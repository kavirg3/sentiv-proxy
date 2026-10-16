// Daily call-recording sweep (16 Oct 2026), run by .github/workflows/health.yml after the
// health check. Asks the proxy to:
//   - copy any recorded, answered call from the last 3 days that no Hub has archived yet,
//   - delete recordings older than 12 months from pCloud,
//   - prove upload-and-play still works with a throwaway file.
// No stored secret: the run proves itself with a token GitHub signs for this workflow
// (needs `permissions: id-token: write`). The proxy checks it is THIS repo, on main.
// Exits 1 on failure, so GitHub emails the repo owner.
const PROXY = process.env.PROXY_URL || "https://sentiv-proxy-production.up.railway.app";
const AUDIENCE = "sentiv-proxy-archive";
(async () => {
  const reqUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, reqTok = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!reqUrl || !reqTok) { console.log("FAIL  no GitHub OIDC token — the workflow needs `permissions: id-token: write`"); process.exit(1); }
  const idt = await fetch(`${reqUrl}&audience=${AUDIENCE}`, { headers: { Authorization: `Bearer ${reqTok}` } }).then((r) => r.json()).catch(() => ({}));
  if (!idt.value) { console.log("FAIL  GitHub would not issue an OIDC token"); process.exit(1); }
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8 * 60e3);
  let status = 0, d = {};
  try {
    const r = await fetch(`${PROXY}/api/euphoria/archive/sweep`, { method: "POST", headers: { Authorization: `Bearer ${idt.value}` }, signal: ctl.signal });
    status = r.status; d = await r.json().catch(() => ({}));
  } catch (e) { d = { error: String(e.message || e) }; } finally { clearTimeout(t); }
  const lines = [
    `${d.selftest === true ? "ok  " : "FAIL"}  upload-and-play self-test`,
    `${d.errors ? "WARN" : "ok  "}  archived ${d.archived ?? "?"} of ${d.recorded ?? "?"} recorded calls from the last 3 days (${d.uploaded ?? 0} new, ${d.pending ?? 0} left for tomorrow, ${d.errors ?? 0} Euphoria wouldn't hand over)`,
    `ok    deleted ${d.prune ? d.prune.files : "?"} recording(s) and ${d.prune ? d.prune.folders : "?"} month folder(s) older than ${d.prune ? d.prune.cutoff : "12 months"}`,
  ];
  const st = d.stats || {};
  if (st.files !== undefined) lines.push(`ok    pCloud holds ${st.files} recording(s) for ${st.agents} people, ${st.mb} MB (${st.thisMonth} this month${st.wav ? `, ${st.wav} not converted to MP3` : ""})`);
  if (d.skipped) lines.push(`WARN  ${d.skipped}`);
  if (d.error) lines.push(`FAIL  ${d.error}`);
  console.log(`Call recording archive — HTTP ${status}\n${lines.map((l) => "  " + l).join("\n")}`);
  if (process.env.GITHUB_STEP_SUMMARY) require("fs").appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n## Call recordings — ${d.ok ? "✅" : "❌"}\n\n${lines.map((l) => "- " + l).join("\n")}\n`);
  process.exit(status === 200 && d.ok ? 0 : 1);
})();
