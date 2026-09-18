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
import { PLANEIR_ASSUMPTIONS, approvedCollegeScenarios } from '../js/planning/planeir_assumptions.js';
import { getLatestRealtimeMeetingBrief, getRealtimeAnalysisPlanExecution } from '../worker/src/consumer/realtime_repository.js';
import { describeCurrentReview, executeReviewRun } from '../worker/src/consumer/review.js';

const pass = (message) => console.info(`[DirectModuleLivePath] PASS: ${message}`);
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

/* ---------- the first real production call, 2026-09-03, meeting rt_KUTY_… ---- */

// The client said this, chose college funding, and the meeting then stalled
// until they hung up. Sanitised: no name, no figure they did not speak.
const COLLEGE_TURN = 'It is mostly a check-up. I am after having a new baby and I am 30 years old, and I want to be sure I am in a good position to get this baby into college in the future.';
const COLLEGE_QUOTE = 'I am after having a new baby';
const COLLEGE_PROMPT = 'I will run the college funding projection for one child, currently a newborn, starting college at 18 for four years, against the approved living-at-home and living-away cost scenarios. Would you like me to run exactly that plan now?';
const COLLEGE_INPUT = Object.freeze({
  currentYear: Number(TODAY.slice(0, 4)),
  inflationRate: PLANEIR_ASSUMPTIONS.inflation.educationRate,
  children: [{
    id: 'child-1',
    title: 'New baby',
    currentAge: 0,
    collegeStartAge: PLANEIR_ASSUMPTIONS.collegeFunding.startAge,
    collegeDurationYears: PLANEIR_ASSUMPTIONS.collegeFunding.durationYears
  }],
  scenarios: approvedCollegeScenarios()
});

/**
 * The extractor doing exactly what its prompt tells it to: "preserve a previous
 * input unless the conversation corrects or retracts it". In production that
 * instruction returned the ENGINE's derived expansion of the input, because
 * that is what the snapshot handed back -- and the pass was then refused for
 * fields no quote can support, on every turn, forever.
 */
function collegeExtractionFor(throughTurnId, previousSnapshot, evidenceTurnId) {
  const previousCollege = (previousSnapshot?.modules || [])
    .find((item) => item.moduleId === 'college_funding');
  const carried = previousCollege?.status === 'ready' ? previousCollege.input : null;
  return {
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision: Number(previousSnapshot?.snapshotRevision || 0),
    throughTurnId,
    modules: DIRECT_MODULE_IDS.map((moduleId) => ({
      moduleId,
      outputKey: DIRECT_MODULE_CONTRACTS[moduleId].outputKey,
      status: moduleId === 'college_funding' ? 'ready' : 'not_relevant',
      inputJson: moduleId === 'college_funding'
        ? JSON.stringify(carried || COLLEGE_INPUT)
        : '',
      steeringSummary: moduleId === 'college_funding'
        ? 'One child, a newborn, with college timing on the approved Planéir assumptions.'
        : '',
      missing: [],
      ambiguities: [],
      assumptions: moduleId === 'college_funding' ? [
        { path: '/children/0/collegeStartAge', valueJson: String(PLANEIR_ASSUMPTIONS.collegeFunding.startAge), source: 'contract_default' },
        { path: '/children/0/collegeDurationYears', valueJson: String(PLANEIR_ASSUMPTIONS.collegeFunding.durationYears), source: 'contract_default' }
      ] : [],
      evidence: moduleId === 'college_funding' ? [
        { path: '/children/0', source: 'conversation', turnId: evidenceTurnId, quote: COLLEGE_QUOTE, profilePath: '' }
      ] : []
    })),
    generalAmbiguities: [],
    confirmationPrompt: COLLEGE_PROMPT
  };
}

const COLLEGE_INTAKE_QUESTION = 'Which children would you like to plan for, and how old are they now?';
function collegeIntakeExtractionFor(throughTurnId, previousSnapshot) {
  const extraction = collegeExtractionFor(throughTurnId, previousSnapshot, throughTurnId);
  const college = extraction.modules.find((item) => item.moduleId === 'college_funding');
  Object.assign(college, {
    status: 'collecting',
    inputJson: '{}',
    steeringSummary: 'College funding selected; the children and their ages are not yet established.',
    missing: [{ path: '/children', reason: 'The children to include and their current ages are unknown.', question: COLLEGE_INTAKE_QUESTION }],
    assumptions: [],
    evidence: []
  });
  extraction.confirmationPrompt = '';
  return extraction;
}

const originalFetch = globalThis.fetch;
let collegeReplay = false;
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
    value = collegeReplay
      ? collegeExtractionFor(
          requestBody.throughTurnId,
          requestBody.previousSnapshot,
          requestBody.conversation?.find((turn) => turn.text === COLLEGE_TURN)?.turnId
            || requestBody.throughTurnId
        )
      : extractionFor(
          requestBody.throughTurnId,
          Number(requestBody.previousSnapshot?.snapshotRevision || 0),
          requestBody.conversation?.find((turn) => turn.text === CLIENT_TURN)?.turnId
            || requestBody.throughTurnId
        );
    if (collegeReplay === 'intake'
      && !requestBody.conversation?.some((turn) => turn.text === COLLEGE_TURN)) {
      value = collegeIntakeExtractionFor(requestBody.throughTurnId, requestBody.previousSnapshot);
    }
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
      explanation: 'Every ready input is fully supported by the client turn.'
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

  /* ------------------------------------------- readiness seals, it does not ask */

  const readiness = await simulator.turn({
    clientText: 'Are we ready to run it?',
    act: async ({ callTool }) => {
      const state = await callTool('get_state', {});
      assert.equal(state.result?.readyToConfirm, true);
      assert.equal(state.result?.reviewPublished, true, 'a ready read seals the meeting');
      // THE MODEL IS TOLD NOTHING IT COULD SPEND. No token, no prompt to recite,
      // no instruction to seek agreement -- because there is nothing it could
      // do with any of them.
      assert.equal(state.result?.confirmationToken, undefined);
      assert.equal(state.result?.confirmationPrompt, undefined);
      return { speech: 'Here is the plan on screen for you.' };
    }
  });
  await settle(durable, session);
  assert.equal(readiness.responseIds.length, 2, 'get_state must finish in a distinct continuation response');

  const published = await describeCurrentReview(meeting.env, meeting.sessionId);
  const reviewId = published.review?.reviewId;
  assert.ok(reviewId, 'a review is published and is the one on screen');
  assert.deepEqual(published.review.actions, ['run', 'change']);
  assert.equal(published.review.presentation.summary, CONFIRMATION_PROMPT,
    'the client inspects the exact certified statement, verbatim');
  const reviewRow = await meeting.env.CONSUMER_DB
    .prepare('SELECT plan_id, certificate_signature, state FROM consumer_reviews WHERE id = ?')
    .bind(reviewId).first();
  assert.ok(reviewRow.plan_id, 'the exact executable plan is frozen before the client can act');
  assert.ok(reviewRow.certificate_signature, 'and its certificate is frozen with it');
  const frozenExecution = await getRealtimeAnalysisPlanExecution(
    meeting.env, meeting.sessionId, reviewRow.plan_id, meeting.meetingId
  );
  pass('a ready state read seals the meeting and publishes the exact certified plan as a review');

  /* ----------------------------------- conversation cannot touch that review */

  // The server refuses the input, so none of these can alter, approve or
  // revoke anything. Under the old architecture the second of them ran the
  // analyses.
  for (const said of ['Yes, please go ahead.', 'That seems sensible to me.', 'Yeah, run that plan.']) {
    await session.handleClientTurn({ item_id: `closed_${said.length}`, transcript: said });
    await settle(durable, session);
  }
  const untouched = await describeCurrentReview(meeting.env, meeting.sessionId);
  assert.equal(untouched.review?.reviewId, reviewId, 'the review is exactly the one published');
  assert.equal((await meeting.env.CONSUMER_DB.prepare(
    'SELECT COUNT(*) AS n FROM consumer_analysis_runs WHERE session_id = ?'
  ).bind(meeting.sessionId).first()).n, 0, 'and nothing has run');
  pass('conversation during review alters nothing and runs nothing');

  /* -------------------------------------------------- the human presses Run */

  const extractionsBeforeRun = extractionCalls;
  const verificationsBeforeRun = verificationCalls;
  const confirmationResult = await executeReviewRun(meeting.env, meeting.config, {
    sessionId: meeting.sessionId, reviewId, clickId: 'live_path_click'
  });
  assert.equal(extractionCalls, extractionsBeforeRun, 'Run creates no new extraction pass');
  assert.equal(verificationCalls, verificationsBeforeRun, 'and no new verifier pass');
  assert.equal(confirmationResult?.ok, true, confirmationResult?.code || '');
  assert.equal(confirmationResult?.analysisPlan?.status, 'complete');
  assert.equal((confirmationResult.result?.completedModuleIds || []).length, 1);
  pass('the certified JSON runs unchanged through the deterministic mortgage module');

  const runs = (await meeting.env.CONSUMER_DB.prepare(`
    SELECT status, input_snapshot_hash_b64u FROM consumer_module_runs
    WHERE session_id = ? AND module_id = 'mortgage_analysis'
  `).bind(meeting.sessionId).all()).results || [];
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'complete');
  assert.ok(runs[0].input_snapshot_hash_b64u);
  const executed = await getRealtimeAnalysisPlanExecution(
    meeting.env, meeting.sessionId, reviewRow.plan_id, meeting.meetingId
  );
  assert.deepEqual(executed.input, frozenExecution.input,
    'the originally certified inputs must remain byte-for-byte identical');

  const callsBeforeReplay = extractionCalls;
  const replayResult = await executeReviewRun(meeting.env, meeting.config, {
    sessionId: meeting.sessionId, reviewId, clickId: 'live_path_click_again'
  });
  assert.equal(replayResult?.ok, false, 'a second press cannot execute again');
  assert.equal(replayResult?.code, 'review_already_executed');
  assert.equal(extractionCalls, callsBeforeReplay);
  assert.equal((await meeting.env.CONSUMER_DB.prepare(
    'SELECT COUNT(*) AS n FROM consumer_module_runs WHERE session_id = ?'
  ).bind(meeting.sessionId).first()).n, 1, 'a second press with a new click id cannot execute again');
  assert.equal((await meeting.env.CONSUMER_DB.prepare(
    'SELECT stage FROM consumer_sessions WHERE id = ?'
  ).bind(meeting.sessionId).first()).stage, 'results', 'a duplicate press cannot regress the result stage');
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

  // A FAILED PASS LEAVES AN OUTSTANDING OBLIGATION, AND THE SEAL WAITS FOR IT.
  //
  // The stale snapshot cannot be published while that obligation stands, and
  // the next readiness read retries the pass exactly once before deciding.
  let sealedAfterFailure = null;
  await failedSimulator.turn({
    clientText: 'Are we ready now?',
    act: async ({ callTool }) => {
      const refreshed = await callTool('get_state', {});
      sealedAfterFailure = refreshed.result;
      return { speech: 'Here is where we are.' };
    }
  });
  await settle(failedRig.durable, failedRig.session);
  assert.deepEqual(failedRig.session.directModulePlanningOutstanding, []);
  assert.ok(failedRig.session.directAwaitingConfirmationSnapshotRevision);
  assert.equal(sealedAfterFailure?.reviewPublished, true,
    'the recovered pass seals, and only then');
  const recovered = await describeCurrentReview(failedMeeting.env, failedMeeting.sessionId);
  assert.ok(recovered.review?.reviewId, 'a review exists only after the failed pass was retried');
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

  // A bare goal has no child facts. The real state/steering path must carry
  // the planner's open question, and verification must wait for the answer.
  collegeReplay = 'intake';
  const intakeMeeting = await newLiveMeeting('direct-module-college-intake', {
    CONSUMER_MODULE_PLANNER_MODE: 'apply', OPENAI_API_KEY: 'synthetic-test-key'
  });
  const intakeRig = await attachLiveSession(intakeMeeting);
  const intakeSimulator = new LiveProviderSimulator(intakeRig);
  const verificationsBeforeIntake = verificationCalls;
  let intakeState;
  await intakeSimulator.turn({
    clientText: 'Planning for future college costs.',
    act: async ({ callTool }) => {
      intakeState = (await callTool('get_state', {})).result;
      return { speech: intakeState.modules[0].missing[0].question };
    }
  });
  await settle(intakeRig.durable, intakeRig.session);
  assert.equal(intakeState.ok, true);
  assert.equal(intakeState.readyToConfirm, false);
  assert.equal(intakeState.reviewPublished, false, 'an incomplete plan publishes no review');
  assert.equal(intakeState.modules[0].status, 'collecting');
  assert.equal(intakeState.modules[0].missing[0].question, COLLEGE_INTAKE_QUESTION);
  assert.equal(verificationCalls, verificationsBeforeIntake);
  assert.ok(intakeRig.provider.stateItems().some((item) => item.includes(COLLEGE_INTAKE_QUESTION)),
    'the missing-input question must reach Realtime volatile steering as well as get_state');
  const intakeBrief = (await getLatestRealtimeMeetingBrief(
    intakeMeeting.env, intakeMeeting.sessionId, intakeMeeting.meetingId
  )).brief;
  assert.equal(intakeBrief.verificationCertificate, null);
  assert.equal(intakeBrief.directModuleSnapshot.modules
    .find((item) => item.moduleId === 'college_funding').input.childrenCount, undefined);

  await intakeSimulator.turn({
    clientText: COLLEGE_TURN,
    act: async ({ callTool }) => {
      const state = (await callTool('get_state', {})).result;
      assert.equal(state.readyToConfirm, true);
      assert.equal(state.verificationStatus, 'pass');
      assert.equal(state.reviewPublished, true);
      return { speech: 'Here is the plan on screen for you.' };
    }
  });
  await settle(intakeRig.durable, intakeRig.session);
  const intakeReview = await describeCurrentReview(intakeMeeting.env, intakeMeeting.sessionId);
  assert.ok(intakeReview.review?.reviewId);
  const intakeRun = await executeReviewRun(intakeMeeting.env, intakeMeeting.config, {
    sessionId: intakeMeeting.sessionId, reviewId: intakeReview.review.reviewId, clickId: 'college_click'
  });
  assert.equal(intakeRun.ok, true, intakeRun.code || '');
  assert.equal(intakeRun.analysisPlan?.status, 'complete');
  pass('college goal selection delivers missing-input intake; supplied child facts then verify, seal and run');

  /* ------------- the production stall, over the real Durable Object --------- */

  // Selecting a module is not the same as being able to run one, and the second
  // turn is where the first production call died: the planner preserved the
  // input the snapshot had shown it, that input was the engine's derived
  // expansion, and provenance refused every pass from then on. Nothing
  // advanced, so `readyForOffer` -- which requires an empty outstanding queue --
  // could never be true, and Planéir told the client the planner had not given
  // it a confirmation prompt. Here the same conversation must reach a
  // confirmation instead.
  collegeReplay = true;
  const collegeMeeting = await newLiveMeeting('direct-module-production-college', {
    CONSUMER_MODULE_PLANNER_MODE: 'apply',
    OPENAI_API_KEY: 'synthetic-test-key'
  });
  const collegeRig = await attachLiveSession(collegeMeeting);
  const collegeSimulator = new LiveProviderSimulator(collegeRig);
  await collegeSimulator.turn({
    clientText: COLLEGE_TURN,
    act: async () => ({ speech: 'Congratulations. Let us look at what college could cost for them.' })
  });
  await settle(collegeRig.durable, collegeRig.session);
  const firstBrief = await getLatestRealtimeMeetingBrief(
    collegeMeeting.env,
    collegeMeeting.sessionId,
    collegeMeeting.meetingId
  );
  assert.equal(firstBrief.brief.snapshotRevision, 1);
  assert.equal(firstBrief.brief.readyToConfirm, true);

  // The turn that used to poison every pass after it.
  await collegeSimulator.turn({
    clientText: 'Planning for future college costs.',
    act: async () => ({ speech: 'Good, we will keep this on the college side.' })
  });
  await settle(collegeRig.durable, collegeRig.session);

  const failures = (await collegeMeeting.env.CONSUMER_DB.prepare(`
    SELECT event_type FROM consumer_realtime_events
    WHERE realtime_session_id = ? AND event_type = 'live.modules.planning_failed'
  `).bind(collegeMeeting.meetingId).all()).results || [];
  assert.equal(failures.length, 0,
    'preserving the previous input must not refuse the pass that carries the conversation');
  assert.deepEqual(collegeRig.session.directModulePlanningOutstanding, [],
    'an outstanding queue that never drains is what makes confirmation unreachable');

  const secondBrief = await getLatestRealtimeMeetingBrief(
    collegeMeeting.env,
    collegeMeeting.sessionId,
    collegeMeeting.meetingId
  );
  assert.equal(secondBrief.brief.snapshotRevision, 2,
    'the snapshot must advance with the conversation, not freeze at the last good turn');
  assert.equal(secondBrief.brief.readyToConfirm, true);

  await collegeSimulator.turn({
    clientText: 'Is it ready now?',
    act: async ({ callTool }) => {
      const state = await callTool('get_state', {});
      assert.equal(state.result?.ok, true,
        'a state read that answered is a state read that succeeded');
      assert.equal(state.result?.readyToConfirm, true);
      return { speech: 'Here is the plan on screen for you.' };
    }
  });
  await settle(collegeRig.durable, collegeRig.session);
  const collegeReview = await describeCurrentReview(collegeMeeting.env, collegeMeeting.sessionId);
  assert.ok(collegeReview.review?.reviewId,
    'ready plus verified must reliably become a published review');

  const collegeAttempts = (await collegeMeeting.env.CONSUMER_DB.prepare(`
    SELECT status, error_code FROM consumer_realtime_tool_attempts
    WHERE realtime_session_id = ? AND tool_name = 'get_state'
  `).bind(collegeMeeting.meetingId).all()).results || [];
  assert.ok(collegeAttempts.length > 0);
  assert.ok(collegeAttempts.every((row) => row.status === 'succeeded' && !row.error_code),
    'every production state read was recorded as rejected, which is how the diagnosis started in the wrong place');

  const collegeRun = await executeReviewRun(collegeMeeting.env, collegeMeeting.config, {
    sessionId: collegeMeeting.sessionId, reviewId: collegeReview.review.reviewId, clickId: 'college_live_click'
  });
  assert.equal(collegeRun?.ok, true, collegeRun?.code || '');
  assert.equal(collegeRun?.analysisPlan?.status, 'complete');
  collegeReplay = false;
  pass('the production college call reaches a review instead of stalling on its own previous input');
} finally {
  globalThis.fetch = originalFetch;
}

console.info('[DirectModuleLivePath] Complete direct-module live call passed.');
