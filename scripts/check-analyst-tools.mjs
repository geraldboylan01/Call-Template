import assert from 'node:assert/strict';
import { readFile, writeFile, rm, stat } from 'node:fs/promises';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCaseFile } from '../js/planning/analyst/case_file.js';
import { executeTool } from '../js/planning/analyst/executors.js';
import { TOOL_CATALOGUE, RUN_LIMITS, budgetRefusal } from '../js/planning/analyst/contracts.js';
import { createLocalCase, callLocalTool, ANALYSES_ROOT } from './analyst-local-store.mjs';
import { getFigures } from '../js/planning/figures/get_figures.js';
import { compilePlanPack } from '../js/planning/plan_pack/compiler.js';
import { profileToPlanPack } from '../js/planning/profile_to_plan_pack.js';
import { sha256Json } from '../js/planning/utils.js';
import { SECTIONS } from '../js/case_application/schema.js';
import { missingFactQuestions } from '../js/planning/analyst/questions.js';
import { readPlanPosition } from '../js/planning/plan_pack/story_facts.js';
import { compactStoryFacts } from '../js/plan_story_registry.js';
import { checkAnalystWiring } from './check-analyst-wiring.mjs';
import { checkReply } from './lib/analyst-reply-check.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const execFileAsync = promisify(execFile);
// A native walk can perform up to sixty compiler runs. Transport parity checks
// its result, not a one-minute latency target on a shared CI runner. Both
// harnesses get the same finite deadline and CLI results have an explicit cap.
const harnessTimeoutMs = 5 * 60_000;
const harnessMaxBuffer = 32 * 1024 * 1024;
async function harnessCall(label, run) {
  const started = performance.now();
  console.log('[AnalystHarness] ' + label + ': started');
  try { return await run(); }
  catch (error) {
    throw new Error(label + ' failed after ' + Math.round(performance.now() - started) + 'ms: '
      + (error.code ?? '') + ' ' + error.message.slice(-3000));
  } finally { console.log('[AnalystHarness] ' + label + ': ' + Math.round(performance.now() - started) + 'ms'); }
}
function cliTool(name, directory, inputFile) {
  return harnessCall('CLI ' + name, async () => {
    const { stdout } = await execFileAsync('npm', ['run', '--silent', 'analyst', '--', name, '--case', directory, '--input', inputFile],
      { cwd: root, encoding: 'utf8', maxBuffer: harnessMaxBuffer, timeout: harnessTimeoutMs });
    return JSON.parse(stdout);
  });
}
function mcpTool(name, input) {
  return harnessCall('MCP ' + name, () => client.callTool({ name, arguments: input }, undefined, { timeout: harnessTimeoutMs }));
}
const fixtures = JSON.parse(await readFile(new URL('./fixtures/form-to-profile.households.json', import.meta.url), 'utf8'));
const requestId = 'analyst-check-' + process.pid;
const options = (fixture, runId = fixture.id) => ({ requestId, runId, revision: 7, confirmedRevision: 7,
  confirmedAt: '2026-10-20T12:00:00.000Z', information: fixture.information, clientLabel: fixture.id });
const clone = value => JSON.parse(JSON.stringify(value));
const sectionIds = ['current_position', 'ledger', 'protecting', 'inefficiencies', 'goals', 'cash_flow_after', 'net_worth_after', 'risks', 'check_next'];
const story = (routeId = 'current') => ({ routeId, headline: 'Your position', summary: 'A view of your resources.',
  sections: sectionIds.map(id => ({ id, title: id.replaceAll('_', ' '), ...(id === 'goals' ? { goals: [] } : {}),
    parts: { does: 'The route keeps your current position.', why: 'This follows your confirmed details.',
      gives: 'Your net worth is {position.netWorth}.', costs: 'Your existing commitments continue.', check: 'Check your details.' } })) });
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const firstCode = output => output.result.refusals?.[0]?.code;
const assertRefusal = result => { assert.equal(result.status, 'refused'); assert.ok(result.refusals.length); assert.ok(result.refusals.every(row => row.code && row.path.startsWith('/') && row.message)); };
const originalInfo = console.info;
console.info = () => {};
let client, transport;
try {
  const ajv = new Ajv({ strict: false });
  assert.equal(TOOL_CATALOGUE.length, 10);
  for (const tool of TOOL_CATALOGUE) assert.ok(ajv.validateSchema(tool.inputSchema), JSON.stringify(ajv.errors));
  const cases = [];
  for (const fixture of fixtures.slice(0, 4)) {
    const c = await createCaseFile(options(fixture));
    const source = clone(c);
    freeze(c);
    assert.equal(c.pinned.confirmedRevision, 7);
    assert.equal(c.pinned.versions.compiler, c.pinned.currentPosition.compilerVersion);
    assert.ok(c.pinned.versions.taxRules && c.pinned.versions.figures && c.pinned.versions.assumptions);
    if (fixture === fixtures[0]) {
      let initialCompiles = 0;
      const beforeCompile = () => { initialCompiles++; };
      const initial = await profileToPlanPack(c.pinned.profile, { confirmedRevision: 7,
        calculationDate: c.pinned.calculationDate, clientLabel: fixture.id, beforeCompile });
      await compilePlanPack(initial.planPack, { ...initial.compileOptions, beforeCompile });
      assert.equal(c.budget.engineRuns, initialCompiles, 'Case creation includes every compiler preflight');
    }
    const position = await executeTool(c, 'read_position', {});
    assert.equal(position.result.ok, true);
    assert.deepEqual(position.result.data.facts, readPlanPosition(c.pinned.currentPosition).routes[0].facts);
    assert.deepEqual(position.result.data.storyFacts, compactStoryFacts(readPlanPosition(c.pinned.currentPosition), 'current'));
    const compact = checkReply('read_position', position.result, {}, fixture.id);
    assert.ok(Object.keys(compact.data.facts).every(key => !key.startsWith('current.')));
    assert.ok(Object.values(compact.data.facts).every(fact => !fact.source && !fact.basis));
    const keys = Object.keys(position.result.data.facts).slice(0, 20);
    const detail = await executeTool(c, 'read_position', { keys });
    checkReply('read_position', detail.result, { keys }, fixture.id);
    assert.deepEqual(detail.result.data.facts, Object.fromEntries(keys.map(key => [key, position.result.data.facts[key]])));
    for (const fact of Object.values(position.result.data.facts)) {
      assert.ok(fact.key && fact.status && fact.basis && fact.source.routeId === 'current' && fact.source.versions);
    }
    for (const tool of TOOL_CATALOGUE) {
      const input = tool.name === 'price_route' ? { route: { id: 'trial', changes: [] } }
        : tool.name === 'submit_story' ? { story: story() } : tool.name === 'goal_ways' ? { goalId: c.pinned.profile.goals[0].goalId } : {};
      const out = await executeTool(c, tool.name, input);
      checkReply(tool.name, out.result, input, fixture.id);
      assert.equal(out.caseFile.runLog.length, 2);
      assert.deepEqual(out.caseFile.runLog.at(-1).result, out.result);
      if (tool.unavailable) { assertRefusal(out.result); assert.equal(firstCode(out), 'not_built_yet'); }
      else if (!out.result.ok) assertRefusal(out.result);
      else assert.equal(out.result.status, 'ok'); // Full route funding facts have not been asked by v1.
    }
    const missing = (await executeTool(c, 'missing_facts', {})).result.data;
    const types = new Set(SECTIONS.flatMap(section => [...(section.fields ?? []), ...(section.repeater?.fields ?? [])]).map(field => field.type));
    assert.ok(missing.questions.length);
    for (const q of missing.questions) {
      assert.ok(q.path && q.label && types.has(q.type) && q.affects.length && q.reason);
      assert.equal(Object.hasOwn(q, 'answer'), false);
      if (q.type === 'choice') assert.ok(q.options.length);
      if (q.proposed) assert.equal(q.writesTo, 'confirmed_form_revision_only');
      // No question asks the person to predict a State payment or entitlement (plan document section 6;
      // B1.5 section 8): nothing under the protection assumptions is asked as a payment amount.
      assert.ok(!(q.path.startsWith('/assumptions/values/protection/') && q.type === 'money'), 'No question asks for a State payment amount');
      assert.ok(!/state payment expected|expected state payment/i.test(`${q.label} ${q.reason}`), 'No question asks what State payment someone expects');
    }
    assert.ok(missing.unavailable.some(row => row.kind === 'implementation'));
    assert.deepEqual(c, source, 'Pure execution preserves all pinned and mutable input state');
    cases.push(source);
  }
  await assert.rejects(createCaseFile({ ...options(fixtures[0]), revision: 8 }), /confirmed/);
  await assert.rejects(createCaseFile({ ...options(fixtures[0]), confirmedAt: null }));
  await assert.rejects(createCaseFile(options(fixtures[4])), /cannot become a plan/);
  const followup = await createCaseFile({ ...options(fixtures[0], 'followup'), revision: 8, confirmedRevision: 8,
    previousRun: { runId: fixtures[0].id, confirmedRevision: 7 } });
  assert.equal(followup.pinned.confirmedRevision, 8);
  assert.equal(followup.pinned.previousRun.confirmedRevision, 7);
  assert.equal(followup.runLog.length, 1);
  assert.deepEqual(followup.routeDrafts, {});
  assert.deepEqual(followup.storyDrafts, {});
  await assert.rejects(createCaseFile({ ...options(fixtures[0]), previousRun: { runId: 'old', confirmedRevision: 7 } }), /earlier/);
  const base = cases[1];
  const questionCase = clone(base);
  questionCase.pinned.missingFacts = [
    { factId: 'person_current_age', fieldPath: '/household/partner/age', reason: 'Confirm your partner’s age.', kind: 'household_fact', blockingModuleIds: ['pension_projection'] },
    { factId: 'pension_employee_contribution_rate', fieldPath: '/household/pensions/1/employeeContributionRate', reason: 'Confirm the contribution.', kind: 'household_fact', blockingModuleIds: ['household_cash_flow'] }
  ];
  const mapped = missingFactQuestions(questionCase).questions;
  const ageField = SECTIONS.find(section => section.id === 'about').fields.find(field => field.path === 'household.partnerAge');
  assert.equal(mapped[0].path, ageField.path); assert.equal(mapped[0].label, ageField.label);
  assert.equal(mapped[0].type, ageField.type); assert.equal(mapped[0].min, ageField.min); assert.equal(mapped[0].max, ageField.max);
  assert.equal(mapped[1].path, 'pensions.1.youPay');
  assert.equal(mapped[1].unitKey, 'youPayUnit'); assert.ok(mapped[1].units.length);
  const changed = clone(base); changed.pinned.information.household.age++;
  assert.equal(firstCode(await executeTool(changed, 'read_position', {})), 'changed_snapshot');
  const drift = clone(base); drift.pinned.versions.compiler = 'other-version'; drift.pinHash = await sha256Json(drift.pinned);
  assert.equal(firstCode(await executeTool(drift, 'read_position', {})), 'version_mismatch');
  for (const name of ['unknown', 'goal_ways', 'suggest_routes', 'balancing_moves', 'run_whatif']) {
    assertRefusal((await executeTool(base, name, null)).result);
  }
  assertRefusal((await executeTool(base, 'read_position', { household: {} })).result);
  for (const input of [{ ids: ['missing.id'] }, { onDate: '2026-02-31' }, { kinds: ['unknown'] }, { module: 'unknown' }]) {
    assertRefusal((await executeTool(base, 'read_figures', input)).result);
  }
  for (const input of [{}, { kinds: ['law'] }, { kinds: 'law' }, { module: 'planning' }, { onDate: '2026-10-20' },
    { ids: getFigures().slice(0, 3).map(row => row.id), kinds: ['law'], module: 'planning', onDate: '2026-10-20' }]) {
    const result = await executeTool(base, 'read_figures', input);
    assert.deepEqual(result.result.data.figures, getFigures(input).map(figure => ({ ...figure, explainers: figure.explainers ?? [] })));
    assert.ok(!JSON.stringify(result.result.data.figures).includes('"quotes"'));
  }
  const allFigures = getFigures();
  const unfunded = checkReply('goal_ways', { ok: true, data: { ways: [{ kind: 'lump_sum',
    pricing: { ledger: null, refusals: [{ code: 'missing_information', path: '/household/assets', message: 'Cash is unavailable.' }] },
    shortfall: { cash: 2000, yearly: [{ year: 2028, amount: 1000 }] } }] } });
  assert.deepEqual(unfunded.data.ways[0].shortfall, { cash: 2000, yearly: [{ year: 2028, amount: 1000 }] }, 'An unpriced way keeps its native shortfall and calendar year');
  const indexIds = [];
  for (let offset = 0; offset < allFigures.length; offset += 100) {
    const raw = (await executeTool(base, 'read_figures', { offset })).result;
    indexIds.push(...checkReply('read_figures', raw, { offset }).data.figures.map(row => row.id));
  }
  assert.deepEqual(indexIds, allFigures.map(row => row.id), 'Index pages omit no figures');
  for (let offset = 0; offset < allFigures.length; offset += 10) {
    const ids = allFigures.slice(offset, offset + 10).map(row => row.id);
    checkReply('read_figures', (await executeTool(base, 'read_figures', { ids })).result, { ids });
  }
  const a = await executeTool(base, 'read_position', {});
  const b = await executeTool(a.caseFile, 'read_figures', { kinds: ['law'] });
  const again = await executeTool(b.caseFile, 'read_position', {});
  assert.deepEqual(a.result, again.result);
  assert.deepEqual(b.result, (await executeTool(again.caseFile, 'read_figures', { kinds: ['law'] })).result);

  const badStories = [
    s => { s.summary = '{ledger.cashRemaining}'; },
    s => { s.summary = '{personal_balance_sheet.netWorth}'; },
    s => { s.sections.pop(); }, s => { s.sections[0].id = 'risks'; },
    s => { delete s.sections[0].parts.why; }, s => { s.summary = 'You have 123 euros.'; },
    s => { s.summary = 'This is better.'; }, s => { s.summary = '{another_route.cash}'; },
    s => { s.sections[4].goals = [{ goalId: 'unknown', title: 'Your goal', parts: s.sections[0].parts }]; }
  ];
  for (const edit of badStories) { const s = story(); edit(s); assertRefusal((await executeTool(base, 'submit_story', { story: s })).result); }
  const checked = await executeTool(base, 'submit_story', { story: story() });
  assert.equal(checked.result.data.releaseEligible, false);
  assert.equal(checked.caseFile.reviewStatus, 'pending');
  assert.equal(checked.caseFile.checkerReports.length, 1);
  const nativeStory = story(); nativeStory.summary = 'Your net worth is {@position.netWorth}.';
  assert.equal((await executeTool(base, 'submit_story', { story: nativeStory })).result.ok, true);
  const missingKey = Object.entries(readPlanPosition(base.pinned.currentPosition).routes[0].facts).find(([, fact]) => fact.status === 'missing')[0];
  nativeStory.summary = '{' + missingKey + '}';
  assertRefusal((await executeTool(base, 'submit_story', { story: nativeStory })).result);

  // A variant of #97's invented family asking only about the current position
  // can exercise successful route pricing without inventing funding facts.
  const leanFixture = { ...fixtures[1], information: { ...fixtures[1].information, topics: ['whole'] } };
  let lean = await createCaseFile(options(leanFixture, 'pricing'));
  const route = { id: 'unchanged', changes: [] };
  const priced = await executeTool(lean, 'price_route', { route, reason: 'Keep the confirmed commitments.' });
  assert.equal(priced.result.ok, true, JSON.stringify(priced.result));
  const compiler = await compilePlanPack({ ...lean.pinned.planPack, routes: [{ id: 'current' }, route] }, { resourceLedger: true });
  assert.deepEqual(priced.result.data.ledger, compiler.resourceLedger.routes.find(row => row.routeId === route.id));
  assert.ok(priced.caseFile.budget.engineRuns > 1 && priced.caseFile.budget.engineRuns <= 60);
  for (const change of [
    { type: 'useCash', goalId: 'missing', amount: 'whole' },
    { type: 'moveGoal', goalId: 'missing', targetDate: '2030-01-01' },
    { type: 'clearOutgoing', outgoingId: 'missing', paidFrom: 'savings' },
    { type: 'sellAsset', assetId: 'missing' }, { type: 'future_lever' }
  ]) {
    const result = await executeTool(lean, 'price_route', { route: { id: 'trial', changes: [change] } });
    assertRefusal(result.result);
    assert.ok(result.result.refusals[0].path.startsWith('/input/route/') || result.result.refusals[0].path.startsWith('/routes/'), 'Catalogue schema and compiler own lever validation');
  }
  const linked = story('unchanged'); linked.summary = '{@position.netWorth}';
  assert.equal((await executeTool(priced.caseFile, 'submit_story', { story: linked })).result.ok, true);
  const otherRoute = story(); otherRoute.summary = '{unchanged.ledger.cashRemaining}';
  assertRefusal((await executeTool(priced.caseFile, 'submit_story', { story: otherRoute })).result);

  assert.deepEqual(RUN_LIMITS, { routes: 3, whatifsPerRoute: 8, engineRuns: 60 });
  lean.budget.engineRuns = 59;
  const last = await executeTool(lean, 'price_route', { route });
  assert.equal(last.caseFile.budget.engineRuns, 60);
  const beyond = await executeTool(last.caseFile, 'price_route', { route });
  assert.equal(firstCode(beyond), 'budget_exceeded');
  assert.equal(beyond.caseFile.budget.engineRuns, 60);
  assert.equal(beyond.caseFile.runLog.length, last.caseFile.runLog.length + 1);
  for (const tool of ['goal_ways', 'suggest_routes', 'balancing_moves', 'run_whatif']) {
    assert.equal(budgetRefusal(last.caseFile, tool, { routeId: 'unchanged' }).refusals[0].path, '/budget/engineRuns');
  }
  const whatifs = clone(base); whatifs.budget.whatifsByRoute.example = 7;
  assert.equal(budgetRefusal(whatifs, 'run_whatif', { routeId: 'example' }), null);
  whatifs.budget.whatifsByRoute.example++;
  assert.equal(budgetRefusal(whatifs, 'run_whatif', { routeId: 'example' }).refusals[0].path, '/budget/whatifsByRoute/example');
  assert.equal(budgetRefusal(whatifs, 'run_whatif', { routeId: 'another' }), null);
  const stories = clone(base); stories.storyDrafts = { first: {}, second: {}, third: {} };
  assert.equal(firstCode(await executeTool(stories, 'submit_story', { story: story('fourth') })), 'budget_exceeded');
  assert.equal(budgetRefusal(stories, 'submit_story', { story: story('first') }), null);
  assert.equal(budgetRefusal(stories, 'submit_story', { story: story('current') }), null);

  const local = await createLocalCase(options(leanFixture, 'harness'));
  const directory = local.directory;
  assert.equal((await stat(join(directory, 'case.json'))).mode & 0o777, 0o600);
  await assert.rejects(createLocalCase(options(leanFixture, 'harness')), /EEXIST/);
  await assert.rejects(callLocalTool('/tmp/other-case', 'read_position', {}), /private\/analyses/);
  const inputFile = join(directory, 'input.json');
  transport = new StdioClientTransport({ command: 'npm',
    args: ['run', '--silent', 'analyst:mcp', '--', '--case', directory], cwd: root, stderr: 'pipe' });
  client = new Client({ name: 'analyst-contract-check', version: '1.0.0' });
  await client.connect(transport);
  transport.stderr?.resume();
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(({ name, inputSchema }) => ({ name, inputSchema })), TOOL_CATALOGUE.map(({ name, inputSchema }) => ({ name, inputSchema })));
  for (const tool of [...TOOL_CATALOGUE, { name: 'unknown' }]) {
    const input = tool.name === 'price_route' ? { route } : tool.name === 'submit_story' ? { story: story() } : tool.name === 'goal_ways' ? { goalId: 'goal_application_understand_position' } : {};
    const saved = await readFile(join(directory, 'case.json'), 'utf8');
    await writeFile(inputFile, JSON.stringify(input));
    const cliResult = await cliTool(tool.name, directory, inputFile);
    await writeFile(join(directory, 'case.json'), saved);
    const mcp = await mcpTool(tool.name, input);
    assert.deepEqual(JSON.parse(mcp.content[0].text), cliResult, tool.name + ': real stdio and CLI parity');
    assert.equal(mcp.structuredContent, undefined);
  }
  await writeFile(join(directory, '.lock'), '');
  assert.equal((await callLocalTool(directory, 'price_route', { route })).refusals[0].code, 'case_busy');
  await rm(join(directory, '.lock'));
  const stored = JSON.parse(await readFile(join(directory, 'case.json'), 'utf8'));
  assert.equal(stored.runLog.length, 1 + TOOL_CATALOGUE.length + 1);
  assert.ok(stored.budget.engineRuns > 1 && stored.budget.engineRuns <= 60, 'Both harnesses share one persisted budget');
  const persistedFull = { ...stored, budget: { ...stored.budget, engineRuns: 60 } };
  await writeFile(join(directory, 'case.json'), JSON.stringify(persistedFull));
  assert.equal((await callLocalTool(directory, 'price_route', { route })).refusals[0].code, 'budget_exceeded');
  assert.equal(JSON.parse(await readFile(join(directory, 'case.json'), 'utf8')).budget.engineRuns, 60);
  const tracked = spawnSync('git', ['ls-files', '--', 'private/analyses/'], { cwd: root, encoding: 'utf8' });
  assert.equal(tracked.status, 0); assert.equal(tracked.stdout.trim(), '', 'No analysis path may be tracked');
  assert.equal(spawnSync('git', ['check-ignore', '--quiet', join(directory, 'case.json')], { cwd: root }).status, 0);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['check:consumer'].includes('npm run check:analyst-tools'));
  assert.match(pkg.devDependencies['@modelcontextprotocol/sdk'], /^\d+\.\d+\.\d+$/);
  const wiring = await checkAnalystWiring({ fixtures, options });
  await client.close();
  transport = new StdioClientTransport({ command: 'npm',
    args: ['run', '--silent', 'analyst:mcp', '--', '--case', wiring.directory], cwd: root, stderr: 'pipe' });
  client = new Client({ name: 'analyst-wiring-parity', version: '1.0.0' });
  await client.connect(transport);
  transport.stderr?.resume();
  const wiringInput = join(wiring.directory, 'input.json');
  let replaySeed;
  for (const [name, input] of [
    ['price_route', { route: wiring.route }],
    ['read_position', { routeId: wiring.route.id }],
    ['read_explainers', {}],
    ['balancing_moves', { route: { id: 'harness_size', changes: [] }, type: 'tradeDownHome', year: 2026 }],
    ['goal_ways', { route: { id: 'walk', changes: [] }, goalId: wiring.goalId }],
    ['suggest_routes', {}],
    ['balancing_moves', { route: { id: 'walk', changes: [] } }]
  ]) {
    // Replay the same saved state through each harness, including the available
    // budget for a multi-probe search. Each real call still records its result.
    if (replaySeed) await writeFile(join(wiring.directory, 'case.json'), replaySeed);
    const snapshot = await readFile(join(wiring.directory, 'case.json'), 'utf8');
    await writeFile(wiringInput, JSON.stringify(input));
    const expected = await cliTool(name, wiring.directory, wiringInput);
    assert.equal(expected.ok, true, JSON.stringify(expected.refusals));
    await writeFile(join(wiring.directory, 'case.json'), snapshot);
    const actual = await mcpTool(name, input);
    assert.equal(actual.structuredContent, undefined);
    assert.equal(actual.content.length, 1);
    assert.deepEqual(JSON.parse(actual.content[0].text), expected, 'Native wiring parity: ' + name);
    assert.ok(Buffer.byteLength(actual.content[0].text) < 60_000, name + ': MCP reply exceeds 60 KB');
    if (!replaySeed) replaySeed = await readFile(join(wiring.directory, 'case.json'), 'utf8');
  }
  console.log('[AnalystTools] schemas, confirmed cases, all tools, refusals, budgets, CLI/MCP parity and private paths passed.');
} finally {
  if (client) await client.close();
  else if (transport) await transport.close();
  await rm(join(ANALYSES_ROOT, requestId), { recursive: true, force: true });
  console.info = originalInfo;
}
