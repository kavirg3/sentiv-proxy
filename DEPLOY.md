# Deploy the Sentiv Sales Hub proxy (±15 minutes)

## Railway (easiest)
1. Push this `server/` folder to a GitHub repo (or use `railway init` in it).
2. railway.app → New Project → Deploy from repo. Railway auto-detects Node.
3. Variables tab → paste the keys from `.env.example` that you use.
4. Settings → Generate Domain → copy the URL (e.g. https://sentiv-proxy.up.railway.app).
5. In the Sales Hub → Settings → Backend URL → paste that URL. Done.

## Verify
- GET  {url}/health                     → {"ok":true}
- POST {url}/api/euphoria-originate     with {"extension":"101","number":"0115550000"} → 500 "not configured" until the key is set, 502/200 after.

## Notes
- Endpoint paths for Euphoria/VBOUT/ManyReach/RepliQ follow each vendor's docs; if a
  vendor has changed a path or field name since writing, adjust the single fetch in
  that route — the app-facing contract stays the same.
- Never put the service_role Supabase key or any of these API keys in the app itself.

## Meeting recordings (22 Nov 2026, Hub v339)

The Hub's meeting recorder uploads the audio of each meeting to
`/api/euphoria/meetings/upload`. It is kept as MP3 in pCloud at
`/Sentiv Meeting Recordings/<user id>/<YYYY-MM>/` (override with `MEETINGS_ARCHIVE_PATH`),
outside the Vault, playable only by the person who recorded it and the owner, and deleted
after 12 months by the daily archive sweep. `/api/euphoria/archive/health` reports it under
`meetings`. Transcripts with speaker names need `ASSEMBLYAI_API_KEY` (same key as call
summaries); without it the audio is still kept. Test: `node test-meeting-audio.js` (needs
`../test.wav`, `../test.webm`, `../test.m4a`; make them with ffmpeg-static's `-f lavfi -i sine`).
