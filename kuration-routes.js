// ============================================================================
// SENTIV BACKEND — KURATION ENRICHMENT ROUTES
// Mount into the existing Express proxy, alongside pCloud and WhatsApp:
//
//     const kuration = require("./kuration-routes");
//     app.use("/api/kuration", kuration);   // <-- see MOUNT ORDER below
//
// MOUNT ORDER MATTERS — same trap as the WhatsApp webhook. Kuration signs the RAW
// bytes with HMAC-SHA256. If a global `app.use(express.json())` has already consumed
// the stream, the raw bytes are gone and every signature check fails, which looks
// exactly like a wrong secret. This router uses express.raw() for /webhook itself and
// falls back to req.rawBody, so mounting it BEFORE the global json parser is safest.
//
// ENVIRONMENT
//   KURATION_API_KEY        required — from app.kurationai.com/settings/api.
//                           Sent as the `kur-api-key` header (NOT a Bearer token —
//                           Kuration is unusual here; Bearer silently 401s).
//   KURATION_PROJECT_ID     required — the project rows get written into. Get it from
//                           GET /api/kuration/projects once the key is set.
//   KURATION_WEBHOOK_SECRET required for /webhook — HMAC secret from Kuration's
//                           Webhooks settings page. Without it every POST is rejected:
//                           an unsigned public webhook lets anyone write into your CRM.
//   SUPABASE_URL            required for /webhook — https://<ref>.supabase.co
//   SUPABASE_SERVICE_KEY    required for /webhook — service-role key. SERVER ONLY.
//   KURATION_ALLOW_UNSIGNED optional — "1" to skip signature checks. LOCAL DEV ONLY.
//
// WHY A PROXY AT ALL: the API key is account-wide and spends real credits. In the
// browser, any agent (or anyone with devtools) could drain the 60k bank in an
// afternoon. Here it stays server-side and only the narrow verbs below are exposed.
//
// A NOTE ON WEBHOOKS THAT COST ME AN HOUR TO GET RIGHT:
// Kuration fires ONE webhook PER CELL (`tool_output_ready` carries a single col_id
// and value), not one per row. A row with eight enrichment columns produces eight
// POSTs, in no guaranteed order. So the receiver ACCUMULATES cells into
// kuration_cells and the frontend decides when a row is "done enough" to merge.
// Treating a webhook as "the row is finished" gives you leads with one field filled.
//
// Endpoints
//   GET  /api/kuration/health            config check, leaks no secrets
//   GET  /api/kuration/projects          list projects (to find your project id)
//   GET  /api/kuration/projects/:id      column schema + sample row
//   POST /api/kuration/rows              batch submit companies -> row_ids
//   POST /api/kuration/rows/status       batch poll -> enriched cells per row
//   POST /api/kuration/webhook           signed per-cell results -> Supabase
// ============================================================================

const express = require("express");
const crypto = require("crypto");

const router = express.Router();

const API = "https://api.kurationai.com/api/enterprise";
const KEY = process.env.KURATION_API_KEY || "";
const PROJECT = process.env.KURATION_PROJECT_ID || "";
const WEBHOOK_SECRET = process.env.KURATION_WEBHOOK_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const ALLOW_UNSIGNED = process.env.KURATION_ALLOW_UNSIGNED === "1";
// Server-side spend ceiling for a single builder run (v48). The browser asks for a
// row count; this is what actually gets sent. Raise it deliberately, not by accident.
const MAX_SWEEP_ROWS = parseInt(process.env.KURATION_MAX_SWEEP_ROWS || "100", 10) || 100;

// Submitting a row is the only call that spends credits, so it is the only one worth
// rate-limiting and counting. These counters are process-local and reset on redeploy —
// they are a smoke alarm ("did something just submit 4,000 rows?"), not accounting.
const stats = { submitted: 0, webhooks: 0, rejected: 0, lastSubmitAt: null, lastWebhookAt: null };

// Kuration has no published per-minute limit. This ceiling exists to make a runaway
// loop in the frontend cost you 60 credits instead of 6,000.
const MAX_ROWS_PER_REQUEST = 50;

function need(res) {
  if (!KEY) { res.status(500).json({ error: "Kuration not configured — set KURATION_API_KEY" }); return false; }
  return true;
}

async function kur(path, { method = "GET", body, project } = {}) {
  const pid = project || PROJECT;
  const url = `${API}${path.replace(":project", pid)}`;
  const r = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      "kur-api-key": KEY,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let d;
  try { d = text ? JSON.parse(text) : {}; } catch (e) { d = { raw: text }; }
  if (!r.ok) {
    const msg = d.error || d.message || d.detail || `Kuration ${r.status}`;
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.status = r.status;
    throw err;
  }
  return d;
}

// Kuration returns each field as { name, value, status, is_loading } KEYED BY col_id
// (a UUID), not by column name. The browser matches on human column names, so re-key
// here. Keying the browser payload by UUID silently maps nothing — every field arrives
// and none of it lands, which looks like "Kuration returned no data".
function slimCompany(company) {
  const out = {};
  let pending = 0;
  Object.entries(company || {}).forEach(([k, v]) => {
    if (v && typeof v === "object" && "value" in v) {
      const key = v.name && String(v.name).trim() ? String(v.name).trim() : k;
      out[key] = { value: v.value == null ? "" : v.value, status: v.status || "", loading: !!v.is_loading, col_id: k };
      if (v.is_loading) pending++;
    } else {
      out[k] = { value: v == null ? "" : v, status: "", loading: false, col_id: k };
    }
  });
  return { fields: out, pending };
}

// ---------------------------------------------------------------- schema resolution
// Submitting a row requires EVERY required column, keyed by col_id — names are rejected
// with "Missing required columns". Column ids are per-project UUIDs, so they cannot be
// hard-coded without breaking the moment the project is edited. Fetch and cache instead.
const SCHEMA_TTL_MS = 10 * 60 * 1000;
let schemaCache = { at: 0, project: "", cols: null };

const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

async function schemaFor(project) {
  if (schemaCache.cols && schemaCache.project === project && Date.now() - schemaCache.at < SCHEMA_TTL_MS) {
    return schemaCache.cols;
  }
  const d = await kur(`/projects/${encodeURIComponent(project)}`, { project });
  const cols = Array.isArray(d && d.columns) ? d.columns : [];
  schemaCache = { at: Date.now(), project, cols };
  return cols;
}

// Find the column a value belongs in, and return its NAME — the submit endpoint keys on
// column names, not ids. We know this empirically, not from docs: submitting by name
// produced a "missing columns" list that omitted company_name (i.e. it was recognised),
// while submitting the same row keyed by col_id came back with EVERY column missing.
// Exact normalised name first, then substring, so "company_name" beats "Extracted
// Company Phone Number From Company Name" — which contains the string "company_name"
// and would otherwise swallow the company field.
function findCol(cols, aliases) {
  for (const a of aliases) {
    const hit = cols.find((c) => norm(c.name) === a);
    if (hit) return hit.name;
  }
  for (const a of [...aliases].sort((x, y) => y.length - x.length)) {
    const hit = cols.find((c) => norm(c.name).includes(a));
    if (hit) return hit.name;
  }
  return null;
}

// Values for the system_* columns Kuration marks required. It accepts free text here —
// these are provenance labels, not validated enums. Anything required that we do not
// recognise is sent as an empty string rather than omitted, because omission is what
// triggers the 400.
function systemValue(colId, nowIso) {
  switch (colId) {
    case "system_row_source": return process.env.KURATION_ROW_SOURCE || "Sentiv Sales Hub";
    case "system_row_discovered_by": return process.env.KURATION_ROW_ACTOR || "sentiv-sales-hub";
    case "system_row_discovered_at":
    case "system_row_updated_at": return nowIso;
    default: return "";
  }
}

// ---------------------------------------------------------------- health
// Bump this string whenever this file changes. It is the only reliable way to tell
// "my fix is live" from "I am still looking at the previous deploy" — a distinction
// that has already cost hours on this project once.
const CODE_VERSION = "v42.2-names";

router.get("/health", (_req, res) => {
  res.json({
    ok: !!KEY && !!PROJECT,
    codeVersion: CODE_VERSION,
    apiKey: KEY ? "set" : "MISSING",
    projectId: PROJECT ? "set" : "MISSING",
    webhookSecret: WEBHOOK_SECRET ? "set" : "MISSING (webhook will reject everything)",
    supabase: SUPABASE_URL && SERVICE_KEY ? "set" : "MISSING (webhook cannot persist)",
    allowUnsigned: ALLOW_UNSIGNED,
    stats,
  });
});

// ---------------------------------------------------------------- projects
router.get("/projects", async (_req, res) => {
  if (!need(res)) return;
  try { res.json(await kur("/projects")); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

router.get("/projects/:id", async (req, res) => {
  if (!need(res)) return;
  try { res.json(await kur(`/projects/${encodeURIComponent(req.params.id)}`)); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// ---------------------------------------------------------------- submit (SPENDS CREDITS)
// Body: { companies: [{ company_name, website }], project?: "<id>" }
// Returns one result per input, in the same order, each { company_name, row_id|error }.
// Partial success is normal and must not fail the whole batch: if row 7 of 10 is
// rejected, the other nine are already enriching and you have been charged for them.
router.post("/rows", express.json({ limit: "1mb" }), async (req, res) => {
  if (!need(res)) return;
  const project = req.body && req.body.project ? String(req.body.project) : PROJECT;
  if (!project) return res.status(500).json({ error: "No project — set KURATION_PROJECT_ID or pass project" });

  const list = Array.isArray(req.body && req.body.companies) ? req.body.companies : [];
  if (!list.length) return res.status(400).json({ error: "companies[] required" });
  if (list.length > MAX_ROWS_PER_REQUEST) {
    return res.status(400).json({ error: `Too many rows (${list.length}). Max ${MAX_ROWS_PER_REQUEST} per request — this ceiling protects your credit balance.` });
  }

  // Resolve the project's column ids once for the whole batch. If this fails the batch
  // fails as a unit — better than firing 50 requests that will each 400 identically.
  let cols;
  try {
    cols = await schemaFor(project);
  } catch (e) {
    return res.status(e.status || 502).json({ error: `could not read project schema: ${e.message}` });
  }
  const nameCol = findCol(cols, ["company_name", "company", "name", "legal_name"]);
  const siteCol = findCol(cols, ["website", "domain", "url", "company_website"]);
  if (!nameCol) {
    return res.status(500).json({ error: "project has no company-name column — check KURATION_PROJECT_ID points at the lead-enrichment project" });
  }
  const required = cols.filter((c) => c && c.required && c.col_id);

  const out = [];
  for (const c of list) {
    const name = String((c && (c.company_name || c.company)) || "").trim();
    if (!name) { out.push({ company_name: "", error: "missing company_name" }); continue; }

    const nowIso = new Date().toISOString();
    const company = {};
    // Every required column must be present, keyed by column NAME. Fill the system ones
    // first, then overwrite the two we actually have real data for. Note website is sent
    // even when blank: omitting a required column is what triggers the 400, and a lead
    // with no website is common.
    required.forEach((col) => { company[col.name] = systemValue(col.col_id, nowIso); });
    company[nameCol] = name;
    if (siteCol) company[siteCol] = c.website ? String(c.website).trim() : "";

    try {
      const d = await kur("/projects/:project/rows", { method: "POST", body: { company }, project });
      if (d && d.row_id) { stats.submitted++; stats.lastSubmitAt = new Date().toISOString(); }
      out.push({ company_name: name, row_id: d && d.row_id ? d.row_id : null, error: (d && d.error_detail) || (d && d.row_id ? null : "no row_id returned") });
    } catch (e) {
      out.push({ company_name: name, row_id: null, error: e.message });
    }
  }
  res.json({ project, results: out, submitted: out.filter((r) => r.row_id).length });
});

// ---------------------------------------------------------------- poll
// Body: { rows: ["rowid", ...], project?: "<id>" }
router.post("/rows/status", express.json({ limit: "256kb" }), async (req, res) => {
  if (!need(res)) return;
  const project = req.body && req.body.project ? String(req.body.project) : PROJECT;
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows.slice(0, MAX_ROWS_PER_REQUEST) : [];
  if (!rows.length) return res.status(400).json({ error: "rows[] required" });

  const out = [];
  for (const rowId of rows) {
    try {
      const d = await kur(`/projects/:project/rows/${encodeURIComponent(rowId)}`, { project });
      const { fields, pending } = slimCompany(d && d.company);
      out.push({ row_id: rowId, done: pending === 0, pending, fields });
    } catch (e) {
      out.push({ row_id: rowId, done: false, pending: 0, error: e.message });
    }
  }
  res.json({ project, rows: out });
});

// ---------------------------------------------------------------- webhook
// One POST PER CELL. Verify, then upsert the cell. Respond fast — Kuration's docs
// give you 5 seconds before it treats the delivery as failed, so persistence errors
// are logged and still answered 200 rather than triggering an endless retry storm.
function verifySig(raw, sig) {
  if (ALLOW_UNSIGNED) return true;
  if (!WEBHOOK_SECRET || !sig) return false;
  const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  const a = Buffer.from(String(sig), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;            // timingSafeEqual throws on length mismatch
  return crypto.timingSafeEqual(a, b);
}

// ============================================================================
// v48 — BUILDER SOURCING
// Until now this proxy only did enrichment: the Hub sent company names and Kuration
// filled in the details. These three routes expose the other half of the product —
// Kuration sourcing the list itself — while keeping the API key server-side.
//
// Discovery is deliberately a separate route from the run. `GET /project-builders`
// returns only the builders THIS account is permitted to run, each with a form_data
// template. The Hub renders whatever comes back rather than hardcoding a list, so a
// plan change or a renamed builder degrades to "no builders available" instead of a
// broken screen.
// ============================================================================

// GET /api/kuration/builders — what can this account actually run?
// Read-only and free: safe to call on every page load.
router.get("/builders", async (_req, res) => {
  if (!KEY) return res.status(400).json({ error: "KURATION_API_KEY not set" });
  try {
    const r = await kur("/project-builders", { method: "GET" });
    // The API returns a bare array here (unlike /projects, which wraps). Normalise so
    // the client never has to care which.
    res.json({ builders: Array.isArray(r) ? r : (r && r.builders) || [] });
  } catch (e) {
    res.status(502).json({ error: e.message || "could not reach Kuration" });
  }
});

// POST /api/kuration/sweeps — create a project from a builder. THIS SPENDS CREDITS.
// The Hub shows the agent a cost estimate and takes a confirmation before calling
// this; the guard here is the second line of defence, not the first.
router.post("/sweeps", express.json({ limit: "256kb" }), async (req, res) => {
  if (!KEY) return res.status(400).json({ error: "KURATION_API_KEY not set" });
  const builderId = req.body && req.body.builder_id;
  const formData = req.body && req.body.form_data;
  if (!builderId || typeof builderId !== "string") return res.status(400).json({ error: "builder_id is required" });
  if (!formData || typeof formData !== "object" || Array.isArray(formData)) return res.status(400).json({ error: "form_data must be an object" });

  // Hard ceiling on max_results. A typo — 500 instead of 50 — is a month of credits
  // gone in one click, and the browser is not a trustworthy place to enforce a spend
  // limit. Clamp here, where the agent cannot reach.
  const capped = { ...formData };
  const n = parseInt(String(capped.max_results != null ? capped.max_results : ""), 10);
  if (isFinite(n)) capped.max_results = Math.max(1, Math.min(n, MAX_SWEEP_ROWS));
  else if ("max_results" in capped) delete capped.max_results;

  try {
    const r = await kur("/projects", {
      method: "POST",
      body: JSON.stringify({ builder_id: builderId, form_data: capped }),
    });
    res.json({ project_id: (r && (r.project_id || r.id)) || null, capped_to: capped.max_results });
  } catch (e) {
    res.status(502).json({ error: e.message || "could not start the sweep" });
  }
});

// GET /api/kuration/sweeps/:id — builder status + row count, for the progress line.
router.get("/sweeps/:id", async (req, res) => {
  if (!KEY) return res.status(400).json({ error: "KURATION_API_KEY not set" });
  try {
    const r = await kur(`/projects/${encodeURIComponent(req.params.id)}`, { method: "GET" });
    res.json({
      builder_status: (r && r.builder_status) || { type: "running", error_message: null },
      row_count: (r && r.row_count) || 0,
      columns: (r && r.columns) || [],
    });
  } catch (e) {
    res.status(502).json({ error: e.message || "could not read the sweep" });
  }
});

// GET /api/kuration/sweeps/:id/rows — the sourced companies.
// page_size is clamped to the API's documented 1-100 range; an out-of-range value is
// a 422 from Kuration, which surfaces to the agent as a meaningless error.
router.get("/sweeps/:id/rows", async (req, res) => {
  if (!KEY) return res.status(400).json({ error: "KURATION_API_KEY not set" });
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const size = Math.max(1, Math.min(100, parseInt(String(req.query.page_size || "100"), 10) || 100));
  try {
    const r = await kur(`/projects/${encodeURIComponent(req.params.id)}/rows?page=${page}&page_size=${size}`, { method: "GET" });
    res.json({
      rows: (r && r.rows) || [],
      page: (r && r.page) || page,
      total_rows: (r && r.total_rows) || 0,
      total_pages: (r && r.total_pages) || 1,
    });
  } catch (e) {
    res.status(502).json({ error: e.message || "could not read the sweep rows" });
  }
});

router.post("/webhook", express.raw({ type: "*/*", limit: "512kb" }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : (req.rawBody || Buffer.from(""));
  const sig = req.get("X-Kuration-Signature") || req.get("x-kuration-signature") || "";
  if (!verifySig(raw, sig)) {
    stats.rejected++;
    return res.status(401).json({ error: "bad signature" });
  }
  let p;
  try { p = JSON.parse(raw.toString("utf8")); } catch (e) { return res.status(400).json({ error: "bad json" }); }

  stats.webhooks++;
  stats.lastWebhookAt = new Date().toISOString();
  res.json({ ok: true });   // answer first, persist after — the 5s budget is tight

  if (!SUPABASE_URL || !SERVICE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/kuration_cells`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        project_id: p.project_id || null,
        row_id: p.row_id || null,
        col_id: p.col_id || null,
        value: p.value == null ? null : String(p.value),
        status: p.status || null,
        received_at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.error("[kuration] webhook persist failed:", e.message);
  }
});

module.exports = router;
// Exported for verify-kuration.mjs. Keeping the signature check testable is the whole
// reason the WhatsApp core lives in its own file — same lesson, smaller surface.
module.exports.__test = { verifySig, slimCompany, MAX_ROWS_PER_REQUEST, findCol, norm, systemValue };
