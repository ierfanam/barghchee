import assert from 'node:assert/strict';
import { loadRealtimeRuntimeConfig } from './runtimeConfig';

assert.throws(
  () => loadRealtimeRuntimeConfig({ REALTIME_PROVIDER: 'openai', OPENAI_API_KEY: '' }),
  /OPENAI_API_KEY is required/,
);

const openai = loadRealtimeRuntimeConfig({
  REALTIME_PROVIDER: 'openai',
  REALTIME_MODEL: 'gpt-4o-live',
  OPENAI_API_KEY: 'test-key',
});
assert.equal(openai.provider, 'openai');
assert.equal(openai.model, 'gpt-4o-live');
assert.equal(openai.openaiApiKey, 'test-key');

assert.throws(
  () => loadRealtimeRuntimeConfig({ REALTIME_PROVIDER: 'unsupported', REALTIME_MODEL: 'x' }),
  /Unsupported realtime provider/,
);

const gemini = loadRealtimeRuntimeConfig({
  REALTIME_PROVIDER: 'gemini',
  REALTIME_MODEL: 'gemini-3.1-flash-live-preview',
  GEMINI_API_KEY: 'test-gemini-key',
});
assert.equal(gemini.provider, 'gemini');
assert.equal(gemini.geminiApiKey, 'test-gemini-key');

console.log('runtimeConfig tests passed');
