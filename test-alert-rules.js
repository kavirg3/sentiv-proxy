// node test-alert-rules.js — owner-editable alert rules (Hub v241): on/off, who gets it,
// days, office hours, daily limit, weekly day/hour, watchdog timing, and the stats route.
// push-routes runs in-process against a fake Supabase with web-push stubbed.
const http = require("http");
const express = require("express");
const fails = [];
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); if (!c) fails.push(n); };

const OWNER = "00000000-0000-0000-0000-00000000000a", AGENT = "00000000-0000-0000-0000-00000000000b";
const DAY = 864e5, NOW = Date.now();
const sastDayOf = (ms) => new Date(ms + 2 * 3600e3).toISOString().slice(0, 10);
const TODAY = sastDayOf(NOW);
const db = {
  profiles: [{ id: OWNER, role: "owner" }, { id: AGENT, role: "agent" }],
  subs: { [OWNER]: [{ endpoint: "https://push.example/o", p256dh: "x", auth: "y" }], [AGENT]: [{ endpoint: "https://push.example/a", p256dh: "x", auth: "y" }] },
  leads: [],
  pushLog: [],
  settings: { pushTemplates: null },
};
const lead = (id, agent, data) => ({ id, agent_id: agent, data: { company: id, value: 1000, ...data } });
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
  const eq = (k) => (q.get(k) || "").replace(/^eq\./, "");
  if (tbl === "profiles") {
    let rows = db.profiles;
    if (q.get("id")) rows = rows.filter((p) => p.id === eq("id"));
    const role = q.get("role") || "";
    if (role.startsWith("eq.")) rows = rows.filter((p) => p.role === role.slice(3));
    if (role.startsWith("in.(")) { const set = role.slice(4, -1).split(","); rows = rows.filter((p) => set.includes(p.role)); }
    return json(200, rows);
  }
  if (tbl === "push_subscriptions") return json(200, db.subs[eq("user_id")] || []);
  if (tbl === "team_settings") return json(200, [{ pushTemplates: db.settings.pushTemplates, agentPhones: {} }]);
  if (tbl === "leads") return json(200, q.get("data->>stage") ? db.leads.filter((r) => r.data.stage === eq("data->>stage")) : db.leads);
  if (tbl === "usage_events") return json(200, []);
  if (tbl === "user_state") return json(200, [{ agent_id: AGENT, data: { id: "reminders", v: [{ id: "r1abc", text: "x", time: "00:00", date: "2020-01-01", repeat: "daily", created: 0 }] } }]);
  if (tbl === "push_log") {
    if (req.method === "POST") {
      const add = JSON.parse(raw.toString()).filter((r) => !db.pushLog.some((x) => x.lead_id === r.lead_id && x.kind === r.kind && x.sent_on === r.sent_on));
      db.pushLog.push(...add);
      return json(201, add);
    }
    if (req.method === "DELETE") return json(200, []);
    let rows = db.pushLog;
    if (q.get("sent_on")) { const v = q.get("sent_on"); rows = v.startsWith("eq.") ? rows.filter((r) => r.sent_on === v.slice(3)) : rows.filter((r) => r.sent_on >= v.slice(4)); }
    if (q.get("lead_id")) rows = rows.filter((r) => r.lead_id === eq("lead_id"));
    if (q.get("kind")) rows = rows.filter((r) => r.kind === eq("kind"));
    return json(200, rows);
  }
  json(404, { error: "fake: " + tbl });
});

(async () => {
  await new Promise((r) => sbServer.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    SUPABASE_URL: `http://127.0.0.1:${sbServer.address().port}`, SUPABASE_SERVICE_KEY: "svc",
    VAPID_PUBLIC_KEY: "BInuO5Jvd7QTVc2rT01sGp1Pjr4C68ru0xb9q0GG5e0nadT7y5DxUAtkTdXrMPCyN9w4Q1KqSTGVOQlV1nSsDG0",
    VAPID_PRIVATE_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", VAPID_SUBJECT: "mailto:test@example.com",
    PUSH_SWEEP_SECRET: "s3cret", PUSH_LOOPS_OFF: "1",
  });
  const webpush = require("web-push");
  webpush.setVapidDetails = () => {};
  const sent = [];
  webpush.sendNotification = async (sub, body) => { sent.push({ to: sub.endpoint, p: JSON.parse(body) }); return {}; };
  const push = require("./push-routes");
  const { _rulesOf: rulesOf, _kindRules: kindRules } = push;

  // ---- pure: validation falls back to the shipped values ----
  check("rules: nothing set = shipped 07–18, 5 a day", JSON.stringify(rulesOf(null)) === JSON.stringify({ start: 7, end: 18, cap: 5 }), JSON.stringify(rulesOf(null)));
  check("rules: owner's window and limit used", JSON.stringify(rulesOf({ rules: { start: 6, end: 20, cap: 8 } })) === JSON.stringify({ start: 6, end: 20, cap: 8 }));
  check("rules: nonsense ignored (end before start, cap 0, text)", JSON.stringify(rulesOf({ rules: { start: 19, end: 9, cap: 0 } })) === JSON.stringify({ start: 19, end: 24, cap: 5 }) && rulesOf({ rules: { start: "x" } }).start === 7, JSON.stringify(rulesOf({ rules: { start: 19, end: 9, cap: 0 } })));
  check("kind: quote 5 days, stale 7 days by default", kindRules("quote", {}).days === 5 && kindRules("stale", {}).days === 7);
  check("kind: owner's days used, out of range ignored", kindRules("quote", { quote: { days: 3 } }).days === 3 && kindRules("stale", { stale: { days: 400 } }).days === 7);
  check("kind: audience defaults to the deal owner; junk ignored", kindRules("followup", {}).to === "agent" && kindRules("followup", { followup: { to: "everyone" } }).to === "agent" && kindRules("quote", { quote: { to: "both" } }).to === "both");
  check("kind: weekly notes default Monday 08:00", kindRules("week", {}).day === 1 && kindRules("week", {}).hour === 8 && kindRules("digest", { digest: { day: 5, hour: 16 } }).hour === 16);
  check("kind: the test alert can't be switched off", kindRules("test", { test: { off: true } }).off === false);
  check("kind: platform alarm 10 min / every 4 h by default", kindRules("alert", {}).after === 10 && kindRules("alert", {}).repeat === 4);

  // ---- the sweep ----
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => { const t = (req.get("authorization") || "").replace("Bearer ", ""); if (t === "owner") req.sentivUser = OWNER; if (t === "agent") req.sentivUser = AGENT; next(); });
  app.use("/api/push", push);
  const srv = await new Promise((rs) => { const s = app.listen(0, "127.0.0.1", () => rs(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/push`;
  const call = async (method, p, body, tok, hdr = {}) => { const x = await fetch(base + p, { method, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...hdr }, body: body ? JSON.stringify(body) : undefined }); return { status: x.status, body: await x.json().catch(() => ({})) }; };
  const sweep = async (extra = {}) => { sent.length = 0; return call("POST", "/sweep", { force: true, ...extra }, null, { "x-sweep-secret": "s3cret" }); };
  const reset = (tpls) => { db.pushLog = []; db.settings.pushTemplates = tpls; };

  db.leads = [
    lead("F1", AGENT, { stage: "Proposal", followUp: TODAY, updatedAt: NOW }),
    lead("Q1", AGENT, { stage: "Quotation Sent", updatedAt: NOW - 4 * DAY }),
    lead("S1", AGENT, { stage: "Lead", updatedAt: NOW - 8 * DAY }),
  ];
  reset(null);
  let r = await sweep();
  check("shipped: follow-up + going cold to the agent; 4-day-old quote not yet", r.body.followups === 1 && r.body.stale === 1 && r.body.quotes === 0 && sent.every((x) => x.to === "https://push.example/a") && sent.length === 2, JSON.stringify(r.body));

  reset({ quote: { days: 3 } });
  r = await sweep();
  check("quote after 3 days (owner's setting) → chase-the-quote fires", r.body.quotes === 1 && sent.some((x) => /^Chase the quote: Q1/.test(x.p.title)), JSON.stringify(r.body));

  reset({ followup: { off: true }, stale: { off: true } });
  r = await sweep();
  check("follow-up and going cold switched off → nothing sent", r.body.due === 0 && sent.length === 0, JSON.stringify(r.body));

  reset({ quote: { off: true, days: 3 } });
  r = await sweep();
  check("quote switched off → that deal is not chased", r.body.quotes === 0 && !sent.some((x) => /Chase/.test(x.p.title)), JSON.stringify(r.body));

  reset({ followup: { to: "both" } });
  r = await sweep();
  const fu = sent.filter((x) => /^Follow-up due: F1/.test(x.p.title)).map((x) => x.to).sort();
  check("'owner + you': the follow-up reaches the agent AND the owner", JSON.stringify(fu) === JSON.stringify(["https://push.example/a", "https://push.example/o"]), JSON.stringify(fu));
  check("…but is logged once, under the deal's owner", db.pushLog.filter((x) => x.lead_id === "F1").length === 1 && db.pushLog.find((x) => x.lead_id === "F1").user_id === AGENT);

  reset({ stale: { to: "owner" } });
  r = await sweep();
  check("'just you': going cold goes only to the owner", sent.filter((x) => /^Going cold/.test(x.p.title)).map((x) => x.to).join() === "https://push.example/o", JSON.stringify(sent.map((x) => x.to + " " + x.p.title)));

  db.leads = Array.from({ length: 6 }, (_, i) => lead(`C${i}`, AGENT, { stage: "Lead", followUp: TODAY, value: (i + 1) * 100 }));
  reset({ rules: { cap: 2 } });
  r = await sweep();
  check("daily limit 2 → only the two biggest deals, 4 held", sent.length === 2 && r.body.held === 4 && sent.map((x) => x.p.title).sort().join() === "Follow-up due: C4,Follow-up due: C5", JSON.stringify(r.body));
  r = await sweep();
  check("…and the next sweep the same day sends nothing more", sent.length === 0, JSON.stringify(r.body));

  reset({ rules: { start: 0, end: 1 } });
  sent.length = 0;
  r = await call("POST", "/sweep", {}, null, { "x-sweep-secret": "s3cret" });
  const h = Number(new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", hour: "numeric", hour12: false }).format(new Date()));
  if (h >= 1) check("office hours 00–01 → a sweep outside them sends nothing", r.body.skipped === "quiet hours" && r.body.window === "0-1 SAST" && sent.length === 0, JSON.stringify(r.body));
  else check("office hours 00–01 (skipped: test runs inside that hour)", true);

  // ---- weekly notes: owner's day and hour ----
  const dow = new Date(NOW + 2 * 3600e3).getUTCDay();
  db.leads = [lead("W1", AGENT, { stage: "Lead", followUp: TODAY })];
  reset({ followup: { off: true }, week: { day: dow, hour: 5 }, digest: { day: dow, hour: 5 } });
  r = await call("POST", "/sweep", {}, null, { "x-sweep-secret": "s3cret" });
  const hourNow = h;
  if (hourNow >= 5) {
    check("weekly notes on today's weekday from 05:00 → both go out", sent.some((x) => x.p.tag === "weekly-agent") && sent.some((x) => x.p.tag === "weekly-digest"), JSON.stringify(r.body.digest));
  } else check("weekly notes (skipped: before 05:00 SAST)", true);
  reset({ followup: { off: true }, week: { day: (dow + 1) % 7 }, digest: { day: (dow + 1) % 7 } });
  sent.length = 0;
  r = await call("POST", "/sweep", {}, null, { "x-sweep-secret": "s3cret" });
  check("weekly notes set for another day → nothing today", !sent.some((x) => /^weekly/.test(x.p.tag || "")), JSON.stringify(r.body.digest));
  reset({ followup: { off: true }, week: { day: dow, hour: 5, to: "owner" }, digest: { day: dow, hour: 5, off: true } });
  sent.length = 0;
  r = await call("POST", "/sweep", {}, null, { "x-sweep-secret": "s3cret" });
  if (hourNow >= 5) check("'Your week' to the owner only; team week off", sent.filter((x) => x.p.tag === "weekly-agent").every((x) => x.to === "https://push.example/o") && !sent.some((x) => x.p.tag === "weekly-digest"), JSON.stringify(sent.map((x) => x.to + " " + x.p.tag)));
  else check("'Your week' to owner only (skipped: before 05:00)", true);

  // ---- reminders off ----
  reset({ remind: { off: true } });
  await new Promise((r2) => setTimeout(r2, 50));
  const rs = await push._remindSweep(NOW);
  check("reminders switched off → none sent", rs.off === true || rs.sent === 0, JSON.stringify(rs));

  // ---- stats ----
  db.pushLog = [
    { lead_id: "A", kind: "followup", user_id: AGENT, sent_on: TODAY },
    { lead_id: "B", kind: "followup", user_id: OWNER, sent_on: sastDayOf(NOW - 2 * DAY) },
    { lead_id: "C", kind: "quote", user_id: AGENT, sent_on: sastDayOf(NOW - 10 * DAY) },
    { lead_id: `weekly-agent-${AGENT}`, kind: "weekly", user_id: AGENT, sent_on: TODAY },
    { lead_id: `weekly-${OWNER}`, kind: "weekly", user_id: OWNER, sent_on: TODAY },
  ];
  db.settings.pushTemplates = { rules: { cap: 7 } };
  r = await call("GET", "/stats", null, "owner");
  const k = r.body.kinds || {};
  check("stats: follow-ups this week 2, to 2 people", k.followup && k.followup.sent === 2 && k.followup.people === 2 && k.followup.last === TODAY, JSON.stringify(k.followup));
  check("stats: older than 7 days left out", !k.quote);
  check("stats: weekly rows split into Your week and Team week", k.week && k.week.sent === 1 && k.digest && k.digest.sent === 1);
  check("stats: carries the live rules and shipped defaults", r.body.rules.cap === 7 && r.body.defaults.cap === 5 && r.body.defaults.quoteDays === 5);
  r = await call("GET", "/stats", null, "agent");
  check("stats: agents refused", r.status === 403);

  // ---- watchdog timing ----
  const { createWatchdog } = require("./watchdog");
  const calls = [];
  const w = createWatchdog({ notify: async (ev) => calls.push(ev), now: () => 0 });
  w.configure({ failAfter: 6, repeatMs: 3600e3 });
  const bad = [{ name: "x", label: "x", run: async () => ({ ok: false }) }];
  for (let i = 0; i < 5; i++) await w.run(bad);
  check("watchdog: 'after 30 minutes' = no alarm after 5 rounds", calls.length === 0);
  await w.run(bad);
  check("watchdog: …alarm on the 6th", calls.length === 1);

  const hh = await (await fetch(`${base}/health`)).json();
  check("health: shipped defaults published for the Hub", hh.defaults && hh.defaults.start === 7 && hh.defaults.end === 18 && hh.defaults.weekHour === 8);

  srv.close(); sbServer.close();
  console.log(`\n${fails.length ? `${fails.length} FAILED` : "all passed"}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
