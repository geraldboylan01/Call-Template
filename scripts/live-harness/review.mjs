/**
 * A meeting driven to a published REVIEW, on the real Durable Object.
 *
 * WHAT IS REAL: the Durable Object, the database, the migrations, the
 * encryption, the certificate, the seal predicate, the immutable review record
 * and the deterministic financial engine. Only the planner's and verifier's
 * OPINIONS are scripted, exactly as the existing completion harness scripts
 * them -- the harness says what the planner concluded, and production code
 * decides whether that conclusion may be sealed.
 *
 * `modelCalls()` is what makes the "zero additional planner/verifier calls"
 * assertions mean anything: it counts every scripted provider request, so a
 * Run that reasoned about anything at all would be visible.
 */
import assert from 'node:assert/strict';

import { attachLiveSession, attachTypedSession, newLiveMeeting, settle } from './session.mjs';
import { LiveProviderSimulator } from './provider.mjs';
import { directModuleTestInputs } from './direct-fixtures.mjs';
import {
  DIRECT_MODULE_CONTRACTS, DIRECT_MODULE_IDS, MODULE_PLANNING_SNAPSHOT_V1
} from '../../worker/src/consumer/direct_module_planner.js';
import { buildDirectModulePolicyEnvelope, directModulePolicyEntries } from '../../js/planning/direct_module_policy.js';
import { readJsonPointer } from '../../js/planning/utils.js';
import { stableStringify } from '../../worker/src/consumer/crypto.js';

export const TODAY = new Date().toISOString().slice(0, 10);
const INPUTS = directModuleTestInputs(TODAY);
const POLICY = buildDirectModulePolicyEnvelope({ calculationDateIso: TODAY, baseCurrency: 'EUR' });

const MODULE_ID = 'mortgage_analysis';
export const MODULE_NAME = 'mortgage analysis';
export const DETAIL = 'My repayment mortgage balance is €240,000, with a 4.1% interest rate and '
  + '22 years remaining. I am considering no overpayments.';
export const OPENING = `Please examine my ${MODULE_NAME}. Fixture details: ${DETAIL}`;

let extractionCount = 0;
let verificationCount = 0;
let rendererCount = 0;
let originalFetch = null;

export function modelCalls() {
  return { extractions: extractionCount, verifications: verificationCount, total: extractionCount + verificationCount };
}

function extraction(envelope) {
  const source = envelope.conversation.find((turn) => turn.role === 'client' && turn.text.includes('Fixture details:'));
  assert.ok(source, 'the financial input is grounded in a real stored client turn');
  const prompt = `I will run the ${MODULE_NAME} using the figures and standard assumptions we have `
    + `discussed. ${DETAIL}`;
  return {
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision: Number(envelope.previousSnapshot?.snapshotRevision || 0),
    throughTurnId: envelope.throughTurnId,
    modules: DIRECT_MODULE_IDS.map((moduleId) => {
      const relevant = moduleId === MODULE_ID;
      const input = relevant ? structuredClone(INPUTS[moduleId]) : null;
      const policy = relevant ? directModulePolicyEntries(moduleId, input, POLICY) : [];
      return {
        moduleId,
        outputKey: DIRECT_MODULE_CONTRACTS[moduleId].outputKey,
        status: relevant ? 'ready' : 'not_relevant',
        selection: relevant
          ? { origin: 'client_requested', reason: `you asked about your ${MODULE_NAME}` }
          : { origin: 'not_selected', reason: '' },
        inputJson: relevant ? JSON.stringify(input) : '',
        steeringSummary: relevant ? DETAIL : '',
        missing: [],
        ambiguities: [],
        assumptions: policy.filter((entry) => entry.mode === 'default'
          && (readJsonPointer(input, entry.path) === undefined
            || stableStringify(readJsonPointer(input, entry.path)) === stableStringify(entry.value)))
          .map((entry) => ({ path: entry.path, source: entry.source, valueJson: JSON.stringify(entry.value) })),
        evidence: relevant
          ? Object.keys(input).map((key) => ({
            path: `/${key}`, source: 'conversation', turnId: source.turnId, quote: source.text, profilePath: ''
          }))
          : []
      };
    }),
    generalAmbiguities: [],
    confirmationPrompt: prompt
  };
}

/** Install the scripted planner/verifier. Returns a restore function. */
export function scriptPlanner() {
  originalFetch = globalThis.fetch;
  extractionCount = 0;
  verificationCount = 0;
  rendererCount = 0;
  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);

    // THE TYPED RENDERER. It writes the assistant's ordinary prose and decides
    // when to read state; it decides nothing about execution and has no tool
    // that could. Scripted here so a typed meeting can be driven end to end.
    if (Array.isArray(body.tools)) {
      const alreadyRead = (body.input || []).some(
        (item) => typeof item?.content === 'string' && item.content.includes('completed get_state')
      );
      rendererCount += 1;
      return {
        ok: true,
        json: async () => ({
          status: 'completed',
          usage: { input_tokens: 20, output_tokens: 20 },
          output: alreadyRead
            ? [{ type: 'message', content: [{ type: 'output_text', text: 'Thanks — I have what I need.' }] }]
            : [{ type: 'function_call', name: 'get_state', arguments: '{}', call_id: `txtcall_${rendererCount}` }]
        })
      };
    }

    const envelope = JSON.parse(body.input?.[1]?.content || '{}');
    let value;
    if (body.text?.format?.name === 'module_planning_snapshot_v1') {
      extractionCount += 1;
      value = extraction(envelope);
    } else {
      assert.equal(body.text?.format?.name, 'module_input_verification_v1');
      verificationCount += 1;
      value = {
        schemaVersion: 'ModuleInputVerificationV1',
        verdict: 'pass',
        unsupportedPaths: [], omittedSupportedInformation: [], unresolvedAmbiguities: [],
        clarifications: [], confirmationPromptApproved: true,
        explanation: 'Scripted semantic verifier for the review-protocol fixture.'
      };
    }
    return { ok: true, json: async () => ({ status: 'completed', output_text: JSON.stringify(value) }) };
  };
  return () => { if (originalFetch) globalThis.fetch = originalFetch; };
}

export async function newReviewMeeting(label) {
  return newLiveMeeting(label, {
    CONSUMER_MODULE_PLANNER_MODE: 'apply',
    CONSUMER_TYPED_LANE_ENABLED: 'true',
    OPENAI_API_KEY: 'synthetic-test-key'
  });
}

/**
 * Drive a SPOKEN meeting from nothing to a published review.
 *
 * The get_state call is the model's readiness decision and nothing more: the
 * server seals inside it, and this helper asserts only that a review came out.
 */
export async function reachReviewBySpeaking(label, { extraTurns = [] } = {}) {
  const meeting = await newReviewMeeting(label);
  const rig = await attachLiveSession(meeting);
  const simulator = new LiveProviderSimulator(rig);
  await simulator.turn({ clientText: OPENING, act: async () => ({ speech: 'I have those details.' }) });
  await settle(rig.durable, rig.session);
  for (const text of extraTurns) {
    await simulator.turn({ clientText: text, act: async () => ({ speech: 'Noted.' }) });
    await settle(rig.durable, rig.session);
  }
  let state;
  await simulator.turn({
    clientText: 'Is that everything you need?',
    act: async ({ callTool }) => {
      state = (await callTool('get_state', {})).result;
      return { speech: 'Here is what I have.' };
    }
  });
  await settle(rig.durable, rig.session);
  return { meeting, rig, simulator, state };
}

/** Drive a TYPED meeting from nothing to a published review. */
export async function reachReviewByTyping(label) {
  const meeting = await newReviewMeeting(label);
  const rig = await attachTypedSession(meeting);
  const first = await rig.session.handleTextMessage({ text: OPENING });
  await settle(rig.durable, rig.session);
  let sealed = first;
  if (!first.review) {
    sealed = await rig.session.handleTextMessage({ text: 'Is that everything you need?' });
    await settle(rig.durable, rig.session);
  }
  return { meeting, rig, result: sealed };
}
