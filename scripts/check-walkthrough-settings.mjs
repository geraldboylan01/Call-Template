import assert from 'node:assert/strict';
import { expandWalkthroughSettings, parseWalkthroughSettings } from '../worker/src/walkthrough_settings.js';

const gates = ['STRIPE_WALKTHROUGHS_ENABLED', 'STRIPE_WALKTHROUGH_LIVE_ACTIVATED', 'WALKTHROUGH_EMAILS_ENABLED'];
const live = { STRIPE_MODE: 'live', STRIPE_TAX_MODE: 'no_collection', STRIPE_WALKTHROUGH_PRICE_ID: 'price_Live123',
  STRIPE_WALKTHROUGHS_ENABLED: 'true', STRIPE_WALKTHROUGH_LIVE_ACTIVATED: 'true', WALKTHROUGH_EMAILS_ENABLED: 'true' };
const otherApp = { LEADS_DB: {}, CONSUMER_DB: {}, CONSUMER_JOURNEY_ENABLED: 'true', STRIPE_API_KEY: 'kept-server-secret',
  STRIPE_WEBHOOK_SECRET: 'kept-webhook-secret' };
assert.equal(expandWalkthroughSettings(otherApp), otherApp, 'ordinary direct-binding environments remain compatible');
const defaults = parseWalkthroughSettings('{}');
for (const name of gates) assert.equal(defaults[name], 'false');
assert.equal(defaults.STRIPE_MODE, 'test');
const expanded = expandWalkthroughSettings({ ...otherApp, WALKTHROUGH_SETTINGS_JSON: JSON.stringify(live) });
for (const [name, value] of Object.entries(live)) assert.equal(expanded[name], value);
for (const [name, value] of Object.entries(otherApp)) assert.equal(expanded[name], value, `unrelated setting/binding changed: ${name}`);
for (const name of gates) {
  assert.equal(expandWalkthroughSettings({ WALKTHROUGH_SETTINGS_JSON: JSON.stringify(live), [name]: 'false' })[name], 'false',
    'explicit operational kill switches override packed activation');
}
const invalid = ['{', 'null', '[]', '"text"', '{"__proto__":"forbidden"}', '{"STRIPE_API_KEY":"forbidden"}',
  '{"STRIPE_WEBHOOK_SECRET":"forbidden"}', '{"CONSUMER_JOURNEY_ENABLED":"false"}', '{"STRIPE_MODE":"unknown"}',
  '{"STRIPE_TAX_MODE":"automatic"}', '{"STRIPE_WALKTHROUGH_PRICE_ID":"bad price"}', '{"STRIPE_WALKTHROUGHS_ENABLED":true}',
  '{"WALKTHROUGH_EMAILS_ENABLED":"yes"}', '{"STRIPE_WALKTHROUGHS_ENABLED":"true"}', ' '.repeat(4097)];
for (const raw of invalid) {
  assert.throws(() => parseWalkthroughSettings(raw), /Invalid walkthrough settings/);
  const failed = expandWalkthroughSettings({ ...otherApp, ...live, WALKTHROUGH_SETTINGS_JSON: raw });
  for (const name of gates) assert.equal(failed[name], 'false', 'invalid configuration cannot activate a direct-binding gate');
  for (const [name, value] of Object.entries(otherApp)) assert.equal(failed[name], value, 'malformed payment settings must not break the rest of the app');
  assert.equal(failed.STRIPE_MODE, 'live', 'outstanding direct-mode webhooks retain their environment identity');
}
console.info('[WalkthroughSettings] PASS: defaults, live configuration, operational overrides, malformed input isolation and credential exclusion.');
