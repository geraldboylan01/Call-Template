#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyEvidenceAffirmation } from '../worker/src/consumer/live/evidence_affirmation.js';
import { classifySpokenPlanConfirmation } from '../worker/src/consumer/realtime_completion.js';
import {
  partitionSupportedLiveFacts,
  pensionIdentityDirective
} from '../worker/src/consumer/live/live_tools.js';

let checks = 0;
function equal(actual, expected, message) {
  checks += 1;
  assert.deepEqual(actual, expected, message);
}

/* ------------------------------------------------------------------------
 * WHAT THIS FILE NO LONGER TESTS.
 *
 * It began as a table of twenty phrases that were supposed to run a financial
 * analysis -- "work away", "fire away", "sure go for it" -- and a longer table
 * of phrases that were not. That table was the architecture: a growing dialect
 * allowlist standing between a sentence and the deterministic engines.
 *
 * It is deleted rather than adapted, because the thing it guarded does not
 * exist. Execution is authorised by a human pressing Run on one immutable
 * review object; no sentence in any dialect can reach the engine, so there is
 * nothing for a phrase table to get right or wrong.
 *
 * WHAT SURVIVES, AND WHY IT IS DIFFERENT IN KIND.
 *
 * Binding a FIGURE to a read-back the client answered is evidence handling,
 * not authorisation: "your PRSA is about EUR 28,000, is that right?" / "Yes."
 * The anti-forgery conditions below are structural and stay exactly as strict
 * -- the figure must be client-sourced AND must occur in the immediately
 * preceding assistant turn. A wrong figure bound on a hedge would still be a
 * wrong figure, whoever eventually presses the button.
 * --------------------------------------------------------------------- */

// The approval grammar module is deleted outright, not merely unused.
await assert.rejects(
  () => import('../worker/src/consumer/live/execution_approval.js'),
  /Cannot find module|ERR_MODULE_NOT_FOUND/,
  'the execution-approval grammar no longer exists'
);
checks += 1;

const archivedSource = readFileSync(new URL('../worker/src/consumer/realtime_session.js', import.meta.url), 'utf8');
equal(archivedSource.includes('confirmAndRunRealtimeAnalysisPlan'), false,
  'and the archived lane holds no execution route for one to feed');

const money = (amount) => [{ factId: 'pension_current_value', value: { amount, currency: 'EUR' }, certainty: 'approximate' }];
const sourced = { values: [28000, 54000] };
const readback = 'Your PRSA is about EUR 28,000, is that right?';
const binds = (speech, assistantReadBack, values, amount = 28000) => partitionSupportedLiveFacts(
  money(amount), speech, { assistantReadBack, clientSourcedFigures: { values } }
).accepted.length;
equal(binds('Yes', readback, sourced.values), 1, 'Client source AND preceding read-back bind the figure');
equal(binds('Yes', readback, [54000]), 0, 'A model-read figure with no client source cannot bind');
equal(binds('Yes', 'Your salary is EUR 54,000, correct?', sourced.values), 0, 'A different prior client figure cannot bind');
equal(binds('Yes', '', sourced.values), 0, 'No preceding read-back means no binding');
for (const declined of ['yes run the plan', 'yeah around that', 'roughly', 'about that', 'I think so']) {
  equal(binds(declined, readback, sourced.values), 0, `Evidence expansion waits for Phase 2: ${declined}`);
}

const none = [{ factId: 'pension_positions', value: { operation: 'confirm_none', owner: 'partner' }, certainty: 'exact' }];
const confirmsNone = (speech, assistantReadBack) => partitionSupportedLiveFacts(none, speech, { assistantReadBack }).accepted.length;
equal(confirmsNone('Yes', 'Your partner has no pension at all?'), 1, 'The none proposition in the read-back is retained');
equal(confirmsNone('Yes', 'Your partner has a pension?'), 0, 'An affirmation cannot invent categorical absence');
equal(confirmsNone('I think so', 'Your partner has no pension at all?'), 0, 'A hedge cannot establish absence');
equal(pensionIdentityDirective('Yes', 'Is that the same pension?'), 'same', 'Identity proposition context remains required');
equal(pensionIdentityDirective('Yes', 'Is that the same pension or a different one?'), null, 'Two identity propositions remain unresolved');
equal(pensionIdentityDirective('Yes', 'Is your salary correct?'), null, 'Unrelated affirmations cannot establish identity');
equal(pensionIdentityDirective('I think so', 'Is that the same pension?'), null, 'Identity hedges remain unresolved');

console.info(`[LiveEvidenceBinding] ${checks} checks passed.`);
