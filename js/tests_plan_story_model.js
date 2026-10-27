import {
  PlanStoryError,
  buildGlance,
  describeLink,
  findForbiddenWording,
  findTypedFigures,
  followsRoute,
  parseNarration,
  resolveNarration,
  resolveStory
} from './plan_story_model.js';
import {
  PLAN_STORY_SAMPLE_CATALOGUE,
  PLAN_STORY_SAMPLE_REGISTRY,
  PLAN_STORY_SAMPLE_ROUTES,
  PLAN_STORY_SAMPLE_STORY
} from './tests_plan_story_sample.js';

/**
 * THE STORY'S RULES, ASKED WITHOUT A BROWSER.
 *
 * What a story may say, that every link opens the module and case its figure
 * came from, and that "See it in" can only name what a section linked.
 */

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message || 'Not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn, code, message) {
  try {
    fn();
  } catch (error) {
    assert(error instanceof PlanStoryError, `${message}: expected a PlanStoryError, got ${error.name}`);
    assertEqual(error.code, code, message);
    return error;
  }
  throw new Error(`${message}: expected it to be refused`);
}

const resolveSample = () => resolveStory({
  story: PLAN_STORY_SAMPLE_STORY,
  registry: PLAN_STORY_SAMPLE_REGISTRY,
  catalogue: PLAN_STORY_SAMPLE_CATALOGUE
});

const plain = (segments) => segments.map((segment) => segment.text).join('');

/**
 * Every figure the story links, and the module and case it must open. A figure
 * is only ever a way into the place it is shown, so a figure no module prints
 * (what is left over once the whole route is in place, a mortgage after rates
 * rise, a college saving after costs rise) is not in this list: it is plain text.
 */
export const PLAN_STORY_LINK_MAP = Object.freeze([
  ['position.leftOver', 'household_cash_flow', 'today'],
  ['position.savings', 'liquidity_analysis', null],
  ['position.reserve', 'liquidity_analysis', null],
  ['protection.niamh.gap', 'protection_gap', 'niamh-cannot-work'],
  ['route.protection.niamh.months', 'protection_gap', 'niamh-cannot-work'],
  ['protection.dara.gap', 'protection_gap', 'dara-cannot-work'],
  ['loan.car.rate', 'loan_analysis', 'clear'],
  ['route.loan.car.balance', 'loan_analysis', 'clear'],
  ['route.loan.car.interestSaved', 'loan_analysis', 'clear'],
  ['route.cashFlow.freed', 'household_cash_flow', 'clear-car'],
  ['route.goals.college.yearly', 'future_cost_fund', 'yearly'],
  ['route.goals.mortgage.clears', 'mortgage_analysis', 'extra'],
  ['route.goals.mortgage.extraMonthly', 'mortgage_analysis', 'extra'],
  ['goals.retirement.state', 'pension_projection', null],
  ['route.netWorth.after', 'personal_balance_sheet', 'route3']
]);

export function runPlanStoryModelTests() {
  const results = [];
  const test = (name, fn) => { fn(); results.push(name); };

  test('the sample resolves into eight sections in the plan\'s order', () => {
    const resolved = resolveSample();
    assertEqual(resolved.count, 8, 'section count');
    assertEqual(resolved.sections.map((section) => section.number), [1, 2, 3, 4, 5, 6, 7, 8], 'numbers');
    assertEqual(
      resolved.sections.map((section) => section.id),
      ['current_position', 'protecting', 'inefficiencies', 'goals', 'cash_flow_after', 'net_worth_after', 'risks', 'check_next'],
      'order'
    );
  });

  test('the headline and summary read as the design wrote them', () => {
    const resolved = resolveSample();
    assertEqual(plain(resolved.headline), 'Clear the car loan first: €15,000 from savings frees €6,000 a year', 'headline');
    assertEqual(plain(resolved.summary), 'College and the mortgage are paid from income, about €8,900 a year is left over and all goals are covered.', 'summary');
  });

  test('each section reads in full with every placeholder filled', () => {
    const resolved = resolveSample();
    const text = (id) => plain(resolved.sections.find((section) => section.id === id).paragraphs[0].segments);
    assertEqual(text('current_position'), 'You have about €11,000 a year left over after everything you pay, and €90,000 in savings. €42,000 of that is your emergency fund, six months of spending, and every route leaves it untouched.', 'section 1');
    assertEqual(text('protecting'), 'If Niamh couldn’t work, you’d be €38,000 a year short. In this route your savings would cover that for 24 months. If Dara couldn’t work, €26,000 a year short.', 'section 2');
    assertEqual(text('inefficiencies'), 'Your car loan costs 6% while your savings earn far less. Clearing the €15,000 balance from savings saves about €1,300 in interest and frees €6,000 a year from 2026.', 'section 3');
    assertEqual(text('goals'), 'Ella’s college is covered by saving €3,600 a year from 2026. The mortgage clears in 2042 instead of 2046 with €371 more a month. Retirement at 67 is on track.', 'section 4');
    assertEqual(text('net_worth_after'), 'Unchanged at €625,000. €15,000 moves from savings to clear the loan.', 'section 6');
    assertEqual(text('risks'), 'If interest rates rose by 2 points, the mortgage would cost about €3,700 more a year, still within what’s left over. If college costs rose 2 points faster, saving would need about €4,000 a year.', 'section 7');
  });

  test('every linked figure opens the module and the case it came from', () => {
    const resolved = resolveSample();
    const links = resolved.sections.flatMap((section) => section.paragraphs.flatMap((p) => p.segments)).filter((s) => s.type === 'link');
    assertEqual(links.length, PLAN_STORY_LINK_MAP.length, 'number of links');
    PLAN_STORY_LINK_MAP.forEach(([key, chapter, caseId], index) => {
      assertEqual(links[index].key, key, `link ${index} key`);
      assertEqual(links[index].target.chapter, chapter, `${key} opens the wrong module`);
      assertEqual(links[index].target.caseId, caseId, `${key} opens the wrong case`);
      assertEqual(links[index].target.figureKey, key, `${key} carries its own figure`);
    });
  });

  test('a figure that is not marked as a link stays plain text', () => {
    const resolved = resolveSample();
    const section = resolved.sections.find((entry) => entry.id === 'inefficiencies');
    const freedFrom = section.paragraphs[0].segments.find((segment) => segment.key === 'route.cashFlow.freedFrom');
    assertEqual(freedFrom.type, 'figure', 'year is a plain figure');
    assertEqual(freedFrom.text, '2026', 'year text');
  });

  test('"See it in" names only the modules a section linked, in order of first use', () => {
    const resolved = resolveSample();
    const names = (id) => resolved.sections.find((section) => section.id === id).seeIn.map((entry) => entry.title);
    assertEqual(names('current_position'), ['Household cash flow', 'Cash reserve'], 'section 1');
    assertEqual(names('protecting'), ['Protection gap'], 'section 2');
    assertEqual(names('inefficiencies'), ['Car loan', 'Household cash flow'], 'section 3');
    assertEqual(names('goals'), ['College fund', 'Mortgage', 'Pension'], 'section 4');
    assertEqual(names('cash_flow_after'), [], 'section 5: no module prints what is left over once the whole route is in place');
    assertEqual(names('net_worth_after'), ['Balance sheet'], 'section 6');
    assertEqual(names('risks'), [], 'section 7: no module has a rates-up or costs-up case');
    assertEqual(names('check_next'), [], 'section 8 linked nothing, so it names nothing');
  });

  test('a tooltip names the module, the case and the figure it outlines', () => {
    const resolved = resolveSample();
    const interest = resolved.sections.find((s) => s.id === 'inefficiencies').paragraphs[0].segments.find((s) => s.key === 'route.loan.car.interestSaved');
    assertEqual(describeLink(interest), { title: 'Car loan · Clear it now', body: 'Opens the module with €1,300 in interest outlined.' }, 'tooltip');
    const dara = resolved.sections.find((s) => s.id === 'protecting').paragraphs[0].segments.find((s) => s.key === 'protection.dara.gap');
    assertEqual(describeLink(dara).title, 'Protection gap · Dara cannot work', 'case in the title');
  });

  test('narration may not type a figure, a date or a percentage', () => {
    assertEqual(findTypedFigures('You have about {position.leftOver} left over').length, 0, 'placeholders are not figures');
    assertThrows(() => resolveNarration('You have about €11,000 left over.', PLAN_STORY_SAMPLE_REGISTRY), 'typed_figure', 'a typed amount');
    assertThrows(() => resolveNarration('The mortgage clears in 2042.', PLAN_STORY_SAMPLE_REGISTRY), 'typed_figure', 'a typed year');
    assertThrows(() => resolveNarration('It costs 6 per cent.', PLAN_STORY_SAMPLE_REGISTRY), 'typed_figure', 'a typed number');
    assertThrows(() => resolveNarration('About half.%', PLAN_STORY_SAMPLE_REGISTRY), 'typed_figure', 'a typed percent sign');
  });

  test('narration may not recommend, rank, or speak about you in the third person', () => {
    for (const text of ['You should clear the loan.', 'We recommend this route.', 'This is the best route.', 'This route is better.', 'The top route for the household.', 'They could clear it.']) {
      assertThrows(() => resolveNarration(text, PLAN_STORY_SAMPLE_REGISTRY), 'forbidden_wording', text);
    }
    assertEqual(findForbiddenWording('You have a loan and savings.').length, 0, 'plain words pass');
  });

  test('a placeholder the plan did not register is refused with where it is', () => {
    const error = assertThrows(() => resolveNarration('You have {position.nothing} left.', PLAN_STORY_SAMPLE_REGISTRY, { path: '/story/sections/0/paragraphs/0' }), 'unknown_placeholder', 'unknown key');
    assert(error.path.startsWith('/story/sections/0/paragraphs/0{position.nothing}'), 'names the path');
  });

  test('a link on a figure with no source is refused, and so is a stray brace', () => {
    assertThrows(() => resolveNarration('From {@route.cashFlow.freedFrom}.', PLAN_STORY_SAMPLE_REGISTRY), 'unlinkable_placeholder', 'no source');
    assertThrows(() => parseNarration('Mind the {gap'), 'bad_placeholder', 'unclosed brace');
    assertThrows(() => parseNarration('Mind {@@position.leftOver}'), 'bad_placeholder', 'a second marker');
    assertThrows(() => parseNarration('   '), 'invalid_story', 'empty text');
  });

  test('a figure with no value shows the reason there is none', () => {
    const registry = { 'position.solvency': { notApplicable: 'There are no assets yet to measure against.' } };
    const segments = resolveNarration('{position.solvency}', registry);
    assertEqual(segments, [{ type: 'reason', key: 'position.solvency', text: 'There are no assets yet to measure against.' }], 'reason');
    assertThrows(() => resolveNarration('{position.solvency}', { 'position.solvency': {} }), 'empty_fact', 'neither a value nor a reason');
  });

  test('a section told in the five parts reads them in order and skips the empty ones', () => {
    const story = {
      routeId: 'r', headline: 'A', summary: 'B',
      sections: [{ id: 'protecting', title: 'Protecting what you have', parts: { gives: 'It gives {position.savings}.', does: 'It keeps the reserve.', check: 'Check the policy.' } }]
    };
    const resolved = resolveStory({ story, registry: PLAN_STORY_SAMPLE_REGISTRY, catalogue: PLAN_STORY_SAMPLE_CATALOGUE });
    assertEqual(resolved.sections[0].paragraphs.map((p) => plain(p.segments)), ['It keeps the reserve.', 'It gives €90,000.', 'Check the policy.'], 'parts order');
    assertThrows(() => resolveStory({ story: { ...story, sections: [{ id: 'x', title: 'X', parts: { advice: 'No.' } }] }, registry: {}, catalogue: {} }), 'invalid_story', 'unknown part');
  });

  test('a story may not repeat a section or have none', () => {
    const section = { id: 'goals', title: 'Goals', paragraphs: ['Words only.'] };
    assertThrows(() => resolveStory({ story: { routeId: 'r', headline: 'A', summary: 'B', sections: [section, section] }, registry: {}, catalogue: {} }), 'invalid_story', 'repeated');
    assertThrows(() => resolveStory({ story: { routeId: 'r', headline: 'A', summary: 'B', sections: [] }, registry: {}, catalogue: {} }), 'invalid_story', 'none');
  });

  test('the at-a-glance table keeps the routes in the order given and ranks none of them', () => {
    const glance = buildGlance(PLAN_STORY_SAMPLE_ROUTES);
    assertEqual(glance.columns.map((column) => column.number), [1, 2, 3, 4], 'order kept');
    assertEqual(glance.rows.map((row) => row.label), ['Savings used now', 'Left over each year', 'Goals covered'], 'three neutral facts');
    assertEqual(glance.rows[1].cells.map((cell) => cell.text), ['€11,000', '€2,900', '€8,900', '€6,500'], 'left over');
    assertThrows(() => buildGlance([{ ...PLAN_STORY_SAMPLE_ROUTES[0], rank: 1 }]), 'ranking_field', 'rank');
    assertThrows(() => buildGlance([{ ...PLAN_STORY_SAMPLE_ROUTES[0], best: true }]), 'ranking_field', 'best');
    assertThrows(() => buildGlance([{ id: 'x', number: 1, name: 'X', savingsUsed: { text: 'None' } }]), 'invalid_story', 'a missing fact');
  });

  test('a screen follows the route only while it shows the case the link opened', () => {
    const target = { caseId: 'extra' };
    assert(followsRoute(target, 'extra'), 'same case follows');
    assert(!followsRoute(target, 'today'), 'another case does not');
    assert(followsRoute({ caseId: null }, 'anything'), 'a module with no cases always follows');
  });

  return results;
}
