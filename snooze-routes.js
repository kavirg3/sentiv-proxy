// Snooze on a push alert (23 Nov 2026, Hub v347).
//
//   POST /api/push/snooze   public — the Hub's service worker calls it when Snooze is tapped
//
// Before this, Snooze only closed the alert (deal alerts came back with the next day's sweep).
// Now the alert comes back on the SAME device after SNOOZE_MINUTES (60), still with its
// Snooze button, so it can be snoozed again.
//
// Who is asking? A service worker has no sign-in token, so the proof is the device's own push
// endpoint: a long secret URL only that browser knows. It must be a row in push_subscriptions,
// and the alert only ever goes back to that one endpoint — nobody can buzz someone else.
//
// Reminders' "Done" button uses the same action name; the service worker never calls this for
// them (they are the sticky ones). Quiet hours are kept: a snooze that would land outside
// PUSH_QUIET_START..PUSH_QUIET_END (SAST, default 7..18) waits until QUIET_START next morning.
//
// Pending snoozes are kept in Storage, backups/push-snoozes/<due ms>-<id>.json, so a redeploy
// does not lose them; they are read back when the server starts.
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, VAPID_*   required (same as push-routes.js)
//   PUSH_SNOOZE_MINUTES                            optional, default 60
const express = require("express");
const router = express.Router();

const env = (k) => (process.env[k] || "").trim();
const num = (v, d) => { if (v === "" || v == null) return d; const n = Number(v); return Number.isFinite(n) ? n : d; };   // unset = default, not 0
const SB_URL = () => env("SUPABASE_URL").replace(/\/+$/, "");
const SB_SERVICE = () => env("SUPABASE_SERVICE_KEY");
const APP_URL = () => (env("PUSH_APP_URL") || "https://sentiv-sales-hub.pages.dev").replace(/\/+$/, "");
const MINUTES = () => Math.max(1, num(env("PUSH_SNOOZE_MINUTES"), 60));
const QUIET_START = () => num(env("PUSH_QUIET_START"), 7);
const QUIET_END = () => num(env("PUSH_QUIET_END"), 18);
const DIR = "push-snoozes";
const MAX_PER_DEVICE = 20;
const svc = (extra = {}) => ({ apikey: SB_SERVICE(), Authorization: `Bearer ${SB_SERVICE()}`, ...extra });

let _fetch = (...a) => fetch(...a);
router._setFetch = (f) => { _fetch = f; };     // tests
let _now = () => Date.now();
router._setNow = (f) => { _now = f; };         // tests
let _push = async (sub, payload) => {
  const pub = env("VAPID_PUBLIC_KEY"), priv = env("VAPID_PRIVATE_KEY"), subj = env("VAPID_SUBJECT");
  if (!pub || !priv || !subj) return false;
  const webpush = require("web-push");
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload),
      { TTL: 3600 * 12, urgency: "normal", vapidDetails: { subject: subj, publicKey: pub, privateKey: priv } });
    return true;
  } catch (e) { console.warn("snooze re-send failed", (e && e.statusCode) || "", (e && e.message) || e); return false; }
};
router._setPush = (f) => { _push = f; };       // tests

const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const httpsOk = (v, max = 600) => { const s = String(v || ""); return s.indexOf("https://") === 0 && s.length <= max && !/[\s<>"']/.test(s) ? s : ""; };

// When a snooze made at `now` comes back: an hour on, or the start of the next working
// morning if that hour falls in quiet hours. SAST is UTC+2 all year.
function dueAt(now) {
  const t = now + MINUTES() * 60e3;
  const s = new Date(t + 2 * 3600e3), h = s.getUTCHours() + s.getUTCMinutes() / 60;
  if (h >= QUIET_START() && h < QUIET_END()) return t;
  let morning = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate(), QUIET_START()) - 2 * 3600e3;
  if (h >= QUIET_END()) morning += 24 * 3600e3;
  return morning;
}

// What goes back to the phone: the alert as it was, tidied. The service worker cleans it
// again when it shows it (links https only, WhatsApp links wa.me only).
function buildSnooze(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const endpoint = httpsOk(b.endpoint, 1000);
  if (!endpoint) return { error: "No device." };
  const title = clean(b.title, 120);
  if (!title) return { error: "Nothing to snooze." };
  const app = APP_URL();
  const rawUrl = clean(b.url, 600);
  const url = rawUrl.indexOf(app + "/") === 0 || rawUrl === app ? rawUrl : rawUrl.indexOf("/") === 0 && rawUrl.indexOf("//") !== 0 ? app + rawUrl : app + "/";
  const payload = { title, body: clean(b.body, 400), tag: clean(b.tag, 100) || "snooze", url, snoozed: true };
  if (/^[A-Za-z0-9_-]{1,60}$/.test(String(b.leadId || ""))) payload.leadId = String(b.leadId);
  const img = httpsOk(b.image); if (img) payload.image = img;
  const wa = String(b.waUrl || ""); if (wa.indexOf("https://wa.me/") === 0 && httpsOk(wa)) payload.waUrl = wa;
  if (b.links && typeof b.links === "object") {
    const links = {};
    ["open", "wa", "snooze"].forEach((k) => { const v = httpsOk(b.links[k]); if (v) links[k] = v; });
    if (Object.keys(links).length) payload.links = links;
  }
  if (Array.isArray(b.actions)) {
    const acts = b.actions.slice(0, 2).map((a) => ({ action: String((a && a.action) || ""), title: clean(a && a.title, 30) }))
      .filter((a) => ["open", "wa", "snooze"].includes(a.action) && a.title);
    if (acts.length) payload.actions = acts;
  }
  return { endpoint, payload };
}

// ---- pending snoozes: memory first, Storage as the copy that survives a restart ----
const pending = new Map();   // file name -> { due, endpoint, payload }
const storeUrl = (name) => `${SB_URL()}/storage/v1/object/backups/${DIR}/${name}`;
async function save(name, item) {
  try {
    const r = await _fetch(storeUrl(name), { method: "POST", headers: svc({ "Content-Type": "application/json", "x-upsert": "true" }), body: JSON.stringify(item) });
    if (!r.ok) console.warn("snooze save failed", r.status);
  } catch (e) { console.warn("snooze save failed", e.message); }
}
async function drop(name) {
  pending.delete(name);
  try { await _fetch(`${SB_URL()}/storage/v1/object/backups`, { method: "DELETE", headers: svc({ "Content-Type": "application/json" }), body: JSON.stringify({ prefixes: [`${DIR}/${name}`] }) }); }
  catch (e) { console.warn("snooze delete failed", e.message); }
}
async function subFor(endpoint) {
  const r = await _fetch(`${SB_URL()}/rest/v1/push_subscriptions?select=endpoint,p256dh,auth&endpoint=eq.${encodeURIComponent(endpoint)}&limit=1`, { headers: svc() });
  if (!r.ok) throw new Error(`lookup ${r.status}`);
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

let _loaded = false;
async function loadPending() {
  if (_loaded || !SB_URL() || !SB_SERVICE()) return;
  try {
    const r = await _fetch(`${SB_URL()}/storage/v1/object/list/backups`, { method: "POST", headers: svc({ "Content-Type": "application/json" }), body: JSON.stringify({ prefix: `${DIR}/`, limit: 1000 }) });
    if (!r.ok) return;   // try again next tick
    const files = (await r.json()) || [];
    for (const f of files) {
      const name = String((f && f.name) || "");
      if (!/^\d{13}-[a-z0-9]{6,12}\.json$/.test(name) || pending.has(name)) continue;
      const g = await _fetch(storeUrl(name), { headers: svc() });
      if (!g.ok) continue;
      const item = await g.json().catch(() => null);
      if (item && item.endpoint && item.payload && Number(item.due)) pending.set(name, { due: Number(item.due), endpoint: item.endpoint, payload: item.payload });
    }
    _loaded = true;
    if (pending.size) console.log("snooze: picked up", pending.size, "waiting");
  } catch (e) { console.warn("snooze load failed", e.message); }
}

let _busy = false;
async function tick() {
  if (_busy) return 0;
  _busy = true;
  let sent = 0;
  try {
    await loadPending();
    const now = _now();
    for (const [name, item] of [...pending.entries()]) {
      if (item.due > now) continue;
      let sub = null;
      try { sub = await subFor(item.endpoint); } catch (e) { continue; }   // database hiccup: keep it, try next tick
      if (sub && await _push(sub, item.payload)) sent++;
      await drop(name);   // sent, or the device is gone: either way it is finished
    }
  } finally { _busy = false; }
  return sent;
}
router._tick = tick;
router._dueAt = dueAt;
router._build = buildSnooze;
router._pending = pending;
router._reset = () => { pending.clear(); _loaded = false; hits.clear(); };

const hits = new Map();   // ip -> [ms]
router.post("/", async (req, res) => {
  try {
    if (!SB_URL() || !SB_SERVICE()) return res.status(503).json({ error: "Snooze is not set up." });
    const now = _now();
    const ip = String(req.get("x-real-ip") || req.ip || "?");
    const recent = (hits.get(ip) || []).filter((t) => now - t < 600e3);
    if (recent.length >= 30) return res.status(429).json({ error: "Too many." });
    recent.push(now); hits.set(ip, recent); if (hits.size > 2000) hits.delete(hits.keys().next().value);
    const built = buildSnooze(req.body);
    if (built.error) return res.status(400).json({ error: built.error });
    const sub = await subFor(built.endpoint);
    if (!sub) return res.status(404).json({ error: "Unknown device." });
    await loadPending();
    // The same alert snoozed twice on one device: the newer one replaces the older.
    for (const [name, it] of [...pending.entries()]) if (it.endpoint === built.endpoint && it.payload.tag === built.payload.tag) await drop(name);
    if ([...pending.values()].filter((it) => it.endpoint === built.endpoint).length >= MAX_PER_DEVICE) return res.status(429).json({ error: "Too many snoozed." });
    const due = dueAt(now);
    const name = `${due}-${Math.random().toString(36).slice(2, 10).padEnd(6, "0")}.json`;
    const item = { due, endpoint: built.endpoint, payload: built.payload };
    pending.set(name, item);
    await save(name, item);
    console.log("snooze", JSON.stringify({ tag: built.payload.tag, inMin: Math.round((due - now) / 60000) }));
    res.json({ ok: true, due });
  } catch (e) {
    console.warn("snooze error", e.message);
    res.status(502).json({ error: "Could not snooze." });
  }
});

if (!process.env.PUSH_LOOPS_OFF) {
  setTimeout(() => tick().catch(() => {}), 20000).unref();
  setInterval(() => tick().catch((e) => console.warn("snooze tick failed", e.message)), 30000).unref();
}

module.exports = router;
