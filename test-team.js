// node test-team.js — owner invites against a fake Supabase.
const http = require("http");
const { spawn } = require("child_process");
const fails = [];
const check = (name, cond, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); if (!cond) fails.push(name); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const OWNER = "o-1", AGENT = "a-1";
const TOK = { "owner-tok": OWNER, "agent-tok": AGENT };
const EXISTING = new Set(["faraad.shaik@sentiv.com"]);
const seen = [];
const sb = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const body = b ? JSON.parse(b) : null;
    seen.push({ m: req.method, u: req.url, body, auth: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/auth/v1/user") { const id = TOK[(req.headers.authorization || "").replace("Bearer ", "")]; res.writeHead(id ? 200 : 401); return res.end(JSON.stringify(id ? { id } : {})); }
    if (req.headers.authorization !== "Bearer service") { res.writeHead(401); return res.end("{}"); }
    if (req.url.startsWith("/rest/v1/profiles?id=eq.") && req.method === "GET") { const id = decodeURIComponent(req.url.match(/eq\.([^&]+)/)[1]); return res.end(JSON.stringify([{ role: id === OWNER ? "owner" : "agent" }])); }
    if (req.url.startsWith("/rest/v1/profiles?id=eq.") && req.method === "PATCH") { res.writeHead(204); return res.end(); }
    if (req.url === "/auth/v1/admin/generate_link") {
      if (body.type === "invite" && EXISTING.has(body.email)) { res.writeHead(422); return res.end(JSON.stringify({ code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" })); }
      return res.end(JSON.stringify({ id: "new-" + body.email, email: body.email, action_link: "https://x/verify?token=abc", hashed_token: "hash_" + body.type, verification_type: body.type, redirect_to: body.redirect_to }));
    }
    res.writeHead(404); res.end("{}");
  });
});
(async () => {
  const sp = await listen(sb);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: String(port), SUPABASE_URL: `http://127.0.0.1:${sp}`, SUPABASE_SERVICE_KEY: "service", PUSH_APP_URL: "https://sentiv-sales-hub.pages.dev" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 50 && !/listening/.test(log); i++) await wait(100);
  const inv = async (tok, body) => { const r = await fetch(`http://127.0.0.1:${port}/api/team/invite`, { method: "POST", headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  let r = await inv(null, { email: "x@y.co.za" });
  check("no sign-in → 401", r.status === 401);
  r = await inv("agent-tok", { email: "x@y.co.za" });
  check("an agent can't invite", r.status === 403);
  r = await inv("owner-tok", { email: "not-an-email" });
  check("bad email refused", r.status === 400);
  r = await inv("owner-tok", { email: "Lindiwe.N@Sentiv.com ", name: "Lindiwe Nkosi", role: "setter" });
  check("new person: an invite link to the Hub, not to Supabase", r.status === 200 && r.body.type === "invite" && r.body.link === "https://sentiv-sales-hub.pages.dev/?join=hash_invite&jt=invite", JSON.stringify(r.body));
  const gl = seen.find((x) => x.u === "/auth/v1/admin/generate_link" && x.body.email === "lindiwe.n@sentiv.com");
  check("Supabase asked for a token only (generate_link), email lower-cased, name passed", gl && gl.body.type === "invite" && gl.body.data.full_name === "Lindiwe Nkosi");
  check("Supabase's own invite email is NOT used", !seen.some((x) => /\/auth\/v1\/invite/.test(x.u)));
  const pt = seen.find((x) => x.m === "PATCH" && x.u.includes("new-lindiwe.n%40sentiv.com"));
  check("new account named and made a setter", pt && pt.body.full_name === "Lindiwe Nkosi" && pt.body.role === "setter", JSON.stringify(pt && pt.body));
  r = await inv("owner-tok", { email: "faraad.shaik@sentiv.com", name: "Faraad" });
  check("existing person: falls back to a set-password link", r.status === 200 && r.body.type === "recovery" && r.body.existing === true && /jt=recovery$/.test(r.body.link), JSON.stringify(r.body));
  check("existing person's profile is not touched", !seen.some((x) => x.m === "PATCH" && /faraad/.test(x.u)));
  r = await inv("owner-tok", { email: "agent2@sentiv.com", role: "owner" });
  check("role can only be agent or setter — 'owner' becomes agent", r.status === 200 && !seen.some((x) => x.m === "PATCH" && /agent2/.test(x.u) && x.body.role));
  check("log hides the address", /l\*\*\*@sentiv\.com/.test(log) && !/lindiwe\.n@/.test(log));
  p.kill(); sb.close();
  console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
  process.exit(fails.length ? 1 : 0);
})();
