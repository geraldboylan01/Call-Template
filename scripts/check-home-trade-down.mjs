// Home, trade down: the engine, proved against an independent reference.
//
// The reference below imports NOTHING from `js/home_trade_down_math.js`. The
// engine finds the loan a repayment supports with the closed-form annuity
// formula. The reference does not use that formula. It finds the loan by
// bisection on a month-by-month schedule: the largest loan that is repaid to
// zero, payment by payment, within the term. Then it confirms the answer a
// second way with logarithms, the number of months a loan takes to clear at
// that payment. Agreement is a real cross-check and not a copy. This is how
// check-college-funding-audit.mjs proves its engine.

import assert from 'node:assert/strict';

import { computeHomeTradeDownProjection } from '../js/home_trade_down_math.js';
import {
  HOME_TRADE_DOWN_EXPECTED,
  HOME_TRADE_DOWN_SAMPLE,
  runHomeTradeDownTests
} from '../js/tests_home_trade_down_math.js';
import { runHomeTradeDownViewTests } from '../js/tests_home_trade_down_view.js';
import { runHomeTradeDownModuleTests } from '../js/tests_home_trade_down_module.js';
import { runHomeTradeDownWiringTests } from '../js/tests_home_trade_down_wiring.js';

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.info(`[HomeTradeDownAudit] PASS: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`[HomeTradeDownAudit] FAIL: ${name}\n    ${error.message}`);
  }
}

/** The balance left after paying `monthly` for `months` months on `loan`. */
function balanceAfter(loan, monthly, months, monthlyRate) {
  let balance = loan;
  for (let month = 0; month < months; month += 1) {
    balance = balance * (1 + monthlyRate) - monthly;
  }
  return balance;
}

/** The largest loan that a monthly payment clears within the term, by bisection. */
function loanByBisection(yearly, years, annualRate) {
  const monthly = yearly / 12;
  const months = years * 12;
  const monthlyRate = annualRate / 12;
  let low = 0;
  let high = monthly * months + 1; // never more than the payments themselves
  for (let step = 0; step < 200; step += 1) {
    const mid = (low + high) / 2;
    if (balanceAfter(mid, monthly, months, monthlyRate) <= 0) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}

/** Months to clear `loan` at `monthly`, by logarithms. */
function monthsByLogarithm(loan, monthly, annualRate) {
  const monthlyRate = annualRate / 12;
  if (monthlyRate === 0) {
    return loan / monthly;
  }
  // log1p, not log(1 - x) and log(1 + r): at a rate of 1e-16 the first is log(1)
  // and the second divides by zero, which is the flaw the engine's loan had.
  return -Math.log1p(-(loan * monthlyRate) / monthly) / Math.log1p(monthlyRate);
}

const toThousand = (amount) => Math.round(amount / 1_000) * 1_000;

function compare(payload, label) {
  const engine = computeHomeTradeDownProjection(payload);
  const released = payload.homeValue - payload.mortgageBalance - payload.sellingCosts;
  const cash = released - payload.buyingCosts;

  assert.ok(Math.abs(engine.debug.released - released) < 1e-6, `${label}: released`);
  assert.ok(Math.abs(engine.debug.cashTowardHome - cash) < 1e-6, `${label}: cash toward the home`);

  // What is shown adds up. Each input is rounded on its own and everything else
  // is read off those, never rounded from the exact sum.
  const homeShown = Math.round(payload.homeValue);
  const mortgageShown = Math.round(payload.mortgageBalance);
  const releasedShown = homeShown - mortgageShown - Math.round(payload.sellingCosts);
  const cashShown = releasedShown - Math.round(payload.buyingCosts);
  const currentShown = Math.round(payload.currentAnnualRepayments);
  assert.equal(engine.debug.shown.homeValue, homeShown, `${label}: home as shown`);
  assert.equal(engine.debug.shown.released, releasedShown, `${label}: released as shown`);
  assert.equal(engine.debug.shown.cashTowardHome, cashShown, `${label}: cash as shown`);
  assert.equal(engine.debug.shown.currentAnnualRepayments, currentShown, `${label}: repayments today as shown`);

  engine.debug.cases.forEach((entry, index) => {
    const scenario = payload.scenarios[index];
    assert.equal(entry.id, scenario.id, `${label}: case order`);

    assert.equal(entry.block1 + entry.block2, entry.homeBudget, `${label}/${entry.id}: the blocks add to the budget`);
    assert.equal(entry.shownRepaid + entry.shownFreed, currentShown, `${label}/${entry.id}: repaid and freed add to today`);

    if (scenario.kind === 'stay') {
      assert.equal(entry.block1, homeShown - mortgageShown, `${label}/${entry.id}: your share`);
      assert.equal(entry.block2, mortgageShown, `${label}/${entry.id}: the mortgage`);
      assert.equal(entry.homeBudget, homeShown, `${label}/${entry.id}: the home as shown`);
      assert.equal(entry.shownRepaid, currentShown, `${label}/${entry.id}: repaid as shown`);
      assert.equal(entry.shownFreed, 0, `${label}/${entry.id}: nothing freed by staying`);
      assert.equal(entry.freed, 0, `${label}/${entry.id}: nothing freed by staying`);
      return;
    }

    const loan = loanByBisection(scenario.annualRepayment, payload.newLoanTermYears, payload.newLoanAnnualRate);
    assert.ok(
      Math.abs(entry.loanUnrounded - loan) < 0.01,
      `${label}/${entry.id}: loan ${entry.loanUnrounded} vs ${loan}`
    );

    if (scenario.annualRepayment > 0) {
      const months = monthsByLogarithm(loan, scenario.annualRepayment / 12, payload.newLoanAnnualRate);
      assert.ok(
        Math.abs(months - payload.newLoanTermYears * 12) < 1e-4,
        `${label}/${entry.id}: the loan clears in ${months} months, not ${payload.newLoanTermYears * 12}`
      );
    }

    assert.equal(entry.block2, toThousand(loan), `${label}/${entry.id}: the loan as shown`);
    assert.equal(entry.block1, cashShown, `${label}/${entry.id}: money from selling`);
    assert.equal(entry.homeBudget, cashShown + toThousand(loan), `${label}/${entry.id}: home budget`);
    assert.ok(
      Math.abs(entry.freed - (payload.currentAnnualRepayments - scenario.annualRepayment)) < 1e-9,
      `${label}/${entry.id}: freed, exactly`
    );
    assert.equal(entry.shownRepaid, Math.round(scenario.annualRepayment), `${label}/${entry.id}: repaid as shown`);
    assert.equal(entry.shownFreed, currentShown - Math.round(scenario.annualRepayment), `${label}/${entry.id}: freed as shown`);
    assert.ok(entry.shownFreed >= 0, `${label}/${entry.id}: freed is never shown below nothing`);
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

check('the sample matches the independent reference, case by case', () => {
  compare(HOME_TRADE_DOWN_SAMPLE, 'sample');
});

check('the sample reaches the loans and budgets the design is drawn from', () => {
  const rounded = (amount) => Math.round(amount / 1_000) * 1_000;
  const loan18 = loanByBisection(18_000, 15, 0.04);
  const loan12 = loanByBisection(12_000, 15, 0.04);
  assert.equal(rounded(loan18), 203_000, 'the loan at 18,000 a year');
  assert.equal(rounded(loan12), 135_000, 'the loan at 12,000 a year');
  assert.equal(343_000 + rounded(loan18), HOME_TRADE_DOWN_EXPECTED.homeBudget[1]);
  assert.equal(343_000 + rounded(loan12), HOME_TRADE_DOWN_EXPECTED.homeBudget[2]);
});

check('a longer term, a higher rate, no interest, a rate near zero and a one-year loan match too', () => {
  [
    { newLoanTermYears: 30, newLoanAnnualRate: 0.045 },
    { newLoanTermYears: 7, newLoanAnnualRate: 0.0725 },
    { newLoanTermYears: 20, newLoanAnnualRate: 0 },
    { newLoanTermYears: 1, newLoanAnnualRate: 0.04 },
    { newLoanTermYears: 40, newLoanAnnualRate: 0.15 },
    // Rates so near zero that 1 + r is 1, or nearly: the loan is still the payments.
    { newLoanTermYears: 15, newLoanAnnualRate: 1e-16 },
    { newLoanTermYears: 15, newLoanAnnualRate: 1e-14 },
    { newLoanTermYears: 12, newLoanAnnualRate: 1e-9 }
  ].forEach((patch, index) => {
    const payload = {
      ...HOME_TRADE_DOWN_SAMPLE,
      ...patch,
      scenarios: [
        { id: 'stay', kind: 'stay' },
        { id: 'small', kind: 'move', annualRepayment: 6_000 },
        { id: 'half', kind: 'move', annualRepayment: 15_000 },
        { id: 'none', kind: 'move', annualRepayment: 0 }
      ]
    };
    compare(payload, `terms ${index + 1}`);
  });
});

check('three hundred seeded households match the reference', () => {
  const next = sequence(20_261_014);
  let compared = 0;
  for (let index = 0; index < 600 && compared < 300; index += 1) {
    const homeValue = 200_000 + Math.round(next() * 1_800_000);
    const mortgageBalance = 20_000 + Math.round(next() * (homeValue * 0.6));
    const sellingCosts = Math.round(next() * homeValue * 0.04);
    const released = homeValue - mortgageBalance - sellingCosts;
    if (released < 20_000) {
      continue;
    }
    const buyingCosts = Math.round(next() * Math.min(released, homeValue * 0.05));
    const currentAnnualRepayments = 5_000 + Math.round(next() * 40_000);
    const payload = {
      homeValue,
      mortgageBalance,
      currentAnnualRepayments,
      sellingCosts,
      buyingCosts,
      newLoanTermYears: 1 + Math.floor(next() * 40),
      newLoanAnnualRate: Math.round(next() * 0.1 * 10_000) / 10_000,
      scenarios: [
        { id: 'stay', kind: 'stay' },
        { id: 'low', kind: 'move', annualRepayment: Math.round(next() * currentAnnualRepayments * 0.3) },
        { id: 'mid', kind: 'move', annualRepayment: Math.round(next() * currentAnnualRepayments * 0.6) },
        { id: 'none', kind: 'move', annualRepayment: 0 }
      ]
    };
    let accepted = true;
    try {
      computeHomeTradeDownProjection(payload);
    } catch (error) {
      // Only "the budget is more than the current home" may refuse a drawn household.
      assert.match(error.message, /more than the current home/, `seeded ${index}: ${error.message}`);
      accepted = false;
    }
    if (accepted) {
      compare(payload, `seeded ${index + 1}`);
      compared += 1;
    }
  }
  assert.ok(compared >= 200, `only ${compared} seeded households were comparable`);
});

check('three hundred seeded households with cents match the reference and add down as shown', () => {
  const next = sequence(20_261_015);
  const cents = (amount) => Math.round(amount * 100) / 100;
  let compared = 0;
  let shownDiffers = 0;
  for (let index = 0; index < 900 && compared < 300; index += 1) {
    const homeValue = cents(200_000 + (next() * 1_800_000));
    const mortgageBalance = cents(20_000 + (next() * homeValue * 0.6));
    const sellingCosts = cents(next() * homeValue * 0.04);
    const released = homeValue - mortgageBalance - sellingCosts;
    if (released < 20_000) {
      continue;
    }
    // Kept clear of the whole of the money from selling, so only the budget
    // against today's home can refuse a household here.
    const buyingCosts = cents(next() * Math.min(released * 0.9, homeValue * 0.05));
    const currentAnnualRepayments = cents(5_000 + (next() * 40_000));
    const payload = {
      homeValue,
      mortgageBalance,
      currentAnnualRepayments,
      sellingCosts,
      buyingCosts,
      newLoanTermYears: 1 + Math.floor(next() * 40),
      newLoanAnnualRate: Math.round(next() * 0.1 * 10_000) / 10_000,
      scenarios: [
        { id: 'stay', kind: 'stay' },
        { id: 'low', kind: 'move', annualRepayment: cents(next() * currentAnnualRepayments * 0.3) },
        { id: 'mid', kind: 'move', annualRepayment: cents(next() * currentAnnualRepayments * 0.6) },
        { id: 'none', kind: 'move', annualRepayment: 0 }
      ]
    };
    let accepted = true;
    try {
      computeHomeTradeDownProjection(payload);
    } catch (error) {
      assert.match(error.message, /more than the current home/, `seeded ${index}: ${error.message}`);
      accepted = false;
    }
    if (accepted) {
      compare(payload, `cents ${index + 1}`);
      // How often rounding the exact figure would have disagreed with the shown
      // rows: proof that this run exercises what the derivation is for.
      const projection = computeHomeTradeDownProjection(payload);
      projection.debug.cases.forEach((entry) => {
        if (Math.round(entry.freed) !== entry.shownFreed) shownDiffers += 1;
      });
      compared += 1;
    }
  }
  assert.ok(compared >= 200, `only ${compared} seeded households were comparable`);
  assert.ok(shownDiffers > 0, 'no household had a freed figure that rounding the exact sum would have got wrong');
});

// The unit suites, run here so one command proves the engine and the view.
const summary = runHomeTradeDownTests();
if (summary.failed > 0) {
  failures += summary.failed;
}

// The words and the geometry, asked without a browser.
const viewSummary = runHomeTradeDownViewTests();
if (viewSummary.failed > 0) {
  failures += viewSummary.failed;
}

// The module itself, driven against a small DOM shim and a fake clock.
const moduleSummary = await runHomeTradeDownModuleTests();
if (moduleSummary.failed > 0) {
  failures += moduleSummary.failed;
}

// The paste pipeline, the session importer and the presenter catalogue.
const wiringSummary = runHomeTradeDownWiringTests();
if (wiringSummary.failed > 0) {
  failures += wiringSummary.failed;
}

if (failures > 0) {
  console.error(`[HomeTradeDownAudit] ${failures} check(s) failed.`);
  process.exit(1);
}

console.info('[HomeTradeDownAudit] the engine matches the independent reference and the engine, view, module and wiring suites pass.');
