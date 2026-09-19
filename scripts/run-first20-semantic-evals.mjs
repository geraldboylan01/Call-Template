#!/usr/bin/env node
// Paid, synthetic transcript evaluation. Does not create a consumer session.
// FIRST20_SOURCE_ROOT chooses baseline/current code; expectations always come
// from this versioned corpus and are never included in a provider request.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIRST20_SEMANTIC_CORPUS, FIRST20_EVAL_DATE } from './first20-semantic-corpus.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(process.env.FIRST20_SOURCE_ROOT || workspace);
const load = (path) => import(pathToFileURL(resolve(sourceRoot, path)).href);
const [{ interpretDirectModuleConversation, verifyDirectModuleCertificate },
  { APPROVED_CONSUMER_MODULE_IDS, getConsumerConfig }, { runPlanningModuleWithInput }, { readJsonPointer },
  { approvedCollegeScenarios }] = await Promise.all([
  load('worker/src/consumer/direct_module_planner.js'), load('worker/src/consumer/config.js'),
  load('js/planning/module_registry.js'), load('js/planning/utils.js'), load('js/planning/planeir_assumptions.js')
]);
const selected = new Set((process.env.FIRST20_CASES || '').split(',').filter(Boolean));
const cases = FIRST20_SEMANTIC_CORPUS.filter((item) => !selected.size || selected.has(item.id));
assert.ok(cases.length, 'FIRST20_CASES did not select any corpus cases');
for (const id of selected) assert.ok(cases.some((item) => item.id === id), `Unknown case: ${id}`);
if (process.argv.includes('--list')) {
  console.info(JSON.stringify(cases.map(({ id, moduleId, ready }) => ({ id, moduleId, ready })), null, 2));
  process.exit(0);
}
if (!String(process.env.OPENAI_API_KEY || '').trim()) {
  console.error('OPENAI_API_KEY is required for this paid synthetic semantic eval.');
  process.exit(2);
}
const env = { OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url') };
const sourceConfig = getConsumerConfig({});
const config = {
  allowedModules: APPROVED_CONSUMER_MODULE_IDS,
  modulePlannerModel: process.env.CONSUMER_MODULE_PLANNER_MODEL || 'gpt-5.6-luna',
  modulePlannerReasoningEffort: process.env.CONSUMER_MODULE_PLANNER_REASONING_EFFORT || 'low',
  modulePlannerTimeoutMs: Number(process.env.FIRST20_TIMEOUT_MS || sourceConfig.modulePlannerTimeoutMs),
  modulePlannerPromptVersion: sourceConfig.modulePlannerPromptVersion,
  moduleVerifierPromptVersion: sourceConfig.moduleVerifierPromptVersion,
  modulePlannerRepairFloorMs: sourceConfig.modulePlannerRepairFloorMs,
  modulePlannerCallAllowance: sourceConfig.modulePlannerCallAllowance
};
// THE SAME OPERATION PRODUCTION RUNS UNDER.
//
// This runner never supplied one, so every earlier result -- mine included --
// measured an UNBOUNDED planner and was reported as if it were production
// behaviour. It is not: under the real budget the adaptive repair floor can
// refuse the second repair outright, so a case that passes here on five calls
// may never get five in a live turn. Set FIRST20_TURN_BUDGET_MS=0 to measure
// the unbounded planner deliberately.
const turnBudgetMs = Number(
  process.env.FIRST20_TURN_BUDGET_MS ?? sourceConfig.modulePlannerTurnBudgetMs ?? 90_000
);
const newOperation = () => (turnBudgetMs > 0 ? {
  id: `first20-${Math.random().toString(36).slice(2, 10)}`,
  deadlineAt: Date.now() + turnBudgetMs,
  callAllowance: Number(sourceConfig.modulePlannerCallAllowance || 5),
  callsUsed: 0,
  controller: new AbortController()
} : null);
const outputDir = resolve(process.env.FIRST20_OUTPUT_DIR || resolve(workspace,
  'diagnostics/first20/semantic', new Date().toISOString().replaceAll(':', '-')));
await mkdir(outputDir, { recursive: true });
const summary = { startedAt: new Date().toISOString(), sourceRoot, calculationDateIso: FIRST20_EVAL_DATE,
  config, syntheticOnly: true, scope: 'Shared semantic interpreter, verification, certificate and native engine; not audio/browser transport', cases: [] };
const originalFetch = globalThis.fetch;

function expectedChecks(test, result) {
  const checks = [];
  const check = (name, work) => {
    try { work(); checks.push({ name, pass: true }); }
    catch (error) { checks.push({ name, pass: false, message: error.message }); }
  };
  const snapshot = result.snapshot;
  const module = snapshot?.modules?.find((item) => item.moduleId === test.moduleId);
  const input = module?.input || {};
  check('exact selected module and client intent', () => {
    assert.deepEqual(snapshot.modules.filter((item) => item.status !== 'not_relevant').map((item) => item.moduleId), [test.moduleId]);
    assert.equal(module.selection.origin, 'client_requested');
  });
  check('readiness', () => test.ready ? assert.equal(module?.status, 'ready')
    : assert.ok(['collecting', 'needs_clarification'].includes(module?.status)));
  for (const [path, value] of Object.entries(test.expected.values || {})) {
    check(`input /${path}`, () => assert.deepEqual(readJsonPointer(input, `/${path}`), value));
  }
  if (test.expected.assets) {
    check('distinct assets, owners, corrected amounts and no hypothetical inheritance', () => {
      assert.equal(input.assetPositions.length, test.expected.assets.length);
      for (const expected of test.expected.assets) {
        const matching = input.assetPositions.filter((item) => item.amount === expected.amount && item.bucket === expected.bucket);
        assert.equal(matching.length, 1, `Expected exactly one ${expected.bucket} asset of ${expected.amount}`);
        if (expected.owner) assert.ok(matching[0].label.toLowerCase().includes(expected.owner.toLowerCase()), `Missing owner ${expected.owner}`);
      }
      assert.equal(new Set(input.assetPositions.map((item) => `${item.source}:${item.id}`)).size, input.assetPositions.length);
      assert.deepEqual(input.liabilityPositions.map((item) => item.amount), test.expected.liabilities);
      assert.equal(input.monthlyExpenditure, test.expected.monthlyExpenditure);
    });
  }
  for (const key of ['children', 'pensions']) if (test.expected[key]) {
    check(`distinct ${key} and owner-specific corrections`, () => {
      assert.equal(input[key].length, test.expected[key].length);
      assert.equal(new Set(input[key].map((item) => item.id)).size, input[key].length);
      for (const expected of test.expected[key]) {
        const actual = input[key].find((item) => item.title.toLowerCase() === expected.title.toLowerCase());
        assert.ok(actual, `Missing ${expected.title}`);
        for (const [field, value] of Object.entries(expected)) if (field !== 'title') assert.deepEqual(actual[field], value, `${expected.title}.${field}`);
      }
    });
  }
  if (test.expected.pensions) check('retirement income collection and State Pension assumptions', () => {
    assert.deepEqual(input.otherIncomeSources, []);
    assert.equal(input.horizonEndAge, 100);
    for (const pension of input.pensions) {
      assert.equal(pension.includeStatePension, true);
      assert.equal(pension.statePensionFraction, 1);
      assert.equal(pension.statePensionStartAge, 66);
    }
  });
  if (test.expected.children) check('all standard scenarios remain available', () => {
    assert.deepEqual(input.scenarios.map((item) => item.id).sort(), approvedCollegeScenarios().map((item) => item.id).sort());
    for (const child of input.children) assert.ok(!child.scenarioId, 'An unknown living arrangement must not choose a scenario');
  });
  if (test.expected.applicants) check('joint applicant identity and separate cash ownership', () => {
    assert.equal(input.applicants.length, test.expected.applicants.length);
    assert.equal(input.cashSavingsContributions.length, test.expected.applicants.length);
    assert.equal(new Set(input.applicants.map((item) => item.id)).size, input.applicants.length);
    for (const expected of test.expected.applicants) {
      const actual = input.applicants.find((item) => item.label.toLowerCase() === expected.label.toLowerCase());
      assert.ok(actual, `Missing ${expected.label}`);
      assert.equal(actual.age, expected.age);
      assert.equal(actual.grossAnnualIncome, expected.grossAnnualIncome);
      assert.equal(input.cashSavingsContributions.find((item) => item.ownerId === actual.id)?.amount, expected.cash);
    }
  });
  if (test.unknownPath) check('uncertain rate remains unknown', () => assert.ok(readJsonPointer(input, test.unknownPath) == null));
  if (test.acknowledgedUnknown && !test.resolved) check('acknowledged unknown blocks without repeating a question', () => {
    assert.ok(module.blocked.some((item) => item.path === test.unknownPath && !item.covered));
    assert.ok(!module.missing.some((item) => item.path === test.unknownPath));
    assert.ok(!module.ambiguities.some((item) => item.relatedPaths?.includes(test.unknownPath)));
  });
  if (test.resolved) check('later confident answer explicitly resolves its earlier acknowledgement', () => {
    assert.deepEqual(snapshot.resolvedAcknowledgedUnknown, [{ moduleId: test.moduleId, path: test.resolved, sourceTurnId: 'c2', turnId: 'c3' }]);
    assert.deepEqual(module.blocked, []);
  });
  check('verification and certificate decision', () => {
    if (test.ready) {
      assert.equal(result.verification?.verdict, 'pass');
      assert.equal(result.verification.confirmationPromptApproved, true);
      assert.ok(result.certificate?.signature);
      assert.ok(snapshot.confirmationPrompt.trim());
    } else assert.equal(result.certificate, null);
  });
  return checks;
}

for (const test of cases) {
  const began = Date.now();
  const providerCalls = [];
  const record = { id: test.id, moduleId: test.moduleId, expectedReady: test.ready, turns: test.turns,
    expected: test.expected, acknowledgedUnknown: test.acknowledgedUnknown || [], providerCalls, checks: [] };
  // Capture response payloads before interpretation/assertions so failed schema,
  // readiness and repair paths remain diagnosable. No request headers/keys saved.
  globalThis.fetch = async (...args) => {
    const start = Date.now();
    const call = { index: providerCalls.length + 1 };
    providerCalls.push(call);
    try {
      const response = await originalFetch(...args);
      call.httpStatus = response.status;
      const raw = await response.clone().text();
      try { call.response = JSON.parse(raw); } catch { call.responseText = raw; }
      call.elapsedMs = Date.now() - start;
      return response;
    } catch (error) {
      call.error = { name: error.name, message: error.message };
      call.elapsedMs = Date.now() - start;
      throw error;
    }
  };
  const profile = { profileId: 'first20-synthetic', revision: 1,
    primaryPerson: { personId: 'primary', displayName: 'Aoife' },
    partner: test.partner ? { personId: 'partner', displayName: 'Ben' } : null,
    preferences: { baseCurrency: 'EUR' }, assumptions: { calculationDateIso: FIRST20_EVAL_DATE } };
  try {
    const operation = newOperation();
    record.operation = operation && { turnBudgetMs, callAllowance: operation.callAllowance };
    record.result = await interpretDirectModuleConversation({ env, config, operation, turns: test.turns,
      throughTurnId: test.turns.at(-1).id, currentProfileContext: profile,
      acknowledgedUnknown: test.acknowledgedUnknown || [] });
    record.checks = expectedChecks(test, record.result);
    if (test.ready) {
      const authenticated = await verifyDirectModuleCertificate(env, record.result.certificate,
        record.result.snapshot, null, { config, calculationDateIso: FIRST20_EVAL_DATE,
          baseCurrency: 'EUR', currentProfileContext: profile });
      record.checks.push({ name: 'certificate authenticates against current policy, profile and inputs', pass: authenticated });
      if (authenticated) {
        const module = record.result.snapshot.modules.find((item) => item.moduleId === test.moduleId);
        record.engineResult = await runPlanningModuleWithInput(test.moduleId, module.input, {
          calculationDateIso: FIRST20_EVAL_DATE, calculatedAt: `${FIRST20_EVAL_DATE}T12:00:00.000Z`,
          calculationVersion: 'first20-semantic-eval-v1', baseCurrency: 'EUR' });
        assert.equal(record.engineResult.moduleId, test.moduleId);
        assert.ok(record.engineResult.inputSnapshotHash);
        assert.ok(record.engineResult.outputs?.rows?.length);
        if (test.moduleId === 'personal_balance_sheet') assert.equal(record.engineResult.semanticResult.netWorth, 530000);
        if (test.moduleId === 'liquidity_analysis') assert.equal(record.engineResult.semanticResult.monthsCovered, 33000 / 3200);
        record.checks.push({ name: 'native engine completes with populated results', pass: true });
      } else record.checks.push({ name: 'native engine completes with populated results', pass: false, message: 'No authenticated plan; engine execution refused' });
    }
  } catch (error) {
    record.error = { name: error.name, code: error.code, message: error.message, details: error.details };
    record.checks.push({ name: 'pipeline completes without error', pass: false, message: error.message });
  } finally { globalThis.fetch = originalFetch; }
  record.elapsedMs = Date.now() - began;
  record.pass = record.checks.length > 0 && record.checks.every((item) => item.pass);
  await writeFile(resolve(outputDir, `${test.id}.json`), JSON.stringify(record, null, 2) + '\n');
  const compact = { id: test.id, moduleId: test.moduleId, pass: record.pass, elapsedMs: record.elapsedMs,
    providerCalls: providerCalls.length, failures: record.checks.filter((item) => !item.pass) };
  summary.cases.push(compact);
  await writeFile(resolve(outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.info(JSON.stringify(compact));
}
summary.finishedAt = new Date().toISOString();
summary.pass = summary.cases.every((item) => item.pass);
await writeFile(resolve(outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.info(JSON.stringify({ pass: summary.pass, count: summary.cases.length, outputDir }));
if (!summary.pass) process.exitCode = 1;
