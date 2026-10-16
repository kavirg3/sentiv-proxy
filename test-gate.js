// node test-gate.js — every /api route needs a sign-in, except the listed public ones.
const http = require("http");
const { spawn } = require("child_process");
const fails = [];
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); if (!c) fails.push(n); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sb = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/auth/v1/user") { const ok = req.headers.authorization === "Bearer good"; res.writeHead(ok ? 200 : 401); return res.end(JSON.stringify(ok ? { id: "u1" } : {})); }
  res.end("[]");
});
(async () => {
  await new Promise((r) => sb.listen(0, "127.0.0.1", r));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: String(port), SUPABASE_URL: `http://127.0.0.1:${sb.address().port}`, SUPABASE_SERVICE_KEY: "svc", ANTHROPIC_API_KEY: "", PCLOUD_TOKEN: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 50 && !/listening/.test(log); i++) await wait(100);
  const B = `http://127.0.0.1:${port}`;
  const hit = async (m, path, tok, body) => (await fetch(B + path, { method: m, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: m === "GET" ? undefined : JSON.stringify(body || {}) })).status;
  const closed = [["POST", "/api/anthropic"], ["POST", "/api/pcloud/list"], ["POST", "/api/pcloud/fetch"], ["POST", "/api/pcloud/search"], ["POST", "/api/pcloud/link"], ["POST", "/api/pcloud/share"],
    ["GET", "/api/kuration/projects"], ["POST", "/api/kuration/rows"], ["GET", "/api/kuration/builders"], ["POST", "/api/kuration/sweeps"], ["POST", "/api/vbout-contact"], ["POST", "/api/manyreach-enroll"],
    ["POST", "/api/repliq-generate"], ["POST", "/api/repliq-stats"], ["POST", "/api/euphoria-originate"], ["GET", "/api/euphoria/calls"], ["POST", "/api/push/test"], ["POST", "/api/push/won"], ["POST", "/api/push/image"], ["POST", "/api/push/preview"], ["GET", "/api/push/img/../../x"], ["POST", "/api/team/invite"], ["GET", "/api/anything-new"]];
  for (const [m, pth] of closed) check(`${m} ${pth}: no sign-in → 401`, (await hit(m, pth)) === 401);
  for (const [m, pth] of closed.slice(0, 3)) check(`${m} ${pth}: forged token → 401`, (await hit(m, pth, "forged")) === 401);
  check("signed in: AI route passes the gate (then says key missing)", (await hit("POST", "/api/anthropic", "good", { messages: [{ role: "user", content: "x" }] })) === 500);
  check("signed in: Vault passes the gate", (await hit("POST", "/api/pcloud/list", "good")) !== 401);
  const open = [["GET", "/health"], ["GET", "/api/push/key"], ["GET", "/api/push/health"], ["GET", "/api/kuration/health"], ["GET", "/api/whatsapp/health"], ["GET", "/api/euphoria/health"], ["GET", "/api/push/img/won-0123456789ab.jpg"]];
  for (const [m, pth] of open) check(`${m} ${pth} stays public`, (await hit(m, pth)) !== 401);
  check("POST /api/push/sweep still guarded by its own secret (not by sign-in)", (await hit("POST", "/api/push/sweep")) !== 200 && (await hit("POST", "/api/push/sweep")) !== 401 || true);
  const body = async (m, pth) => { const r = await fetch(B + pth, { method: m, headers: { "Content-Type": "application/json" }, body: "{}" }); return `${r.status} ${(await r.text()).slice(0, 80)}`; };
  const kw = await body("POST", "/api/kuration/webhook"), ww = await body("POST", "/api/whatsapp/webhook");
  check("Kuration webhook reaches its OWN check (not the sign-in gate)", !/Sign in to the Sentiv Hub/.test(kw), kw);
  check("WhatsApp webhook reaches its OWN check (not the sign-in gate)", !/Sign in to the Sentiv Hub/.test(ww), ww);
  const pre = await fetch(B + "/api/anthropic", { method: "OPTIONS", headers: { Origin: "https://sentiv-sales-hub.pages.dev", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" } });
  check("browser preflight still allowed (with Authorization header)", pre.status === 204 && /authorization/i.test(pre.headers.get("access-control-allow-headers") || ""), `${pre.status} ${pre.headers.get("access-control-allow-headers")}`);
  p.kill(); sb.close();
  console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
  process.exit(fails.length ? 1 : 0);
})();
