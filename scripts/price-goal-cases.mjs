#!/usr/bin/env node

/**
 * ILLUSTRATIVE HOUSEHOLD, NOT REAL FIGURES.
 *
 * Prices every way of using today's cash against a mortgage, college for each
 * child and retirement, and prints the four cases the Goals and resources
 * screen shows. It is a thin caller: the work is done by
 * `js/goals_and_resources_math.js`, so there is one implementation.
 *
 * Every case carries "needed this year" and "paid out over the life of the
 * goals" side by side. Neither orders the cases.
 *
 * Usage:
 *   node scripts/price-goal-cases.mjs            readable report
 *   node scripts/price-goal-cases.mjs --json     the same, as JSON
 *
 * The household is the constant below. Change it there; nothing is read from a
 * client record, and none of it is a client's.
 */

import { computeGoalsAndResourcesProjection } from '../js/goals_and_resources_math.js';

const ILLUSTRATIVE_LABEL = 'Illustrative household, not real figures';

const ILLUSTRATIVE_HOUSEHOLD = Object.freeze({
  /** Spare cash, already net of the emergency reserve. */
  spareCash: 60_000,
  /**
   * What is left over each year. STATED for Stage 1. In a plan it will be the
   * Household cash flow result's left-over figure.
   */
  leftOverEachYear: 6_000,
  /** Married, jointly assessed. */
  householdTaxStatus: 'married_or_civil_partners',
  mortgage: Object.freeze({
    currentBalance: 380_000,
    annualInterestRate: 0.04,
    startDateIso: '2026-11-01',
    remainingTermYears: 18,
    currentAge: 45,
    clearByAge: 60
  }),
  pensions: Object.freeze([
    Object.freeze({ id: 'niamh', title: 'Niamh', currentAge: 45, currentSalary: 90_000, currentPot: 100_000, personalPct: 0.05, employerPct: 0.05, includeStatePension: true }),
    Object.freeze({ id: 'dara', title: 'Dara', currentAge: 45, currentSalary: 60_000, currentPot: 40_000, personalPct: 0.04, employerPct: 0.04, includeStatePension: true })
  ]),
  /** Household targets: after tax, in today's money, State Pension included. */
  retirement: Object.freeze({ retirementAge: 62, targetIncomeToday: 50_000 }),
  laterRetirement: Object.freeze({ retirementAge: 65, targetIncomeToday: 46_000 }),
  /** College timing and cost are the central assumptions. */
  children: Object.freeze([
    Object.freeze({ id: 'child-1', title: 'First child', age: 10 }),
    Object.freeze({ id: 'child-2', title: 'Second child', age: 8 })
  ])
});

const eur = (amount) => `${amount < 0 ? '−' : ''}€${Math.abs(Math.round(amount)).toLocaleString('en-IE')}`;
const signed = (amount) => `${amount < 0 ? '−' : '+'}${eur(Math.abs(amount))}`;

function priceGoalCases(options = {}) {
  return computeGoalsAndResourcesProjection(ILLUSTRATIVE_HOUSEHOLD, { includeHeadroom: true, ...options });
}

function report(projection) {
  const { debug } = projection;
  const H = ILLUSTRATIVE_HOUSEHOLD;
  const lines = [];
  const out = (text = '') => lines.push(text);
  const pad = (text, width) => String(text).padEnd(width);

  out(ILLUSTRATIVE_LABEL.toUpperCase());
  out('');
  out('Household');
  out(`  Spare cash (net of the emergency reserve)  ${eur(H.spareCash)}`);
  out(`  Left over each year (stated)                ${eur(H.leftOverEachYear)}`);
  out('  Goals are taken in this order               each child\'s college by start date, the mortgage, retirement');
  out(`  Tax                                         ${H.householdTaxStatus.replace(/_/g, ' ')}, assessed jointly`);
  out(`  Mortgage  ${eur(H.mortgage.currentBalance)} at ${(H.mortgage.annualInterestRate * 100).toFixed(1)}%, ${H.mortgage.remainingTermYears} years from ${H.mortgage.startDateIso}`);
  const today = debug.mortgageToday;
  out(`            today's repayment ${eur(today.todayMonthlyPayment)} a month; ends ${today.todayPayoffDateIso}`);
  out(`            cleared by ${H.mortgage.clearByAge} = a ${today.termYears}-year term: ${eur(today.monthlyPayment)} a month with no lump sum (${signed(today.yearlyChange)} a year)`);
  out(`            the lump sum that clears it by ${H.mortgage.clearByAge} at today's repayment: ${eur(debug.wholeMortgageLump)}`);
  out(`  Pensions  ${H.pensions.map((p) => `${p.title}: pot ${eur(p.currentPot)}, salary ${eur(p.currentSalary)}, ${(p.personalPct * 100).toFixed(0)}% and ${(p.employerPct * 100).toFixed(0)}%`).join('; ')}`);
  out(`  College   ${H.children.map((child) => `${child.title.toLowerCase()} ${child.age}`).join(', ')}; four years each from 18, living at home`);
  debug.wholeCollege.perChild.forEach((child) => {
    out(`            ${pad(child.title, 13)} starts in ${child.startsInYears} years, total ${eur(child.totalCost)}, funded today by ${eur(child.requiredToday)}`);
  });
  out(`            both children funded today: ${eur(debug.wholeCollege.requiredToday)}; saved yearly from today instead: ${eur(debug.wholeCollege.yearlyIfNoLump)} a year`);
  out('');
  out('Retirement (household, after tax, today\'s money, State Pension included)');
  [debug.retirement.base, debug.retirement.later].filter(Boolean).forEach((entry) => {
    out(`  From ${entry.retirementAge} on ${eur(entry.targetIncomeToday)}: pot needed ${eur(entry.requiredPotAtToday)}, projected at today's contributions ${eur(entry.projectedPotAtToday)}`
      + `${entry.onTrackAtToday ? ' (on track)' : ''}`);
    out(`     extra paid in (gross) ${eur(entry.yearlyExtra)} a year (${(entry.extraPoints * 100).toFixed(2)} points of salary each)`
      + `${entry.reachedCap ? `; at the relief limit the pot is still short by ${eur(entry.gapLeftOver)}` : ''}`);
    out(`     income tax relief on it ${eur(entry.yearlyExtraTaxRelief)}, so it costs you ${eur(entry.yearlyExtraCost)} a year`);
    if (entry.headroomYearly > 0) {
      out(`     contributions already above the target by about ${eur(entry.headroomYearly)} a year gross (reported, not counted as money to find)`);
    }
  });
  out('');
  out('Every way of using the cash, in order of how much it changes (not a ranking)');
  debug.uses.forEach((entry) => {
    const against = entry.shortfall > 0 ? `short by ${eur(entry.shortfall)}` : `${eur(entry.spare)} to spare`;
    const lumps = [];
    if (entry.mortgageLump > 0.5) lumps.push(`${eur(entry.mortgageLump)} to the mortgage`);
    if (entry.collegeLump > 0.5) lumps.push(`${eur(entry.collegeLump)} to college`);
    out(`  ${pad(lumps.length ? lumps.join(' and ') : 'Nothing from your cash', 44)} needed this year ${pad(eur(entry.neededThisYear), 9)} ${pad(against, 20)} paid out over the life ${eur(entry.paidOutOverLife.total)}`);
  });
  out('');
  out('The four cases (case 1, then the three most different uses, in order of how much they change)');
  debug.cases.forEach((entry) => {
    out(`  ${entry.number}. ${entry.words.title} [${entry.id}]: ${entry.words.amountLine}`);
    out(`     ${entry.words.headline}`);
    out(`     ${entry.words.support}`);
    out(`     Money now: mortgage ${eur(entry.mortgageLump)}, college ${eur(entry.collegeLump)}, cash left ${eur(entry.cashLeft)}`);
    out(`     Needed this year ${eur(entry.neededThisYear)}  |  paid out over the life of the goals ${eur(entry.paidOutOverLife.total)}`
      + ` (mortgage ${eur(entry.paidOutOverLife.mortgage)}, college ${eur(entry.paidOutOverLife.college)}, retirement after relief ${eur(entry.paidOutOverLife.retirement)})`);
    out(`     Mortgage repayment ${eur(entry.mortgage.monthlyPayment)} a month (${signed(entry.mortgage.yearlyChange)} a year); college ${eur(entry.college.yearlyAmountNow)} a year; retirement extra ${eur(entry.pension.yearlyExtraCost)} a year after relief (${eur(entry.pension.yearlyExtra)} gross)`);
    out(`     Goals in order: ${entry.states.map((goal) => `${goal.title.toLowerCase()} ${goal.stateWord.toLowerCase()}`).join('; ')}`);
    const later = entry.laterRetirement;
    if (later) {
      out(`     If you retire at ${later.retirementAge} on ${eur(later.targetIncomeToday)}: needed this year ${eur(later.neededThisYear)}, paid out over the life ${eur(later.paidOutOverLife.total)}`);
    }
  });
  out('');
  out('Ledger, year by year (mortgage change, each child, pension after relief, total, against what is left over)');
  debug.cases.forEach((entry) => {
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
  const projection = priceGoalCases();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ label: ILLUSTRATIVE_LABEL, household: ILLUSTRATIVE_HOUSEHOLD, ...projection }, null, 2)}\n`);
  } else {
    process.stdout.write(`${report(projection)}\n`);
  }
}
