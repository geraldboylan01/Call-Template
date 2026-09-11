#!/usr/bin/env node
// Option 2 independent audit. Synthetic provider responses; real DO and D1.
// Assertions record falsified claims and retained guards separately. No production mutation.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { interpretDirectModuleConversation, MODULE_PLANNING_SNAPSHOT_V1, DIRECT_MODULE_CONTRACTS } from '../worker/src/consumer/direct_module_planner.js';
import { buildDirectModulePolicyEnvelope, directModulePolicyEntries } from '../js/planning/direct_module_policy.js';
import { directModuleTestInputs } from './live-harness/direct-fixtures.mjs';
import { readJsonPointer } from '../js/planning/utils.js';
import { stableStringify } from '../worker/src/consumer/crypto.js';
import { newLiveMeeting, attachTypedSession, attachLiveSession, settle } from './live-harness/session.mjs';
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
const evidence = [];
function record(name, details) { evidence.push({ name, ...details }); console.log(`${name}: ${JSON.stringify(details)}`); }
const expiredOperation = () => ({ id: 'expired', deadlineAt: Date.now() - 1, callAllowance: 7, callsUsed: 0, controller: new AbortController() });
try {
  let count = 0;
  globalThis.fetch = async () => { count++; throw new Error('must not dispatch'); };
  await assert.rejects(interpretDirectModuleConversation({ env, config, turns: [], throughTurnId: 'turn-1', currentProfileContext: profile, operation: expiredOperation() }), { code: 'module_planner_turn_deadline_exceeded' });
  await assert.rejects(interpretDirectModuleConversation({ env, config, turns: [], throughTurnId: 'turn-1', currentProfileContext: profile, operation: { ...expiredOperation(), deadlineAt: Date.now() + 90000, callsUsed: 7 } }), { code: 'module_planner_call_allowance_exhausted' });
  assert.equal(count, 0);
  record('GUARD HOLDS: expired and eighth planner calls refused synchronously', { providerCalls: count });

  // Exactly seven planner stages, followed by the real typed renderer. This
  // distinguishes the planner allowance from the all-provider-call claim.
  const full = await newLiveMeeting('audit-option2-full-chain', { CONSUMER_MODULE_PLANNER_MODE: 'apply', OPENAI_API_KEY: 'synthetic' });
  const { session: fullSession, durable: fullDurable } = await attachTypedSession(full);
  let planningCalls = 0;
  let lastTurn;
  let rendererCalls = 0;
  const calls = [];
  const reject = { ...pass, verdict: 'needs_clarification', confirmationPromptApproved: false,
    omittedSupportedInformation: ['/confirmationPrompt'], repairScope: 'confirmation', repairTargets: [],
    clarifications: [{ id: 'confirmation', question: 'May I check the readback?', relatedModuleIds: ['mortgage_analysis'], relatedPaths: ['/confirmationPrompt'] }] };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const name = body.text?.format?.name || 'renderer';
    calls.push(name);
    if (['module_planning_snapshot_v1', 'module_confirmation_repair_v1', 'module_input_verification_v1'].includes(name)) {
      planningCalls++;
      const request = JSON.parse(body.input?.[1]?.content || '{}');
      if (name === 'module_planning_snapshot_v1') {
        lastTurn = request.throughTurnId;
        const p = proposal(lastTurn);
        if (planningCalls === 1) p.modules[0].evidence = p.modules[0].evidence.filter(e => e.path !== '/currentBalance');
        return reply(p, `full-plan-${planningCalls}`);
      }
      if (name === 'module_confirmation_repair_v1') return reply({ confirmationPrompt: 'Shall I run that?' }, `full-plan-${planningCalls}`);
      return reply(planningCalls === 7 ? pass : reject, `full-plan-${planningCalls}`);
    }
    if (name === 'renderer') {
      rendererCalls++;
      if (rendererCalls === 1) return { ok: true, json: async () => ({ id: 'renderer-1', status: 'completed', output: [{ type: 'function_call', name: 'get_state', arguments: '{}', call_id: 'option2-get-state' }], usage: { input_tokens: 100, output_tokens: 10 } }) };
      return { ok: true, json: async () => ({ id: `renderer-${rendererCalls}`, status: 'completed', output_text: 'Your plan is ready to check.', usage: { input_tokens: 100, output_tokens: 10 } }) };
    }
    return reply(pass, 'compliance-response');
  };
  const result = await fullSession.handleTextMessage({ text: TEXT, clientTurnId: 'option2_full_chain' });
  await settle(fullDurable, fullSession);
  assert.equal(planningCalls, 7);
  assert.equal(rendererCalls, 2);
  assert.equal(result.readback, true);
  const plannerUsage = await full.env.CONSUMER_DB.prepare("SELECT COUNT(*) AS n, SUM(input_text_tokens) AS input, SUM(output_text_tokens) AS output FROM consumer_realtime_usage WHERE realtime_session_id = ? AND usage_kind = 'planner'").bind(full.meetingId).first();
  assert.equal(plannerUsage.n, 7);
  assert.equal(plannerUsage.input, 700);
  assert.equal(plannerUsage.output, 70);
  record('ALLOWANCE SCOPE: seven planner calls plus two renderer calls and detached review', { planningCalls, rendererCalls, totalCalls: calls.length, calls, plannerUsage, certifiedReadback: result.readback });

  // A duplicate POST is a single client database row, but it still spends a
  // fresh renderer. After reconstruction it also spends the planner again.
  const replay = await newLiveMeeting('audit-option2-message-replay', { CONSUMER_MODULE_PLANNER_MODE: 'apply', OPENAI_API_KEY: 'synthetic' });
  const { session: replaySession, durable: replayDurable } = await attachTypedSession(replay);
  const replayCalls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const name = body.text?.format?.name || 'renderer';
    replayCalls.push(name);
    if (name === 'module_planning_snapshot_v1') return reply(proposal(JSON.parse(body.input[1].content).throughTurnId));
    if (name === 'renderer') return { ok: true, json: async () => ({ status: 'completed', output_text: 'I have checked that answer.', usage: { input_tokens: 100, output_tokens: 10 } }) };
    return reply(pass);
  };
  const message = { text: TEXT, clientTurnId: 'same_submission_id' };
  await replaySession.handleTextMessage(message);
  await settle(replayDurable, replaySession);
  const afterFirst = replayCalls.length;
  await replaySession.handleTextMessage(message);
  await settle(replayDurable, replaySession);
  const secondCalls = replayCalls.slice(afterFirst);
  assert.ok(secondCalls.includes('renderer'));
  assert.ok(!secondCalls.includes('module_planning_snapshot_v1'));
  const afterSecond = replayCalls.length;
  const { session: restoredSession, durable: restoredDurable } = await attachTypedSession(replay);
  await restoredSession.handleTextMessage(message);
  await settle(restoredDurable, restoredSession);
  const restoredCalls = replayCalls.slice(afterSecond);
  assert.ok(restoredCalls.includes('module_planning_snapshot_v1'));
  const rowCounts = await replay.env.CONSUMER_DB.prepare("SELECT SUM(role='user') AS users, SUM(role='assistant') AS assistants FROM consumer_realtime_final_turns WHERE realtime_session_id = ?").bind(replay.meetingId).first();
  assert.equal(rowCounts.users, 1);
  assert.equal(rowCounts.assistants, 3);
  record('DEFECT: same message ID rerenders and replans after reconstruction', { secondCalls, restoredCalls, rowCounts });

  // Provider usage is real even if max_output_tokens truncates structured
  // output. The parser discards those tokens before the metering callback.
  const incomplete = await newLiveMeeting('audit-option2-incomplete-billing', { CONSUMER_MODULE_PLANNER_MODE: 'apply', OPENAI_API_KEY: 'synthetic' });
  const { session: incompleteSession } = await attachTypedSession(incomplete);
  const incompleteTurn = await recordRealtimeFinalTurn(incomplete.env, { sessionId: incomplete.sessionId, leaseId: incomplete.meetingId, providerItemId: 'incomplete-turn', role: 'user', transcript: TEXT });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'paid-incomplete', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1000, output_tokens: 12000 }, output_text: '{' }) });
  await incompleteSession.scheduleDirectModulePlanning(incompleteTurn.id);
  const incompleteUsage = await incomplete.env.CONSUMER_DB.prepare('SELECT COUNT(*) AS n FROM consumer_realtime_usage WHERE realtime_session_id = ?').bind(incomplete.meetingId).first();
  assert.equal(incompleteUsage.n, 0);
  record('DEFECT: incomplete response with reported tokens records no usage', { providerInputTokens: 1000, providerOutputTokens: 12000, usageRows: incompleteUsage.n });
} finally { globalThis.fetch = originalFetch; }
await mkdir('diagnostics/option2-audit', { recursive: true });
await writeFile('diagnostics/option2-audit/budget.json', JSON.stringify(evidence, null, 2) + '\n');
