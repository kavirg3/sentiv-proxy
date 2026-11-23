// node test-task-files.js — attachments on "Add a task" kept in pCloud (23 Nov 2026, Hub v344),
// against fakes of Supabase and pCloud (harness copied from test-meeting-audio.js).
// Covers: the Vault fence, allowed file kinds, keep-once by fid, who may open and delete.
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
const WAV = Buffer.alloc(0);

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

const taskFiles = (agent) => { const a = kids(byPath("Sentiv Task Files") || "-").find((n) => n.name === agent); return a ? kids(a.id).flatMap((mo) => kids(mo.id).map((f) => f.name)).sort() : []; };
(async () => {
  euph.listen(0); const sp = await listen(sb); PCP = await listen(pc); const jp = await listen(jwks);
  const base = { SUPABASE_URL: `http://127.0.0.1:${sp}`, SUPABASE_SERVICE_KEY: "service", PCLOUD_API_URL: `http://127.0.0.1:${PCP}`, PCLOUD_TOKEN: "pc-token", GITHUB_OIDC_JWKS_URL: `http://127.0.0.1:${jp}/jwks` };
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(2000)]);
  let s = await boot(P, base);
  const api = (port) => async (method, p, tok, body, ct) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/euphoria${p}`, { method, headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(ct ? { "Content-Type": ct } : {}) }, body });
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString()); } catch (e) { /* binary */ }
    return { status: r.status, json, buf, type: r.headers.get("content-type") || "" };
  };
  let call = api(P);
  // 1. Unfenced → refuses.
  let r = await call("POST", "/tasks/files/upload?fid=F1732350000001&name=shot.png", "agent-tok", PNG, "image/png");
  check("unfenced pCloud refuses task files", r.status === 503, `HTTP ${r.status} ${r.json && r.json.error}`);
  s.p.kill(); await wait(150);
  s = await boot(P + 1, { ...base, PCLOUD_ROOT: VAULT }); call = api(P + 1);
  r = await call("GET", "/archive/health");
  check("health reports taskFiles fenced", r.json && r.json.taskFiles && r.json.taskFiles.ok === true, JSON.stringify(r.json && r.json.taskFiles));
  // 2. Strangers + bad input.
  r = await call("POST", "/tasks/files/upload?fid=F1732350000001&name=shot.png", "", PNG, "image/png");
  check("no sign-in → 401", r.status === 401, `HTTP ${r.status}`);
  r = await call("POST", "/tasks/files/upload?fid=bad&name=shot.png", "agent-tok", PNG, "image/png");
  check("bad fid → 400", r.status === 400, `HTTP ${r.status}`);
  r = await call("POST", "/tasks/files/upload?fid=F1732350000002&name=run.exe", "agent-tok", PNG, "application/octet-stream");
  check("exe refused → 415", r.status === 415, `HTTP ${r.status}`);
  r = await call("POST", "/tasks/files/upload?fid=F1732350000002&name=page.html", "agent-tok", Buffer.from("<script>x</script>"), "text/html");
  check("html refused → 415", r.status === 415, `HTTP ${r.status}`);
  // 3. Agent uploads a screenshot (pasted: no name, type only) and a PDF.
  r = await call("POST", "/tasks/files/upload?fid=F1732350000001&name=", "agent-tok", PNG, "image/png");
  check("agent uploads pasted png", r.status === 200 && /^\d+$/.test(r.json.fileid), JSON.stringify(r.json));
  const shot = r.json && r.json.fileid;
  r = await call("POST", "/tasks/files/upload?fid=F1732350000001&name=", "agent-tok", PNG, "image/png");
  check("same fid twice keeps one copy", r.status === 200 && r.json.fileid === shot && r.json.existed === true && taskFiles(AGENT).length === 1, `${JSON.stringify(r.json)} ${taskFiles(AGENT)}`);
  r = await call("POST", "/tasks/files/upload?fid=F1732350000003&name=Quote%20v2.PDF", "agent-tok", Buffer.from("%PDF-1.4 test"), "application/pdf");
  const pdf = r.json && r.json.fileid;
  check("agent uploads pdf", r.status === 200 && !!pdf && taskFiles(AGENT).some((n) => /_F1732350000003\.pdf$/.test(n)), `${taskFiles(AGENT)}`);
  check("files sit under /Sentiv Task Files/<user>/<month>/, not in the Vault", taskFiles(AGENT).length === 2 && kids(VAULT).length === 2);
  // 4. Who may open.
  r = await call("GET", `/tasks/files/${shot}`, "agent-tok");
  check("uploader opens it, right bytes and type", r.status === 200 && r.buf.equals(PNG) && /image\/png/.test(r.type), `${r.status} ${r.type}`);
  r = await call("GET", `/tasks/files/${shot}`, "owner-tok");
  check("owner opens it", r.status === 200 && r.buf.equals(PNG));
  r = await call("GET", `/tasks/files/${shot}`, "thief-tok");
  check("another agent can't open it", r.status === 404, `HTTP ${r.status}`);
  r = await call("GET", `/tasks/files/${VAULT_FILE}`, "owner-tok");
  check("a Vault file can't be read through this route", r.status === 404, `HTTP ${r.status}`);
  r = await call("GET", `/tasks/files/${pdf}`, "agent-tok");
  check("pdf served as application/pdf", r.status === 200 && /application\/pdf/.test(r.type), r.type);
  // 5. Delete.
  r = await call("DELETE", `/tasks/files/${pdf}`, "thief-tok");
  check("another agent can't delete it", r.status === 404 && taskFiles(AGENT).length === 2, `HTTP ${r.status}`);
  r = await call("DELETE", `/tasks/files/${pdf}`, "agent-tok");
  check("uploader deletes it", r.status === 200 && taskFiles(AGENT).length === 1, `HTTP ${r.status} ${taskFiles(AGENT)}`);
  r = await call("DELETE", `/tasks/files/${VAULT_FILE}`, "owner-tok");
  check("Vault files can't be deleted through this route", r.status === 404 && nodes.has(VAULT_FILE), `HTTP ${r.status}`);
  check("server logged the uploads", /\[taskfiles\] upload/.test(s.log()));
  s.p.kill();
  [euph, sb, pc, jwks].forEach((x) => x.close());
  console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
