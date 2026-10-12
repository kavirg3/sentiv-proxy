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
  const text = await r.text();
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
    res.json({ ok: out.ok && cfg.supabase, ...cfg, stt: !!AAI_KEY(), auth: out.ok ? "accepted" : out.error });
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

let _extCache = { at: 0, byUser: {}, byExt: {} };
async function extMap() {
  if (Date.now() - _extCache.at < 60e3) return _extCache;
  const rows = await sbGet("user_state?id=eq.euphoriaExt&select=agent_id,data");
  const claims = {};
  rows.forEach((r) => {
    const v = r && r.data && typeof r.data === "object" && "v" in r.data ? r.data.v : r && r.data;
    const ext = digitsExt(v);
    if (ext) (claims[ext] = claims[ext] || []).push(r.agent_id);
  });
  const byUser = {}, byExt = {};
  Object.entries(claims).forEach(([ext, ids]) => { if (ids.length === 1) { byExt[ext] = ids[0]; byUser[ids[0]] = ext; } });
  _extCache = { at: Date.now(), byUser, byExt };
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

function shapeCall(r, map) {
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
      console.log(`[euphoria] cdr shape: ${String(res.raw).replace(/>[^<]*</g, "><").slice(0, 400)}`);
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
    const rows = await cdrsCached(days, g.owner && !mine ? "" : g.ext);
    let calls = rows.map((r) => shapeCall(r, g.map)).filter((c) => c.at && c.dir !== "internal");
    if (!g.owner || mine) calls = calls.filter((c) => c.ext === g.ext);
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

async function audioFor(id) {
  const a = await euphoria("DownloadCallRecordingByCdrID", { cdrID: id });
  if (!a.ok) throw new Error(a.error);
  const b64 = tag(a.raw, "audioData");
  if (!b64) throw new Error("no recording on this call");
  return Buffer.from(b64, "base64");
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

module.exports = { router, originate, _test: { saNumber, ourExtension, parseRecords, shapeCall, normNumber, sastIso } };

