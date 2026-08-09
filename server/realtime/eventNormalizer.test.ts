import assert from 'node:assert/strict';
import { createFullDuplexState } from './fullDuplexState';
import { applyRealtimeEvent } from './eventNormalizer';

const state = createFullDuplexState('test');
const overlap = applyRealtimeEvent(state, {
  type: 'overlap',
  userSpeechState: 'SPEAKING',
  assistantSpeechState: 'SPEAKING',
});

assert.equal(overlap.userSpeech, 'SPEAKING');
assert.equal(overlap.assistantSpeech, 'SPEAKING');
assert.equal(overlap.overlap, true);

const interrupted = applyRealtimeEvent(overlap, {
  type: 'response.cancelled',
  interrupted: true,
  assistantSpeechState: 'INTERRUPTED',
});

assert.equal(interrupted.userSpeech, 'SPEAKING');
assert.equal(interrupted.assistantSpeech, 'INTERRUPTED');
assert.equal(interrupted.overlap, false);

console.log('eventNormalizer tests passed');
