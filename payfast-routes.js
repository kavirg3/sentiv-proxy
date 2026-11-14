// ============================================================================
// SENTIV BACKEND — PAYFAST (Digital Rewards invoices)   Hub v322
//
// The Hub raises an invoice on a won Digital Rewards deal (lead.invoices[]). This server
//   1. shows that invoice to the client on a public page with a Pay button,
//   2. signs the PayFast payment (a monthly card subscription the first time, a once-off
//      payment after that), and
//   3. takes PayFast's payment notice (ITN), checks it three ways, writes it to the
//      rw_payments ledger and marks the invoice paid on the deal.
//
// Amounts always come from the invoice saved on the server — never from the link.
//
// ENVIRONMENT
//   PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY, PAYFAST_PASSPHRASE
//                         PayFast → Settings → Integration. A passphrase is REQUIRED for
//                         subscriptions. None of them ever reaches the browser or a log.
//   PAYFAST_SANDBOX=1     optional: use sandbox.payfast.co.za (test money).
//   PUBLIC_URL            optional: this server's public https address (defaults to
//                         RAILWAY_PUBLIC_DOMAIN, then the request's host).
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   deal + settings read, ledger + result write.
//
// Endpoints
//   GET  /api/payfast/health                    public, leaks nothing
//   GET  /api/payfast/i/:leadId/:invId/:key     public invoice page (key = the invoice's secret)
//   POST /api/payfast/itn                       PayFast's notice (signature + PayFast confirm)
//   POST /api/payfast/cancel {leadId}           owner only: stop the monthly card charge
// ============================================================================
const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const env = (k) => (process.env[k] || "").trim();
const cfg = () => ({ id: env("PAYFAST_MERCHANT_ID"), key: env("PAYFAST_MERCHANT_KEY"), pass: env("PAYFAST_PASSPHRASE"), sandbox: /^(1|true|yes)$/i.test(env("PAYFAST_SANDBOX")) });
const configured = () => { const c = cfg(); return !!(c.id && c.key && c.pass); };
const pfHost = () => (cfg().sandbox ? "https://sandbox.payfast.co.za" : "https://www.payfast.co.za");
const SB_URL = () => env("SUPABASE_URL").replace(/\/+$/, "");
const SB_SERVICE = () => env("SUPABASE_SERVICE_KEY");
const svc = (extra = {}) => ({ apikey: SB_SERVICE(), Authorization: `Bearer ${SB_SERVICE()}`, "Content-Type": "application/json", ...extra });
const publicUrl = (req) => (env("PUBLIC_URL") || (env("RAILWAY_PUBLIC_DOMAIN") ? `https://${env("RAILWAY_PUBLIC_DOMAIN")}` : `${req.get("x-forwarded-proto") || req.protocol}://${req.get("host")}`)).replace(/\/+$/, "");

let _fetch = (...a) => fetch(...a);
router._setFetch = (f) => { _fetch = f; };   // tests

// ---- PayFast signing -----------------------------------------------------------
// PHP urlencode(): spaces are "+", hex is upper case, and ! ' ( ) * ~ are encoded too.
const phpEnc = (v) => encodeURIComponent(String(v)).replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, "+");
const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
// Payment form: the fields in the order they are sent, empty ones left out, passphrase last.
function signForm(pairs, pass) {
  const s = pairs.filter(([, v]) => v !== "" && v != null).map(([k, v]) => `${k}=${phpEnc(String(v).trim())}`).join("&");
  return md5(pass ? `${s}&passphrase=${phpEnc(pass.trim())}` : s);
}
// API calls: every header + body value, sorted by name, passphrase included.
function signApi(obj, pass) {
  const all = { ...obj, ...(pass ? { passphrase: pass } : {}) };
  return md5(Object.keys(all).sort().map((k) => `${k}=${phpEnc(all[k])}`).join("&"));
}
// ITN: the posted fields in the order they arrived, up to (not including) `signature`.
function parseItn(raw) {
  const pairs = [];
  String(raw || "").split("&").forEach((part) => {
    if (!part) return;
    const i = part.indexOf("=");
    const k = i < 0 ? part : part.slice(0, i), v = i < 0 ? "" : part.slice(i + 1);
    let dk = k, dv = v;
    try { dk = decodeURIComponent(k.replace(/\+/g, " ")); dv = decodeURIComponent(v.replace(/\+/g, " ")); } catch (_) { /* keep raw */ }
    pairs.push([dk, dv, part]);
  });
  const data = {}; pairs.forEach(([k, v]) => { data[k] = v; });
  const cut = pairs.findIndex(([k]) => k === "signature");
  const before = cut < 0 ? pairs : pairs.slice(0, cut);
  return { data, rebuilt: before.map(([k, v]) => `${k}=${phpEnc(v)}`).join("&"), asSent: before.map((p) => p[2]).join("&") };
}
function itnSignatureOk(parsed, pass) {
  const sig = String(parsed.data.signature || "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(sig)) return false;
  const tail = pass ? `&passphrase=${phpEnc(pass)}` : "";
  return [parsed.rebuilt, parsed.asSent].some((s) => { const m = md5(s + tail); return m.length === sig.length && crypto.timingSafeEqual(Buffer.from(m), Buffer.from(sig)); });
}

// ---- Supabase --------------------------------------------------------------------
async function loadLead(id) {
  if (!SB_URL() || !SB_SERVICE()) return null;
  const r = await _fetch(`${SB_URL()}/rest/v1/leads?id=eq.${encodeURIComponent(id)}&select=id,agent_id,data`, { headers: svc() });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}
async function leadByToken(token) {
  if (!/^[0-9a-f-]{8,60}$/i.test(String(token || ""))) return null;
  const r = await _fetch(`${SB_URL()}/rest/v1/leads?data->billing->sub->>token=eq.${encodeURIComponent(token)}&select=id,agent_id,data&limit=1`, { headers: svc() });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}
async function isOwner(uid) {
  if (!uid || !SB_URL() || !SB_SERVICE()) return false;
  const r = await _fetch(`${SB_URL()}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=role`, { headers: svc() });
  if (!r.ok) return false;
  const rows = await r.json();
  return !!(rows[0] && rows[0].role === "owner");
}
async function sellerSettings() {
  try {
    const r = await _fetch(`${SB_URL()}/rest/v1/team_settings?id=eq.1&select=rwSettings:data->rwSettings,bizNames:data->bizNames`, { headers: svc() });
    if (!r.ok) return {};
    const rows = await r.json();
    const rw = (rows[0] && rows[0].rwSettings) || {};
    return rw && typeof rw.billing === "object" && rw.billing ? rw.billing : {};
  } catch (_) { return {}; }
}
// The ledger: one row per PayFast notice, written only by this server. A row that is
// already there (PayFast repeats a notice until it gets a 200) is left alone.
async function ledgerAdd(row) {
  try {
    const r = await _fetch(`${SB_URL()}/rest/v1/rw_payments?on_conflict=id`, { method: "POST", headers: svc({ Prefer: "resolution=ignore-duplicates,return=minimal" }), body: JSON.stringify(row) });
    return r.ok;
  } catch (_) { return false; }
}
async function ledgerPaidFor(leadId) {
  try {
    const r = await _fetch(`${SB_URL()}/rest/v1/rw_payments?lead_id=eq.${encodeURIComponent(leadId)}&status=eq.COMPLETE&ok=is.true&select=id,invoice_id,amount_gross,at`, { headers: svc() });
    if (!r.ok) return [];
    return (await r.json()) || [];
  } catch (_) { return []; }
}
async function ledgerUp() {
  try { const r = await _fetch(`${SB_URL()}/rest/v1/rw_payments?select=id&limit=1`, { headers: svc() }); return r.ok; } catch (_) { return false; }
}
async function saveLead(row, data) {
  const now = Date.now();
  const r = await _fetch(`${SB_URL()}/rest/v1/leads?id=eq.${encodeURIComponent(row.id)}`, { method: "PATCH", headers: svc({ Prefer: "return=minimal" }), body: JSON.stringify({ data: { ...data, updatedAt: now }, updated_at: new Date(now).toISOString() }) });
  return r.ok;
}

// ---- invoices ----------------------------------------------------------------------
const money = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const rand = (n) => "R" + money(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ").replace(".", ",");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dmy = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "")); return m ? `${m[3]}/${m[2]}/${m[1]}` : ""; };
const todayIso = () => new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);   // SAST
const invoicesOf = (data) => (Array.isArray(data && data.invoices) ? data.invoices.filter((x) => x && x.id) : []);
const invState = (inv) => (inv.voidAt ? "void" : inv.paidAt ? "paid" : inv.due && inv.due < todayIso() ? "overdue" : "due");
const subActive = (data) => !!(data && data.billing && data.billing.sub && data.billing.sub.token && data.billing.sub.status === "active");
// The next monthly charge: the billing day of the month after the invoice's own, moved on
// a month at a time until it is in the future.
function nextBillingDate(inv, day) {
  const d = Math.min(28, Math.max(1, Number(day) || 1));
  const base = /^(\d{4})-(\d{2})/.exec(String(inv.period || inv.date || todayIso()));
  let y = Number(base[1]), m = Number(base[2]);
  const iso = () => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const step = () => { m += 1; if (m > 12) { m = 1; y += 1; } };
  step();
  for (let i = 0; i < 1200 && iso() <= todayIso(); i++) step();
  return iso();
}
// What the Pay button sends to PayFast. Subscription the first time (when the invoice
// carries a monthly amount and no card is on file), once-off otherwise.
function payFields(req, row, inv) {
  const c = cfg(); const lead = row.data; const b = lead.billing || {};
  const page = `${publicUrl(req)}/api/payfast/i/${encodeURIComponent(row.id)}/${encodeURIComponent(inv.id)}/${encodeURIComponent(inv.key)}`;
  const email = String(b.email || lead.email || "").trim();
  const first = String(b.name || lead.contact || "").trim().split(/\s+/)[0] || "";
  const recur = Number(inv.recur) > 0 && b.auto !== false && !subActive(lead) ? Number(inv.recur) : 0;
  const pairs = [
    ["merchant_id", c.id], ["merchant_key", c.key],
    ["return_url", `${page}?paid=1`], ["cancel_url", page], ["notify_url", `${publicUrl(req)}/api/payfast/itn`],
    ["name_first", first.slice(0, 100)],
    ["email_address", /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email.slice(0, 100) : ""],
    ["m_payment_id", inv.id],
    ["amount", money(inv.total)],
    ["item_name", `Invoice ${inv.no || inv.id}`.slice(0, 100)],
    ["item_description", String((inv.lines && inv.lines[0] && inv.lines[0].d) || "").slice(0, 255)],
    ["custom_str1", row.id], ["custom_str2", inv.id],
    ...(recur ? [["subscription_type", "1"], ["billing_date", nextBillingDate(inv, b.day)], ["recurring_amount", money(recur)], ["frequency", "3"], ["cycles", "0"]] : []),
  ].filter(([, v]) => v !== "" && v != null);
  return { pairs: [...pairs, ["signature", signForm(pairs, c.pass)]], recur, next: recur ? pairs.find(([k]) => k === "billing_date")[1] : "" };
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>
:root{--ink:#0f172a;--mute:#64748b;--line:#e2e8f0;--bg:#f1f5f9;--card:#fff;--brand:#6d28d9;--ok:#15803d;--bad:#b91c1c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{font-size:22px;margin:0;letter-spacing:.04em}.top{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
.mute{color:var(--mute)}.small{font-size:13px}.right{text-align:right}.two{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:22px}
table{width:100%;border-collapse:collapse;margin-top:22px}th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);text-align:left;padding:8px 0;border-bottom:1px solid var(--line)}
td{padding:10px 0;border-bottom:1px solid var(--line);vertical-align:top}td.n,th.n{text-align:right;white-space:nowrap}
.tot td{border:0;padding:4px 0}.tot .big td{font-size:18px;font-weight:700;padding-top:10px}
.badge{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.08em;padding:4px 10px;border-radius:999px;border:1px solid currentColor}
.paid{color:var(--ok)}.over{color:var(--bad)}.due{color:var(--brand)}
.pay{margin-top:22px;padding:18px;border-radius:14px;background:#faf5ff;border:1px solid #e9d5ff}
button.go{appearance:none;border:0;border-radius:12px;background:var(--brand);color:#fff;font-size:16px;font-weight:700;padding:14px 22px;cursor:pointer;width:100%}
.bank{margin-top:16px;padding:16px;border-radius:14px;border:1px dashed var(--line)}.bank b{display:inline-block;min-width:130px;font-weight:600}
.note{margin-top:18px;white-space:pre-wrap}.bar{display:flex;justify-content:flex-end;margin:0 0 10px}.bar button{border:1px solid var(--line);background:#fff;border-radius:10px;padding:8px 14px;font-size:13px;cursor:pointer}
.flash{margin:0 0 12px;padding:12px 16px;border-radius:12px;background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46}
@media (max-width:560px){.card{padding:18px}.two{grid-template-columns:1fr}.right{text-align:left}}
@media print{body{background:#fff}.wrap{padding:0}.card{border:0;padding:0}.pay,.bar,.flash{display:none}}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}
const plainPage = (res, status, title, msg) => res.status(status).type("html").send(page(title, `<div class="card"><h1>${esc(title)}</h1><p class="mute">${esc(msg)}</p></div>`));

function invoiceHtml(req, row, inv, seller, state, justPaid) {
  const lead = row.data; const b = lead.billing || {};
  const lines = (Array.isArray(inv.lines) ? inv.lines : []).filter((l) => l && l.d);
  const vatOn = Number(inv.vat) > 0;
  const sellerName = seller.name || "Digital Rewards";
  const addr = (s) => esc(String(s || "").trim()).replace(/\n/g, "<br>");
  const bank = seller.bank && typeof seller.bank === "object" ? seller.bank : {};
  const hasBank = !!(bank.acc && bank.name);
  const badge = state === "paid" ? `<span class="badge paid">PAID${inv.paidAt ? " " + dmy(new Date(inv.paidAt + 2 * 3600e3).toISOString()) : ""}</span>`
    : state === "void" ? `<span class="badge mute">CANCELLED</span>`
    : state === "overdue" ? `<span class="badge over">OVERDUE</span>` : `<span class="badge due">DUE ${esc(dmy(inv.due))}</span>`;
  let pay = "";
  if (state === "due" || state === "overdue") {
    if (configured() && Number(inv.total) > 0) {
      const f = payFields(req, row, inv);
      const what = f.recur
        ? `You pay <b>${rand(inv.total)}</b> now. After that your card is charged <b>${rand(f.recur)}</b> every month, starting ${esc(dmy(f.next))}, until you cancel. You can cancel at any time by telling us.`
        : `You pay <b>${rand(inv.total)}</b> once, by card or instant EFT.`;
      pay = `<div class="pay"><form method="post" action="${pfHost()}/eng/process">${f.pairs.map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}
<button class="go" type="submit">${f.recur ? "Pay and set up monthly card payment" : "Pay now"} · ${rand(inv.total)}</button></form>
<p class="small mute" style="margin:10px 0 0">${what} Payments are handled by Payfast. We never see your card number.</p></div>`;
    }
    if (hasBank) {
      pay += `<div class="bank"><div style="font-weight:700;margin-bottom:6px">${configured() ? "Or pay by EFT" : "Pay by EFT"}</div>
<div><b>Bank</b>${esc(bank.name)}</div><div><b>Account name</b>${esc(bank.holder || sellerName)}</div><div><b>Account number</b>${esc(bank.acc)}</div>
${bank.branch ? `<div><b>Branch code</b>${esc(bank.branch)}</div>` : ""}${bank.type ? `<div><b>Account type</b>${esc(bank.type)}</div>` : ""}
<div><b>Reference</b>${esc(inv.no || inv.id)}</div></div>`;
    }
  }
  return page(`${vatOn ? "Tax invoice" : "Invoice"} ${inv.no || ""} — ${sellerName}`, `
${justPaid && state !== "paid" ? `<div class="flash">Thank you. Payfast is confirming your payment — this page will show PAID in a minute or two.</div>` : ""}
${justPaid && state === "paid" ? `<div class="flash">Thank you — payment received.</div>` : ""}
<div class="bar"><button onclick="window.print()">Print / save as PDF</button></div>
<div class="card">
  <div class="top">
    <div><div style="font-size:18px;font-weight:700">${esc(sellerName)}</div>
      <div class="small mute">${addr(seller.address)}</div>
      ${seller.regNo ? `<div class="small mute">Reg no ${esc(seller.regNo)}</div>` : ""}${seller.vatNo && vatOn ? `<div class="small mute">VAT no ${esc(seller.vatNo)}</div>` : ""}
      ${seller.email ? `<div class="small mute">${esc(seller.email)}</div>` : ""}${seller.phone ? `<div class="small mute">${esc(seller.phone)}</div>` : ""}</div>
    <div class="right"><h1>${vatOn ? "TAX INVOICE" : "INVOICE"}</h1><div style="font-weight:700;margin-top:4px">${esc(inv.no || "")}</div><div style="margin-top:8px">${badge}</div></div>
  </div>
  <div class="two">
    <div><div class="small mute">BILL TO</div><div style="font-weight:700">${esc(lead.company || "")}</div>
      ${b.name || lead.contact ? `<div>${esc(b.name || lead.contact)}</div>` : ""}<div class="small mute">${addr(b.address || lead.address)}</div>${b.vatNo ? `<div class="small mute">VAT no ${esc(b.vatNo)}</div>` : ""}</div>
    <div class="right"><div><span class="mute">Invoice date</span> ${esc(dmy(inv.date))}</div><div><span class="mute">Due date</span> ${esc(dmy(inv.due))}</div></div>
  </div>
  <table><thead><tr><th>Description</th><th class="n">Amount</th></tr></thead><tbody>
  ${lines.map((l) => `<tr><td>${esc(l.d)}</td><td class="n">${rand(l.amt)}</td></tr>`).join("")}
  </tbody></table>
  <table class="tot" style="margin-top:8px"><tbody>
  ${vatOn ? `<tr><td class="n mute">Subtotal</td><td class="n" style="width:140px">${rand(inv.sub)}</td></tr><tr><td class="n mute">VAT ${esc(inv.vatRate || 15)}%</td><td class="n">${rand(inv.vat)}</td></tr>` : ""}
  <tr class="big"><td class="n">Total</td><td class="n" style="width:140px">${rand(inv.total)}</td></tr></tbody></table>
  ${pay}
  ${seller.note ? `<div class="note small mute">${esc(seller.note)}</div>` : ""}
</div>`);
}

// ---- mark an invoice paid on the deal ---------------------------------------------------
// The invoice PayFast named, if it is still open; else the oldest open one (a monthly
// charge repeats the first invoice's id). Returns the invoice id it paid, or null.
function applyPayment(data, pay) {
  const list = invoicesOf(data);
  if (list.some((i) => i.payRef === pay.id)) return { data, paid: list.find((i) => i.payRef === pay.id).id, changed: false };
  const open = list.filter((i) => !i.paidAt && !i.voidAt);
  const target = open.find((i) => i.id === pay.invoiceId) || open.slice().sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))[0] || null;
  if (!target) return { data, paid: null, changed: false };
  const invoices = (data.invoices || []).map((i) => (i && i.id === target.id ? { ...i, paidAt: pay.at, paidVia: "payfast", payRef: pay.id, paidAmount: pay.gross } : i));
  const act = { at: pay.at, type: "note", summary: `Invoice ${target.no || target.id} paid by Payfast — ${rand(pay.gross)}` };
  return { data: { ...data, invoices, activities: [act, ...(Array.isArray(data.activities) ? data.activities : [])] }, paid: target.id, changed: true };
}

// ---- routes -------------------------------------------------------------------------------
// A failed lookup (Supabase or PayFast unreachable) must never take the whole server down:
// an async route that throws is answered here instead.
const safe = (fn, onError) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
  console.warn(`[payfast] ${req.method} ${req.path.split("/").slice(0, 2).join("/")} failed: ${String((e && e.message) || e).slice(0, 200)}`);
  if (!res.headersSent) onError(res);
});
// Do the keys actually work? Two harmless questions to PayFast, asked at most every 10 minutes:
//   auth — the API ping, signed with the merchant ID + passphrase;
//   form — a signed R5 payment form (merchant ID + key + passphrase). PayFast answers with a
//          redirect to its pay page when it accepts the signature; nobody is charged.
let _proof = null;
async function keyProof(req) {
  if (_proof && _proof.until > Date.now()) return _proof.out;
  const c = cfg(); const out = { auth: "unreachable", form: "unreachable" };
  try {
    const d = new Date(Date.now() + 2 * 3600e3);
    const headers = { "merchant-id": c.id, version: "v1", timestamp: `${d.toISOString().slice(0, 19)}+0200` };
    headers.signature = signApi(headers, c.pass);
    const r = await _fetch(`https://api.payfast.co.za/ping${c.sandbox ? "?testing=true" : ""}`, { headers });
    out.auth = r.status === 200 ? "accepted" : r.status === 401 || r.status === 400 ? "refused" : `http ${r.status}`;
  } catch (_) { /* unreachable */ }
  try {
    const pairs = [["merchant_id", c.id], ["merchant_key", c.key], ["return_url", `${publicUrl(req)}/health`], ["cancel_url", `${publicUrl(req)}/health`],
      ["m_payment_id", "connection-check"], ["amount", "5.00"], ["item_name", "Connection check"]];
    const body = new URLSearchParams([...pairs, ["signature", signForm(pairs, c.pass)]]);
    const r = await _fetch(`${pfHost()}/eng/process`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, redirect: "manual" });
    out.form = r.status >= 300 && r.status < 400 ? "accepted" : r.status === 400 ? "refused" : `http ${r.status}`;
  } catch (_) { /* unreachable */ }
  const settled = out.auth !== "unreachable" && out.form !== "unreachable";
  _proof = { out, until: Date.now() + (settled ? 10 : 1) * 60e3 };
  return out;
}
router._resetProof = () => { _proof = null; };

router.get("/health", safe(async (req, res) => {
  const c = cfg();
  const proof = configured() ? await keyProof(req) : {};
  res.json({ ok: configured() && proof.auth !== "refused" && proof.form !== "refused", configured: configured(), sandbox: c.sandbox, ledger: SB_URL() && SB_SERVICE() ? await ledgerUp() : false, ...proof,
    ...(configured() ? {} : { error: "PayFast keys are not set on the server yet." }) });
}, (res) => res.json({ ok: false, configured: configured(), sandbox: cfg().sandbox, ledger: false })));

router.get("/i/:leadId/:invId/:key", safe(async (req, res) => {
  res.set("Cache-Control", "no-store"); res.set("X-Robots-Tag", "noindex");
  const row = await loadLead(String(req.params.leadId || ""));
  const inv = row && row.data && row.data.business === "rewards" ? invoicesOf(row.data).find((i) => i.id === req.params.invId) : null;
  const key = String(req.params.key || "");
  const good = inv && inv.key && inv.key.length >= 16 && key.length === inv.key.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(inv.key));
  if (!good) return plainPage(res, 404, "Invoice not found", "This link is not valid any more. Please ask us for a new one.");
  let live = inv;
  // The ledger is the truth: a paid notice that did not reach the deal still shows PAID here.
  if (!inv.paidAt && !inv.voidAt) {
    const paid = (await ledgerPaidFor(row.id)).find((p) => p.invoice_id === inv.id);
    if (paid) live = { ...inv, paidAt: Date.parse(paid.at) || Date.now() };
  }
  res.type("html").send(invoiceHtml(req, row, live, await sellerSettings(), invState(live), req.query.paid === "1"));
}, (res) => plainPage(res, 503, "Please try again", "We couldn't load this invoice just now. Please try again in a minute.")));

router.post("/itn", express.urlencoded({ extended: false, limit: "64kb", verify: (req, _res, buf) => { req.rawBody = buf; } }), safe(async (req, res) => {
  // PayFast only needs a 200 to stop repeating itself; say nothing about why a notice failed.
  const done = (why) => { if (why) console.warn(`[payfast] notice ignored: ${why}`); res.status(200).send("OK"); };
  if (!configured()) return done("keys not set");
  const c = cfg();
  const parsed = parseItn(req.rawBody ? req.rawBody.toString("utf8") : "");
  const d = parsed.data;
  if (!itnSignatureOk(parsed, c.pass)) return done("bad signature");
  if (String(d.merchant_id || "") !== c.id) return done("wrong merchant");
  try {
    const v = await _fetch(`${pfHost()}/eng/query/validate`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: parsed.rebuilt });
    const t = (await v.text()).trim();
    if (!/^VALID/.test(t)) return done("PayFast did not confirm it");
  } catch (e) { return res.status(503).send("retry"); }   // PayFast will send it again

  const pfId = String(d.pf_payment_id || "").trim();
  if (!pfId) return done("no payment id");
  let row = d.custom_str1 ? await loadLead(String(d.custom_str1)) : null;
  if (!row && d.token) row = await leadByToken(d.token);
  if (!row || !row.data || row.data.business !== "rewards") return done("no matching deal");
  const status = String(d.payment_status || "").toUpperCase();
  const gross = Number(d.amount_gross) || 0;
  const at = Date.now();
  let data = row.data; let paidInv = null; let ok = true; let note = "";

  if (status === "COMPLETE") {
    const named = invoicesOf(data).find((i) => i.id === (d.custom_str2 || d.m_payment_id));
    // First payment = the invoice total. A later monthly charge = the agreed monthly amount.
    const first = named && !named.paidAt && !named.voidAt;
    const expect = first ? Number(named.total) : Number((data.billing && data.billing.sub && data.billing.sub.amount) || (named && named.recur) || 0);
    if (expect > 0 && Math.abs(expect - gross) > 0.01) { ok = false; note = `expected ${money(expect)}, got ${money(gross)}`; }
    if (ok) {
      const r = applyPayment(data, { id: pfId, invoiceId: named ? named.id : "", at, gross });
      data = r.data; paidInv = r.paid;
    }
    if (d.token) {
      const prev = (data.billing && data.billing.sub) || {};
      const recur = Number(prev.amount) || Number(named && named.recur) || 0;
      data = { ...data, billing: { ...(data.billing || {}), sub: { ...prev, token: String(d.token), status: "active", since: prev.since || at, amount: recur, lastPaidAt: at, ...(d.billing_date ? { nextDate: String(d.billing_date).slice(0, 10) } : {}) } } };
    }
  } else if (status === "CANCELLED") {
    const prev = (data.billing && data.billing.sub) || {};
    if (prev.token && (!d.token || d.token === prev.token)) data = { ...data, billing: { ...(data.billing || {}), sub: { ...prev, status: "cancelled", cancelledAt: at } } };
  } else { note = `status ${status || "unknown"}`; }

  await ledgerAdd({ id: pfId + (status === "COMPLETE" ? "" : `-${status.toLowerCase()}`), lead_id: row.id, invoice_id: paidInv, m_payment_id: String(d.m_payment_id || ""), status,
    amount_gross: gross, amount_fee: Number(d.amount_fee) || 0, amount_net: Number(d.amount_net) || 0, token: d.token ? String(d.token) : null,
    item_name: String(d.item_name || "").slice(0, 200), billing_date: d.billing_date ? String(d.billing_date).slice(0, 10) : null, ok, note });
  if (data !== row.data) await saveLead(row, data);
  done(ok ? "" : `amount mismatch on ${row.id}: ${note}`);
}, (res) => res.status(503).send("retry")));   // PayFast sends the notice again

router.post("/cancel", safe(async (req, res) => {
  if (!configured()) return res.status(503).json({ error: "PayFast keys are not set on the server yet." });
  if (!(await isOwner(req.sentivUser))) return res.status(403).json({ error: "Only the owner can stop a card payment." });
  const row = await loadLead(String((req.body || {}).leadId || ""));
  if (!row || !row.data) return res.status(404).json({ error: "That deal isn't on the server yet." });
  if (row.agent_id !== req.sentivUser) return res.status(403).json({ error: "You can only change billing on your own deals." });
  const sub = row.data.billing && row.data.billing.sub;
  if (!sub || !sub.token) return res.status(400).json({ error: "This client has no card payment set up." });
  const c = cfg();
  const d = new Date(Date.now() + 2 * 3600e3);
  const headers = { "merchant-id": c.id, version: "v1", timestamp: `${d.toISOString().slice(0, 19)}+0200` };
  headers.signature = signApi(headers, c.pass);
  try {
    const r = await _fetch(`https://api.payfast.co.za/subscriptions/${encodeURIComponent(sub.token)}/cancel${c.sandbox ? "?testing=true" : ""}`, { method: "PUT", headers });
    let body = null; try { body = await r.json(); } catch (_) {}
    if (!r.ok) return res.status(502).json({ error: `PayFast answered ${r.status}${body && body.data && body.data.message ? ` — ${String(body.data.message).slice(0, 200)}` : ""}. Nothing was changed.` });
    const next = { ...sub, status: "cancelled", cancelledAt: Date.now() };
    await saveLead(row, { ...row.data, billing: { ...row.data.billing, sub: next } });
    res.json({ ok: true, sub: next });
  } catch (e) { res.status(502).json({ error: "PayFast could not be reached. Nothing was changed." }); }
}, (res) => res.status(502).json({ error: "The server could not finish that. Nothing was changed." })));

module.exports = router;
Object.assign(module.exports, { signForm, signApi, phpEnc, parseItn, itnSignatureOk, applyPayment, nextBillingDate, payFields });
