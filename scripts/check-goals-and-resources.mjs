// Goals and resources: the engine, proved against an independent reference.
//
// The reference below takes nothing from `js/goals_and_resources_math.js`.
//
//   mortgage   a plain annuity at a fixed number of months, never the mortgage
//              engine's schedule
//   college    each child rebuilt year by year, the amounts found by bisection,
//              as scripts/check-future-cost-fund.mjs does
//   pensions   the engine's own answer is run back through the retirement
//              module: it must close the gap, and a hundredth of a point less
//              must not. Relief is the tax engine's difference, taken directly.
//   states     the yearly money handed out by hand, in the planning order
//
// This is how check-college-funding-audit.mjs and check-future-cost-fund.mjs
// prove their engines.

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { computeGoalsAndResourcesProjection } from '../js/goals_and_resources_math.js';
import {
  GOALS_AND_RESOURCES_EXPECTED,
  GOALS_AND_RESOURCES_SAMPLE,
  runGoalsAndResourcesTests
} from '../js/tests_goals_and_resources_math.js';
import { runGoalsAndResourcesModuleTests } from '../js/tests_goals_and_resources_module.js';
import { runGoalsAndResourcesViewTests } from '../js/tests_goals_and_resources_view.js';
import { PENSION_EARNINGS_CAP, computePensionProjection, normalizePensionInputs } from '../js/pension_math.js';
import { computeTaxYear } from '../js/planning/tax/engine.js';
import { PLANEIR_ASSUMPTIONS } from '../js/planning/planeir_assumptions.js';
import { resolveTaxRules } from '../js/planning/tax/resolve.js';

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.info(`[GoalsAndResourcesAudit] PASS: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`[GoalsAndResourcesAudit] FAIL: ${name}\n    ${error.message}`);
  }
}

const near = (actual, expected, tolerance, label) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected} (± ${tolerance})`);
};

const H = GOALS_AND_RESOURCES_SAMPLE;

// ----------------------------------------------------------------- mortgage ---

const annuity = (balance, annualRate, months) => {
  const i = annualRate / 12;
  return balance * i / (1 - (1 + i) ** -months);
};
const MONTHS_TODAY = Math.round(H.mortgage.remainingTermYears * 12);
const MONTHS_CLEARED = (H.mortgage.clearByAge - H.mortgage.currentAge) * 12;
const todayPayment = annuity(H.mortgage.currentBalance, H.mortgage.annualInterestRate, MONTHS_TODAY);
const clearedPayment = (lump) => annuity(H.mortgage.currentBalance - lump, H.mortgage.annualInterestRate, MONTHS_CLEARED);

// ------------------------------------------------------------------ college ---

const PRICE_RATE = 0.04;
const CASH_NET = 0.002 * (1 - 0.33);

function simulate({ lump, yearly, startsIn, duration, annualCost }) {
  let balance = 0;
  let lowest = Infinity;
  for (let year = 0; year < startsIn + duration; year += 1) {
    if (year > 0) balance *= 1 + CASH_NET;
    if (year === 0) balance += lump;
    if (year < startsIn) balance += yearly;
    if (year >= startsIn) balance -= annualCost * (1 + PRICE_RATE) ** year;
    lowest = Math.min(lowest, balance);
  }
  return lowest;
}

function bisect(fn, low, high) {
  let a = low;
  let b = high;
  for (let i = 0; i < 200; i += 1) {
    const mid = (a + b) / 2;
    if (fn(mid) >= 0) b = mid;
    else a = mid;
  }
  return (a + b) / 2;
}

function collegeReference(shareOfCash, children) {
  const duration = PLANEIR_ASSUMPTIONS.collegeFunding.durationYears;
  const annualCost = 5_000;
  const perChild = children.map((child) => {
    const startsIn = 18 - child.age;
    const required = bisect(
      (lump) => simulate({ lump, yearly: 0, startsIn, duration, annualCost }),
      0,
      annualCost * duration * 4
    );
    return { startsIn, required };
  });
  const totalRequired = perChild.reduce((sum, child) => sum + child.required, 0);
  const share = Math.min(1, shareOfCash / totalRequired);
  const priced = perChild.map((child) => {
    const lump = share * child.required;
    const yearly = share >= 1
      ? 0
      : bisect(
        (amount) => simulate({ lump, yearly: amount, startsIn: child.startsIn, duration, annualCost }),
        0,
        annualCost * duration * 4
      );
    return { ...child, lump, yearly, paidIn: lump + yearly * child.startsIn };
  });
  return {
    totalRequired,
    lump: priced.reduce((sum, child) => sum + child.lump, 0),
    yearly: priced.reduce((sum, child) => sum + child.yearly, 0),
    paidIn: priced.reduce((sum, child) => sum + child.paidIn, 0),
    priced
  };
}

// ----------------------------------------------------------------- pensions ---

const pensionPayload = (target, extra) => ({
  currentYear: 2026,
  incomeMode: 'target',
  targetIncomeToday: target.targetIncomeToday,
  targetIncomeBasis: 'net',
  householdTaxStatus: H.householdTaxStatus,
  pensions: H.pensions.map((person) => ({
    ...person,
    retirementAge: target.retirementAge,
    personalPct: Math.max(0, person.personalPct + extra)
  }))
});

const incomeTaxFor = (extra) => computeTaxYear({
  input: {
    year: 2026,
    status: H.householdTaxStatus,
    people: H.pensions.map((person) => ({ id: person.id, age: person.currentAge })),
    items: H.pensions.flatMap((person) => ([
      { personId: person.id, type: 'employment', amount: person.currentSalary },
      { personId: person.id, type: 'employmentPensionContribution', amount: (person.personalPct + extra) * person.currentSalary }
    ]))
  }
}).result.totals.totalTax;

// ------------------------------------------------------------------- checks ---

const started = performance.now();
const result = computeGoalsAndResourcesProjection(H);
const elapsed = performance.now() - started;
const { debug } = result;

check('the central values the engine reads are the ones the brief settled', () => {
  assert.equal(PLANEIR_ASSUMPTIONS.inflation.educationRate, PRICE_RATE);
  assert.equal(PLANEIR_ASSUMPTIONS.cash.instantAccessGrossRate, 0.002);
  assert.equal(resolveTaxRules(2026).dirt.rate, 0.33);
});

// The time is printed on every run. The target on a laptop is under a second;
// the check fails only above three, so a slower CI machine does not trip it.
console.info(`[GoalsAndResourcesAudit] the engine ran in ${elapsed.toFixed(0)} ms (target under 1,000 ms, fails above 3,000 ms)`);
check('the whole run takes under three seconds', () => {
  assert.ok(elapsed < 3000, `took ${elapsed.toFixed(0)} ms`);
});

check('mortgage: every repayment, lump sum and total matches a plain annuity', () => {
  const i = H.mortgage.annualInterestRate / 12;
  const whole = H.mortgage.currentBalance - todayPayment * (1 - (1 + i) ** -MONTHS_CLEARED) / i;
  near(debug.wholeMortgageLump, whole, 0.01, 'the lump sum that clears it by 60 at today\'s repayment');
  near(debug.mortgageToday.todayMonthlyPayment, todayPayment, 1e-6, 'today\'s repayment');
  debug.cases.forEach((entry) => {
    const payment = clearedPayment(entry.mortgageLump);
    near(entry.mortgage.monthlyPayment, payment, 1e-6, `${entry.id}: repayment`);
    near(entry.mortgage.yearlyChange, 12 * (payment - todayPayment), 0.01, `${entry.id}: yearly change`);
    near(entry.mortgage.totalPaidOverTheLoan, entry.mortgageLump + payment * MONTHS_CLEARED, 0.5, `${entry.id}: paid over the loan`);
  });
});

check('college: every lump sum, yearly amount and total paid in matches a year-by-year rebuild', () => {
  const whole = collegeReference(Infinity, H.children);
  near(debug.wholeCollege.requiredToday, whole.totalRequired, 0.01, 'both children funded today');
  debug.cases.forEach((entry) => {
    const reference = collegeReference(entry.collegeLump, H.children);
    near(entry.college.lumpSumToday, reference.lump, 0.01, `${entry.id}: lump sum`);
    near(entry.college.yearlyAmountNow, reference.yearly, 0.01, `${entry.id}: yearly`);
    near(entry.college.paidIn, reference.paidIn, 0.05, `${entry.id}: paid in`);
    entry.college.perChild.forEach((child, index) => {
      near(child.yearlyAmount, reference.priced[index].yearly, 0.01, `${entry.id}: ${child.title} yearly`);
    });
  });
});

check('pensions: the engine\'s answer closes the gap, a hundredth of a point less does not', () => {
  const base = debug.retirement.base;
  const closed = computePensionProjection(pensionPayload(H.retirement, base.extraPoints)).debug;
  assert.equal(closed.currentGapVsRequired, 0, 'closes at the engine\'s answer');
  const rawGap = closed.requiredPot - closed.projectedPotCurrent;
  assert.ok(rawGap <= closed.requiredPotDepletionTolerance && rawGap > closed.requiredPotDepletionTolerance - 1,
    `the gap sits within a euro of the tolerance (${rawGap})`);
  const short = computePensionProjection(pensionPayload(H.retirement, base.extraPoints - 0.0001)).debug;
  assert.ok(short.currentGapVsRequired > 0, 'a hundredth of a point less does not close it');
});

check('pensions: the extra is gross, and its relief is the tax engine\'s difference', () => {
  const base = debug.retirement.base;
  const salary = H.pensions.reduce((sum, person) => sum + person.currentSalary, 0);
  near(base.yearlyExtra, base.extraPoints * salary, 0.01, 'gross extra');
  const relief = incomeTaxFor(0) - incomeTaxFor(base.extraPoints);
  near(base.yearlyExtraTaxRelief, relief, 0.01, 'relief on the extra');
  near(base.yearlyExtraCost, base.extraPoints * salary - relief, 0.01, 'cost after relief');
});

// The Revenue age bands, written out here so the ceiling is not taken from the
// engine: the limit on a personal contribution that gets relief, by age.
const reliefBand = (age) => {
  if (age <= 29) return 0.15;
  if (age <= 39) return 0.20;
  if (age <= 49) return 0.25;
  if (age <= 54) return 0.30;
  if (age <= 59) return 0.35;
  return 0.40;
};

check('pensions: the search ceiling is the room across the whole schedule, and at it nothing more helps', () => {
  const target = { retirementAge: 62, targetIncomeToday: 200_000 };
  const stretched = computeGoalsAndResourcesProjection({ ...H, retirement: target });
  const base = stretched.debug.retirement.base;
  assert.equal(base.reachedCap, true);
  // A person pays in until the year before they retire. In each year the age
  // band's share of their salary up to the €115,000 earnings cap is relieved,
  // which as a share of that year's salary is the band's rate under the cap and
  // less above it, and the salary grows. Their room is the best year's share
  // less what they pay in; the household's is the larger of its people's.
  const wageGrowth = normalizePensionInputs(pensionPayload(target, 0)).wageGrowthRate;
  const roomOf = (person) => {
    let room = 0;
    for (let year = 0; year < target.retirementAge - person.currentAge; year += 1) {
      const salary = person.currentSalary * (1 + wageGrowth) ** year;
      const share = reliefBand(person.currentAge + year) * Math.min(salary, PENSION_EARNINGS_CAP) / salary;
      room = Math.max(room, share - person.personalPct);
    }
    return room;
  };
  const ceiling = Math.max(...H.pensions.map(roomOf));
  near(base.extraPoints, ceiling, 1e-9, 'the ceiling is the best year\'s relievable share of salary less the lower contribution');
  near(base.capPointsAvailable, ceiling, 1e-9, 'and it is reported');
  assert.ok(base.gapLeftOver > 0, 'a gap is left');

  const gapAt = (extra) => {
    const debug = computePensionProjection(pensionPayload(target, extra)).debug;
    return debug.requiredPot - debug.projectedPotCurrent;
  };
  near(base.gapLeftOver, gapAt(ceiling), 1, 'the gap left over is the engine\'s');
  near(gapAt(ceiling + 0.05), gapAt(ceiling), 1e-6, 'more than the ceiling changes nothing: everyone is at the limit every year');
  assert.ok(gapAt(ceiling - 0.01) > gapAt(ceiling) + 1, 'a little under it there is still something to gain');

  stretched.debug.cases.forEach((entry) => {
    const retirement = entry.states.find((goal) => goal.goal === 'retirement');
    assert.notEqual(retirement.state, 'covered', `${entry.id}: retirement is not covered`);
  });
});

check('the ledger runs to the last active goal, with nothing for the mortgage once it is cleared', () => {
  const years = (age, person) => age - person.currentAge;
  const horizon = Math.max(
    MONTHS_CLEARED / 12,
    ...H.children.map((child) => 18 - child.age),
    ...H.pensions.map((person) => years(H.retirement.retirementAge, person)),
    ...H.pensions.map((person) => years(H.laterRetirement.retirementAge, person))
  );
  debug.cases.forEach((entry) => {
    assert.equal(entry.ledger.length, horizon, `${entry.id}: the ledger has a row for every year to the last goal`);
    assert.equal(entry.laterRetirement.ledger.length, horizon, `${entry.id}: and so does the later option's`);
    entry.ledger.forEach((row) => {
      if (row.year >= MONTHS_CLEARED / 12) assert.equal(row.mortgage, 0, `${entry.id} year ${row.year}: no mortgage once cleared`);
    });
  });
});

check('states: the yearly money handed out by hand, year by year, in the planning order', () => {
  debug.cases.forEach((entry) => {
    const mortgageYearly = 12 * (clearedPayment(entry.mortgageLump) - todayPayment);
    const reference = collegeReference(entry.collegeLump, H.children);
    const freed = Math.max(0, -mortgageYearly);
    // Each goal's need in each year: the children by their own start, the
    // mortgage until it is cleared, retirement from the engine's per-year cost
    // (its first year is proved against the tax engine above).
    const needs = [
      (year) => (year < reference.priced[0].startsIn ? reference.priced[0].yearly : 0),
      (year) => (year < reference.priced[1].startsIn ? reference.priced[1].yearly : 0),
      (year) => (year < MONTHS_CLEARED / 12 ? Math.max(0, mortgageYearly) : 0),
      (year) => entry.pension.extraCostByYear[year] || 0
    ];
    const got = needs.map(() => []);
    for (let year = 0; year < entry.ledger.length; year += 1) {
      let remaining = H.leftOverEachYear + (year < MONTHS_CLEARED / 12 ? freed : 0);
      needs.forEach((need, index) => {
        const amount = Math.max(0, Math.min(need(year), remaining));
        remaining -= amount;
        got[index].push(amount);
      });
    }
    const expected = needs.map((need, index) => {
      const active = got[index]
        .map((amount, year) => ({ year, amount, need: need(year) }))
        .filter((row) => row.need > 0.5);
      const short = active.filter((row) => row.amount < row.need - 0.5);
      let state = 'covered';
      if (short.length > 0) state = active.every((row) => row.amount <= 0) ? 'not' : 'partly';
      if (index === 3 && entry.pension.reachedCap && entry.pension.gapLeftOver > 0 && state === 'covered') state = 'partly';
      const goal = entry.states[index];
      assert.equal(goal.firstShortYear, short[0]?.year ?? null, `${entry.id} ${goal.goal}: first short year`);
      assert.equal(goal.firstMoneyYear, active.find((row) => row.amount > 0)?.year ?? null, `${entry.id} ${goal.goal}: first funded year`);
      const lastShortYear = short.at(-1)?.year;
      const unreachable = index === 3 && entry.pension.reachedCap && entry.pension.gapLeftOver > 0;
      const recovery = lastShortYear === undefined || unreachable ? null : active.find((row) => row.year > lastShortYear)?.year ?? null;
      assert.equal(goal.coveredFromYear, recovery, `${entry.id} ${goal.goal}: covered for every remaining active year`);
      return state;
    });
    assert.deepEqual(entry.states.map((goal) => goal.state), expected, `${entry.id}: states`);
  });
});

check('the brief\'s tables are reproduced to the euro', () => {
  GOALS_AND_RESOURCES_EXPECTED.cases.forEach((want, index) => {
    const entry = debug.cases[index];
    assert.equal(entry.id, want.id);
    assert.equal(Math.round(entry.neededThisYear), want.needed, `${want.id}: needed this year`);
    assert.equal(Math.round(entry.paidOutOverLife.total), want.life, `${want.id}: paid out over the life`);
    assert.equal(Math.round(entry.laterRetirement.neededThisYear), want.laterNeeded, `${want.id}: later needed`);
    assert.equal(Math.round(entry.laterRetirement.paidOutOverLife.total), want.laterLife, `${want.id}: later paid out`);
  });
});

// The unit suites, run here so one command proves the engine and the screen.
const summary = runGoalsAndResourcesTests();
if (summary.failed > 0) {
  failures += summary.failed;
}

// The screen's own decisions: words, geometry, label placement, no names.
const viewSummary = runGoalsAndResourcesViewTests();
if (viewSummary.failed > 0) {
  failures += viewSummary.failed;
}

// The module itself, driven against a small DOM shim and a fake clock.
const moduleSummary = await runGoalsAndResourcesModuleTests();
if (moduleSummary.failed > 0) {
  failures += moduleSummary.failed;
}

if (failures > 0) {
  console.error(`[GoalsAndResourcesAudit] ${failures} check(s) failed.`);
  process.exit(1);
}

console.info('[GoalsAndResourcesAudit] the engine matches the independent reference and the engine, view and module suites pass.');
