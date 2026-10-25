// ============================================================================
// SENTIV BACKEND — BOOMERANG (Digital Rewards loyalty cards)   Hub v266
//
// The Hub's Strategy button: the Hub turns the owner's card strategy into a Boomerang
// template with its own AI call (so the cost lands in Costs), then POSTs it here. This
// server builds it INSIDE the client's own sub-account and writes the result onto the deal.
//
// ENVIRONMENT
//   BOOMERANG_API_KEY     the AGENCY account's key (Boomerang → Settings → Integrations).
//                         Sent as `X-API-Key` to https://api.digitalwallet.cards/api/v2.
//                         The agency's GET /companies also returns each sub-account's own
//                         key; that key is what builds inside the sub-account. No key ever
//                         goes back to the browser or into a log.
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   owner check, lead ownership, result write-back.
//
// Endpoints (owner only, signed in — the global gate in server.js)
//   GET  /api/boomerang/health              public, leaks nothing
//   GET  /api/boomerang/companies           [{id, name}] — the agency's sub-accounts
//   POST /api/boomerang/build               {leadId, companyId, template, summary, logoUrl, requestedAt, templateId?}
//   POST /api/boomerang/activate            {leadId}
// Sub-accounts themselves are created by Kavir in the Boomerang dashboard (they need the
// client's email, a password and a tariff) — deliberately not from here.
// ============================================================================
const express = require("express");
const router = express.Router();
const BASE = "https://api.digitalwallet.cards/api/v2";
const key = () => (process.env.BOOMERANG_API_KEY || "").trim();
const SB_URL = () => (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_SERVICE = () => process.env.SUPABASE_SERVICE_KEY || "";
const svc = (extra = {}) => ({ apikey: SB_SERVICE(), Authorization: `Bearer ${SB_SERVICE()}`, "Content-Type": "application/json", ...extra });

let _fetch = (...a) => fetch(...a);
router._setFetch = (f) => { _fetch = f; };   // tests

async function bm(path, opts = {}, apiKey = key()) {
  const r = await _fetch(BASE + path, { ...opts, headers: { "X-API-Key": apiKey, Accept: "application/json", "Content-Type": "application/json", ...(opts.headers || {}) } });
  let body = null; try { body = await r.json(); } catch (_) {}
  return { status: r.status, ok: r.ok, body };
}
const bmError = (r, what) => {
  const msg = r && r.body && (r.body.message || r.body.error || (r.body.errors && JSON.stringify(r.body.errors)));
  return `${what}: Boomerang answered ${r ? r.status : "nothing"}${msg ? ` — ${String(msg).slice(0, 300)}` : ""}`;
};

// ---- who may call ----------------------------------------------------------
async function isOwner(uid) {
  if (!uid || !SB_URL() || !SB_SERVICE()) return false;
  const r = await _fetch(`${SB_URL()}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=role`, { headers: svc() });
  if (!r.ok) return false;
  const rows = await r.json();
  return !!(rows[0] && rows[0].role === "owner");
}
async function loadLead(id) {
  const r = await _fetch(`${SB_URL()}/rest/v1/leads?id=eq.${encodeURIComponent(id)}&select=id,agent_id,data`, { headers: svc() });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}
// Owner, and the deal is his own Digital Rewards row (the same rule RLS applies to the Hub).
async function guard(req, res, leadId) {
  if (!key()) { res.status(503).json({ error: "The Boomerang key is not set on the server." }); return null; }
  if (!(await isOwner(req.sentivUser))) { res.status(403).json({ error: "Only the owner can build cards." }); return null; }
  if (!leadId) return {};
  const row = await loadLead(leadId);
  if (!row) { res.status(404).json({ error: "That deal isn't on the server yet — wait a few seconds and try again." }); return null; }
  if (row.agent_id !== req.sentivUser) { res.status(403).json({ error: "You can only build cards on your own deals." }); return null; }
  if (!row.data || row.data.business !== "rewards") { res.status(400).json({ error: "Cards are for Digital Rewards deals only." }); return null; }
  return row;
}

// ---- sub-accounts ------------------------------------------------------------
let _companies = null;   // { list: [{id, name, apiKey}], until }
async function companies(force) {
  if (!force && _companies && _companies.until > Date.now()) return _companies.list;
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const r = await bm(`/companies?itemsPerPage=200&page=${page}`);
    if (!r.ok) throw new Error(bmError(r, "Listing sub-accounts"));
    const rows = (r.body && r.body.data) || [];
    rows.forEach((c) => out.push({ id: c.id, name: c.name || `Sub-account ${c.id}`, apiKey: c.apiKey || null }));
    const total = r.body && r.body.meta && r.body.meta.totalItems;
    if (!rows.length || (total != null && out.length >= total)) break;
  }
  _companies = { list: out, until: Date.now() + 5 * 60e3 };
  return out;
}
// "" / "main" = the agency's own account.
async function keyFor(companyId) {
  if (!companyId || companyId === "main") return key();
  let c = (await companies()).find((x) => String(x.id) === String(companyId));
  if (!c) c = (await companies(true)).find((x) => String(x.id) === String(companyId));
  if (!c) throw Object.assign(new Error("That sub-account wasn't found in your Boomerang agency."), { code: 404 });
  if (!c.apiKey) throw Object.assign(new Error(`${c.name} has no API key. Open the sub-account in Boomerang → Settings → Integrations once, then try again.`), { code: 409 });
  return c.apiKey;
}

// ---- template safety -----------------------------------------------------------
// The template comes from the Hub's AI. Only known settings pass, the SA defaults and POPIA
// consent are forced, and images can only come from the logo link fetched here.
const KEEP = ["name", "type", "customFields", "appearance", "mechanics", "description", "usageDescription", "companyName",
  "localization", "expiry", "welcomeBonuses", "referralProgram", "legal", "issuer", "platforms", "installForm", "cardFace", "usefulLinks", "feedbackLinks"];
const TYPES = ["stamp", "cashback", "subscription", "coupon", "discount", "certificate", "membership", "reward"];
function cleanTemplate(t, lead) {
  const src = t && typeof t === "object" ? (t.settings && typeof t.settings === "object" ? { ...t.settings, ...t } : t) : {};
  const out = {};
  KEEP.forEach((k) => { if (src[k] !== undefined) out[k] = src[k]; });
  const company = String((lead && lead.company) || out.companyName || "Client").slice(0, 80);
  out.type = TYPES.includes(out.type) ? out.type : "stamp";
  out.name = `${company} Rewards`;
  out.companyName = company;
  if (out.appearance && typeof out.appearance === "object") {
    const a = {};
    Object.entries(out.appearance).forEach(([k, v]) => { if (!/Base64$/.test(k) && typeof v === "string" && v.length < 40) a[k] = v; });
    out.appearance = a;
  } else out.appearance = {};
  if (!out.appearance.barcodeType) out.appearance.barcodeType = "qr";
  const fields = Array.isArray(out.customFields) ? out.customFields.filter((f) => f && f.name && f.type).map((f) => ({ name: String(f.name).slice(0, 60), type: f.type, required: !!f.required, unique: !!f.unique })) : [];
  if (!fields.some((f) => (f.type === "phone" || f.type === "email") && f.unique)) {
    const ph = fields.find((f) => f.type === "phone");
    if (ph) { ph.unique = true; ph.required = true; } else fields.push({ name: "Phone", type: "phone", required: true, unique: true });
  }
  if (!fields.some((f) => f.type === "FName")) fields.unshift({ name: "First Name", type: "FName", required: true, unique: false });
  out.customFields = fields;
  out.localization = { languageCode: "en", dateFormat: "DD/MM/YYYY", currencyId: 1, decimalSeparator: ",", thousandsSeparator: " ", phoneFormatCountryCode: "za" };
  const consent = `I agree that ${company} may keep my name and number for this loyalty card and send me card updates. I can opt out at any time.`;
  out.legal = { ...(out.legal && typeof out.legal === "object" ? out.legal : {}), privacyPolicy: { visible: true, text: consent, fullText: consent }, consentToProcessing: true };
  return out;
}
const saPhone = (p) => { const d = String(p || "").replace(/\D/g, ""); return d.startsWith("27") ? `+${d}` : d.startsWith("0") && d.length === 10 ? `+27${d.slice(1)}` : d ? `+${d}` : ""; };

async function logoBase64(url) {
  if (!url || !/^https:\/\//i.test(url)) return { note: url ? "Logo skipped: the link must start with https://" : null };
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    const r = await _fetch(url, { signal: ctl.signal, redirect: "follow" });
    clearTimeout(t);
    if (!r.ok) return { note: `Logo skipped: the link answered ${r.status}.` };
    const type = String(r.headers.get("content-type") || "").toLowerCase();
    const buf = Buffer.from(await r.arrayBuffer());
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (!isPng) return { note: `Logo skipped: Boomerang needs a PNG and this link is ${type.split(";")[0] || "not a PNG"}.` };
    if (buf.length > 3 * 1024 * 1024) return { note: "Logo skipped: bigger than 3 MB." };
    return { b64: buf.toString("base64") };
  } catch (e) { return { note: "Logo skipped: couldn't download it." }; }
}

// ---- write the result onto the deal (best effort; the Hub saves it too) -----------
async function writeBack(leadId, patch, requestedAt) {
  try {
    const row = await loadLead(leadId);
    if (!row || !row.data) return false;
    const cs = row.data.cardStrategy || {};
    if (requestedAt != null && cs.requestedAt != null && String(cs.requestedAt) !== String(requestedAt)) return false;   // changed meanwhile
    const now = Date.now();
    const next = { ...cs, ...patch };
    delete next.error;
    if (patch.error) next.error = patch.error;
    const data = { ...row.data, cardStrategy: next, updatedAt: now };
    const r = await _fetch(`${SB_URL()}/rest/v1/leads?id=eq.${encodeURIComponent(leadId)}`, { method: "PATCH", headers: svc({ Prefer: "return=minimal" }), body: JSON.stringify({ data, updated_at: new Date(now).toISOString() }) });
    return r.ok;
  } catch (e) { return false; }
}

// ---- routes ---------------------------------------------------------------------------
let _health = null;
router.get("/health", async (_req, res) => {
  if (!key()) return res.json({ ok: false, keyConfigured: false, error: "BOOMERANG_API_KEY is not set on the server." });
  if (_health && _health.until > Date.now()) return res.json(_health.out);
  let out;
  try {
    const list = await companies(true);
    const withKey = list.filter((c) => c.apiKey);
    // Read-only proof that a sub-account's own key opens its templates (nothing is changed).
    let subKeyWorks = null;
    if (withKey.length) { const t = await bm("/templates?itemsPerPage=1", {}, withKey[0].apiKey); subKeyWorks = t.ok; }
    out = { ok: true, keyConfigured: true, subAccounts: list.length, subAccountsWithKey: withKey.length, subKeyWorks };
  } catch (e) { out = { ok: false, keyConfigured: true, error: String(e.message || e).replace(/X-API-Key[^,]*/gi, "") }; }
  _health = { out, until: Date.now() + 60e3 };
  res.json(out);
});

router.get("/companies", async (req, res) => {
  if (!(await guard(req, res))) return;
  try {
    const list = await companies(req.query.fresh === "1");
    res.json({ companies: list.map((c) => ({ id: c.id, name: c.name, ready: !!c.apiKey })).sort((a, b) => a.name.localeCompare(b.name)) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

router.post("/build", async (req, res) => {
  const b = req.body || {};
  const row = await guard(req, res, b.leadId);
  if (!row) return;
  const lead = row.data;
  const companyId = b.companyId ? String(b.companyId) : "main";
  try {
    const subKey = await keyFor(companyId);
    const tpl = cleanTemplate(b.template, lead);
    if (!tpl.issuer) tpl.issuer = { name: tpl.companyName, email: lead.email || "", phone: saPhone(lead.phone) };
    const notes = [];
    const logo = await logoBase64(String(b.logoUrl || "").trim());
    if (logo.b64) tpl.appearance.logoImageBase64 = logo.b64;
    if (logo.note) notes.push(logo.note);

    // Same deal, same sub-account → update its card. Otherwise reuse a card of the same name
    // in that sub-account before ever creating a second one.
    let existing = null;
    const prev = lead.cardStrategy || {};
    const prevId = b.templateId || (String(prev.companyId || "main") === companyId ? prev.templateId : null);
    if (prevId) { const g = await bm(`/templates/${encodeURIComponent(prevId)}`, {}, subKey); if (g.ok && g.body && g.body.data) existing = g.body.data; }
    if (!existing) {
      const l = await bm(`/templates?itemsPerPage=200`, {}, subKey);
      if (l.ok) existing = ((l.body && l.body.data) || []).find((t) => t && t.name === tpl.name) || null;
    }
    let r;
    if (existing) {
      const patch = { ...tpl }; delete patch.customFields;   // a field list sent here would wipe customers' answers
      if (existing.type && existing.type !== tpl.type) { delete patch.type; delete patch.mechanics; notes.push(`Kept the card type (${existing.type}); a new type needs a new card.`); }
      r = await bm(`/templates/${existing.id}`, { method: "PATCH", body: JSON.stringify(patch) }, subKey);
    } else {
      r = await bm(`/templates`, { method: "POST", body: JSON.stringify(tpl) }, subKey);
    }
    if (!r.ok || !r.body || !r.body.data) throw new Error(bmError(r, existing ? "Updating the card" : "Creating the card"));
    const t = r.body.data;
    const company = companyId === "main" ? { id: "main", name: "Main account" } : ((await companies()).find((c) => String(c.id) === companyId) || { name: "" });
    const summary = [String(b.summary || "").trim(), ...notes].filter(Boolean).join("\n").slice(0, 1200);
    const result = { status: "built", templateId: t.id, templateName: t.name, installLink: t.installLink || "", qrLink: t.qrLink || "",
      companyId, companyName: company.name, summary, builtAt: Date.now(), via: "server" };
    await writeBack(row.id, result, b.requestedAt);
    res.json({ ok: true, updated: !!existing, cardStrategy: result });
  } catch (e) {
    const msg = String(e.message || e).slice(0, 400);
    await writeBack(row.id, { status: "error", error: msg }, b.requestedAt);
    res.status(e.code && e.code < 500 ? e.code : 502).json({ error: msg });
  }
});

router.post("/activate", async (req, res) => {
  const b = req.body || {};
  const row = await guard(req, res, b.leadId);
  if (!row) return;
  const cs = row.data.cardStrategy || {};
  if (!cs.templateId) return res.status(400).json({ error: "Build the card first." });
  try {
    const subKey = await keyFor(cs.companyId || "main");
    const r = await bm(`/templates/${encodeURIComponent(cs.templateId)}/activate`, { method: "POST", body: "{}" }, subKey);
    if (!r.ok) throw new Error(bmError(r, "Switching the card on"));
    const result = { status: "live", liveAt: Date.now() };
    await writeBack(row.id, result, null);
    res.json({ ok: true, cardStrategy: { ...cs, ...result } });
  } catch (e) { res.status(e.code && e.code < 500 ? e.code : 502).json({ error: String(e.message || e).slice(0, 400) }); }
});

module.exports = router;
module.exports.cleanTemplate = cleanTemplate;
