import assert from 'node:assert/strict';
import { DEFAULT_REALTIME_MODEL, DEFAULT_REALTIME_PROVIDER, resolveRealtimeModel } from './config';

assert.equal(DEFAULT_REALTIME_PROVIDER, process.env.REALTIME_PROVIDER ?? 'openai');
assert.equal(DEFAULT_REALTIME_MODEL, process.env.REALTIME_MODEL ?? 'gpt-4o-live');
assert.equal(resolveRealtimeModel('gpt-4o-live'), 'gpt-realtime');
assert.equal(resolveRealtimeModel('custom-realtime-model'), 'custom-realtime-model');

console.log('realtime config tests passed');
