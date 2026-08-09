/**
 * Realtime conversation state model.
 *
 * The key design decision is that connection, user speech and assistant speech
 * are independent dimensions. A single mutually-exclusive `aiState` cannot
 * represent genuine full-duplex conversation because USER_SPEAKING and
 * ASSISTANT_SPEAKING may be true at the same time.
 */

export type ConnectionState =
  | 'IDLE'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'ERROR'
  | 'DISCONNECTED';

export type SpeechState =
  | 'SILENT'
  | 'STARTING'
  | 'SPEAKING'
  | 'ENDING'
  | 'INTERRUPTED';

export interface FullDuplexState {
  connection: ConnectionState;
  userSpeech: SpeechState;
  assistantSpeech: SpeechState;
  overlap: boolean;
  sessionId: string;
}

export function createFullDuplexState(sessionId: string): FullDuplexState {
  return {
    connection: 'IDLE',
    userSpeech: 'SILENT',
    assistantSpeech: 'SILENT',
    overlap: false,
    sessionId,
  };
}

export function updateOverlap(state: FullDuplexState): FullDuplexState {
  return {
    ...state,
    overlap:
      state.userSpeech === 'SPEAKING' &&
      state.assistantSpeech === 'SPEAKING',
  };
}

export function isFullDuplex(state: FullDuplexState): boolean {
  return (
    state.connection === 'CONNECTED' &&
    state.userSpeech === 'SPEAKING' &&
    state.assistantSpeech === 'SPEAKING'
  );
}
