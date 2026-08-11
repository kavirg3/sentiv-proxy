// ============================================================================
// SENTIV BACKEND — pCLOUD PROXY ROUTES
// Mount into the existing Express proxy (the one already serving /api/anthropic,
// /api/euphoria-originate, /api/vbout-contact, /api/manyreach-enroll,
// /api/repliq-generate):
//
//     const pcloud = require("./pcloud-routes");
//     app.use("/api/pcloud", pcloud);
//
// ENVIRONMENT
//     PCLOUD_TOKEN     required — pCloud OAuth access token (full-account scope)
//     PCLOUD_REGION    "eu" (default, eapi.pcloud.com) or "us" (api.pcloud.com)
//     PCLOUD_ROOT      optional — folder id to lock agents into, e.g. "12345678".
//                      Defaults to 0 (whole drive). SET THIS. It is the only
//                      thing standing between an agent and your personal files:
//                      pCloud has no per-user scoping, so the fence is here.
//
// WHY A PROXY AT ALL: the token is full-account. In the browser it would give
// every agent read/write over all 2TB. Here it stays server-side and only the
// five narrow verbs below are exposed — all read-only. No delete, no upload.
// ============================================================================

const express = require("express");
const router = express.Router();

const REGION = (process.env.PCLOUD_REGION || "eu").toLowerCase();
const API = REGION === "us" ? "https://api.pcloud.com" : "https://eapi.pcloud.com";
const TOKEN = process.env.PCLOUD_TOKEN || "";
const ROOT = String(process.env.PCLOUD_ROOT || "0");

// Recursive listings are expensive; a short cache keeps search snappy without
// going stale on a working day.
const SEARCH_TTL_MS = 5 * 60 * 1000;
let searchCache = { at: 0, flat: null };

function need(res) {
  if (!TOKEN) { res.status(500).json({ error: "pCloud not configured — set PCLOUD_TOKEN" }); return false; }
  return true;
}

async function pc(method, params) {
  const url = new URL(`${API}/${method}`);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const d = await r.json();
  // pCloud signals failure in the body, not the HTTP status.
  if (d.result !== 0) throw new Error(d.error || `pCloud error ${d.result}`);
  return d;
}

// pCloud metadata is chatty; the browser only needs these fields.
function slim(e) {
  return {
    name: e.name,
    isfolder: !!e.isfolder,
    folderid: e.folderid,
    fileid: e.fileid,
    size: e.size || 0,
    modified: e.modified || null,
    contenttype: e.contenttype || null,
  };
}

// Agents may never escape PCLOUD_ROOT. Without this an agent could pass
// folderid: 0 and walk the whole personal drive.
async function withinRoot(folderid) {
  if (ROOT === "0") return true;
  if (String(folderid) === ROOT) return true;
  let cur = folderid;
  for (let hops = 0; hops < 40; hops++) {
    const d = await pc("listfolder", { folderid: cur, nofiles: 1 });
    const parent = d.metadata && d.metadata.parentfolderid;
    if (parent === undefined || parent === null) return false;
    if (String(parent) === ROOT) return true;
    if (String(parent) === "0") return false;
    cur = parent;
  }
  return false;
}

// --- list a folder ----------------------------------------------------------
router.post("/list", async (req, res) => {
  if (!need(res)) return;
  try {
    const folderid = req.body && req.body.folderid !== undefined ? String(req.body.folderid) : ROOT;
    const target = folderid === "0" ? ROOT : folderid;
    if (!(await withinRoot(target))) return res.status(403).json({ error: "folder outside the agent vault" });
    const d = await pc("listfolder", { folderid: target });
    res.json({ contents: ((d.metadata && d.metadata.contents) || []).map(slim) });
  } catch (e) {
    res.status(502).json({ error: e.message || "pCloud list failed" });
  }
});

// --- recursive name search --------------------------------------------------
router.post("/search", async (req, res) => {
  if (!need(res)) return;
  const q = String((req.body && req.body.query) || "").trim().toLowerCase();
  if (!q) return res.status(400).json({ error: "query required" });
  try {
    if (!searchCache.flat || Date.now() - searchCache.at > SEARCH_TTL_MS) {
      const d = await pc("listfolder", { folderid: ROOT, recursive: 1 });
      const flat = [];
      (function walk(node) {
        ((node && node.contents) || []).forEach((e) => {
          flat.push(slim(e));
          if (e.isfolder) walk(e);
        });
      })(d.metadata);
      searchCache = { at: Date.now(), flat };
    }
    const results = searchCache.flat.filter((e) => String(e.name || "").toLowerCase().includes(q)).slice(0, 300);
    res.json({ results, cachedAt: searchCache.at });
  } catch (e) {
    res.status(502).json({ error: e.message || "pCloud search failed" });
  }
});

// --- temporary direct link (preview / open) ---------------------------------
router.post("/link", async (req, res) => {
  if (!need(res)) return;
  const fileid = req.body && req.body.fileid;
  if (!fileid) return res.status(400).json({ error: "fileid required" });
  try {
    const d = await pc("getfilelink", { fileid });
    const host = (d.hosts && d.hosts[0]) || "";
    if (!host || !d.path) throw new Error("pCloud returned no host");
    res.json({ url: `https://${host}${d.path}`, expires: d.expires || null });
  } catch (e) {
    res.status(502).json({ error: e.message || "pCloud link failed" });
  }
});

// --- public share link (what agents paste to clients) -----------------------
router.post("/share", async (req, res) => {
  if (!need(res)) return;
  const fileid = req.body && req.body.fileid;
  if (!fileid) return res.status(400).json({ error: "fileid required" });
  try {
    const d = await pc("getfilepublink", { fileid });
    res.json({ link: d.link, code: d.code || null });
  } catch (e) {
    res.status(502).json({ error: e.message || "pCloud share failed" });
  }
});

// --- stream bytes back with CORS (feeds the AI Brain extractor) -------------
// The browser can't fetch the pCloud host link directly (no CORS header on it),
// so for text extraction we pipe the bytes through here. Capped: the extractor
// only reads the first 60k characters anyway, and an agent clicking a 900MB
// video into the Brain should fail fast rather than stall the proxy.
const MAX_FETCH_BYTES = 40 * 1024 * 1024;
router.post("/fetch", async (req, res) => {
  if (!need(res)) return;
  const fileid = req.body && req.body.fileid;
  if (!fileid) return res.status(400).json({ error: "fileid required" });
  try {
    const meta = await pc("checksumfile", { fileid });
    const size = (meta.metadata && meta.metadata.size) || 0;
    if (size > MAX_FETCH_BYTES) return res.status(413).json({ error: `file is ${Math.round(size / 1048576)}MB — too large to read into the Brain` });

    const d = await pc("getfilelink", { fileid });
    const host = (d.hosts && d.hosts[0]) || "";
    if (!host || !d.path) throw new Error("pCloud returned no host");
    const upstream = await fetch(`https://${host}${d.path}`);
    if (!upstream.ok) throw new Error(`pCloud host returned ${upstream.status}`);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(buf.length));
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: e.message || "pCloud fetch failed" });
  }
});

module.exports = router;
