#!/usr/bin/env node
// Real migrated SQLite, Durable Object and lease lifecycle. No provider calls.
// Run every scenario before failing so the baseline records independent faults.
import assert from 'node:assert/strict';
import { attachTypedSession, attachLiveSession, newLiveMeeting, settle } from './live-harness/session.mjs';
import { getRealtimeLease, listRealtimeFinalTurns, touchRealtimeLease } from '../worker/src/consumer/realtime_repository.js';
import { terminateRealtimeLease } from '../worker/src/consumer/realtime_lifecycle.js';

const failures = [];
let passed = 0;
const PROMPT = 'I will run the mortgage analysis using a balance of 240,000 and a rate of 4.1%. Would you like me to run this plan?';
async function check(name, run) {
  try { await run(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
async function rig(label, channel = 'typed') {
  const meeting = await newLiveMeeting(`first20-${label}`, {
    CONSUMER_MODULE_PLANNER_MODE: 'apply', CONSUMER_TYPED_LANE_ENABLED: 'true',
    OPENAI_API_KEY: 'synthetic-test-key'
  });
  // The shared harness starts with an agent_test row; exercise actual transport
  // lifecycle by setting its persisted discriminator, not only the DO flag.
  await meeting.env.CONSUMER_DB.prepare('UPDATE consumer_realtime_sessions SET channel = ? WHERE id = ?')
    .bind(channel, meeting.meetingId).run();
  const attached = channel === 'typed' ? await attachTypedSession(meeting) : await attachLiveSession(meeting);
  await attached.durable.state.storage.put('lease', attached.session.meta);
  return { ...attached, meeting };
}
function offer(session) {
  session.directConfirmationOffer = {
    token: 'dmc_recovery', planId: 'plan_recovery', profileRevision: 1,
    certificateSignature: 'synthetic-certificate', reviewStatus: 'settled',
    confirmationPrompt: PROMPT, readbackFullyDelivered: false,
    assistantTurnId: null, confirmationTurnIds: []
  };
}
function candidate(response) {
  response.continuationChain.directConfirmationCandidate = {
    token: 'dmc_recovery', sourceResponseId: response.responseId, confirmationPrompt: PROMPT
  };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, request) => {
  const body = JSON.parse(request?.body || '{}');
  return new Response(JSON.stringify({ status: 'completed', output: body?.tools
    ? [{ type: 'function_call', name: 'get_state', arguments: '{}', call_id: 'first20_get_state' }]
    : [], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
try {
  await check('composed typed readback persists once and next approval binds to it', async () => {
    const { session, meeting, durable } = await rig('composed-readback');
    offer(session);
    // Model state/certification are synthetic here; the composed ingest ->
    // renderer -> delivery -> finalization and all persistence remain real.
    session.dispatchTextToolCall = async (_call, response) => { candidate(response); return { ok: true }; };
    const result = await session.handleTextMessage({ text: 'Please read the plan back.' });
    await settle(durable, session);
    assert.equal(result.readback, true);
    const turns = await listRealtimeFinalTurns(meeting.env, meeting.sessionId, meeting.meetingId);
    const assistant = turns.filter((turn) => turn.role === 'assistant');
    assert.equal(assistant.length, 1, 'one visible reply must have one persisted assistant identity');
    session.registerStoppedClientTurn({ item_id: 'approval_after_readback' });
    assert.equal(session.turnAnswersDirectOffer(session.clientTurnsByItemId.get('approval_after_readback')), true);
  });

  await check('typed approval reply binding survives Durable Object eviction', async () => {
    const { session, meeting, durable } = await rig('readback-recovery');
    offer(session);
    const response = session.createResponseContext({ responseId: 'txt_recovery', rootResponseId: 'txt_recovery', causeItemId: null });
    candidate(response);
    await session.deliverCertifiedReadback(response, '');
    await settle(durable, session);
    const recovered = await attachTypedSession(meeting, { initial: Object.fromEntries(durable.values) });
    recovered.session.registerStoppedClientTurn({ item_id: 'approval_after_eviction' });
    assert.equal(recovered.session.turnAnswersDirectOffer(recovered.session.clientTurnsByItemId.get('approval_after_eviction')), true);
  });

  await check('typing preserves the hard-expiry-only idle policy', async () => {
    const { meeting } = await rig('typed-idle');
    const before = await getRealtimeLease(meeting.env, meeting.sessionId, meeting.meetingId);
    const after = await touchRealtimeLease(meeting.env, meeting.sessionId, meeting.meetingId, 180);
    assert.equal(after.idle_expires_at, before.hard_expires_at);
  });

  await check('typed heartbeat does not require a voice sideband', async () => {
    const { session, durable } = await rig('typed-heartbeat');
    await session.alarm();
    assert.equal(session.pendingTerminalization, null);
    assert.equal(durable.values.has('terminalizationRetryAttempts'), false);
  });

  await check('active typed lease closes through the Durable Object without a provider id', async () => {
    const { session, meeting } = await rig('typed-close');
    const closed = await session.terminalize('complete', 'consumer_closed', null, true);
    assert.equal(closed.providerHangupConfirmed, true);
    assert.equal((await getRealtimeLease(meeting.env, meeting.sessionId, meeting.meetingId)).status, 'complete');
  });

  await check('active typed lease closes with coordinator unavailable', async () => {
    const { meeting } = await rig('typed-fallback-close');
    const lease = await getRealtimeLease(meeting.env, meeting.sessionId, meeting.meetingId);
    const closed = await terminateRealtimeLease(meeting.env, lease, { status: 'complete', reason: 'consumer_closed' });
    assert.equal(closed.status, 'complete');
  });

  await check('voice fallback still refuses unproven provider termination', async () => {
    const { meeting } = await rig('voice-fallback-close', 'voice');
    const lease = await getRealtimeLease(meeting.env, meeting.sessionId, meeting.meetingId);
    await assert.rejects(terminateRealtimeLease(meeting.env, lease), (error) => error.code === 'realtime_hangup_uncertain');
  });
} finally { globalThis.fetch = originalFetch; }
console.log(`[First20ExecutionRecovery] ${passed} passed; ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;
