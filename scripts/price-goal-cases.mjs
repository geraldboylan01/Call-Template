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
  /** What is left over each year after everything they already pay. */
  leftOverEachYear: 6_000,

  mortgage: Object.freeze({
    currentBalance: 380_000,
    annualInterestRate: 0.04,
    startDateIso: '2026-11-01',
    remainingTermYears: 18,
    ageToday: 45,
    clearByAge: 60
  }),

  people: Object.freeze([
    Object.freeze({ id: 'niamh', title: 'Niamh', currentAge: 45, currentSalary: 90_000, currentPot: 180_000, personalPct: 0.06, employerPct: 0.06 }),
    Object.freeze({ id: 'dara', title: 'Dara', currentAge: 45, currentSalary: 60_000, currentPot: 90_000, personalPct: 0.05, employerPct: 0.05 })
  ]),

  /** Household targets: after tax, in today's money, State Pension included. */
  retirementTargets: Object.freeze({
    base: Object.freeze({ id: 'retire-62', retirementAge: 62, targetIncomeToday: 45_000 }),
    later: Object.freeze({ id: 'retire-65', retirementAge: 65, targetIncomeToday: 42_000 })
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
      savingYears: entry.savingYears
    };
  });
  return {
    lumpShare,
    lumpSumToday: perChild.reduce((sum, child) => sum + child.lumpSumToday, 0),
    yearlyAmountNow: perChild.reduce((sum, child) => sum + child.yearlyAmount, 0),
    requiredToday: perChild.reduce((sum, child) => sum + child.requiredToday, 0),
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
      personalPct: person.personalPct + extraPoints,
      employerPct: person.employerPct,
      includeStatePension: true
    }))
  };
}

function pensionGap(target, extraPoints) {
  const { debug } = computePensionProjection(pensionPayload(target, extraPoints));
  return {
    gap: debug.currentGapVsRequired,
    surplus: debug.currentSurplusVsRequired,
    requiredPot: debug.requiredPot,
    projectedPot: debug.projectedPotCurrent,
    status: debug.readinessStatus
  };
}

/**
 * The extra personal contribution, in points of salary added to BOTH people,
 * that closes the gap against the household target. Searched through the
 * engine, never solved. Capped at the age-related relief limit the engine
 * already has; any gap left at the cap is reported.
 */
export function priceRetirement(target) {
  const atToday = pensionGap(target, 0);
  const cap = Math.min(...H.people.map(
    (person) => maxRelievableContributionRatePercent(person.currentAge) / 100 - person.personalPct
  ));

  let extraPoints = 0;
  let result = atToday;
  let reachedCap = false;

  if (atToday.gap > 0) {
    const atCap = pensionGap(target, cap);
    if (atCap.gap > 0) {
      extraPoints = cap;
      result = atCap;
      reachedCap = true;
    } else {
      let low = 0;
      let high = cap;
      for (let i = 0; i < 30; i += 1) {
        const mid = (low + high) / 2;
        if (pensionGap(target, mid).gap > 0) {
          low = mid;
        } else {
          high = mid;
        }
      }
      extraPoints = high;
      result = pensionGap(target, high);
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
    if (pensionGap(target, floor).gap === 0) {
      high = floor;
    } else {
      for (let i = 0; i < 30; i += 1) {
        const mid = (low + high) / 2;
        if (pensionGap(target, mid).gap > 0) {
          low = mid;
        } else {
          high = mid;
        }
      }
    }
    lowestPoints = high;
  }

  const salaryTotal = H.people.reduce((sum, person) => sum + person.currentSalary, 0);
  const yearlyExtra = extraPoints * salaryTotal;
  return {
    id: target.id,
    retirementAge: target.retirementAge,
    targetIncomeToday: target.targetIncomeToday,
    requiredPotAtToday: atToday.requiredPot,
    projectedPotAtToday: atToday.projectedPot,
    onTrackAtToday: atToday.gap === 0,
    extraPoints,
    yearlyExtra,
    reachedCap,
    gapLeftOver: reachedCap ? result.gap : 0,
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

function priceAllocation({ mortgageLump, collegeLump }, wholeMortgage, wholeCollege, pension) {
  const mortgage = priceMortgage(mortgageLump);
  const college = priceCollege(wholeCollege.requiredToday > 0 ? collegeLump / wholeCollege.requiredToday : 0);
  const pensionYearly = pension.yearlyExtra;
  const needToday = mortgage.yearlyChange + college.yearlyAmountNow + pensionYearly;
  const difference = needToday - H.leftOverEachYear;
  return {
    mortgageLump,
    collegeLump: college.lumpSumToday,
    cashUsed: mortgageLump + college.lumpSumToday,
    cashLeft: H.spareCash - mortgageLump - college.lumpSumToday,
    use: describeUse(mortgageLump, college.lumpSumToday, wholeMortgage, wholeCollege.requiredToday),
    mortgage,
    college,
    pensionYearly,
    // What leaves the household over the whole life of the two goals: the
    // mortgage with its lump sum, and everything paid into the college fund.
    lifetimePaidOut: mortgage.totalPaidOverTheLoan + college.perChild.reduce(
      (sum, child) => sum + child.lumpSumToday + child.yearlyAmount * child.savingYears, 0
    ),
    needToday,
    shortfall: Math.max(0, difference),
    spare: Math.max(0, -difference),
    ledger: buildLedger(mortgage, college, pensionYearly)
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

// -------------------------------------------------------------------- run ---

export function priceGoalCases() {
  const wholeMortgage = solveWholeMortgageLump();
  const wholeCollege = priceCollege(1);
  const pensionBase = priceRetirement(H.retirementTargets.base);
  const pensionLater = priceRetirement(H.retirementTargets.later);

  const uses = enumerateUses(wholeMortgage, wholeCollege);
  const priced = uses
    .map((use) => priceAllocation(use, wholeMortgage, wholeCollege, pensionBase))
    .sort((a, b) => a.needToday - b.needToday);

  const current = priced.find((entry) => entry.mortgageLump === 0 && entry.collegeLump === 0);
  const alternatives = priced.filter((entry) => entry !== current).slice(0, 3);

  const caseDefinitions = [
    { id: 'current', title: 'Cash stays as it is', allocation: current, retirement: pensionBase },
    { id: 'use-1', title: null, allocation: alternatives[0], retirement: pensionBase },
    { id: 'use-2', title: null, allocation: alternatives[1], retirement: pensionBase },
    { id: 'use-3-later', title: null, allocation: alternatives[2], retirement: pensionLater }
  ];

  const cases = caseDefinitions.map((definition, index) => {
    const allocation = definition.allocation;
    // The retirement target only changes the pension line. Case 4 prices its
    // cash use again with the later target rather than reusing the 62 figure.
    const priced4 = definition.retirement === pensionBase
      ? allocation
      : priceAllocation(
        { mortgageLump: allocation.mortgageLump, collegeLump: allocation.collegeLump },
        wholeMortgage,
        wholeCollege,
        definition.retirement
      );
    return { number: index + 1, id: definition.id, title: definition.title, retirement: definition.retirement, ...priced4 };
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
    ranking: priced,
    cases
  };
}

function useWords(allocation) {
  const m = allocation.use.mortgage;
  const c = allocation.use.college;
  if (m === 'none' && c === 'none') {
    return 'Cash stays as it is';
  }
  const parts = [];
  if (m !== 'none') {
    const what = {
      part: 'into the mortgage',
      whole: `into the mortgage, enough to clear it by ${H.mortgage.clearByAge} at today's repayment`,
      over: 'into the mortgage, which takes the repayment below today\'s'
    }[m];
    parts.push(`${eur(allocation.mortgageLump)} ${what}`);
  }
  if (c !== 'none') {
    const what = {
      part: 'into the college fund',
      whole: 'into the college fund, which covers both children',
      over: 'into the college fund'
    }[c];
    parts.push(`${eur(allocation.collegeLump)} ${what}`);
  }
  return parts.join(' and ');
}

function report(result) {
  const lines = [];
  const out = (text = '') => lines.push(text);
  const pad = (text, width) => String(text).padEnd(width);

  out(`${result.label.toUpperCase()}`);
  out('');
  out('Household');
  out(`  Spare cash (net of the emergency reserve)  ${eur(H.spareCash)}`);
  out(`  Left over each year                         ${eur(H.leftOverEachYear)}`);
  out(`  Mortgage  ${eur(H.mortgage.currentBalance)} at ${(H.mortgage.annualInterestRate * 100).toFixed(1)}%, ${H.mortgage.remainingTermYears} years from ${H.mortgage.startDateIso}`);
  const today = result.mortgageToday;
  out(`            today's repayment ${eur(today.todayMonthlyPayment)} a month; ends ${today.todayPayoffDateIso}`);
  out(`            cleared by ${H.mortgage.clearByAge} = a ${today.termYears}-year term: ${eur(today.monthlyPayment)} a month with no lump sum (${signed(today.yearlyChange)} a year)`);
  out(`            the lump sum that clears it by ${H.mortgage.clearByAge} at today's repayment: ${eur(result.wholeMortgageLump)}`);
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
    out(`     extra a year needed: ${eur(entry.yearlyExtra)}${entry.reachedCap ? `; at the relief limit, pot still short by ${eur(entry.gapLeftOver)}` : ''}`);
    if (entry.headroomYearly > 0) {
      out(`     contributions already above the target by about ${eur(entry.headroomYearly)} a year (reported, not counted as money to find)`);
    }
  });
  out('');
  out('Every way of using the cash, by yearly need today (lowest first)');
  result.ranking.forEach((entry) => {
    const against = entry.shortfall > 0 ? `short by ${eur(entry.shortfall)}` : `${eur(entry.spare)} to spare`;
    out(`  ${useWords(entry)}`);
    out(`     mortgage ${signed(entry.mortgage.yearlyChange)} a year, college ${eur(entry.college.yearlyAmountNow)} a year, need ${eur(entry.needToday)}: ${against}`
      + `; paid out over the life of both goals ${eur(entry.lifetimePaidOut)}`);
  });
  out('');
  out('The four cases');
  result.cases.forEach((entry) => {
    const against = entry.shortfall > 0 ? `short by ${eur(entry.shortfall)} a year` : `${eur(entry.spare)} a year to spare`;
    out(`  ${entry.number}. ${useWords(entry)}`);
    out(`     Retire at ${entry.retirement.retirementAge} on ${eur(entry.retirement.targetIncomeToday)}; pension need ${eur(entry.pensionYearly)} a year`);
    out(`     Money now: mortgage ${eur(entry.mortgageLump)}, college ${eur(entry.collegeLump)}, cash left ${eur(entry.cashLeft)}`);
    out(`     Mortgage repayment ${eur(entry.mortgage.monthlyPayment)} a month (${signed(entry.mortgage.yearlyChange)} a year); college ${eur(entry.college.yearlyAmountNow)} a year; need ${eur(entry.needToday)} against ${eur(H.leftOverEachYear)}: ${against}`);
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
