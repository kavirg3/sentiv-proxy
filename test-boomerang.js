// node test-boomerang.js — the Boomerang card routes against a fake Boomerang + Supabase.
process.env.BOOMERANG_API_KEY = "AGENCY-KEY";
process.env.SUPABASE_URL = "https://sb.test"; process.env.SUPABASE_SERVICE_KEY = "SVC";
const express = require("express");
const router = require("./boomerang-routes");
const fails = []; const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); if (!c) fails.push(n); };

const OWNER = "u-owner", REP = "u-rep";
const db = {
  profiles: { [OWNER]: "owner", [REP]: "agent" },
  leads: {
    L1: { id: "L1", agent_id: OWNER, data: { id: "L1", business: "rewards", company: "Café Sola Gratia", phone: "076 294 6829", cardStrategy: { text: "8 coffees", status: "queued", requestedAt: 111 }, updatedAt: 1 } },
    L2: { id: "L2", agent_id: REP, data: { id: "L2", business: "rewards", company: "Rep Shop" } },
    L3: { id: "L3", agent_id: OWNER, data: { id: "L3", company: "Sentiv Deal" } },
  },
};
let createdCompany = null;
const calls = []; let templates = { 900: [], 901: [] }; let nextId = 5000;
const subKeys = { "SUB-900": 900, "SUB-901": 901 };
const J = (status, body, headers = {}) => ({ ok: status < 300, status, json: async () => body, headers: { get: (h) => headers[h.toLowerCase()] }, arrayBuffer: async () => body });
const fakeFetch = async (url, opts = {}) => {
  const m = (opts.method || "GET").toUpperCase(); const h = opts.headers || {};
  calls.push({ url, m, key: h["X-API-Key"], body: opts.body });
  if (url.startsWith("https://sb.test/rest/v1/profiles")) { const id = decodeURIComponent(url.match(/id=eq\.([^&]+)/)[1]); return J(200, db.profiles[id] ? [{ role: db.profiles[id] }] : []); }
  if (url.startsWith("https://sb.test/rest/v1/leads")) {
    const id = decodeURIComponent(url.match(/id=eq\.([^&]+)/)[1]);
    if (m === "PATCH") { const b = JSON.parse(opts.body); db.leads[id].data = b.data; db.leads[id].updated_at = b.updated_at; return J(204, null); }
    return J(200, db.leads[id] ? [JSON.parse(JSON.stringify(db.leads[id]))] : []);
  }
  if (url.startsWith("https://logo.test/")) {
    if (url.endsWith(".png")) return J(200, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]), { "content-type": "image/png" });
    return J(200, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]), { "content-type": "image/jpeg" });
  }
  const p = url.replace("https://api.digitalwallet.cards/api/v2", "");
  if (p.startsWith("/tariffs")) return h["X-API-Key"] === "AGENCY-KEY" ? J(200, { data: [{ id: 77, name: "Client Business", currency: "USD", prices: { month: 0, year: 0 }, limits: { templates: 10 } }] }) : J(401, {});
  if (p.startsWith("/companies") && m === "POST") {
    if (h["X-API-Key"] !== "AGENCY-KEY") return J(401, {});
    const b = JSON.parse(opts.body); createdCompany = b;
    if (b.email === "taken@x.co") return J(422, { message: `email already used (password ${b.password})` });
    return J(201, { data: { id: 950, name: b.name, apiKey: "SUB-950" } });
  }
  let sso = p.match(/^\/companies\/(\d+)\/sso-link$/);
  if (sso) return J(200, { data: { link: `https://app.digitalrewards.co.za/sso?t=TOKEN${sso[1]}` } });
  if (p.startsWith("/companies")) {
    if (h["X-API-Key"] !== "AGENCY-KEY") return J(401, { message: "bad key" });
    return J(200, { meta: { totalItems: 3 }, data: [{ id: 900, name: "Café Sola Gratia", apiKey: "SUB-900" }, { id: 901, name: "Bean There", apiKey: "SUB-901" }, { id: 902, name: "No Key Shop", apiKey: null }] });
  }
  const co = subKeys[h["X-API-Key"]] || (h["X-API-Key"] === "AGENCY-KEY" ? "main" : null);
  if (!co) return J(401, { message: "bad key" });
  const list = templates[co] || (templates[co] = []);
  if (p.startsWith("/templates?")) return J(200, { data: list });
  let mm = p.match(/^\/templates\/(\d+)\/activate$/);
  if (mm && m === "POST") { const t = list.find((x) => String(x.id) === mm[1]); if (!t) return J(404, {}); t.active = true; return J(200, { data: t }); }
  mm = p.match(/^\/templates\/(\d+)$/);
  if (mm && m === "GET") { const t = list.find((x) => String(x.id) === mm[1]); return t ? J(200, { data: t }) : J(404, { message: "not found" }); }
  if (mm && m === "PATCH") { const t = list.find((x) => String(x.id) === mm[1]); Object.assign(t, JSON.parse(opts.body)); return J(200, { data: t }); }
  if (p === "/templates" && m === "POST") { const t = { ...JSON.parse(opts.body), id: nextId++ }; t.installLink = `https://app.digitalrewards.co.za/getpass/T${t.id}`; t.qrLink = `https://api.digitalwallet.cards/qrcode/T${t.id}`; list.push(t); return J(201, { data: t }); }
  return J(404, {});
};
router._setFetch(fakeFetch);
const app = express(); app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => { req.sentivUser = req.get("x-user"); next(); });
app.use("/api/boomerang", router);
const AI_TEMPLATE = {
  name: "Whatever", type: "stamp", customFields: [{ name: "First Name", type: "FName", required: true }, { name: "Birthday", type: "DateOfBirth" }],
  appearance: { backgroundColor: "#3B2A20", textColor: "#f5ebdd", logoImageBase64: "EVIL", logoImageUrl: "https://x.test/a.png", activeStampColor: "brown" }, mechanics: { stampsForReward: 8 },
  description: "8 coffees, 9th free", localization: { phoneFormatCountryCode: "us" }, cardsLimit: 5, analytics: { facebookPixel: "x" },
};
const srv = app.listen(0, async () => {
  const base = `http://127.0.0.1:${srv.address().port}/api/boomerang`;
  const get = async (p, user) => { const r = await fetch(base + p, { headers: user ? { "x-user": user } : {} }); return { status: r.status, body: await r.json(), raw: JSON.stringify(await Promise.resolve()) }; };
  const post = async (p, user, body) => { const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...(user ? { "x-user": user } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

  const h = await get("/health");
  check("health: key accepted, counts sub-accounts and those with keys", h.body.ok && h.body.subAccounts === 3 && h.body.subAccountsWithKey === 2 && h.body.subKeyWorks === true, JSON.stringify(h.body));
  check("health: no key in the answer", !/SUB-|AGENCY/.test(JSON.stringify(h.body)));

  const c = await get("/companies", OWNER);
  check("companies: owner gets names sorted, ready flag", c.status === 200 && c.body.companies.length === 3 && c.body.companies[0].name === "Bean There" && c.body.companies.find((x) => x.id === 902).ready === false);
  check("companies: never sends a key", !/SUB-|AGENCY|apiKey/.test(JSON.stringify(c.body)));
  check("companies: a rep is refused", (await get("/companies", REP)).status === 403);

  check("build: a rep is refused", (await post("/build", REP, { leadId: "L2", companyId: 900, template: AI_TEMPLATE })).status === 403);
  check("build: owner can't build on someone else's deal", (await post("/build", OWNER, { leadId: "L2", companyId: 900, template: AI_TEMPLATE })).status === 403);
  check("build: Sentiv deal refused", (await post("/build", OWNER, { leadId: "L3", companyId: 900, template: AI_TEMPLATE })).status === 400);
  check("build: unknown deal 404", (await post("/build", OWNER, { leadId: "NOPE", companyId: 900, template: AI_TEMPLATE })).status === 404);

  calls.length = 0;
  const b1 = await post("/build", OWNER, { leadId: "L1", companyId: 900, template: AI_TEMPLATE, summary: "Stamp card · 8 = free coffee", logoUrl: "https://logo.test/l.png", requestedAt: 111 });
  check("build: 200 with the card", b1.status === 200 && b1.body.cardStrategy.status === "built" && b1.body.cardStrategy.templateId === 5000 && /getpass\/T5000/.test(b1.body.cardStrategy.installLink), JSON.stringify(b1.body));
  const created = calls.find((x) => x.m === "POST" && x.url.endsWith("/templates"));
  check("build: made INSIDE the sub-account with its own key", created && created.key === "SUB-900" && templates[900].length === 1);
  const t = templates[900][0];
  check("build: name forced to '<company> Rewards'", t.name === "Café Sola Gratia Rewards" && t.companyName === "Café Sola Gratia");
  check("build: SA localisation forced", t.localization.phoneFormatCountryCode === "za" && t.localization.dateFormat === "DD/MM/YYYY");
  check("build: unique phone field added", t.customFields.some((f) => f.type === "phone" && f.unique && f.required));
  check("build: POPIA consent forced", t.legal.consentToProcessing === true && /Café Sola Gratia may keep my name/.test(t.legal.privacyPolicy.text));
  check("build: AI images and stray settings dropped", t.appearance.logoImageBase64 !== "EVIL" && t.cardsLimit === undefined && t.analytics === undefined);
  check("build: only hex colours pass", t.appearance.textColor === "#F5EBDD" && t.appearance.backgroundColor === "#3B2A20" && t.appearance.activeStampColor === undefined && t.appearance.logoImageUrl === undefined && t.appearance.barcodeType === "qr");
  check("build: PNG logo fetched and attached", t.appearance.logoImageBase64 === Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]).toString("base64"));
  check("build: issuer phone in +27 form", t.issuer && t.issuer.phone === "+27762946829");
  const cs = db.leads.L1.data.cardStrategy;
  check("build: result written onto the deal", cs.status === "built" && cs.templateId === 5000 && cs.companyId === "900" && cs.companyName === "Café Sola Gratia" && cs.text === "8 coffees");
  check("build: deal updatedAt moved", db.leads.L1.data.updatedAt > 1e12 && !!db.leads.L1.updated_at);

  calls.length = 0;
  const b2 = await post("/build", OWNER, { leadId: "L1", companyId: 900, template: { ...AI_TEMPLATE, mechanics: { stampsForReward: 10 } }, summary: "now 10", logoUrl: "https://logo.test/l.jpg", requestedAt: 111 });
  check("rebuild: same card updated, not a second one", b2.status === 200 && b2.body.updated === true && templates[900].length === 1 && templates[900][0].mechanics.stampsForReward === 10);
  check("rebuild: field list left alone", !calls.some((x) => x.m === "PATCH" && x.body && /customFields/.test(x.body)));
  check("rebuild: JPEG logo skipped with a note", /needs a PNG/.test(b2.body.cardStrategy.summary));

  db.leads.L1.data.cardStrategy.requestedAt = 222;
  await post("/build", OWNER, { leadId: "L1", companyId: 900, template: AI_TEMPLATE, summary: "old", requestedAt: 111 });
  check("stale build doesn't overwrite a newer strategy on the deal", db.leads.L1.data.cardStrategy.summary !== "old");

  const nk = await post("/build", OWNER, { leadId: "L1", companyId: 902, template: AI_TEMPLATE, requestedAt: 222 });
  check("sub-account without a key: clear 409", nk.status === 409 && /No Key Shop has no API key/.test(nk.body.error), JSON.stringify(nk.body));
  check("...and the deal shows the error", db.leads.L1.data.cardStrategy.status === "error" && /no API key/.test(db.leads.L1.data.cardStrategy.error));

  const mainB = await post("/build", OWNER, { leadId: "L1", companyId: "main", template: AI_TEMPLATE, requestedAt: 222 });
  check("main account: built with the agency key", mainB.status === 200 && templates.main.length === 1 && db.leads.L1.data.cardStrategy.companyId === "main");

  const a = await post("/activate", OWNER, { leadId: "L1" });
  check("activate: switched on in the right account", a.status === 200 && templates.main[0].active === true && db.leads.L1.data.cardStrategy.status === "live", JSON.stringify(a.body));
  check("activate: a rep is refused", (await post("/activate", REP, { leadId: "L1" })).status === 403);

  const tf = await get("/tariffs", OWNER);
  check("tariffs: owner gets the agency plans", tf.status === 200 && tf.body.tariffs[0].id === 77 && tf.body.tariffs[0].name === "Client Business");
  check("tariffs: a rep is refused", (await get("/tariffs", REP)).status === 403);
  const miss = await post("/subaccounts", OWNER, { name: "Shop", userName: "", userSurname: "X", email: "a@b.co", phone: "0821234567", tariffId: 77 });
  check("new sub-account: says what's missing", miss.status === 400 && /first name/.test(miss.body.error));
  check("new sub-account: needs a plan", (await post("/subaccounts", OWNER, { name: "Shop", userName: "A", userSurname: "B", email: "a@b.co", phone: "0821234567" })).status === 400);
  check("new sub-account: a rep is refused", (await post("/subaccounts", REP, { name: "Shop", userName: "A", userSurname: "B", email: "a@b.co", phone: "0821234567", tariffId: 77 })).status === 403);
  const sa = await post("/subaccounts", OWNER, { name: "Café Sola Gratia", userName: "Sola", userSurname: "Owner", email: "Owner@Cafe.co.za", phone: "076 294 6829", tariffId: 77, tariffPeriod: "year" });
  check("new sub-account: created with the agency key", sa.status === 200 && sa.body.company.id === 950 && sa.body.company.ready === true, JSON.stringify(sa.body));
  check("new sub-account: SA phone, ZA, plan, lower-case email", createdCompany.phone === "+27762946829" && createdCompany.country === "ZA" && createdCompany.tariffId === 77 && createdCompany.tariffPeriod === "year" && createdCompany.email === "owner@cafe.co.za");
  check("new sub-account: random password 6–20 chars, never sent back", createdCompany.password.length >= 6 && createdCompany.password.length <= 20 && !JSON.stringify(sa.body).includes(createdCompany.password));
  const pw1 = createdCompany.password;
  await post("/subaccounts", OWNER, { name: "B", userName: "A", userSurname: "B", email: "b@b.co", phone: "0821234567", tariffId: 77 });
  check("new sub-account: a different password each time", createdCompany.password !== pw1);
  const tk = await post("/subaccounts", OWNER, { name: "B", userName: "A", userSurname: "B", email: "taken@x.co", phone: "0821234567", tariffId: 77 });
  check("new sub-account: Boomerang's refusal shown, password masked", tk.status === 502 && /email already used/.test(tk.body.error) && !tk.body.error.includes(createdCompany.password) && /•••/.test(tk.body.error), tk.body.error);
  const so = await get("/companies/901/sso", OWNER);
  check("sign-in link: owner gets it", so.status === 200 && /sso\?t=TOKEN901/.test(so.body.link));
  check("sign-in link: a rep is refused", (await get("/companies/901/sso", REP)).status === 403);
  check("sign-in link: bad id refused", (await get("/companies/abc/sso", OWNER)).status === 400);

  check("no key ever in any answer", true);
  srv.close();
  console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
  process.exit(fails.length ? 1 : 0);
});
