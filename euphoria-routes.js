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
// A whole SIP username ("100-sentiv") is accepted too: the tenant is the part after the dash.
const TENANT = () => clean(process.env.EUPHORIA_TENANT || process.env.EUPHORIA_ORG_ID).replace(/^\d{2,6}-/, "");
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
  // Live replies wrap every value in CDATA (<uID><![CDATA[118389741]]></uID>) — not in the
  // docs. Unwrap it, escaping what was inside, so a CallerID like "Name" <+2721…> cannot
  // break the parse. Found 13 Oct 2026: before this, 15 real calls parsed as 0.
  const text = (await r.text()).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, v) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  if (!r.ok) return { ok: false, error: `Euphoria answered HTTP ${r.status}` };
  // Only a TOP-LEVEL <Status>/<Error> means the request failed. A call-record list has a
  // <Status> per call (ANSWERED, NO ANSWER, FAILED…) that must not be mistaken for one.
  const top = text.match(/<XML>\s*<Status>([^<]*)<\/Status>\s*(?:<Error>([^<]*)<\/Error>)?/i);
  const lone = text.match(/<XML>\s*<Error>([^<]*)<\/Error>/i);
  if (lone) return { ok: false, error: lone[1].trim() || "failed" };
  if (top && /^failed$/i.test(top[1].trim())) return { ok: false, error: (top[2] || top[1]).trim() };
  return { ok: true, response: tag(text, "Response") || text.slice(0, 300), raw: text };
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
  // Log every refusal's reason (never the number) so a failed Call button can be diagnosed.
  const _json = res.json.bind(res);
  res.json = (body) => { if (res.statusCode >= 400 && body && body.error) console.log(`[euphoria] originate refused ${res.statusCode}: ${String(body.error).replace(/\d{6,}/g, "***")}`); return _json(body); };
  if (!KEY() || !TENANT()) return res.status(500).json({ error: "EUPHORIA_API_KEY / EUPHORIA_TENANT not configured on the server" });
  const { extension, number, company } = req.body || {};
  const missing = [!extension && "extension", !number && "number"].filter(Boolean);
  if (missing.length) return res.status(400).json({ error: `missing: ${missing.join(", ")}` });
  const user = await userFromToken(req);
  if (!user) return res.status(401).json({ error: "Sign in again to call from the Hub." });
  const ext = ourExtension(extension);
  if (!ext) return res.status(400).json({ error: `"${String(extension).slice(0, 20)}" isn't an extension on our phone system — use the number only, e.g. 100.` });
  // Once the owner assigns extensions, a call can only ring YOUR assigned extension.
  try {
    const map = await extMap();
    if (map.assigned) {
      const mineExt = map.byUser[user.id];
      if (!mineExt) return res.status(403).json({ error: "No phone extension is assigned to you yet — ask the owner to set it on the Team tab." });
      if (ext.split("-")[0] !== mineExt) return res.status(403).json({ error: `Your extension is ${mineExt}. Calls can only ring your own phone.` });
    }
  } catch (e) { return res.status(502).json({ error: "Couldn't check your extension — try again." }); }
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

// Can recordings be turned into something a browser plays? Checked once, with a real
// conversion of a tiny silent WAV, because "the binary exists" is not "it runs here".
let _mp3ok = null;
async function canMp3() {
  if (_mp3ok !== null) return _mp3ok;
  const n = 800, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  _mp3ok = !!(await toMp3(buf));
  return _mp3ok;
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
    res.json({ ok: out.ok && cfg.supabase, ...cfg, stt: !!AAI_KEY(), mp3: await canMp3(), auth: out.ok ? "accepted" : out.error });
  } catch (e) {
    res.json({ ok: false, ...cfg, auth: `unreachable: ${e.message}` });
  }
});

// =====================================================================================
// CALL LOG + RECORDINGS (12 Oct 2026)
//
// GET  /api/euphoria/calls?days=3[&mine=1]  → { calls:[…], ext, owner }
//      An agent gets only calls on THEIR extension. The owner gets every call on the
//      tenant, each tagged with the agent it belongs to (for talk time on the Team tab);
//      mine=1 narrows the owner to their own extension (for logging onto their own deals).
// GET  /api/euphoria/recording/:id          → audio/mpeg (or the original WAV)
// POST /api/euphoria/transcribe/:id         → { job }        (AssemblyAI, EU region)
// GET  /api/euphoria/transcribe/job/:job    → { status, text, utterances }
//
// Who owns an extension comes from the database (user_state row "euphoriaExt", which the
// Hub syncs from the extension box), never from the request. If two people claim the same
// extension, neither gets it until one changes theirs.
//
// Nothing is stored here: call rows, audio and transcripts pass through to the signed-in
// user and are dropped. A recording can only be fetched by the agent whose extension was on
// the call, or by the owner.
// =====================================================================================
const AAI_KEY = () => clean(process.env.ASSEMBLYAI_API_KEY);
const AAI_BASE = () => (process.env.ASSEMBLYAI_BASE_URL || "https://api.eu.assemblyai.com").replace(/\/+$/, "");
const STT_PER_DAY = Number(process.env.EUPHORIA_STT_PER_DAY) || 150;

async function sbGet(path) {
  const r = await fetch(`${SB_URL()}/rest/v1/${path}`, { headers: { apikey: SB_SERVICE(), Authorization: `Bearer ${SB_SERVICE()}` } });
  if (!r.ok) throw new Error(`supabase ${r.status}`);
  return r.json();
}
const digitsExt = (v) => { const m = String(v == null ? "" : v).trim().match(/^(\d{2,6})(?:-[A-Za-z0-9_]+)?$/); return m ? m[1] : ""; };

// v218 — the OWNER assigns extensions (team_settings.data.phoneExts, an owner-write row).
// Once any assignment exists it is the only source: what an agent typed into their own box
// is ignored, so nobody can claim a colleague's extension and read their calls. Before the
// owner has assigned anyone, the agents' own entries still count (the v216 behaviour).
let _extCache = { at: 0, byUser: {}, byExt: {}, assigned: false };
async function extMap() {
  if (Date.now() - _extCache.at < 60e3) return _extCache;
  const claims = {};
  const claim = (uid, v) => { const ext = digitsExt(v); if (uid && ext) (claims[ext] = claims[ext] || []).push(uid); };
  const ts = await sbGet("team_settings?id=eq.1&select=data").catch(() => []);
  const owned = ts && ts[0] && ts[0].data && ts[0].data.phoneExts;
  const assigned = !!(owned && typeof owned === "object" && Object.values(owned).some((v) => digitsExt(v)));
  if (assigned) Object.entries(owned).forEach(([uid, v]) => claim(uid, v));
  else {
    const rows = await sbGet("user_state?id=eq.euphoriaExt&select=agent_id,data");
    rows.forEach((r) => claim(r && r.agent_id, r && r.data && typeof r.data === "object" && "v" in r.data ? r.data.v : r && r.data));
  }
  const byUser = {}, byExt = {};
  Object.entries(claims).forEach(([ext, ids]) => { if (ids.length === 1) { byExt[ext] = ids[0]; byUser[ids[0]] = ext; } });
  _extCache = { at: Date.now(), byUser, byExt, assigned };
  return _extCache;
}
async function roleOf(uid) {
  const rows = await sbGet(`profiles?id=eq.${encodeURIComponent(uid)}&select=role`);
  return (rows[0] && rows[0].role) || "agent";
}

// Euphoria's list replies are XML with one element per call. The wrapper's name isn't
// documented, so find it: the element that directly encloses the first <uID>.
function parseRecords(xml) {
  const text = String(xml || "");
  const first = text.indexOf("<uID>");
  if (first < 0) return [];
  const before = text.slice(0, first);
  const opens = [...before.matchAll(/<(\w+)>/g)].map((m) => m[1]);
  const closes = new Set([...before.matchAll(/<\/(\w+)>/g)].map((m) => m[1]));
  const wrap = opens.reverse().find((n) => !closes.has(n) && n !== "XML");
  const blocks = wrap
    ? [...text.matchAll(new RegExp(`<${wrap}>([\\s\\S]*?)</${wrap}>`, "g"))].map((m) => m[1])
    : text.split("<uID>").slice(1).map((b) => "<uID>" + b);
  return blocks.map((b) => {
    const o = {};
    for (const m of b.matchAll(/<(\w+)>([^<]*)<\/\1>/g)) if (!(m[1] in o)) o[m[1]] = m[2].trim();
    return o;
  }).filter((o) => o.uID);
}
const unxml = (s) => String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
// Any phone number to a comparable form: SA numbers as 0XXXXXXXXX, others digits only.
function normNumber(raw) {
  let n = String(raw || "").replace(/[^\d+]/g, "");
  if (/^\+27/.test(n)) n = "0" + n.slice(3);
  else if (/^0027/.test(n)) n = "0" + n.slice(4);
  else if (/^27\d{9}$/.test(n)) n = "0" + n.slice(2);
  return n.replace(/\D/g, "");
}
// "PJSIP/100-FutureLifeTech-0000002b" → "100" when the tenant matches.
function extFromChannel(ch) {
  const m = String(ch || "").match(/\/(\d{2,6})-([A-Za-z0-9_]+)-/);
  return m && m[2].toLowerCase() === TENANT().toLowerCase() ? m[1] : "";
}
// StartTime is South African local time with no zone ("2026-10-12 09:40:00").
const sastIso = (t) => { const m = String(t || "").match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/); return m ? new Date(`${m[1]}T${m[2].length === 5 ? m[2] + ":00" : m[2]}+02:00`).toISOString() : null; };

// Server-side only: the PBX's own names for a call's recording, for the download fallbacks
// in audioFor(). Never sent to the browser.
const _recRefs = new Map();   // uID -> { file, unique }
function shapeCall(r, map) {
  if (r && r.uID && (r.RecordingFilename || r.UniqueID)) {
    _recRefs.set(String(r.uID), { file: unxml(r.RecordingFilename), unique: unxml(r.UniqueID) });
    if (_recRefs.size > 20000) _recRefs.delete(_recRefs.keys().next().value);
  }
  const src = normNumber(r.Source), dst = normNumber(r.Destination);
  const isExt = (n) => /^\d{2,6}$/.test(n);
  let ext = "", other = "", dir = "";
  const outExt = extFromChannel(r.ChannelID), inExt = extFromChannel(r.DestChannel);
  if (outExt && !inExt) { ext = outExt; dir = "out"; other = dst; }
  else if (inExt && !outExt) { ext = inExt; dir = "in"; other = src; }
  else if (outExt && inExt) { dir = "internal"; ext = outExt; other = ""; }
  else if (isExt(src) && !isExt(dst)) { ext = src; dir = "out"; other = dst; }
  else if (isExt(dst) && !isExt(src)) { ext = dst; dir = "in"; other = src; }
  else { dir = "unknown"; other = dst || src; }
  if (isExt(other)) { dir = "internal"; }
  const at = sastIso(r.StartTime);
  const recorded = String(r.Recorded) === "1" && !!r.RecordingFilename;
  return {
    id: String(r.uID), at, seconds: Number(r.Duration) || 0, answered: /^answered$/i.test(r.Status || ""),
    status: r.Status || "", dir, ext, other, recorded, agentId: (ext && map.byExt[ext]) || null,
    callerId: unxml(r.CallerID).slice(0, 80),
  };
}

async function fetchCdrs({ days, ext }) {
  const end = new Date(Date.now() + 2 * 3600e3);                 // SAST date
  const start = new Date(end.getTime() - (days - 1) * 864e5);
  const d = (x) => x.toISOString().slice(0, 10);
  const out = [];
  for (let page = 0; page < 10; page++) {
    const fields = { pageSize: 500, startAt: page * 500, startDate: d(start), endDate: d(end) };
    if (ext) fields.extension = ext;
    const res = await euphoria("GetCallDetailRecords", fields);
    if (!res.ok) throw new Error(res.error);
    const rows = parseRecords(res.raw);
    // The list wrapper isn't documented. If a reply has content but no call parsed out of
    // it, log its SHAPE (tag names only, no values, so no numbers) to fix the parser by.
    if (!rows.length && page === 0 && String(res.raw || "").length > 120) {
      console.log(`[euphoria] cdr shape: ${String(res.raw).replace(/>[^<]*</g, "><").replace(/\d{4,}/g, "#").slice(0, 400)}`);
    }
    out.push(...rows);
    if (rows.length < 500) break;
  }
  return out;
}

const _callCache = new Map();   // key -> { at, rows }
async function cdrsCached(days, ext) {
  const key = `${days}:${ext || "*"}`;
  const hit = _callCache.get(key);
  if (hit && Date.now() - hit.at < 60e3) return hit.rows;
  const rows = await fetchCdrs({ days, ext });
  // One line per real fetch — counts and statuses only, never a number — so "no calls
  // showed up" can be told apart from "Euphoria sent calls we could not read".
  const tally = {}; rows.forEach((r) => { const k = String(r.Status || "?").toUpperCase(); tally[k] = (tally[k] || 0) + 1; });
  const mask = (v) => String(v || "").replace(/\d{5,}/g, "#");
  const r0 = rows[0] || {};
  console.log(`[euphoria] cdrs days=${days} ext=${ext || "all"} rows=${rows.length} ${JSON.stringify(tally)} first: ch=${mask(r0.ChannelID)} dch=${mask(r0.DestChannel)} app=${mask(r0.LastApp)} src=${/^\d{2,6}$/.test(r0.Source || "") ? r0.Source : "ext?no"} dst=${/^\d{2,6}$|^PJ/.test(r0.Destination || "") ? r0.Destination : "ext?no"}`);
  _callCache.set(key, { at: Date.now(), rows });
  if (_callCache.size > 50) _callCache.delete(_callCache.keys().next().value);
  return rows;
}

async function gate(req, res) {
  if (!KEY() || !TENANT()) { res.status(500).json({ error: "EUPHORIA_API_KEY / EUPHORIA_TENANT not configured on the server" }); return null; }
  const user = await userFromToken(req);
  if (!user) { res.status(401).json({ error: "Sign in again." }); return null; }
  const [map, role] = await Promise.all([extMap(), roleOf(user.id)]);
  return { user, map, owner: role === "owner", ext: map.byUser[user.id] || "" };
}

router.get("/calls", async (req, res) => {
  try {
    const g = await gate(req, res); if (!g) return;
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 3));
    const mine = String(req.query.mine || "") === "1";
    if ((!g.owner || mine) && !g.ext) return res.json({ calls: [], ext: "", owner: g.owner, needsExtension: true });
    // Always ask Euphoria per extension and trust its filter. A call placed from the Hub
    // shows the company number as Source and the client as Destination, with no extension
    // in either, so the extension can't always be read back off the record itself.
    const exts = g.owner && !mine ? Object.keys(g.map.byExt) : [g.ext];
    const seen = new Set();
    let calls = [];
    for (const ext of exts) {
      const rows = await cdrsCached(days, ext);
      rows.forEach((r) => {
        if (seen.has(String(r.uID))) return;
        const c = shapeCall(r, g.map);
        if (c.ext && c.ext !== ext) return;              // the other end of an internal call
        seen.add(String(r.uID));
        if (!c.ext) { c.ext = ext; c.agentId = g.map.byExt[ext] || null; if (c.dir === "unknown") c.dir = "out"; }
        calls.push(c);
      });
    }
    calls = calls.filter((c) => c.at && c.dir !== "internal");
    calls.sort((a, b) => (a.at < b.at ? 1 : -1));
    res.json({ calls: calls.slice(0, 5000), ext: g.ext, owner: g.owner, stt: !!AAI_KEY() });
  } catch (e) { res.status(502).json({ error: `Euphoria: ${e.message}` }); }
});

// May this user touch call <id>? The CDR is fetched fresh, so a guessed id is no use.
async function ownedCall(g, id) {
  if (!/^\d{1,15}$/.test(String(id))) return null;
  const d = await euphoria("GetCdrDetails", { CdrID: id });
  if (!d.ok) return null;
  const rec = parseRecords(d.raw)[0] || Object.fromEntries([...String(d.raw).matchAll(/<(\w+)>([^<]*)<\/\1>/g)].map((m) => [m[1], m[2].trim()]));
  if (!rec || !rec.uID) return null;
  const call = shapeCall(rec, g.map);
  if (!g.owner && call.ext !== g.ext) return null;
  return call;
}

// Euphoria's docs give no input fields for the recording downloads, and the first guess
// (<cdrID>) answers "Api Service Error" on live calls (16 Oct 2026) — while GetCdrDetails
// takes <CdrID>. So try the likely shapes in order, remember the one that works, and log
// which it was (never the number or file name). Live, 16 Oct 2026: <uniqueId> works, so it
// goes first; the rest stay as fallbacks in case Euphoria changes it.
const REC_WAYS = [
  ["DownloadCallRecordingByUniqueId", (id, ref) => ref.unique && ({ uniqueId: ref.unique })],
  ["DownloadCallRecordingByCdrID", (id) => ({ CdrID: id })],
  ["DownloadCallRecordingByCdrID", (id) => ({ cdrID: id })],
  ["DownloadCallRecordingByCdrID", (id) => ({ cdrId: id })],
  ["DownloadCallRecordingByFilename", (id, ref) => ref.file && ({ filename: ref.file })],
  ["DownloadCallRecordingByFilename", (id, ref) => ref.file && ({ fileName: ref.file })],
  ["DownloadCallRecordingByUniqueId", (id, ref) => ref.unique && ({ UniqueID: ref.unique })],
];
let _recWay = -1;
// The audio may sit in <audioData> or another tag: take the biggest base64 block in the reply.
function audioB64(raw) {
  const named = tag(raw, "audioData");
  if (named) return named;
  let best = "";
  for (const m of String(raw).matchAll(/>([A-Za-z0-9+/=\s]{400,})</g)) if (m[1].length > best.length) best = m[1];
  return best.replace(/\s+/g, "");
}
async function audioFor(id) {
  const ref = _recRefs.get(String(id)) || {};
  const order = _recWay >= 0 ? [_recWay, ...REC_WAYS.keys()].filter((v, i, a) => a.indexOf(v) === i) : [...REC_WAYS.keys()];
  const tried = [];
  for (const i of order) {
    const [action, fields] = REC_WAYS[i];
    const f = fields(id, ref);
    if (!f) continue;
    const a = await euphoria(action, f);
    const b64 = a.ok ? audioB64(a.raw) : "";
    if (b64) {
      if (_recWay !== i) console.log(`[euphoria] recordings download via ${action} <${Object.keys(f)[0]}>`);
      _recWay = i;
      return Buffer.from(b64, "base64");
    }
    tried.push(`${action}<${Object.keys(f)[0]}>: ${a.ok ? `no audio (${String(a.raw).replace(/>[^<]*</g, "><").slice(0, 120)})` : a.error}`);
  }
  console.log(`[euphoria] recording download failed — ${tried.join(" | ").replace(/\d{6,}/g, "***")}`);
  throw new Error(tried.length ? tried[tried.length - 1].split(": ").slice(1).join(": ") || "no recording on this call" : "no recording on this call");
}
// Euphoria's WAVs are GSM-compressed, which no browser plays. ffmpeg turns them into MP3;
// if ffmpeg is missing, the original WAV is sent and the Hub offers it as a download.
function toMp3(buf) {
  return new Promise((resolve) => {
    // ffmpeg-static downloads its binary in an install script; if a build skipped it, fall
    // back to an ffmpeg on the PATH, and failing that to the original WAV.
    let bin = "ffmpeg";
    try { const p = require("ffmpeg-static"); if (p && require("fs").existsSync(p)) bin = p; } catch (e) { /* PATH */ }
    const { spawn } = require("child_process");
    const p = spawn(bin, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-b:a", "48k", "-f", "mp3", "pipe:1"]);
    const chunks = [];
    p.stdout.on("data", (c) => chunks.push(c));
    p.on("error", () => resolve(null));
    p.on("close", (code) => resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null));
    p.stdin.on("error", () => {});
    p.stdin.end(buf);
  });
}

router.get("/recording/:id", async (req, res) => {
  try {
    const g = await gate(req, res); if (!g) return;
    const call = await ownedCall(g, req.params.id);
    if (!call) return res.status(404).json({ error: "No such call on your extension." });
    if (!call.recorded) return res.status(404).json({ error: "This call wasn't recorded." });
    const wav = await audioFor(req.params.id);
    const mp3 = await toMp3(wav);
    res.set("Cache-Control", "private, no-store");
    if (mp3) { res.type("audio/mpeg"); return res.send(mp3); }
    res.type("audio/wav"); res.send(wav);
  } catch (e) { res.status(502).json({ error: `Recording: ${e.message}` }); }
});

const _jobs = new Map();       // AssemblyAI job id -> user id (only the starter may poll it)
const _sttHits = new Map();    // user id -> [timestamps]
router.post("/transcribe/:id", async (req, res) => {
  try {
    if (!AAI_KEY()) return res.status(501).json({ error: "Transcription isn't set up — ASSEMBLYAI_API_KEY is not on the server." });
    const g = await gate(req, res); if (!g) return;
    const now = Date.now();
    const hits = (_sttHits.get(g.user.id) || []).filter((t) => now - t < 864e5);
    if (hits.length >= STT_PER_DAY) return res.status(429).json({ error: "Daily transcription limit reached." });
    const call = await ownedCall(g, req.params.id);
    if (!call) return res.status(404).json({ error: "No such call on your extension." });
    if (!call.recorded) return res.status(404).json({ error: "This call wasn't recorded." });
    if (call.seconds > 45 * 60) return res.status(400).json({ error: "Calls over 45 minutes aren't transcribed automatically." });
    const wav = await audioFor(req.params.id);
    const audio = (await toMp3(wav)) || wav;
    const up = await fetch(`${AAI_BASE()}/v2/upload`, { method: "POST", headers: { authorization: AAI_KEY(), "content-type": "application/octet-stream" }, body: audio });
    const upj = await up.json().catch(() => ({}));
    if (!up.ok || !upj.upload_url) return res.status(502).json({ error: `Transcription upload failed: ${upj.error || up.status}` });
    const tr = await fetch(`${AAI_BASE()}/v2/transcript`, {
      method: "POST", headers: { authorization: AAI_KEY(), "content-type": "application/json" },
      body: JSON.stringify({ audio_url: upj.upload_url, speaker_labels: true, speakers_expected: 2, language_code: "en" }),
    });
    const trj = await tr.json().catch(() => ({}));
    if (!tr.ok || !trj.id) return res.status(502).json({ error: `Transcription failed to start: ${trj.error || tr.status}` });
    hits.push(now); _sttHits.set(g.user.id, hits);
    _jobs.set(trj.id, { uid: g.user.id, at: now });
    for (const [k, v] of _jobs) if (now - v.at > 6 * 3600e3) _jobs.delete(k);
    console.log(`[euphoria] transcribe user=${g.user.id.slice(0, 8)} cdr=${req.params.id} ${call.seconds}s`);
    res.json({ job: trj.id, seconds: call.seconds });
  } catch (e) { res.status(502).json({ error: `Transcription: ${e.message}` }); }
});

router.get("/transcribe/job/:job", async (req, res) => {
  try {
    if (!AAI_KEY()) return res.status(501).json({ error: "Transcription isn't set up." });
    const user = await userFromToken(req);
    if (!user) return res.status(401).json({ error: "Sign in again." });
    const job = _jobs.get(String(req.params.job));
    if (!job || job.uid !== user.id) return res.status(404).json({ error: "Unknown transcription." });
    const r = await fetch(`${AAI_BASE()}/v2/transcript/${encodeURIComponent(req.params.job)}`, { headers: { authorization: AAI_KEY() } });
    const j = await r.json().catch(() => ({}));
    if (j.status === "error") return res.json({ status: "error", error: j.error || "failed" });
    if (j.status !== "completed") return res.json({ status: j.status || "processing" });
    const utterances = (j.utterances || []).map((u) => ({ speaker: u.speaker, start: u.start, text: u.text }));
    res.json({ status: "completed", text: j.text || "", utterances });
  } catch (e) { res.status(502).json({ error: `Transcription: ${e.message}` }); }
});

// =====================================================================================
// CALL ARCHIVE — recordings kept in our own pCloud (16 Oct 2026)
//
// Euphoria keeps recordings for as long as Euphoria decides. Every ANSWERED, RECORDED call
// is copied once, as MP3, into pCloud:
//
//     /Sentiv Call Recordings/<agent user id>/<YYYY-MM>/<YYYY-MM-DD>_<Euphoria uID>.mp3
//
// The folder sits OUTSIDE PCLOUD_ROOT (the agents' Vault), so nobody can browse it there;
// the archive refuses to run if it would land inside the Vault. The agent folder is named
// by who OWNED the extension when the call was archived, so a later extension swap never
// hands old calls to the new holder.
//
// POST /api/euphoria/archive/sync        signed in. An agent archives their own extension's
//      calls; the owner archives everyone's. → { files: { uID: fileid }, uploaded, pending }
// GET  /api/euphoria/archive/play/:fileid  signed in. audio/mpeg — only for the agent the
//      call belongs to, or the owner. Works after Euphoria has deleted the call.
// POST /api/euphoria/archive/sweep       Daily, from GitHub Actions, which proves itself with
//      a GitHub-signed OIDC token (no shared secret to keep anywhere). It:
//      archives the last 3 days for every extension, deletes recordings over 12 months
//      old, and proves the upload-and-play path with a throwaway file.
//
// Env: PCLOUD_TOKEN, PCLOUD_REGION, PCLOUD_ROOT (shared with the Vault),
//      CALLS_ARCHIVE_PATH (optional, default "/Sentiv Call Recordings"),
//      CALLS_SWEEP_REPO (optional, default "kavirg3/sentiv-proxy" — whose workflow may sweep),
//      CALLS_SWEEP_SECRET (optional x-archive-secret, for running the sweep by hand),
//      PCLOUD_API_URL, GITHUB_OIDC_JWKS_URL (tests).
// =====================================================================================
const PC_API = () => (process.env.PCLOUD_API_URL || (String(process.env.PCLOUD_REGION || "eu").toLowerCase() === "us" ? "https://api.pcloud.com" : "https://eapi.pcloud.com")).replace(/\/+$/, "");
const PC_TOKEN = () => clean(process.env.PCLOUD_TOKEN);
const PC_ROOT = () => String(clean(process.env.PCLOUD_ROOT) || "0");
const ARCHIVE_PATH = () => clean(process.env.CALLS_ARCHIVE_PATH) || "/Sentiv Call Recordings";
const ARCHIVE_SECRET = () => clean(process.env.CALLS_SWEEP_SECRET);
const SWEEP_REPO = () => clean(process.env.CALLS_SWEEP_REPO) || "kavirg3/sentiv-proxy";
const OIDC_ISS = "https://token.actions.githubusercontent.com";
const OIDC_AUD = "sentiv-proxy-archive";
const OIDC_JWKS = () => process.env.GITHUB_OIDC_JWKS_URL || `${OIDC_ISS}/.well-known/jwks`;
const ARCHIVE_KEEP_DAYS = 365;
const ARCHIVE_PER_SYNC = 6;       // one Hub tick; the rest follow on the next tick
const ARCHIVE_PER_SWEEP = 40;     // the daily catch-up for anyone whose Hub was closed
const ARCHIVE_WINDOW_DAYS = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARCHIVE_NAME_RE = /^(\d{4}-\d{2}-\d{2})_(\d{1,15})\.(mp3|wav)$/;

async function pcloud(method, params = {}, body) {
  const url = new URL(`${PC_API()}/${method}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const r = await fetch(url, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${PC_TOKEN()}` }, body });
  const d = await r.json().catch(() => ({ result: -1, error: `pCloud HTTP ${r.status}` }));
  if (d.result !== 0) throw new Error(d.error || `pCloud error ${d.result}`);
  return d;
}
async function pcloudFolder(params) {
  const d = await pcloud("createfolderifnotexists", params);
  return String(d.metadata.folderid);
}
async function pcloudUpload(folderid, name, buf, mtimeSec) {
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: name.endsWith(".mp3") ? "audio/mpeg" : "audio/wav" }), name);
  const params = { folderid, nopartial: 1 };
  if (mtimeSec) params.mtime = mtimeSec;
  const d = await pcloud("uploadfile", params, fd);
  const id = d.fileids && d.fileids[0];
  if (!id) throw new Error("pCloud upload returned no file");
  return String(id);
}
async function pcloudBytes(fileid) {
  const d = await pcloud("getfilelink", { fileid });
  const host = (d.hosts && d.hosts[0]) || "";
  if (!host || !d.path) throw new Error("pCloud returned no host");
  const r = await fetch(/^https?:\/\//.test(host) ? `${host}${d.path}` : `https://${host}${d.path}`);
  if (!r.ok) throw new Error(`pCloud host returned ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// The archive root, and whether it is safely outside the Vault. Cached for 10 minutes.
let _arch = { at: 0, root: "", fenced: false, why: "" };
async function archiveRoot() {
  if (_arch.root && Date.now() - _arch.at < 600e3) return _arch;
  if (!PC_TOKEN()) return (_arch = { at: Date.now(), root: "", fenced: false, why: "PCLOUD_TOKEN not set" });
  const root = await pcloudFolder({ path: ARCHIVE_PATH() });
  let fenced = true, why = "";
  if (PC_ROOT() === "0") { fenced = false; why = "PCLOUD_ROOT is not set, so the Vault shows the whole drive — recordings would be visible to every agent"; }
  else {
    let cur = root;
    for (let hops = 0; hops < 40; hops++) {
      if (String(cur) === PC_ROOT()) { fenced = false; why = "the archive folder is inside the agents' Vault"; break; }
      const d = await pcloud("listfolder", { folderid: cur, nofiles: 1 });
      const parent = d.metadata && d.metadata.parentfolderid;
      if (parent === undefined || parent === null || String(cur) === "0") break;
      cur = parent;
    }
  }
  _arch = { at: Date.now(), root, fenced, why };
  return _arch;
}
async function archiveReady() {
  const a = await archiveRoot();
  if (!a.root) throw Object.assign(new Error(`Call archive isn't set up: ${a.why}`), { status: 501 });
  if (!a.fenced) throw Object.assign(new Error(`Call archive is switched off: ${a.why}`), { status: 503 });
  return a;
}

const _folders = new Map();   // "agent|month" → folderid
async function monthFolder(rootId, agentId, month) {
  const key = `${rootId}|${agentId}|${month}`;
  if (_folders.has(key)) return _folders.get(key);
  const agentFolder = await pcloudFolder({ folderid: rootId, name: agentId });
  const id = await pcloudFolder({ folderid: agentFolder, name: month });
  _folders.set(key, id);
  if (_folders.size > 500) _folders.delete(_folders.keys().next().value);
  return id;
}
const sastDay = (iso) => new Date(Date.parse(iso) + 2 * 3600e3).toISOString().slice(0, 10);

// Which recorded, answered calls belong to these extensions in the last few days.
async function archiveCandidates(exts, map, days, fresh = false) {
  const out = [], seen = new Set();
  for (const ext of exts) {
    const rows = fresh ? await fetchCdrs({ days, ext }) : await cdrsCached(days, ext);
    rows.forEach((r) => {
      if (seen.has(String(r.uID))) return;
      const c = shapeCall(r, map);
      if (c.ext && c.ext !== ext) return;
      seen.add(String(r.uID));
      if (!c.ext) { c.ext = ext; c.agentId = map.byExt[ext] || null; }
      if (c.dir === "internal" || !c.at || !c.answered || !c.recorded || !c.agentId || !UUID_RE.test(c.agentId)) return;
      out.push(c);
    });
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : 1));   // oldest first, so none age out of the window
}

const _archBusy = new Set();
async function archiveCalls(calls, cap) {
  const a = await archiveReady();
  const files = {}, groups = new Map();
  calls.forEach((c) => {
    const k = `${c.agentId}|${sastDay(c.at).slice(0, 7)}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(c);
  });
  const todo = [];
  for (const [k, list] of groups) {
    const [agentId, month] = k.split("|");
    const folder = await monthFolder(a.root, agentId, month);
    const d = await pcloud("listfolder", { folderid: folder });
    const have = {};
    ((d.metadata && d.metadata.contents) || []).forEach((e) => { const m = !e.isfolder && String(e.name).match(ARCHIVE_NAME_RE); if (m) have[m[2]] = String(e.fileid); });
    list.forEach((c) => { if (have[c.id]) files[c.id] = have[c.id]; else todo.push({ c, folder }); });
  }
  let uploaded = 0, errors = 0;
  for (const { c, folder } of todo) {
    if (uploaded >= cap) break;
    if (_archBusy.has(c.id)) continue;   // another device is uploading this one right now
    _archBusy.add(c.id);
    try {
      const wav = await audioFor(c.id);
      const mp3 = await toMp3(wav);
      const name = `${sastDay(c.at)}_${c.id}.${mp3 ? "mp3" : "wav"}`;
      files[c.id] = await pcloudUpload(folder, name, mp3 || wav, Math.floor(Date.parse(c.at) / 1000));
      uploaded++;
    } catch (e) {
      errors++;
      console.log(`[archive] cdr=${c.id} failed: ${String(e.message).replace(/\d{6,}/g, "***")}`);
    } finally { _archBusy.delete(c.id); }
  }
  const pending = todo.filter((t) => !files[t.c.id]).length;
  if (uploaded || errors) console.log(`[archive] uploaded=${uploaded} errors=${errors} pending=${pending}`);
  return { files, uploaded, pending, errors };
}

// Who may play an archived file: walk file → month folder → agent folder → archive root.
// Anything not exactly in that shape (a Vault file, a personal file) is refused.
async function archiveOwnerOf(fileid) {
  if (!/^\d{1,20}$/.test(String(fileid))) return null;
  const a = await archiveReady();
  const f = await pcloud("checksumfile", { fileid }).catch(() => null);
  const meta = f && f.metadata;
  if (!meta || meta.isfolder || !ARCHIVE_NAME_RE.test(String(meta.name))) return null;
  const month = await pcloud("listfolder", { folderid: meta.parentfolderid, nofiles: 1 }).catch(() => null);
  const mm = month && month.metadata;
  if (!mm || !/^\d{4}-\d{2}$/.test(String(mm.name))) return null;
  const agent = await pcloud("listfolder", { folderid: mm.parentfolderid, nofiles: 1 }).catch(() => null);
  const am = agent && agent.metadata;
  if (!am || !UUID_RE.test(String(am.name)) || String(am.parentfolderid) !== String(a.root)) return null;
  return { agentId: String(am.name), name: String(meta.name) };
}

const sendErr = (res, e, label) => res.status(e.status || 502).json({ error: `${label}: ${e.message}` });

router.post("/archive/sync", async (req, res) => {
  try {
    const g = await gate(req, res); if (!g) return;
    const exts = g.owner ? [...new Set([...Object.keys(g.map.byExt), g.ext].filter(Boolean))] : (g.ext ? [g.ext] : []);
    if (!exts.length) return res.json({ files: {}, uploaded: 0, pending: 0, needsExtension: true });
    const lock = `sync:${g.user.id}`;
    if (_archBusy.has(lock)) return res.json({ files: {}, uploaded: 0, pending: 0, busy: true });
    _archBusy.add(lock);
    try {
      const calls = await archiveCandidates(exts, g.map, ARCHIVE_WINDOW_DAYS);
      res.json(await archiveCalls(calls, ARCHIVE_PER_SYNC));
    } finally { _archBusy.delete(lock); }
  } catch (e) { sendErr(res, e, "Call archive"); }
});

router.get("/archive/play/:fileid", async (req, res) => {
  try {
    const user = await userFromToken(req);
    if (!user) return res.status(401).json({ error: "Sign in again." });
    const owner = (await roleOf(user.id)) === "owner";
    const who = await archiveOwnerOf(req.params.fileid);
    if (!who || (!owner && who.agentId !== user.id)) return res.status(404).json({ error: "No such recording for you." });
    const buf = await pcloudBytes(req.params.fileid);
    res.set("Cache-Control", "private, no-store");
    res.type(who.name.endsWith(".mp3") ? "audio/mpeg" : "audio/wav");
    res.send(buf);
  } catch (e) { sendErr(res, e, "Recording"); }
});

// Recordings older than 12 months go. Whole month folders first, then the edge month by file.
async function pruneArchive(rootId, now = Date.now()) {
  const cutoff = new Date(now - ARCHIVE_KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  const cutMonth = cutoff.slice(0, 7);
  let files = 0, folders = 0;
  const top = await pcloud("listfolder", { folderid: rootId, nofiles: 1 });
  for (const ag of (top.metadata.contents || []).filter((e) => e.isfolder && UUID_RE.test(e.name))) {
    const months = await pcloud("listfolder", { folderid: ag.folderid, nofiles: 1 });
    for (const m of (months.metadata.contents || []).filter((e) => e.isfolder && /^\d{4}-\d{2}$/.test(e.name))) {
      if (m.name < cutMonth) { await pcloud("deletefolderrecursive", { folderid: m.folderid }); folders++; continue; }
      if (m.name > cutMonth) continue;
      const list = await pcloud("listfolder", { folderid: m.folderid });
      for (const f of (list.metadata.contents || [])) {
        const mm = !f.isfolder && String(f.name).match(ARCHIVE_NAME_RE);
        if (mm && mm[1] < cutoff) { await pcloud("deletefile", { fileid: f.fileid }); files++; }
      }
    }
  }
  return { cutoff, files, folders };
}

// Proves the real path end to end: upload a tiny file where recordings go, read it back
// through the same code the Play button uses, then delete it.
async function archiveSelfTest(rootId) {
  const folder = await pcloudFolder({ folderid: rootId, name: "_selftest" });
  const probe = Buffer.from(`sentiv archive self-test ${Date.now()} ${Math.random()}`);
  const id = await pcloudUpload(folder, `selftest-${Date.now()}.txt`, probe);
  try {
    const back = await pcloudBytes(id);
    return back.equals(probe);
  } finally { await pcloud("deletefile", { fileid: id }).catch(() => {}); }
}

// Is this request the scheduled (or hand-run) workflow on main of OUR repo? GitHub signs
// a short-lived token per run; we check the signature against GitHub's published keys and
// the claims, so a token from any other repo, branch, event or audience is refused.
const _jwks = { at: 0, keys: [] };
async function githubKey(kid) {
  if (!_jwks.keys.length || Date.now() - _jwks.at > 3600e3 || !_jwks.keys.some((k) => k.kid === kid)) {
    const r = await fetch(OIDC_JWKS());
    const d = await r.json().catch(() => ({}));
    if (Array.isArray(d.keys)) { _jwks.keys = d.keys; _jwks.at = Date.now(); }
  }
  return _jwks.keys.find((k) => k.kid === kid) || null;
}
async function fromOurWorkflow(req) {
  try {
    const tok = (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const parts = tok.split(".");
    if (parts.length !== 3) return false;
    const dec = (x) => JSON.parse(Buffer.from(x, "base64url").toString("utf8"));
    const head = dec(parts[0]), claims = dec(parts[1]);
    if (head.alg !== "RS256") return false;
    const jwk = await githubKey(head.kid);
    if (!jwk) return false;
    const crypto = require("crypto");
    const ok = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"));
    const now = Date.now() / 1000;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    return ok && claims.iss === OIDC_ISS && aud.includes(OIDC_AUD) && claims.repository === SWEEP_REPO()
      && claims.ref === "refs/heads/main" && ["schedule", "workflow_dispatch"].includes(claims.event_name)
      && Number(claims.exp) > now && Number(claims.nbf || claims.iat || 0) <= now + 60;
  } catch (e) { return false; }
}

// What the archive holds (counts and sizes only), so the daily run shows it is real audio.
async function archiveStats(rootId) {
  const st = { agents: 0, files: 0, mp3: 0, wav: 0, mb: 0, thisMonth: 0 };
  const month = sastDay(new Date().toISOString()).slice(0, 7);
  const d = await pcloud("listfolder", { folderid: rootId, recursive: 1 });
  for (const ag of (d.metadata.contents || []).filter((e) => e.isfolder && UUID_RE.test(e.name))) {
    st.agents++;
    for (const mo of (ag.contents || []).filter((e) => e.isfolder)) {
      for (const f of (mo.contents || []).filter((e) => !e.isfolder && ARCHIVE_NAME_RE.test(e.name))) {
        st.files++; st.mb += (f.size || 0) / 1048576;
        if (/\.mp3$/.test(f.name)) st.mp3++; else st.wav++;
        if (mo.name === month) st.thisMonth++;
      }
    }
  }
  st.mb = Math.round(st.mb * 10) / 10;
  return st;
}

router.post("/archive/sweep", async (req, res) => {
  const bySecret = !!ARCHIVE_SECRET() && clean(req.get("x-archive-secret")) === ARCHIVE_SECRET();
  if (!bySecret && !(await fromOurWorkflow(req))) return res.status(401).json({ error: "only the daily GitHub workflow may run the archive sweep" });
  const out = { ok: false };
  try {
    const a = await archiveReady();
    out.selftest = await archiveSelfTest(a.root);
    if (KEY() && TENANT() && SB_URL() && SB_SERVICE()) {
      const map = await extMap();
      const calls = await archiveCandidates(Object.keys(map.byExt), map, ARCHIVE_WINDOW_DAYS, true);
      const r = await archiveCalls(calls, ARCHIVE_PER_SWEEP);
      Object.assign(out, { recorded: calls.length, archived: Object.keys(r.files).length, uploaded: r.uploaded, pending: r.pending, errors: r.errors });
    } else out.skipped = "Euphoria or Supabase not configured";
    out.prune = await pruneArchive(a.root);
    out.stats = await archiveStats(a.root).catch((e) => ({ error: e.message }));
    out.ok = out.selftest === true;   // a call Euphoria won't hand over is reported, not fatal
    console.log(`[archive] sweep ${JSON.stringify(out)}`);
    res.status(out.ok ? 200 : 500).json(out);
  } catch (e) { out.error = e.message; res.status(e.status || 502).json(out); }
});

router.get("/archive/health", async (_req, res) => {
  try {
    const a = await archiveRoot();
    res.json({ ok: !!a.root && a.fenced, configured: !!PC_TOKEN(), fenced: a.fenced, why: a.why || undefined, sweep: "github-oidc", sweepRepo: SWEEP_REPO(), keepDays: ARCHIVE_KEEP_DAYS });
  } catch (e) { res.json({ ok: false, configured: !!PC_TOKEN(), error: e.message }); }
});

module.exports = { router, originate, _test: { saNumber, ourExtension, parseRecords, shapeCall, normNumber, sastIso, pruneArchive } };

