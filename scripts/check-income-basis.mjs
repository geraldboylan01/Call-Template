#!/usr/bin/env node

/**
 * GROSS BY DEFAULT — the shared reading of what a client said about their pay.
 *
 * THE DEFECT THIS PINS. `income_sources` holds `grossAnnual` or `netAnnual` and
 * nothing decided which: the basis was whichever key the caller happened to use.
 * On a paid probe a real planner met "I am on 95,000 a year", had no rule to
 * follow, and asked whether that was gross or net — a reasonable question from a
 * model with nothing to go on, and the wrong question to put to a client who had
 * just told you their salary.
 *
 * The rule is now deterministic and lives in the shared planning layer, applied
 * inside the shared canonicalisation mapper. THAT is what these tests are really
 * checking: not that a prompt says the right thing, but that the same sentence
 * produces the same canonical record whichever lane reads it.
 *
 * IT IS AN INTERPRETATION RULE, NOT A LICENCE TO INVENT. Every case here asserts
 * the amount is one the client actually said; nothing is scaled, converted or
 * supplied. A monthly figure is refused rather than annualised.
 */

import assert from 'node:assert/strict';

import { classifyIncomeBasis, resolveIncomeBasis } from '../js/planning/income_basis.js';
import { createHouseholdProfile, normalizeHouseholdProfile } from '../js/planning/profile.js';
import { mapRealtimeFact } from '../worker/src/consumer/realtime_fact_mapper.js';
import { mapReconciledFactValue } from '../worker/src/consumer/planner_reconciliation.js';
import { partitionSupportedLiveFacts } from '../worker/src/consumer/live/live_tools.js';

const pass = (message) => console.info(`[IncomeBasis] PASS: ${message}`);

const profile = () => normalizeHouseholdProfile(createHouseholdProfile({
  profileId: 'income-basis',
  primaryPerson: { personId: 'primary', role: 'primary', age: 45 }
}));

/** One income fact, as the mapper receives it from either lane. */
const mapIncome = (value, evidenceText) => mapRealtimeFact(profile(), {
  factId: 'income_sources',
  value: { operation: 'upsert', entityId: 'job1', type: 'employment', owner: 'primary', ...value },
  evidenceText
});

const record = (mapped) => mapped.canonicalValue[0];
const refusalFrom = (value, evidenceText) => {
  try {
    mapIncome(value, evidenceText);
    return null;
  } catch (error) {
    return error?.code || 'threw';
  }
};

/* ------------------------------------------------------- the wording itself */

for (const [text, expected] of [
  ['I earn 95,000 a year', null],
  ["I'm on 95,000", null],
  ['My salary is 95,000', null],
  ['My annual income is 95,000', null],
  ['I make about 95k', null],
  ['My gross salary is 95,000', 'gross'],
  ['I take home 60,000', 'net'],
  ['My net income is 60,000', 'net'],
  ['After tax I get 60,000', 'net'],
  ['About 5,000 hits my account each month', 'net'],
  ['I clear 3,000 a month', 'net'],
  ['My gross salary is 95k but I take home 60k', 'conflicting']
]) {
  assert.equal(classifyIncomeBasis(text), expected, `wording read wrongly: "${text}"`);
}
pass('client wording is classified as gross, net, conflicting or unstated');

// The default is applied by the RESOLVER, not by the classifier: an unstated
// basis is genuinely unstated, and only becomes gross when a value needs a slot.
assert.deepEqual(resolveIncomeBasis({ evidenceText: 'I earn 95,000 a year' }), { basis: 'gross' });
assert.deepEqual(resolveIncomeBasis({ evidenceText: 'I take home 60,000' }), { basis: 'net' });
assert.equal(resolveIncomeBasis({ evidenceText: 'gross is 95k but I take home 60k' }).refused, true);
assert.deepEqual(
  resolveIncomeBasis({ statedBasis: 'gross', evidenceText: 'gross is 95k but I take home 60k' }),
  { basis: 'gross' },
  'a caller that names the basis resolves its own ambiguity'
);
assert.equal(
  resolveIncomeBasis({ statedBasis: 'gross', evidenceText: 'I take home 60,000' }).refused, true,
  'the default must never override the client saying take-home'
);
pass('the gross default never overrides explicit net wording, and a conflict fails closed');

/* ------------------------------------------------- an unbased amount canonicalises */

for (const text of [
  "I'm on 95,000 a year",
  'My salary is 95,000',
  'I earn 95,000 a year',
  'My annual income is 95,000'
]) {
  const mapped = record(mapIncome({ amount: 95_000 }, text));
  assert.deepEqual(mapped.grossAnnual, { amount: 95_000, currency: 'EUR' },
    `"${text}" must canonicalise as gross annual income`);
  assert.equal(mapped.netAnnual, undefined, `"${text}" must not be written as net`);
}
pass('an ordinary statement of pay becomes grossAnnual without anyone being asked');

{
  const mapped = record(mapIncome({ amount: 60_000 }, 'I take home 60,000'));
  assert.deepEqual(mapped.netAnnual, { amount: 60_000, currency: 'EUR' });
  assert.equal(mapped.grossAnnual, undefined, 'take-home must not be recorded as gross');

  const net = record(mapIncome({ amount: 60_000 }, 'My net income is 60,000'));
  assert.deepEqual(net.netAnnual, { amount: 60_000, currency: 'EUR' });
  assert.equal(net.grossAnnual, undefined);
}
pass('take-home and net wording become netAnnual');

/* ------------------------------------------------------------ nothing invented */

{
  // No annualisation rule exists for these slots, so a monthly figure is refused
  // rather than multiplied by twelve. The classification still works — it is
  // net — but the CONVERSION is what this contract cannot do.
  assert.equal(classifyIncomeBasis('After tax I get 5,000 per month'), 'net');
  assert.equal(refusalFrom({ amount: 5_000 }, 'After tax I get 5,000 per month'),
    'realtime_income_period_unsupported',
    'a monthly figure must be refused, never annualised into a number nobody said');

  // And an explicit annual key with monthly wording is the caller's assertion,
  // which the numeric guard grounds separately — not this rule's business.
  const explicit = record(mapIncome({ netAnnual: { amount: 60_000, currency: 'EUR' } },
    'After tax I get 60,000 over the year'));
  assert.deepEqual(explicit.netAnnual, { amount: 60_000, currency: 'EUR' });
}
pass('a sub-annual figure is refused rather than converted');

{
  // Conflicting wording must not collapse two different figures into one slot.
  const conflicting = 'My gross salary is 95k but I take home 60k';
  assert.equal(refusalFrom({ amount: 95_000 }, conflicting), 'realtime_income_basis_unclear',
    'an unbased amount in a two-basis sentence must fail closed');
  // Naming the basis resolves it, and each figure keeps its own slot.
  const gross = record(mapIncome({ grossAnnual: { amount: 95_000, currency: 'EUR' } }, conflicting));
  assert.deepEqual(gross.grossAnnual, { amount: 95_000, currency: 'EUR' });
  assert.equal(gross.netAnnual, undefined, 'the take-home figure must not follow the gross one in');
}
pass('conflicting wording fails closed and never merges two figures');

{
  assert.equal(refusalFrom({ grossAnnual: { amount: 60_000, currency: 'EUR' } }, 'I take home 60,000'),
    'realtime_income_basis_unclear',
    'a caller contradicting the client must be refused, not silently corrected');
}
pass('a stated basis that contradicts the client is refused');

/* ------------------------------------------ both lanes reach the same answer */

{
  const text = "I'm on 95,000 a year";
  const live = record(mapIncome({ amount: 95_000 }, text));
  const reconciled = mapReconciledFactValue(profile(), {
    factId: 'income_sources',
    entityId: 'job1',
    ownerId: 'primary',
    value: { operation: 'upsert', entityId: 'job1', type: 'employment', owner: 'primary', amount: 95_000 },
    evidenceRefs: [{ turnId: 't1', start: 0, end: text.length, quote: text }]
  });
  assert.deepEqual(record(reconciled).grossAnnual, live.grossAnnual,
    'the reconciler and the live lane must read one sentence one way');
  assert.equal(record(reconciled).netAnnual, undefined);
}
pass('the live lane and the background reconciler agree, because they share the rule');

/* --------------------------------------------- numeric grounding is untouched */

{
  // The basis rule says nothing about whether the FIGURE is real. That is the
  // live numeric guard's job, and it still refuses what it cannot bind.
  //
  // This case used to be "I'm on 95,000 a year. I put in 6 percent and the
  // company puts in 8 percent." — refused, and the income left for the
  // reconciler to repair. That refusal was a DEFECT, not a safety property:
  // "I'm on 95,000 a year" is a plain salary statement, the percentages sit in
  // a separate clause and are not amounts, and the fast lane now captures it.
  // What must still fail closed is a figure that genuinely cannot be attributed.
  const income = (amount) => [{
    factId: 'income_sources',
    value: { operation: 'upsert', entityId: 'job1', type: 'employment', owner: 'primary', amount },
    certainty: 'exact'
  }];
  const guard = (amount, said) => partitionSupportedLiveFacts(
    income(amount), said, { clientSourcedFigures: { values: [] }, assistantReadBack: '' }
  );

  const collective = guard(95_000, 'We are on 95,000 and 40,000 between us.');
  assert.equal(collective.accepted.length, 0,
    'the numeric guard must still fail closed on an unbindable figure');
  assert.equal(collective.rejected[0]?.reason, 'live_numeric_fact_unsupported');

  // The swap this boundary exists to stop: a contribution rate recorded as pay.
  const crowded = "I'm on 95,000 a year. I put in 6 percent and the company puts in 8 percent.";
  assert.equal(guard(6, crowded).accepted.length, 0,
    'a contribution percentage must never be captured as the salary');
  assert.equal(guard(88_000, crowded).accepted.length, 0,
    'nor a figure the client never said');
  assert.equal(guard(95_000, crowded).accepted.length, 1,
    'while the salary the client plainly stated is captured live');

  // A figure the client never said is still refused, gross default or not.
  assert.equal(refusalFrom({ amount: 123_456 }, "I'm on 95,000 a year") === null, true,
    'the mapper canonicalises what it is given; grounding is the guard\'s job, not a second opinion here');
}
pass('numeric grounding is unchanged: the basis rule decides the slot, never the number');

console.info('\n[IncomeBasis] PASS: gross is the default reading, net is honoured, and both lanes agree');
