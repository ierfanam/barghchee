import assert from 'node:assert/strict';
import {
  createFullDuplexState,
  isFullDuplex,
  updateOverlap,
} from './fullDuplexState';

const state = createFullDuplexState('test-session');
assert.equal(state.connection, 'IDLE');
assert.equal(state.userSpeech, 'SILENT');
assert.equal(state.assistantSpeech, 'SILENT');
assert.equal(state.overlap, false);

const connected = updateOverlap({
  ...state,
  connection: 'CONNECTED',
  userSpeech: 'SPEAKING',
  assistantSpeech: 'SPEAKING',
});

assert.equal(connected.overlap, true);
assert.equal(isFullDuplex(connected), true);

const userOnly = updateOverlap({
  ...connected,
  assistantSpeech: 'SILENT',
});

assert.equal(userOnly.overlap, false);
assert.equal(isFullDuplex(userOnly), false);

const assistantOnly = updateOverlap({
  ...connected,
  userSpeech: 'SILENT',
});

assert.equal(assistantOnly.overlap, false);
assert.equal(isFullDuplex(assistantOnly), false);

console.log('fullDuplexState tests passed');
