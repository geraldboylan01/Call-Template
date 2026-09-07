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
const CLIENT_TURN = 'Please analyse my existing repayment mortgage. The balance is two hundred and forty thousand euro, the rate is four point one percent, and there are twenty two years left. I do not want to model an overpayment.';
const CONFIRMATION_PROMPT = 'I will run the existing mortgage analysis using a €240,000 balance, 4.1% interest and 22 years remaining, with no overpayment. Would you like me to run exactly that plan now?';
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


const CORRECTION = 'Actually, I checked the statement: the balance is 340,000, not 240,000. Please correct that before running it.';
let rejectLatest = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const request = JSON.parse(body.input?.[1]?.content || '{}');
  let value;
  if (body.text?.format?.name === 'module_planning_snapshot_v1') {
    value = extractionFor(request.throughTurnId, Number(request.previousSnapshot?.snapshotRevision || 0),
      request.conversation.find((turn) => turn.text === CLIENT_TURN)?.turnId || request.throughTurnId);
  } else if (body.text?.format?.name === 'module_input_verification_v1') {
    value = {
      schemaVersion: 'ModuleInputVerificationV1', verdict: rejectLatest ? 'needs_clarification' : 'pass',
      unsupportedPaths: [], omittedSupportedInformation: [],
      unresolvedAmbiguities: rejectLatest ? ['The client corrected the balance to 340,000 but the candidate still contains 240,000.'] : [],
      clarifications: rejectLatest ? [{ id: 'missed-correction', question: 'May I update the balance to the 340,000 on your statement?',
        relatedModuleIds: ['mortgage_analysis'], relatedPaths: ['/currentBalance'] }] : [],
      confirmationPromptApproved: !rejectLatest,
      explanation: rejectLatest ? 'The old read-back contradicts the latest client correction.' : 'The input and read-back are supported.'
    };
  } else throw new Error('Unexpected model request');
  return { ok: true, json: async () => ({ status: 'completed', output_text: JSON.stringify(value), usage: {} }) };
};
const failures = [];
let passed = 0;
async function check(name, run) {
  try { await run(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
try {
  const meeting = await newLiveMeeting('first20-verifier-rejection', {
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
  const frozen = await getRealtimeAnalysisPlanExecution(meeting.env, meeting.sessionId,
    session.directConfirmationOffer.planId, meeting.meetingId);
  rejectLatest = true;
  await simulator.turn({ clientText: CORRECTION, act: async () => ({ speech: 'Thanks, I will check that correction.' }) });
  await settle(durable, session);
  const latest = await getLatestRealtimeMeetingBrief(meeting.env, meeting.sessionId, meeting.meetingId);
  assert.equal(latest.brief.verificationCertificate, null);
  assert.equal(latest.brief.directModuleSnapshot.modules.find((item) => item.moduleId === 'mortgage_analysis').input.currentBalance, 240000);
  await check('a verifier rejection retires the delivered offer even when extraction missed the correction', async () => {
    assert.equal(session.directConfirmationOffer, null);
  });
  await check('the final execution barrier rejects the old certificate against the rejected latest review', async () => {
    // Independently exercise the lowest execution boundary with the correct
    // frozen nonce, simulating a stale coordinator that still holds the offer.
    const context = await loadLiveContext({ env: meeting.env, config: meeting.config, sessionId: meeting.sessionId });
    await confirmPlanSelection({ env: meeting.env, config: meeting.config, sessionRow: context.sessionRow,
      profile: context.profile, channel: 'live', confirmedModuleIds: ['mortgage_analysis'], preparedPlanId: frozen.row.id });
    await assert.rejects(confirmAndRunRealtimeAnalysisPlan({ env: meeting.env, config: meeting.config,
      sessionId: meeting.sessionId, planId: frozen.row.id, planNonce: frozen.planNonce,
      expectedRevision: Number(frozen.row.profile_revision) }),
      (error) => error.code === 'module_snapshot_revision_conflict');
  });
  await check('no financial engine runs from the superseded input', async () => {
    const row = await meeting.env.CONSUMER_DB.prepare('SELECT COUNT(*) AS n FROM consumer_module_runs WHERE session_id = ?')
      .bind(meeting.sessionId).first();
    assert.equal(row.n, 0);
  });
} finally { globalThis.fetch = originalFetch; }
console.log(`[First20VerifierRejection] ${passed} passed; ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;
