#!/usr/bin/env node

/** Real coordinator delivery states and authenticated route, with no provider spend. */
import assert from 'node:assert/strict';
import { attachLiveSession, newLiveMeeting } from './live-harness/session.mjs';
import { makeConfig, makeEnv, newDatabase, realtimeTestEnv } from './agent-harness/transports.mjs';
import { createConsumerCredential, randomId, sha256Base64Url } from '../worker/src/consumer/crypto.js';
import {
  createSessionRecord, getCurrentProfile, getSessionRow, reserveConsumerProviderCost
} from '../worker/src/consumer/repository.js';
import { confirmPlanSelection } from '../worker/src/consumer/planning_turn.js';
import {
  createRealtimeLease, prepareRealtimeAnalysisPlan, setRealtimeConsent
} from '../worker/src/consumer/realtime_repository.js';
import { handleConsumerRequest } from '../worker/src/consumer/router.js';

let checks = 0;
function equal(actual, expected, message) {
  checks += 1;
  assert.deepEqual(actual, expected, message);
}
const PROMPT = 'I will run the mortgage analysis using the figures just reviewed. Would you like me to run that plan?';
async function rig() {
  const meeting = await newLiveMeeting('readback-delivery', { CONSUMER_MODULE_PLANNER_MODE: 'apply' });
  const attached = await attachLiveSession(meeting);
  attached.session.directConfirmationOffer = {
    token: 'dmc_delivery_test', planId: 'realtime_plan_delivery_test', profileRevision: 1,
    certificateSignature: 'test-certificate', reviewStatus: 'settled',
    confirmationPrompt: PROMPT, readbackFullyDelivered: false,
    assistantTurnId: null, confirmationTurnIds: []
  };
  return { ...attached, meeting };
}
function responseFor(session, responseId = 'resp_readback') {
  return {
    responseId, causeItemId: 'item_goal', done: false, status: 'in_progress',
    assistantDone: false, assistantTranscript: '', storedAssistantTurnId: null,
    toolCallIds: new Set(), complianceTripped: false,
    continuationChain: {
      invalidated: false,
      directConfirmationCandidate: {
        token: session.directConfirmationOffer.token,
        sourceResponseId: 'resp_state_tool', confirmationPrompt: PROMPT
      }
    }
  };
}
async function completeResponse(session, response) {
  Object.assign(response, {
    done: true, status: 'completed', assistantDone: true,
    assistantTranscript: PROMPT, storedAssistantTurnId: `turn_${response.responseId}`
  });
  return session.maybeArmDirectConfirmation(response);
}
const playback = (session, responseId, state = 'completed') => session.acknowledgeReadbackPlayback({
  responseId, eventId: `evt_${responseId}_${state}`, playback: state
});

// Generation, final transcript and actual playback are independent lifecycles.
for (const order of [
  ['done', 'transcript', 'playback'], ['done', 'playback', 'transcript'],
  ['transcript', 'done', 'playback'], ['transcript', 'playback', 'done'],
  ['playback', 'done', 'transcript'], ['playback', 'transcript', 'done']
]) {
  const { session, durable } = await rig();
  const response = responseFor(session);
  await session.beginDirectReadbackAttempt(response);
  for (const [index, part] of order.entries()) {
    if (part === 'done') Object.assign(response, { done: true, status: 'completed' });
    if (part === 'transcript') Object.assign(response, {
      assistantDone: true, assistantTranscript: PROMPT, storedAssistantTurnId: 'turn_delivered'
    });
    if (part === 'playback') await playback(session, response.responseId);
    await session.maybeArmDirectConfirmation(response);
    equal(session.directConfirmationOffer.readbackFullyDelivered, index === 2,
      `${order.join(' → ')} only all three observations establish delivery`);
  }
  equal(durable.values.get('directConfirmationOffer').readbackFullyDelivered, true, 'Delivery is durable');
}

{
  const { session } = await rig();
  const response = responseFor(session);
  await playback(session, response.responseId); // Browser beat sideband response.created.
  await session.beginDirectReadbackAttempt(response);
  equal(session.directConfirmationOffer.readbackFullyDelivered, false, 'An early ACK cannot certify its own speech');
  await completeResponse(session, response);
  equal(session.directConfirmationOffer.readbackFullyDelivered, true, 'Early browser ACK joins later matching response evidence');
}

for (const failure of ['cleared', 'cancelled', 'compliance', 'barge_in', 'wrong_transcript']) {
  const { session } = await rig();
  const response = responseFor(session);
  await session.beginDirectReadbackAttempt(response);
  if (failure === 'cleared') await playback(session, response.responseId, 'interrupted');
  if (failure === 'cancelled' || failure === 'compliance') {
    response.status = 'cancelled';
    response.complianceTripped = failure === 'compliance';
    await session.interruptDirectReadback(response.responseId);
  }
  if (failure === 'barge_in') {
    await session.handleProviderMessage(JSON.stringify({ type: 'output_audio_buffer.started', response_id: response.responseId }));
    await session.handleProviderMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  }
  if (failure === 'wrong_transcript') {
    Object.assign(response, {
      done: true, status: 'completed', assistantDone: true,
      storedAssistantTurnId: 'turn_wrong_readback',
      assistantTranscript: 'A different plan with an invented figure.'
    });
    await session.maybeArmDirectConfirmation(response);
  } else await completeResponse(session, response);
  await playback(session, response.responseId);
  equal(session.directConfirmationOffer.readbackFullyDelivered, false, `${failure} cannot be revived by a delayed normal-drain ACK`);
}

{
  const { session } = await rig();
  const first = responseFor(session, 'resp_interrupted');
  await session.beginDirectReadbackAttempt(first);
  await session.interruptDirectReadback(first.responseId);
  const second = responseFor(session, 'resp_retry');
  await session.beginDirectReadbackAttempt(second);
  await completeResponse(session, second);
  await playback(session, first.responseId);
  equal(session.directConfirmationOffer.readbackFullyDelivered, false, 'A superseded delivery ACK cannot finish a retry');
  await playback(session, second.responseId);
  equal(session.directConfirmationOffer.readbackFullyDelivered, true, 'A full retry can deliver the same frozen offer');
}

{
  const { session } = await rig();
  const response = responseFor(session);
  await session.beginDirectReadbackAttempt(response);
  await completeResponse(session, response);
  await playback(session, response.responseId);
  const original = structuredClone(session.directConfirmationOffer);
  session.clientTurnsByItemId.set('item_unclear', {
    confirmationOfferToken: original.token, answersTurnId: original.assistantTurnId
  });
  await session.maybeArmDirectConfirmation({
    causeItemId: 'item_unclear', done: true, status: 'completed', assistantDone: true,
    assistantTranscript: 'Would you like me to run that plan?', storedAssistantTurnId: 'turn_clarification'
  });
  equal(session.turnAnswersDirectOffer({ answersTurnId: 'turn_clarification' }), true, 'Clarification answers refer to the original offer');
  equal(session.directConfirmationOffer.token, original.token, 'Clarification preserves the token');
  equal(session.directConfirmationOffer.deliveryAttempt, original.deliveryAttempt, 'Clarification does not manufacture new read-back evidence');
}

{
  const { session, durable } = await rig();
  const response = responseFor(session);
  await session.beginDirectReadbackAttempt(response);
  await completeResponse(session, response);
  // Fallback topology: sideband has no output buffer events. The browser has
  // drained the read-back, but its authenticated ACK is still in flight when
  // the natural approval reaches the sideband.
  await session.handleProviderMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  equal(session.directConfirmationOffer.deliveryAttempt.interrupted, false, 'Missing sideband output events do not invent a barge-in');
  session.clientTurnsByItemId.set('item_approval', { answersTurnId: session.directConfirmationOffer.assistantTurnId });
  session.responseContextsById.set('resp_approval', { causeItemId: 'item_approval' });
  const event = {
    name: 'confirm_and_run', call_id: 'call_once', response_id: 'resp_approval',
    arguments: JSON.stringify({ confirmationToken: session.directConfirmationOffer.token })
  };
  await session.executeToolCallWithTranscript(event, 'Grand, go ahead');
  equal(session.pendingDirectApprovals.size, 1, 'The same natural approval waits for its delayed playback ACK');
  let resumed = 0;
  session.executeToolCallWithTranscript = async (actualEvent, actualTranscript) => {
    equal(actualEvent, event, 'The original tool identity resumes');
    equal(actualTranscript, 'Grand, go ahead', 'The original approval evidence resumes');
    resumed += 1;
  };
  await playback(session, response.responseId);
  await Promise.all(durable.waitUntilPromises);
  await playback(session, response.responseId);
  equal(resumed, 1, 'Duplicate delivery ACKs do not duplicate the approval');
}

// A concurrent loser may have read 'prepared' before the winning execution.
// The production D1 batch must then leave the winner's results stage intact.
{
  const { meeting } = await rig();
  const sessionRow = await getSessionRow(meeting.env, meeting.sessionId);
  const profile = await getCurrentProfile(meeting.env, sessionRow);
  const prepared = await prepareRealtimeAnalysisPlan(meeting.env, {
    sessionId: meeting.sessionId, leaseId: meeting.meetingId, profileRevision: 1,
    idempotencyKey: 'profile-race', moduleIds: ['mortgage_analysis']
  });
  const confirm = () => confirmPlanSelection({
    env: meeting.env, config: meeting.config, sessionRow, profile, channel: 'live',
    confirmedModuleIds: ['mortgage_analysis'], preparedPlanId: prepared.row.id
  });
  await confirm();
  await meeting.env.CONSUMER_DB.batch([
    meeting.env.CONSUMER_DB.prepare("UPDATE consumer_realtime_analysis_plans SET status = 'complete' WHERE id = ?").bind(prepared.row.id),
    meeting.env.CONSUMER_DB.prepare("UPDATE consumer_sessions SET stage = 'results' WHERE id = ?").bind(meeting.sessionId)
  ]);
  const before = await getCurrentProfile(meeting.env, await getSessionRow(meeting.env, meeting.sessionId));
  await confirm();
  equal((await getSessionRow(meeting.env, meeting.sessionId)).stage, 'results', 'A late confirmation cannot regress completed results');
  equal(await getCurrentProfile(meeting.env, await getSessionRow(meeting.env, meeting.sessionId)), before, 'A late confirmation cannot rewrite the completed profile');
}

// The HTTP boundary requires both the private planning-session credential and
// the lease control capability; model-shaped fields cannot assert delivery.
{
  // A real lease needs a real reservation, which needs a session whose provider
  // cost limit is non-zero, which needs `realtimeEnabled`. That gate includes
  // the Durable Object binding, so the stub is installed BEFORE makeConfig
  // rather than just before the request.
  let delivered = 0;
  const env = makeEnv(newDatabase('delivery-route'), realtimeTestEnv({
    CONSUMER_MODULE_PLANNER_MODE: 'apply',
    CONSUMER_LIVE_SESSIONS: {
      idFromName: (value) => value,
      get: () => ({ fetch: async () => { delivered += 1; return Response.json({ ok: true }); } })
    }
  }));
  const config = makeConfig(env);
  assert.equal(config.realtimeEnabled, true, 'the delivery route needs a configured realtime lane');
  const credential = await createConsumerCredential();
  await createSessionRecord(env, credential, {
    aiProcessing: false, manifestId: config.consentManifestId, policyVersion: config.consentPolicyVersion,
    analysisNoticeId: config.analysisNoticeId, aiNoticeId: config.aiNoticeId, privacyNoticeUrl: config.privacyNoticeUrl
  }, config, {
    jti: `delivery-${credential.id}`, cohort: 'adviser_test', maxUses: 1,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  });
  const row = await getSessionRow(env, credential.id);
  // A lease is refused without current live-voice consent, exactly as in production.
  await setRealtimeConsent(env, row, config, true);
  const reservation = await reserveConsumerProviderCost(env, {
    sessionId: row.id, operation: 'realtime_voice_session', idempotencyKey: 'delivery-route',
    provider: 'openai', model: config.realtimeModel, pricingVersion: config.realtimePricingVersion,
    reservedCostEurMicros: 1000000, dailyCostLimitEurMicros: config.realtimeDailyBudgetMicroEur
  });
  const control = randomId('rt_control');
  const lease = await createRealtimeLease(env, row, config, reservation.entry, await sha256Base64Url(control));
  const path = `/api/consumer/sessions/${row.id}/voice/realtime/calls/${lease.id}/delivery`;
  const ack = { responseId: 'resp_delivery', eventId: 'evt_stopped', playback: 'completed' };
  const request = (body, sessionCredential = credential.credential, capability = control) => handleConsumerRequest(
    new Request(`https://worker.test${path}`, {
      method: 'POST', headers: {
        'Content-Type': 'application/json',
        ...(sessionCredential ? { 'X-Consumer-Session': sessionCredential } : {}),
        ...(capability ? { 'X-Realtime-Control-Capability': capability } : {})
      }, body: JSON.stringify(body)
    }), env, { pathname: path, respond: (body, status) => Response.json(body, { status }) }
  );
  // 404, not 401: `requireConsumerSession` answers not-found for an absent or
  // wrong credential so an unauthenticated caller cannot distinguish a real
  // session from one that never existed. Every authenticated consumer route
  // shares that property; do not "fix" this to 401.
  equal((await request(ack, '')).status, 404, 'Missing session authentication cannot acknowledge playback');
  equal((await request(ack, credential.credential, randomId('rt_control'))).status, 404, 'A wrong lease capability cannot acknowledge playback');
  equal((await request({ ...ack, readbackFullyDelivered: true })).status, 400, 'A model-style delivery assertion is refused');
  equal(delivered, 0, 'Rejected requests never reach the coordinator');
  equal((await request(ack)).status, 200, 'The authenticated narrow playback acknowledgement reaches the coordinator');
  equal(delivered, 1, 'One valid acknowledgement is forwarded');
}

console.info(`[LiveReadbackDelivery] ${checks} checks passed.`);
