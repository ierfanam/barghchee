# BARghCHEE Realtime Full-Duplex Layer

## Production target

- Provider: OpenAI Realtime
- Product model label: `gpt-4o-live`
- API model resolution: `gpt-realtime`
- Input: continuous microphone PCM stream
- Output: streamed PCM audio
- Turn detection: provider VAD
- Full duplex: microphone capture remains active while assistant audio is playing
- Barge-in: user speech may overlap assistant speech
- Credentials: server-side only

## Invariants

1. Microphone capture must remain active while assistant audio is playing.
2. Assistant playback must not implicitly disable microphone capture.
3. User speech and assistant speech are independent state dimensions.
4. `overlap === true` is valid when both sides are speaking.
5. Barge-in and overlap are different concepts; an interruption event must not be used as a substitute for full-duplex state.
6. Provider-specific code belongs in provider adapters rather than UI components.

## Required runtime checks

1. `OPENAI_API_KEY` exists only in the server environment.
2. Browser connects only to the BARghCHEE realtime gateway.
3. Gateway authenticates the browser session before creating a provider session.
4. Gateway forwards input audio without Push-to-Talk gating.
5. Provider output is streamed to the browser immediately.
6. User input is not muted while output audio is playing.
7. Provider cancellation and local playback interruption are coordinated on barge-in.
8. Reconnect does not duplicate sessions or audio listeners.
9. Session shutdown releases WebSocket, AudioContext, MediaStream and timers.
10. CI/build/test must pass before merging.

This checklist deliberately does not claim microphone/browser validation. That final acceptance step must be executed in a real browser with a real API credential.
