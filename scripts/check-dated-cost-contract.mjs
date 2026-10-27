#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeDatedCostFunding, computeFutureCostFundProjection, normalizeFutureCostFundInputs } from '../js/future_cost_fund_math.js';
import { computeCollegeFundingProjection } from '../js/college_funding_math.js';
import { FUTURE_COST_FUND_SAMPLE } from '../js/tests_future_cost_fund_math.js';
import { PLANEIR_ASSUMPTIONS, approvedCollegeScenarios } from '../js/planning/planeir_assumptions.js';
import { resolveTaxRules } from '../js/planning/tax/resolve.js';
import { referenceDatedCostFunding } from './references/dated-cost-funding.mjs';
import { createDatedCost } from '../js/planning/dated_costs/contract.js';
import { produceCollegeCost } from '../js/planning/dated_costs/college_funding.js';
import { produceFutureCostFundCost } from '../js/planning/dated_costs/future_cost_fund.js';
import { compilePlanPack } from '../js/planning/plan_pack/compiler.js';

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

const contractInput = () => ({ costId: 'cost', goalId: 'goal', title: 'Dated cost',
  producer: { module: 'test', version: '1.0.0' }, payerIds: ['one', 'two'],
  payerRetirements: [{ personId: 'one', stopsFromYear: 2028 }, { personId: 'two', stopsFromYear: 2030 }],
  calculationDate: '2026-11-01', costKind: 'general', funding: 'each_year',
  costByYear: [2027, 2028, 2029, 2030, 2031].map(year => ({ year, amountBeforeRelief: 10000,
    reliefAmount: 3000, amountAfterRelief: 7000, reliefClaims: [{ claimantId: 'one', amount: 3000, rulesVersion: 'test-tax-1' }] })) });
await test('The three yearly amounts reconcile with named tax-engine claims, counted once', () => {
  const input = contractInput(), before = structuredClone(input), result = createDatedCost(input);
  assert.deepEqual(input, before); assert.equal(result.moneyEachYear[1].amount, 7000);
  assert.deepEqual(result.costByYear[0], input.costByYear[0]);
  for (const patch of [{ reliefAmount: 4000 }, { amountAfterRelief: 6000 }, { reliefClaims: [] },
    { reliefClaims: [{ claimantId: 'unknown', amount: 3000, rulesVersion: 'v1' }] },
    { reliefClaims: [{ claimantId: 'one', amount: 3000 }] }]) {
    const invalid = contractInput(); Object.assign(invalid.costByYear[0], patch);
    assert.throws(() => createDatedCost(invalid), /datedCost\/costByYear/);
  }
});
await test('The split waits for every payer and prices the later annual amounts at that year', () => {
  const result = createDatedCost(contractInput()), split = result.retirementSplit;
  assert.equal(split.year, 2030); assert.deepEqual(split.before.map(row => row.year), [2026, 2027, 2028, 2029]);
  assert.deepEqual(split.after.map(row => row.year), [2030, 2031]);
  close(split.capitalNeededAtRetirement, 7000 + 7000 / (1 + rate));
  assert.deepEqual([...split.before, ...split.after], result.moneyEachYear);
});
await test('Already-retired payers retain their continuing B1.1 share and never split it again', () => {
  const input = contractInput(); input.payerRetirements[1].stopsFromYear = null;
  const split = createDatedCost(input).retirementSplit;
  assert.equal(split.year, null); assert.equal(split.after.length, 0); assert.equal(split.capitalNeededAtRetirement, 0);
  delete input.payerRetirements;
  assert.throws(() => createDatedCost(input), /retirement boundary/);
});
await test('An early retirement can transfer forty future saving years without changing payload limits', () => {
  const input = contractInput(); input.funding = 'save_then_pay';
  input.payerRetirements.forEach(row => { row.stopsFromYear = 2026; });
  input.costByYear = [{ ...input.costByYear[0], year: 2066 }];
  const split = createDatedCost(input).retirementSplit;
  assert.equal(split.after.length, 40); close(split.capitalNeededAtRetirement, createDatedCost(input).moneyNow);
});

const payer = { payerIds: ['parent'], payerRetirements: [{ personId: 'parent', stopsFromYear: 2050 }] };
const producerBase = { ...payer, calculationDate: '2026-11-01', costId: 'cost', goalId: 'college' };
const collegeInput = () => ({ currentYear: 2026, inflationRate: PLANEIR_ASSUMPTIONS.inflation.educationRate,
  children: [{ id: 'child', title: 'Child', currentAge: 10, collegeStartAge: 18, collegeDurationYears: 4 }], scenarios: approvedCollegeScenarios() });
await test('The future-cost producer pins the full sample schedule, present value and each funding case to the cent', () => {
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/dated-cost-sample-baseline.json', import.meta.url))).future;
  for (const [i, scenario] of FUTURE_COST_FUND_SAMPLE.scenarios.entries()) {
    const result = produceFutureCostFundCost({ ...producerBase, input: FUTURE_COST_FUND_SAMPLE,
      cashToday: baseline.requiredToday * scenario.lumpShare, savingStartsInYears: scenario.savingStartsInYears ?? 0,
      funding: scenario.lumpShare === 1 ? 'lump_sum_now' : 'save_then_pay' });
    close(result.provenance.requiredToday, baseline.requiredToday);
    result.costByYear.forEach((row, j) => close(row.amountAfterRelief, baseline.costYears[j].cost));
    result.moneyEachYear.filter(row => row.year >= 2026 + (scenario.savingStartsInYears ?? 0))
      .forEach(row => close(row.amount, baseline.cases[i].yearlyAmount));
  }
});
await test('The college producer returns the native sample bills to the cent, without a second inflation step', () => {
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/dated-cost-sample-baseline.json', import.meta.url))).college;
  for (const expected of baseline) {
    const result = produceCollegeCost({ ...producerBase, title: 'College', input: collegeInput(), scenarioId: expected.id });
    result.costByYear.forEach((row, i) => close(row.amountAfterRelief, expected.costByYear[i].cost));
    close(result.costByYear.reduce((n, row) => n + row.amountAfterRelief, 0), expected.nominalCost);
  }
});
await test('Part of a lump sum gives the same yearly funding whichever module produces the same cost', () => {
  for (const cashToday of [0, 10000, 30000, 86066.1822762033]) {
    const fund = produceFutureCostFundCost({ ...producerBase, input: FUTURE_COST_FUND_SAMPLE, cashToday });
    const college = produceCollegeCost({ ...producerBase, title: 'College', input: collegeInput(), scenarioId: 'living_away', cashToday });
    assert.deepEqual(fund.costByYear, college.costByYear);
    fund.moneyEachYear.forEach((row, i) => close(row.amount, college.moneyEachYear[i].amount));
    close(fund.moneyNow, college.moneyNow);
  }
});
await test('A producer passes its explicit plan date and never falls back to the clock', () => {
  const OriginalDate = globalThis.Date;
  globalThis.Date = class extends OriginalDate { constructor(...args) { if (!args.length) throw new Error('Clock read'); super(...args); } };
  try {
    const fund = produceFutureCostFundCost({ ...producerBase, input: FUTURE_COST_FUND_SAMPLE });
    const college = produceCollegeCost({ ...producerBase, title: 'College', input: collegeInput(), scenarioId: 'living_away' });
    assert.equal(fund.assumptions.calculationYear, 2026); assert.equal(college.assumptions.calculationYear, 2026);
    assert.throws(() => produceFutureCostFundCost({ ...producerBase, calculationDate: undefined, input: FUTURE_COST_FUND_SAMPLE }));
    assert.throws(() => produceCollegeCost({ ...producerBase, title: 'College', input: { ...collegeInput(), currentYear: 2027 }, scenarioId: 'living_away' }), /match calculationDate/);
  } finally { globalThis.Date = OriginalDate; }
});
await test('The future-cost producer supports an internal cost starting now without widening its payload', () => {
  const result = produceFutureCostFundCost({ ...producerBase, input: { ...FUTURE_COST_FUND_SAMPLE, startsInYears: 0 } });
  assert.equal(result.moneyEachYear[0].year, 2026); close(result.moneyEachYear[0].amount, 15000);
});

function datedPack({ start = 2, duration = 5, funding = 'each_year', pension = false } = {}) {
  const p = JSON.parse(readFileSync(new URL('./fixtures/plan-packs/valid-b1.json', import.meta.url)));
  p.narration = {}; p.routes = [{ id: 'current' }, { id: 'fund' }]; p.goalFlexibility = {};
  p.chapters = ['household_cash_flow', 'liquidity_analysis'];
  p.household.goals = p.household.goals.filter(goal => pension && goal.goalId === 'goal_retirement');
  p.planningInputs.goalBindings = p.planningInputs.goalBindings.filter(goal => pension && goal.goalId === 'goal_retirement');
  p.planningInputs.goalFundingFacts = [];
  p.household.goals.push({ goalId: 'cost', type: 'assess_decision', title: 'School fees', priority: 'low', status: 'active',
    targetDate: `${2026 + start}-11-01`, targetAmount: { amount: 1000, currency: 'EUR' } });
  p.planningInputs.goalFundingFacts.push({ goalId: 'cost', kind: 'dated_cost', costKind: 'general', durationYears: duration,
    currentAnnualSaving: 0, funding });
  return p;
}
const compile = async p => {
  const info = console.info; console.info = () => {};
  try {
    const result = await compilePlanPack(p, { resourceLedger: true });
    assert.equal(result.status, 'compiled', JSON.stringify(result.diagnostics)); return result;
  } finally { console.info = info; }
};
const ledgerFor = (r, id = 'fund') => r.resourceLedger.routes.find(row => row.routeId === id);
await test('The ledger takes each producer year once, including a cost starting now', async () => {
  for (const start of [0, 2]) {
    const result = await compile(datedPack({ start })), ledger = ledgerFor(result), contract = ledger.datedCosts[0];
    for (const row of ledger.years) {
      const bill = contract.moneyEachYear.find(cost => cost.year === row.year)?.amount ?? 0;
      close(row.goals.find(goal => goal.goalId === 'cost').required, bill);
      close(row.planned, bill); // moneyNow is an alternative, never added
    }
    assert.notEqual(contract.costByYear[0].amountAfterRelief, contract.costByYear[1].amountAfterRelief);
  }
});
await test('Route useCash reprices the same contract; whole cash leaves no yearly requirement', async () => {
  const p = datedPack();
  p.routes = [{ id: 'current' }, { id: 'part', changes: [{ type: 'useCash', goalId: 'cost', amount: 1000 }] },
    { id: 'whole', changes: [{ type: 'useCash', goalId: 'cost', amount: 'whole' }] }];
  const result = await compile(p), original = ledgerFor(result, 'current').datedCosts[0];
  const part = ledgerFor(result, 'part'), whole = ledgerFor(result, 'whole');
  close(part.datedCosts[0].moneyNow, original.moneyNow - 1000);
  close(whole.cashAllocated, original.moneyNow); close(whole.datedCosts[0].moneyNow, 0);
  assert(whole.years.every(row => row.planned < 0.01));
  assert(part.years.some(row => row.planned > 0));
});
await test('Later needs move under retirement as named capital and are funded before the last payer stops', async () => {
  const p = datedPack({ start: 1, duration: 6 });
  p.household.primaryPerson.intendedRetirementAge = 47; // 2028
  p.household.partner.intendedRetirementAge = 46; // 2029
  const result = await compile(p), ledger = ledgerFor(result), cost = ledger.datedCosts[0];
  assert.equal(cost.retirementSplit.year, 2029);
  const retirement = ledger.pricing.find(row => row.kind === 'retirement_capital');
  const addition = retirement.priced.datedCostsAfterRetirement[0];
  assert.equal(addition.title, 'School fees after retirement');
  close(addition.capitalNeededAtRetirement, cost.retirementSplit.capitalNeededAtRetirement);
  assert(addition.fundingByYear.every(row => row.year < 2029));
  for (const row of ledger.years.filter(row => row.year >= 2029)) {
    assert.equal(row.goals.find(goal => goal.goalId === 'cost').required, 0);
    assert.equal(row.planned, 0);
  }
  assert(ledger.goals.every(row => row.state === 'covered'));
  const future = cost.retirementSplit.after.map(row => ({ yearIndex: row.year - 2029, cost: row.amount }));
  close(addition.capitalNeededAtRetirement, referenceDatedCostFunding({ startsInYears: future[0].yearIndex, costYears: future,
    rate, funding: 'lump_sum_now' }).requiredToday);
});
await test('An existing retirement goal owns the added capital without changing the pension-income target', async () => {
  const p = datedPack({ start: 21, duration: 5, pension: true });
  p.household.expenses.annualTotal.amount = 30000;
  const target = p.household.goals.find(goal => goal.goalId === 'goal_retirement').targetAmount.amount;
  const before = structuredClone(p), result = await compile(p), ledger = ledgerFor(result);
  const retirement = ledger.pricing.find(row => row.goalId === 'goal_retirement');
  assert(retirement.priced.datedCostsAfterRetirement.length > 0);
  assert.equal(retirement.priced.plannedInput.targetIncomeToday, target);
  assert(!ledger.pricing.some(row => row.kind === 'retirement_capital'));
  assert.deepEqual(p, before);
});
await test('Explicit payer IDs select that payer’s boundary and invalid or duplicate IDs fail', async () => {
  const p = datedPack({ start: 1, duration: 6 });
  p.household.primaryPerson.intendedRetirementAge = 47;
  p.planningInputs.goalFundingFacts[0].payerIds = ['niamh'];
  const result = await compile(p);
  assert.equal(ledgerFor(result).datedCosts[0].retirementSplit.year, 2028);
  for (const payerIds of [['absent'], ['niamh', 'niamh']]) {
    const invalid = structuredClone(p); invalid.planningInputs.goalFundingFacts[0].payerIds = payerIds;
    assert.equal((await compilePlanPack(invalid, { resourceLedger: true })).status, 'invalid');
  }
});

console.log(`Dated-cost contract checks: ${total - failures}/${total} passed.`);
process.exitCode = failures ? 1 : 0;
