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
//   PUSH_QUOTE_DAYS      optional — a Quotation Sent deal untouched this long gets the
//                        "chase the quote" alert instead, default 5. 0 = off.
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
//   POST /api/push/won      announce a deal just marked Closed Won (auth: its owner or the owner)
//   POST /api/push/image    owner uploads a notification picture
//   GET  /api/push/img/:f   serves that picture to phones (public — content-hashed names)
//   POST /api/push/preview  owner sends themselves one message of a kind, with sample words
//   POST /api/push/remind/test  anyone: one of their own reminders, now, to their own devices
//   POST /api/push/alert    the GitHub health-check workflow reports results (OIDC-signed)
//   (in-process) personal reminders every minute; platform watchdog every 5 minutes
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
const QUOTE_DAYS = num(process.env.PUSH_QUOTE_DAYS, 5);
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
async function sendTo(subs, payload, opts = {}) {
  const body = JSON.stringify(payload);
  let sent = 0;
  const dead = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { TTL: opts.ttl || 60 * 60 * 12, urgency: opts.urgency || "normal" }
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
    quoteDays: QUOTE_DAYS || "off",
    appUrl: APP_URL,
    weeklyDigest: `Mondays from ${DIGEST_HOUR}:00 SAST — team numbers to the owner, own deals to everyone`,
    dealWon: true,          // v234 — /won, /image, /img, /preview
    templates: PUSH_KINDS,
    // v239 — personal reminders and the platform watchdog. Names of failing checks only.
    reminders: { every: "1 min", lastRun: _remindLast.at ? new Date(_remindLast.at).toISOString() : null, error: _remindLast.error || undefined },
    watchdog: { every: `${Math.round(WATCH_MS / 60000)} min`, ...watchStatus() },
  });
});

router.post("/test", async (req, res) => {
  if (!need(res)) return;
  try {
    const user = await userFromToken(req);
    if (!user) return res.status(401).json({ error: "sign in first — no valid Supabase session on this request" });
    const subs = await subsFor(user.id);
    if (!subs.length) return res.status(404).json({ error: "no push subscription for this account on any device yet" });
    const { tpls } = await loadTemplates();
    const out = await sendTo(subs, applyTpl({
      title: "Sentiv Sales Hub",
      body: "Push notifications are working. This is what a follow-up alert will look like.",
      tag: "sentiv-test",
      url: `${APP_URL}/`,
    }, "test", {}, tpls));
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
    const { tpls } = await loadTemplates();
    const out = await sendTo(subs, applyTpl({
      title: "Sentiv Sales Hub — test",
      body: "Your notifications are working. You'll get follow-up alerts here, and a short note about your deals every Monday.",
      tag: "sentiv-test",
      url: `${APP_URL}/`,
      actions: [{ action: "open", title: "Open Hub" }],
    }, "test", {}, tpls));
    res.json({ ok: true, devices: subs.length, ...out });
  } catch (e) {
    res.status(500).json({ error: e.message || "test push failed" });
  }
});

// ---- Owner-editable wording and pictures (Hub v234) ---------------------------------
// Every notification's title and text is a template the owner edits in the Hub
// (Settings → Notifications), stored on the owner-write team_settings row as
// `pushTemplates`. A blank or missing field means the shipped wording below, so the team
// never gets an empty buzz. {words} in braces are filled per message; a gap left by an
// empty one (a deal with no value) is tidied away rather than showing " ·  · ".
// The Hub carries the same defaults to show in its editor — keep the two in step.
const PUSH_DEFAULTS = {
  won: { title: "Deal won: {company}", body: "{value} · closed by {agent}. Team this month: {month}.", wa: "Well done {agent}! {company} signed for {value}." },
  followup: { title: "Follow-up due: {company}", body: "{stage} · {value} · {contact}" },
  quote: { title: "Chase the quote: {company}", body: "Quoted {value} · no update for {days} days · {contact}", wa: "Hi {firstname}, just checking in on the quote we sent for {company}. Any questions I can help with?" },
  stale: { title: "Going cold: {company}", body: "{stage} · {value} · untouched {days} days" },
  week: { title: "Your week — Sentiv", body: "{todo} {lastweek}" },
  digest: { title: "Sentiv — last week's next steps", body: "{summary}" },
  test: { title: "Sentiv Sales Hub — test", body: "Your notifications are working. You'll get follow-up alerts here, and a short note about your deals every Monday." },
  // v239 — a reminder someone set for themselves, and the owner's "something is broken" alert.
  remind: { title: "Reminder", body: "{text}" },
  alert: { title: "Sentiv needs you: {problem}", body: "{detail}" },
};
const PUSH_KINDS = Object.keys(PUSH_DEFAULTS);
// Where a notification's picture is served from. Phones fetch it themselves, with no
// sign-in, so it has to be a public address on THIS server (see GET /img below).
const PUBLIC_URL = (process.env.PUSH_PUBLIC_URL || "https://sentiv-proxy-production.up.railway.app").replace(/\/+$/, "");
// Pictures live in the existing private `backups` bucket under their own folder; this
// server reads them with the service key and serves them. The nightly backup prune lists
// the bucket ROOT only, where a folder has no created_at, so it never touches these.
const IMG_BUCKET = "backups", IMG_DIR = "push-images";
const IMG_RE = /^[a-z]+-[0-9a-f]{12}\.(jpg|png|webp)$/;
const IMG_MAX = 1024 * 1024;
const crypto = require("crypto");
const waCore = require("./whatsapp-core");
const sha12 = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);

const fmtRand = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? `R${Math.round(n).toLocaleString("en-ZA")}` : ""; };

// Pure: fill {words}, then tidy what an empty one leaves behind.
function fillTpl(str, vars) {
  let s = String(str || "").replace(/\{(\w+)\}/g, (_m, k) => (vars && vars[k] != null ? String(vars[k]) : ""));
  s = s.replace(/[ \t]+/g, " ")
    .replace(/(\s*·\s*){2,}/g, " · ")          // "Lead ·  · Thabo" → "Lead · Thabo"
    .replace(/\s*·\s*([.,!?])/g, "$1")         // "R5 · ." → "R5."
    .replace(/\s+([.,!?])/g, "$1")
    .replace(/^[\s·.,]+|[\s·]+$/g, "")
    .trim();
  return s;
}
// The owner's version of one kind, field by field over the shipped one.
function tplFor(kind, tpls) {
  const d = PUSH_DEFAULTS[kind] || { title: "", body: "" };
  const o = (tpls && typeof tpls === "object" && tpls[kind] && typeof tpls[kind] === "object") ? tpls[kind] : {};
  const str = (v, dflt) => (typeof v === "string" && v.trim() ? v : dflt);
  return {
    title: str(o.title, d.title).slice(0, 140),
    body: str(o.body, d.body).slice(0, 400),
    wa: str(o.wa, d.wa || "").slice(0, 600),
    image: typeof o.image === "string" && IMG_RE.test(o.image) ? o.image : null,
    // Deal won only: "card" = the green deal card drawn by the Hub (default), "custom" =
    // the owner's uploaded picture, "none" = text only. Every other kind: a picture if set.
    pic: o.pic === "custom" || o.pic === "none" ? o.pic : "card",
    to: o.to === "owner" ? "owner" : "all",
    off: o.off === true,
  };
}
const imgUrl = (file) => `${PUBLIC_URL}/api/push/img/${file}`;
// Title, text and picture from the owner's template, over a payload that already carries
// the shipped wording. A template that fills to nothing falls back to that wording.
function applyTpl(p, kind, vars, tpls) {
  const t = tplFor(kind, tpls);
  const out = { ...p, title: fillTpl(t.title, vars) || p.title, body: fillTpl(t.body, vars) || p.body };
  if (kind !== "won" && t.image) out.image = imgUrl(t.image);
  return out;
}

// The templates, read with the service key. Cached briefly: a sweep sends many messages.
let _tplCache = { at: 0, v: null };
async function loadTemplates(fresh) {
  if (!fresh && _tplCache.v && Date.now() - _tplCache.at < 30000) return _tplCache.v;
  try {
    const r = (await sb("team_settings?id=eq.1&select=pushTemplates:data->pushTemplates,agentPhones:data->agentPhones")) || [];
    _tplCache = { at: Date.now(), v: { tpls: (r[0] && r[0].pushTemplates) || {}, phones: (r[0] && r[0].agentPhones) || {} } };
  } catch (e) {
    console.warn("push templates unreadable — shipped wording used", e.message);
    if (!_tplCache.v) return { tpls: {}, phones: {} };
  }
  return _tplCache.v;
}

// ---- Picture storage ----
function decodeImage(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length || buf.length > IMG_MAX) return null;
  // The bytes have to BE the type they claim — a renamed file is not a picture.
  const ok = m[1] === "jpeg" ? buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
    : m[1] === "png" ? buf.slice(0, 4).toString("hex") === "89504e47"
    : buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP";
  if (!ok) return null;
  return { buf, ext: m[1] === "jpeg" ? "jpg" : m[1], type: `image/${m[1]}` };
}
async function storeImage(name, img) {
  const r = await fetch(`${SB_URL}/storage/v1/object/${IMG_BUCKET}/${IMG_DIR}/${name}`, {
    method: "POST",
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": img.type, "x-upsert": "true", "cache-control": "max-age=31536000" },
    body: img.buf,
  });
  if (!r.ok) throw new Error(`picture upload failed (${r.status}) ${(await r.text()).slice(0, 200)}`);
  return name;
}
async function imageExists(name) {
  try {
    const r = await fetch(`${SB_URL}/storage/v1/object/info/${IMG_BUCKET}/${IMG_DIR}/${name}`, { headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` } });
    return r.ok;
  } catch (e) { return false; }
}
// One deal's card always lands at the same name, so the sweep can find a card the Hub
// uploaded during quiet hours. Salted, so a deal id alone cannot be turned into its card.
const cardName = (leadId) => `card-${sha12(`${SWEEP_SECRET || VAPID_PRIVATE}|${leadId}`)}.jpg`;

// What a notification says, for each of the two reasons we send one.
function payloadFor(r, kind, tpls) {
  const d = r.data || {};
  const rand = typeof d.value === "number" && d.value > 0 ? ` · R${Math.round(d.value).toLocaleString("en-ZA")}` : "";
  if (kind === "quote") return quotePayload(r, tpls);
  if (kind === "stale") {
    const days = Math.max(1, Math.round((Date.now() - Number(d.updatedAt || 0)) / 864e5));
    return applyTpl({
      title: `Going cold: ${d.company || "a deal"}`,
      body: `${d.stage || "In pipeline"}${rand} · untouched ${days} days`,
      tag: `stale-${r.id}`,
      url: `${APP_URL}/?lead=${encodeURIComponent(r.id)}`,
      leadId: r.id,
    }, "stale", { company: d.company || "a deal", stage: d.stage || "In pipeline", value: fmtRand(d.value), days }, tpls);
  }
  return applyTpl({
    title: `Follow-up due: ${d.company || "a deal"}`,
    body: `${d.stage || "In pipeline"}${rand}${d.contact ? ` · ${d.contact}` : ""}`,
    tag: `followup-${r.id}`,          // replaces, never stacks, if it re-fires
    url: `${APP_URL}/?lead=${encodeURIComponent(r.id)}`,
    leadId: r.id,
  }, "followup", { company: d.company || "a deal", stage: d.stage || "In pipeline", value: fmtRand(d.value), contact: d.contact || "" }, tpls);
}

// ---- Chase the quote (Hub v235) ------------------------------------------------------
// A quote that has sat untouched is where deals quietly die. The alert carries a
// "WhatsApp them" button that opens a chat with the client's cell number, the check-in
// already typed (the owner's wording). Landlines can't take WhatsApp, so no cell = no button.
const SA_CELL = /^27[6-8]\d{8}$/;
function cellOf(d) {
  const nums = [d.phone, d.directLine].concat(Array.isArray(d.contacts) ? d.contacts.map((c) => c && c.phone) : []);
  for (const n of nums) {
    for (const part of String(n || "").split(/[,;/]|\s{2,}/)) {
      const c = waCore.normalizeMsisdn(part);
      if (SA_CELL.test(c)) return c;
    }
  }
  return "";
}
function quotePayload(r, tpls) {
  const d = r.data || {};
  const days = Math.max(1, Math.round((Date.now() - Number(d.updatedAt || 0)) / 864e5));
  const vars = { company: d.company || "a deal", stage: d.stage || "Quotation Sent", value: fmtRand(d.value), days, contact: d.contact || "",
    firstname: String(d.contact || "").trim().split(/\s+/)[0] || "there" };
  const t = tplFor("quote", tpls);
  const out = applyTpl({
    title: `Chase the quote: ${vars.company}`,
    body: `Quoted${vars.value ? " " + vars.value : ""} · no update for ${days} days`,
    tag: `quote-${r.id}`,
    url: `${APP_URL}/?lead=${encodeURIComponent(r.id)}`,
    leadId: r.id,
  }, "quote", vars, tpls);
  const cell = cellOf(d);
  out.actions = [{ action: "open", title: "Open lead" }];
  if (cell) {
    out.waUrl = `https://wa.me/${cell}?text=${encodeURIComponent(fillTpl(t.wa, vars))}`;
    out.actions.push({ action: "wa", title: "WhatsApp them" });
  } else out.actions.push({ action: "snooze", title: "Snooze" });
  return out;
}

// ---- Deal won (Hub v234) -------------------------------------------------------------
// Pure: who is told, and what each of them sees. `phones` is team_settings.agentPhones.
// The WhatsApp button opens a chat with whoever closed it (to say well done) — or, for
// the closer themselves or anyone without a number on file, WhatsApp's own chat picker
// with the text filled in, so they can send the news to the team group.
function wonPayloads(lead, ctx) {
  const d = lead.data || {};
  const t = tplFor("won", ctx.tpls);
  if (t.off) return [];
  const vars = { company: d.company || "a deal", value: fmtRand(d.value), agent: ctx.agentName || "the team", month: fmtRand(ctx.monthTotal) || "R0", stage: d.stage || "Closed Won" };
  const title = fillTpl(t.title, vars) || `Deal won: ${vars.company}`;
  const body = fillTpl(t.body, vars) || vars.value;
  const waText = fillTpl(t.wa, vars);
  const image = t.pic === "none" ? null : t.pic === "custom" ? (t.image ? imgUrl(t.image) : null) : (ctx.card ? imgUrl(ctx.card) : null);
  const people = (ctx.people || []).filter((p) => (t.to === "owner" ? p.role === "owner" : true));
  const phone = String((ctx.phones || {})[lead.agent_id] || "").replace(/\D/g, "");
  return people.map((p) => {
    const toCloser = p.id !== lead.agent_id && phone.length >= 9;
    const waUrl = `https://wa.me/${toCloser ? phone : ""}?text=${encodeURIComponent(waText || title)}`;
    const out = {
      title, body, tag: `won-${lead.id}`, url: `${APP_URL}/?lead=${encodeURIComponent(lead.id)}`, leadId: lead.id, waUrl,
      actions: [{ action: "open", title: "Open deal" }, { action: "wa", title: "Reply in WhatsApp" }],
    };
    if (image) out.image = image;
    return { userId: p.id, payload: out };
  });
}

// Same month in SAST, same business (Sentiv or Digital Rewards) as the deal just won.
function monthWonTotal(rows, lead, now) {
  const month = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit" }).format(new Date(ms));
  const m = month(now);
  const biz = (r) => ((r.business || (r.data && r.data.business)) === "rewards" ? "rewards" : "sentiv");
  const want = biz(lead);
  return (rows || []).reduce((s, r) => {
    const closedAt = Number(r.closedAt != null ? r.closedAt : r.data && r.data.closedAt);
    const v = Number(r.value != null ? r.value : r.data && r.data.value);
    if (!closedAt || month(closedAt) !== m || biz(r) !== want) return s;
    return s + (Number.isFinite(v) && v > 0 ? v : 0);
  }, 0);
}

const WON_FRESH_MS = 36 * 3600e3;   // the sweep still announces a win this old (e.g. won after 18:00)
// Announce one won deal, once. The push_log row goes in FIRST: whichever of the Hub's
// call and the sweep gets there first sends, the other finds the row and stops.
async function sendWon(lead, today) {
  const prior = (await sb(`push_log?select=lead_id&lead_id=eq.${encodeURIComponent(lead.id)}&kind=eq.won&limit=1`)) || [];
  if (prior.length) return { already: true };
  const fresh = await sb("push_log", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify([{ lead_id: lead.id, kind: "won", user_id: lead.agent_id, sent_on: today }]),
  });
  if (!Array.isArray(fresh) || !fresh.length) return { already: true };
  const { tpls, phones } = await loadTemplates(true);
  const people = (await sb(`profiles?select=id,role,full_name`)) || [];
  const closer = people.find((p) => p.id === lead.agent_id);
  const rewards = (lead.data || {}).business === "rewards";
  const won = (await sb(`leads?select=closedAt:data->>closedAt,value:data->>value,business:data->>business&data->>stage=eq.${encodeURIComponent("Closed Won")}`)) || [];
  const card = (await imageExists(cardName(lead.id))) ? cardName(lead.id) : null;
  const list = wonPayloads(lead, {
    tpls, phones, card, monthTotal: monthWonTotal(won, lead, Date.now()),
    agentName: ((closer && closer.full_name) || "").trim().split(/\s+/)[0] || "the team",
    // Setters only hear about Digital Rewards wins — their bookings are what those are.
    people: people.filter((p) => p.role === "owner" || p.role === "agent" || (rewards && p.role === "setter")),
  });
  let sent = 0, people_ = 0;
  for (const it of list) {
    const subs = await subsFor(it.userId);
    if (!subs.length) continue;
    const out = await sendTo(subs, it.payload);
    sent += out.sent; people_++;
  }
  return { sent, people: people_, image: !!(list[0] && list[0].payload.image) };
}

async function wonSweep(today) {
  const rows = (await sb(`leads?select=id,agent_id,data&data->>stage=eq.${encodeURIComponent("Closed Won")}`)) || [];
  const cut = Date.now() - WON_FRESH_MS;
  const recent = rows.filter((r) => r.agent_id && Number(r.data && r.data.closedAt) >= cut);
  let announced = 0;
  for (const r of recent) { const o = await sendWon(r, today); if (!o.already) announced++; }
  return { recent: recent.length, announced };
}

const sastHour = () => Number(new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", hour: "numeric", hour12: false }).format(new Date()));
const sastDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(new Date());
const isOwner = async (uid) => { const me = ((await sb(`profiles?select=role&id=eq.${encodeURIComponent(uid)}`)) || [])[0]; return !!me && me.role === "owner"; };

// The Hub calls this the moment a deal is marked Closed Won, with the deal card it drew.
// Only the person whose deal it is (or the owner) can announce it, and only once the
// database itself says it is won — never on the caller's word.
router.post("/won", async (req, res) => {
  if (!need(res)) return;
  try {
    const uid = req.sentivUser || ((await userFromToken(req)) || {}).id;
    if (!uid) return res.status(401).json({ error: "sign in first" });
    const leadId = String((req.body && req.body.leadId) || "").trim();
    if (!leadId || leadId.length > 120) return res.status(400).json({ error: "leadId missing" });
    const lead = ((await sb(`leads?select=id,agent_id,data&id=eq.${encodeURIComponent(leadId)}`)) || [])[0];
    if (!lead) return res.status(404).json({ error: "deal not found" });
    if (lead.agent_id !== uid && !(await isOwner(uid))) return res.status(403).json({ error: "not your deal" });
    const d = lead.data || {};
    // 409 = not saved as won YET: the Hub's write may still be in flight. It retries.
    if (d.stage !== "Closed Won") return res.status(409).json({ error: "deal is not Closed Won (yet)" });
    if (!(Number(d.closedAt) >= Date.now() - WON_FRESH_MS)) return res.json({ ok: true, skipped: "won too long ago" });
    let card = null;
    if (req.body && req.body.card) {
      const img = decodeImage(req.body.card);
      if (img && img.ext === "jpg") { try { card = await storeImage(cardName(lead.id), img); } catch (e) { console.warn(e.message); } }
    }
    const hour = sastHour();
    if (hour < QUIET_START || hour >= QUIET_END) return res.json({ ok: true, queued: `quiet hours — goes out after ${QUIET_START}:00 SAST`, card: !!card });
    const out = await sendWon(lead, sastDay());
    res.json({ ok: true, ...out, card: !!card });
  } catch (e) {
    res.status(500).json({ error: e.message || "won push failed" });
  }
});

// Owner: upload a picture for one kind of message. Returns the file name, which the Hub
// saves into pushTemplates[kind].image on the settings row.
router.post("/image", async (req, res) => {
  if (!need(res)) return;
  try {
    const uid = req.sentivUser || ((await userFromToken(req)) || {}).id;
    if (!uid) return res.status(401).json({ error: "sign in first" });
    if (!(await isOwner(uid))) return res.status(403).json({ error: "only the owner can change notification pictures" });
    const kind = String((req.body && req.body.kind) || "");
    if (!PUSH_KINDS.includes(kind)) return res.status(400).json({ error: "unknown message kind" });
    const img = decodeImage(req.body && req.body.dataUrl);
    if (!img) return res.status(400).json({ error: "send a JPG, PNG or WebP under 1MB" });
    const file = await storeImage(`${kind}-${sha12(img.buf)}.${img.ext}`, img);
    res.json({ ok: true, file, url: imgUrl(file) });
  } catch (e) {
    res.status(500).json({ error: e.message || "upload failed" });
  }
});

// Public: phones fetch a notification's picture with no sign-in. Names are content hashes,
// so a file never changes and can be cached for a year.
const _imgCache = new Map();
router.get("/img/:file", async (req, res) => {
  const file = String(req.params.file || "");
  if (!IMG_RE.test(file) || !SB_URL || !SB_SERVICE) return res.status(404).end();
  try {
    let hit = _imgCache.get(file);
    if (!hit) {
      const r = await fetch(`${SB_URL}/storage/v1/object/${IMG_BUCKET}/${IMG_DIR}/${file}`, { headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` } });
      if (!r.ok) return res.status(404).end();
      hit = { type: file.endsWith(".png") ? "image/png" : file.endsWith(".webp") ? "image/webp" : "image/jpeg", buf: Buffer.from(await r.arrayBuffer()) };
      _imgCache.set(file, hit);
      if (_imgCache.size > 40) _imgCache.delete(_imgCache.keys().next().value);
    }
    res.set("Content-Type", hit.type);
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(hit.buf);
  } catch (e) { res.status(502).end(); }
});

// Owner: send yourself one message of a kind, filled with sample words, exactly as the
// team would get it — the "Send me a test" button under each template in the Hub.
const SAMPLE = { company: "Mthembu Logistics", value: "R84 500", agent: "Thabo", month: "R312 000", stage: "Quotation Sent", contact: "Sipho Dlamini", firstname: "Sipho", days: 9,
  todo: "This week: 2 overdue · 4 follow-ups due · 3 going cold.", lastweek: "Last week you saved 6 next steps and finished 4.",
  summary: "AI wrote 18 lines · agents saved 12 (9 from AI) · 7 marked done. Saved up 3 on the week before.",
  text: "Call Sipho about the Mthembu quote", problem: "The database isn't answering", detail: "supabase 503 · since 09:42 · test only, nothing is broken" };
const _lastPreview = {};
router.post("/preview", async (req, res) => {
  if (!need(res)) return;
  try {
    const uid = req.sentivUser || ((await userFromToken(req)) || {}).id;
    if (!uid) return res.status(401).json({ error: "sign in first" });
    if (!(await isOwner(uid))) return res.status(403).json({ error: "owner only" });
    const kind = String((req.body && req.body.kind) || "");
    if (!PUSH_KINDS.includes(kind)) return res.status(400).json({ error: "unknown message kind" });
    if (_lastPreview[uid] && Date.now() - _lastPreview[uid] < 4000) return res.status(429).json({ error: "one test every few seconds" });
    _lastPreview[uid] = Date.now();
    const subs = await subsFor(uid);
    if (!subs.length) return res.status(404).json({ error: "turn notifications on for this device first" });
    // The Hub sends the owner's on-screen draft for this kind (it may not have reached the
    // settings row yet); everything else is what is saved. tplFor cleans whatever arrives.
    const saved = (await loadTemplates(true)).tpls || {};
    const draft = req.body && req.body.tpl && typeof req.body.tpl === "object" && !Array.isArray(req.body.tpl) ? req.body.tpl : null;
    const tpls = draft ? { ...saved, [kind]: draft } : saved;
    let payload;
    if (kind === "won") {
      let card = null;
      const img = req.body && req.body.card ? decodeImage(req.body.card) : null;
      if (img && img.ext === "jpg") card = await storeImage(`card-${sha12(img.buf)}.jpg`, img);
      const fake = { id: "preview", agent_id: "preview", data: { company: SAMPLE.company, value: 84500 } };
      const list = wonPayloads(fake, { tpls, phones: {}, card, monthTotal: 312000, agentName: SAMPLE.agent, people: [{ id: uid, role: "owner" }] });
      if (!list.length) return res.status(409).json({ error: "the deal-won message is switched off" });
      payload = { ...list[0].payload, tag: "won-preview", url: `${APP_URL}/` };
    } else if (kind === "quote") {
      const fake = { id: "preview", data: { company: SAMPLE.company, value: 84500, stage: "Quotation Sent", contact: SAMPLE.contact, phone: "082 555 0172", updatedAt: Date.now() - 9 * 864e5 } };
      payload = { ...quotePayload(fake, tpls), tag: "preview-quote", url: `${APP_URL}/` };
    } else {
      const base = { tag: `preview-${kind}`, url: `${APP_URL}/`, actions: kind === "followup" || kind === "stale" ? undefined : [{ action: "open", title: "Open Hub" }] };
      payload = applyTpl({ ...base, title: PUSH_DEFAULTS[kind].title, body: "" }, kind, SAMPLE, tpls);
      if (kind === "digest") { payload.waUrl = `https://wa.me/?text=${encodeURIComponent(payload.body)}`; payload.actions = [{ action: "open", title: "Open Hub" }, { action: "wa", title: "Send to WhatsApp" }]; }
    }
    const out = await sendTo(subs, payload);
    res.json({ ok: true, devices: subs.length, ...out, image: !!payload.image });
  } catch (e) {
    res.status(500).json({ error: e.message || "test failed" });
  }
});

// Which five: the most valuable, rand for rand, whatever the reason. A deal with no
// value set sorts as 0 and falls to the back — which is what you want when 95 of 98 open
// deals carry no figure at all. Where two deals are worth the same, the follow-up wins:
// that one is a date the agent committed to, the other is only drifting.
const KIND_RANK = { quote: 1, followup: 2, stale: 3 };
const leadValue = (it) => { const v = Number(it && it.r && it.r.data && it.r.data.value); return Number.isFinite(v) ? v : 0; };
const rankForAgent = (list) => list.slice().sort((a, b) => {
  const d = leadValue(b) - leadValue(a);
  if (d !== 0) return d;
  if (a.kind !== b.kind) return (KIND_RANK[a.kind] || 9) - (KIND_RANK[b.kind] || 9);
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
    vars: { summary: body },
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
    vars: { todo, lastweek: last.trim() },
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
    const { counts, vars, ...note } = payload;
    const out = await sendTo(subs, applyTpl(note, "digest", vars, (await loadTemplates()).tpls));
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
    const { counts, vars, ...note } = p;
    const out = await sendTo(a.subs, applyTpl(note, "week", vars, (await loadTemplates()).tpls));
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
    // v234 — deals won since the last sweep that the Hub did not announce itself (offline,
    // or won during quiet hours). Same rule: a problem here never stops the alerts below.
    let won = null;
    try { won = await wonSweep(today); }
    catch (e) { won = { error: e.message || "won sweep failed" }; console.warn("won sweep failed", won.error); }
    const rows = (await sb(`leads?select=id,agent_id,data`)) || [];
    const staleCutoff = STALE_DAYS > 0 ? Date.now() - STALE_DAYS * 864e5 : null;
    const quoteCutoff = QUOTE_DAYS > 0 ? Date.now() - QUOTE_DAYS * 864e5 : null;

    // Two reasons to nudge. A deal that is BOTH due and going cold gets the follow-up
    // alert only: the dated one is the more actionable, and two buzzes about one deal
    // in one morning is how an agent learns to ignore both.
    const items = [];
    rows.forEach((r) => {
      const d = r.data || {};
      if (!r.agent_id) return;
      if (String(d.stage || "").startsWith("Closed")) return;
      // v235 — a quote gone quiet beats the plain follow-up: same deal, sharper ask, and a
      // button to message the client. An opted-out contact is never prompted (POPIA s11(3)).
      if (quoteCutoff && d.stage === "Quotation Sent" && !d.optOut && Number(d.updatedAt) && Number(d.updatedAt) <= quoteCutoff) { items.push({ r, kind: "quote" }); return; }
      if (d.followUp && String(d.followUp) <= today) { items.push({ r, kind: "followup" }); return; }
      if (staleCutoff && Number(d.updatedAt) && Number(d.updatedAt) <= staleCutoff) items.push({ r, kind: "stale" });
    });
    if (!items.length) return res.json({ ok: true, due: 0, sent: 0, digest, won });

    // One notification per lead per REASON per day. The guard rows are written BEFORE
    // the send, so a crash mid-sweep can't produce a second round on the retry.
    const todayRows = (await sb(`push_log?select=lead_id,kind,user_id&sent_on=eq.${today}`)) || [];
    const logged = new Set(todayRows.map((r) => `${r.lead_id}|${r.kind}`));
    // Deal alerts ALREADY sent to each person today. The cap is per person per DAY: the
    // sweep runs every 15 minutes, and capping each run alone let 5 more through every
    // quarter hour — 90 buzzes to one Mac on 29/09/2026 against a cap of 5.
    const sentToday = {};
    todayRows.forEach((r) => { if (r.kind === "followup" || r.kind === "stale" || r.kind === "quote") sentToday[r.user_id] = (sentToday[r.user_id] || 0) + 1; });
    // One deal alert per deal per day, whatever the reason — a deal that got its follow-up
    // alert this morning must not buzz again as a quote alert this afternoon (v235).
    const dealToday = new Set(todayRows.filter((r) => r.kind === "followup" || r.kind === "stale" || r.kind === "quote").map((r) => r.lead_id));
    const fresh = items.filter((it) => !logged.has(`${it.r.id}|${it.kind}`) && !dealToday.has(it.r.id));
    if (!fresh.length) return res.json({ ok: true, due: items.length, sent: 0, note: "all already notified today", digest, won });

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
    const { tpls } = await loadTemplates(true);
    for (const [agentId, list] of Object.entries(byAgent)) {
      const subs = await subsFor(agentId);
      if (!subs.length) continue;
      await sb("push_log", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(list.map((it) => ({ lead_id: it.r.id, kind: it.kind, user_id: agentId, sent_on: today }))),
      });
      for (const it of list) {
        const out = await sendTo(subs, payloadFor(it.r, it.kind, tpls));
        sent += out.sent; pruned += out.pruned; notified++;
      }
    }
    res.json({
      ok: true,
      due: items.length,
      followups: fresh.filter((i) => i.kind === "followup").length,
      quotes: fresh.filter((i) => i.kind === "quote").length,
      stale: fresh.filter((i) => i.kind === "stale").length,
      leadsNotified: notified, sent, pruned, held, maxPerAgent: MAX_PER_AGENT, digest, won,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "sweep failed" });
  }
});

// ---- Personal reminders (Hub v239) ----------------------------------------------------
// Anyone can set reminders for themselves in Settings → Notifications. The Hub keeps them
// in that person's own user_state row "reminders" (it syncs like their text size does);
// this loop reads those rows once a minute and buzzes the person's own devices at the time
// they picked. Quiet hours do NOT apply: the person chose the time.
//
// A reminder: { id, text, time "HH:MM" (SAST), date "YYYY-MM-DD", repeat, off, created }
//   repeat "once"     → on `date`
//          "daily"    → every day from `date`
//          "weekdays" → Monday to Friday from `date`
//          "weekly"   → the weekday of `date`, every week from it
// One push per reminder per day (push_log guard row, written first). A reminder whose time
// passed while this server was restarting still goes out up to REMIND_LATE_MIN later; older
// than that it is skipped rather than buzzing about a 09:00 call at 17:00.
const REMIND_MS = num(process.env.PUSH_REMIND_MS, 60000);
const REMIND_LATE_MIN = 6 * 60;
const SAST_MS = 2 * 3600e3;   // South Africa has no daylight saving
const REMIND_ID = /^[a-z0-9]{4,24}$/i;
function sastParts(ms) {
  const d = new Date(ms + SAST_MS);
  return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}
const dowOf = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
// Pure: the reminders in `list` that should buzz at `now`.
function remindersDue(list, now) {
  const t = sastParts(now);
  const out = [];
  (Array.isArray(list) ? list : []).forEach((r) => {
    if (!r || typeof r !== "object" || r.off || !REMIND_ID.test(String(r.id || ""))) return;
    const text = String(r.text || "").trim();
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(r.time || ""));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || "")) ? r.date : "";
    if (!text || !m || !date) return;
    const rep = r.repeat || "once";
    const onDay = rep === "once" ? t.day === date
      : t.day < date ? false
      : rep === "daily" ? true
      : rep === "weekdays" ? t.dow >= 1 && t.dow <= 5
      : rep === "weekly" ? t.dow === dowOf(date)
      : false;
    if (!onDay) return;
    const at = Number(m[1]) * 60 + Number(m[2]);
    if (t.min < at || t.min - at > REMIND_LATE_MIN) return;
    // Set AFTER today's time had already passed? Then it starts next time, not right now.
    const occurs = Date.parse(`${t.day}T00:00:00Z`) - SAST_MS + at * 60e3;
    if (Number(r.created) > occurs) return;
    out.push({ id: r.id, text: text.slice(0, 200), time: r.time, repeat: rep });
  });
  return out;
}
function remindPayload(r, tpls) {
  return {
    ...applyTpl({ title: "Reminder", body: r.text, tag: `remind-${r.id}`, url: `${APP_URL}/` }, "remind", { text: r.text, time: r.time }, tpls),
    sticky: true,                       // stays on screen until dealt with
    actions: [{ action: "open", title: "Open Hub" }, { action: "snooze", title: "Done" }],
  };
}
const _remindLast = { at: 0, error: "" };
async function remindSweep(now = Date.now()) {
  const rows = (await sb("user_state?select=agent_id,data&id=eq.reminders")) || [];
  const today = sastParts(now).day;
  let due = 0, sent = 0;
  let tpls = null;
  for (const row of rows) {
    const list = remindersDue(row && row.data && row.data.v, now);
    for (const r of list) {
      due++;
      const fresh = await sb("push_log", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify([{ lead_id: `remind-${row.agent_id}-${r.id}`, kind: "remind", user_id: row.agent_id, sent_on: today }]),
      });
      if (!Array.isArray(fresh) || !fresh.length) continue;
      if (!tpls) tpls = (await loadTemplates(true)).tpls;   // fresh: the owner may have just changed the wording
      const subs = await subsFor(row.agent_id);
      if (!subs.length) continue;
      const out = await sendTo(subs, remindPayload(r, tpls), { urgency: "high", ttl: 3600 * 6 });
      sent += out.sent;
    }
  }
  return { people: rows.length, due, sent };
}

// "Send me this now" under each reminder — any signed-in person, to their own devices.
const _lastRemindTest = {};
router.post("/remind/test", async (req, res) => {
  if (!need(res)) return;
  try {
    const uid = req.sentivUser || ((await userFromToken(req)) || {}).id;
    if (!uid) return res.status(401).json({ error: "sign in first" });
    if (_lastRemindTest[uid] && Date.now() - _lastRemindTest[uid] < 4000) return res.status(429).json({ error: "one test every few seconds" });
    _lastRemindTest[uid] = Date.now();
    const text = String((req.body && req.body.text) || "").trim().slice(0, 200) || "Your reminder";
    const subs = await subsFor(uid);
    if (!subs.length) return res.status(404).json({ error: "turn notifications on for this device first" });
    const out = await sendTo(subs, { ...remindPayload({ id: "test", text, time: "" }, (await loadTemplates()).tpls), tag: "remind-test" }, { urgency: "high" });
    res.json({ ok: true, devices: subs.length, ...out });
  } catch (e) {
    res.status(500).json({ error: e.message || "test failed" });
  }
});

// ---- Platform watchdog (Hub v239) ----------------------------------------------------
// Every WATCH_MS this server checks the parts that, broken, stop the team working, and
// buzzes the owner(s) — any hour, high urgency, stays on screen — when one stays broken.
// See watchdog.js for when it buzzes. The owner can switch it off with the "Platform
// problem" alert's Off button in the Hub (pushTemplates.alert.off).
//
// What it can NOT catch: this server itself being down — then nothing here runs. That case
// is still covered by GitHub's email from the scheduled health check.
const { createWatchdog } = require("./watchdog");
const WATCH_MS = num(process.env.PUSH_WATCH_MS, 5 * 60000);
const HUB_URL = (process.env.HUB_URL || APP_URL).replace(/\/+$/, "");
// The PUBLIC anon key — it ships in the live page. With it, private tables must read empty.
const ANON = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVsdm1wdWdqeG56YWp2Z3ZodHpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMjE2MTgsImV4cCI6MjA5OTc5NzYxOH0.BHl5AtPoU-t2pP7AzDG6IqZ2uKdJtNNZdDbW6MZtUfg";
const SELF = () => `http://127.0.0.1:${process.env.PORT || 8787}`;
const hhmm = (ms) => { const d = new Date(ms + SAST_MS); return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
const forMins = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 90 ? `${m} min` : `${Math.round(m / 60)} hours`; };

// Pure: the watchdog's verdict for a round → what the owner's phone shows.
function alertPayloads(ev, tpls) {
  const out = [];
  const t = tplFor("alert", tpls);
  if (t.off) return out;
  if (ev.down && ev.down.length) {
    const one = ev.down.length === 1 ? ev.down[0] : null;
    const problem = one ? one.label : `${ev.down.length} things are broken`;
    const detail = one
      ? `${one.detail || "failing"} · since ${hhmm(one.since)}${one.again ? " · still broken" : ""}`
      : ev.down.map((d) => d.label).join(" · ");
    out.push({
      ...applyTpl({ title: `Sentiv needs you: ${problem}`, body: detail, tag: "platform-alert", url: `${APP_URL}/` }, "alert", { problem, detail }, tpls),
      sticky: true, actions: [{ action: "open", title: "Open Hub" }],
    });
  }
  if (ev.fixed && ev.fixed.length) {
    const one = ev.fixed.length === 1 ? ev.fixed[0] : null;
    out.push({
      title: one ? `Fixed: ${one.label}` : `Fixed: ${ev.fixed.length} problems`,
      body: one ? `Working again after ${forMins(one.downMs)}.` : ev.fixed.map((f) => f.label).join(" · "),
      tag: "platform-fixed", url: `${APP_URL}/`, actions: [{ action: "open", title: "Open Hub" }],
    });
  }
  return out;
}
async function notifyOwners(ev) {
  if (!configured || !SB_URL || !SB_SERVICE) { console.warn("watchdog: cannot push", JSON.stringify(ev)); return; }
  const tpls = (await loadTemplates(true)).tpls;
  const list = alertPayloads(ev, tpls);
  if (!list.length) return;
  const owners = (await sb("profiles?select=id&role=eq.owner")) || [];
  for (const o of owners) {
    const subs = await subsFor(o.id);
    for (const p of list) await sendTo(subs, p, { urgency: "high", ttl: 3600 * 12 });
  }
  console.log("watchdog alert", JSON.stringify({ down: (ev.down || []).map((d) => d.name), fixed: (ev.fixed || []).map((f) => f.name), owners: owners.length }));
}
const watch = createWatchdog({ notify: notifyOwners });
const watchStatus = () => { const s = watch.status(); return { checkedAt: s.checkedAt ? new Date(s.checkedAt).toISOString() : null, failing: s.failing.map((f) => f.label) }; };

const getJson = async (url, opts) => { const r = await fetch(url, opts); return { status: r.status, json: await r.json().catch(() => null) }; };
const WATCH_CHECKS = [
  { name: "hub", label: "The Hub website is down", run: async () => {
    const r = await fetch(`${HUB_URL}/?watchdog=${Date.now()}`);
    const t = r.ok ? await r.text() : "";
    return { ok: r.ok && /sentiv-hub-v\d+ build/.test(t), detail: r.ok ? "page loads but has no Hub build in it" : `HTTP ${r.status}` };
  } },
  { name: "signin", label: "Sign-in is down", run: async () => {
    const r = await fetch(`${SB_URL}/auth/v1/health`, { headers: { apikey: SB_SERVICE } });
    return { ok: r.ok, detail: `Supabase sign-in HTTP ${r.status}` };
  } },
  { name: "database", label: "The database isn't answering", run: async () => {
    try { await sb("profiles?select=id&limit=1"); return { ok: true }; }
    catch (e) { return { ok: false, detail: String(e.message || e).slice(0, 120) }; }
  } },
  { name: "datalock", label: "Private data is open to the public", run: async () => {
    const leaked = [];
    for (const t of ["leads", "profiles", "team_settings", "documents", "push_subscriptions", "user_state"]) {
      const r = await getJson(`${SB_URL}/rest/v1/${t}?select=*&limit=1`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
      if (r.status === 200 && Array.isArray(r.json) && r.json.length) leaked.push(t);
    }
    return { ok: !leaked.length, detail: `public key can read: ${leaked.join(", ")}` };
  } },
  // An outside call (Euphoria), so every 3rd round — about every 15 minutes.
  { name: "phones", label: "Phones (Euphoria) aren't connected", every: 3, run: async () => {
    const r = await getJson(`${SELF()}/api/euphoria/health`);
    const j = r.json || {};
    if (j.auth === "not configured") return { skip: true };
    return { ok: j.auth === "accepted", detail: String(j.auth || `HTTP ${r.status}`).slice(0, 120) };
  } },
];

// The scheduled GitHub health check posts every result here; a failed one buzzes at once
// (it already ran on a schedule), a passing one clears it. It proves it is OUR workflow on
// main with a GitHub-signed token, same as the call-archive sweep — no shared secret.
const { fromOurWorkflow } = require("./euphoria-routes");
router.post("/alert", async (req, res) => {
  if (!(await fromOurWorkflow(req))) return res.status(401).json({ error: "only the Sentiv health-check workflow can report problems" });
  const results = Array.isArray(req.body && req.body.results) ? req.body.results.slice(0, 200) : [];
  results.forEach((r) => {
    if (!r || typeof r.name !== "string") return;
    const name = `gh:${String(r.area || "")}:${r.name}`.slice(0, 160);
    watch.report(name, !!r.ok, String(r.detail || "").slice(0, 160), { label: `${r.area ? r.area + ": " : ""}${r.name}`.slice(0, 120), immediate: true });
  });
  const out = await watch.flush();
  res.json({ ok: true, received: results.length, alerted: (out.down || []).length, fixed: (out.fixed || []).length });
});

let _watchBusy = false, _remindBusy = false;
async function watchTick() {
  if (_watchBusy || !SB_URL || !SB_SERVICE) return;
  _watchBusy = true;
  try { await watch.run(WATCH_CHECKS); } catch (e) { console.warn("watchdog round failed", e.message); }
  finally { _watchBusy = false; }
}
async function remindTick() {
  if (_remindBusy || !configured || !SB_URL || !SB_SERVICE) return;
  _remindBusy = true;
  try {
    await remindSweep();
    _remindLast.at = Date.now(); _remindLast.error = "";
    watch.report("reminders", true, "", { label: "Reminders aren't sending" });
  } catch (e) {
    _remindLast.error = String(e.message || e).slice(0, 160);
    console.warn("reminder sweep failed", _remindLast.error);
    watch.report("reminders", false, _remindLast.error, { label: "Reminders aren't sending" });
    await watch.flush();
  } finally { _remindBusy = false; }
}
if (!process.env.PUSH_LOOPS_OFF) {
  if (WATCH_MS > 0) { setTimeout(watchTick, 60000).unref(); setInterval(watchTick, WATCH_MS).unref(); }
  if (REMIND_MS > 0) setInterval(remindTick, REMIND_MS).unref();
}

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
    }).then(async (r) => {
      const d = await r.json().catch(() => ({}));
      watch.report("sweep", r.ok, r.ok ? "" : `HTTP ${r.status} ${String(d.error || "").slice(0, 120)}`, { label: "Follow-up alerts stopped sending", immediate: true });
      await watch.flush();
    }).catch((e) => console.warn("scheduled sweep failed", e.message));
  }, SWEEP_MS).unref();
  console.log(`push: in-process sweep every ${Math.round(SWEEP_MS / 60000)} min`);
}

module.exports = router;
module.exports._digestPayload = digestPayload;   // for tests only
module.exports._agentWeekPayload = agentWeekPayload;
module.exports._fillTpl = fillTpl;
module.exports._tplFor = tplFor;
module.exports._applyTpl = applyTpl;
module.exports._wonPayloads = wonPayloads;
module.exports._monthWonTotal = monthWonTotal;
module.exports._payloadFor = payloadFor;
module.exports._decodeImage = decodeImage;
module.exports._quotePayload = quotePayload;
module.exports._cellOf = cellOf;
module.exports._rankForAgent = rankForAgent;
module.exports._remindersDue = remindersDue;
module.exports._remindPayload = remindPayload;
module.exports._alertPayloads = alertPayloads;
module.exports._watch = () => watch;
module.exports._remindSweep = remindSweep;
