import {
  PlanStoryError,
  parseNarration,
  resolveNarration,
  resolveStory
} from './plan_story_model.js';
import { PLAN_STORY_BASIS_KINDS, describeBasis, formatBasisDate } from './plan_story_basis.js';
import { normalizePlanStory } from './plan_story_session.js';
import { PLAN_STORY_SAMPLE_REGISTRY, PLAN_STORY_SAMPLE_STORY, buildSamplePlanStory } from './tests_plan_story_sample.js';

/**
 * WHERE A FIGURE COMES FROM, AND EXPLAINERS: THE WORDS AND THE RULES, WITHOUT A BROWSER.
 *
 * The screen's hover and tap text is written by code from the fact's basis (one test per kind), an explainer
 * is the catalogue's own words, and a placeholder that names something the plan did not produce is refused
 * with its path.
 */

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message || 'Not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function refusal(fn, code, message) {
  try {
    fn();
  } catch (error) {
    assert(error instanceof PlanStoryError, `${message}: expected a PlanStoryError, got ${error.name}: ${error.message}`);
    assertEqual(error.code, code, `${message}: wrong code (${error.message})`);
    return error;
  }
  throw new Error(`${message}: expected a refusal`);
}

const EXPLAINER = Object.freeze({
  title: 'Pension tax relief and the age limits',
  sentences: ['Contributions you pay into a pension can get income tax relief at your highest rate of tax.', 'The relief is limited each year to a share of your earnings.'],
  sources: [{ title: 'Revenue, tax relief on pension contributions', url: 'https://www.revenue.ie/en/jobs-and-pensions/pension/relief/index.aspx' }],
  checkedOn: '2026-10-28',
  catalogueVersion: 'ie-explainers-2026.1'
});

const fact = (text, basis, extra = {}) => ({ text, source: { panel: 'plan_facts' }, ...(basis ? { basis } : {}), ...extra });

export function runPlanStoryBasisTests() {
  const results = [];
  const test = (name, fn) => { fn(); results.push(name); };

  test('a figure you stated says you told us, with the form question and the day it was confirmed', () => {
    const described = describeBasis({
      kind: 'stated', inputPath: '/household/liabilities/0/currentBalance', origin: 'application',
      formQuestions: [{ path: 'loans.0.balance', label: 'How much is left to pay?', type: 'money', sectionId: 'loans' }],
      form: { schema: 'planeir.application.v1', version: 1, revision: 7, confirmedAt: '2026-10-20T12:00:00.000Z' }
    });
    assertEqual(described.kind, 'stated', 'kind');
    assertEqual(described.label, 'You told us', 'label');
    assertEqual(described.questions, [{ label: 'How much is left to pay?', path: 'loans.0.balance' }], 'the form question, in the form’s own words');
    assert(described.lines.some((line) => /on the form/.test(line)), 'says it came from the form');
    assert(described.lines.includes('Confirmed on 20 October 2026.'), 'the day it was confirmed');
  });

  test('a stated figure with no recorded question says so, and never invents wording', () => {
    const described = describeBasis({
      kind: 'stated', inputPath: '/routes/2/sourceHousehold/liabilities/0/annualInterestRate', formQuestions: [],
      reason: { code: 'no_form_provenance', message: 'This household input has no recorded form question.' }
    });
    assertEqual(described.lines, ['This household input has no recorded form question.'], 'the code’s own reason');
    assert(!described.questions, 'no question is made up');
    const unknown = describeBasis({ kind: 'stated', inputPath: '/x', formQuestions: [{ path: 'loans.0.rate', label: null, reason: 'The recorded form schema version is unavailable.' }] });
    assert(/wording was not recorded|unavailable/.test(JSON.stringify(unknown)), 'a question whose wording is unavailable says so');
  });

  test('a figure the app worked out names the module, or the engine when no module shows it', () => {
    const inModule = describeBasis({ kind: 'calculated', engine: 'personal_balance_sheet', calculation: 'compiled_result', inputs: ['/chapters/6/cases/3/metrics/netWorth'] }, { moduleTitle: 'Personal Balance Sheet' });
    assertEqual(inModule.label, 'Worked out by the app', 'label');
    assertEqual(inModule.lines, ['Worked out by the app, in the Personal Balance Sheet module.'], 'names the module');
    const ledger = describeBasis({ kind: 'calculated', engine: 'resource_ledger', calculation: 'compiled_result', inputs: [] });
    assertEqual(ledger.lines, ['Worked out by the app, in the plan’s resource ledger.'], 'names the engine');
    const fromForm = describeBasis({ kind: 'calculated', engine: 'application_to_profile', calculation: 'form_to_profile_derivation', inputs: [], description: 'Converted from a percentage' });
    assertEqual(fromForm.lines, ['Worked out by the app from the answers you gave on the form.', 'Converted from a percentage.'], 'a form derivation');
  });

  test('a Planeir assumption says so, with its plain basis and its disclosure', () => {
    const described = describeBasis({
      kind: 'assumption', assumptionId: 'liquidity.working.targetBufferMonths', version: 'planeir-assumptions-1.8.0',
      description: 'For a working household, Planeir uses six months of spending as the target.', disclosure: 'These are planning guides, not a recommendation.'
    });
    assertEqual(described.label, 'A Planeir assumption', 'label');
    assertEqual(described.lines, ['A Planeir assumption, not something you told us.', 'For a working household, Planeir uses six months of spending as the target.', 'These are planning guides, not a recommendation.'], 'lines');
  });

  test('an official figure names its source and the day it was checked', () => {
    const described = describeBasis({
      kind: 'official', registerId: 'ie.dirt.2026.rate', value: 0.33, checkedOn: '2026-10-13', catalogueVersion: 'ie-tax-2026.7',
      source: { title: 'Revenue, Deposit Interest Retention Tax (DIRT)', url: 'https://www.revenue.ie/en/additional-incomes/dirt/who-is-charged-dirt.aspx' }
    });
    assertEqual(described.label, 'An official figure', 'label');
    assert(described.lines.includes('Checked on 13 October 2026.'), 'the day it was checked');
    assertEqual(described.sources, [{ title: 'Revenue, Deposit Interest Retention Tax (DIRT)', url: 'https://www.revenue.ie/en/additional-incomes/dirt/who-is-charged-dirt.aspx' }], 'the source');
  });

  test('a mixed calculation shows what it is made of, and a basis the screen does not know is refused by name', () => {
    const mixed = describeBasis({
      kind: 'calculated', engine: 'irish_tax_engine', calculation: 'central_cash_rate_after_dirt', inputs: [],
      evidence: [
        { kind: 'assumption', assumptionId: 'cash.instantAccessGrossRate', version: 'v', description: 'A 0.2% interest rate is used for instant-access cash.' },
        { kind: 'official', registerId: 'ie.dirt.2026.rate', checkedOn: '2026-10-13', source: { title: 'Revenue, DIRT', url: 'https://www.revenue.ie/' } }
      ]
    });
    assertEqual(mixed.evidence.map((entry) => entry.kind), ['assumption', 'official'], 'the parts it is made of');
    assert(/Irish tax calculations/.test(mixed.lines[0]), 'names the tax engine');
    let refused = false;
    try { describeBasis({ kind: 'guess' }); } catch (error) { refused = /stated, calculated, assumption, official/.test(error.message); }
    assert(refused, 'an unknown kind is refused, naming the four');
    assertEqual([...PLAN_STORY_BASIS_KINDS], ['stated', 'calculated', 'assumption', 'official'], 'the four kinds');
  });

  test('dates are read as the day they are, whatever the time zone', () => {
    assertEqual(formatBasisDate('2026-10-27'), '27 October 2026', 'a date');
    assertEqual(formatBasisDate('2026-01-01T00:00:00.000Z'), '1 January 2026', 'a date and time');
    assertEqual(formatBasisDate('not a date'), null, 'not a date');
  });

  test('the basis on a fact travels to every figure that shows it, and a basis that is not one is refused', () => {
    const basis = { kind: 'calculated', engine: 'resource_ledger', calculation: 'compiled_result', inputs: [] };
    const segments = resolveNarration('Your net worth is {a.worth} and {@a.link}.', {
      'a.worth': fact('€1', basis),
      'a.link': { text: '€2', source: { chapter: 'household_cash_flow', caseId: 'case-1', nativeCaseId: 'today' }, basis }
    }, { path: '/p' });
    assertEqual(segments.filter((segment) => segment.basis).map((segment) => segment.type), ['figure', 'link'], 'figure and link both carry it');
    refusal(() => resolveNarration('{a.worth}', { 'a.worth': fact('€1', { kind: 'guess' }) }), 'bad_basis', 'a basis that is not one');
  });

  test('{?explainer.id} is an info marker that carries the catalogue’s own words', () => {
    assertEqual(parseNarration('Tax relief{?explainer.pension_tax_relief} applies.').filter((token) => token.explainer).map((token) => token.key), ['explainer.pension_tax_relief'], 'parsed');
    const segments = resolveNarration('Tax relief{?explainer.pension_tax_relief} applies.', {}, { path: '/p', explainers: { pension_tax_relief: EXPLAINER } });
    const marker = segments.find((segment) => segment.type === 'explainer');
    assertEqual(marker.id, 'pension_tax_relief', 'the id');
    assertEqual(marker.explainer.title, EXPLAINER.title, 'the title');
    assertEqual(marker.explainer.sentences, EXPLAINER.sentences, 'the sentences, whole');
    assertEqual(marker.explainer.sources, EXPLAINER.sources, 'its sources');
    assertEqual(marker.explainer.checkedOn, '2026-10-28', 'the day its sources were read');
    assertEqual(segments.map((segment) => segment.text ?? '').join(''), 'Tax relief applies.', 'a marker adds no words of its own');
  });

  test('an explainer the plan does not hold, and a marker that is not an explainer, are refused with where they are', () => {
    const unknown = refusal(() => resolveNarration('A rule{?explainer.nope}.', {}, { path: '/story/sections/2/paragraphs/1', explainers: { pension_tax_relief: EXPLAINER } }), 'unknown_explainer', 'unknown id');
    assert(unknown.path === '/story/sections/2/paragraphs/1{?explainer.nope}' || unknown.message.startsWith('/story/sections/2/paragraphs/1{?explainer.nope}'), `the path names the placeholder: ${unknown.message}`);
    refusal(() => resolveNarration('A rule{?pension_tax_relief}.', {}, { explainers: { pension_tax_relief: EXPLAINER } }), 'bad_placeholder', 'a ? marker that is not {?explainer.<id>}');
    refusal(() => resolveNarration('A rule{??explainer.x}.', {}, { explainers: {} }), 'bad_placeholder', 'a second marker');
    refusal(() => resolveNarration('A rule{?explainer.Bad-Id}.', {}, { explainers: {} }), 'bad_placeholder', 'a malformed id');
  });

  test('a story may not word an explainer itself, and an explainer types no figure into the story', () => {
    // The explainer is only ever the catalogue's: story text next to a marker cannot change what it shows.
    const segments = resolveNarration('A rule{?explainer.pension_tax_relief}.', {}, { explainers: { pension_tax_relief: EXPLAINER } });
    assertEqual(segments.find((segment) => segment.type === 'explainer').explainer.sentences, EXPLAINER.sentences, 'unchanged');
    refusal(() => resolveNarration('Relief is 20% back{?explainer.pension_tax_relief}.', {}, { explainers: { pension_tax_relief: EXPLAINER } }), 'typed_figure', 'a figure typed beside a marker');
  });

  test('goal subsections are told in the goals section only, once each', () => {
    const story = JSON.parse(JSON.stringify(PLAN_STORY_SAMPLE_STORY));
    const goals = story.sections.find((section) => section.id === 'goals');
    goals.goals = [{ goalId: 'college', title: 'Ella’s college', paragraphs: ['Ella’s college is covered by saving {@route.goals.college.yearly}.'] }];
    const resolved = resolveStory({ story, registry: PLAN_STORY_SAMPLE_REGISTRY });
    const section = resolved.sections.find((entry) => entry.id === 'goals');
    assertEqual(section.goals.map((goal) => goal.goalId), ['college'], 'one subsection');
    assert(section.seeIn.some((entry) => entry.chapter === 'future_cost_fund'), 'a link in a subsection counts for "See it in"');
    const misplaced = JSON.parse(JSON.stringify(PLAN_STORY_SAMPLE_STORY));
    misplaced.sections[0].goals = [];
    refusal(() => resolveStory({ story: misplaced, registry: PLAN_STORY_SAMPLE_REGISTRY }), 'invalid_story', 'goals outside the goals section');
    goals.goals.push({ goalId: 'college', title: 'Again', paragraphs: ['Once more.'] });
    refusal(() => resolveStory({ story, registry: PLAN_STORY_SAMPLE_REGISTRY }), 'invalid_story', 'the same goal twice');
  });

  test('a session keeps its explainers and glance bases, and drops a story that names an explainer it does not hold', () => {
    const planStory = buildSamplePlanStory({});
    planStory.stories['route-3'].sections[0].paragraphs[0] += '';
    planStory.explainers = { pension_tax_relief: EXPLAINER };
    planStory.stories['route-3'].sections[0].paragraphs = ['You have about {@position.leftOver} left over{?explainer.pension_tax_relief}.', ...PLAN_STORY_SAMPLE_STORY.sections[0].paragraphs.slice(1)];
    planStory.routes[0].leftOver.basis = { kind: 'calculated', engine: 'resource_ledger', calculation: 'x', inputs: [] };
    const warnings = [];
    const kept = normalizePlanStory(planStory, { warn: (message) => warnings.push(message) });
    assertEqual(warnings, [], 'nothing dropped');
    assertEqual(Object.keys(kept.explainers), ['pension_tax_relief'], 'the explainer travels with the story');
    assertEqual(kept.routes[0].leftOver.basis.kind, 'calculated', 'the glance figure keeps its basis');
    delete planStory.explainers;
    const dropped = [];
    const without = normalizePlanStory(planStory, { warn: (message) => dropped.push(message) });
    assert(!without.stories['route-3'] && /unknown|explainer/.test(dropped.join(' ')), 'the story is left out, and says why');
  });

  return results;
}
