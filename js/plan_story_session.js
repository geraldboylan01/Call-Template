import { buildGlance, resolveStory } from './plan_story_model.js';

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

export const PLAN_STORY_VERSION = 1;

const MAX_ROUTES = 6;
const MAX_FACTS = 400;
const MAX_TEXT = 4000;

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
        savingsUsed: { text: String(route.savingsUsed?.text ?? '').slice(0, 40), ...(route.savingsUsed?.approx ? { approx: true } : {}) },
        leftOver: { text: String(route.leftOver?.text ?? '').slice(0, 40), ...(route.leftOver?.approx ? { approx: true } : {}) },
        goalsCovered: { text: String(route.goalsCovered?.text ?? '').slice(0, 40), ...(route.goalsCovered?.approx ? { approx: true } : {}) }
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
  const registries = {};
  const stories = {};
  for (const route of routes) {
    const story = raw.stories?.[route.id];
    const registry = raw.registries?.[route.id];
    if (!story) continue;
    if (!isPlain(story) || !isPlain(registry) || Object.keys(registry).length > MAX_FACTS) { warn(`The story for ${route.id} was left out: it needs its facts.`); continue; }
    try {
      resolveStory({ story, registry, catalogue });
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

  return {
    version: PLAN_STORY_VERSION,
    routes,
    selectedRouteId,
    stories,
    registries,
    catalogue,
    chapterModules,
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
  const catalogue = { chapters, cases: planStory.catalogue.cases };
  const story = planStory.stories[route.id] || null;
  let resolved = null;
  if (story) resolved = resolveStory({ story, registry: planStory.registries[route.id], catalogue });
  return { route, routes: planStory.routes, glance: buildGlance(planStory.routes), catalogue, resolved, storyMissing: !story };
}
