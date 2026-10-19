import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createTestRuntime } from './lib/application-test-runtime.mjs';
import { createConsumerCredential } from '../worker/src/consumer/crypto.js';
import { createSessionRecord, getSessionRow, getCurrentProfile, createAnalysisRun, completeAnalysisRun } from '../worker/src/consumer/repository.js';
import { EDUCATION_CALL } from '../js/workspace/education_call.js';
import { encryptPublishedSessionV4, buildPublishedCapabilityToken, resolvePublishedClientSessionAccess } from '../js/crypto_session.js';

const objects = new Map();
const bucket = {
  async put(key, value) { objects.set(key, typeof value === 'string' ? value : new Uint8Array(value)); },
  async get(key) { const value = objects.get(key); return value === undefined ? null : { text: async () => typeof value === 'string' ? value : new TextDecoder().decode(value), body: new Blob([value]).stream() }; },
  async delete(key) { objects.delete(key); },
  async list({ prefix }) { return { objects: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }; }
};
const runtime = createTestRuntime({ EDUCATION_CALLS_ENABLED: 'true', WALKTHROUGH_EMAILS_ENABLED: 'true', SESSIONS_BUCKET: bucket,
  STRIPE_WALKTHROUGHS_ENABLED: 'true', STRIPE_API_KEY: 'rk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
  STRIPE_WALKTHROUGH_PRICE_ID: 'price_fixture', STRIPE_TAX_MODE: 'no_collection',
  ZOOM_ACCOUNT_ID: 'test', ZOOM_CLIENT_ID: 'test', ZOOM_CLIENT_SECRET: 'test', ZOOM_USER_ID: 'test-host' });
const consumer = createTestRuntime();
for (const file of readdirSync(new URL('../worker/consumer-migrations/', import.meta.url)).filter(file => file.endsWith('.sql')).sort()) consumer.sql.exec(readFileSync(new URL(`../worker/consumer-migrations/${file}`, import.meta.url), 'utf8'));
runtime.env.CONSUMER_DB = consumer.db;
runtime.env.CONSUMER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64url');
const originalFetch = globalThis.fetch, emails = [], meetings = [], sessions = new Map(), checkoutKeys = new Map();
globalThis.fetch = async (url, options = {}) => {
  const target = new URL(String(url));
  if (target.origin === 'https://api.stripe.com') {
    if (target.pathname === '/v1/prices/price_fixture') return Response.json({ id: 'price_fixture', livemode: false, active: true, currency: 'eur', unit_amount: 9999, recurring: null, tax_behavior: 'inclusive' });
    if (target.pathname === '/v1/checkout/sessions') {
      const key = new Headers(options.headers).get('Idempotency-Key');
      if (checkoutKeys.has(key)) return Response.json(sessions.get(checkoutKeys.get(key)));
      const params = new URLSearchParams(options.body), id = `cs_test_${sessions.size + 1}`;
      assert.equal(params.has('payment_method_types[0]'), false);
      const session = { id, livemode: false, status: 'open', payment_status: 'unpaid', mode: 'payment', currency: 'eur', amount_total: 9999,
        metadata: { planeir_order: params.get('metadata[planeir_order]') }, client_reference_id: params.get('client_reference_id'),
        url: `https://checkout.stripe.com/c/pay/${id}`, payment_intent: null,
        line_items: { data: [{ price: { id: 'price_fixture' }, quantity: 1 }], has_more: false } };
      assert.equal(params.get('customer_email'), 'saved-profile@example.com');
      sessions.set(id, session); checkoutKeys.set(key, id); return Response.json(session);
    }
    if (target.pathname.startsWith('/v1/checkout/sessions/')) return Response.json(sessions.get(target.pathname.split('/').pop()));
  }
  if (target.href.startsWith('https://zoom.us/oauth/token')) return Response.json({ access_token: 'fixture-zoom-token' });
  if (target.href === 'https://api.zoom.us/v2/users/test-host/meetings') {
    meetings.push(JSON.parse(options.body)); return Response.json({ id: 12345678, join_url: 'https://zoom.us/j/12345678', password: 'fixture-pass' });
  }
  if (target.href === 'https://api.resend.com/emails') {
    emails.push({ ...JSON.parse(options.body), key: new Headers(options.headers).get('Idempotency-Key') }); return Response.json({ id: `mail-${emails.length}` });
  }
  throw new Error(`Unexpected external integration request: ${target.origin}${target.pathname}`);
};

try {
  const auth = await runtime.login();
  const credential = await createConsumerCredential();
  await createSessionRecord(runtime.env, credential, { aiProcessing: false, manifestId: 'fixture', policyVersion: 'fixture', analysisNoticeId: 'fixture', aiNoticeId: 'fixture', privacyNoticeUrl: 'https://planeir.ie/privacy/' }, { sessionTtlDays: 7, cohort: 'automated_test' });
  consumer.sql.prepare('UPDATE consumer_sessions SET confirmed_profile_revision = current_profile_revision WHERE id = ?').run(credential.id);
  const sessionRow = await getSessionRow(runtime.env, credential.id), profile = await getCurrentProfile(runtime.env, sessionRow);
  const run = await createAnalysisRun(runtime.env, sessionRow, profile, ['mortgage_analysis']);
  await completeAnalysisRun(runtime.env, run, credential.id, { results: [{ moduleId: 'mortgage_analysis', outputs: { privateFinancialFixture: 918273645 } }], calculationPerformed: true }, ['mortgage_analysis']);
  const headers = { 'X-Consumer-Session': credential.credential };
  const source = { sourceType: 'consumer', sourceId: credential.id, analysisRunId: run.id };
  const query = new URLSearchParams(source);
  assert.equal((await runtime.call(`/api/education-calls/profile?${query}`)).status, 404);
  assert.equal((await runtime.call(`/api/education-calls/profile?${query}`, undefined, { headers })).json.profile, null);
  const purchaseBody = { ...source, idempotencyKey: 'integration-purchase', offerVersion: EDUCATION_CALL.version,
    consent: true, reportAccessConsent: true, termsAccepted: true, earlyPerformanceConsent: true };
  const missing = await runtime.call('/api/education-calls/purchases', purchaseBody, { headers });
  assert.equal(missing.status, 409, JSON.stringify(missing.json)); assert.equal(missing.json.code, 'profile_contact_required');
  const saved = await runtime.call('/api/education-calls/profile', { ...source, contact: { fullName: 'Saved Profile', email: 'saved-profile@example.com' } }, { method: 'PATCH', headers });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(JSON.stringify(runtime.sql.prepare('SELECT * FROM education_customer_profiles').get()).includes('saved-profile@example.com'), false);
  const purchased = await runtime.call('/api/education-calls/purchases', { ...purchaseBody, contact: { fullName: 'Forged', email: 'forged@example.com' } }, { headers });
  assert.equal(purchased.status, 200, JSON.stringify(purchased.json)); const purchase = purchased.json.purchase;
  assert.equal(purchase.contact.email, 'saved-profile@example.com');
  assert.equal(runtime.sql.prepare('SELECT COUNT(*) n FROM education_bookings').get().n, 0);
  assert.equal(runtime.sql.prepare('SELECT COUNT(*) n FROM education_calendar_reservations').get().n, 0);
  assert.equal(emails.length, 0); assert.equal(meetings.length, 0);
  assert.equal((await runtime.call(`/api/education-calls/purchases/${purchase.id}?token=wrong`)).status, 403);
  const checkout = await runtime.call(`/api/education-calls/purchases/${purchase.id}/checkout`, { token: purchase.accessToken });
  assert.equal(checkout.status, 200, JSON.stringify(checkout.json));
  const order = runtime.sql.prepare('SELECT * FROM education_stripe_orders WHERE id = ?').get(purchase.id);
  const stripeSession = sessions.get(order.session_id);
  Object.assign(stripeSession, { status: 'complete', payment_status: 'paid', payment_intent: {
    id: `pi_${purchase.id}`, livemode: false, status: 'succeeded', currency: 'eur', amount: 9999, amount_received: 9999,
    metadata: { planeir_order: purchase.id }, latest_charge: { amount_refunded: 0, disputed: false } } });
  const payload = JSON.stringify({ id: 'evt_integration_paid', livemode: false, type: 'checkout.session.completed', data: { object: stripeSession } });
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: runtime.env.STRIPE_WEBHOOK_SECRET, cryptoProvider: Stripe.createSubtleCryptoProvider() });
  const deliver = () => runtime.dispatch(new Request('https://api.planeir.ie/api/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': signature }, body: payload }));
  assert.equal((await deliver()).status, 200); assert.equal((await deliver()).status, 200);
  assert.equal(meetings.length, 0, 'Payment without scheduling must not create Zoom');
  assert.equal(emails.length, 2, JSON.stringify(emails));
  const receipt = emails.find(mail => mail.to.includes('saved-profile@example.com'));
  const paymentAdmin = emails.find(mail => mail.to.includes('advisor@example.com'));
  assert.match(receipt.subject, /payment confirmed/); assert.match(receipt.text, /#purchase=/); assert.match(receipt.text, /24 hours/);
  assert.match(paymentAdmin.text, /View advisor analysis: https:\/\/planeir.ie\/app\/education-call-report.html\?pub=/);
  assert.match(paymentAdmin.text, /View client analysis: .*view=client#ak=/);
  assert.ok(emails.every(mail => !mail.text.includes('918273645')), 'No financial figures in emails');
  const recovered = await runtime.call(`/api/education-calls/purchases?${query}`, undefined, { headers });
  assert.equal(recovered.json.purchase.id, purchase.id); assert.equal(recovered.json.purchase.paymentStatus, 'paid');
  assert.equal('reportAdvisorLink' in recovered.json.purchase, false, 'Customer responses never disclose staff keys');
  assert.match(recovered.json.purchase.reportClientLink, /#ck=/);
  const future = (await runtime.call('/api/education-calls/availability')).json.slots.find(slot => Date.parse(slot.startAt) > Date.now() + 2 * 86400_000);
  const topics = 'I would like to explore a different retirement age.';
  const booked = await runtime.call(`/api/education-calls/purchases/${purchase.id}/schedule`, { token: purchase.accessToken, startAt: future.startAt, discussionTopics: topics });
  assert.equal(booked.status, 200, JSON.stringify(booked.json)); assert.equal(meetings.length, 1);
  assert.equal(booked.json.purchase.discussionTopics, topics);
  assert.equal(JSON.stringify(runtime.sql.prepare('SELECT * FROM education_stripe_orders WHERE id = ?').get(purchase.id)).includes(topics), false);
  // The durable Zoom operation queues emails after saving its actual details.
  await runtime.cron();
  assert.equal(emails.length, 4, JSON.stringify(emails.map(email => email.subject)));
  const bookingAdmin = emails.find(mail => mail.to.includes('advisor@example.com') && mail.subject.includes('walkthrough booked'));
  assert.ok(bookingAdmin, JSON.stringify(emails.map(mail => mail.subject))); assert.ok(bookingAdmin.text.includes(topics));
  assert.match(bookingAdmin.text, /https:\/\/zoom.us\/j\/12345678/); assert.match(bookingAdmin.text, /view=client#ak=/);
  const bookingCustomer = emails.find(mail => mail.to.includes('saved-profile@example.com') && mail.subject.includes('is booked'));
  assert.match(bookingCustomer.text, /View your Planéir analysis: .*#ck=/); assert.ok(bookingCustomer.attachments?.[0]?.filename.endsWith('.ics'));
  assert.equal((await deliver()).status, 200); await runtime.cron(); assert.equal(emails.length, 4); assert.equal(meetings.length, 1);
  const adminList = await runtime.call('/api/advisor/education-calls/purchases', undefined, { headers: auth });
  assert.equal(adminList.status, 200); assert.match(adminList.json.purchases[0].reportAdvisorLink, /#ak=/);
  assert.equal(adminList.json.purchases[0].paymentEmailStatus, 'sent');
  assert.equal(adminList.json.purchases[0].bookingEmailStatus, 'sent');
  assert.equal(adminList.json.purchases[0].adminBookingEmailStatus, 'sent');
  // Published report identity is also recovered from its authenticated saved row.
  const bundle = await encryptPublishedSessionV4({ clientSessionJson: JSON.stringify({ modules: [] }), advisorSessionJson: '{}', clientName: 'Published Customer', clientEmail: 'published@example.com' });
  const published = await runtime.call('/api/published-sessions', bundle.requestBody, { headers: auth });
  const pubHeaders = { 'X-Published-Capability': await buildPublishedCapabilityToken(bundle.clientSecretB64u, 'client') };
  const pubProfile = await runtime.call(`/api/education-calls/profile?sourceType=published&sourceId=${published.json.publishedId}`, undefined, { headers: pubHeaders });
  assert.equal(pubProfile.status, 200); assert.equal(pubProfile.json.profile.email, 'published@example.com');
  const pubAccess = await resolvePublishedClientSessionAccess(bundle.clientSecretB64u, bundle.requestBody.clientBundle);
  const pubPurchase = await runtime.call('/api/education-calls/purchases', { ...purchaseBody, sourceType: 'published', sourceId: published.json.publishedId, analysisRunId: undefined, reportDekB64u: pubAccess.dekB64u, idempotencyKey: 'published-purchase' }, { headers: pubHeaders });
  assert.equal(pubPurchase.status, 200, JSON.stringify(pubPurchase.json)); assert.equal(pubPurchase.json.purchase.email, 'published@example.com');
  assert.equal((await runtime.call('/api/education-calls/profile', { sourceType: 'published', sourceId: published.json.publishedId,
    contact: { fullName: 'Unauthorised', email: 'intruder@example.com' } }, { method: 'PATCH' })).status, 404);
  const savedPublished = await runtime.call('/api/education-calls/profile', { sourceType: 'published', sourceId: published.json.publishedId,
    contact: { fullName: 'Published Customer', email: 'updated-saved@example.com' } }, { method: 'PATCH', headers: pubHeaders });
  assert.equal(savedPublished.status, 200); assert.equal(savedPublished.json.profile.email, 'updated-saved@example.com');
  assert.equal(JSON.stringify(runtime.sql.prepare("SELECT * FROM education_customer_profiles WHERE source_type = 'published'").get()).includes('updated-saved@example.com'), false);
  console.log('Walkthrough purchase integration passed: saved source identity, encrypted profile/topics, real Worker webhook routing, browser abandonment, four independent emails, exact protected analysis links, one Zoom and replay safety.');
} finally { globalThis.fetch = originalFetch; runtime.close(); consumer.close(); }
