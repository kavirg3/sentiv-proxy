// Euphoria Telecom click-to-dial — rings the agent's extension, then the client.
//
// Rewritten 12 Oct 2026. The first version POSTed JSON with a Bearer token to
// api.euphoria.co.za/api/v1/originate — an endpoint that does not exist. The real API is
// XML over one URL (from Euphoria's own docs, apidocs.euphoria.co.za, and their client DLL):
//
//   POST https://api.euphoria.co.za/files/1010107057/api/Euphoria.Api.aspx   (text/xml)
//   <XML><Tenant><Name>tenant</Name><Auth>key</Auth></Tenant>
//        <ActionName>Originate</ActionName><extension>101-tenant</extension>
//        <dialNumber>0105934500</dialNumber><crmTag>…</crmTag></XML>
//
// It answers 200 even on failure, with <Status>Failed</Status><Error>…</Error>.
//
// The old route also had no sign-in check. An open "make our PBX dial this number" URL is
// a toll-fraud hole (premium and international numbers billed to us), so now:
//   - the caller must be a signed-in Sentiv user (Supabase token checked with Supabase),
//   - only South African numbers 0[1-8]xxxxxxxx can be dialled (no 09xx premium, no international),
//   - the extension must be a plain extension number on OUR tenant,
//   - each user is capped per minute and per day.
//
// Env:
//   EUPHORIA_API_KEY      required — TMS → API & Integration → API Manager → Add API Key
//   EUPHORIA_TENANT       required — the one-word tenant name (the part after the dash in a
//                         SIP username like 108-sentiv). EUPHORIA_ORG_ID is read as a fallback.
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   required — to check who is calling
//   EUPHORIA_API_URL      optional — override for tests
const express = require("express");
const router = express.Router();

const API_URL = process.env.EUPHORIA_API_URL || "https://api.euphoria.co.za/files/1010107057/api/Euphoria.Api.aspx";
// Trimmed, quotes stripped: a key pasted with a trailing newline or wrapped in quotes is
// rejected by Euphoria as "Authorization Failed", which looks exactly like a wrong key.
const clean = (v) => String(v || "").trim().replace(/^["']|["']$/g, "").trim();
const KEY = () => clean(process.env.EUPHORIA_API_KEY);
const TENANT = () => clean(process.env.EUPHORIA_TENANT || process.env.EUPHORIA_ORG_ID);
const SB_URL = () => (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_SERVICE = () => process.env.SUPABASE_SERVICE_KEY || "";
const PER_MIN = Number(process.env.EUPHORIA_MAX_PER_MIN) || 6;
const PER_DAY = Number(process.env.EUPHORIA_MAX_PER_DAY) || 300;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const tag = (xml, name) => { const m = String(xml).match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i")); return m ? m[1].trim() : ""; };

async function euphoria(action, fields = {}) {
  const body = "<?xml version='1.0' encoding='utf-8'?>"
    + `<XML><Tenant><Name>${esc(TENANT())}</Name><Auth>${esc(KEY())}</Auth></Tenant>`
    + `<ActionName>${esc(action)}</ActionName>`
    + Object.entries(fields).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join("")
    + "</XML>";
  const r = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8" }, body });
  const text = await r.text();
  if (!r.ok) return { ok: false, error: `Euphoria answered HTTP ${r.status}` };
  const err = tag(text, "Error");
  const status = tag(text, "Status");
  if (err || /^failed$/i.test(status)) return { ok: false, error: err || status || "failed" };
  return { ok: true, response: tag(text, "Response") || tag(text, "XML") || text.slice(0, 300) };
}

// South African numbers only. +27 / 0027 / 27 become 0. Landlines and mobiles are
// 0[1-8] + 8 digits; 09x premium-rate and anything international are refused.
function saNumber(raw) {
  let n = String(raw || "").replace(/[\s\-().]/g, "");
  if (/^\+27/.test(n)) n = "0" + n.slice(3);
  else if (/^0027/.test(n)) n = "0" + n.slice(4);
  else if (/^27\d{9}$/.test(n)) n = "0" + n.slice(2);
  return /^0[1-8]\d{8}$/.test(n) ? n : null;
}
// "108", "108-sentiv" or "108-Sentiv" → "108-sentiv". Another tenant's extension is refused.
function ourExtension(raw) {
  const m = String(raw || "").trim().match(/^(\d{2,6})(?:-([A-Za-z0-9_]+))?$/);
  if (!m) return null;
  const t = TENANT();
  if (m[2] && m[2].toLowerCase() !== t.toLowerCase()) return null;
  return `${m[1]}-${t}`;
}

async function userFromToken(req) {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token || !SB_URL() || !SB_SERVICE()) return null;
  try {
    const r = await fetch(`${SB_URL()}/auth/v1/user`, { headers: { apikey: SB_SERVICE(), Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch (e) { return null; }
}

const hits = new Map();   // userId -> [timestamps]
function overLimit(uid) {
  const now = Date.now();
  const list = (hits.get(uid) || []).filter((t) => now - t < 864e5);
  const lastMin = list.filter((t) => now - t < 60e3).length;
  if (lastMin >= PER_MIN) return "Too many calls in a minute — wait a moment.";
  if (list.length >= PER_DAY) return "Daily call limit reached for this login.";
  list.push(now); hits.set(uid, list);
  return null;
}

// POST /api/euphoria-originate   { extension, number, company }
// Order matters for the Hub's diagnostics probe, which POSTs {} with no token:
// 500 "not configured" = key missing, 400 "missing" = route alive and configured.
async function originate(req, res) {
  if (!KEY() || !TENANT()) return res.status(500).json({ error: "EUPHORIA_API_KEY / EUPHORIA_TENANT not configured on the server" });
  const { extension, number, company } = req.body || {};
  const missing = [!extension && "extension", !number && "number"].filter(Boolean);
  if (missing.length) return res.status(400).json({ error: `missing: ${missing.join(", ")}` });
  const user = await userFromToken(req);
  if (!user) return res.status(401).json({ error: "Sign in again to call from the Hub." });
  const ext = ourExtension(extension);
  if (!ext) return res.status(400).json({ error: `"${String(extension).slice(0, 20)}" isn't an extension on our phone system — use the number only, e.g. 108.` });
  const dial = saNumber(number);
  if (!dial) return res.status(400).json({ error: "Only South African numbers can be dialled from the Hub." });
  const limited = overLimit(user.id);
  if (limited) return res.status(429).json({ error: limited });
  try {
    const out = await euphoria("Originate", { extension: ext, dialNumber: dial, crmTag: String(company || "Sentiv Hub").slice(0, 60) });
    console.log(`[euphoria] originate user=${user.id.slice(0, 8)} ext=${ext} to=***${dial.slice(-3)} ${out.ok ? "ok" : "FAILED " + out.error}`);
    if (!out.ok) return res.status(502).json({ error: `Euphoria: ${out.error}` });
    res.json({ ok: true, extension: ext, response: out.response });
  } catch (e) {
    res.status(502).json({ error: `Euphoria unreachable: ${e.message}` });
  }
}

// GET /api/euphoria/health — is the key set, and does Euphoria accept it? Uses the
// DoNothing action, which dials nothing. Returns no secrets.
router.get("/health", async (_req, res) => {
  // The tenant name is not a secret (it is half of every SIP username), so it is shown to make
  // a typo visible. The key never is: only its length and whether the raw value needed cleaning.
  const raw = process.env.EUPHORIA_API_KEY || "";
  const cfg = { key: !!KEY(), tenant: !!TENANT(), tenantName: TENANT(), keyLength: KEY().length, keyWasCleaned: raw !== KEY(), supabase: !!(SB_URL() && SB_SERVICE()) };
  if (!cfg.key || !cfg.tenant) return res.json({ ok: false, ...cfg, auth: "not configured" });
  try {
    const out = await euphoria("DoNothing");
    res.json({ ok: out.ok && cfg.supabase, ...cfg, auth: out.ok ? "accepted" : out.error });
  } catch (e) {
    res.json({ ok: false, ...cfg, auth: `unreachable: ${e.message}` });
  }
});

module.exports = { router, originate, _test: { saNumber, ourExtension } };
