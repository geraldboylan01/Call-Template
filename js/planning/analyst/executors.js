import { getFigures } from '../figures/get_figures.js';
import { getExplainers } from '../figures/get_explainers.js';
import { assembleCaseRoutes, compileCaseStories } from './compilation.js';
import { goalWays, balancingMoves as nativeBalancingMoves, suggestRoutes, priceRoute as nativePriceRoute } from '../plan_pack/ledger_walk.js';
import { checkStory, getStoryRequirements } from '../plan_pack/story_checker.js';
import { validateLeverSources } from '../plan_pack/lever_catalogue.js';
import { sizeMajorMove } from '../plan_pack/major_move_search.js';
import { PROPERTY_LEVERS } from '../plan_pack/property_moves.js';
import { cloneJson, assertIsoDate, stableStringify, sha256Json } from '../utils.js';
import { compiledFacts } from './facts.js';
import { missingFactQuestions } from './questions.js';
import { TOOL_CATALOGUE, PRICING_TOOLS, RUN_LIMITS, validateToolInput, refused, budgetRefusal } from './contracts.js';
import { caseRefusal } from './case_file.js';
import { compilerBudget } from './budget.js';
import { inefficiencyFirst, debtNotes } from '../plan_pack/debt_efficiency.js';
import { walkSession } from '../plan_pack/walk_session.js';

const ok = data => ({ ok: true, status: 'ok', data });
const fromError = (error, fallback = '/input') => ({ ok: false, status: 'refused',
  refusals: error.diagnostics ?? [{ code: error.code ?? 'invalid_input', path: error.path ?? fallback, message: error.message }] });
function storyRequirements(compiled, routeId) {
  const requirements = getStoryRequirements(compiled, routeId);
  delete requirements.facts;
  return requirements;
}

function readPosition(caseFile, { routeId = 'current', keys }) {
  const compiled = routeId === 'current' ? caseFile.pinned.currentPosition : caseFile.pricedRoutes[routeId];
  if (!compiled || !Object.hasOwn(caseFile.factRegistry, routeId)) return refused('unpriced_route', '/input/routeId', 'Read current or a successfully priced route.');
  const facts = compiledFacts(compiled, routeId);
  if (keys) {
    const unknown = keys.findIndex(key => !Object.hasOwn(facts.selected.facts, key));
    if (unknown !== -1) return refused('unknown_fact', '/input/keys/' + unknown, 'Ask for a fact key returned by read_position.');
  }
  caseFile.factRegistry[routeId] = facts.registry;
  return ok({ ...facts.selected, ...(keys ? { facts: Object.fromEntries(keys.map(key => [key, facts.selected.facts[key]])) } : {}), storyFacts: facts.storyFacts,
    storyRequirements: storyRequirements(compiled, routeId), versions: compiled.versions, calculationDate: compiled.calculationDate });
}

function readFigures(caseFile, input) {
  if (input.onDate !== undefined) {
    try { assertIsoDate(input.onDate, 'onDate'); }
    catch (error) { return refused('invalid_input', '/input/onDate', error.message); }
  }
  const unknown = input.ids?.find(id => !getFigures().some(figure => figure.id === id));
  if (unknown) return refused('unknown_figure', '/input/ids/' + input.ids.indexOf(unknown), 'The register has no figure with this ID.');
  const figures = getFigures(input).map(figure => ({ ...figure, explainers: figure.explainers ?? [] }));
  for (const figure of figures) {
    const id = 'figure.' + figure.id;
    // Figure facts are global to this run, never borrowed from another route.
    caseFile.factRegistry.figures ??= {};
    caseFile.factRegistry.figures[id] = { id, value: figure.value, unit: figure.unit, text: figure.valueShown, explainers: figure.explainers,
      source: { panel: 'figures', registerSource: figure.source, checkedOn: figure.checkedOn,
        catalogueVersion: figure.catalogueVersion, versions: caseFile.pinned.versions } };
  }
  return ok({ figures, versions: caseFile.pinned.versions });
}

function readExplainers(_caseFile, input) {
  const unknown = input.ids?.find(id => !getExplainers().some(explainer => explainer.id === id));
  if (unknown) return refused('unknown_explainer', '/input/ids/' + input.ids.indexOf(unknown), 'The catalogue has no explainer with this ID.');
  const unknownFigure = input.figureIds?.find(id => !getFigures().some(figure => figure.id === id));
  if (unknownFigure) return refused('unknown_figure', '/input/figureIds/' + input.figureIds.indexOf(unknownFigure), 'The register has no figure with this ID.');
  return ok({ explainers: getExplainers(input) });
}

function settingSourceChecks(pack, route) {
  return route.changes.map((change, index) => {
    const path = '/routes/1/changes/' + index;
    try {
      validateLeverSources(pack, change, path);
      return { type: change.type, path: path + '/sources', status: 'passed', sources: cloneJson(change.sources) };
    } catch (error) {
      return { type: change.type, path: error.path ?? path, status: 'refused', sources: cloneJson(change.sources ?? {}),
        refusals: fromError(error).refusals };
    }
  });
}


function pricedResult(caseFile, compiled, routeId) {
  const facts = compiledFacts(compiled, routeId);
  caseFile.pricedRoutes[routeId] = compiled;
  caseFile.factRegistry[routeId] = facts.registry;
  delete caseFile.storyDrafts[routeId];
  return { route: compiled.routes.find(row => row.id === routeId),
    ledger: compiled.resourceLedger.routes.find(row => row.routeId === routeId),
    position: facts.selected, storyFacts: facts.storyFacts,
    chapters: facts.chapters, facts: facts.position.routes.find(row => row.routeId === routeId).facts,
    ledgerSummary: facts.ledgerSummary, versions: compiled.versions, sourceHash: compiled.source.hash,
    notes: debtNotes(compiled.resourceLedger.routes.find(row => row.routeId === routeId)) };
}

async function priceRoute(caseFile, { route, candidateId, reason }, execution) {
  const cached = candidateId ? caseFile.pricedCandidates?.[candidateId]
    : Object.values(caseFile.pricedCandidates ?? {}).find(row => stableStringify(row.route) === stableStringify(route));
  if (candidateId && !cached) return refused('unknown_candidate', '/input/candidateId', 'Choose a retained candidate from a pricing reply.');
  if (cached && route && stableStringify(route) !== stableStringify(cached.route)) return refused('candidate_mismatch', '/input/route', 'Use the retained candidate unchanged or price a new route without its candidateId.');
  route ??= cached?.route;
  if (route.id === 'current') return refused('immutable_current', '/input/route/id', 'The current route is pinned; use a new alternative ID.');
  // Reusing an ID replaces its draft. A refusal must not leave older facts or
  // a story looking as though they price the newly submitted settings.
  delete caseFile.pricedRoutes[route.id];
  delete caseFile.factRegistry[route.id];
  delete caseFile.storyDrafts[route.id];
  caseFile.routeDrafts[route.id] = { route: cloneJson(route), ...(reason ? { reason } : {}) };
  const checks = settingSourceChecks(caseFile.pinned.planPack, route);
  const failures = checks.flatMap(check => check.refusals ?? []);
  if (failures.length) return { ...fromError({ diagnostics: failures }), data: { settingSourceChecks: checks } };
  if (cached?.pinHash === caseFile.pinHash) {
    if (cached.compilation.status !== 'compiled') return { ...fromError({ diagnostics: cached.compilation.diagnostics }),
      data: { route, ledger: cached.compilation.resourceLedger?.routes.find(row => row.routeId === route.id), settingSourceChecks: checks } };
    return ok({ ...pricedResult(caseFile, cached.compilation, route.id), storyRequirements: storyRequirements(cached.compilation, route.id), settingSourceChecks: checks, reusedCandidate: candidateId ?? cached.id });
  }
  // Full B1 assembly removes only chapters without route adapters. It preserves
  // refusals and never substitutes today's summary for a priced alternative.
  const assembly = await assembleCaseRoutes(caseFile, [route], execution);
  const compiled = assembly.compilation;
  if (compiled?.status !== 'compiled') return { ...fromError({ diagnostics: assembly.routeRefusals ?? assembly.missingFacts.map(row => ({
    code: row.factId, path: row.fieldPath, message: row.reason
  })) }), data: { settingSourceChecks: checks, ledgers: compiled?.resourceLedger?.routes ?? [], omittedChapters: assembly.omittedChapters } };
  return ok({ ...pricedResult(caseFile, compiled, route.id), storyRequirements: storyRequirements(compiled, route.id), settingSourceChecks: checks, omittedChapters: assembly.omittedChapters });
}

function toolDraft(caseFile, { route, routeId }, fallback) {
  if (route && routeId && route.id !== routeId) throw Object.assign(new Error('The route ID must match the supplied draft.'), { path: '/input/routeId' });
  if (route) return route;
  if (routeId) {
    if (caseFile.routeDrafts[routeId]) return caseFile.routeDrafts[routeId].route;
    throw Object.assign(new Error('Supply a saved draft ID or a route.'), { path: '/input/routeId', code: 'unknown_route' });
  }
  return { id: fallback, changes: [] };
}

function nativeResult(result, extra = {}) {
  const budget = result.refusals?.filter(row => row.code === 'budget_exceeded');
  if (result.status === 'refused' || budget?.length) return { ...fromError({ diagnostics: budget?.length ? budget : result.refusals }), data: { ...result, ...extra } };
  return ok({ ...result, ...extra });
}

async function goalWaysTool(caseFile, input, execution) {
  const route = toolDraft(caseFile, input, 'walk');
  const assembly = await assembleCaseRoutes(caseFile, [], execution);
  if (!assembly.planPack) return fromError({ diagnostics: assembly.routeRefusals ?? assembly.missingFacts.map(row => ({ path: row.fieldPath, code: row.factId, message: row.reason })) });
  return nativeResult(await goalWays(assembly, route, input.goalId, execution));
}

async function suggestRoutesTool(caseFile, _input, execution) {
  const assembly = await assembleCaseRoutes(caseFile, [], execution);
  if (!assembly.planPack) return fromError({ diagnostics: assembly.routeRefusals ?? assembly.missingFacts.map(row => ({ path: row.fieldPath, code: row.factId, message: row.reason })) });
  return nativeResult(await suggestRoutes(assembly, execution));
}

async function balancingMoves(caseFile, input, execution) {
  const route = toolDraft(caseFile, input, 'balance');
  const { type, propertyId, year } = input;
  if (route.id === 'current') return refused('immutable_current', '/input/route/id', 'Size a move for an alternative draft.');
  const checks = settingSourceChecks(caseFile.pinned.planPack, route);
  const failures = checks.flatMap(check => check.refusals ?? []);
  if (failures.length) return { ...fromError({ diagnostics: failures }), data: { settingSourceChecks: checks } };
  const assembly = await assembleCaseRoutes(caseFile, [], execution);
  if (!assembly.planPack) return fromError({ diagnostics: assembly.routeRefusals ?? assembly.missingFacts.map(row => ({ code: row.factId, path: row.fieldPath, message: row.reason })) });
  if (!PROPERTY_LEVERS.includes(type)) {
    const pricing = await nativePriceRoute(assembly, route, execution);
    return nativeResult(await nativeBalancingMoves(pricing, execution), { settingSourceChecks: checks });
  }
  const start = await inefficiencyFirst(walkSession(assembly, execution), route);
  const sized = await sizeMajorMove(assembly.planPack, start.draft, { type, propertyId, year },
    { maxProbes: RUN_LIMITS.compilerRunsPerCall, ...execution });
  if (sized.status === 'refused') return { ...fromError({ diagnostics: sized.refusals }), data: { ...sized, settingSourceChecks: checks } };
  if (sized.status === 'sized') {
    caseFile.routeDrafts[route.id] = { route: cloneJson(sized.route), reason: 'Native major-move sizing within the recorded bounds.' };
    const priced = pricedResult(caseFile, sized.compilation, route.id);
    return ok({ ...sized, position: priced.position, facts: priced.facts, storyFacts: priced.storyFacts, notes: priced.notes, versions: priced.versions, sourceHash: priced.sourceHash,
      settingSourceChecks: settingSourceChecks(assembly.planPack, sized.route) });
  }
  return ok({ ...sized, settingSourceChecks: checks });
}

async function submitStory(caseFile, { story }, execution) {
  const { routeId } = story;
  if (routeId !== 'current' && !Object.hasOwn(caseFile.pricedRoutes, routeId)) {
    return refused('unpriced_route', '/input/story/routeId', 'Price this route before submitting its story.');
  }
  const stories = { ...caseFile.storyDrafts, [routeId]: cloneJson(story) };
  try {
    const prepared = await compileCaseStories(caseFile, stories, execution);
    const compiled = prepared.compilation;
    const reports = Object.values(stories).map(draft => checkStory(compiled, draft));
    const failures = reports.flatMap(report => report.refusals);
    const report = reports.find(row => row.routeId === routeId);
    if (failures.length) return { ...fromError({ diagnostics: failures }), data: { accepted: false, releaseEligible: false, report, reports } };
    caseFile.storyDrafts = stories;
    caseFile.storyCompilation = prepared;
    caseFile.storyChecks = {};
    for (const draft of Object.values(stories)) caseFile.storyChecks[draft.routeId] = {
      storyHash: await sha256Json(draft), compilationSignature: prepared.signature,
      report: reports.find(row => row.routeId === draft.routeId)
    };
    return ok({ verdict: 'pass', accepted: true, report, reports, reviewStatus: 'pending', releaseEligible: false, openOnStoryScreen: true });
  } catch (error) { return fromError(error, '/story'); }
}

const notBuilt = (_caseFile, _input, name) => refused('not_built_yet', '/tools/' + name, 'not built yet');
const executors = {
  read_position: readPosition, read_figures: readFigures, read_explainers: readExplainers, price_route: priceRoute,
  missing_facts: caseFile => ok(missingFactQuestions(caseFile)), submit_story: submitStory,
  goal_ways: goalWaysTool,
  suggest_routes: suggestRoutesTool,
  balancing_moves: balancingMoves,
  run_whatif: caseFile => notBuilt(caseFile, null, 'run_whatif')
};

function retainCandidates(caseFile, result) {
  const data = result.data;
  if (!data) return;
  const choices = ['ways', 'levers', 'suggestions', 'moves'].flatMap(key => data[key] ?? []);
  if (data.sourceHash || data.compilation) choices.push(data);
  for (const [index, choice] of choices.entries()) {
    const priced = choice.pricing ?? choice.pricedRoute ?? choice;
    const compilation = priced.compilation ?? (data.sourceHash ? caseFile.pricedRoutes[data.route.id] : null);
    const draft = priced.routeDraft ?? compilation?.source?.normalizedPlanPack?.routes.find(row => row.id !== 'current');
    if (!compilation || !draft) continue;
    const route = { id: draft.id, ...(draft.title ? { title: draft.title } : {}), changes: cloneJson(draft.changes) };
    const id = 'candidate_' + (caseFile.runLog.length + 1) + '_' + (index + 1);
    (caseFile.pricedCandidates ??= {})[id] = { id, pinHash: caseFile.pinHash, route, compilation };
    choice.candidateId = id;
    choice.wireRoute = route;
  }
}

/** The only dispatch path. Pure: returns new state; never changes its inputs. */
export async function executeTool(rawCase, name, input) {
  const caseFile = cloneJson(rawCase);
  let result;
  let pricingCalls = 0;
  const meter = compilerBudget(caseFile);
  const tool = TOOL_CATALOGUE.find(row => row.name === name);
  // Invalid inputs do not start pricing; every valid pricing attempt is charged.
  if (!tool) result = refused('unknown_tool', '/tool', 'Unknown analyst tool.');
  else {
    try {
      result = await caseRefusal(caseFile);
      if (!result) {
        const errors = validateToolInput(name, input);
        result = errors.length ? { ok: false, status: 'refused', refusals: errors }
          : budgetRefusal(caseFile, name, input);
        if (!result) {
          if (PRICING_TOOLS.includes(name)) { caseFile.budget.pricingCalls++; pricingCalls++; }
          // Charge each real compiler invocation, including preflights and
          // nested native searches. The callback never enters a wire pack.
          if (name === 'run_whatif') caseFile.budget.whatifsByRoute[input.routeId] = (caseFile.budget.whatifsByRoute[input.routeId] ?? 0) + 1;
          const execution = { candidatePrefix: 'candidate_' + (caseFile.runLog.length + 1), beforeCompile: meter.beforeCompile };
          result = await executors[name](caseFile, input, execution);
        }
      }
    } catch (error) { result = fromError(error); }
  }
  retainCandidates(caseFile, result);
  const record = { sequence: caseFile.runLog.length + 1, tool: name, input: cloneJson(input ?? null), result: cloneJson(result), usage: { pricingCalls, ...meter.usage } };
  caseFile.runLog.push(record);
  if (name === 'submit_story') caseFile.checkerReports.push({ sequence: record.sequence, result: record.result, ...(result.data?.report ? { report: result.data.report } : {}) });
  return { caseFile, result };
}
