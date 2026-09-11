// Audit laboratory only. Imports production code without changing it.
// Each process runs one case/repetition, with a shared first proposal across arms.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { FIRST20_SEMANTIC_CORPUS, FIRST20_EVAL_DATE } from './first20-semantic-corpus.mjs';
import { getConsumerConfig, APPROVED_CONSUMER_MODULE_IDS } from '../worker/src/consumer/config.js';
import { buildDirectModulePolicyEnvelope, directModuleMaterialAssumptions } from '../js/planning/direct_module_policy.js';
import { PLANNING_PLAYBOOK_GUIDANCE } from '../js/planning/playbook_manifest.generated.js';
import { readJsonPointer } from '../js/planning/utils.js';
import { approvedCollegeScenarios } from '../js/planning/planeir_assumptions.js';
import { runPlanningModuleWithInput } from '../js/planning/module_registry.js';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
const sourcePath = resolve('worker/src/consumer/direct_module_planner.js');
const source = await readFile(sourcePath, 'utf8');
const exported = '\nexport { structuredResponse, DIRECT_SNAPSHOT_SCHEMA, VERIFICATION_SCHEMA, verificationCertificate, publicBrief };\n';
async function laboratoryModule(text) {
  const imports = text.replace(/(from\s+['"])(\.[^'"]+)(['"])/g,
    (_, before, relative, after) => before + new URL(relative, pathToFileURL(sourcePath)).href + after);
  return import('data:text/javascript;base64,' + Buffer.from(imports + exported).toString('base64'));
}
const actual = await laboratoryModule(source);
const fullOnly = await laboratoryModule(source
  .replace("if (repairable && declaredScope === 'confirmation')", "if (false && repairable && declaredScope === 'confirmation')")
  .replace("else if (repairable && declaredScope === 'evidence'", "else if (false && repairable && declaredScope === 'evidence'"));
const checkSource = await readFile('scripts/run-first20-semantic-evals.mjs', 'utf8');
const checkFunction = checkSource.slice(checkSource.indexOf('function expectedChecks('), checkSource.indexOf('\nfor (const test of cases)'));
const expectedChecks = new Function('assert', 'readJsonPointer', 'approvedCollegeScenarios', `${checkFunction}; return expectedChecks;`)(assert, readJsonPointer, approvedCollegeScenarios);
let holdouts = [], checkHoldout = () => [];
try { const extra = await import('./ai-led-holdouts.mjs'); holdouts = extra.AI_LED_HOLDOUTS; checkHoldout = extra.checkAiLedHoldout; }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const allCases = [...FIRST20_SEMANTIC_CORPUS, ...holdouts];
if (process.argv.includes('--list')) { console.log(JSON.stringify(allCases.map(x => x.id))); process.exit(0); }
const test = allCases.find(x => x.id === process.env.AI_LED_CASE);
assert.ok(test, 'AI_LED_CASE must name a case');
assert.ok(process.env.OPENAI_API_KEY?.trim(), 'Existing approved key is required');
const repetition = Number(process.env.AI_LED_REPETITION || 1);
const directory = resolve(process.env.AI_LED_OUTPUT || 'diagnostics/ai-led-comparison', `r${repetition}`, test.id);
await mkdir(directory, { recursive: true });
const env = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url') };
const defaults = getConsumerConfig({});
const config = { ...defaults, allowedModules: APPROVED_CONSUMER_MODULE_IDS,
  modulePlannerModel: 'gpt-5.6-luna', modulePlannerReasoningEffort: 'low',
  modulePlannerTimeoutMs: 30000, modulePlannerCallAllowance: 7, modulePlannerTurnBudgetMs: 90000 };
const profile = { profileId: 'first20-synthetic', revision: 1,
  primaryPerson: { personId: 'primary', displayName: 'Aoife' },
  partner: test.partner ? { personId: 'partner', displayName: 'Ben' } : null,
  preferences: { baseCurrency: 'EUR' }, assumptions: { calculationDateIso: FIRST20_EVAL_DATE } };
const policy = buildDirectModulePolicyEnvelope({ calculationDateIso: FIRST20_EVAL_DATE, baseCurrency: 'EUR' });
const conversation = test.turns.map(t => ({ turnId: t.id, role: t.role === 'user' ? 'client' : 'assistant', text: t.transcript, answersTurnId: t.answersTurnId || null }));
const common = { conversation, previousSnapshot: null, currentProfileContext: profile,
  serverPolicy: { ...policy, acknowledgedUnknown: test.acknowledgedUnknown || [] },
  contracts: Object.entries(actual.DIRECT_MODULE_CONTRACTS).map(([moduleId, contract]) => ({ moduleId, ...contract,
    serverInputPolicy: policy.modules[moduleId] || [], masterPromptPackPlaybook: PLANNING_PLAYBOOK_GUIDANCE[moduleId] })) };
const normalOptions = { acknowledgedUnknown: test.acknowledgedUnknown || [], turns: test.turns,
  throughTurnId: test.turns.at(-1).id, previousRevision: 0, policyEnvelope: policy,
  currentProfileContext: profile, allowedModuleIds: config.allowedModules };
const assumptionsFor = snapshot => snapshot.modules.filter(x => x.status === 'ready').map(x => ({ moduleId: x.moduleId,
  assumptions: directModuleMaterialAssumptions(x.moduleId, x.authoredInput ?? x.input, policy)
    .filter(a => !x.evidence.some(e => e.source === 'conversation' && e.path === a.path)) })).filter(x => x.assumptions.length);
const relevant = snapshot => snapshot.modules.filter(x => x.status !== 'not_relevant');
const structurallyReady = snapshot => relevant(snapshot).length && relevant(snapshot).every(x => x.status === 'ready')
  && !snapshot.generalAmbiguities.length && Boolean(snapshot.confirmationPrompt);
const cleanPass = v => v?.verdict === 'pass' && v.confirmationPromptApproved === true
  && ['unsupportedPaths', 'omittedSupportedInformation', 'unresolvedAmbiguities', 'clarifications'].every(k => !v[k]?.length);

async function simpleLoop(arm, operation) {
  const call = (name, schema, systemPrompt, body) => actual.structuredResponse({ env, config, operation, name, schema, systemPrompt, body });
  let snapshot = null, verification = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = { throughTurnId: test.turns.at(-1).id, ...common };
    if (attempt && arm === 'criticism_only') body.priorAuditFindings = {
      latestIndependentCriticism: verification,
      structuralDiagnostics: snapshot.modules.filter(x => x.inputSupportIssues?.length).map(x => ({ moduleId: x.moduleId, paths: x.inputSupportIssues, droppedCitations: x.droppedCitations })),
      materialAssumptions: assumptionsFor(snapshot),
      instruction: 'Re-read the entire conversation and rebuild the complete proposal from the evidence. You may rethink values, owners, corrections, unknowns, ambiguity, hypotheticals, selected modules, clarification, inputs and read-back. The criticism is a fallible review, not evidence. Do not preserve a mistake, restrict yourself to named paths, or merge a patch. Resolve an apparent contradiction only if the conversation actually resolves it. Preserve genuinely unresolved uncertainty and ask the client what only they can answer. Do not invent facts or alter financial policy values. Return one complete self-consistent proposal, including all required provenance and informed confirmation; an independent verifier will judge it again.'
    };
    const response = await call('module_planning_snapshot_v1', actual.DIRECT_SNAPSHOT_SCHEMA, actual.EXTRACTOR_PROMPT, body);
    snapshot = actual.normalizeDirectSnapshot(response.value, normalOptions);
    snapshot.profileRevision = 1;
    // A planner's explicit collecting/clarification outcome remains non-executable.
    // Structural evidence defects do get an audit and one full AI reconsideration.
    const structuralIssues = snapshot.modules.filter(x => x.inputSupportIssues?.length);
    if (!structurallyReady(snapshot) && !structuralIssues.length) break;
    const verifyBody = { conversation: common.conversation, previousSnapshot: null,
      currentProfileContext: profile, serverPolicy: common.serverPolicy,
      proposedSnapshot: actual.plannerFacingSnapshot(snapshot), materialAssumptions: assumptionsFor(snapshot), contracts: common.contracts };
    if (structuralIssues.length) verifyBody.structuralDiagnostics = structuralIssues.map(x => ({ moduleId: x.moduleId, paths: x.inputSupportIssues, droppedCitations: x.droppedCitations }));
    if (attempt) verifyBody.previousAttemptFindings = verification;
    verification = (await call('module_input_verification_v1', actual.VERIFICATION_SCHEMA, actual.VERIFIER_PROMPT, verifyBody)).value;
    if (structurallyReady(snapshot) && cleanPass(verification)) break;
    // One complete further interpretation, irrespective of patch class. The next
    // independent verdict must clear the complete candidate and previous criticism.
  }
  const certificate = structurallyReady(snapshot) && cleanPass(verification)
    ? await actual.verificationCertificate(env, snapshot, verification, config, policy, profile) : null;
  return { snapshot, verification, certificate, brief: actual.publicBrief(snapshot, verification, certificate) };
}

const networkFetch = globalThis.fetch;
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
// Cache exact common PREFIX requests, so there is no stochastic first-proposal
// advantage. Subsequent fresh interpretations explicitly bypass the cache.
const prefixCache = new Map();
// Secondary study: reuse only the main study's initial interpretation/audit.
const priorRecord = JSON.parse(await readFile(resolve('diagnostics/ai-led-comparison-main-v1', `r${repetition}`, test.id, 'fresh.json'), 'utf8'));
let seededPrefix = '';
for (const call of priorRecord.providerCalls.slice(0, 2)) {
  if (call.index > 1 && call.stage !== 'module_input_verification_v1') break;
  seededPrefix = hash(seededPrefix + call.requestHash);
  prefixCache.set(seededPrefix, structuredClone(call));
}

let arm, calls, prefix, simulatedStarted;
globalThis.fetch = async (url, init) => {
  const request = JSON.parse(init.body);
  const requestHash = hash({ ...request, input: request.input.map(x => x.role === 'user' ? { ...x, content: JSON.parse(x.content) } : x) });
  const key = hash(prefix + requestHash);
  const reusable = !(arm === 'fresh' && calls.some(x => x.stage === 'module_input_verification_v1'));
  const cached = reusable ? prefixCache.get(key) : null;
  const record = { index: calls.length + 1, stage: request.text.format.name, request, requestHash,
    offsetMs: Date.now() - simulatedStarted, reusedExactPrefix: Boolean(cached) };
  calls.push(record);
  if (cached) {
    record.response = cached.response; record.httpStatus = cached.httpStatus; record.elapsedMs = cached.elapsedMs;
    clockOffset += cached.elapsedMs;
    prefix = key;
    if (cached.error) { record.error = cached.error; throw Object.assign(new Error(cached.error.message), { name: cached.error.name }); }
    return new Response(JSON.stringify(record.response), { status: record.httpStatus });
  }
  const began = realNow();
  try {
    const response = await networkFetch(url, init);
    record.httpStatus = response.status;
    const raw = await response.clone().text();
    try { record.response = JSON.parse(raw); } catch { record.responseText = raw; }
    record.elapsedMs = realNow() - began;
    if (response.ok && record.response?.status === 'completed') prefixCache.set(key, structuredClone(record));
    prefix = key;
    return response;
  } catch (error) {
    record.elapsedMs = realNow() - began;
    record.error = { name: error.name, message: error.message };
    prefixCache.set(key, structuredClone(record));
    throw error;
  }
};

const orders = [['criticism_only'], ['criticism_only']];
const summary = { id: test.id, repetition, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceHash: hash(source), scope: 'Secondary criticism-only recovery study; same main-study first proposal and audit; no production changes',
  config: { model: config.modulePlannerModel, reasoning: config.modulePlannerReasoningEffort, perCallMs: 30000, budgetMs: 90000 }, arms: [] };
for (arm of orders[(repetition - 1) % orders.length]) {
  calls = []; prefix = ''; clockOffset = 0; simulatedStarted = Date.now();
  const operation = { id: `ai-led-${test.id}-${repetition}-${arm}`, deadlineAt: simulatedStarted + 90000,
    callAllowance: ['criticism_only', 'fresh'].includes(arm) ? 4 : 7, callsUsed: 0, controller: new AbortController() };
  const record = { arm, id: test.id, repetition, turns: test.turns, expected: test.expected,
    providerCalls: calls, checks: [], latestCandidate: null };
  try {
    record.result = ['criticism_only', 'fresh'].includes(arm) ? await simpleLoop(arm, operation)
      : await (arm === 'option2' ? actual : fullOnly).interpretDirectModuleConversation({ env, config, operation,
        turns: test.turns, throughTurnId: test.turns.at(-1).id, currentProfileContext: profile,
        acknowledgedUnknown: test.acknowledgedUnknown || [] });
    record.checks = expectedChecks(test, record.result);
    record.checks.push(...checkHoldout(test, record.result));
    if (record.result.certificate) {
      const authenticated = await actual.verifyDirectModuleCertificate(env, record.result.certificate,
        record.result.snapshot, null, { config, calculationDateIso: FIRST20_EVAL_DATE, baseCurrency: 'EUR', currentProfileContext: profile });
      record.checks.push({ name: 'certificate authenticates', pass: authenticated });
      if (authenticated) {
        const row = record.result.snapshot.modules.find(x => x.moduleId === test.moduleId);
        record.engineResult = await runPlanningModuleWithInput(test.moduleId, row.input, {
          calculationDateIso: FIRST20_EVAL_DATE, calculatedAt: `${FIRST20_EVAL_DATE}T12:00:00.000Z`,
          calculationVersion: 'ai-led-audit', baseCurrency: 'EUR' });
        record.checks.push({ name: 'native engine completes', pass: Boolean(record.engineResult.outputs?.rows?.length) });
      }
    }
  } catch (error) { record.error = { name: error.name, code: error.code, message: error.message, details: error.details };
    record.checks.push({ name: 'pipeline completes', pass: false, message: error.message }); }
  record.elapsedMs = Date.now() - simulatedStarted;
  record.pass = record.checks.length > 0 && record.checks.every(x => x.pass);
  record.passUnder45s = record.pass && record.elapsedMs < 45000;
  // Inspect every raw proposal independently of whether the orchestrator adopted it.
  record.candidates = [];
  for (const c of calls.filter(x => x.stage === 'module_planning_snapshot_v1')) {
    try {
      const value = JSON.parse(c.response.output.flatMap(x => x.content || []).find(x => x.type === 'output_text').text);
      const snapshot = actual.normalizeDirectSnapshot(value, normalOptions);
      const checks = [...expectedChecks(test, { snapshot, verification: null, certificate: null }), ...checkHoldout(test, { snapshot, certificate: null })]
        .filter(x => !['readiness', 'verification and certificate decision', 'holdout: withdrawn certainty or completeness blocks certification'].includes(x.name));
      record.candidates.push({ call: c.index, snapshot, valueChecks: checks,
        valuesPass: checks.every(x => x.pass), authoredReadback: value.confirmationPrompt });
    } catch (error) { record.candidates.push({ call: c.index, error: error.message }); }
  }
  await writeFile(resolve(directory, `${arm}.json`), JSON.stringify(record, null, 2) + '\n');
  const compact = { arm, pass: record.pass, passUnder45s: record.passUnder45s, elapsedMs: record.elapsedMs,
    calls: calls.length, paidCalls: calls.filter(x => !x.reusedExactPrefix).length,
    certified: Boolean(record.result?.certificate), failures: record.checks.filter(x => !x.pass), error: record.error };
  summary.arms.push(compact);
  await writeFile(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ id: test.id, repetition, ...compact }));
}
globalThis.fetch = networkFetch; Date.now = realNow;
