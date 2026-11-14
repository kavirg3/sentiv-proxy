// node test-payfast.js — the PayFast invoice routes against a fake PayFast + Supabase.
process.env.PAYFAST_MERCHANT_ID = "10000100"; process.env.PAYFAST_MERCHANT_KEY = "46f0cd694581a"; process.env.PAYFAST_PASSPHRASE = "jt7NOE43FZPn";
process.env.PAYFAST_SANDBOX = "1"; process.env.PUBLIC_URL = "https://proxy.test";
process.env.SUPABASE_URL = "https://sb.test"; process.env.SUPABASE_SERVICE_KEY = "SVC";
const express = require("express");
const crypto = require("crypto");
const router = require("./payfast-routes");
const { signForm, phpEnc, nextBillingDate } = router;
const fails = []; const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); if (!c) fails.push(n); };
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

const OWNER = "u-owner", REP = "u-rep";
const KEY1 = "a".repeat(32), KEY2 = "b".repeat(32);
const today = new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);
const period = today.slice(0, 7);
const inv = (o) => ({ id: "inv_1", key: KEY1, no: "DR-0001", date: today, due: "2099-01-01", period, lines: [{ d: "Regulars package — this month", amt: 1490 }], sub: 1490, vat: 0, total: 1490, recur: 1490, ...o });
const fresh = () => ({
  profiles: { [OWNER]: "owner", [REP]: "agent" },
  settings: { rwSettings: { billing: { name: "Digital Rewards <b>", address: "1 Main Rd\nKyalami", bank: { name: "FNB", acc: "62000000001", branch: "250655" }, note: "Thank you." } } },
  leads: {
    L1: { id: "L1", agent_id: OWNER, data: { id: "L1", business: "rewards", company: "Café Sola & Sons", contact: "Thandi Mokoena", email: "thandi@cafe.test", billing: { day: 1 }, invoices: [inv()], activities: [], updatedAt: 1 } },
    L2: { id: "L2", agent_id: REP, data: { id: "L2", business: "rewards", company: "Rep Shop", billing: { sub: { token: "tok-rep-0001", status: "active" } }, invoices: [] } },
    L3: { id: "L3", agent_id: OWNER, data: { id: "L3", company: "Sentiv Deal", invoices: [inv({ id: "inv_s", key: KEY2 })] } },
  },
  ledger: [],
});
let db = fresh(); let validateAnswer = "VALID"; let ledgerOn = true; const pfCalls = []; let pingStatus = 200; let formStatus = 302;
const J = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const fakeFetch = async (url, opts = {}) => {
  const m = (opts.method || "GET").toUpperCase();
  if (url.startsWith("https://sb.test/rest/v1/profiles")) { const id = decodeURIComponent(url.match(/id=eq\.([^&]+)/)[1]); return J(200, db.profiles[id] ? [{ role: db.profiles[id] }] : []); }
  if (url.startsWith("https://sb.test/rest/v1/team_settings")) return J(200, [db.settings]);
  if (url.startsWith("https://sb.test/rest/v1/rw_payments")) {
    if (!ledgerOn) return J(404, {});
    if (m === "POST") { const row = JSON.parse(opts.body); if (!db.ledger.some((r) => r.id === row.id)) db.ledger.push({ ...row, at: new Date().toISOString() }); return J(201, null); }
    const lead = (url.match(/lead_id=eq\.([^&]+)/) || [])[1];
    return J(200, db.ledger.filter((r) => (!lead || r.lead_id === decodeURIComponent(lead)) && (!/status=eq\.COMPLETE/.test(url) || r.status === "COMPLETE") && (!/ok=is\.true/.test(url) || r.ok)));
  }
  if (url.startsWith("https://sb.test/rest/v1/leads")) {
    const tok = url.match(/token=eq\.([^&]+)/);
    if (tok) { const hit = Object.values(db.leads).find((l) => l.data.billing && l.data.billing.sub && l.data.billing.sub.token === decodeURIComponent(tok[1])); return J(200, hit ? [JSON.parse(JSON.stringify(hit))] : []); }
    const id = decodeURIComponent(url.match(/id=eq\.([^&]+)/)[1]);
    if (m === "PATCH") { const b = JSON.parse(opts.body); db.leads[id].data = b.data; db.leads[id].updated_at = b.updated_at; return J(204, null); }
    return J(200, db.leads[id] ? [JSON.parse(JSON.stringify(db.leads[id]))] : []);
  }
  if (url.startsWith("https://sandbox.payfast.co.za/eng/query/validate")) { pfCalls.push({ url, body: opts.body }); return J(200, validateAnswer); }
  if (url.startsWith("https://api.payfast.co.za/ping")) return J(pingStatus, "PayFast API");
  if (url.startsWith("https://sandbox.payfast.co.za/eng/process")) return J(formStatus, "");
  if (url.startsWith("https://api.payfast.co.za/subscriptions/")) { pfCalls.push({ url, m, headers: opts.headers }); return /tok-bad/.test(url) ? J(400, { data: { message: "not found" } }) : J(200, { status: "success" }); }
  if (url.startsWith("https://www.payfast.co.za")) { pfCalls.push({ url, live: true }); return J(200, "VALID"); }
  return J(404, {});
};
router._setFetch(fakeFetch);

// A notice the way PayFast posts it: its own field order, PHP-encoded, signed with the passphrase.
function itnBody(fields, pass = "jt7NOE43FZPn") {
  const s = Object.entries(fields).map(([k, v]) => `${k}=${phpEnc(v)}`).join("&");
  return `${s}&signature=${md5(`${s}&passphrase=${phpEnc(pass)}`)}`;
}
const notice = (o = {}) => ({ m_payment_id: "inv_1", pf_payment_id: "1000001", payment_status: "COMPLETE", item_name: "Invoice DR-0001", item_description: "Regulars package — this month",
  amount_gross: "1490.00", amount_fee: "-52.15", amount_net: "1437.85", custom_str1: "L1", custom_str2: "inv_1", name_first: "Thandi", email_address: "thandi@cafe.test", merchant_id: "10000100", ...o });

const app = express(); app.use(express.json());
app.use((req, _res, next) => { req.sentivUser = req.get("x-user"); next(); });
app.use("/api/payfast", router);
const srv = app.listen(0, async () => {
  const base = `http://127.0.0.1:${srv.address().port}/api/payfast`;
  const page = async (p) => { const r = await fetch(base + p); return { status: r.status, html: await r.text() }; };
  const itn = async (body) => { const r = await fetch(base + "/itn", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }); return { status: r.status, text: await r.text() }; };
  const post = async (p, user, body) => { const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...(user ? { "x-user": user } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const field = (html, name) => { const m = html.match(new RegExp(`name="${name}" value="([^"]*)"`)); return m ? m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">") : null; };
  const fieldsIn = (html) => [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], field(html, m[1])]);

  // ---- signing ----
  check("sign: PHP-style encoding (space = +, upper-case hex, ! ' ( ) * ~ encoded)", phpEnc("a b/c:d!'()*~é") === "a+b%2Fc%3Ad%21%27%28%29%2A%7E%C3%A9", phpEnc("a b/c:d!'()*~é"));
  check("sign: fields in order, empty left out, passphrase last", signForm([["merchant_id", "1"], ["name_first", ""], ["amount", "10.00"]], "p w") === md5("merchant_id=1&amount=10.00&passphrase=p+w"));
  { const d = nextBillingDate({ period: "2020-01" }, 31); check("billing date: day capped at 28 and always in the future", /-28$/.test(d) && d > today, d); }
  { const d = nextBillingDate({ period }, 1); const [y, m] = period.split("-").map(Number); const exp = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`; check("billing date: the billing day of the month after the invoice", d === exp, d); }

  // ---- health ----
  const h = await (await fetch(base + "/health")).json();
  check("health: configured, sandbox, ledger up, no key in the answer", h.ok && h.sandbox === true && h.ledger === true && !/46f0cd|jt7NOE|10000100/.test(JSON.stringify(h)), JSON.stringify(h));

  check("health: PayFast accepts the keys (API ping + signed form)", h.auth === "accepted" && h.form === "accepted");
  router._resetProof(); pingStatus = 401; formStatus = 400;
  { const hb = await (await fetch(base + "/health")).json(); check("health: refused keys are reported, ok goes false", hb.ok === false && hb.auth === "refused" && hb.form === "refused" && hb.configured === true, JSON.stringify(hb)); }
  router._resetProof(); pingStatus = 200; formStatus = 302;

  // ---- the invoice page ----
  let p = await page(`/i/L1/inv_1/${KEY1}`);
  check("page: opens with the right key", p.status === 200 && /DR-0001/.test(p.html) && /Caf&#233;|Café Sola &amp; Sons/.test(p.html));
  check("page: seller text is escaped", /Digital Rewards &lt;b&gt;/.test(p.html) && !/Digital Rewards <b>/.test(p.html));
  check("page: shows total, due date and the bank details with the invoice number as reference", /R1 490,00/.test(p.html) && /DUE 01\/01\/2099/.test(p.html) && /62000000001/.test(p.html) && /Reference<\/b>DR-0001/.test(p.html));
  const ff = fieldsIn(p.html);
  const names = ff.map(([k]) => k);
  check("page: pay form posts to the PayFast sandbox", /action="https:\/\/sandbox\.payfast\.co\.za\/eng\/process"/.test(p.html));
  check("page: first payment sets up the monthly card charge", field(p.html, "subscription_type") === "1" && field(p.html, "frequency") === "3" && field(p.html, "cycles") === "0" && field(p.html, "recurring_amount") === "1490.00" && field(p.html, "amount") === "1490.00", names.join(","));
  check("page: tells the client plainly about the monthly charge", /every month/.test(p.html) && /cancel at any time/.test(p.html));
  check("page: notice + return addresses are this server's", field(p.html, "notify_url") === "https://proxy.test/api/payfast/itn" && field(p.html, "return_url") === `https://proxy.test/api/payfast/i/L1/inv_1/${KEY1}?paid=1`);
  check("page: deal + invoice travel with the payment", field(p.html, "custom_str1") === "L1" && field(p.html, "custom_str2") === "inv_1" && field(p.html, "m_payment_id") === "inv_1");
  { const pairs = ff.filter(([k]) => k !== "signature"); check("page: signature matches the fields exactly as sent", field(p.html, "signature") === md5(pairs.map(([k, v]) => `${k}=${phpEnc(v)}`).join("&") + "&passphrase=jt7NOE43FZPn")); }
  check("page: the passphrase is never on the page", !/jt7NOE43FZPn/.test(p.html));
  check("page: wrong key refused", (await page(`/i/L1/inv_1/${KEY2}`)).status === 404);
  check("page: unknown invoice refused", (await page(`/i/L1/inv_9/${KEY1}`)).status === 404);
  check("page: a Sentiv deal has no invoice page", (await page(`/i/L3/inv_s/${KEY2}`)).status === 404);

  // ---- the notice ----
  let r = await itn(itnBody(notice(), "wrong-pass"));
  check("itn: wrong signature changes nothing (still answers 200)", r.status === 200 && !db.leads.L1.data.invoices[0].paidAt && db.ledger.length === 0);
  r = await itn(itnBody(notice({ merchant_id: "999" })));
  check("itn: another merchant's notice changes nothing", !db.leads.L1.data.invoices[0].paidAt && db.ledger.length === 0);
  validateAnswer = "INVALID"; r = await itn(itnBody(notice()));
  check("itn: not confirmed by PayFast → nothing changes", !db.leads.L1.data.invoices[0].paidAt && db.ledger.length === 0);
  validateAnswer = "VALID";
  r = await itn(itnBody(notice({ amount_gross: "14.90" })));
  check("itn: wrong amount is logged but does not pay the invoice", !db.leads.L1.data.invoices[0].paidAt && db.ledger.length === 1 && db.ledger[0].ok === false, JSON.stringify(db.ledger[0]));
  db = fresh();
  r = await itn(itnBody(notice({ token: "dc0521d3-55fe-269b-fa00-b647310d760f", billing_date: "2099-02-01" })));
  let L = db.leads.L1.data;
  check("itn: a good notice marks the invoice paid", r.status === 200 && L.invoices[0].paidAt > 0 && L.invoices[0].paidVia === "payfast" && L.invoices[0].payRef === "1000001");
  check("itn: the card subscription is saved on the deal", L.billing.sub.token === "dc0521d3-55fe-269b-fa00-b647310d760f" && L.billing.sub.status === "active" && L.billing.sub.amount === 1490 && L.billing.sub.nextDate === "2099-02-01" && L.billing.day === 1);
  check("itn: the deal's trail says so and updatedAt moved", /paid by Payfast/.test(L.activities[0].summary) && L.updatedAt > 1 && !!db.leads.L1.updated_at);
  check("itn: ledger row written with fee and net", db.ledger.length === 1 && db.ledger[0].id === "1000001" && db.ledger[0].invoice_id === "inv_1" && db.ledger[0].amount_fee === -52.15 && db.ledger[0].ok === true);
  check("itn: confirmation was asked of the sandbox, not the live site", pfCalls.some((c) => /sandbox\.payfast\.co\.za\/eng\/query\/validate/.test(c.url)) && !pfCalls.some((c) => c.live));
  r = await itn(itnBody(notice({ token: "dc0521d3-55fe-269b-fa00-b647310d760f" })));
  check("itn: the same notice twice pays once", db.ledger.length === 1 && db.leads.L1.data.activities.filter((a) => /paid by Payfast/.test(a.summary)).length === 1);

  p = await page(`/i/L1/inv_1/${KEY1}?paid=1`);
  check("page: now shows PAID and no pay button", /class="badge paid"/.test(p.html) && !/eng\/process/.test(p.html) && /payment received/.test(p.html));

  // next month: PayFast repeats the first invoice's id; the oldest open invoice is paid
  db.leads.L1.data.invoices.push(inv({ id: "inv_2", key: KEY2, no: "DR-0002", date: "2099-02-01" }), inv({ id: "inv_3", key: KEY2, no: "DR-0003", date: "2099-03-01" }));
  r = await itn(itnBody(notice({ pf_payment_id: "1000002", token: "dc0521d3-55fe-269b-fa00-b647310d760f" })));
  L = db.leads.L1.data;
  check("itn: a monthly charge pays the oldest open invoice", L.invoices[1].paidAt > 0 && L.invoices[1].payRef === "1000002" && !L.invoices[2].paidAt && db.ledger[1].invoice_id === "inv_2");
  p = await page(`/i/L1/inv_3/${KEY2}`);
  check("page: with a card on file a later invoice is a once-off payment", /eng\/process/.test(p.html) && field(p.html, "subscription_type") === null && /Pay now/.test(p.html));
  db.leads.L1.data.invoices[2].voidAt = 5;
  r = await itn(itnBody(notice({ pf_payment_id: "1000003", token: "dc0521d3-55fe-269b-fa00-b647310d760f" })));
  check("itn: a charge with no open invoice waits in the ledger for the Hub", db.ledger.length === 3 && db.ledger[2].invoice_id === null && db.ledger[2].ok === true);
  r = await itn(itnBody(notice({ pf_payment_id: "1000004", token: "dc0521d3-55fe-269b-fa00-b647310d760f", custom_str1: "", custom_str2: "", m_payment_id: "" })));
  check("itn: a notice with only the card token still finds the deal", db.ledger.length === 4 && db.ledger[3].lead_id === "L1");
  r = await itn(itnBody(notice({ pf_payment_id: "1000005", payment_status: "CANCELLED", token: "dc0521d3-55fe-269b-fa00-b647310d760f" })));
  check("itn: a cancelled subscription is marked cancelled", db.leads.L1.data.billing.sub.status === "cancelled" && db.ledger[4].status === "CANCELLED");

  // ledger is the truth when the deal write was lost
  db = fresh(); db.ledger.push({ id: "77", lead_id: "L1", invoice_id: "inv_1", status: "COMPLETE", ok: true, amount_gross: 1490, at: new Date().toISOString() });
  p = await page(`/i/L1/inv_1/${KEY1}`);
  check("page: paid in the ledger = PAID on the page even if the deal missed it", /class="badge paid"/.test(p.html) && !/eng\/process/.test(p.html));
  ledgerOn = false; db = fresh();
  r = await itn(itnBody(notice()));
  check("itn: with no ledger table the invoice is still marked paid", db.leads.L1.data.invoices[0].paidAt > 0);
  check("health: reports the missing ledger", (await (await fetch(base + "/health")).json()).ledger === false);
  ledgerOn = true;

  // ---- cancel ----
  db = fresh(); db.leads.L1.data.billing.sub = { token: "tok-good-0001", status: "active" };
  check("cancel: a rep is refused", (await post("/cancel", REP, { leadId: "L1" })).status === 403);
  check("cancel: not on someone else's deal", (await post("/cancel", OWNER, { leadId: "L2" })).status === 403);
  const cz = await post("/cancel", OWNER, { leadId: "L1" });
  const call = pfCalls.filter((c) => /subscriptions\/tok-good-0001\/cancel/.test(c.url)).pop();
  check("cancel: owner stops the card charge", cz.status === 200 && db.leads.L1.data.billing.sub.status === "cancelled" && call && call.m === "PUT" && /testing=true/.test(call.url));
  { const hd = call.headers; const exp = md5(["merchant-id", "passphrase", "timestamp", "version"].map((k) => `${k}=${phpEnc(k === "passphrase" ? "jt7NOE43FZPn" : hd[k])}`).join("&")); check("cancel: API signature is the sorted headers + passphrase", hd.signature === exp && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+0200$/.test(hd.timestamp)); }
  db.leads.L1.data.billing.sub = { token: "tok-bad-0001", status: "active" };
  const cb = await post("/cancel", OWNER, { leadId: "L1" });
  check("cancel: a PayFast refusal changes nothing", cb.status === 502 && db.leads.L1.data.billing.sub.status === "active");

  // ---- Supabase down: answered, never thrown (an unhandled throw would stop the whole server) ----
  db = fresh(); let down = true;
  const upFetch = fakeFetch; router._setFetch(async (url, opts) => { if (down && String(url).startsWith("https://sb.test")) throw new Error("network down"); return upFetch(url, opts); });
  p = await page(`/i/L1/inv_1/${KEY1}`);
  check("outage: the invoice page says try again (503)", p.status === 503 && /try again/i.test(p.html));
  r = await itn(itnBody(notice({ pf_payment_id: "2000001" })));
  check("outage: the notice is refused with 503 so PayFast sends it again", r.status === 503);
  check("outage: cancel answers with an error, not a crash", (await post("/cancel", OWNER, { leadId: "L1" })).status >= 400);
  down = false;
  r = await itn(itnBody(notice({ pf_payment_id: "2000001" })));
  check("outage: the repeat notice then pays the invoice", r.status === 200 && db.leads.L1.data.invoices[0].payRef === "2000001");
  router._setFetch(upFetch);

  // ---- no keys ----
  delete process.env.PAYFAST_PASSPHRASE; db = fresh();
  p = await page(`/i/L1/inv_1/${KEY1}`);
  check("no keys: the invoice still opens, with bank details and no card button", p.status === 200 && !/eng\/process/.test(p.html) && /Pay by EFT/.test(p.html));
  check("no keys: health says not configured", (await (await fetch(base + "/health")).json()).configured === false);

  console.log(`\n${fails.length ? fails.length + " FAILED" : "all passed"}`);
  srv.close(); process.exit(fails.length ? 1 : 0);
});
