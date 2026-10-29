import { classifyLever } from './lever_catalogue.js';
import { planFactsMissing } from '../plan_facts_missing.js';
import { pointerValue } from './story_registry.js';

export const STORY_SECTIONS = Object.freeze(['current_position', 'ledger', 'protecting', 'inefficiencies', 'goals',
  'cash_flow_after', 'net_worth_after', 'risks', 'check_next']);
export const STORY_PARTS = Object.freeze(['does', 'why', 'gives', 'costs', 'check']);
const people = household => [household.primaryPerson, household.partner].filter(Boolean);

/** Code-owned floor and limitation facts. No what-if is run by this reader. */
export function storyRequirements(compiled, position) {
  const route = compiled.routes.find(row => row.id === position.routeId);
  const pack = compiled.source.normalizedPlanPack, household = route.sourceHousehold ?? pack.household;
  const ledger = compiled.resourceLedger?.routes?.find(row => row.routeId === route.id);
  const facts = { ...position.facts }, limitations = [], whatifs = [];
  const missing = planFactsMissing(household);
  const add = (id, section, result, missingFacts, reason, factKey = null) => {
    const key = 'limitations.' + id;
    const message = `${result} is not shown. ${reason} Missing fact: ${missingFacts.map(row => row.label).join('; ')}.`;
    const limitation = { id, section, result, missingFacts, factKey, key, message };
    limitations.push(limitation);
    facts[key] = { key, value: message, display: message, unit: 'text', status: 'available',
      basis: { kind: 'calculated', engine: 'story_requirements', calculation: 'missing_result', inputs: missingFacts.map(row => row.path) },
      source: { kind: 'calculation', chapter: null, routeId: route.id, caseId: null, nativeCaseId: null, focusTargetId: null,
        panel: 'plan_facts', versions: { ...compiled.versions, storyFacts: position.facts['position.netWorth'].source.versions.storyFacts },
        calculation: 'missing_result', inputs: missingFacts.map(row => row.path) } };
    return limitation;
  };
  const missingFor = (chapter, fallback) => {
    const rows = missing.filter(row => row.blockingModuleIds?.includes(chapter) && row.importance !== 'recommended');
    return rows.length ? rows.map(row => ({ path: row.fieldPath.startsWith('/household/') || row.fieldPath.startsWith('/planningInputs/')
      ? row.fieldPath : '/household' + row.fieldPath, label: row.reason, kind: row.kind })) : fallback;
  };
  const required = [];
  const requireFact = (key, section, label) => {
    const fact = facts[key];
    if (fact?.status === 'available') { required.push({ key, section }); return; }
    if (fact?.status === 'not_applicable' && facts[key + '.notApplicable']) { required.push({ key: key + '.notApplicable', section }); return; }
    const chapter = key.startsWith('protection') ? 'protection_gap' : key === 'position.leftOver'
      || key.startsWith('steps.') && key.endsWith('.surplusAfter') && facts['position.leftOver'].status !== 'available' ? 'household_cash_flow'
      : /netWorth|solvency/.test(key) ? 'personal_balance_sheet' : null;
    const absentInputs = (fact?.source?.inputs ?? []).filter(path => typeof path === 'string' && path.startsWith('/') && pointerValue(compiled, path) == null)
      .map(path => ({ path: path.replace(/^\/routes\/\d+\/sourceHousehold/, '/household'),
        label: path.endsWith('/annualInterestRate') ? 'the stated debt interest rate' : path.endsWith('/currentBalance') ? 'the stated debt balance' : 'the input at ' + path,
        kind: 'household_fact' }));
    const chapterFallback = chapter === 'household_cash_flow' && !pack.planningInputs.householdTaxStatus
      ? [{ path: '/planningInputs/householdTaxStatus', label: 'the confirmed household tax status', kind: 'plan_pack_fact' }]
      : [{ path: '/chapters/' + chapter, label: 'a compiled ' + (chapter ?? '').replaceAll('_', ' ') + ' result', kind: 'implementation' }];
    const missingFacts = absentInputs.length ? absentInputs : chapter ? missingFor(chapter, chapterFallback)
      : [{ path: '/planningInputs/goalFundingFacts', label: 'priced funding facts for ' + label, kind: 'plan_pack_fact' }];
    const limitation = add(section + '.' + key, section, label, missingFacts, fact?.reason?.message ?? 'The compiled plan did not produce this result.', key);
    required.push({ key: limitation.key, section, limitationId: limitation.id });
  };
  for (const [key, label] of [['leftOver', 'Yearly surplus or deficit'], ['spareCash', 'Spare cash'], ['netWorth', 'Net worth'],
    ['solvency', 'Solvency'], ['pressurePoints', 'Pressure points']]) requireFact('position.' + key, 'current_position', label);
  requireFact('ledger.crossedOff', 'ledger', 'Assets already assigned');
  for (const step of position.steps) for (const key of [step.cashAfter, step.surplusAfter]) requireFact(key, 'ledger', step.title + ' remaining resources');
  for (const key of ['position.reserve', 'position.reserveMonths']) requireFact(key, 'protecting', 'Emergency reserve');
  for (const goal of position.goalWalk) for (const field of ['title', 'state', 'chosenWay', 'routeCash', 'routeYearly']) {
    requireFact('goals.' + goal.goalId + '.' + field, 'goals', goal.title + ' ' + field.replace(/([a-z])([A-Z])/g, '$1 $2'));
  }
  requireFact('leftOverAfterGoals.yearly', 'cash_flow_after', 'Yearly money after goals');
  requireFact('position.netWorth', 'net_worth_after', 'Net worth after changes');
  if (route.id !== 'current') requireFact('vsCurrent.netWorth', 'net_worth_after', 'Net worth difference from current');
  const protection = compiled.chapters.find(row => row.id === 'protection_gap')?.cases.find(row => row.id === route.chapterCases.protection_gap);
  const earners = people(household).filter(person => household.incomeSources.some(income => income.ownerIds.includes(person.personId)
    && ['employment', 'self_employment'].includes(income.type) && (income.grossAnnual?.amount > 0 || income.netAnnual?.amount > 0))
    || ['employee', 'self_employed'].includes(person.employmentStatus));
  const bindWhatif = (kind, personIds) => {
    const scenario = protection?.input.scenarios.find(row => row.event?.type === (kind === 'incomeStops' ? 'cannotWork' : 'dies')
      && personIds.includes(row.event.personId));
    const id = kind === 'incomeStops' ? kind + '.' + personIds[0] : 'death';
    if (scenario) {
      const keys = ['protection.' + scenario.id + '.gap', 'protection.' + scenario.id + '.months'];
      keys.forEach(key => requireFact(key, 'protecting', 'Income gap or savings duration'));
      whatifs.push({ id, kind, personId: scenario.event.personId, caseId: scenario.id, factKeys: keys, status: 'compiled' });
    } else {
      const fallback = [{ path: '/planningInputs/protectionCases', label: `a confirmed ${kind === 'death' ? 'death' : 'income-stop'} case for ${personIds.join(', ')}`, kind: 'plan_pack_fact' }];
      const limitation = add('whatif.' + id, 'protecting', kind === 'death' ? 'The death illustration' : 'The income-stop illustration for ' + personIds[0],
        missingFor('protection_gap', fallback), 'No matching protection case was compiled.');
      whatifs.push({ id, kind, personId: kind === 'incomeStops' ? personIds[0] : null, status: 'not_shown', limitationId: limitation.id });
    }
  };
  earners.forEach(person => bindWhatif('incomeStops', [person.personId]));
  if (household.partner || household.dependants.length) bindWhatif('death', people(household).map(person => person.personId));
  const issues = position.issues.map(issue => {
    const keys = [issue.headlineKey, ...issue.items.flatMap(item => item.factKeys)];
    keys.forEach(key => requireFact(key, 'inefficiencies', issue.headline));
    return { id: issue.id, factKeys: keys };
  });
  const years = ledger?.years?.map(row => row.year) ?? [];
  const freed = (ledger?.freedCash ?? []).filter(event => years.includes(event.fromYear)).map(event => {
    const id = event.liabilityId ?? event.goalId;
    const keys = ['label', 'amount', 'fromYear'].map(field => 'freed.' + id + '.' + field);
    keys.forEach(key => requireFact(key, 'cash_flow_after', 'Money released by ' + (event.label ?? id)));
    return { id, factKeys: keys };
  });
  const sourceRouteIndex = pack.routes.findIndex(row => row.id === route.id), sourceRoute = pack.routes[sourceRouteIndex];
  const changes = (sourceRoute?.changes ?? []).map((change, i) => ({ id: 'change_' + i, type: change.type,
    source: '/source/normalizedPlanPack/routes/' + sourceRouteIndex + '/changes/' + i,
    scale: classifyLever(pack, change).scale }));
  const majorMoves = changes.filter(change => change.scale === 'major');
  const mainChangeIds = (majorMoves.length ? majorMoves : changes.slice(0, 1)).map(change => change.id);
  if (route.id !== 'current' && !mainChangeIds.length) {
    changes.push({ id: 'goal_funding', type: 'goal_funding', scale: 'ordinary', source: '/routes/' + compiled.routes.indexOf(route) });
    mainChangeIds.push('goal_funding');
  }
  return { routeId: route.id, facts, required, limitations, whatifs, issues, freed, changes, mainChangeIds, majorMoves,
    goalIds: position.goalWalk.map(row => row.goalId) };
}
