import { StoryRegistry } from './story_registry.js';
import { scanStoryIssues } from './story_issues.js';
import { storyRequirements } from './story_requirements.js';
import { propertyMoveRows } from './property_move_story.js';

const RETIREMENT = ['retire', 'retire_early', 'improve_pension'];
const active = goal => !['paused', 'completed'].includes(goal.status);
const number = value => typeof value === 'number' && Number.isFinite(value);
const valueOf = fact => fact?.status === 'available' ? fact.value : null;
const sum = rows => rows.reduce((a, b) => a + b, 0);

function currentPosition(r) {
  const l = r.ledger, lp = r.ledgerPath;
  if (number(l?.baselineLeftOver)) r.from('position.leftOver', lp + '/baselineLeftOver', 'EUR/year');
  else r.metric('position.leftOver', 'household_cash_flow', 'leftOver', 'EUR/year');
  const left = valueOf(r.facts['position.leftOver']);
  if (number(left)) r.calculated('position.leftOverWord', left < 0 ? 'a deficit' : left > 0 ? 'a surplus' : 'no surplus or deficit', 'text', ['position.leftOver'], 'sign');
  else r.unavailable('position.leftOverWord', 'Annual surplus or deficit has not been calculated.');
  const spare = number(l?.spareCashRemaining) ? l.spareCashRemaining : l?.cashAvailableAfterReserve;
  if (number(spare)) r.calculated('position.spareCash', Math.max(0, spare), 'EUR', [lp], 'cash_above_protected_reserve_and_assignments');
  else r.unavailable('position.spareCash', 'Spare cash needs a compiled resource ledger and reserve.');
  if (number(l?.reserve?.protectedAmount)) r.from('position.reserve', lp + '/reserve/protectedAmount', 'EUR');
  else r.metric('position.reserve', 'liquidity_analysis', 'targetCash');
  if (number(l?.reserve?.result?.targetBufferMonths)) r.from('position.reserveMonths', lp + '/reserve/result/targetBufferMonths', 'months');
  else if (r.chapter('liquidity_analysis')) r.from('position.reserveMonths', r.chapter('liquidity_analysis').path + '/input/targetBufferMonths', 'months');
  else r.unavailable('position.reserveMonths', 'The reserve policy has not been compiled.');
  r.metric('position.netWorth', 'personal_balance_sheet', 'netWorth');
  r.metric('position.grossAssets', 'personal_balance_sheet', 'grossAssets');
  const assets = valueOf(r.facts['position.grossAssets']), worth = valueOf(r.facts['position.netWorth']);
  if (assets === 0) r.unavailable('position.solvency', 'There are no assets yet to measure against.', undefined, true, 'no_assets');
  else if (number(assets) && number(worth)) r.calculated('position.solvency', worth / assets, 'ratio', ['position.netWorth', 'position.grossAssets'], 'net_worth_divided_by_assets');
  else r.unavailable('position.solvency', 'Solvency needs the compiled assets and net worth.');
  const home = r.household?.properties?.filter(row => row.use === 'home') ?? [];
  const balance = r.chapter('personal_balance_sheet');
  const positions = balance?.entry.input.assetPositions ?? [];
  const liabilities = balance?.entry.input.liabilityPositions ?? [];
  const mortgages = r.household?.liabilities?.filter(row => row.type === 'mortgage' && row.currentBalance?.amount !== 0) ?? [];
  if (!r.household) r.unavailable('position.homeShare', 'This compiled route does not retain its household source.');
  else if (!home.length) r.unavailable('position.homeShare', 'No home is recorded in this compiled household.', undefined, true, 'no_home');
  else if (!balance || !number(worth)) r.unavailable('position.homeShare', 'The home’s share needs the compiled balance sheet.');
  else if (worth === 0) r.unavailable('position.homeShare', 'Net worth is zero, so the home’s share cannot be expressed as a percentage.', undefined, true, 'zero_net_worth');
  else {
    const homeValues = home.map(row => positions.find(position => position.id === row.propertyId));
    const mortgageIds = new Set(r.household.liabilities.filter(row => row.type === 'mortgage').map(row => row.liabilityId));
    const linkedIds = new Set(home.flatMap(row => row.associatedLiabilityIds ?? []).filter(id => mortgageIds.has(id)));
    const allBound = new Set(r.household.properties.flatMap(row => row.associatedLiabilityIds ?? []));
    const unbound = mortgages.filter(row => !allBound.has(row.liabilityId));
    if (homeValues.some(row => !number(row?.amount)) || unbound.length) {
      r.unavailable('position.homeShare', 'The home and its mortgage must be identified in the compiled balance sheet.');
    } else {
      const debts = [...linkedIds].map(id => liabilities.find(row => row.id === id));
      if (debts.some(row => !number(row?.amount)) || [...linkedIds].some(id => !number(r.household.liabilities.find(row => row.liabilityId === id)?.currentBalance?.amount))) r.unavailable('position.homeShare', 'The home’s mortgage balance is missing from the compiled balance sheet.');
      else {
        const equity = sum(homeValues.map(row => row.amount)) - sum(debts.map(row => row.amount));
        r.calculated('position.homeEquity', equity, 'EUR', [balance.path + '/input'], 'home_values_less_bound_mortgages');
        r.calculated('position.homeShare', equity / worth, 'ratio', ['position.homeEquity', 'position.netWorth'], 'net_home_equity_divided_by_net_worth');
      }
    }
  }
  const takeHome = r.chapter('household_cash_flow')?.entry.metrics.bankTakeHome;
  if (!r.household) r.unavailable('position.mortgageShare', 'The route’s mortgage source is not available.');
  else if (!mortgages.length) r.unavailable('position.mortgageShare', 'There is no outstanding mortgage in this route.', undefined, true, 'no_mortgage');
  else if (takeHome === 0) r.unavailable('position.mortgageShare', 'There is no bank take-home to measure mortgage repayments against.', undefined, true, 'no_take_home');
  else if (!number(takeHome) || mortgages.some(row => !number(row.monthlyPayment?.amount))) r.unavailable('position.mortgageShare', 'Mortgage repayments as a share of take-home need the confirmed payments and compiled bank income.');
  else r.calculated('position.mortgageShare', sum(mortgages.map(row => row.monthlyPayment.amount * 12)) / takeHome, 'ratio',
    [r.householdPath + '/liabilities', r.chapter('household_cash_flow').path + '/metrics/bankTakeHome'], 'annual_mortgage_payments_divided_by_bank_take_home');
}

function goalFacts(r) {
  const l = r.ledger, lp = r.ledgerPath;
  const goals = (r.household?.goals ?? r.pack.household.goals).filter(active).filter(row => !['maintain_liquidity', 'understand_position'].includes(row.type));
  const category = g => g.type === 'manage_loan' ? 0 : RETIREMENT.includes(g.type) ? 3 : g.type === 'optimise_mortgage' ? 2 : 1;
  const order = l?.goalOrder ?? [...goals].sort((a, b) => category(a) - category(b)
    || (a.targetDate ?? '9999').localeCompare(b.targetDate ?? '9999') || goals.indexOf(a) - goals.indexOf(b)).map(row => row.goalId);
  r.calculated('ledger.goalOrder', order, 'list', l?.goalOrder ? [lp + '/goalOrder'] : [r.householdPath + '/goals'], l?.goalOrder ? 'compiled_ledger_order' : 'method_order_unpriced');
  const walk = [];
  for (const id of order) {
    const goal = goals.find(row => row.goalId === id) ?? { goalId: id, title: 'Retirement', type: 'retire' };
    const key = 'goals.' + id;
    const gi = l?.goals?.findIndex(row => row.goalId === id) ?? -1;
    const state = gi >= 0 ? l.goals[gi] : null;
    const qi = l?.pricing?.findIndex(row => row.goalId === id) ?? -1;
    const quote = qi >= 0 ? l.pricing[qi] : null;
    const gp = lp + '/goals/' + gi, qp = lp + '/pricing/' + qi;
    r.calculated(key + '.title', goal.title, 'text', [r.householdPath + '/goals'], 'goal_label');
    if (state?.stateWord) r.from(key + '.state', gp + '/stateWord', 'text');
    else r.unavailable(key + '.state', 'Goal funding has not been priced; no coverage state is claimed.', r.source(gi >= 0 ? gp : null), false, 'goal_not_priced');
    for (const field of ['firstShortYear', 'firstMoneyYear', 'coveredFromYear']) {
      if (number(state?.[field])) r.calculated(key + '.' + field, Number(r.compiled.calculationDate.slice(0, 4)) + state[field], 'year', [gp + '/' + field], 'calendar_year_from_ledger_offset');
      else r.unavailable(key + '.' + field, quote ? 'The compiled ledger has no such goal event.' : 'Goal timing has not been priced.', r.source(gi >= 0 ? gp : null), Boolean(quote), quote ? 'no_event' : 'goal_not_priced');
    }
    const cash = r.route.changes.filter(row => {
      const authored = r.pack.routes.find(route => route.id === r.route.id)?.changes?.[Number(row.source?.split('/')[4])];
      return (row.goalId === id || authored?.goalId === id) && (number(row.cashUsed) || number(row.cashReserved));
    }).reduce((total, row) => total + (row.cashUsed ?? row.cashReserved), 0);
    if (r.route.id === 'current' || quote) r.calculated(key + '.routeCash', cash, 'EUR', [r.routePath + '/changes'], 'cash_committed_to_this_goal');
    else r.unavailable(key + '.routeCash', 'This goal has no priced funding choice.');
    const rowIndex = l?.years?.[0]?.goals?.findIndex(row => row.goalId === id) ?? -1;
    if (rowIndex >= 0) r.from(key + '.routeYearly', lp + '/years/0/goals/' + rowIndex + '/planned', 'EUR/year');
    else r.unavailable(key + '.routeYearly', 'Yearly funding for this goal has not been priced.');
    if (cash > 0) r.calculated(key + '.routeCashYear', Number(r.compiled.calculationDate.slice(0, 4)), 'year', [r.routePath + '/changes'], 'cash_committed_today');
    const yearly = valueOf(r.facts[key + '.routeYearly']);
    const lumpNeed = quote?.priced?.requiredToday ?? quote?.priced?.wholeCash;
    if (number(lumpNeed)) r.calculated(key + '.lumpSumNeeded', lumpNeed, 'EUR', [qp + '/priced'], 'native_whole_goal_cash_requirement');
    else r.unavailable(key + '.lumpSumNeeded', quote?.kind === 'retirement' ? 'A pension lump-sum funding contract is not available.' : 'The goal’s cash requirement has not been priced.');
    if (rowIndex >= 0) r.from(key + '.yearlyNeeded', lp + '/years/0/goals/' + rowIndex + '/required', 'EUR/year');
    else r.unavailable(key + '.yearlyNeeded', 'The goal’s yearly requirement has not been priced.');
    const way = !quote ? 'unpriced' : r.route.id === 'current' ? 'current' : cash > 0 ? yearly > 0 ? 'mixed' : 'cash' : yearly > 0 ? 'yearly' : 'existing';
    const labels = { unpriced: 'Funding not priced', current: 'Current arrangements', mixed: 'Cash and yearly money', cash: 'Cash now', yearly: 'Yearly money', existing: 'Existing funding' };
    r.calculated(key + '.chosenWay', labels[way], 'text', [r.routePath, ...(quote ? [qp] : [])], 'chosen_funding_way');
    if (l?.years?.some(year => year.goals.some(row => row.goalId === id && row.capitalAllocated > 0.005))) {
      r.facts[key + '.chosenWay'].display = 'yearly money and property sale proceeds';
    }
    const fundingYears = [];
    for (const [yi, year] of (l?.years ?? []).entries()) {
      const index = year.goals.findIndex(row => row.goalId === id), row = year.goals[index];
      if (!row || row.planned <= 0.005 && row.capitalAllocated <= 0.005) continue;
      const prefix = key + '.funding.' + year.year, path = lp + '/years/' + yi;
      r.from(prefix + '.year', path + '/year', 'year');
      for (const field of ['capitalAllocated', 'yearlyAllocated']) r.from(prefix + '.' + field, path + '/goals/' + index + '/' + field, 'EUR');
      fundingYears.push(year.year);
    }
    walk.push({ fundingYears, goalId: id, title: goal.title, way, cash: valueOf(r.facts[key + '.routeCash']), yearly,
      status: quote ? 'priced' : 'not_priced', factKeys: Object.keys(r.facts).filter(k => k.startsWith(key + '.')) });
  }
  return walk;
}

function ledgerWalk(r, walk) {
  const l = r.ledger, lp = r.ledgerPath, steps = [];
  const cleared = new Set(), debtPayments = l?.annualFunding?.debtPayments ?? [];
  const yearlySaving = payment => Math.max(0, (payment.openingMonthlyPayment - payment.routeMonthlyPayment) * 12);
  let cash = number(l?.cashAvailableAfterReserve) ? l.cashAvailableAfterReserve : null;
  let surplus = number(l?.earnedLeftOver) ? l.earnedLeftOver : valueOf(r.facts['position.leftOver']);
  const fundingActive = !number(l?.years?.[0]?.earningShare) || l.years[0].earningShare > 1e-9;
  if (l?.years?.[0]) {
    // Start with the ledger's actual first-year earning shares. Move only the
    // savings made by this route to the step that makes them available.
    const clearedAnnual = r.route.changes.reduce((total, change) => {
      const authored = r.pack.routes.find(row => row.id === r.route.id)?.changes?.[Number(change.source?.split('/')[4])];
      const original = r.pack.household.liabilities.find(row => row.liabilityId === change.liabilityId);
      if (authored?.type !== 'clearOutgoing') return total;
      cleared.add(change.liabilityId);
      return total + original.monthlyPayment.amount * 12;
    }, 0);
    // Pricing omits the engine's temporary freed arrays. The serialized payment
    // differences are also what the goal steps below use to release savings.
    const goalSavings = r.route.id === 'current' ? 0 : sum(debtPayments.filter(payment => !cleared.has(payment.liabilityId)).map(yearlySaving));
    surplus = l.years[0].available + (l.years[0].propertyCapitalForExpenses ?? 0) - (fundingActive ? clearedAnnual + goalSavings : 0);
  }
  const step = (id, title, inputs, status = 'priced') => {
    const key = 'steps.' + id;
    r.calculated(key + '.cashAfter', cash, 'EUR', inputs, 'running_spare_cash');
    r.calculated(key + '.surplusAfter', l?.balanced && surplus < 0 && surplus >= -0.005 ? 0 : surplus, 'EUR/year', inputs, 'running_surplus');
    steps.push({ id, title, status, cashAfter: key + '.cashAfter', surplusAfter: key + '.surplusAfter' });
  };
  if (surplus < 0) step('deficit', 'Yearly deficit', ['position.leftOver']);
  step('reserve', 'Emergency reserve', ['position.reserve', 'position.spareCash', lp]);
  for (const change of r.route.changes) {
    const authored = r.pack.routes.find(row => row.id === r.route.id)?.changes?.[Number(change.source?.split('/')[4])];
    if (authored?.type !== 'clearOutgoing') continue;
    const original = r.pack.household.liabilities.find(row => row.liabilityId === change.liabilityId);
    cash = number(cash) ? cash - change.cashUsed : null;
    surplus = number(surplus) && number(original?.monthlyPayment?.amount) ? surplus + (fundingActive ? original.monthlyPayment.amount * 12 : 0) : null;
    cleared.add(change.liabilityId);
    step('clear_' + change.liabilityId, 'Clearing a stated debt', ['/source/normalizedPlanPack' + change.source, '/source/normalizedPlanPack/household/liabilities']);
  }
  for (const goal of walk) {
    const quote = l?.pricing?.find(row => row.goalId === goal.goalId);
    const binding = r.pack.planningInputs.goalBindings.find(row => row.goalId === goal.goalId);
    const payment = debtPayments.find(row => row.liabilityId === binding?.liabilityId);
    const freed = payment && !cleared.has(payment.liabilityId) && fundingActive ? yearlySaving(payment) : 0;
    cash = number(cash) && number(goal.cash) ? cash - goal.cash : null;
    const allocation = l?.years?.[0]?.goals.find(row => row.goalId === goal.goalId);
    const incomeUsed = allocation ? allocation.planned - (allocation.capitalAllocated ?? 0) : goal.yearly;
    surplus = number(surplus) && number(incomeUsed) ? surplus + freed - incomeUsed : null;
    step(goal.goalId, goal.title, ['goals.' + goal.goalId + '.routeCash', 'goals.' + goal.goalId + '.routeYearly', ...(lp ? [l.annualFunding ? lp + '/annualFunding' : lp, ...(l.years?.[0] ? [lp + '/years/0/goals'] : [])] : [])], quote ? 'priced' : 'not_priced');
  }
  const crossedOff = (r.pack.planningInputs.assetAssignments ?? []).map(row => ({ assetId: row.assetId, goalId: row.goalId,
    label: r.pack.household.assets.find(asset => asset.assetId === row.assetId)?.label ?? 'Assigned asset' }));
  const retirement = r.pack.household.goals.find(row => active(row) && RETIREMENT.includes(row.type));
  if (retirement) for (const pension of r.pack.household.pensions) {
    if (!crossedOff.some(row => row.assetId === pension.pensionId)) crossedOff.push({ assetId: pension.pensionId, goalId: retirement.goalId, label: pension.label ?? 'Pension funding' });
  }
  const pensionTypes = { occupational: 'workplace pension', prsa: 'PRSA', personal: 'personal pension',
    defined_benefit: 'defined benefit pension', buyout_bond: 'buyout bond', state: 'State Pension', arf: 'approved retirement fund' };
  const crossedOffDisplay = crossedOff.map(row => {
    const pension = r.pack.household.pensions.find(p => p.pensionId === row.assetId);
    if (!pension || pension.label) return row;
    const owner = [r.pack.household.primaryPerson, r.pack.household.partner].find(p => p?.personId === pension.ownerId);
    const name = owner?.name ?? (pension.ownerId === r.pack.household.primaryPerson.personId ? 'Your' : 'Your partner’s');
    return { ...row, label: name === 'Your' || name.endsWith('’s') ? name + ' ' + (pensionTypes[pension.type] ?? 'pension')
      : name + '’s ' + (pensionTypes[pension.type] ?? 'pension') };
  });
  r.calculated('ledger.crossedOff', crossedOff, 'list', ['/source/normalizedPlanPack/planningInputs/assetAssignments', '/source/normalizedPlanPack/household/pensions'], 'assigned_assets_once');
  r.facts['ledger.crossedOff'].display = crossedOffDisplay.length ? crossedOffDisplay.map(row => row.label).join(', ') : 'None';
  cashFlowYears(r, walk);
  if (l?.years?.[0]) r.from('leftOverAfterGoals.yearly', lp + '/years/0/remaining', 'EUR/year');
  else r.unavailable('leftOverAfterGoals.yearly', 'The plan has not priced funding after all goals.', r.source(lp), false, 'goal_not_priced');
  const yearly = valueOf(r.facts['leftOverAfterGoals.yearly']);
  if (number(yearly)) r.calculated('leftOverAfterGoals.monthly', yearly / 12, 'EUR/month', ['leftOverAfterGoals.yearly'], 'yearly_divided_by_twelve');
  else r.unavailable('leftOverAfterGoals.monthly', 'The plan has not priced funding after all goals.');
  if (number(l?.cashRemaining)) r.from('cashAfterGoals', lp + '/cashRemaining', 'EUR');
  else r.unavailable('cashAfterGoals', 'Cash remaining has not been calculated.');
  return steps;
}

function cashFlowYears(r, walk) {
  const years = r.ledger?.years ?? [];
  const fundingYears = walk.flatMap(goal => goal.fundingYears);
  for (const [i, year] of years.entries()) {
    const key = 'cashFlow.' + year.year, path = r.ledgerPath + '/years/' + i;
    r.from(key + '.year', path + '/year', 'year');
    r.from(key + '.remaining', path + '/remaining', 'EUR/year');
    const phase = !fundingYears.length ? 'no goal funding required' : year.year > Math.max(...fundingYears) ? 'after goal funding ends' : 'while goals are being paid';
    r.calculated(key + '.phase', phase, 'text', [path + '/goals'], 'goal_funding_phase');
  }
}

function moveFacts(r) {
  const move = r.ledger?.propertyMove;
  if (!move || !r.chapter('property_move')) return;
  const changeId = 'change_' + move.source.split('/').at(-1);
  const property = r.pack.household.properties.find(row => row.propertyId === move.propertyId);
  for (const row of propertyMoveRows(move, property)) {
    r.metric('moves.' + changeId + '.' + row.key, 'property_move', row.key, row.unit);
  }
}

function freedCash(r) {
  const events = (r.ledger?.freedCash ?? []).filter(event => number(event.fromYear));
  for (const [index, event] of events.entries()) {
    const id = event.liabilityId ?? event.goalId, key = 'freed.' + id, path = r.ledgerPath + '/freedCash/' + index;
    const label = event.label ?? r.pack.household.goals.find(row => row.goalId === event.goalId)?.title ?? 'Goal saving';
    r.calculated(key + '.label', label, 'text', [path], 'event_label');
    r.from(key + '.amount', path + '/annualAmount', 'EUR/year');
    if (event.fromYear !== null) r.from(key + '.fromYear', path + '/fromYear', 'year');
    else r.unavailable(key + '.fromYear', 'This debt has no contractual end date.', r.source(path), true, 'no_contractual_end');
    if (event.kind === 'loan_ends' && event.payoffDateIso) r.from(key + '.endDate', path + '/payoffDateIso', 'date');
  }
  for (const [i, person] of (r.ledger?.earners ?? []).entries()) {
    const key = 'retirement.' + person.personId + '.fromYear';
    if (person.stopsFromYear !== null) r.from(key, r.ledgerPath + '/earners/' + i + '/stopsFromYear', 'year');
    else r.unavailable(key, 'This person’s existing retirement-income share continues.', undefined, true, 'continuing_retired_share');
  }
  return events.map(row => row.liabilityId ?? row.goalId);
}

function pensions(r) {
  const cashFlow = r.chapter('household_cash_flow');
  let peopleCosts = null, flowPath = null;
  if (cashFlow) {
    const cases = cashFlow.entry.calculationFacts?.cases;
    const index = cases?.findIndex(row => row.id === cashFlow.entry.nativeCaseId) ?? -1;
    if (index >= 0) {
      peopleCosts = cases[index].takeHome.byPerson;
      flowPath = cashFlow.path + '/calculationFacts/cases/' + index + '/takeHome/byPerson';
    }
  }
  const quote = r.ledger?.pricing?.find(row => row.kind === 'retirement');
  const qi = r.ledger?.pricing?.findIndex(row => row === quote);
  if (quote) r.from('pension.disclosures', r.ledgerPath + '/pricing/' + qi + '/priced/disclosures', 'list');
  else r.unavailable('pension.disclosures', 'No priced retirement goal supplies contribution-limit disclosures.');
  const costsKey = r.route.id === 'current' ? 'costsToday' : 'costsWithExtra';
  let members = quote?.priced?.[costsKey]?.years?.[0]?.members;
  let source = r.source(r.ledgerPath + '/pricing/' + qi + '/priced/' + costsKey + '/years/0/members');
  const people = [r.household?.primaryPerson, r.household?.partner].filter(Boolean);
  for (const person of people) {
    const own = peopleCosts?.find(row => row.personId === person.personId);
    const member = members?.find(row => row.id === person.personId);
    const key = 'pension.' + person.personId;
    for (const [name, field] of [['grossRoute', 'gross'], ['costRoute', 'cost'], ['relief', 'relief']]) {
      const flowField = { gross: 'pensionGross', cost: 'pensionCost', relief: 'pensionRelief' }[field];
      if (number(own?.[flowField])) {
        r.add(key + '.' + name, own[flowField], 'EUR/year', { ...r.chapterSource(cashFlow, flowPath.slice(cashFlow.path.length) + '/' + peopleCosts.indexOf(own) + '/' + flowField, own[flowField]), allocationBasis: own.basis });
      } else if (number(member?.[field])) r.add(key + '.' + name, member[field], 'EUR/year', { ...source, ...(source.path ? { path: source.path + '/' + members.indexOf(member) + '/' + field } : {}) });
      else r.unavailable(key + '.' + name, 'This person’s contribution and tax relief were not calculated.');
    }
  }
}

function protection(r) {
  const chapter = r.chapter('protection_gap');
  if (!chapter) {
    r.unavailable('protection', 'No protection chapter was compiled; income gaps and savings duration are not asserted.');
    return;
  }
  for (const scenario of chapter.entry.input.scenarios) {
    for (const metric of ['moneyIn', 'gap', 'months']) {
      const name = scenario.id + '.' + metric, key = 'protection.' + name;
      if (number(chapter.entry.metrics[name])) r.metric(key, 'protection_gap', name, metric === 'months' ? 'months' : 'EUR/year');
      else r.unavailable(key, metric === 'months' && chapter.entry.metrics[scenario.id + '.gap'] === 0
        ? 'There is no income gap drawing down savings in this case.' : 'This protection figure was not calculated.',
      r.source(chapter.path), metric === 'months' && chapter.entry.metrics[scenario.id + '.gap'] === 0, 'no_finite_runway');
    }
  }
}

function pressurePoints(r) {
  const points = [], get = key => valueOf(r.facts[key]);
  if (get('position.leftOver') < 0) points.push({ id: 'yearly_deficit', label: 'A yearly deficit', facts: ['position.leftOver'] });
  const reserve = get('position.reserve'), cash = r.chapter('liquidity_analysis')?.entry.metrics.currentCash;
  if (number(reserve) && number(cash) && cash < reserve) points.push({ id: 'reserve_short', label: 'Cash is below the reserve', facts: ['position.reserve'] });
  for (const goal of r.ledger?.goals ?? []) if (['partly', 'not'].includes(goal.state)) points.push({ id: 'goal_' + goal.goalId, label: 'A goal is not fully funded', facts: ['goals.' + goal.goalId + '.state'] });
  for (const event of r.ledger?.freedCash ?? []) {
    if (!event.liabilityId || !event.payoffDateIso) continue;
    const debt = r.household?.liabilities.find(row => row.liabilityId === event.liabilityId);
    if ((r.ledger.earners ?? []).some(person => debt?.ownerIds.includes(person.personId) && person.stopsFromYear !== null && Number(event.payoffDateIso.slice(0, 4)) >= person.stopsFromYear)) {
      points.push({ id: 'loan_retirement_' + event.liabilityId, label: 'A loan continues into an owner’s retirement', facts: ['freed.' + event.liabilityId + '.endDate'] });
    }
  }
  const months = get('position.reserveMonths');
  for (const [key, value] of Object.entries(r.chapter('protection_gap')?.entry.metrics ?? {})) if (key.endsWith('.months') && number(months) && value < months) {
    points.push({ id: 'income_runway_' + key.split('.')[0], label: 'Savings last less than the reserve target when income stops', facts: ['position.reserveMonths'] });
  }
  r.calculated('position.pressurePoints', points, 'list', [r.ledgerPath, r.chapter('protection_gap')?.path].filter(Boolean), 'code_found_pressure_points');
}

function issueChange(r, itemId) {
  return r.route.changes.some(change => {
    if (change.liabilityId === itemId || change.assetId === itemId) return true;
    const goalId = change.goalId ?? r.pack.routes.find(route => route.id === r.route.id)?.changes?.[Number(change.source?.split('/')[4])]?.goalId;
    return r.pack.planningInputs.goalBindings.some(binding => binding.goalId === goalId && binding.liabilityId === itemId);
  });
}

/** The future read_position executor calls this function; no tools are built here. */
export function readPlanPosition(compiled) {
  if (compiled?.status !== 'compiled' || !compiled.source?.normalizedPlanPack || !Array.isArray(compiled.chapters)
    || !Array.isArray(compiled.routes) || !compiled.routes.some(row => row.id === 'current')) throw new Error('A successfully compiled plan with its current route and source is required.');
  const registries = compiled.routes.map((route, i) => new StoryRegistry(compiled, route, i));
  const results = registries.map(r => {
    currentPosition(r);
    const goalWalk = goalFacts(r), steps = ledgerWalk(r, goalWalk), freed = freedCash(r);
    moveFacts(r); pensions(r); protection(r); pressurePoints(r);
    const scanned = scanStoryIssues(r);
    return { routeId: r.route.id, facts: r.facts, goalWalk, steps, freedCash: freed, issues: scanned.issues, unavailableIssues: scanned.unavailable };
  });
  const current = results.find(row => row.routeId === 'current');
  for (const [index, route] of results.entries()) {
    const r = registries[index];
    for (const [key, fact] of Object.entries(current.facts)) {
      if (key.startsWith('current.') || key.startsWith('vsCurrent.')) continue;
      route.facts['current.' + key] = { ...structuredClone(fact), key: 'current.' + key };
    }
    for (const [name, key] of [['cashUsed', null], ['yearlyRemaining', 'leftOverAfterGoals.yearly'], ['cashLeft', 'cashAfterGoals'], ['netWorth', 'position.netWorth']]) {
      const currentRegistry = registries.find(row => row.route.id === 'current');
      const a = key ? valueOf(route.facts[key]) : r.ledger?.cashAllocated;
      const b = key ? valueOf(current.facts[key]) : currentRegistry.ledger?.cashAllocated;
      if (number(a) && number(b)) {
        r.calculated('vsCurrent.' + name, a - b, name === 'yearlyRemaining' ? 'EUR/year' : 'EUR', [key ?? r.ledgerPath + '/cashAllocated', 'current.' + (key ?? 'cashUsed')], 'route_less_current');
        r.calculated('vsCurrent.' + name + 'Word', a > b ? 'more' : a < b ? 'less' : 'unchanged', 'text', ['vsCurrent.' + name], 'difference_direction');
      } else r.unavailable('vsCurrent.' + name, 'Both this route and the current position need a calculated value for this comparison.');
    }
    const changed = route.goalWalk.filter(goal => {
      const key = 'goals.' + goal.goalId + '.state';
      return route.facts[key]?.status === 'available' && current.facts[key]?.status === 'available' && route.facts[key].value !== current.facts[key].value;
    }).map(goal => goal.title);
    r.calculated('vsCurrent.goalsChanged', changed, 'list', ['ledger.goalOrder', 'current.ledger.goalOrder'], 'goals_whose_compiled_state_changes');
    for (const key of Object.keys(current.facts).filter(key => key.startsWith('protection.') && key.endsWith('.months'))) {
      const name = key.slice('protection.'.length), a = valueOf(route.facts[key]), b = valueOf(current.facts[key]);
      if (number(a) && number(b)) {
        r.calculated('vsCurrent.protection.' + name, a - b, 'months', [key, 'current.' + key], 'route_less_current');
        r.calculated('vsCurrent.protection.' + name + 'Word', a > b ? 'more' : a < b ? 'less' : 'unchanged', 'text', ['vsCurrent.protection.' + name], 'difference_direction');
      } else r.unavailable('vsCurrent.protection.' + name, 'Both cases need a finite calculated savings duration for this comparison.');
    }
    for (const person of [r.household?.primaryPerson, r.household?.partner].filter(Boolean)) {
      const key = 'pension.' + person.personId;
      for (const [now, target] of [['grossNow', 'grossRoute'], ['costNow', 'costRoute']]) {
        const fact = current.facts[key + '.' + target];
        if (fact) route.facts[key + '.' + now] = { ...structuredClone(fact), key: key + '.' + now };
      }
      for (const [extra, field] of [['extraGross', 'grossRoute'], ['extraCost', 'costRoute']]) {
        const a = valueOf(route.facts[key + '.' + field]), b = valueOf(current.facts[key + '.' + field]);
        if (number(a) && number(b)) r.calculated(key + '.' + extra, a - b, 'EUR/year', [key + '.' + field, 'current.' + key + '.' + field], 'route_less_current');
        else r.unavailable(key + '.' + extra, 'Both routes need this person’s calculated contribution costs.');
      }
    }
    for (const baseline of current.issues) {
      const own = route.issues.find(issue => issue.id === baseline.id);
      if (route.routeId === 'current') continue;
      const unknown = route.unavailableIssues.some(issue => issue.id === baseline.id || issue.id === 'household_source');
      const carried = item => ({ ...structuredClone(item), state: unknown ? 'unknown' : 'not_present_in_route',
        factKeys: item.factKeys.map(key => 'current.' + key) });
      if (!own) route.issues.push({ ...structuredClone(baseline), headlineKey: 'current.' + baseline.headlineKey, orderKey: 'current.' + baseline.orderKey,
        state: unknown ? 'unknown' : 'not_present_in_route', addressed: !unknown, items: baseline.items.map(carried) });
      else {
        const missing = baseline.items.filter(item => !own.items.some(row => row.id === item.id));
        for (const item of own.items) if (issueChange(r, item.id)) {
          item.state = 'changed_in_route'; item.addressed = true;
        }
        own.items.push(...missing.map(carried)); own.addressed = !unknown && (missing.length > 0 || own.items.some(item => item.addressed));
      }
    }
  }
  // Missing-result words are code facts too. Both the screen and checker read
  // them here, so an accepted limitation never becomes an unknown screen key.
  for (const route of results) Object.assign(route.facts, storyRequirements(compiled, route).facts);
  return { version: 'story-facts-1.2.0', calculationDate: compiled.calculationDate, versions: { ...compiled.versions },
    currentRouteId: 'current', routes: results };
}
