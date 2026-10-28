import { buildGlance, resolveStory } from './plan_story_model.js';
import { PLAN_STORY_BASIS_KINDS } from './plan_story_basis.js';

/**
 * THE STORY, AS A SESSION KEEPS IT.
 *
 * A session for a plan built through the form carries one optional `planStory`:
 * the routes, a story and its facts for each route that has been told, and which
 * session module each plan chapter became. Everything on it is plain JSON that
 * the plan's code produced; the screen only reads it.
 *
 * It is normalised on the way in like every other part of a session, and a bad
 * one is dropped with a warning rather than allowed to stop the session opening.
 */

const PLAN_STORY_VERSION = 1;

const MAX_ROUTES = 4;
const MAX_FACTS = 400;
const MAX_TEXT = 4000;
const MAX_EXPLAINERS = 40;
const MAX_CASE_MODULES = 60;

/** Small marks until each module has an icon of its own. */
export const PLAN_STORY_DEFAULT_GLYPHS = Object.freeze({
  household_cash_flow: 'flow',
  liquidity_analysis: 'res',
  protection_gap: 'prot',
  mortgage_analysis: 'mort',
  loan_analysis: 'car',
  future_cost_fund: 'coll',
  college_funding: 'coll',
  pension_projection: 'pen',
  net_retirement_cashflow: 'pen',
  personal_balance_sheet: 'bal',
  goals_and_resources: 'bal'
});

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const idPattern = /^[a-z][a-z0-9_-]{0,63}$/;

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanCatalogue(raw) {
  if (!isPlain(raw)) return { chapters: {}, cases: {} };
  const chapters = {};
  for (const [id, entry] of Object.entries(isPlain(raw.chapters) ? raw.chapters : {})) {
    if (idPattern.test(id) && isPlain(entry) && typeof entry.title === 'string' && entry.title.trim()) {
      chapters[id] = { title: entry.title.trim().slice(0, 80), glyph: typeof entry.glyph === 'string' ? entry.glyph : null };
    }
  }
  const cases = {};
  for (const [chapter, list] of Object.entries(isPlain(raw.cases) ? raw.cases : {})) {
    if (!idPattern.test(chapter) || !isPlain(list)) continue;
    cases[chapter] = Object.fromEntries(Object.entries(list).filter(([, title]) => typeof title === 'string' && title.trim()).map(([id, title]) => [id, title.trim().slice(0, 80)]));
  }
  return { chapters, cases };
}

/** A cell of the at-a-glance table: its words, "About" when rounded, and where the figure comes from when the plan says. */
function cleanCell(raw) {
  const basis = raw?.basis;
  if (basis !== undefined && (!isPlain(basis) || !PLAN_STORY_BASIS_KINDS.includes(basis.kind))) throw new Error('a glance figure has a basis the screen does not know.');
  return {
    text: String(raw?.text ?? '').slice(0, 40),
    ...(raw?.approx ? { approx: true } : {}),
    ...(basis ? { basis: jsonClone(basis) } : {})
  };
}

/** The explainers a story may point to, copied whole from the register by the code that built the story. */
function cleanExplainers(raw) {
  const explainers = {};
  for (const [id, entry] of Object.entries(isPlain(raw) ? raw : {}).slice(0, MAX_EXPLAINERS)) {
    if (!/^[a-z][a-z0-9_]*$/.test(id) || !isPlain(entry) || typeof entry.title !== 'string' || !entry.title.trim()) continue;
    const sentences = (Array.isArray(entry.sentences) ? entry.sentences : []).filter((sentence) => typeof sentence === 'string' && sentence.trim()).slice(0, 8);
    if (!sentences.length) continue;
    explainers[id] = {
      title: entry.title.trim().slice(0, 200),
      sentences: sentences.map((sentence) => sentence.trim().slice(0, 600)),
      sources: (Array.isArray(entry.sources) ? entry.sources : []).filter((source) => isPlain(source) && typeof source.title === 'string' && source.title.trim()).slice(0, 8)
        .map((source) => ({ title: source.title.trim().slice(0, 200), url: typeof source.url === 'string' && /^https:\/\//.test(source.url) ? source.url.slice(0, 500) : null })),
      checkedOn: typeof entry.checkedOn === 'string' ? entry.checkedOn.slice(0, 10) : null,
      catalogueVersion: typeof entry.catalogueVersion === 'string' ? entry.catalogueVersion.slice(0, 60) : null
    };
  }
  return explainers;
}

/**
 * Which session module shows which compiled case. A plan compiled with several routes has several cases of
 * the same chapter (each its own module); a link names its case, and this says which module that is.
 */
function cleanCaseModules(raw) {
  const caseModules = {};
  for (const [caseId, entry] of Object.entries(isPlain(raw) ? raw : {}).slice(0, MAX_CASE_MODULES)) {
    if (!isPlain(entry) || !idPattern.test(entry.chapter) || typeof entry.moduleId !== 'string' || !entry.moduleId.trim()) continue;
    caseModules[caseId] = { chapter: entry.chapter, moduleId: entry.moduleId, routeIds: (Array.isArray(entry.routeIds) ? entry.routeIds : []).filter((id) => typeof id === 'string' && idPattern.test(id)) };
  }
  return caseModules;
}

/** The module that shows the case a link names: by compiled case when the plan has them, otherwise by chapter. */
export function planStoryModuleFor(planStory, target) {
  return planStory?.caseModules?.[target?.caseId]?.moduleId ?? planStory?.chapterModules?.[target?.chapter] ?? null;
}

/** The chapter a session module belongs to, so the app can find the case controls that module answers to. */
export function planStoryChapterOf(planStory, moduleId) {
  const compiled = Object.values(planStory?.caseModules ?? {}).find((entry) => entry.moduleId === moduleId);
  if (compiled) return compiled.chapter;
  return Object.keys(planStory?.chapterModules ?? {}).find((chapter) => planStory.chapterModules[chapter] === moduleId) ?? null;
}

/** Returns a clean `planStory`, or null (after saying why through `warn`). */
export function normalizePlanStory(raw, { warn = () => {} } = {}) {
  if (raw === undefined || raw === null) return null;
  const drop = (reason) => { warn(`The plan story was left out: ${reason}`); return null; };
  if (!isPlain(raw)) return drop('it must be an object.');
  if (raw.version !== PLAN_STORY_VERSION) return drop(`version ${raw.version} is not supported.`);
  if (!Array.isArray(raw.routes) || raw.routes.length < 1 || raw.routes.length > MAX_ROUTES) return drop(`it needs between 1 and ${MAX_ROUTES} routes.`);

  let routes;
  try {
    routes = raw.routes.map((route) => {
      if (!isPlain(route) || !idPattern.test(route.id)) throw new Error('every route needs an id.');
      return {
        id: route.id,
        number: Number.isInteger(route.number) ? route.number : null,
        name: String(route.name || '').trim().slice(0, 80),
        savingsUsed: cleanCell(route.savingsUsed),
        leftOver: cleanCell(route.leftOver),
        goalsCovered: cleanCell(route.goalsCovered)
      };
    });
    if (new Set(routes.map((route) => route.id)).size !== routes.length) throw new Error('route ids must be unique.');
    if (routes.some((route) => !route.name || route.number === null)) throw new Error('every route needs a number and a name.');
    // On the raw routes, so a rank or score field is refused rather than quietly dropped by the copy above.
    buildGlance(raw.routes);
  } catch (error) {
    return drop(error.message);
  }

  const selectedRouteId = routes.some((route) => route.id === raw.selectedRouteId) ? raw.selectedRouteId : routes[0].id;
  const catalogue = cleanCatalogue(raw.catalogue);
  const explainers = cleanExplainers(raw.explainers);
  const registries = {};
  const stories = {};
  for (const route of routes) {
    const story = raw.stories?.[route.id];
    const registry = raw.registries?.[route.id];
    if (!story) continue;
    if (!isPlain(story) || !isPlain(registry) || Object.keys(registry).length > MAX_FACTS) { warn(`The story for ${route.id} was left out: it needs its facts.`); continue; }
    try {
      if (story.routeId !== route.id) throw new Error('the story routeId does not match its route.');
      resolveStory({ story, registry, catalogue, explainers });
    } catch (error) {
      warn(`The story for ${route.id} was left out: ${error.message}`);
      continue;
    }
    stories[route.id] = jsonClone(story);
    registries[route.id] = jsonClone(registry);
  }

  const chapterModules = {};
  for (const [chapter, moduleId] of Object.entries(isPlain(raw.chapterModules) ? raw.chapterModules : {})) {
    if (idPattern.test(chapter) && typeof moduleId === 'string' && moduleId.trim()) chapterModules[chapter] = moduleId;
  }

  const caseModules = cleanCaseModules(raw.caseModules);

  return {
    version: PLAN_STORY_VERSION,
    routes,
    selectedRouteId,
    stories,
    registries,
    catalogue,
    chapterModules,
    ...(Object.keys(caseModules).length ? { caseModules } : {}),
    ...(Object.keys(explainers).length ? { explainers } : {}),
    glanceNote: typeof raw.glanceNote === 'string' ? raw.glanceNote.slice(0, MAX_TEXT) : ''
  };
}

/**
 * What the screen needs for one route, or why it cannot be drawn. Chapter titles
 * come from the session's own modules, so a story can never name a module the
 * session does not have; marks fall back to the defaults above.
 */
export function buildPlanStoryScreen(planStory, session, routeId = planStory.selectedRouteId) {
  const route = planStory.routes.find((entry) => entry.id === routeId) || planStory.routes[0];
  const modulesById = new Map((session?.modules || []).map((module) => [module.id, module]));
  const chapters = { ...planStory.catalogue.chapters };
  for (const [chapter, moduleId] of Object.entries(planStory.chapterModules)) {
    const module = modulesById.get(moduleId);
    if (!module) continue;
    chapters[chapter] = {
      title: chapters[chapter]?.title || module.title || chapter,
      glyph: chapters[chapter]?.glyph || PLAN_STORY_DEFAULT_GLYPHS[chapter] || null
    };
  }
  for (const { chapter, moduleId } of Object.values(planStory.caseModules ?? {})) {
    const module = modulesById.get(moduleId);
    if (!module || chapters[chapter]?.title) continue;
    chapters[chapter] = { title: module.title || chapter, glyph: PLAN_STORY_DEFAULT_GLYPHS[chapter] || null };
  }
  const catalogue = { chapters, cases: planStory.catalogue.cases };
  const story = planStory.stories[route.id] || null;
  let resolved = null;
  if (story) resolved = resolveStory({ story, registry: planStory.registries[route.id], catalogue, explainers: planStory.explainers ?? {} });
  return { route, routes: planStory.routes, glance: buildGlance(planStory.routes), catalogue, resolved, storyMissing: !story };
}
