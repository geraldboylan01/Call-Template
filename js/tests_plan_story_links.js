import { evaluateOffRoute, backToRoute, openStoryLink, PLAN_STORY_CASE_BRIDGES } from './plan_story_links.js';
import { resolveStory } from './plan_story_model.js';
import {
  PLAN_STORY_SAMPLE_CATALOGUE,
  PLAN_STORY_SAMPLE_REGISTRY,
  PLAN_STORY_SAMPLE_STORY
} from './tests_plan_story_sample.js';

/**
 * OPENING A LINK, AGAINST A PRETEND APP.
 *
 * The app is a list of calls, so what is proved here is the order and the
 * outcome: the case is set before the module opens, the figure is outlined last,
 * a missing module or case is said plainly, and a changed case is noticed.
 */

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message || 'Not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function pretendApp({ modules = {}, cases = {}, canOutline = true } = {}) {
  const calls = [];
  const state = { ...cases };
  return {
    calls,
    deps: {
      findModule: (chapter) => { calls.push(`find:${chapter}`); return modules[chapter] ?? null; },
      setCase: (moduleId, caseId) => { calls.push(`case:${moduleId}:${caseId}`); if (caseId === 'missing') return false; state[moduleId] = caseId; return true; },
      currentCase: (moduleId) => state[moduleId] ?? null,
      openModule: (moduleId) => { calls.push(`open:${moduleId}`); },
      outline: (moduleId, focusTargetId, figureText) => { calls.push(`outline:${moduleId}:${focusTargetId}:${figureText}`); return canOutline; },
      openPanel: (panelId) => { calls.push(`panel:${panelId}`); }
    }
  };
}

const linkFor = (key) => {
  const resolved = resolveStory({ story: PLAN_STORY_SAMPLE_STORY, registry: PLAN_STORY_SAMPLE_REGISTRY, catalogue: PLAN_STORY_SAMPLE_CATALOGUE });
  return resolved.sections.flatMap((s) => s.paragraphs.flatMap((p) => p.segments)).find((segment) => segment.key === key).target;
};

export async function runPlanStoryLinksTests() {
  const results = [];
  const test = async (name, fn) => { await fn(); results.push(name); };

  await test('a link sets the case, opens the module, and outlines the figure last', async () => {
    const app = pretendApp({ modules: { protection_gap: 'm-pg' } });
    const result = await openStoryLink(linkFor('protection.niamh.gap'), app.deps, { routeId: 'route-3' });
    assertEqual(app.calls, ['find:protection_gap', 'case:m-pg:niamh-cannot-work', 'open:m-pg', 'outline:m-pg:null:€38,000 a year short'], 'order of calls');
    assertEqual(result, { opened: true, moduleId: 'm-pg', caseId: 'niamh-cannot-work', outlined: true, routeId: 'route-3' }, 'result');
  });

  await test('the same module opens on a different case for a different figure', async () => {
    const app = pretendApp({ modules: { protection_gap: 'm-pg' } });
    const result = await openStoryLink(linkFor('protection.dara.gap'), app.deps);
    assertEqual(result.caseId, 'dara-cannot-work', 'Dara\'s figure opens Dara\'s case');
  });

  await test('a module with no case to set is opened on whatever it shows', async () => {
    const app = pretendApp({ modules: { liquidity_analysis: 'm-liq' }, cases: { 'm-liq': 'only' } });
    const result = await openStoryLink(linkFor('position.savings'), app.deps);
    assert(!app.calls.some((call) => call.startsWith('case:')), 'no case is set');
    assertEqual(result.caseId, 'only', 'reports the case it shows');
  });

  await test('a "See it in" link opens the module without outlining anything', async () => {
    const app = pretendApp({ modules: { loan_analysis: 'm-loan' } });
    const result = await openStoryLink({ chapter: 'loan_analysis', panel: null, caseId: 'clear', focusTargetId: null, figureKey: null, figureText: null }, app.deps);
    assertEqual(result.outlined, false, 'nothing outlined');
    assert(!app.calls.some((call) => call.startsWith('outline:')), 'outline never called');
  });

  await test('a missing module and a missing case are said plainly, and nothing opens', async () => {
    const none = pretendApp();
    assertEqual((await openStoryLink(linkFor('loan.car.rate'), none.deps)).reason, 'module_missing', 'no module');
    const app = pretendApp({ modules: { loan_analysis: 'm-loan' } });
    const result = await openStoryLink({ chapter: 'loan_analysis', caseId: 'missing', figureText: 'x' }, app.deps);
    assertEqual([result.opened, result.reason], [false, 'case_missing'], 'no case');
    assert(!app.calls.some((call) => call.startsWith('open:')), 'the module never opened on the wrong case');
  });

  await test('a figure that cannot be outlined still opens the module', async () => {
    const app = pretendApp({ modules: { future_cost_fund: 'm-fcf' }, canOutline: false });
    const result = await openStoryLink(linkFor('route.goals.college.yearly'), app.deps);
    assertEqual([result.opened, result.outlined], [true, false], 'opens, no outline');
  });

  await test('a plan panel link opens the panel and no module', async () => {
    const app = pretendApp();
    const result = await openStoryLink({ chapter: null, panel: 'ledger', caseId: null, focusTargetId: null }, app.deps);
    assertEqual(app.calls, ['panel:ledger'], 'panel only');
    assertEqual(result.moduleId, null, 'no module');
  });

  await test('changing the case away from the route is noticed, and Back to the route restores it', async () => {
    const target = linkFor('route.goals.mortgage.clears');
    assertEqual(evaluateOffRoute({ target, currentCaseId: 'extra' }), { offRoute: false }, 'on the route');
    assertEqual(
      evaluateOffRoute({ target, currentCaseId: 'today', caseTitles: PLAN_STORY_SAMPLE_CATALOGUE.cases.mortgage_analysis }),
      { offRoute: true, caseWas: 'Pay €371 more a month', caseNow: 'Today' },
      'off the route'
    );
    const app = pretendApp({ modules: { mortgage_analysis: 'm-m' } });
    assert(await backToRoute(target, 'm-m', app.deps), 'back to the route');
    assertEqual(app.calls, ['case:m-m:extra'], 'put back on the route\'s case');
  });

  await test('every module a link opens on a case has a case bridge the app already exposes', async () => {
    const resolved = resolveStory({ story: PLAN_STORY_SAMPLE_STORY, registry: PLAN_STORY_SAMPLE_REGISTRY, catalogue: PLAN_STORY_SAMPLE_CATALOGUE });
    const links = resolved.sections.flatMap((s) => s.paragraphs.flatMap((p) => p.segments)).filter((x) => x.type === 'link');
    const withCases = new Set(links.filter((x) => x.target.caseId).map((x) => x.target.chapter));
    assert(withCases.size >= 5, 'the sample links several modules on a case');
    for (const chapter of withCases) assert(PLAN_STORY_CASE_BRIDGES[chapter], `${chapter} is opened on a case but has no case bridge`);
    for (const chapter of new Set(links.filter((x) => !x.target.caseId).map((x) => x.target.chapter))) {
      assert(!PLAN_STORY_SAMPLE_CATALOGUE.cases[chapter], `${chapter} has cases, so a link to it must name one`);
    }
  });

  return results;
}
