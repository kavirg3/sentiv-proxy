// Existing Sentiv clients — do not call. COPY of the Hub's
// "Sentiv Hub Dev/edge-functions/lead-feed/clients.js" (Hub v253), CommonJS for the proxy.
// Keep the three copies (Hub, lead feed, here) identical: test-client-block.js pins the
// fingerprints the Hub makes, so a drift here fails the test.

// cyrb53 — a fast 53-bit string hash. Not a secret: it stops the list being read, not
// a guess at one company being checked (the Hub answers that question anyway).
function clHash(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const CL_LEGAL = /\b(pty|ltd|limited|proprietary|incorporated|inc|cc|npc|soc|plc|llc|co|company|the)\b/g;
const CL_GENERIC = /\b(security|securities|services|service|solutions|group|holdings|south africa|sa|za|africa|international|enterprises|trading|and)\b/g;
// A company name, as one or more keys ("ABC t/a XYZ Guarding" gives both names).
function clNameKeys(name) {
  const out = [];
  String(name || "").split(/\bt\s*\/\s*a\b|\btrading\s+as\b/i).forEach((part) => {
    const full = part.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(CL_LEGAL, " ").replace(/\s+/g, " ").trim();
    const core = full.replace(CL_GENERIC, " ").replace(/\s+/g, " ").trim();
    const key = (core.replace(/ /g, "").length >= 4 ? core : full).replace(/ /g, "");
    if (key.length >= 3 && !out.includes(key)) out.push(key);
  });
  return out;
}
// Every SA number in a cell, as its last nine digits (082…, +27 82…, 27 82… all match).
function clPhoneKeys(raw) {
  const out = [];
  String(raw || "").split(/[\/,;|]|\bor\b|\band\b/i).forEach((p) => {
    let d = p.replace(/\D/g, "");
    if (d.startsWith("0027")) d = d.slice(4);
    if (d.length < 9 || d.length > 12) return;
    const k = d.slice(-9);
    if (!out.includes(k)) out.push(k);
  });
  return out;
}
const CL_FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|protonmail|proton|mweb|telkomsa|vodamail|webmail|iafrica|absamail|lantic|wol|polka|netactive|cybersmart|axxess|afrihost|xsinet|mtnloaded|vodacom|cellc)\./;
const CL_NOT_A_SITE = /^(facebook|fb|instagram|linkedin|twitter|x|google|maps|goo|wa|youtube|tiktok|yellowpages|bizcommunity|brabys|sayellow|cylex)\./;
// A web domain from an email address or a website, never a free mailbox or a social page.
function clDomainKeys(raw) {
  const out = [];
  String(raw || "").split(/[\s,;|]+/).forEach((p) => {
    let t = p.trim().toLowerCase();
    if (!t) return;
    if (t.includes("@")) t = t.split("@").pop();
    else if (!/[a-z0-9-]+\.[a-z]{2,}/.test(t)) return;
    t = t.replace(/^[a-z]+:\/\//, "").replace(/^www\d?\./, "").split(/[\/?#:]/)[0].replace(/[^a-z0-9.-]/g, "");
    if (!/\.[a-z]{2,}$/.test(t) || CL_FREE_MAIL.test(t) || CL_NOT_A_SITE.test(t)) return;
    if (!out.includes(t)) out.push(t);
  });
  return out;
}
const clFp = (salt, kind, v) => clHash(`${salt}|${kind}:${v}`);
// One client row -> its fingerprints. kind n = name, p = phone, d = domain.
function clRowPrints(salt, row) {
  const out = [];
  (row.names || []).forEach((v) => clNameKeys(v).forEach((k) => out.push(["n", clFp(salt, "n", k)])));
  (row.phones || []).forEach((v) => clPhoneKeys(v).forEach((k) => out.push(["p", clFp(salt, "p", k)])));
  (row.domains || []).forEach((v) => clDomainKeys(v).forEach((k) => out.push(["d", clFp(salt, "d", k)])));
  return out;
}
// The saved list -> a fast lookup. Returns null when there is no list.
function clIndex(saved) {
  if (!saved || !saved.salt || !saved.keys) return null;
  const k = saved.keys;
  return { salt: saved.salt, n: new Set(k.n || []), p: new Set(k.p || []), d: new Set(k.d || []) };
}
// What a lead (or a Google place) offers to match on.
function clLeadParts(l) {
  if (!l) return { names: [], phones: [], domains: [] };
  const people = Array.isArray(l.contacts) ? l.contacts.filter((c) => c && typeof c === "object") : [];
  const extra = Array.isArray(l.extraFields) ? l.extraFields.filter((f) => f && typeof f === "object").map((f) => f.value) : [];
  return {
    names: [l.company, l.name, l.tradingAs].filter(Boolean),
    phones: [l.phone, l.directLine, l.phoneIntl, ...people.map((c) => c.phone), ...extra].filter(Boolean),
    domains: [l.email, l.website, ...people.map((c) => c.email), ...extra].filter(Boolean),
  };
}
// Which way a lead matches the client list: "name" | "phone" | "web" | "" (not a client).
function clMatch(idx, l) {
  if (!idx || !l) return "";
  const parts = clLeadParts(l);
  for (const v of parts.names) for (const k of clNameKeys(v)) if (idx.n.has(clFp(idx.salt, "n", k))) return "name";
  for (const v of parts.phones) for (const k of clPhoneKeys(v)) if (idx.p.has(clFp(idx.salt, "p", k))) return "phone";
  for (const v of parts.domains) for (const k of clDomainKeys(v)) if (idx.d.has(clFp(idx.salt, "d", k))) return "web";
  return "";
}

module.exports = { clHash, clNameKeys, clPhoneKeys, clDomainKeys, clFp, clRowPrints, clIndex, clLeadParts, clMatch };
