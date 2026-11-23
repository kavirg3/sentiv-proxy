// node test-referral.js — the website's "Refer a business" links (23 Nov 2026) against a fake Supabase.
process.env.SUPABASE_URL = "https://sb.test"; process.env.SUPABASE_SERVICE_KEY = "SVC";
process.env.WEBLEAD_ORIGINS = "https://site.test"; process.env.WEBLEAD_DAILY_CAP = "50";
const express = require("express");
const cors = require("cors");
const router = require("./weblead-routes");
const { buildReferrer, refCode } = router;
const fails = []; const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); if (!c) fails.push(n); };

const files = {}; const leads = []; const pushes = []; let saveStatus = 200;
const J = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
router._setFetch(async (url, opts = {}) => {
  const m = (opts.method || "GET").toUpperCase();
  if (opts.headers.apikey !== "SVC") return J(401, {});
  if (url.includes("/storage/v1/object/backups/referrers/")) {
    const f = url.split("/").pop();
    if (m === "POST") { if (saveStatus >= 300) return J(saveStatus, {}); files[f] = opts.body; return J(200, {}); }
    return files[f] ? J(200, files[f]) : J(400, { error: "not found" });
  }
  if (url.includes("/rest/v1/profiles")) return J(200, [{ id: "u-owner" }]);
  if (url.includes("/rest/v1/leads") && m === "GET") return J(200, []);
  if (url.endsWith("/rest/v1/leads") && m === "POST") { leads.push(JSON.parse(opts.body)); return J(201, {}); }
  if (url.includes("/rest/v1/push_subscriptions")) return J(200, [{ endpoint: "e1", p256dh: "k", auth: "a" }]);
  return J(404, {});
});
router._setPush(async (subs, p) => { pushes.push(p); return subs.length; });
let now = Date.UTC(2026, 10, 23, 10, 0);
router._setNow(() => now);

(async () => {
  // ---- pure ----
  const r = buildReferrer({ name: "  Thandi  M ", whatsapp: "+27 82 123 4567", consent: "on", page: "/refer" }, now).ref;
  check("code is 6 easy characters", /^[A-HJ-NP-Z2-9]{6}$/.test(r.code), r.code);
  check("same number, same code", refCode("082 123 4567") === r.code && buildReferrer({ name: "Other", whatsapp: "0821234567", consent: "on" }, now).ref.code === r.code);
  check("different number, different code", refCode("083 000 0000") !== r.code);
  check("name + phone tidied, consent recorded", r.name === "Thandi M" && r.phone === "082 123 4567" && r.consent.includes("/refer"));
  for (const [n, o] of [["no name", { name: "" }], ["bad phone", { whatsapp: "12" }], ["no consent", { consent: "" }]])
    check(`refused: ${n}`, !!buildReferrer({ name: "Thandi", whatsapp: "0821234567", consent: "on", ...o }, now).error);

  // ---- routes ----
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use("/api/rewards/referrer", cors({ origin: (req, cb) => cb(null, router.origins()), methods: ["POST"] }));
  app.use("/api/rewards", router);
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}/api/rewards`;
  const post = (path, body, origin = "https://site.test", ip = "1.1.1.1") => fetch(`${base}/${path}`, { method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}), "x-forwarded-for": ip }, body: JSON.stringify(body) });

  let res = await post("referrer", { name: "Thandi", whatsapp: "082 123 4567", consent: "on" }, "https://evil.test");
  check("another website is refused", res.status === 403, `HTTP ${res.status}`);
  res = await post("referrer", { name: "Thandi", whatsapp: "082 123 4567", consent: "on", website: "bot" });
  check("honeypot saves nothing", res.status === 200 && Object.keys(files).length === 0);
  res = await post("referrer", { name: "Thandi", whatsapp: "082 123 4567", consent: "" });
  check("missing consent says so", res.status === 400 && /consent/.test((await res.json()).error));
  res = await post("referrer", { name: "Thandi", whatsapp: "082 123 4567", consent: "on", page: "/refer" });
  let j = await res.json();
  check("link made + saved privately", res.status === 200 && j.code === r.code && !!files[`${r.code}.json`], JSON.stringify(j));
  res = await post("referrer", { name: "Someone Else", whatsapp: "0821234567", consent: "on" }, "https://site.test", "2.2.2.2");
  j = await res.json();
  check("same number again: same link, first record kept", j.code === r.code && j.back === true && JSON.parse(files[`${r.code}.json`]).name === "Thandi");
  saveStatus = 500;
  res = await post("referrer", { name: "Sipho", whatsapp: "083 555 0000", consent: "on" }, "https://site.test", "3.3.3.3");
  check("a storage failure tells the visitor", res.status === 502);
  saveStatus = 200;

  const lead = (o = {}) => ({ name: "Owner Person", business: "Sola Café", type: "Restaurant, café or takeaway", branches: 1, email: `o${Math.random()}@cafe.test`,
    whatsapp: "084 111 2222", consent: "on", page: "/", ...o });
  res = await post("web-lead", lead({ ref: r.code.toLowerCase() }), "https://site.test", "4.4.4.4");
  await new Promise((ok) => setTimeout(ok, 30));
  let L = leads[leads.length - 1].data;
  check("referred lead saved", res.status === 200 && L.referral && L.referral.name === "Thandi" && L.referral.phone === "082 123 4567" && L.referral.code === r.code);
  check("notes say who referred + the deal rule", /Referred by Thandi \(082 123 4567, code /.test(L.notes) && /R1,000 off the setup fee/.test(L.notes) && /after 2 months/.test(L.notes), L.notes);
  check("owner push names the referrer", /referred by Thandi/.test(pushes[pushes.length - 1].body), pushes[pushes.length - 1].body);

  res = await post("web-lead", lead({ ref: "ZZZZZZ" }), "https://site.test", "5.5.5.5");
  L = leads[leads.length - 1].data;
  check("unknown code: lead still saves, no referral", res.status === 200 && !L.referral && !/Referred/.test(L.notes));
  res = await post("web-lead", lead({ ref: "../x" }), "https://site.test", "6.6.6.6");
  check("junk code: lead still saves", res.status === 200 && !leads[leads.length - 1].data.referral);
  res = await post("web-lead", lead({ whatsapp: "+27821234567", ref: r.code }), "https://site.test", "7.7.7.7");
  L = leads[leads.length - 1].data;
  check("own link: no referral, noted", res.status === 200 && !L.referral && /own referral link/.test(L.notes), L.notes);
  res = await post("web-lead", lead(), "https://site.test", "8.8.8.8");
  L = leads[leads.length - 1].data;
  check("no code: unchanged", res.status === 200 && !L.referral && !/referr/i.test(L.notes));

  srv.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join("; ")}` : "\nAll referral checks passed.");
  process.exit(fails.length ? 1 : 0);
})();
