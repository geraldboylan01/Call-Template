// Future cost fund: the engine, proved against an independent reference.
//
// The reference below imports NOTHING from `js/future_cost_fund_math.js`. It
// rebuilds every case year by year from first principles and finds the amounts
// by bisection: the smallest lump sum that lets the fund pay every cost, then
// the yearly amount that closes the fund at zero. The engine solves the same
// problem with a present-value formula, so agreement is a real cross-check and
// not a copy. This is how check-college-funding-audit.mjs proves its engine.

import assert from 'node:assert/strict';

import {
  computeFutureCostFundProjection
} from '../js/future_cost_fund_math.js';
import {
  FUTURE_COST_FUND_EXPECTED,
  FUTURE_COST_FUND_SAMPLE,
  designFixtureOptions,
  runFutureCostFundTests
} from '../js/tests_future_cost_fund_math.js';
import { PLANEIR_ASSUMPTIONS } from '../js/planning/planeir_assumptions.js';
import { resolveTaxRules } from '../js/planning/tax/resolve.js';

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.info(`[FutureCostFundAudit] PASS: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`[FutureCostFundAudit] FAIL: ${name}\n    ${error.message}`);
  }
}

/** Does a fund that starts with `lump` and saves `yearly` pay every cost? Returns the closing balance. */
function simulate({ lump, yearly, savingFrom, startsIn, durationYears, costs, rate }) {
  let balance = 0;
  let lowest = Infinity;
  const lastYear = startsIn + durationYears - 1;
  for (let year = 0; year <= lastYear; year += 1) {
    if (year > 0) {
      balance *= 1 + rate;
    }
    if (year === 0) {
      balance += lump;
    }
    if (year >= savingFrom && year < startsIn) {
      balance += yearly;
    }
    balance -= costs[year] || 0;
    lowest = Math.min(lowest, balance);
  }
  return { closing: balance, lowest };
}

function bisect(fn, low, high) {
  let a = low;
  let b = high;
  for (let i = 0; i < 200; i += 1) {
    const mid = (a + b) / 2;
    if (fn(mid) >= 0) {
      b = mid;
    } else {
      a = mid;
    }
  }
  return (a + b) / 2;
}

function reference({ payload, priceRate, cashGross, dirt }) {
  const rate = cashGross * (1 - dirt);
  const costs = {};
  for (let k = 0; k < payload.durationYears; k += 1) {
    const year = payload.startsInYears + k;
    costs[year] = payload.annualCostToday * (1 + priceRate) ** year;
  }
  const total = Object.values(costs).reduce((sum, amount) => sum + amount, 0);
  const common = {
    startsIn: payload.startsInYears,
    durationYears: payload.durationYears,
    costs,
    rate
  };

  // The whole cost, funded today: the least lump sum whose fund never goes short.
  const requiredToday = bisect(
    (lump) => simulate({ ...common, lump, yearly: 0, savingFrom: 0 }).lowest,
    0,
    total
  );

  return {
    total,
    requiredToday,
    rate,
    cases: payload.scenarios.map((scenario) => {
      const share = scenario.lumpShare ?? 0;
      const savingFrom = share >= 1 ? payload.startsInYears : (scenario.savingStartsInYears ?? 0);
      const lump = share * requiredToday;
      const savingYears = payload.startsInYears - savingFrom;
      const yearly = savingYears > 0
        ? bisect(
          (amount) => simulate({ ...common, lump, yearly: amount, savingFrom }).lowest,
          0,
          total
        )
        : 0;
      return { id: scenario.id, lump, yearly, savingYears, paidIn: lump + yearly * savingYears };
    })
  };
}

function compare(engine, ref, label) {
  assert.ok(
    Math.abs(engine.debug.totalCost - ref.total) < 0.01,
    `${label}: total cost ${engine.debug.totalCost} vs ${ref.total}`
  );
  assert.ok(
    Math.abs(engine.debug.requiredToday - ref.requiredToday) < 0.01,
    `${label}: required today ${engine.debug.requiredToday} vs ${ref.requiredToday}`
  );
  engine.debug.cases.forEach((entry, index) => {
    const expected = ref.cases[index];
    assert.equal(entry.id, expected.id, `${label}: case order`);
    assert.ok(Math.abs(entry.lumpSumToday - expected.lump) < 0.01, `${label}/${entry.id}: lump sum ${entry.lumpSumToday} vs ${expected.lump}`);
    assert.ok(Math.abs(entry.yearlyAmount - expected.yearly) < 0.01, `${label}/${entry.id}: yearly ${entry.yearlyAmount} vs ${expected.yearly}`);
    assert.equal(entry.savingYears, expected.savingYears, `${label}/${entry.id}: years of saving`);
    assert.ok(Math.abs(entry.paidIn - expected.paidIn) < 0.05, `${label}/${entry.id}: paid in ${entry.paidIn} vs ${expected.paidIn}`);
  });
}

// ---------------------------------------------------------------------------

check('the central values the module reads are the ones the brief settled', () => {
  assert.equal(PLANEIR_ASSUMPTIONS.inflation.educationRate, 0.04);
  assert.equal(PLANEIR_ASSUMPTIONS.inflation.generalRate, 0.02);
  assert.equal(PLANEIR_ASSUMPTIONS.cash.instantAccessGrossRate, 0.002);
  assert.equal(resolveTaxRules(2026).dirt.rate, 0.33);
});

check('central defaults match the independent reference, year by year', () => {
  const engine = computeFutureCostFundProjection(FUTURE_COST_FUND_SAMPLE, { calculationYear: 2026 });
  const ref = reference({
    payload: FUTURE_COST_FUND_SAMPLE,
    priceRate: 0.04,
    cashGross: 0.002,
    dirt: 0.33
  });
  compare(engine, ref, 'central');
  assert.ok(Math.abs(ref.rate - 0.00134) < 1e-12, 'the reference net rate is 0.134%');
});

check('the design fixture matches the independent reference', () => {
  const engine = computeFutureCostFundProjection(FUTURE_COST_FUND_SAMPLE, designFixtureOptions());
  const ref = reference({
    payload: FUTURE_COST_FUND_SAMPLE,
    priceRate: 0.03,
    cashGross: 0.02,
    dirt: 0
  });
  compare(engine, ref, 'design');
});

check('a general cost, a long run and a one-year lead match the reference too', () => {
  [
    { costKind: 'general', startsInYears: 5, durationYears: 6, annualCostToday: 8_000 },
    { costKind: 'education', startsInYears: 1, durationYears: 1, annualCostToday: 5_000 },
    { costKind: 'education', startsInYears: 10, durationYears: 4, annualCostToday: 5_000 },
    { costKind: 'general', startsInYears: 25, durationYears: 25, annualCostToday: 12_000 }
  ].forEach((shape, index) => {
    const payload = {
      ...FUTURE_COST_FUND_SAMPLE,
      ...shape,
      scenarios: [
        { id: 'lump', lumpShare: 1 },
        { id: 'yearly', lumpShare: 0 },
        { id: 'quarter', lumpShare: 0.25 },
        { id: 'late', lumpShare: 0, savingStartsInYears: Math.min(2, shape.startsInYears - 1) }
      ]
    };
    const engine = computeFutureCostFundProjection(payload, { calculationYear: 2026 });
    const ref = reference({
      payload,
      priceRate: shape.costKind === 'education' ? 0.04 : 0.02,
      cashGross: 0.002,
      dirt: 0.33
    });
    compare(engine, ref, `shape ${index + 1}`);
  });
});

check('the published tables in the spec are reproduced to the nearest €100', () => {
  const central = computeFutureCostFundProjection(FUTURE_COST_FUND_SAMPLE, { calculationYear: 2026 });
  const rows = central.outputsTable.rows;
  assert.deepEqual(rows.map((row) => row[1]), FUTURE_COST_FUND_EXPECTED.central.lumpSum);
  assert.deepEqual(rows.map((row) => row[2]), FUTURE_COST_FUND_EXPECTED.central.yearly);
  assert.deepEqual(rows.map((row) => row[4]), FUTURE_COST_FUND_EXPECTED.central.paidIn);
  assert.deepEqual(rows.map((row) => row[5]), FUTURE_COST_FUND_EXPECTED.central.growth);
});

// The unit suite, run here so one command proves both.
const summary = runFutureCostFundTests();
if (summary.failed > 0) {
  failures += summary.failed;
}

if (failures > 0) {
  console.error(`[FutureCostFundAudit] ${failures} check(s) failed.`);
  process.exit(1);
}

console.info('[FutureCostFundAudit] the engine matches the independent reference and the unit suite passes.');
