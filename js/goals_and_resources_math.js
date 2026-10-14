/**
 * Goals and resources: can the money do everything you want, and what has to
 * give?
 *
 * A household has several goals pulling on the same limited money. This engine
 * takes the household's cash and what it has left over each year, prices every
 * way of using the cash against a mortgage, college for each child and
 * retirement, and returns four cases to put side by side.
 *
 * It has no maths of its own. It composes engines that exist:
 *
 *   mortgage  js/mortgage_math.js         a lump sum at month 0, lowerPayment,
 *                                         term set to clear by the goal's age
 *   college   js/future_cost_fund_math.js each child is its own dated cost
 *   pensions  js/pension_math.js          the personal contribution is searched
 *                                         until the retirement gap closes
 *   tax       js/pension_math.js          `computePersonalContributionCosts`:
 *                                         what a contribution costs after
 *                                         income tax relief, year by year
 *
 * THE TWO MEASURES. Every case carries "needed this year" and "paid out over
 * the life of the goals", side by side. Neither orders the cases, and they
 * disagree: the use of cash that helps most this year is not the one that
 * costs least over the life of the goals.
 *
 * THE FOUR CASES. Case 1 keeps the cash as it is, every goal pursued from
 * yearly money. The other three are the most different uses of cash: the three
 * that, with case 1, are furthest apart in euros moved into the mortgage and
 * into college. They are shown in order of how much they change from case 1.
 * No score picks them or orders them.
 *
 * THE LATER RETIREMENT OPTION is priced beside every case and never attached
 * to one, so each case differs by one thing: the use of cash.
 *
 * PENSION MONEY IS GROSS FOR GROWTH AND AFTER RELIEF FOR CASH FLOW. The search
 * is in gross terms because the pot grows on everything paid in. Wherever a
 * contribution is counted against the household's money it counts at its cost
 * after income tax relief. Employer contributions are not the household's money.
 *
 * GOAL ORDER is the planning method's and is fixed here, never taken from a
 * payload: each child's college by start date, then the mortgage, then
 * retirement. Protection and the emergency reserve come first and sit outside
 * this module: `spareCash` is already net of the reserve.
 *
 * NO RATES. No growth, inflation, cash or DIRT rate is accepted. They are
 * central, and each engine reads them from where they live.
 */

import { computeAmortizationMonthlySchedule, normalizeMortgageInputs } from './mortgage_math.js';
import {
  computePensionProjection,
  computePersonalContributionCosts,
  maxRelievableContributionRatePercent,
  normalizePensionInputs
} from './pension_math.js';
import { computeFutureCostFundProjection } from './future_cost_fund_math.js';
import { PLANEIR_ASSUMPTIONS } from './planning/planeir_assumptions.js';
import { IE_TAX_RULES_VERSION } from './planning/tax/rules_ie.js';

const FIELD = 'generated.goalsAndResourcesInputs';
const MAX_CHILDREN = 4;
const MAX_PEOPLE = 2;
/** Two cash uses count as the same when both lump sums are within this. */
const SAME_USE_WITHIN_EUR = 1_000;
/** A search stops once the gap sits inside (−1, 0] euros of the engine's own threshold. */
const SEARCH_AIM_EUR = 0.5;
const SEARCH_MAX_STEPS = 14;

const REFUSED_RATE_FIELDS = Object.freeze([
  'priceGrowthRate',
  'savingsGrowthRate',
  'inflationRate',
  'dirtRate',
  'growthRate',
  'wageGrowthRate',
  'educationRate'
]);

const GOAL_ORDER_TEXT = 'Your goals are taken in this order: the costs that come soonest, then your mortgage, then retirement.';
const PENSION_TEXT = 'Pension contributions count at what they cost you after income tax relief. Your pension grows on the full amount paid in.';

const USE_LABELS = Object.freeze({
  'none/none': { id: 'cash-stays', title: 'Cash stays as it is' },
  'none/part': { id: 'college-part', title: 'Part of college from cash' },
  'none/whole': { id: 'college-today', title: 'Fund college today' },
  'part/none': { id: 'mortgage-part', title: 'Part of the mortgage from cash' },
  'whole/none': { id: 'mortgage-cleared', title: 'Mortgage from cash' },
  'over/none': { id: 'mortgage-all-cash', title: 'All cash into the mortgage' },
  'whole/part': { id: 'mortgage-then-college', title: 'Mortgage, then college' },
  'over/part': { id: 'mortgage-over-then-college', title: 'Mortgage, then college' },
  'whole/whole': { id: 'mortgage-and-college', title: 'Mortgage and college from cash' },
  'over/whole': { id: 'mortgage-over-and-college', title: 'Mortgage and college from cash' },
  'part/whole': { id: 'college-then-mortgage', title: 'College, then mortgage' },
  'part/part': { id: 'cash-split', title: 'Cash split across both' }
});

const STATE_WORDS = Object.freeze({ covered: 'Covered', partly: 'Partly covered', not: 'Not covered' });

// -------------------------------------------------------------- formatting ---

const eur = (amount) => `${amount < 0 ? '−' : ''}€${Math.abs(Math.round(amount)).toLocaleString('en-IE')}`;
const sumOf = (values) => values.reduce((sum, value) => sum + value, 0);

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function has(raw, key) {
  return Object.prototype.hasOwnProperty.call(raw, key) && typeof raw[key] !== 'undefined';
}

// ------------------------------------------------------------ normalisation ---

function requireNumber(value, path, { min = 0, greaterThan = null, max = null, text = null } = {}) {
  const ok = isFiniteNumber(value)
    && (greaterThan === null ? value >= min : value > greaterThan)
    && (max === null || value <= max);
  if (!ok) {
    throw new Error(`${FIELD}.${path} must be ${text || (greaterThan === null ? `a number, ${min} or more` : `greater than ${greaterThan}`)}.`);
  }
  return value;
}

function requireWholeYears(value, path, { min, max = Infinity, text }) {
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${FIELD}.${path} must be ${text}.`);
  }
  return value;
}

function requireText(value, path) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new Error(`${FIELD}.${path} must be a non-empty string.`);
  }
  return text;
}

function rewrap(error, from, to) {
  return new Error(String(error.message).replace(from, to));
}

function normalizeTarget(raw, path, maxCurrentAge) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${FIELD}.${path} must be an object.`);
  }
  const retirementAge = requireWholeYears(raw.retirementAge, `${path}.retirementAge`, {
    min: maxCurrentAge + 1,
    max: 100,
    text: `a whole age later than ${maxCurrentAge}`
  });
  const targetIncomeToday = requireNumber(raw.targetIncomeToday, `${path}.targetIncomeToday`, { greaterThan: 0 });
  return { retirementAge, targetIncomeToday };
}

/**
 * Validate a payload and return it in canonical form. Idempotent.
 */
export function normalizeGoalsAndResourcesInputs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${FIELD} must be an object.`);
  }

  if (has(raw, 'goalPriorities')) {
    throw new Error(`${FIELD}.goalPriorities is not accepted. Goals are taken in a fixed order: college, then the mortgage, then retirement.`);
  }
  if (has(raw, 'scenarios')) {
    throw new Error(`${FIELD}.scenarios is not accepted. Cases are derived from the household, not authored.`);
  }
  REFUSED_RATE_FIELDS.forEach((key) => {
    if (has(raw, key)) {
      throw new Error(`${FIELD}.${key} is not accepted. Rates are set centrally in the Planéir assumptions.`);
    }
  });

  const spareCash = requireNumber(raw.spareCash, 'spareCash');
  const leftOverEachYear = requireNumber(raw.leftOverEachYear, 'leftOverEachYear');

  // ---- mortgage
  const m = raw.mortgage;
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    throw new Error(`${FIELD}.mortgage must be an object.`);
  }
  const mortgage = {
    currentBalance: requireNumber(m.currentBalance, 'mortgage.currentBalance', { greaterThan: 0 }),
    annualInterestRate: requireNumber(m.annualInterestRate, 'mortgage.annualInterestRate', {
      min: 0, max: 1, text: 'a rate from 0 to 1 (4% is 0.04)'
    }),
    startDateIso: requireText(m.startDateIso, 'mortgage.startDateIso'),
    remainingTermYears: requireNumber(m.remainingTermYears, 'mortgage.remainingTermYears', { greaterThan: 0 }),
    currentAge: requireWholeYears(m.currentAge, 'mortgage.currentAge', { min: 18, max: 100, text: 'a whole age from 18 to 100' }),
    clearByAge: null,
    fixedPaymentAmount: null
  };
  if (has(m, 'fixedPaymentAmount') && m.fixedPaymentAmount !== null) {
    mortgage.fixedPaymentAmount = requireNumber(m.fixedPaymentAmount, 'mortgage.fixedPaymentAmount', { greaterThan: 0 });
  }
  mortgage.clearByAge = requireWholeYears(m.clearByAge, 'mortgage.clearByAge', {
    min: mortgage.currentAge + 1,
    max: 100,
    text: `a whole age later than ${mortgage.currentAge}`
  });
  try {
    normalizeMortgageInputs(mortgageEnginePayload(mortgage));
  } catch (error) {
    throw rewrap(error, 'generated.mortgageInputs.', `${FIELD}.mortgage.`);
  }

  // ---- pensions
  if (!Array.isArray(raw.pensions) || raw.pensions.length < 1 || raw.pensions.length > MAX_PEOPLE) {
    throw new Error(`${FIELD}.pensions must be an array of one or two people.`);
  }
  const usedPeople = new Set();
  const pensions = raw.pensions.map((person, index) => {
    const path = `pensions[${index}]`;
    if (!person || typeof person !== 'object' || Array.isArray(person)) {
      throw new Error(`${FIELD}.${path} must be an object.`);
    }
    REFUSED_RATE_FIELDS.forEach((key) => {
      if (has(person, key)) {
        throw new Error(`${FIELD}.${path}.${key} is not accepted. Rates are set centrally in the Planéir assumptions.`);
      }
    });
    const id = requireText(person.id, `${path}.id`);
    if (usedPeople.has(id)) {
      throw new Error(`${FIELD}.${path}.id must be unique.`);
    }
    usedPeople.add(id);
    return {
      id,
      title: requireText(person.title, `${path}.title`),
      currentAge: requireWholeYears(person.currentAge, `${path}.currentAge`, { min: 18, max: 100, text: 'a whole age from 18 to 100' }),
      currentSalary: requireNumber(person.currentSalary, `${path}.currentSalary`),
      currentPot: requireNumber(person.currentPot, `${path}.currentPot`),
      personalPct: requireNumber(person.personalPct, `${path}.personalPct`, { min: 0, max: 1, text: 'a share of salary from 0 to 1 (5% is 0.05)' }),
      employerPct: requireNumber(person.employerPct, `${path}.employerPct`, { min: 0, max: 1, text: 'a share of salary from 0 to 1 (5% is 0.05)' }),
      includeStatePension: has(person, 'includeStatePension') ? person.includeStatePension === true : true
    };
  });
  const maxCurrentAge = Math.max(...pensions.map((person) => person.currentAge));
  const householdTaxStatus = has(raw, 'householdTaxStatus') ? requireText(raw.householdTaxStatus, 'householdTaxStatus') : null;

  // ---- retirement
  const retirement = normalizeTarget(raw.retirement, 'retirement', maxCurrentAge);
  const laterRetirement = has(raw, 'laterRetirement') && raw.laterRetirement !== null
    ? normalizeTarget(raw.laterRetirement, 'laterRetirement', maxCurrentAge)
    : null;

  try {
    normalizePensionInputs(pensionEnginePayload({ pensions, householdTaxStatus }, retirement, 0, 2026));
  } catch (error) {
    throw rewrap(error, 'generated.pensionInputs.', `${FIELD}.`);
  }

  // ---- children
  if (!Array.isArray(raw.children) || raw.children.length < 1 || raw.children.length > MAX_CHILDREN) {
    throw new Error(`${FIELD}.children must be an array of 1 to ${MAX_CHILDREN} children.`);
  }
  const collegeStartAge = PLANEIR_ASSUMPTIONS.collegeFunding.startAge;
  const usedChildren = new Set();
  const children = raw.children.map((child, index) => {
    const path = `children[${index}]`;
    if (!child || typeof child !== 'object' || Array.isArray(child)) {
      throw new Error(`${FIELD}.${path} must be an object.`);
    }
    const id = requireText(child.id, `${path}.id`);
    if (usedChildren.has(id)) {
      throw new Error(`${FIELD}.${path}.id must be unique.`);
    }
    usedChildren.add(id);
    return {
      id,
      title: requireText(child.title, `${path}.title`),
      age: requireWholeYears(child.age, `${path}.age`, {
        min: 0,
        max: collegeStartAge - 1,
        text: `a whole age from 0 to ${collegeStartAge - 1}, below the college start age of ${collegeStartAge}`
      })
    };
  });

  return {
    spareCash,
    leftOverEachYear,
    mortgage,
    pensions,
    householdTaxStatus,
    retirement,
    laterRetirement,
    children
  };
}

// ------------------------------------------------------------------ engines ---

/**
 * The mortgage already ends by the goal's age, so there is nothing to clear and
 * nothing to pay: no lump sum, no yearly change, and the goal reads covered.
 * Every use of cash that would have gone into the mortgage collapses into the
 * others, so fewer than four cases is expected.
 */
function mortgageAlreadyEnds(mortgage) {
  return mortgage.clearByAge - mortgage.currentAge >= mortgage.remainingTermYears;
}

/**
 * The fields of `computePensionProjection(...).debug` the search reads. The
 * retirement module's own readiness reads the same ones. If it ever stops
 * returning one as a number this engine stops with a clear message instead of
 * searching on `undefined`.
 */
export const PENSION_DEBUG_FIELDS_READ = Object.freeze(['requiredPot', 'projectedPotCurrent', 'requiredPotDepletionTolerance']);

function assertPensionDebugContract(debug) {
  PENSION_DEBUG_FIELDS_READ.forEach((key) => {
    if (!isFiniteNumber(debug && debug[key])) {
      throw new Error(
        `computePensionProjection no longer returns debug.${key} as a number (got ${typeof (debug && debug[key])}). `
        + 'The goals and resources search reads it. Update js/goals_and_resources_math.js to match the retirement module.'
      );
    }
  });
}

function calculationYearFor(inputs, options) {
  if (Number.isInteger(options.calculationYear)) {
    return options.calculationYear;
  }
  return Number(inputs.mortgage.startDateIso.slice(0, 4));
}

function mortgageEnginePayload(mortgage, lumpSum = 0) {
  const targetTermYears = mortgage.clearByAge - mortgage.currentAge;
  return {
    loanKind: 'mortgage',
    currentBalance: mortgage.currentBalance,
    annualInterestRate: mortgage.annualInterestRate,
    startDateIso: mortgage.startDateIso,
    remainingTermYears: mortgage.remainingTermYears,
    repaymentType: 'repayment',
    fixedPaymentAmount: mortgage.fixedPaymentAmount,
    baseScenarioId: 'today',
    scenarios: [
      { id: 'today', title: 'As it is today' },
      {
        id: 'clear-by-age',
        title: `Cleared by ${mortgage.clearByAge}`,
        oneOffOverpayment: lumpSum,
        oneOffOverpaymentMonth: 0,
        overpaymentBenefit: 'lowerPayment',
        remainingTermYears: targetTermYears
      }
    ]
  };
}

function pensionEnginePayload(inputs, target, extraPoints, year) {
  return {
    currentYear: year,
    incomeMode: 'target',
    targetIncomeToday: target.targetIncomeToday,
    targetIncomeBasis: 'net',
    ...(inputs.householdTaxStatus ? { householdTaxStatus: inputs.householdTaxStatus } : {}),
    pensions: inputs.pensions.map((person) => ({
      id: person.id,
      title: person.title,
      currentAge: person.currentAge,
      retirementAge: target.retirementAge,
      currentSalary: person.currentSalary,
      currentPot: person.currentPot,
      personalPct: Math.max(0, person.personalPct + extraPoints),
      employerPct: person.employerPct,
      includeStatePension: person.includeStatePension
    }))
  };
}

// ---- mortgage

function priceMortgage(inputs, lumpSum, todaySchedule = null) {
  if (mortgageAlreadyEnds(inputs.mortgage)) {
    const ends = todaySchedule
      || computeAmortizationMonthlySchedule(mortgageEnginePayload(inputs.mortgage, 0), { scenarioId: 'today' });
    return {
      lumpSum: 0,
      alreadyEnds: true,
      todayMonthlyPayment: ends.contractualPayment,
      monthlyPayment: ends.contractualPayment,
      yearlyChange: 0,
      payoffDateIso: ends.payoffDateIso,
      todayPayoffDateIso: ends.payoffDateIso,
      termYears: inputs.mortgage.remainingTermYears,
      balanceAfterLumpSum: inputs.mortgage.currentBalance,
      totalPaidOverTheLoan: ends.totalPaidLifetime,
      interestOverTheLoan: ends.totalInterestLifetime
    };
  }
  const raw = mortgageEnginePayload(inputs.mortgage, lumpSum);
  const today = todaySchedule || computeAmortizationMonthlySchedule(raw, { scenarioId: 'today' });
  const cleared = computeAmortizationMonthlySchedule(raw, { scenarioId: 'clear-by-age' });
  return {
    lumpSum,
    todayMonthlyPayment: today.contractualPayment,
    monthlyPayment: cleared.monthlyPaymentUsed,
    // The engine's repayment minus today's repayment, a year of it. It can be
    // negative: a lump sum big enough lowers the repayment below today's.
    yearlyChange: 12 * (cleared.monthlyPaymentUsed - today.contractualPayment),
    payoffDateIso: cleared.payoffDateIso,
    todayPayoffDateIso: today.payoffDateIso,
    termYears: inputs.mortgage.clearByAge - inputs.mortgage.currentAge,
    balanceAfterLumpSum: cleared.openingBalance,
    // Over the whole loan, the lump sum included: what leaves the household.
    totalPaidOverTheLoan: cleared.totalPaidLifetime + cleared.lumpSumApplied,
    interestOverTheLoan: cleared.totalInterestLifetime
  };
}

/**
 * The lump sum that clears the mortgage by the goal's age WITHOUT raising
 * today's repayment. With the benefit taken as a lower payment the repayment
 * falls in a straight line with the lump sum, so a secant step finds it in two
 * or three runs; a bracket bisection is kept for anything that is not straight.
 */
function solveWholeMortgageLump(inputs) {
  if (mortgageAlreadyEnds(inputs.mortgage)) {
    return 0;
  }
  const today = computeAmortizationMonthlySchedule(mortgageEnginePayload(inputs.mortgage, 0), { scenarioId: 'today' });
  const target = today.contractualPayment;
  const gap = (lump) => priceMortgage(inputs, lump, today).monthlyPayment - target;

  const noLump = gap(0);
  if (noLump <= 0) {
    return 0;
  }
  let lowX = 0;
  let highX = inputs.mortgage.currentBalance;
  let lowGap = noLump;
  let highGap = gap(highX);
  if (highGap > 0) {
    return highX;
  }
  for (let step = 0; step < 40; step += 1) {
    // The straight-line estimate first; if it falls outside the bracket, halve.
    let x = lowX + (0 - lowGap) * (highX - lowX) / (highGap - lowGap);
    if (!(x > lowX && x < highX)) {
      x = (lowX + highX) / 2;
    }
    const g = gap(x);
    // The repayment equals today's to a billionth of a euro a month: that is
    // the lump sum, from whichever side the line landed on.
    if (Math.abs(g) < 1e-9) {
      return x;
    }
    if (g > 0) {
      lowX = x;
      lowGap = g;
    } else {
      highX = x;
      highGap = g;
    }
  }
  return highX;
}

// ---- college

function collegeCost() {
  const college = PLANEIR_ASSUMPTIONS.collegeFunding;
  const scenario = college.scenarios.find((entry) => entry.id === 'living_at_home');
  return {
    startAge: college.startAge,
    durationYears: college.durationYears,
    annualCostToday: scenario.annualCostTodayPerChild
  };
}

/** What funding a share of the college cost today asks, each child as its own dated cost. */
function priceCollege(inputs, lumpShare, fundOptions) {
  const cost = collegeCost();
  const perChild = inputs.children.map((child) => {
    const projection = computeFutureCostFundProjection({
      costTitle: `College, ${child.title.toLowerCase()}`,
      costKind: 'education',
      startsInYears: cost.startAge - child.age,
      durationYears: cost.durationYears,
      annualCostToday: cost.annualCostToday,
      scenarios: [{ id: 'share', lumpShare }]
    }, fundOptions);
    const entry = projection.debug.cases[0];
    return {
      id: child.id,
      title: child.title,
      startsInYears: cost.startAge - child.age,
      requiredToday: projection.debug.requiredToday,
      totalCost: projection.debug.totalCost,
      lumpSumToday: entry.lumpSumToday,
      yearlyAmount: entry.yearlyAmount,
      savingYears: entry.savingYears,
      paidIn: entry.paidIn
    };
  });
  return {
    lumpShare,
    lumpSumToday: sumOf(perChild.map((child) => child.lumpSumToday)),
    yearlyAmountNow: sumOf(perChild.map((child) => child.yearlyAmount)),
    requiredToday: sumOf(perChild.map((child) => child.requiredToday)),
    paidIn: sumOf(perChild.map((child) => child.paidIn)),
    perChild
  };
}

// ---- retirement

function pensionRun(inputs, target, extraPoints, year) {
  const { debug } = computePensionProjection(pensionEnginePayload(inputs, target, extraPoints, year));
  assertPensionDebugContract(debug);
  const rawGap = debug.requiredPot - debug.projectedPotCurrent;
  return {
    x: extraPoints,
    // The engine's own difference, unclamped: required less projected. The gap
    // closes when it is no more than the engine's tolerance, which is exactly
    // when the module reads "on track".
    rawGap,
    closed: rawGap <= debug.requiredPotDepletionTolerance,
    tolerance: debug.requiredPotDepletionTolerance,
    requiredPot: debug.requiredPot,
    projectedPot: debug.projectedPotCurrent
  };
}

/**
 * Solve for the contribution (points of salary added for everyone) at which the
 * engine's own gap sits just inside its tolerance, from points already run.
 *
 * The projected pot is a straight line in the contribution (the same slope to
 * the euro at every point below the relief cap) and the required pot barely
 * curves, so the gap is nearly straight and a secant step lands within a euro
 * in two or three runs. The gap only falls as the contribution rises, so a
 * bracket is kept between the largest point that does not close and the
 * smallest that does, and a step that falls outside it is halved instead. The
 * answer is always a point the engine itself says closes.
 */
function solveContribution(runAt, points, minX, maxX) {
  const f = (run) => run.rawGap - run.tolerance;
  const evaluated = [...points];

  for (let step = 0; step < SEARCH_MAX_STEPS; step += 1) {
    const closed = evaluated.filter((run) => f(run) <= 0);
    const open = evaluated.filter((run) => f(run) > 0);
    const hi = closed.length ? closed.reduce((best, run) => (run.x < best.x ? run : best)) : null;
    const lo = open.length ? open.reduce((best, run) => (run.x > best.x ? run : best)) : null;
    if (hi && f(hi) > -1) {
      return hi;
    }

    const pair = hi && lo ? [lo, hi] : evaluated.slice(-2);
    const slope = (f(pair[1]) - f(pair[0])) / (pair[1].x - pair[0].x);
    let x = Number.isFinite(slope) && slope !== 0 ? pair[1].x - (f(pair[1]) + SEARCH_AIM_EUR) / slope : NaN;
    const low = lo ? lo.x : minX;
    const high = hi ? hi.x : maxX;
    if (!(x > low && x < high)) {
      x = (low + high) / 2;
    }
    evaluated.push(runAt(x));
  }

  const closedNow = evaluated.filter((run) => f(run) <= 0);
  return closedNow.length
    ? closedNow.reduce((best, run) => (run.x < best.x ? run : best))
    : evaluated[evaluated.length - 1];
}

function priceRetirement(inputs, target, year, { includeHeadroom }) {
  const runAt = (x) => pensionRun(inputs, target, x, year);
  const f = (run) => run.rawGap - run.tolerance;
  const atToday = runAt(0);
  const costsToday = computePersonalContributionCosts(pensionEnginePayload(inputs, target, 0, year));
  const capPoints = Math.min(...inputs.pensions.map(
    (person) => maxRelievableContributionRatePercent(person.currentAge) / 100 - person.personalPct
  ));

  let extraPoints = 0;
  let result = atToday;
  let reachedCap = false;

  if (!atToday.closed) {
    if (capPoints <= 0) {
      reachedCap = true;
    } else {
      // Two points make a straight line: today, and a probe inside the cap.
      const probe = runAt(Math.min(capPoints, 0.05));
      const points = [atToday, probe];
      if (!probe.closed) {
        if (probe.x >= capPoints) {
          reachedCap = true;
          result = probe;
          extraPoints = probe.x;
        } else {
          const slope = (f(probe) - f(atToday)) / (probe.x - atToday.x);
          const guess = probe.x - (f(probe) + SEARCH_AIM_EUR) / slope;
          if (!(guess < capPoints)) {
            // The line closes beyond the cap, or does not close: run the cap itself.
            const atCap = runAt(capPoints);
            points.push(atCap);
            if (!atCap.closed) {
              reachedCap = true;
              result = atCap;
              extraPoints = capPoints;
            }
          } else {
            points.push(runAt(guess));
          }
        }
      }
      if (!reachedCap) {
        result = solveContribution(runAt, points, 0, capPoints);
        extraPoints = result.x;
      }
    }
  }

  const costsWithExtra = extraPoints === 0
    ? costsToday
    : computePersonalContributionCosts(pensionEnginePayload(inputs, target, extraPoints, year));
  const costOf = (costs, index) => (costs.years[index] ? costs.years[index].cost : 0);
  const salaryTotal = sumOf(inputs.pensions.map((person) => person.currentSalary));
  const yearlyExtra = costsWithExtra.years[0].gross - costsToday.years[0].gross;
  const yearlyExtraTaxRelief = costsWithExtra.years[0].relief - costsToday.years[0].relief;

  let headroomYearly = 0;
  if (includeHeadroom && atToday.closed) {
    // How far the current contributions sit above what the target needs. Not
    // counted as money to find: reported so the surplus is visible, never spent.
    const floor = -Math.min(...inputs.pensions.map((person) => person.personalPct));
    if (floor < 0) {
      const atFloor = runAt(floor);
      if (atFloor.closed) {
        headroomYearly = -floor * salaryTotal;
      } else {
        const solved = solveContribution(runAt, [atFloor, atToday], floor, 0);
        headroomYearly = -solved.x * salaryTotal;
      }
    }
  }

  return {
    id: target.id,
    retirementAge: target.retirementAge,
    targetIncomeToday: target.targetIncomeToday,
    requiredPotAtToday: atToday.requiredPot,
    projectedPotAtToday: atToday.projectedPot,
    onTrackAtToday: atToday.closed,
    extraPoints,
    // Gross: what goes into the pension, and what its pot grows on.
    yearlyExtra,
    yearlyExtraTaxRelief,
    // After relief: what the household pays, and what is counted against its money.
    yearlyExtraCost: yearlyExtra - yearlyExtraTaxRelief,
    extraCostByYear: costsWithExtra.years.map((entry, index) => entry.cost - costOf(costsToday, index)),
    reachedCap,
    gapLeftOver: reachedCap ? Math.max(0, result.rawGap) : 0,
    // The household's own contributions over the years to retirement: gross as
    // the pension engine simulated them, and at their cost after relief.
    personalGrossToday: costsToday.totals.gross,
    personalGrossWithExtra: costsWithExtra.totals.gross,
    personalCostToday: costsToday.totals.cost,
    personalCostWithExtra: costsWithExtra.totals.cost,
    extraOverTheLife: costsWithExtra.totals.cost - costsToday.totals.cost,
    headroomYearly,
    capPointsAvailable: capPoints
  };
}

// --------------------------------------------------------------- allocation ---

function classifyUse(amount, whole) {
  if (amount <= 0.5) return 'none';
  if (amount < whole - 1) return 'part';
  if (amount <= whole + 1) return 'whole';
  return 'over';
}

function enumerateUses(inputs, wholeMortgage, wholeCollege) {
  const cash = inputs.spareCash;
  const candidates = [];
  const add = (mortgageLump, collegeLump) => {
    if (mortgageLump >= 0 && collegeLump >= 0 && mortgageLump + collegeLump <= cash + 0.005) {
      candidates.push({ mortgageLump, collegeLump });
    }
  };
  // A mortgage that already ends by the goal's age takes no cash.
  const balance = mortgageAlreadyEnds(inputs.mortgage) ? 0 : inputs.mortgage.currentBalance;

  // Each of the mortgage and the college fund: none, the cash that is left, or
  // the whole amount. "The cash that is left" is what the other goal has not
  // taken. The mortgage may take more than the whole amount (the repayment
  // falls below today's); college cannot.
  add(0, 0);
  add(0, Math.min(wholeCollege, cash));
  add(Math.min(wholeMortgage, cash), 0);
  add(Math.min(wholeMortgage, cash), Math.min(cash - Math.min(wholeMortgage, cash), wholeCollege));
  add(Math.min(cash - Math.min(wholeCollege, cash), balance), Math.min(wholeCollege, cash));
  add(Math.min(cash, balance), 0);

  const unique = [];
  candidates.forEach((candidate) => {
    const twin = unique.some((entry) => (
      Math.abs(entry.mortgageLump - candidate.mortgageLump) <= SAME_USE_WITHIN_EUR
      && Math.abs(entry.collegeLump - candidate.collegeLump) <= SAME_USE_WITHIN_EUR
    ));
    if (!twin) {
      unique.push(candidate);
    }
  });
  return unique;
}

/**
 * The most different uses of cash: the `count` that, with the cash kept as it
 * is, are furthest apart (the largest smallest gap between any two, in euros
 * moved into the mortgage and into college). Distance, not outcome.
 */
function chooseMostDifferent(uses, current, count) {
  const distance = (a, b) => Math.hypot(a.mortgageLump - b.mortgageLump, a.collegeLump - b.collegeLump);
  const pool = uses.filter((entry) => entry !== current);
  if (pool.length <= count) {
    return pool;
  }
  let best = null;
  const choose = (start, picked) => {
    if (picked.length === count) {
      const group = [current, ...picked];
      let smallest = Infinity;
      let total = 0;
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const gap = distance(group[i], group[j]);
          smallest = Math.min(smallest, gap);
          total += gap;
        }
      }
      if (!best || smallest > best.smallest + 1e-9
        || (Math.abs(smallest - best.smallest) <= 1e-9 && total > best.total)) {
        best = { picked: [...picked], smallest, total };
      }
      return;
    }
    for (let i = start; i < pool.length; i += 1) {
      choose(i + 1, [...picked, pool[i]]);
    }
  };
  choose(0, []);
  return best.picked;
}

/** How much a use changes from leaving the cash alone: euros moved, then goals touched, then the mortgage. */
function byHowMuchTheyChange(a, b) {
  return (a.cashUsed - b.cashUsed) || (a.goalsTouched - b.goalsTouched) || (a.mortgageLump - b.mortgageLump);
}

/**
 * Who gets the yearly money, in the planning method's order. A goal takes what
 * it needs from what is left, so a goal late in the order can be partly
 * covered or not covered. A goal needing nothing this year is covered. A lower
 * mortgage repayment frees money, and that money is there for the goals.
 */
function goalStates(inputs, { mortgageYearly, college, pension }) {
  const freed = Math.max(0, -mortgageYearly);
  let remaining = inputs.leftOverEachYear + freed;
  const goals = [
    ...[...college.perChild]
      .sort((a, b) => a.startsInYears - b.startsInYears)
      .map((child) => ({
        goal: child.id,
        kind: 'college',
        title: `College, ${child.title.toLowerCase()}`,
        need: child.yearlyAmount
      })),
    {
      goal: 'mortgage',
      kind: 'mortgage',
      title: `Your mortgage cleared by ${inputs.mortgage.clearByAge}`,
      note: mortgageAlreadyEnds(inputs.mortgage) ? `Your mortgage already ends by ${inputs.mortgage.clearByAge}.` : '',
      need: Math.max(0, mortgageYearly)
    },
    {
      goal: 'retirement',
      kind: 'retirement',
      title: `You retire at ${pension.retirementAge} on ${eur(pension.targetIncomeToday)} a year`,
      need: pension.yearlyExtraCost
    }
  ];

  return goals.map((entry) => {
    const covered = Math.max(0, Math.min(entry.need, remaining));
    remaining -= covered;
    let state = entry.need <= 0.5 || covered >= entry.need - 0.5 ? 'covered' : (covered <= 0 ? 'not' : 'partly');
    // Contributions at the relief limit that still leave a gap cannot read
    // "covered": the money is found and the target is still not met.
    if (entry.kind === 'retirement' && pension.reachedCap && pension.gapLeftOver > 0 && state === 'covered') {
      state = 'partly';
    }
    return { ...entry, covered, state, stateWord: STATE_WORDS[state] };
  });
}

function buildLedger(inputs, mortgage, college, pension, years) {
  const rows = [];
  for (let year = 0; year < years; year += 1) {
    const children = college.perChild.map((child) => (year < child.savingYears ? child.yearlyAmount : 0));
    const pensionCost = pension.extraCostByYear[year] || 0;
    const total = mortgage.yearlyChange + sumOf(children) + pensionCost;
    rows.push({
      year,
      mortgage: mortgage.yearlyChange,
      children,
      pension: pensionCost,
      total,
      difference: total - inputs.leftOverEachYear
    });
  }
  return rows;
}

/** One use of cash priced against the mortgage and college. The pension is added per target. */
function priceUse(inputs, use, wholeMortgage, wholeCollege, todaySchedule, fundOptions) {
  const mortgage = priceMortgage(inputs, use.mortgageLump, todaySchedule);
  const college = priceCollege(inputs, wholeCollege.requiredToday > 0 ? use.collegeLump / wholeCollege.requiredToday : 0, fundOptions);
  return {
    mortgageLump: use.mortgageLump,
    collegeLump: college.lumpSumToday,
    cashUsed: use.mortgageLump + college.lumpSumToday,
    cashLeft: inputs.spareCash - use.mortgageLump - college.lumpSumToday,
    goalsTouched: (use.mortgageLump > 0.5 ? 1 : 0) + (college.lumpSumToday > 0.5 ? 1 : 0),
    use: {
      mortgage: classifyUse(use.mortgageLump, wholeMortgage),
      college: classifyUse(college.lumpSumToday, wholeCollege.requiredToday)
    },
    mortgage,
    college
  };
}

/** A priced use measured against the money the household has, at one retirement target. */
function measure(inputs, priced, pension, ledgerYears) {
  const neededThisYear = priced.mortgage.yearlyChange + priced.college.yearlyAmountNow + pension.yearlyExtraCost;
  const difference = neededThisYear - inputs.leftOverEachYear;
  const paidOut = {
    mortgage: priced.mortgage.totalPaidOverTheLoan,
    college: priced.college.paidIn,
    retirement: pension.personalCostWithExtra
  };
  return {
    pension,
    neededThisYear,
    shortfall: Math.max(0, difference),
    spare: Math.max(0, -difference),
    paidOutOverLife: { ...paidOut, total: paidOut.mortgage + paidOut.college + paidOut.retirement },
    states: goalStates(inputs, { mortgageYearly: priced.mortgage.yearlyChange, college: priced.college, pension }),
    ledger: buildLedger(inputs, priced.mortgage, priced.college, pension, ledgerYears)
  };
}

// -------------------------------------------------------------------- words ---

/**
 * The words a case puts on screen, all addressed to the household as "you",
 * derived from the figures and never typed per case.
 */
function caseWords(inputs, entry) {
  const label = USE_LABELS[`${entry.use.mortgage}/${entry.use.college}`]
    || { id: 'cash-used-differently', title: 'Cash used a different way' };
  const lumps = [];
  if (entry.mortgageLump > 0.5) lumps.push(eur(entry.mortgageLump));
  if (entry.collegeLump > 0.5) lumps.push(eur(entry.collegeLump));
  const freed = Math.max(0, -entry.mortgage.yearlyChange);
  return {
    id: label.id,
    title: label.title,
    amountLine: lumps.length === 0 ? 'Nothing from your cash' : `${lumps.join(' and ')} from your cash`,
    mortgageNote: mortgageAlreadyEnds(inputs.mortgage) ? `Your mortgage already ends by ${inputs.mortgage.clearByAge}.` : '',
    headline: entry.shortfall > 0
      ? `You’re short by ${eur(entry.shortfall)} a year`
      : `You have ${eur(entry.spare)} a year to spare`,
    // The same figure as "needed this year", so the headline, the support line
    // and the case's measures never state two different needs.
    support: `Your goals need ${eur(entry.neededThisYear)} a year `
      + `against the ${eur(inputs.leftOverEachYear)} you have`
      + `${freed > 0 ? `, counting the ${eur(freed)} a lower repayment frees` : ''}.`
  };
}

// ------------------------------------------------------------------- output ---

function buildAssumptionsTable(inputs, context) {
  const { fundAssumptions, year } = context;
  const pct = (value) => `${Number.isInteger(value * 100) ? value * 100 : (value * 100).toFixed(2)}%`;
  return {
    columns: ['Assumption', 'Input Used'],
    rows: [
      ['Spare cash now', `${eur(inputs.spareCash)}, after your emergency reserve`],
      ['Left over each year', `${eur(inputs.leftOverEachYear)}, the same every year`],
      ['Order of your goals', GOAL_ORDER_TEXT],
      ['Pension money', PENSION_TEXT],
      ['Mortgage', `${eur(inputs.mortgage.currentBalance)} at ${pct(inputs.mortgage.annualInterestRate)}, ${inputs.mortgage.remainingTermYears} years left, cleared by ${inputs.mortgage.clearByAge}`],
      mortgageAlreadyEnds(inputs.mortgage)
        ? ['Your mortgage', `Your mortgage already ends by ${inputs.mortgage.clearByAge}, so there is nothing to clear and no cash goes into it`]
        : ['A lump sum into the mortgage', 'Lowers the repayment and keeps the term, so the mortgage is still cleared by that age'],
      ['College', `${inputs.children.length === 1 ? 'One child' : `${inputs.children.length} children`}, four years each from age ${PLANEIR_ASSUMPTIONS.collegeFunding.startAge}, living at home, ${eur(collegeCost().annualCostToday)} a year each in today’s money`],
      ['College cost growth', `${pct(fundAssumptions.priceGrowthRate)} a year`],
      ['Interest on money held in cash, after DIRT', `${pct(fundAssumptions.cashRateNet)} a year`],
      ['Retirement target', `${eur(inputs.retirement.targetIncomeToday)} a year after tax, in today’s money, from ${inputs.retirement.retirementAge}`],
      ...(inputs.laterRetirement
        ? [['Later retirement option', `${eur(inputs.laterRetirement.targetIncomeToday)} a year from ${inputs.laterRetirement.retirementAge}, priced beside every case`]]
        : []),
      ['Tax year', String(year)],
      ['Not modelled', 'Anything in your emergency reserve, protection, and money you have not told us about']
    ]
  };
}

function buildOutputsTable(cases, hasLater) {
  return {
    columns: [
      'Case',
      'From your cash (€)',
      'Needed this year (€)',
      'Against what you have (€)',
      'Paid out over the life of your goals (€)',
      ...(hasLater ? ['Needed this year at the later option (€)'] : [])
    ],
    rows: cases.map((entry) => [
      entry.words.title,
      Math.round(entry.cashUsed),
      Math.round(entry.neededThisYear),
      entry.shortfall > 0 ? -Math.round(entry.shortfall) : Math.round(entry.spare),
      Math.round(entry.paidOutOverLife.total),
      ...(hasLater && entry.laterRetirement ? [Math.round(entry.laterRetirement.neededThisYear)] : [])
    ])
  };
}

function buildTables(inputs, cases) {
  return cases.map((entry) => ({
    title: `${entry.words.title}: what you need each year`,
    columns: [
      'Year',
      'Mortgage change (€)',
      ...inputs.children.map((child) => `College, ${child.title.toLowerCase()} (€)`),
      'Retirement, after relief (€)',
      'Total (€)',
      'Against what you have (€)'
    ],
    rows: entry.ledger.map((row) => [
      row.year === 0 ? 'This year' : `Year ${row.year}`,
      Math.round(row.mortgage),
      ...row.children.map((value) => Math.round(value)),
      Math.round(row.pension),
      Math.round(row.total),
      Math.round(inputs.leftOverEachYear - row.total)
    ])
  }));
}

function buildCharts(inputs, cases) {
  return [{
    title: 'What you need each year, by case',
    subtitle: `Against the ${eur(inputs.leftOverEachYear)} you have left over each year.`,
    type: 'bar',
    labels: cases.map((entry) => entry.words.title),
    datasets: [
      { label: 'Needed this year', data: cases.map((entry) => Math.round(entry.neededThisYear)) },
      { label: 'Left over each year', data: cases.map(() => Math.round(inputs.leftOverEachYear)) }
    ],
    display: { variant: 'wide', valueFormat: 'currency', yAxisTitle: 'A year' }
  }];
}

// ------------------------------------------------------------------ engine ---

/**
 * @param {object} rawInputs `generated.goalsAndResourcesInputs`
 * @param {object} [options]
 * @param {object} [options.assumptions] Test injection for the college engine's central assumptions.
 * @param {number} [options.calculationYear] The tax year; defaults to the year of the mortgage start date.
 * @param {object} [options.taxCatalogue] Test injection for the college engine's DIRT rule.
 * @param {boolean} [options.includeHeadroom] Also report how far current contributions sit above the target.
 */
export function computeGoalsAndResourcesProjection(rawInputs, options = {}) {
  const inputs = normalizeGoalsAndResourcesInputs(rawInputs);
  const year = calculationYearFor(inputs, options);
  const fundOptions = {
    calculationYear: year,
    ...(options.assumptions ? { assumptions: options.assumptions } : {}),
    ...(options.taxCatalogue ? { taxCatalogue: options.taxCatalogue } : {})
  };
  const includeHeadroom = options.includeHeadroom === true;
  const ledgerYears = inputs.mortgage.clearByAge - inputs.mortgage.currentAge;

  const todaySchedule = computeAmortizationMonthlySchedule(mortgageEnginePayload(inputs.mortgage, 0), { scenarioId: 'today' });
  const wholeMortgage = solveWholeMortgageLump(inputs);
  const wholeCollege = priceCollege(inputs, 1, fundOptions);

  const pensionBase = priceRetirement(inputs, { id: 'retire-base', ...inputs.retirement }, year, { includeHeadroom });
  const pensionLater = inputs.laterRetirement
    ? priceRetirement(inputs, { id: 'retire-later', ...inputs.laterRetirement }, year, { includeHeadroom })
    : null;

  const uses = enumerateUses(inputs, wholeMortgage, wholeCollege.requiredToday)
    .map((use) => priceUse(inputs, use, wholeMortgage, wholeCollege, todaySchedule, fundOptions));
  const measured = uses.map((priced) => ({
    ...priced,
    ...measure(inputs, priced, pensionBase, ledgerYears)
  }));

  // Case 1 keeps the cash as it is, and every goal is pursued from yearly money.
  const current = measured.find((entry) => entry.mortgageLump <= 0.5 && entry.collegeLump <= 0.5);
  const chosen = [current, ...chooseMostDifferent(measured, current, 3).sort(byHowMuchTheyChange)];

  const cases = chosen.map((entry, index) => {
    const withLater = pensionLater
      ? { ...entry, ...measure(inputs, entry, pensionLater, ledgerYears) }
      : null;
    return {
      number: index + 1,
      ...entry,
      words: caseWords(inputs, entry),
      laterRetirement: withLater
        ? {
          retirementAge: pensionLater.retirementAge,
          targetIncomeToday: pensionLater.targetIncomeToday,
          neededThisYear: withLater.neededThisYear,
          shortfall: withLater.shortfall,
          spare: withLater.spare,
          paidOutOverLife: withLater.paidOutOverLife,
          states: withLater.states,
          pension: withLater.pension,
          ledger: withLater.ledger
        }
        : null
    };
  }).map((entry) => ({ ...entry, id: entry.words.id, title: entry.words.title }));

  const fundRates = computeFutureCostFundProjection({
    costTitle: 'College',
    costKind: 'education',
    startsInYears: 1,
    durationYears: 1,
    annualCostToday: 1,
    scenarios: [{ id: 'rates' }]
  }, fundOptions).debug.assumptionsUsed;

  return {
    assumptionsTable: buildAssumptionsTable(inputs, { fundAssumptions: fundRates, year }),
    outputsTable: buildOutputsTable(cases, pensionLater !== null),
    tables: buildTables(inputs, cases),
    charts: buildCharts(inputs, cases),
    debug: {
      inputs,
      calculationYear: year,
      goalOrder: ['college by start date', 'mortgage', 'retirement'],
      mortgageAlreadyEnds: mortgageAlreadyEnds(inputs.mortgage),
      wholeMortgageLump: wholeMortgage,
      wholeCollege: {
        requiredToday: wholeCollege.requiredToday,
        yearlyIfNoLump: priceCollege(inputs, 0, fundOptions).yearlyAmountNow,
        perChild: wholeCollege.perChild
      },
      mortgageToday: priceMortgage(inputs, 0, todaySchedule),
      retirement: { base: pensionBase, later: pensionLater },
      // Every use priced, in order of how much it changes. Not a ranking.
      uses: [...measured].sort(byHowMuchTheyChange),
      cases,
      baseScenarioId: cases[0].id,
      assumptionsUsed: {
        goalOrder: GOAL_ORDER_TEXT,
        pensionMoney: PENSION_TEXT,
        priceGrowthRate: fundRates.priceGrowthRate,
        cashRateGross: fundRates.cashRateGross,
        dirtRate: fundRates.dirtRate,
        cashRateNet: fundRates.cashRateNet,
        assumptionsVersion: fundRates.assumptionsVersion,
        taxRulesVersion: IE_TAX_RULES_VERSION,
        calculationYear: year
      }
    }
  };
}

/** `[{ id, title, description }]`, for the presenter and the case buttons. */
export function getGoalsAndResourcesCases(rawInputs, options = {}) {
  return computeGoalsAndResourcesProjection(rawInputs, options).debug.cases.map((entry) => ({
    id: entry.id,
    title: entry.title,
    description: entry.words.amountLine
  }));
}

export function getDefaultGoalsAndResourcesScenarioId(rawInputs, options = {}) {
  return computeGoalsAndResourcesProjection(rawInputs, options).debug.baseScenarioId;
}
