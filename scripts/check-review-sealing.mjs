#!/usr/bin/env node

/**
 * THE HARD REVIEW BOUNDARY: WHETHER A REVIEW WAS ENTITLED TO EXIST.
 *
 * check-review-protocol.mjs asks what can reach the engine. This file asks the
 * question before it: given input this meeting ACCEPTED, may it publish a
 * review at all?
 *
 * The property under test is one sentence: REVIEW cannot become available while
 * previously accepted client input can still alter the proposal. Every case
 * below is a way that could go wrong -- a transcript still in flight, a
 * transcription that failed, a process that died mid-seal -- and in every one
 * the required outcome is the same: no review, and therefore no execution.
 *
 * NOTHING HERE INSPECTS WHAT THE CLIENT SAID. The blockers are work-accounting
 * facts. A test that had to know whether an utterance "mattered" would be
 * testing the architecture this replaced.
 */

import assert from 'node:assert/strict';

import {
  OPENING,
  newReviewMeeting,
  reachReviewByTyping,
  reachReviewBySpeaking,
  scriptPlanner
} from './live-harness/review.mjs';
import { attachLiveSession, attachTypedSession, settle } from './live-harness/session.mjs';
import { LiveProviderSimulator } from './live-harness/provider.mjs';
import { listRealtimeFinalTurns } from '../worker/src/consumer/realtime_repository.js';
import {
  beginSealing,
  describeCurrentReview,
  executeReviewRun,
  currentInputMode,
  readReviewControl,
  revokeReview
} from '../worker/src/consumer/review.js';

let checks = 0;
function ok(value, message) { checks += 1; assert.ok(value, message); }
function equal(actual, expected, message) { checks += 1; assert.equal(actual, expected, message); }

async function engineRuns(meeting) {
  const row = await meeting.env.CONSUMER_DB
    .prepare('SELECT COUNT(*) AS n FROM consumer_analysis_runs WHERE session_id = ?')
    .bind(meeting.sessionId).first();
  return Number(row.n);
}

async function executableReviews(meeting) {
  const row = await meeting.env.CONSUMER_DB
    .prepare("SELECT COUNT(*) AS n FROM consumer_reviews WHERE session_id = ? AND state = 'review'")
    .bind(meeting.sessionId).first();
  return Number(row.n);
}

const restore = scriptPlanner();
try {

/* =================================================================== 15, 17
 * SPEECH ACCEPTED IMMEDIATELY BEFORE THE SEAL IS ACCOUNTED FOR.
 *
 * The provider has taken the audio and issued its item id. Its transcript has
 * not arrived. This is the exact window a microphone button cannot cover, and
 * the one an empty in-memory queue looks identical to. */
{
  const meeting = await newReviewMeeting('pre-seal-speech');
  const rig = await attachLiveSession(meeting);
  const simulator = new LiveProviderSimulator(rig);
  await simulator.turn({ clientText: OPENING, act: async () => ({ speech: 'Noted.' }) });
  await settle(rig.durable, rig.session);

  // Audio accepted. No transcript yet.
  await rig.session.handleProviderMessage(JSON.stringify({
    type: 'input_audio_buffer.speech_stopped', item_id: 'item_in_flight'
  }));
  ok(rig.session.sealBlockers().includes('input_pending'),
    'accepted-but-untranscribed audio blocks the seal');
  ok(rig.session.speechCaptureOpen, 'and the durable capture guard is set');

  // THE READINESS READ CANNOT EVEN ANSWER YET.
  //
  // get_state is the tool that seals. Bound to a response whose causal turn is
  // still being transcribed, it is DEFERRED rather than answered from state
  // that predates the sentence -- so readiness cannot be established, let alone
  // published, while that audio is outstanding.
  const response = rig.session.createResponseContext({
    responseId: 'resp_pre_seal', rootResponseId: 'resp_pre_seal', causeItemId: 'item_in_flight'
  });
  await rig.session.handleToolCall({
    name: 'get_state', call_id: 'call_pre_seal', response_id: response.responseId, arguments: '{}'
  });
  equal(rig.session.deferredEvidenceToolCallIds.has('call_pre_seal'), true,
    'the readiness read is deferred behind the audio already accepted');
  equal(await executableReviews(meeting), 0, 'no executable review exists');
  equal((await currentInputMode(meeting.env, meeting.sessionId)).mode, 'conversation',
    'and the conversation stayed open rather than being left half-sealed');

  // The pre-seal transcript lands. It is processed normally -- NOT relabelled
  // as rejected because ASR was slow -- and the deferred read resumes.
  await rig.session.handleProviderMessage(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_in_flight',
    transcript: 'Actually the balance is 250,000 euro.'
  }));
  await settle(rig.durable, rig.session);
  equal(rig.session.sealBlockers().length, 0, 'the obligation is discharged once its meaning is known');

  const turns = await listRealtimeFinalTurns(meeting.env, meeting.sessionId, meeting.meetingId);
  ok(turns.some((turn) => turn.role === 'user' && String(turn.transcript).includes('250,000')),
    'the pre-seal correction became a real turn the planner can see');

  // AND ONLY THEN DOES THE DEFERRED READ SEAL.
  //
  // The same readiness read that could not answer a moment ago resumed once its
  // input settled, and sealed from a state that includes the correction. The
  // ordering is the property: the review exists BECAUSE the outstanding input
  // was accounted for, not in spite of it.
  const sealed = await describeCurrentReview(meeting.env, meeting.sessionId);
  equal(sealed.mode, 'review', 'the meeting sealed after the outstanding input settled');
  equal(await executableReviews(meeting), 1, 'exactly one executable review');
  ok(sealed.review.presentation.summary.length > 0, 'with a certified summary to inspect');
  void simulator;
}

/* =================================================================== 18
 * A FAILED TRANSCRIPTION IS UNKNOWN MEANING, NOT SILENCE. */
{
  const meeting = await newReviewMeeting('failed-transcription');
  const rig = await attachLiveSession(meeting);
  const simulator = new LiveProviderSimulator(rig);
  await simulator.turn({ clientText: OPENING, act: async () => ({ speech: 'Noted.' }) });
  await settle(rig.durable, rig.session);

  await rig.session.handleProviderMessage(JSON.stringify({
    type: 'input_audio_buffer.speech_stopped', item_id: 'item_lost'
  }));
  await rig.session.handleProviderMessage(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.failed', item_id: 'item_lost'
  }));
  await settle(rig.durable, rig.session);

  ok(rig.session.sealBlockers().includes('transcription_failed'),
    'a failed transcription blocks the seal');
  let state;
  await simulator.turn({
    clientText: 'Is that everything?',
    act: async ({ callTool }) => { state = (await callTool('get_state', {})).result; return { speech: 'Here it is.' }; }
  });
  await settle(rig.durable, rig.session);
  equal(state.reviewPublished, false, 'no review is published over speech whose meaning was lost');
  equal(await executableReviews(meeting), 0, 'and there is nothing executable');
  equal(await engineRuns(meeting), 0, 'nothing ran');

  // AND IT DOES NOT CLEAR ITSELF. A later turn does not make the lost one
  // harmless; only knowing what was said could, and nothing here can.
  await simulator.turn({ clientText: 'Anything else?', act: async () => ({ speech: 'Not yet.' }) });
  await settle(rig.durable, rig.session);
  ok(rig.session.sealBlockers().includes('transcription_failed'),
    'and a later turn does not retire the unknown one');
}

/* =================================================================== 16
 * INPUT ARRIVING AFTER ADMISSION CLOSES IS REJECTED, NOT ABSORBED. */
{
  const meeting = await newReviewMeeting('closed-admission');
  const rig = await attachTypedSession(meeting);
  await rig.session.handleTextMessage({ text: OPENING });
  await settle(rig.durable, rig.session);
  const control = await readReviewControl(meeting.env, meeting.sessionId);
  equal(control.mode, 'review', 'the typed meeting sealed');

  // REVIEW: an explicit refusal.
  await assert.rejects(
    () => rig.session.handleTextMessage({ text: 'One more thing — my rate is 3.9%.' }),
    (error) => error.code === 'review_input_closed',
    'typed input after admission closes is REJECTED'
  );
  checks += 1;

  // SEALING: the same refusal, mid-seal. A message accepted here would be one
  // the seal had already finished accounting for.
  const sealingControl = await readReviewControl(meeting.env, meeting.sessionId);
  void sealingControl;
  const fresh = await newReviewMeeting('closed-admission-sealing');
  const freshRig = await attachTypedSession(fresh);
  const started = await beginSealing(fresh.env, fresh.sessionId,
    (await (await import('../worker/src/consumer/review.js')).ensureReviewControl(fresh.env, fresh.sessionId)).stateVersion);
  ok(started, 'the meeting entered SEALING');
  await assert.rejects(
    () => freshRig.session.handleTextMessage({ text: 'Wait, one correction.' }),
    (error) => error.code === 'review_input_closed',
    'typed input during SEALING is REJECTED too'
  );
  checks += 1;
  const stored = await listRealtimeFinalTurns(fresh.env, fresh.sessionId, fresh.meetingId);
  equal(stored.filter((turn) => turn.role === 'user').length, 0,
    'the refused message was never accepted as a turn');
}

/* =================================================================== 19
 * RECONSTRUCTION DURING SEALING CANNOT LOSE UNRESOLVED WORK.
 *
 * This is the counterexample the durable ledger exists for: the process dies
 * after accepting speech and before persisting its turn. An in-memory queue
 * comes back empty, and an empty queue is indistinguishable from a settled one
 * unless the obligation itself was durable. */
{
  const meeting = await newReviewMeeting('reconstruct-sealing');
  const rig = await attachLiveSession(meeting);
  const simulator = new LiveProviderSimulator(rig);
  await simulator.turn({ clientText: OPENING, act: async () => ({ speech: 'Noted.' }) });
  await settle(rig.durable, rig.session);

  await rig.session.handleProviderMessage(JSON.stringify({
    type: 'input_audio_buffer.speech_stopped', item_id: 'item_lost_to_crash'
  }));
  // The process dies here. Everything in memory is gone.
  const rebuilt = await attachLiveSession(meeting, { initial: Object.fromEntries(rig.durable.values) });
  ok(rebuilt.session.admittedInput.has('item_lost_to_crash'),
    'the reconstructed meeting still knows it accepted that audio');
  ok(rebuilt.session.speechCaptureOpen, 'and that its capture guard is still open');
  ok(rebuilt.session.sealBlockers().includes('input_pending'),
    'so it cannot seal from an empty reconstructed queue');
  equal(await executableReviews(meeting), 0, 'no review was invented from that state');

  // A ledger storage cannot answer for is not an empty ledger.
  const uncertain = await attachLiveSession(meeting, { initial: Object.fromEntries(rig.durable.values) });
  uncertain.session.reconstructionUncertain = true;
  ok(uncertain.session.sealBlockers().includes('state_uncertain'),
    'a meeting that cannot say what it accepted refuses to seal');
}

/* ============================= an old epoch's transcript is not a new turn
 * THE COUNTEREXAMPLE: the provider redelivers a transcript for audio accepted
 * before a revocation, after the conversation has reopened. The turn ledger it
 * belonged to is gone -- the meeting was reconstructed -- but the durable
 * admission record survives, and it remembers which epoch accepted it.
 *
 * Without the epoch it would arrive looking exactly like fresh speech and be
 * folded into a conversation it was never part of. */
{
  const meeting = await newReviewMeeting('stale-epoch');
  const rig = await attachLiveSession(meeting);
  const simulator = new LiveProviderSimulator(rig);
  await simulator.turn({ clientText: OPENING, act: async () => ({ speech: 'Noted.' }) });
  await settle(rig.durable, rig.session);

  // Audio accepted in the epoch that is about to end.
  await rig.session.handleProviderMessage(JSON.stringify({
    type: 'input_audio_buffer.speech_stopped', item_id: 'item_old_epoch'
  }));
  await rig.session.handleProviderMessage(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_old_epoch', transcript: 'My rate is 3.9%.'
  }));
  await settle(rig.durable, rig.session);

  let state;
  await simulator.turn({
    clientText: 'Is that everything?',
    act: async ({ callTool }) => { state = (await callTool('get_state', {})).result; return { speech: 'Here it is.' }; }
  });
  await settle(rig.durable, rig.session);
  equal(state.reviewPublished, true, 'the meeting sealed');
  const reviewId = (await describeCurrentReview(meeting.env, meeting.sessionId)).review.reviewId;

  const revoked = await revokeReview(meeting.env, { sessionId: meeting.sessionId, reviewId });
  equal(revoked.ok, true, 'Make a change reopened the conversation');
  equal(revoked.inputEpoch, 1, 'on a new input epoch');

  // The meeting is reconstructed: the in-memory turn ledger is gone, the
  // durable admission record is not.
  const rebuilt = await attachLiveSession(meeting, { initial: Object.fromEntries(rig.durable.values) });
  equal(rebuilt.session.clientTurnsByItemId.has('item_old_epoch'), false,
    'the reconstructed meeting has no in-memory turn for that item');
  equal(rebuilt.session.admittedInput.get('item_old_epoch')?.epoch, 0,
    'but it still knows which epoch accepted it');

  // WHAT "CANNOT BECOME A TURN" HAS TO MEAN, MEASURABLY.
  //
  // Not "no row appeared" -- the turn table already refuses a duplicate item id
  // on its own, so that assertion would pass with every fence removed. It means
  // the transcript did not become the conversation's latest word and did not
  // create planning work, which is the whole of what a turn does here.
  const beforeTranscript = rebuilt.session.latestClientTranscript;
  const beforeObligations = rebuilt.session.directModulePlanningOutstanding.length;
  await rebuilt.session.handleClientTurn({
    item_id: 'item_old_epoch', transcript: 'My rate is 3.9%.'
  });
  await settle(rebuilt.durable, rebuilt.session);
  equal(rebuilt.session.latestClientTranscript, beforeTranscript,
    "an old epoch's transcript does not become the conversation's latest word");
  equal(rebuilt.session.directModulePlanningOutstanding.length, beforeObligations,
    'and creates no planning obligation in the reopened conversation');
}

/* ======================== speech into a closed microphone stays refused
 * THE HARDER HALF OF THE SAME COUNTEREXAMPLE.
 *
 * Audio spoken while the review was on screen is refused when it arrives. Its
 * TRANSCRIPT lands later, and by then the client may have pressed Make a
 * change and reopened the conversation. Nothing about that transcript says it
 * was spoken to a microphone that was not listening -- unless the refusal was
 * recorded when it happened. */
{
  const meeting = await newReviewMeeting('rejected-then-reopened');
  const rig = await attachLiveSession(meeting);
  const simulator = new LiveProviderSimulator(rig);
  await simulator.turn({ clientText: OPENING, act: async () => ({ speech: 'Noted.' }) });
  await settle(rig.durable, rig.session);
  let state;
  await simulator.turn({
    clientText: 'Is that everything?',
    act: async ({ callTool }) => { state = (await callTool('get_state', {})).result; return { speech: 'Here it is.' }; }
  });
  await settle(rig.durable, rig.session);
  equal(state.reviewPublished, true, 'the meeting sealed');
  const reviewId = (await describeCurrentReview(meeting.env, meeting.sessionId)).review.reviewId;

  // The client talks at the review screen. The audio is refused on arrival.
  await rig.session.handleProviderMessage(JSON.stringify({
    type: 'input_audio_buffer.speech_stopped', item_id: 'item_spoken_at_review'
  }));
  await settle(rig.durable, rig.session);
  equal(rig.session.admittedInput.get('item_spoken_at_review')?.status, 'rejected',
    'the refusal is recorded, not merely performed');
  equal(rig.session.speechCaptureOpen, false,
    'and a refused item never opens a capture obligation the seal would wait on');

  ok((await revokeReview(meeting.env, { sessionId: meeting.sessionId, reviewId })).ok,
    'the client then chooses Make a change');

  const beforeTranscript = rig.session.latestClientTranscript;
  const beforeObligations = rig.session.directModulePlanningOutstanding.length;
  await rig.session.handleClientTurn({
    item_id: 'item_spoken_at_review', transcript: 'Actually make it 30 years.'
  });
  await settle(rig.durable, rig.session);
  equal(rig.session.latestClientTranscript, beforeTranscript,
    'speech refused during REVIEW does not become the latest word once conversation reopens');
  equal(rig.session.directModulePlanningOutstanding.length, beforeObligations,
    'and creates no planning obligation');
  equal(rig.session.admittedInput.get('item_spoken_at_review')?.status, 'rejected',
    'and stays refused');
}

/* ================== a refusal holds even when the epoch never moved
 * RUN DOES NOT ADVANCE THE INPUT EPOCH -- it has no reason to, because the
 * conversation never reopens. So for speech refused during REVIEW and
 * transcribed after Run wins, the epoch fence has nothing to compare and the
 * recorded refusal is the only thing standing between that audio and the
 * conversation. */
{
  const meeting = await newReviewMeeting('rejected-then-running');
  const rig = await attachLiveSession(meeting);
  const simulator = new LiveProviderSimulator(rig);
  await simulator.turn({ clientText: OPENING, act: async () => ({ speech: 'Noted.' }) });
  await settle(rig.durable, rig.session);
  await simulator.turn({
    clientText: 'Is that everything?',
    act: async ({ callTool }) => { await callTool('get_state', {}); return { speech: 'Here it is.' }; }
  });
  await settle(rig.durable, rig.session);
  const reviewId = (await describeCurrentReview(meeting.env, meeting.sessionId)).review.reviewId;

  await rig.session.handleProviderMessage(JSON.stringify({
    type: 'input_audio_buffer.speech_stopped', item_id: 'item_spoken_before_run'
  }));
  await settle(rig.durable, rig.session);
  const epochBefore = (await readReviewControl(meeting.env, meeting.sessionId)).inputEpoch;

  const run = await executeReviewRun(meeting.env, meeting.config, {
    sessionId: meeting.sessionId, reviewId, clickId: 'ran_before_transcript'
  });
  equal(run.ok, true, `the client pressed Run: ${run.code || ''}`);
  const control = await readReviewControl(meeting.env, meeting.sessionId);
  equal(control.mode, 'running', 'the conversation stays closed');
  equal(control.inputEpoch, epochBefore,
    'and Run does not advance the epoch, so the fence has nothing to catch this with');

  const beforeTranscript = rig.session.latestClientTranscript;
  await rig.session.handleClientTurn({
    item_id: 'item_spoken_before_run', transcript: 'Wait, stop, do not run it.'
  });
  await settle(rig.durable, rig.session);
  equal(rig.session.latestClientTranscript, beforeTranscript,
    'the recorded refusal alone keeps that speech out of the conversation');
  equal(await engineRuns(meeting), 1,
    'and a conversational event after a valid execution cannot retroactively invalidate it');
}

/* =================================================================== 29
 * TYPE POSITIVE CONTROL: reaches REVIEW and executes normally. */
{
  const { meeting, result } = await reachReviewByTyping('type-positive');
  ok(result.review?.reviewId, 'a typed meeting reaches REVIEW');
  ok(result.review.presentation?.summary, 'with the certified summary to inspect');
  ok(result.review.presentation.modules.length > 0, 'and the analyses it will run');
  const shown = await describeCurrentReview(meeting.env, meeting.sessionId);
  equal(shown.review.reviewId, result.review.reviewId,
    'the review the turn returned is the review the server holds');
  assert.deepEqual(shown.review.actions, ['run', 'change'], 'with exactly two actions');
  checks += 1;

  const run = await executeReviewRun(meeting.env, meeting.config, {
    sessionId: meeting.sessionId, reviewId: result.review.reviewId, clickId: 'typed_click'
  });
  equal(run.ok, true, `the typed review runs: ${run.code || ''}`);
  equal(await engineRuns(meeting), 1, 'exactly one execution');
  ok(run.result.speakableText.length > 0, 'and produced a deterministic result');
}

/* =================================================================== 30
 * SPEAK POSITIVE CONTROL: reaches REVIEW and executes normally. */
{
  const { meeting, state } = await reachReviewBySpeaking('speak-positive');
  equal(state.reviewPublished, true, 'a spoken meeting reaches REVIEW');
  const shown = await describeCurrentReview(meeting.env, meeting.sessionId);
  ok(shown.review?.reviewId, 'with a review to inspect');
  ok(shown.review.presentation.summary.includes('mortgage'),
    'whose summary describes the analysis that will actually run');

  const run = await executeReviewRun(meeting.env, meeting.config, {
    sessionId: meeting.sessionId, reviewId: shown.review.reviewId, clickId: 'spoken_click'
  });
  equal(run.ok, true, `the spoken review runs: ${run.code || ''}`);
  equal(await engineRuns(meeting), 1, 'exactly one execution');
}

console.info(`[ReviewSealing] ${checks} checks passed.`);
} finally {
  restore();
}
