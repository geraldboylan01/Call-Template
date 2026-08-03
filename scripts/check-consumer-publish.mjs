/**
 * A finished call publishing itself.
 *
 * Every published session used to be created by an authenticated adviser --
 * `handleCreatePublishedSession` opens with `requireAdvisorSession`, and that
 * gate was the whole security model. Letting a consumer session publish widens
 * who can put a page in front of a client under Planéir's name, so the checks
 * below are mostly about what a caller CANNOT do.
 *
 * The load-bearing one: the request decides nothing about the content. It
 * proves it holds a session, and every byte of the payload is rebuilt from the
 * confirmed profile and the analysis the engine already ran.
 */

import assert from 'node:assert/strict';

import { applyProfilePatch, createHouseholdProfile, runPlanningModule } from '../js/planning/index.js';
import { getConsumerConfig } from '../worker/src/consumer/config.js';
import {
  buildAdviserNotification,
  buildPublishedLinks,
  publishConsumerAnalysis
} from '../worker/src/consumer/publish.js';

const NOW = '2026-08-02T09:00:00.000Z';
const provenance = {
  source: 'user_confirmation', confidence: 'high', certainty: 'exact',
  capturedAt: NOW, confirmedByUser: true
};

let checks = 0;
const check = (label, condition, detail = '') => {
  checks += 1;
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
};

const profile = applyProfilePatch(
  createHouseholdProfile({ profileId: 'pub', nowIso: NOW, calculationDateIso: '2026-08-02' }),
  {
    patchId: 'pub-1',
    operations: [
      { op: 'add', path: '/primaryPerson/age', value: 41, provenance },
      { op: 'add', path: '/properties/-', value: { propertyId: 'h', label: 'Family home', use: 'home', currentValue: { amount: 500_000, currency: 'EUR' } }, provenance },
      { op: 'add', path: '/assets/-', value: { assetId: 'c', label: 'Cash savings', type: 'cash', currentValue: { amount: 25_000, currency: 'EUR' }, liquid: true }, provenance },
      { op: 'add', path: '/liabilities/-', value: { liabilityId: 'm', label: 'Mortgage', type: 'mortgage', currentBalance: { amount: 200_000, currency: 'EUR' } }, provenance }
    ]
  },
  { nowIso: NOW }
).profile;

const analysis = {
  results: [await runPlanningModule('personal_balance_sheet', profile, { calculationDateIso: '2026-08-02' })]
};
const config = getConsumerConfig({
  CONSUMER_JOURNEY_ENABLED: 'false',
  CONSUMER_PUBLISHED_SESSION_BASE_URL: 'https://planeir.ie'
});
const confirmedRow = { id: 'cs_abc', current_profile_revision: 7, confirmed_profile_revision: 7 };

const stored = [];
const emails = [];
const publish = (overrides = {}) => publishConsumerAnalysis({
  env: {},
  config,
  sessionRow: confirmedRow,
  profile,
  analysis,
  storePublishedSession: async (record) => { stored.push(record); },
  notifyAdviser: async (message) => { emails.push(message); },
  ...overrides
});

const published = await publish();

/* ------------------------------------------------ it produces both links */

check('a completed call publishes', Boolean(published.publishedId));
check('one module was published', published.moduleCount === 1);
check('a client link is produced', published.clientUrl.includes('/app/session.html'));
check('an adviser link is produced', published.adviserUrl.includes('role=advisor'));
// The secret rides in the FRAGMENT so it is never sent to the server, never
// written to an access log and never carried in a Referer header.
for (const [name, url] of [['client', published.clientUrl], ['adviser', published.adviserUrl]]) {
  const [addressed, fragment] = url.split('#');
  check(`the ${name} key is in the fragment, not the path or query`,
    Boolean(fragment) && fragment.startsWith('k=') && !addressed.includes(fragment.slice(2)));
}
check('the two links carry different keys',
  published.clientUrl.split('#')[1] !== published.adviserUrl.split('#')[1],
  'a client holding their own link must not be able to open the adviser view');
check('the link expires', new Date(published.expiresAt) > new Date(published.createdAt));

/* ------------------------------------- the caller decides nothing but "go" */

const record = stored.at(-1);
check('the stored payload is encrypted, not plain modules',
  !JSON.stringify(record.requestBody).includes('Family home'),
  'the client figures must never be stored in the clear');
check('the record is traceable back to the call that made it',
  record.consumerSessionId === 'cs_abc' && record.profileRevision === 7);
check('the record is marked as consumer-originated', record.origin === 'consumer_call');

/* ---------------------------------------------------------- the gates */

await assert.rejects(
  publish({ sessionRow: { id: 'cs_abc', current_profile_revision: 8, confirmed_profile_revision: 7 } }),
  (error) => error.code === 'profile_confirmation_required',
  'a profile that moved on since it was confirmed must not be published as reviewed'
);
checks += 1;
await assert.rejects(
  publish({ analysis: { results: [] } }),
  (error) => error.code === 'analysis_incomplete'
);
checks += 1;
await assert.rejects(
  publish({ analysis: { results: [{ moduleId: 'college_funding' }] } }),
  (error) => error.code === 'analysis_not_publishable',
  'a module with no builder must not publish an empty page'
);
checks += 1;
await assert.rejects(
  publish({ storePublishedSession: null }),
  (error) => error.code === 'publish_unconfigured',
  'publishing must fail closed when storage is not wired'
);
checks += 1;

/* ------------------------------------------------------------ the email */

const notification = emails.at(-1);
check('the adviser is notified', Boolean(notification?.adviserUrl));
check('the adviser is sent the adviser link, not the client one',
  notification.adviserUrl === published.adviserUrl);
const body = buildAdviserNotification(notification);
// An inbox is the least controlled surface in the system: forwarded, synced to
// phones, searchable. It carries a link and a count; the analysis stays behind
// the encrypted link.
check('the email carries no client figures',
  !/500,000|25,000|200,000|Family home/.test(`${body.subject} ${body.text}`),
  body.text);
check('the email says how many analyses ran', /1 analysis/.test(body.subject));
check('the email says the link expires', /expires/i.test(body.text));

// A publish must still succeed when nobody is configured to be told.
const quiet = await publish({ notifyAdviser: null });
check('publishing works with no adviser notifier wired', Boolean(quiet.clientUrl));

/* ------------------------------------------------------------- links */

const links = buildPublishedLinks({
  config: { publishedSessionBaseUrl: 'https://planeir.ie/' },
  publishedId: 'abc def',
  encrypted: { clientSecretB64u: 'CLIENT', advisorSecretB64u: 'ADVISER' }
});
check('a trailing slash on the base does not double up', !links.clientUrl.includes('ie//app'));
check('the published id is url-encoded', links.clientUrl.includes('abc%20def'));

console.info(`[ConsumerPublish] ${checks} checks passed: a session authorises the publish, the server `
  + 'writes every byte of it, and the two links carry separate keys in the fragment.');
