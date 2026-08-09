import assert from 'node:assert/strict';
import { PRODUCTION_SESSION_POLICY, validateSessionPolicy } from './session-policy';

validateSessionPolicy(PRODUCTION_SESSION_POLICY);
assert.equal(PRODUCTION_SESSION_POLICY.continuousInput, true);
assert.equal(PRODUCTION_SESSION_POLICY.allowOverlap, true);
assert.equal(PRODUCTION_SESSION_POLICY.allowBargeIn, true);
assert.equal(PRODUCTION_SESSION_POLICY.requireServerCredential, true);

// The gateway contract deliberately keeps provider credentials server-side.
assert.equal('apiKey' in PRODUCTION_SESSION_POLICY, false);

console.log('realtime gateway contract tests passed');
