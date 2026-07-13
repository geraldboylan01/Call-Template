import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const appHtml = source('app/index.html');
const appSource = source('js/app.js');
const planAppSource = source('js/plan/app.js');
const planStoreSource = source('js/plan/store.js');
const renderSource = source('js/render.js');

assert.match(appHtml, /id="consumerPlannerTestBtn"[\s\S]*?class="ui-button is-hidden"/);
assert.match(appHtml, /id="mobileOverflowConsumerPlannerTestBtn"/);
assert.match(renderSource, /consumerPlannerTestButton:\s*document\.getElementById\('consumerPlannerTestBtn'\)/);
assert.match(renderSource, /mobileOverflowConsumerPlannerTestButton:\s*document\.getElementById\('mobileOverflowConsumerPlannerTestBtn'\)/);
assert.match(appSource, /advisorAuthState\.enabled[\s\S]*?advisorAuthState\.authenticated/);
assert.match(appSource, /\/api\/advisor\/consumer-invite/);
assert.match(appSource, /includeCsrf:\s*true/);
assert.match(appSource, /target\.origin/);
assert.match(appSource, /consumerPlannerLaunchInFlight/);
assert.match(appSource, /pendingConsumerPlannerUrl/);
assert.match(appSource, /window\.open\('about:blank', '_blank'\)/);
assert.match(appSource, /plannerWindow\.opener = null/);
assert.match(appSource, /plannerWindow\.location\.replace\(privateUrl\)/);
assert.doesNotMatch(appSource, /window\.location\.assign\(privateUrl\)/);
assert.doesNotMatch(appSource, /copyToClipboard\(privateUrl\)/);
assert.match(planAppSource, /const capturedInvite = captureInviteFromUrlFragment\(\);[\s\S]*?if \(capturedInvite\) \{[\s\S]*?clearSessionAccess\(\)/);
assert.match(planStoreSource, /\^ci1\\\./);

const storageValues = new Map();
const sessionStorage = {
  getItem(key) { return storageValues.has(key) ? storageValues.get(key) : null; },
  setItem(key, value) { storageValues.set(key, String(value)); },
  removeItem(key) { storageValues.delete(key); }
};
let replacedUrl = '';
globalThis.window = {
  sessionStorage,
  location: {
    hash: '',
    pathname: '/plan/',
    search: ''
  },
  history: {
    replaceState(_state, _title, value) { replacedUrl = String(value); }
  }
};
const store = await import('../js/plan/store.js');
const invite = `ci1.${'a'.repeat(80)}.${'b'.repeat(43)}`;
store.storeSessionAccess({ id: `cs_${'c'.repeat(24)}` }, `cs_${'c'.repeat(24)}.${'d'.repeat(43)}`);
window.location.hash = `#invite=${invite}`;
const captured = store.captureInviteFromUrlFragment();
if (captured) store.clearSessionAccess();
assert.equal(captured, invite);
assert.equal(store.getStoredSessionAccess(), null, 'A fresh valid invite must outrank cloned or stale session access.');
assert.equal(store.getConsumerInvite(), invite, 'Clearing stale access must preserve the fresh invite.');
assert.equal(replacedUrl, '/plan/', 'The bearer invite must be removed from browser history immediately.');

store.storeSessionAccess({ id: `cs_${'e'.repeat(24)}` }, `cs_${'e'.repeat(24)}.${'f'.repeat(43)}`);
window.location.hash = '#invite=invalid';
const invalidCapture = store.captureInviteFromUrlFragment();
if (invalidCapture) store.clearSessionAccess();
assert.equal(invalidCapture, '');
assert.ok(store.getStoredSessionAccess(), 'An invalid fragment must not erase valid session access.');

console.log('Consumer adviser launcher checks passed.');
