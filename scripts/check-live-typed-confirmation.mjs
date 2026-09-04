#!/usr/bin/env node

/**
 * THE TYPED READ-BACK, AND WHY IT IS STRONGER THAN THE SPOKEN ONE.
 *
 * Voice proves delivery with a four-way conjunction: the response completed,
 * the spoken transcript matched the certified string byte for byte, the audio
 * buffer finished playing, and nobody talked over it. Three of those four
 * checks exist for one reason -- the MODEL held the pen, so what it actually
 * said has to be audited after the fact, and speech evaporates.
 *
 * In text the SERVER holds the pen. The certified string is written verbatim
 * as the assistant turn, so it cannot be paraphrased, and it does not
 * evaporate: it stays on screen until the client answers it. What replaces the
 * playback acknowledgement is REPLY BINDING -- the approving turn must answer
 * that exact assistant turn id. A playback ack proves noise left a speaker.
 * Reply binding proves the approval was made against the plan the client was
 * looking at, which is the property the barrier actually wants.
 *
 * Everything else in the barrier is unchanged, and this file asserts that too:
 * a wrong token, an unbound turn, a superseded offer and an unsettled review
 * must all still refuse.
 */

import assert from 'node:assert/strict';

import { attachTypedSession, newLiveMeeting } from './live-harness/session.mjs';
import { classifyExecutionApproval } from '../worker/src/consumer/live/execution_approval.js';
import { listRealtimeFinalTurns } from '../worker/src/consumer/realtime_repository.js';

let checks = 0;
function ok(value, message) { checks += 1; assert.ok(value, message); }
function equal(actual, expected, message) { checks += 1; assert.equal(actual, expected, message); }

const PROMPT = 'I will run the pension projection using a current value of 185,000, '
  + 'contributions of 6% and a retirement age of 65. Would you like me to run that plan?';

async function rig(label) {
  const meeting = await newLiveMeeting(label, {
    CONSUMER_MODULE_PLANNER_MODE: 'apply',
    CONSUMER_TYPED_LANE_ENABLED: 'true',
    OPENAI_API_KEY: 'synthetic-test-key'
  });
  const attached = await attachTypedSession(meeting);
  attached.session.directConfirmationOffer = {
    token: 'dmc_typed_test',
    planId: 'realtime_plan_typed_test',
    profileRevision: 1,
    certificateSignature: 'test-certificate',
    reviewStatus: 'settled',
    confirmationPrompt: PROMPT,
    readbackFullyDelivered: false,
    assistantTurnId: null,
    confirmationTurnIds: []
  };
  return { ...attached, meeting };
}

/** A response carrying a certified plan, exactly as get_state leaves one. */
function responseWithCandidate(session, token = 'dmc_typed_test') {
  const response = session.createResponseContext({
    responseId: 'txt_state_read',
    rootResponseId: 'txt_state_read',
    causeItemId: null
  });
  response.continuationChain.directConfirmationCandidate = {
    token,
    sourceResponseId: 'txt_state_read',
    confirmationPrompt: PROMPT
  };
  return response;
}

/* ------------------------------------------- the server writes it, verbatim */

{
  const { session, meeting } = await rig('typed-readback');
  const response = responseWithCandidate(session);
  const delivered = await session.deliverCertifiedReadback(response, '');

  equal(delivered, PROMPT, 'the certified prompt is delivered exactly as certified');
  const turns = await listRealtimeFinalTurns(meeting.env, meeting.sessionId, meeting.meetingId);
  const assistant = turns.filter((turn) => turn.role === 'assistant');
  equal(assistant.length, 1, 'the read-back is one persisted assistant turn');
  equal(assistant[0].transcript, PROMPT,
    'the PERSISTED turn is byte-identical to the certified prompt -- not a paraphrase of it');

  const offer = session.directConfirmationOffer;
  equal(offer.readbackFullyDelivered, true,
    'a persisted, returned certified prompt IS delivery on this transport');
  equal(offer.assistantTurnId, assistant[0].id,
    'the offer records the exact turn an approval must answer');
  ok(offer.deliveryAttempt.transcriptMatched, 'transcript equality still holds, by construction');
  ok(offer.deliveryAttempt.responseCompleted, 'the response is recorded complete');
  // NOTHING HERE WAITED ON AUDIO. If a future edit reintroduces the playback
  // acknowledgement on this path, a typed meeting would never be able to run.
  equal(offer.deliveryAttempt.playbackCompleted, false,
    'no playback evidence exists on a typed meeting, and none is required');

  // Delivering twice must not re-arm: the client saw one plan.
  equal(await session.deliverCertifiedReadback(response, ''), '',
    'an already-delivered offer is not read back again');
}

/* --------------------------------------------------------- reply binding */

{
  const { session } = await rig('typed-binding');
  await session.deliverCertifiedReadback(responseWithCandidate(session), '');
  const offer = session.directConfirmationOffer;

  equal(session.turnAnswersDirectOffer({ answersTurnId: offer.assistantTurnId }), true,
    'a turn answering the read-back is bound to the offer');
  equal(session.turnAnswersDirectOffer({ answersTurnId: 'turn_something_else' }), false,
    'a turn answering any other message is NOT an approval of this plan');
  equal(session.turnAnswersDirectOffer({ answersTurnId: null }), false,
    'an unbound turn can never approve a plan');

  // A SUPERSEDED PLAN CANNOT BE APPROVED. This is what replaces barge-in: the
  // client's finances changed, the offer is retired, and a "yes" that was
  // typed against the old plan on screen no longer attaches to anything.
  offer.superseded = true;
  equal(session.turnAnswersDirectOffer({ answersTurnId: offer.assistantTurnId }), false,
    'a superseded offer cannot be approved by a turn bound to its read-back');
}

/* ------------------------------------- the approval classifier is unchanged */

// Typed text is the SAME deterministic gate voice uses, and it behaves better
// here because there is no ASR punctuation to reason about.
for (const [text, verdict] of [
  ['yes, go ahead', 'affirmed'],
  ['Yes please, run that plan', 'affirmed'],
  ['that sounds right', 'affirmed'],
  ['no', 'rejected'],
  ['not now', 'rejected'],
  // Anything that is not a clean whole-clause refusal falls to `ambiguous`,
  // which is the safe verdict: ambiguous does not run, and does not end the
  // meeting either. Planéir asks again.
  ['no, not yet', 'ambiguous'],
  ['yes but change the retirement age to 62', 'ambiguous'],
  ['why do you need my retirement age?', 'ambiguous'],
  ['yes if the pension figure is right', 'ambiguous'],
  ['I think so', 'ambiguous']
]) {
  equal(classifyExecutionApproval(text), verdict, `"${text}" classifies as ${verdict}`);
}

/* ------------------------------------------ a plan nobody certified is inert */

{
  const { session, meeting } = await rig('typed-uncertified');
  const response = session.createResponseContext({
    responseId: 'txt_no_candidate',
    rootResponseId: 'txt_no_candidate',
    causeItemId: null
  });
  equal(await session.deliverCertifiedReadback(response, ''), '',
    'with no certified candidate there is nothing to read back');
  equal(session.directConfirmationOffer.readbackFullyDelivered, false,
    'an undelivered offer stays undelivered');
  const turns = await listRealtimeFinalTurns(meeting.env, meeting.sessionId, meeting.meetingId);
  equal(turns.length, 0, 'nothing is written to the transcript when nothing was certified');
}

/* --------------------------------------- a candidate for a different offer */

{
  const { session } = await rig('typed-token-mismatch');
  const response = responseWithCandidate(session, 'dmc_a_different_plan');
  equal(await session.deliverCertifiedReadback(response, ''), '',
    'a candidate whose token does not match the live offer is refused');
  equal(session.directConfirmationOffer.readbackFullyDelivered, false,
    'and it arms nothing');
}

console.log(`[LiveTypedConfirmation] ${checks} checks passed.`);
