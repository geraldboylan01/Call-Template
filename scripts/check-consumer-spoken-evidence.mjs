/**
 * Does the meeting keep what the client actually said?
 *
 * THIS IS THE TEST THAT WAS MISSING.
 *
 * Conversation quality was measured only by the persona replay, where a model
 * plays the client and improvises. Nothing there knows what the client "should"
 * have been understood to say, so every judgement collapses into a grader's 1-5
 * opinion -- and that opinion moved by two to three points across runs of
 * identical code. It cannot gate anything, and it never once named a cause.
 *
 * This corpus is the opposite in every respect: fixed words, a stated
 * expectation, and a deterministic verdict from the real gate. It costs nothing,
 * runs in the ordinary gate, and it names the exact utterance that broke.
 *
 * TWO CLASSES OF CASE, AND THEY FAIL DIFFERENTLY:
 *
 *   expect: reject   A swap, an invention, or uncertainty read as certainty.
 *                    These are the reason the boundary exists. One of these
 *                    passing is a hard failure, always.
 *
 *   expect: accept   The client plainly said it. A failure here is a figure
 *                    silently dropped, which the meeting then asks for again --
 *                    the repeated-question complaint, at its source.
 *
 * `knownGap: true` records an accept case the gate fails TODAY, so this check
 * can be adopted before the gaps are closed. The list may only shrink: a gap
 * case that starts passing while still marked fails the run, so a fix has to
 * delete its marker and prove it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { partitionSupportedLiveFacts } from '../worker/src/consumer/live/live_tools.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/spoken-evidence.json', import.meta.url), 'utf8')
);

let checks = 0;
const safetyFailures = [];
const regressions = [];
const staleGaps = [];
const openGaps = [];

for (const testCase of fixture.cases) {
  const facts = testCase.submit.map((fact) => ({
    factId: fact.factId,
    value: fact.value,
    certainty: fact.certainty || 'exact'
  }));
  const verdict = partitionSupportedLiveFacts(facts, testCase.said);
  // Every submitted fact must survive for an `accept` case: a batch that keeps
  // two of three figures has still lost one.
  const accepted = verdict.accepted.length === facts.length;
  checks += 1;

  if (testCase.expect === 'reject') {
    if (accepted) {
      safetyFailures.push(`${testCase.id}: ${JSON.stringify(testCase.said)} was ACCEPTED`);
    }
    continue;
  }

  if (accepted && testCase.knownGap) staleGaps.push(testCase.id);
  else if (accepted) continue;
  else if (testCase.knownGap) openGaps.push(testCase);
  else regressions.push(`${testCase.id}: ${JSON.stringify(testCase.said)} was REJECTED`);
}

const acceptCases = fixture.cases.filter((item) => item.expect === 'accept');
const rejectCases = fixture.cases.filter((item) => item.expect === 'reject');
const captured = acceptCases.length - openGaps.length;

console.log(`[SpokenEvidence] ${fixture.version}`);
console.log(`  ${rejectCases.length} safety cases — every one must be refused.`);
console.log(`  ${acceptCases.length} things a client plainly said — ${captured} kept, ${openGaps.length} still dropped.`);
if (openGaps.length) {
  console.log('\n  STILL DROPPED (each one is a figure the meeting will ask for again):');
  for (const gap of openGaps) {
    console.log(`    · ${gap.id}: ${JSON.stringify(gap.said)}`);
    if (gap.note) console.log(`        ${gap.note}`);
  }
}

if (safetyFailures.length) {
  console.error('\n  SAFETY FAILURES — a figure the client never gave would be recorded:');
  for (const failure of safetyFailures) console.error(`    ✗ ${failure}`);
}
if (regressions.length) {
  console.error('\n  REGRESSIONS — these used to be captured:');
  for (const regression of regressions) console.error(`    ✗ ${regression}`);
}
if (staleGaps.length) {
  console.error('\n  FIXED BUT STILL MARKED knownGap — delete the marker:');
  for (const stale of staleGaps) console.error(`    ✗ ${stale}`);
}

assert.deepEqual(safetyFailures, [], 'The evidence boundary must refuse every safety case.');
assert.deepEqual(regressions, [], 'A phrase that was captured before must still be captured.');
assert.deepEqual(staleGaps, [], 'A closed gap must have its knownGap marker removed.');

console.log(`\n[SpokenEvidence] ${checks} utterances checked.`);
