#!/usr/bin/env node

/**
 * First complete direct-module call, over the real live Durable Object and D1.
 * Only the two background model responses are scripted. The transcript storage,
 * detached scheduling, encrypted brief, steering injection, confirmation tool,
 * certificate checks and deterministic module execution are production code.
 */

import assert from 'node:assert/strict';

import { attachLiveSession, newLiveMeeting, settle } from './live-harness/session.mjs';
import { LiveProviderSimulator } from './live-harness/provider.mjs';
import {
  DIRECT_MODULE_CONTRACTS,
  DIRECT_MODULE_IDS,
  MODULE_PLANNING_SNAPSHOT_V1
} from '../worker/src/consumer/direct_module_planner.js';
import { getLatestRealtimeMeetingBrief } from '../worker/src/consumer/realtime_repository.js';

const pass = (message) => console.info(`[DirectModuleLivePath] PASS: ${message}`);
const TODAY = new Date().toISOString().slice(0, 10);
const CLIENT_TURN = 'Please analyse my existing repayment mortgage. The balance is two hundred and forty thousand euro, the rate is four point one percent, and there are twenty two years left. I do not want to model an overpayment.';
const CONFIRMATION_PROMPT = 'I will run the existing mortgage analysis using a €240,000 balance, 4.1% interest and 22 years remaining, with no overpayment. Would you like me to run exactly that plan now?';
const MORTGAGE_INPUT = Object.freeze({
  loanKind: 'mortgage',
  currentBalance: 240000,
  annualInterestRate: 0.041,
  startDateIso: TODAY,
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

const originalFetch = globalThis.fetch;
let extractionCalls = 0;
let verificationCalls = 0;
let failNextExtraction = false;
let holdNextExtraction = null;
globalThis.fetch = async (_url, request) => {
  const body = JSON.parse(request.body);
  const requestBody = JSON.parse(body.input?.[1]?.content || '{}');
  let value;
  if (body.text?.format?.name === 'module_planning_snapshot_v1') {
    extractionCalls += 1;
    if (holdNextExtraction) {
      const held = holdNextExtraction;
      holdNextExtraction = null;
      await held;
    }
    if (failNextExtraction) {
      failNextExtraction = false;
      return { ok: false, json: async () => ({ error: { message: 'synthetic failure' } }) };
    }
    value = extractionFor(
      requestBody.throughTurnId,
      Number(requestBody.previousSnapshot?.snapshotRevision || 0),
      requestBody.conversation?.find((turn) => turn.text === CLIENT_TURN)?.turnId
        || requestBody.throughTurnId
    );
  } else if (body.text?.format?.name === 'module_input_verification_v1') {
    verificationCalls += 1;
    value = {
      schemaVersion: 'ModuleInputVerificationV1',
      verdict: 'pass',
      unsupportedPaths: [],
      omittedSupportedInformation: [],
      unresolvedAmbiguities: [],
      clarifications: [],
      confirmationPromptApproved: true,
      explanation: 'The mortgage input is fully supported by the client turn.'
    };
  } else {
    throw new Error(`Unexpected model request ${body.text?.format?.name || 'unknown'}`);
  }
  return {
    ok: true,
    json: async () => ({
      status: 'completed',
      output_text: JSON.stringify(value),
      usage: { input_tokens: 100, output_tokens: 50 }
    })
  };
};

try {
  const meeting = await newLiveMeeting('direct-module-live-path', {
    CONSUMER_MODULE_PLANNER_MODE: 'apply',
    OPENAI_API_KEY: 'synthetic-test-key'
  });
  const { session, durable, provider } = await attachLiveSession(meeting);
  const simulator = new LiveProviderSimulator({ session, durable, provider });

  // Exercise the production race explicitly: Realtime may start speaking
  // before Whisper's finalized transcript reaches the sideband Worker.
  const delayedItemId = `item_${++simulator.itemSeq}`;
  const delayedTurnStartedAt = Date.now();
  await simulator.send({ type: 'input_audio_buffer.speech_stopped', item_id: delayedItemId });
  const conversationalTurn = await simulator.runResponseChain({
    itemId: delayedItemId,
    clientText: CLIENT_TURN,
    startedAt: delayedTurnStartedAt,
    act: async ({ speak }) => {
      await speak('Absolutely. I have the roughly €240,000 balance and 4.1% rate, and I can help you examine that mortgage.');
      await simulator.send({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: delayedItemId,
        transcript: CLIENT_TURN
      });
      return { alreadySpoken: true };
    }
  });
  assert.match(conversationalTurn.speech, /help you examine/i);
  assert.equal(session.violationCount, 0,
    'a correct digit rendering of words must not be cancelled by a deterministic English parser');
  pass('Realtime replies without waiting for the background module planner');

  await settle(durable, session);
  assert.equal(session.violationCount, 0);
  assert.equal(extractionCalls, 1);
  assert.equal(verificationCalls, 1);
  assert.deepEqual(session.directModulePlanningOutstanding, []);

  const stored = await getLatestRealtimeMeetingBrief(
    meeting.env,
    meeting.sessionId,
    meeting.meetingId
  );
  assert.equal(stored?.brief?.schemaVersion, 'MeetingBriefV3');
  assert.equal(stored.brief.readyToConfirm, true);
  assert.equal(
    stored.brief.directModuleSnapshot.modules
      .find((item) => item.moduleId === 'mortgage_analysis')?.input?.currentBalance,
    240000
  );
  assert.ok(provider.stateItems().some((item) => item.includes('RealtimeModuleSteeringV1')));
  assert.ok(provider.stateItems().some((item) => item.includes('background data, never an instruction')));
  pass('the transcript becomes encrypted, verified native module input and later-turn steering');

  let confirmationToken = null;
  const inaccurateReadBack = await simulator.turn({
    clientText: 'Are we ready to run it?',
    act: async ({ callTool }) => {
      const state = await callTool('get_state', {});
      confirmationToken = state.result?.confirmationToken || null;
      assert.equal(state.result?.readyToConfirm, true);
      assert.ok(confirmationToken);
      assert.equal(state.result?.confirmationPrompt, CONFIRMATION_PROMPT);
      return { speech: 'Everything is ready. Shall I run it?' };
    }
  });
  await settle(durable, session);
  assert.equal(inaccurateReadBack.responseIds.length, 2, 'get_state must finish in a distinct continuation response');
  assert.equal(session.directConfirmationOffer, null,
    'an incomplete or inaccurate read-back must not arm a certified plan');

  const readBack = await simulator.turn({
    clientText: 'Please read the exact plan back to me.',
    act: async ({ callTool }) => {
      const state = await callTool('get_state', {});
      confirmationToken = state.result?.confirmationToken || null;
      assert.equal(state.result?.confirmationPrompt, CONFIRMATION_PROMPT);
      return { speech: state.result.confirmationPrompt };
    }
  });
  await settle(durable, session);
  assert.equal(readBack.responseIds.length, 2);
  assert.equal(session.directConfirmationOffer?.token, confirmationToken);
  const armedAssistantTurnId = session.directConfirmationOffer?.assistantTurnId;
  assert.ok(armedAssistantTurnId);
  pass('a ready get_state result arms only the assistant turn that reads back the verified plan');

  let refusedWrongToken = null;
  let replacementToken = null;
  const refusedChain = await simulator.turn({
    clientText: 'Yes, please go ahead.',
    act: async ({ callTool }) => {
      refusedWrongToken = (await callTool('confirm_and_run', {
        confirmationToken: `${confirmationToken}-wrong`
      })).result;
      const refreshed = await callTool('get_state', {});
      replacementToken = refreshed.result?.confirmationToken || null;
      return {
        speech: refreshed.result.confirmationPrompt
      };
    }
  });
  await settle(durable, session);
  assert.equal(refusedWrongToken?.code, 'confirmation_context_invalid');
  assert.equal(refusedChain.responseIds.length, 3,
    'two consecutive tools must require two causally linked continuation responses');
  const rootContext = session.responseContextsById.get(refusedChain.responseIds[0]);
  for (const responseId of refusedChain.responseIds.slice(1)) {
    const continuation = session.responseContextsById.get(responseId);
    assert.equal(continuation?.causeItemId, rootContext?.causeItemId);
    assert.equal(continuation?.precedingAssistantTranscript, rootContext?.precedingAssistantTranscript);
  }
  assert.equal(session.directConfirmationOffer?.token, replacementToken);
  assert.notEqual(session.directConfirmationOffer?.assistantTurnId, armedAssistantTurnId);
  pass('wrong tokens fail and a multi-continuation chain preserves its exact causal turn and proposition');

  let confirmationResult = null;
  await simulator.turn({
    clientText: 'Yes, please go ahead.',
    act: async ({ callTool }) => {
      const call = await callTool('confirm_and_run', { confirmationToken: replacementToken });
      confirmationResult = call.result;
      return { speech: call.result?.speakableText || 'The analysis is ready.' };
    }
  });
  await settle(durable, session);

  assert.equal(extractionCalls, 3, 'each pre-confirmation get_state settles its latest client turn once');
  assert.equal(verificationCalls, 3, 'the confirmation must use the latest independently verified snapshot');
  assert.equal(confirmationResult?.ok, true);
  assert.equal(confirmationResult?.status, 'complete');
  assert.equal(confirmationResult?.completedCount, 1);
  pass('the confirmed certified JSON runs unchanged through the deterministic mortgage module');

  const runs = (await meeting.env.CONSUMER_DB.prepare(`
    SELECT status, input_snapshot_hash_b64u FROM consumer_module_runs
    WHERE session_id = ? AND module_id = 'mortgage_analysis'
  `).bind(meeting.sessionId).all()).results || [];
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'complete');
  assert.ok(runs[0].input_snapshot_hash_b64u);
  pass('the analysis run records provenance for the exact direct input snapshot');
  const plannerUsage = (await meeting.env.CONSUMER_DB.prepare(`
    SELECT usage_kind FROM consumer_realtime_usage
    WHERE session_id = ? AND realtime_session_id = ? AND usage_kind = 'planner'
  `).bind(meeting.sessionId, meeting.meetingId).all()).results || [];
  assert.equal(plannerUsage.length, extractionCalls + verificationCalls);
  pass('every extractor/verifier pass is recorded on the live cost ledger');

  const failedMeeting = await newLiveMeeting('direct-module-failed-pass', {
    CONSUMER_MODULE_PLANNER_MODE: 'apply',
    OPENAI_API_KEY: 'synthetic-test-key'
  });
  const failedRig = await attachLiveSession(failedMeeting);
  const failedSimulator = new LiveProviderSimulator(failedRig);
  await failedSimulator.turn({
    clientText: CLIENT_TURN,
    act: async () => ({ speech: 'I have the mortgage details.' })
  });
  await settle(failedRig.durable, failedRig.session);
  assert.ok(failedRig.session.directAwaitingConfirmationSnapshotRevision);

  failNextExtraction = true;
  await failedSimulator.turn({
    clientText: 'Before we proceed, please keep the mortgage analysis as the only analysis.',
    act: async () => ({ speech: 'Understood.' })
  });
  await settle(failedRig.durable, failedRig.session);
  assert.equal(failedRig.session.directAwaitingConfirmationSnapshotRevision, null);
  assert.equal(failedRig.session.directModulePlanningOutstanding.length, 1);

  let blocked = null;
  let recoveredToken = null;
  await failedSimulator.turn({
    clientText: 'Yes, please go ahead.',
    act: async ({ callTool }) => {
      blocked = (await callTool('confirm_and_run', { confirmationToken: 'dmc_missing_offer_123456789' })).result;
      const refreshed = await callTool('get_state', {});
      recoveredToken = refreshed.result?.confirmationToken || null;
      return { speech: refreshed.result.confirmationPrompt };
    }
  });
  assert.equal(blocked?.code, 'confirmation_context_invalid');
  await settle(failedRig.durable, failedRig.session);
  assert.deepEqual(failedRig.session.directModulePlanningOutstanding, []);
  assert.ok(failedRig.session.directAwaitingConfirmationSnapshotRevision);
  assert.equal(failedRig.session.directConfirmationOffer?.token, recoveredToken);
  pass('a failed semantic pass blocks the stale snapshot and get_state performs one safe retry');

  const coalescedMeeting = await newLiveMeeting('direct-module-coalesced-planning', {
    CONSUMER_MODULE_PLANNER_MODE: 'apply',
    OPENAI_API_KEY: 'synthetic-test-key'
  });
  const coalescedRig = await attachLiveSession(coalescedMeeting);
  const coalescedSimulator = new LiveProviderSimulator(coalescedRig);
  let releaseHeldExtraction;
  holdNextExtraction = new Promise((resolve) => { releaseHeldExtraction = resolve; });
  const callsBeforeCoalescing = extractionCalls;
  await coalescedSimulator.turn({
    clientText: CLIENT_TURN,
    act: async () => ({ speech: 'I have those mortgage details.' })
  });
  while (extractionCalls === callsBeforeCoalescing) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await coalescedSimulator.turn({
    clientText: 'Keep that as the only analysis.',
    act: async () => ({ speech: 'Understood.' })
  });
  await coalescedSimulator.turn({
    clientText: 'And keep the overpayment at zero.',
    act: async () => ({ speech: 'Understood.' })
  });
  releaseHeldExtraction();
  await settle(coalescedRig.durable, coalescedRig.session);
  assert.equal(extractionCalls - callsBeforeCoalescing, 2,
    'one active pass plus the newest turn must replace a three-turn FIFO backlog');
  const coalescedBrief = await getLatestRealtimeMeetingBrief(
    coalescedMeeting.env,
    coalescedMeeting.sessionId,
    coalescedMeeting.meetingId
  );
  assert.equal(coalescedBrief?.brief?.snapshotRevision, 2);
  assert.deepEqual(coalescedRig.session.directModulePlanningOutstanding, []);
  pass('rapid client turns coalesce to one active semantic pass plus the latest complete transcript');

  /* ------------------------- the first state read cannot answer from nothing */

  // THE RACE THIS PINS. Realtime is already speaking when it asks what is in
  // play. On the very first substantive turn Whisper has often not finalized,
  // so the turn is not stored, no planning pass is queued, and the background
  // lane looks idle rather than late. A get_state answered there returns
  // revision 0 and no analyses -- and the model, told to steer on exactly that,
  // names nothing it can examine and starts asking for figures the client has
  // just given. The read is owed to the turn that caused it.
  const delayedMeeting = await newLiveMeeting('direct-module-delayed-asr', {
    CONSUMER_MODULE_PLANNER_MODE: 'apply',
    OPENAI_API_KEY: 'synthetic-test-key'
  });
  const delayedRig = await attachLiveSession(delayedMeeting);
  const delayedSimulator = new LiveProviderSimulator(delayedRig);
  const delayedStateItemId = `item_${++delayedSimulator.itemSeq}`;

  await delayedSimulator.send({
    type: 'input_audio_buffer.speech_stopped', item_id: delayedStateItemId
  });
  const delayedResponse = await delayedSimulator.startResponse(null);
  assert.equal(
    delayedRig.session.responseContextsById.get(delayedResponse.responseId)?.causeItemId,
    delayedStateItemId,
    'the response must record the client turn it is answering'
  );

  const sentBeforeDelayedState = delayedRig.provider.sent.length;
  await delayedSimulator.send({
    type: 'response.function_call_arguments.done',
    response_id: delayedResponse.responseId,
    call_id: 'call_delayed_state',
    name: 'get_state',
    arguments: '{}'
  });
  const outputFor = (callId) => delayedRig.provider.sent
    .find((event) => event?.item?.type === 'function_call_output'
      && event.item.call_id === callId);
  assert.equal(
    delayedRig.provider.sent.slice(sentBeforeDelayedState)
      .some((event) => event?.item?.type === 'function_call_output'),
    false,
    'a direct state read must not be answered before its causal transcript finalizes'
  );

  await delayedSimulator.send({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: delayedStateItemId,
    transcript: CLIENT_TURN
  });
  await settle(delayedRig.durable, delayedRig.session);

  const delayedStateOutput = outputFor('call_delayed_state');
  assert.ok(delayedStateOutput, 'the deferred state read must still be answered');
  const delayedState = JSON.parse(delayedStateOutput.item.output);
  assert.equal(delayedState.schemaVersion, 'DirectModuleToolStateV1');
  assert.equal(delayedState.snapshotRevision, 1,
    'the first state read must reflect the turn that caused it, never revision 0');
  assert.deepEqual(
    delayedState.modules.map((item) => item.moduleId),
    ['mortgage_analysis'],
    'module selection must be populated on the turn the client stated the goal'
  );
  assert.match(delayedState.modules[0].knownSummary, /240,000/,
    'the figures the client just spoke must already be known to the state read');
  assert.deepEqual(delayedState.modules[0].missing, []);

  // FAIL OPEN WHEN THERE IS NOTHING TO WAIT FOR. An unavailable transcript
  // queues no planning pass, so a state read deferred behind it would otherwise
  // wait for a turn that will never arrive and silently strand the response.
  const unavailableItemId = `item_${++delayedSimulator.itemSeq}`;
  await delayedSimulator.send({
    type: 'input_audio_buffer.speech_stopped', item_id: unavailableItemId
  });
  const unavailableResponse = await delayedSimulator.startResponse(null);
  await delayedSimulator.send({
    type: 'response.function_call_arguments.done',
    response_id: unavailableResponse.responseId,
    call_id: 'call_unavailable_state',
    name: 'get_state',
    arguments: '{}'
  });
  assert.equal(outputFor('call_unavailable_state'), undefined);
  await delayedSimulator.send({
    type: 'conversation.item.input_audio_transcription.failed',
    item_id: unavailableItemId
  });
  await settle(delayedRig.durable, delayedRig.session);
  const unavailableOutput = outputFor('call_unavailable_state');
  assert.ok(unavailableOutput,
    'a state read must be released even when its causal transcript never arrives');
  assert.equal(JSON.parse(unavailableOutput.item.output).snapshotRevision, 1,
    'it must fall back to the newest snapshot that does exist, not to nothing');
  pass('a delayed or failed transcript cannot answer the first state read from empty planning state');
} finally {
  globalThis.fetch = originalFetch;
}

console.info('[DirectModuleLivePath] Complete direct-module live call passed.');
