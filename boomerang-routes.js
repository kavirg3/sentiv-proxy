// ============================================================================
// SENTIV BACKEND — BOOMERANG (Digital Rewards loyalty cards)
//
// ENVIRONMENT
//   BOOMERANG_API_KEY   the agency account's key (Boomerang → Settings → Integrations).
//                       Sent as `X-API-Key` to https://api.digitalwallet.cards/api/v2.
//                       With an agency key, GET /companies also returns each
//                       sub-account's own key, so cards can be built inside a client's
//                       sub-account. Never returned to the browser, never logged.
//
// Endpoints
//   GET /api/boomerang/health   public, leaks nothing: is the key set, does Boomerang
//                               accept it, how many sub-accounts it can see.
// ============================================================================
const express = require("express");
const router = express.Router();
const BASE = "https://api.digitalwallet.cards/api/v2";
const key = () => (process.env.BOOMERANG_API_KEY || "").trim();

async function bm(path, opts = {}, apiKey = key()) {
  const r = await fetch(BASE + path, { ...opts, headers: { "X-API-Key": apiKey, Accept: "application/json", "Content-Type": "application/json", ...(opts.headers || {}) } });
  let body = null; try { body = await r.json(); } catch (_) {}
  return { status: r.status, ok: r.ok, body };
}

// Cached for a minute: the route is public, so it must not let anyone hammer Boomerang.
let _health = null;
router.get("/health", async (_req, res) => {
  if (!key()) return res.json({ ok: false, keyConfigured: false, error: "BOOMERANG_API_KEY is not set on the server." });
  if (_health && _health.until > Date.now()) return res.json(_health.out);
  let out;
  try {
    const c = await bm("/companies?itemsPerPage=1");
    const meta = (c.body && (c.body.meta || c.body)) || {};
    const total = Number(meta.totalItems ?? meta.total ?? (Array.isArray(c.body && c.body.data) ? c.body.data.length : NaN));
    out = c.ok
      ? { ok: true, keyConfigured: true, status: c.status, subAccounts: Number.isFinite(total) ? total : null }
      : { ok: false, keyConfigured: true, status: c.status, error: c.status === 401 ? "Boomerang refused the key." : c.status === 403 ? "The key works but cannot list sub-accounts." : `Boomerang answered ${c.status}.` };
  } catch (e) { out = { ok: false, keyConfigured: true, error: "Boomerang unreachable." }; }
  _health = { out, until: Date.now() + 60e3 };
  res.json(out);
});

module.exports = router;
module.exports.bm = bm;
