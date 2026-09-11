// Audit laboratory only. Imports production code without changing it.
//
// ADVERSARIAL VARIANT. The natural corpus mostly gets its first interpretation
// right, so these cases inject an identical structurally valid but SEMANTICALLY
// WRONG first proposal -- a hypothetical rate promoted to fact, a superseded
// borrower restored, stale owners behind equal balances, forced readiness after
// a withdrawn rate. Every quoted source turn is authentic; the real independent
// verifier has to judge the meaning. These are fault-injection tests, not
// natural-sample observations and not latency claims.
//
// TWO ARMS: the Option 2 recovery ladder exactly as committed, and the
// simplified one-revision loop in the working tree. Each process runs one
// case/repetition, with a shared first proposal across both arms.
//
// WHY THE FIRST PROPOSAL CAN STILL BE SHARED ACROSS A SCHEMA CHANGE. The
// simplified loop stops asking the model to author `baseSnapshotRevision` and
// `throughTurnId`, so the two arms would otherwise send a different output
// SCHEMA for an identical first request -- and the whole value of this
// comparison is that both arms reason from the same first reading.
//
// So the FIRST extractor call of every arm is sent under Option 2's wider
// schema. The first request is then byte-identical in both arms, the prefix
// cache pairs them exactly, and the comparison is symmetric under the arm-order
// reversal the protocol requires.
//
// THIS IS NOT A HANDICAP TO EITHER ARM, AND IT DOES NOT HIDE THE FIX. The
// shared response carries the two server-owned fields; Option 2 must echo them
// correctly or it fails, and the simplified normalizer ignores them and binds
// its own from the request. When the model gets one wrong -- which is the
// defect this change removes -- that shows up here as exactly what it is: one
// arm losing a correct proposal to bookkeeping, the other not.
//
// AN EARLIER VERSION KEYED THE CACHE WITHOUT THE SCHEMA INSTEAD, and it was
// wrong. In the reversed repetition the simplified arm ran first and cached a
// NARROW-shaped response, which Option 2's normalizer then rejected outright:
// all seventeen of its cases failed with module_snapshot_watermark_mismatch.
// That was a harness artefact scoring the benchmark at zero, not a measurement.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { FIRST20_SEMANTIC_CORPUS, FIRST20_EVAL_DATE } from './first20-semantic-corpus.mjs';
import { getConsumerConfig, APPROVED_CONSUMER_MODULE_IDS } from '../worker/src/consumer/config.js';
import { buildDirectModulePolicyEnvelope } from '../js/planning/direct_module_policy.js';
import { PLANNING_PLAYBOOK_GUIDANCE } from '../js/planning/playbook_manifest.generated.js';
import { readJsonPointer } from '../js/planning/utils.js';
import { approvedCollegeScenarios } from '../js/planning/planeir_assumptions.js';
import { runPlanningModuleWithInput } from '../js/planning/module_registry.js';
import { AI_LED_HOLDOUTS, checkAiLedHoldout } from './ai-led-holdouts.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
const sourcePath = resolve('worker/src/consumer/direct_module_planner.js');
const workingSource = await readFile(sourcePath, 'utf8');
// The committed Option 2 interpreter, read from git rather than the tree, so
// the benchmark cannot drift as the candidate is edited.
//
// PINNED TO THE COMMIT, NOT TO HEAD. This defaulted to HEAD, which was right
// exactly once -- while the candidate was uncommitted work on top of 30eab9e.
// The moment the candidate was committed, HEAD became the candidate, and a
// clean checkout would have loaded the SAME source into both arms and reported
// a flawless dead heat. That is the worst shape a measurement bug can take: it
// does not fail, it agrees with you.
//
// 30eab9e is "Let the auditor say what a repair may touch, and re-author only
// if that fails" -- the last commit before the simplified loop, and the Option 2
// implementation every previously reported benchmark figure was measured
// against. Override with AI_LED_BENCHMARK_REF to compare against something else.
const OPTION_2_COMMIT = '30eab9eb9c0737726c9a392ef1805f347aa3b10f';
const benchmarkCommit = process.env.AI_LED_BENCHMARK_REF || OPTION_2_COMMIT;
const benchmarkSource = execFileSync('git',
  ['show', `${benchmarkCommit}:worker/src/consumer/direct_module_planner.js`], { encoding: 'utf8' });
const exported = '\nexport { structuredResponse, DIRECT_SNAPSHOT_SCHEMA, VERIFICATION_SCHEMA, verificationCertificate, publicBrief };\n';
async function laboratoryModule(text) {
  const imports = text.replace(/(from\s+['"])(\.[^'"]+)(['"])/g,
    (_, before, relative, after) => before + new URL(relative, pathToFileURL(sourcePath)).href + after);
  return import('data:text/javascript;base64,' + Buffer.from(imports + exported).toString('base64'));
}
const simplified = await laboratoryModule(workingSource);
const option2 = await laboratoryModule(benchmarkSource);
const ARMS = {
  // The committed recovery ladder: structural repair, narrow confirmation or
  // evidence patch, then an unconditional full re-author. Seven-call allowance.
  option2: { module: option2, callAllowance: 7 },
  // One proposal, one independent audit, one revision in the form that audit
  // chose, and the fresh audit that must approve it.
  simplified: { module: simplified, callAllowance: 4 }
};

const checkSource = await readFile('scripts/run-first20-semantic-evals.mjs', 'utf8');
const checkFunction = checkSource.slice(checkSource.indexOf('function expectedChecks('), checkSource.indexOf('\nfor (const test of cases)'));
const expectedChecks = new Function('assert', 'readJsonPointer', 'approvedCollegeScenarios', `${checkFunction}; return expectedChecks;`)(assert, readJsonPointer, approvedCollegeScenarios);
// The five holdouts are imported at the top, as a HARD dependency: they used to
// be optional, so a checkout without them ran 12 cases instead of 17 and
// reported the total as though it were the whole corpus. A missing fixture must
// stop the run, not shrink it.
const allCases = [...FIRST20_SEMANTIC_CORPUS, ...AI_LED_HOLDOUTS];
const checkHoldout = checkAiLedHoldout;
if (process.argv.includes('--list')) { console.log(JSON.stringify(allCases.map(x => x.id))); process.exit(0); }
const seed = JSON.parse(await readFile(process.env.AI_LED_SEED, 'utf8'));
const test = allCases.find(x => x.id === seed.originalCaseId);
assert.ok(test, 'the seed manifest must name a corpus case');
assert.ok(process.env.OPENAI_API_KEY?.trim(), 'Existing approved key is required');
const repetition = Number(process.env.AI_LED_REPETITION || 1);
const directory = resolve(process.env.AI_LED_OUTPUT || 'diagnostics/ai-led-simplified-seeded', `r${repetition}`, seed.id);
await mkdir(directory, { recursive: true });
const env = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url') };
const defaults = getConsumerConfig({});
const config = { ...defaults, allowedModules: APPROVED_CONSUMER_MODULE_IDS,
  modulePlannerModel: 'gpt-5.6-luna', modulePlannerReasoningEffort: 'low',
  modulePlannerTimeoutMs: 30000, modulePlannerTurnBudgetMs: 90000 };
const profile = { profileId: 'first20-synthetic', revision: 1,
  primaryPerson: { personId: 'primary', displayName: 'Aoife' },
  partner: test.partner ? { personId: 'partner', displayName: 'Ben' } : null,
  preferences: { baseCurrency: 'EUR' }, assumptions: { calculationDateIso: FIRST20_EVAL_DATE } };

const networkFetch = globalThis.fetch;
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
// Cache exact common PREFIX requests, so there is no stochastic first-proposal
// advantage between the arms.
const prefixCache = new Map();
let arm, calls, prefix, simulatedStarted;
globalThis.fetch = async (url, init) => {
  let request = JSON.parse(init.body);
  // See the header: the shared first proposal is authored under the benchmark's
  // wider schema in BOTH arms, so this request is byte-identical either way.
  if (calls.length === 0 && request.text?.format?.name === 'module_planning_snapshot_v1') {
    request = { ...request, text: { ...request.text,
      format: { ...request.text.format, schema: option2.DIRECT_SNAPSHOT_SCHEMA } } };
    init = { ...init, body: JSON.stringify(request) };
  }
  const requestHash = hash({ ...request, input: request.input.map(x => x.role === 'user' ? { ...x, content: JSON.parse(x.content) } : x) });
  const key = hash(prefix + requestHash);
  const cached = prefixCache.get(key);
  const record = { index: calls.length + 1, stage: request.text.format.name, request, requestHash,
    offsetMs: Date.now() - simulatedStarted, reusedExactPrefix: Boolean(cached) };
  calls.push(record);
  // THE INJECTED FIRST PROPOSAL. Structurally valid, semantically wrong, and
  // identical for both arms: the real independent verifier has to judge its
  // meaning. It costs no tokens and no time, so it makes no latency claim.
  if (record.index === 1) {
    record.synthetic = true;
    record.response = { id: `audit-injected-${seed.id}`, status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(seed.seededProposal) }] }],
      usage: { input_tokens: 0, output_tokens: 0 } };
    record.httpStatus = 200; record.elapsedMs = 0; prefix = key;
    return new Response(JSON.stringify(record.response), { status: 200 });
  }
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

const orders = [['option2', 'simplified'], ['simplified', 'option2']];
const summary = { id: seed.id, originalCaseId: test.id, injectedManifest: seed.manifest, repetition, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  benchmarkSourceHash: hash(benchmarkSource), candidateSourceHash: hash(workingSource),
  scope: 'Injected incorrect first proposal; real independent verifier and recovery; zero latency/tokens for the synthetic first proposal; no production changes',
  config: { model: config.modulePlannerModel, reasoning: config.modulePlannerReasoningEffort, perCallMs: 30000, budgetMs: 90000 },
  arms: [] };
for (arm of orders[(repetition - 1) % orders.length]) {
  const { module: planner, callAllowance } = ARMS[arm];
  calls = []; prefix = ''; clockOffset = 0; simulatedStarted = Date.now();
  const operation = { id: `ai-led-${test.id}-${repetition}-${arm}`, deadlineAt: simulatedStarted + 90000,
    callAllowance, callsUsed: 0, controller: new AbortController() };
  const record = { arm, id: seed.id, originalCaseId: test.id, repetition, turns: test.turns, expected: test.expected, expectsReady: test.ready !== false,
    callAllowance, providerCalls: calls, checks: [], latestCandidate: null };
  const normalOptions = { acknowledgedUnknown: test.acknowledgedUnknown || [], turns: test.turns,
    throughTurnId: test.turns.at(-1).id, previousRevision: 0,
    policyEnvelope: buildDirectModulePolicyEnvelope({ calculationDateIso: FIRST20_EVAL_DATE, baseCurrency: 'EUR' }),
    currentProfileContext: profile, allowedModuleIds: config.allowedModules };
  try {
    record.result = await planner.interpretDirectModuleConversation({ env,
      config: { ...config, modulePlannerCallAllowance: callAllowance }, operation,
      turns: test.turns, throughTurnId: test.turns.at(-1).id, currentProfileContext: profile,
      acknowledgedUnknown: test.acknowledgedUnknown || [] });
    record.checks = expectedChecks(test, record.result);
    record.checks.push(...checkHoldout(test, record.result));
    if (record.result.certificate) {
      const authenticated = await planner.verifyDirectModuleCertificate(env, record.result.certificate,
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
      const snapshot = planner.normalizeDirectSnapshot(value, normalOptions);
      const checks = [...expectedChecks(test, { snapshot, verification: null, certificate: null }), ...checkHoldout(test, { snapshot, certificate: null })]
        .filter(x => !['readiness', 'verification and certificate decision', 'holdout: withdrawn certainty or completeness blocks certification'].includes(x.name));
      record.candidates.push({ call: c.index, snapshot, valueChecks: checks,
        valuesPass: checks.every(x => x.pass), authoredReadback: value.confirmationPrompt });
    } catch (error) { record.candidates.push({ call: c.index, error: error.message }); }
  }
  await writeFile(resolve(directory, `${arm}.json`), JSON.stringify(record, null, 2) + '\n');
  const compact = { arm, pass: record.pass, passUnder45s: record.passUnder45s, elapsedMs: record.elapsedMs,
    calls: calls.length, paidCalls: calls.filter(x => !x.synthetic && !x.reusedExactPrefix).length,
    certified: Boolean(record.result?.certificate), failures: record.checks.filter(x => !x.pass), error: record.error };
  summary.arms.push(compact);
  await writeFile(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ id: seed.id, repetition, ...compact }));
}
globalThis.fetch = networkFetch; Date.now = realNow;
