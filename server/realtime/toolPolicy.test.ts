import assert from 'node:assert/strict';
import { getToolRisk, isToolAllowedWithoutConfirmation } from './toolPolicy';

assert.equal(getToolRisk('searchWeb'), 'READ_ONLY');
assert.equal(getToolRisk('displayWidget'), 'LOW_RISK');
assert.equal(getToolRisk('initiateLivePhoneCall'), 'CONFIRM_REQUIRED');
assert.equal(getToolRisk('executeNodeCode'), 'HIGH_RISK');
assert.equal(getToolRisk('unknownTool'), 'HIGH_RISK');

assert.equal(isToolAllowedWithoutConfirmation('searchWeb'), true);
assert.equal(isToolAllowedWithoutConfirmation('displayWidget'), true);
assert.equal(isToolAllowedWithoutConfirmation('submitForm'), false);
assert.equal(isToolAllowedWithoutConfirmation('executeNodeCode'), false);

console.log('toolPolicy tests passed');
