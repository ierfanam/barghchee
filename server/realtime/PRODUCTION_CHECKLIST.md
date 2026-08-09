# Production Readiness Checklist

## Repository-side

- [x] OpenAI Realtime provider boundary
- [x] Server-side API credential isolation
- [x] Product alias `gpt-4o-live`
- [x] API model resolution
- [x] Continuous microphone contract
- [x] Simultaneous assistant playback contract
- [x] Overlap state
- [x] Barge-in / interrupt contract
- [x] Browser gateway client
- [x] AudioWorklet input path
- [x] WebSocket gateway adapter
- [x] Session token gate
- [x] Provider error propagation
- [x] Session cleanup
- [x] Realtime configuration tests
- [x] Gateway policy tests

## Explicit final manual acceptance

These cannot truthfully be marked complete by source inspection alone:

1. Start the production build with a real `OPENAI_API_KEY`.
2. Open the application in a real browser.
3. Grant microphone permission.
4. Confirm microphone capture remains active while the assistant speaks.
5. Start speaking while the assistant is speaking.
6. Confirm the overlap state appears and the new user audio reaches the provider.
7. Confirm the assistant can respond to the new utterance without Push-to-Talk.
8. Repeat the interruption several times and verify there are no duplicated sessions, audio loops, or memory growth.
9. Confirm reconnect and close release the MediaStream, AudioContext and WebSocket.

Until these steps are performed in the target runtime, the project must not be labelled "production verified".
