#!/usr/bin/env node
// Independent audit reproductions. Assertions describe the observed defects,
// not acceptable product behaviour. No real model, no production mutation.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { interpretDirectModuleConversation, MODULE_PLANNING_SNAPSHOT_V1, DIRECT_MODULE_CONTRACTS } from '../worker/src/consumer/direct_module_planner.js';
import { buildDirectModulePolicyEnvelope, directModulePolicyEntries } from '../js/planning/direct_module_policy.js';
import { directModuleTestInputs } from './live-harness/direct-fixtures.mjs';
import { readJsonPointer } from '../js/planning/utils.js';
import { stableStringify } from '../worker/src/consumer/crypto.js';
import { newLiveMeeting, attachTypedSession, attachLiveSession } from './live-harness/session.mjs';
import { recordRealtimeFinalTurn } from '../worker/src/consumer/realtime_repository.js';

const TODAY = new Date().toISOString().slice(0, 10);
const INPUT = directModuleTestInputs(TODAY).mortgage_analysis;
const POLICY = buildDirectModulePolicyEnvelope({ calculationDateIso: TODAY, baseCurrency: 'EUR' });
const TEXT = 'My repayment mortgage balance is 240000 euro at 4.1 percent with 22 years remaining, and I am considering no overpayments.';
const PROMPT = 'I will analyse your repayment mortgage of 240000 euro at 4.1 percent with 22 years left and no overpayments. Shall I run that?';
const pass = { schemaVersion: 'ModuleInputVerificationV1', verdict: 'pass', unsupportedPaths: [], omittedSupportedInformation: [], unresolvedAmbiguities: [], clarifications: [], confirmationPromptApproved: true, explanation: 'Scripted independent acceptance.' };
const config = { allowedModules: ['mortgage_analysis'], modulePlannerModel: 'synthetic', modulePlannerTimeoutMs: 30000, modulePlannerRepairFloorMs: 20000, modulePlannerReasoningEffort: 'low', realtimePromptVersion: 'p', realtimeToolsetVersion: 't' };
const env = { OPENAI_API_KEY: 'synthetic', CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url') };
const profile = { revision: 1, assumptions: { calculationDateIso: TODAY, values: {} }, preferences: { baseCurrency: 'EUR' } };
function proposal(turnId = 'turn-1') {
  const policy = directModulePolicyEntries('mortgage_analysis', INPUT, POLICY);
  return { schemaVersion: MODULE_PLANNING_SNAPSHOT_V1, baseSnapshotRevision: 0, throughTurnId: turnId,
    modules: [{ moduleId: 'mortgage_analysis', outputKey: DIRECT_MODULE_CONTRACTS.mortgage_analysis.outputKey,
      status: 'ready', selection: { origin: 'client_requested', reason: 'mortgage analysis requested' },
      inputJson: JSON.stringify(INPUT), steeringSummary: 'your mortgage', missing: [], ambiguities: [],
      assumptions: policy.filter(entry => entry.mode === 'default' && (readJsonPointer(INPUT, entry.path) === undefined || stableStringify(readJsonPointer(INPUT, entry.path)) === stableStringify(entry.value)))
        .map(entry => ({ path: entry.path, source: entry.source, valueJson: JSON.stringify(entry.value) })),
      evidence: Object.keys(INPUT).map(key => ({ path: `/${key}`, source: 'conversation', turnId, quote: TEXT, profilePath: '' })) }],
    generalAmbiguities: [], confirmationPrompt: PROMPT };
}
const reply = (value, id = crypto.randomUUID()) => ({ ok: true, json: async () => ({ id, status: 'completed', output_text: JSON.stringify(value), usage: { input_tokens: 100, output_tokens: 10 } }) });
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const evidence = [];
const record = (name, details) => { evidence.push({ name, ...details }); console.log(`REPRODUCED ${name}: ${JSON.stringify(details)}`); };
try {
  // A spent entry-point deadline is not guarded before dispatch. A zero-delay
  // timer runs after fetch has already been invoked; a fast response can finish.
  let calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ kind: body.text.format.name, at: Date.now(), alreadyAborted: init.signal.aborted });
    return reply(body.text.format.name === 'module_planning_snapshot_v1' ? proposal() : pass);
  };
  const deadlineAt = Date.now() - 1;
  const expired = await interpretDirectModuleConversation({ env, config, turns: [{ id: 'turn-1', role: 'user', transcript: TEXT }], throughTurnId: 'turn-1', currentProfileContext: profile, deadlineAt });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.at > deadlineAt && !call.alreadyAborted));
  assert.ok(expired.certificate);
  record('expired direct pass dispatches extractor and verifier', { calls, certificateIssued: Boolean(expired.certificate) });

  // Real Type DO: refusing the planning drain does not refuse its renderer.
  const typed = await newLiveMeeting('audit-claude-budget-renderer', { CONSUMER_MODULE_PLANNER_MODE: 'apply', OPENAI_API_KEY: 'synthetic' });
  const { session: typedSession } = await attachTypedSession(typed);
  typedSession.directModulePlanningDeadlineAt = Date.now() - 1;
  calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ kind: body.text?.format?.name || 'renderer', pastDeadline: Date.now() > typedSession.directModulePlanningDeadlineAt });
    return { ok: true, json: async () => ({ status: 'completed', output_text: 'I am checking your saved answer.', usage: { input_tokens: 100, output_tokens: 10 } }) };
  };
  await typedSession.handleTextMessage({ text: TEXT });
  assert.ok(calls.some(call => call.kind === 'renderer' && call.pastDeadline));
  assert.ok(calls.every(call => call.pastDeadline));
  assert.equal(typedSession.directModulePlanningOutstanding.length, 1);
  record('Type renderer dispatches after shared deadline', { calls, outstandingReview: 1 });

  // A Speak background pass captures null before a blocking boundary arms.
  // Simulate time passing only at model boundaries, without waiting 90 sec.
  const voice = await newLiveMeeting('audit-claude-budget-background', { CONSUMER_MODULE_PLANNER_MODE: 'apply', OPENAI_API_KEY: 'synthetic', CONSUMER_MODULE_PLANNER_TURN_BUDGET_MS: '20000' });
  const { session: voiceSession } = await attachLiveSession(voice);
  const turn = await recordRealtimeFinalTurn(voice.env, { sessionId: voice.sessionId, leaseId: voice.meetingId, providerItemId: 'audit-background', role: 'user', transcript: TEXT });
  let releaseExtract;
  let startedExtract;
  const extractorStarted = new Promise(resolve => { startedExtract = resolve; });
  const release = new Promise(resolve => { releaseExtract = resolve; });
  let clockOffset = 0;
  Date.now = () => originalNow() + clockOffset;
  calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ kind: body.text?.format?.name, at: Date.now(), armedDeadline: voiceSession.directModulePlanningDeadlineAt });
    if (body.text?.format?.name === 'module_planning_snapshot_v1') {
      startedExtract(); await release; return reply(proposal(turn.id));
    }
    return reply(pass);
  };
  const chain = voiceSession.scheduleDirectModulePlanning(turn.id);
  await extractorStarted;
  assert.equal(voiceSession.directModulePlanningDeadlineAt, null);
  const disarm = voiceSession.armDirectModulePlanningDeadline();
  const armedDeadline = voiceSession.directModulePlanningDeadlineAt;
  clockOffset = 21000;
  releaseExtract();
  await chain;
  disarm();
  Date.now = originalNow;
  assert.equal(calls.length, 2);
  assert.ok(calls[1].at > armedDeadline);
  record('Speak background chain ignores subsequently armed boundary', { calls, armedDeadline });

  // Metering commits only if interpret returns. A completed paid extraction
  // followed by an initial-verifier timeout is silently absent from the ledger.
  const meter = await newLiveMeeting('audit-claude-budget-meter', { CONSUMER_MODULE_PLANNER_MODE: 'apply', OPENAI_API_KEY: 'synthetic' });
  const { session: meterSession } = await attachTypedSession(meter);
  const meterTurn = await recordRealtimeFinalTurn(meter.env, { sessionId: meter.sessionId, leaseId: meter.meetingId, providerItemId: 'audit-meter', role: 'user', transcript: TEXT });
  let dispatched = 0;
  globalThis.fetch = async (_url, init) => {
    dispatched++;
    if (JSON.parse(init.body).text?.format?.name === 'module_planning_snapshot_v1') return reply(proposal(meterTurn.id), 'audit-paid-extraction');
    throw new DOMException('Synthetic timeout after paid extraction', 'AbortError');
  };
  await meterSession.scheduleDirectModulePlanning(meterTurn.id);
  const usage = await meter.env.CONSUMER_DB.prepare('SELECT COUNT(*) AS n FROM consumer_realtime_usage WHERE realtime_session_id = ?').bind(meter.meetingId).first();
  assert.equal(dispatched, 2);
  assert.equal(usage.n, 0);
  assert.equal(meterSession.directModulePlanningOutstanding.length, 1);
  record('successful extraction lost from billing when initial verifier fails', { dispatched, completedExtractionTokens: 110, usageRows: usage.n, outstandingReview: 1 });

  // A failed first chain leaves an obligation that the renderer's get_state
  // retries inside the SAME request, while there is time left. The second
  // chain may independently spend both repair opportunities.
  const repeat = await newLiveMeeting('audit-claude-budget-second-chain', { CONSUMER_MODULE_PLANNER_MODE: 'apply', OPENAI_API_KEY: 'synthetic' });
  const { session: repeatSession } = await attachTypedSession(repeat);
  let plannerCalls = 0;
  let rendererCalls = 0;
  let lastTurnId;
  calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const name = body.text?.format?.name;
    calls.push(name || 'renderer');
    if (name === 'module_planning_snapshot_v1' || name === 'module_input_verification_v1') {
      plannerCalls++;
      if (name === 'module_planning_snapshot_v1') {
        lastTurnId = JSON.parse(body.input[1].content).throughTurnId;
        const snapshot = proposal(lastTurnId);
        if (plannerCalls === 3) snapshot.modules[0].evidence = snapshot.modules[0].evidence.filter(e => e.path !== '/currentBalance');
        return reply(snapshot);
      }
      if (plannerCalls === 2) throw new DOMException('First chain verifier failed', 'AbortError');
      if (plannerCalls === 5) return reply({ ...pass, verdict: 'needs_clarification', confirmationPromptApproved: false,
        omittedSupportedInformation: ['/confirmationPrompt'], clarifications: [{ id: 'wording', question: 'May I check that wording?', relatedModuleIds: ['mortgage_analysis'], relatedPaths: ['/confirmationPrompt'] }] });
      return reply(pass);
    }
    if (!name) {
      rendererCalls++;
      if (rendererCalls === 1) return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'function_call', name: 'get_state', arguments: '{}', call_id: 'audit-second-chain-state' }], usage: { input_tokens: 100, output_tokens: 10 } }) };
      return { ok: true, json: async () => ({ status: 'completed', output_text: 'I have checked your saved answer.', usage: { input_tokens: 100, output_tokens: 10 } }) };
    }
    return reply(pass);
  };
  await repeatSession.handleTextMessage({ text: TEXT });
  assert.equal(plannerCalls, 7);
  assert.equal(rendererCalls, 2);
  record('one typed request starts a second planning chain and seven planner calls', { plannerCalls, rendererCalls, calls });

  // Ending the real meeting does not cancel an in-flight Responses chain;
  // after closing, its successful extraction can still dispatch verification.
  const cancel = await newLiveMeeting('audit-claude-budget-cancel', { CONSUMER_MODULE_PLANNER_MODE: 'apply', OPENAI_API_KEY: 'synthetic' });
  const { session: cancelSession } = await attachTypedSession(cancel);
  const cancelTurn = await recordRealtimeFinalTurn(cancel.env, { sessionId: cancel.sessionId, leaseId: cancel.meetingId,
    providerItemId: 'audit-cancel', role: 'user', transcript: TEXT });
  let unlockExtraction;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const unlock = new Promise(resolve => { unlockExtraction = resolve; });
  let ended = false;
  calls = [];
  globalThis.fetch = async (_url, init) => {
    const name = JSON.parse(init.body).text?.format?.name;
    calls.push({ name, afterMeetingEnded: ended, signalAborted: init.signal.aborted });
    if (name === 'module_planning_snapshot_v1') { markStarted(); await unlock; return reply(proposal(cancelTurn.id)); }
    return reply(pass);
  };
  const cancelChain = cancelSession.scheduleDirectModulePlanning(cancelTurn.id);
  await started;
  await cancelSession.terminalize('complete', 'consumer_closed', null, true);
  ended = true;
  unlockExtraction();
  await cancelChain;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].afterMeetingEnded, true);
  assert.equal(calls[1].signalAborted, false);
  record('a verifier is dispatched after explicit meeting termination', { calls });
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
}
await mkdir('diagnostics/claude-review', { recursive: true });
await writeFile('diagnostics/claude-review/budget-reproductions.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(`Recorded ${evidence.length} independent budget reproductions. These are observed defects, not passing safety checks.`);
