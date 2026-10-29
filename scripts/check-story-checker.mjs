import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkStory, getStoryRequirements } from '../js/planning/plan_pack/story_checker.js';
import { checkStoryLink } from '../js/planning/plan_pack/story_links.js';
import { readPlanPosition } from '../js/planning/plan_pack/story_facts.js';
import { compilePlanPack } from '../js/planning/plan_pack/compiler.js';
import { applicationToProfile } from '../js/planning/application_to_profile.js';
import { profileToPlanPack } from '../js/planning/profile_to_plan_pack.js';
import { getFigures } from '../js/planning/figures/get_figures.js';
import { getExplainers } from '../js/planning/figures/get_explainers.js';
import { buildPresentationCatalogue } from '../js/presenter_catalogue.js';
import { computeHouseholdCashFlowProjection } from '../js/household_cash_flow_math.js';
import { euroText } from '../js/household_cash_flow_view.js';

const read = file => JSON.parse(readFileSync(file, 'utf8')), clone = structuredClone;
const authored = read('scripts/fixtures/story-checker-stories.json');
const households = read('scripts/fixtures/form-to-profile.households.json');
const info = console.info; console.info = () => {};
let total = 0, failures = 0;
async function test(name, fn) { total++; try { await fn(); console.log('PASS ' + name); } catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.stack); } }
const pass = (compiled, story) => { const result = checkStory(compiled, story); assert.equal(result.ok, true, JSON.stringify(result.refusals)); assert.equal(result.verdict, 'pass'); return result; };
const fails = (compiled, story, code, path = null) => {
  const result = checkStory(compiled, story); assert.equal(result.ok, false); assert.equal(result.verdict, 'refused');
  assert.ok(result.refusals.some(row => row.code === code && (path === null || row.path === path)), JSON.stringify(result.refusals));
  assert.ok(result.refusals.every(row => row.code && row.path.startsWith('/') && typeof row.message === 'string' && row.message.trim())); return result;
};
const compiledHouseholds = {};
for (const fixture of households.filter(row => Object.hasOwn(authored, row.id))) {
  const profile = applicationToProfile(fixture.information, { revision: 7, confirmedAt: '2026-10-20T12:00:00.000Z', profileId: fixture.id });
  const built = await profileToPlanPack(profile, { confirmedRevision: 7, clientLabel: fixture.id });
  const compiled = await compilePlanPack(built.planPack, built.compileOptions);
  assert.equal(compiled.status, 'compiled', JSON.stringify(compiled.diagnostics)); compiledHouseholds[fixture.id] = compiled;
  await test('Authored placeholder story passes on freshly compiled ' + fixture.id, () => pass(compiled, authored[fixture.id]));
}
const renter = compiledHouseholds['fictional-single-renter'], renterStory = authored['fictional-single-renter'];
const borrower = compiledHouseholds['fictional-borrower-with-card'], borrowerStory = authored['fictional-borrower-with-card'];
const compile = async p => { const c = await compilePlanPack(p, { resourceLedger: true }); assert.equal(c.status, 'compiled', JSON.stringify(c.diagnostics)); return c; };
const base = () => read('scripts/fixtures/plan-packs/valid-b1.json');
const b1 = await compile(base());

// Scaffolding only for isolated negative rules. The two positive stories above
// are separately authored fixtures, not generated from the checker’s floor.
function completeDraft(compiled, routeId = 'current') {
  const r = getStoryRequirements(compiled, routeId);
  const parts = () => ({ does: 'This view keeps the recorded facts visible.', why: 'The illustration follows the compiled inputs.',
    gives: 'The results come from code.', costs: 'Resources assigned here cannot also be used elsewhere.', check: 'Review changed facts and the recorded limitations.' });
  const sectionIds = ['current_position', 'ledger', 'protecting', 'inefficiencies', 'goals', 'cash_flow_after', 'net_worth_after', 'risks', 'check_next'];
  const sections = sectionIds.map(id => ({ id, title: 'Your recorded position', parts: parts() }));
  for (const section of sections) {
    const required = r.required.filter(row => row.section === section.id);
    section.parts.gives += ' ' + required.map(row => '{' + row.key + '}').join(' ');
    const limits = r.limitations.filter(row => row.section === section.id || section.id === 'check_next');
    section.limitationIds = limits.map(row => row.id);
    section.parts.check += ' ' + limits.map(row => '{' + row.key + '}').join(' ');
  }
  sections[4].goals = r.goalIds.map(id => ({ goalId: id, title: '{goals.' + id + '.title}', parts: {
    ...parts(), gives: r.required.filter(row => row.section === 'goals' && row.key.includes('.' + id + '.')).map(row => '{' + row.key + '}').join(' ')
  } }));
  sections[3].issues = r.issues.map(row => row.id); sections[5].freedCash = r.freed.map(row => row.id);
  sections[7].risks = routeId === 'current' ? [] : [{ changeIds: r.mainChangeIds, parts: parts() }];
  sections[4].majorMoves = r.majorMoves.map(row => row.id);
  return { routeId, headline: 'Your recorded position', summary: 'This view follows the compiled route.', sections,
    whatifs: r.whatifs.filter(row => row.status === 'compiled').map(row => ({ id: row.id })) };
}
const b1Story = completeDraft(b1), alternative = completeDraft(b1, 'college_cash');
await test('Full B1 draft includes its compiled what-if, missing death case, goals, issues and freed events', () => pass(b1, b1Story));
await test('An alternative has a risk tied to its actual main change', () => pass(b1, alternative));
await test('Checker is deterministic, JSON-safe and changes neither input', () => {
  const freeze = obj => { if (obj && typeof obj === 'object') { Object.values(obj).forEach(freeze); Object.freeze(obj); } return obj; };
  const c = freeze(clone(renter)), s = freeze(clone(renterStory)), before = JSON.stringify({ c, s });
  assert.deepEqual(checkStory(c, s), checkStory(c, s)); assert.equal(JSON.stringify({ c, s }), before);
  assert.deepEqual(JSON.parse(JSON.stringify(checkStory(c, s))), checkStory(c, s));
});
await test('Malformed inputs return a verdict rather than throwing', () => {
  for (const story of [null, [], {}, { routeId: 'missing' }, { routeId: 'current', sections: [null] }]) assert.equal(checkStory(renter, story).ok, false);
  assert.equal(checkStory(null, renterStory).ok, false);
});
for (const mutate of [story => story.sections.splice(2, 1), story => story.sections.push(clone(story.sections[0])),
  story => story.sections.reverse(), story => { story.sections[2].id = story.sections[1].id; }]) {
  await test('Sections cannot be dropped, repeated, added or reordered', () => { const story = clone(renterStory); mutate(story); fails(renter, story, 'section_order'); });
}
for (const part of ['does', 'why', 'gives', 'costs', 'check']) await test('Required education-only part: ' + part, () => {
  const story = clone(renterStory); delete story.sections[0].parts[part]; fails(renter, story, 'empty_part', '/story/sections/0/parts/' + part);
});
await test('Costs cannot be blank, punctuation or invisible text', () => {
  for (const costs of [' ', '...', '\u200b']) { const story = clone(renterStory); story.sections[2].parts.costs = costs; fails(renter, story, 'empty_part'); }
});
await test('Preview paragraphs and hidden extra fields are refused instead of substituted for parts', () => {
  const story = clone(renterStory); story.sections[0].paragraphs = ['Words']; story.rank = 'winner'; fails(renter, story, 'unknown_field');
});
for (const mutate of [story => story.sections[4].goals.reverse(), story => story.sections[4].goals.pop(),
  story => story.sections[4].goals.push(clone(story.sections[4].goals[0]))]) await test('Goal subsections are exact and ordered', () => {
  const story = clone(b1Story); mutate(story); fails(b1, story, 'goal_order');
});
await test('Each goal subsection needs its own five parts and its own goal facts', () => {
  const story = clone(b1Story); story.sections[4].goals[0].parts.costs = ''; fails(b1, story, 'empty_part');
  story.sections[4].goals[0].parts.costs = 'Resources stay assigned.'; story.sections[4].goals[0].parts.gives = 'The result stays visible.';
  fails(b1, story, 'goal_fact');
});
await test('Every earner needs a compiled income-stop result or an actual code limitation', () => {
  const story = clone(b1Story); story.whatifs = []; fails(b1, story, 'whatif_floor');
  const r = clone(renterStory); r.sections[2].limitationIds = []; fails(renter, r, 'limitation_floor');
});
await test('A missing death case for a couple must be disclosed in protecting and check_next', () => {
  const story = clone(b1Story); story.sections[2].limitationIds = story.sections[2].limitationIds.filter(id => id !== 'whatif.death');
  fails(b1, story, 'limitation_floor', '/story/sections/2/limitationIds');
});
await test('Compiled income-stop cases for both earners and a death case satisfy the floor without a fabricated limitation', async () => {
  const p = base(); p.planningInputs.protectionCases.push(
    { id: 'dara_stops', event: { type: 'cannotWork', personId: 'dara', statePayment: 0 } },
    { id: 'niamh_dies', event: { type: 'dies', personId: 'niamh', survivorsPension: 0 } });
  const c = await compile(p), story = completeDraft(c); pass(c, story);
  assert.deepEqual(story.whatifs.map(row => row.id), ['incomeStops.niamh', 'incomeStops.dara', 'death']);
  assert.equal(getStoryRequirements(c, 'current').limitations.some(row => row.id === 'whatif.death'), false);
  story.whatifs = story.whatifs.filter(row => row.id !== 'death'); fails(c, story, 'whatif_floor');
});
await test('A sole parent also requires a death result or code limitation', async () => {
  // The real parent case is the already compiled household with its partner
  // omitted from household composition; no death result is invented.
  const c = clone(b1); for (const route of c.routes) delete route.sourceHousehold.partner; delete c.source.normalizedPlanPack.household.partner;
  const required = getStoryRequirements(c, 'current'); assert.ok(required.whatifs.some(row => row.kind === 'death'));
});
await test('A story cannot claim an unrun or unknown what-if', () => {
  for (const id of ['incomeStops.primary', 'death', 'invented']) { const story = clone(renterStory); story.whatifs = [{ id }]; fails(renter, story, 'unrun_whatif'); }
});
await test('A compiled what-if must have its results in protecting, not just a metadata tag', () => {
  const story = clone(b1Story); story.sections[2].parts.gives = 'Recorded results stay visible.'; fails(b1, story, 'required_fact');
});
await test('The emergency reserve belongs in protecting', () => {
  const story = clone(renterStory); story.sections[2].parts.does = 'The reserve stays visible.'; fails(renter, story, 'required_fact');
});
await test('An alternative risk must cite its main change, not a generic warning or another change', () => {
  const story = clone(alternative); story.sections[7].risks = []; fails(b1, story, 'risk_floor');
  story.sections[7].risks = [{ changeIds: ['unknown'], parts: clone(story.sections[7].parts) }]; fails(b1, story, 'unknown_reference'); fails(b1, story, 'risk_floor');
});
await test('Every issue is named and its actual item facts are narrated', () => {
  const story = clone(borrowerStory); story.sections[3].issues = []; fails(borrower, story, 'issue_floor');
  story.sections[3].issues = ['debts_other_than_mortgage']; story.sections[3].parts.gives = 'Recorded borrowing stays visible.'; fails(borrower, story, 'required_fact');
});
await test('Freed cash inside ledger years cannot be omitted', () => {
  const story = clone(b1Story); story.sections[5].freedCash = []; fails(b1, story, 'freed_cash_floor');
});
await test('A repayment beyond the ledger horizon creates no mandatory freed-cash entry', () => {
  const c = clone(b1), ledger = c.resourceLedger.routes.find(row => row.routeId === 'current');
  ledger.freedCash.push({ kind: 'loan_ends', liabilityId: 'later', label: 'Later repayment', annualAmount: 100, fromYear: 2190, payoffDateIso: '2189-12-01' });
  assert.equal(getStoryRequirements(c, 'current').freed.some(row => row.id === 'later'), false);
});
for (const phrase of ['You should use this route.', 'We recommend this route.', 'This is better.', 'The cheapest route.', 'The preferred route.', 'AIB has an option.']) {
  await test('Banned/ranking/provider wording: ' + phrase, () => { const story = clone(renterStory); story.summary = phrase; fails(renter, story, 'forbidden_wording'); });
}
for (const phrase of ['It costs €100.', 'At 3%.', 'Until 2045.', 'For twelve months.', 'At age sixty-five.', 'At twenty twenty-seven.', 'It uses half your savings.', 'It costs a thousand euro.', 'For Ⅻ years.', 'For s\u200bixty years.', 'For a year.', 'After a couple of months.']) {
  await test('Typed figures are refused in digits and words: ' + phrase, () => { const story = clone(renterStory); story.summary = phrase; fails(renter, story, 'typed_figure'); });
}
for (const phrase of ['He can review the result.', 'Her savings remain.', 'His income changes.', 'She can review the result.']) {
  await test('Gendered pronoun is refused: ' + phrase, () => { const story = clone(renterStory); story.summary = phrase; fails(renter, story, 'gendered_pronoun'); });
}
await test('Another alternative cannot be named or referenced generically', () => {
  for (const phrase of ['Compare clear_car.', 'Compared with another route.']) { const story = clone(alternative); story.summary = phrase; fails(b1, story, 'other_alternative'); }
});
await test('Calculated states use placeholders rather than typed conclusions', () => {
  const story = clone(renterStory); story.summary = 'The goals are covered.'; fails(renter, story, 'typed_state');
});
for (const phrase of ['Your cover amount is sufficient.', 'Your premium remains.', 'The gap against cover remains.', 'You need more life cover.', 'Your insurance product remains.']) {
  await test('Protection restriction: ' + phrase, () => { const story = clone(renterStory); story.summary = phrase; fails(renter, story, 'protection_wording'); });
}
await test('Protection cannot be a different registered amount labelled as cover', () => {
  const story = clone(b1Story); story.summary = 'The death cover is {position.netWorth}.'; fails(b1, story, 'protection_figure');
  story.summary = 'On death you receive {position.reserve}.'; fails(b1, story, 'protection_figure');
});
await test('Protection may not narrate total money in, only gap, months and stated money received', () => {
  const story = clone(b1Story); story.sections[2].parts.gives += ' {protection.niamh_stops.moneyIn}'; fails(b1, story, 'protection_figure');
});
await test('Unknown, cross-route and unavailable placeholders are refused', () => {
  for (const key of ['unknown.key', 'college_cash.position.netWorth']) { const story = clone(renterStory); story.summary = '{' + key + '}'; fails(renter, story, 'unknown_placeholder'); }
  const story = clone(renterStory); story.summary = '{position.leftOver}'; fails(renter, story, 'unavailable_placeholder');
});
for (const token of ['{@@position.netWorth}', '{!position.netWorth}', '{position.netWorth', '{?unknown.id}', '{{position.netWorth}}']) await test('Malformed placeholder: ' + token, () => {
  const story = clone(renterStory); story.summary = token; fails(renter, story, 'bad_placeholder');
});
await test('Register figures and explainers must exist, with the compiled register version', () => {
  const story = clone(renterStory), figure = getFigures({ onDate: renter.calculationDate })[0], explainer = getExplainers()[0];
  story.summary = '{figure.' + figure.id + '} {?explainer.' + explainer.id + '}'; pass(renter, story);
  story.summary = '{figure.missing}'; fails(renter, story, 'unknown_figure');
  story.summary = '{?explainer.missing}'; fails(renter, story, 'unknown_explainer');
  story.summary = '{@figure.' + figure.id + '}'; fails(renter, story, 'register_link');
  const c = clone(renter); c.versions.figures = 'older'; story.summary = '{figure.' + figure.id + '}'; fails(c, story, 'register_versions');
});
await test('A link must have an available native focus and an equal compiled figure', () => {
  const c = clone(renter), chapter = c.chapters.find(row => row.id === 'personal_balance_sheet').cases[0];
  chapter.metrics.netWorth += 0.01;
  assert.ok(checkStory(c, renterStory).refusals.some(row => row.code === 'link_target' || row.code === 'link_value'));
});
const position = readPlanPosition(b1).routes.find(row => row.routeId === 'current');
await test('Links reject the wrong route case, native case, target, unit, display or version', () => {
  const original = position.facts['position.netWorth']; assert.equal(checkStoryLink(b1, original, '/link').ok, true);
  const mutations = [
    ['link_case', fact => { fact.source.caseId = 'wrong'; }],
    ['link_case', fact => { fact.source.nativeCaseId = 'wrong'; }],
    ['link_target', fact => { fact.source.focusTargetId = 'wrong'; }],
    ['link_unit', fact => { fact.unit = 'EUR/year'; }],
    ['link_display', fact => { fact.display = '€175,000.00'; }],
    ['link_versions', fact => { fact.source.versions.taxRules = 'older'; }]
  ];
  for (const [code, mutate] of mutations) { const fact = clone(original); mutate(fact); assert.equal(checkStoryLink(b1, fact, '/link').refusal.code, code); }
});
await test('Current aliases on an alternative open the current case', () => {
  const story = clone(alternative); story.summary += ' {@current.position.netWorth}';
  const result = pass(b1, story), link = result.links.find(row => row.key === 'current.position.netWorth');
  assert.equal(link.source.routeId, 'current'); assert.equal(link.source.caseId, b1.routes[0].chapterCases.personal_balance_sheet);
});
await test('Native cash-flow rounding comes from its shown result, not rounding the exact surplus independently', () => {
  const chapterIndex = b1.chapters.findIndex(row => row.id === 'household_cash_flow'), entry = b1.chapters[chapterIndex].cases[0];
  const projection = computeHouseholdCashFlowProjection(entry.input, { calculationYear: 2026 });
  const summary = projection.summary.cases.find(row => row.id === entry.nativeCaseId);
  const catalogue = buildPresentationCatalogue({ modules: [{ id: entry.id, title: entry.payload.title, generated: { ...entry.payload.generated, ...entry.derived } }] });
  const target = catalogue.targets.find(row => row.kind === 'table-row' && row.cells[0] === summary.title);
  const fact = { key: 'cashflow.leftOver', value: entry.metrics.leftOver, unit: 'EUR/year', display: euroText(summary.leftOver.shown),
    source: { kind: 'chapter', chapter: 'household_cash_flow', routeId: 'current', caseId: entry.id, nativeCaseId: entry.nativeCaseId,
      focusTargetId: target.id, panel: null, path: `/chapters/${chapterIndex}/cases/0/metrics/leftOver`, versions: b1.versions } };
  assert.equal(checkStoryLink(b1, fact, '/link').ok, true);
  fact.display = euroText(fact.value); assert.equal(checkStoryLink(b1, fact, '/link').refusal.code, 'link_display');
});
await test('A chapter-sourced cash-flow link uses the engine’s own table rounding in the registered display', async () => {
  const c = await compilePlanPack(read('scripts/fixtures/plan-packs/valid-small.json')); assert.equal(c.status, 'compiled');
  const story = completeDraft(c); story.summary = 'The compiled cash-flow result is {@position.leftOver}.';
  const result = pass(c, story); assert.ok(result.links.some(row => row.key === 'position.leftOver'));
});
await test('A plan-panel link must match its compiled pointer', () => {
  const fact = clone(position.facts['leftOverAfterGoals.yearly']); assert.equal(checkStoryLink(b1, fact, '/link').ok, true);
  fact.value += 1; assert.equal(checkStoryLink(b1, fact, '/link').refusal.code, 'link_value');
});
await test('Missing results require the code message in both their section and check_next, not author-written excuses', () => {
  const story = clone(renterStory); story.sections[8].parts.check = 'Review the missing facts.'; fails(renter, story, 'limitation_floor');
  story.sections[8].parts.check = 'The result is not shown.'; fails(renter, story, 'unregistered_limitation');
  story.sections[8].limitationIds.push('invented'); fails(renter, story, 'unknown_reference');
});
await test('The card limitation names its actual missing interest-rate fact', () => {
  const required = getStoryRequirements(borrower, 'current');
  const limitation = required.limitations.find(row => row.factKey?.endsWith('credit_card.yearlyCost'));
  assert.ok(limitation.missingFacts.some(row => row.path.endsWith('/annualInterestRate')));
});
const majorPack = base(); majorPack.goalFlexibility.goal_retirement.retirementAge[1] = 70;
majorPack.routes = [{ id: 'current' }, { id: 'working_longer', changes: [{ type: 'moveGoal', goalId: 'goal_retirement', retirementAge: 70 }] }]; majorPack.narration = {};
const major = await compile(majorPack), majorStory = completeDraft(major, 'working_longer');
await test('A real compiled major move has explicit costs and check parts', () => pass(major, majorStory));
await test('A major move cannot be hidden or lose its costs or check part', () => {
  const story = clone(majorStory); story.sections[4].majorMoves = []; fails(major, story, 'major_move_floor');
  story.sections[4].majorMoves = ['change_0']; story.sections[4].parts.costs = ''; fails(major, story, 'major_move_parts');
  story.sections[4].parts.costs = 'Resources stay assigned.'; story.sections[4].parts.check = ''; fails(major, story, 'major_move_parts');
});
await test('Multiple major moves cannot be authorised by a story claim or an unsupported compiled boolean', () => {
  const c = clone(major); c.source.normalizedPlanPack.routes[1].changes.push({ type: 'tradeDownHome', newHomePrice: 200000, year: 2026 });
  const story = completeDraft(c, 'working_longer'); fails(c, story, 'major_move_count');
  c.routes.find(row => row.id === 'working_longer').majorMoveEvidence = { code: 'single_major_insufficient', singleMoveRouteIds: ['current'] };
  fails(c, story, 'major_move_count');
  story.evidence = 'This is enough.'; fails(c, story, 'unknown_field');
});
await test('The combined-major exception requires actual unmet-goal singleton evidence for every included move', async () => {
  const p = base(); p.household.expenses.annualTotal.amount = 60000; p.household.expenses.monthlyEssential = { amount: 2000, currency: 'EUR' };
  p.household.goals.find(row => row.goalId === 'goal_retirement').targetAmount.amount = 200000;
  p.goalFlexibility.goal_retirement.retirementAge[1] = 70;
  p.routes = [{ id: 'current' }, { id: 'working_longer', changes: [{ type: 'moveGoal', goalId: 'goal_retirement', retirementAge: 70 }] },
    { id: 'lower_spending', changes: [{ type: 'spendLess', annualAmount: 15000, sources: { annualAmount: { kind: 'bounded',
      reason: 'Invented illustration citing /household/expenses/annualTotal', factPaths: ['/household/expenses/annualTotal'] } } }] }]; p.narration = {};
  const c = await compile(p);
  assert.ok(c.resourceLedger.routes.filter(row => row.routeId !== 'current').every(row => row.goals.some(goal => ['partly', 'not'].includes(goal.state))));
  // The current compiler caps majors at a move. Exercise the checker's future
  // compiled-evidence envelope, using real singleton results; this does not
  // claim to price their combination or add a combined-major route builder.
  const combined = { ...clone(c.routes.find(row => row.id === 'working_longer')), id: 'combined',
    majorMoveEvidence: { code: 'single_major_insufficient', singleMoveRouteIds: ['working_longer', 'lower_spending'] } };
  c.routes.push(combined);
  c.resourceLedger.routes.push({ ...clone(c.resourceLedger.routes.find(row => row.routeId === 'working_longer')), routeId: 'combined' });
  c.source.normalizedPlanPack.routes.push({ id: 'combined', changes: [...clone(p.routes[1].changes), ...clone(p.routes[2].changes)] });
  const story = completeDraft(c, 'combined');
  assert.equal(checkStory(c, story).refusals.some(row => row.code === 'major_move_count'), false);
  combined.majorMoveEvidence.singleMoveRouteIds.pop(); fails(c, story, 'major_move_count');
});
await test('Malformed metadata produces refusals without throwing', () => {
  for (const changeIds of [null, 'change_0', [null], {}]) { const story = clone(alternative); story.sections[7].risks = [{ changeIds, parts: clone(story.sections[7].parts) }]; assert.equal(checkStory(b1, story).ok, false); }
});
await test('Malformed major-move metadata is refused rather than throwing', () => {
  const story = clone(majorStory); story.sections[4].majorMoves = {}; assert.equal(checkStory(major, story).ok, false);
});
console.info = info;
console.log(`Story-checker checks: ${total - failures}/${total} passed.`);
if (failures) process.exitCode = 1;
