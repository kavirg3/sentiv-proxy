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
//   Each saved enquiry also pushes the owner's phone (23 Nov 2026); tapping it opens the lead.
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

const TYPES = ["Shopping centre", "Restaurant, café or takeaway", "Salon or barber", "Spa or beauty", "Butchery or speciality retail",
  "Hotel or hospitality", "Gym or fitness", "Retail store", "Other"];
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
    // Someone who asked to be called goes to the TOP of Up next: ranked leads come first,
    // lowest rank first (Hub v246), so a negative rank that falls with time puts the newest enquiry first.
    callRank: -Math.floor(now / 1000),
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
    tellOwnerLead(owner, built.lead).then((n) => console.log("web-lead push", JSON.stringify({ id: row.id, pushed: n })));
  } catch (e) {
    console.error("web-lead error", e.message);
    res.status(502).json({ error: "Could not save your request. Please WhatsApp us." });
  }
});

// ---- Area partner applications (22 Nov 2026) ----
//
//   POST /api/rewards/partner-apply   public — the website's /area-partners form
//
// People applying to be an Area Partner (they run meetings and look after clients). These are
// NOT sales leads, so they never go in the leads table (that would put them in Thembi's list).
// Each one is saved as a JSON file in the private "backups" bucket under partner-apps/ and the
// owner gets a push with the name, city and number. Same origin list, honeypot and limits as web-lead.
const crypto = require("crypto");
const PARTNER_CITIES = ["Johannesburg", "Durban"];
const PARTNER_EXPERIENCE = ["No sales experience yet", "Less than 1 year", "1 to 3 years", "More than 3 years"];
const PARTNER_WORK = ["Full-time job", "Part-time job", "Self-employed", "Not working right now"];
const PARTNER_HOURS = ["Under 10 hours", "10 to 20 hours", "More than 20 hours"];
const PARTNER_LANGS = ["English", "isiZulu", "Afrikaans", "Sesotho", "isiXhosa", "Setswana", "Sepedi", "Other"];
const PARTNER_HEARD = ["LinkedIn", "Pnet", "WhatsApp", "A friend", "Other"];
const PARTNER_STATUSES = ["New", "Chatted", "Interview", "Onboarded", "Declined"];
const yesNo = (v) => (v === "yes" || v === true ? true : v === "no" || v === false ? false : null);
const APP_DIR = "backups/partner-apps";

function buildPartnerApp(body, now) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const name = clean(b.name, 80), city = clean(b.city, 40), experience = clean(b.experience, 40);
  const email = clean(b.email, 120).toLowerCase(), phone = saPhone(b.whatsapp);
  const car = yesNo(b.car), laptop = yesNo(b.laptop);
  const about = clean(b.about, 800), suburb = clean(b.suburb, 60);
  const work = clean(b.work, 40), hours = clean(b.hours, 40), heard = clean(b.heard, 40);
  const langIn = Array.isArray(b.languages) ? b.languages : String(b.languages || "").split(",");
  const languages = PARTNER_LANGS.filter((l) => langIn.map((x) => clean(x, 20)).includes(l));
  let linkedin = clean(b.linkedin, 200);
  if (linkedin && !/^https?:\/\//i.test(linkedin)) linkedin = `https://${linkedin}`;
  const page = (clean(b.page, 80).match(/^\/[a-z0-9\-./]*$/i) || [""])[0];
  if (name.length < 2) return { error: "Please enter your name." };
  if (!PARTNER_CITIES.includes(city)) return { error: "Please choose your city." };
  if (!PARTNER_EXPERIENCE.includes(experience)) return { error: "Please choose your sales experience." };
  if (suburb.length < 2) return { error: "Please enter the suburb you live in." };
  if (!PARTNER_WORK.includes(work)) return { error: "Please choose what you do now." };
  if (!PARTNER_HOURS.includes(hours)) return { error: "Please choose how many hours a week you have." };
  if (car === null) return { error: "Please tell us if you have your own transport." };
  if (laptop === null) return { error: "Please tell us if you have your own laptop." };
  if (!languages.length) return { error: "Please tick at least one language." };
  if (!PARTNER_HEARD.includes(heard)) return { error: "Please tell us where you heard about us." };
  if (linkedin && !/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/[^\s]*$/i.test(linkedin)) return { error: "Please enter a LinkedIn profile link, or leave it empty." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { error: "Please enter a valid email address." };
  if (!phone) return { error: "Please enter a valid South African WhatsApp number." };
  if (!(b.consent === true || b.consent === "on" || b.consent === "true")) return { error: "Please tick the consent box." };
  const day = sastDay(now);
  const key = crypto.createHash("sha256").update(phone).digest("hex").slice(0, 12);
  return { app: {
    id: `PA${now.toString(36)}`, file: `${day}-${key}.json`,   // same number, same day → same file (no duplicates)
    name, city, suburb, experience, work, hours, car, laptop, languages, heard, linkedin, email, phone, about, at: now, day, page,
    status: "New", note: "",
    consent: `Website form${page ? ` (${page})` : ""}, ${dmy(day)} — ticked the POPIA consent box`,
  } };
}

// Push to the owner. Swappable for tests; quietly does nothing if push is not set up.
let _push = async (subs, payload) => {
  const pub = env("VAPID_PUBLIC_KEY"), priv = env("VAPID_PRIVATE_KEY"), subj = env("VAPID_SUBJECT");
  if (!pub || !priv || !subj) return 0;
  const webpush = require("web-push");
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload),
        { TTL: 3600 * 24, urgency: "normal", vapidDetails: { subject: subj, publicKey: pub, privateKey: priv } });
      sent++;
    } catch (e) { console.warn("push failed", (e && e.statusCode) || "", (e && e.message) || e); }
  }
  return sent;
};
router._setPush = (f) => { _push = f; };   // tests

async function tellOwner(owner, a) {
  try {
    const r = await _fetch(`${SB_URL()}/rest/v1/push_subscriptions?select=endpoint,p256dh,auth&user_id=eq.${owner}`, { headers: svc() });
    const subs = r.ok ? await r.json() : [];
    if (!Array.isArray(subs) || !subs.length) return 0;
    const hub = env("PUSH_APP_URL").replace(/\/+$/, "") || "https://sentiv-sales-hub.pages.dev";
    return await _push(subs, {
      title: `New area partner: ${a.name} · ${a.city}`,
      body: `${a.suburb} · ${a.experience} · ${a.hours} · ${a.phone}`,
      tag: `partner-${a.file}`, url: `${hub}/`, brand: "rewards",
    });
  } catch (e) { console.warn("partner-apply push error", e.message); return 0; }
}

// A new website enquiry: buzz the owner straight away (leads go cold fast). Tapping opens the lead in the Hub.
async function tellOwnerLead(owner, lead) {
  try {
    const r = await _fetch(`${SB_URL()}/rest/v1/push_subscriptions?select=endpoint,p256dh,auth&user_id=eq.${owner}`, { headers: svc() });
    const subs = r.ok ? await r.json() : [];
    if (!Array.isArray(subs) || !subs.length) return 0;
    const hub = env("PUSH_APP_URL").replace(/\/+$/, "") || "https://sentiv-sales-hub.pages.dev";
    const calc = /Calculator: /.test(lead.notes) ? " · used the calculator" : "";
    return await _push(subs, {
      title: `New website lead: ${lead.company}`,
      body: `${lead.contact} · ${lead.vertical} · ${lead.phone}${calc}`,
      tag: `weblead-${lead.id}`, url: `${hub}/?lead=${encodeURIComponent(lead.id)}`, leadId: lead.id, brand: "rewards",
    });
  } catch (e) { console.warn("web-lead push error", e.message); return 0; }
}

router.post("/partner-apply", async (req, res) => {
  try {
    const allow = origins();
    if (!allow.length || !SB_URL() || !SB_SERVICE()) return res.status(503).json({ error: "The form is not switched on yet." });
    const origin = String(req.get("origin") || "").replace(/\/+$/, "");
    if (!allow.includes(origin)) return res.status(403).json({ error: "Not allowed from this website." });
    if (req.rawBody && req.rawBody.length > 8192) return res.status(413).json({ error: "That message is too long." });
    const body = req.body || {};
    if (clean(body.website, 200)) return res.json({ ok: true });   // honeypot
    const now = _now();
    const built = buildPartnerApp(body, now);
    if (built.error) return res.status(400).json({ error: built.error });
    const why = limited(clientIp(req), now);
    if (why) return res.status(429).json({ error: why });
    const a = built.app;
    const url = `${SB_URL()}/storage/v1/object/${APP_DIR}/${a.file}`;
    const seen = await _fetch(`${SB_URL()}/storage/v1/object/info/${APP_DIR}/${a.file}`, { headers: svc() });
    if (seen.ok) return res.json({ ok: true });   // already applied today
    const r = await _fetch(url, { method: "POST", headers: svc({ "x-upsert": "true" }), body: JSON.stringify(a) });
    if (!r.ok) { console.error("partner-apply save failed", r.status, (await r.text()).slice(0, 200)); return res.status(502).json({ error: "Could not send your application. Please WhatsApp us." }); }
    const owner = await ownerId(now);
    const pushed = owner ? await tellOwner(owner, a) : 0;
    console.log("partner-apply saved", JSON.stringify({ file: a.file, city: a.city, pushed }));
    res.json({ ok: true });
  } catch (e) {
    console.error("partner-apply error", e.message);
    res.status(502).json({ error: "Could not send your application. Please WhatsApp us." });
  }
});

// ---- The owner's Applicants list in the Hub (signed in; owner only) ----
//   GET  /api/rewards/partner-apps            every application, newest first
//   POST /api/rewards/partner-apps/status     { file, status?, note?, invitedAt? } → saved on the file
async function ownerOnly(req, res) {
  const uid = req.sentivUser;
  if (!uid) { res.status(401).json({ error: "Sign in again." }); return false; }
  const r = await _fetch(`${SB_URL()}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=role`, { headers: svc() });
  const rows = r.ok ? await r.json() : [];
  if (!(rows[0] && rows[0].role === "owner")) { res.status(403).json({ error: "Only the owner can see applications." }); return false; }
  return true;
}
const FILE_RE = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{12}\.json$/;
async function readApp(file) {
  const r = await _fetch(`${SB_URL()}/storage/v1/object/${APP_DIR}/${file}`, { headers: svc() });
  if (!r.ok) return null;
  try { return JSON.parse(await r.text()); } catch (e) { return null; }
}
router.get("/partner-apps", async (req, res) => {
  try {
    if (!SB_URL() || !SB_SERVICE()) return res.status(503).json({ error: "Not set up." });
    if (!(await ownerOnly(req, res))) return;
    const l = await _fetch(`${SB_URL()}/storage/v1/object/list/backups`, { method: "POST", headers: svc(),
      body: JSON.stringify({ prefix: "partner-apps/", limit: 1000, offset: 0, sortBy: { column: "name", order: "desc" } }) });
    if (!l.ok) return res.status(502).json({ error: `Could not list applications (${l.status}).` });
    const names = ((await l.json()) || []).map((o) => o && o.name).filter((n) => FILE_RE.test(String(n || "")));
    const apps = [];
    for (let i = 0; i < names.length; i += 10) {
      const got = await Promise.all(names.slice(i, i + 10).map(async (n) => { const a = await readApp(n); return a ? { status: "New", note: "", ...a, file: n } : null; }));
      apps.push(...got.filter(Boolean));
    }
    apps.sort((a, b) => (b.at || 0) - (a.at || 0));
    res.json({ ok: true, apps, statuses: PARTNER_STATUSES });
  } catch (e) { console.error("partner-apps list error", e.message); res.status(502).json({ error: "Could not load applications." }); }
});
router.post("/partner-apps/status", async (req, res) => {
  try {
    if (!SB_URL() || !SB_SERVICE()) return res.status(503).json({ error: "Not set up." });
    if (!(await ownerOnly(req, res))) return;
    const b = req.body || {};
    const file = String(b.file || "");
    if (!FILE_RE.test(file)) return res.status(400).json({ error: "Unknown application." });
    const a = await readApp(file);
    if (!a) return res.status(404).json({ error: "That application is gone." });
    if (b.status != null) { if (!PARTNER_STATUSES.includes(b.status)) return res.status(400).json({ error: "Unknown status." }); a.status = b.status; }
    if (b.note != null) a.note = clean(b.note, 600);
    if (b.invitedAt != null) a.invitedAt = Number(b.invitedAt) || _now();
    a.updatedAt = _now();
    const w = await _fetch(`${SB_URL()}/storage/v1/object/${APP_DIR}/${file}`, { method: "POST", headers: svc({ "x-upsert": "true" }), body: JSON.stringify({ ...a, file: undefined }) });
    if (!w.ok) return res.status(502).json({ error: `Could not save (${w.status}).` });
    res.json({ ok: true, app: { ...a, file } });
  } catch (e) { console.error("partner-apps status error", e.message); res.status(502).json({ error: "Could not save." }); }
});

module.exports = router;
Object.assign(module.exports, { buildWebLead, buildPartnerApp, saPhone, origins, TYPES, PARTNER_CITIES, PARTNER_EXPERIENCE, PARTNER_WORK, PARTNER_HOURS, PARTNER_LANGS, PARTNER_HEARD, PARTNER_STATUSES });
