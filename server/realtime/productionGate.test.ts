import assert from 'node:assert/strict';
import { getRealtimeReadiness } from './productionGate';

const checks = getRealtimeReadiness();
assert.ok(checks.some(check => check.name === 'provider-configured'));
assert.ok(checks.some(check => check.name === 'model-configured'));
console.log('productionGate.test.ts: PASS');
