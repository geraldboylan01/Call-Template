#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyExecutionApproval } from '../worker/src/consumer/live/execution_approval.js';
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

const approvals = [
  'yes', 'yes please', 'yes run the plan', 'grand go ahead', 'work away',
  'fire away', 'please do', 'sure go for it', 'perfect', 'yeah run that plan',
  'that sounds right go for it', 'yeah grand fire away', 'yes go ahead and run it',
  'absolutely please proceed', 'I confirm', 'I’m happy with that', 'okay go ahead',
  'that is correct', 'please generate the modules', 'yes run those analyses now'
];
for (const phrase of approvals) {
  for (const variant of [phrase, `${phrase}?`, `${phrase}!`, `${phrase}.`, phrase.replaceAll(' ', ', ')]) {
    equal(classifyExecutionApproval(variant), 'affirmed', `Natural approval: ${variant}`);
  }
}

const unclear = [
  '', 'thanks', 'please', 'I think so', 'yes I think so', 'roughly', 'about that',
  'yeah around that', 'yes if that includes Sarah', 'yes once you check the figures',
  'yes but change one thing', 'yes before we run it', 'yes unless that costs money',
  'yes maybe', 'yes probably', 'sure could you explain it', 'can you run that plan',
  'will that work', 'what does that mean', 'yes how does it work', 'yes no',
  'yes my pension is 38000', 'yes the pension is Sarah’s', 'more like €38k',
  'no that’s Sarah’s', 'yes retire earlier', 'yes exclude the pension',
  'yes use thirty eight thousand', 'not necessarily', 'yes please '.repeat(20)
];
for (const phrase of unclear) {
  equal(classifyExecutionApproval(phrase), 'ambiguous', `Review or clarification required: ${phrase}`);
  equal(classifyExecutionApproval(`${phrase}?`), 'ambiguous', 'Punctuation cannot promote approval');
}
for (const phrase of ['no', 'nope', 'no thanks', 'not now', 'please stop', 'do not proceed']) {
  equal(classifyExecutionApproval(phrase), 'rejected', `Explicit rejection: ${phrase}`);
}

// The old safety test's "one extra exchange" premise was disproved by the real
// DO reproduction: an unclear approval destroyed the offer and advanced the
// snapshot pass. The continuity regressions restore that premise. Only the
// execution component broadens; evidence and the separate lane stay identical.
for (const phrase of [...approvals, ...unclear, 'no', 'yes please go ahead', 'sure']) {
  equal(classifyEvidenceAffirmation(phrase), classifySpokenPlanConfirmation(phrase),
    `Evidence behavior is unchanged: ${phrase}`);
}
for (const phrase of ['yes run the plan', 'grand go ahead', 'work away', 'fire away', 'please do', 'sure go for it', 'perfect']) {
  equal(classifySpokenPlanConfirmation(phrase), 'ambiguous', `Archived lane still fails closed: ${phrase}`);
}

const source = readFileSync(new URL('../worker/src/consumer/realtime_session.js', import.meta.url), 'utf8');
equal(source.includes('classifyExecutionApproval'), false, 'The separate Realtime lane cannot import execution approval');

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

console.info(`[LiveExecutionApproval] ${checks} checks passed.`);
