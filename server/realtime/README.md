# Realtime Full-Duplex Layer

This directory contains the state model used to evolve BARghCHEE toward genuine full-duplex voice conversation.

## Invariants

1. Microphone capture must remain active while assistant audio is playing.
2. Assistant playback must not implicitly disable microphone capture.
3. User speech and assistant speech are independent state dimensions.
4. `overlap === true` is valid when both sides are speaking.
5. Barge-in and overlap are different concepts; an interruption event must not be used as a substitute for full-duplex state.
6. Provider-specific code belongs in provider adapters rather than UI components.

The current branch intentionally introduces the state model first. Audio transport and UI integration should be performed only after the existing Gemini Live event flow has been audited against these invariants.
