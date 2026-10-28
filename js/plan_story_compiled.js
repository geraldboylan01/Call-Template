import { readPlanPosition } from './planning/plan_pack/story_facts.js';
import { getFigures } from './planning/figures/get_figures.js';
import { getExplainers } from './planning/figures/get_explainers.js';
import { PlanStoryError, parseNarration, resolveStory } from './plan_story_model.js';
import { PLAN_STORY_DEFAULT_GLYPHS } from './plan_story_session.js';
import { checkModulePayload } from './module_pipeline.js';
import { buildPresentationCatalogue } from './presenter_catalogue.js';
import { importSession, newSession, drainSessionImportWarnings } from './state.js';

/**
 * THE STORY SCREEN, READING A COMPILED PLAN.
 *
 * A compiled plan (plan-pack compiler, resource ledger) and a story written for
 * it become what the app opens: a `planStory` (this file's `buildPlanStory`) and
 * a whole session with a module for every compiled case the story can link to
 * (`buildSessionFromPlan`).
 *
 * Nothing on the screen comes from the story but words. Every figure is filled
 * from `readPlanPosition(compiled)` (docs/story-facts.md): its text, the module
 * and case it came from (the route's `chapterCases` and the native case inside
 * the module), the exact target in that module where the presenter catalogue has
 * one, and the basis the screen shows on hover or tap. A `{figure.<id>}` is read
 * from the figures register and an explainer from the explainer catalogue, in
 * the same way. A placeholder the plan did not produce is refused with its path.
 *
 * `story` is B1.5 section 3's `story[routeId]`: an object keyed by route id, or
 * one story object with its own `routeId`.
 */

const PARTS = ['does', 'why', 'gives', 'costs', 'check'];
const FIGURE_PREFIX = 'figure.';

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const euro = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

/** Every narration string in a story (headline, summary, section titles, parts, goal subsections). */
function* narrations(story) {
  yield story.headline;
  yield story.summary;
  const parts = (holder) => [...(holder.paragraphs ?? []), ...PARTS.map((part) => holder.parts?.[part])];
  for (const section of story.sections ?? []) {
    yield section.title;
    yield* parts(section);
    for (const goal of section.goals ?? []) {
      yield goal.title;
      yield* parts(goal);
    }
  }
}

/** The placeholders a story names, so only those facts travel with it. Bad text is left for resolveStory to refuse, with its path. */
function referenced(story) {
  const keys = new Set();
  const explainers = new Set();
  for (const text of narrations(story)) {
    let tokens = [];
    try { tokens = parseNarration(text); } catch (_error) { continue; }
    for (const token of tokens) {
      if (token.type !== 'placeholder') continue;
      if (token.explainer) explainers.add(token.key.slice('explainer.'.length));
      else keys.add(token.key);
    }
  }
  return { keys, explainers };
}

/** Where a fact opens: the module and case it came from, or the part of the plan view that worked it out. */
function linkSource(source) {
  if (source?.chapter) {
    return {
      chapter: source.chapter,
      caseId: source.caseId ?? null,
      nativeCaseId: source.nativeCaseId ?? null,
      focusTargetId: source.focusTargetId ?? null
    };
  }
  return { panel: source?.panel ?? 'plan_facts' };
}

function figureFact(id, calculationDate) {
  let figure;
  try { [figure] = getFigures({ ids: [id], onDate: calculationDate }); } catch (_error) { return null; }
  if (!figure) return null;
  return {
    text: figure.valueShown,
    source: { panel: 'figures' },
    basis: {
      kind: 'official', registerId: figure.id, value: figure.value, source: { ...figure.source },
      checkedOn: figure.checkedOn, catalogueVersion: figure.catalogueVersion
    }
  };
}

function humanise(id) {
  const words = String(id).replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : String(id);
}

const routeName = (route) => (route.id === 'current' ? 'Current position' : route.title && route.title !== route.id ? route.title : humanise(route.id));

/** The at-a-glance column for one route: every cell is a figure the plan produced, with the basis it carries. */
function glanceRoute(compiled, position, route, number) {
  const facts = position.routes.find((entry) => entry.routeId === route.id).facts;
  const ledgerIndex = (compiled.resourceLedger?.routes ?? []).findIndex((row) => row.routeId === route.id);
  const ledger = ledgerIndex >= 0 ? compiled.resourceLedger.routes[ledgerIndex] : null;
  const ledgerPath = `/resourceLedger/routes/${ledgerIndex}`;
  const calculated = (calculation, inputs) => ({ kind: 'calculated', engine: 'resource_ledger', calculation, inputs });

  const used = ledger && Number.isFinite(ledger.cashAllocated)
    ? { text: ledger.cashAllocated > 0 ? euro.format(ledger.cashAllocated) : 'None', basis: calculated('cash_allocated_to_goals', [`${ledgerPath}/cashAllocated`]) }
    : { text: 'Not priced' };

  // Whole euros, so a column of four routes fits; the story's own text keeps the fact's exact display.
  const after = facts['leftOverAfterGoals.yearly']?.status === 'available' ? facts['leftOverAfterGoals.yearly'] : facts['position.leftOver'];
  const left = after?.status === 'available' ? { text: euro.format(after.value), basis: after.basis } : { text: 'Not priced' };

  const goals = ledger?.goals ?? [];
  const covered = goals.filter((goal) => goal.state === 'covered').length;
  const goalsCovered = !goals.length ? { text: 'Not priced' }
    : { text: covered === goals.length ? 'All' : covered === 0 ? 'None' : `${covered} of ${goals.length}`, basis: calculated('goal_states', [`${ledgerPath}/goals`]) };

  return { id: route.id, number, name: routeName(route), savingsUsed: used, leftOver: left, goalsCovered };
}

/**
 * A planStory (the session's `planStory`, version 1) from a compiled plan and its stories.
 *
 * @param {object} compiled A successfully compiled plan (with its resource ledger).
 * @param {object} story    `{ [routeId]: story }`, or a single story with a `routeId`.
 * @throws {PlanStoryError} when a story names a route the plan does not hold, or a placeholder it did not produce.
 */
export function buildPlanStory(compiled, story, { selectedRouteId = null } = {}) {
  const position = readPlanPosition(compiled);
  const stories = isPlain(story) && Array.isArray(story.sections) ? { [story.routeId]: story } : (story ?? {});
  const routes = compiled.routes.filter((route) => route.status === 'compiled');
  for (const id of Object.keys(stories)) {
    if (!routes.some((route) => route.id === id)) throw new PlanStoryError(`/story/${id}`, 'the compiled plan has no route with this id.', 'unknown_route');
    if (stories[id]?.routeId !== id) throw new PlanStoryError(`/story/${id}/routeId`, 'must be the route this story is under.', 'invalid_story');
  }

  // The modules: one per compiled case, in the order the routes first use them. A compiled case id is the module id.
  const caseOrder = [];
  const caseModules = {};
  const cases = {};
  const chapters = {};
  for (const route of routes) {
    for (const chapter of compiled.chapters) {
      const caseId = route.chapterCases[chapter.id];
      const entry = chapter.cases.find((row) => row.id === caseId);
      if (!entry) continue;
      chapters[chapter.id] ??= { title: entry.payload.title, glyph: PLAN_STORY_DEFAULT_GLYPHS[chapter.id] ?? null };
      if (!caseModules[caseId]) {
        caseModules[caseId] = { chapter: chapter.id, moduleId: caseId, routeIds: [] };
        caseOrder.push(caseId);
      }
      caseModules[caseId].routeIds.push(route.id);
      cases[chapter.id] ??= {};
      cases[chapter.id][caseId] = caseModules[caseId].routeIds.map((id) => routeName(routes.find((row) => row.id === id))).join(', ');
    }
  }
  const current = routes.find((route) => route.id === 'current');
  const chapterModules = Object.fromEntries(Object.entries(current?.chapterCases ?? {}).filter(([, caseId]) => caseModules[caseId]));

  const catalogue = { chapters, cases };
  const registries = {};
  const explainerIds = new Set();
  for (const [routeId, routeStory] of Object.entries(stories)) {
    const facts = position.routes.find((entry) => entry.routeId === routeId).facts;
    const { keys, explainers } = referenced(routeStory);
    const registry = {};
    for (const key of keys) {
      if (key.startsWith(FIGURE_PREFIX)) {
        const figure = figureFact(key.slice(FIGURE_PREFIX.length), compiled.calculationDate);
        if (figure) registry[key] = figure;
        continue;
      }
      const fact = facts[key];
      if (fact?.status !== 'available') continue;
      registry[key] = { text: fact.display, source: linkSource(fact.source), basis: fact.basis, ...(fact.explainerId ? { explainerId: fact.explainerId } : {}) };
      if (fact.explainerId) explainerIds.add(fact.explainerId);
    }
    registries[routeId] = registry;
    for (const id of explainers) explainerIds.add(id);
  }

  const held = new Map(getExplainers().map((explainer) => [explainer.id, explainer]));
  const explainers = {};
  for (const id of [...explainerIds].sort()) {
    const explainer = held.get(id);
    if (explainer) explainers[id] = { title: explainer.title, sentences: [...explainer.sentences], sources: explainer.sources.map((source) => ({ ...source })), checkedOn: explainer.checkedOn, catalogueVersion: explainer.catalogueVersion };
  }

  // Refuse a story the screen cannot draw, with its path, and one with a figure that carries no basis.
  for (const [routeId, routeStory] of Object.entries(stories)) {
    let resolved;
    try { resolved = resolveStory({ story: routeStory, registry: registries[routeId], catalogue, explainers }); }
    catch (error) { if (error instanceof PlanStoryError) error.message = `${routeId}: ${error.message}`; throw error; }
    const segments = [resolved.headline, resolved.summary, ...resolved.sections.flatMap((section) => [section.titleSegments, ...section.paragraphs.map((p) => p.segments),
      ...section.goals.flatMap((goal) => [goal.titleSegments, ...goal.paragraphs.map((p) => p.segments)])])].flat();
    const bare = segments.find((segment) => ['figure', 'link', 'reason'].includes(segment.type) && !segment.basis);
    if (bare) throw new PlanStoryError(`/story/${routeId}`, `{${bare.key}} has no basis, so the screen cannot say where it comes from.`, 'missing_basis');
  }

  const planRoutes = routes.map((route, index) => glanceRoute(compiled, position, route, index + 1));
  return {
    version: 1,
    routes: planRoutes,
    selectedRouteId: selectedRouteId ?? (stories.current ? 'current' : Object.keys(stories)[0] ?? 'current'),
    stories: clone(stories),
    registries,
    catalogue,
    chapterModules,
    caseModules,
    ...(Object.keys(explainers).length ? { explainers } : {}),
    glanceNote: ''
  };
}

/**
 * The focus targets in a compiled fact name the module by a fingerprint of how the compiler built it. The session
 * holds the module the app will show, so each target is looked up there (same place inside the module, the session
 * module's own fingerprint); one the session's module does not hold is dropped, and the link then opens the module
 * on its case without ringing anything.
 */
function bindFocusTargets(planStory, session) {
  const catalogue = buildPresentationCatalogue(session);
  const keyOf = new Map(catalogue.modules.map((module) => [module.moduleId, module.key]));
  const targets = new Set(catalogue.targets.map((target) => target.id));
  for (const registry of Object.values(planStory.registries)) {
    for (const fact of Object.values(registry)) {
      const source = fact.source;
      if (!source?.focusTargetId) continue;
      const key = keyOf.get(planStory.caseModules[source.caseId]?.moduleId);
      const local = source.focusTargetId.slice(source.focusTargetId.indexOf('/') + 1);
      const rebound = key ? `${key}/${local}` : null;
      source.focusTargetId = rebound && targets.has(rebound) ? rebound : null;
    }
  }
}

/**
 * A session the app can open: a module for every compiled case the plan's routes use (the module's id is the
 * compiled case id), in the order the routes first use them, and the `planStory`.
 *
 * @returns {object} the session as the app normalises it.
 * @throws when a compiled case cannot be built as a module, or the story does not survive the session's own checks.
 */
export function buildSessionFromPlan(compiled, story, { clientName = null, selectedRouteId = null } = {}) {
  const planStory = buildPlanStory(compiled, story, { selectedRouteId });
  const calculationYear = Number(String(compiled.calculationDate).slice(0, 4));
  const modules = [];
  for (const [caseId, { chapter }] of Object.entries(planStory.caseModules)) {
    const entry = compiled.chapters.find((row) => row.id === chapter).cases.find((row) => row.id === caseId);
    const checked = checkModulePayload(entry.payload, { calculationYear });
    if (!checked.ok) throw new Error(`${chapter} (${caseId}) could not be built as a module: ${checked.error}`);
    checked.module.id = caseId;
    modules.push(checked.module);
  }
  const session = newSession(clientName ?? compiled.clientName ?? 'Client');
  session.modules = modules;
  session.order = modules.map((module) => module.id);
  session.activeModuleId = session.order[0] ?? null;
  bindFocusTargets(planStory, { modules });
  session.planStory = planStory;

  drainSessionImportWarnings();
  const imported = importSession(JSON.stringify(session));
  const warnings = drainSessionImportWarnings();
  const kept = Object.keys(imported.planStory?.stories ?? {});
  const wanted = Object.keys(planStory.stories);
  if (!imported.planStory || wanted.some((id) => !kept.includes(id))) {
    throw new Error(`The session left out a story: ${warnings.join(' ') || 'it did not pass the screen’s own checks.'}`);
  }
  return imported;
}

