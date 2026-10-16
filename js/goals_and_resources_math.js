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
 * THE RELIEF LIMIT RISES WITH AGE, so the search ceiling is the room across
 * the whole schedule to retirement (each person's limit in their last working
 * year), not today's age band, and the limit is reported only when nothing
 * later helps. When it is reached and the target is still out of reach, the
 * notes beside money invested outside a pension are carried in the output.
 *
 * COVERAGE IS JUDGED YEAR BY YEAR. What is left over is fixed and a pension
 * saving rises with wages, so a goal met this year can be short later. The
 * ledger runs to the last year any goal is active (the mortgage's term, each
 * child's college start, retirement and the later option's retirement), and a
 * goal is covered only if it is met in every year it needs money.
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
  PENSION_EARNINGS_CAP,
  computePensionProjection,
  computePersonalContributionCosts,
  maxRelievableContributionRatePercent,
  maxRelievablePersonalContribution,
  normalizePensionInputs
} from './pension_math.js';
import { computeFutureCostFundProjection } from './future_cost_fund_math.js';
import { PLANEIR_ASSUMPTIONS } from './planning/planeir_assumptions.js';
import { afterTaxInvestmentDisclosures } from './planning/tax/investment_funds.js';
import { resolveTaxRules } from './planning/tax/resolve.js';
import { IE_TAX_FIRST_YEAR, IE_TAX_RULES_VERSION } from './planning/tax/rules_ie.js';

const FIELD = 'generated.goalsAndResourcesInputs';
const MAX_CHILDREN = 4;
const MAX_PEOPLE = 2;
/** Two cash uses count as the same when both lump sums are within this. */
const SAME_USE_WITHIN_EUR = 1_000;
/** A search stops once the gap sits inside (−1, 0] euros of the engine's own threshold. */
const SEARCH_AIM_EUR = 0.5;
const SEARCH_MAX_STEPS = 20;

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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The date the calculation is as of: `options.calculationDate` when one is
 * given, else the mortgage's start date (the date its balance is stated at,
 * and the one the calculation year comes from). Never earlier than the first
 * year the tax catalogue covers.
 */
function calculationDateFor(inputs, options, year) {
  const given = typeof options.calculationDate === 'string' && ISO_DATE.test(options.calculationDate)
    ? options.calculationDate
    : null;
  const started = ISO_DATE.test(inputs.mortgage.startDateIso) ? inputs.mortgage.startDateIso : `${year}-01-01`;
  const first = `${IE_TAX_FIRST_YEAR}-01-01`;
  const date = given || started;
  return date < first ? first : date;
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
 * `points` must hold one run that does not close the gap and one that does, in
 * the order of the contribution. The gap only falls as the contribution rises,
 * and it is a straight line only while no year's relief limit binds; past that
 * it bends (more contribution buys less) and may go flat. So this does not
 * trust a straight line: it keeps a bracket and takes the Illinois step, which
 * is the straight-line step with the retained end's value halved whenever the
 * same end is kept twice, so it closes in a handful of runs on a line, a bend
 * or a flat tail alike. It aims half a euro inside the threshold and stops at
 * the first point the engine itself says closes within a euro of it.
 */
function solveContribution(runAt, points, minX, maxX) {
  const f = (run) => run.rawGap - run.tolerance;
  const tight = (run) => f(run) <= 0 && f(run) > -1;
  const evaluated = [...points];

  const already = evaluated.find(tight);
  if (already) {
    return already;
  }
  const closedPoints = evaluated.filter((run) => f(run) <= 0);
  const openPoints = evaluated.filter((run) => f(run) > 0);
  if (closedPoints.length === 0 || openPoints.length === 0) {
    // Nothing to bracket: the nearest end of the range, run once.
    return closedPoints[0] || runAt(maxX);
  }

  let hi = closedPoints.reduce((best, run) => (run.x < best.x ? run : best));
  let lo = openPoints.filter((run) => run.x < hi.x).reduce((best, run) => (run.x > best.x ? run : best), openPoints[0]);
  let gLo = f(lo) + SEARCH_AIM_EUR;
  let gHi = f(hi) + SEARCH_AIM_EUR;
  let kept = 0;

  for (let step = 0; step < SEARCH_MAX_STEPS; step += 1) {
    let x = hi.x - (gHi * (hi.x - lo.x)) / (gHi - gLo);
    if (!(x > lo.x && x < hi.x)) {
      x = (lo.x + hi.x) / 2;
    }
    x = Math.min(maxX, Math.max(minX, x));
    const run = runAt(x);
    evaluated.push(run);
    if (tight(run)) {
      return run;
    }
    if (f(run) > 0) {
      lo = run;
      gLo = f(run) + SEARCH_AIM_EUR;
      if (kept === -1) gHi /= 2;
      kept = -1;
    } else {
      hi = run;
      gHi = f(run) + SEARCH_AIM_EUR;
      if (kept === 1) gLo /= 2;
      kept = 1;
    }
  }

  const closedNow = evaluated.filter((run) => f(run) <= 0);
  return closedNow.reduce((best, run) => (run.x < best.x ? run : best));
}

/**
 * The most points of salary, added for everyone, that can still change what
 * anyone pays in: beyond it every person is at the relief limit in every
 * working year, so more points do nothing.
 *
 * It is worked out the way the pension engine relieves a contribution, year by
 * year. A person pays in until the year before they retire, and in each of
 * those years the engine relieves the age band's share of their salary up to
 * the earnings cap (`maxRelievablePersonalContribution`). As a share of that
 * year's salary that is the band's rate while the salary is under the cap, and
 * a smaller share once it is over, so a high earner has less room than the age
 * band suggests, and wage growth lowers it a little more each year. The room is
 * the largest such share over the working years, less what they already pay in.
 * A person at today's limit who reaches a higher band still has room. The
 * household's ceiling is the largest of its people's, because one person's
 * contributions can rise while another's cannot.
 *
 * The ages, salaries and growth are the pension engine's own, from its
 * normalised inputs, so they cannot drift from it.
 */
function reliefCeilingPoints(inputs, target, year) {
  const household = normalizePensionInputs(pensionEnginePayload(inputs, target, 0, year));
  return Math.max(0, ...household.pensions.map((member) => {
    let room = 0;
    for (let working = household.currentYear; working < member.retirementYear; working += 1) {
      const sinceNow = working - household.currentYear;
      const salary = member.currentSalary * (1 + member.wageGrowthRate) ** sinceNow;
      if (salary > 0) {
        const share = maxRelievablePersonalContribution(member.currentAge + sinceNow, salary) / salary;
        room = Math.max(room, share - member.personalPct);
      }
    }
    return room;
  }));
}

/**
 * What a household at the relief limit must be told about money that goes
 * beyond it: the notes for an after-tax investment, from the tax rules as of
 * the calculation date. Carried in the output for a screen to render with
 * `renderTaxDisclosures`; none when the target is met.
 *
 * The limit's figures are given only when the people share one limit: two
 * people in different age bands have two, and the note then says no figure
 * rather than the wrong one.
 */
function reliefLimitDisclosures(inputs, { asOf, year }) {
  const shares = new Set(inputs.pensions.map(
    (person) => maxRelievableContributionRatePercent(person.currentAge)
  ));
  const [only] = [...shares];
  return afterTaxInvestmentDisclosures({
    asOf,
    rules: resolveTaxRules(Math.max(IE_TAX_FIRST_YEAR, year)),
    pensionAtReliefLimit: true,
    ...(shares.size === 1 && Number.isFinite(only)
      ? { reliefLimit: { share: only / 100, earningsCap: PENSION_EARNINGS_CAP } }
      : {})
  });
}

function priceRetirement(inputs, target, year, { includeHeadroom, asOf }) {
  const runAt = (x) => pensionRun(inputs, target, x, year);
  const f = (run) => run.rawGap - run.tolerance;
  const atToday = runAt(0);
  const costsToday = computePersonalContributionCosts(pensionEnginePayload(inputs, target, 0, year));
  const capPoints = reliefCeilingPoints(inputs, target, year);

  let extraPoints = 0;
  let result = atToday;
  let reachedCap = false;

  if (!atToday.closed) {
    if (capPoints <= 0) {
      reachedCap = true;
    } else {
      // The most that can help is run first: if it does not close the gap,
      // nothing within the relief limit does, and the limit is reached. If it
      // does, the answer lies between today and it, and the search closes in.
      // (The pot is no longer a straight line in the contribution once some
      // year's relief limit binds, so a straight-line guess past the first
      // probe cannot be trusted to bracket the answer.)
      const atCap = runAt(capPoints);
      if (!atCap.closed) {
        reachedCap = true;
        result = atCap;
        extraPoints = capPoints;
      } else {
        result = solveContribution(runAt, [atToday, atCap], 0, capPoints);
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
    // Notes for money beyond the limit, only when the target is out of reach at it.
    disclosures: reachedCap && result.rawGap > 0 ? reliefLimitDisclosures(inputs, { asOf, year }) : [],
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
 * Who gets the yearly money, in the planning method's order, year by year.
 *
 * Each year the household has what is left over, plus what a lower mortgage
 * repayment frees that year. A goal takes what it needs from what remains, in
 * the planning order, so a goal late in the order can be partly covered or not
 * covered. The ledger is the year-by-year record of what each goal needs, and a
 * goal's state is read from every year it needs anything:
 *
 *  - covered   it is met in every year it needs money (or never needs any)
 *  - not       it is not met in any of them, with nothing put towards it
 *  - partly    anything else, including a goal met this year that a rising
 *              cost (wage growth) or a later goal's start leaves short later
 *
 * `need` and `covered` are this year's, which is what the screen's picture
 * shows. Three year offsets say when, with 0 as this year and a screen turning
 * them into calendar years:
 *
 *  - `firstShortYear`   the first year the goal is not fully met, or null
 *  - `firstMoneyYear`   the first active year any yearly money reaches it, or
 *                       null if none does (including a goal paid in full today)
 *  - `coveredFromYear`  the first year from which it is fully met in every year
 *                       it still needs money, after having been short; null if
 *                       it was never short, or is still short in its last year
 */
function goalStates(inputs, { college, pension, ledger }) {
  const ordered = college.perChild
    .map((child, index) => ({ child, index }))
    .sort((a, b) => a.child.startsInYears - b.child.startsInYears);
  const goals = [
    ...ordered.map(({ child, index }) => ({
      goal: child.id,
      kind: 'college',
      title: `College, ${child.title.toLowerCase()}`,
      needs: ledger.map((row) => row.children[index] || 0)
    })),
    {
      goal: 'mortgage',
      kind: 'mortgage',
      title: `Your mortgage cleared by ${inputs.mortgage.clearByAge}`,
      note: mortgageAlreadyEnds(inputs.mortgage) ? `Your mortgage already ends by ${inputs.mortgage.clearByAge}.` : '',
      needs: ledger.map((row) => Math.max(0, row.mortgage))
    },
    {
      goal: 'retirement',
      kind: 'retirement',
      title: `You retire at ${pension.retirementAge} on ${eur(pension.targetIncomeToday)} a year`,
      needs: ledger.map((row) => row.pension)
    }
  ];

  // The planning order, year by year: what each goal gets from what is left.
  const gets = goals.map(() => []);
  ledger.forEach((row, year) => {
    let remaining = inputs.leftOverEachYear + Math.max(0, -row.mortgage);
    goals.forEach((entry, index) => {
      const got = Math.max(0, Math.min(entry.needs[year], remaining));
      remaining -= got;
      gets[index].push(got);
    });
  });

  return goals.map((entry, index) => {
    const active = entry.needs
      .map((need, year) => ({ year, need, got: gets[index][year] }))
      .filter((row) => row.need > 0.5);
    const short = active.filter((row) => row.got < row.need - 0.5);
    let state = 'covered';
    if (short.length > 0) {
      state = active.every((row) => row.got <= 0) ? 'not' : 'partly';
    }
    // Contributions at the relief limit that still leave a gap cannot read
    // "covered": the money is found and the target is still not met.
    if (entry.kind === 'retirement' && pension.reachedCap && pension.gapLeftOver > 0 && state === 'covered') {
      state = 'partly';
    }
    const { needs, ...rest } = entry;
    const lastShort = short.length > 0 ? short[short.length - 1].year : null;
    const recovered = lastShort === null ? undefined : active.find((row) => row.year > lastShort);
    const funded = active.find((row) => row.got > 0);
    return {
      ...rest,
      need: needs[0],
      covered: gets[index][0],
      firstShortYear: short.length > 0 ? short[0].year : null,
      firstMoneyYear: funded ? funded.year : null,
      coveredFromYear: recovered ? recovered.year : null,
      state,
      stateWord: STATE_WORDS[state]
    };
  });
}

/**
 * What each goal needs, year by year, from this year to the last year any goal
 * is active: the mortgage until it is cleared, each child's saving until their
 * college starts, and the pension until retirement (the later option's too).
 * After the mortgage is cleared the ledger carries nothing for it.
 */
function buildLedger(inputs, mortgage, college, pension, years) {
  const mortgageYears = inputs.mortgage.clearByAge - inputs.mortgage.currentAge;
  const rows = [];
  for (let year = 0; year < years; year += 1) {
    const children = college.perChild.map((child) => (year < child.savingYears ? child.yearlyAmount : 0));
    const pensionCost = pension.extraCostByYear[year] || 0;
    const mortgageChange = year < mortgageYears ? mortgage.yearlyChange : 0;
    const total = mortgageChange + sumOf(children) + pensionCost;
    rows.push({
      year,
      mortgage: mortgageChange,
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
  const ledger = buildLedger(inputs, priced.mortgage, priced.college, pension, ledgerYears);
  return {
    pension,
    neededThisYear,
    shortfall: Math.max(0, difference),
    spare: Math.max(0, -difference),
    paidOutOverLife: { ...paidOut, total: paidOut.mortgage + paidOut.college + paidOut.retirement },
    states: goalStates(inputs, { college: priced.college, pension, ledger }),
    ledger
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

function buildTables(inputs, cases, year) {
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
      // Calendar years, so the table and the screen agree: a client cannot know
      // that this year counts as year 0.
      String(year + row.year),
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
 * @param {string} [options.calculationDate] YYYY-MM-DD the relief-limit notes are raised as of; defaults to the mortgage start date.
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
  const asOf = calculationDateFor(inputs, options, year);

  const todaySchedule = computeAmortizationMonthlySchedule(mortgageEnginePayload(inputs.mortgage, 0), { scenarioId: 'today' });
  const wholeMortgage = solveWholeMortgageLump(inputs);
  const wholeCollege = priceCollege(inputs, 1, fundOptions);

  const pensionBase = priceRetirement(inputs, { id: 'retire-base', ...inputs.retirement }, year, { includeHeadroom, asOf });
  const pensionLater = inputs.laterRetirement
    ? priceRetirement(inputs, { id: 'retire-later', ...inputs.laterRetirement }, year, { includeHeadroom, asOf })
    : null;

  // The ledger runs to the last year any goal is active: the mortgage's term,
  // the youngest child's college start, and retirement, the later option's too.
  const ledgerYears = Math.max(
    inputs.mortgage.clearByAge - inputs.mortgage.currentAge,
    ...inputs.children.map((child) => collegeCost().startAge - child.age),
    pensionBase.extraCostByYear.length,
    pensionLater ? pensionLater.extraCostByYear.length : 0
  );

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
    tables: buildTables(inputs, cases, year),
    charts: buildCharts(inputs, cases),
    debug: {
      inputs,
      calculationYear: year,
      // What a screen needs to render the relief-limit notes with
      // `renderTaxDisclosures`: the date they were raised as of, and the year
      // whose rules resolve them. Not part of any figure.
      calculationDateIso: asOf,
      taxRulesYear: Math.max(IE_TAX_FIRST_YEAR, year),
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
