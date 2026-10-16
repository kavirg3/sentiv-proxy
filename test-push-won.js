// node test-push-won.js — owner-editable push wording + the deal-won push (Hub v234).
// Runs push-routes in-process against a fake Supabase (REST + Storage) with web-push
// stubbed, so every notification that WOULD go out is captured and checked.
const http = require("http");
const express = require("express");
const fails = [];
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); if (!c) fails.push(n); };

const OWNER = "00000000-0000-0000-0000-00000000000a", AGENT = "00000000-0000-0000-0000-00000000000b", SETTER = "00000000-0000-0000-0000-00000000000c";
const NOW = Date.now();
const sp = (t) => String(t || "").replace(/\u00a0/g, " ");   // en-ZA groups thousands with a no-break space
const db = {
  profiles: [{ id: OWNER, role: "owner", full_name: "Kavir Gayanda" }, { id: AGENT, role: "agent", full_name: "Thabo Nkosi" }, { id: SETTER, role: "setter", full_name: "Lerato M" }],
  subs: { [OWNER]: [{ endpoint: "https://push.example/o", p256dh: "x", auth: "y" }], [AGENT]: [{ endpoint: "https://push.example/a", p256dh: "x", auth: "y" }], [SETTER]: [{ endpoint: "https://push.example/s", p256dh: "x", auth: "y" }] },
  leads: [
    { id: "L1", agent_id: AGENT, data: { company: "Mthembu Logistics", stage: "Closed Won", value: 84500, closedAt: NOW - 60e3 } },
    { id: "L2", agent_id: OWNER, data: { company: "Karoo Mining", stage: "Closed Won", value: 200000, closedAt: NOW - 5 * 864e5 } },
    { id: "L3", agent_id: AGENT, data: { company: "Rand Security", stage: "Quotation Sent", value: 50000 } },
    { id: "L4", agent_id: AGENT, data: { company: "Old Win", stage: "Closed Won", value: 9, closedAt: NOW - 90 * 864e5 } },
  ],
  pushLog: [],
  settings: { pushTemplates: null, agentPhones: { [AGENT]: "+27 82 555 0172" } },
  objects: {},
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
  if (u.pathname.startsWith("/storage/v1/object/info/backups/push-images/")) {
    return db.objects[u.pathname.split("/").pop()] ? json(200, {}) : json(400, { error: "not found" });
  }
  if (u.pathname.startsWith("/storage/v1/object/backups/push-images/")) {
    const name = u.pathname.split("/").pop();
    if (req.method === "POST") { db.objects[name] = raw; return json(200, { Key: name }); }
    if (!db.objects[name]) return json(400, { error: "not found" });
    res.writeHead(200, { "Content-Type": "application/octet-stream" }); return res.end(db.objects[name]);
  }
  const tbl = u.pathname.replace("/rest/v1/", "");
  const q = u.searchParams;
  if (tbl === "profiles") {
    let rows = db.profiles;
    if (q.get("id")) rows = rows.filter((p) => p.id === q.get("id").replace("eq.", ""));
    if (q.get("role")) rows = rows.filter((p) => p.role === q.get("role").replace("eq.", ""));
    return json(200, rows);
  }
  if (tbl === "push_subscriptions") return json(200, db.subs[(q.get("user_id") || "").replace("eq.", "")] || []);
  if (tbl === "team_settings") return json(200, [{ pushTemplates: db.settings.pushTemplates, agentPhones: db.settings.agentPhones }]);
  if (tbl === "leads") {
    let rows = db.leads;
    if (q.get("id")) rows = rows.filter((r) => r.id === q.get("id").replace("eq.", ""));
    if (q.get("data->>stage")) rows = rows.filter((r) => r.data.stage === q.get("data->>stage").replace("eq.", ""));
    if ((q.get("select") || "").includes("closedAt:")) rows = rows.map((r) => ({ closedAt: r.data.closedAt != null ? String(r.data.closedAt) : null, value: r.data.value != null ? String(r.data.value) : null, business: r.data.business || null }));
    return json(200, rows);
  }
  if (tbl === "push_log") {
    if (req.method === "POST") {
      const add = JSON.parse(raw.toString()).filter((r) => !db.pushLog.some((x) => x.lead_id === r.lead_id && x.kind === r.kind && x.sent_on === r.sent_on));
      db.pushLog.push(...add);
      return json(201, add);
    }
    let rows = db.pushLog;
    if (q.get("lead_id")) rows = rows.filter((r) => r.lead_id === q.get("lead_id").replace("eq.", ""));
    if (q.get("kind")) rows = rows.filter((r) => r.kind === q.get("kind").replace("eq.", ""));
    if (q.get("sent_on")) rows = rows.filter((r) => r.sent_on === q.get("sent_on").replace("eq.", ""));
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
    PUSH_SWEEP_SECRET: "s3cret", PUSH_QUIET_START: "0", PUSH_QUIET_END: "24", PUSH_PUBLIC_URL: "https://proxy.test",
  });
  const webpush = require("web-push");
  webpush.setVapidDetails = () => {};
  const sent = [];
  webpush.sendNotification = async (sub, body) => { sent.push({ to: sub.endpoint, p: JSON.parse(body) }); return {}; };
  const push = require("./push-routes");
  const { _fillTpl: fill, _tplFor: tplFor, _wonPayloads: wonPayloads, _monthWonTotal: monthTotal, _payloadFor: payloadFor, _decodeImage: decodeImage } = push;

  // ---- pure ----
  check("fill: words filled", fill("Deal won: {company}", { company: "Acme" }) === "Deal won: Acme");
  check("fill: an empty word leaves no stray separator", fill("{stage} · {value} · {contact}", { stage: "Lead", value: "", contact: "Sipho" }) === "Lead · Sipho", fill("{stage} · {value} · {contact}", { stage: "Lead", value: "", contact: "Sipho" }));
  check("fill: empty last word leaves no trailing dot", fill("{stage} · {value}", { stage: "Lead", value: "" }) === "Lead");
  check("fill: empty first word leaves no leading dot", fill("{value} · closed by {agent}.", { value: "", agent: "Thabo" }) === "closed by Thabo.", fill("{value} · closed by {agent}.", { value: "", agent: "Thabo" }));
  check("fill: unknown word becomes nothing, not {braces}", fill("Hi {nobody} there", {}) === "Hi there");
  check("tplFor: blank owner field falls back to shipped wording", tplFor("won", { won: { title: "  ", body: "Custom {value}" } }).title === "Deal won: {company}" && tplFor("won", { won: { body: "Custom {value}" } }).body === "Custom {value}");
  check("tplFor: a bad picture name is ignored", tplFor("stale", { stale: { image: "../../etc/passwd" } }).image === null);
  check("tplFor: deal won defaults to the deal card, everyone", tplFor("won", null).pic === "card" && tplFor("won", null).to === "all");

  const fu = payloadFor(db.leads[2], "followup", {});
  check("follow-up: shipped wording unchanged", fu.title === "Follow-up due: Rand Security" && sp(fu.body) === "Quotation Sent · R50 000", fu.body);
  const fu2 = payloadFor(db.leads[2], "stale", { stale: { title: "Cold: {company} ({days}d)", image: "stale-0123456789ab.jpg" } });
  check("going cold: owner's wording + picture used", fu2.title.startsWith("Cold: Rand Security (") && fu2.image === "https://proxy.test/api/push/img/stale-0123456789ab.jpg", JSON.stringify(fu2));

  const people = db.profiles.filter((p) => p.role !== "setter");
  const w = wonPayloads(db.leads[0], { tpls: {}, phones: db.settings.agentPhones, card: "card-0123456789ab.jpg", monthTotal: 312000, agentName: "Thabo", people });
  const toOwner = w.find((x) => x.userId === OWNER).payload, toCloser = w.find((x) => x.userId === AGENT).payload;
  check("won: title", toOwner.title === "Deal won: Mthembu Logistics", toOwner.title);
  check("won: body has value, closer and month total", sp(toOwner.body) === "R84 500 · closed by Thabo. Team this month: R312 000.", toOwner.body);
  check("won: buttons are Open deal + Reply in WhatsApp", JSON.stringify(toOwner.actions) === JSON.stringify([{ action: "open", title: "Open deal" }, { action: "wa", title: "Reply in WhatsApp" }]));
  check("won: deal card is the picture", toOwner.image === "https://proxy.test/api/push/img/card-0123456789ab.jpg");
  check("won: owner's WhatsApp goes to the closer's number", toOwner.waUrl.startsWith("https://wa.me/27825550172?text=Well%20done%20Thabo"), toOwner.waUrl);
  check("won: closer's own WhatsApp opens the chat picker", toCloser.waUrl.startsWith("https://wa.me/?text="), toCloser.waUrl);
  check("won: tapping opens that deal", toOwner.url.endsWith("/?lead=L1"));
  const wOwner = wonPayloads(db.leads[0], { tpls: { won: { to: "owner", pic: "custom", image: "won-0123456789ab.jpg" } }, phones: {}, card: "card-x", monthTotal: 0, agentName: "Thabo", people });
  check("won: 'owner only' sends to the owner alone", wOwner.length === 1 && wOwner[0].userId === OWNER);
  check("won: 'your picture' replaces the card", wOwner[0].payload.image === "https://proxy.test/api/push/img/won-0123456789ab.jpg");
  check("won: 'no picture' sends text only", !wonPayloads(db.leads[0], { tpls: { won: { pic: "none" } }, people, card: "card-0123456789ab.jpg" })[0].payload.image);
  check("won: switched off sends nothing", wonPayloads(db.leads[0], { tpls: { won: { off: true } }, people }).length === 0);
  const rows = [{ closedAt: String(NOW), value: "100" }, { closedAt: String(NOW), value: "50", business: "rewards" }, { closedAt: String(NOW - 70 * 864e5), value: "999" }, { closedAt: null, value: "5" }];
  check("month total: this month, this business only", monthTotal(rows, { data: {} }, NOW) === 100 && monthTotal(rows, { data: { business: "rewards" } }, NOW) === 50);
  check("decodeImage: real JPEG accepted", !!decodeImage("data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString("base64")));
  check("decodeImage: a PDF renamed .jpg refused", !decodeImage("data:image/jpeg;base64," + Buffer.from("%PDF-1.4").toString("base64")));

  // ---- routes ----
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", async (req, _res, next) => { const t = (req.get("authorization") || "").replace("Bearer ", ""); req.sentivUser = t === "owner" ? OWNER : t === "agent" ? AGENT : undefined; next(); });
  app.use("/api/push", push);
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const B = `http://127.0.0.1:${srv.address().port}/api/push`;
  const call = async (path, tok, body, method = "POST") => { const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: method === "GET" ? undefined : JSON.stringify(body || {}) }); let j = null; try { j = await r.clone().json(); } catch (e) {} return { status: r.status, j, r }; };
  const jpeg = "data:image/jpeg;base64," + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString("base64");

  check("/won: someone else's deal refused", (await call("/won", "agent", { leadId: "L2" })).status === 403);
  check("/won: a deal not yet Closed Won → 409 (Hub retries)", (await call("/won", "agent", { leadId: "L3" })).status === 409);
  check("/won: an old win is not announced", (await call("/won", "agent", { leadId: "L4" })).j.skipped === "won too long ago");
  sent.length = 0;
  const r1 = await call("/won", "agent", { leadId: "L1", card: jpeg });
  check("/won: the closer announces their win", r1.status === 200 && r1.j.sent === 2 && r1.j.card === true, JSON.stringify(r1.j));
  check("/won: owner + agent told, setter not (Sentiv deal)", sent.map((s) => s.to).sort().join() === "https://push.example/a,https://push.example/o");
  const op = sent.find((s) => s.to.endsWith("/o")).p;
  // L1 (today) + L2 (5 days ago, if that is still this SAST month); never L4 (90 days ago).
  const mon = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit" }).format(new Date(ms));
  const expTotal = 84500 + (mon(NOW - 5 * 864e5) === mon(NOW) ? 200000 : 0);
  check("/won: month total = this month's wins only", sp(op.body).endsWith("Team this month: R" + sp(expTotal.toLocaleString("en-ZA")) + "."), op.body);
  check("/won: card stored and used as the picture", /^https:\/\/proxy\.test\/api\/push\/img\/card-[0-9a-f]{12}\.jpg$/.test(op.image || ""), op.image);
  check("/won: closer's first name used", / closed by Thabo\./.test(op.body));
  const img = await call(op.image.replace("https://proxy.test/api/push", ""), null, null, "GET");
  check("/img: card served to phones without sign-in", img.status === 200 && img.r.headers.get("content-type") === "image/jpeg" && /immutable/.test(img.r.headers.get("cache-control")));
  check("/img: bad name → 404", (await call("/img/..%2F..%2Fsecret.jpg", null, null, "GET")).status === 404);
  sent.length = 0;
  const r2 = await call("/won", "owner", { leadId: "L1" });
  check("/won: a second call never buzzes again", r2.j.already === true && sent.length === 0, JSON.stringify(r2.j));

  // The sweep catches a win the Hub never announced (offline / quiet hours).
  db.leads.push({ id: "L5", agent_id: OWNER, data: { company: "Late Win Co", stage: "Closed Won", value: 1000, closedAt: NOW - 3600e3 } });
  sent.length = 0;
  const sw = await fetch(B + "/sweep", { method: "POST", headers: { "Content-Type": "application/json", "x-sweep-secret": "s3cret" }, body: "{}" }).then((r) => r.json());
  check("sweep: announces the unannounced win once", sw.won && sw.won.announced === 1 && sent.filter((s) => s.p.tag === "won-L5").length === 2, JSON.stringify(sw.won));
  sent.length = 0;
  await fetch(B + "/sweep", { method: "POST", headers: { "Content-Type": "application/json", "x-sweep-secret": "s3cret" }, body: "{}" });
  check("sweep: and never again", sent.filter((s) => (s.p.tag || "").startsWith("won-")).length === 0);

  // Owner edits + picture upload.
  check("/image: agent refused", (await call("/image", "agent", { kind: "won", dataUrl: jpeg })).status === 403);
  check("/image: junk refused", (await call("/image", "owner", { kind: "won", dataUrl: "data:image/jpeg;base64,AAAA" })).status === 400);
  const up = await call("/image", "owner", { kind: "won", dataUrl: jpeg });
  check("/image: owner upload → hashed file name", up.status === 200 && /^won-[0-9a-f]{12}\.jpg$/.test(up.j.file), JSON.stringify(up.j));
  db.settings.pushTemplates = { won: { title: "🏆 {company} is ours!", body: "{agent} closed {value}", pic: "custom", image: up.j.file, wa: "Congrats {agent}!" }, followup: { title: "Call {company} today" } };
  db.leads.push({ id: "L6", agent_id: AGENT, data: { company: "Edited Co", stage: "Closed Won", value: 5000, closedAt: NOW - 1000 } });
  sent.length = 0;
  await call("/won", "agent", { leadId: "L6", card: jpeg });
  const ep = sent.find((s) => s.to.endsWith("/o")).p;
  check("edited won: owner's title, text, picture and WhatsApp text", ep.title === "🏆 Edited Co is ours!" && sp(ep.body) === "Thabo closed R5 000" && ep.image.endsWith(up.j.file) && ep.waUrl.includes("Congrats%20Thabo"), JSON.stringify(ep));
  sent.length = 0;
  const pv = await call("/preview", "owner", { kind: "followup" });
  check("/preview: sends the owner the edited follow-up, sample words", pv.status === 200 && sent.length === 1 && sent[0].p.title === "Call Mthembu Logistics today", JSON.stringify(sent[0] && sent[0].p));
  await new Promise((r) => setTimeout(r, 4100));
  sent.length = 0;
  await call("/preview", "owner", { kind: "stale", tpl: { title: "Draft: {company} cold {days}d", image: "../evil.jpg" } });
  check("/preview: uses the on-screen draft, cleans a bad picture name", sent.length === 1 && sent[0].p.title === "Draft: Mthembu Logistics cold 9d" && !sent[0].p.image, JSON.stringify(sent[0] && sent[0].p));
  check("/preview: agents can't", (await call("/preview", "agent", { kind: "followup" })).status === 403);
  await new Promise((r) => setTimeout(r, 4100));
  sent.length = 0;
  await call("/preview", "owner", { kind: "won", card: jpeg });
  check("/preview won: owner only, with picture + both buttons", sent.length === 1 && sent[0].to.endsWith("/o") && !!sent[0].p.image && sent[0].p.actions.length === 2);
  await new Promise((r) => setTimeout(r, 4100));
  sent.length = 0;
  await call("/test", "agent");
  check("/test: the test template's shipped wording", sent.length === 1 && sent[0].p.title === "Sentiv Sales Hub — test" && /notifications are working/.test(sent[0].p.body), JSON.stringify(sent[0] && sent[0].p));

  // ---- v235 chase the quote ----
  const { _quotePayload: quotePayload, _cellOf: cellOf, _rankForAgent: rank } = push;
  check("cellOf: SA cell found, landline skipped", cellOf({ phone: "011 555 0100", directLine: "082 555 0172" }) === "27825550172" && cellOf({ phone: "011 555 0100" }) === "");
  const q = quotePayload({ id: "Q1", data: { company: "Karoo Mining", value: 120000, stage: "Quotation Sent", contact: "Sipho Dlamini", phone: "+27 82 555 0172", updatedAt: NOW - 6 * 864e5 } }, {});
  check("quote: title", q.title === "Chase the quote: Karoo Mining", q.title);
  check("quote: body", sp(q.body) === "Quoted R120 000 · no update for 6 days · Sipho Dlamini", q.body);
  check("quote: WhatsApp them → client's cell, check-in typed", q.waUrl.startsWith("https://wa.me/27825550172?text=Hi%20Sipho%2C%20just%20checking%20in") && q.actions[1].title === "WhatsApp them", q.waUrl);
  const ql = quotePayload({ id: "Q2", data: { company: "Landline Co", stage: "Quotation Sent", phone: "011 555 0100", updatedAt: NOW - 6 * 864e5 } }, {});
  check("quote: no cell → Snooze, no WhatsApp", !ql.waUrl && ql.actions.map((x) => x.title).join() === "Open lead,Snooze" && sp(ql.body) === "Quoted · no update for 6 days", ql.body);
  const qe = quotePayload({ id: "Q3", data: { company: "X", stage: "Quotation Sent", contact: "Jo Bloggs", phone: "0825550172", updatedAt: NOW - 6 * 864e5 } }, { quote: { title: "Quote at {company} is {days}d old", wa: "Morning {firstname}!" } });
  check("quote: owner's wording + WhatsApp text", qe.title === "Quote at X is 6d old" && qe.waUrl.endsWith("?text=Morning%20Jo!"), JSON.stringify(qe));
  check("rank: equal value → quote before follow-up before cold", rank([{ kind: "stale", r: { data: {} } }, { kind: "followup", r: { data: {} } }, { kind: "quote", r: { data: {} } }]).map((x) => x.kind).join() === "quote,followup,stale");
  db.settings.pushTemplates = null;
  db.leads.push(
    { id: "Q10", agent_id: AGENT, data: { company: "Quiet Quote", stage: "Quotation Sent", value: 90000, phone: "0825550172", followUp: "2000-01-01", updatedAt: NOW - 6 * 864e5 } },
    { id: "Q11", agent_id: AGENT, data: { company: "Opted Out", stage: "Quotation Sent", value: 80000, optOut: true, followUp: "2000-01-01", updatedAt: NOW - 6 * 864e5 } },
    { id: "Q12", agent_id: AGENT, data: { company: "Fresh Quote", stage: "Quotation Sent", value: 70000, followUp: "2000-01-01", updatedAt: NOW - 2 * 864e5 } },
  );
  sent.length = 0;
  const sq = await fetch(B + "/sweep", { method: "POST", headers: { "Content-Type": "application/json", "x-sweep-secret": "s3cret" }, body: "{}" }).then((r) => r.json());
  const tagOf = (id) => (sent.find((x) => (x.p.tag || "").endsWith("-" + id)) || { p: {} }).p.tag;
  check("sweep: quiet quote → quote alert (not follow-up)", tagOf("Q10") === "quote-Q10", `${tagOf("Q10")} ${JSON.stringify(sq.quotes)}`);
  check("sweep: opted-out quote → plain follow-up, never 'WhatsApp them'", tagOf("Q11") === "followup-Q11");
  check("sweep: quote touched 2 days ago → follow-up", tagOf("Q12") === "followup-Q12");
  sent.length = 0;
  await fetch(B + "/sweep", { method: "POST", headers: { "Content-Type": "application/json", "x-sweep-secret": "s3cret" }, body: "{}" });
  check("sweep: not repeated the same day", !sent.some((x) => (x.p.tag || "").startsWith("quote-")));
  // A deal that already had its follow-up alert today, then goes quiet long enough to be a quote alert.
  db.leads.find((l) => l.id === "Q12").data.updatedAt = NOW - 6 * 864e5;
  sent.length = 0;
  await fetch(B + "/sweep", { method: "POST", headers: { "Content-Type": "application/json", "x-sweep-secret": "s3cret" }, body: "{}" });
  check("sweep: a deal already alerted today is not buzzed again under another reason", !sent.some((x) => x.p.tag === "quote-Q12"));
  await new Promise((r) => setTimeout(r, 4100));
  sent.length = 0;
  await call("/preview", "owner", { kind: "quote" });
  check("/preview quote: sample with WhatsApp them", sent.length === 1 && sent[0].p.title === "Chase the quote: Mthembu Logistics" && sent[0].p.actions[1].title === "WhatsApp them", JSON.stringify(sent[0] && sent[0].p));

  srv.close(); sbServer.close();
  console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
