#!/usr/bin/env node

/**
 * PHASE 5 — THE DETERMINISTIC MODULE LAYER, HELD TO ITS OWN CONTRACTS.
 *
 * A perfect conversation is not enough. Phase 4 proved a client can be
 * understood; this file starts proving that what the engines then receive is
 * actually right. Two defects are pinned here, both found by replaying a
 * conversation that had already worked.
 *
 * DEFECT 1 — THE HOUSE-PURCHASE CASH SPLIT WAS NOT A SPLIT.
 *
 * `cashSavingsContributions` is a decomposition of `currentCashSavings`: the
 * playbook requires the rows to total the household cash exactly, the form
 * calls the field "contribution display only", and no engine calculation ever
 * reads it. The adapter nonetheless built each row by re-filtering every cash
 * asset for that applicant, which is not a partition:
 *
 *   - cash held jointly matched BOTH applicants and was counted twice;
 *   - cash the client stated as "we have 25,000 saved" is stored against the
 *     household, matched NEITHER applicant, and vanished from the split.
 *
 * Either way the rows stopped totalling the household cash and the engine
 * refused the payload. A couple saying the most natural sentence there is
 * about savings could not run the module their conversation had just qualified
 * them for. The contract was right; the mapping was wrong.
 *
 * DEFECT 2 — EVERY FAILURE LOOKED LIKE A CLIENT WHO HAD NOT ANSWERED.
 *
 * That refusal surfaced as `analysis_missing_information`, so the meeting was
 * told to go back and collect facts the client had already given. There was no
 * machine-readable reason and nothing useful to say. The failure codes now
 * separate a broken input contract, an engine crash, an unmet readiness state
 * and an unsupported state, and the client-facing sentence is derived from the
 * code — never from the engine's own diagnostic text.
 *
 * THE TESTS ARE ABOUT SEMANTICS, NOT POSITION. A Phase 4 evaluator defect was
 * asserting on array order; every ownership assertion here resolves rows by
 * ownerId.
 */

import assert from 'node:assert/strict';

import { createHouseholdProfile, normalizeHouseholdProfile } from '../js/planning/profile.js';
import {
  buildHousePurchaseInput,
  getHousePurchaseReadiness,
  validateHousePurchaseInput
} from '../js/planning/adapters/house_purchase.js';
import {
  MODULE_FAILURE_CODES,
  ModuleFailureError,
  classifyModuleFailure,
  clientFailureMessage,
  hasBlockingModuleFailure,
  primaryModuleFailure
} from '../js/planning/module_failures.js';
import {
  buildPlanningModuleInput,
  getPlanningModuleDefinition,
  runPlanningModule
} from '../js/planning/module_registry.js';
import { runConsumerAnalysis } from '../js/planning/orchestrator.js';
import { confirmAndRunFailure, executeLiveTool } from '../worker/src/consumer/live/live_tools.js';
import { ConsumerError } from '../worker/src/consumer/errors.js';

const pass = (message) => console.info(`[ModuleContracts] PASS: ${message}`);

const NOW = '2026-08-18T09:00:00.000Z';
const TODAY = '2026-08-18';
const EUR = (amount) => ({ amount, currency: 'EUR' });

/**
 * A household that has already cleared house-purchase readiness. Only the cash
 * holdings vary between cases, so any failure is attributable to ownership
 * shape and nothing else.
 */
function housePurchaseProfile(assets, { partner = true } = {}) {
  const base = createHouseholdProfile({ profileId: 'hp', nowIso: NOW, calculationDateIso: TODAY });
  return normalizeHouseholdProfile({
    ...base,
    primaryPerson: {
      personId: 'primary', role: 'primary', employmentStatus: 'employee', age: 34, displayName: 'Aoife'
    },
    ...(partner
      ? {
        partner: {
          personId: 'partner', role: 'partner', employmentStatus: 'employee', age: 36, displayName: 'Cian'
        }
      }
      : {}),
    incomeSources: [
      {
        incomeId: 'inc-primary',
        ownerId: 'primary',
        type: 'employment',
        label: 'Salary',
        grossAnnual: EUR(62000),
        netAnnual: EUR(43000)
      },
      ...(partner
        ? [{
          incomeId: 'inc-partner',
          ownerId: 'partner',
          type: 'employment',
          label: 'Salary',
          grossAnnual: EUR(54000),
          netAnnual: EUR(38000)
        }]
        : [])
    ],
    assets,
    expenses: { monthlyEssential: EUR(2400), currentMonthlyRent: EUR(1800) },
    goals: [{
      goalId: 'goal-home',
      type: 'buy_home',
      priority: 'high',
      status: 'active',
      title: 'Buy a home',
      targetAmount: EUR(420000),
      targetDate: '2028-06-01'
    }],
    assumptions: {
      calculationDateIso: TODAY,
      values: { housePurchase: { lendingCategory: 'first_time_buyer', currentMonthlySavings: 1500 } }
    }
  });
}

const cash = (assetId, ownerIds, amount, label = 'Savings') => ({
  assetId, ownerIds, type: 'cash', label, currentValue: EUR(amount)
});

/** Resolve a contribution row by owner identity, never by array position. */
function contributionFor(input, ownerId) {
  const rows = input.cashSavingsContributions.filter((row) => row.ownerId === ownerId);
  assert.equal(rows.length, 1, `expected exactly one contribution row for ${ownerId}`);
  return rows[0].amount;
}

function contributionTotal(input) {
  return input.cashSavingsContributions.reduce((total, row) => total + row.amount, 0);
}

/**
 * The contract, asserted the same way for every case: the rows partition the
 * household cash, name only real applicants, name each of them once, and never
 * go negative.
 */
function assertValidCashPartition(input, expectedTotal) {
  const applicantIds = input.applicants.map((applicant) => applicant.id);
  const ownerIds = input.cashSavingsContributions.map((row) => row.ownerId);
  assert.deepEqual(
    [...ownerIds].sort(),
    [...applicantIds].sort(),
    'every applicant is named exactly once in the cash split'
  );
  assert.ok(
    input.cashSavingsContributions.every((row) => row.amount >= 0),
    'no contribution row is negative'
  );
  assert.equal(input.currentCashSavings, expectedTotal, 'household cash total is counted once');
  assert.equal(contributionTotal(input), input.currentCashSavings, 'the split totals the household cash exactly');
  // The engine's own normaliser is the authority; passing our own arithmetic
  // is not the same as passing the contract the engine enforces.
  validateHousePurchaseInput(input);
}

/* ---------------------------------------------- house purchase cash split */

{
  const input = buildHousePurchaseInput(housePurchaseProfile(
    [cash('cash-1', ['primary'], 25000)],
    { partner: false }
  ));
  assert.equal(input.applicationType, 'single');
  assertValidCashPartition(input, 25000);
  assert.equal(contributionFor(input, 'primary'), 25000);
  pass('single buyer: all cash is attributed to the one applicant');
}

{
  // A lone buyer whose savings were never attributed to them by name. Before
  // the fix this produced an empty split against a positive total.
  const input = buildHousePurchaseInput(housePurchaseProfile(
    [cash('cash-1', [], 25000)],
    { partner: false }
  ));
  assertValidCashPartition(input, 25000);
  assert.equal(contributionFor(input, 'primary'), 25000);
  pass('single buyer: unattributed cash still reaches the only applicant');
}

{
  const input = buildHousePurchaseInput(housePurchaseProfile([
    cash('cash-1', ['primary'], 15000, 'Aoife savings'),
    cash('cash-2', ['partner'], 10000, 'Cian savings')
  ]));
  assert.equal(input.applicationType, 'joint');
  assertValidCashPartition(input, 25000);
  assert.equal(contributionFor(input, 'primary'), 15000, 'individually owned cash stays with its owner');
  assert.equal(contributionFor(input, 'partner'), 10000, 'individually owned cash stays with its owner');
  pass('two buyers: individually owned savings keep their owner');
}

{
  // "We have 25,000 saved." The reconciler binds this to the household owner,
  // which matched no applicant at all before the fix.
  const input = buildHousePurchaseInput(housePurchaseProfile([
    cash('cash-1', ['household'], 25000, 'Joint savings')
  ]));
  assertValidCashPartition(input, 25000);
  assert.equal(contributionFor(input, 'primary'), 12500);
  assert.equal(contributionFor(input, 'partner'), 12500);
  pass('joint savings held at household level are shared, not dropped');
}

{
  // The same money recorded against both people. This is the double-count: the
  // old mapping gave each applicant the full 25,000.
  const input = buildHousePurchaseInput(housePurchaseProfile([
    cash('cash-1', ['primary', 'partner'], 25000, 'Joint savings')
  ]));
  assertValidCashPartition(input, 25000);
  assert.equal(contributionFor(input, 'primary'), 12500);
  assert.equal(contributionFor(input, 'partner'), 12500);
  assert.notEqual(contributionTotal(input), 50000, 'jointly held cash is never counted once per owner');
  pass('joint savings held by both people are shared, not doubled');
}

{
  const input = buildHousePurchaseInput(housePurchaseProfile([
    cash('cash-1', ['household'], 20000, 'Joint savings'),
    cash('cash-2', ['primary'], 5000, 'Aoife savings')
  ]));
  assertValidCashPartition(input, 25000);
  assert.equal(contributionFor(input, 'primary'), 15000, 'own 5,000 plus half of the joint 20,000');
  assert.equal(contributionFor(input, 'partner'), 10000, 'half of the joint 20,000');
  pass('combined joint and individual savings partition correctly');
}

{
  const input = buildHousePurchaseInput(housePurchaseProfile([cash('cash-1', ['household'], 0)]));
  assertValidCashPartition(input, 0);
  assert.equal(contributionFor(input, 'primary'), 0);
  assert.equal(contributionFor(input, 'partner'), 0);
  pass('zero savings still produce a valid, reconciling split');
}

{
  // Amounts that do not halve cleanly must still reconcile to the cent.
  const input = buildHousePurchaseInput(housePurchaseProfile([
    cash('cash-1', ['household'], 10000.01, 'Joint savings')
  ]));
  assertValidCashPartition(input, 10000.01);
  assert.equal(contributionTotal(input), 10000.01, 'the residual cent is settled, not lost');
  pass('an odd-cent joint balance reconciles exactly');
}

{
  // Foreign-currency cash is excluded from `currentCashSavings`; the split has
  // to exclude it on the same terms or the two sides cannot reconcile.
  const profile = housePurchaseProfile([
    cash('cash-1', ['household'], 20000, 'Joint savings'),
    { assetId: 'cash-2', ownerIds: ['primary'], type: 'cash', label: 'US savings', currentValue: { amount: 9000, currency: 'USD' } }
  ]);
  const input = buildHousePurchaseInput(profile);
  assertValidCashPartition(input, 20000);
  assert.equal(contributionFor(input, 'primary'), 10000, 'excluded foreign cash is excluded from both sides');
  pass('cross-currency cash is excluded consistently from total and split');
}

{
  // The household total is the sum of DISTINCT cash holdings. This is the
  // no-duplicate-cash guard stated independently of the split.
  const holdings = [
    cash('cash-1', ['household'], 12000, 'Joint savings'),
    cash('cash-2', ['primary'], 4000, 'Aoife savings'),
    cash('cash-3', ['partner'], 3000, 'Cian savings'),
    cash('cash-4', ['primary', 'partner'], 6000, 'Other joint savings')
  ];
  const input = buildHousePurchaseInput(housePurchaseProfile(holdings));
  const distinctTotal = holdings.reduce((total, asset) => total + asset.currentValue.amount, 0);
  assertValidCashPartition(input, distinctTotal);
  assert.equal(input.currentCashSavings, 25000);
  assert.equal(contributionFor(input, 'primary'), 13000, '4,000 own plus half of 12,000 and half of 6,000');
  assert.equal(contributionFor(input, 'partner'), 12000, '3,000 own plus half of 12,000 and half of 6,000');
  pass('four holdings across three ownership shapes: no cash duplicated, none dropped');
}

{
  // The failure mode itself must stay loud. A split that does not reconcile is
  // refused with a diagnostic that names the contract.
  const profile = housePurchaseProfile([cash('cash-1', ['household'], 25000)]);
  const input = buildHousePurchaseInput(profile);
  const broken = {
    ...input,
    cashSavingsContributions: input.cashSavingsContributions.map((row) => ({ ...row, amount: row.amount * 2 }))
  };
  assert.throws(
    () => validateHousePurchaseInput(broken),
    /cashSavingsContributions must total currentCashSavings/,
    'a non-reconciling split is refused'
  );
  const dropped = { ...input, cashSavingsContributions: [] };
  assert.throws(() => validateHousePurchaseInput(dropped), /cashSavingsContributions/);
  pass('a non-reconciling split still fails loudly and diagnostically');
}

{
  // Ownership derivation is explainable rather than silent: a shared holding
  // records the even split as a stated assumption.
  const shared = getHousePurchaseReadiness(housePurchaseProfile([cash('cash-1', ['household'], 25000)]));
  const attributed = getHousePurchaseReadiness(housePurchaseProfile([
    cash('cash-1', ['primary'], 15000),
    cash('cash-2', ['partner'], 10000)
  ]));
  const keyOf = (result) => result.assumptionsUsed.map((item) => item.key);
  assert.ok(keyOf(shared).includes('cashSavingsContributions'), 'a derived split is declared');
  assert.ok(!keyOf(attributed).includes('cashSavingsContributions'), 'a client-stated split assumes nothing');
  pass('an evenly shared split is declared as an assumption, a stated one is not');
}

{
  // End to end through the registry: the module actually runs and returns a
  // result for the ownership shape that used to break it.
  const profile = housePurchaseProfile([cash('cash-1', ['household'], 25000)]);
  const result = await runPlanningModule('house_purchase', profile, {
    calculationVersion: 'test-calc',
    calculatedAt: NOW,
    scenarioOverrides: {}
  });
  assert.equal(result.moduleId, 'house_purchase');
  assert.equal(result.semanticResult.targetPropertyPrice, 420000);
  assert.ok(Number.isFinite(result.semanticResult.standardMortgageCapacity));
  pass('house purchase runs end to end on household-owned savings');
}

/* -------------------------------------------- structured failure reporting */

{
  const definition = getPlanningModuleDefinition('house_purchase');
  assert.equal(typeof definition.validateInput, 'function', 'the module declares its input contract');

  const profile = housePurchaseProfile([cash('cash-1', ['household'], 25000)]);
  const brokenMapping = {
    ...definition,
    buildInput: (value) => {
      const input = definition.buildInput(value);
      return {
        ...input,
        cashSavingsContributions: input.cashSavingsContributions.map((row) => ({ ...row, amount: row.amount * 2 }))
      };
    }
  };
  let error = null;
  try {
    buildPlanningModuleInput(brokenMapping, profile);
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof ModuleFailureError, 'a mapping breach throws a labelled module failure');
  assert.equal(classifyModuleFailure(error), MODULE_FAILURE_CODES.INPUT_INVALID);
  assert.match(error.detail, /cashSavingsContributions must total currentCashSavings/);
  pass('a broken input mapping is reported as module_input_invalid, not as an engine crash');
}

{
  const failures = [
    { moduleId: 'liquidity_analysis', code: MODULE_FAILURE_CODES.READINESS_NOT_MET, detail: 'not ready' },
    { moduleId: 'house_purchase', code: MODULE_FAILURE_CODES.INPUT_INVALID, detail: 'contract breach' }
  ];
  assert.equal(primaryModuleFailure(failures).moduleId, 'house_purchase', 'a real defect outranks an unmet readiness');
  assert.equal(hasBlockingModuleFailure(failures), true);
  assert.equal(
    hasBlockingModuleFailure([{ code: MODULE_FAILURE_CODES.READINESS_NOT_MET }]),
    false,
    'an unmet readiness alone is a question, not a defect'
  );
  assert.equal(classifyModuleFailure(new Error('boom')), MODULE_FAILURE_CODES.UNKNOWN, 'unlabelled failures are not guessed at');
  pass('failure codes rank and separate defects from open questions');
}

{
  const profile = housePurchaseProfile([cash('cash-1', ['household'], 25000)]);
  const analysis = await runConsumerAnalysis({
    profile,
    moduleIds: ['house_purchase'],
    // house_purchase declares liquidity_analysis as a prerequisite, so the
    // allowlist has to carry both for the plan to resolve at all.
    allowedModuleIds: ['house_purchase', 'liquidity_analysis'],
    calculationDateIso: TODAY,
    calculatedAt: NOW
  });
  assert.deepEqual(analysis.errors, [], 'a valid profile produces no failures at all');
  const houseResult = analysis.results.find((item) => item.moduleId === 'house_purchase');
  assert.ok(houseResult, 'the house-purchase module produced a result');
  assert.equal(houseResult.semanticResult.targetPropertyPrice, 420000);
  assert.equal(analysis.analysisPlan.status, 'complete');
  pass('a valid module run is unchanged by the diagnostics work');
}

{
  // A module selected but never runnable is now recorded rather than silently
  // dropped from the results array.
  const profile = housePurchaseProfile([cash('cash-1', ['household'], 25000)]);
  const withoutGoal = normalizeHouseholdProfile({ ...profile, goals: [] });
  const analysis = await runConsumerAnalysis({
    profile: withoutGoal,
    moduleIds: ['house_purchase'],
    allowedModuleIds: ['house_purchase', 'liquidity_analysis'],
    calculationDateIso: TODAY,
    calculatedAt: NOW
  });
  const failure = analysis.errors.find((item) => item.moduleId === 'house_purchase');
  assert.ok(failure, 'an unrunnable module leaves a trace');
  assert.equal(failure.code, MODULE_FAILURE_CODES.READINESS_NOT_MET);
  assert.equal(failure.readinessStatus, 'not_relevant');
  assert.ok(
    !analysis.results.some((item) => item.moduleId === 'house_purchase'),
    'and produces no result'
  );
  pass('a module that never became runnable reports readiness_not_met');
}

{
  const wrapped = new ModuleFailureError(
    MODULE_FAILURE_CODES.EXECUTION_FAILED,
    'house_purchase',
    'TypeError: cannot read property rate of undefined at engine.js:1204'
  );
  assert.equal(classifyModuleFailure(wrapped), MODULE_FAILURE_CODES.EXECUTION_FAILED);
  const spoken = clientFailureMessage(classifyModuleFailure(wrapped));
  assert.ok(!spoken.includes('engine.js'), 'no file or line reaches the client');
  assert.ok(!spoken.includes('TypeError'), 'no exception name reaches the client');
  assert.ok(!spoken.includes('undefined'));
  pass('an engine exception yields a client sentence with no internal detail');
}

{
  // Every code has distinct, safe client wording. This is the leak guard
  // applied to the whole vocabulary rather than to one sampled message.
  const forbidden = [/Error/, /\bat [\w./-]+:\d+/, /generated\./, /undefined/, /null/, /\bhouse_purchase\b/];
  const messages = Object.values(MODULE_FAILURE_CODES).map((code) => clientFailureMessage(code));
  for (const message of messages) {
    assert.ok(message.length > 0 && message.length < 240, 'client wording is a sentence, not a dump');
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(message), `client wording must not match ${pattern}: ${message}`);
    }
  }
  assert.equal(new Set(messages).size >= 4, true, 'the codes do not collapse into one message');
  pass('no failure code produces client wording carrying internal detail');
}

/* ------------------------------------------------- confirm_and_run results */

{
  const cases = [
    ['analysis_module_failed', MODULE_FAILURE_CODES.EXECUTION_FAILED, false],
    ['analysis_missing_information', MODULE_FAILURE_CODES.READINESS_NOT_MET, true],
    ['analysis_plan_empty', MODULE_FAILURE_CODES.UNSUPPORTED_STATE, false],
    ['profile_revision_conflict', MODULE_FAILURE_CODES.READINESS_NOT_MET, true]
  ];
  for (const [consumerCode, expectedCode, retryable] of cases) {
    const result = confirmAndRunFailure(new ConsumerError(409, consumerCode, 'internal wording'));
    assert.equal(result.ok, false);
    assert.equal(result.code, expectedCode, `${consumerCode} maps to ${expectedCode}`);
    assert.equal(result.retryable, retryable);
    assert.equal(result.diagnosticCode, consumerCode, 'the server code is kept for diagnosis');
    assert.equal(result.message, clientFailureMessage(expectedCode));
    assert.ok(!result.message.includes('internal wording'), 'internal wording never becomes client wording');
  }
  const carried = confirmAndRunFailure(new ConsumerError(422, 'analysis_module_failed', 'x', {
    failureCode: MODULE_FAILURE_CODES.INPUT_INVALID,
    failedModuleId: 'house_purchase'
  }));
  assert.equal(carried.code, MODULE_FAILURE_CODES.INPUT_INVALID, 'a specific module failure code wins over the generic mapping');
  assert.equal(carried.failedModuleId, 'house_purchase');
  pass('confirm_and_run failures carry a machine-readable code and safe wording');
}

{
  const plain = confirmAndRunFailure(new Error('ECONNRESET reading from d1 at internal.js:88'));
  assert.equal(plain.ok, false);
  assert.equal(plain.code, MODULE_FAILURE_CODES.UNKNOWN);
  assert.equal(plain.diagnosticCode, 'live_tool_failed');
  assert.ok(!plain.message.includes('ECONNRESET'));
  assert.ok(!plain.message.includes('internal.js'));
  assert.ok(!JSON.stringify(plain).includes('ECONNRESET'), 'nothing in the tool result carries the raw error');
  pass('an infrastructure fault never leaks its message through confirm_and_run');
}

{
  // The real dispatch path: a throw inside confirm_and_run must come back as a
  // structured result, not as the generic "do not mention it" fallback the
  // session applies to a broken fact write.
  const thrown = new ConsumerError(422, 'analysis_module_failed', 'engine contract breach', {
    failureCode: MODULE_FAILURE_CODES.INPUT_INVALID,
    failedModuleId: 'house_purchase'
  });
  const result = await executeLiveTool('confirm_and_run', {}, {
    latestClientTranscript: 'yes go ahead',
    loadContext: () => { throw thrown; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, MODULE_FAILURE_CODES.INPUT_INVALID);
  assert.equal(result.failedModuleId, 'house_purchase');
  assert.ok(result.speakableText.length > 0, 'the meeting has something to say');
  assert.ok(!JSON.stringify(result).includes('engine contract breach'));
  pass('executeLiveTool returns a structured confirm_and_run failure instead of throwing');
}

{
  // The confirmation gate itself is unchanged and still comes first.
  const result = await executeLiveTool('confirm_and_run', {}, {
    latestClientTranscript: 'hold on, not yet',
    loadContext: () => { throw new Error('must not be reached'); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'confirmation_required');
  pass('the spoken confirmation gate still precedes any analysis work');
}

console.info('[ModuleContracts] All module input-contract and failure-diagnostic checks passed.');
