#!/usr/bin/env node
// Real persistence and public projection; every provider request is prohibited.
import assert from 'node:assert/strict';
import { makeEnv, makeConfig, newDatabase } from './agent-harness/transports.mjs';
import { attachTypedSession, newLiveMeeting, settle } from './live-harness/session.mjs';
import { createConsumerCredential } from '../worker/src/consumer/crypto.js';
import { createSessionRecord, getSessionRow, reserveConsumerProviderCost } from '../worker/src/consumer/repository.js';
import { createRealtimeLease, getActiveRealtimeLease, getActiveTypedLease, recordRealtimeFinalTurn,
  saveRealtimeMeetingBrief, setRealtimeConsent } from '../worker/src/consumer/realtime_repository.js';

const failures = [];
let passed = 0;
async function check(name, run) {
  try { await run(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Recovery must never call a provider.'); };
try {
  await check('a pending typed lease belongs to the typed lifecycle before activation', async () => {
    const env = makeEnv(newDatabase('first20-pending-typed'));
    const config = { ...makeConfig(env), providerCostLimitEurMicros: 10_000_000,
      realtimeDailyBudgetMicroEur: 100_000_000, realtimePromptVersion: 'first20-prompt',
      realtimeToolsetVersion: 'first20-tools', realtimePricingVersion: 'first20-pricing',
      realtimeNoticeId: 'first20-notice', realtimeDataPolicyId: 'first20-data' };
    const credential = await createConsumerCredential('');
    await createSessionRecord(env, credential, {
      analysis: true, aiProcessing: false, adultConfirmed: true, educationOnlyAcknowledged: true,
      manifestId: config.consentManifestId, policyVersion: config.consentPolicyVersion,
      analysisNoticeId: config.analysisNoticeId, aiNoticeId: config.aiNoticeId,
      privacyNoticeUrl: config.privacyNoticeUrl
    }, config, { jti: 'first20-pending-typed', cohort: 'adviser_test',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), maxUses: 1 });
    const session = await getSessionRow(env, credential.id);
    await setRealtimeConsent(env, session, config, true);
    const reserve = await reserveConsumerProviderCost(env, {
      sessionId: session.id, operation: 'typed_planning_session', idempotencyKey: 'first20-typed',
      provider: 'openai', model: config.defaultModel, pricingVersion: config.realtimePricingVersion,
      reservedCostEurMicros: 1_000_000, dailyCostLimitEurMicros: config.realtimeDailyBudgetMicroEur
    });
    const lease = await createRealtimeLease(env, session, config, reserve.entry, null, null, { channel: 'typed' });
    assert.equal(lease.channel, 'typed');
    assert.equal((await getActiveTypedLease(env, session.id))?.id, lease.id);
    assert.equal(await getActiveRealtimeLease(env, session.id), null);
    assert.equal(lease.idle_expires_at, lease.hard_expires_at);
  });

  await check('Type refresh restores the persisted card and chronological conversation without provider calls', async () => {
    const meeting = await newLiveMeeting('first20-recover-public', { CONSUMER_MODULE_PLANNER_MODE: 'apply' });
    const { session, durable } = await attachTypedSession(meeting);
    const user = await recordRealtimeFinalTurn(meeting.env, {
      sessionId: meeting.sessionId, leaseId: meeting.meetingId,
      providerItemId: 'refresh-user', role: 'user', transcript: 'My mortgage balance is about 240,000.'
    });
    await recordRealtimeFinalTurn(meeting.env, {
      sessionId: meeting.sessionId, leaseId: meeting.meetingId,
      providerItemId: 'refresh-assistant', role: 'assistant', transcript: 'What is your mortgage interest rate?'
    });
    await saveRealtimeMeetingBrief(meeting.env, {
      sessionId: meeting.sessionId, leaseId: meeting.meetingId, sourceTurnId: user.id,
      profileRevision: 1, plannerPromptVersion: 'synthetic-first20', brief: {
        schemaVersion: 'MeetingBriefV3', readyToConfirm: false,
        verificationCertificate: { signature: 'must-never-be-public' },
        directModuleSnapshot: { modules: [{ moduleId: 'mortgage_analysis', status: 'collecting',
          input: { currentBalance: 240000 }, evidence: [],
          missing: [{ path: '/annualInterestRate', question: 'What is your mortgage interest rate?' }]
        }] }
      }
    });
    const state = await session.publicState();
    assert.deepEqual(state.turns.map((turn) => [turn.role, turn.text]), [
      ['user', 'My mortgage balance is about 240,000.'],
      ['assistant', 'What is your mortgage interest rate?']
    ]);
    assert.equal(state.card.modules.length, 1);
    assert.equal(state.card.modules[0].fields[0].question, 'What is your mortgage interest rate?');
    assert.equal(session.typedCardIndex.size, 1, 'restoring a card must also restore its private field bindings');
    assert.equal(JSON.stringify(state).includes('must-never-be-public'), false);
    assert.equal(JSON.stringify(state.card).includes('/annualInterestRate'), false);
    await settle(durable, session);
  });

  await check('a stale Not sure action cannot acknowledge a different field or a later card', async () => {
    const meeting = await newLiveMeeting('first20-stale-card', { CONSUMER_MODULE_PLANNER_MODE: 'apply' });
    let rig = await attachTypedSession(meeting);
    async function save(revision, path) {
      await saveRealtimeMeetingBrief(meeting.env, {
        sessionId: meeting.sessionId, leaseId: meeting.meetingId, sourceTurnId: `c${revision}`,
        profileRevision: 1, plannerPromptVersion: 'synthetic-first20', brief: {
          schemaVersion: 'MeetingBriefV3', readyToConfirm: false,
          directModuleSnapshot: { snapshotRevision: revision, modules: [{
            moduleId: 'mortgage_analysis', status: 'collecting', input: {}, evidence: [],
            missing: [{ path, question: 'Please supply this mortgage detail.' }]
          }] }
        }
      });
      return (await rig.session.publicState()).card.modules[0].fields[0];
    }
    const rate = await save(1, '/annualInterestRate');
    const balance = await save(2, '/currentBalance');
    const oldAction = rate.unknownFieldId || rate.id;
    assert.notEqual(balance.unknownFieldId || balance.id, oldAction);
    assert.notEqual(balance.id, rate.id, 'draft identities must not cross financial fields');
    await rig.session.recordAcknowledgedUnknown(oldAction, 'client-stale');
    assert.deepEqual(rig.session.acknowledgedUnknown, [], 'the old rate card must not block balance');
    const refreshed = await save(3, '/currentBalance');
    assert.equal(refreshed.id, balance.id, 'a midway question retains a draft for the same field');
    assert.notEqual(refreshed.unknownFieldId, balance.unknownFieldId, 'actions bind to the current brief');
    await rig.durable.state.storage.put('lease', rig.session.meta);
    rig = await attachTypedSession(meeting, { initial: Object.fromEntries(rig.durable.values) });
    const restored = (await rig.session.publicState()).card.modules[0].fields[0];
    assert.deepEqual(restored, refreshed, 'eviction recovers the exact public and private binding');
    await rig.session.recordAcknowledgedUnknown(restored.unknownFieldId, 'client-current');
    assert.equal(rig.session.acknowledgedUnknown[0].path, '/currentBalance');
    await rig.session.recordAcknowledgedUnknown(restored.unknownFieldId, 'client-newer');
    assert.equal(rig.session.acknowledgedUnknown[0].sourceTurnId, 'client-newer', 'a later acknowledgement supersedes an older resolution target');
    await settle(rig.durable, rig.session);
  });
} finally { globalThis.fetch = originalFetch; }
console.log(`[First20TypedRecovery] ${passed} passed; ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;
