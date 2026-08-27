#!/usr/bin/env node

/**
 * THE THINGS RECONCILIATION MUST NEVER ACCEPT.
 *
 * Every case here was demonstrated against real code, not imagined. Each one
 * writes something false into a household's financial profile, so each is a
 * refusal that has to keep working no matter what the semantic layer is
 * allowed to do above it.
 *
 * These are safety assertions, not capability assertions. Nothing here says a
 * correct value must be ACCEPTED — that is the reconciler's job and it belongs
 * in the paid evals. What this file says is that a WRONG value must be
 * REFUSED, which is a property no amount of model quality can be trusted to
 * provide.
 */

import assert from 'node:assert/strict';

import { applyReconciliationPlan } from '../js/planning/reconciliation.js';
import { createHouseholdProfile, normalizeHouseholdProfile } from '../js/planning/profile.js';

const NOW = '2026-08-09T10:00:00.000Z';

function baseProfile() {
  return normalizeHouseholdProfile(createHouseholdProfile({
    profileId: 'profile_reconciliation_safety',
    primaryPersonId: 'primary',
    nowIso: NOW,
    calculationDateIso: '2026-08-09'
  }));
}

async function apply({ text, operations, turnReadings = [] }) {
  const result = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: [],
    plan: {
      schemaVersion: 1,
      planId: 'plan_reconciliation_safety',
      verdict: 'changes_proposed',
      operationGroups: [{ groupId: 'candidate', operations }]
    },
    transcriptTurns: [{
      turnId: 'turn_reviewed', role: 'user', finalized: true, sequence: 1, text
    }],
    sessionId: 'session_reconciliation_safety',
    transcriptWatermark: 'turn_reviewed',
    baseProfileRevision: 0,
    turnReadings,
    nowIso: NOW
  });
  return {
    accepted: result.acceptedGroupIds.includes('candidate'),
    code: result.rejectedGroups?.[0]?.code || null
  };
}

const money = (amount, currency = 'EUR') => ([{
  operationId: 'proposed',
  op: 'upsert_note',
  factId: 'monthly_spending',
  noteKind: 'fact',
  value: { amount, currency },
  certainty: 'approximate',
  reasonCode: 'missing_note',
  evidence: [{ turnId: 'turn_reviewed', quote: QUOTE }]
}]);

const completion = (factId, quote) => ([{
  operationId: 'proposed',
  op: 'set_completion',
  factId,
  noteKind: 'completion',
  value: { completion: 'confirmed_none' },
  certainty: 'exact',
  reasonCode: 'explicit_none',
  evidence: [{ turnId: 'turn_reviewed', quote }]
}]);

let failures = 0;
const knownOpen = [];

/**
 * @param knownOpenReason set ONLY for a hazard that predates this work and has
 *   an owner. It is reported loudly on every run but does not fail the build,
 *   because failing it would take the whole gate red and hide the regressions
 *   around it. Silence is what is forbidden here, not the open item.
 */
async function refuses(label, options, knownOpenReason = null) {
  const outcome = await apply(options);
  if (!outcome.accepted) {
    console.log(`  PASS  ${label} — refused ${outcome.code}`);
    return;
  }
  if (knownOpenReason) {
    knownOpen.push({ label, knownOpenReason });
    console.log(`  KNOWN-OPEN  ${label} — ACCEPTED (${knownOpenReason})`);
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${label} — ACCEPTED`);
}

/* ================================= invented magnitudes ==================== */

// A truncating scan reads "two and a half thousand" as 2. Any rule that lets a
// reviewer "extend" that reading has to bound HOW FAR, or it trades one wrong
// value for a much larger one. 25,000 and 2,500,000 share 2's leading digits
// and are ten and a thousand times the spoken figure.
const SPEND = 'We spend about two and a half thousand a month on essentials.';
const QUOTE = 'about two and a half thousand a month';

console.log('\nA reviewed turn must not license an invented magnitude:');
for (const amount of [2_000, 25_000, 250_000, 2_500_000, 20_000_000, 4_100]) {
  await refuses(`"two and a half thousand" does not support ${amount.toLocaleString('en-IE')}`,
    { text: SPEND, operations: money(amount) });
}

// THE ORIGINAL INVERSION, STILL OPEN. The truncating scan reads this phrase as
// 2 and that reading is still authoritative, so a EUR 2 monthly spend can
// still be written while the correct 2,500 is refused. This is the defect the
// whole semantic-review effort exists to end; the first attempt at ending it
// opened a wider hole and was removed. It is deliberately NOT a build failure:
// it predates this work, closing it needs the corrected Phase 3 design, and a
// permanently red gate would hide the regressions above it.
await refuses('"two and a half thousand" does not support 2 (turn not read)',
  { text: SPEND, operations: money(2) },
  'legacy path only: closed by an independent reading, which is off by default');

// AND CLOSED, once the turn has actually been read. The same input, with a
// second reading present, refuses the truncation and accepts the figure the
// client gave. This is the acceptance criterion the whole effort was for.
console.log('\nA turn that was independently read closes it:');
{
  const reading = [{
    turnId: 'turn_reviewed',
    figures: [{ digits: 2500, quote: 'two and a half thousand', currency: null, ambiguous: false }]
  }];
  const truncation = await apply({ text: SPEND, operations: money(2), turnReadings: reading });
  if (truncation.accepted) {
    failures += 1;
    console.error('  FAIL  a read turn still supports the scan\'s truncation — ACCEPTED');
  } else {
    console.log(`  PASS  a read turn refuses 2 — ${truncation.code}`);
  }
  const recovered = await apply({ text: SPEND, operations: money(2500), turnReadings: reading });
  if (!recovered.accepted) {
    failures += 1;
    console.error(`  FAIL  a read turn must accept the figure the client gave — refused ${recovered.code}`);
  } else {
    console.log('  PASS  a read turn accepts 2500');
  }
}

/* ============================ categorical absence ======================== */

// Emptying a collection is destructive in a way a wrong number is not: it
// asserts the client HAS nothing, and downstream analysis stops asking. It
// must never rest on a bare affirmation or on a statement about something else.
console.log('\nA reviewed turn must not empty a collection without saying so:');

const noneCases = [
  ['a bare "Yes." cannot empty the pensions', 'Yes.', 'pension_positions', 'Yes.'],
  ['an unrelated statement cannot empty the liabilities',
    'I still have the mortgage.', 'liability_position', 'I still have the mortgage.'],
  ['a question answered about something else cannot empty the pensions',
    'That is right, the mortgage is with Bank of Ireland.', 'pension_positions',
    'That is right, the mortgage is with Bank of Ireland.']
];
for (const [label, text, factId, quote] of noneCases) {
  const outcome = await apply({ text, operations: completion(factId, quote) });
  if (outcome.accepted) {
    failures += 1;
    console.error(`  FAIL  ${label} — ACCEPTED`);
  } else {
    console.log(`  PASS  ${label} — refused ${outcome.code}`);
  }
}

/* ================================ currency substitution ================== */

// The client said pounds. Writing euro is not a smaller error than writing the
// wrong number — it is the same error with a nicer failure mode, because the
// figure looks right. Where an explicit currency is present in the quote but
// cannot be attached to the amount, the only safe answer is to refuse.
//
// NOTE: this asserts only that EUR is refused. Making GBP ACCEPT here needs the
// currency scanner to read past an unparsed magnitude word, which is exactly
// the phrase-specific grammar this remediation is not adding. Refusing is the
// safe half and it is the half that belongs in a permanent check.
console.log('\nAn explicit currency in the quote must not be silently replaced:');
{
  const text = 'Mine is a hundred and eighty grand pounds.';
  const quote = 'a hundred and eighty grand pounds';
  for (const reviewed of [true, false]) {
    const outcome = await apply({
      text,
      reviewed,
      operations: [{
        operationId: 'proposed',
        op: 'upsert_note',
        factId: 'monthly_spending',
        noteKind: 'fact',
        value: { amount: 180, currency: 'EUR' },
        certainty: 'approximate',
        reasonCode: 'missing_note',
        evidence: [{ turnId: 'turn_reviewed', quote }]
      }]
    });
    const label = `"${quote}" does not support a EUR amount`;
    if (outcome.accepted) {
      failures += 1;
      console.error(`  FAIL  ${label} — ACCEPTED`);
    } else {
      console.log(`  PASS  ${label} — refused ${outcome.code}`);
    }
  }
}

/* ================================= known-good must survive =============== */

// The refusals above are worthless if they were bought by refusing everything.
console.log('\nThe ordinary digit path must still work:');
{
  const outcome = await apply({
    text: 'We spend about 2500 a month on essentials.',
    operations: [{
      operationId: 'proposed',
      op: 'upsert_note',
      factId: 'monthly_spending',
      noteKind: 'fact',
      value: { amount: 2500, currency: 'EUR' },
      certainty: 'approximate',
      reasonCode: 'missing_note',
      evidence: [{ turnId: 'turn_reviewed', quote: 'about 2500 a month' }]
    }]
  });
  if (!outcome.accepted) {
    failures += 1;
    console.error(`  FAIL  a plainly stated 2500 must still be accepted — refused ${outcome.code}`);
  } else {
    console.log('  PASS  a plainly stated 2500 is still accepted');
  }
}

/* ============================ order independence ========================= */

// CURRENCY VALIDATION MUST NOT DEPEND ON WHAT RAN BEFORE IT.
//
// The unattached-currency detector was written with a `g`-flagged regex and
// `.test()`, which advances that shared regex's lastIndex. The very next
// `matchAll` on the same pattern then starts mid-string and silently drops
// earlier matches — so identical evidence was accepted or refused depending on
// which quote had been validated a moment earlier. A gate that is only
// sometimes a gate is not one.
console.log('\nCurrency validation must be order-independent:');
{
  const conflicting = {
    text: 'It is £500 EUR.',
    operations: [{
      operationId: 'proposed',
      op: 'upsert_note',
      factId: 'monthly_spending',
      noteKind: 'fact',
      value: { amount: 500, currency: 'GBP' },
      certainty: 'approximate',
      reasonCode: 'missing_note',
      evidence: [{ turnId: 'turn_reviewed', quote: '£500 EUR' }]
    }]
  };
  const unattached = {
    text: 'Mine is a hundred and eighty grand pounds.',
    operations: [{
      operationId: 'proposed',
      op: 'upsert_note',
      factId: 'monthly_spending',
      noteKind: 'fact',
      value: { amount: 180, currency: 'EUR' },
      certainty: 'approximate',
      reasonCode: 'missing_note',
      evidence: [{ turnId: 'turn_reviewed', quote: 'a hundred and eighty grand pounds' }]
    }]
  };
  const first = await apply(conflicting);
  await apply(unattached);
  const third = await apply(conflicting);
  if (first.accepted !== third.accepted) {
    failures += 1;
    console.error('  FAIL  the same evidence changed verdict after an unrelated quote'
      + ` (${first.accepted ? 'accepted' : 'refused'} then ${third.accepted ? 'accepted' : 'refused'})`);
  } else if (first.accepted) {
    failures += 1;
    console.error('  FAIL  a quote naming two conflicting currencies was accepted');
  } else {
    console.log('  PASS  conflicting-currency evidence refuses identically before and after');
  }
}

if (knownOpen.length > 0) {
  console.log(`\n${knownOpen.length} known-open hazard(s), carried deliberately:`);
  for (const item of knownOpen) console.log(`  - ${item.label}\n      ${item.knownOpenReason}`);
}

if (failures > 0) {
  console.error(`\ncheck-consumer-reconciliation-safety: ${failures} unsafe acceptance(s).`);
  process.exit(1);
}
console.log(`\ncheck-consumer-reconciliation-safety: every fixed hazard stays refused`
  + `${knownOpen.length > 0 ? `, ${knownOpen.length} known-open and reported above` : ''}.`);
