import { readPlanPosition } from '../plan_pack/story_facts.js';

const entries = (facts, requirements) => {
  const needed = new Set((requirements?.required ?? []).filter(row => ['current_position', 'inefficiencies'].includes(row.section)).map(row => row.key));
  return Object.entries(facts ?? {}).filter(([key]) => !key.startsWith('current.') || requirements && requirements.routeId !== 'current' && (key.startsWith('current.position.') || needed.has(key)));
};
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const storyKeys = compiled => {
  if (compiled?.status !== 'compiled') return [];
  return entries(readPlanPosition(compiled).routes.find(row => row.routeId !== 'current')?.facts)
    .filter(([, fact]) => fact.status === 'available').map(([key]) => key);
};
function ledgerView(ledger) {
  if (!ledger) return null;
  return {
    ...pick(ledger, ['balanced', 'goalsCovered', 'cashRemaining', 'reserveProtected', 'spareCashRemaining']),
    ...(ledger.propertyMove ? { majorMove: pick(ledger.propertyMove, ['type', 'propertyId', 'year', 'newHomePrice', 'cashReleased', 'sellingCosts', 'buyingCosts', 'tax']) } : {}),
    goals: (ledger.goals ?? []).map(goal => ({ ...pick(goal, ['goalId', 'state', 'firstShortYear']),
      metOnTime: goal.state === 'covered', shortfalls: ledger.years.flatMap(year => year.goals
        .filter(row => row.goalId === goal.goalId && row.shortfall > 0.005).map(row => ({ year: year.year, amount: row.shortfall }))),
      pensionPotShortfall: ledger.goalFunding?.find(row => row.goalId === goal.goalId)?.projectedPotGap ?? null })),
    years: ledger.years.map(year => pick(year, ['year', 'remaining', 'shortfall', 'cashflowDeficit', 'propertyCapitalReceived', 'propertyCapitalRemaining']))
  };
}
function choiceView(choice) {
  const priced = choice.pricing ?? choice.pricedRoute ?? choice;
  const route = choice.wireRoute ?? priced.routeDraft ?? choice.route;
  return { ...pick(choice, ['candidateId', 'kind', 'scale', 'status', 'minimum', 'bounds', 'meetsGoalOnTime', 'wholeRouteMeetsGoals']),
    id: route?.id ?? choice.id ?? choice.kind ?? null,
    what: route ? route.changes.map(change => change.type) : choice.kind ?? null,
    why: choice.why ?? choice.reason ?? (route ? 'The native engine prices these sourced changes against the pinned household.' : choice.refusals?.[0]?.message ?? 'No route was priced.'),
    ...(choice.shortfall ? { shortfall: { ...pick(choice.shortfall, ['cash', 'pensionPot', 'reserve']),
      yearly: (choice.shortfall.yearly ?? []).filter(row => row.amount > 0.005) } } : {}),
    ...(choice.funding ? { funding: pick(choice.funding, ['kind', 'wholeCash', 'maximumCash', 'cashAllocated', 'startsInYears', 'projectedPotGap', 'timingBasis']) } : {}),
    ...(route ? { route } : {}),
    ledger: ledgerView(priced.ledger), refusals: priced.refusals ?? choice.refusals ?? [], notes: priced.notes ?? choice.notes ?? [], storyFacts: storyKeys(priced.compilation) };
}

/** Only the harness reply is projected. The executor result and audit log stay full. */
export function toolReply(name, result, input = {}) {
  if (!result.data) return result;
  const data = result.data;
  if (name === 'read_position') return { ...result, data: {
    routeId: data.routeId, facts: input?.keys ? data.facts : Object.fromEntries(entries(data.facts, data.storyRequirements).map(([key, fact]) => [key,
      { key, display: fact.display, unit: fact.unit, status: fact.status, basisKind: fact.basis?.kind }])),
    storyFacts: entries(data.storyFacts, data.storyRequirements).map(([key]) => key),
    goalOrder: data.goalWalk?.map(row => row.goalId), issues: data.issues?.map(row => pick(row, ['id', 'headline', 'headlineKey'])),
    unavailableIssues: data.unavailableIssues, storyRequirements: data.storyRequirements
  } };
  if (name === 'read_figures') {
    const offset = input?.offset ?? 0;
    return { ...result, data: { ...data, figures: input?.ids ? data.figures : data.figures.slice(offset, offset + 100).map(figure =>
      pick(figure, ['id', 'label', 'valueShown', 'kind', 'effectiveFrom', 'effectiveTo', 'explainers'])),
    ...(!input?.ids ? { total: data.figures.length, nextOffset: offset + 100 < data.figures.length ? offset + 100 : null } : {}) } };
  }
  if (name === 'submit_story') return { ...result, data: {
    ...pick(data, ['verdict', 'accepted', 'reviewStatus', 'releaseEligible', 'openOnStoryScreen']),
    ...(data.report ? { report: { ...pick(data.report, ['ok', 'verdict', 'checkerVersion', 'routeId', 'refusals', 'limitations']),
      links: data.report.links.map(link => pick(link, ['ok', 'key'])) } } : {})
  } };
  if (!['price_route', 'goal_ways', 'suggest_routes', 'balancing_moves'].includes(name)) return result;
  const out = pick(data, ['status', 'goalId', 'goalOrder', 'methodOrder', 'scope', 'ordering', 'settingSourceChecks', 'omittedChapters', 'refusals', 'reusedCandidate', 'storyRequirements']);
  for (const key of ['ways', 'levers', 'moves', 'suggestions']) if (data[key]) out[key] = data[key].map(choiceView);
  if (data.route || data.ledger) Object.assign(out, choiceView(data), { ledger: ledgerView(data.ledger), storyFacts: Object.keys(data.storyFacts ?? {}).filter(key => !key.startsWith('current.')) });
  if (name === 'price_route' && input?.reason) out.why = input.reason;
  if (data.available) out.available = { ...pick(data.available, ['spareCash', 'reserve', 'earlierGoalIds', 'earlierGoalsOnTime']),
    years: (data.available.years ?? []).map(year => pick(year, ['year', 'surplus', 'propertyCapitalBeforeThisGoal', 'propertyCapitalRemainingAfterAllGoals'])) };
  return { ...result, data: out };
}
