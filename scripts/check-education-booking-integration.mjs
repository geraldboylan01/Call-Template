import assert from 'node:assert/strict';
import { createTestRuntime } from './lib/application-test-runtime.mjs';
import {
  encryptPublishedSessionV4, buildPublishedCapabilityToken, resolvePublishedClientSessionAccess,
  decryptPublishedSessionV4ForAdvisor
} from '../js/crypto_session.js';
import { EDUCATION_CALL } from '../js/workspace/education_call.js';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createConsumerCredential } from '../worker/src/consumer/crypto.js';
import { createSessionRecord, getSessionRow, getCurrentProfile, createAnalysisRun, completeAnalysisRun } from '../worker/src/consumer/repository.js';

const objects = new Map();
const metadata = new Map();
const bucket = {
  async put(key, value, options = {}) { objects.set(key, typeof value === 'string' ? value : new Uint8Array(value)); metadata.set(key, options.httpMetadata); },
  async get(key) { const value = objects.get(key); return value === undefined ? null : { text: async () => typeof value === 'string' ? value : new TextDecoder().decode(value), body: new Blob([value]).stream(), httpMetadata: metadata.get(key) }; },
  async delete(key) { objects.delete(key); metadata.delete(key); },
  async list({ prefix }) { return { objects: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }; }
};
const runtime = createTestRuntime({
  EDUCATION_CALLS_ENABLED: 'true', SESSIONS_BUCKET: bucket,
  ZOOM_ACCOUNT_ID: 'test', ZOOM_CLIENT_ID: 'test', ZOOM_CLIENT_SECRET: 'test', ZOOM_USER_ID: 'test-host'
});
const consumer = createTestRuntime();
for (const file of readdirSync(new URL('../worker/consumer-migrations/', import.meta.url)).filter(file => file.endsWith('.sql')).sort()) {
  consumer.sql.exec(readFileSync(new URL(`../worker/consumer-migrations/${file}`, import.meta.url), 'utf8'));
}
runtime.env.CONSUMER_DB = consumer.db;
runtime.env.CONSUMER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64url');
const originalFetch = globalThis.fetch;
const emails = [], meetings = [], updates = [];
let failZoomDelete = true;
let failZoomAuth = false;
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.startsWith('https://zoom.us/oauth/token')) return failZoomAuth
    ? Response.json({ message: 'Authorization unavailable' }, { status: 401 }) : Response.json({ access_token: 'test-zoom-token' });
  if (target === 'https://api.zoom.us/v2/users/test-host/meetings') {
    meetings.push(JSON.parse(options.body));
    return Response.json({ id: 777777777, join_url: 'https://zoom.us/j/777777777', password: 'test-passcode' });
  }
  if (target === 'https://api.zoom.us/v2/meetings/777777777' && options.method === 'PATCH') {
    updates.push(JSON.parse(options.body)); return new Response(null, { status: 204 });
  }
  if (target === 'https://api.zoom.us/v2/meetings/777777777' && options.method === 'DELETE') {
    return failZoomDelete ? Response.json({ message: 'Temporary provider failure' }, { status: 500 }) : new Response(null, { status: 204 });
  }
  if (target === 'https://api.resend.com/emails') {
    emails.push({ ...JSON.parse(options.body), key: new Headers(options.headers).get('Idempotency-Key') });
    return Response.json({ id: `test-mail-${emails.length}` });
  }
  throw new Error(`Unexpected integration test request: ${target}`);
};

try {
  const auth = await runtime.login();
  assert.equal((await runtime.call('/api/advisor/qualification/ranking')).status, 401);
  const ranking = await runtime.call('/api/advisor/qualification/ranking', undefined, { headers: auth });
  assert.equal(ranking.status, 200, JSON.stringify(ranking.json));
  assert.deepEqual(ranking.json.ranked, []);
  const payload = JSON.stringify({ id: 'integration-report', clientName: 'Report Tester', modules: [{ id: 'test-result', type: 'report', payload: { privateFixture: 918273645 }, media: { images: [{ assetId: 'fixture-image' }] } }] });
  const encrypted = await encryptPublishedSessionV4({ clientSessionJson: payload, advisorSessionJson: payload, clientName: 'Report Tester' });
  const published = await runtime.call('/api/published-sessions', encrypted.requestBody, { headers: auth });
  assert.equal(published.status, 201, JSON.stringify(published.json));
  const publishedId = published.json.publishedId;
  assert.ok(publishedId);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP8sAAAAASUVORK5CYII=', 'base64');
  await bucket.put(`published/assets/${publishedId}/fixture-image`, image, { httpMetadata: { contentType: 'image/png' } });
  const capability = await buildPublishedCapabilityToken(encrypted.clientSecretB64u, 'client');
  const access = await resolvePublishedClientSessionAccess(encrypted.clientSecretB64u, encrypted.requestBody.clientBundle);
  const headers = { 'X-Published-Capability': capability };
  const availability = await runtime.call('/api/education-calls/availability');
  assert.equal(availability.status, 200, JSON.stringify(availability.json));
  assert.ok(availability.json.slots.length);
  assert.match(availability.response.headers.get('cache-control'), /no-store/);
  const slot = availability.json.slots.find(item => Date.parse(item.startAt) > Date.now() + 2 * 86400_000);
  const request = {
    sourceType: 'published', sourceId: publishedId, startAt: slot.startAt,
    contact: { fullName: 'Report Tester', email: 'report-tester@example.com' },
    idempotencyKey: 'integration-booking-one', offerVersion: EDUCATION_CALL.version,
    consent: true, reportAccessConsent: true, termsAccepted: true, earlyPerformanceConsent: true,
    reportDekB64u: access.dekB64u
  };
  assert.equal((await runtime.call('/api/education-calls/bookings', request)).status, 404, 'Published capability is mandatory');
  assert.equal((await runtime.call('/api/education-calls/bookings', { ...request, reportAccessConsent: false }, { headers })).status, 400);
  assert.equal((await runtime.call('/api/education-calls/bookings', { ...request, reportDekB64u: 'wrong-key' }, { headers })).status, 400);
  const booked = await runtime.call('/api/education-calls/bookings', request, { headers });
  assert.equal(booked.status, 200, JSON.stringify(booked.json));
  const booking = booked.json.booking;
  assert.equal(booking.amountCents, 9999);
  assert.equal(booking.status, 'awaiting_payment');
  assert.equal(meetings.length, 0, 'Unpaid request must not create Zoom');
  assert.ok(booking.reportSnapshotId);
  assert.deepEqual(objects.get(`published/assets/${booking.reportSnapshotId}/fixture-image`), new Uint8Array(image), 'Report images are copied into the consented snapshot');
  assert.ok(emails.find(email => email.to.includes(request.contact.email) && /provisional/.test(email.subject)));
  assert.ok(emails.every(email => !JSON.stringify(email).includes(access.dekB64u)));
  assert.equal((await runtime.call('/api/education-calls/bookings', request, { headers })).json.booking.id, booking.id);
  assert.equal(runtime.sql.prepare('SELECT COUNT(*) n FROM education_bookings').get().n, 1);
  const link = runtime.sql.prepare('SELECT * FROM education_call_reports WHERE booking_id = ?').get(booking.id);
  assert.ok(link.report_digest);
  const recovered = await runtime.call(`/api/advisor/published-sessions/${booking.reportSnapshotId}`, undefined, { headers: auth });
  assert.equal(recovered.status, 200);
  assert.ok(recovered.json.session.advisorSecretB64u);
  const snapRow = runtime.sql.prepare('SELECT * FROM published_sessions WHERE id = ?').get(booking.reportSnapshotId);
  const copied = await decryptPublishedSessionV4ForAdvisor(recovered.json.session.advisorSecretB64u, JSON.parse(objects.get(snapRow.advisor_r2_key)));
  assert.equal(copied.plaintext, payload, 'Gerry receives the exact report which was consented to');
  const advisorRoot = `/api/advisor/education-calls/bookings/${booking.id}`;
  assert.equal((await runtime.call(`${advisorRoot}/verify-payment`, { paymentReference: 'test-payment', amountCents: 9999, currency: 'EUR', completed: true })).status, 401);
  assert.equal((await runtime.call(`/api/advisor/leads/${booking.leadId}/send-schedule-email`, { scheduledStartAt: slot.startAt, scheduledEndAt: slot.endAt }, { headers: auth })).status, 409, 'Legacy scheduling must not bypass payment');
  const paymentLink = await runtime.call(`${advisorRoot}/payment-link`, { paymentLink: 'https://revolut.me/test/pro-payment' }, { headers: auth });
  assert.equal(paymentLink.status, 200, JSON.stringify(paymentLink.json));
  assert.ok(emails.find(email => /Payment link/.test(email.subject) && email.text.includes('https://revolut.me/test/pro-payment')));
  failZoomAuth = true;
  const waitingForZoom = await runtime.call(`${advisorRoot}/verify-payment`, { paymentReference: 'test-payment', amountCents: 9999, currency: 'EUR', completed: true }, { headers: auth });
  assert.equal(waitingForZoom.status, 200);
  assert.equal(runtime.sql.prepare('SELECT zoom_state FROM education_bookings WHERE id = ?').get(booking.id).zoom_state, 'failed', 'Pre-create OAuth failures must be retryable rather than uncertain');
  assert.equal(meetings.length, 0);
  failZoomAuth = false;
  const verified = await runtime.call(`${advisorRoot}/retry`, {}, { headers: auth });
  assert.equal(verified.status, 200, JSON.stringify(verified.json));
  assert.equal(verified.json.booking.paymentStatus, 'verified');
  assert.equal(meetings.length, 1);
  // Native consumer results include every module, including modules which the
  // older workspace publisher cannot convert. The displayed analysis is pinned.
  const credential = await createConsumerCredential();
  await createSessionRecord(runtime.env, credential, {
    aiProcessing: false, manifestId: 'fixture', policyVersion: 'fixture',
    analysisNoticeId: 'fixture', aiNoticeId: 'fixture', privacyNoticeUrl: 'https://planeir.ie/privacy/'
  }, { sessionTtlDays: 7, cohort: 'automated_test' });
  consumer.sql.prepare('UPDATE consumer_sessions SET confirmed_profile_revision = current_profile_revision WHERE id = ?').run(credential.id);
  const consumerRow = await getSessionRow(runtime.env, credential.id);
  const profile = await getCurrentProfile(runtime.env, consumerRow);
  const run = await createAnalysisRun(runtime.env, consumerRow, profile, ['mortgage_analysis']);
  await completeAnalysisRun(runtime.env, run, credential.id, {
    results: [{ moduleId: 'mortgage_analysis', outputs: { privateFixtureNumber: 456789123 } }], calculationPerformed: true
  }, ['mortgage_analysis']);
  const consumerSlot = (await runtime.call('/api/education-calls/availability')).json.slots.find(item => Date.parse(item.startAt) > Date.now() + 3 * 86400_000);
  const consumerBody = { ...request, sourceType: 'consumer', sourceId: credential.id, startAt: consumerSlot.startAt,
    analysisRunId: run.id, idempotencyKey: 'consumer-test-request', reportDekB64u: undefined };
  const consumerHeaders = { 'X-Consumer-Session': credential.credential };
  // The helper returns the full credential under token, or assemble its
  // stable wire shape when using the low-level credential factory.
  consumerHeaders['X-Consumer-Session'] = credential.token || credential.credential || `${credential.id}.${credential.secret}`;
  const wrongAnalysis = await runtime.call('/api/education-calls/bookings', { ...consumerBody, analysisRunId: 'old-analysis' }, { headers: consumerHeaders });
  assert.equal(wrongAnalysis.status, 409, JSON.stringify(wrongAnalysis.json));
  const consumerBooking = await runtime.call('/api/education-calls/bookings', consumerBody, { headers: consumerHeaders });
  assert.equal(consumerBooking.status, 200, JSON.stringify(consumerBooking.json));
  const copiedConsumer = await runtime.call(`/api/advisor/published-sessions/${consumerBooking.json.booking.reportSnapshotId}`, undefined, { headers: auth });
  assert.equal(copiedConsumer.json.session.reportKind, 'consumer-analysis-snapshot');
  assert.equal(copiedConsumer.json.session.canEmail, false);
  const consumerCopyRow = runtime.sql.prepare('SELECT * FROM published_sessions WHERE id = ?').get(consumerBooking.json.booking.reportSnapshotId);
  const nativeSnapshot = JSON.parse((await decryptPublishedSessionV4ForAdvisor(copiedConsumer.json.session.advisorSecretB64u,
    JSON.parse(objects.get(consumerCopyRow.advisor_r2_key)))).plaintext);
  assert.equal(nativeSnapshot.analysis.id, run.id);
  assert.equal(nativeSnapshot.analysis.results[0].moduleId, 'mortgage_analysis');
  assert.equal(nativeSnapshot.analysis.results[0].outputs.privateFixtureNumber, 456789123);
  const oldClosedAt = Math.floor(Date.now() / 1000) - 32 * 86400;
  runtime.sql.prepare("UPDATE education_bookings SET status = 'cancelled', updated_at = ? WHERE id = ?").run(oldClosedAt, consumerBooking.json.booking.id);
  runtime.sql.prepare("INSERT INTO education_booking_events (booking_id,created_at,actor,event_type,metadata_json) VALUES (?,?,'advisor','booking_cancelled','{}')").run(consumerBooking.json.booking.id, oldClosedAt);
  await runtime.cron();
  assert.equal(runtime.sql.prepare('SELECT state FROM education_call_reports WHERE booking_id = ?').get(consumerBooking.json.booking.id).state, 'purged');
  assert.equal(objects.has(consumerCopyRow.client_r2_key), false);
  assert.equal(objects.has(consumerCopyRow.advisor_r2_key), false);
  assert.equal(runtime.sql.prepare('SELECT recovery_payload_b64u FROM published_sessions WHERE id = ?').get(consumerCopyRow.id).recovery_payload_b64u, null);
  assert.equal(objects.has(snapRow.advisor_r2_key), true, 'Cleanup does not delete another active report');
  const confirmation = emails.find(email => /is confirmed/.test(email.subject));
  assert.ok(confirmation, JSON.stringify(emails.map(item => item.subject)));
  assert.match(confirmation.text, /€99\.99/);
  assert.match(Buffer.from(confirmation.attachments[0].content, 'base64').toString(), /DTEND:/);
  await runtime.call(`${advisorRoot}/verify-payment`, { paymentReference: 'test-payment', amountCents: 9999, currency: 'EUR', completed: true }, { headers: auth });
  assert.equal(meetings.length, 1, 'Verification retry must reuse Zoom');
  assert.equal(runtime.sql.prepare('SELECT status FROM leads WHERE id = ?').get(booking.leadId).status, 'booked');
  assert.equal(runtime.sql.prepare('SELECT COUNT(*) n FROM education_calendar_reservations WHERE lead_id = ?').get(booking.leadId).n, 0, 'A paid booking must not gain a second legacy reservation');
  const replacement = (await runtime.call('/api/education-calls/availability')).json.slots.find(item => Date.parse(item.startAt) > Date.parse(slot.startAt) + 86400_000);
  const proposed = await runtime.call(`${advisorRoot}/propose`, { startAt: replacement.startAt, revision: verified.json.booking.revision }, { headers: auth });
  assert.equal(proposed.status, 200, JSON.stringify(proposed.json));
  const accepted = await runtime.call(`/api/education-calls/bookings/${booking.id}/response`, {
    token: booking.accessToken, revision: proposed.json.booking.proposal.revision, decision: 'accept'
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  assert.equal(accepted.json.booking.startAt, replacement.startAt);
  assert.equal(accepted.json.booking.paymentStatus, 'verified');
  assert.equal(updates.length, 1);
  assert.equal(meetings.length, 1);
  const events = JSON.stringify(runtime.sql.prepare('SELECT * FROM education_booking_events').all());
  assert.ok(!events.includes(access.dekB64u) && !events.includes('918273645'), 'No report content or keys enter audit events');
  const cancelled = await runtime.call(`${advisorRoot}/cancel`, { reason: 'Integration cancellation' }, { headers: auth });
  assert.equal(cancelled.status, 200);
  assert.equal(runtime.sql.prepare('SELECT zoom_state FROM education_bookings WHERE id = ?').get(booking.id).zoom_state, 'failed', 'A rejected provider delete must remain retryable');
  failZoomDelete = false;
  assert.equal((await runtime.call(`${advisorRoot}/retry`, {}, { headers: auth })).status, 200);
  assert.equal(runtime.sql.prepare('SELECT zoom_state FROM education_bookings WHERE id = ?').get(booking.id).zoom_state, 'cancelled');
  console.log('Education booking integration: source capability, exact encrypted report sharing/recovery, payment gate, real Zoom/ICS wiring, retries, rescheduling and legacy bypass protections passed.');
} finally { globalThis.fetch = originalFetch; runtime.close(); consumer.close(); }
