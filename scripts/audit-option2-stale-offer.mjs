#!/usr/bin/env node
// Adversarial executor regression: the extractor misses a correction, while
// the independent verifier notices. Every persistence/barrier/engine is real;
// only model responses are scripted. No provider requests or production writes.
import assert from 'node:assert/strict';
import { attachLiveSession, newLiveMeeting, settle } from './live-harness/session.mjs';
import { LiveProviderSimulator } from './live-harness/provider.mjs';
import { DIRECT_MODULE_CONTRACTS, DIRECT_MODULE_IDS, MODULE_PLANNING_SNAPSHOT_V1 }
  from '../worker/src/consumer/direct_module_planner.js';
import { getLatestRealtimeMeetingBrief, getRealtimeAnalysisPlanExecution }
  from '../worker/src/consumer/realtime_repository.js';
import { loadLiveContext } from '../worker/src/consumer/live/live_tools.js';
import { confirmPlanSelection } from '../worker/src/consumer/planning_turn.js';
import { confirmAndRunRealtimeAnalysisPlan } from '../worker/src/consumer/realtime_analysis.js';

const TODAY = new Date().toISOString().slice(0, 10);
const CLIENT_TURN = 'Please analyse my existing repayment mortgage. The balance is two hundred and forty thousand euro, the rate is four point one percent, and there are twenty two years left. I do not want to model an overpayment. I hold this mortgage jointly with Ben.';
const CONFIRMATION_PROMPT = 'For the mortgage you hold jointly with Ben, I will run the existing mortgage analysis using a €240,000 balance, 4.1% interest and 22 years remaining, with no overpayment. Would you like me to run exactly that plan now?';
const MORTGAGE_INPUT = Object.freeze({
  loanKind: 'mortgage',
  currentBalance: 240000,
  annualInterestRate: 0.041,
  startDateIso: TODAY,
  endDateIso: null,
  remainingTermYears: 22,
  repaymentType: 'repayment',
  fixedPaymentAmount: null,
  oneOffOverpayment: 0,
  annualOverpayment: 0
});

function extractionFor(throughTurnId, baseSnapshotRevision = 0, evidenceTurnId = throughTurnId) {
  return {
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision,
    throughTurnId,
    modules: DIRECT_MODULE_IDS.map((moduleId) => ({
      moduleId,
      outputKey: DIRECT_MODULE_CONTRACTS[moduleId].outputKey,
      status: moduleId === 'mortgage_analysis' ? 'ready' : 'not_relevant',
      inputJson: moduleId === 'mortgage_analysis' ? JSON.stringify(MORTGAGE_INPUT) : '',
      steeringSummary: moduleId === 'mortgage_analysis'
        ? 'Existing repayment mortgage: €240,000 balance, 4.1% interest, 22 years remaining, with no overpayment modelled.'
        : '',
      selection: { origin: moduleId === 'mortgage_analysis' ? 'client_requested' : 'not_selected', reason: '' },
      resolvedAcknowledgedUnknown: [],
      missing: [],
      ambiguities: [],
      assumptions: moduleId === 'mortgage_analysis' ? [
        { path: '/endDateIso', valueJson: 'null', source: 'contract_default' },
        { path: '/fixedPaymentAmount', valueJson: 'null', source: 'contract_default' },
        { path: '/oneOffOverpayment', valueJson: '0', source: 'contract_default' },
        { path: '/annualOverpayment', valueJson: '0', source: 'contract_default' }
      ] : [],
      evidence: moduleId === 'mortgage_analysis' ? [
        { path: '/currentBalance', source: 'conversation', turnId: evidenceTurnId, quote: 'two hundred and forty thousand euro', profilePath: '' },
        { path: '/annualInterestRate', source: 'conversation', turnId: evidenceTurnId, quote: 'four point one percent', profilePath: '' },
        { path: '/remainingTermYears', source: 'conversation', turnId: evidenceTurnId, quote: 'twenty two years', profilePath: '' }
      ] : []
    })),
    generalAmbiguities: [],
    confirmationPrompt: CONFIRMATION_PROMPT
  };
}


const CORRECTION = 'The figures are unchanged, but I got the ownership wrong: this mortgage is held jointly with Ciara, not Ben.';
const NEW_PROMPT = CONFIRMATION_PROMPT.replace('jointly with Ben', 'jointly with Ciara');
let corrected = false;
let calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const request = JSON.parse(body.input?.[1]?.content || '{}');
  const kind = body.text?.format?.name;
  calls.push({ kind, request });
  let value;
  if (kind === 'module_planning_snapshot_v1') {
    value = extractionFor(request.throughTurnId, Number(request.previousSnapshot?.snapshotRevision || 0),
      request.conversation.find(turn => turn.text === CLIENT_TURN)?.turnId || request.throughTurnId);
    if (corrected) value.confirmationPrompt = NEW_PROMPT;
  } else if (kind === 'module_confirmation_repair_v1') {
    // Failed narrow repair repeats the old owner. A later full re-author will
    // supply the correct owner while retaining identical native mortgage input.
    value = { confirmationPrompt: CONFIRMATION_PROMPT };
  } else if (kind === 'module_input_verification_v1') {
    const staleOwner = corrected && request.proposedSnapshot.confirmationPrompt !== NEW_PROMPT;
    value = { schemaVersion: 'ModuleInputVerificationV1', verdict: staleOwner ? 'needs_clarification' : 'pass',
      unsupportedPaths: [], omittedSupportedInformation: staleOwner ? ['The readback names superseded owner Ben rather than corrected owner Ciara.'] : [],
      unresolvedAmbiguities: [],
      clarifications: staleOwner ? [{ id: 'owner', question: 'May I use Ciara as the joint owner?', relatedModuleIds: ['mortgage_analysis'], relatedPaths: [] }] : [],
      confirmationPromptApproved: !staleOwner, repairScope: staleOwner ? 'confirmation' : 'none', repairTargets: [],
      explanation: staleOwner ? 'Only the readback ownership is wrong; the native figures remain correct.' : 'The exact readback is supported by the latest ownership correction.' };
  } else throw new Error(`Unexpected model request ${kind}`);
  return { ok: true, json: async () => ({ id: `synthetic-${calls.length}`, status: 'completed', output_text: JSON.stringify(value), usage: {} }) };
};
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.log(`FAIL ${name}: ${error.message}`); }
}
try {
  const meeting = await newLiveMeeting('option2-ownership-offer', {
    CONSUMER_MODULE_PLANNER_MODE: 'apply', OPENAI_API_KEY: 'synthetic-test-key'
  });
  const { session, durable, provider } = await attachLiveSession(meeting);
  const simulator = new LiveProviderSimulator({ session, durable, provider });
  await simulator.turn({ clientText: CLIENT_TURN, act: async () => ({ speech: 'I will check that plan.' }) });
  await settle(durable, session);
  await simulator.turn({ clientText: 'Please read that plan back.', act: async ({ callTool }) => {
    const state = await callTool('get_state', {});
    assert.ok(state.result?.confirmationToken);
    return { speech: state.result.confirmationPrompt };
  } });
  await settle(durable, session);
  assert.equal(session.directConfirmationOffer?.readbackFullyDelivered, true);
  const oldToken = session.directConfirmationOffer.token;
  const frozen = await getRealtimeAnalysisPlanExecution(meeting.env, meeting.sessionId,
    session.directConfirmationOffer.planId, meeting.meetingId);
  corrected = true;
  const correctionCallStart = calls.length;
  await simulator.turn({ clientText: CORRECTION, act: async () => ({ speech: 'Thanks, I will check that ownership correction.' }) });
  await settle(durable, session);
  const latest = await getLatestRealtimeMeetingBrief(meeting.env, meeting.sessionId, meeting.meetingId);
  await check('control: fallback certified the current correct owner at unchanged financial inputs', async () => {
    assert.ok(latest.brief.verificationCertificate);
    assert.equal(latest.brief.confirmationPrompt, NEW_PROMPT);
    assert.equal(latest.brief.directModuleSnapshot.modules.find(item => item.moduleId === 'mortgage_analysis').input.currentBalance, 240000);
    assert.equal(calls.slice(correctionCallStart).filter(call => call.kind === 'module_planning_snapshot_v1').length, 2);
  });
  await check('changed owner retires the delivered old offer', async () => assert.equal(session.directConfirmationOffer, null));
  let returnedState;
  await simulator.turn({ clientText: 'Please read the corrected plan back.', act: async ({ callTool }) => {
    const state = await callTool('get_state', {}); returnedState = state.result;
    return { speech: state.result.confirmationPrompt || 'Let me check.' };
  } });
  await settle(durable, session);
  await check('get_state offers the newly certified ownership wording', async () => {
    assert.equal(returnedState.confirmationPrompt, NEW_PROMPT);
    assert.notEqual(returnedState.confirmationToken, oldToken);
  });
  await check('old approval is nevertheless refused by the execution readback hash barrier', async () => {
    const context = await loadLiveContext({ env: meeting.env, config: meeting.config, sessionId: meeting.sessionId });
    await confirmPlanSelection({ env: meeting.env, config: meeting.config, sessionRow: context.sessionRow,
      profile: context.profile, channel: 'live', confirmedModuleIds: ['mortgage_analysis'], preparedPlanId: frozen.row.id });
    await assert.rejects(confirmAndRunRealtimeAnalysisPlan({ env: meeting.env, config: meeting.config,
      sessionId: meeting.sessionId, planId: frozen.row.id, planNonce: frozen.planNonce,
      expectedRevision: Number(frozen.row.profile_revision) }), error => error.code === 'module_snapshot_revision_conflict');
  });
  await check('no stale-owner financial calculation executes', async () => {
    const row = await meeting.env.CONSUMER_DB.prepare('SELECT COUNT(*) AS n FROM consumer_module_runs WHERE session_id = ?')
      .bind(meeting.sessionId).first(); assert.equal(row.n, 0);
  });
} finally { globalThis.fetch = originalFetch; }
console.log(`Option2 same-value ownership: ${failures} reproduced offer-continuity failures.`);
if (failures) process.exitCode = 1;
