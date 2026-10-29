import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createCaseFile } from '../js/planning/analyst/case_file.js';
import { executeTool } from '../js/planning/analyst/executors.js';
import { profileToPlanPack } from '../js/planning/profile_to_plan_pack.js';
import { getLeverCatalogue } from '../js/planning/plan_pack/lever_catalogue.js';
import { readPlanPosition } from '../js/planning/plan_pack/story_facts.js';
import { compactStoryFacts } from '../js/plan_story_registry.js';
import { goalWays, balancingMoves, suggestRoutes, priceRoute as nativePriceRoute } from '../js/planning/plan_pack/ledger_walk.js';
import { buildPlanStoryScreen } from '../js/plan_story_session.js';
import { sizeMajorMove } from '../js/planning/plan_pack/major_move_search.js';
import { getExplainers } from '../js/planning/figures/get_explainers.js';
import { getFigures } from '../js/planning/figures/get_figures.js';
import { sha256Json } from '../js/planning/utils.js';
import { reviewedRouteExample } from './fixtures/form-to-plan-reviewed.mjs';
import { REVIEWED_FIXTURES, buildReviewedAnalystCase, buildReviewedFixture } from './fixtures/analyst-households.mjs';
import { createLocalCase } from './analyst-local-store.mjs';
import { checkReply } from './lib/analyst-reply-check.mjs';
import { TOOL_CATALOGUE, RUN_LIMITS } from '../js/planning/analyst/contracts.js';

const clone = value => JSON.parse(JSON.stringify(value));
const fact = path => ({ kind: 'fact', path });
const bounded = path => ({ kind: 'bounded', reason: 'Fictional illustration within the recorded bound at ' + path, factPaths: [path] });
const route = (id, ...changes) => ({ id, changes });

export async function checkAnalystWiring({ fixtures, options }) {
  // The same builders power new-case and every successful reviewed test.
  const reviewedCase = (profile, runId) => buildReviewedAnalystCase(profile, options(fixtures[2], runId));
  const example = reviewedRouteExample(fixtures[2]);
  const reviewed = await buildReviewedFixture('fictional-reviewed-couple', fixtures, options(fixtures[2], 'reviewed'));
  const trade = await buildReviewedFixture('fictional-trade-down', fixtures, options(fixtures[2], 'trade'));
  const rental = await buildReviewedFixture('fictional-rental-sale', fixtures, options(fixtures[2], 'rental'));
  for (const c of [reviewed, trade, rental]) for (const tool of TOOL_CATALOGUE) {
    if (['price_route', 'goal_ways', 'suggest_routes', 'balancing_moves'].includes(tool.name)) continue; // Exercised below with actual priced choices.
    const input = tool.name === 'price_route' ? { route: route('compact_check') }
      : tool.name === 'goal_ways' ? { goalId: example.costId } : tool.name === 'run_whatif' ? { routeId: 'trial' } : {};
    const out = await executeTool(c, tool.name, input);
    checkReply(tool.name, out.result, input, c.pinned.runId);
  }
  const unknownMove = await executeTool(trade, 'balancing_moves', { type: 'invented_move' });
  assert.equal(unknownMove.result.refusals[0].path, '/input/type');
  assert.equal(unknownMove.caseFile.budget.compilerRuns, trade.budget.compilerRuns);
  const central = path => ({ kind: 'default', path, version: reviewed.pinned.versions.assumptions });
  const inputs = [
    [reviewed, { type: 'useCash', goalId: example.costId, amount: 1000,
      sources: { goalId: fact('/household/goals/2/goalId'), amount: bounded('/household/assets/0/currentValue/amount') } }],
    [reviewed, { type: 'clearOutgoing', outgoingId: 'debt_0', paidFrom: 'savings',
      sources: { outgoingId: fact('/planningInputs/outgoingBindings/0/id'), paidFrom: central('/routes/clearOutgoingPaidFrom') } }],
    [reviewed, { type: 'sellAsset', assetId: example.profile.assets[1].assetId,
      sources: { assetId: fact('/household/assets/1/assetId') } }],
    [reviewed, { type: 'moveGoal', goalId: example.retirementGoalId, retirementAge: 66,
      sources: { goalId: fact('/household/goals/0/goalId'), retirementAge: bounded('/household/primaryPerson/intendedRetirementAge') } }],
    [reviewed, { type: 'pensionContribution', personId: 'primary', annualAmount: 1200,
      sources: { personId: fact('/household/primaryPerson/personId'), annualAmount: bounded('/household/incomeSources/0/grossAnnual/amount') } }],
    [reviewed, { type: 'spendLess', annualAmount: 3000,
      sources: { annualAmount: bounded('/household/expenses/annualTotal/amount') } }],
    [trade, { type: 'tradeDownHome', newHomePrice: 400000, year: 2026,
      sources: { newHomePrice: bounded('/household/properties/0/currentValue'), year: bounded('/household/properties/0/currentValue') } }],
    [rental, { type: 'sellProperty', propertyId: 'fictional_rental', year: 2026,
      sources: { propertyId: fact('/household/properties/1/propertyId'), year: bounded('/household/properties/1/currentValue') } }]
  ];
  assert.deepEqual(inputs.map(([, change]) => change.type).sort(), getLeverCatalogue().levers.map(row => row.type).sort(), 'Every catalogue lever has a successful analyst run');
  for (const [c, change] of inputs) {
    const before = clone(c);
    const alternative = route('test_' + change.type.toLowerCase(), change);
    const out = await executeTool(c, 'price_route', { route: alternative });
    assert.equal(out.result.ok, true, change.type + ': ' + JSON.stringify(out.result.refusals));
    checkReply('price_route', out.result, { route: alternative }, change.type);
    const compiled = out.caseFile.pricedRoutes[alternative.id];
    const position = readPlanPosition(compiled);
    const selected = position.routes.find(row => row.routeId === alternative.id);
    assert.deepEqual(out.result.data.position, selected);
    assert.deepEqual(out.result.data.facts, selected.facts);
    assert.deepEqual(out.result.data.ledger, compiled.resourceLedger.routes.find(row => row.routeId === alternative.id));
    assert.equal(out.result.data.settingSourceChecks[0].status, 'passed');
    assert.deepEqual(out.result.data.settingSourceChecks[0].sources, change.sources);
    assert.ok(Object.values(out.result.data.facts).every(row => row.basis && row.source && row.status));
    assert.deepEqual((await executeTool(out.caseFile, 'read_position', { routeId: alternative.id })).result.data.facts, selected.facts);
    assert.deepEqual(out.result.data.storyFacts, compactStoryFacts(position, alternative.id));
    assert.deepEqual((await executeTool(out.caseFile, 'read_position', {})).result.data.facts, readPlanPosition(c.pinned.currentPosition).routes[0].facts, 'Reading an alternative never replaces pinned current');
    assert.deepEqual(c, before, 'Source and earlier routes remain unchanged');
    const bad = clone(change);
    const key = Object.keys(change.sources)[0];
    bad.sources[key] = { kind: 'fact', path: '/household/missing_fact' };
    const refusal = (await executeTool(c, 'price_route', { route: route('bad_source', bad) })).result;
    assert.equal(refusal.ok, false);
    assert.ok(['unsupported_parameter_source', 'missing_information'].includes(refusal.refusals[0].code));
    assert.ok(refusal.refusals[0].path.includes('/sources/'));
    assert.equal(refusal.data.settingSourceChecks[0].status, 'refused');
    if (change.type === 'useCash') {
      const replaced = await executeTool(out.caseFile, 'price_route', { route: route(alternative.id, bad) });
      assert.equal((await executeTool(replaced.caseFile, 'read_position', { routeId: alternative.id })).result.refusals[0].code, 'unpriced_route', 'A refused replacement cannot expose facts for an older draft');
    }
  }
  const missingSources = clone(inputs[4][1]); delete missingSources.sources.annualAmount;
  const unchecked = await executeTool(reviewed, 'price_route', { route: route('missing_source', missingSources) });
  assert.equal(unchecked.result.refusals[0].path, '/routes/1/changes/0/sources/annualAmount');
  const missingEssentials = await createCaseFile(options(fixtures[1], 'unreviewed'));
  const essentialRefusal = (await executeTool(missingEssentials, 'price_route', { route: route('spend_less', inputs[5][1]) })).result;
  assert.ok(essentialRefusal.refusals.some(row => row.path === '/household/expenses/monthlyEssential'));
  assert.equal((await executeTool(reviewed, 'read_position', { routeId: 'unknown' })).result.refusals[0].code, 'unpriced_route');

  const explainer = getExplainers()[0];
  const figure = getFigures({ ids: [explainer.figureIds[0]] })[0];
  const figures = (await executeTool(reviewed, 'read_figures', { ids: [figure.id] })).result.data.figures;
  assert.ok(figures[0].explainers.includes(explainer.id));
  const beforeExplainers = clone(reviewed);
  for (const input of [{}, { ids: [explainer.id] }, { figureIds: [figure.id] }, { ids: [explainer.id], figureIds: [figure.id] }]) {
    assert.deepEqual((await executeTool(reviewed, 'read_explainers', input)).result.data.explainers, getExplainers(input));
  }
  assert.deepEqual(reviewed, beforeExplainers, 'Lookup cannot change the catalogue or case');
  for (const input of [{ ids: ['no_such_explainer'] }, { figureIds: ['no_such_figure'] }]) {
    const out = await executeTool(reviewed, 'read_explainers', input);
    assert.equal(out.result.ok, false); assert.ok(out.result.refusals[0].path.endsWith('/0'));
  }

  for (const [c, type, propertyId] of [[trade, 'tradeDownHome', undefined], [rental, 'sellProperty', 'fictional_rental']]) {
    const draft = route('sized_move');
    const out = await executeTool(c, 'balancing_moves', { route: draft, type, ...(propertyId ? { propertyId } : {}), year: 2026 });
    assert.equal(out.result.ok, true, JSON.stringify(out.result));
    assert.equal(out.result.data.status, 'sized');
    checkReply('balancing_moves', out.result, {}, type);
    let compiles = 0; const execution = { beforeCompile: () => { compiles++; } };
    const assembly = await profileToPlanPack(c.pinned.profile, { confirmedRevision: 7, calculationDate: c.pinned.calculationDate, clientLabel: c.pinned.planPack.clientName, routes: [], ...execution });
    const native = await sizeMajorMove(assembly.planPack, draft, { type, propertyId, year: 2026 }, execution);
    assert.deepEqual(out.result.data.route, native.route);
    assert.deepEqual(out.result.data.ledger, native.ledger);
    assert.deepEqual(out.result.data.facts, readPlanPosition(native.compilation).routes.find(row => row.routeId === draft.id).facts);
    assert.equal(out.caseFile.budget.compilerRuns, c.budget.compilerRuns + compiles);
    assert.ok(out.result.data.settingSourceChecks.every(row => row.status === 'passed'));
    assert.equal((await executeTool(out.caseFile, 'read_position', { routeId: draft.id })).result.ok, true);
    // A proposed move is reusable through the ordinary price_route contract.
    assert.equal((await executeTool(c, 'price_route', { route: out.result.data.route })).result.ok, true);
  }
  const limited = clone(trade); limited.budget.compilerRuns = 1498;
  const exhausted = await executeTool(limited, 'balancing_moves', { route: route('limited'), type: 'tradeDownHome', year: 2026 });
  assert.equal(exhausted.result.refusals[0].code, 'budget_exceeded');
  assert.equal(exhausted.caseFile.budget.compilerRuns, 1500, 'Bridge preflights and search share the same counter');
  assert.equal((await executeTool(exhausted.caseFile, 'balancing_moves', { route: route('limited'), type: 'tradeDownHome' })).result.refusals[0].code, 'budget_exceeded');
  // A saved refused draft can be sized by ID without replacing its inputs.
  const draftCase = clone(trade); draftCase.routeDrafts.saved = { route: route('saved') };
  assert.equal((await executeTool(draftCase, 'balancing_moves', { routeId: 'saved', type: 'tradeDownHome', year: 2026 })).result.data.status, 'sized');

  // The new wrappers preserve the native part-c results, and every compiler
  // invocation (including bridge preflights) enters the same local counter.
  const ordinaryProfile = clone(example.profile);
  ordinaryProfile.assets.forEach(asset => { asset.currentValue.amount = asset.type === 'cash' ? 21000 : 0; });
  ordinaryProfile.goals.find(goal => goal.goalId === example.costId).targetAmount.amount = 100000;
  const ordinary = await reviewedCase(ordinaryProfile, 'ordinary');
  for (const c of [reviewed, trade, rental]) {
    for (const [name, input] of [
      ['goal_ways', { route: route('walk'), goalId: example.costId }],
      ['suggest_routes', {}], ['balancing_moves', { route: route('walk') }]
    ]) {
      const before = clone(c);
      const actual = await executeTool(c, name, input);
      assert.equal(actual.result.ok, true, name + ': ' + JSON.stringify(actual.result.refusals));
      checkReply(name, actual.result, input, c.pinned.runId);
      if (c === rental) continue; // Native financial parity is already checked on the other households.
      let calls = 0; const execution = { candidatePrefix: 'candidate_' + (c.runLog.length + 1), beforeCompile: () => { calls++; } };
      const assembly = await profileToPlanPack(c.pinned.profile, { confirmedRevision: 7, calculationDate: c.pinned.calculationDate,
        clientLabel: c.pinned.planPack.clientName, routes: [], ...execution });
      const expected = name === 'goal_ways' ? await goalWays(assembly, input.route, input.goalId, execution)
        : name === 'suggest_routes' ? await suggestRoutes(assembly, execution)
          : await balancingMoves(await nativePriceRoute(assembly, input.route, execution), execution);
      const { settingSourceChecks, ...returned } = actual.result.data;
      const financial = value => JSON.parse(JSON.stringify(value, (key, v) => ['candidateId', 'wireRoute'].includes(key) ? undefined : v));
      assert.deepEqual(financial(returned), expected, name + ': native function result');
      const choice = returned.suggestions?.find(row => row.pricing?.compilation?.status === 'compiled');
      if (choice) {
        const cached = await executeTool(actual.caseFile, 'price_route', { candidateId: choice.candidateId });
        assert.equal(cached.result.ok, true);
        assert.equal(cached.caseFile.budget.compilerRuns, actual.caseFile.budget.compilerRuns, 'Retaining a priced candidate never recompiles it');
      }
      assert.equal(actual.caseFile.budget.compilerRuns - c.budget.compilerRuns, calls, name + ': exact compile accounting');
      assert.ok(actual.caseFile.budget.compilerRuns <= RUN_LIMITS.compilerRuns);
      assert.deepEqual(c, before, name + ': input case unchanged');
      if (c === trade && name === 'suggest_routes') assert.ok(returned.suggestions.some(row => row.allGoalsOnTime && row.what.some(change => change.type === 'tradeDownHome')));
      if (c === trade && name === 'balancing_moves') assert.ok(returned.moves.some(row => row.kind.startsWith('tradeDownHome')));
    }
  }
  const moved = await executeTool(ordinary, 'balancing_moves', { route: route('ordinary') });
  assert.equal(moved.result.ok, true, JSON.stringify(moved.result.refusals));
  assert.ok(moved.result.data.moves.some(row => row.kind === 'spendLess' && row.scale === 'ordinary'));
  for (const [name, input] of [
    ['goal_ways', { route: route('limited'), goalId: example.costId }], ['suggest_routes', {}], ['balancing_moves', { route: route('limited') }]
  ]) {
    const limited = clone(trade); limited.budget.compilerRuns = 1499;
    const out = await executeTool(limited, name, input);
    assert.equal(out.result.refusals[0].code, 'budget_exceeded');
    assert.equal(out.caseFile.budget.compilerRuns, 1500, name + ': no compiler run past the plan guard');
    assert.equal(out.caseFile.runLog.at(-1).result.refusals[0].path, '/budget/compilerRuns');
  }
  console.log('[AnalystPartC] goal ways, suggestions, ordinary and major balancing, exact compile accounting and cap passed.');

  const cli = (...args) => {
    const result = spawnSync(process.execPath, ['scripts/analyst.mjs', ...args], { encoding: 'utf8' });
    return { ...result, json: JSON.parse(result.stdout) };
  };
  const listed = cli('list-fixtures');
  assert.deepEqual(listed.json.data.fixtures.map(row => row.name), [...fixtures.map(row => row.id), ...REVIEWED_FIXTURES.map(row => row.name)]);
  assert.deepEqual(listed.json.data.fixtures.filter(row => row.reachesRoutes).map(row => row.name), REVIEWED_FIXTURES.map(row => row.name));
  assert.equal(cli('new-case', '--fixture', 'missing').json.refusals[0].path, '/fixture');
  for (const fixture of fixtures.slice(0, 4)) {
    const created = cli('new-case', '--fixture', fixture.id);
    assert.equal(created.status, 0, created.stderr);
    const directory = created.json.directory;
    try {
      const c = JSON.parse(await readFile(join(directory, 'case.json'), 'utf8'));
      assert.deepEqual(c.pinned.information, fixture.information, 'Fixture creation adds no reviewed facts');
      assert.equal(c.pinned.confirmedRevision, 7);
      await writeFile(join(directory, 'input.json'), '{}');
      assert.equal(cli('read_position', '--case', directory, '--input', join(directory, 'input.json')).json.ok, true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  for (const [index, fixture] of REVIEWED_FIXTURES.entries()) {
    const created = cli('new-case', '--fixture', fixture.name);
    assert.equal(created.status, 0, created.stderr);
    try {
      const c = JSON.parse(await readFile(join(created.json.directory, 'case.json'), 'utf8'));
      assert.deepEqual(c.pinned.profile, [reviewed, trade, rental][index].pinned.profile, 'CLI and wiring use the same supplemented profile');
      assert.ok(c.pinned.notes.some(note => /invented supplemental/.test(note)));
      assert.ok(c.pinned.planPack.planningInputs.goalBindings.length);
      assert.equal(created.json.reachesRoutes, true);
    } finally { await rm(created.json.directory, { recursive: true, force: true }); }
  }
  const blank = cli('new-case', '--fixture', fixtures[4].id);
  assert.equal(blank.json.ok, false); assert.ok(blank.json.data.diagnostics.length);

  // Make the successful new lever available to the main test's real CLI/MCP
  // clients, without ever making a production fixture accept reviewed inputs.
  const local = await createLocalCase(options(fixtures[2], 'reviewed-harness'));
  const localCase = clone(trade); localCase.pinned.runId = 'reviewed-harness';
  localCase.pinHash = await sha256Json(localCase.pinned);
  await writeFile(join(local.directory, 'case.json'), JSON.stringify(localCase));
  const priced = await executeTool(localCase, 'price_route', { route: route('harness_property', inputs[6][1]) });
  assert.equal(priced.result.ok, true, JSON.stringify(priced.result.refusals));
  const sections = ['current_position', 'ledger', 'protecting', 'inefficiencies', 'goals', 'cash_flow_after', 'net_worth_after', 'risks', 'check_next'];
  const acceptedStory = { routeId: 'harness_property', headline: 'Your position', summary: 'Your net worth is {@position.netWorth}.',
    sections: sections.map(id => ({ id, title: id.replaceAll('_', ' '), ...(id === 'goals' ? { goals: [] } : {}),
      parts: { does: 'This route illustrates a change.', why: 'The figures follow your details.', gives: 'Your net worth is {position.netWorth}.', costs: 'Moving changes your home.', check: 'Check the recorded details.' } })) };
  acceptedStory.sections[3].parts.why = 'Tax follows the recorded rule{?explainer.dirt}.';
  const accepted = await executeTool(priced.caseFile, 'submit_story', { story: acceptedStory });
  assert.equal(accepted.result.ok, true, JSON.stringify(accepted.result));
  assert.equal(accepted.result.data.openOnStoryScreen, true);
  await writeFile(join(local.directory, 'case.json'), JSON.stringify(accepted.caseFile));
  const opened = spawnSync(process.execPath, ['scripts/analyst-open.mjs', local.directory], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(opened.status, 0, opened.stderr.slice(-3000));
  const session = JSON.parse(await readFile(join(local.directory, 'session.json'), 'utf8'));
  const screen = buildPlanStoryScreen(session.planStory, session, acceptedStory.routeId);
  assert.equal(screen.storyMissing, false);
  assert.ok(screen.resolved.sections.length === 9 && session.modules.length);
  assert.equal(session.planStory.registries.harness_property['position.netWorth'].text, priced.result.data.storyFacts['position.netWorth'].text);
  const legacy = clone(acceptedStory); legacy.summary = '{ledger.cashRemaining}';
  const refused = await executeTool(accepted.caseFile, 'submit_story', { story: legacy });
  assert.equal(refused.result.ok, false);
  assert.deepEqual(refused.caseFile.storyDrafts, accepted.caseFile.storyDrafts, 'Rejected drafts cannot break the accepted screen session');
  // Restore the fresh seed for the main harness parity replays.
  await writeFile(join(local.directory, 'case.json'), JSON.stringify(localCase));
  console.log('[AnalystWiring] native position/bases/issues, all eight sourced levers, explainers, major sizing, probe budget and fixture CLI passed.');
  return { directory: local.directory, route: route('harness_property', inputs[6][1]), goalId: example.costId };
}
