# BARghCHEE Realtime Execution Runbook

## Intended end state

The browser keeps microphone capture active while assistant audio is playing. User speech may begin at any point, including while assistant speech is audible. The gateway forwards input without Push-to-Talk semantics and exposes independent user/assistant speech state.

## Required environment

- `OPENAI_API_KEY`: server-side only.
- `REALTIME_PROVIDER=openai`
- `REALTIME_MODEL`: exact model identifier supported by the configured OpenAI Realtime API deployment.
- Optional `REALTIME_SESSION_TOKEN`: short-lived application session credential if gateway authentication is enabled.

## Security invariants

- Never ship `OPENAI_API_KEY` to the browser.
- Never execute arbitrary browser-supplied code on the server without an explicit allowlist and authorization boundary.
- Fail closed when required credentials are missing.
- Treat tool calls as untrusted input.

## Realtime invariants

- Microphone capture is not stopped by assistant playback.
- User and assistant speech are independent states.
- Overlap is a valid state.
- Interruption is a provider event, not a replacement for duplex capture.
- Reconnect must release old audio/WebSocket resources before creating a new session.

## Final practical test

1. Start the application with a valid server-side OpenAI credential.
2. Open the realtime voice interface and grant microphone permission.
3. Speak naturally without Push-to-Talk.
4. While the assistant is speaking, begin a second utterance.
5. Confirm the browser continues sending microphone audio.
6. Confirm the gateway reports simultaneous user/assistant speech when overlap occurs.
7. Confirm assistant response adapts to the interruption/new utterance.
8. Repeat after reconnect and verify resources are not duplicated.

The practical test is the final acceptance gate; source-code completion alone must not be represented as successful live audio execution.
