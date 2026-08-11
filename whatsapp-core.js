// ============================================================================
// SENTIV BACKEND — WHATSAPP INBOUND, PURE CORE
// Zero dependencies. Everything here is a pure function so it can be tested
// with plain node (see verify-whatsapp.mjs) without booting Express or hitting
// Meta. whatsapp-routes.js is the thin Express wrapper around this file.
// ============================================================================

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Signature verification (Meta Cloud API, X-Hub-Signature-256).
// MUST run against the RAW request bytes. Re-serialising the parsed JSON does
// not round-trip (key order, unicode escaping, whitespace) and will fail on
// perfectly valid payloads — which looks exactly like a wrong app secret.
// ---------------------------------------------------------------------------
function verifySignature(rawBody, header, appSecret) {
  if (!appSecret) return { ok: false, reason: "no_secret" };
  if (!header || typeof header !== "string") return { ok: false, reason: "no_signature" };
  if (!header.startsWith("sha256=")) return { ok: false, reason: "bad_scheme" };
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(buf).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so length-check first.
  if (a.length !== b.length) return { ok: false, reason: "mismatch" };
  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "mismatch" };
}

// ---------------------------------------------------------------------------
// South African MSISDN normalisation → E.164 digits, no plus.
//   082 123 4567      -> 27821234567
//   +27 82 123 4567   -> 27821234567
//   0027821234567     -> 27821234567
//   27821234567       -> 27821234567 (unchanged)
// Anything that isn't recognisably SA is returned digits-only and untouched,
// so international prospects still match on an exact-digits comparison.
// ---------------------------------------------------------------------------
function normalizeMsisdn(input) {
  let d = String(input == null ? "" : input).replace(/\D+/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("27") && d.length === 11) return d;
  if (d.startsWith("0") && d.length === 10) return "27" + d.slice(1);
  if (d.length === 9 && /^[1-8]/.test(d)) return "27" + d; // 821234567, no leading zero
  return d;
}

// Two numbers refer to the same person if their normalised forms match, or if
// one is a suffix of the other by at least 9 digits (covers a lead captured as
// "082 123 4567" vs a WhatsApp id of "27821234567" when normalisation misses).
function samePhone(a, b) {
  const x = normalizeMsisdn(a);
  const y = normalizeMsisdn(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const n = Math.min(x.length, y.length, 9);
  return n >= 9 && x.slice(-n) === y.slice(-n);
}

// ---------------------------------------------------------------------------
// Partner SP-code extraction. Partner kits tell the prospect to quote a code;
// prospects type it every possible way: "SP-4821", "sp 4821", "SP4821",
// "code: sp-4821.". Normalised to upper-case SP-XXXX.
// ---------------------------------------------------------------------------
function parseSpCode(text) {
  if (!text) return null;
  const m = String(text).match(/\bSP[\s\-_.]?([A-Z0-9]{3,10})\b/i);
  if (!m) return null;
  const code = m[1].toUpperCase();
  // Reject an all-letter match that is just an English word after "sp"
  // ("sp please", "sp thanks") — real codes contain at least one digit.
  if (!/\d/.test(code)) return null;
  return "SP-" + code;
}

// ---------------------------------------------------------------------------
// Payload → rows.
// Meta sends one POST containing entry[].changes[].value with EITHER messages
// (real inbound) or statuses (delivery/read receipts). Receipts are noise here
// and are dropped — capturing them would flood the table and mark deals as
// "replied" when all that happened was a tick turning blue.
// ---------------------------------------------------------------------------
const TEXTY = {
  text: (m) => (m.text && m.text.body) || "",
  button: (m) => (m.button && m.button.text) || "",
  interactive: (m) =>
    (m.interactive && ((m.interactive.button_reply && m.interactive.button_reply.title) ||
      (m.interactive.list_reply && m.interactive.list_reply.title))) || "",
  image: (m) => (m.image && m.image.caption) || "",
  video: (m) => (m.video && m.video.caption) || "",
  document: (m) => (m.document && (m.document.caption || m.document.filename)) || "",
  audio: () => "",
  sticker: () => "",
  location: (m) => (m.location && (m.location.name || m.location.address)) || "",
};

const BODY_CAP = 4000; // POPIA + storage: we keep the message, not an essay.

function extractRows(payload) {
  const rows = [];
  const entries = (payload && payload.entry) || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      if (!Array.isArray(value.messages) || !value.messages.length) continue; // statuses/errors
      const names = {};
      for (const c of value.contacts || []) {
        if (c && c.wa_id) names[c.wa_id] = (c.profile && c.profile.name) || null;
      }
      for (const m of value.messages) {
        if (!m || !m.id || !m.from) continue;
        const type = m.type || "text";
        const body = String((TEXTY[type] || (() => ""))(m) || "").slice(0, BODY_CAP);
        const ts = Number(m.timestamp);
        rows.push({
          id: m.id,
          wa_from: normalizeMsisdn(m.from),
          wa_from_raw: String(m.from),
          profile_name: names[m.from] || null,
          body,
          msg_type: type,
          sp_code: parseSpCode(body),
          status: "new",
          received_at: Number.isFinite(ts) && ts > 0
            ? new Date(ts * 1000).toISOString()
            : new Date().toISOString(),
          // Store the single message, never the whole batch: a batch can carry
          // other prospects' numbers, and each row would then hold personal data
          // about people it isn't about. POPIA minimisation, cheaply.
          raw: { message: m, phone_number_id: (value.metadata || {}).phone_number_id || null },
        });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Supabase REST insert with natural-key dedupe. Meta retries a webhook it
// thinks failed, so the SAME wamid arrives more than once as a matter of
// routine; `resolution=ignore-duplicates` makes that a no-op instead of a 409.
// ---------------------------------------------------------------------------
async function insertRows(rows, cfg, fetchImpl) {
  if (!rows.length) return { inserted: 0 };
  const f = fetchImpl || globalThis.fetch;
  const url = `${cfg.url.replace(/\/$/, "")}/rest/v1/wa_inbound?on_conflict=id`;
  const r = await f(url, {
    method: "POST",
    headers: {
      apikey: cfg.serviceKey,
      Authorization: `Bearer ${cfg.serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=representation",
    },
    body: JSON.stringify(rows),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${text.slice(0, 300)}`);
  let back = [];
  try { back = JSON.parse(text); } catch (_) { back = []; }
  return { inserted: Array.isArray(back) ? back.length : 0, received: rows.length };
}

module.exports = {
  verifySignature,
  normalizeMsisdn,
  samePhone,
  parseSpCode,
  extractRows,
  insertRows,
  BODY_CAP,
};
