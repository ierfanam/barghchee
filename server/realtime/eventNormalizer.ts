import type { FullDuplexState, SpeechState } from './fullDuplexState';

export interface NormalizedRealtimeEvent {
  type: string;
  userSpeechState?: SpeechState;
  assistantSpeechState?: SpeechState;
  audio?: string;
  userTranscriptDelta?: string;
  userTranscript?: string;
  interrupted?: boolean;
  error?: unknown;
}

export function applyRealtimeEvent(
  state: FullDuplexState,
  event: NormalizedRealtimeEvent,
): FullDuplexState {
  const next = {
    ...state,
    userSpeech: event.userSpeechState ?? state.userSpeech,
    assistantSpeech: event.assistantSpeechState ?? state.assistantSpeech,
  };

  return {
    ...next,
    overlap: next.userSpeech === 'SPEAKING' && next.assistantSpeech === 'SPEAKING',
  };
}
