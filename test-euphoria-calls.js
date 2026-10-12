// node test-euphoria-calls.js — call log, recordings and transcription against fakes of
// Euphoria, Supabase and AssemblyAI. Needs a small WAV at ../test.wav (any PCM WAV).
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

const rec = (o) => `<Record><uID>${o.id}</uID><StartTime>${o.t}</StartTime><Duration>${o.d}</Duration><CallerID>${o.cid || "Kavir &lt;100&gt;"}</CallerID><Destination>${o.dst}</Destination><Source>${o.src}</Source><Status>${o.st || "ANSWERED"}</Status><ChannelID>${o.ch}</ChannelID><UniqueID>pbx-${o.id}</UniqueID><DestChannel>${o.dch || ""}</DestChannel><Recorded>${o.rec ? 1 : 0}</Recorded><RecordingFilename>${o.rec ? "pbx-" + o.id + ".WAV" : ""}</RecordingFilename></Record>`;
const CDRS = [
  { id: 501, t: "2026-10-12 09:40:00", d: 252, src: "100", dst: "0825550111", ch: "PJSIP/100-FutureLifeTech-0000002a", dch: "PJSIP/GW3-0000002b", rec: true },           // Kavir out, answered, recorded
  { id: 502, t: "2026-10-12 10:05:10", d: 0, src: "100", dst: "011 555 0100", ch: "PJSIP/100-FutureLifeTech-0000003a", dch: "PJSIP/GW3-0000003b", st: "NO ANSWER" },   // Kavir out, no answer
  { id: 503, t: "2026-10-12 11:00:00", d: 95, src: "+27725550199", dst: "0105934500", ch: "PJSIP/GW3-0000004a", dch: "PJSIP/101-FutureLifeTech-0000004b", rec: true }, // inbound to Faraad (101)
  { id: 504, t: "2026-10-12 11:30:00", d: 30, src: "100", dst: "101", ch: "PJSIP/100-FutureLifeTech-0000005a", dch: "PJSIP/101-FutureLifeTech-0000005b" },              // internal — dropped
  { id: 505, t: "2026-10-12 12:00:00", d: 40, src: "102", dst: "0835550000", ch: "PJSIP/102-FutureLifeTech-0000006a", dch: "PJSIP/GW3", st: "FAILED" },              // ext 102 (claimed twice → unassigned)
];
const seen = [];
const euph = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    seen.push(b);
    const act = (b.match(/<ActionName>(.*?)<\/ActionName>/) || [])[1];
    const f = (n) => (b.match(new RegExp(`<${n}>(.*?)</${n}>`)) || [])[1];
    res.writeHead(200, { "Content-Type": "text/xml" });
    if (!b.includes("<Auth>good-key</Auth>")) return res.end("<?xml version='1.0'?><XML><Status>Failed</Status><Error>Authorization Failed</Error></XML>");
    if (act === "GetCallDetailRecords") {
      const ext = f("extension");
      const list = CDRS.filter((c) => !ext || c.ch.includes(`/${ext}-`) || (c.dch || "").includes(`/${ext}-`));
      return res.end(`<?xml version='1.0'?><XML><Records>${list.map(rec).join("")}</Records><Total>${list.length}</Total></XML>`);
    }
    if (act === "GetCdrDetails") { const c = CDRS.find((x) => String(x.id) === f("CdrID")); return res.end(c ? `<?xml version='1.0'?><XML>${rec(c).replace(/<\/?Record>/g, "")}</XML>` : "<XML><Error>Not found</Error></XML>"); }
    if (act === "DownloadCallRecordingByCdrID") return res.end(`<?xml version='1.0'?><XML><fileName>x.WAV</fileName><audioData>${WAV.toString("base64")}</audioData></XML>`);
    res.end("<XML><Response>ok</Response></XML>");
  });
});
// user_state: Kavir 100, Faraad 101, two people both claim 102
const sb = http.createServer((req, res) => {
  const tok = (req.headers.authorization || "").replace("Bearer ", "");
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/auth/v1/user") { const id = TOKENS[tok]; res.writeHead(id ? 200 : 401); return res.end(JSON.stringify(id ? { id } : {})); }
  if (tok !== "service") { res.writeHead(401); return res.end("[]"); }
  if (req.url.startsWith("/rest/v1/user_state")) return res.end(JSON.stringify([
    { agent_id: OWNER, data: { v: "100", at: 1, id: "euphoriaExt" } },
    { agent_id: AGENT, data: { v: "101-FutureLifeTech", at: 1, id: "euphoriaExt" } },
    { agent_id: THIEF, data: { v: "102", at: 1 } }, { agent_id: "x2", data: { v: "102", at: 1 } },
  ]));
  if (req.url.startsWith("/rest/v1/profiles")) { const id = decodeURIComponent((req.url.match(/id=eq\.([^&]+)/) || [])[1] || ""); return res.end(JSON.stringify([{ role: id === OWNER ? "owner" : "agent" }])); }
  res.end("[]");
});
let aaiPolls = 0; const aaiSeen = [];
const aai = http.createServer((req, res) => {
  let chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
    const body = Buffer.concat(chunks);
    aaiSeen.push({ url: req.url, auth: req.headers.authorization, len: body.length, head: body.slice(0, 4).toString("latin1"), json: req.headers["content-type"] === "application/json" ? JSON.parse(body.toString()) : null });
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "aai-key") { res.writeHead(401); return res.end(JSON.stringify({ error: "bad key" })); }
    if (req.url === "/v2/upload") return res.end(JSON.stringify({ upload_url: "https://cdn.example/abc" }));
    if (req.url === "/v2/transcript") return res.end(JSON.stringify({ id: "job123", status: "queued" }));
    if (req.url === "/v2/transcript/job123") { aaiPolls++; return res.end(JSON.stringify(aaiPolls < 2 ? { status: "processing" } : { status: "completed", text: "Hello, it's Kavir from Sentiv. Yes we need radios for 40 guards.", utterances: [{ speaker: "A", start: 0, end: 2000, text: "Hello, it's Kavir from Sentiv." }, { speaker: "B", start: 2100, end: 5000, text: "Yes we need radios for 40 guards." }] })); }
    res.writeHead(404); res.end("{}");
  });
});

async function boot(port, env) {
  const p = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 50 && !/listening/.test(log); i++) await wait(100);
  return { p, log: () => log };
}

(async () => {
  const ep = await listen(euph), sp = await listen(sb), ap = await listen(aai);
  const env = { EUPHORIA_API_URL: `http://127.0.0.1:${ep}/api`, SUPABASE_URL: `http://127.0.0.1:${sp}`, SUPABASE_SERVICE_KEY: "service", EUPHORIA_API_KEY: "good-key", EUPHORIA_TENANT: "FutureLifeTech", ASSEMBLYAI_BASE_URL: `http://127.0.0.1:${ap}`, ASSEMBLYAI_API_KEY: "aai-key" };
  const s = await boot(4821, env);
  const B = "http://127.0.0.1:4821/api/euphoria";
  const get = async (u, tok) => { const r = await fetch(B + u, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} }); const ct = r.headers.get("content-type") || ""; return { status: r.status, ct, body: /json/.test(ct) ? await r.json() : Buffer.from(await r.arrayBuffer()) }; };
  const post = async (u, tok) => { const r = await fetch(B + u, { method: "POST", headers: tok ? { Authorization: `Bearer ${tok}` } : {} }); return { status: r.status, body: await r.json() }; };

  let r = await get("/calls?days=3");
  check("calls: no sign-in → 401", r.status === 401);
  r = await get("/calls?days=3", "agent-tok");
  check("agent sees only calls on their own extension (101)", r.status === 200 && r.body.calls.length === 1 && r.body.calls[0].id === "503" && r.body.ext === "101", JSON.stringify(r.body).slice(0, 300));
  const c503 = r.body.calls[0] || {};
  check("inbound call shaped: dir in, other = caller, SAST time", c503.dir === "in" && c503.other === "0725550199" && c503.at === "2026-10-12T09:00:00.000Z" && c503.seconds === 95 && c503.recorded === true && c503.answered === true, JSON.stringify(c503));
  check("Euphoria was asked for that extension only", seen.some((b) => b.includes("<ActionName>GetCallDetailRecords</ActionName>") && b.includes("<extension>101</extension>")));
  r = await get("/calls?days=3", "owner-tok");
  const ids = (r.body.calls || []).map((c) => c.id).sort();
  check("owner sees every external call, internal one dropped", JSON.stringify(ids) === JSON.stringify(["501", "502", "503", "505"]), ids.join(","));
  const by = Object.fromEntries((r.body.calls || []).map((c) => [c.id, c]));
  check("owner: each call tagged with its agent", by["501"] && by["501"].agentId === OWNER && by["503"].agentId === AGENT, JSON.stringify(by["501"]));
  check("a doubly-claimed extension belongs to nobody", by["505"] && by["505"].agentId === null && by["505"].status === "FAILED" && by["505"].answered === false);
  check("outbound shaped: dir out, number normalised", by["502"] && by["502"].dir === "out" && by["502"].other === "0115550100" && by["502"].answered === false);
  check("a call whose Status is FAILED doesn't fail the whole list", r.status === 200);
  check("owner reply says transcription is on", r.body.stt === true);
  r = await get("/calls?days=3&mine=1", "owner-tok");
  check("owner mine=1 → only extension 100", (r.body.calls || []).map((c) => c.id).sort().join(",") === "501,502");
  r = await get("/calls?days=3", "thief-tok");
  check("someone whose extension is contested gets nothing", r.status === 200 && r.body.calls.length === 0 && r.body.needsExtension === true);

  r = await get("/recording/501", "agent-tok");
  check("agent cannot play another agent's recording", r.status === 404);
  r = await get("/recording/503", "agent-tok");
  check("agent plays their own recording as MP3", r.status === 200 && /audio\/mpeg/.test(r.ct) && r.body.length > 1000 && (r.body.slice(0, 3).toString("latin1") === "ID3" || r.body[0] === 0xff), `${r.ct} ${r.body.length}`);
  r = await get("/recording/501", "owner-tok");
  check("owner can play any recording", r.status === 200 && /audio/.test(r.ct));
  r = await get("/recording/502", "owner-tok");
  check("unrecorded call → 404", r.status === 404 && /wasn't recorded/.test(r.body.error));
  r = await get("/recording/abc", "owner-tok");
  check("junk id → 404, never sent to Euphoria", r.status === 404);

  r = await post("/transcribe/501", "agent-tok");
  check("agent cannot transcribe someone else's call", r.status === 404);
  r = await post("/transcribe/503", "agent-tok");
  check("transcription starts, returns a job", r.status === 200 && r.body.job === "job123", JSON.stringify(r.body));
  const up = aaiSeen.find((x) => x.url === "/v2/upload");
  check("audio uploaded to AssemblyAI as MP3 with the key", up && up.auth === "aai-key" && up.len > 1000 && (up.head.startsWith("ID3") || up.head.charCodeAt(0) === 0xff));
  const start = aaiSeen.find((x) => x.url === "/v2/transcript");
  check("speaker labels requested, English", start && start.json && start.json.speaker_labels === true && start.json.language_code === "en");
  r = await get("/transcribe/job/job123", "owner-tok");
  check("someone else can't read the job", r.status === 404);
  r = await get("/transcribe/job/job123", "agent-tok");
  check("first poll: processing", r.body.status === "processing");
  r = await get("/transcribe/job/job123", "agent-tok");
  check("second poll: transcript with speakers", r.body.status === "completed" && r.body.utterances.length === 2 && r.body.utterances[1].speaker === "B" && /40 guards/.test(r.body.text), JSON.stringify(r.body).slice(0, 200));
  r = await (await fetch(B + "/health")).json();
  check("health reports transcription on", r.stt === true && r.ok === true, JSON.stringify(r));
  check("logs never contain a full phone number", !/0725550199|0825550111/.test(s.log()));
  s.p.kill();

  const s2 = await boot(4822, { ...env, ASSEMBLYAI_API_KEY: "" });
  const r2 = await fetch("http://127.0.0.1:4822/api/euphoria/transcribe/503", { method: "POST", headers: { Authorization: "Bearer agent-tok" } });
  check("no AssemblyAI key → 501 with a plain reason", r2.status === 501);
  s2.p.kill();

  euph.close(); sb.close(); aai.close();
  console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
  process.exit(fails.length ? 1 : 0);
})();
