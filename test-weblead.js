// node test-weblead.js — the Digital Rewards website form route against a fake Supabase.
process.env.SUPABASE_URL = "https://sb.test"; process.env.SUPABASE_SERVICE_KEY = "SVC";
process.env.WEBLEAD_ORIGINS = "https://site.test, https://www.site.test/"; process.env.WEBLEAD_DAILY_CAP = "8";
const express = require("express");
const cors = require("cors");
const router = require("./weblead-routes");
const { buildWebLead, saPhone } = router;
const fails = []; const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); if (!c) fails.push(n); };

let leads = []; let ownerRows = [{ id: "u-owner" }]; let insertStatus = 201; const calls = [];
const J = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
router._setFetch(async (url, opts = {}) => {
  const m = (opts.method || "GET").toUpperCase(); calls.push(`${m} ${url}`);
  if (opts.headers.apikey !== "SVC") return J(401, {});
  if (url.includes("/rest/v1/profiles?id=eq.")) return J(200, url.includes("id=eq.u-owner") ? [{ role: "owner" }] : [{ role: "agent" }]);
  if (url.includes("/rest/v1/profiles")) return J(200, ownerRows);
  if (url.endsWith("/storage/v1/object/list/backups") && m === "POST") return J(200, Object.keys(files).map((name) => ({ name })).concat([{ name: "../evil.json" }]));
  if (url.includes("/storage/v1/object/backups/partner-apps/") && m === "GET") { const f = files[url.split("/").pop()]; return f ? J(200, f) : J(400, {}); }
  if (url.includes("/rest/v1/leads") && m === "GET") {
    const q = decodeURIComponent(url);
    return J(200, leads.filter((l) => q.includes(`"${l.data.email}"`) || q.includes(`"${l.data.phone}"`)).map((l) => ({ id: l.id })));
  }
  if (url.endsWith("/rest/v1/leads") && m === "POST") { if (insertStatus >= 300) return J(insertStatus, { message: "no" }); leads.push(JSON.parse(opts.body)); return J(201, {}); }
  if (url.includes("/storage/v1/object/info/")) return files[url.split("/").pop()] ? J(200, {}) : J(400, { error: "not found" });
  if (url.includes("/storage/v1/object/backups/partner-apps/") && m === "POST") { if (saveStatus >= 300) return J(saveStatus, {}); files[url.split("/").pop()] = JSON.parse(opts.body); return J(200, {}); }
  if (url.includes("/rest/v1/push_subscriptions")) return J(200, url.includes("user_id=eq.u-owner") ? [{ endpoint: "e1", p256dh: "k", auth: "a" }] : []);
  return J(404, {});
});
const files = {}; const FILE = (f) => /^\d{4}-\d{2}-\d{2}-[0-9a-f]{12}\.json$/.test(f); let saveStatus = 200; const pushes = [];
router._setPush(async (subs, p) => { pushes.push({ subs, p }); return subs.length; });
let now = Date.UTC(2026, 10, 15, 21, 30);   // 23:30 SAST on 15 Nov
router._setNow(() => now);

const good = (o = {}) => ({ name: "  Thandi   Mokoena ", business: "Café <b>Sola</b>", type: "Restaurant, café or takeaway", branches: "2", email: "Thandi@Cafe.test", whatsapp: "+27 82 123 4567",
  challenge: "Customers visit once\nand never return", consent: "on", page: "/contact.html", website: "", role: "owner", agent_id: "evil", ...o });

(async () => {
  // ---- pure ----
  check("phone: +27 form", saPhone("+27 82 123 4567") === "082 123 4567");
  check("phone: local form", saPhone("0821234567") === "082 123 4567");
  check("phone: 9 digits", saPhone("821234567") === "082 123 4567");
  check("phone: foreign refused", saPhone("+1 415 555 0100") === "");
  check("phone: junk refused", saPhone("call me") === "");
  const b = buildWebLead(good(), now).lead;
  check("lead is a Digital Rewards lead in stage Lead", b.business === "rewards" && b.stage === "Lead" && b.source === "website");
  check("names are tidied, markup stripped", b.contact === "Thandi Mokoena" && b.company === "Café b Sola /b" && !/[<>]/.test(JSON.stringify(b)));
  check("email lower-cased, phone in Hub format", b.email === "thandi@cafe.test" && b.phone === "082 123 4567");
  check("follow-up is today in SAST", b.followUp === "2026-11-15", b.followUp);
  check("consent recorded with where and when", b.consentBasis === "consent" && b.consentSource.includes("/contact.html") && b.consentSource.includes("15/11/2026"));
  check("goes to the top of the call list, newest first", b.callRank < 0 && buildWebLead(good(), now + 60e3).lead.callRank < b.callRank);
  check("kept for three years", b.retainUntil === "2029-11-15", b.retainUntil);
  check("notes carry branches and challenge on one line", b.notes === "Website enquiry · 2 branches · Challenge: Customers visit once and never return", b.notes);
  check("extra fields from the browser are dropped", !("role" in b) && !("agent_id" in b) && !("website" in b) && !("consent" in b));
  check("long text is cut", buildWebLead(good({ challenge: "x".repeat(5000) }), now).lead.notes.length < 700);
  for (const [n, o] of [["no name", { name: "" }], ["unknown type", { type: "Bank" }], ["0 branches", { branches: 0 }], ["9999 branches", { branches: 9999 }],
    ["bad email", { email: "a@b" }], ["bad phone", { whatsapp: "123" }], ["no consent", { consent: "" }]]) check(`refused: ${n}`, !!buildWebLead(good(o), now).error);
  check("a non-object body is refused", !!buildWebLead("hello", now).error && !!buildWebLead(null, now).error);
  check("a strange page value is dropped", buildWebLead(good({ page: "javascript:alert(1)" }), now).lead.webLead.page === "");

  // ---- over HTTP, mounted the way server.js mounts it ----
  const app = express();
  app.use(express.json({ limit: "2mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use("/api/rewards/web-lead", cors({ origin: (req, cb) => cb(null, router.origins()), methods: ["POST"] }));
  app.use("/api/rewards/partner-apply", cors({ origin: (req, cb) => cb(null, router.origins()), methods: ["POST"] }));
  app.use(cors({ origin: ["https://hub.test"] }));   // the strictest ALLOWED_ORIGINS the server could have
  app.use((req, _res, next) => { const u = req.get("x-test-user"); if (u) req.sentivUser = u; next(); });   // stands in for server.js's sign-in gate
  app.use("/api/rewards", router);
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}/api/rewards`;
  const post = (body, origin = "https://site.test", ip = "1.1.1.1") => fetch(`${base}/web-lead`, { method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}), "x-forwarded-for": `9.9.9.9, ${ip}` }, body: typeof body === "string" ? body : JSON.stringify(body) });

  const pre = await fetch(`${base}/web-lead`, { method: "OPTIONS", headers: { Origin: "https://www.site.test", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
  check("browser pre-check passes for the website", pre.status === 204 && pre.headers.get("access-control-allow-origin") === "https://www.site.test", `${pre.status} ${pre.headers.get("access-control-allow-origin")}`);
  const pre2 = await fetch(`${base}/web-lead`, { method: "OPTIONS", headers: { Origin: "https://evil.test", "Access-Control-Request-Method": "POST" } });
  check("browser pre-check fails for another site", !pre2.headers.get("access-control-allow-origin"));

  let r = await post(good());
  check("a real enquiry is accepted", r.status === 200 && (await r.json()).ok === true, `HTTP ${r.status}`);
  check("the browser may read the answer", r.headers.get("access-control-allow-origin") === "https://site.test");
  check("one lead saved, on the owner's row", leads.length === 1 && leads[0].agent_id === "u-owner" && leads[0].id === leads[0].data.id && leads[0].data.business === "rewards");
  check("saved with a timestamp", leads[0].updated_at === new Date(now).toISOString());

  r = await post(good({ website: "http://spam.example" }), "https://site.test", "2.2.2.2");
  check("a bot (honeypot filled) is thanked and nothing is saved", r.status === 200 && leads.length === 1);
  r = await post(good({ email: "new@shop.test", whatsapp: "0731112222" }), "https://evil.test", "2.2.2.2");
  check("another website is refused", r.status === 403 && leads.length === 1, `HTTP ${r.status}`);
  r = await post(good({ email: "new@shop.test", whatsapp: "0731112222" }), "", "2.2.2.2");
  check("no Origin (a script) is refused", r.status === 403 && leads.length === 1, `HTTP ${r.status}`);
  r = await post(good({ email: "bad" }), "https://site.test", "2.2.2.2");
  check("a bad email is refused with a plain message", r.status === 400 && /email/.test((await r.json()).error) && leads.length === 1);
  r = await post(good({ challenge: "y".repeat(9000) }), "https://site.test", "2.2.2.2");
  check("an oversized post is refused", r.status === 413 && leads.length === 1, `HTTP ${r.status}`);
  r = await post(good(), "https://site.test", "2.2.2.2");
  check("the same person twice in a day saves one lead", r.status === 200 && leads.length === 1);
  r = await post(good({ email: "other@cafe.test" }), "https://site.test", "2.2.2.2");
  check("same number, different email: still one lead", r.status === 200 && leads.length === 1);
  r = await post(good({ email: "second@shop.test", whatsapp: "0731112222", business: "Second Shop" }), "https://www.site.test", "2.2.2.2");
  check("a second business is saved (www origin too)", r.status === 200 && leads.length === 2);

  // limits
  router._resetLimits(); leads = [];
  const uniq = (i) => good({ email: `p${i}@x.test`, whatsapp: `07200000${String(i).padStart(2, "0")}` });
  const st = []; for (let i = 0; i < 7; i++) st.push((await post(uniq(i), "https://site.test", "3.3.3.3")).status);
  check("one address: 5 in ten minutes, then 429", st.join() === "200,200,200,200,200,429,429" && leads.length === 5, st.join());
  r = await fetch(`${base}/web-lead`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://site.test", "x-forwarded-for": "8.8.8.8, 3.3.3.3" }, body: JSON.stringify(uniq(9)) });
  check("a forged first x-forwarded-for entry does not dodge the limit", r.status === 429 && leads.length === 5, `HTTP ${r.status}`);
  const st2 = []; for (let i = 10; i < 16; i++) st2.push((await post(uniq(i), "https://site.test", `4.4.4.${i}`)).status);
  check("daily cap (8 here) stops a flood from many addresses", st2.join() === "200,200,200,429,429,429" && leads.length === 8, st2.join());
  now += 24 * 3600e3;
  r = await post(uniq(30), "https://site.test", "4.4.4.99");
  check("the cap resets the next day", r.status === 200 && leads.length === 9);

  // failures
  router._resetLimits(); insertStatus = 500;
  r = await post(uniq(40), "https://site.test", "5.5.5.5");
  check("a database failure tells the visitor, not 'thanks'", r.status === 502 && /WhatsApp/.test((await r.json()).error));
  insertStatus = 201; ownerRows = []; router._resetLimits();
  r = await post(uniq(41), "https://site.test", "5.5.5.6");
  check("no owner found → not saved, visitor told", r.status === 502);
  ownerRows = [{ id: "u-owner" }];
  r = await post("{not json", "https://site.test", "5.5.5.7");
  check("broken JSON is refused", r.status === 400, `HTTP ${r.status}`);

  // ---- area partner applications ----
  const { buildPartnerApp } = router;
  const pa = (o = {}) => ({ name: " Sipho  Dlamini ", city: "Durban", experience: "1 to 3 years", car: "yes", email: "Sipho@Mail.test", whatsapp: "082 555 1234",
    about: "Sold <b>insurance</b>\nfor two years", consent: "on", suburb: " Umhlanga ", work: "Part-time job", hours: "10 to 20 hours", laptop: "yes",
    languages: ["English", "isiZulu", "Klingon"], heard: "LinkedIn", linkedin: "linkedin.com/in/sipho", page: "/area-partners", website: "", business: "rewards", stage: "Won", ...o });
  const A = buildPartnerApp(pa(), now).app;
  check("partner: fields tidied, markup stripped", A.name === "Sipho Dlamini" && A.email === "sipho@mail.test" && A.phone === "082 555 1234" && A.car === true && !/[<>]/.test(JSON.stringify(A)));
  check("partner: never looks like a lead", !("business" in A) && !("stage" in A) && !("website" in A));
  check("partner: consent recorded", A.consent.includes("/area-partners"));
  for (const [n, o] of [["no name", { name: "" }], ["other city", { city: "Cape Town" }], ["unknown experience", { experience: "lots" }], ["no transport answer", { car: "" }],
    ["bad email", { email: "x" }], ["bad phone", { whatsapp: "12" }], ["no consent", { consent: "" }]]) check(`partner refused: ${n}`, !!buildPartnerApp(pa(o), now).error);
  check("partner: new fields kept", A.suburb === "Umhlanga" && A.work === "Part-time job" && A.hours === "10 to 20 hours" && A.laptop === true && A.heard === "LinkedIn" && A.status === "New");
  check("partner: only known languages", JSON.stringify(A.languages) === '["English","isiZulu"]', JSON.stringify(A.languages));
  check("partner: LinkedIn link gets https", A.linkedin === "https://linkedin.com/in/sipho", A.linkedin);
  check("partner: languages as a comma string work", buildPartnerApp(pa({ languages: "Afrikaans,English" }), now).app.languages.length === 2);
  for (const [n, o] of [["no suburb", { suburb: "" }], ["unknown work", { work: "astronaut" }], ["unknown hours", { hours: "all" }], ["no laptop answer", { laptop: "" }],
    ["no language", { languages: [] }], ["unknown heard", { heard: "TV" }], ["not a LinkedIn link", { linkedin: "https://evil.test/x" }]]) check(`partner refused: ${n}`, !!buildPartnerApp(pa(o), now).error);
  check("partner: LinkedIn is optional", !buildPartnerApp(pa({ linkedin: "" }), now).error);
  check("partner: 'no' transport is kept as false", buildPartnerApp(pa({ car: "no" }), now).app.car === false);

  router._resetLimits(); leads = [];
  const ppost = (body, origin = "https://site.test", ip = "7.7.7.7") => fetch(`${base}/partner-apply`, { method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}), "x-forwarded-for": ip }, body: JSON.stringify(body) });
  const ppre = await fetch(`${base}/partner-apply`, { method: "OPTIONS", headers: { Origin: "https://site.test", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
  check("partner: browser pre-check passes for the website", ppre.headers.get("access-control-allow-origin") === "https://site.test");
  r = await ppost(pa());
  check("partner: application accepted", r.status === 200 && (await r.json()).ok === true, `HTTP ${r.status}`);
  const saved = Object.values(files);
  check("partner: saved as one file, NOT as a lead", saved.length === 1 && leads.length === 0 && saved[0].city === "Durban");
  check("partner: owner gets one push with name, city and number", pushes.length === 1 && /Sipho Dlamini · Durban/.test(pushes[0].p.title) && pushes[0].p.body.includes("082 555 1234"));
  r = await ppost(pa({ email: "again@mail.test" }));
  check("partner: same number same day = one file, one push", r.status === 200 && Object.keys(files).length === 1 && pushes.length === 1);
  r = await ppost(pa({ whatsapp: "0835551235" }), "https://evil.test");
  check("partner: another website is refused", r.status === 403 && Object.keys(files).length === 1);
  r = await ppost(pa({ whatsapp: "0835551235", website: "spam" }));
  check("partner: honeypot saves nothing", r.status === 200 && Object.keys(files).length === 1);
  r = await ppost(pa({ whatsapp: "0835551235", city: "Pretoria" }));
  check("partner: bad city gets a plain message", r.status === 400 && /city/.test((await r.json()).error));
  saveStatus = 500;
  r = await ppost(pa({ whatsapp: "0835551236" }));
  check("partner: a storage failure tells the visitor", r.status === 502 && /WhatsApp/.test((await r.json()).error) && pushes.length === 1);
  saveStatus = 200;
  check("partner: push names suburb and hours", pushes[0].p.body.includes("Umhlanga") && pushes[0].p.body.includes("10 to 20 hours"), pushes[0].p.body);

  // the owner's Applicants list
  const owner = (path, opts = {}, user = "u-owner") => fetch(`${base}${path}`, { ...opts, headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": user } : {}) } });
  r = await owner("/partner-apps", {}, "");
  check("list: not signed in → 401", r.status === 401);
  r = await owner("/partner-apps", {}, "u-agent");
  check("list: an agent is refused", r.status === 403);
  r = await owner("/partner-apps");
  let lj = await r.json();
  check("list: owner sees the application, junk names skipped", r.status === 200 && lj.apps.length === 1 && lj.apps[0].name === "Sipho Dlamini" && FILE(lj.apps[0].file), JSON.stringify(lj).slice(0, 200));
  const file = lj.apps[0].file;
  r = await owner("/partner-apps/status", { method: "POST", body: JSON.stringify({ file, status: "Interview", note: "Good <b>call</b>" }) });
  let sj = await r.json();
  check("status: saved on the file", r.status === 200 && sj.app.status === "Interview" && files[file].status === "Interview" && files[file].note === "Good b call /b");
  r = await owner("/partner-apps/status", { method: "POST", body: JSON.stringify({ file, status: "Hired!!" }) });
  check("status: unknown status refused", r.status === 400 && files[file].status === "Interview");
  r = await owner("/partner-apps/status", { method: "POST", body: JSON.stringify({ file: "../../leads.json", status: "New" }) });
  check("status: a strange file name is refused", r.status === 400);
  r = await owner("/partner-apps/status", { method: "POST", body: JSON.stringify({ file, status: "Declined" }) }, "u-agent");
  check("status: an agent cannot change it", r.status === 403 && files[file].status === "Interview");
  r = await owner("/partner-apps/status", { method: "POST", body: JSON.stringify({ file, status: "Onboarded", invitedAt: 123 }) });
  check("status: invited time kept", r.status === 200 && files[file].invitedAt === 123 && files[file].status === "Onboarded");

  let h = await (await fetch(`${base}/health`)).json();
  check("health says open, shows no secrets", h.webLead.open === true && h.webLead.origins === 2 && !JSON.stringify(h).includes("SVC") && !JSON.stringify(h).includes("site.test"));
  process.env.WEBLEAD_ORIGINS = "";
  r = await post(uniq(50), "https://site.test", "6.6.6.6");
  check("with no website set the route is shut", r.status === 503);
  h = await (await fetch(`${base}/health`)).json();
  check("health says closed", h.webLead.open === false);

  srv.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join("; ")}` : "\nAll web-lead checks passed.");
  process.exit(fails.length ? 1 : 0);
})();
