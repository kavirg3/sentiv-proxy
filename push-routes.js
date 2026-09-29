// ============================================================================
// SENTIV BACKEND — WEB PUSH NOTIFICATIONS
// Mount into the existing Express proxy, alongside the pCloud and WhatsApp routes:
//
//     const push = require("./push-routes");
//     app.use("/api/push", push);        // AFTER app.use(express.json())
//
// Unlike the WhatsApp router this one WANTS a parsed JSON body, so mount order is
// the opposite: it must come after express.json(), not before.
//
// ENVIRONMENT
//   VAPID_PUBLIC_KEY     required — the browser-safe half. Also served to the app at
//                        GET /api/push/key so a key rotation never needs a rebuild.
//   VAPID_PRIVATE_KEY    required — SERVER ONLY. Anyone holding this can send
//                        notifications that appear to come from Sentiv.
//   VAPID_SUBJECT        required — "mailto:you@example.com". Google and Mozilla use
//                        it to reach you if a subscription starts misbehaving.
//   SUPABASE_URL         required — https://elvmpugjxnzajvgvhtzh.supabase.co
//   SUPABASE_SERVICE_KEY required — service-role key. SERVER ONLY, bypasses RLS.
//   PUSH_SWEEP_SECRET    required to use /sweep — any random string. Without it the
//                        sweep endpoint is disabled rather than left open: it can
//                        notify every agent at once.
//   PUSH_SWEEP_MS        optional — run the sweep in-process every N ms (e.g.
//                        900000 = 15 min). Leave unset to drive it by external cron.
//   PUSH_QUIET_START     optional — hour, SAST, default 7.  No sends before this.
//   PUSH_QUIET_END       optional — hour, SAST, default 18. No sends after this.
//   PUSH_STALE_DAYS      optional — also nudge on deals untouched this long, default 7.
//                        Set 0 to send follow-up alerts only.
//   PUSH_LOG_KEEP_DAYS   optional — how long the debounce log is kept, default 30.
//   PUSH_APP_URL         optional — where a tapped notification opens.
//                        Default https://sentiv-sales-hub.pages.dev
//
// Endpoints
//   GET  /api/push/key      the VAPID public key (no auth — it is public by design)
//   POST /api/push/test     send yourself one test push (auth: Supabase access token)
//   POST /api/push/sweep    notify every agent of their due follow-ups (secret)
//   GET  /api/push/health   config check, leaks no secrets
// ============================================================================

const express = require("express");
const webpush = require("web-push");

const router = express.Router();

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "";
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY || "";
const SWEEP_SECRET = process.env.PUSH_SWEEP_SECRET || "";
const APP_URL = (process.env.PUSH_APP_URL || "https://sentiv-sales-hub.pages.dev").replace(/\/+$/, "");
const QUIET_START = num(process.env.PUSH_QUIET_START, 7);
const QUIET_END = num(process.env.PUSH_QUIET_END, 18);
const STALE_DAYS = num(process.env.PUSH_STALE_DAYS, 7);
const LOG_KEEP_DAYS = num(process.env.PUSH_LOG_KEEP_DAYS, 30);
// Most an agent can be buzzed in one day. The first real sweep found 97 deals deserving
// a nudge for ONE agent — 78 of them merely going cold — which is not a notification
// system, it is noise somebody learns to swipe away. Five is a morning's work.
const MAX_PER_AGENT = num(process.env.PUSH_MAX_PER_AGENT, 5);

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

const configured = !!(VAPID_PUBLIC && VAPID_PRIVATE && VAPID_SUBJECT);
if (configured) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

function need(res) {
  if (!configured) { res.status(500).json({ error: "push not configured — set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT" }); return false; }
  if (!SB_URL || !SB_SERVICE) { res.status(500).json({ error: "push not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY" }); return false; }
  return true;
}

// ---- Supabase, service-role. Bypasses RLS, so it is never handed a client token. ----
async function sb(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_SERVICE,
      Authorization: `Bearer ${SB_SERVICE}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`supabase ${res.status} ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

// Who is calling? The app sends its Supabase access token; we ask Supabase rather than
// verifying the JWT ourselves, so a revoked session stops working immediately.
async function userFromToken(req) {
  const auth = req.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const res = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const u = await res.json();
  return u && u.id ? u : null;
}

// ---- Sending -------------------------------------------------------------------
// A subscription is a perishable thing: the browser rotates it, the agent clears site
// data, the phone is wiped. 404 and 410 mean "this endpoint is dead forever" — delete
// it, or the table fills with addresses that can never be reached again.
async function sendTo(subs, payload) {
  const body = JSON.stringify(payload);
  let sent = 0;
  const dead = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { TTL: 60 * 60 * 12, urgency: "normal" }
      );
      sent++;
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) dead.push(s.endpoint);
      else console.warn("push failed", code || "", (e && e.message) || e);
    }
  }));
  if (dead.length) {
    try {
      const list = dead.map((e) => `"${e.replace(/"/g, '\\"')}"`).join(",");
      await sb(`push_subscriptions?endpoint=in.(${encodeURIComponent(list)})`, { method: "DELETE" });
    } catch (e) { console.warn("could not prune dead subscriptions", e.message); }
  }
  return { sent, pruned: dead.length };
}

async function subsFor(userId) {
  return (await sb(`push_subscriptions?select=endpoint,p256dh,auth&user_id=eq.${userId}`)) || [];
}

// ---- Routes --------------------------------------------------------------------

router.get("/key", (_req, res) => {
  if (!VAPID_PUBLIC) return res.status(500).json({ error: "push not configured — set VAPID_PUBLIC_KEY" });
  res.json({ publicKey: VAPID_PUBLIC });
});

router.get("/health", (_req, res) => {
  res.json({
    ok: configured && !!SB_URL && !!SB_SERVICE,
    vapid: configured,
    supabase: !!(SB_URL && SB_SERVICE),
    sweep: !!SWEEP_SECRET,
    quietHours: `${QUIET_START}:00–${QUIET_END}:00 SAST`,
    staleDays: STALE_DAYS || "off",
    appUrl: APP_URL,
    weeklyDigest: `Mondays from ${DIGEST_HOUR}:00 SAST — team numbers to the owner, own deals to everyone`,
  });
});

router.post("/test", async (req, res) => {
  if (!need(res)) return;
  try {
    const user = await userFromToken(req);
    if (!user) return res.status(401).json({ error: "sign in first — no valid Supabase session on this request" });
    const subs = await subsFor(user.id);
    if (!subs.length) return res.status(404).json({ error: "no push subscription for this account on any device yet" });
    const out = await sendTo(subs, {
      title: "Sentiv Sales Hub",
      body: "Push notifications are working. This is what a follow-up alert will look like.",
      tag: "sentiv-test",
      url: `${APP_URL}/`,
    });
    res.json({ ok: true, devices: subs.length, ...out });
  } catch (e) {
    res.status(500).json({ error: e.message || "test push failed" });
  }
});

// Owner-only: send one test buzz to SOMEONE ELSE's devices (Hub v151 — the "Send test"
// button on the owner's weekly card). The caller's own Supabase session proves who they
// are; their role is read with the service key, never taken from the request. One test
// per person per minute, so a double-tap can't turn into a buzz storm.
const _lastTest = {};
router.post("/test-user", async (req, res) => {
  if (!need(res)) return;
  try {
    const user = await userFromToken(req);
    if (!user) return res.status(401).json({ error: "sign in first — no valid Supabase session on this request" });
    const me = ((await sb(`profiles?select=role&id=eq.${encodeURIComponent(user.id)}`)) || [])[0];
    if (!me || me.role !== "owner") return res.status(403).json({ error: "only the owner can test someone else's notifications" });
    const target = String((req.body && req.body.userId) || "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(target)) return res.status(400).json({ error: "userId missing or not a valid id" });
    const now = Date.now();
    if (_lastTest[target] && now - _lastTest[target] < 60000) return res.status(429).json({ error: "just sent one — wait a minute before testing this person again" });
    const subs = await subsFor(target);
    if (!subs.length) return res.status(404).json({ error: "this person has no device with notifications on" });
    _lastTest[target] = now;
    const out = await sendTo(subs, {
      title: "Sentiv Sales Hub — test",
      body: "Your notifications are working. You'll get follow-up alerts here, and a short note about your deals every Monday.",
      tag: "sentiv-test",
      url: `${APP_URL}/`,
      actions: [{ action: "open", title: "Open Hub" }],
    });
    res.json({ ok: true, devices: subs.length, ...out });
  } catch (e) {
    res.status(500).json({ error: e.message || "test push failed" });
  }
});

// What a notification says, for each of the two reasons we send one.
function payloadFor(r, kind) {
  const d = r.data || {};
  const rand = typeof d.value === "number" && d.value > 0 ? ` · R${Math.round(d.value).toLocaleString("en-ZA")}` : "";
  if (kind === "stale") {
    const days = Math.max(1, Math.round((Date.now() - Number(d.updatedAt || 0)) / 864e5));
    return {
      title: `Going cold: ${d.company || "a deal"}`,
      body: `${d.stage || "In pipeline"}${rand} · untouched ${days} days`,
      tag: `stale-${r.id}`,
      url: `${APP_URL}/?lead=${encodeURIComponent(r.id)}`,
      leadId: r.id,
    };
  }
  return {
    title: `Follow-up due: ${d.company || "a deal"}`,
    body: `${d.stage || "In pipeline"}${rand}${d.contact ? ` · ${d.contact}` : ""}`,
    tag: `followup-${r.id}`,          // replaces, never stacks, if it re-fires
    url: `${APP_URL}/?lead=${encodeURIComponent(r.id)}`,
    leadId: r.id,
  };
}

// Which five: the most valuable, rand for rand, whatever the reason. A deal with no
// value set sorts as 0 and falls to the back — which is what you want when 95 of 98 open
// deals carry no figure at all. Where two deals are worth the same, the follow-up wins:
// that one is a date the agent committed to, the other is only drifting.
const leadValue = (it) => { const v = Number(it && it.r && it.r.data && it.r.data.value); return Number.isFinite(v) ? v : 0; };
const rankForAgent = (list) => list.slice().sort((a, b) => {
  const d = leadValue(b) - leadValue(a);
  if (d !== 0) return d;
  if (a.kind !== b.kind) return a.kind === "followup" ? -1 : 1;
  return 0;
});

// ---- Monday digest for the owner (Hub v147) ------------------------------------
// Once a week, the owner gets ONE notification with last week's next-step numbers — the
// same four counts as the "Next steps this week" card on the Team screen, read from the
// same usage_events rows. Counts only: usage_events holds no deal, company or wording.
// Rides the existing sweep, so it needs no new cron and obeys the same quiet hours.
const DIGEST_HOUR = num(process.env.PUSH_DIGEST_HOUR, 8);   // Mondays, from this hour SAST
const NEXT_KINDS = ["next_ai", "next_set_ai", "next_set_rule", "next_done"];

// Pure: rows in, notification out. Kept apart from the I/O so it can be tested alone.
function digestPayload(rows, now) {
  const wk = 7 * 864e5;
  const blank = () => ({ next_ai: 0, next_set_ai: 0, next_set_rule: 0, next_done: 0 });
  const T = blank(), L = blank();
  (rows || []).forEach((r) => {
    if (!r || !(r.kind in T)) return;
    const age = now - new Date(r.at).getTime();
    if (!(age >= 0)) return;
    if (age < wk) T[r.kind]++; else if (age < 2 * wk) L[r.kind]++;
  });
  const saved = T.next_set_ai + T.next_set_rule, savedBefore = L.next_set_ai + L.next_set_rule;
  const d = saved - savedBefore;
  const trend = d === 0 ? "same as the week before" : `${d > 0 ? "up" : "down"} ${Math.abs(d)} on the week before`;
  const body = saved + T.next_done + T.next_ai === 0
    ? "No next steps were saved or completed last week. Worth a word with the team."
    : `AI wrote ${T.next_ai} line${T.next_ai === 1 ? "" : "s"} · agents saved ${saved} (${T.next_set_ai} from AI) · ${T.next_done} marked done. Saved ${trend}.`;
  // v150 — the same summary as WhatsApp text, behind a "Send to WhatsApp" button (Hub
  // v150 service worker). wa.me with no number opens the chat picker: the owner picks
  // themselves or the team group, and their own WhatsApp sends it — no Meta API, no cost.
  const wa = [
    "*Sentiv — next steps, last 7 days*",
    "",
    `AI lines written: ${T.next_ai}`,
    `Suggestions saved: ${saved} (${T.next_set_ai} from AI)`,
    `Next actions done: ${T.next_done}`,
    `Saved vs the week before: ${d === 0 ? "same" : `${d > 0 ? "up" : "down"} ${Math.abs(d)}`}`,
  ].join("\n");
  return {
    title: "Sentiv — last week's next steps", body, tag: "weekly-digest", url: `${APP_URL}/`,
    waUrl: `https://wa.me/?text=${encodeURIComponent(wa)}`,
    actions: [{ action: "open", title: "Open Hub" }, { action: "wa", title: "Send to WhatsApp" }],
    counts: { thisWeek: T, weekBefore: L },
  };
}

// Each AGENT's own Monday note (Hub v148): their deals only, what needs doing this week,
// plus what they themselves saved and finished last week. Pure, like digestPayload.
// Returns null when there is nothing worth a buzz (no open deals).
function agentWeekPayload(leads, events, now, today) {
  const open = (leads || []).filter((r) => r && r.data && !String(r.data.stage || "").startsWith("Closed"));
  if (!open.length) return null;
  const in7 = new Date(new Date(today + "T00:00:00Z").getTime() + 6 * 864e5).toISOString().slice(0, 10);
  const coldCut = now - 7 * 864e5;
  let overdue = 0, due = 0, cold = 0, noNext = 0;
  open.forEach((r) => {
    const d = r.data;
    const f = d.followUp ? String(d.followUp) : "";
    if (f && f < today) overdue++;
    else if (f && f <= in7) due++;
    if (Number(d.updatedAt) && Number(d.updatedAt) <= coldCut) cold++;
    if (!String(d.nextAction || "").trim()) noNext++;
  });
  const wk = 7 * 864e5;
  let saved = 0, done = 0;
  (events || []).forEach((e) => {
    const age = now - new Date(e.at).getTime();
    if (!(age >= 0 && age < wk)) return;
    if (e.kind === "next_set_ai" || e.kind === "next_set_rule") saved++;
    else if (e.kind === "next_done") done++;
  });
  const parts = [];
  if (overdue) parts.push(`${overdue} overdue`);
  if (due) parts.push(`${due} follow-up${due === 1 ? "" : "s"} due`);
  if (cold) parts.push(`${cold} going cold`);
  if (noNext) parts.push(`${noNext} with no next step`);
  const todo = parts.length ? `This week: ${parts.join(" · ")}.` : (open.length === 1 ? "Your open deal is on track." : `All ${open.length} open deals are on track.`);
  const last = saved || done ? ` Last week you saved ${saved} next step${saved === 1 ? "" : "s"} and finished ${done}.` : "";
  return {
    title: "Your week — Sentiv",
    body: todo + last,
    tag: "weekly-agent",
    url: `${APP_URL}/`,
    // A weekly note is not a deal: "Open lead" / "Snooze" would both be wrong here.
    actions: [{ action: "open", title: "Open Hub" }],
    counts: { open: open.length, overdue, due, cold, noNext, saved, done },
  };
}

async function weeklyDigest(today, hour, force) {
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Johannesburg", weekday: "short" }).format(new Date());
  if (!force && (dow !== "Mon" || hour < DIGEST_HOUR)) return { skipped: "not Monday morning" };
  const owners = (await sb("profiles?select=id&role=eq.owner")) || [];
  if (!owners.length) return { owners: 0 };
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  const rows = (await sb(`usage_events?select=kind,at&at=gte.${encodeURIComponent(since)}&kind=in.(${NEXT_KINDS.join(",")})&limit=20000`)) || [];
  const payload = digestPayload(rows, Date.now());
  let sent = 0, already = 0, noDevice = 0;
  for (const o of owners) {
    const subs = await subsFor(o.id);
    if (!subs.length) { noDevice++; continue; }
    // The guard row goes in first; ignore-duplicates + return=representation hands back
    // only rows that were NEW, so an empty answer means this Monday was already sent.
    const fresh = await sb("push_log", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify([{ lead_id: `weekly-${o.id}`, kind: "weekly", user_id: o.id, sent_on: today }]),
    });
    if (!Array.isArray(fresh) || !fresh.length) { already++; continue; }
    const { counts, ...note } = payload;
    const out = await sendTo(subs, note);
    sent += out.sent;
  }
  const agents = await agentDigests(today);
  return { owners: owners.length, sent, already, noDevice, counts: payload.counts, agents };
}

async function agentDigests(today) {
  // Owners too: on this team the owner works most of the deals, and the owner digest
  // above is about the TEAM, not their own book. So they get both on a Monday.
  const agents = (await sb("profiles?select=id&role=in.(agent,owner)")) || [];
  if (!agents.length) return { agents: 0 };
  // Only agents who can actually receive one are worth a leads read.
  const reachable = [];
  for (const a of agents) { const subs = await subsFor(a.id); if (subs.length) reachable.push({ id: a.id, subs }); }
  if (!reachable.length) return { agents: agents.length, sent: 0, noDevice: agents.length };
  const leads = (await sb("leads?select=id,agent_id,data")) || [];
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const events = (await sb(`usage_events?select=agent_id,kind,at&at=gte.${encodeURIComponent(since)}&kind=in.(${NEXT_KINDS.join(",")})&limit=20000`)) || [];
  let sent = 0, already = 0, nothing = 0;
  for (const a of reachable) {
    const p = agentWeekPayload(leads.filter((r) => r.agent_id === a.id), events.filter((e) => e.agent_id === a.id), Date.now(), today);
    if (!p) { nothing++; continue; }
    const fresh = await sb("push_log", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify([{ lead_id: `weekly-agent-${a.id}`, kind: "weekly", user_id: a.id, sent_on: today }]),
    });
    if (!Array.isArray(fresh) || !fresh.length) { already++; continue; }
    const { counts, ...note } = p;
    const out = await sendTo(a.subs, note);
    sent += out.sent;
  }
  return { agents: agents.length, reachable: reachable.length, sent, already, nothing, noDevice: agents.length - reachable.length };
}

// The debounce log is a debounce, not an archive. Trimmed once a day, on the first
// sweep of that day — cheap, and nobody has to remember to run it.
let _lastPrune = "";
async function prunePushLog(today) {
  if (_lastPrune === today || LOG_KEEP_DAYS <= 0) return;
  _lastPrune = today;
  const cutoff = new Date(Date.now() - LOG_KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  try { await sb(`push_log?sent_on=lt.${cutoff}`, { method: "DELETE" }); }
  catch (e) { console.warn("push_log prune failed", e.message); }
}

// The sweep. Finds every lead that deserves a nudge, groups them by the agent who owns
// them, and sends that agent ONE notification per deal.
//
// Runs against the leads table's JSONB `data` column, which is where followUp, stage,
// company, value and updatedAt all live — see teamUpsertLead in the app.
router.post("/sweep", async (req, res) => {
  if (!need(res)) return;
  if (!SWEEP_SECRET) return res.status(503).json({ error: "sweep disabled — set PUSH_SWEEP_SECRET" });
  const given = (req.get("x-sweep-secret") || (req.body && req.body.secret) || "").trim();
  if (given !== SWEEP_SECRET) return res.status(401).json({ error: "bad sweep secret" });

  // Quiet hours, in SAST regardless of where Railway happens to run the container.
  const hour = Number(new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", hour: "numeric", hour12: false }).format(new Date()));
  const force = !!(req.body && req.body.force);
  if (!force && (hour < QUIET_START || hour >= QUIET_END)) {
    return res.json({ ok: true, skipped: "quiet hours", hour, window: `${QUIET_START}-${QUIET_END} SAST` });
  }

  try {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(new Date()); // YYYY-MM-DD
    await prunePushLog(today);
    // Never lets a digest problem stop the follow-up alerts, which matter more.
    let digest = null;
    try { digest = await weeklyDigest(today, hour, !!(req.body && req.body.digest === "force")); }
    catch (e) { digest = { error: e.message || "digest failed" }; console.warn("weekly digest failed", digest.error); }
    const rows = (await sb(`leads?select=id,agent_id,data`)) || [];
    const staleCutoff = STALE_DAYS > 0 ? Date.now() - STALE_DAYS * 864e5 : null;

    // Two reasons to nudge. A deal that is BOTH due and going cold gets the follow-up
    // alert only: the dated one is the more actionable, and two buzzes about one deal
    // in one morning is how an agent learns to ignore both.
    const items = [];
    rows.forEach((r) => {
      const d = r.data || {};
      if (!r.agent_id) return;
      if (String(d.stage || "").startsWith("Closed")) return;
      if (d.followUp && String(d.followUp) <= today) { items.push({ r, kind: "followup" }); return; }
      if (staleCutoff && Number(d.updatedAt) && Number(d.updatedAt) <= staleCutoff) items.push({ r, kind: "stale" });
    });
    if (!items.length) return res.json({ ok: true, due: 0, sent: 0, digest });

    // One notification per lead per REASON per day. The guard rows are written BEFORE
    // the send, so a crash mid-sweep can't produce a second round on the retry.
    const todayRows = (await sb(`push_log?select=lead_id,kind,user_id&sent_on=eq.${today}`)) || [];
    const logged = new Set(todayRows.map((r) => `${r.lead_id}|${r.kind}`));
    // Deal alerts ALREADY sent to each person today. The cap is per person per DAY: the
    // sweep runs every 15 minutes, and capping each run alone let 5 more through every
    // quarter hour — 90 buzzes to one Mac on 29/09/2026 against a cap of 5.
    const sentToday = {};
    todayRows.forEach((r) => { if (r.kind === "followup" || r.kind === "stale") sentToday[r.user_id] = (sentToday[r.user_id] || 0) + 1; });
    const fresh = items.filter((it) => !logged.has(`${it.r.id}|${it.kind}`));
    if (!fresh.length) return res.json({ ok: true, due: items.length, sent: 0, note: "all already notified today", digest });

    const byAgent = {};
    fresh.forEach((it) => { (byAgent[it.r.agent_id] = byAgent[it.r.agent_id] || []).push(it); });

    // Cap BEFORE the push_log write, never after. The log is what suppresses a repeat
    // tomorrow, so logging a deal we deliberately did not send would bury it for good —
    // it would be marked "already notified" having never buzzed anything. Held-back
    // deals stay unlogged and come back tomorrow, once the bigger ones are cleared.
    let held = 0;
    Object.keys(byAgent).forEach((agentId) => {
      const ranked = rankForAgent(byAgent[agentId]);
      const room = Math.max(0, MAX_PER_AGENT - (sentToday[agentId] || 0));
      if (ranked.length > room) held += ranked.length - room;
      byAgent[agentId] = ranked.slice(0, room);
      if (!byAgent[agentId].length) delete byAgent[agentId];
    });

    let sent = 0, pruned = 0, notified = 0;
    for (const [agentId, list] of Object.entries(byAgent)) {
      const subs = await subsFor(agentId);
      if (!subs.length) continue;
      await sb("push_log", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(list.map((it) => ({ lead_id: it.r.id, kind: it.kind, user_id: agentId, sent_on: today }))),
      });
      for (const it of list) {
        const out = await sendTo(subs, payloadFor(it.r, it.kind));
        sent += out.sent; pruned += out.pruned; notified++;
      }
    }
    res.json({
      ok: true,
      due: items.length,
      followups: fresh.filter((i) => i.kind === "followup").length,
      stale: fresh.filter((i) => i.kind === "stale").length,
      leadsNotified: notified, sent, pruned, held, maxPerAgent: MAX_PER_AGENT, digest,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "sweep failed" });
  }
});

// Optional in-process schedule, for when you'd rather not wire an external cron.
// Railway keeps the web process warm, so a plain interval is enough; the quiet-hours
// check inside /sweep is what stops it firing overnight.
const SWEEP_MS = num(process.env.PUSH_SWEEP_MS, 0);
if (SWEEP_MS > 0 && SWEEP_SECRET) {
  setInterval(() => {
    fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/push/sweep`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sweep-secret": SWEEP_SECRET },
      body: "{}",
    }).catch((e) => console.warn("scheduled sweep failed", e.message));
  }, SWEEP_MS).unref();
  console.log(`push: in-process sweep every ${Math.round(SWEEP_MS / 60000)} min`);
}

module.exports = router;
module.exports._digestPayload = digestPayload;   // for tests only
module.exports._agentWeekPayload = agentWeekPayload;
