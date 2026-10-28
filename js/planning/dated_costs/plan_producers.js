import { PLANEIR_ASSUMPTIONS } from '../planeir_assumptions.js';
import { PlanPackError } from '../plan_pack/schema.js';
import { planWorkingShares } from '../plan_pack/working_shares.js';
import { produceCollegeCost } from './college_funding.js';
import { produceFutureCostFundCost } from './future_cost_fund.js';

function missing(path, message) { throw new PlanPackError(path, message, 'missing_information'); }
function euros(value) {
  if (value?.currency !== 'EUR' || !Number.isFinite(value.amount)) missing('/household/goals/targetAmount', 'Supply a stated EUR cost.');
  return value.amount;
}

// Module-specific input bindings live with the producers. The ledger only sees
// a producer, its common contract and the cash already assigned to that goal.
export function planDatedCostProducer(context, pack, goal) {
  const fact = pack.planningInputs.goalFundingFacts.find(row => row.goalId === goal.goalId);
  if (!(goal.type === 'fund_education' || (goal.type === 'assess_decision' && fact?.kind === 'dated_cost'))) return null;
  if (fact?.currentAnnualSaving === undefined) missing('/planningInputs/goalFundingFacts', 'State current annual saving for ' + goal.goalId + ', including confirmed zero.');
  if (pack.planningInputs.goalSavingBasis !== 'excluded_from_regular_costs') missing('/planningInputs/goalSavingBasis', 'Confirm regular costs exclude goal transfers and stated left over is before those transfers.');
  const year = Number(pack.calculationDate.slice(0, 4));
  const workingShares = context.workingShares ?? planWorkingShares(pack, context.profile);
  const payerIds = fact.payerIds ?? workingShares.filter(row => row.share > 0).map(row => row.personId);
  if (!payerIds.length) missing('/planningInputs/goalFundingFacts', 'Name the payers of this dated cost.');
  const payerRetirements = payerIds.map(personId => {
    const payer = workingShares.find(row => row.personId === personId);
    return { personId, stopsFromYear: payer.stopsFromYear };
  });
  const common = { calculationDate: pack.calculationDate, costId: goal.goalId, goalId: goal.goalId, payerIds, payerRetirements };
  let input, produce;
  if (goal.type === 'fund_education' && fact.kind !== 'dated_cost') {
    const child = context.profile.dependants.find(row => row.dependantId === fact.dependantId);
    if (!child || !Number.isInteger(child.currentAge)) missing('/planningInputs/goalFundingFacts', 'Bind each college goal to one child with a stated age.');
    const central = PLANEIR_ASSUMPTIONS.collegeFunding;
    const selected = context.profile.assumptions.values.collegeFunding?.scenarioByChild?.[child.dependantId] ?? 'living_at_home';
    const scenario = central.scenarios.find(row => row.id === selected);
    if (!scenario) missing('/household/assumptions/values/collegeFunding/scenarioByChild', 'Select an approved college-cost scenario.');
    input = { costTitle: goal.title, costKind: 'education',
      startsInYears: goal.targetDate ? Number(goal.targetDate.slice(0, 4)) - year : central.startAge - child.currentAge,
      durationYears: central.durationYears, annualCostToday: goal.targetAmount ? euros(goal.targetAmount) : scenario.annualCostTodayPerChild };
    const collegeInput = { currentYear: year, inflationRate: PLANEIR_ASSUMPTIONS.inflation.educationRate,
      children: [{ id: child.dependantId, title: child.displayName ?? child.dependantId, currentAge: child.currentAge,
        collegeStartAge: child.currentAge + input.startsInYears, collegeDurationYears: input.durationYears }],
      scenarios: [{ ...scenario, annualCostTodayPerChild: input.annualCostToday }] };
    produce = cashToday => produceCollegeCost({ ...common, title: goal.title, input: collegeInput, scenarioId: selected, cashToday, funding: fact.funding ?? 'save_then_pay' });
  } else {
    if (!goal.targetDate || !goal.targetAmount || !fact.durationYears || !fact.costKind) missing('/planningInputs/goalFundingFacts', 'A dated cost needs its goal amount/date, cost kind and duration.');
    input = { costTitle: goal.title, costKind: fact.costKind, startsInYears: Number(goal.targetDate.slice(0, 4)) - year,
      durationYears: fact.durationYears, annualCostToday: euros(goal.targetAmount) };
    produce = cashToday => produceFutureCostFundCost({ ...common, input, cashToday, ...(fact.funding ? { funding: fact.funding } : {}) });
  }
  return { input, currentAnnualSaving: fact.currentAnnualSaving, produce(cashToday) {
    const contract = produce(cashToday);
    contract.provenance.planCostInput = { ...input };
    contract.provenance.payerBasis = fact.payerIds ? 'stated_goal_payers' : 'household_positive_income_shares';
    return contract;
  } };
}
