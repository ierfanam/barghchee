---
name: testing-barghchee
description: How to run and end-to-end test the barghchee Persian PBX console (Express + Vite + LitElement + Three.js) on the Windows test box.
---

# Testing the barghchee PBX console

## Run
- `npm install`, then `npm run dev` (tsx server.ts). Default port 3000; override with the `PORT` env var (e.g. run with `PORT=3100` to avoid conflicts).
- `npm run typecheck` / `npm run lint` = `tsc --noEmit`; `npm run build` = vite build + esbuild server bundle to `dist/server.cjs` (a benign esbuild warning about `import.meta` in CJS output is expected).
- No `.env` needed for UI/API testing. Without `GEMINI_API_KEY`, the server boots fine; connecting to the `/live` WebSocket returns a Persian error ("کلید سرویس هوش مصنوعی (GEMINI_API_KEY) پیکربندی نشده است...") and closes — that is intended behavior.
- Kamailio RPC on localhost:5060 is normally unavailable; the SIP gateway logs a WARN and falls back to a simulated proxy. Not an error.

## API smoke endpoints
- `GET /api/diagnostics` → `{"status":"healthy",...}`
- `GET /api/subscribers?q=رضایی` (URL-encode the Persian) → seeded subscriber "محمد رضایی"
- Unknown `/api/*` routes → JSON 404 `{"error":"API endpoint not found"}`

## Browser testing gotchas (Windows box)
- Chrome lives at `C:\devin\chrome\chrome-win64\chrome.exe`. The CDP-managed instance uses `--remote-debugging-port=29229` and `--user-data-dir=C:\Users\Administrator\.browser_data_dir`. If you launch a separate Chrome, `browser_console`/`read_dom` will NOT attach to it — instead kill the managed instance and relaunch it with your extra flags plus the same debug port and user-data-dir.
- To exercise the voice flow without a real mic, add `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`.
- The main UI trigger is clicking the central 3D CFL-bulb avatar (toggleLight) — it requests the mic and opens the `/live` WebSocket. Error messages appear in the bottom `#status` div and auto-clear after 7 seconds, so capture screenshots quickly.
- The console dashboard opens via the top-right "کنسول کنترل توزیع برق ایلام" button; subscriber list is under the "پایگاه مشترکین" tab.
- A Google Translate popup may cover the top-right; dismiss it before interacting.
