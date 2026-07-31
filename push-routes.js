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
    if (!items.length) return res.json({ ok: true, due: 0, sent: 0 });

    // One notification per lead per REASON per day. The guard rows are written BEFORE
    // the send, so a crash mid-sweep can't produce a second round on the retry.
    const logged = new Set(
      ((await sb(`push_log?select=lead_id,kind&sent_on=eq.${today}`)) || []).map((r) => `${r.lead_id}|${r.kind}`)
    );
    const fresh = items.filter((it) => !logged.has(`${it.r.id}|${it.kind}`));
    if (!fresh.length) return res.json({ ok: true, due: items.length, sent: 0, note: "all already notified today" });

    const byAgent = {};
    fresh.forEach((it) => { (byAgent[it.r.agent_id] = byAgent[it.r.agent_id] || []).push(it); });

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
      leadsNotified: notified, sent, pruned,
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
