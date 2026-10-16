// node test-call-archive.js — the pCloud call archive (16 Oct 2026) against fakes of
// Euphoria, Supabase and pCloud. Needs a small WAV at ../test.wav (any PCM WAV).
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
    if (act === "DownloadCallRecordingByCdrID") { downloads++; return res.end(`<?xml version='1.0'?><XML><audioData>${cd(WAV.toString("base64"))}</audioData></XML>`); }
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
  : { isfolder: false, fileid: Number(n.id), name: n.name, parentfolderid: Number(n.parent), size: n.data.length, modified: n.mtime };
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
      return ok({ metadata: { ...meta(n), contents: kids(n.id).filter((k) => !q.nofiles || k.isfolder).map(meta) } });
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

(async () => {
  const ep = await listen(euph), sp = await listen(sb), jp = await listen(jwks); PCP = await listen(pc);
  const base = { EUPHORIA_API_URL: `http://127.0.0.1:${ep}/api`, SUPABASE_URL: `http://127.0.0.1:${sp}`, SUPABASE_SERVICE_KEY: "service", EUPHORIA_API_KEY: "good-key", EUPHORIA_TENANT: "FutureLifeTech", PCLOUD_API_URL: `http://127.0.0.1:${PCP}`, PCLOUD_TOKEN: "pc-token", GITHUB_OIDC_JWKS_URL: `http://127.0.0.1:${jp}/jwks` };
  const mkApi = (port) => {
    const B = `http://127.0.0.1:${port}/api/euphoria`;
    return {
      get: async (u, tok) => { const r = await fetch(B + u, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} }); const ct = r.headers.get("content-type") || ""; return { status: r.status, ct, body: /json/.test(ct) ? await r.json() : Buffer.from(await r.arrayBuffer()) }; },
      post: async (u, tok, headers = {}) => { const r = await fetch(B + u, { method: "POST", headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...headers } }); return { status: r.status, body: await r.json().catch(() => ({})) }; },
    };
  };

  // 1. No Vault fence configured → the archive refuses to run at all.
  let s = await boot(P + 1, base);
  let api = mkApi(P + 1);
  let r = await api.get("/archive/health");
  check("health without PCLOUD_ROOT: not fenced, says why", r.status === 200 && r.body.ok === false && r.body.fenced === false && /PCLOUD_ROOT/.test(r.body.why || ""), JSON.stringify(r.body));
  r = await api.post("/archive/sync", "agent-tok");
  check("sync refuses when recordings would show in the Vault", r.status === 503 && /switched off/.test(r.body.error || ""), JSON.stringify(r.body));
  check("nothing uploaded while unfenced", !pcCalls.some((c) => c.m === "uploadfile"));
  s.p.kill();

  // 2. Archive folder INSIDE the Vault → refused too.
  s = await boot(P + 2, { ...base, PCLOUD_ROOT: VAULT, CALLS_ARCHIVE_PATH: "/Sentiv Vault/Calls" });
  api = mkApi(P + 2);
  r = await api.get("/archive/health");
  check("archive folder inside the Vault is refused", r.body.ok === false && /inside the agents' Vault/.test(r.body.why || ""), JSON.stringify(r.body));
  s.p.kill();

  // 3. Proper setup: Vault fenced, archive at the drive root.
  s = await boot(P + 3, { ...base, PCLOUD_ROOT: VAULT });
  api = mkApi(P + 3);
  r = await api.get("/archive/health");
  check("health: configured, fenced, sweep via GitHub OIDC for our repo, 365 days", r.body.ok === true && r.body.fenced === true && r.body.sweep === "github-oidc" && r.body.sweepRepo === "kavirg3/sentiv-proxy" && r.body.keepDays === 365, JSON.stringify(r.body));
  check("the archive folder is NOT inside the Vault", byPath("Sentiv Call Recordings") && !kids(VAULT).some((n) => n.name === "Sentiv Call Recordings"));

  r = await api.post("/archive/sync");
  check("sync: no sign-in → 401 (server gate)", r.status === 401);
  r = await api.post("/archive/sync", "thief-tok");
  check("sync: someone with no extension archives nothing", r.status === 200 && r.body.needsExtension === true && Object.keys(r.body.files).length === 0, JSON.stringify(r.body));

  r = await api.post("/archive/sync", "agent-tok");
  check("agent sync archives their one recorded answered call", r.status === 200 && r.body.uploaded === 1 && Object.keys(r.body.files).join() === "503", JSON.stringify(r.body));
  check("stored as <agent>/<month>/<date>_<uID>.mp3", JSON.stringify(filesUnder(AGENT)) === JSON.stringify(["2026-10/2026-10-12_503.mp3"]), filesUnder(AGENT).join());
  const f503 = r.body.files["503"];
  const n503 = nodes.get(String(f503));
  check("it is real MP3 (converted from Euphoria's WAV)", n503 && (n503.data.slice(0, 3).toString("latin1") === "ID3" || (n503.data[0] === 0xff && (n503.data[1] & 0xe0) === 0xe0)), n503 && n503.data.slice(0, 4).toString("hex"));
  const up = pcCalls.filter((c) => c.m === "uploadfile").pop();
  check("upload carries the call time (mtime) and nopartial", up && up.q.mtime === String(Date.parse("2026-10-12T09:00:00Z") / 1000) && up.q.nopartial === "1", JSON.stringify(up && up.q));

  const dl0 = downloads, up0 = pcCalls.filter((c) => c.m === "uploadfile").length;
  r = await api.post("/archive/sync", "agent-tok");
  check("second sync uploads nothing and still returns the file id", r.body.uploaded === 0 && r.body.files["503"] === f503 && downloads === dl0 && pcCalls.filter((c) => c.m === "uploadfile").length === up0, JSON.stringify(r.body));

  r = await api.post("/archive/sync", "owner-tok");
  const ownerFiles = Object.keys(r.body.files || {}).sort().join();
  check("owner sync archives the whole team: 501, 503, 506 only", ownerFiles === "501,503,506" && r.body.uploaded === 2, JSON.stringify(r.body));
  check("owner's calls filed under the owner, by SAST date (506 → 2026-10)", JSON.stringify(filesUnder(OWNER)) === JSON.stringify(["2026-10/2026-10-01_506.mp3", "2026-10/2026-10-12_501.mp3"]), filesUnder(OWNER).join());
  const f501 = r.body.files["501"];

  // Playback
  r = await api.get(`/archive/play/${f503}`, "agent-tok");
  check("agent plays their own archived call", r.status === 200 && /audio\/mpeg/.test(r.ct) && Buffer.compare(r.body, n503.data) === 0, `${r.status} ${r.ct}`);
  r = await api.get(`/archive/play/${f501}`, "agent-tok");
  check("agent can't play the owner's call", r.status === 404);
  r = await api.get(`/archive/play/${f503}`, "thief-tok");
  check("another signed-in person can't play it", r.status === 404);
  r = await api.get(`/archive/play/${f503}`);
  check("no sign-in → 401", r.status === 401);
  r = await api.get(`/archive/play/${f503}`, "owner-tok");
  check("owner plays the agent's call", r.status === 200 && r.body.length === n503.data.length);
  r = await api.get(`/archive/play/${VAULT_FILE}`, "owner-tok");
  check("a file outside the archive (Vault) can't be pulled through this route", r.status === 404);
  r = await api.get(`/archive/play/abc`, "owner-tok");
  check("a junk id is refused", r.status === 404);
  CDRS = CDRS.filter((c) => c.id !== 503);
  r = await api.get(`/archive/play/${f503}`, "agent-tok");
  check("still plays after Euphoria has dropped the call", r.status === 200 && r.body.length === n503.data.length);

  // Sweep: secret, self-test, catch-up, 12-month delete
  r = await api.post("/archive/sweep");
  check("sweep with no token → 401 (open past the sign-in gate, shut by the GitHub check)", r.status === 401 && /GitHub workflow/.test(r.body.error || ""), JSON.stringify(r.body));
  r = await api.post("/archive/sweep", null, { "x-archive-secret": "anything" });
  check("no secret configured → a guessed x-archive-secret is refused", r.status === 401);
  r = await api.post("/archive/sweep", "agent-tok");
  check("a signed-in agent can't run the sweep", r.status === 401);
  const bad = {
    "signed by another key": jwt({}, { key: evil.privateKey }),
    "unknown key id": jwt({}, { kid: "nope" }),
    "another repo": jwt({ repository: "someone/sentiv-proxy" }),
    "a branch, not main": jwt({ ref: "refs/heads/evil" }),
    "a pull request run": jwt({ event_name: "pull_request" }),
    "wrong audience": jwt({ aud: "api://AzureADTokenExchange" }),
    "expired": jwt({ exp: Math.floor(Date.now() / 1000) - 10 }),
    "tampered claims": (() => { const t = jwt().split("."); t[1] = b64({ ...JSON.parse(Buffer.from(t[1], "base64url")), repository: "x/y" }); return t.join("."); })(),
    "alg none": `${b64({ alg: "none", kid: "gh1" })}.${b64({ iss: "https://token.actions.githubusercontent.com", aud: "sentiv-proxy-archive", repository: "kavirg3/sentiv-proxy", ref: "refs/heads/main", event_name: "schedule", exp: 9999999999 })}.`,
  };
  for (const [why, tok] of Object.entries(bad)) { r = await api.post("/archive/sweep", tok); check(`sweep refuses a token from ${why}`, r.status === 401, String(r.status)); }
  CDRS.push({ id: 508, t: "2026-10-13 08:00:00", d: 61, src: "101", dst: "0825550123", ch: "PJSIP/101-FutureLifeTech-0000009a", dch: "PJSIP/GW3-9", rec: true });
  const root = byPath("Sentiv Call Recordings");
  const agentDir = kids(root).find((n) => n.name === AGENT).id;
  const now = Date.now(), day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const cutoff = day(now - 365 * 864e5);
  const prevMonth = (() => { const d = new Date(cutoff + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
  const oldDir = mk(agentDir, prevMonth, true); mk(oldDir, `${prevMonth}-15_1.mp3`, false, Buffer.from("old"));
  const edgeDir = kids(agentDir).find((n) => n.name === cutoff.slice(0, 7)) ? kids(agentDir).find((n) => n.name === cutoff.slice(0, 7)).id : mk(agentDir, cutoff.slice(0, 7), true);
  const oldF = mk(edgeDir, `${day(now - 366 * 864e5)}_2.mp3`, false, Buffer.from("old"));
  const keepF = mk(edgeDir, `${day(now - 360 * 864e5)}_3.mp3`, false, Buffer.from("keep"));
  const strayF = mk(edgeDir, `notes.txt`, false, Buffer.from("not ours"));
  r = await api.post("/archive/sweep", jwt({ event_name: "workflow_dispatch" }));
  check("sweep: our workflow's token accepted, self-test passed", r.status === 200 && r.body.ok === true && r.body.selftest === true, JSON.stringify(r.body));
  check("sweep catches up a call nobody's Hub archived (508)", r.body.uploaded === 1 && filesUnder(AGENT).includes("2026-10/2026-10-13_508.mp3"), JSON.stringify(r.body));
  check("sweep deletes month folders older than 12 months", !nodes.get(oldDir), JSON.stringify(r.body.prune));
  check("sweep deletes the edge month's files past 365 days, keeps newer", !nodes.get(oldF) && !!nodes.get(keepF), JSON.stringify(r.body.prune));
  check("sweep leaves files that aren't recordings alone", !!nodes.get(strayF));
  check("this month's recordings untouched", filesUnder(AGENT).includes("2026-10/2026-10-12_503.mp3"));
  check("self-test file cleaned up", kids(kids(root).find((n) => n.name === "_selftest").id).length === 0);
  check("the Vault was never written to", kids(VAULT).length === 2);
  check("pCloud never saw a request without the token", pcAuthBad === 0);
  check("no phone numbers in the server log", !/0825550123|0725550199|0825550111/.test(s.log()), "");
  s.p.kill();

  // The by-hand secret, when one is set on the server.
  s = await boot(P + 4, { ...base, PCLOUD_ROOT: VAULT, CALLS_SWEEP_SECRET: "hand-s3cret" });
  api = mkApi(P + 4);
  r = await api.post("/archive/sweep", null, { "x-archive-secret": "wrong" });
  check("by-hand secret: wrong one refused", r.status === 401);
  r = await api.post("/archive/sweep", null, { "x-archive-secret": "hand-s3cret" });
  check("by-hand secret: right one runs the sweep", r.status === 200 && r.body.selftest === true, JSON.stringify(r.body));
  s.p.kill();

  console.log(fails.length ? `\n${fails.length} FAILED:\n- ${fails.join("\n- ")}` : "\nALL PASS");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
