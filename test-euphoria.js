// node test-euphoria.js — drives the real proxy against a fake Euphoria and a fake Supabase.
const http = require("http");
const { spawn } = require("child_process");

const fails = [];
const check = (name, cond, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); if (!cond) fails.push(name); };

const seen = [];
const euph = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    seen.push({ ct: req.headers["content-type"], body: b });
    res.writeHead(200, { "Content-Type": "text/xml" });
    if (!b.includes("<Auth>good-key</Auth>")) return res.end("<?xml version='1.0' encoding='UTF-8'?><XML><Status>Failed</Status><Error>Authorization Failed</Error></XML>");
    if (b.includes("<ActionName>DoNothing</ActionName>")) return res.end("<?xml version='1.0'?><XML><Response>Nothing Done</Response></XML>");
    const ext = (b.match(/<extension>(.*?)<\/extension>/) || [])[1];
    const to = (b.match(/<dialNumber>(.*?)<\/dialNumber>/) || [])[1];
    res.end(`<?xml version='1.0'?><XML><Response>Originate ${ext} to ${to} with crmTag x</Response></XML>`);
  });
});
let ASSIGNED = null;   // team_settings.data.phoneExts, when a scenario sets it
const sb = http.createServer((req, res) => {
  if (req.url.startsWith("/rest/v1/team_settings")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(ASSIGNED ? [{ data: { phoneExts: ASSIGNED } }] : [{ data: {} }])); }
  if (req.url.startsWith("/rest/v1/user_state")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end("[]"); }
  const ok = req.url === "/auth/v1/user" && req.headers.authorization === "Bearer user-token" && req.headers.apikey === "service";
  res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
  res.end(JSON.stringify(ok ? { id: "6664924a-0ce3-4125-8343-b6c9183e3549" } : { msg: "bad jwt" }));
});

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(port, env) {
  const p = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 50 && !/listening/.test(log); i++) await wait(100);
  return { p, log: () => log };
}

(async () => {
  const ep = await listen(euph), sp = await listen(sb);
  const base = { EUPHORIA_API_URL: `http://127.0.0.1:${ep}/api`, SUPABASE_URL: `http://127.0.0.1:${sp}`, SUPABASE_SERVICE_KEY: "service" };
  const post = (port, body, token) => fetch(`http://127.0.0.1:${port}/api/euphoria-originate`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  // 1. Not configured
  {
    const s = await boot(4811, base);
    const r = await post(4811, {});
    check("no key: diagnostics probe gets 500 not configured", r.status === 500 && /not configured/.test(r.body.error), JSON.stringify(r));
    const h = await (await fetch("http://127.0.0.1:4811/api/euphoria/health")).json();
    check("no key: health says not configured", h.ok === false && h.key === false && h.auth === "not configured");
    s.p.kill();
  }
  // 2. Configured with the right key
  const s = await boot(4812, { ...base, EUPHORIA_API_KEY: "good-key", EUPHORIA_TENANT: "sentiv" });
  let r = await post(4812, {});
  check("diagnostics probe ({} no token) gets 400 missing", r.status === 400 && /missing/.test(r.body.error));
  r = await post(4812, { extension: "108", number: "0825550111" });
  check("no sign-in: refused 401, nothing sent to Euphoria", r.status === 401 && !seen.some((x) => x.body.includes("Originate")), JSON.stringify(r));
  r = await post(4812, { extension: "108", number: "0825550111" }, "stolen-token");
  check("bad token: refused 401", r.status === 401);
  r = await post(4812, { extension: "108", number: "+27 82 555 0111", company: "Acme <&> Ltd" }, "user-token");
  check("signed in: call placed", r.status === 200 && r.body.ok === true, JSON.stringify(r));
  const last = seen[seen.length - 1] || { body: "" };
  check("Euphoria gets XML, not JSON", /text\/xml/.test(last.ct) && last.body.startsWith("<?xml") && last.body.includes("<ActionName>Originate</ActionName>"), last.ct);
  check("tenant + key in the Tenant block", last.body.includes("<Tenant><Name>sentiv</Name><Auth>good-key</Auth></Tenant>"));
  check("extension sent as 108-sentiv", last.body.includes("<extension>108-sentiv</extension>"));
  check("+27 number normalised to 0825550111", last.body.includes("<dialNumber>0825550111</dialNumber>"));
  check("company name XML-escaped", last.body.includes("<crmTag>Acme &lt;&amp;&gt; Ltd</crmTag>"));
  const n0 = seen.length;
  r = await post(4812, { extension: "108-Sentiv", number: "011 555 0100" }, "user-token");
  check("108-Sentiv form accepted, landline dialled", r.status === 200 && seen[seen.length - 1].body.includes("<extension>108-sentiv</extension><dialNumber>0115550100</dialNumber>"));
  r = await post(4812, { extension: "108", number: "+44 20 7946 0000" }, "user-token");
  check("international number refused", r.status === 400 && /South African/.test(r.body.error));
  r = await post(4812, { extension: "108", number: "0900123456" }, "user-token");
  check("09x premium-rate refused", r.status === 400);
  r = await post(4812, { extension: "200-othertenant", number: "0825550111" }, "user-token");
  check("another tenant's extension refused", r.status === 400 && /isn't an extension/.test(r.body.error));
  r = await post(4812, { extension: "108; DROP", number: "0825550111" }, "user-token");
  check("junk extension refused", r.status === 400);
  check("none of the refused calls reached Euphoria", seen.length === n0 + 1, `${seen.length - n0} sent`);
  // rate limit: 2 placed so far this minute, cap 6
  for (let i = 0; i < 4; i++) await post(4812, { extension: "108", number: "0825550111" }, "user-token");
  r = await post(4812, { extension: "108", number: "0825550111" }, "user-token");
  check("7th call in a minute is refused 429", r.status === 429, JSON.stringify(r));
  const h = await (await fetch("http://127.0.0.1:4812/api/euphoria/health")).json();
  check("health: key accepted by Euphoria (DoNothing)", h.ok === true && h.auth === "accepted", JSON.stringify(h));
  check("log never prints the full number", !/0825550111/.test(s.log()) && /to=\*\*\*111/.test(s.log()));
  s.p.kill();
  // 3. Wrong key
  {
    const s3 = await boot(4813, { ...base, EUPHORIA_API_KEY: "wrong", EUPHORIA_TENANT: "sentiv" });
    const h3 = await (await fetch("http://127.0.0.1:4813/api/euphoria/health")).json();
    check("wrong key: health shows Euphoria's own error", h3.ok === false && h3.auth === "Authorization Failed", JSON.stringify(h3));
    const r3 = await post(4813, { extension: "108", number: "0825550111" }, "user-token");
    check("wrong key: call returns 502 with the reason", r3.status === 502 && /Authorization Failed/.test(r3.body.error));
    s3.p.kill();
  }
  // 4. Old variable name still works
  {
    const s4 = await boot(4814, { ...base, EUPHORIA_API_KEY: "good-key", EUPHORIA_ORG_ID: "sentiv" });
    const h4 = await (await fetch("http://127.0.0.1:4814/api/euphoria/health")).json();
    check("EUPHORIA_ORG_ID accepted as the tenant", h4.ok === true);
    s4.p.kill();
  }
  {
    const s5 = await boot(4815, { ...base, EUPHORIA_API_KEY: "good-key", EUPHORIA_TENANT: "100-sentiv" });
    const h5 = await (await fetch("http://127.0.0.1:4815/api/euphoria/health")).json();
    check("a whole SIP username is read as the tenant", h5.tenantName === "sentiv", JSON.stringify(h5));
    s5.p.kill();
  }
  // 6. The owner has assigned extensions: a call may only ring the caller's own.
  {
    ASSIGNED = { "6664924a-0ce3-4125-8343-b6c9183e3549": "100", "someone-else": "101" };
    const s6 = await boot(4816, { ...base, EUPHORIA_API_KEY: "good-key", EUPHORIA_TENANT: "FutureLifeTech" });
    let r6 = await post(4816, { extension: "101", number: "0825550111" }, "user-token");
    check("assigned: ringing a colleague's extension is refused", r6.status === 403 && /Your extension is 100/.test(r6.body.error), JSON.stringify(r6));
    r6 = await post(4816, { extension: "100", number: "0825550111" }, "user-token");
    check("assigned: ringing your own extension works", r6.status === 200, JSON.stringify(r6));
    s6.p.kill();
    ASSIGNED = { "someone-else": "101" };
    const s7 = await boot(4817, { ...base, EUPHORIA_API_KEY: "good-key", EUPHORIA_TENANT: "FutureLifeTech" });
    const r7 = await post(4817, { extension: "100", number: "0825550111" }, "user-token");
    check("assigned to others but not you: refused with a plain reason", r7.status === 403 && /ask the owner/.test(r7.body.error), JSON.stringify(r7));
    s7.p.kill();
    ASSIGNED = null;
  }
  euph.close(); sb.close();
  console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
  process.exit(fails.length ? 1 : 0);
})();
