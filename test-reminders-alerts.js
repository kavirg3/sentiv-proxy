// node test-reminders-alerts.js — personal reminders + the platform watchdog (Hub v239).
// Runs push-routes in-process against a fake Supabase and a fake GitHub signing key, with
// web-push stubbed, so every notification that WOULD go out is captured and checked.
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const fails = [];
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); if (!c) fails.push(n); };

const OWNER = "00000000-0000-0000-0000-00000000000a", AGENT = "00000000-0000-0000-0000-00000000000b";
const db = {
  profiles: [{ id: OWNER, role: "owner" }, { id: AGENT, role: "agent" }],
  subs: { [OWNER]: [{ endpoint: "https://push.example/o", p256dh: "x", auth: "y" }], [AGENT]: [{ endpoint: "https://push.example/a", p256dh: "x", auth: "y" }] },
  userState: [],
  pushLog: [],
  settings: { pushTemplates: null },
};
const sbServer = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const json = (code, v) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
  if (u.pathname === "/auth/v1/user") {
    const t = (req.headers.authorization || "").replace("Bearer ", "");
    return t === "owner" ? json(200, { id: OWNER }) : t === "agent" ? json(200, { id: AGENT }) : json(401, {});
  }
  const tbl = u.pathname.replace("/rest/v1/", "");
  const q = u.searchParams;
  if (tbl === "profiles") {
    let rows = db.profiles;
    if (q.get("role")) rows = rows.filter((p) => p.role === q.get("role").replace("eq.", ""));
    return json(200, rows);
  }
  if (tbl === "push_subscriptions") return json(200, db.subs[(q.get("user_id") || "").replace("eq.", "")] || []);
  if (tbl === "team_settings") return json(200, [{ pushTemplates: db.settings.pushTemplates, agentPhones: {} }]);
  if (tbl === "user_state") return json(200, db.userState.filter((r) => r.id === (q.get("id") || "").replace("eq.", "")).map((r) => ({ agent_id: r.agent_id, data: r.data })));
  if (tbl === "push_log") {
    if (req.method === "POST") {
      const add = JSON.parse(raw.toString()).filter((r) => !db.pushLog.some((x) => x.lead_id === r.lead_id && x.kind === r.kind && x.sent_on === r.sent_on));
      db.pushLog.push(...add);
      return json(201, add);
    }
    return json(200, db.pushLog);
  }
  json(404, { error: "fake: " + tbl });
});

// ---- fake GitHub OIDC: a signing key, its JWKS, and a token minter ----
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const jwksServer = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ keys: [jwk] })); });
const mint = (over = {}) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: "RS256", kid: "k1", typ: "JWT" });
  const p = b64({ iss: "https://token.actions.githubusercontent.com", aud: "sentiv-proxy-archive", repository: "kavirg3/sentiv-proxy", ref: "refs/heads/main", event_name: "schedule", iat: now, exp: now + 300, ...over });
  return `${h}.${p}.${crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
};

(async () => {
  await new Promise((r) => sbServer.listen(0, "127.0.0.1", r));
  await new Promise((r) => jwksServer.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    SUPABASE_URL: `http://127.0.0.1:${sbServer.address().port}`, SUPABASE_SERVICE_KEY: "svc",
    VAPID_PUBLIC_KEY: "BInuO5Jvd7QTVc2rT01sGp1Pjr4C68ru0xb9q0GG5e0nadT7y5DxUAtkTdXrMPCyN9w4Q1KqSTGVOQlV1nSsDG0",
    VAPID_PRIVATE_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", VAPID_SUBJECT: "mailto:test@example.com",
    PUSH_LOOPS_OFF: "1", GITHUB_OIDC_JWKS_URL: `http://127.0.0.1:${jwksServer.address().port}/jwks`,
  });
  const webpush = require("web-push");
  webpush.setVapidDetails = () => {};
  const sent = [];
  webpush.sendNotification = async (sub, body, opts) => { sent.push({ to: sub.endpoint, p: JSON.parse(body), opts }); return {}; };
  const push = require("./push-routes");
  const { createWatchdog } = require("./watchdog");
  const due = push._remindersDue;

  // ---- reminders: when they fire (SAST; 16 Oct 2026 is a Friday) ----
  const at = (iso) => Date.parse(iso);              // pass UTC; SAST = UTC+2
  const NINE = at("2026-10-16T07:00:00Z");           // Fri 09:00 SAST
  const base = { id: "r1abc", text: "Call Sipho", time: "09:00", date: "2026-10-16", repeat: "once", created: at("2026-10-15T08:00:00Z") };
  check("once: fires at its time", due([base], NINE).length === 1);
  check("once: not a minute early", due([base], NINE - 60e3).length === 0);
  check("once: still goes out if the server was down for a while (2h late)", due([base], NINE + 2 * 3600e3).length === 1);
  check("once: skipped once 6+ hours stale", due([base], NINE + 7 * 3600e3).length === 0);
  check("once: not on another day", due([base], NINE + 864e5).length === 0);
  check("off: never fires", due([{ ...base, off: true }], NINE).length === 0);
  check("set after its time today: waits (no instant buzz)", due([{ ...base, created: NINE + 3600e3 }], NINE + 2 * 3600e3).length === 0);
  check("time is SAST, not UTC (09:00 SAST ≠ 09:00 UTC)", due([base], at("2026-10-16T09:00:00Z")).length === 1 && due([base], at("2026-10-16T06:59:00Z")).length === 0);
  const daily = { ...base, repeat: "daily" };
  check("daily: fires the next day too", due([daily], NINE + 864e5).length === 1);
  check("daily: not before its start date", due([daily], NINE - 864e5).length === 0);
  const wd = { ...base, repeat: "weekdays" };
  check("weekdays: Friday yes", due([wd], NINE).length === 1);
  check("weekdays: Saturday no", due([wd], NINE + 864e5).length === 0);
  check("weekdays: Monday yes", due([wd], NINE + 3 * 864e5).length === 1);
  const wk = { ...base, repeat: "weekly" };
  check("weekly: same weekday next week", due([wk], NINE + 7 * 864e5).length === 1);
  check("weekly: not the day after", due([wk], NINE + 864e5).length === 0);
  check("junk is ignored, not thrown", due([null, {}, { id: "x" }, { ...base, id: "../bad" }, { ...base, time: "25:00" }, { ...base, text: "  " }], NINE).length === 0);
  check("not a list → nothing", due("nope", NINE).length === 0 && due(undefined, NINE).length === 0);

  // ---- reminders: the sweep ----
  db.userState = [
    { agent_id: AGENT, id: "reminders", data: { id: "reminders", v: [base, { ...base, id: "r2abc", text: "Later", time: "15:00" }] } },
    { agent_id: OWNER, id: "reminders", data: { id: "reminders", v: [{ ...daily, id: "r3abc", text: "Check the pipeline" }] } },
  ];
  sent.length = 0;
  let r = await push._remindSweep(NINE + 5 * 60e3);
  check("sweep: two due reminders sent", r.due === 2 && r.sent === 2, JSON.stringify(r));
  const toAgent = sent.find((s) => s.to === "https://push.example/a");
  check("sweep: each person's reminder goes to THEIR devices only", !!toAgent && toAgent.p.body === "Call Sipho" && sent.find((s) => s.to === "https://push.example/o").p.body === "Check the pipeline");
  check("sweep: title 'Reminder', stays on screen, Open Hub + Done", toAgent.p.title === "Reminder" && toAgent.p.sticky === true && JSON.stringify(toAgent.p.actions.map((a) => a.title)) === '["Open Hub","Done"]');
  check("sweep: sent as high urgency", toAgent.opts && toAgent.opts.urgency === "high");
  sent.length = 0;
  r = await push._remindSweep(NINE + 6 * 60e3);
  check("sweep: the next minute does NOT send it again", sent.length === 0 && r.sent === 0, JSON.stringify(r));
  db.settings.pushTemplates = { remind: { title: "⏰ {text}", body: "Set for {time}" } };
  db.pushLog = [];
  sent.length = 0;
  await push._remindSweep(NINE + 7 * 60e3);
  check("sweep: owner's wording is used", sent.length === 2 && sent.some((s) => s.p.title === "⏰ Call Sipho" && s.p.body === "Set for 09:00"), JSON.stringify(sent.map((s) => s.p.title + " / " + s.p.body)));

  // ---- watchdog: when it buzzes ----
  let clock = 0;
  const calls = [];
  const w = createWatchdog({ notify: async (ev) => calls.push(JSON.parse(JSON.stringify(ev))), now: () => clock });
  const flaky = { ok: false, detail: "HTTP 503" };
  let result = flaky;
  const checks = [{ name: "db", label: "The database isn't answering", run: async () => result }, { name: "hub", label: "Hub down", run: async () => ({ ok: true }) }];
  clock = 1000; await w.run(checks);
  check("watchdog: one failure does NOT buzz", calls.length === 0);
  clock = 301000; await w.run(checks);
  check("watchdog: second failure in a row buzzes once", calls.length === 1 && calls[0].down.length === 1 && calls[0].down[0].label === "The database isn't answering" && calls[0].down[0].since === 1000, JSON.stringify(calls));
  clock = 601000; await w.run(checks);
  check("watchdog: still broken 5 min later — no repeat buzz", calls.length === 1);
  clock = 301000 + 4 * 3600e3; await w.run(checks);
  check("watchdog: still broken after 4 hours — buzzes again, marked 'still'", calls.length === 2 && calls[1].down[0].again === true);
  result = { ok: true };
  clock += 300000; await w.run(checks);
  check("watchdog: recovery sends one 'fixed'", calls.length === 3 && calls[2].fixed.length === 1 && calls[2].fixed[0].label === "The database isn't answering");
  clock += 300000; await w.run(checks);
  check("watchdog: healthy rounds send nothing", calls.length === 3);
  result = flaky; clock += 300000; await w.run(checks); result = { ok: true }; clock += 300000; await w.run(checks);
  check("watchdog: a single blip then OK sends nothing at all", calls.length === 3);
  w.report("gh:x", false, "boom", { label: "GH thing", immediate: true }); await w.flush();
  check("watchdog: an immediate report buzzes on first failure", calls.length === 4 && calls[3].down[0].label === "GH thing");
  const w2 = createWatchdog({ notify: async (ev) => calls.push(ev), now: () => 0 });
  const many = ["a", "b", "c"].map((n) => ({ name: n, label: n, run: async () => ({ ok: false }) }));
  calls.length = 0; await w2.run(many); await w2.run(many);
  check("watchdog: several breaking at once = ONE buzz", calls.length === 1 && calls[0].down.length === 3);
  const slow = createWatchdog({ notify: async (ev) => calls.push(ev), now: () => 0, failAfter: 1 });
  calls.length = 0;
  await slow.run([{ name: "s", label: "slow", run: () => new Promise(() => {}) }], 200);
  check("watchdog: a check that hangs counts as a failure", calls.length === 1 && /no answer/.test(calls[0].down[0].detail));
  check("watchdog: a check that throws counts as a failure", (await slow.run([{ name: "t", label: "throws", run: async () => { throw new Error("x"); } }])).down.length === 1);
  check("watchdog: skip results are ignored", (await slow.run([{ name: "k", label: "k", run: async () => ({ skip: true }) }])).sent === false);

  // ---- what the owner sees ----
  const one = push._alertPayloads({ down: [{ name: "db", label: "The database isn't answering", detail: "supabase 503", since: Date.parse("2026-10-16T07:42:00Z") }], fixed: [] }, {});
  check("alert: title names the problem", one.length === 1 && one[0].title === "Sentiv needs you: The database isn't answering", one[0].title);
  check("alert: text has the detail and SAST time", one[0].body === "supabase 503 · since 09:42", one[0].body);
  check("alert: stays on screen", one[0].sticky === true);
  const sev = push._alertPayloads({ down: [{ label: "A" }, { label: "B" }], fixed: [{ label: "C", downMs: 25 * 60e3 }] }, {});
  check("alert: several problems in one message", sev[0].title === "Sentiv needs you: 2 things are broken" && sev[0].body === "A · B");
  check("alert: fixed message says how long it was down", sev[1].title === "Fixed: C" && sev[1].body === "Working again after 25 min.", JSON.stringify(sev[1]));
  check("alert: switched off by the owner → nothing", push._alertPayloads({ down: [{ label: "A" }] }, { alert: { off: true } }).length === 0);

  // ---- routes ----
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/push", push);
  const srv = await new Promise((rs) => { const s = app.listen(0, "127.0.0.1", () => rs(s)); });
  const base_ = `http://127.0.0.1:${srv.address().port}/api/push`;
  const post = async (p, body, tok) => { const x = await fetch(base_ + p, { method: "POST", headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body || {}) }); return { status: x.status, body: await x.json().catch(() => ({})) }; };

  sent.length = 0;
  let x = await post("/remind/test", { text: "Pay the Euphoria bill" }, "agent");
  check("remind/test: sends to the caller's own devices", x.status === 200 && sent.length === 1 && sent[0].to === "https://push.example/a" && sent[0].p.title === "⏰ Pay the Euphoria bill", JSON.stringify({ x, s: sent[0] && sent[0].p }));
  x = await post("/remind/test", { text: "again" }, "agent");
  check("remind/test: a double-tap is refused", x.status === 429);
  x = await post("/remind/test", { text: "x" });
  check("remind/test: needs a sign-in", x.status === 401);

  db.settings.pushTemplates = null;
  await new Promise((r) => setTimeout(r, 50));
  x = await post("/alert", { results: [{ area: "Data lock", name: "public key reads nothing from leads", ok: false, detail: "ROWS RETURNED" }] });
  check("alert route: refuses anyone without a GitHub token", x.status === 401);
  x = await post("/alert", { results: [] }, mint({ repository: "someone/else" }));
  check("alert route: refuses another repo's token", x.status === 401);
  x = await post("/alert", { results: [] }, mint({ event_name: "pull_request" }));
  check("alert route: refuses a pull-request run", x.status === 401);
  sent.length = 0;
  x = await post("/alert", { results: [{ area: "Data lock", name: "public key reads nothing from leads", ok: false, detail: "ROWS RETURNED" }, { area: "Hub", name: "live site loads", ok: true }] }, mint());
  const ownerMsg = sent.find((s) => s.to === "https://push.example/o");
  check("alert route: our workflow's failure buzzes the OWNER at once", x.status === 200 && x.body.alerted === 1 && !!ownerMsg && /Data lock: public key reads nothing from leads/.test(ownerMsg.p.title), JSON.stringify({ x, sent }));
  check("alert route: agents are not told", !sent.some((s) => s.to === "https://push.example/a"));
  check("alert route: high urgency", ownerMsg && ownerMsg.opts.urgency === "high");
  sent.length = 0;
  x = await post("/alert", { results: [{ area: "Data lock", name: "public key reads nothing from leads", ok: false, detail: "ROWS RETURNED" }] }, mint());
  check("alert route: the same failure next run doesn't buzz again", x.body.alerted === 0 && sent.length === 0);
  x = await post("/alert", { results: [{ area: "Data lock", name: "public key reads nothing from leads", ok: true }] }, mint());
  check("alert route: when it passes again, the owner gets 'Fixed'", x.body.fixed === 1 && sent.some((s) => s.to === "https://push.example/o" && /^Fixed: Data lock/.test(s.p.title)));

  const hh = await fetch(`${base_}/health`).then((r) => r.json());
  check("health: reports reminders + watchdog, and the new kinds", hh.reminders && hh.watchdog && hh.templates.includes("remind") && hh.templates.includes("alert"), JSON.stringify({ r: hh.reminders, w: hh.watchdog }));

  srv.close(); sbServer.close(); jwksServer.close();
  console.log(`\n${fails.length ? `${fails.length} FAILED` : "all passed"}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
