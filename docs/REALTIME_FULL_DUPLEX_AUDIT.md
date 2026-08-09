# BARghCHEE Realtime Full-Duplex Audit

## Baseline

Base commit: `e4617d5fae32739eb3d7a69fb8515f76c447c550`

Working branch: `feat/realtime-full-duplex-v1`

## Findings

### Existing strengths

- Gemini Live WebSocket proxy exists at `/live`.
- Browser microphone capture is streamed continuously while recording is active.
- Browser output uses an independent AudioContext and queued BufferSource playback.
- Input and output transcription events are already exposed to the UI.
- Tool calling is already wired into the Live session.

### Full-duplex gaps

- UI currently represents voice with a mutually exclusive `aiState` (`idle`, `listening`, `processing`, `speaking`). This cannot represent simultaneous user and assistant speech.
- The output `interrupted` event currently stops all queued assistant sources. That is useful for provider interruption handling, but it is not a complete overlap model.
- The microphone pipeline currently uses `ScriptProcessorNode`; this should be evaluated for migration to `AudioWorklet` after functional behavior is stabilized.
- There is no explicit overlap event/state model in the repository.

### Security / correctness gaps

- `server.ts` contains an auto-injected fake Gemini API key path. This must be removed; missing configuration must fail explicitly.
- `ProviderManager` advertises multiple providers while mapping them to the same Gemini model. This is misleading and must be replaced by real provider adapters or honest single-provider configuration.
- The current server contains demo/in-memory subscriber records and simulated campaign behavior. These must remain clearly separated from production integrations.
- The repository contains powerful tools such as arbitrary Node execution and external form submission. These require explicit security boundaries before production use.

## Implementation order

1. Introduce independent realtime state model. **Done in this branch.**
2. Remove fake credential fallback.
3. Make provider configuration truthful.
4. Integrate state transitions into the browser audio event flow.
5. Add overlap detection and timestamped speech events.
6. Harden interruption handling so it does not destroy independent state.
7. Evaluate AudioWorklet migration.
8. Add automated tests for concurrent speech states and reconnect behavior.
9. Add production security boundaries around tools.
10. Run build/type/test verification before considering merge.

## Non-negotiable acceptance test

While assistant audio is playing, the browser must continue microphone capture and forward user audio. If the user starts speaking before assistant playback completes, the system must be capable of representing both speech streams as active simultaneously. The microphone must not be disabled merely because assistant output is playing.
