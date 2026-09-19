#!/usr/bin/env node
// Exercise the authenticated HTTP routing boundary over real migrated D1.
// The coordinator can fail independently of the database; no provider is used.
import assert from 'node:assert/strict';
import { makeEnv, newDatabase, realtimeTestEnv } from './agent-harness/transports.mjs';
import { getConsumerConfig } from '../worker/src/consumer/config.js';
import { createConsumerCredential, randomId } from '../worker/src/consumer/crypto.js';
import { createSessionRecord, getConsumerProviderBudget, getSessionRow } from '../worker/src/consumer/repository.js';
import { getRealtimeLeaseByActivationHash, setRealtimeConsent } from '../worker/src/consumer/realtime_repository.js';
import { sha256Base64Url } from '../worker/src/consumer/crypto.js';
import { handleConsumerRequest } from '../worker/src/consumer/router.js';

const failures = [];
let passed = 0;
async function check(name, run) {
  try { await run(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
async function setup(label) {
  const calls = [];
  let failActivation = false;
  let failClose = false;
  const namespace = {
    idFromName: (name) => name,
    get: () => ({ async fetch(url, init) {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === '/activate') return failActivation ? json({ ok: false, code: 'test_activation_failure' }, 503)
        : json({ ok: true, assistantText: 'What would you like to explore?' });
      if (path === '/close') return json({ ok: false, code: 'test_close_failure' }, 503);
      if (failClose) throw new Error('coordinator unavailable');
      return json({ ok: true, card: { modules: [] }, turns: [] });
    } })
  };
  const env = makeEnv(newDatabase(`first20-router-${label}`), {
    ...realtimeTestEnv(), CONSUMER_COHORT: 'adviser_test',
    CONSUMER_MODULE_PLANNER_MODE: 'apply', CONSUMER_TYPED_LANE_ENABLED: 'true',
    CONSUMER_INVITE_SIGNING_KEY: Buffer.alloc(32, 22).toString('base64url'),
    CONSUMER_LIVE_SESSIONS: namespace, CONSUMER_LIVE_VOICE_ENABLED: 'true'
  });
  const config = getConsumerConfig(env);
  assert.equal(config.typedLaneEnabled, true);
  const credential = await createConsumerCredential('');
  const consent = {
    analysis: true, aiProcessing: false, adultConfirmed: true, educationOnlyAcknowledged: true,
    manifestId: config.consentManifestId, policyVersion: config.consentPolicyVersion,
    analysisNoticeId: config.analysisNoticeId, aiNoticeId: config.aiNoticeId,
    privacyNoticeUrl: config.privacyNoticeUrl
  };
  await createSessionRecord(env, credential, consent, config, {
    jti: randomId('invite'), cohort: config.cohort, maxUses: 1,
    expiresAt: new Date(Date.now() + 3600000).toISOString()
  });
  const row = await getSessionRow(env, credential.id);
  await setRealtimeConsent(env, row, config, true);
  const activationId = randomId('rt_activation');
  const controlCapability = randomId('rt_control');
  const requestId = randomId('first20');
  async function request(suffix = '', method = 'GET', body, overrides = {}) {
    const pathname = `/api/consumer/sessions/${credential.id}/text/meetings${suffix}`;
    return handleConsumerRequest(new Request(`https://example.invalid${pathname}`, {
      method, headers: {
        'X-Consumer-Session': credential.credential,
        'X-Realtime-Activation-Id': activationId,
        'X-Realtime-Control-Capability': controlCapability,
        'X-Voice-Request-Id': requestId,
        ...overrides
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }), env, { pathname, clientIp: '127.0.0.1', respond: json });
  }
  return { env, credential, activationId, request, calls,
    failActivation() { failActivation = true; }, failClose() { failClose = true; } };
}

await check('failed Type activation closes the lease and does not strand an active meeting', async () => {
  const rig = await setup('activation'); rig.failActivation();
  const result = await rig.request('', 'POST');
  assert.equal(result.status, 503);
  const lease = await getRealtimeLeaseByActivationHash(rig.env, rig.credential.id, await sha256Base64Url(rig.activationId));
  assert.ok(!lease || !['active', 'pending', 'closing'].includes(lease.status), 'failed startup must not hold the only meeting slot');
});

await check('failed pre-dispatch creation releases its full budget reservation', async () => {
  const rig = await setup('before-dispatch');
  await rig.env.CONSUMER_DB.prepare('UPDATE consumer_invite_redemptions SET revoked_at = ?')
    .bind(new Date().toISOString()).run();
  const before = await getConsumerProviderBudget(rig.env, rig.credential.id);
  assert.equal((await rig.request('', 'POST')).status, 403);
  const after = await getConsumerProviderBudget(rig.env, rig.credential.id);
  assert.equal(after.remainingEurMicros, before.remainingEurMicros, 'no model call was dispatched');
});

await check('replaying a lost Type creation response resumes the same lease without a second opening', async () => {
  const rig = await setup('replay');
  const first = await rig.request('', 'POST'); assert.equal(first.status, 201);
  const body = await first.json();
  const replay = await rig.request('', 'POST');
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).leaseId, body.leaseId);
  assert.equal(rig.calls.filter((path) => path === '/activate').length, 1);
});

await check('typed GET returns recovery state and terminal reads survive a deleted coordinator', async () => {
  const rig = await setup('read');
  const created = await rig.request('', 'POST'); assert.equal(created.status, 201);
  const { leaseId } = await created.json();
  const active = await rig.request(`/${leaseId}`); assert.equal(active.status, 200);
  const activeBody = await active.json();
  assert.equal(activeBody.leaseId, leaseId);
  assert.equal(activeBody.realtimeLease.status, 'active');
  assert.ok('realtimeExecution' in activeBody);
  await rig.env.CONSUMER_DB.prepare("UPDATE consumer_realtime_sessions SET status = 'complete' WHERE id = ?")
    .bind(leaseId).run();
  rig.failClose();
  const terminal = await rig.request(`/${leaseId}`); assert.equal(terminal.status, 200);
  const body = await terminal.json(); assert.equal(body.realtimeLease.status, 'complete');
  assert.ok(Array.isArray(body.turns));
  assert.equal((await rig.request(`/${leaseId}`, 'GET', undefined, { 'X-Realtime-Control-Capability': randomId('rt_control') })).status, 404);
});

await check('Type DELETE confirms durable closure with coordinator unavailable and is retryable', async () => {
  const rig = await setup('close');
  const created = await rig.request('', 'POST'); assert.equal(created.status, 201);
  const { leaseId } = await created.json();
  rig.failClose();
  assert.equal((await rig.request(`/${leaseId}`, 'DELETE')).status, 200);
  const lease = await getRealtimeLeaseByActivationHash(rig.env, rig.credential.id, await sha256Base64Url(rig.activationId));
  assert.equal(lease.status, 'complete', '200 means a closed lease, not a swallowed close failure');
  assert.equal((await rig.request(`/${leaseId}`, 'DELETE')).status, 200);
});

await check('Type dispatch stops when the acknowledged privacy disclosure is superseded', async () => {
  const rig = await setup('stale-disclosure');
  const { leaseId } = await (await rig.request('', 'POST')).json();
  await rig.env.CONSUMER_DB.prepare('UPDATE consumer_sessions SET consent_manifest_id = ? WHERE id = ?')
    .bind('old-manifest', rig.credential.id).run();
  assert.equal((await rig.request(`/${leaseId}/messages`, 'POST', { text: 'My savings are 30000.' })).status, 428);
  assert.equal(rig.calls.includes('/message'), false);
  assert.equal((await rig.request(`/${leaseId}`)).status, 200, 'read access remains available');
});

await check('Type dispatch requires current conversation consent and an unexpired lease', async () => {
  const rig = await setup('expired-meeting');
  const { leaseId } = await (await rig.request('', 'POST')).json();
  await rig.env.CONSUMER_DB.prepare('UPDATE consumer_realtime_consents SET granted = 0 WHERE session_id = ?')
    .bind(rig.credential.id).run();
  assert.equal((await rig.request(`/${leaseId}/messages`, 'POST', { text: 'Please continue.' })).status, 403);
  await rig.env.CONSUMER_DB.prepare('UPDATE consumer_realtime_consents SET granted = 1 WHERE session_id = ?')
    .bind(rig.credential.id).run();
  await rig.env.CONSUMER_DB.prepare('UPDATE consumer_realtime_sessions SET hard_expires_at = ? WHERE id = ?')
    .bind(new Date(Date.now() - 1000).toISOString(), leaseId).run();
  assert.equal((await rig.request(`/${leaseId}/messages`, 'POST', { text: 'Please continue.' })).status, 410);
  assert.equal(rig.calls.includes('/message'), false);
});

console.log(`[First20RouterRecovery] ${passed} passed; ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;
