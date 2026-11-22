// node test-meeting-audio.js — meeting recordings kept in pCloud (22 Nov 2026, Hub v339),
// against fakes of Supabase, pCloud and AssemblyAI. Needs ../test.wav, ../test.webm and
// ../test.m4a (any short audio; ffmpeg-static can make them — see the bottom of DEPLOY.md).
// Shares the fakes with test-call-archive.js (copied, so each test stands alone).
// Covers: the Vault fence, archive-once by uID, who may play what, playback after Euphoria
// has dropped the call, the daily sweep (self-test, catch-up, 12-month delete) and the gate.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const fails = [];
const check = (name, cond, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); if (!cond) fails.push(name); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));

const OWNER = "6664924a-0ce3-4125-8343-b6c9183e3549", AGENT = "0eed71d1-0bf8-4217-94fc-ad20ba2c8a78", THIEF = "11111111-2222-3333-4444-555555555555";
const TOKENS = { "owner-tok": OWNER, "agent-tok": AGENT, "thief-tok": THIEF };
const WAV = fs.readFileSync(path.join(__dirname, "..", "test.wav"));

const cd = (v) => `<![CDATA[${v}]]>`;
const rec = (o) => `<CDR><uID>${cd(o.id)}</uID><StartTime>${cd(o.t)}</StartTime><Duration>${cd(o.d)}</Duration><CallerID>${cd('"x" <100>')}</CallerID><Destination>${cd(o.dst)}</Destination><Source>${cd(o.src)}</Source><Status>${cd(o.st || "ANSWERED")}</Status><ChannelID>${cd(o.ch)}</ChannelID><DestChannel>${cd(o.dch || "")}</DestChannel><Recorded>${cd(o.rec ? 1 : 0)}</Recorded><RecordingFilename>${cd(o.rec ? "pbx-" + o.id + ".WAV" : "")}</RecordingFilename></CDR>`;
let CDRS = [
  { id: 501, t: "2026-10-12 09:40:00", d: 252, src: "100", dst: "0825550111", ch: "PJSIP/100-FutureLifeTech-0000002a", dch: "PJSIP/GW3-0000002b", rec: true },              // owner, recorded
  { id: 502, t: "2026-10-12 10:05:10", d: 0, src: "100", dst: "0115550100", ch: "PJSIP/100-FutureLifeTech-0000003a", dch: "PJSIP/GW3-0000003b", st: "NO ANSWER", rec: true }, // not answered → skip
  { id: 503, t: "2026-10-12 11:00:00", d: 95, src: "+27725550199", dst: "0105934500", ch: "PJSIP/GW3-0000004a", dch: "PJSIP/101-FutureLifeTech-0000004b", rec: true },  // agent 101, recorded
  { id: 504, t: "2026-10-12 11:30:00", d: 30, src: "100", dst: "101", ch: "PJSIP/100-FutureLifeTech-0000005a", dch: "PJSIP/101-FutureLifeTech-0000005b", rec: true },  // internal → skip
  { id: 505, t: "2026-10-12 12:00:00", d: 40, src: "100", dst: "0835550000", ch: "PJSIP/100-FutureLifeTech-0000006a", dch: "PJSIP/GW3" },                                // not recorded → skip
  { id: 506, t: "2026-10-01 00:30:00", d: 75, src: "+27101429217", dst: "0732532235", ch: "Local/0732532235@from-internal-0001;2", dch: "PJSIP/GW3-00009", rec: true, forExt: "100" }, // SAST 1 Oct = UTC 30 Sep
];
let downloads = 0;
const euph = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const act = (b.match(/<ActionName>(.*?)<\/ActionName>/) || [])[1];
    const f = (n) => (b.match(new RegExp(`<${n}>(.*?)</${n}>`)) || [])[1];
    res.writeHead(200, { "Content-Type": "text/xml" });
    if (act === "GetCallDetailRecords") {
      const ext = f("extension");
      const list = CDRS.filter((c) => !ext || c.forExt === ext || c.ch.includes(`/${ext}-`) || (c.dch || "").includes(`/${ext}-`));
      return res.end(`<?xml version='1.0'?><XML>${list.map(rec).join("")}</XML>`);
    }
    // Like live (16 Oct 2026): <cdrID> → "Api Service Error". This fake only answers the filename
    // form, with the audio in an undocumented tag, so the fallbacks are what gets exercised.
    if (act === "DownloadCallRecordingByCdrID") return res.end("<?xml version='1.0'?><XML><Status>Failed</Status><Error>Api Service Error</Error></XML>");
    if (act === "DownloadCallRecordingByFilename" && f("filename")) { downloads++; return res.end(`<?xml version='1.0'?><XML><Status>Success</Status><Data>${cd(WAV.toString("base64"))}</Data></XML>`); }
    res.end("<XML><Response>ok</Response></XML>");
  });
});
const sb = http.createServer((req, res) => {
  const tok = (req.headers.authorization || "").replace("Bearer ", "");
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/auth/v1/user") { const id = TOKENS[tok]; res.writeHead(id ? 200 : 401); return res.end(JSON.stringify(id ? { id } : {})); }
  if (tok !== "service") { res.writeHead(401); return res.end("[]"); }
  if (req.url.startsWith("/rest/v1/team_settings")) return res.end(JSON.stringify([{ data: { phoneExts: { [OWNER]: "100", [AGENT]: "101" } } }]));
  if (req.url.startsWith("/rest/v1/profiles")) { const id = decodeURIComponent((req.url.match(/id=eq\.([^&]+)/) || [])[1] || ""); return res.end(JSON.stringify([{ role: id === OWNER ? "owner" : "agent" }])); }
  res.end("[]");
});

// ---- fake pCloud: an in-memory drive ------------------------------------------------
let nextId = 100;
const nodes = new Map();   // id -> { id, name, parent, isfolder, data, mtime }
nodes.set("0", { id: "0", name: "/", parent: null, isfolder: true });
const kids = (id) => [...nodes.values()].filter((n) => n.parent === id);
const mk = (parent, name, isfolder, data, mtime) => { const id = String(nextId++); nodes.set(id, { id, name, parent, isfolder, data, mtime }); return id; };
const meta = (n) => n.isfolder ? { isfolder: true, folderid: Number(n.id), name: n.name, parentfolderid: n.parent === null ? undefined : Number(n.parent) }
  : { isfolder: false, fileid: Number(n.id), name: n.name, parentfolderid: Number(n.parent), size: n.data.length, modified: n.mtime ? new Date(n.mtime * 1000).toUTCString() : undefined };   // pCloud sends an RFC date
const byPath = (p) => { let cur = "0"; for (const part of p.split("/").filter(Boolean)) { const k = kids(cur).find((n) => n.isfolder && n.name === part); if (!k) return null; cur = k.id; } return cur; };
const VAULT = mk("0", "Sentiv Vault", true);
const VAULT_FILE = mk(VAULT, "2026-10-01_999.mp3", false, Buffer.from("vault"));
mk(VAULT, "Calls", true);
const pcCalls = [];
let pcAuthBad = 0;
const pc = http.createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
    const u = new URL(req.url, "http://x"), q = Object.fromEntries(u.searchParams);
    const m = u.pathname.slice(1);
    if (m === "dl") { const n = nodes.get(q.id); res.writeHead(n ? 200 : 404); return res.end(n ? n.data : ""); }
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer pc-token") { pcAuthBad++; return res.end(JSON.stringify({ result: 1000, error: "Log in required." })); }
    pcCalls.push({ m, q });
    const ok = (o) => res.end(JSON.stringify({ result: 0, ...o }));
    const err = (e) => res.end(JSON.stringify({ result: 2005, error: e }));
    if (m === "createfolderifnotexists") {
      let parent, name;
      if (q.path) { const parts = q.path.split("/").filter(Boolean); name = parts.pop(); parent = byPath(parts.join("/")); }
      else { parent = q.folderid; name = q.name; }
      if (!parent || !nodes.get(parent)) return err("Directory does not exist.");
      const have = kids(parent).find((n) => n.isfolder && n.name === name);
      const id = have ? have.id : mk(parent, name, true);
      return ok({ created: !have, metadata: meta(nodes.get(id)) });
    }
    if (m === "listfolder") {
      const n = nodes.get(q.folderid); if (!n || !n.isfolder) return err("Directory does not exist.");
      const tree = (x) => ({ ...meta(x), ...(x.isfolder ? { contents: kids(x.id).filter((k) => !q.nofiles || k.isfolder).map((k) => (q.recursive && k.isfolder ? tree(k) : meta(k))) } : {}) });
      return ok({ metadata: tree(n) });
    }
    if (m === "uploadfile") {
      const body = Buffer.concat(chunks);
      const bnd = "--" + (req.headers["content-type"].match(/boundary=(.+)$/) || [])[1];
      const start = body.indexOf(bnd), headEnd = body.indexOf("\r\n\r\n", start), end = body.indexOf("\r\n" + bnd, headEnd);
      const head = body.slice(start, headEnd).toString();
      const name = (head.match(/filename="([^"]+)"/) || [])[1];
      const data = body.slice(headEnd + 4, end);
      if (!nodes.get(q.folderid)) return err("Directory does not exist.");
      const old = kids(q.folderid).find((n) => !n.isfolder && n.name === name);
      if (old) nodes.delete(old.id);
      const id = mk(q.folderid, name, false, data, q.mtime ? Number(q.mtime) : null);
      return ok({ fileids: [Number(id)], metadata: [meta(nodes.get(id))] });
    }
    if (m === "checksumfile") { const n = nodes.get(q.fileid); if (!n || n.isfolder) return err("File not found."); return ok({ metadata: meta(n) }); }
    if (m === "getfilelink") { const n = nodes.get(q.fileid); if (!n) return err("File not found."); return ok({ hosts: [`http://127.0.0.1:${PCP}`], path: `/dl?id=${n.id}` }); }
    if (m === "deletefile") { nodes.delete(q.fileid); return ok({}); }
    if (m === "deletefolderrecursive") { const del = (id) => { kids(id).forEach((k) => del(k.id)); nodes.delete(id); }; del(q.folderid); return ok({}); }
    err("unknown method " + m);
  });
});
let PCP = 0;

// ---- fake GitHub OIDC: a signing key, its JWKS, and a token minter ------------------
const crypto = require("crypto");
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const evil = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = http.createServer((req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "gh1", alg: "RS256", use: "sig" }] })); });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(over = {}, { key = privateKey, kid = "gh1" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: "https://token.actions.githubusercontent.com", aud: "sentiv-proxy-archive", repository: "kavirg3/sentiv-proxy", ref: "refs/heads/main", event_name: "schedule", iat: now, nbf: now, exp: now + 300, ...over };
  const h = b64({ alg: "RS256", kid, typ: "JWT" }), p = b64(claims);
  return `${h}.${p}.${crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
}

async function boot(port, env) {
  const p = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 50 && !/listening/.test(log); i++) await wait(100);
  return { p, log: () => log };
}
const P = 20000 + Math.floor(Math.random() * 20000);
const filesUnder = (agent) => { const a = kids(byPath("Sentiv Call Recordings") || "-").find((n) => n.name === agent); return a ? kids(a.id).flatMap((mo) => kids(mo.id).map((f) => `${mo.name}/${f.name}`)).sort() : []; };


const WEBM = fs.readFileSync(path.join(__dirname, "..", "test.webm"));
const M4A = fs.readFileSync(path.join(__dirname, "..", "test.m4a"));
// ---- fake AssemblyAI ----
const aaiSeen = [];
const aai = http.createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "aai-key") { res.writeHead(401); return res.end("{}"); }
    if (req.url === "/v2/upload") { aaiSeen.push({ upload: Buffer.concat(chunks).length }); return res.end(JSON.stringify({ upload_url: "https://cdn/u1" })); }
    if (req.url === "/v2/transcript" && req.method === "POST") { aaiSeen.push({ start: JSON.parse(Buffer.concat(chunks).toString()) }); return res.end(JSON.stringify({ id: "job1" })); }
    if (req.url === "/v2/transcript/job1") return res.end(JSON.stringify({ status: "completed", text: "hello there", utterances: [{ speaker: "A", start: 1200, text: "Hello there." }, { speaker: "B", start: 4100, text: "We need ten radios." }] }));
    res.writeHead(404); res.end("{}");
  });
});
const meetFiles = (agent) => { const a = kids(byPath("Sentiv Meeting Recordings") || "-").find((n) => n.name === agent); return a ? kids(a.id).flatMap((mo) => kids(mo.id).map((f) => `${mo.name}/${f.name}`)).sort() : []; };

(async () => {
  const sp = await listen(sb), jp = await listen(jwks), ap = await listen(aai); PCP = await listen(pc);
  const base = { SUPABASE_URL: `http://127.0.0.1:${sp}`, SUPABASE_SERVICE_KEY: "service", PCLOUD_API_URL: `http://127.0.0.1:${PCP}`, PCLOUD_TOKEN: "pc-token", GITHUB_OIDC_JWKS_URL: `http://127.0.0.1:${jp}/jwks`, ASSEMBLYAI_BASE_URL: `http://127.0.0.1:${ap}` };
  const B = (port) => `http://127.0.0.1:${port}/api/euphoria`;
  const up = async (port, tok, q, body, ct = "audio/webm") => { const r = await fetch(`${B(port)}/meetings/upload?${q}`, { method: "POST", headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), "Content-Type": ct }, body }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const get = async (port, u, tok) => { const r = await fetch(B(port) + u, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} }); const ct = r.headers.get("content-type") || ""; return { status: r.status, ct, body: /json/.test(ct) ? await r.json() : Buffer.from(await r.arrayBuffer()) }; };
  const now = Date.now();

  // 1. Unfenced (no PCLOUD_ROOT) → refuses to keep meeting audio.
  let s = await boot(P + 1, base);
  let r = await up(P + 1, "agent-tok", `rec=M${now}&at=${now}`, WEBM);
  check("unfenced: upload refused, nothing written", r.status === 503 && /switched off/.test(r.body.error || "") && !meetFiles(AGENT).length, JSON.stringify(r.body));
  r = await get(P + 1, "/archive/health");
  check("health reports the meetings folder separately", r.body.meetings && r.body.meetings.ok === false && r.body.meetings.stt === false, JSON.stringify(r.body.meetings));
  s.p.kill();

  // 2. Fenced, no AssemblyAI key: audio kept, no transcription.
  s = await boot(P + 2, { ...base, PCLOUD_ROOT: VAULT });
  r = await up(P + 2, null, `rec=M${now}&at=${now}`, WEBM);
  check("upload: no sign-in → 401", r.status === 401);
  r = await up(P + 2, "agent-tok", `rec=bad&at=${now}`, WEBM);
  check("upload: bad meeting id → 400", r.status === 400);
  r = await up(P + 2, "agent-tok", `rec=M${now}&at=${now}`, Buffer.alloc(10));
  check("upload: empty audio → 400", r.status === 400);
  const id1 = `M${now}`;
  r = await up(P + 2, "agent-tok", `rec=${id1}&at=${now}&transcribe=1`, WEBM);
  const f1 = r.body.fileid;
  check("upload webm: kept, converted to MP3, seconds worked out", r.status === 200 && !!f1 && r.body.seconds >= 5 && r.body.seconds <= 7 && meetFiles(AGENT).some((f) => f.endsWith(`_${id1}.mp3`)), JSON.stringify(r.body) + " " + meetFiles(AGENT).join(","));
  check("no AssemblyAI key: no job, says stt off", r.body.job === null && r.body.stt === false && !aaiSeen.length);
  check("meeting folder sits outside the Vault, apart from call recordings", !!byPath("Sentiv Meeting Recordings") && !kids(VAULT).some((n) => /Meeting/.test(n.name)));
  r = await up(P + 2, "agent-tok", `rec=${id1}&at=${now}`, WEBM);
  check("same meeting id again: first file kept, no second copy", r.status === 200 && r.body.fileid === f1 && r.body.existed === true && meetFiles(AGENT).length === 1, meetFiles(AGENT).join(","));
  const id2 = `M${now + 1}`;
  r = await up(P + 2, "agent-tok", `rec=${id2}&at=${now}`, M4A, "audio/mp4");
  check("upload iPhone-style mp4: converted to MP3", r.status === 200 && meetFiles(AGENT).some((f) => f.endsWith(`_${id2}.mp3`)), JSON.stringify(r.body));
  r = await get(P + 2, `/meetings/play/${f1}`, "agent-tok");
  check("play: the recorder gets the MP3", r.status === 200 && /audio\/mpeg/.test(r.ct) && r.body.length > 1000, `${r.status} ${r.ct}`);
  r = await get(P + 2, `/meetings/play/${f1}`, "owner-tok");
  check("play: the owner can play it", r.status === 200 && /audio\/mpeg/.test(r.ct));
  r = await get(P + 2, `/meetings/play/${f1}`, "thief-tok");
  check("play: someone else gets nothing", r.status === 404);
  r = await get(P + 2, `/meetings/play/${VAULT_FILE}`, "owner-tok");
  check("play: a Vault file is never served as a meeting", r.status === 404);
  const callFolder = byPath("Sentiv Call Recordings");
  r = await fetch(`${B(P + 2)}/meetings/transcribe/${f1}`, { method: "POST", headers: { Authorization: "Bearer agent-tok" } });
  check("transcribe without a key → 501 says why", r.status === 501 && /ASSEMBLYAI_API_KEY/.test((await r.json()).error || ""));
  s.p.kill();

  // 3. With AssemblyAI: upload starts a job, and the job is pollable by its starter only.
  s = await boot(P + 3, { ...base, PCLOUD_ROOT: VAULT, ASSEMBLYAI_API_KEY: "aai-key" });
  const id3 = `M${now + 2}`;
  r = await up(P + 3, "owner-tok", `rec=${id3}&at=${now}&transcribe=1`, WEBM);
  check("with key: upload kept and a transcription started", r.status === 200 && r.body.job === "job1" && r.body.stt === true, JSON.stringify(r.body));
  const start = aaiSeen.find((x) => x.start);
  check("transcription asks for speaker labels, no fixed speaker count", start && start.start.speaker_labels === true && !("speakers_expected" in start.start), JSON.stringify(start));
  check("what went to AssemblyAI is the MP3, not the raw upload", aaiSeen.some((x) => x.upload && x.upload < WEBM.length));
  r = await get(P + 3, "/transcribe/job/job1", "owner-tok");
  check("job poll: utterances with speakers come back", r.body.status === "completed" && r.body.utterances.length === 2 && r.body.utterances[1].speaker === "B", JSON.stringify(r.body));
  r = await get(P + 3, "/transcribe/job/job1", "agent-tok");
  check("job poll: someone else's job is refused", r.status === 404);
  r = await fetch(`${B(P + 3)}/meetings/transcribe/${f1}`, { method: "POST", headers: { Authorization: "Bearer owner-tok" } });
  check("re-transcribe an earlier meeting (owner)", r.status === 200 && (await r.json()).job === "job1");
  r = await get(P + 3, "/archive/health");
  check("health: meetings fenced and stt on", r.body.meetings && r.body.meetings.ok === true && r.body.meetings.stt === true, JSON.stringify(r.body.meetings));

  // 4. The daily sweep deletes meeting audio over 12 months old, keeps the rest.
  const agentFolder = kids(byPath("Sentiv Meeting Recordings")).find((n) => n.name === AGENT).id;
  const oldMonth = mk(agentFolder, "2025-06", true);
  mk(oldMonth, "2025-06-03_M1749000000000.mp3", false, Buffer.from("old"));
  const edge = new Date(Date.now() - 370 * 864e5).toISOString().slice(0, 10);
  const edgeMonth = kids(agentFolder).find((n) => n.name === edge.slice(0, 7)) ? kids(agentFolder).find((n) => n.name === edge.slice(0, 7)).id : mk(agentFolder, edge.slice(0, 7), true);
  mk(edgeMonth, `${edge}_M1700000000000.mp3`, false, Buffer.from("edge"));
  r = await fetch(`${B(P + 3)}/archive/sweep`, { method: "POST", headers: { Authorization: `Bearer ${jwt({ event_name: "workflow_dispatch" })}` } });
  const sw = await r.json();
  check("sweep prunes meetings over 12 months", sw.meetPrune && sw.meetPrune.folders >= 1 && sw.meetPrune.files >= 0 && !meetFiles(AGENT).some((f) => f.startsWith("2025-06")) && !meetFiles(AGENT).some((f) => f.includes(edge)), JSON.stringify(sw.meetPrune) + " " + meetFiles(AGENT).join(","));
  check("sweep keeps this year's meetings", meetFiles(AGENT).filter((f) => /_M\d+\.mp3$/.test(f)).length >= 2, meetFiles(AGENT).join(","));
  check("call recordings untouched by the meeting upload", !callFolder || kids(callFolder).every((n) => n.name !== "_meetings"));
  s.p.kill();

  console.log(fails.length ? `\n${fails.length} FAILED:\n- ${fails.join("\n- ")}` : "\nAll meeting-audio checks passed.");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
