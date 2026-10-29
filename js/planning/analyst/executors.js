import { getFigures } from '../figures/get_figures.js';
import { getExplainers } from '../figures/get_explainers.js';
import { readPlanPosition } from '../plan_pack/story_facts.js';
import { FIGURE_PREFIX, compactStoryFacts, referencedPlaceholders, storyFactRegistry } from '../../plan_story_registry.js';
import { compilePlanPack } from '../plan_pack/compiler.js';
import { normalizePlanPack } from '../plan_pack/schema.js';
import { resolveStory, resolveNarration } from '../../plan_story_model.js';
import { cloneJson, assertIsoDate } from '../utils.js';
import { compiledFacts } from './facts.js';
import { missingFactQuestions } from './questions.js';
import { TOOL_CATALOGUE, ENGINE_TOOLS, validateToolInput, refused, budgetRefusal } from './contracts.js';
import { caseRefusal } from './case_file.js';

const ok = data => ({ ok: true, status: 'ok', data });
const fromError = (error, fallback = '/input') => ({ ok: false, status: 'refused',
  refusals: error.diagnostics ?? [{ code: error.code ?? 'invalid_input', path: error.path ?? fallback, message: error.message }] });

function readPosition(caseFile) {
  const compiled = caseFile.pinned.currentPosition;
  const facts = compiledFacts(compiled, 'current');
  caseFile.factRegistry.current = facts.registry;
  return ok({ route: compiled.routes[0], ledgerSummary: facts.ledgerSummary, chapters: facts.chapters,
    facts: facts.registry, diagnostics: compiled.resourceLedger.routes[0]?.diagnostics ?? [],
    omittedChapters: caseFile.pinned.omittedChapters,
    // The keys a story may use, as the story screen opens them (docs/story-facts.md). `facts` is the older metrics registry.
    storyFacts: compactStoryFacts(readPlanPosition(compiled), 'current'),
    scope: 'Compiled current position only. Write a story with the keys in `storyFacts`: they are the ones the story screen can open. `facts` is the older metrics registry.' });
}

function readFigures(caseFile, input) {
  if (input.onDate !== undefined) {
    try { assertIsoDate(input.onDate, 'onDate'); }
    catch (error) { return refused('invalid_input', '/input/onDate', error.message); }
  }
  const unknown = input.ids?.find(id => !getFigures().some(figure => figure.id === id));
  if (unknown) return refused('unknown_figure', '/input/ids/' + input.ids.indexOf(unknown), 'The register has no figure with this ID.');
  const figures = getFigures(input);
  for (const figure of figures) {
    const id = 'figure.' + figure.id;
    // Figure facts are global to this run, never borrowed from another route.
    caseFile.factRegistry.figures ??= {};
    caseFile.factRegistry.figures[id] = { id, value: figure.value, unit: figure.unit, text: figure.valueShown,
      source: { panel: 'figures', registerSource: figure.source, checkedOn: figure.checkedOn,
        catalogueVersion: figure.catalogueVersion, versions: caseFile.pinned.versions } };
  }
  return ok({ figures, versions: caseFile.pinned.versions });
}

async function priceRoute(caseFile, { route, reason }) {
  if (route.id === 'current') return refused('immutable_current', '/input/route/id', 'The current route is pinned; use a new alternative ID.');
  // No household, planning inputs or compiler options are accepted from tools.
  // Every call starts with the pinned pack, not a previously mutated route.
  const pack = cloneJson(caseFile.pinned.planPack);
  pack.routes = [{ id: 'current', changes: [] }, route];
  pack.narration = {};
  try { normalizePlanPack(pack); }
  catch (error) { return fromError(error); }
  caseFile.routeDrafts[route.id] = { route: cloneJson(route), ...(reason ? { reason } : {}) };
  const compiled = await compilePlanPack(pack, { resourceLedger: true });
  if (compiled.status !== 'compiled') return fromError({ diagnostics: compiled.diagnostics });
  const facts = compiledFacts(compiled, route.id);
  const result = { route: compiled.routes.find(row => row.id === route.id),
    ledger: compiled.resourceLedger.routes.find(row => row.routeId === route.id),
    chapters: facts.chapters, facts: facts.registry, ledgerSummary: facts.ledgerSummary,
    storyFacts: compactStoryFacts(readPlanPosition(compiled), route.id),
    versions: compiled.versions, sourceHash: compiled.source.hash };
  caseFile.pricedRoutes[route.id] = compiled;
  caseFile.factRegistry[route.id] = facts.registry;
  delete caseFile.storyDrafts[route.id];
  return ok(result);
}

/** The facts a story on this route may use, as the story screen opens them: `readPlanPosition` on the plan this route was priced in. */
function storyFacts(caseFile, routeId) {
  try {
    const compiled = routeId === 'current' ? caseFile.pinned.currentPosition : caseFile.pricedRoutes[routeId];
    return storyFactRegistry(readPlanPosition(compiled), routeId);
  } catch (_error) { return {}; }
}

function submitStory(caseFile, { story }) {
  const { routeId } = story;
  if (routeId !== 'current' && !Object.hasOwn(caseFile.pricedRoutes, routeId)) {
    return refused('unpriced_route', '/input/story/routeId', 'Price this route before submitting its story.');
  }
  caseFile.storyDrafts[routeId] = cloneJson(story);
  const onScreen = storyFacts(caseFile, routeId);
  // `storyFacts` are the keys the story screen opens; the older metrics registry is still accepted here, but a story using it cannot be opened.
  const registry = { ...caseFile.factRegistry[routeId], ...caseFile.factRegistry.figures, ...onScreen };
  const explainers = Object.fromEntries(getExplainers().map(explainer => [explainer.id, explainer]));
  try {
    resolveStory({ story, registry, explainers });
    const ids = new Set();
    for (const [index, goal] of (story.sections[4].goals ?? []).entries()) {
      const path = '/story/sections/4/goals/' + index;
      if (!caseFile.pinned.profile.goals.some(row => row.goalId === goal.goalId) || ids.has(goal.goalId)) {
        return refused('invalid_goal', path + '/goalId', 'Name a household goal once.');
      }
      ids.add(goal.goalId);
      resolveNarration(goal.title, registry, { path: path + '/title', explainers });
      for (const [part, text] of Object.entries(goal.parts)) resolveNarration(text, registry, { path: path + '/parts/' + part, explainers });
    }
    // A key outside `storyFacts` (and not a register figure) passes the older checks but cannot be opened on the story screen.
    const { keys } = referencedPlaceholders(story);
    const notOnScreen = [...keys].filter(key => !Object.hasOwn(onScreen, key)
      && !(key.startsWith(FIGURE_PREFIX) && getFigures().some(figure => figure.id === key.slice(FIGURE_PREFIX.length)))).sort();
    return ok({ verdict: 'passes_available_checks', scope: 'B1.5 shape and plan_story_model checks only',
      fullChecker: 'not built yet', reviewStatus: 'pending', releaseEligible: false,
      openOnStoryScreen: notOnScreen.length === 0, ...(notOnScreen.length ? { keysNotOnStoryScreen: notOnScreen } : {}) });
  } catch (error) { return fromError(error, '/story'); }
}

const notBuilt = (_caseFile, _input, name) => refused('not_built_yet', '/tools/' + name, 'not built yet');
const executors = {
  read_position: readPosition, read_figures: readFigures, price_route: priceRoute,
  missing_facts: caseFile => ok(missingFactQuestions(caseFile)), submit_story: submitStory,
  goal_ways: caseFile => notBuilt(caseFile, null, 'goal_ways'),
  suggest_routes: caseFile => notBuilt(caseFile, null, 'suggest_routes'),
  balancing_moves: caseFile => notBuilt(caseFile, null, 'balancing_moves'),
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
