import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createCaseFile } from '../js/planning/analyst/case_file.js';
import { executeTool } from '../js/planning/analyst/executors.js';
import { compilePlanPack } from '../js/planning/plan_pack/compiler.js';
import { profileToPlanPack } from '../js/planning/profile_to_plan_pack.js';
import { getLeverCatalogue } from '../js/planning/plan_pack/lever_catalogue.js';
import { readPlanPosition } from '../js/planning/plan_pack/story_facts.js';
import { sizeMajorMove } from '../js/planning/plan_pack/major_move_search.js';
import { getExplainers } from '../js/planning/figures/get_explainers.js';
import { getFigures } from '../js/planning/figures/get_figures.js';
import { sha256Json } from '../js/planning/utils.js';
import { reviewedRouteExample } from './fixtures/form-to-plan-reviewed.mjs';
import { majorHouseholds } from './fixtures/major-levers.households.mjs';
import { createLocalCase } from './analyst-local-store.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const fact = path => ({ kind: 'fact', path });
const bounded = path => ({ kind: 'bounded', reason: 'Fictional illustration within the recorded bound at ' + path, factPaths: [path] });
const route = (id, ...changes) => ({ id, changes });

export async function checkAnalystWiring({ fixtures, options }) {
  // Only these tests install the existing, explicitly fictional supplemental
  // review facts. Neither new-case nor the production form bridge adds them.
  async function reviewedCase(profile, runId) {
    const c = await createCaseFile(options(fixtures[2], runId));
    const assembly = await profileToPlanPack(profile, { confirmedRevision: 7, calculationDate: c.pinned.calculationDate, clientLabel: c.pinned.planPack.clientName });
    const compiled = await compilePlanPack(assembly.planPack, assembly.compileOptions);
    assert.equal(compiled.status, 'compiled');
    c.pinned = clone({ ...c.pinned, profile, planPack: assembly.planPack, currentPosition: compiled,
      planningFacts: assembly.planPack.planningInputs, missingFacts: assembly.missingFacts,
      omittedChapters: assembly.omittedChapters, provenance: assembly.provenance,
      notes: ['Explicit invented supplemental review facts from the route-lever fixtures.'] });
    c.pinHash = await sha256Json(c.pinned);
    return (await executeTool(c, 'read_position', {})).caseFile;
  }
  const example = reviewedRouteExample(fixtures[2]);
  const reviewed = await reviewedCase(example.profile, 'reviewed');
  const properties = majorHouseholds();
  // Make the invented rental bill large enough to require a sale; the smaller
  // native fixture can already fund its bill without a major move.
  properties.rental.goals.find(goal => goal.goalId === 'fictional_dated_cost').targetAmount.amount = 150000;
  const trade = await reviewedCase(properties.tradeDown, 'trade');
  const rental = await reviewedCase(properties.rental, 'rental');
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
    const compiled = out.caseFile.pricedRoutes[alternative.id];
    const position = readPlanPosition(compiled);
    const selected = position.routes.find(row => row.routeId === alternative.id);
    assert.deepEqual(out.result.data.position, selected);
    assert.deepEqual(out.result.data.facts, selected.facts);
    assert.deepEqual(out.result.data.ledger, compiled.resourceLedger.routes.find(row => row.routeId === alternative.id));
    assert.equal(out.result.data.settingSourceChecks[0].status, 'passed');
    assert.deepEqual(out.result.data.settingSourceChecks[0].sources, change.sources);
    assert.ok(Object.values(out.result.data.facts).every(row => row.basis && row.source && row.status));
    assert.deepEqual((await executeTool(out.caseFile, 'read_position', { routeId: alternative.id })).result.data, position);
    assert.deepEqual((await executeTool(out.caseFile, 'read_position', {})).result.data, readPlanPosition(c.pinned.currentPosition), 'Reading an alternative never replaces pinned current');
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
    const assembly = await profileToPlanPack(c.pinned.profile, { confirmedRevision: 7, calculationDate: c.pinned.calculationDate, clientLabel: c.pinned.planPack.clientName, routes: [] });
    const native = await sizeMajorMove(assembly.planPack, draft, { type, propertyId, year: 2026 });
    assert.deepEqual(out.result.data.route, native.route);
    assert.deepEqual(out.result.data.ledger, native.ledger);
    assert.deepEqual(out.result.data.facts, readPlanPosition(native.compilation).routes.find(row => row.routeId === draft.id).facts);
    assert.equal(out.caseFile.budget.engineRuns, c.budget.engineRuns + 1 + native.probes.length);
    assert.ok(out.result.data.settingSourceChecks.every(row => row.status === 'passed'));
    assert.equal((await executeTool(out.caseFile, 'read_position', { routeId: draft.id })).result.ok, true);
    // A proposed move is reusable through the ordinary price_route contract.
    assert.equal((await executeTool(c, 'price_route', { route: out.result.data.route })).result.ok, true);
  }
  const limited = clone(trade); limited.budget.engineRuns = 58;
  const exhausted = await executeTool(limited, 'balancing_moves', { route: route('limited'), type: 'tradeDownHome', year: 2026 });
  assert.equal(exhausted.result.refusals[0].code, 'budget_exceeded');
  assert.equal(exhausted.caseFile.budget.engineRuns, 60);
  assert.equal(exhausted.result.data.probes.length, 1, 'No probe runs after the final available compiler pass');
  assert.equal((await executeTool(exhausted.caseFile, 'balancing_moves', { route: route('limited'), type: 'tradeDownHome' })).result.refusals[0].code, 'budget_exceeded');
  for (const input of [{}, { type: 'moveGoal', route: route('ordinary') }]) {
    const out = await executeTool(trade, 'balancing_moves', input);
    assert.equal(out.result.refusals[0].message, 'not built yet');
    assert.equal(out.caseFile.budget.engineRuns, trade.budget.engineRuns);
  }
  // A saved refused draft can be sized by ID without replacing its inputs.
  const draftCase = clone(trade); draftCase.routeDrafts.saved = { route: route('saved') };
  assert.equal((await executeTool(draftCase, 'balancing_moves', { routeId: 'saved', type: 'tradeDownHome', year: 2026 })).result.data.status, 'sized');

  const cli = (...args) => {
    const result = spawnSync(process.execPath, ['scripts/analyst.mjs', ...args], { encoding: 'utf8' });
    return { ...result, json: JSON.parse(result.stdout) };
  };
  const listed = cli('list-fixtures');
  assert.deepEqual(listed.json.data.fixtures.map(row => row.name), fixtures.map(row => row.id));
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
  const blank = cli('new-case', '--fixture', fixtures[4].id);
  assert.equal(blank.json.ok, false); assert.ok(blank.json.data.diagnostics.length);

  // Make the successful new lever available to the main test's real CLI/MCP
  // clients, without ever making a production fixture accept reviewed inputs.
  const local = await createLocalCase(options(fixtures[2], 'reviewed-harness'));
  const localCase = clone(trade); localCase.pinned.runId = 'reviewed-harness';
  localCase.pinHash = await sha256Json(localCase.pinned);
  await writeFile(join(local.directory, 'case.json'), JSON.stringify(localCase));
  console.log('[AnalystWiring] native position/bases/issues, all eight sourced levers, explainers, major sizing, probe budget and fixture CLI passed.');
  return { directory: local.directory, route: route('harness_property', inputs[6][1]) };
}
