#!/usr/bin/env node

/**
 * WHAT A REVIEWED TURN MAY BE READ TO SAY.
 *
 * Phase 3 moved semantic authority for a reviewed client turn from the
 * deterministic scan to the planner. This suite is the boundary that move had
 * to respect, and it separates two things the scan used to conflate:
 *
 *   TRANSCRIPTION  rendering number words the client actually said into the
 *                  digits the profile stores. "two and a half thousand" is
 *                  2500. This is the reconciler's job and must be allowed.
 *
 *   ARITHMETIC     totals, differences, percentages-of, midpoints, currency
 *                  conversion. None of it is in the transcript. This must stay
 *                  prohibited, and the guards at the bottom prove it still is.
 *
 * The scan cannot tell them apart, and its failure was not "returns nothing" —
 * it was an INVERSION. `groundedNumbers()` reads "two and a half thousand" as
 * 2, so the old gate refused the correct 2500 and accepted a €2 monthly spend.
 * Every pair below therefore runs in BOTH directions. An acceptance-only suite
 * would have left the dangerous half passing, which is why the refusals here
 * matter as much as the acceptances.
 *
 * The guard that replaced the parser's authority does not read English. An
 * under-read span still yields the leading digits the scan managed, and a
 * transcription has to extend them: strictly larger, same significant digits.
 * That admits 2500 from "two and a half thousand" while refusing 2, 4100, and
 * the 270000 total of two separate pensions.
 *
 * Cases needing the reconciler MODEL to choose between a value and a
 * clarification ("about three or four") are acceptance/eval cases, not
 * deterministic ones, and are listed at the end rather than asserted here.
 */

import {
  applyReconciliationPlan,
  projectPlanningNotesToProfile
} from '../js/planning/reconciliation.js';
import {
  createHouseholdProfile,
  normalizeHouseholdProfile
} from '../js/planning/profile.js';
import { extractNumericOccurrences } from '../js/planning/value_evidence.js';

const NOW = '2026-08-09T10:00:00.000Z';

function baseProfile() {
  return normalizeHouseholdProfile(createHouseholdProfile({
    profileId: 'profile_numeric_transcription',
    primaryPersonId: 'primary',
    nowIso: NOW,
    calculationDateIso: '2026-08-09'
  }));
}

/** One reviewed client turn proposing one money value for one fact. */
async function reviewTurn({ text, quote, amount, factId = 'monthly_spending' }) {
  const result = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: [],
    plan: {
      schemaVersion: 1,
      planId: 'plan_numeric_transcription',
      verdict: 'changes_proposed',
      operationGroups: [{
        groupId: 'reviewed_turn',
        operations: [{
          operationId: 'proposed_value',
          op: 'upsert_note',
          factId,
          noteKind: 'fact',
          value: { amount, currency: 'EUR' },
          certainty: 'approximate',
          reasonCode: 'missing_note',
          evidence: [{ turnId: 'turn_reviewed', quote }]
        }]
      }]
    },
    transcriptTurns: [{
      turnId: 'turn_reviewed', role: 'user', finalized: true, sequence: 1, text
    }],
    sessionId: 'session_numeric_transcription',
    transcriptWatermark: 'turn_reviewed',
    baseProfileRevision: 0,
    // The whole point of the scope: this turn was read by the planner, in
    // context, as one finalized client utterance.
    reviewedTurnIds: ['turn_reviewed'],
    nowIso: NOW
  });
  return {
    accepted: result.acceptedGroupIds.includes('reviewed_turn'),
    code: result.rejectedGroups?.[0]?.code || null,
    notes: result.notes || []
  };
}

const failures = [];
const results = [];

async function expect({ label, phase3Target = false, text, quote, amount, accepted }) {
  const outcome = await reviewTurn({ text, quote, amount });
  const ok = outcome.accepted === accepted;
  results.push({ label, ok, phase3Target, outcome });
  if (!ok) failures.push({ label, phase3Target, expected: accepted, outcome });
  const mark = ok ? 'PASS' : 'FAIL';
  const detail = outcome.accepted ? 'accepted' : `refused ${outcome.code}`;
  console.log(`  ${mark}  ${label} — ${detail}`);
}

/* ============================ the inversion, proved in both directions ===== */

const SPEND_TURN = 'We spend about two and a half thousand a month on essentials.';
const SPEND_QUOTE = 'about two and a half thousand a month';

console.log('\nTranscription must be allowed, and its inverse must not be:');

await expect({
  label: '"two and a half thousand" supports 2500',
  phase3Target: true,
  text: SPEND_TURN, quote: SPEND_QUOTE, amount: 2500, accepted: true
});

await expect({
  label: '"two and a half thousand" does NOT support 2',
  phase3Target: true,
  text: SPEND_TURN, quote: SPEND_QUOTE, amount: 2, accepted: false
});

const PENSION_TURN = 'Mine is a hundred and eighty grand and hers is ninety.';

await expect({
  label: '"a hundred and eighty grand" supports 180000',
  phase3Target: true,
  text: PENSION_TURN, quote: 'a hundred and eighty grand', amount: 180_000, accepted: true
});

await expect({
  label: '"a hundred and eighty grand" does NOT support 180',
  phase3Target: true,
  text: PENSION_TURN, quote: 'a hundred and eighty grand', amount: 180, accepted: false
});

await expect({
  label: '"two and a half grand" supports 2500',
  phase3Target: true,
  text: 'It is about two and a half grand a month.',
  quote: 'about two and a half grand a month', amount: 2500, accepted: true
});

await expect({
  label: '"about a hundred and eighty k" supports 180000',
  phase3Target: true,
  text: 'The pension is about a hundred and eighty k.',
  quote: 'about a hundred and eighty k', amount: 180_000, accepted: true
});

/* ==================== digits already work, and must keep working =========== */

console.log('\nThe digit path is the baseline and must not regress:');

await expect({
  label: 'digits: "about 2500 a month" supports 2500',
  text: 'We spend about 2500 a month on essentials.',
  quote: 'about 2500 a month', amount: 2500, accepted: true
});

await expect({
  label: 'digits: "about 2500 a month" does NOT support 2',
  text: 'We spend about 2500 a month on essentials.',
  quote: 'about 2500 a month', amount: 2, accepted: false
});

/* ============ arithmetic and invention stay refused after Phase 3 ========== */

console.log('\nArithmetic and invention must stay refused:');

await expect({
  label: 'no invented total: "two thousand plus the other three" does not support 5000',
  text: 'That is two thousand plus the other three.',
  quote: 'two thousand plus the other three', amount: 5000, accepted: false
});

await expect({
  label: 'no invented total: word-numbers do not license summing them either',
  text: 'Mine is a hundred and eighty grand and hers is ninety.',
  quote: 'a hundred and eighty grand and hers is ninety', amount: 270_000, accepted: false
});

await expect({
  label: 'a figure never spoken is refused',
  text: 'We spend about two and a half thousand a month on essentials.',
  quote: 'about two and a half thousand a month', amount: 4100, accepted: false
});

await expect({
  label: 'no midpoint: "three or four thousand" does not support 3500',
  text: 'Maybe three or four thousand a month.',
  quote: 'three or four thousand a month', amount: 3500, accepted: false
});

/* ======================= why the inversion is not cosmetic ================= */

// The dangerous half is not "a value is missing" — it is a wrong value with a
// real currency landing in a real profile path. Show the concrete hazard so a
// future reader cannot mistake this for a strictness preference.
console.log('\nThe hazard, stated concretely:');
const spendScan = extractNumericOccurrences(SPEND_TURN) || [];
console.log(`  deterministic scan of the spend turn -> ${JSON.stringify(
  spendScan.map((occurrence) => ({ value: occurrence.value, financial: occurrence.financial }))
)}`);
const badValue = await reviewTurn({ text: SPEND_TURN, quote: SPEND_QUOTE, amount: 2 });
if (badValue.accepted) {
  const projected = projectPlanningNotesToProfile(baseProfile(), badValue.notes, { nowIso: NOW });
  const landed = projected?.profile?.expenses?.monthlyEssential ?? projected?.expenses?.monthlyEssential;
  console.log(`  a €2 monthly spend reaches the profile as: ${JSON.stringify(landed)}`);
}

/* ================================================================== summary */

const targets = failures.filter((failure) => failure.phase3Target);
const regressions = failures.filter((failure) => !failure.phase3Target);

console.log(`\n${results.length} cases: ${results.length - failures.length} passing, `
  + `${failures.length} failing.`);

console.log(`
Not asserted here — these need the reconciler model, not the validator, and
belong in the replay/eval suite:
  - "about three or four" after a monthly-spend question -> clarification, not a value
  - "900 a month" after a childcare question -> 900 recovered despite financial:false
  - "400" after a car-repayment question -> 400 recovered from a bare terse answer
  - "Mine is a hundred and eighty grand and hers is ninety" -> BOTH pensions
    recovered, including the one Realtime never proposed`);

if (failures.length > 0) {
  console.error('\nThe reviewed-turn reading boundary moved:');
  for (const failure of failures) {
    console.error(`  - ${failure.label} (expected ${failure.expected ? 'accepted' : 'refused'})`);
  }
  // A transcription case failing means recovery broke; a refusal case failing
  // means the semantic layer can now invent a figure. The second is worse.
  process.exit(regressions.length > 0 ? 2 : 1);
}

console.log('\ncheck-consumer-live-numeric-transcription: all cases pass.');
