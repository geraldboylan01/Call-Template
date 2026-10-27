import { normalizePlanStory, buildPlanStoryScreen } from './plan_story_session.js';
import { buildSamplePlanStory } from './tests_plan_story_sample.js';

/**
 * THE STORY ON A SESSION.
 *
 * A bad story is dropped with a reason and the session still opens; a good one
 * survives a round trip unchanged; and the screen's chapter titles come from the
 * session's own modules.
 */

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message || 'Not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const MODULES = {
  household_cash_flow: 'm-hcf', liquidity_analysis: 'm-liq', protection_gap: 'm-pg', loan_analysis: 'm-car',
  mortgage_analysis: 'm-mort', future_cost_fund: 'm-fcf', pension_projection: 'm-pen', personal_balance_sheet: 'm-pbs'
};

function normalize(raw) {
  const warnings = [];
  const result = normalizePlanStory(raw, { warn: (message) => warnings.push(message) });
  return { result, warnings };
}

export function runPlanStorySessionTests() {
  const results = [];
  const test = (name, fn) => { fn(); results.push(name); };

  test('a good story survives a round trip unchanged', () => {
    const { result, warnings } = normalize(buildSamplePlanStory(MODULES));
    assertEqual(warnings, [], 'no warnings');
    assertEqual(normalize(JSON.parse(JSON.stringify(result))).result, result, 'idempotent');
    assertEqual(result.selectedRouteId, 'route-3', 'selected route');
    assertEqual(Object.keys(result.stories), ['route-3'], 'only the told route has a story');
  });

  test('no story, or the wrong kind of thing, is nothing and says nothing', () => {
    assertEqual(normalize(undefined), { result: null, warnings: [] }, 'undefined');
    assertEqual(normalize(null), { result: null, warnings: [] }, 'null');
    assert(normalize([]).warnings[0].includes('must be an object'), 'array refused');
  });

  test('a story the code cannot read is dropped with the reason, not thrown', () => {
    const wrongVersion = { ...buildSamplePlanStory(), version: 2 };
    assert(normalize(wrongVersion).warnings[0].includes('version 2'), 'version');
    assertEqual(normalize({ ...buildSamplePlanStory(), routes: [] }).result, null, 'no routes');
    const ranked = buildSamplePlanStory();
    ranked.routes[0].rank = 1;
    assert(normalize(ranked).warnings[0].includes('never ranked'), 'a ranked route is refused');
  });

  test('one bad route story is left out and the others stay', () => {
    const raw = buildSamplePlanStory(MODULES);
    raw.stories['route-2'] = { ...raw.stories['route-3'], routeId: 'route-2', summary: 'It costs €2,900 a year.' };
    raw.registries['route-2'] = raw.registries['route-3'];
    const { result, warnings } = normalize(raw);
    assert(warnings.some((message) => message.includes('route-2') && message.includes('types a figure')), 'typed figure named');
    assertEqual(Object.keys(result.stories), ['route-3'], 'route 3 stays');
  });

  test('a story with no facts is left out, and so is a story for a route that does not exist', () => {
    const raw = buildSamplePlanStory(MODULES);
    delete raw.registries['route-3'];
    const { result, warnings } = normalize(raw);
    assertEqual(result.stories, {}, 'no story without its facts');
    assert(warnings[0].includes('needs its facts'), 'says why');
    const stray = buildSamplePlanStory(MODULES);
    stray.stories['route-9'] = stray.stories['route-3'];
    assertEqual(Object.keys(normalize(stray).result.stories), ['route-3'], 'unknown route ignored');
  });

  test('the selected route falls back to the first when it does not exist', () => {
    assertEqual(normalize({ ...buildSamplePlanStory(), selectedRouteId: 'route-9' }).result.selectedRouteId, 'route-1', 'fallback');
  });

  test('chapter titles come from the session\'s own modules, and a missing module names nothing', () => {
    const planStory = normalize(buildSamplePlanStory({ ...MODULES, protection_gap: 'gone' })).result;
    planStory.catalogue.chapters = {};
    const session = { modules: Object.entries(MODULES).filter(([chapter]) => chapter !== 'protection_gap').map(([chapter, id]) => ({ id, title: `Title of ${chapter}` })) };
    const screen = buildPlanStoryScreen(planStory, session);
    assertEqual(screen.catalogue.chapters.household_cash_flow, { title: 'Title of household_cash_flow', glyph: 'flow' }, 'title and default mark');
    assert(!screen.catalogue.chapters.protection_gap, 'a chapter with no module is not named');
  });

  test('a route with no story yet draws as updating, not as an error', () => {
    const planStory = normalize(buildSamplePlanStory(MODULES)).result;
    const screen = buildPlanStoryScreen(planStory, { modules: [] }, 'route-2');
    assertEqual([screen.storyMissing, screen.resolved, screen.route.id], [true, null, 'route-2'], 'missing story');
    assertEqual(buildPlanStoryScreen(planStory, { modules: [] }, 'route-3').resolved.count, 8, 'route 3 resolves');
  });

  return results;
}
