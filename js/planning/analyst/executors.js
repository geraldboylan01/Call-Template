import { getFigures } from '../figures/get_figures.js';
import { getExplainers } from '../figures/get_explainers.js';
import { assembleCaseRoutes, compileCaseStories } from './compilation.js';
import { goalWays, balancingMoves as nativeBalancingMoves, suggestRoutes, priceRoute as nativePriceRoute } from '../plan_pack/ledger_walk.js';
import { FIGURE_PREFIX, figureEntry, storyFactRegistry, referencedPlaceholders } from '../../plan_story_registry.js';
import { readPlanPosition } from '../plan_pack/story_facts.js';
import { validateLeverSources } from '../plan_pack/lever_catalogue.js';
import { sizeMajorMove } from '../plan_pack/major_move_search.js';
import { PROPERTY_LEVERS } from '../plan_pack/property_moves.js';
import { resolveStory } from '../../plan_story_model.js';
import { cloneJson, assertIsoDate } from '../utils.js';
import { compiledFacts } from './facts.js';
import { missingFactQuestions } from './questions.js';
import { TOOL_CATALOGUE, RUN_LIMITS, validateToolInput, refused, budgetRefusal } from './contracts.js';
import { caseRefusal } from './case_file.js';

const ok = data => ({ ok: true, status: 'ok', data });
const fromError = (error, fallback = '/input') => ({ ok: false, status: 'refused',
  refusals: error.diagnostics ?? [{ code: error.code ?? 'invalid_input', path: error.path ?? fallback, message: error.message }] });

function readPosition(caseFile, { routeId = 'current' }) {
  const compiled = routeId === 'current' ? caseFile.pinned.currentPosition : caseFile.pricedRoutes[routeId];
  if (!compiled || !Object.hasOwn(caseFile.factRegistry, routeId)) return refused('unpriced_route', '/input/routeId', 'Read current or a successfully priced route.');
  const facts = compiledFacts(compiled, routeId);
  caseFile.factRegistry[routeId] = facts.registry;
  return ok({ ...facts.selected, storyFacts: facts.storyFacts, versions: compiled.versions, calculationDate: compiled.calculationDate });
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
    ledgerSummary: facts.ledgerSummary, versions: compiled.versions, sourceHash: compiled.source.hash };
}

async function priceRoute(caseFile, { route, reason }, execution) {
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
  // Full B1 assembly removes only chapters without route adapters. It preserves
  // refusals and never substitutes today's summary for a priced alternative.
  const assembly = await assembleCaseRoutes(caseFile, [route], execution);
  const compiled = assembly.compilation;
  if (compiled?.status !== 'compiled') return { ...fromError({ diagnostics: assembly.routeRefusals ?? assembly.missingFacts.map(row => ({
    code: row.factId, path: row.fieldPath, message: row.reason
  })) }), data: { settingSourceChecks: checks, ledgers: compiled?.resourceLedger?.routes ?? [], omittedChapters: assembly.omittedChapters } };
  return ok({ ...pricedResult(caseFile, compiled, route.id), settingSourceChecks: checks, omittedChapters: assembly.omittedChapters });
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
  const sized = await sizeMajorMove(assembly.planPack, route, { type, propertyId, year },
    { maxProbes: RUN_LIMITS.engineRuns - caseFile.budget.engineRuns, ...execution });
  if (sized.status === 'refused') return { ...fromError({ diagnostics: sized.refusals }), data: { ...sized, settingSourceChecks: checks } };
  if (sized.status === 'sized') {
    caseFile.routeDrafts[route.id] = { route: cloneJson(sized.route), reason: 'Native major-move sizing within the recorded bounds.' };
    const priced = pricedResult(caseFile, sized.compilation, route.id);
    return ok({ ...sized, position: priced.position, facts: priced.facts, storyFacts: priced.storyFacts, versions: priced.versions, sourceHash: priced.sourceHash,
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
    const position = readPlanPosition(compiled);
    const explainers = Object.fromEntries(getExplainers().map(entry => [entry.id, entry]));
    for (const draft of Object.values(stories)) {
      // No metrics aliases and no unfiltered register snapshot: use precisely
      // the same registry and effective-date figure lookup as the screen.
      const registry = storyFactRegistry(position, draft.routeId);
      for (const key of referencedPlaceholders(draft).keys) if (key.startsWith(FIGURE_PREFIX)) {
        const entry = figureEntry(key.slice(FIGURE_PREFIX.length), compiled.calculationDate);
        if (entry) registry[key] = entry;
      }
      resolveStory({ story: draft, registry, explainers });
      const ids = new Set();
      const goals = position.routes.find(row => row.routeId === draft.routeId).goalWalk;
      for (const [index, goal] of (draft.sections[4].goals ?? []).entries()) {
        if ((!compiled.source.normalizedPlanPack.household.goals.some(row => row.goalId === goal.goalId)
          && !goals.some(row => row.goalId === goal.goalId)) || ids.has(goal.goalId)) {
          return refused('invalid_goal', '/story/sections/4/goals/' + index + '/goalId', 'Name a household goal once.');
        }
        ids.add(goal.goalId);
      }
    }
    caseFile.storyDrafts = stories;
    caseFile.storyCompilation = prepared;
    return ok({ verdict: 'passes_available_checks', scope: 'B1.5 shape and plan_story_model checks only',
      fullChecker: 'not built yet', reviewStatus: 'pending', releaseEligible: false, openOnStoryScreen: true });
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

/** The only dispatch path. Pure: returns new state; never changes its inputs. */
export async function executeTool(rawCase, name, input) {
  const caseFile = cloneJson(rawCase);
  let result;
  const tool = TOOL_CATALOGUE.find(row => row.name === name);
  // Availability is decided before input validation or inspection.
  if (!tool) result = refused('unknown_tool', '/tool', 'Unknown analyst tool.');
  else if (tool.unavailable) result = executors[name](caseFile);
  else {
    try {
      result = await caseRefusal(caseFile);
      if (!result) {
        const errors = validateToolInput(name, input);
        result = errors.length ? { ok: false, status: 'refused', refusals: errors }
          : budgetRefusal(caseFile, name, input);
        if (!result) {
          // Charge each real compiler invocation, including preflights and
          // nested native searches. The callback never enters a wire pack.
          if (name === 'run_whatif') caseFile.budget.whatifsByRoute[input.routeId] = (caseFile.budget.whatifsByRoute[input.routeId] ?? 0) + 1;
          const execution = { beforeCompile: () => {
            if (caseFile.budget.engineRuns >= RUN_LIMITS.engineRuns) throw Object.assign(new Error('The plan has used its engine runs.'), { code: 'budget_exceeded', path: '/budget/engineRuns' });
            caseFile.budget.engineRuns++;
          } };
          result = await executors[name](caseFile, input, execution);
        }
      }
    } catch (error) { result = fromError(error); }
  }
  const record = { sequence: caseFile.runLog.length + 1, tool: name, input: cloneJson(input ?? null), result: cloneJson(result) };
  caseFile.runLog.push(record);
  if (name === 'submit_story') caseFile.checkerReports.push({ sequence: record.sequence, result: record.result });
  return { caseFile, result };
}
