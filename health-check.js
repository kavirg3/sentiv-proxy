// Daily live health check for the Sentiv Hub (13 Oct 2026).
//
// Run by .github/workflows/health.yml every morning. Uses only what anyone on the internet
// can see — no passwords, no secrets — because what it guards is exactly what must stay
// shut to the internet, and what must keep working for the team. Any failure exits 1, the
// GitHub run fails, and GitHub emails the repo owner.
//
// Built after one day surfaced five silent failures: phones running offline practice mode,
// the Vault and AI open to anyone, Euphoria call history unreadable, an invite burned by an
// email scanner, and an input that would not take typing. Each would have been caught here.
//
//   node health-check.js            → prints every check, exits 1 if any failed
const HUB = process.env.HUB_URL || "https://sentiv-sales-hub.pages.dev";
const PROXY = process.env.PROXY_URL || "https://sentiv-proxy-production.up.railway.app";
const SB = process.env.SUPABASE_URL || "https://elvmpugjxnzajvgvhtzh.supabase.co";
// The PUBLIC anon key (it is in the live page too). It must be able to read nothing.
const ANON = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVsdm1wdWdqeG56YWp2Z3ZodHpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMjE2MTgsImV4cCI6MjA5OTc5NzYxOH0.BHl5AtPoU-t2pP7AzDG6IqZ2uKdJtNNZdDbW6MZtUfg";

const results = [];
const check = (area, name, ok, detail = "") => { results.push({ area, name, ok: !!ok, detail }); };
const warn = (area, name, detail) => { results.push({ area, name, ok: true, warn: true, detail }); };
async function get(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: r.status, text, json };
  } catch (e) { return { status: 0, text: String(e.message || e), json: null }; }
  finally { clearTimeout(t); }
}

async function hub() {
  const r = await get(`${HUB}/?healthcheck=${Date.now()}`);
  check("Hub", "live site loads", r.status === 200, `HTTP ${r.status}`);
  const build = (r.text.match(/sentiv-hub-v(\d+) build/) || [])[1];
  check("Hub", "serves a Hub build", !!build, build ? `v${build}` : "no build tag in the page");
  check("Hub", "connects itself to the team (no offline practice mode on new devices)", r.text.includes(PROXY.replace(/^https?:\/\//, "")) && r.text.includes(SB.replace(/^https?:\/\//, "")), "");
}

async function proxy() {
  const h = await get(`${PROXY}/health`);
  check("Server", "proxy is up", h.status === 200 && h.json && h.json.ok, `HTTP ${h.status}`);
  // Must refuse anyone without a sign-in. Each of these answered strangers before 13 Oct.
  const closed = [["POST", "/api/pcloud/list"], ["POST", "/api/pcloud/fetch"], ["POST", "/api/anthropic"], ["GET", "/api/kuration/projects"],
    ["POST", "/api/kuration/rows"], ["POST", "/api/team/invite"], ["GET", "/api/euphoria/calls"], ["POST", "/api/euphoria-originate"],
    ["POST", "/api/vbout-contact"], ["POST", "/api/manyreach-enroll"], ["POST", "/api/repliq-generate"], ["POST", "/api/push/test"]];
  for (const [m, p] of closed) {
    const r = await get(`${PROXY}${p}`, { method: m, headers: { "Content-Type": "application/json" }, body: m === "GET" ? undefined : "{}" });
    check("Server lock", `${m} ${p} refuses strangers`, r.status === 401, `HTTP ${r.status}`);
  }
  const forged = await get(`${PROXY}/api/anthropic`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer forged.token.value" }, body: "{}" });
  check("Server lock", "a forged sign-in is refused", forged.status === 401, `HTTP ${forged.status}`);

  const eu = await get(`${PROXY}/api/euphoria/health`);
  const e = eu.json || {};
  check("Phones", "Euphoria accepts our key", e.auth === "accepted", e.auth || `HTTP ${eu.status}`);
  check("Phones", "call recordings convert to playable audio", e.mp3 === true, String(e.mp3));
  if (!e.stt) warn("Phones", "call summaries are OFF", "ASSEMBLYAI_API_KEY not set on Railway");

  const pu = await get(`${PROXY}/api/push/health`);
  const p = pu.json || {};
  check("Notifications", "push alerts can be sent", p.ok && p.vapid && p.supabase && p.sweep, JSON.stringify({ vapid: p.vapid, supabase: p.supabase, sweep: p.sweep }));
  check("Notifications", "deal-won alerts and editable wording are live", p.dealWon === true, String(p.dealWon));
  // Phones fetch notification pictures with no sign-in: the route must answer (404 for an
  // unknown picture), not 401 — and never serve a file outside its own folder.
  const pimg = await get(`${PROXY}/api/push/img/won-000000000000.jpg`);
  check("Notifications", "notification pictures are reachable by phones", pimg.status === 404, `HTTP ${pimg.status}`);

  const ku = await get(`${PROXY}/api/kuration/health`);
  check("Lead research", "Kuration route is up", ku.status === 200, `HTTP ${ku.status}`);
  const wa = await get(`${PROXY}/api/whatsapp/health`);
  check("WhatsApp", "WhatsApp route is up", wa.status === 200, `HTTP ${wa.status}`);
  // The webhooks must stay reachable AND keep checking their signatures.
  const wh = await get(`${PROXY}/api/whatsapp/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("WhatsApp", "inbound webhook rejects unsigned messages", wh.status === 401 && /signature/i.test(wh.text), `HTTP ${wh.status}`);
  const kh = await get(`${PROXY}/api/kuration/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("Lead research", "Kuration webhook rejects unsigned calls", kh.status === 401 && /signature/i.test(kh.text), `HTTP ${kh.status}`);
}

async function database() {
  const au = await get(`${SB}/auth/v1/health`, { headers: { apikey: ANON } });
  check("Database", "sign-in service is up", au.status === 200, `HTTP ${au.status}`);
  // With only the public key, every table must give back NOTHING. A row here means a
  // security rule was dropped or loosened.
  const tables = ["leads", "documents", "profiles", "team_settings", "user_state", "usage_events", "spend_events", "wa_inbound", "tenders",
    "tender_chunks", "recordings", "todos", "referrals", "partners", "network", "meetings", "push_subscriptions", "push_log", "deleted_rows",
    "places_usage", "company_registry"];
  for (const t of tables) {
    const r = await get(`${SB}/rest/v1/${t}?select=*&limit=1`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
    const leaked = r.status === 200 && Array.isArray(r.json) && r.json.length > 0;
    check("Data lock", `public key reads nothing from ${t}`, !leaked, leaked ? "ROWS RETURNED" : `HTTP ${r.status}`);
  }
  for (const fn of ["usage_devices", "team_readiness", "sign_out_sessions", "push_coverage", "setter_booked_deals", "recently_deleted_leads"]) {
    const r = await get(`${SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" }, body: fn === "sign_out_sessions" ? JSON.stringify({ p_ids: ["00000000-0000-0000-0000-000000000000"] }) : "{}" });
    const leaked = r.status === 200 && ((Array.isArray(r.json) && r.json.length > 0) || (typeof r.json === "number" && r.json > 0));
    check("Data lock", `public key can't use ${fn}()`, !leaked, `HTTP ${r.status}`);
  }
}

(async () => {
  await hub();
  await proxy();
  await database();
  const failed = results.filter((r) => !r.ok);
  const warns = results.filter((r) => r.warn);
  let area = "";
  for (const r of results) {
    if (r.area !== area) { area = r.area; console.log(`\n${area}`); }
    console.log(`  ${r.warn ? "WARN" : r.ok ? "ok  " : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\n${results.length - warns.length - failed.length} ok · ${warns.length} warning(s) · ${failed.length} FAILED`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [`## Sentiv Hub daily health — ${failed.length ? `❌ ${failed.length} problem(s)` : "✅ all good"}`, "",
      ...failed.map((r) => `- ❌ **${r.area}:** ${r.name} — ${r.detail}`), ...warns.map((r) => `- ⚠️ **${r.area}:** ${r.name} — ${r.detail}`), "",
      `${results.length} checks run.`].join("\n");
    require("fs").appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  }
  process.exit(failed.length ? 1 : 0);
})();
