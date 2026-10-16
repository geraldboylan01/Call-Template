import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createTestRuntime } from './lib/application-test-runtime.mjs';
import { demoAcknowledgements, DEMO_ACKNOWLEDGEMENTS, DEMO_CONFIRMED } from '../js/workspace/demo_contract.js';

const originalFetch = globalThis.fetch, deliveries = [];
let deliveryFails = false;
globalThis.fetch = async (url, options) => {
  assert.equal(String(url), 'https://api.resend.com/emails', 'No AI, calculation or other external API may be called.');
  if (deliveryFails) throw new Error('Simulated email outage');
  deliveries.push({ ...JSON.parse(options.body), key: options.headers['Idempotency-Key'] });
  return new Response(JSON.stringify({ id: `email-${deliveries.length}` }), { headers: { 'Content-Type': 'application/json' } });
};
const runtime = createTestRuntime({ DEMO_REQUESTS_ENABLED: 'true', DEMO_DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64url') });
const ack = demoAcknowledgements(Object.fromEntries(DEMO_ACKNOWLEDGEMENTS.map(key => [key, true])));
const make = (email = 'person@example.com', information = {}) => ({ submissionId: randomBytes(32).toString('base64url'), contact: { fullName: 'Demo Person', email }, information, acknowledgements: ack });
const cookie = result => result.response.headers.get('set-cookie')?.split(';')[0];
const tokenFor = email => new URL(deliveries.filter(item => item.to.includes(email) && item.text.includes('#access=')).at(-1).text.match(/https:\/\/planeir\.ie\/demo\/#access=[\w-]+/)[0]).hash.slice(8);
const headersFor = async result => {
  const Cookie = cookie(result);
  const session = await runtime.call('/api/demo/session', undefined, { headers: { Cookie } });
  return { Cookie, 'X-Demo-CSRF': session.json.csrfToken };
};
try {
  const admin = await runtime.login();
  const emptyPayload = make();
  const created = await runtime.call('/api/demo/requests', emptyPayload);
  assert.equal(created.status, 201); assert.equal(created.json.accessStatus, 'pending');
  assert.match(created.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=604800; Secure/);
  assert.match(created.response.headers.get('set-cookie'), /Path=\/api\/demo/);
  assert.equal(created.response.headers.get('cache-control'), 'no-store, max-age=0');
  const owner = await headersFor(created), id = created.json.id, path = `/api/demo/requests/${id}`;
  const stored = runtime.sql.prepare('SELECT * FROM demo_requests WHERE id=?').get(id);
  assert.ok(!stored.payload_encrypted.includes('Demo Person')); assert.ok(!stored.payload_encrypted.includes('person@example.com'));
  assert.equal((await runtime.call(`${path}/confirm`, { revision: 1 }, { headers: owner })).status, 403);
  assert.equal((await runtime.call(path)).status, 404);
  assert.equal((await runtime.call(path, { ...emptyPayload, revision: 1 }, { method: 'PATCH', headers: { Cookie: owner.Cookie } })).status, 403);
  const resent = await runtime.call('/api/demo/requests', emptyPayload);
  assert.equal(resent.status, 200); assert.equal(resent.json.id, id);
  assert.equal(runtime.sql.prepare('SELECT COUNT(*) AS n FROM demo_requests').get().n, 1);
  assert.equal(deliveries.filter(item => item.to.includes('person@example.com')).length, 1);
  const invalidAck = make('invalid@example.com'); invalidAck.acknowledgements = { ...ack, privacyNoticeAcknowledged: false };
  assert.equal((await runtime.call('/api/demo/requests', invalidAck)).status, 400);
  assert.equal((await runtime.call('/api/demo/requests', { ...make(), information: { household: { age: 16 } } })).status, 400);

  // GETs never consume email links. A different device can redeem explicitly.
  const firstToken = tokenFor('person@example.com');
  assert.equal((await runtime.call('/api/demo/access/redeem')).status, 405);
  const redeemed = await runtime.call('/api/demo/access/redeem', { token: firstToken });
  assert.equal(redeemed.status, 200);
  assert.equal((await runtime.call('/api/demo/access/redeem', { token: firstToken })).status, 410);
  const secondDevice = await headersFor(redeemed);
  const updatedPayload = { ...emptyPayload, information: { topics: ['mortgage'], question: 'Compare mortgage routes', home: { status: 'mortgage' }, mortgage: { balance: 180000, rate: 3.5 } }, revision: 1 };
  const patched = await runtime.call(path, updatedPayload, { method: 'PATCH', headers: secondDevice });
  assert.equal(patched.status, 200); assert.equal(patched.json.revision, 2);
  assert.equal((await runtime.call(path, updatedPayload, { method: 'PATCH', headers: owner })).status, 409, 'Stale edits must not overwrite newer data.');
  assert.equal((await runtime.call(path, { ...updatedPayload, revision: 2, contact: { fullName: 'Demo', email: 'other@example.com' } }, { method: 'PATCH', headers: owner })).status, 400);
  assert.equal((await runtime.call(`/api/advisor/demo/requests/${id}/approve`, {}, { headers: admin })).status, 200);
  assert.equal((await runtime.call(path, undefined, { headers: secondDevice })).json.information.mortgage.balance, 180000);
  const confirmation = await runtime.call(`${path}/confirm`, { revision: 2 }, { headers: secondDevice });
  assert.equal(confirmation.status, 200); assert.equal(confirmation.json.generationAvailable, false); assert.equal(confirmation.json.message, DEMO_CONFIRMED);
  assert.equal(runtime.sql.prepare('SELECT confirmed_revision FROM demo_requests WHERE id=?').get(id).confirmed_revision, 2);
  assert.equal((await runtime.call(`${path}/confirm`, { revision: 2 }, { headers: secondDevice })).status, 200);
  assert.equal((await runtime.call('/api/advisor/demo/requests')).status, 401);
  assert.equal((await runtime.call(`/api/advisor/demo/requests/${id}/revoke`, {}, { headers: { Cookie: admin.Cookie } })).status, 403);
  assert.equal((await runtime.call(`/api/advisor/demo/requests/${id}/revoke`, {}, { headers: admin })).status, 200);
  assert.equal((await runtime.call(`${path}/confirm`, { revision: 2 }, { headers: owner })).status, 403);

  const invitation = await runtime.call('/api/advisor/demo/invitations', { label: 'Small cohort', maxUses: 2 }, { headers: admin });
  assert.equal(invitation.status, 201); assert.equal(invitation.json.maxUses, 2);
  const inviteToken = new URL(invitation.json.url).hash.slice(8);
  const invited1 = await runtime.call('/api/demo/invitations/redeem', { token: inviteToken });
  const invited2 = await runtime.call('/api/demo/invitations/redeem', { token: inviteToken });
  assert.equal(runtime.sql.prepare('SELECT uses FROM demo_invitations WHERE id=?').get(invitation.json.id).uses, 0, 'Opening/redeeming a shared link is not enrolment.');
  const firstDirect = make('direct1@example.com', { question: 'My goals' });
  const direct1 = await runtime.call('/api/demo/requests', firstDirect, { headers: await headersFor(invited1) });
  const direct2 = await runtime.call('/api/demo/requests', make('direct2@example.com'), { headers: await headersFor(invited2) });
  assert.equal(direct1.status, 201); assert.equal(direct2.status, 201);
  assert.equal(direct1.json.accessStatus, 'approved'); assert.notEqual(direct1.json.id, direct2.json.id);
  const directHeaders = await headersFor(direct1);
  assert.equal((await runtime.call(`/api/demo/requests/${direct2.json.id}`, undefined, { headers: directHeaders })).status, 404);
  const retryDirect = await runtime.call('/api/demo/requests', firstDirect, { headers: directHeaders });
  assert.equal(retryDirect.json.id, direct1.json.id);
  assert.equal(runtime.sql.prepare('SELECT uses FROM demo_invitations WHERE id=?').get(invitation.json.id).uses, 2);
  assert.equal((await runtime.call('/api/demo/invitations/redeem', { token: inviteToken })).status, 410);
  assert.equal((await runtime.call(`/api/demo/requests/${direct1.json.id}/confirm`, { revision: 1 }, { headers: directHeaders })).status, 200);

  const upgrade = await runtime.call('/api/demo/requests', make('upgrade@example.com'));
  const upgradeHeaders = await headersFor(upgrade);
  const upgradeInvite = await runtime.call('/api/advisor/demo/invitations', {}, { headers: admin });
  assert.equal(upgradeInvite.json.maxUses, 25);
  assert.ok(Math.abs(Date.parse(upgradeInvite.json.expiresAt) - Date.now() - 7 * 86400000) < 10000);
  const upgradeToken = new URL(upgradeInvite.json.url).hash.slice(8);
  assert.equal((await runtime.call('/api/demo/invitations/redeem', { token: upgradeToken }, { headers: upgradeHeaders })).status, 200);
  assert.equal((await runtime.call('/api/demo/invitations/redeem', { token: upgradeToken }, { headers: upgradeHeaders })).status, 200);
  assert.equal(runtime.sql.prepare('SELECT uses FROM demo_invitations WHERE id=?').get(upgradeInvite.json.id).uses, 1);
  assert.equal((await runtime.call(`/api/advisor/demo/invitations/${upgradeInvite.json.id}/revoke`, {}, { headers: admin })).status, 200);
  assert.equal((await runtime.call('/api/demo/invitations/redeem', { token: upgradeToken })).status, 410);
  assert.equal((await runtime.call(`/api/demo/requests/${upgrade.json.id}/confirm`, { revision: 1 }, { headers: upgradeHeaders })).status, 200, 'Revoking the invitation does not revoke participants.');

  const raceInvite = await runtime.call('/api/advisor/demo/invitations', { maxUses: 1 }, { headers: admin });
  const raceToken = new URL(raceInvite.json.url).hash.slice(8);
  const raceSessions = await Promise.all([runtime.call('/api/demo/invitations/redeem', { token: raceToken }), runtime.call('/api/demo/invitations/redeem', { token: raceToken })]);
  const raceOwners = await Promise.all(raceSessions.map(headersFor));
  const raceResults = await Promise.all(raceOwners.map((headers, i) => runtime.call('/api/demo/requests', make(`race-${i}@example.com`), { headers })));
  assert.deepEqual(raceResults.map(result => result.status).sort(), [201, 410], 'Exactly one concurrent enrolment wins the last invitation place.');
  assert.equal(runtime.sql.prepare('SELECT uses FROM demo_invitations WHERE id=?').get(raceInvite.json.id).uses, 1);
  const duplicate = make('retry-race@example.com');
  const duplicateResults = await Promise.all([runtime.call('/api/demo/requests', duplicate), runtime.call('/api/demo/requests', duplicate)]);
  assert.equal(duplicateResults[0].json.id, duplicateResults[1].json.id);
  assert.deepEqual(duplicateResults.map(result => result.status).sort(), [200, 201]);
  const raceAccess = tokenFor('retry-race@example.com');
  const redemptions = await Promise.all([runtime.call('/api/demo/access/redeem', { token: raceAccess }), runtime.call('/api/demo/access/redeem', { token: raceAccess })]);
  assert.deepEqual(redemptions.map(result => result.status).sort(), [200, 410]);

  const expiredInvite = await runtime.call('/api/advisor/demo/invitations', { maxUses: 1 }, { headers: admin });
  const expiredToken = new URL(expiredInvite.json.url).hash.slice(8);
  const beforeExpiry = await runtime.call('/api/demo/invitations/redeem', { token: expiredToken });
  runtime.sql.prepare('UPDATE demo_invitations SET expires_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', expiredInvite.json.id);
  assert.equal((await runtime.call('/api/demo/requests', make('expired@example.com'), { headers: await headersFor(beforeExpiry) })).status, 410);

  // Failed delivery is durable; cron retries exactly the same provider key.
  deliveryFails = true;
  const outage = await runtime.call('/api/demo/requests', make('outage@example.com'));
  assert.equal(outage.status, 201);
  assert.equal(runtime.sql.prepare("SELECT COUNT(*) AS n FROM demo_email_outbox WHERE request_id=? AND status='pending'").get(outage.json.id).n, 2);
  deliveryFails = false;
  runtime.sql.prepare("UPDATE demo_email_outbox SET next_attempt_at='2020-01-01T00:00:00.000Z' WHERE request_id=?").run(outage.json.id);
  await runtime.cron();
  assert.equal(runtime.sql.prepare("SELECT COUNT(*) AS n FROM demo_email_outbox WHERE request_id=? AND status='sent' AND payload_encrypted IS NULL").get(outage.json.id).n, 2);
  const recovery = await runtime.call('/api/demo/return-links', { email: 'outage@example.com' });
  const unknownRecovery = await runtime.call('/api/demo/return-links', { email: 'unknown@example.com' });
  assert.deepEqual(recovery.json, unknownRecovery.json);
  const expiredAccess = tokenFor('outage@example.com');
  runtime.sql.prepare("UPDATE demo_access_tokens SET expires_at='2020-01-01T00:00:00.000Z' WHERE request_id=?").run(outage.json.id);
  assert.equal((await runtime.call('/api/demo/access/redeem', { token: expiredAccess })).status, 410);
  assert.equal((await runtime.call('/api/demo/requests', make(), { headers: { Origin: 'https://evil.example' } })).status, 403);

  const thirdParty = await headersFor(direct2);
  assert.equal((await runtime.call(path, undefined, { method: 'DELETE', headers: thirdParty })).status, 404);
  assert.equal((await runtime.call(path, undefined, { method: 'DELETE', headers: owner })).status, 200);
  for (const table of ['demo_requests', 'demo_sessions', 'demo_access_tokens', 'demo_email_outbox']) {
    const field = table === 'demo_requests' ? 'id' : 'request_id';
    assert.equal(runtime.sql.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${field}=?`).get(id).n, 0, `${table}: deletion must erase associated data.`);
  }
  const closed = createTestRuntime({ DEMO_REQUESTS_ENABLED: 'false', DEMO_DATA_ENCRYPTION_KEY: runtime.env.DEMO_DATA_ENCRYPTION_KEY });
  try { assert.equal((await closed.call('/api/demo/requests', make())).status, 503); } finally { closed.close(); }
  const noAuth = createTestRuntime({ DEMO_DATA_ENCRYPTION_KEY: runtime.env.DEMO_DATA_ENCRYPTION_KEY, ADVISOR_PASSWORD: undefined, ADVISOR_SESSION_SECRET: undefined });
  try { assert.equal((await noAuth.call('/api/advisor/demo/requests')).status, 503); } finally { noAuth.close(); }
  assert.equal(runtime.sql.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 0, 'Demo requests must not enter historical services.');
  console.log('Demo flow: optional figures, encrypted storage, personal access, approvals, independent invitations, confirmation-only handoff, concurrency guards, email retries and deletion passed.');
} finally { runtime.close(); globalThis.fetch = originalFetch; }
