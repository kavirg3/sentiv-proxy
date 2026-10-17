// Daily lead feed runner (17 Oct 2026), run by .github/workflows/lead-feed.yml.
// Asks the Supabase function `lead-feed` to top up each setter's call list, then prints
// what landed. The function does the work; this proves who is asking (GitHub OIDC) and
// reports. Exits 1 when the run failed or a queue could not be filled, so GitHub emails
// the repo owner.
const FN = process.env.LEAD_FEED_URL || "https://elvmpugjxnzajvgvhtzh.supabase.co/functions/v1/lead-feed";
const AUDIENCE = "sentiv-lead-feed";
const live = process.env.LEAD_FEED_LIVE === "true" && process.env.DRY_RUN_INPUT !== "true";
(async () => {
  const reqUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, reqTok = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!reqUrl || !reqTok) { console.log("FAIL  no GitHub OIDC token — the workflow needs `permissions: id-token: write`"); process.exit(1); }
  const idt = await fetch(`${reqUrl}&audience=${AUDIENCE}`, { headers: { Authorization: `Bearer ${reqTok}` } }).then((r) => r.json()).catch(() => ({}));
  if (!idt.value) { console.log("FAIL  GitHub would not issue an OIDC token"); process.exit(1); }
  let status = 0, d = {};
  try {
    const r = await fetch(FN, { method: "POST", headers: { Authorization: `Bearer ${idt.value}`, "Content-Type": "application/json" }, body: JSON.stringify({ dryRun: !live }) });
    status = r.status; d = await r.json().catch(() => ({}));
  } catch (e) { d = { error: String(e.message || e) }; }
  const label = { sentiv: "Sentiv", rewards: "Digital Rewards" };
  const lines = [`${live ? "LIVE" : "DRY RUN (no Google calls)"} — ${d.day || "?"} — target ${d.plan ? `${d.plan.perDay} new a day, ${d.plan.floor} waiting` : "?"}`];
  (d.recipients || []).forEach((x) => {
    const sk = Object.entries(x.skipped || {}).map(([k, v]) => `${v} ${k}`).join(", ");
    lines.push(`${x.name || x.id} · ${label[x.biz]}: ${x.freshBefore} waiting → ${live ? `+${x.added} added (${x.cells} cell, ${x.landlines} landline)` : `would add ${x.want}`}${x.searches && x.searches.length ? ` from ${x.searches.length} searches` : ""}${sk ? ` · skipped ${sk}` : ""}`);
  });
  if (d.counts) lines.push(`Today: +${d.counts.sentiv} Sentiv, +${d.counts.rewards} Digital Rewards · uncalled now ${d.counts.freshSentiv} Sentiv, ${d.counts.freshRewards} Digital Rewards`);
  lines.push(`Google: ${d.requests ?? 0} requests (~$${d.usd ?? 0}) · quota before run ${d.quota ? `${d.quota.used}/${d.quota.limit}` : "?"}`);
  if (d.short && d.short.length) lines.push(`WARN  short: ${d.short.join("; ")}`);
  if (d.error) lines.push(`FAIL  ${d.error}`);
  console.log(`Lead feed — HTTP ${status}\n${lines.map((l) => "  " + l).join("\n")}`);
  if (process.env.GITHUB_STEP_SUMMARY) require("fs").appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n## Lead feed — ${status === 200 && d.ok && !d.error ? "✅" : "❌"}\n\n${lines.map((l) => "- " + l).join("\n")}\n`);
  process.exit(status === 200 && d.ok && !d.error ? 0 : 1);
})();
