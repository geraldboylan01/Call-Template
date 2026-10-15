// Rental keep or sell: the engine, proved against an independent reference.
//
// The reference below imports NOTHING from `js/rental_keep_or_sell_math.js`.
// It works in whole cents with integer arithmetic and rebuilds each case as a
// running balance, where the engine builds rows and bar ends. Agreement is a
// real cross-check and not a copy. This is how check-college-funding-audit.mjs
// proves its engine.

import assert from 'node:assert/strict';

import { computeRentalKeepOrSellProjection } from '../js/rental_keep_or_sell_math.js';
import {
  RENTAL_KEEP_OR_SELL_SAMPLE,
  runRentalKeepOrSellTests
} from '../js/tests_rental_keep_or_sell_math.js';
import { runRentalKeepOrSellViewTests } from '../js/tests_rental_keep_or_sell_view.js';
import { runRentalKeepOrSellModuleTests } from '../js/tests_rental_keep_or_sell_module.js';
import { runRentalKeepOrSellWiringTests } from '../js/tests_rental_keep_or_sell_wiring.js';

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.info(`[RentalKeepOrSellAudit] PASS: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`[RentalKeepOrSellAudit] FAIL: ${name}\n    ${error.message}`);
  }
}

const cents = (euro) => Math.round(euro * 100);

/** The balance left after each deduction, in whole cents, and the final one. */
function runningBalances(startEuro, deductionsEuro) {
  let left = cents(startEuro);
  const after = deductionsEuro.map((euro) => {
    left -= cents(euro);
    return left;
  });
  return { after, result: left };
}

function reference(payload) {
  return {
    keep: runningBalances(payload.rentPerYear, [
      payload.loanRepaymentsPerYear,
      payload.runningCostsPerYear,
      payload.taxOnRentalProfitPerYear
    ]),
    sell: runningBalances(payload.salePrice, [
      payload.sellingCosts,
      payload.loanBalance,
      payload.taxOnGain
    ])
  };
}

function compare(payload, label) {
  const engine = computeRentalKeepOrSellProjection(payload);
  const ref = reference(payload);
  ['keep', 'sell'].forEach((id) => {
    const entry = engine.debug.cases.find((candidate) => candidate.id === id);
    const expected = ref[id];

    // Each cut ends at the balance the reference reaches after that deduction.
    ['cut1', 'cut2', 'cut3'].forEach((key, index) => {
      const row = entry.rows.find((candidate) => candidate.key === key);
      assert.equal(
        Math.round(row.lo * 100),
        expected.after[index],
        `${label}/${id}/${key}: lower end ${row.lo} vs ${expected.after[index] / 100}`
      );
    });

    assert.equal(
      Math.round(entry.result * 100),
      expected.result,
      `${label}/${id}: result ${entry.result} vs ${expected.result / 100}`
    );

    const result = entry.rows.find((candidate) => candidate.key === 'result');
    assert.equal(Math.round(result.lo * 100), Math.min(0, expected.result), `${label}/${id}: result lower end`);
    assert.equal(Math.round(result.hi * 100), Math.max(0, expected.result), `${label}/${id}: result upper end`);

    const expectedTone = expected.result > 0 ? 'left_over' : expected.result < 0 ? 'short' : 'level';
    assert.equal(entry.resultTone, expectedTone, `${label}/${id}: tone`);
  });
}

/** A fixed pseudo-random sequence, so a failure can be reproduced. */
function sequence(seed) {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

// ---------------------------------------------------------------------------

check('the sample matches the independent reference, line by line', () => {
  compare(RENTAL_KEEP_OR_SELL_SAMPLE, 'sample');
});

check('the sample reaches the two answers the design is drawn from', () => {
  const ref = reference(RENTAL_KEEP_OR_SELL_SAMPLE);
  assert.deepEqual(ref.keep.after.map((value) => value / 100), [5_000, 2_500, -1_200]);
  assert.equal(ref.keep.result / 100, -1_200, 'net each year');
  assert.deepEqual(ref.sell.after.map((value) => value / 100), [314_000, 134_000, 113_000]);
  assert.equal(ref.sell.result / 100, 113_000, 'in hand');
});

check('the edges match too: nothing left, a shortfall, an empty sale, a loan above the price', () => {
  [
    { ...RENTAL_KEEP_OR_SELL_SAMPLE, rentPerYear: 19_200 },
    { ...RENTAL_KEEP_OR_SELL_SAMPLE, rentPerYear: 4_000 },
    { ...RENTAL_KEEP_OR_SELL_SAMPLE, loanRepaymentsPerYear: 0, runningCostsPerYear: 0, taxOnRentalProfitPerYear: 0 },
    { ...RENTAL_KEEP_OR_SELL_SAMPLE, sellingCosts: 0, loanBalance: 0, taxOnGain: 0 },
    { ...RENTAL_KEEP_OR_SELL_SAMPLE, loanBalance: 400_000 },
    { ...RENTAL_KEEP_OR_SELL_SAMPLE, loanBalance: 293_000 },
    { ...RENTAL_KEEP_OR_SELL_SAMPLE, rentPerYear: 18_000.5, taxOnGain: 20_999.99 }
  ].forEach((payload, index) => compare(payload, `edge ${index + 1}`));
});

check('three hundred seeded payloads match the reference', () => {
  const next = sequence(20_261_013);
  const euro = (limit) => Math.round(next() * limit);
  for (let index = 0; index < 300; index += 1) {
    const payload = {
      rentPerYear: 1 + euro(60_000),
      loanRepaymentsPerYear: euro(40_000),
      runningCostsPerYear: euro(15_000),
      taxOnRentalProfitPerYear: euro(15_000),
      salePrice: 1 + euro(1_500_000),
      sellingCosts: euro(60_000),
      loanBalance: euro(1_200_000),
      taxOnGain: euro(250_000)
    };
    compare(payload, `seeded ${index + 1}`);
  }
});

// The unit suites, run here so one command proves the engine and the view.
const summary = runRentalKeepOrSellTests();
if (summary.failed > 0) {
  failures += summary.failed;
}

// The words and the geometry, asked without a browser.
const viewSummary = runRentalKeepOrSellViewTests();
if (viewSummary.failed > 0) {
  failures += viewSummary.failed;
}

// The module itself, driven against a small DOM shim and a fake clock.
const moduleSummary = await runRentalKeepOrSellModuleTests();
if (moduleSummary.failed > 0) {
  failures += moduleSummary.failed;
}

// The paste pipeline, the session importer and the presenter catalogue.
const wiringSummary = runRentalKeepOrSellWiringTests();
if (wiringSummary.failed > 0) {
  failures += wiringSummary.failed;
}

if (failures > 0) {
  console.error(`[RentalKeepOrSellAudit] ${failures} check(s) failed.`);
  process.exit(1);
}

console.info('[RentalKeepOrSellAudit] the engine matches the independent reference and the engine, view, module and wiring suites pass.');
