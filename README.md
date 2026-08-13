# گُردآفرین — کنسول هوشمند توزیع برق استان ایلام

سامانه دستیار صوتی مبتنی بر هوش مصنوعی و کنسول مرکز تماس (PBX) برای شرکت توزیع نیروی برق استان ایلام.
این سامانه تماس‌های ارتباط مردمی را خودکار می‌کند، وصول مطالبات را مدیریت می‌کند و با درگاه‌های خدمات مشترکین همگام می‌شود.

> AI-powered voice agent and PBX console for the Ilam Province Electricity Distribution Company —
> automating public contact calls, debt-collection campaigns, and utility-portal synchronization.

---

## Architecture

| Layer | File(s) | Description |
| --- | --- | --- |
| Backend / AI proxy | `server.ts` | Express + WebSocket server. Bridges the browser to the Google Gemini Live API, exposes REST APIs, and proxies AI tool calls. |
| SIP / VoIP gateway | `server/sipGateway.ts` | UDP (5060) SIP stack and Kamailio RPC integration for PSTN/SIP signaling. |
| Frontend SPA | `index.ts`, `index.html`, `index.css` | LitElement single-page console (`gdm-live-audio`) with the PBX dashboard, transcripts, and settings. |
| 3D / audio visuals | `human-avatar.ts`, `equalizer.ts`, `analyser.ts`, `visual*.ts`, `backdrop-shader.ts` | Three.js avatar and Web Audio visualizations. |
| Charts | `chart.tsx` | Recharts-based analytics widgets. |
| Data | `data.csv`, `subscribers.csv` | Local subscriber records used for lookups. |

Real-time audio flows over a WebSocket at `/live`; internal PBX signaling uses `/voip-signaling`.

## Prerequisites

- Node.js 20+
- A Google Gemini API key (required)
- Optional: Twilio credentials for real PSTN calls, and a Kamailio SIP proxy for telephony

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values (see below)
```

### Environment variables

All variables are documented in [`.env.example`](./.env.example). Only `GEMINI_API_KEY` is required to run the AI assistant.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | yes | Google Gemini Live API key. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | no | Real outbound PSTN calls via Twilio. |
| `PORT` | no | HTTP/WebSocket port (default `3000`). |
| `HOST` | no | Bind interface (default `0.0.0.0`). |
| `NODE_ENV` | no | Set to `production` to serve the pre-built `dist/`. |
| `CORS_ORIGIN` | no | Comma-separated allowed origins (empty = allow all, dev only). |
| `KAMAILIO_RPC_URL` | no | Kamailio JSON-RPC endpoint for SIP subscriber dumps. |

## Development

```bash
npm run dev        # starts the server with the Vite dev middleware
```

Open <http://localhost:3000>.

## Type-checking / lint

```bash
npm run typecheck  # tsc --noEmit  (also run as `npm run lint`)
```

## Production build & run

```bash
npm run build      # builds the SPA (dist/) and bundles the server (dist/server.cjs)
npm start          # NODE_ENV=production node dist/server.cjs
```

In production mode the server serves the static `dist/` assets and falls back to `index.html` for SPA routes.

## Notes & security

- `GEMINI_API_KEY` must be provided; the server rejects Live sessions with a clear message when it is missing.
- Set `CORS_ORIGIN` to your deployed frontend origin(s) in production instead of leaving it open.
- The `executeNodeCode` AI tool runs sandboxed JS restricted to `axios`/`cheerio`. Review before exposing to untrusted operators.
