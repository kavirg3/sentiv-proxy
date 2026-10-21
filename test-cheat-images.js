// node test-cheat-images.js — cheat-notes pictures (Hub v259): the owner uploads, every
// signed-in person can fetch, nobody else can. Runs push-routes in-process behind the same
// kind of sign-in gate server.js uses, against a fake Supabase (auth + profiles + storage).
const http = require("http");
const fs = require("fs");
const express = require("express");
const fails = [];
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); if (!c) fails.push(n); };

const OWNER = "00000000-0000-0000-0000-00000000000a", SETTER = "00000000-0000-0000-0000-00000000000c";
const objects = {};
const sbServer = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const json = (code, v) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
  if (u.pathname === "/auth/v1/user") {
    const t = (req.headers.authorization || "").replace("Bearer ", "");
    return t === "owner" ? json(200, { id: OWNER }) : t === "setter" ? json(200, { id: SETTER }) : json(401, {});
  }
  if (u.pathname.startsWith("/storage/v1/object/backups/")) {
    const key = u.pathname.replace("/storage/v1/object/backups/", "");
    if (req.method === "POST") { objects[key] = { raw, type: req.headers["content-type"] }; return json(200, { Key: key }); }
    if (!objects[key]) return json(400, { error: "not found" });
    res.writeHead(200, { "Content-Type": "application/octet-stream" }); return res.end(objects[key].raw);
  }
  if (u.pathname === "/rest/v1/profiles") {
    const id = (u.searchParams.get("id") || "").replace("eq.", "");
    return json(200, [{ id: OWNER, role: "owner" }, { id: SETTER, role: "setter" }].filter((p) => p.id === id));
  }
  json(404, { error: "fake: " + u.pathname });
});

(async () => {
  await new Promise((r) => sbServer.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { SUPABASE_URL: `http://127.0.0.1:${sbServer.address().port}`, SUPABASE_SERVICE_KEY: "svc", PUSH_PUBLIC_URL: "https://proxy.test" });
  const push = require("./push-routes");
  const router = push.router || push;
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  // The same gate as server.js: the public list, then a signed-in user or 401.
  const src = fs.readFileSync(__dirname + "/server.js", "utf8");
  const pubImg = /\["GET", (\/\^\\\/api\\\/push\\\/img.*?\/)\]/.exec(src);
  const PUBLIC = pubImg ? [eval(pubImg[1])] : [];
  check("server.js keeps notification pictures public (sanity)", PUBLIC.length === 1 && PUBLIC[0].test("/api/push/img/won-0123456789ab.jpg"));
  check("server.js does NOT make cheat pictures public", PUBLIC.length === 1 && !PUBLIC[0].test("/api/push/cheat-img/cheat-0123456789ab.jpg") && !/cheat-img/.test(src));
  app.use("/api", async (req, res, next) => {
    const full = req.baseUrl + req.path;
    if (req.method === "GET" && PUBLIC.some((re) => re.test(full))) return next();
    const t = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: `Bearer ${t}` } });
    if (!r.ok) return res.status(401).json({ error: "Sign in to the Sentiv Hub first." });
    req.sentivUser = (await r.json()).id;
    next();
  });
  app.use("/api/push", router);
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}/api/push`;
  const post = (tok, body) => fetch(`${base}/cheat-image`, { method: "POST", headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body) });
  const get = (tok, f) => fetch(`${base}/cheat-img/${f}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });

  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fake jpeg body")]);
  const dataUrl = "data:image/jpeg;base64," + jpg.toString("base64");

  let r = await post("", { dataUrl });
  check("upload: not signed in → 401", r.status === 401, String(r.status));
  r = await post("setter", { dataUrl });
  check("upload: a setter can't add pictures → 403", r.status === 403, String(r.status));
  r = await post("owner", { dataUrl: "data:image/jpeg;base64," + Buffer.from("%PDF-1.4").toString("base64") });
  check("upload: a PDF called .jpg is refused → 400", r.status === 400, String(r.status));
  r = await post("owner", { dataUrl });
  const d = await r.json();
  check("upload: owner's picture saved, name is cheat-<hash>.jpg", r.status === 200 && /^cheat-[0-9a-f]{12}\.jpg$/.test(d.file || ""), JSON.stringify(d));
  check("upload: stored in its own folder, not push-images", !!objects[`cheat-images/${d.file}`] && !Object.keys(objects).some((k) => k.startsWith("push-images/")), Object.keys(objects).join(","));
  const r2 = await (await post("owner", { dataUrl })).json();
  check("upload: the same picture twice keeps one file", r2.file === d.file);

  r = await get("", d.file);
  check("fetch: not signed in → 401", r.status === 401, String(r.status));
  r = await get("setter", d.file);
  const buf = Buffer.from(await r.arrayBuffer());
  check("fetch: a signed-in setter gets the picture", r.status === 200 && buf.equals(jpg) && r.headers.get("content-type") === "image/jpeg", `${r.status} ${r.headers.get("content-type")}`);
  check("fetch: cached privately (browser only, never a shared cache)", /^private/.test(r.headers.get("cache-control") || ""), r.headers.get("cache-control"));
  r = await get("setter", "cheat-ffffffffffff.jpg");
  check("fetch: an unknown picture → 404", r.status === 404, String(r.status));
  r = await get("setter", "..%2Fpush-images%2Fwon-0123456789ab.jpg");
  check("fetch: a path trick → 404", r.status === 404, String(r.status));
  r = await fetch(`${base}/img/${d.file}`);
  check("fetch: the public notification route can't serve a cheat picture", r.status === 404, String(r.status));
  const h = await (await fetch(`${base}/health`, { headers: { Authorization: "Bearer owner" } })).json();
  check("health says cheat pictures are on", h.cheatImages === true);

  srv.close(); sbServer.close();
  console.log(fails.length ? `\n${fails.length} FAILURE(S): ${fails.join(", ")}` : "\nall passed");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
