// Platform watchdog (Hub v239, 16 Oct 2026).
//
// Kavir asked for a push "when something breaks and requires me to fix the platform asap".
// The daily GitHub health check only ran at 06:00 and only emailed, so a break at 09:00
// went unseen until the next morning. This keeps a little state per check and decides
// WHEN to buzz the owner:
//
//   - a check must fail twice in a row (two runs, ~10 minutes) before anyone is woken —
//     one slow answer from Supabase is not an outage;
//   - a report marked `immediate` (the GitHub health run, a sweep that threw) buzzes on
//     the first failure, because whoever sent it already ran on a schedule;
//   - while something stays broken it buzzes again every `repeatMs` (4 hours), not every run;
//   - when it recovers after a buzz, one "Fixed" message follows, so the owner can stop
//     worrying without opening anything.
//
// Pure apart from the injected `notify` and the clock, so test-watchdog.js drives it alone.

function createWatchdog({ notify, now = () => Date.now(), failAfter = 2, repeatMs = 4 * 3600e3 } = {}) {
  const state = {};          // name -> { fails, since, alertedAt, detail, label }
  let pending = { down: [], fixed: [] };
  let checkedAt = 0;

  function report(name, ok, detail, opts = {}) {
    const label = opts.label || name;
    const s = state[name] || (state[name] = { fails: 0, since: 0, alertedAt: 0, detail: "", label });
    s.label = label;
    if (ok) {
      if (s.alertedAt) pending.fixed.push({ name, label, since: s.since, downMs: now() - s.since });
      state[name] = { fails: 0, since: 0, alertedAt: 0, detail: "", label };
      return;
    }
    s.fails++;
    if (!s.since) s.since = now();
    s.detail = String(detail || "").slice(0, 200);
    const need = opts.immediate ? 1 : failAfter;
    if (s.fails >= need && (!s.alertedAt || now() - s.alertedAt >= repeatMs)) {
      pending.down.push({ name, label, detail: s.detail, since: s.since, again: !!s.alertedAt });
      s.alertedAt = now();
    }
  }

  // Send whatever this round decided, as ONE message for the downs and one for the fixes:
  // Supabase going down fails four checks at once, and four buzzes would be noise.
  async function flush() {
    const out = pending;
    pending = { down: [], fixed: [] };
    if (!out.down.length && !out.fixed.length) return { sent: false };
    try { await notify(out); } catch (e) { console.warn("watchdog notify failed", (e && e.message) || e); }
    return { sent: true, ...out };
  }

  // checks: [{ name, label, every?, run: async () => ({ ok, detail, skip }) }]
  // `every` = run on every Nth round only (for checks that cost an outside call).
  let round = 0;
  async function run(checks, timeoutMs = 20000) {
    round++;
    const due = checks.filter((c) => !c.every || round % c.every === 1 || c.every === 1);
    await Promise.all(due.map(async (c) => {
      let r;
      try {
        r = await Promise.race([c.run(), new Promise((res) => setTimeout(() => res({ ok: false, detail: `no answer in ${Math.round(timeoutMs / 1000)}s` }), timeoutMs).unref?.())]);
      } catch (e) { r = { ok: false, detail: (e && e.message) || String(e) }; }
      if (!r || r.skip) return;
      report(c.name, !!r.ok, r.detail, { label: c.label });
    }));
    checkedAt = now();
    return flush();
  }

  function status() {
    const failing = Object.entries(state).filter(([, s]) => s.fails > 0)
      .map(([name, s]) => ({ name, label: s.label, since: s.since, alerted: !!s.alertedAt }));
    return { checkedAt, failing };
  }

  return { report, flush, run, status, _state: state };
}

module.exports = { createWatchdog };
