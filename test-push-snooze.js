// Snooze on a push alert comes back in an hour (Hub v347). Run: node test-push-snooze.js
process.env.PUSH_LOOPS_OFF = "1";
process.env.SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SERVICE_KEY = "svc";
process.env.PUSH_APP_URL = "https://hub.test";
const express = require("express");
const router = require("./snooze-routes");
const fails = []; const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); if (!c) fails.push(n); };

const EP = "https://fcm.googleapis.com/fcm/send/abc123";
let subs = [{ endpoint: EP, p256dh: "k", auth: "a" }];
let files = {}; let listFails = false;
const J = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
router._setFetch(async (url, opts = {}) => {
  const m = (opts.method || "GET").toUpperCase();
  if (url.includes("/rest/v1/push_subscriptions")) { const ep = decodeURIComponent(url.split("endpoint=eq.")[1].split("&")[0]); return J(200, subs.filter((s) => s.endpoint === ep)); }
  if (url.endsWith("/storage/v1/object/list/backups") && m === "POST") return listFails ? J(500, {}) : J(200, Object.keys(files).map((n) => ({ name: n })).concat([{ name: "../evil.json" }]));
  if (url.endsWith("/storage/v1/object/backups") && m === "DELETE") { JSON.parse(opts.body).prefixes.forEach((p) => delete files[p.replace("push-snoozes/", "")]); return J(200, []); }
  if (url.includes("/storage/v1/object/backups/push-snoozes/")) { const n = url.split("/").pop(); if (m === "POST") { files[n] = JSON.parse(opts.body); return J(200, {}); } return files[n] ? J(200, files[n]) : J(400, {}); }
  return J(404, {});
});
const sent = []; router._setPush(async (sub, p) => { sent.push({ sub, p }); return true; });
let now = Date.UTC(2026, 10, 23, 8, 0);   // 10:00 SAST, a Monday
router._setNow(() => now);

(async () => {
  // ---- when it comes back ----
  check("10:00 → 11:00", router._dueAt(now) === now + 3600e3);
  check("16:30 → 17:30", router._dueAt(Date.UTC(2026, 10, 23, 14, 30)) === Date.UTC(2026, 10, 23, 15, 30));
  check("17:30 → 07:00 tomorrow (quiet hours)", router._dueAt(Date.UTC(2026, 10, 23, 15, 30)) === Date.UTC(2026, 10, 24, 5, 0), new Date(router._dueAt(Date.UTC(2026, 10, 23, 15, 30))).toISOString());
  check("05:30 → 07:00 same day", router._dueAt(Date.UTC(2026, 10, 23, 3, 30)) === Date.UTC(2026, 10, 23, 5, 0));
  check("23:30 → 07:00 next day", router._dueAt(Date.UTC(2026, 10, 23, 21, 30)) === Date.UTC(2026, 10, 24, 5, 0));

  // ---- what is kept ----
  const b = router._build({ endpoint: EP, title: "Follow-up due: Acme", body: "Lead · R0", tag: "followup-L1", url: "https://hub.test/?lead=L1", leadId: "L1",
    actions: [{ action: "open", title: "Open lead" }, { action: "snooze", title: "Later" }, { action: "evil", title: "x" }], links: { open: "javascript:alert(1)", snooze: "https://cal.com/x" }, image: "http://x.test/a.png", role: "owner" });
  check("alert kept as it was", b.payload.title === "Follow-up due: Acme" && b.payload.tag === "followup-L1" && b.payload.leadId === "L1" && b.payload.url === "https://hub.test/?lead=L1");
  check("owner's button names kept, unknown actions dropped", JSON.stringify(b.payload.actions) === '[{"action":"open","title":"Open lead"},{"action":"snooze","title":"Later"}]');
  check("links https only", JSON.stringify(b.payload.links) === '{"snooze":"https://cal.com/x"}');
  check("http picture dropped, extra fields dropped", !b.payload.image && !("role" in b.payload));
  check("a link to another site becomes the Hub", router._build({ endpoint: EP, title: "x", url: "https://evil.test/" }).payload.url === "https://hub.test/");
  check("a path stays on the Hub", router._build({ endpoint: EP, title: "x", url: "/?lead=L2" }).payload.url === "https://hub.test/?lead=L2");
  check("//evil is not a path", router._build({ endpoint: EP, title: "x", url: "//evil.test" }).payload.url === "https://hub.test/");
  check("odd lead id dropped", !router._build({ endpoint: EP, title: "x", leadId: "L1');alert(1" }).payload.leadId);
  check("no endpoint / no title refused", !!router._build({ title: "x" }).error && !!router._build({ endpoint: EP }).error && !!router._build("x").error);

  // ---- over HTTP ----
  const app = express(); app.use(express.json()); app.use("/api/push/snooze", router);
  const srv = app.listen(0); const url = `http://127.0.0.1:${srv.address().port}/api/push/snooze`;
  const post = (body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const alert = { endpoint: EP, title: "New website lead: Café Sola", body: "Thandi · Restaurant · 082 123 4567", tag: "weblead-L9", url: "https://hub.test/?lead=L9", leadId: "L9" };

  let r = await post(alert);
  const j = await r.json();
  check("snooze accepted, due in an hour", r.status === 200 && j.ok && j.due === now + 3600e3, JSON.stringify(j));
  check("kept in Storage so a restart keeps it", Object.keys(files).length === 1 && Object.values(files)[0].payload.tag === "weblead-L9");
  r = await post({ ...alert, endpoint: "https://fcm.googleapis.com/fcm/send/someone-else" });
  check("an unknown device is refused", r.status === 404 && Object.keys(files).length === 1);
  r = await post({ ...alert, endpoint: "" });
  check("no device refused", r.status === 400);
  r = await post(alert);
  check("same alert snoozed again: one waiting, not two", r.status === 200 && router._pending.size === 1 && Object.keys(files).length === 1);

  now += 59 * 60e3; await router._tick();
  check("not back after 59 minutes", sent.length === 0);
  now += 2 * 60e3; await router._tick();
  check("back after an hour, to that device only", sent.length === 1 && sent[0].sub.endpoint === EP && sent[0].p.title === "New website lead: Café Sola" && sent[0].p.leadId === "L9");
  check("comes back with its Snooze button (default buttons)", !sent[0].p.actions);
  check("finished snooze removed from Storage", router._pending.size === 0 && Object.keys(files).length === 0);
  await router._tick();
  check("sent once only", sent.length === 1);

  // restart: a snooze saved before the restart still comes back
  r = await post({ ...alert, tag: "followup-L3", title: "Follow-up due: Acme" });
  router._reset();   // the server restarted: memory empty, Storage still has it
  check("memory empty after restart", router._pending.size === 0 && Object.keys(files).length === 1);
  now += 61 * 60e3; await router._tick();
  check("picked up from Storage after a restart and sent", sent.length === 2 && sent[1].p.tag === "followup-L3");

  // device removed while waiting
  r = await post({ ...alert, tag: "gone" });
  subs = []; now += 61 * 60e3; await router._tick();
  check("device gone: nothing sent, snooze cleared", sent.length === 2 && router._pending.size === 0 && Object.keys(files).length === 0);
  subs = [{ endpoint: EP, p256dh: "k", auth: "a" }];

  // a flood from one device
  router._reset();
  const st = []; for (let i = 0; i < 22; i++) st.push((await post({ ...alert, tag: `t${i}` })).status);
  check("at most 20 waiting per device", st.filter((s) => s === 200).length === 20 && st.slice(-2).join() === "429,429", st.join());

  srv.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join("; ")}` : "\nall passed");
  process.exit(fails.length ? 1 : 0);
})();
