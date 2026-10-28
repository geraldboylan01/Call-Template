import { getPlanningModuleDefinition } from '../module_registry.js';
import { buildPublishedSessionFromCall } from '../session_payload.js';
import { hasOwnerConfirmedNone } from '../profile.js';
import { cloneJson } from '../utils.js';
import { computeHouseholdCashFlowProjection } from '../../household_cash_flow_math.js';
import { computeProtectionGapProjection } from '../../protection_gap_math.js';
import { computeMortgageComparison } from '../../mortgage_math.js';
import { computePensionProjection } from '../../pension_math.js';
import { computeNetRetirementProjection } from '../../net_retirement_math.js';
import { computeFutureCostFundProjection } from '../../future_cost_fund_math.js';
import { planDatedCostProducer } from '../dated_costs/plan_producers.js';
import { finiteJson, PlanPackError, fail } from './schema.js';
import { statedEssentialAnnual } from './lever_catalogue.js';
import { applyPropertyMove, PROPERTY_LEVERS } from './property_moves.js';

export class LaterStage extends PlanPackError {
  constructor(path, message, stage = 'B2', code = 'requires_profile_adapter') {
    super(path, message, code);
    this.stage = stage;
  }
}
export function missing(path, message) { throw new PlanPackError(path, message, 'missing_information'); }
export { people, ownerBankPay } from './working_shares.js';
import { people, ownerBankPay } from './working_shares.js';
function amount(value, path) {
  if (!value || value.currency !== 'EUR' || !Number.isFinite(value.amount)) missing(path, 'A stated EUR amount is required; no currency conversion or missing value is inferred.');
  return value.amount;
}
const toCents = value => Math.round(value * 100) / 100;
const retirementTypes = ['retire', 'retire_early', 'improve_pension'];
export function routeContext(pack, route, index, { fundingGoalIds = new Set(), allowGoalMoves = false, saleResult = null, propertyMove = null } = {}) {
  const profile = cloneJson(pack.household);
  const original = pack.household;
  const inputs = pack.planningInputs;
  const cashByLiability = Object.create(null);
  const changedFacts = [];
  const movedGoals = [];
  const goalOverrides = Object.create(null);
  const goalCashReserved = Object.create(null);
  let cashUsed = 0;
  let reservedCash = 0;
  let spendingRemoved = 0;
  let spendingReduction = 0;
  let spendingReductionPath;
  const pensionContributions = [];
  const changes = route.changes;
  const liabilityChanges = new Set();
  const retirementChanges = new Set();
  let cashAssetId = inputs.cashAssetId;
  applyPropertyMove(profile, propertyMove, cashAssetId);
  const propertySpendingRemoved = propertyMove?.offset === 0 ? propertyMove.debts.reduce((sum, d) => sum + d.annualPayment, 0) + (propertyMove.rental?.running ?? 0) : 0;
  if (propertyMove?.offset === 0) for (const debt of propertyMove.debts) cashByLiability[debt.liabilityId] = debt.balance;
  if (saleResult?.sales.length) {
    const cash = cashAssetId ? profile.assets.find(a => a.assetId === cashAssetId) : profile.assets.filter(a => a.type === 'cash').length === 1 ? profile.assets.find(a => a.type === 'cash') : null;
    if (!cash) missing('/planningInputs/cashAssetId', 'Name the cash account receiving sale proceeds.');
    cashAssetId = cash.assetId;
    cash.currentValue = { amount: amount(cash.currentValue, '/household/assets/' + profile.assets.indexOf(cash) + '/currentValue') + saleResult.netProceeds, currency: 'EUR' };
    for (const sale of saleResult.sales) profile.assets.find(a => a.assetId === sale.assetId).currentValue.amount = 0;
  }
  for (const [ci, change] of changes.entries()) {
    const path = '/routes/' + index + '/changes/' + ci;
    const goal = profile.goals.find(g => g.goalId === change.goalId);
    const binding = inputs.goalBindings.find(b => b.goalId === change.goalId);
    if (PROPERTY_LEVERS.includes(change.type)) {
      if (!propertyMove) throw new LaterStage(path, 'Property levers require the full B1 ledger.', 'B1', 'requires_resource_ledger');
      changedFacts.push({ source: path, propertyId: propertyMove.propertyId, year: propertyMove.year, cashReleased: propertyMove.cashReleased });
      continue;
    }
    if (change.type === 'pensionContribution') {
      if (!allowGoalMoves) throw new LaterStage(path, 'Contribution levers require the full B1 ledger.', 'B1', 'requires_resource_ledger');
      pensionContributions.push({ personId: change.personId, annualAmount: change.annualAmount, source: path });
      changedFacts.push({ source: path, personId: change.personId, grossAnnualContribution: change.annualAmount });
      continue;
    }
    if (change.type === 'spendLess') {
      if (!allowGoalMoves) throw new LaterStage(path, 'Spending levers require the full B1 ledger.', 'B1', 'requires_resource_ledger');
      spendingReduction = change.annualAmount;
      spendingReductionPath = path + '/annualAmount';
      changedFacts.push({ source: path, annualSpendingReduction: change.annualAmount });
      continue;
    }
    if (change.type === 'sellAsset') {
      if (!saleResult) throw new LaterStage(path, 'Investment-sale funding requires the B1 ledger.', 'B1', 'requires_resource_ledger');
      changedFacts.push({ source: path, assetId: change.assetId, sale: saleResult.sales.find(s => s.assetId === change.assetId) });
      continue;
    }
    if (change.type === 'moveGoal') {
      if (!movedGoals.includes(goal.goalId)) movedGoals.push(goal.goalId);
      for (const [key, value] of Object.entries(change)) {
        if (['type', 'goalId', 'sources'].includes(key)) continue;
        if (key === 'retirementAge') {
          if (!retirementTypes.includes(goal.type)) fail(path + '/' + key, 'retirementAge requires a retirement goal.');
          const owner = binding?.personId ?? (people(profile).length === 1 ? profile.primaryPerson.personId : null);
          const person = people(profile).find(p => p.personId === owner);
          if (!person) missing('/planningInputs/goalBindings', 'Name the person whose retirement age this goal changes.');
          if (value < person.age || value > 100) fail(path + '/' + key, 'must be between the current age and 100.');
          if (retirementChanges.has(person.personId)) fail(path + '/' + key, 'two goals cannot change the same person retirement age in one route.');
          retirementChanges.add(person.personId);
          person.intendedRetirementAge = value;
        } else if (key === 'targetIncomeToday' || key === 'targetAmount') {
          if (!retirementTypes.includes(goal.type) && !allowGoalMoves) throw new LaterStage(path + '/' + key, 'Changing this funding target needs its B1 pricing builder.', 'B1', 'requires_resource_ledger');
          goal.targetAmount = { amount: value, currency: 'EUR' };
        } else {
          // A date/clear-by-age goal needs the resource ledger to price its
          // required repayment/funding path. Do not alter contractual debt terms.
          if (!allowGoalMoves) throw new LaterStage(path + '/' + key, 'Moving a dated funding or mortgage target requires its B1 funding builder.', 'B1', 'requires_resource_ledger');
          goalOverrides[goal.goalId] ??= {};
          goalOverrides[goal.goalId][key] = value;
          if (key === 'targetDate') goal.targetDate = value;
        }
        changedFacts.push({ source: path + '/' + key, goalId: goal.goalId, field: key, value });
      }
      continue;
    }
    let liabilityId;
    let cash;
    if (change.type === 'clearOutgoing') {
      liabilityId = inputs.outgoingBindings.find(b => b.id === change.outgoingId).liabilityId;
      const loan = profile.liabilities.find(l => l.liabilityId === liabilityId);
      cash = amount(loan.currentBalance, '/household/liabilities/' + profile.liabilities.indexOf(loan) + '/currentBalance');
    } else {
      if (typeof change.amount !== 'number') throw new LaterStage(path + '/amount', 'whole and remaining need B1 to resolve a funding amount.', 'B1', 'requires_resource_ledger');
      if (fundingGoalIds.has(change.goalId)) {
        goalCashReserved[change.goalId] = change.amount;
        reservedCash += change.amount;
        cashUsed += change.amount;
        changedFacts.push({ source: path, goalId: change.goalId, cashReserved: change.amount });
        continue;
      }
      if (!binding?.liabilityId) throw new LaterStage(path + '/goalId', 'Cash funding for this goal needs its B1 resource-ledger builder.', 'B1', 'requires_resource_ledger');
      liabilityId = binding.liabilityId;
      cash = change.amount;
    }
    if (liabilityChanges.has(liabilityId)) fail(path, 'the same liability is funded twice in this route.');
    liabilityChanges.add(liabilityId);
    const loan = profile.liabilities.find(l => l.liabilityId === liabilityId);
    if (!['mortgage', 'loan', 'credit_card'].includes(loan.type)) throw new LaterStage(path, 'This liability needs an explicit funding builder.', 'B1', 'requires_resource_ledger');
    const balance = amount(loan.currentBalance, '/household/liabilities/' + profile.liabilities.indexOf(loan) + '/currentBalance');
    if (cash > balance) fail(path, 'cash used exceeds the outstanding liability; it is not silently capped.');
    loan.currentBalance.amount = balance - cash;
    cashByLiability[liabilityId] = cash;
    cashUsed += cash;
    if (!Number.isFinite(cashUsed)) fail(path, 'cash used overflows.');
    if (loan.currentBalance.amount === 0) {
      const payment = amount(loan.monthlyPayment, '/household/liabilities/' + profile.liabilities.indexOf(loan) + '/monthlyPayment');
      spendingRemoved += payment * 12;
      loan.monthlyPayment.amount = 0;
    }
    changedFacts.push({ source: path, liabilityId, cashUsed: cash });
  }
  if (cashUsed > 0) {
    const candidates = profile.assets.filter(a => a.type === 'cash');
    const asset = cashAssetId
      ? candidates.find(a => a.assetId === cashAssetId)
      : candidates.length === 1 ? candidates[0] : null;
    if (!asset) missing('/planningInputs/cashAssetId', 'Choose the cash account funding this route; multiple accounts are never selected by array order.');
    const cash = amount(asset.currentValue, '/household/assets/' + profile.assets.indexOf(asset) + '/currentValue');
    if (cash < cashUsed) fail('/routes/' + index, 'cash used exceeds the named cash account.');
    cashAssetId = asset.assetId;
    asset.currentValue.amount = cash - (cashUsed - reservedCash);
  }
  if (spendingRemoved > 0 || spendingReduction > 0) {
    const spending = amount(profile.expenses.annualTotal, '/household/expenses/annualTotal');
    if (spending < spendingRemoved) fail('/household/expenses/annualTotal', 'must include the contractual debt payments being cleared.');
    if (spendingReduction > 0 && spending - spendingRemoved - spendingReduction < statedEssentialAnnual(original) - 0.005) fail(spendingReductionPath, 'After debt clearances this reduction would take spending below stated essentials.');
    spendingRemoved += spendingReduction;
    profile.expenses.annualTotal.amount = spending - spendingRemoved;
  }
  spendingRemoved += propertySpendingRemoved;
  if (spendingReduction > 0 && propertyMove?.offset > 0) {
    const futureRemoval = propertyMove.debts.reduce((sum, debt) => sum + debt.annualPayment, 0) + (propertyMove.rental?.running ?? 0);
    if (profile.expenses.annualTotal.amount - futureRemoval < statedEssentialAnnual(original) - 0.005) fail(spendingReductionPath,
      'After the future property move this cut would take spending below stated essentials.');
  }
  return { profile, original, route, cashUsed, cashByLiability, spendingRemoved, spendingReduction, pensionContributions, changedFacts, movedGoals, goalOverrides, goalCashReserved, reservedCash, cashAssetId, saleResult, propertyMove };
}
function selectGoalProfile(profile, pack, chapter) {
  const view = cloneJson(profile);
  const types = chapter === 'pension_projection' || chapter === 'net_retirement_cashflow'
    ? retirementTypes : chapter === 'college_funding' ? ['fund_education'] : null;
  if (!types) return view;
  const candidates = view.goals.filter(g => types.includes(g.type) && !['paused', 'completed'].includes(g.status));
  const selectedId = pack.planningInputs.chapterGoals[chapter];
  const selected = selectedId ? candidates.find(g => g.goalId === selectedId) : candidates.length === 1 ? candidates[0] : null;
  if (!selected) missing('/planningInputs/chapterGoals/' + chapter, 'Select one relevant goal; the compiler does not rank goals or choose by array order.');
  view.goals = view.goals.filter(g => !types.includes(g.type) || g.goalId === selected.goalId);
  if (retirementTypes.includes(selected.type) && selected.targetAmount) {
    view.assumptions.values.retirement ??= {};
    view.assumptions.values.retirement.targetIncomeToday = amount(selected.targetAmount, '/household/goals/' + profile.goals.findIndex(g => g.goalId === selected.goalId) + '/targetAmount');
  }
  return view;
}
function annualEmployment(profile, personId) {
  return profile.incomeSources.filter(i => i.ownerIds.length === 1 && i.ownerIds[0] === personId && i.type === 'employment')
    .reduce((sum, i) => sum + amount(i.grossAnnual, '/household/incomeSources/' + profile.incomeSources.indexOf(i) + '/grossAnnual'), 0);
}
function currentPension(profile, pack, personId) {
  const explicit = pack.planningInputs.personalPensionContributions.find(c => c.personId === personId);
  if (explicit) return explicit.annualAmount;
  const pensions = profile.pensions.filter(p => p.ownerId === personId);
  if (pensions.length) {
    let rate = 0;
    for (const pension of pensions) {
      if (['paid_up', 'not_applicable'].includes(pension.contributionStatus) || ['defined_benefit', 'buyout_bond'].includes(pension.type)) continue;
      if (!Number.isFinite(pension.employeeContributionRate)) missing('/household/pensions/' + profile.pensions.indexOf(pension) + '/employeeContributionRate', 'State the current personal contribution or its recorded rate.');
      rate += pension.employeeContributionRate;
    }
    return annualEmployment(profile, personId) * rate;
  }
  if (hasOwnerConfirmedNone(profile, '/pensions', personId) || profile.assumptions.values.completionFacts?.confirmedNonePaths?.['/pensions'] === true) return 0;
  missing('/planningInputs/personalPensionContributions', 'Confirm the current personal contribution for ' + personId + ', including explicit zero.');
}
function outgoings(profile, pack) {
  const spending = amount(profile.expenses.annualTotal, '/household/expenses/annualTotal');
  const lines = [];
  let debt = 0;
  for (const [index, loan] of profile.liabilities.entries()) {
    const monthly = amount(loan.monthlyPayment, '/household/liabilities/' + index + '/monthlyPayment');
    if (!monthly) continue;
    const binding = pack.planningInputs.outgoingBindings.find(b => b.liabilityId === loan.liabilityId);
    if (!binding) missing('/planningInputs/outgoingBindings', 'Bind the contractual payment for liability ' + loan.liabilityId + ' to a named outgoing.');
    const annual = monthly * 12;
    debt += annual;
    lines.push({ id: binding.id, label: binding.label ?? loan.label, amount: annual });
  }
  if (debt > spending) fail('/household/expenses/annualTotal', 'is below the sum of known debt repayments. Annual total must include those payments.');
  if (!pack.planningInputs.spendingLabel) missing('/planningInputs/spendingLabel', 'Supply display wording for the remaining stated spending. The compiler does not author or rewrite expense labels.');
  lines.push({ id: 'living', label: pack.planningInputs.spendingLabel, amount: spending - debt });
  return lines;
}
function cashBalance(profile) {
  return profile.assets.filter(a => a.type === 'cash').reduce((sum, a) => sum + amount(a.currentValue, '/household/assets/' + profile.assets.indexOf(a) + '/currentValue'), 0);
}
function cashFlowInput(context, pack) {
  const profile = context.profile;
  if (!pack.planningInputs.householdTaxStatus) missing('/planningInputs/householdTaxStatus', 'State the tax assessment status; the compiler does not infer it from a partner record.');
  const incomeTypes = { employment: 'employment', rental: 'rentalProfit', pension: 'occupationalPension', state_pension: 'statePension' };
  const income = profile.incomeSources.flatMap((entry, index) => {
    if (entry.grossAnnual?.amount === 0) return [];
    if (!incomeTypes[entry.type]) throw new LaterStage('/household/incomeSources/' + index + '/type', 'Cash flow does not support this income type.', 'B2', 'requires_profile_adapter');
    if (entry.ownerIds.some(owner => !people(profile).some(p => p.personId === owner))) missing('/household/incomeSources/' + index + '/ownerIds', 'Name actual people as the owners of this income.');
    return [{ personId: entry.ownerIds.length > 1 ? 'joint' : entry.ownerIds[0], type: incomeTypes[entry.type], amount: amount(entry.grossAnnual, '/household/incomeSources/' + index + '/grossAnnual') }];
  });
  const rows = outgoings(profile, pack);
  if (context.ledgerFunding?.goalSaving > 0) {
    if (!pack.planningInputs.goalFundingLabel) missing('/planningInputs/goalFundingLabel', 'Supply display wording for goal-saving transfers.');
    rows.push({ id: 'goal_funding', label: pack.planningInputs.goalFundingLabel, amount: context.ledgerFunding.goalSaving });
  }
  return {
    calculationYear: Number(pack.calculationDate.slice(0, 4)),
    householdTaxStatus: pack.planningInputs.householdTaxStatus,
    people: people(profile).map(person => {
      if (!Number.isInteger(person.age)) missing('/household', 'Each cash-flow person needs a current age.');
      const net = ownerBankPay(profile, person.personId, { optional: true });
      const gross = income.filter(i => i.personId === person.personId).reduce((sum, i) => sum + i.amount, 0);
      if (net === 0 && gross > 0) throw new LaterStage('/household/incomeSources', 'The cash-flow engine cannot anchor a stated zero bank income; this is not replaced with an estimate.');
      return { id: person.personId, label: person.displayName ?? '', age: person.age, personalPensionContribution: currentPension(profile, pack, person.personId), ...(net > 0 ? { statedTakeHome: net } : {}) };
    }),
    income, outgoings: rows, scenarios: [{ id: 'today' }, ...(context.ledgerFunding?.pensionChanges.length
      ? [{ id: 'route', title: 'Funding this route', changes: context.ledgerFunding.pensionChanges }] : [])]
  };
}

const nativeKeys = {
  liquidity_analysis: 'liquidityPlan', mortgage_analysis: 'mortgageInputs', loan_analysis: 'loanInputs',
  pension_projection: 'pensionInputs', net_retirement_cashflow: 'netRetirementInputs', college_funding: 'collegeFundingInputs'
};
export async function buildChapter(context, pack, chapter) {
  if (context.usableCashDeductions && ['liquidity_analysis', 'protection_gap'].includes(chapter)) {
    const profile = cloneJson(context.profile);
    for (const deduction of context.usableCashDeductions) {
      const asset = profile.assets.find(a => a.assetId === deduction.assetId);
      asset.currentValue.amount -= deduction.amount;
      if (asset.currentValue.amount < -0.005) fail('/planningInputs/assetAssignments', 'Assigned cash is unavailable twice.');
    }
    context = { ...context, profile };
  }
  const year = Number(pack.calculationDate.slice(0, 4));
  if (chapter === 'net_retirement_cashflow' && !context.ledgerFunding && context.usableCashDeductions?.length) {
    throw new LaterStage('/planningInputs/assetAssignments', 'Net retirement needs an explicit adapter for after-tax capital remaining after cash earmarks; the original fund cannot be reused.');
  }
  if (context.ledgerFunding && ['net_retirement_cashflow', 'college_funding'].includes(chapter)) {
    throw new LaterStage('/chapters', chapter === 'net_retirement_cashflow'
      ? 'The ledger is priced; net retirement still needs a route adapter for unassigned after-tax capital and changed bank pay.'
      : 'The ledger is priced; the college screen still needs an exact adapter for the bound child and dated funding target.', 'B2', 'requires_profile_adapter');
  }
  if (chapter === 'net_retirement_cashflow' && context.route.changes.some(c => c.type === 'moveGoal')) {
    throw new LaterStage('/chapters', 'The current net-retirement adapter prices stated spending, not a moved retirement goal. A route-specific goal builder is required.', 'B2', 'requires_profile_adapter');
  }
  if (chapter === 'goals_and_resources') {
    if (!pack.chapters.includes('household_cash_flow') && pack.planningInputs.leftOverEachYear === undefined) missing('/planningInputs/leftOverEachYear', 'State left-over cash or include the cash-flow chapter before compiling goals.');
    throw new LaterStage('/chapters', context.ledgerFunding
      ? 'The ledger is priced, but the native goals screen has no exact unchanged-current case. Its screen adapter is still required; no derived funding case is relabelled.'
      : 'The goals engine derives its own funding cases. Mapping a plan route requires B1; no nearest or relabelled case is substituted.', context.ledgerFunding ? 'B2' : 'B1', context.ledgerFunding ? 'requires_profile_adapter' : 'requires_resource_ledger');
  }
  if (chapter === 'future_cost_fund') {
    const candidates = context.profile.goals.filter(goal => !['paused', 'completed'].includes(goal.status)
      && (goal.type === 'fund_education' || pack.planningInputs.goalFundingFacts.some(fact => fact.goalId === goal.goalId && fact.kind === 'dated_cost')));
    const selectedId = pack.planningInputs.chapterGoals[chapter];
    const goal = selectedId ? candidates.find(row => row.goalId === selectedId) : candidates.length === 1 ? candidates[0] : null;
    if (!goal) missing('/planningInputs/chapterGoals/future_cost_fund', 'Select one dated cost for the future-cost-fund chapter.');
    const producer = planDatedCostProducer(context, pack, goal);
    const recorded = context.resourceLedger?.datedCosts.find(cost => cost.goalId === goal.goalId);
    // B0 can compile a funding requirement too, without applying B1 route cash.
    // Assigned investments still need a valuation contract before counting here.
    const held = pack.planningInputs.assetAssignments.filter(row => row.goalId === goal.goalId).reduce((sum, row) => {
      const asset = context.profile.assets.find(asset => asset.assetId === row.assetId);
      if (asset.type !== 'cash') throw new LaterStage('/planningInputs/assetAssignments', 'An assigned investment needs its goal-specific valuation before it can count as cash.', 'B2', 'requires_goal_asset_adapter');
      return sum + amount(asset.currentValue, '/household/assets/currentValue');
    }, 0);
    const contract = recorded ?? producer.produce(held);
    if (producer.input.startsInYears === 0 || contract.provenance.funding !== 'save_then_pay' || contract.retirementSplit.capitalNeededAtRetirement > 0.005) {
      throw new LaterStage('/chapters', 'The dated-cost contract is priced, but this unchanged screen only shows saving before a future cost; immediate, each-year and retirement-split funding need their screen adapter.', 'B2', 'requires_profile_adapter');
    }
    const requiredToday = contract.provenance.requiredToday;
    const input = { ...producer.input, scenarios: [{ id: 'funding', lumpShare: requiredToday > 0 ? contract.provenance.cashToday / requiredToday : 0 }] };
    const projection = computeFutureCostFundProjection(input, { calculationYear: year });
    const priced = projection.debug, fundingCase = priced.cases[0];
    if (Math.abs(priced.requiredToday - requiredToday) > 0.005 || priced.costYears.some((row, i) => Math.abs(row.cost - contract.costByYear[i].amountAfterRelief) > 0.005)) {
      throw new LaterStage('/chapters', 'This cost’s nominal schedule needs an exact screen adapter; the existing fixed-growth screen is not substituted.', 'B2', 'requires_profile_adapter');
    }
    return { input, payload: { title: goal.title, generated: { futureCostFundInputs: input,
      summaryHtml: '<p>What this route would need to fund this cost, distinct from its current saving.</p>' } },
    nativeCaseId: 'funding', metrics: { requiredToday, moneyNow: contract.moneyNow, lumpSumToday: fundingCase.lumpSumToday,
      yearlyAmount: fundingCase.yearlyAmount, totalCost: priced.totalCost }, builderHousehold: context.profile,
    assumptionsUsed: [{ key: 'datedCost', value: contract }, { key: 'calculationYear', value: year }], warnings: [],
    basis: 'dated_cost_contract_funding_requirement' };
  }
  if (['household_cash_flow', 'protection_gap'].includes(chapter)) {
    if (pack.planningInputs.takeHomeBasis !== 'after_personal_pension') missing('/planningInputs/takeHomeBasis', 'Confirm that stated net income is bank pay after personal pension deductions.');
    if (pack.planningInputs.spendingBasis !== 'regular_costs_including_debt_excluding_tax_and_pensions') missing('/planningInputs/spendingBasis', 'State the total-spending basis: debt repayments included; tax and pensions excluded.');
  }
  if (chapter === 'household_cash_flow') {
    const input = cashFlowInput(context, pack);
    const projection = computeHouseholdCashFlowProjection(input, { calculationYear: year });
    const summary = projection.summary.cases.at(-1);
    return {
      input, payload: { title: 'Your cash flow', generated: { summaryHtml: '<p>Compare the income and regular costs for this route.</p>', householdCashFlowInputs: input } },
      metrics: { income: summary.income.total, bankTakeHome: summary.takeHome.bankTotal, tax: summary.outgoings.tax, pensions: summary.outgoings.pensionContributions, leftOver: summary.leftOver.amount },
      builderHousehold: context.profile, cashFlowSummary: projection.summary,
      nativeCaseId: summary.id,
      assumptionsUsed: Object.entries(projection.debug.assumptionsUsed).map(([key, value]) => ({ key, value })),
      warnings: [...projection.debug.warnings, ...(input.people.some(p => p.statedTakeHome === undefined)
        ? ['Some bank pay is estimated by the cash-flow engine because a complete per-person net income was not stated.'] : [])],
      basis: input.people.every(p => p.statedTakeHome !== undefined) ? 'stated_bank_pay_with_engine_case_differences' : 'includes_estimated_bank_pay'
    };
  }
  if (chapter === 'protection_gap') {
    const profile = context.profile;
    if (context.spendingRemoved && pack.planningInputs.protectionCases.some(c => c.event.neededAfter !== undefined)) {
      throw new LaterStage('/planningInputs/protectionCases', 'A changed spending route needs its own confirmed post-death spending basis; the original figure is not silently reused.');
    }
    // This native illustration takes whole euros. Round only at its boundary;
    // reserve allocation, tax and the route ledger retain full precision.
    const protectionAmount = value => context.ledgerFunding ? Math.round(value) : value;
    const input = {
      people: people(profile).map(p => {
        const stated = ownerBankPay(profile, p.personId);
        return { id: p.personId, label: p.displayName ?? p.personId, takeHome: protectionAmount(context.bankTakeHomeByPerson?.[p.personId] ?? stated) };
      }),
      needed: protectionAmount(amount(profile.expenses.annualTotal, '/household/expenses/annualTotal')),
      savings: protectionAmount(cashBalance(profile)),
      scenarios: [{ id: 'today' }, ...cloneJson(pack.planningInputs.protectionCases)]
    };
    const projection = computeProtectionGapProjection(input);
    const metrics = {};
    for (const scenario of projection.debug.cases) {
      metrics[scenario.id + '.moneyIn'] = scenario.moneyIn;
      metrics[scenario.id + '.gap'] = scenario.gap;
      if (Number.isFinite(scenario.months)) metrics[scenario.id + '.months'] = scenario.months;
    }
    return { input, payload: { title: 'If income stops', generated: { protectionGapInputs: input } }, metrics, builderHousehold: profile,
      assumptionsUsed: context.ledgerFunding ? [{ key: 'protectionInputRounding', value: 'Route amounts rounded to whole euros for the native protection illustration; ledger amounts retain full precision.' }] : [],
      basis: 'stated_bank_pay_and_confirmed_state_payments' };
  }
  const definition = getPlanningModuleDefinition(chapter);
  if (!definition?.buildInput || !definition.run) throw new LaterStage('/chapters', 'No complete builder exists for ' + chapter + '.');
  let profile = selectGoalProfile(context.profile, pack, chapter);
  if (['mortgage_analysis', 'loan_analysis'].includes(chapter)) {
    // Debt cash changes are passed to the existing amortisation engine as an
    // explicit lump sum against the common opening debt, not as a new loan.
    profile = cloneJson(context.original);
    const settingsKey = chapter === 'mortgage_analysis' ? 'mortgage' : 'loan';
    const family = chapter === 'mortgage_analysis' ? 'mortgage' : 'loan';
    const selected = profile.assumptions.values[settingsKey]?.liabilityId;
    const candidates = profile.liabilities.filter(l => l.type === family);
    const loan = selected ? candidates.find(l => l.liabilityId === selected) : candidates.length === 1 ? candidates[0] : null;
    if (!loan) missing('/household/assumptions/values/' + settingsKey + '/liabilityId', 'Select exactly one liability for this chapter.');
    profile.assumptions.values[settingsKey] ??= {};
    for (const key of ['oneOffOverpayment', 'annualOverpayment']) {
      if (profile.assumptions.values[settingsKey][key]) fail('/household/assumptions/values/' + settingsKey + '/' + key, 'current facts cannot contain a proposed overpayment. State current contractual payment on the liability and future changes on a route.');
    }
    profile.assumptions.values[settingsKey].oneOffOverpayment = context.cashByLiability[loan.liabilityId] ?? 0;
    profile.assumptions.values[settingsKey].fixedPaymentAmount = amount(loan.monthlyPayment, '/household/liabilities/' + profile.liabilities.indexOf(loan) + '/monthlyPayment');
  }
  const readiness = definition.canRun(profile);
  if (!['ready', 'ready_with_assumptions'].includes(readiness.status)) {
    const first = readiness.requiredMissing?.find(r => (r.importance ?? 'required') === 'required');
    missing('/household' + (first?.fieldPath ?? ''), first?.reason ?? 'Chapter is not ready: ' + readiness.status + '.');
  }
  let input = definition.buildInput(profile);
  const chapterAssumptions = [];
  const chapterWarnings = [];
  if (chapter === 'pension_projection' && pack.planningInputs.householdTaxStatus) input.householdTaxStatus = pack.planningInputs.householdTaxStatus;
  if (chapter === 'pension_projection') {
    const targetSource = profile.fieldMetadata['/assumptions/values/retirement/targetIncomeToday']?.application;
    if (targetSource?.paths.includes('retirement.income')) input.targetIncomeBasis = 'gross';
    for (const member of input.pensions) {
      if (profile.assumptions.values.retirement?.statePensionFraction?.[member.id] !== undefined) continue;
      chapterAssumptions.push({ key: `statePensionFraction.${member.id}`, value: member.statePensionFraction,
        reason: 'Existing adviser-adapter illustration default, using the dated central maximum. No numeric entitlement was established for this person; retain the missing fact.' });
      chapterWarnings.push(`The State Pension fraction for ${member.id} is an illustration assumption, not a confirmed entitlement.`);
    }
  }
  const balanceSheetAssignments = chapter === 'personal_balance_sheet' ? context.usableCashDeductions ?? [] : [];
  if (balanceSheetAssignments.length) {
    const committed = new Map();
    for (const row of balanceSheetAssignments) committed.set(row.assetId, (committed.get(row.assetId) ?? 0) + row.amount);
    for (const [assetId, cash] of committed) {
      if (cash <= 0) continue;
      const position = input.assetPositions.find(p => p.source === 'assets' && p.id === assetId);
      if (!position || cash > position.amount + 0.005) fail('/planningInputs/assetAssignments', 'Committed cash exceeds its balance-sheet holding.');
      // The engine reconciles its buckets to gross assets in cents. Split the
      // holding in cents so both parts add back to it exactly; the ledger keeps
      // full precision.
      const holding = toCents(position.amount);
      const earmarked = Math.min(toCents(cash), holding);
      position.amount = toCents(holding - earmarked);
      // Supported assignments are dated spending, so their purpose is Lifestyle.
      // Keep their value and the author's label; only free cash stays Liquidity.
      input.assetPositions.push({ ...position, amount: earmarked, bucket: 'lifestyle_assets', source: 'plan_goal_funding' });
    }
  }
  let ledgerDebtInput = false;
  if (chapter === 'pension_projection' && context.ledgerFunding?.pensionInput) input = cloneJson(context.ledgerFunding.pensionInput);
  if (['mortgage_analysis', 'loan_analysis'].includes(chapter)) {
    const key = chapter === 'mortgage_analysis' ? 'mortgage' : 'loan';
    const id = profile.assumptions.values[key]?.liabilityId ?? profile.liabilities.filter(l => l.type === key)[0]?.liabilityId;
    const funding = context.ledgerFunding?.debtInputs[id];
    if (funding) { input = { ...cloneJson(funding), loanKind: key }; ledgerDebtInput = true; }
  }
  if (['mortgage_analysis', 'loan_analysis'].includes(chapter) && !ledgerDebtInput && input.oneOffOverpayment > 0) {
    const lump = input.oneOffOverpayment;
    input.oneOffOverpayment = 0;
    input.baseScenarioId = 'current';
    input.scenarios = [{ id: 'current', title: 'Current repayments' }, { id: 'route', title: 'Use the stated cash', oneOffOverpayment: lump }];
  }
  definition.validateInput(input);
  const result = await definition.run(input, {
    moduleVersion: definition.moduleVersion, calculationVersion: 'plan-pack-1.0.0',
    calculatedAt: pack.calculationDate + 'T00:00:00.000Z', baseCurrency: 'EUR'
  });
  finiteJson(result.semanticResult, '/chapters/' + chapter + '/result');
  let payload;
  let metrics = {};
  let nativeCaseId = 'base';
  if (chapter === 'personal_balance_sheet') {
    const published = buildPublishedSessionFromCall({ profile, results: [result], moduleInputs: { personal_balance_sheet: input }, clientName: pack.clientName, createdAt: pack.calculationDate + 'T00:00:00.000Z' });
    const module = published.session.modules[0];
    if (!module) fail('/chapters', 'The existing balance-sheet publisher produced no payload.');
    payload = { title: module.title, generated: module.generated };
    metrics = Object.fromEntries(Object.entries(result.semanticResult).filter(([, value]) => Number.isFinite(value)));
  } else {
    const key = nativeKeys[chapter];
    if (!key) throw new LaterStage('/chapters', 'This chapter has no complete payload builder.');
    payload = { title: definition.name, generated: { summaryHtml: '<p>Figures for this route use the stated household facts and the existing calculator.</p>', [key]: input } };
    metrics = Object.fromEntries(Object.entries(result.semanticResult).filter(([, value]) => Number.isFinite(value)));
    if (['mortgage_analysis', 'loan_analysis'].includes(chapter)) {
      const comparison = computeMortgageComparison(input, { defaultLoanKind: input.loanKind });
      const selected = comparison.cases.find(c => c.id === (ledgerDebtInput ? 'clear-by-age' : 'route')) ?? comparison.cases.find(c => c.isBase);
      if (!selected) fail('/chapters', 'The amortisation engine did not provide the selected case.');
      nativeCaseId = selected.id;
      metrics = { monthlyPayment: selected.projection.monthlyPaymentUsed, totalInterest: selected.totalInterestLifetime, interestSaved: selected.interestSaved };
      metrics = Object.fromEntries(Object.entries(metrics).filter(([, value]) => Number.isFinite(value)));
    } else if (chapter === 'pension_projection') {
      const debug = computePensionProjection(input).debug;
      metrics = { requiredPot: debug.requiredPot, projectedPot: debug.projectedPotCurrent, retirementYear: debug.retirementYear };
    } else if (chapter === 'net_retirement_cashflow') {
      const debug = computeNetRetirementProjection(input).debug;
      metrics = Object.fromEntries(Object.entries(debug).filter(([key, value]) => ['requiredFundToday', 'availableInvestmentFundToday'].includes(key) && Number.isFinite(value)));
    }
  }
  return { input, payload, metrics, nativeCaseId, basis: 'existing_adviser_adapter', moduleVersion: definition.moduleVersion,
    builderHousehold: profile, assumptionsUsed: [...(readiness.assumptionsUsed ?? []), ...chapterAssumptions, ...(balanceSheetAssignments.length ? [{
      key: 'goalCashClassification', value: { bucket: 'lifestyle_assets', cashAssignments: cloneJson(balanceSheetAssignments) }
    }, { key: 'balanceSheetCashRounding', value: 'Free and earmarked cash rounded to the cent for the balance sheet; ledger amounts retain full precision.' }] : [])],
    warnings: [...(readiness.warnings ?? []), ...chapterWarnings] };
}
