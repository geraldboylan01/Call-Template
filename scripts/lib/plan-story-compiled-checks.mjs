// The story screen reading a compiled plan (check:plan-story): real compiles of made-up households, the
// story built from `readPlanPosition`'s facts, links that follow the routes' `chapterCases`, the words for
// every kind of basis, explainers and the refusals. No browser.

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlanPosition } from '../../js/planning/plan_pack/story_facts.js';
import { getExplainers } from '../../js/planning/figures/get_explainers.js';
import { getFigures } from '../../js/planning/figures/get_figures.js';
import { SECTIONS } from '../../js/case_application/schema.js';
import { PlanStoryError } from '../../js/plan_story_model.js';
import { describeBasis } from '../../js/plan_story_basis.js';
import { buildPlanStory, buildSessionFromPlan } from '../../js/plan_story_compiled.js';
import { buildPlanStoryScreen, planStoryChapterOf, planStoryModuleFor } from '../../js/plan_story_session.js';
import { buildPresentationCatalogue } from '../../js/presenter_catalogue.js';
import { callLocalTool, createLocalCase, ANALYSES_ROOT } from '../analyst-local-store.mjs';
import { compileMadeUpBorrower, compileMadeUpCouple, madeUpBorrowerStory, madeUpCoupleStory } from './plan-story-compiled.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = JSON.parse(await readFile(new URL('../fixtures/form-to-profile.households.json', import.meta.url), 'utf8'));

const quiet = (work) => {
  const { info, warn, log } = console;
  console.info = console.warn = console.log = () => {};
  try { return work(); } finally { Object.assign(console, { info, warn, log }); }
};
const segmentsOf = (resolved) => [resolved.headline, resolved.summary, ...resolved.sections.flatMap((section) => [section.titleSegments,
  ...section.paragraphs.map((paragraph) => paragraph.segments), ...section.goals.flatMap((goal) => [goal.titleSegments, ...goal.paragraphs.map((paragraph) => paragraph.segments)])])].flat();
const refusal = (fn, code, message) => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof PlanStoryError, `${message}: ${error.stack}`);
    assert.equal(error.code, code, `${message}: ${error.message}`);
    return error;
  }
  throw new Error(`${message}: expected a refusal`);
};

export async function runPlanStoryCompiledTests() {
  const results = [];
  const test = async (name, fn) => { await fn(); results.push(name); };

  const couple = await compileMadeUpCouple();
  const stories = { current: madeUpCoupleStory('current'), clear_car: madeUpCoupleStory('clear_car') };
  const planStory = quiet(() => buildPlanStory(couple, stories));
  const position = quiet(() => readPlanPosition(couple));
  const session = quiet(() => buildSessionFromPlan(couple, stories));
  const screen = (routeId) => buildPlanStoryScreen(session.planStory, session, routeId);

  await test('every registered figure is the plan’s own fact: its text, its basis and the module and case it came from', () => {
    for (const routeId of Object.keys(stories)) {
      const facts = position.routes.find((route) => route.routeId === routeId).facts;
      const compiledRoute = couple.routes.find((route) => route.id === routeId);
      for (const [key, entry] of Object.entries(planStory.registries[routeId])) {
        if (key.startsWith('figure.')) continue;
        const fact = facts[key];
        assert.equal(fact.status, 'available', `${routeId} ${key} is an available fact`);
        assert.equal(entry.text, fact.display, `${key} reads as the fact reads`);
        assert.deepEqual(entry.basis, fact.basis, `${key} carries the fact’s own basis`);
        if (fact.source.chapter) {
          assert.equal(entry.source.chapter, fact.source.chapter, `${key} names its module`);
          assert.equal(entry.source.caseId, fact.source.caseId, `${key} names its compiled case`);
          assert.equal(entry.source.nativeCaseId, fact.source.nativeCaseId, `${key} names its native case`);
          // A figure about this route comes from this route's case; one about the current position, from the current case.
          const owner = key.startsWith('current.') ? couple.routes.find((route) => route.id === 'current') : compiledRoute;
          assert.equal(fact.source.caseId, owner.chapterCases[fact.source.chapter], `${key}: the case is the route’s chapterCases entry`);
        } else assert.ok(entry.source.panel && !entry.source.chapter, `${key} is a plan figure, so it opens the plan view`);
      }
    }
  });

  await test('a link opens the module for the case its figure came from, found by the compiled case id', () => {
    let links = 0;
    for (const routeId of Object.keys(stories)) {
      const compiledRoute = couple.routes.find((route) => route.id === routeId);
      for (const segment of segmentsOf(screen(routeId).resolved).filter((entry) => entry.type === 'link')) {
        links += 1;
        const { chapter, caseId, nativeCaseId } = segment.target;
        const owner = segment.key.startsWith('current.') ? couple.routes.find((route) => route.id === 'current') : compiledRoute;
        assert.equal(caseId, owner.chapterCases[chapter], `${segment.key} opens the route’s case of ${chapter}`);
        const moduleId = planStoryModuleFor(session.planStory, segment.target);
        assert.equal(moduleId, caseId, 'the module is the compiled case');
        assert.ok(session.modules.some((module) => module.id === moduleId), 'and the session holds it');
        assert.equal(planStoryChapterOf(session.planStory, moduleId), chapter, 'the app can find the case controls for that module');
        const entry = couple.chapters.find((row) => row.id === chapter).cases.find((row) => row.id === caseId);
        assert.ok(entry && nativeCaseId, 'the native case the link selects inside the module');
      }
    }
    assert.ok(links >= 4, `the story links figures into modules (${links})`);
  });

  await test('the session holds exactly the compiled cases the routes use, one module each, in route order', () => {
    const used = [];
    for (const route of couple.routes) for (const chapter of couple.chapters) {
      const id = route.chapterCases[chapter.id];
      if (id && !used.includes(id)) used.push(id);
    }
    assert.deepEqual(session.modules.map((module) => module.id), used);
    assert.deepEqual(Object.keys(session.planStory.caseModules), used);
    assert.deepEqual(session.planStory.routes.map((route) => route.id), couple.routes.map((route) => route.id), 'routes keep the plan’s neutral order');
    assert.ok(session.planStory.routes.every((route) => !('rank' in route) && !('score' in route)), 'nothing ranks them');
  });

  await test('a focus target is the exact place in the session’s own module, and a link that has none still opens its module on its case', () => {
    const catalogue = buildPresentationCatalogue(session);
    let withTarget = 0;
    for (const registry of Object.values(session.planStory.registries)) for (const [key, entry] of Object.entries(registry)) {
      if (!entry.source.focusTargetId) continue;
      withTarget += 1;
      const target = catalogue.targets.find((row) => row.id === entry.source.focusTargetId);
      assert.ok(target, `${key}: the target exists in the session’s modules`);
      assert.equal(target.moduleKey, catalogue.modules.find((module) => module.moduleId === entry.source.caseId).key, `${key}: and belongs to the module for its case`);
    }
    assert.ok(withTarget >= 2, 'net worth and the protection figures point at exact places');
  });

  await test('every figure on the screen carries a basis written by code from its fact, and the story’s words cannot change it', () => {
    for (const routeId of Object.keys(stories)) {
      const figures = segmentsOf(screen(routeId).resolved).filter((segment) => ['figure', 'link', 'reason'].includes(segment.type));
      assert.ok(figures.length > 20, 'a real story has many figures');
      for (const figure of figures) assert.ok(figure.basis?.kind, `{${figure.key}} has a basis`);
    }
    // The same figures under different words keep the same bases.
    const reworded = madeUpCoupleStory('current');
    reworded.sections[0].parts.why = 'Your reserve is {position.reserve}, covering {position.reserveMonths} months{?explainer.emergency_reserve}.';
    const other = quiet(() => buildPlanStory(couple, { current: reworded }));
    assert.deepEqual(other.registries.current['position.reserve'].basis, planStory.registries.current['position.reserve'].basis);
  });

  await test('basis text for each kind comes from the fact: assumption, calculated, stated and official', () => {
    const registry = planStory.registries.clear_car;
    const words = (key, moduleTitle = null) => describeBasis(registry[key].basis, { moduleTitle });
    const months = words('position.reserveMonths');
    assert.equal(months.kind, 'assumption');
    assert.match(months.lines.join(' '), /Planeir uses three months of spending as the minimum cash-reserve floor and six months as the target/);
    const worth = words('position.netWorth', 'Personal Balance Sheet');
    assert.equal(worth.kind, 'calculated');
    assert.deepEqual(worth.lines, ['Worked out by the app, in the Personal Balance Sheet module.']);
    const loan = words('issues.idle_cash_vs_debt.home_loan.loanRate');
    assert.equal(loan.kind, 'stated');
    assert.match(loan.lines.join(' '), /no recorded form question/, 'a plan-pack input has no form question and says so');
    const dirt = words('figure.ie.dirt.2026.rate');
    const figure = getFigures({ ids: ['ie.dirt.2026.rate'], onDate: couple.calculationDate })[0];
    assert.equal(dirt.kind, 'official');
    assert.equal(registry['figure.ie.dirt.2026.rate'].text, figure.valueShown);
    assert.deepEqual(dirt.sources, [{ title: figure.source.title, url: figure.source.url }]);
    assert.ok(dirt.lines.some((line) => line.startsWith('Checked on ')), 'the day it was checked');
    const cash = words('issues.idle_cash_vs_debt.home_loan.cashRateAfterTax');
    assert.deepEqual(cash.evidence.map((entry) => entry.kind), ['assumption', 'official'], 'a mixed calculation keeps its parts, each with its own basis');
  });

  await test('a figure stated on the form shows the form’s own question', async () => {
    const borrower = await compileMadeUpBorrower();
    const built = quiet(() => buildPlanStory(borrower, { current: madeUpBorrowerStory() }));
    const balance = built.registries.current['issues.debts_other_than_mortgage.liability_application_loan_0.balance'];
    assert.equal(balance.basis.kind, 'stated');
    const described = describeBasis(balance.basis);
    const field = SECTIONS.find((section) => section.repeater?.path === 'loans').repeater.fields.find((entry) => entry.key === 'balance');
    assert.deepEqual(described.questions, [{ label: field.label, path: 'loans.0.balance' }], 'the question as the form words it');
    assert.ok(described.lines.includes('Confirmed on 20 October 2026.'));
    const rate = describeBasis(built.registries.current['issues.debts_other_than_mortgage.liability_application_loan_0.rate'].basis);
    assert.equal(rate.kind, 'calculated');
    assert.deepEqual(rate.evidence.map((entry) => entry.kind), ['stated'], 'a derived figure shows the answer it was derived from');
    assert.equal(rate.evidence[0].questions[0].path, 'loans.0.rate');
  });

  await test('an explainer is the catalogue’s own words, with its sources and date', () => {
    const held = getExplainers({ ids: ['dirt', 'emergency_reserve', 'illness_benefit', 'pension_tax_relief'] });
    assert.deepEqual(Object.keys(session.planStory.explainers).sort(), held.map((explainer) => explainer.id).sort());
    for (const explainer of held) {
      const shown = session.planStory.explainers[explainer.id];
      assert.equal(shown.title, explainer.title);
      assert.deepEqual(shown.sentences, [...explainer.sentences]);
      assert.deepEqual(shown.sources, explainer.sources.map((source) => ({ ...source })));
      assert.equal(shown.checkedOn, explainer.checkedOn);
    }
    const markers = segmentsOf(screen('clear_car').resolved).filter((segment) => segment.type === 'explainer');
    assert.ok(markers.length >= 3, `the story attaches explainers (${markers.length})`);
    for (const marker of markers) assert.deepEqual(marker.explainer.sentences, [...getExplainers({ ids: [marker.id] })[0].sentences], 'whole and unchanged');
  });

  await test('a placeholder the plan did not produce is refused with its path: unknown key, unknown figure, unknown explainer, unavailable fact, another route', () => {
    const attempt = (change) => {
      const story = madeUpCoupleStory('clear_car');
      change(story);
      return () => quiet(() => buildPlanStory(couple, { clear_car: story }));
    };
    const unknownKey = refusal(attempt((story) => { story.summary = 'Net worth is {position.invented}.'; }), 'unknown_placeholder', 'an invented key');
    assert.match(unknownKey.message, /^clear_car: \/story\/summary\{position\.invented\}/, 'with route and path');
    refusal(attempt((story) => { story.sections[3].parts.costs = 'DIRT is {figure.ie.dirt.1999.rate}.'; }), 'unknown_placeholder', 'a figure the register does not hold');
    const unknownExplainer = refusal(attempt((story) => { story.sections[0].parts.why = 'A rule{?explainer.state_pension_not_inherited}.'; }), 'unknown_explainer', 'an explainer id the catalogue does not hold');
    assert.match(unknownExplainer.message, /\/story\/sections\/0\/paragraphs\/1\{\?explainer\.state_pension_not_inherited\}/);
    refusal(attempt((story) => { story.sections[0].parts.gives = 'Retirement runs out in {goals.goal_retirement.lumpSumNeeded}.'; }), 'unknown_placeholder', 'a fact the plan could not produce');
    // A link on a figure no module shows opens the plan view's own panel, never a module it did not come from.
    const planLink = quiet(() => buildPlanStory(couple, { clear_car: (() => { const story = madeUpCoupleStory('clear_car'); story.summary = 'You have {@position.leftOver} a year.'; return story; })() }));
    const target = segmentsOf(buildPlanStoryScreen(planLink, session, 'clear_car').resolved).find((segment) => segment.key === 'position.leftOver' && segment.type === 'link').target;
    assert.deepEqual([target.chapter, target.panel], [null, 'plan_facts']);
  });

  await test('a story for another route, or for a route the plan does not hold, is refused', () => {
    refusal(() => quiet(() => buildPlanStory(couple, { clear_car: madeUpCoupleStory('current') })), 'invalid_story', 'a story under the wrong route');
    refusal(() => quiet(() => buildPlanStory(couple, { not_a_route: madeUpCoupleStory('not_a_route') })), 'unknown_route', 'an unknown route');
    // A story cannot reach another alternative’s facts: its keys name only its own route and `current.`.
    const sneaky = madeUpCoupleStory('clear_car');
    sneaky.summary = 'College cash leaves {college_cash.vsCurrent.cashUsed}.';
    refusal(() => quiet(() => buildPlanStory(couple, { clear_car: sneaky })), 'unknown_placeholder', 'another route’s fact');
  });

  await test('at a glance: each route’s column is the plan’s own figures, with the basis they carry', () => {
    const [today, , clear] = session.planStory.routes;
    assert.equal(today.savingsUsed.text, 'None');
    assert.equal(clear.savingsUsed.text, '€15,000');
    const ledger = couple.resourceLedger.routes.find((row) => row.routeId === 'clear_car');
    assert.equal(clear.savingsUsed.text, new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(ledger.cashAllocated));
    const euros = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
    assert.equal(clear.leftOver.text, euros.format(position.routes.find((route) => route.routeId === 'clear_car').facts['leftOverAfterGoals.yearly'].value), 'whole euros, from the same fact');
    assert.equal(clear.goalsCovered.text, 'All');
    for (const route of session.planStory.routes) for (const cell of [route.savingsUsed, route.leftOver, route.goalsCovered]) assert.ok(cell.basis?.kind, `${route.id} ${cell.text} has a basis`);
  });

  await test('the session is what the app normalises: the story and every figure survive a round trip, and routes without a story say so', () => {
    const again = JSON.parse(JSON.stringify(session));
    assert.deepEqual(Object.keys(again.planStory.stories), ['current', 'clear_car']);
    assert.equal(again.planStory.routes.length, 4);
    assert.equal(screen('fund_annually').storyMissing, true, 'a route with no story is updating, not an error');
    assert.equal(screen('clear_car').storyMissing, false);
    assert.equal(screen('clear_car').resolved.sections.find((section) => section.id === 'goals').goals.length, 4, 'a subsection for each goal');
  });

  await test('a story accepted at submission opens on the screen: read_position, price_route and submit_story use the keys the screen reads', async () => {
    const fixture = fixtures.find((row) => row.id === 'fictional-borrower-with-card');
    const requestId = `plan-story-check-${process.pid}`;
    const created = await createLocalCase({ requestId, runId: 'run1', revision: 7, confirmedRevision: 7, confirmedAt: '2026-10-20T12:00:00.000Z',
      information: fixture.information, clientLabel: fixture.id });
    try {
      const run = (...args) => spawnSync(process.execPath, ['scripts/analyst-open.mjs', created.directory, ...args], { cwd: root, encoding: 'utf8' });
      const submit = (story) => callLocalTool(created.directory, 'submit_story', { story });

      // The analyst is told the keys the screen can open.
      const position = await callLocalTool(created.directory, 'read_position', {});
      assert.equal(position.ok, true);
      assert.ok(position.data.storyFacts['position.netWorth'] && position.data.storyFacts['issues.debts_other_than_mortgage.liability_application_loan_0.balance'], 'the story facts are listed');
      assert.equal(position.data.storyFacts['position.netWorth'].opens, 'module');
      assert.equal(position.data.storyFacts['position.spareCash'].opens, 'plan');

      const empty = run();
      assert.equal(empty.status, 1);
      assert.match(empty.stderr, /No story has been submitted/);

      // A metrics-only key is refused before it can become an active story.
      const legacy = { ...madeUpBorrowerStory(), summary: 'Your cash is {ledger.cashRemaining}.' };
      const legacyResult = await submit(legacy);
      assert.equal(legacyResult.ok, false);
      assert.match(legacyResult.refusals[0].path, /ledger\.cashRemaining/);
      const stuck = run();
      assert.equal(stuck.status, 1);
      assert.match(stuck.stderr, /No story has been submitted/);

      // An invented key, and an explainer the catalogue does not hold, are refused at submission, with their paths.
      const invented = await submit({ ...madeUpBorrowerStory(), summary: 'Your net worth is {position.invented}.' });
      assert.equal(invented.ok, false);
      assert.match(invented.refusals[0].path, /\/story\/summary/);
      const badExplainer = madeUpBorrowerStory();
      badExplainer.sections[0].parts.why = 'A rule{?explainer.state_pension_not_inherited}.';
      assert.equal((await submit(badExplainer)).refusals[0].code, 'unknown_explainer');

      // A story using the screen's keys, with an explainer, is accepted and opens.
      const accepted = await submit(madeUpBorrowerStory());
      assert.equal(accepted.ok, true, JSON.stringify(accepted));
      assert.equal(accepted.data.openOnStoryScreen, true);
      const opened = run();
      assert.equal(opened.status, 0, opened.stderr);
      assert.match(opened.stdout, /Wrote private\/analyses\/.*\/run1\/session\.json/);
      assert.match(opened.stdout, /plan-story-open\.html\?session=\/private\/analyses\//);
      const written = JSON.parse(await readFile(join(created.directory, 'session.json'), 'utf8'));
      assert.deepEqual(Object.keys(written.planStory.stories), ['current']);
      assert.ok(written.modules.length > 0 && written.modules.length === Object.keys(written.planStory.caseModules).length, 'a module for every compiled case');
      assert.equal(written.planStory.registries.current['issues.debts_other_than_mortgage.liability_application_loan_0.balance'].basis.kind, 'stated');
      assert.ok(written.planStory.explainers.dirt, 'the explainer travels with the story');
    } finally {
      await rm(join(ANALYSES_ROOT, requestId), { recursive: true, force: true });
    }
  });

  return results;
}
