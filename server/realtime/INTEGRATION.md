# Realtime integration checklist

## Current architecture

- `fullDuplexState.ts`: independent connection/user/assistant speech state.
- `eventNormalizer.ts`: converts provider events into concurrent speech state.
- `openaiRealtime.ts`: authenticated server-side OpenAI Realtime GA WebSocket transport.
- `openaiGateway.ts`: browser `/live-openai` bridge using the existing `{audio: base64}` client message shape.
- `config.ts`: `gpt-4o-live` product alias resolves to the current `gpt-realtime` API alias.
- `runtimeConfig.ts`: provider-specific fail-closed credential validation.

OpenAI's current documentation identifies Realtime as the low-latency voice-agent path and documents server-to-server WebSocket connections with a server-held API key. For browser-native media, OpenAI recommends WebRTC; this repository's gateway remains useful when the application intentionally keeps raw PCM behind its own server pipeline.

## Required server integration

The legacy `server.ts` currently owns `/live`. The safe migration is:

1. Import `attachOpenAIRealtimeGateway` from `./server/realtime/openaiGateway`.
2. Call `attachOpenAIRealtimeGateway(server, '/live-openai')` immediately after the HTTP server is created.
3. Move the browser from `/live` to `/live-openai` only after integration tests pass.
4. Keep Gemini behind its own adapter rather than mapping other provider names to Gemini.
5. Remove the legacy fake-key fallback and arbitrary Node.js execution before production deployment.

## Audio contract

Browser input is PCM16 mono. Audio input remains active while assistant output is playing. `overlap` is true when both speech states are `SPEAKING`.

## Production security

- `OPENAI_API_KEY` is server-side only.
- Never expose provider keys to browser JavaScript.
- Use a stable privacy-preserving safety identifier when the application identifies end users.
- Do not execute arbitrary Node.js from model-generated input.
- Authenticate WebSocket sessions before production exposure.
- Rate-limit and audit tool calls.
