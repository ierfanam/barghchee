import assert from 'node:assert/strict';
import { loadRealtimeRuntimeConfig } from './runtimeConfig';

assert.throws(
  () => loadRealtimeRuntimeConfig({ GEMINI_API_KEY: '' }),
  /GEMINI_API_KEY is required/,
);

const config = loadRealtimeRuntimeConfig({ GEMINI_API_KEY: 'test-key' });
assert.equal(config.geminiApiKey, 'test-key');

console.log('runtimeConfig tests passed');
