#!/usr/bin/env node

/**
 * THE EVAL CORPUS IS PROTECTED EVEN THOUGH RUNNING IT COSTS MONEY.
 *
 * The cases in reconciliation-transcription-evals.json are the ones no
 * validator can grade: what "400" means depends on the question before it.
 * Grading them needs the model, so the run is paid and manual — which means
 * nothing would notice if a case quietly disappeared from the fixture.
 *
 * This check is free and runs in CI. It does not grade the model. It asserts
 * that every case class Phase 3 was accountable for is still represented, that
 * every case is gradeable, and that the paid runner still drives the real
 * production prompt rather than a copy that has drifted.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { RECONCILIATION_SYSTEM_PROMPT } from '../worker/src/consumer/planner_reconciliation.js';

const source = (relative) => readFileSync(
  fileURLToPath(new URL(relative, import.meta.url)), 'utf8'
);

const dataset = JSON.parse(source('./fixtures/reconciliation-transcription-evals.json'));
assert.equal(dataset.schemaVersion, 'reconciliation-transcription-eval-v1');
assert.ok(Array.isArray(dataset.cases) && dataset.cases.length >= 10,
  'The eval corpus must not shrink below the set Phase 3 shipped with.');
assert.equal(new Set(dataset.cases.map((item) => item.id)).size, dataset.cases.length,
  'Every eval case needs its own id.');

/* ------------------------------- every case must be runnable and gradeable */

for (const testCase of dataset.cases) {
  const where = `eval case ${testCase.id}`;
  assert.ok(testCase.assistantQuestion?.trim(),
    `${where} needs the assistant question — it is the context the case turns on.`);
  assert.ok(testCase.clientTurn?.trim(), `${where} needs a client turn.`);
  assert.ok(testCase.family?.trim(), `${where} needs a family.`);
  // Without an agreed goal nothing routes, no analysis is waiting on any fact,
  // and the reviewer is correctly told there is nothing it may write. A case
  // missing this grades the empty context, not the reading.
  assert.ok(testCase.goalType?.trim(), `${where} needs the goal that puts its fact in play.`);
  assert.ok(testCase.expect?.why?.trim(),
    `${where} must say why a deterministic check cannot grade it.`);

  const outcome = testCase.expect.outcome;
  assert.ok(['value', 'multiple_values', 'clarification'].includes(outcome),
    `${where} has an ungradeable outcome: ${outcome}`);
  if (outcome === 'value') {
    assert.equal(typeof testCase.expect.amount, 'number', `${where} needs the expected amount.`);
  }
  if (outcome === 'multiple_values') {
    assert.ok(Array.isArray(testCase.expect.amounts) && testCase.expect.amounts.length >= 2,
      `${where} is a multi-value case and needs at least two amounts.`);
  }
  if (outcome === 'clarification') {
    assert.ok(Array.isArray(testCase.expect.forbiddenAmounts)
      && testCase.expect.forbiddenAmounts.length > 0,
    `${where} asks for a clarification, so it must name the figures that must NOT appear — `
      + 'otherwise a reviewer that both invents a value and asks a question would pass.');
  }
}

/* ------------- the classes Phase 3 took responsibility for, case by case --- */

const families = new Set(dataset.cases.map((testCase) => testCase.family));
for (const required of ['terse_contextual', 'transcription', 'dense_recovery', 'ambiguity']) {
  assert.ok(families.has(required), `The eval corpus lost its ${required} cases.`);
}

const byId = new Map(dataset.cases.map((testCase) => [testCase.id, testCase]));

// Both terse cases are sub-1000 bare figures. The financial classifier scores
// those false, so neither can ever produce a deterministic coverage gap and
// neither is gradeable without the question that gives it a subject.
const subThreshold = byId.get('terse_sub_threshold_900');
assert.equal(subThreshold?.expect.amount, 900);
assert.ok(subThreshold.expect.amount < 1000,
  'The point of this case is the sub-1000 blind spot; raising it removes the test.');
const bareFigure = byId.get('terse_bare_figure_400');
assert.equal(bareFigure?.expect.amount, 400);
assert.match(bareFigure.clientTurn, /^\s*400\.?\s*$/,
  'The 400 case must stay a bare figure; adding words to it removes the thing being tested.');
assert.ok(bareFigure.assistantQuestion.trim().length > 20,
  'A bare figure is only gradeable because the question carries the subject.');

// Dense recovery exists so a turn Realtime only half-heard is still recovered
// whole, and it must forbid the total that a summing reviewer would produce.
const dense = byId.get('dense_two_pensions');
assert.deepEqual(dense?.expect.amounts, [180_000, 90_000]);
assert.ok(dense.expect.forbiddenAmounts.includes(270_000),
  'The dense pension case must forbid the sum, or it stops testing arithmetic.');
assert.ok(dense.expect.forbiddenAmounts.includes(180),
  'The dense pension case must also forbid the under-read 180.');

// Ambiguity must cost a clarification rather than a guess.
const range = byId.get('ambiguous_range');
assert.equal(range?.expect.outcome, 'clarification');
assert.ok(range.expect.forbiddenAmounts.includes(3500),
  'The range case must forbid the midpoint explicitly.');

/* ---------------------- the paid runner drives production, not a copy ----- */

const runner = source('./run-reconciliation-transcription-evals.mjs');
assert.match(runner, /requestPlannerReconciliation/,
  'The eval runner must call the production reconciliation request.');
assert.match(runner, /applyReconciliationPlan/,
  'A plan the deterministic gate would reject must not be graded as a pass.');
assert.match(runner, /reviewedTurnIds: \['turn_client'\]/,
  'The runner must exercise the reviewed-turn scope; without it the evals test the old gate.');
assert.doesNotMatch(runner, /RECONCILIATION_SYSTEM_PROMPT\s*=/,
  'The runner must import the production prompt, never restate one that can drift.');

/* ------------- the prompt still says what the corpus is grading against --- */

assert.match(RECONCILIATION_SYSTEM_PROMPT, /transcription and is expected of you/,
  'The reviewed-turn transcription grant has gone from the prompt.');
assert.match(RECONCILIATION_SYSTEM_PROMPT, /never combine two spoken figures into a third/,
  'The prompt must keep prohibiting arithmetic across figures.');
assert.match(RECONCILIATION_SYSTEM_PROMPT, /request_clarification instead of picking one/,
  'The prompt must keep sending genuine ranges to clarification.');
assert.match(RECONCILIATION_SYSTEM_PROMPT, /CITE THE NARROWEST SPAN THAT STILL IDENTIFIES THE NUMBER/,
  'The narrowest-span rule is what makes the wider transcription scope safe.');
// Speech never carries a currency word. Without the jurisdiction default the
// transcription grant is unusable: every recovered figure stalls on currency.
assert.match(RECONCILIATION_SYSTEM_PROMPT, /A SPOKEN FIGURE CARRIES NO CURRENCY WORD/,
  'The transcription grant needs the EUR jurisdiction default the server already applies.');
assert.match(RECONCILIATION_SYSTEM_PROMPT, /never a reason to request_clarification/,
  'A missing currency word must not send a recovered figure to clarification.');

console.log(`check-reconciliation-transcription-evals: ${dataset.cases.length} cases across `
  + `${families.size} families, corpus and prompt intact.`);
