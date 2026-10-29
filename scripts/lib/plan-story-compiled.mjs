// Entirely made-up households, compiled by the real compiler, and stories written for them. Used by
// check:plan-story and check:plan-story-browser; nothing here is a client's.
//
// A story is words and placeholders only. Every key below is a fact `readPlanPosition` produces for the
// household, so the screen can fill it, link it and say where it comes from.

import { readFileSync } from 'node:fs';
import { compilePlanPack } from '../../js/planning/plan_pack/compiler.js';
import { applicationToProfile } from '../../js/planning/application_to_profile.js';
import { profileToPlanPack } from '../../js/planning/profile_to_plan_pack.js';

const quiet = async (work) => {
  // The engines log their own diagnostics; a check's output should be its own.
  const { info, warn, log } = console;
  console.info = console.warn = console.log = () => {};
  try { return await work(); } finally { Object.assign(console, { info, warn, log }); }
};

/** Niamh and Dara, with a car loan, a mortgage, college and retirement: a current position and three alternatives. */
export async function compileMadeUpCouple() {
  const pack = JSON.parse(readFileSync(new URL('../fixtures/plan-packs/valid-b1.json', import.meta.url), 'utf8'));
  const compiled = await quiet(() => compilePlanPack(pack, { resourceLedger: true }));
  if (compiled.status !== 'compiled') throw new Error(`The made-up couple did not compile: ${JSON.stringify(compiled.diagnostics)}`);
  return compiled;
}

/** #97's made-up borrower with loans and a card, from the form: stated figures with form questions. Current position only. */
export async function compileMadeUpBorrower() {
  const fixtures = JSON.parse(readFileSync(new URL('../fixtures/form-to-profile.households.json', import.meta.url), 'utf8'));
  const fixture = fixtures.find((row) => row.id === 'fictional-borrower-with-card');
  const profile = applicationToProfile(fixture.information, { revision: 7, confirmedAt: '2026-10-20T12:00:00.000Z', calculationDateIso: '2026-10-20', profileId: `profile_${fixture.id}` });
  const assembly = await quiet(() => profileToPlanPack(profile, { confirmedRevision: 7, clientLabel: fixture.id }));
  const compiled = await quiet(() => compilePlanPack(assembly.planPack, assembly.compileOptions));
  if (compiled.status !== 'compiled') throw new Error(`The made-up borrower did not compile: ${JSON.stringify(compiled.diagnostics)}`);
  return compiled;
}

const parts = (does, why, gives, costs, check) => ({ does, why, gives, costs, check });

const GOAL_IDS = ['goal_loan', 'college', 'goal_mortgage', 'goal_retirement'];
const goalSubsections = () => GOAL_IDS.map((id) => ({
  goalId: id,
  title: `{goals.${id}.title}`,
  parts: parts(
    `This goal is funded through: {goals.${id}.chosenWay}.`,
    `The plan funds {goals.${id}.title} in the order the method sets.`,
    `Its state in this route is {goals.${id}.state}.`,
    `This route puts {goals.${id}.routeCash} of cash and {goals.${id}.routeYearly} a year towards it.`,
    'Whether the date and amount you gave us for this goal are still right.'
  )
}));

/**
 * The made-up couple's story for `current` or for the alternative that clears the car loan. The two differ
 * only where a comparison with today makes sense.
 */
export function madeUpCoupleStory(routeId) {
  const current = routeId === 'current';
  return {
    routeId,
    headline: current
      ? 'Where you are today: {@position.netWorth} of net worth and {position.leftOver} left over each year'
      : 'This route uses {vsCurrent.cashUsed} of cash and leaves {leftOverAfterGoals.yearly} a year after every goal',
    summary: current
      ? 'Your reserve is {position.reserve}, and {position.spareCash} sits above it.'
      : 'Your net worth is {@position.netWorth}, {vsCurrent.netWorthWord} from today.',
    sections: [
      { id: 'current_position', title: 'Where you are now', parts: parts(
        'This section starts from where you are today.',
        'Your cash reserve is {position.reserve}, which covers {position.reserveMonths} months of spending{?explainer.emergency_reserve}.',
        'You have {@current.position.netWorth} of net worth, {current.position.leftOver} left over each year and {current.position.spareCash} above your reserve.',
        current ? 'Nothing is used yet; this is today’s position.' : 'Clearing the car loan uses {vsCurrent.cashUsed} of your cash.',
        'Whether the figures you gave us for your income and spending are still right.') },
      { id: 'ledger', title: 'Your goals and what funds them', parts: parts(
        'The plan funds your goals one at a time, from the money available.',
        'The order is {goals.goal_loan.title}, then {goals.college.title}, then {goals.goal_mortgage.title}, then {goals.goal_retirement.title}.',
        'After your reserve, {steps.reserve.cashAfter} of spare cash and {steps.reserve.surplusAfter} of yearly surplus are available.',
        'After every goal is funded, {cashAfterGoals} of cash and {leftOverAfterGoals.yearly} a year remain.',
        'Whether the order suits what matters most to you.') },
      { id: 'protecting', title: 'If an income stops', parts: parts(
        'This section looks at your reserve and at what happens if an income stops.',
        'The protection figures show the gap each year and how long your savings last.',
        'If Niamh stopped working, the yearly gap would be {@protection.niamh_stops.gap} and your savings would last {@protection.niamh_stops.months} months{?explainer.illness_benefit}.',
        current ? 'Your reserve of {position.reserve} is the first cash used.'
          : 'Your savings would last {vsCurrent.protection.niamh_stops.monthsWord} time than today.',
        'Whether cover through work would change these figures.') },
      { id: 'inefficiencies', title: 'Borrowing and cash', parts: parts(
        'This section covers {issues.idle_cash_vs_debt.headline}.',
        'Your home loan costs {issues.idle_cash_vs_debt.home_loan.loanRate}, while cash earns {issues.idle_cash_vs_debt.home_loan.cashRateAfterTax} after tax{?explainer.dirt}.',
        'Holding {issues.idle_cash_vs_debt.home_loan.comparedAmount} in cash rather than against the loan is a yearly difference of {issues.idle_cash_vs_debt.home_loan.yearlyDifference}.',
        'DIRT is charged on deposit interest at {figure.ie.dirt.2026.rate}.',
        'Whether paying a lump sum into the loan would carry a charge.') },
      { id: 'goals', title: 'Your goals, in order', parts: parts(
        'Each goal is shown in the order the plan funds it.',
        'Loans come first, then dated costs soonest first, then the mortgage, then retirement.',
        'College is {goals.college.state} and the mortgage is {goals.goal_mortgage.state}.',
        'The yearly money towards college and the mortgage is {goals.college.routeYearly} and {goals.goal_mortgage.routeYearly}.',
        'Whether the dates you gave us for each goal are still right.'), goals: goalSubsections() },
      { id: 'cash_flow_after', title: 'Your yearly cash flow after the goals', parts: parts(
        'This section shows the yearly money left once every goal is funded.',
        'The plan takes each goal’s yearly funding from your surplus.',
        '{leftOverAfterGoals.yearly} a year is left over, which is about {leftOverAfterGoals.monthly} a month.',
        'Money from the mortgage is freed from {freed.home_loan.fromYear}, adding {freed.home_loan.amount} a year.',
        'The surplus stops being earned from {retirement.niamh.fromYear} for Niamh and {retirement.dara.fromYear} for Dara; whether those years are right is worth checking{?explainer.pension_tax_relief}.') },
      { id: 'net_worth_after', title: 'Your net worth', parts: parts(
        'This section shows net worth after the route’s changes.',
        'Net worth is what you own less what you owe.',
        current ? 'Your net worth is {@position.netWorth}, with {position.grossAssets} of assets.'
          : 'Your net worth is {@position.netWorth}, {vsCurrent.netWorthWord} from today.',
        current ? 'Nothing changes in the current position.' : 'Cash used to clear a loan leaves savings but also reduces what you owe.',
        'Whether the values you gave us for your assets are still right.') },
      { id: 'risks', title: 'What could go wrong', parts: parts(
        current ? 'The current position changes nothing, so it has no change to test.' : 'The main change is using cash to clear the car loan.',
        'Using cash leaves less to fall back on.',
        'After every goal, {cashAfterGoals} of cash remains.',
        current ? 'No change is made, so no extra cash is used.' : '{vsCurrent.cashUsed} {vsCurrent.cashUsedWord} cash is used than today.',
        'Whether an unexpected cost could be met from the cash that remains.') },
      { id: 'check_next', title: 'What to check next', parts: parts(
        'These are the points to look at next.',
        'Each comes from the facts above.',
        'The mortgage could end in {issues.mortgage_could_be_shorter.home_loan.endDateWithCash} instead of {issues.mortgage_could_be_shorter.home_loan.endDate} if spare cash were applied.',
        'Applying cash to the mortgage means it is no longer available as savings.',
        'Whether your lender allows lump sums and what it would charge.') }
    ]
  };
}

/** A short story for the made-up borrower, whose figures were stated on the form. */
export function madeUpBorrowerStory() {
  const filler = (id, title) => ({ id, title, parts: parts('This section follows the facts below.', 'It comes from what you told us.', 'Nothing more is shown here.', 'Nothing is used.', 'Whether your answers are still right.') });
  return {
    routeId: 'current',
    headline: 'Your first loan is {issues.debts_other_than_mortgage.liability_application_loan_0.balance} at {issues.debts_other_than_mortgage.liability_application_loan_0.rate}',
    summary: 'This is the position you described on the form.',
    sections: [
      { id: 'current_position', title: 'Where you are now', parts: parts(
        'This section starts from your answers.',
        'Your net worth is {@position.netWorth}.',
        'You have {position.spareCash} of spare cash.',
        'Nothing is used yet.',
        'Whether your answers are still right.') },
      filler('ledger', 'Your goals'),
      filler('protecting', 'If an income stops'),
      { id: 'inefficiencies', title: 'Borrowing', parts: parts(
        'This section covers your loans and card.',
        'Your first loan has a balance of {issues.debts_other_than_mortgage.liability_application_loan_0.balance}{?explainer.dirt}.',
        'Its rate is {issues.debts_other_than_mortgage.liability_application_loan_0.rate}.',
        'Interest is part of what each loan costs.',
        'Whether the balances and rates you gave us are current.') },
      { ...filler('goals', 'Your goals'), goals: [] },
      filler('cash_flow_after', 'Cash flow'),
      filler('net_worth_after', 'Net worth'),
      filler('risks', 'Risks'),
      filler('check_next', 'What to check next')
    ]
  };
}
