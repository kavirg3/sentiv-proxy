// Sentiv Sales Hub — backend proxy
// Keeps every API key server-side. The app calls these routes; this service signs
// requests to Euphoria, VBOUT, ManyReach, RepliQ and Anthropic with env-var credentials.
// Deploy: Railway / Fly.io / Render. Node 18+. `npm install && npm start`.
const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json({ limit: "2mb" }));
const rawOrigins = (process.env.ALLOWED_ORIGINS || "*").trim();
const corsOrigin = rawOrigins === "*" ? "*" : rawOrigins.split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);
app.use(cors({ origin: corsOrigin === "*" ? "*" : (origin, cb) => { if (!origin) return cb(null, true); cb(null, corsOrigin.includes(origin.replace(/\/+$/, ""))); } }));
app.options("*", cors());
const need = (res, pairs) => {
  const missing = Object.entries(pairs).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) { res.status(400).json({ error: `missing: ${missing.join(", ")}` }); return true; }
  return false;
};
const envOr400 = (res, name) => {
  if (!process.env[name]) { res.status(500).json({ error: `${name} not configured on the server` }); return null; }
  return process.env[name];
};
const upstream = async (res, url, opts, label) => {
  try {
    const r = await fetch(url, opts);
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
    if (!r.ok) return res.status(502).json({ error: `${label} error ${r.status}`, detail: body });
    res.json(body);
  } catch (e) { res.status(502).json({ error: `${label} unreachable: ${e.message}` }); }
};

app.get("/health", (_req, res) => res.json({ ok: true, service: "sentiv-sales-hub-proxy" }));

// ---- Euphoria click-to-dial: rings the agent's extension, then the client ----
// App sends: { extension, number, company }
app.post("/api/euphoria-originate", async (req, res) => {
  const { extension, number } = req.body || {};
  if (need(res, { extension, number })) return;
  const key = envOr400(res, "EUPHORIA_API_KEY"); if (!key) return;
  const org = envOr400(res, "EUPHORIA_ORG_ID"); if (!org) return;
  await upstream(res, "https://api.euphoria.co.za/api/v1/originate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({ organisation: org, extension: String(extension), destination: String(number).replace(/\s+/g, "") }),
  }, "Euphoria");
});

// ---- VBOUT: add/refresh a contact on a list (partners + nurture) ----
// App sends: { email, firstName, lastName, phone, listId, tags }
app.post("/api/vbout-contact", async (req, res) => {
  const { email, listId } = req.body || {};
  if (need(res, { email, listId })) return;
  const key = envOr400(res, "VBOUT_API_KEY"); if (!key) return;
  const { firstName = "", lastName = "", phone = "", tags = [] } = req.body;
  const params = new URLSearchParams({ key, listid: String(listId), email, status: "1", ipaddress: "" });
  params.append("fields[first_name]", firstName);
  params.append("fields[last_name]", lastName);
  if (phone) params.append("fields[phone]", phone);
  if (tags.length) params.append("tags", tags.join(","));
  await upstream(res, `https://api.vbout.com/1/emailmarketing/addcontact.json?${params}`, { method: "POST" }, "VBOUT");
});

// ---- ManyReach: enroll a prospect into a cold sequence ----
// App sends: { email, firstName, lastName, company, campaignId, customFields }
app.post("/api/manyreach-enroll", async (req, res) => {
  const { email, campaignId } = req.body || {};
  if (need(res, { email, campaignId })) return;
  const key = envOr400(res, "MANYREACH_API_KEY"); if (!key) return;
  const { firstName = "", lastName = "", company = "", customFields = {} } = req.body;
  await upstream(res, `https://app.manyreach.com/api/campaigns/${encodeURIComponent(campaignId)}/prospects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": key },
    body: JSON.stringify({ email, firstName, lastName, company, customFields }),
  }, "ManyReach");
});

// ---- RepliQ: generate a personalized asset / read stats ----
app.post("/api/repliq-generate", async (req, res) => {
  const { website, company } = req.body || {};
  if (need(res, { website, company })) return;
  const key = envOr400(res, "REPLIQ_API_KEY"); if (!key) return;
  const { assetType = "video", firstName = "", lastName = "", vertical = "" } = req.body;
  await upstream(res, "https://api.repliq.co/v1/assets", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({ type: assetType, firstName, lastName, company, websiteUrl: website, meta: { vertical } }),
  }, "RepliQ");
});
app.post("/api/repliq-stats", async (req, res) => {
  const key = envOr400(res, "REPLIQ_API_KEY"); if (!key) return;
  const { assetId } = req.body || {};
  if (need(res, { assetId })) return;
  await upstream(res, `https://api.repliq.co/v1/assets/${encodeURIComponent(assetId)}/stats`, {
    headers: { "Authorization": `Bearer ${key}` },
  }, "RepliQ");
});

// ---- Anthropic passthrough: lets the app run its AI features when hosted
// outside claude.ai. The app falls back to this route automatically. ----
app.post("/api/anthropic", async (req, res) => {
  const key = envOr400(res, "ANTHROPIC_API_KEY"); if (!key) return;
  const body = req.body || {};
  if (need(res, { messages: body.messages })) return;
  body.model = body.model || "claude-sonnet-4-6";
  body.max_tokens = Math.min(Number(body.max_tokens) || 1000, 2000);
  await upstream(res, "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  }, "Anthropic");
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`Sentiv Sales Hub proxy listening on :${port}`));
