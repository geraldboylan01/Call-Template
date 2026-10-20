import { cloneJson } from '../utils.js';
import { getPlanningModuleDefinition } from '../module_registry.js';
import { PLANEIR_ASSUMPTIONS } from '../planeir_assumptions.js';
import { computeLiquidityReserve } from '../../liquidity_reserve.js';
import { computeFutureCostFundProjection } from '../../future_cost_fund_math.js';
import { GOAL_STATE_WORDS, pricePlanMortgage, pricePlanRetirement } from '../../goals_and_resources_math.js';
import { routeContext, buildChapter, missing, people, LaterStage } from './chapters.js';
import { priceInvestmentSales } from './investment_sales.js';
import { fail, finiteJson } from './schema.js';

const RETIREMENT = ['retire', 'retire_early', 'improve_pension'];
const INFORMATIONAL = ['understand_position', 'maintain_liquidity'];
const sum = values => values.reduce((total, value) => total + value, 0);
const money = (value, path) => {
  if (!value || value.currency !== 'EUR' || !Number.isFinite(value.amount)) missing(path, 'Supply a stated EUR amount.');
  return value.amount;
};
function cashAssets(profile) { return profile.assets.filter(a => a.type === 'cash'); }
function activeGoals(profile) { return profile.goals.filter(g => !['paused', 'completed'].includes(g.status) && !INFORMATIONAL.includes(g.type)); }
function assignedCash(pack, profile, goalId) {
  return sum(pack.planningInputs.assetAssignments.filter(a => a.goalId === goalId).map(binding => {
    const asset = profile.assets.find(a => a.assetId === binding.assetId);
    if (asset.type !== 'cash') throw new LaterStage('/planningInputs/assetAssignments', 'An assigned investment needs its goal-specific valuation before it can count as cash.', 'B2', 'requires_goal_asset_adapter');
    return money(asset.currentValue, '/household/assets/' + profile.assets.indexOf(asset) + '/currentValue');
  }));
}
function availableCashProfile(pack, profile) {
  const view = cloneJson(profile);
  for (const binding of pack.planningInputs.assetAssignments) {
    const asset = view.assets.find(a => a.assetId === binding.assetId);
    if (asset.type === 'cash' && asset.currentValue) asset.currentValue.amount = 0;
  }
  return view;
}
function reserveFor(pack) {
  const view = availableCashProfile(pack, pack.household);
  const definition = getPlanningModuleDefinition('liquidity_analysis');
  const ready = definition.canRun(view);
  if (!['ready', 'ready_with_assumptions'].includes(ready.status)) missing('/household/expenses', 'Establish cash, spending and working/retired status before setting the reserve.');
  const input = definition.buildInput(view);
  const result = computeLiquidityReserve(input);
  if (result.targetCash === null) missing('/household/expenses', 'The emergency reserve cannot be calculated from missing spending.');
  return { input, result, protectedAmount: result.targetCash, basis: 'opening_unassigned_cash_and_central_target_policy' };
}
function debtData(context, pack, goal, fact) {
  const binding = pack.planningInputs.goalBindings.find(b => b.goalId === goal.goalId);
  const debt = context.original.liabilities.find(d => d.liabilityId === binding?.liabilityId);
  if (!debt) missing('/planningInputs/goalBindings', 'Bind debt goal ' + goal.goalId + ' to its liability.');
  const owner = people(context.profile).find(p => p.personId === binding.personId)
    ?? (people(context.profile).length === 1 ? context.profile.primaryPerson : null);
  if (!owner || !Number.isInteger(owner.age)) missing('/planningInputs/goalBindings', 'Name the person whose age sets the debt target for ' + goal.goalId + '.');
  const year = Number(pack.calculationDate.slice(0, 4));
  const override = context.goalOverrides[goal.goalId];
  const years = override?.clearByAge !== undefined ? override.clearByAge - owner.age
    : goal.targetDate ? Number(goal.targetDate.slice(0, 4)) - year
      : fact?.debtTarget === 'current_contract' ? Math.ceil(debt.remainingTermMonths / 12) : null;
  if (!(years > 0)) missing('/household/goals/' + context.profile.goals.indexOf(goal) + '/targetDate', 'Supply a future target date or explicitly retain the current debt contract.');
  return { debt, mortgage: {
    currentBalance: money(debt.currentBalance, '/household/liabilities/currentBalance'),
    annualInterestRate: debt.annualInterestRate, startDateIso: pack.calculationDate,
    remainingTermYears: debt.remainingTermMonths / 12, currentAge: owner.age, clearByAge: owner.age + years,
    fixedPaymentAmount: money(debt.monthlyPayment, '/household/liabilities/monthlyPayment')
  }, years };
}
function fundInput(context, pack, goal, fact) {
  if (fact?.currentAnnualSaving === undefined) missing('/planningInputs/goalFundingFacts', 'State current annual saving for ' + goal.goalId + ', including confirmed zero.');
  if (pack.planningInputs.goalSavingBasis !== 'excluded_from_regular_costs') missing('/planningInputs/goalSavingBasis', 'Confirm regular costs exclude goal transfers and stated left over is before those transfers.');
  const year = Number(pack.calculationDate.slice(0, 4));
  if (goal.type === 'fund_education' && fact.kind !== 'dated_cost') {
    const child = context.profile.dependants.find(d => d.dependantId === fact.dependantId);
    if (!child || !Number.isInteger(child.currentAge)) missing('/planningInputs/goalFundingFacts', 'Bind each college goal to one child with a stated age.');
    const central = PLANEIR_ASSUMPTIONS.collegeFunding;
    const selected = context.profile.assumptions.values.collegeFunding?.scenarioByChild?.[child.dependantId] ?? 'living_at_home';
    const scenario = central.scenarios.find(s => s.id === selected);
    if (!scenario) missing('/household/assumptions/values/collegeFunding/scenarioByChild', 'Select an approved college-cost scenario.');
    return { costTitle: goal.title, costKind: 'education',
      startsInYears: goal.targetDate ? Number(goal.targetDate.slice(0, 4)) - year : central.startAge - child.currentAge,
      durationYears: central.durationYears,
      annualCostToday: goal.targetAmount ? money(goal.targetAmount, '/household/goals/targetAmount') : scenario.annualCostTodayPerChild };
  }
  if (!goal.targetDate || !goal.targetAmount || !fact.durationYears || !fact.costKind) missing('/planningInputs/goalFundingFacts', 'A dated cost needs its goal amount/date, cost kind and duration.');
  return { costTitle: goal.title, costKind: fact.costKind, startsInYears: Number(goal.targetDate.slice(0, 4)) - year,
    durationYears: fact.durationYears, annualCostToday: money(goal.targetAmount, '/household/goals/targetAmount') };
}
function pensionInput(context, pack, goal) {
  if (pack.planningInputs.retirementIncomeBasis !== 'net' || !pack.planningInputs.householdTaxStatus) missing('/planningInputs/retirementIncomeBasis', 'Confirm net retirement income and the household tax status.');
  if (!goal.targetAmount) missing('/household/goals/targetAmount', 'State the net annual retirement-income target.');
  const profile = cloneJson(context.profile);
  profile.goals = profile.goals.filter(g => !RETIREMENT.includes(g.type) || g.goalId === goal.goalId);
  profile.assumptions.values.retirement ??= {};
  profile.assumptions.values.retirement.targetIncomeToday = goal.targetAmount.amount;
  const definition = getPlanningModuleDefinition('pension_projection');
  const ready = definition.canRun(profile);
  if (!['ready', 'ready_with_assumptions'].includes(ready.status)) missing('/household/pensions', 'The retirement goal needs complete pension, income and retirement-age facts.');
  const input = { ...definition.buildInput(profile), targetIncomeBasis: 'net', householdTaxStatus: pack.planningInputs.householdTaxStatus };
  definition.validateInput(input);
  return input;
}
function quoteGoals(context, pack, cashByGoal = {}) {
  for (const goal of context.profile.goals.filter(g => !['paused', 'completed'].includes(g.status) && INFORMATIONAL.includes(g.type))) {
    if (goal.targetAmount || goal.targetDate) throw new LaterStage('/household/goals',
      'A quantitative informational goal needs an explicit funding contract; its amount or date is not ignored.', 'B2', 'requires_goal_funding_adapter');
  }
  const active = activeGoals(context.profile);
  if (active.filter(g => RETIREMENT.includes(g.type)).length > 1) throw new LaterStage('/household/goals', 'A combined household retirement target is required so pension pots are not used twice.', 'B2', 'requires_combined_retirement_goal');
  return active.map((goal, index) => {
    const fact = pack.planningInputs.goalFundingFacts.find(f => f.goalId === goal.goalId);
    const common = { goalId: goal.goalId, title: goal.title, sourceIndex: index };
    if (RETIREMENT.includes(goal.type)) {
      if (goal.targetDate) throw new LaterStage('/household/goals/' + context.profile.goals.indexOf(goal) + '/targetDate',
        'Represent a retirement timing target with the named person’s retirement age; a retirement goal date needs its date-to-age adapter.', 'B2', 'requires_goal_funding_adapter');
      const input = pensionInput(context, pack, goal);
      const priced = pricePlanRetirement(input, { calculationDate: pack.calculationDate });
      return { ...common, kind: 'retirement', order: 3, startsInYears: 999, input, priced, wholeCash: null,
        needs: priced.extraCostByYear, alreadyCovered: priced.onTrackAtToday, hasCurrentFunding: priced.projectedPotAtToday > 0,
        unreachable: priced.reachedCap && priced.gapLeftOver > 0 };
    }
    if (['optimise_mortgage', 'manage_loan'].includes(goal.type)) {
      if (goal.targetAmount) throw new LaterStage('/household/goals/' + context.profile.goals.indexOf(goal) + '/targetAmount',
        'This debt contract prices full clearance by the target date; a partial-balance target needs its own funding adapter.', 'B2', 'requires_goal_funding_adapter');
      const { debt, mortgage, years } = debtData(context, pack, goal, fact);
      const lump = cashByGoal[goal.goalId] ?? context.cashByLiability[debt.liabilityId] ?? 0;
      const priced = pricePlanMortgage(mortgage, lump);
      const currentDebt = context.profile.liabilities.find(d => d.liabilityId === debt.liabilityId);
      const monthly = currentDebt.currentBalance.amount === 0 ? 0 : priced.monthlyPayment;
      const delta = 12 * (monthly - currentDebt.monthlyPayment.amount);
      return { ...common, kind: 'debt', order: goal.type === 'manage_loan' ? 0 : 2, startsInYears: years,
        liabilityId: debt.liabilityId, priced, input: priced.input, monthly, years, wholeCash: priced.wholeCash,
        maximumCash: debt.currentBalance.amount, needs: Array.from({ length: years }, () => Math.max(0, delta)),
        freed: Array.from({ length: years }, () => Math.max(0, -delta)), alreadyCovered: delta <= 0.005, hasCurrentFunding: mortgage.fixedPaymentAmount > 0 };
    }
    if (goal.type === 'fund_education' || (goal.type === 'assess_decision' && fact?.kind === 'dated_cost')) {
      const raw = fundInput(context, pack, goal, fact);
      const options = { calculationYear: Number(pack.calculationDate.slice(0, 4)) };
      const initial = computeFutureCostFundProjection({ ...raw, scenarios: [{ id: 'funding', lumpShare: 0 }] }, options);
      const held = assignedCash(pack, context.profile, goal.goalId);
      const allocated = cashByGoal[goal.goalId] ?? 0;
      const wholeCash = Math.max(0, initial.debug.requiredToday - held);
      if (allocated > wholeCash + 0.005) fail('/routes', 'Cash reserved exceeds what goal ' + goal.goalId + ' needs; it is not silently capped.');
      const input = { ...raw, scenarios: [{ id: 'funding', lumpShare: Math.min(1, (held + allocated) / initial.debug.requiredToday) }] };
      const priced = computeFutureCostFundProjection(input, options).debug;
      const annual = priced.cases[0].yearlyAmount;
      return { ...common, kind: 'dated_cost', order: 1, startsInYears: raw.startsInYears, input, priced,
        held, allocated, wholeCash, maximumCash: wholeCash, currentAnnualSaving: fact.currentAnnualSaving,
        needs: Array.from({ length: raw.startsInYears }, () => annual),
        alreadyCovered: fact.currentAnnualSaving >= annual - 0.005, hasCurrentFunding: held > 0 || fact.currentAnnualSaving > 0 };
    }
    throw new LaterStage('/household/goals/' + context.profile.goals.indexOf(goal), 'A funding contract is needed for goal ' + goal.goalId + '.', 'B2', 'requires_goal_funding_adapter');
  }).sort((a, b) => (a.order - b.order) || (a.startsInYears - b.startsInYears) || (a.sourceIndex - b.sourceIndex));
}

function validateFundingFacts(pack) {
  const goals = activeGoals(pack.household);
  const debtIds = goals.filter(g => ['optimise_mortgage', 'manage_loan'].includes(g.type))
    .map(g => pack.planningInputs.goalBindings.find(b => b.goalId === g.goalId)?.liabilityId).filter(Boolean);
  if (new Set(debtIds).size !== debtIds.length) fail('/planningInputs/goalBindings', 'A liability cannot fund two goal calculations.');
  const children = new Set();
  for (const fact of pack.planningInputs.goalFundingFacts) {
    const goal = goals.find(g => g.goalId === fact.goalId);
    if (!goal) fail('/planningInputs/goalFundingFacts', 'Funding facts must refer to an active funding goal.');
    const kind = RETIREMENT.includes(goal.type) ? 'retirement' : ['optimise_mortgage', 'manage_loan'].includes(goal.type) ? 'debt'
      : goal.type === 'fund_education' && fact.kind !== 'dated_cost' ? 'college' : 'dated_cost';
    if (fact.kind && fact.kind !== kind) fail('/planningInputs/goalFundingFacts', 'The funding kind must match its goal.');
    const fields = { retirement: [], debt: ['debtTarget'], college: ['dependantId', 'currentAnnualSaving'],
      dated_cost: ['currentAnnualSaving', 'costKind', 'durationYears'] }[kind];
    for (const key of Object.keys(fact)) if (!['goalId', 'kind', ...fields].includes(key)) fail('/planningInputs/goalFundingFacts', key + ' is not used by this funding kind.');
    if (kind === 'debt' && fact.debtTarget && goal.targetDate) fail('/planningInputs/goalFundingFacts', 'Use the goal target date or current_contract, not both.');
    if (kind === 'college' && fact.dependantId) {
      if (children.has(fact.dependantId)) fail('/planningInputs/goalFundingFacts', 'One child cannot be priced twice as a college goal.');
      children.add(fact.dependantId);
    }
  }
  for (const assignment of pack.planningInputs.assetAssignments) {
    const goal = goals.find(g => g.goalId === assignment.goalId);
    if (!goal || !(goal.type === 'fund_education' || goal.type === 'assess_decision')) {
      throw new LaterStage('/planningInputs/assetAssignments', 'This assigned asset needs a goal-specific funding adapter.', 'B2', 'requires_goal_asset_adapter');
    }
  }
}

function investmentInventory(pack, sales) {
  const assigned = new Set(pack.planningInputs.assetAssignments.map(a => a.assetId));
  const holdings = pack.household.assets.filter(a => a.type === 'investment' && !assigned.has(a.assetId));
  const sold = new Set(sales.sales.map(s => s.assetId));
  // Only holdings the route keeps: a sold asset and its exemption are already in the route's own sale.
  const ordinary = holdings.filter(a => a.investmentTaxTreatment === 'ordinary_cgt' && a.currentValue && !sold.has(a.assetId));
  // This is one hypothetical batch, never additional cash or another allowance.
  const potentialSale = ordinary.length && pack.planningInputs.householdTaxStatus
    ? priceInvestmentSales(pack.household, ordinary.map(a => a.assetId), pack.calculationDate, pack.planningInputs.householdTaxStatus, pack.planningInputs.openingTaxState) : null;
  return { countedAsCash: false, potentialSaleBasis: 'unassigned_ordinary_cgt_holdings_kept_by_the_route_sold_together_from_opening_tax_history', potentialSale,
    holdings: holdings.map(asset => ({ assetId: asset.assetId, marketValue: asset.currentValue ?? null,
      taxTreatment: asset.investmentTaxTreatment ?? 'unknown', soldInRoute: sold.has(asset.assetId),
      valuationStatus: sold.has(asset.assetId) ? 'sold_in_route'
        : ordinary.includes(asset) && potentialSale ? 'priced_in_potential_batch' : 'requires_sale_facts_or_adapter' })) };
}

export async function prepareResourceRoute(pack, route, index) {
  validateFundingFacts(pack);
  const reserve = reserveFor(pack);
  const saleIds = route.changes.filter(c => c.type === 'sellAsset').map(c => c.assetId);
  if (saleIds.some(id => pack.planningInputs.assetAssignments.some(a => a.assetId === id))) fail('/routes/' + index, 'An assigned asset cannot fund another goal without an explicit reassignment contract.');
  const sales = priceInvestmentSales(pack.household, saleIds, pack.calculationDate, pack.planningInputs.householdTaxStatus, pack.planningInputs.openingTaxState);
  const movedOnly = { ...route, changes: route.changes.filter(c => c.type === 'moveGoal') };
  const preview = routeContext(pack, movedOnly, index, { allowGoalMoves: true, saleResult: sales });
  const preliminary = quoteGoals(preview, pack);
  for (const change of route.changes.filter(c => c.type === 'useCash')) if (!preliminary.some(g => g.goalId === change.goalId)) {
    throw new LaterStage('/routes/' + index, 'This goal needs an explicit cash-funding contract.', 'B2', 'requires_goal_funding_adapter');
  }
  const assigned = new Set(pack.planningInputs.assetAssignments.map(a => a.assetId));
  const openingCash = sum(cashAssets(pack.household).filter(a => !assigned.has(a.assetId)).map(a => money(a.currentValue, '/household/assets/currentValue')));
  const cashAvailable = Math.max(0, openingCash + sales.netProceeds - reserve.protectedAmount);
  let left = cashAvailable;
  const resolved = cloneJson(route);
  const cashByGoal = Object.create(null);
  const clearances = route.changes.map((change, i) => ({ change, i })).filter(row => row.change.type === 'clearOutgoing');
  for (const { change } of clearances) {
    const binding = pack.planningInputs.outgoingBindings.find(b => b.id === change.outgoingId);
    const debt = pack.household.liabilities.find(d => d.liabilityId === binding.liabilityId);
    left -= money(debt.currentBalance, '/household/liabilities/currentBalance');
  }
  // Explicit/whole instructions first; "remaining" means after those commitments.
  for (const remainingPass of [false, true]) for (const goal of preliminary) {
    for (const [ci, change] of route.changes.entries()) {
      if (change.type !== 'useCash' || change.goalId !== goal.goalId || (change.amount === 'remaining') !== remainingPass) continue;
      if (goal.wholeCash === null) throw new LaterStage('/routes/' + index + '/changes/' + ci, 'A pension lump-sum funding contract is required; annual contributions are priced separately.', 'B2', 'requires_pension_lump_adapter');
      const cash = typeof change.amount === 'number' ? change.amount : change.amount === 'whole' ? goal.wholeCash : Math.min(Math.max(0, left), goal.maximumCash);
      if (cash > goal.maximumCash + 0.005) fail('/routes/' + index + '/changes/' + ci, 'Cash exceeds the goal funding limit.');
      cashByGoal[goal.goalId] = cash;
      resolved.changes[ci].amount = cash;
      left -= cash;
    }
  }
  const context = routeContext(pack, resolved, index, {
    allowGoalMoves: true, fundingGoalIds: new Set(preliminary.filter(g => g.kind === 'dated_cost').map(g => g.goalId)), saleResult: sales
  });
  if (context.cashAssetId && assigned.has(context.cashAssetId)) fail('/planningInputs/cashAssetId', 'The funding cash account is already assigned to a goal.');
  const quotes = quoteGoals(context, pack, cashByGoal);
  const current = route.id === 'current';
  let baselineLeftOver = pack.planningInputs.leftOverEachYear;
  if (pack.chapters.includes('household_cash_flow')) baselineLeftOver = (await buildChapter(context, pack, 'household_cash_flow')).metrics.leftOver;
  else if (baselineLeftOver !== undefined) baselineLeftOver += context.spendingRemoved;
  if (baselineLeftOver === undefined) missing('/planningInputs/leftOverEachYear', 'Include cash flow or state annual left over before goal-saving transfers.');
  const costs = quotes.filter(g => g.kind === 'dated_cost');
  const goalSaving = sum(costs.map(g => current ? g.currentAnnualSaving : (g.needs[0] ?? 0)));
  context.ledgerFunding = { current, goalSaving, pensionChanges: [], debtInputs: {}, pensionInput: null };
  const retirement = quotes.find(g => g.kind === 'retirement');
  if (retirement) context.ledgerFunding.pensionInput = retirement.priced.currentInput;
  if (!current) {
    for (const goal of quotes.filter(g => g.kind === 'debt')) {
      const debt = context.profile.liabilities.find(d => d.liabilityId === goal.liabilityId);
      const delta = 12 * (goal.monthly - debt.monthlyPayment.amount);
      debt.monthlyPayment.amount = goal.monthly;
      if (context.profile.expenses.annualTotal) context.profile.expenses.annualTotal.amount += delta;
      if (!goal.priced.alreadyEnds || goal.priced.lumpSum > 0) context.ledgerFunding.debtInputs[goal.liabilityId] = goal.input;
    }
    if (retirement) {
      context.ledgerFunding.pensionInput = retirement.priced.plannedInput;
      const before = retirement.priced.costsToday.years[0]?.members ?? [];
      const after = retirement.priced.costsWithExtra.years[0]?.members ?? [];
      context.ledgerFunding.pensionChanges = after.map(member => ({ type: 'extraPension', personId: member.id, amount: member.gross - (before.find(p => p.id === member.id)?.gross ?? 0) })).filter(row => row.amount > 0.005);
    }
  }
  // Investment/cost capital remains an asset, but cannot also be emergency cash.
  context.usableCashDeductions = pack.planningInputs.assetAssignments.filter(a => pack.household.assets.find(asset => asset.assetId === a.assetId).type === 'cash')
    .map(a => ({ assetId: a.assetId, amount: money(pack.household.assets.find(asset => asset.assetId === a.assetId).currentValue, '/household/assets/currentValue') }));
  if (context.reservedCash > 0) context.usableCashDeductions.push({ assetId: context.cashAssetId, amount: context.reservedCash });
  if (pack.chapters.includes('household_cash_flow')) {
    const cashflow = await buildChapter(context, pack, 'household_cash_flow');
    const today = cashflow.cashFlowSummary.cases[0];
    const selected = cashflow.cashFlowSummary.cases.at(-1);
    context.bankTakeHomeByPerson = Object.fromEntries(selected.takeHome.byPerson.map(p => [p.personId, p.bankTakeHome]));
    if (!current && retirement && retirement.needs.length) retirement.needs[0] = today.leftOver.amount - selected.leftOver.amount;
  } else if (pack.chapters.includes('protection_gap') && context.ledgerFunding.pensionChanges.length) {
    missing('/chapters', 'Include household_cash_flow so protection uses the changed per-person bank pay after pension contributions.');
  }
  const horizon = Math.max(1, ...quotes.map(g => g.needs.length));
  const years = Array.from({ length: horizon }, (_, offset) => {
    const freed = current ? 0 : sum(quotes.map(g => g.freed?.[offset] ?? 0));
    const resources = baselineLeftOver + freed;
    let available = Math.max(0, resources);
    const goals = quotes.map(goal => {
      const required = goal.needs[offset] ?? 0;
      const planned = current ? goal.kind === 'dated_cost' && offset < goal.needs.length ? goal.currentAnnualSaving : 0 : required;
      const allocated = Math.min(planned, available);
      available -= allocated;
      return { goalId: goal.goalId, required, planned, allocated, shortfall: Math.max(0, planned - allocated) };
    });
    const planned = sum(goals.map(g => g.planned));
    return { offset, year: Number(pack.calculationDate.slice(0, 4)) + offset, available: resources, cashflowDeficit: Math.max(0, -resources), goals,
      required: sum(goals.map(g => g.required)), planned, remaining: resources - planned, shortfall: Math.max(0, planned - resources) };
  });
  const goalStates = quotes.map(goal => {
    const rows = years.map(row => row.goals.find(g => g.goalId === goal.goalId));
    const covered = current ? goal.alreadyCovered : !goal.unreachable && rows.every(row => row.shortfall <= 0.005);
    const partly = goal.hasCurrentFunding || rows.some(row => row.allocated > 0.005) || (cashByGoal[goal.goalId] ?? 0) > 0;
    const short = years.filter(row => { const g = row.goals.find(g => g.goalId === goal.goalId); return g.allocated < g.required - 0.005; });
    const lastShort = short.at(-1)?.offset;
    const state = covered ? 'covered' : partly ? 'partly' : 'not';
    return { goalId: goal.goalId, kind: goal.kind, state, stateWord: GOAL_STATE_WORDS[state],
      unreachable: goal.unreachable ?? false, firstShortYear: short[0]?.offset ?? null,
      firstMoneyYear: years.find(row => row.goals.find(g => g.goalId === goal.goalId).allocated > 0.005)?.offset ?? null,
      coveredFromYear: lastShort === undefined || goal.unreachable ? null : years.find(row => row.offset > lastShort && row.goals.find(g => g.goalId === goal.goalId).required > 0.005)?.offset ?? null };
  });
  const cashRemaining = openingCash + sales.netProceeds - context.cashUsed;
  const reserveProtected = cashRemaining >= reserve.protectedAmount - 0.005;
  const ledger = finiteJson({ version: 1, status: 'priced', currentPositionUnchanged: current,
    reserve, openingCash, investments: investmentInventory(pack, sales), investmentSales: sales, cashAvailableAfterReserve: cashAvailable,
    cashAllocated: context.cashUsed, cashRemaining, spareCashRemaining: cashRemaining - reserve.protectedAmount, reserveProtected,
    baselineLeftOver, goalOrder: quotes.map(g => g.goalId), goals: goalStates, years,
    annualFunding: { goalSaving, pensionChanges: context.ledgerFunding.pensionChanges,
      debtPayments: quotes.filter(g => g.kind === 'debt').map(g => ({ liabilityId: g.liabilityId,
        openingMonthlyPayment: pack.household.liabilities.find(d => d.liabilityId === g.liabilityId).monthlyPayment.amount,
        routeMonthlyPayment: context.profile.liabilities.find(d => d.liabilityId === g.liabilityId).monthlyPayment.amount })) },
    balanced: reserveProtected && years.every(row => row.shortfall <= 0.005),
    goalsCovered: goalStates.every(g => g.state === 'covered'),
    assumptions: ['Dated costs use calendar-year offsets. Annual left over is held constant; no future loan-expiry or salary windfall is credited.', 'Annual left over remains a funding assumption throughout the model, including years between different retirement dates.', 'The opening central-policy reserve remains protected.', 'Goal-saving transfers are excluded from stated regular spending.'],
    pricing: quotes.map(g => ({ goalId: g.goalId, kind: g.kind, input: g.input, priced: g.priced })) });
  return { context, ledger };
}
