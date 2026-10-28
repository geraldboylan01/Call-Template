import { getFigures } from '../figures/get_figures.js';
import { getExplainers } from '../figures/get_explainers.js';
import { profileToPlanPack } from '../profile_to_plan_pack.js';
import { validateLeverSources } from '../plan_pack/lever_catalogue.js';
import { sizeMajorMove } from '../plan_pack/major_move_search.js';
import { PROPERTY_LEVERS } from '../plan_pack/property_moves.js';
import { resolveStory, resolveNarration } from '../../plan_story_model.js';
import { cloneJson, assertIsoDate } from '../utils.js';
import { compiledFacts } from './facts.js';
import { missingFactQuestions } from './questions.js';
import { TOOL_CATALOGUE, ENGINE_TOOLS, RUN_LIMITS, validateToolInput, refused, budgetRefusal } from './contracts.js';
import { caseRefusal } from './case_file.js';

const ok = data => ({ ok: true, status: 'ok', data });
const fromError = (error, fallback = '/input') => ({ ok: false, status: 'refused',
  refusals: error.diagnostics ?? [{ code: error.code ?? 'invalid_input', path: error.path ?? fallback, message: error.message }] });

function readPosition(caseFile, { routeId = 'current' }) {
  const compiled = routeId === 'current' ? caseFile.pinned.currentPosition : caseFile.pricedRoutes[routeId];
  if (!compiled || !Object.hasOwn(caseFile.factRegistry, routeId)) return refused('unpriced_route', '/input/routeId', 'Read current or a successfully priced route.');
  const facts = compiledFacts(compiled, routeId);
  caseFile.factRegistry[routeId] = facts.registry;
  return ok(facts.position);
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

const assembleRoutes = (caseFile, routes) => profileToPlanPack(caseFile.pinned.profile, {
  confirmedRevision: caseFile.pinned.confirmedRevision, calculationDate: caseFile.pinned.calculationDate,
  clientLabel: caseFile.pinned.planPack.clientName, routes
});

function pricedResult(caseFile, compiled, routeId) {
  const facts = compiledFacts(compiled, routeId);
  caseFile.pricedRoutes[routeId] = compiled;
  caseFile.factRegistry[routeId] = facts.registry;
  delete caseFile.storyDrafts[routeId];
  return { route: compiled.routes.find(row => row.id === routeId),
    ledger: compiled.resourceLedger.routes.find(row => row.routeId === routeId),
    position: facts.position.routes.find(row => row.routeId === routeId),
    chapters: facts.chapters, facts: facts.position.routes.find(row => row.routeId === routeId).facts,
    ledgerSummary: facts.ledgerSummary, versions: compiled.versions, sourceHash: compiled.source.hash };
}

async function priceRoute(caseFile, { route, reason }) {
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
  const assembly = await assembleRoutes(caseFile, [route]);
  const compiled = assembly.compilation;
  if (compiled?.status !== 'compiled') return { ...fromError({ diagnostics: assembly.routeRefusals ?? assembly.missingFacts.map(row => ({
    code: row.factId, path: row.fieldPath, message: row.reason
  })) }), data: { settingSourceChecks: checks, ledgers: compiled?.resourceLedger?.routes ?? [], omittedChapters: assembly.omittedChapters } };
  return ok({ ...pricedResult(caseFile, compiled, route.id), settingSourceChecks: checks, omittedChapters: assembly.omittedChapters });
}

async function balancingMoves(caseFile, { route: inputRoute, routeId, type, propertyId, year }) {
  const route = inputRoute ?? caseFile.routeDrafts[routeId]?.route;
  if (!route) return refused('unknown_route', '/input/routeId', 'Supply a route draft or the ID of a saved draft.');
  if (route.id === 'current') return refused('immutable_current', '/input/route/id', 'Size a move for an alternative draft.');
  if (inputRoute && routeId && inputRoute.id !== routeId) return refused('invalid_input', '/input/routeId', 'The route ID must match the supplied draft.');
  const checks = settingSourceChecks(caseFile.pinned.planPack, route);
  const failures = checks.flatMap(check => check.refusals ?? []);
  if (failures.length) return { ...fromError({ diagnostics: failures }), data: { settingSourceChecks: checks } };
  const assembly = await assembleRoutes(caseFile, []);
  if (!assembly.planPack) return fromError({ diagnostics: assembly.routeRefusals ?? assembly.missingFacts.map(row => ({ code: row.factId, path: row.fieldPath, message: row.reason })) });
  const sized = await sizeMajorMove(assembly.planPack, route, { type, propertyId, year },
    { maxProbes: RUN_LIMITS.engineRuns - caseFile.budget.engineRuns });
  caseFile.budget.engineRuns += sized.probes?.length ?? 0;
  if (sized.status === 'refused') return { ...fromError({ diagnostics: sized.refusals }), data: { ...sized, settingSourceChecks: checks } };
  if (sized.status === 'sized') {
    caseFile.routeDrafts[route.id] = { route: cloneJson(sized.route), reason: 'Native major-move sizing within the recorded bounds.' };
    const priced = pricedResult(caseFile, sized.compilation, route.id);
    return ok({ ...sized, position: priced.position, facts: priced.facts, versions: priced.versions, sourceHash: priced.sourceHash,
      settingSourceChecks: settingSourceChecks(assembly.planPack, sized.route) });
  }
  return ok({ ...sized, settingSourceChecks: checks });
}

function submitStory(caseFile, { story }) {
  const { routeId } = story;
  if (routeId !== 'current' && !Object.hasOwn(caseFile.pricedRoutes, routeId)) {
    return refused('unpriced_route', '/input/story/routeId', 'Price this route before submitting its story.');
  }
  caseFile.storyDrafts[routeId] = cloneJson(story);
  // The current screen model consumes text; story facts keep their native
  // display/status/source contract in the case. Missing facts stay unavailable.
  const registry = Object.fromEntries(Object.entries({ ...caseFile.factRegistry[routeId], ...caseFile.factRegistry.figures })
    .map(([key, fact]) => [key, { ...fact, text: fact.status ? fact.status === 'available' ? fact.display : null : fact.text,
      source: { ...fact.source, ...(fact.source?.chapter ? { panel: null } : {}) } }]));
  try {
    resolveStory({ story, registry });
    const ids = new Set();
    for (const [index, goal] of (story.sections[4].goals ?? []).entries()) {
      const path = '/story/sections/4/goals/' + index;
      if (!caseFile.pinned.profile.goals.some(row => row.goalId === goal.goalId) || ids.has(goal.goalId)) {
        return refused('invalid_goal', path + '/goalId', 'Name a household goal once.');
      }
      ids.add(goal.goalId);
      resolveNarration(goal.title, registry, { path: path + '/title' });
      for (const [part, text] of Object.entries(goal.parts)) resolveNarration(text, registry, { path: path + '/parts/' + part });
    }
    return ok({ verdict: 'passes_available_checks', scope: 'B1.5 shape and plan_story_model checks only',
      fullChecker: 'not built yet', reviewStatus: 'pending', releaseEligible: false });
  } catch (error) { return fromError(error, '/story'); }
}

const notBuilt = (_caseFile, _input, name) => refused('not_built_yet', '/tools/' + name, 'not built yet');
const executors = {
  read_position: readPosition, read_figures: readFigures, read_explainers: readExplainers, price_route: priceRoute,
  missing_facts: caseFile => ok(missingFactQuestions(caseFile)), submit_story: submitStory,
  goal_ways: caseFile => notBuilt(caseFile, null, 'goal_ways'),
  suggest_routes: caseFile => notBuilt(caseFile, null, 'suggest_routes'),
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
  else if (name === 'balancing_moves' && !PROPERTY_LEVERS.includes(input?.type)) result = notBuilt(caseFile, null, name);
  else {
    try {
      result = await caseRefusal(caseFile);
      if (!result) {
        const errors = validateToolInput(name, input);
        result = errors.length ? { ok: false, status: 'refused', refusals: errors }
          : budgetRefusal(caseFile, name, input);
        if (!result) {
          // Charge centrally before executing, including an engine refusal.
          // Replacing a stub cannot accidentally bypass the shared counters.
          if (ENGINE_TOOLS.includes(name)) caseFile.budget.engineRuns++;
          if (name === 'run_whatif') caseFile.budget.whatifsByRoute[input.routeId] = (caseFile.budget.whatifsByRoute[input.routeId] ?? 0) + 1;
          result = await executors[name](caseFile, input);
        }
      }
    } catch (error) { result = fromError(error); }
  }
  const record = { sequence: caseFile.runLog.length + 1, tool: name, input: cloneJson(input ?? null), result: cloneJson(result) };
  caseFile.runLog.push(record);
  if (name === 'submit_story') caseFile.checkerReports.push({ sequence: record.sequence, result: record.result });
  return { caseFile, result };
}
