// Digital Rewards website → Hub leads (15 Nov 2026).
//
// The public Digital Rewards website has a "Free Growth Assessment" form. It posts here and
// the enquiry lands in the owner's Digital Rewards Lead Gen list as a normal lead
// (business "rewards", stage Lead, follow-up today).
//
//   POST /api/rewards/web-lead   public — the website's form
//   GET  /api/rewards/health     public — what is configured, no secrets
//
// This route has NO sign-in (strangers fill in the form), so it protects itself:
//   - WEBLEAD_ORIGINS  required — comma-separated origins of the website, e.g.
//                      "https://www.digitalrewards.co.za". Unset = the route is shut (503).
//                      A browser on any other site is refused (403). server.js applies the
//                      same list as this path's CORS rule.
//   - a honeypot field ("website"): bots fill it, people never see it → accepted, nothing saved.
//   - every field is checked and cut to length; anything else in the body is dropped.
//   - at most 5 posts per address in 10 minutes and WEBLEAD_DAILY_CAP (100) a day in all.
//   - the same email or number twice within a day saves one lead.
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  required — owner lookup + lead insert.
const express = require("express");
const router = express.Router();

const env = (k) => (process.env[k] || "").trim();
const SB_URL = () => env("SUPABASE_URL").replace(/\/+$/, "");
const SB_SERVICE = () => env("SUPABASE_SERVICE_KEY");
const svc = (extra = {}) => ({ apikey: SB_SERVICE(), Authorization: `Bearer ${SB_SERVICE()}`, "Content-Type": "application/json", ...extra });
const origins = () => env("WEBLEAD_ORIGINS").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
const dailyCap = () => Math.max(1, Number(env("WEBLEAD_DAILY_CAP")) || 100);

let _fetch = (...a) => fetch(...a);
router._setFetch = (f) => { _fetch = f; };   // tests
let _now = () => Date.now();
router._setNow = (f) => { _now = f; };       // tests

const TYPES = ["Restaurant, café or takeaway", "Cannabis retailer", "Butchery or speciality retail", "Shopping centre", "Salon or barber",
  "Spa or beauty", "Hotel or hospitality", "Gym or fitness", "Retail store", "Other"];
const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
// South African numbers only, stored the way the Hub shows them: "082 123 4567".
function saPhone(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.startsWith("0027")) d = d.slice(4); else if (d.startsWith("27") && d.length === 11) d = d.slice(2);
  if (d.length === 9) d = "0" + d;
  if (!/^0[1-8]\d{8}$/.test(d)) return "";
  return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}
const pad = (n) => String(n).padStart(2, "0");
const sastDay = (ms) => new Date(ms + 2 * 3600e3).toISOString().slice(0, 10);
const dmy = (day) => day.split("-").reverse().join("/");

// Returns { lead } or { error }. Pure — the tests call it directly.
function buildWebLead(body, now) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const name = clean(b.name, 80), company = clean(b.business, 120), type = clean(b.type, 60);
  const email = clean(b.email, 120).toLowerCase(), phone = saPhone(b.whatsapp);
  const branches = Math.floor(Number(b.branches)), challenge = clean(b.challenge, 600);
  const page = (clean(b.page, 80).match(/^\/[a-z0-9\-./]*$/i) || [""])[0];
  if (name.length < 2) return { error: "Please enter your name." };
  if (company.length < 2) return { error: "Please enter your business name." };
  if (!TYPES.includes(type)) return { error: "Please choose a business type." };
  if (!(branches >= 1 && branches <= 500)) return { error: "Please enter the number of branches." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { error: "Please enter a valid email address." };
  if (!phone) return { error: "Please enter a valid South African WhatsApp number." };
  if (!(b.consent === true || b.consent === "on" || b.consent === "true")) return { error: "Please tick the consent box." };
  const day = sastDay(now);
  const ret = new Date(now); ret.setUTCFullYear(ret.getUTCFullYear() + 3);
  const lead = {
    id: "L" + now.toString(36) + "s" + Math.random().toString(36).slice(2, 7),
    company, contact: name, phone, email, vertical: type, branches,
    notes: ["Website enquiry", `${branches} ${branches === 1 ? "branch" : "branches"}`, challenge ? `Challenge: ${challenge}` : ""].filter(Boolean).join(" · "),
    value: 0, stage: "Lead", source: "website", activities: [], updatedAt: now, stageEnteredAt: now, followUp: day,
    consentBasis: "consent", consentSource: `Website form${page ? ` (${page})` : ""}, ${dmy(day)} — ticked the POPIA consent box`,
    retainUntil: `${ret.getUTCFullYear()}-${pad(ret.getUTCMonth() + 1)}-${pad(ret.getUTCDate())}`,
    webLead: { at: now, page },
    business: "rewards",
  };
  return { lead };
}

// ---- limits (in memory: one small server, and a restart only loosens them briefly) ----
const hits = new Map();   // ip -> [ms, ...]
let dayCount = { day: "", n: 0 };
function clientIp(req) {
  const xff = String(req.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  return req.get("x-real-ip") || xff[xff.length - 1] || req.ip || "?";
}
function limited(ip, now) {
  const recent = (hits.get(ip) || []).filter((t) => now - t < 600e3);
  if (recent.length >= 5) { hits.set(ip, recent); return "Too many requests. Please try again in a few minutes."; }
  const day = sastDay(now);
  if (dayCount.day !== day) dayCount = { day, n: 0 };
  if (dayCount.n >= dailyCap()) return "We are receiving a lot of requests. Please WhatsApp us instead.";
  recent.push(now); hits.set(ip, recent); dayCount.n++;
  if (hits.size > 2000) hits.delete(hits.keys().next().value);
  return "";
}
router._resetLimits = () => { hits.clear(); dayCount = { day: "", n: 0 }; _owner = null; };

let _owner = null;   // { id, until }
async function ownerId(now) {
  if (_owner && _owner.until > now) return _owner.id;
  const r = await _fetch(`${SB_URL()}/rest/v1/profiles?select=id&role=eq.owner&limit=1`, { headers: svc() });
  const rows = r.ok ? await r.json() : [];
  const id = rows && rows[0] && rows[0].id;
  if (id) _owner = { id, until: now + 600e3 };
  return id || null;
}
async function alreadySent(lead, now) {
  const since = new Date(now - 24 * 3600e3).toISOString();
  const q = `leads?select=id&data->>source=eq.website&updated_at=gte.${encodeURIComponent(since)}` +
    `&or=(${encodeURIComponent(`data->>email.eq."${lead.email}",data->>phone.eq."${lead.phone}"`)})&limit=1`;
  const r = await _fetch(`${SB_URL()}/rest/v1/${q}`, { headers: svc() });
  if (!r.ok) return false;   // a failed look-up must not lose a real enquiry
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

router.get("/health", (_req, res) => {
  res.json({ ok: true, webLead: { open: origins().length > 0 && !!SB_URL() && !!SB_SERVICE(), origins: origins().length, supabase: !!SB_URL() && !!SB_SERVICE(), dailyCap: dailyCap() } });
});

router.post("/web-lead", async (req, res) => {
  try {
    const allow = origins();
    if (!allow.length || !SB_URL() || !SB_SERVICE()) return res.status(503).json({ error: "The website form is not switched on yet." });
    const origin = String(req.get("origin") || "").replace(/\/+$/, "");
    if (!allow.includes(origin)) return res.status(403).json({ error: "Not allowed from this website." });
    if (req.rawBody && req.rawBody.length > 8192) return res.status(413).json({ error: "That message is too long." });
    const body = req.body || {};
    if (clean(body.website, 200)) return res.json({ ok: true });   // honeypot: a bot. Say thanks, save nothing.
    const now = _now();
    const built = buildWebLead(body, now);
    if (built.error) return res.status(400).json({ error: built.error });
    const why = limited(clientIp(req), now);
    if (why) return res.status(429).json({ error: why });
    if (await alreadySent(built.lead, now)) return res.json({ ok: true });
    const owner = await ownerId(now);
    if (!owner) return res.status(502).json({ error: "Could not save your request. Please WhatsApp us." });
    const row = { id: built.lead.id, agent_id: owner, data: built.lead, updated_at: new Date(now).toISOString() };
    const r = await _fetch(`${SB_URL()}/rest/v1/leads`, { method: "POST", headers: svc({ Prefer: "return=minimal" }), body: JSON.stringify(row) });
    if (!r.ok) { console.error("web-lead insert failed", r.status, (await r.text()).slice(0, 200)); return res.status(502).json({ error: "Could not save your request. Please WhatsApp us." }); }
    console.log("web-lead saved", JSON.stringify({ id: row.id, type: built.lead.vertical, branches: built.lead.branches }));
    res.json({ ok: true });
  } catch (e) {
    console.error("web-lead error", e.message);
    res.status(502).json({ error: "Could not save your request. Please WhatsApp us." });
  }
});

module.exports = router;
Object.assign(module.exports, { buildWebLead, saPhone, origins, TYPES });
