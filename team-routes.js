// Team invites that survive email link-scanners (13 Oct 2026).
//
// Faraad's account (22 Sep 2026) was "accepted" two minutes after the invite went out — by a
// Microsoft cloud link-checker opening the one-time link, not by Faraad. A Supabase invite or
// reset link is spent the moment anything opens it.
//
// So the Hub no longer sends Supabase's link. POST /api/team/invite (owner only) asks Supabase
// for the one-time token WITHOUT emailing it, and hands the owner a Hub link instead:
//     https://sentiv-sales-hub.pages.dev/?join=<token_hash>&jt=invite
// Opening that page spends nothing. The token is only redeemed when the person taps
// "Set up my account" (the Hub then POSTs /auth/v1/verify), and a scanner does not tap.
// The owner sends the link themselves, by WhatsApp or however they like.
//
// New email  → type "invite": creates the account (profile row via the existing trigger),
//              sets their name, and their role if it is "setter".
// Known email → type "recovery": the same link lets them set a (new) password. This is the
//              "Resend" for someone who never got in, or who forgot their password.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (already set for push), PUSH_APP_URL (optional).
const express = require("express");
const router = express.Router();

const SB_URL = () => (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_SERVICE = () => process.env.SUPABASE_SERVICE_KEY || "";
const APP_URL = () => (process.env.PUSH_APP_URL || "https://sentiv-sales-hub.pages.dev").replace(/\/+$/, "");
const PER_DAY = Number(process.env.TEAM_INVITES_PER_DAY) || 40;
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i;

const svc = (extra = {}) => ({ apikey: SB_SERVICE(), Authorization: `Bearer ${SB_SERVICE()}`, "Content-Type": "application/json", ...extra });

async function userFromToken(req) {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token || !SB_URL() || !SB_SERVICE()) return null;
  try {
    const r = await fetch(`${SB_URL()}/auth/v1/user`, { headers: { apikey: SB_SERVICE(), Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch (e) { return null; }
}
async function isOwner(uid) {
  const r = await fetch(`${SB_URL()}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=role`, { headers: svc() });
  if (!r.ok) return false;
  const rows = await r.json();
  return !!(rows[0] && rows[0].role === "owner");
}
async function generateLink(type, email, name) {
  const body = { type, email, redirect_to: APP_URL() };
  if (type === "invite" && name) body.data = { full_name: name };
  const r = await fetch(`${SB_URL()}/auth/v1/admin/generate_link`, { method: "POST", headers: svc(), body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  const hashed = j.hashed_token || (j.properties && j.properties.hashed_token);
  const user = j.user || (j.id ? j : null);
  return { ok: r.ok && !!hashed, status: r.status, hashed, userId: user && user.id, error: j.msg || j.message || j.error_description || j.error || "" };
}

const hits = new Map();
router.post("/invite", async (req, res) => {
  try {
    if (!SB_URL() || !SB_SERVICE()) return res.status(500).json({ error: "Invites aren't set up — SUPABASE_URL / SUPABASE_SERVICE_KEY missing on the server." });
    const me = await userFromToken(req);
    if (!me) return res.status(401).json({ error: "Sign in again." });
    if (!(await isOwner(me.id))) return res.status(403).json({ error: "Only the owner can invite people." });
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    const name = String((req.body && req.body.name) || "").trim().slice(0, 80);
    const role = (req.body && req.body.role) === "setter" ? "setter" : "agent";
    if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ error: "That doesn't look like an email address." });
    const now = Date.now();
    const list = (hits.get(me.id) || []).filter((t) => now - t < 864e5);
    if (list.length >= PER_DAY) return res.status(429).json({ error: "Too many invites today." });
    list.push(now); hits.set(me.id, list);

    // New person first; if the address already has an account, a set-password link instead.
    let type = "invite";
    let g = await generateLink("invite", email, name);
    if (!g.ok && (g.status === 422 || /already|registered|exists/i.test(g.error))) { type = "recovery"; g = await generateLink("recovery", email); }
    if (!g.ok) return res.status(502).json({ error: `Couldn't make the link: ${g.error || g.status}` });

    // A brand-new account: name it, and make it a setter if asked. (Service role: the
    // role-pinning trigger only stops signed-in users changing roles.)
    if (type === "invite" && g.userId) {
      const patch = { ...(name ? { full_name: name } : {}), ...(role === "setter" ? { role: "setter" } : {}) };
      if (Object.keys(patch).length) {
        await fetch(`${SB_URL()}/rest/v1/profiles?id=eq.${encodeURIComponent(g.userId)}`, { method: "PATCH", headers: svc({ Prefer: "return=minimal" }), body: JSON.stringify(patch) }).catch(() => {});
      }
    }
    console.log(`[team] ${type} link made by ${me.id.slice(0, 8)} for ${email.replace(/^(.).*@/, "$1***@")}`);
    res.json({ ok: true, type, existing: type === "recovery", email, link: `${APP_URL()}/?join=${encodeURIComponent(g.hashed)}&jt=${type}` });
  } catch (e) { res.status(502).json({ error: `Invite failed: ${e.message}` }); }
});

module.exports = router;
