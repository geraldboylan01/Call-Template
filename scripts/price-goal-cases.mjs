#!/usr/bin/env node

/**
 * ILLUSTRATIVE HOUSEHOLD, NOT REAL FIGURES.
 *
 * Prices every way of using today's cash against three goals, through the
 * engines, and picks the four cases the Goals and resources screen shows.
 *
 *   mortgage  js/mortgage_math.js         lump sum, lowerPayment, term = clear by 60
 *   pensions  js/pension_math.js          personal contribution searched until the gap closes
 *   college   js/future_cost_fund_math.js each child is its own dated cost
 *
 * Nothing here is a formula of its own. Every figure is an engine's output;
 * the only arithmetic done here is adding goals together and comparing them
 * with the money the household has.
 *
 * NO SINGLE SCORE. Every case carries two measures side by side, "needed this
 * year" and "paid out over the life of the goals", and neither orders the
 * cases. They disagree: the use of cash that frees the most this year is not
 * the one that costs the least over the life of the goals. Case 1 is the
 * current position. The other three are the most different uses of cash, shown
 * in order of how much they change from case 1.
 *
 * Usage:
 *   node scripts/price-goal-cases.mjs            readable report
 *   node scripts/price-goal-cases.mjs --json     the same, as JSON
 *
 * The household is the constant below. Change it there; nothing is read from a
 * client record, and none of it is a client's.
 */

import { computeAmortizationMonthlySchedule } from '../js/mortgage_math.js';
import {
  computePensionProjection,
  maxRelievableContributionRatePercent
} from '../js/pension_math.js';
import { computeFutureCostFundProjection } from '../js/future_cost_fund_math.js';
import { PLANEIR_ASSUMPTIONS } from '../js/planning/planeir_assumptions.js';

export const ILLUSTRATIVE_HOUSEHOLD = Object.freeze({
  label: 'Illustrative household, not real figures',
  currentYear: 2026,

  /** Spare cash, already net of the emergency reserve. */
  spareCash: 60_000,
  /**
   * What is left over each year after everything they already pay. STATED for
   * Stage 1. In a plan it will be the Household cash flow result's left-over
   * figure, so this field is replaced by that result, not by the client typing it.
   */
  leftOverEachYear: 6_000,

  /**
   * The client's stated priorities, highest first. A payload field: it decides
   * which goal takes the yearly money first, and so which goals read "covered",
   * "partly covered" or "not covered". Never a position this script chose.
   */
  goalPriorities: Object.freeze(['college', 'mortgage', 'retirement']),

  mortgage: Object.freeze({
    currentBalance: 380_000,
    annualInterestRate: 0.04,
    startDateIso: '2026-11-01',
    remainingTermYears: 18,
    ageToday: 45,
    clearByAge: 60
  }),

  people: Object.freeze([
    Object.freeze({ id: 'niamh', title: 'Niamh', currentAge: 45, currentSalary: 90_000, currentPot: 100_000, personalPct: 0.05, employerPct: 0.05 }),
    Object.freeze({ id: 'dara', title: 'Dara', currentAge: 45, currentSalary: 60_000, currentPot: 40_000, personalPct: 0.04, employerPct: 0.04 })
  ]),

  /** Household targets: after tax, in today's money, State Pension included. */
  retirementTargets: Object.freeze({
    base: Object.freeze({ id: 'retire-62', retirementAge: 62, targetIncomeToday: 50_000 }),
    later: Object.freeze({ id: 'retire-65', retirementAge: 65, targetIncomeToday: 46_000 })
  }),

  /** Children's ages. College timing and cost are the central assumptions. */
  children: Object.freeze([
    Object.freeze({ id: 'child-1', title: 'First child', age: 10 }),
    Object.freeze({ id: 'child-2', title: 'Second child', age: 8 })
  ])
});

const H = ILLUSTRATIVE_HOUSEHOLD;
const LEDGER_YEARS = H.mortgage.clearByAge - H.mortgage.ageToday;
/** Two cash uses count as the same when both lump sums are within this. */
const SAME_USE_WITHIN_EUR = 1_000;

const eur = (amount) => `${amount < 0 ? '−' : ''}€${Math.abs(Math.round(amount)).toLocaleString('en-IE')}`;
const signed = (amount) => `${amount < 0 ? '−' : '+'}${eur(Math.abs(amount))}`;

// ---------------------------------------------------------------- mortgage ---

function mortgagePayload(lumpSum) {
  const m = H.mortgage;
  return {
    loanKind: 'mortgage',
    currentBalance: m.currentBalance,
    annualInterestRate: m.annualInterestRate,
    startDateIso: m.startDateIso,
    remainingTermYears: m.remainingTermYears,
    repaymentType: 'repayment',
    baseScenarioId: 'today',
    scenarios: [
      { id: 'today', title: 'As it is today' },
      {
        id: 'clear-by-retirement',
        title: `Cleared by ${m.clearByAge}`,
        oneOffOverpayment: lumpSum,
        oneOffOverpaymentMonth: 0,
        overpaymentBenefit: 'lowerPayment',
        remainingTermYears: m.clearByAge - m.ageToday
      }
    ]
  };
}

function priceMortgage(lumpSum) {
  const raw = mortgagePayload(lumpSum);
  const today = computeAmortizationMonthlySchedule(raw, { scenarioId: 'today' });
  const cleared = computeAmortizationMonthlySchedule(raw, { scenarioId: 'clear-by-retirement' });
  const todayPayment = today.contractualPayment;
  const monthlyPayment = cleared.monthlyPaymentUsed;
  return {
    lumpSum,
    todayMonthlyPayment: todayPayment,
    monthlyPayment,
    // The engine's repayment minus today's repayment, a year of it.
    yearlyChange: 12 * (monthlyPayment - todayPayment),
    payoffDateIso: cleared.payoffDateIso,
    termYears: H.mortgage.clearByAge - H.mortgage.ageToday,
    balanceAfterLumpSum: cleared.openingBalance,
    todayPayoffDateIso: today.payoffDateIso,
    // Over the whole loan, the lump sum included: what leaves the household.
    totalPaidOverTheLoan: cleared.totalPaidLifetime + cleared.lumpSumApplied,
    interestOverTheLoan: cleared.totalInterestLifetime
  };
}

/**
 * The lump sum that clears the mortgage by the target age WITHOUT raising
 * today's repayment: the smallest lump whose lowered payment is no more than
 * the one they pay now. Found by asking the engine, not by a formula.
 */
function solveWholeMortgageLump() {
  const todayPayment = priceMortgage(0).todayMonthlyPayment;
  let low = 0;
  let high = H.mortgage.currentBalance;
  for (let i = 0; i < 80; i += 1) {
    const mid = (low + high) / 2;
    if (priceMortgage(mid).monthlyPayment <= todayPayment) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return high;
}

// ----------------------------------------------------------------- college ---

function collegeCost() {
  const college = PLANEIR_ASSUMPTIONS.collegeFunding;
  const scenario = college.scenarios.find((entry) => entry.id === 'living_at_home');
  return {
    startAge: college.startAge,
    durationYears: college.durationYears,
    annualCostToday: scenario.annualCostTodayPerChild
  };
}

function childPayload(child, cost, shares) {
  return {
    costTitle: `College, ${child.title.toLowerCase()}`,
    costKind: 'education',
    startsInYears: cost.startAge - child.age,
    durationYears: cost.durationYears,
    annualCostToday: cost.annualCostToday,
    scenarios: shares.map((share, index) => ({ id: `share-${index}`, lumpShare: share }))
  };
}

/** What funding a share of the college cost today asks, for each child as its own dated cost. */
function priceCollege(lumpShare) {
  const cost = collegeCost();
  const options = { calculationYear: H.currentYear };
  const perChild = H.children.map((child) => {
    const projection = computeFutureCostFundProjection(childPayload(child, cost, [lumpShare]), options);
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
    lumpSumToday: perChild.reduce((sum, child) => sum + child.lumpSumToday, 0),
    yearlyAmountNow: perChild.reduce((sum, child) => sum + child.yearlyAmount, 0),
    requiredToday: perChild.reduce((sum, child) => sum + child.requiredToday, 0),
    paidIn: perChild.reduce((sum, child) => sum + child.paidIn, 0),
    perChild
  };
}

// ---------------------------------------------------------------- pensions ---

function pensionPayload(target, extraPoints) {
  return {
    currentYear: H.currentYear,
    incomeMode: 'target',
    targetIncomeToday: target.targetIncomeToday,
    targetIncomeBasis: 'net',
    householdTaxStatus: 'married_or_civil_partners',
    pensions: H.people.map((person) => ({
      id: person.id,
      title: person.title,
      currentAge: person.currentAge,
      retirementAge: target.retirementAge,
      currentSalary: person.currentSalary,
      currentPot: person.currentPot,
      personalPct: Math.max(0, person.personalPct + extraPoints),
      employerPct: person.employerPct,
      includeStatePension: true
    }))
  };
}

function pensionRun(target, extraPoints) {
  const { debug } = computePensionProjection(pensionPayload(target, extraPoints));
  return {
    gap: debug.currentGapVsRequired,
    surplus: debug.currentSurplusVsRequired,
    requiredPot: debug.requiredPot,
    projectedPot: debug.projectedPotCurrent,
    status: debug.readinessStatus,
    // What the household itself puts in, every year to retirement, as the
    // engine simulated it (capped each year at the relief limit).
    personalContributions: debug.currentScenario.personalEurSeries.reduce((sum, value) => sum + value, 0)
  };
}

/**
 * The extra personal contribution, in points of salary added to BOTH people,
 * that closes the gap against the household target. Searched through the
 * engine, never solved. Capped at the age-related relief limit the engine
 * already has; any gap left at the cap is reported.
 */
export function priceRetirement(target) {
  const atToday = pensionRun(target, 0);
  const cap = Math.min(...H.people.map(
    (person) => maxRelievableContributionRatePercent(person.currentAge) / 100 - person.personalPct
  ));

  let extraPoints = 0;
  let result = atToday;
  let reachedCap = false;

  if (atToday.gap > 0) {
    const atCap = pensionRun(target, cap);
    if (atCap.gap > 0) {
      extraPoints = cap;
      result = atCap;
      reachedCap = true;
    } else {
      let low = 0;
      let high = cap;
      for (let i = 0; i < 30; i += 1) {
        const mid = (low + high) / 2;
        if (pensionRun(target, mid).gap > 0) {
          low = mid;
        } else {
          high = mid;
        }
      }
      extraPoints = high;
      result = pensionRun(target, high);
    }
  }

  // How far the CURRENT contributions sit above what the target needs. Not
  // counted as money the household can find: it is reported so the surplus is
  // visible, never spent.
  let lowestPoints = 0;
  if (atToday.gap === 0) {
    const floor = -Math.min(...H.people.map((person) => person.personalPct));
    let low = floor;
    let high = 0;
    if (pensionRun(target, floor).gap === 0) {
      high = floor;
    } else {
      for (let i = 0; i < 30; i += 1) {
        const mid = (low + high) / 2;
        if (pensionRun(target, mid).gap > 0) {
          low = mid;
        } else {
          high = mid;
        }
      }
    }
    lowestPoints = high;
  }

  const salaryTotal = H.people.reduce((sum, person) => sum + person.currentSalary, 0);
  return {
    id: target.id,
    retirementAge: target.retirementAge,
    targetIncomeToday: target.targetIncomeToday,
    requiredPotAtToday: atToday.requiredPot,
    projectedPotAtToday: atToday.projectedPot,
    onTrackAtToday: atToday.gap === 0,
    extraPoints,
    yearlyExtra: extraPoints * salaryTotal,
    reachedCap,
    gapLeftOver: reachedCap ? result.gap : 0,
    // The household's own contributions to retirement over the years to
    // retirement, with and without the extra the search found.
    personalContributionsToday: atToday.personalContributions,
    personalContributionsWithExtra: result.personalContributions,
    extraOverTheLife: result.personalContributions - atToday.personalContributions,
    // Money the current contributions carry beyond the target: personal
    // contributions could fall by this much a year and still close the gap.
    headroomYearly: lowestPoints < 0 ? -lowestPoints * salaryTotal : 0,
    capPointsAvailable: cap
  };
}

// ------------------------------------------------------------- allocations ---

function describeUse(mortgageLump, collegeLump, wholeMortgage, wholeCollege) {
  // none / part (some of it) / whole (the amount that does the job) / over
  // (more than the job needs, which the mortgage can take and college cannot).
  const classify = (amount, whole) => {
    if (amount <= 0.5) return 'none';
    if (amount < whole - 1) return 'part';
    if (amount <= whole + 1) return 'whole';
    return 'over';
  };
  return { mortgage: classify(mortgageLump, wholeMortgage), college: classify(collegeLump, wholeCollege) };
}

/**
 * Who gets the yearly money, in the client's stated order. A goal takes what
 * it needs from what is left, so a goal late in the order can be partly
 * covered or not covered at all. A goal needing nothing this year is covered.
 */
function goalStates({ mortgageYearly, collegeYearly, pension }) {
  const freed = Math.max(0, -mortgageYearly);
  let remaining = H.leftOverEachYear + freed;
  const needs = {
    college: collegeYearly,
    mortgage: Math.max(0, mortgageYearly),
    retirement: pension.yearlyExtra
  };
  const states = {};
  H.goalPriorities.forEach((goal) => {
    const need = needs[goal];
    const covered = Math.max(0, Math.min(need, remaining));
    remaining -= covered;
    let state = need <= 0.5 || covered >= need - 0.5 ? 'covered' : (covered <= 0 ? 'not' : 'partly');
    // Contributions at the relief limit that still leave a gap cannot read
    // "covered": the money is found and the target is still not met.
    if (goal === 'retirement' && pension.reachedCap && pension.gapLeftOver > 0 && state === 'covered') {
      state = 'partly';
    }
    states[goal] = { state, need, covered };
  });
  return states;
}

function priceAllocation({ mortgageLump, collegeLump }, wholeMortgage, wholeCollege, pension) {
  const mortgage = priceMortgage(mortgageLump);
  const college = priceCollege(wholeCollege.requiredToday > 0 ? collegeLump / wholeCollege.requiredToday : 0);
  const neededThisYear = mortgage.yearlyChange + college.yearlyAmountNow + pension.yearlyExtra;
  const difference = neededThisYear - H.leftOverEachYear;
  const goalCount = (mortgageLump > 0.5 ? 1 : 0) + (college.lumpSumToday > 0.5 ? 1 : 0);

  // What leaves the household over the life of the three goals: the mortgage
  // with its lump sum, everything paid into the college fund, and the
  // household's own contributions to retirement (what it pays now, and the extra).
  const paidOutOverLife = {
    mortgage: mortgage.totalPaidOverTheLoan,
    college: college.paidIn,
    retirement: pension.personalContributionsWithExtra
  };

  return {
    mortgageLump,
    collegeLump: college.lumpSumToday,
    cashUsed: mortgageLump + college.lumpSumToday,
    cashLeft: H.spareCash - mortgageLump - college.lumpSumToday,
    goalsTouched: goalCount,
    use: describeUse(mortgageLump, college.lumpSumToday, wholeMortgage, wholeCollege.requiredToday),
    mortgage,
    college,
    pension,
    neededThisYear,
    shortfall: Math.max(0, difference),
    spare: Math.max(0, -difference),
    paidOutOverLife: {
      ...paidOutOverLife,
      total: paidOutOverLife.mortgage + paidOutOverLife.college + paidOutOverLife.retirement
    },
    states: goalStates({
      mortgageYearly: mortgage.yearlyChange,
      collegeYearly: college.yearlyAmountNow,
      pension
    }),
    ledger: buildLedger(mortgage, college, pension.yearlyExtra)
  };
}

/** The household's yearly needs, year by year, each goal as its own line. */
function buildLedger(mortgage, college, pensionYearly) {
  const rows = [];
  for (let year = 0; year < LEDGER_YEARS; year += 1) {
    const children = college.perChild.map((child) => (year < child.savingYears ? child.yearlyAmount : 0));
    const total = mortgage.yearlyChange + children.reduce((sum, amount) => sum + amount, 0) + pensionYearly;
    rows.push({
      year,
      mortgage: mortgage.yearlyChange,
      children,
      pension: pensionYearly,
      total,
      difference: total - H.leftOverEachYear
    });
  }
  return rows;
}

function enumerateUses(wholeMortgage, wholeCollege) {
  const cash = H.spareCash;
  const candidates = [];
  const add = (mortgageLump, collegeLump) => {
    if (mortgageLump + collegeLump <= cash + 0.005) {
      candidates.push({ mortgageLump, collegeLump });
    }
  };

  const mortgageOptions = { none: 0, whole: wholeMortgage };
  const collegeOptions = { none: 0, whole: wholeCollege.requiredToday };

  // Each of the mortgage and the college fund: none, the cash that's left, or
  // the whole amount. "The cash that's left" is what the other goal has not
  // taken, and is never more than the balance or the whole college cost.
  [['none', 'none'], ['none', 'whole'], ['whole', 'none']].forEach(([m, c]) => {
    add(mortgageOptions[m], collegeOptions[c]);
  });
  // College takes the cash left after the whole mortgage lump.
  add(wholeMortgage, Math.min(cash - wholeMortgage, wholeCollege.requiredToday));
  // Mortgage takes the cash left after the whole college fund.
  add(Math.min(cash - wholeCollege.requiredToday, H.mortgage.currentBalance), wholeCollege.requiredToday);
  // Mortgage takes all the cash, college nothing.
  add(Math.min(cash, H.mortgage.currentBalance), 0);
  // College takes all the cash it can use, mortgage nothing.
  add(0, Math.min(cash, wholeCollege.requiredToday));

  const unique = [];
  candidates.forEach((candidate) => {
    const twin = unique.findIndex((entry) => (
      Math.abs(entry.mortgageLump - candidate.mortgageLump) <= SAME_USE_WITHIN_EUR
      && Math.abs(entry.collegeLump - candidate.collegeLump) <= SAME_USE_WITHIN_EUR
    ));
    if (twin === -1) {
      unique.push(candidate);
    }
  });
  return unique;
}

/**
 * The most different uses of cash: the three that, together with the current
 * position, are furthest apart (the largest smallest gap between any two, in
 * euros moved into the mortgage and into college). Distance, not outcome, so
 * no score decides which cases are shown.
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
      if (!best || smallest > best.smallest + 1e-9 || (Math.abs(smallest - best.smallest) <= 1e-9 && total > best.total)) {
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

/** How much a use changes from leaving the cash alone: euros moved, then goals touched. */
function byHowMuchTheyChange(a, b) {
  return (a.cashUsed - b.cashUsed) || (a.goalsTouched - b.goalsTouched) || (a.mortgageLump - b.mortgageLump);
}

// ------------------------------------------------------------------- words ---

const USE_TITLES = Object.freeze({
  'none/none': 'Cash stays as it is',
  'none/part': 'Part of college from cash',
  'none/whole': 'Fund college today',
  'part/none': 'Part of the mortgage from cash',
  'whole/none': 'Mortgage from cash',
  'over/none': 'All cash into the mortgage',
  'whole/part': 'Mortgage, then college',
  'whole/whole': 'Mortgage and college from cash',
  'part/whole': 'College, then mortgage',
  'over/part': 'Mortgage, then college',
  'part/part': 'Cash split across both'
});

/**
 * The words a case puts on screen, all addressed to the household as "you".
 * Derived from the figures here, never typed per case.
 */
function caseWords(allocation) {
  const key = `${allocation.use.mortgage}/${allocation.use.college}`;
  const lumps = [];
  if (allocation.mortgageLump > 0.5) lumps.push(eur(allocation.mortgageLump));
  if (allocation.collegeLump > 0.5) lumps.push(eur(allocation.collegeLump));
  const freed = Math.max(0, -allocation.mortgage.yearlyChange);
  const short = allocation.shortfall > 0;
  return {
    title: USE_TITLES[key] || 'Cash used a different way',
    amountLine: lumps.length === 0 ? 'Nothing from your cash' : `${lumps.join(' and ')} from your cash`,
    headline: short
      ? `You’re short by ${eur(allocation.shortfall)} a year`
      : `You have ${eur(allocation.spare)} a year to spare`,
    // The same figure as "needed this year", so the headline, the support line
    // and the case's measures never state two different needs.
    support: `Your goals need ${eur(allocation.neededThisYear)} a year `
      + `against the ${eur(H.leftOverEachYear)} you have`
      + `${freed > 0 ? `, counting the ${eur(freed)} a lower repayment frees` : ''}.`
  };
}

// -------------------------------------------------------------------- run ---

export function priceGoalCases() {
  const wholeMortgage = solveWholeMortgageLump();
  const wholeCollege = priceCollege(1);
  const pensionBase = priceRetirement(H.retirementTargets.base);
  const pensionLater = priceRetirement(H.retirementTargets.later);

  const allUses = enumerateUses(wholeMortgage, wholeCollege);
  const priced = allUses.map((use) => priceAllocation(use, wholeMortgage, wholeCollege, pensionBase));

  // Case 1 is the current position as built: the cash stays, and every goal
  // is pursued from yearly money.
  const current = priced.find((entry) => entry.mortgageLump === 0 && entry.collegeLump === 0);
  const others = chooseMostDifferent(priced, current, 3).sort(byHowMuchTheyChange);

  const cases = [current, ...others].map((allocation, index) => {
    // The later retirement option moves only the pension line, so it is
    // priced beside every case rather than attached to one of them.
    const withLater = priceAllocation(
      { mortgageLump: allocation.mortgageLump, collegeLump: allocation.collegeLump },
      wholeMortgage,
      wholeCollege,
      pensionLater
    );
    return {
      number: index + 1,
      ...allocation,
      words: caseWords(allocation),
      laterRetirement: {
        retirementAge: pensionLater.retirementAge,
        targetIncomeToday: pensionLater.targetIncomeToday,
        neededThisYear: withLater.neededThisYear,
        shortfall: withLater.shortfall,
        spare: withLater.spare,
        paidOutOverLife: withLater.paidOutOverLife,
        states: withLater.states,
        pension: withLater.pension
      }
    };
  });

  return {
    label: H.label,
    household: H,
    wholeMortgageLump: wholeMortgage,
    wholeCollege: {
      requiredToday: wholeCollege.requiredToday,
      yearlyIfNoLump: priceCollege(0).yearlyAmountNow,
      perChild: wholeCollege.perChild
    },
    mortgageToday: priceMortgage(0),
    retirement: { base: pensionBase, later: pensionLater },
    // Every use considered, in order of how much it changes. Not a ranking.
    uses: [...priced].sort(byHowMuchTheyChange),
    cases
  };
}

function report(result) {
  const lines = [];
  const out = (text = '') => lines.push(text);
  const pad = (text, width) => String(text).padEnd(width);

  out(`${result.label.toUpperCase()}`);
  out('');
  out('Household');
  out(`  Spare cash (net of the emergency reserve)  ${eur(H.spareCash)}`);
  out(`  Left over each year (stated)                ${eur(H.leftOverEachYear)}`);
  out(`  Priorities, highest first                   ${H.goalPriorities.join(', ')}`);
  out(`  Mortgage  ${eur(H.mortgage.currentBalance)} at ${(H.mortgage.annualInterestRate * 100).toFixed(1)}%, ${H.mortgage.remainingTermYears} years from ${H.mortgage.startDateIso}`);
  const today = result.mortgageToday;
  out(`            today's repayment ${eur(today.todayMonthlyPayment)} a month; ends ${today.todayPayoffDateIso}`);
  out(`            cleared by ${H.mortgage.clearByAge} = a ${today.termYears}-year term: ${eur(today.monthlyPayment)} a month with no lump sum (${signed(today.yearlyChange)} a year)`);
  out(`            the lump sum that clears it by ${H.mortgage.clearByAge} at today's repayment: ${eur(result.wholeMortgageLump)}`);
  out(`  Pensions  ${H.people.map((p) => `${p.title}: pot ${eur(p.currentPot)}, salary ${eur(p.currentSalary)}, ${(p.personalPct * 100).toFixed(0)}% and ${(p.employerPct * 100).toFixed(0)}%`).join('; ')}`);
  out(`  College   ${H.children.map((child) => `${child.title.toLowerCase()} ${child.age}`).join(', ')}; four years each from 18, living at home`);
  result.wholeCollege.perChild.forEach((child) => {
    out(`            ${pad(child.title, 13)} starts in ${child.startsInYears} years, total ${eur(child.totalCost)}, funded today by ${eur(child.requiredToday)}`);
  });
  out(`            both children funded today: ${eur(result.wholeCollege.requiredToday)}; saved yearly from today instead: ${eur(result.wholeCollege.yearlyIfNoLump)} a year`);
  out('');
  out('Retirement (household, after tax, today\'s money, State Pension included)');
  [result.retirement.base, result.retirement.later].forEach((entry) => {
    out(`  From ${entry.retirementAge} on ${eur(entry.targetIncomeToday)}: pot needed ${eur(entry.requiredPotAtToday)}, projected at today's contributions ${eur(entry.projectedPotAtToday)}`
      + `${entry.onTrackAtToday ? ' (on track)' : ''}`);
    out(`     extra a year needed: ${eur(entry.yearlyExtra)} (${(entry.extraPoints * 100).toFixed(2)} points of salary each)`
      + `${entry.reachedCap ? `; at the relief limit the pot is still short by ${eur(entry.gapLeftOver)}` : ''}`);
    if (entry.headroomYearly > 0) {
      out(`     contributions already above the target by about ${eur(entry.headroomYearly)} a year (reported, not counted as money to find)`);
    }
  });
  out('');
  out('Every way of using the cash, in order of how much it changes (not a ranking)');
  result.uses.forEach((entry) => {
    const against = entry.shortfall > 0 ? `short by ${eur(entry.shortfall)}` : `${eur(entry.spare)} to spare`;
    out(`  ${pad(caseWords(entry).amountLine, 52)} needed this year ${pad(eur(entry.neededThisYear), 9)} ${pad(against, 20)} paid out over the life ${eur(entry.paidOutOverLife.total)}`);
  });
  out('');
  out('The four cases (case 1, then the three most different uses, in order of how much they change)');
  result.cases.forEach((entry) => {
    out(`  ${entry.number}. ${entry.words.title}: ${entry.words.amountLine}`);
    out(`     ${entry.words.headline}`);
    out(`     ${entry.words.support}`);
    out(`     Money now: mortgage ${eur(entry.mortgageLump)}, college ${eur(entry.collegeLump)}, cash left ${eur(entry.cashLeft)}`);
    out(`     Needed this year ${eur(entry.neededThisYear)}  |  paid out over the life of the goals ${eur(entry.paidOutOverLife.total)}`
      + ` (mortgage ${eur(entry.paidOutOverLife.mortgage)}, college ${eur(entry.paidOutOverLife.college)}, retirement ${eur(entry.paidOutOverLife.retirement)})`);
    out(`     Mortgage repayment ${eur(entry.mortgage.monthlyPayment)} a month (${signed(entry.mortgage.yearlyChange)} a year); college ${eur(entry.college.yearlyAmountNow)} a year; retirement extra ${eur(entry.pension.yearlyExtra)} a year`);
    out(`     Goals in your order: ${H.goalPriorities.map((goal) => `${goal} ${entry.states[goal].state === 'covered' ? 'covered' : (entry.states[goal].state === 'partly' ? 'partly covered' : 'not covered')}`).join(', ')}`);
    const later = entry.laterRetirement;
    out(`     If you retire at ${later.retirementAge} on ${eur(later.targetIncomeToday)}: needed this year ${eur(later.neededThisYear)}, paid out over the life ${eur(later.paidOutOverLife.total)}`);
  });
  out('');
  out('Ledger, year by year (mortgage change, each child, pension, total, against what is left over)');
  result.cases.forEach((entry) => {
    out(`  Case ${entry.number}`);
    entry.ledger.forEach((row) => {
      const against = row.difference > 0 ? `short ${eur(row.difference)}` : `${eur(-row.difference)} to spare`;
      out(`    year ${pad(row.year, 3)} mortgage ${pad(signed(row.mortgage), 9)} child 1 ${pad(eur(row.children[0]), 8)} child 2 ${pad(eur(row.children[1]), 8)} pension ${pad(eur(row.pension), 7)} total ${pad(eur(row.total), 9)} ${against}`);
    });
  });
  return lines.join('\n');
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  const result = priceGoalCases();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${report(result)}\n`);
  }
}
