// ============================================================================
// SENTIV BACKEND — WHATSAPP INBOUND WEBHOOK
// Mount into the existing Express proxy, ALONGSIDE the pCloud routes:
//
//     const whatsapp = require("./whatsapp-routes");
//     app.use("/api/whatsapp", whatsapp);   // <-- see MOUNT ORDER below
//
// MOUNT ORDER MATTERS. Meta signs the RAW bytes. If a global `app.use(express.json())`
// has already consumed and re-parsed the stream, the raw bytes are gone and every
// signature check fails — which looks identical to a wrong app secret and will cost
// you an afternoon. Either:
//   (a) mount this line BEFORE app.use(express.json()), or
//   (b) keep express.json({ verify: (req,_res,buf)=>{ req.rawBody = buf; } })
// This router does (a) for itself via express.raw(), and falls back to req.rawBody.
//
// ENVIRONMENT
//   WHATSAPP_VERIFY_TOKEN    required — any random string; paste the same value into
//                            Meta → WhatsApp → Configuration → Verify token.
//   WHATSAPP_APP_SECRET      required — Meta App → Settings → Basic → App secret.
//                            Without it every POST is rejected. That is deliberate:
//                            an unsigned public webhook lets anyone write rows into
//                            your CRM.
//   SUPABASE_URL             required — https://elvmpugjxnzajvgvhtzh.supabase.co
//   SUPABASE_SERVICE_KEY     required — service-role key. SERVER ONLY. It bypasses
//                            RLS; wa_inbound has no client INSERT policy on purpose.
//   WHATSAPP_ALLOW_UNSIGNED  optional — "1" to skip signature checks. LOCAL DEV ONLY.
//
// Endpoints
//   GET  /api/whatsapp/webhook   Meta's subscribe handshake (hub.challenge)
//   POST /api/whatsapp/webhook   inbound messages -> public.wa_inbound
//   GET  /api/whatsapp/health    config check, leaks no secrets
// ============================================================================

const express = require("express");
const core = require("./whatsapp-core");

const router = express.Router();

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "";
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const ALLOW_UNSIGNED = process.env.WHATSAPP_ALLOW_UNSIGNED === "1";

// Rolling counters so /health can answer "is anything actually arriving?" without
// a Supabase round-trip. Reset on redeploy; that's fine, they're a pulse not a log.
const stats = { received: 0, stored: 0, duplicates: 0, rejected: 0, lastAt: null, lastError: null };

router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    configured: {
      verify_token: !!VERIFY_TOKEN,
      app_secret: !!APP_SECRET,
      supabase: !!(SUPABASE_URL && SERVICE_KEY),
    },
    allow_unsigned: ALLOW_UNSIGNED,
    stats,
  });
});

// --- Meta subscribe handshake -------------------------------------------------
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    // Must be the bare challenge string, no JSON wrapper, or Meta rejects it.
    return res.status(200).type("text/plain").send(String(challenge == null ? "" : challenge));
  }
  return res.sendStatus(403);
});

// --- Inbound messages ---------------------------------------------------------
// express.raw here so the signature can be checked against the exact bytes.
router.post("/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body)
    ? req.body
    : (req.rawBody || Buffer.from(JSON.stringify(req.body || {})));

  if (!ALLOW_UNSIGNED) {
    const sig = req.get("x-hub-signature-256");
    const v = core.verifySignature(raw, sig, APP_SECRET);
    if (!v.ok) {
      stats.rejected++;
      stats.lastError = `signature:${v.reason}`;
      return res.status(401).json({ error: "bad signature", reason: v.reason });
    }
  }

  // ACK FIRST. Meta gives the webhook a few seconds and retries the whole batch
  // on a timeout or a 5xx — a slow Supabase write would turn one message into
  // four delivery attempts. Dedupe on wamid makes the retry harmless anyway, but
  // there's no reason to invite it.
  res.status(200).json({ ok: true });

  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch (_) {
    stats.rejected++;
    stats.lastError = "bad json";
    return;
  }

  try {
    const rows = core.extractRows(payload);
    if (!rows.length) return; // status receipt or an event we don't capture
    stats.received += rows.length;
    stats.lastAt = new Date().toISOString();

    if (!SUPABASE_URL || !SERVICE_KEY) {
      stats.lastError = "supabase not configured";
      console.error("[whatsapp] dropped %d message(s): SUPABASE_URL/SUPABASE_SERVICE_KEY unset", rows.length);
      return;
    }
    const out = await core.insertRows(rows, { url: SUPABASE_URL, serviceKey: SERVICE_KEY });
    stats.stored += out.inserted;
    stats.duplicates += rows.length - out.inserted;
    // Never log the message body or the sender's number — this log is not a
    // POPIA-safe place for personal data.
    console.log("[whatsapp] %d received, %d stored, %d duplicate", rows.length, out.inserted, rows.length - out.inserted);
  } catch (e) {
    stats.lastError = String((e && e.message) || e).slice(0, 200);
    console.error("[whatsapp] store failed:", stats.lastError);
  }
});

module.exports = router;
module.exports.stats = stats;
