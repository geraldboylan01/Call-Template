#!/usr/bin/env node

/**
 * Free completion-path matrix: real Durable Object, database, certification,
 * execution and persisted results; scripted semantic extraction/verifier and
 * provider playback events. These are LOCAL timings, not browser/provider
 * latency or evidence for a production timeout. No paid call is made.
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { attachLiveSession, newLiveMeeting, settle } from './live-harness/session.mjs';
import { LiveProviderSimulator } from './live-harness/provider.mjs';
import { directModuleTestInputs } from './live-harness/direct-fixtures.mjs';
import {
  DIRECT_MODULE_CONTRACTS, DIRECT_MODULE_IDS, MODULE_PLANNING_SNAPSHOT_V1
} from '../worker/src/consumer/direct_module_planner.js';
import { buildDirectModulePolicyEnvelope, directModulePolicyEntries } from '../js/planning/direct_module_policy.js';
import { readJsonPointer, sha256Json } from '../js/planning/utils.js';
import { decryptJson, sha256Base64Url, stableStringify } from '../worker/src/consumer/crypto.js';
import { getRealtimeAnalysisPlanExecution } from '../worker/src/consumer/realtime_repository.js';
import { confirmAndRunRealtimeAnalysisPlan } from '../worker/src/consumer/realtime_analysis.js';

const TODAY = new Date().toISOString().slice(0, 10);
const INPUTS = directModuleTestInputs(TODAY);
const POLICY = buildDirectModulePolicyEnvelope({ calculationDateIso: TODAY, baseCurrency: 'EUR' });
const APPROVALS = ['Yes', 'Yes, run the plan', 'Grand, go ahead', 'Work away', 'Fire away', 'Please do', 'Sure, go for it', 'Perfect'];
const DETAILS = {
  personal_balance_sheet: 'My home is worth €450,000, my cash savings are €50,000 and my pension is €180,000. My mortgage is €240,000 and I spend €2,500 monthly. Those are all my assets and debts.',
  pension_projection: 'John is 42, earns €85,000 and has €180,000 in his pension, paying 8% with a 6% employer contribution and retiring at 67. Mary is 40, earns €70,000 and has €120,000 in her pension, paying 7% with a 5% employer contribution and retiring at 66. We want €70,000 yearly from retirement through age 95 and have no other income sources. Use the standard State Pension and growth assumptions.',
  liquidity_analysis: 'I am not retired. I have €90,000 cash and spend €5,000 a month, or €60,000 a year. Use the standard working-household reserve policy.',
  mortgage_analysis: 'My repayment mortgage balance is €240,000, with a 4.1% interest rate and 22 years remaining. I am considering no overpayments.',
  loan_analysis: 'My repayment loan balance is €18,000, with an 8.5% interest rate and four years remaining. I can overpay €500 yearly and have no one-off overpayment.',
  college_funding: 'My one child is eight. Please use college starting at 18 for four years, with the standard education inflation and approved living-at-home and living-away cost scenarios.',
  house_purchase: 'Aoife is a 34-year-old first-time buyer in stable employment earning €68,000 gross. I have €70,000 cash, €4,200 monthly net income, €2,200 monthly essential spending, €1,700 rent and €1,000 current and planned monthly saving. The home target is €400,000 by June 2028, to live in myself. I have no other applicants, debts, gifts or grants; the local authority, property subtype and lender approval are unknown. Use the standard purchase-cost, reserve and mortgage assumptions.'
};
const NAMES = {
  personal_balance_sheet: 'personal balance sheet', pension_projection: 'pension projection',
  liquidity_analysis: 'cash reserve analysis', mortgage_analysis: 'mortgage analysis',
  loan_analysis: 'loan analysis', college_funding: 'college funding projection', house_purchase: 'house purchase analysis'
};
const SCENARIOS = [
  ...DIRECT_MODULE_IDS.map((moduleId) => ({ id: moduleId, moduleIds: [moduleId] })),
  { id: 'mixed_mortgage_liquidity', moduleIds: ['mortgage_analysis', 'liquidity_analysis'] },
  { id: 'general_checkup', moduleIds: ['personal_balance_sheet', 'liquidity_analysis', 'loan_analysis'] },
  { id: 'correction_before_readback', moduleIds: ['mortgage_analysis'], correction: true }
];
const rows = [];
const originalFetch = globalThis.fetch;
let scenario;
let extractionCount = 0;
let verificationCount = 0;

function extraction(envelope) {
  const source = envelope.conversation.find((turn) => turn.role === 'client' && turn.text.includes('Fixture details:'));
  assert.ok(source, 'the financial input is grounded in the fixture client turn');
  const correction = envelope.conversation.find((turn) => turn.role === 'client' && turn.text.includes('Actually the balance'));
  const prompt = `I will run the ${scenario.moduleIds.map((id) => NAMES[id]).join(' and ')} using the figures and standard assumptions we have discussed. ${scenario.moduleIds.map((id) => DETAILS[id]).join(' ')} Would you like me to run exactly that plan now?`;
  return {
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision: Number(envelope.previousSnapshot?.snapshotRevision || 0),
    throughTurnId: envelope.throughTurnId,
    modules: DIRECT_MODULE_IDS.map((moduleId) => {
      const relevant = scenario.moduleIds.includes(moduleId);
      const input = relevant ? structuredClone(INPUTS[moduleId]) : null;
      if (input && scenario.correction && !correction) input.currentBalance = 230000;
      const policy = relevant ? directModulePolicyEntries(moduleId, input, POLICY) : [];
      return {
        moduleId, outputKey: DIRECT_MODULE_CONTRACTS[moduleId].outputKey,
        status: relevant ? 'ready' : 'not_relevant',
        // A general check-up is Planeir's own suggestion; a named request is the
        // client's. The fixture emits what a real planner must emit.
        selection: relevant
          ? scenario.id === 'general_checkup'
            ? { origin: 'planeir_suggested', reason: `a ${NAMES[moduleId]} would show where you stand` }
            : { origin: 'client_requested', reason: `you asked about your ${NAMES[moduleId]}` }
          : { origin: 'not_selected', reason: '' },
        inputJson: relevant ? JSON.stringify(input) : '',
        steeringSummary: relevant ? DETAILS[moduleId] : '',
        missing: [], ambiguities: [],
        assumptions: policy.filter((entry) => entry.mode === 'default'
          && (readJsonPointer(input, entry.path) === undefined
            || stableStringify(readJsonPointer(input, entry.path)) === stableStringify(entry.value)))
          .map((entry) => ({ path: entry.path, source: entry.source, valueJson: JSON.stringify(entry.value) })),
        evidence: relevant ? Object.keys(input).map((key) => ({
          path: `/${key}`, source: 'conversation',
          turnId: correction && key === 'currentBalance' ? correction.turnId : source.turnId,
          quote: correction && key === 'currentBalance' ? correction.text : source.text,
          profilePath: ''
        })) : []
      };
    }),
    generalAmbiguities: [], confirmationPrompt: prompt
  };
}

globalThis.fetch = async (_url, request) => {
  const body = JSON.parse(request.body);
  const envelope = JSON.parse(body.input?.[1]?.content || '{}');
  let value;
  if (body.text?.format?.name === 'module_planning_snapshot_v1') {
    extractionCount += 1;
    value = extraction(envelope);
  } else {
    assert.equal(body.text?.format?.name, 'module_input_verification_v1');
    verificationCount += 1;
    value = {
      schemaVersion: 'ModuleInputVerificationV1', verdict: 'pass',
      unsupportedPaths: [], omittedSupportedInformation: [], unresolvedAmbiguities: [],
      clarifications: [], confirmationPromptApproved: true,
      explanation: 'Scripted semantic verifier for the completion-path fixture; not a model-quality evaluation.'
    };
  }
  return { ok: true, json: async () => ({ status: 'completed', output_text: JSON.stringify(value) }) };
};

try {
  for (scenario of SCENARIOS) {
    for (const approval of APPROVALS) {
      const label = `${scenario.id}/${approval}`;
      const meeting = await newLiveMeeting(`completion-${rows.length}`, {
        CONSUMER_MODULE_PLANNER_MODE: 'apply', OPENAI_API_KEY: 'synthetic-test-key'
      });
      const rig = await attachLiveSession(meeting);
      const simulator = new LiveProviderSimulator(rig);
      await simulator.turn({
        clientText: `${scenario.id === 'general_checkup' ? 'I would like a financial check-up.' : `Please examine my ${scenario.moduleIds.map((id) => NAMES[id]).join(' and ')}.`} Fixture details: ${scenario.moduleIds.map((id) => DETAILS[id]).join(' ')}`,
        act: async () => ({ speech: 'I have those details.' })
      });
      await settle(rig.durable, rig.session);
      if (scenario.correction) {
        await simulator.turn({ clientText: 'Actually the balance is €240,000, not €230,000.', act: async () => ({ speech: 'I have the corrected balance.' }) });
        await settle(rig.durable, rig.session);
      }
      let token;
      await simulator.turn({
        clientText: 'Please read the plan back.',
        act: async ({ callTool }) => {
          const state = (await callTool('get_state', {})).result;
          assert.equal(state.readyToConfirm, true, `${label}: ready snapshot ${JSON.stringify(state)}`);
          token = state.confirmationToken;
          return { speech: state.confirmationPrompt };
        }
      });
      await settle(rig.durable, rig.session);
      assert.equal(rig.session.directConfirmationOffer?.token, token, label);
      assert.equal(rig.session.directConfirmationOffer?.readbackFullyDelivered, true, label);
      const offer = structuredClone(rig.session.directConfirmationOffer);
      const frozen = await getRealtimeAnalysisPlanExecution(meeting.env, meeting.sessionId, offer.planId, meeting.meetingId);
      const modelCallsBeforeApproval = extractionCount + verificationCount;
      const approvalStarted = performance.now();
      let result;
      await simulator.turn({
        clientText: approval,
        act: async ({ callTool }) => {
          result = (await callTool('confirm_and_run', { confirmationToken: token })).result;
          return {};
        }
      });
      const observedAt = performance.now();
      await settle(rig.durable, rig.session);
      assert.equal(result?.ok, true, `${label}: ${JSON.stringify(result)}`);
      assert.equal(result?.status, 'complete', label);
      assert.equal(result?.completedCount, scenario.moduleIds.length, label);
      assert.equal(extractionCount + verificationCount, modelCallsBeforeApproval, `${label}: approval must not re-plan`);
      const plans = (await meeting.env.CONSUMER_DB.prepare('SELECT * FROM consumer_realtime_analysis_plans WHERE session_id = ?').bind(meeting.sessionId).all()).results;
      assert.equal(plans.length, 1, `${label}: one frozen offer`);
      assert.equal(plans[0].id, frozen.row.id);
      assert.equal(plans[0].status, 'complete');
      const runs = (await meeting.env.CONSUMER_DB.prepare('SELECT * FROM consumer_analysis_runs WHERE session_id = ?').bind(meeting.sessionId).all()).results;
      assert.equal(runs.length, 1, `${label}: exactly one execution`);
      assert.equal(runs[0].input_snapshot_hash_b64u, await sha256Base64Url(stableStringify(frozen.input.moduleInputs)), `${label}: exact frozen execution bundle`);
      const storedResults = await decryptJson(meeting.env, runs[0].payload_encrypted, `consumer/analysis/${meeting.sessionId}/${runs[0].id}`);
      assert.equal(storedResults.results.length, scenario.moduleIds.length);
      const moduleRuns = (await meeting.env.CONSUMER_DB.prepare('SELECT * FROM consumer_module_runs WHERE session_id = ?').bind(meeting.sessionId).all()).results;
      assert.equal(moduleRuns.length, scenario.moduleIds.length);
      for (const moduleId of scenario.moduleIds) {
        const approvedInput = frozen.input.moduleInputs[moduleId];
        assert.equal(await sha256Base64Url(stableStringify(approvedInput)), frozen.input.verificationCertificate.moduleInputHashes[moduleId]);
        const executedHash = await sha256Json({ input: approvedInput, scenarioOverrides: {} });
        assert.equal(storedResults.results.find((item) => item.moduleId === moduleId)?.inputSnapshotHash, executedHash, `${label}: ${moduleId} exact native hash`);
        assert.equal(moduleRuns.find((item) => item.module_id === moduleId)?.input_snapshot_hash_b64u, executedHash);
      }
      // A new provider tool-call id against the same offer joins its receipt.
      await simulator.turn({ clientText: approval, act: async ({ callTool }) => {
        const duplicate = (await callTool('confirm_and_run', { confirmationToken: token })).result;
        assert.equal(duplicate?.status, 'complete', `${label}: duplicate approval receipt ${JSON.stringify(duplicate)}`);
        return {};
      } });
      // Reconstruct the Durable Object from persisted state; a retry through
      // the execution service still uses the saved plan nonce and same run.
      const restarted = await attachLiveSession(meeting, { initial: Object.fromEntries(rig.durable.values) });
      assert.equal(restarted.session.directConfirmationOffer?.planId, offer.planId);
      const replay = await confirmAndRunRealtimeAnalysisPlan({
        env: meeting.env, config: meeting.config, sessionId: meeting.sessionId,
        planId: frozen.row.id, planNonce: frozen.planNonce, expectedRevision: Number(frozen.row.profile_revision)
      });
      assert.equal(replay.idempotentReplay, true);
      assert.equal(replay.analysisPlan.analysisRunId, runs[0].id);
      const count = await meeting.env.CONSUMER_DB.prepare('SELECT COUNT(*) AS n FROM consumer_analysis_runs WHERE session_id = ?').bind(meeting.sessionId).first();
      assert.equal(Number(count.n), 1, `${label}: retries never rerun modules`);
      rows.push({ scenario: scenario.id, approval, approvalToPersistedObservationMs: Number((observedAt - approvalStarted).toFixed(2)) });
    }
    console.info(`[LiveCompletionMatrix] ${scenario.id}: 8/8 one-approval completions; zero duplicate executions or hash mismatches.`);
  }
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(rows.length, 80);
const sorted = rows.map((row) => row.approvalToPersistedObservationMs).sort((a, b) => a - b);
const percentile = (fraction) => sorted[Math.ceil(sorted.length * fraction) - 1];
console.info(JSON.stringify({
  lane: 'local-scripted-provider-real-durable-object-and-database',
  representativeCalls: rows.length, oneApprovalCompletions: rows.length,
  doubleExecutions: 0, approvedExecutedInputMismatches: 0,
  approvalToPersistedObservationMs: { p50: percentile(0.5), p95: percentile(0.95), min: sorted[0], max: sorted.at(-1) },
  productionTimeoutEvidence: false,
  browserShutdownMeasured: false
}, null, 2));
