#!/usr/bin/env node

/**
 * PHASE 5 MODULE #3 — THE LIQUIDITY RESERVE, PROVED ARITHMETICALLY.
 *
 * This module tells a household how many months its cash would cover and how
 * far it is from Planéir's reserve target. It is the prerequisite House
 * Purchase declares, so its correctness is load-bearing for a module already
 * signed off.
 *
 * THE REFERENCE CALCULATOR BELOW IS DELIBERATELY SEPARATE from the engine. It
 * re-derives every figure from the case's own inputs and the published policy
 * months, and imports nothing from `liquidity_reserve.js` except the policy
 * constants it is checking the engine applied. An existing test compares the
 * adapter against `computeLiquidityReserve(input)` — that proves the adapter
 * does not drift from the engine, which is worth having and is NOT evidence
 * the engine is right.
 *
 * THE DEFECT THIS PINS. A gap of zero is a claim. `surplusCash` and
 * `shortfallCash` both fell back to `0` whenever the target or the cash could
 * not be established, and every reader downstream decides the household is
 * fine by asking whether the shortfall is above zero. So a household whose
 * monthly spending had never been captured was told, in a positive tone, that
 * its cash reserve was at or above target — a reassurance that reads exactly
 * like a calculated one. Unknown is now `null`, and the engine states its own
 * `position` rather than leaving each caller to infer it from an absence.
 */

import assert from 'node:assert/strict';

import { createHouseholdProfile, normalizeHouseholdProfile } from '../js/planning/profile.js';
import {
  buildLiquidityInput,
  getLiquidityReadiness,
  resolveLiquidityCohort,
  validateLiquidityInput
} from '../js/planning/adapters/liquidity.js';
import { computeLiquidityReserve, resolveLiquidityReservePolicy } from '../js/liquidity_reserve.js';
import { PLANEIR_ASSUMPTIONS } from '../js/planning/planeir_assumptions.js';
import { buildPersonalBalanceSheetInput } from '../js/planning/adapters/personal_balance_sheet.js';
import { computePersonalBalanceSheet } from '../js/personal_balance_sheet.js';
import { runPlanningModule } from '../js/planning/module_registry.js';
import { MODULE_FAILURE_CODES, classifyModuleFailure } from '../js/planning/module_failures.js';
import { summarizeAnalysisResults } from '../js/planning/result_summary.js';

const pass = (message) => console.info(`[LiquidityAudit] PASS: ${message}`);

const NOW = '2026-08-18T09:00:00.000Z';
const TODAY = '2026-08-18';
const EUR = (amount) => ({ amount, currency: 'EUR' });

/* ------------------------------------------------ independent arithmetic */

/**
 * The reserve, worked out from first principles.
 *
 * Months of cover is cash divided by monthly spending. The floor and the
 * target are that spending multiplied by the policy's months. The gap is the
 * difference, one way or the other, and there is no gap to state at all when
 * either side is unknown.
 */
function reference({ cash, monthly, minimumMonths, targetMonths }) {
  if (monthly === null || monthly <= 0) {
    return {
      monthsCovered: null, minimumCash: null, targetCash: null,
      surplusCash: null, shortfallCash: null, position: 'unknown'
    };
  }
  const minimumCash = monthly * minimumMonths;
  const targetCash = monthly * Math.max(targetMonths, minimumMonths);
  if (cash === null) {
    return {
      monthsCovered: null, minimumCash, targetCash,
      surplusCash: null, shortfallCash: null, position: 'unknown'
    };
  }
  const surplusCash = cash > targetCash ? cash - targetCash : 0;
  const shortfallCash = targetCash > cash ? targetCash - cash : 0;
  return {
    monthsCovered: cash / monthly,
    minimumCash,
    targetCash,
    surplusCash,
    shortfallCash,
    position: shortfallCash > 0 ? 'below_target' : 'at_or_above_target'
  };
}

function assertReserve(input, expectedFrom, note) {
  const expected = reference(expectedFrom);
  const actual = computeLiquidityReserve(input);
  for (const key of ['monthsCovered', 'minimumCash', 'targetCash', 'surplusCash', 'shortfallCash', 'position']) {
    // Exact equality: every case here uses whole euro and months that divide
    // cleanly, so a tolerance would only hide error.
    assert.equal(actual[key], expected[key], `${key} (${note})`);
  }
  return actual;
}

const WORKING = PLANEIR_ASSUMPTIONS.liquidity.working;
const RETIRED = PLANEIR_ASSUMPTIONS.liquidity.retired;

function profileOf(over) {
  const base = createHouseholdProfile({ profileId: 'liq', nowIso: NOW, calculationDateIso: TODAY });
  return normalizeHouseholdProfile({
    ...base,
    primaryPerson: { personId: 'primary', role: 'primary', employmentStatus: 'employee', age: 44 },
    expenses: { monthlyEssential: EUR(2000) },
    goals: [{
      goalId: 'g1', type: 'maintain_liquidity', priority: 'high', status: 'active', title: 'Keep a buffer'
    }],
    assumptions: { calculationDateIso: TODAY, values: {} },
    ...over
  });
}

const cash = (assetId, ownerIds, amount, label = 'Savings') => ({
  assetId, ownerIds, type: 'cash', label, currentValue: EUR(amount)
});

/* --------------------------------------------------- the published policy */

{
  // The months are the central versioned rule, not a number retyped here.
  assert.equal(WORKING.minimumBufferMonths, 3);
  assert.equal(WORKING.targetBufferMonths, 6);
  assert.equal(RETIRED.minimumBufferMonths, 12);
  assert.equal(RETIRED.targetBufferMonths, 24);
  assert.equal(resolveLiquidityReservePolicy('not-retired'), WORKING);
  assert.equal(resolveLiquidityReservePolicy('retired'), RETIRED);
  assert.equal(
    computeLiquidityReserve({ currentCash: 1, monthlyExpenditure: 1 }).policyVersion,
    PLANEIR_ASSUMPTIONS.liquidity.policyVersion,
    'the run is stamped with the policy version it applied'
  );
  pass('the 3/6 and 12/24 guides come from the versioned Planéir policy, applied once');
}

/* -------------------------------------------------------- hand-checkable */

{
  // €12,000 against €2,000 a month is exactly 6.0 months: the floor is €6,000,
  // the target €12,000, and the household is exactly on target with no gap
  // either way. Every step confirmable without running anything.
  const actual = assertReserve(
    { currentCash: 12_000, monthlyExpenditure: 2_000 },
    { cash: 12_000, monthly: 2_000, minimumMonths: 3, targetMonths: 6 },
    'hand-checkable working'
  );
  assert.equal(actual.monthsCovered, 6);
  assert.equal(actual.minimumCash, 6_000);
  assert.equal(actual.targetCash, 12_000);
  assert.equal(actual.surplusCash, 0);
  assert.equal(actual.shortfallCash, 0);
  assert.equal(actual.position, 'at_or_above_target');
  pass('hand-checkable: €12,000 over €2,000 a month is 6.0 months, exactly on the working target');
}

{
  // The same household read as retired: 12 and 24 months, so €24,000 floor,
  // €48,000 target, and a €36,000 shortfall against the same €12,000 of cash.
  const actual = assertReserve(
    { currentCash: 12_000, monthlyExpenditure: 2_000, clientStatus: 'retired' },
    { cash: 12_000, monthly: 2_000, minimumMonths: 12, targetMonths: 24 },
    'hand-checkable retired'
  );
  assert.equal(actual.targetCash, 48_000);
  assert.equal(actual.shortfallCash, 36_000);
  assert.equal(actual.position, 'below_target');
  assert.equal(actual.monthsCovered, 6, 'months of cover does not change with the cohort');
  pass('hand-checkable: the retired guide targets €48,000 and reports the true €36,000 shortfall');
}

{
  // Realistic: a couple with €31,500 across three accounts and €4,100 a month.
  const monthly = 4_100;
  const total = 18_000 + 9_500 + 4_000;
  const actual = assertReserve(
    { currentCash: total, monthlyExpenditure: monthly },
    { cash: total, monthly, minimumMonths: 3, targetMonths: 6 },
    'realistic'
  );
  assert.equal(actual.targetCash, 24_600);
  assert.equal(actual.surplusCash, 6_900, '31,500 less the 24,600 target');
  assert.equal(actual.shortfallCash, 0);
  pass('realistic case: €31,500 against €4,100 a month leaves a €6,900 surplus');
}

/* ----------------------------------------------- invariants and edge cases */

{
  const actual = assertReserve(
    { currentCash: 0, monthlyExpenditure: 2_000 },
    { cash: 0, monthly: 2_000, minimumMonths: 3, targetMonths: 6 },
    'zero cash'
  );
  assert.equal(actual.monthsCovered, 0);
  assert.equal(actual.shortfallCash, 12_000, 'the whole target is the gap');
  pass('zero cash is zero months covered and a full-target shortfall');
}

{
  // The division-by-zero guard. No output may be Infinity or NaN.
  for (const monthlyExpenditure of [0, null]) {
    const actual = computeLiquidityReserve({ currentCash: 12_000, monthlyExpenditure });
    for (const key of ['monthsCovered', 'minimumCash', 'targetCash']) {
      assert.equal(actual[key], null, `${key} is unknown, not Infinity`);
    }
    assert.ok(!Object.values(actual).some((value) => value === Infinity || Number.isNaN(value)));
  }
  pass('spending of zero or unknown yields nulls, never Infinity or NaN');
}

{
  // THE DEFECT. An unknown target, or unknown cash, must not read as a pass.
  const noSpending = computeLiquidityReserve({ currentCash: 12_000, monthlyExpenditure: null });
  assert.equal(noSpending.position, 'unknown');
  assert.equal(noSpending.shortfallCash, null, 'not zero, which every reader treats as fine');
  assert.equal(noSpending.surplusCash, null);

  const noCash = computeLiquidityReserve({ currentCash: null, monthlyExpenditure: 2_000 });
  assert.equal(noCash.position, 'unknown');
  assert.equal(noCash.shortfallCash, null);
  assert.equal(noCash.targetCash, 12_000, 'the target is still stated; only the comparison is withheld');
  pass('a reserve that could not be compared says so, instead of reporting no gap');
}

{
  // And the client-facing summary must not call that a pass either.
  const summary = summarizeAnalysisResults({
    results: [{
      moduleId: 'liquidity_analysis',
      semanticResult: {
        currency: 'EUR', currentCash: 12_000, monthsCovered: null, targetCash: null,
        surplusCash: null, shortfallCash: null, position: 'unknown'
      }
    }],
    errors: [],
    analysisPlan: { selectedModules: [], status: 'complete' }
  });
  const highlight = summary.highlights.find((item) => item.id === 'liquidity-position');
  assert.ok(highlight, 'the module still produces a highlight');
  assert.ok(!/at or above target/i.test(highlight.title), 'and it does not claim the target was met');
  assert.ok(!/at least the/i.test(highlight.message));
  assert.notEqual(highlight.tone, 'positive', 'nor present it in a reassuring tone');
  pass('the client summary reports an uncomparable reserve as uncomparable');
}

{
  // Exactly one of surplus and shortfall is non-zero, and never both.
  for (const cashValue of [0, 6_000, 12_000, 18_000, 100_000]) {
    const actual = computeLiquidityReserve({ currentCash: cashValue, monthlyExpenditure: 2_000 });
    assert.ok(
      actual.surplusCash === 0 || actual.shortfallCash === 0,
      'surplus and shortfall are never both non-zero'
    );
    assert.equal(
      actual.surplusCash - actual.shortfallCash,
      cashValue - actual.targetCash,
      'the two figures are one signed distance from target'
    );
  }
  pass('surplus and shortfall are one signed distance from the target, never both');
}

{
  // A target below the floor is not a target. An override of the minimum
  // raises the target with it rather than leaving the pair contradictory.
  const actual = computeLiquidityReserve({
    currentCash: 12_000, monthlyExpenditure: 2_000, minimumBufferMonths: 30
  });
  assert.equal(actual.minimumBufferMonths, 30);
  assert.equal(actual.targetBufferMonths, 30, 'the target rises to the floor');
  assert.equal(actual.targetCash, 60_000);
  assert.equal(actual.shortfallCash, 48_000);
  assert.ok(actual.targetCash >= actual.minimumCash, 'the target is never below the floor');
  pass('the target is never allowed below the minimum floor');
}

{
  // Annual spending is the same household on a different clock.
  const monthly = computeLiquidityReserve({ currentCash: 12_000, monthlyExpenditure: 2_000 });
  const annual = computeLiquidityReserve({ currentCash: 12_000, annualExpenditure: 24_000 });
  assert.equal(annual.monthlyExpenditure, 2_000, '24,000 a year is 2,000 a month');
  assert.equal(annual.targetCash, monthly.targetCash);
  assert.equal(annual.monthsCovered, monthly.monthsCovered);
  assert.equal(annual.annualExpenditure, 24_000, 'and it round-trips');
  pass('an annual spending figure gives the identical reserve to the monthly one');
}

{
  // A household in the red is reported as such rather than floored at zero.
  const actual = computeLiquidityReserve({ currentCash: -500, monthlyExpenditure: 2_000 });
  assert.equal(actual.monthsCovered, -0.25);
  assert.equal(actual.shortfallCash, 12_500, 'the gap includes climbing back to zero');
  assert.equal(actual.position, 'below_target');
  pass('an overdrawn household reports negative cover and the full gap');
}

/* ------------------------------------------------- ownership aggregation */

{
  // Cash is a household total here, so ownership must change nothing: four
  // shapes, each counted once, same answer as one holding of the total.
  const split = profileOf({
    assets: [
      cash('a1', ['primary'], 3_000),
      cash('a2', ['household'], 4_000),
      cash('a3', [], 2_000),
      cash('a4', ['primary'], 3_000)
    ]
  });
  const single = profileOf({ assets: [cash('a1', ['household'], 12_000)] });
  assert.equal(buildLiquidityInput(split).currentCash, 12_000);
  assert.equal(buildLiquidityInput(single).currentCash, 12_000);
  assert.equal(
    computeLiquidityReserve(buildLiquidityInput(split)).targetCash,
    computeLiquidityReserve(buildLiquidityInput(single)).targetCash
  );
  pass('cash is a household total: ownership shape changes nothing and nothing is double counted');
}

{
  // A jointly held holding is one holding.
  const joint = profileOf({
    assets: [cash('a1', ['primary', 'partner'], 12_000, 'Joint savings')],
    partner: { personId: 'partner', role: 'partner', employmentStatus: 'employee', age: 43 }
  });
  assert.equal(buildLiquidityInput(joint).currentCash, 12_000, 'two owners is not twice the cash');
  pass('a jointly owned cash holding contributes its value once');
}

{
  // Non-cash wealth is not a reserve. A house is not spendable in an emergency.
  const profile = profileOf({
    assets: [
      cash('a1', ['household'], 12_000),
      { assetId: 'a2', ownerIds: ['primary'], type: 'investment', label: 'Shares', currentValue: EUR(80_000) },
      { assetId: 'a3', ownerIds: ['primary'], type: 'property', label: 'Land', currentValue: EUR(500_000) }
    ]
  });
  assert.equal(buildLiquidityInput(profile).currentCash, 12_000, 'only cash counts toward the reserve');
  pass('investments and property do not inflate the cash reserve');
}

{
  // Foreign-currency cash is excluded, consistently with every other module,
  // and the exclusion is stated rather than silent.
  const profile = profileOf({
    assets: [
      cash('a1', ['household'], 12_000),
      { assetId: 'a2', ownerIds: ['primary'], type: 'cash', label: 'US savings', currentValue: { amount: 9_000, currency: 'USD' } }
    ]
  });
  assert.equal(buildLiquidityInput(profile).currentCash, 12_000);
  const readiness = getLiquidityReadiness(profile);
  assert.ok(
    readiness.warnings.some((warning) => /other than EUR/.test(warning)),
    'the excluded holding is disclosed'
  );
  pass('cash in another currency is excluded from the reserve and the exclusion is disclosed');
}

/* --------------------------------------------- agreement with other modules */

{
  // The balance sheet reports reserves and months of cover too. Two modules
  // giving one household two different months of cover is a defect whichever
  // number is right, so they are asserted against each other directly.
  const profile = profileOf({
    assets: [cash('a1', ['household'], 24_000)],
    expenses: { monthlyEssential: EUR(2_000), monthlyDiscretionary: EUR(1_000) },
    assumptions: {
      calculationDateIso: TODAY,
      values: { completionFacts: { confirmedNonePaths: { '/liabilities': true } } }
    }
  });
  const liquidity = computeLiquidityReserve(buildLiquidityInput(profile));
  const sheet = computePersonalBalanceSheet(buildPersonalBalanceSheetInput(profile));
  assert.equal(liquidity.monthlyExpenditure, sheet.monthlyExpenditure, 'one spending basis');
  assert.equal(liquidity.currentCash, sheet.spendableReserves, 'one view of spendable cash');
  assert.equal(liquidity.monthsCovered, sheet.reserveMonths, 'and therefore one months-of-cover figure');
  assert.equal(liquidity.monthsCovered, 8, '24,000 / 3,000, checked independently');
  pass('liquidity and the balance sheet agree on spending, reserves and months of cover');
}

/* ------------------------------------------------------- cohort resolution */

{
  // The unambiguous cases. A lone client's own status decides the guide.
  const working = profileOf({ assets: [cash('a1', ['primary'], 12_000)] });
  const retired = profileOf({
    assets: [cash('a1', ['primary'], 12_000)],
    primaryPerson: { personId: 'primary', role: 'primary', employmentStatus: 'retired', age: 70 }
  });
  assert.equal(resolveLiquidityCohort(working), 'working');
  assert.equal(resolveLiquidityCohort(retired), 'retired');
  assert.equal(buildLiquidityInput(working).minimumBufferMonths, WORKING.minimumBufferMonths);
  assert.equal(buildLiquidityInput(retired).minimumBufferMonths, RETIRED.minimumBufferMonths);
  pass('a single client’s own employment status selects the working or retired guide');
}

{
  // An explicitly stated retirement status outranks the employment field, and
  // is the signal the conversation actually captures.
  const stated = profileOf({
    assets: [cash('a1', ['primary'], 12_000)],
    assumptions: { calculationDateIso: TODAY, values: { persona: { retirementStatus: 'newly_retired' } } }
  });
  assert.equal(resolveLiquidityCohort(stated), 'retired');
  assert.equal(buildLiquidityInput(stated).clientStatus, 'retired');
  pass('a stated retirement status outranks the employment field');
}

{
  // Neither known: the module refuses rather than guessing a guide that
  // differs by a factor of four.
  const unknown = profileOf({
    assets: [cash('a1', ['primary'], 12_000)],
    primaryPerson: { personId: 'primary', role: 'primary', employmentStatus: 'unknown', age: 60 }
  });
  assert.equal(resolveLiquidityCohort(unknown), null);
  const readiness = getLiquidityReadiness(unknown);
  assert.equal(readiness.status, 'missing_information');
  assert.ok(readiness.requiredMissing.some((item) => item.fieldPath.includes('retirementStatus')));
  pass('an unknown cohort blocks rather than guessing between a 6- and a 24-month target');
}

{
  // Both members retired is a retired household under any reading.
  const bothRetired = profileOf({
    assets: [cash('a1', ['household'], 12_000)],
    primaryPerson: { personId: 'primary', role: 'primary', employmentStatus: 'retired', age: 70 },
    partner: { personId: 'partner', role: 'partner', employmentStatus: 'retired', age: 68 }
  });
  assert.equal(resolveLiquidityCohort(bothRetired), 'retired');
  assert.equal(buildLiquidityInput(bothRetired).targetBufferMonths, RETIRED.targetBufferMonths);
  pass('a couple who have both retired get the retired guide');
}

/* ------------------------------------------------------- input contract */

{
  const valid = buildLiquidityInput(profileOf({ assets: [cash('a1', ['household'], 12_000)] }));
  assert.doesNotThrow(() => validateLiquidityInput(valid));
  // A buffer override the engine would silently discard is refused instead, so
  // an adviser cannot type one figure and have the illustration use another.
  for (const bad of [0, -3, 'six', Number.NaN]) {
    assert.throws(
      () => validateLiquidityInput({ ...valid, minimumBufferMonths: bad }),
      /positive number of months/,
      `minimumBufferMonths ${String(bad)} is refused`
    );
  }
  assert.throws(() => validateLiquidityInput({ ...valid, currentCash: -1 }), /must not be negative/);
  assert.throws(() => validateLiquidityInput({ ...valid, monthlyExpenditure: 'lots' }), /finite number/);
  pass('an unusable buffer override is refused rather than silently replaced by the policy default');
}

{
  const profile = profileOf({
    assets: [cash('a1', ['household'], 12_000)],
    assumptions: { calculationDateIso: TODAY, values: { liquidity: { minimumBufferMonths: -3 } } }
  });
  let error = null;
  try {
    await runPlanningModule('liquidity_analysis', profile, { calculationVersion: 'test', calculatedAt: NOW });
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, 'the run fails');
  assert.equal(classifyModuleFailure(error), MODULE_FAILURE_CODES.INPUT_INVALID,
    'and reports as an invalid input, not as an engine crash');
  pass('a bad buffer assumption reports module_input_invalid');
}

/* ------------------------------------------------------------- end to end */

{
  const profile = profileOf({
    assets: [cash('a1', ['household'], 12_000)],
    expenses: { monthlyEssential: EUR(2_000) }
  });
  const readiness = getLiquidityReadiness(profile);
  assert.equal(readiness.status, 'ready_with_assumptions');
  assert.ok(
    readiness.assumptionsUsed.some((item) => item.key === 'minimumBufferMonths' && item.value === 3),
    'the policy months are declared as assumptions, with their basis'
  );
  const result = await runPlanningModule('liquidity_analysis', profile, {
    calculationVersion: 'test', calculatedAt: NOW, scenarioOverrides: {}
  });
  assert.equal(result.semanticResult.monthsCovered, 6, 'the hand-checked figure survives the whole path');
  assert.equal(result.semanticResult.targetCash, 12_000);
  assert.equal(result.semanticResult.shortfallCash, 0);
  assert.equal(result.semanticResult.position, 'at_or_above_target');
  assert.equal(result.semanticResult.policyVersion, PLANEIR_ASSUMPTIONS.liquidity.policyVersion);
  pass('liquidity runs end to end and reports the hand-checked reserve position');
}

console.info('[LiquidityAudit] All liquidity reserve audit checks passed.');
