#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeDatedCostFunding, computeFutureCostFundProjection, normalizeFutureCostFundInputs } from '../js/future_cost_fund_math.js';
import { computeCollegeFundingProjection } from '../js/college_funding_math.js';
import { FUTURE_COST_FUND_SAMPLE } from '../js/tests_future_cost_fund_math.js';
import { PLANEIR_ASSUMPTIONS, approvedCollegeScenarios } from '../js/planning/planeir_assumptions.js';
import { resolveTaxRules } from '../js/planning/tax/resolve.js';
import { referenceDatedCostFunding } from './references/dated-cost-funding.mjs';

let total = 0, failures = 0;
async function test(name, fn) {
  total++;
  try { await fn(); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.stack); }
}
const close = (a, b) => assert(Math.abs(a - b) < 0.01, `${a} != ${b}`);
const options = { calculationYear: 2026 };
const rate = PLANEIR_ASSUMPTIONS.cash.instantAccessGrossRate * (1 - resolveTaxRules(2026).dirt.rate);
const schedule = (start, amounts) => amounts.map((cost, index) => ({ yearIndex: start + index, cost }));
function compare(input, engineOptions = options, expectedRate = rate) {
  const before = structuredClone(input);
  const actual = computeDatedCostFunding(input, engineOptions);
  const expected = referenceDatedCostFunding({ ...input, rate: expectedRate });
  close(actual.requiredToday, expected.requiredToday); close(actual.moneyNow, expected.moneyNow);
  assert.equal(actual.moneyEachYear.length, expected.moneyEachYear.length);
  actual.moneyEachYear.forEach((row, i) => {
    assert.equal(row.yearIndex, expected.moneyEachYear[i].yearIndex);
    close(row.amount, expected.moneyEachYear[i].amount);
  });
  actual.rows.forEach((row, i) => { close(row.closingBalance, expected.rows[i].balance); assert(row.closingBalance >= -0.01); });
  close(actual.rows.at(-1).closingBalance, 0); assert.deepEqual(input, before);
  return actual;
}

await test('The reference imports nothing from the funding engine or contract', () => {
  assert(!/^import\s/m.test(readFileSync(new URL('./references/dated-cost-funding.mjs', import.meta.url), 'utf8')));
});
await test('A cost starting now can be paid each year or with cash today, never by saving first', () => {
  const input = { costKind: 'general', startsInYears: 0, costYears: schedule(0, [10000, 11000, 12000]) };
  compare({ ...input, funding: 'each_year' }); compare({ ...input, funding: 'lump_sum_now' });
  assert.throws(() => computeDatedCostFunding(input, options), /cannot use save_then_pay/);
  assert.throws(() => normalizeFutureCostFundInputs({ ...FUTURE_COST_FUND_SAMPLE, startsInYears: 0 }), /from 1 to 40/);
});
await test('A varying nominal schedule is never inflated again, in all three funding modes', () => {
  for (const funding of ['save_then_pay', 'each_year', 'lump_sum_now']) {
    for (const start of [1, 5, 40]) compare({ costKind: 'education', startsInYears: start,
      costYears: schedule(start, [12000, 16000, 0, 4000, 3500]), funding });
  }
});
await test('Paying each bill directly needs no fund and takes the actual yearly amount', () => {
  const amounts = [9000, 8000, 7000, 4000, 3000];
  const result = compare({ costKind: 'general', startsInYears: 0, costYears: schedule(0, amounts), funding: 'each_year' });
  assert.deepEqual(result.moneyEachYear.map(row => row.amount), amounts);
  assert(result.rows.every(row => row.closingBalance === 0));
});
await test('Opening cash earns the central net rate and reduces the recalculated yearly money', () => {
  for (const funding of ['save_then_pay', 'each_year']) {
    const input = { costKind: 'general', startsInYears: 5, costYears: schedule(5, [18000, 15000, 12000, 5000]), funding };
    const empty = compare(input);
    const part = compare({ ...input, cashToday: empty.requiredToday * 0.4 });
    close(part.moneyNow, empty.requiredToday * 0.6);
    assert(part.moneyEachYear.reduce((n, row) => n + row.amount, 0) < empty.moneyEachYear.reduce((n, row) => n + row.amount, 0));
    compare({ ...input, cashToday: empty.requiredToday });
  }
});
await test('Zero cash interest and a zero-cost year use the same arithmetic', () => {
  const zero = { ...options, assumptions: { ...PLANEIR_ASSUMPTIONS, cash: { instantAccessGrossRate: 0 } } };
  compare({ costKind: 'general', startsInYears: 2, costYears: schedule(2, [2000, 0, 3000]), cashToday: 1000 }, zero, 0);
  compare({ costKind: 'general', startsInYears: 0, costYears: schedule(0, [0, 0]), funding: 'each_year' });
});
await test('Nominal start-of-year funding equals the independently computed real-rate present value', () => {
  for (const startsInYears of [0, 1, 8, 40]) {
    for (const inflation of [0, 0.02, 0.04]) {
      const costYears = schedule(startsInYears, Array.from({ length: 5 }, (_, k) => 10000 * (1 + inflation) ** (startsInYears + k)));
      const result = compare({ costKind: 'education', startsInYears, costYears, funding: 'lump_sum_now' });
      const real = (1 + rate) / (1 + inflation) - 1;
      const present = Array.from({ length: 5 }, (_, k) => 10000 / (1 + real) ** (startsInYears + k)).reduce((a, b) => a + b, 0);
      close(result.requiredToday, present);
    }
  }
});
await test('Missing dates, invalid schedules, overfunding and non-finite amounts are refused', () => {
  const base = { costKind: 'general', startsInYears: 2, costYears: schedule(2, [1000, 2000]) };
  assert.throws(() => computeDatedCostFunding(base), /explicit calculationYear/);
  for (const patch of [{ startsInYears: -1 }, { startsInYears: 41 }, { costYears: [] }, { costYears: schedule(2, [NaN]) },
    { costYears: schedule(2, [-1]) }, { costYears: schedule(3, [1]) }, { cashToday: 100000 }, { cashToday: -1 }, { savingStartsInYears: 2 }, { funding: 'unknown' }]) {
    assert.throws(() => computeDatedCostFunding({ ...base, ...patch }, options));
  }
  assert.throws(() => computeDatedCostFunding({ ...base, costYears: schedule(2, [Number.MAX_VALUE, Number.MAX_VALUE]) }, options), /overflow/);
});
await test('The screen sample and its four funding cases retain the captured main figures to the cent', () => {
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/dated-cost-sample-baseline.json', import.meta.url))).future;
  const result = computeFutureCostFundProjection(FUTURE_COST_FUND_SAMPLE, options).debug;
  close(result.totalCost, baseline.totalCost); close(result.requiredToday, baseline.requiredToday);
  result.cases.forEach((entry, i) => Object.entries(baseline.cases[i]).forEach(([key, value]) => {
    if (typeof value === 'number') close(entry[key], value); else assert.equal(entry[key], value);
  }));
  result.costYears.forEach((row, i) => close(row.cost, baseline.costYears[i].cost));
  const withInternalFields = computeFutureCostFundProjection({ ...FUTURE_COST_FUND_SAMPLE,
    costYears: schedule(0, [1]), cashToday: 1, funding: 'each_year' }, options);
  assert.deepEqual(withInternalFields.debug, result);
});
await test('The college sample retains every native yearly cost to the cent', () => {
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/dated-cost-sample-baseline.json', import.meta.url))).college;
  const result = computeCollegeFundingProjection({ currentYear: 2026, inflationRate: PLANEIR_ASSUMPTIONS.inflation.educationRate,
    children: [{ id: 'child', title: 'Child', currentAge: 10, collegeStartAge: 18, collegeDurationYears: 4 }], scenarios: approvedCollegeScenarios() });
  result.debug.scenarios.forEach((entry, i) => {
    close(entry.costToday, baseline[i].costToday); close(entry.nominalCost, baseline[i].nominalCost);
    entry.yearRows.forEach((row, j) => close(row.annualFamilyCost, baseline[i].costByYear[j].cost));
  });
});

console.log(`Dated-cost contract checks: ${total - failures}/${total} passed.`);
process.exitCode = failures ? 1 : 0;
