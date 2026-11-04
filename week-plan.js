// Sunday week plan (Hub v309, 4 Nov 2026), run by .github/workflows/week-plan.yml.
// Asks the Supabase function `lead-feed` ({ weekPlan: true }) to plan the setter's coming
// week by area day (Hub: Plan calls → Area days), then sends the owner one notification with
// the result through the proxy (/api/push/weekplan). Both calls prove who is asking with a
// GitHub-signed OIDC token: no shared secret. Exits 1 when the plan failed, so GitHub emails.
const FN = process.env.LEAD_FEED_URL || "https://elvmpugjxnzajvgvhtzh.supabase.co/functions/v1/lead-feed";
const PROXY = process.env.PROXY_URL || "https://sentiv-proxy-production.up.railway.app";
const live = process.env.LEAD_FEED_LIVE === "true" && process.env.DRY_RUN_INPUT !== "true";
const reqUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, reqTok = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
const oidc = async (aud) => (await fetch(`${reqUrl}&audience=${aud}`, { headers: { Authorization: `Bearer ${reqTok}` } }).then((r) => r.json()).catch(() => ({}))).value || "";
(async () => {
  if (!reqUrl || !reqTok) { console.log("FAIL  no GitHub OIDC token — the workflow needs `permissions: id-token: write`"); process.exit(1); }
  const tok = await oidc("sentiv-lead-feed");
  if (!tok) { console.log("FAIL  GitHub would not issue an OIDC token"); process.exit(1); }
  let status = 0, d = {};
  try {
    const r = await fetch(FN, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify({ weekPlan: true, dryRun: !live }) });
    status = r.status; d = await r.json().catch(() => ({}));
  } catch (e) { d = { error: String(e.message || e) }; }
  const good = status === 200 && d.ok !== false && !d.error;
  const lines = [`${live ? "LIVE" : "DRY RUN (nothing saved)"} — week of ${d.week || "?"} — ${d.setter || "?"}`];
  if (d.skipped) lines.push(`Not planned: ${d.skipped}`);
  (d.lines || []).forEach((l) => lines.push(l));
  lines.push(`Planned ${d.planned ?? 0} · ${d.added ?? 0} new from Google · ${d.located ?? 0} placed on the map · ${d.searches ?? 0} searches · ~$${d.usd ?? 0}`);
  if (d.short && d.short.length) lines.push(`WARN  short: ${d.short.join("; ")}`);
  if (d.error) lines.push(`FAIL  ${d.error}`);
  // Tell the owner, live runs only.
  if (live) {
    try {
      const ptok = await oidc("sentiv-proxy-archive");
      const p = await fetch(`${PROXY}/api/push/weekplan`, { method: "POST", headers: { Authorization: `Bearer ${ptok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ setter: d.setter, planned: d.planned, added: d.added, lines: d.lines, skipped: d.skipped, error: good ? "" : (d.error || `HTTP ${status}`) }) });
      lines.push(`Owner notified: HTTP ${p.status} ${(await p.text()).slice(0, 120)}`);
    } catch (e) { lines.push(`Owner not notified: ${e.message || e}`); }
  }
  console.log(`Sunday week plan — HTTP ${status}\n${lines.map((l) => "  " + l).join("\n")}`);
  if (process.env.GITHUB_STEP_SUMMARY) require("fs").appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n## Sunday week plan — ${good ? "✅" : "❌"}\n\n${lines.map((l) => "- " + l).join("\n")}\n`);
  process.exit(good ? 0 : 1);
})();
