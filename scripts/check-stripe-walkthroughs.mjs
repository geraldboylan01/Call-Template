import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createTestRuntime } from './lib/application-test-runtime.mjs';
import { createWalkthroughCheckout, handleStripeWebhook, stripeClient, handleStripePurchases, processStripePurchaseJobs } from '../worker/src/stripe_walkthroughs.js';
import { handleEducationCalls, processEducationCallJobs } from '../worker/src/education_calls.js';
import { educationSlots } from '../js/workspace/education_booking.js';

const time = () => Math.floor(Date.now() / 1000);
// Test the migration with actual historic parent/child rows, not only an empty
// test database. Existing payment history must survive paid-first deployment.
{
  const historic = new DatabaseSync(':memory:'); historic.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../worker/migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql') && name < '0026').sort()) historic.exec(readFileSync(new URL(name, directory),'utf8'));
  historic.prepare(`INSERT INTO education_bookings(id,source_type,source_id,idempotency_key,request_digest,access_token,
    created_at,updated_at,status,setup_state,full_name,email,start_at,end_at,hold_expires_at,amount_cents,currency,offer_version,offer_json,consent_json)
    VALUES ('historic','consumer','historic-source','key','digest','token',unixepoch(),unixepoch(),'awaiting_payment','ready',
      'Historic customer','historic@example.com',unixepoch()+200000,unixepoch()+202400,unixepoch()+86400,9999,'EUR','v2','{}','{}')`).run();
  historic.prepare(`INSERT INTO education_stripe_orders(id,booking_id,created_at,expires_at,livemode,parameters_json)
    VALUES ('historic-order','historic',unixepoch(),unixepoch()+7200,0,'{}')`).run();
  historic.prepare(`INSERT INTO education_stripe_events(id,order_id,type,processed_at) VALUES ('historic-event','historic-order','test',unixepoch())`).run();
  historic.exec('BEGIN'); historic.exec(readFileSync(new URL('0026_paid_first_walkthroughs.sql',directory),'utf8')); historic.exec('COMMIT');
  assert.equal(historic.prepare('SELECT booking_id FROM education_stripe_orders').get().booking_id, 'historic');
  assert.equal(historic.prepare('SELECT order_id FROM education_stripe_events').get().order_id, 'historic-order');
  assert.deepEqual(historic.prepare('PRAGMA foreign_key_check').all(), []); historic.close();
}
const runtime = createTestRuntime({ STRIPE_API_KEY: 'rk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
  STRIPE_WALKTHROUGHS_ENABLED: 'true', STRIPE_WALKTHROUGH_PRICE_ID: 'price_fixture', STRIPE_TAX_MODE: 'no_collection' });
const { env, sql } = runtime;
const originalFetch = globalThis.fetch;
const sessions = new Map(), intents = new Map(), keys = new Map(), requests = [];
let priceAmount = 9999;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://api.stripe.com', 'Tests must never call another provider');
  const method = options.method || 'GET';
  requests.push({ url: url.pathname, method, body: options.body, headers: new Headers(options.headers) });
  if (url.pathname === '/v1/prices/price_fixture') return Response.json({ id: 'price_fixture', object: 'price', livemode: false,
    active: true, currency: 'eur', unit_amount: priceAmount, recurring: null, tax_behavior: 'inclusive' });
  if (url.pathname === '/v1/checkout/sessions' && method === 'POST') {
    const key = new Headers(options.headers).get('Idempotency-Key');
    if (keys.has(key)) return Response.json(sessions.get(keys.get(key)));
    const body = new URLSearchParams(options.body);
    const id = `cs_test_${sessions.size + 1}`;
    const session = { id, object: 'checkout.session', livemode: false, status: 'open', payment_status: 'unpaid',
      mode: 'payment', currency: 'eur', amount_total: 9999, url: `https://checkout.stripe.com/c/pay/${id}`,
      metadata: { planeir_order: body.get('metadata[planeir_order]') }, payment_intent: null,
      client_reference_id: body.get('client_reference_id'),
      line_items: { data: [{ price: { id: 'price_fixture' }, quantity: 1 }], has_more: false } };
    sessions.set(id, session); keys.set(key, id);
    return Response.json(session);
  }
  if (url.pathname.startsWith('/v1/checkout/sessions/')) return Response.json(sessions.get(url.pathname.split('/').pop()));
  if (url.pathname.startsWith('/v1/payment_intents/')) return Response.json(intents.get(url.pathname.split('/').pop()));
  throw new Error(`Unexpected Stripe operation: ${url.pathname}`);
};

function booking() {
  const id = randomUUID(), offset = sql.prepare('SELECT COUNT(*) n FROM education_bookings').get().n * 7200;
  const start = time() + 3 * 86400 + offset;
  sql.prepare(`INSERT INTO education_bookings (id, source_type, source_id, idempotency_key, request_digest,
    access_token, created_at, updated_at, status, setup_state, full_name, email, start_at, end_at, hold_expires_at,
    amount_cents, currency, offer_version, offer_json, consent_json)
    VALUES (?, 'published', ?, ?, 'digest', 'private-fixture-token', ?, ?, 'awaiting_payment', 'ready',
      'Synthetic Test', 'synthetic@example.com', ?, ?, ?, 9999, 'EUR', 'private-education-call-v2', '{}', '{}')`)
    .run(id, id, id, time(), time(), start, start + 2400, time() + 86400);
  sql.prepare(`INSERT INTO education_calendar_reservations (id, booking_id, kind, start_at, end_at, expires_at)
    VALUES (?, ?, 'booking', ?, ?, ?)`).run(id, id, start, start + 2400, time() + 86400);
  return sql.prepare('SELECT * FROM education_bookings WHERE id = ?').get(id);
}
const orderFor = (b) => sql.prepare('SELECT * FROM education_stripe_orders WHERE booking_id = ?').get(b.id);
function paid(order) {
  const session = sessions.get(order.session_id);
  const pi = { id: `pi_${order.id}`, object: 'payment_intent', livemode: false, metadata: { planeir_order: order.id },
    status: 'succeeded', currency: 'eur', amount: 9999, amount_received: 9999,
    latest_charge: { id: 'ch_fixture', amount_refunded: 0, disputed: false } };
  intents.set(pi.id, pi);
  Object.assign(session, { payment_intent: pi, payment_status: 'paid', status: 'complete' });
  return session;
}
async function webhook(type, value, { eventId = `evt_${randomUUID()}`, signed = true, viaWorker = false, timestamp } = {}) {
  const payload = JSON.stringify({ id: eventId, object: 'event', livemode: false, type, data: { object: value } });
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: 'whsec_fixture',
    ...(timestamp ? { timestamp } : {}), cryptoProvider: Stripe.createSubtleCryptoProvider() });
  const request = new Request('https://api.planeir.ie/api/stripe/webhook', { method: 'POST',
    headers: { 'Stripe-Signature': signed ? signature : 't=1,v1=invalid' }, body: payload });
  const response = viaWorker ? await runtime.dispatch(request) : await handleStripeWebhook(request, env);
  return { status: response.status, body: await response.json() };
}

try {
  assert.throws(() => stripeClient({ STRIPE_API_KEY: 'sk_live_fixture' }), /sandbox/);
  const first = booking();
  const badAuth = await handleEducationCalls(new Request(`https://api.planeir.ie/api/education-calls/bookings/${first.id}/checkout`,
    { method: 'POST', body: JSON.stringify({ token: 'wrong' }) }), env);
  assert.equal(badAuth.status, 403); assert.equal(requests.length, 0);
  await assert.rejects(createWalkthroughCheckout({ ...env, STRIPE_WALKTHROUGHS_ENABLED: 'false' }, first), /not configured/);
  priceAmount = 1;
  await assert.rejects(createWalkthroughCheckout(env, first), /Price/);
  priceAmount = 9999;
  const created = await Promise.all([createWalkthroughCheckout(env, first), createWalkthroughCheckout(env, first)]);
  assert.equal(created[0].checkoutUrl, created[1].checkoutUrl);
  const order = orderFor(first), params = JSON.parse(order.parameters_json);
  assert.equal(keys.size, 1); assert.equal(sql.prepare('SELECT COUNT(*) n FROM education_stripe_orders').get().n, 1);
  assert.equal(params.line_items[0].price, 'price_fixture');
  assert.equal(params.automatic_tax.enabled, false);
  assert.equal('payment_method_types' in params, false);
  assert.match(params.integration_identifier, /-[a-z]{8}$/);
  assert.equal(JSON.stringify(params).includes('private-fixture-token'), false);
  assert.equal(JSON.stringify(params).includes('synthetic@example.com'), false);
  assert.equal(new URL(params.success_url).search, '?result=success');
  assert.ok(params.expires_at <= first.hold_expires_at);
  const auth = await runtime.login();
  assert.equal((await runtime.call(`/api/advisor/education-calls/bookings/${first.id}/verify-payment`,
    { paymentReference: 'manual', amountCents: 9999, currency: 'EUR', completed: true }, { headers: auth })).status, 409);
  assert.throws(() => sql.prepare('UPDATE education_bookings SET payment_link = ? WHERE id = ?').run('https://revolut.me/test', first.id), /stripe_collection/);
  const session = sessions.get(order.session_id);
  session.status = 'complete';
  assert.equal((await webhook('checkout.session.completed', session)).status, 200);
  assert.equal(sql.prepare('SELECT status FROM education_bookings WHERE id = ?').get(first.id).status, 'awaiting_payment');
  assert.equal(orderFor(first).state, 'processing');
  const paidSession = paid(order);
  const eventId = `evt_${randomUUID()}`;
  const duplicated = await Promise.all([webhook('checkout.session.async_payment_succeeded', paidSession, { eventId }),
    webhook('checkout.session.async_payment_succeeded', paidSession, { eventId })]);
  assert.deepEqual(duplicated.map(r => r.status), [200, 200]);
  assert.equal(sql.prepare('SELECT status FROM education_bookings WHERE id = ?').get(first.id).status, 'confirmed');
  assert.equal(sql.prepare('SELECT expires_at FROM education_calendar_reservations WHERE booking_id = ?').get(first.id).expires_at, null);
  await webhook('checkout.session.completed', paidSession);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM education_booking_jobs WHERE kind = 'zoom_create'").get().n, 1);
  let zooms = 0;
  await processEducationCallJobs(env, { createZoom: async () => { zooms++; return { id: 'fixture-zoom', joinUrl: 'https://zoom.us/j/123' }; }, sendEmail: async () => {} });
  assert.equal(zooms, 1);
  await webhook('checkout.session.completed', paidSession);
  await processEducationCallJobs(env, { createZoom: async () => { zooms++; } });
  assert.equal(zooms, 1);
  assert.equal((await webhook('checkout.session.completed', paidSession, { signed: false })).status, 400);
  assert.equal((await webhook('checkout.session.completed', paidSession, { timestamp: time() - 600 })).status, 400);
  assert.equal((await handleStripeWebhook(new Request('https://api.planeir.ie/api/stripe/webhook', {
    method: 'POST', body: 'x'.repeat(256001) }), env)).status, 413);

  const late = booking(); await createWalkthroughCheckout(env, late);
  const lateOrder = orderFor(late), lateSession = paid(lateOrder);
  sql.prepare("UPDATE education_bookings SET status = 'cancelled' WHERE id = ?").run(late.id);
  sql.prepare('DELETE FROM education_calendar_reservations WHERE booking_id = ?').run(late.id);
  assert.equal((await webhook('checkout.session.completed', lateSession)).status, 200);
  assert.equal(sql.prepare('SELECT payment_status FROM education_bookings WHERE id = ?').get(late.id).payment_status, 'late_review');
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM education_booking_jobs WHERE booking_id = ?").get(late.id).n, 0);

  const mismatch = booking(); await createWalkthroughCheckout(env, mismatch);
  const wrongSession = paid(orderFor(mismatch)); wrongSession.amount_total = 1;
  await webhook('checkout.session.completed', wrongSession);
  assert.equal(orderFor(mismatch).review_reason, 'amount_or_price_mismatch');
  assert.equal(sql.prepare('SELECT status FROM education_bookings WHERE id = ?').get(mismatch.id).status, 'awaiting_payment');

  const refund = booking(); await createWalkthroughCheckout(env, refund);
  const refundedSession = paid(orderFor(refund));
  refundedSession.payment_intent.latest_charge.amount_refunded = 9999;
  await webhook('charge.refunded', { payment_intent: refundedSession.payment_intent.id });
  await webhook('checkout.session.completed', refundedSession);
  assert.equal(orderFor(refund).review_reason, 'refund_requires_review');
  assert.equal(sql.prepare('SELECT status FROM education_bookings WHERE id = ?').get(refund.id).status, 'awaiting_payment');
  assert.equal(sql.prepare('SELECT payment_status FROM education_bookings WHERE id = ?').get(refund.id).payment_status, 'refunded');

  // A refund winning between the paid-event read and its transaction must block
  // fulfilment, even when the handler already read a successful payment.
  const racing = booking(); await createWalkthroughCheckout(env, racing);
  const racingSession = paid(orderFor(racing));
  const originalBatch = env.LEADS_DB.batch;
  let injectRefund = true;
  env.LEADS_DB.batch = async statements => {
    if (injectRefund && statements.some(statement => statement.sql.includes('INSERT INTO education_stripe_payment_operations'))) {
      injectRefund = false;
      racingSession.payment_intent.latest_charge.amount_refunded = 9999;
      assert.equal((await webhook('charge.refunded', { payment_intent: racingSession.payment_intent.id })).status, 200);
    }
    return originalBatch(statements);
  };
  const racingEvent = `evt_${randomUUID()}`;
  assert.equal((await webhook('checkout.session.completed', racingSession, { eventId: racingEvent })).status, 503);
  env.LEADS_DB.batch = originalBatch;
  assert.equal((await webhook('checkout.session.completed', racingSession, { eventId: racingEvent })).status, 200);
  assert.equal(orderFor(racing).state, 'review');
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM education_booking_jobs WHERE booking_id = ?").get(racing.id).n, 0);

  const afterPaid = booking(); await createWalkthroughCheckout(env, afterPaid);
  const afterSession = paid(orderFor(afterPaid));
  await webhook('checkout.session.completed', afterSession);
  afterSession.payment_intent.latest_charge.amount_refunded = 9999;
  await webhook('charge.refunded', { payment_intent: afterSession.payment_intent.id });
  await processEducationCallJobs(env, { createZoom: async value => {
    assert.notEqual(value.id, afterPaid.id, 'Refunded bookings cannot start queued Zoom delivery');
    return { id: 'other-fixture-zoom', joinUrl: 'https://zoom.us/j/123' };
  }, sendEmail: async () => {} });
  assert.equal(sql.prepare('SELECT state FROM education_booking_jobs WHERE booking_id = ?').get(afterPaid.id).state, 'superseded');

  const retry = booking(); await createWalkthroughCheckout(env, retry);
  const retrySession = paid(orderFor(retry));
  const batch = env.LEADS_DB.batch;
  env.LEADS_DB.batch = async () => { throw new Error('Synthetic database failure'); };
  const retryEvent = `evt_${randomUUID()}`;
  assert.equal((await webhook('checkout.session.completed', retrySession, { eventId: retryEvent })).status, 503);
  assert.equal(sql.prepare('SELECT id FROM education_stripe_events WHERE id = ?').get(retryEvent), undefined);
  env.LEADS_DB.batch = batch;
  // Worker dispatch proves signed webhooks work without a browser Origin.
  // Disable external delivery in this fixture while retaining the durable job.
  env.STRIPE_WALKTHROUGHS_ENABLED = 'false';
  assert.equal((await webhook('checkout.session.completed', retrySession, { eventId: retryEvent })).status, 200);
  assert.equal(orderFor(retry).state, 'paid', 'Kill switch must not drop outstanding payments');
  const unknown = await webhook('unhandled.event', { id: 'unrelated' }, { viaWorker: true });
  assert.equal(unknown.status, 200);
  // The new journey buys a durable entitlement first. No appointment, calendar
  // hold or Zoom call exists until the paid customer selects a time.
  env.STRIPE_WALKTHROUGHS_ENABLED = 'true';
  const purchaseEmails = [], bookingEmails = [];
  const hooks = {
    resolveCustomer: async request => request.headers.get('X-Test-Customer') === 'private-source-capability'
      ? { contact: { fullName: 'Paid First Customer', email: 'paid-first@example.com' }, customerId: 'trusted-existing-user' } : new Response('{}', { status: 403 }),
    createLead: async () => ({ leadId: 456 }), createReportSnapshot: async () => ({ id: 'exact-report-copy' }),
    encryptDiscussionTopics: async (text, id) => `encrypted:${Buffer.from(`${id}:${text}`).toString('base64url')}`,
    decryptDiscussionTopics: async (text, id) => Buffer.from(text.slice(10), 'base64url').toString().slice(id.length + 1),
    requireAdvisor: async request => request.headers.get('X-Test-Admin') === 'yes',
    sendPurchaseEmail: async delivery => purchaseEmails.push(delivery),
    createZoom: async () => ({ id: 'paid-first-zoom', joinUrl: 'https://zoom.us/j/paid-first' }),
    updateZoom: async () => {},
    sendEmail: async delivery => bookingEmails.push(delivery)
  };
  async function purchaseCall(path, body, { source = true, admin = false, deliver = false } = {}) {
    const request = new Request(`https://api.planeir.ie${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(source ? { 'X-Test-Customer': 'private-source-capability' } : {}), ...(admin ? { 'X-Test-Admin': 'yes' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await handleStripePurchases(request, env, deliver ? hooks : { ...hooks, sendEmail: undefined });
    return { status: result.status, body: await result.json() };
  }
  const purchaseBody = { sourceType: 'consumer', sourceId: 'paid-first-source', analysisRunId: 'exact-analysis-run',
    idempotencyKey: randomUUID(), offerVersion: 'private-education-call-v2', consent: true, reportAccessConsent: true,
    termsAccepted: true, earlyPerformanceConsent: true, contact: { fullName: 'Tampered', email: 'attacker@example.com' } };
  assert.equal((await purchaseCall('/api/education-calls/purchases', purchaseBody, { source: false })).status, 403);
  const preBookings = sql.prepare('SELECT COUNT(*) n FROM education_bookings').get().n;
  const pending = await purchaseCall('/api/education-calls/purchases', purchaseBody);
  assert.equal(pending.status, 200, JSON.stringify(pending.body));
  assert.equal(pending.body.purchase.contact.email, 'paid-first@example.com', 'Contact is taken from the authenticated profile');
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM education_bookings').get().n, preBookings);
  const purchase = pending.body.purchase, purchasePath = `/api/education-calls/purchases/${purchase.id}`;
  const repeated = await purchaseCall('/api/education-calls/purchases', { ...purchaseBody, idempotencyKey: randomUUID() });
  assert.equal(repeated.body.purchase.id, purchase.id, 'New clicks resume an existing purchase instead of charging twice');
  const recalculated = await purchaseCall('/api/education-calls/purchases', { ...purchaseBody, analysisRunId: 'new-analysis-run', idempotencyKey: randomUUID() });
  assert.equal(recalculated.body.purchase.id, purchase.id, 'Recalculating the same customer report does not create a second charge');
  assert.equal(recalculated.body.purchase.analysisRunId, 'exact-analysis-run', 'Recovery preserves the purchased immutable analysis');
  assert.equal((await purchaseCall(`${purchasePath}?token=wrong`, undefined, { source: false })).status, 403);
  const checkout = await Promise.all([purchaseCall(`${purchasePath}/checkout`, { token: purchase.accessToken }),
    purchaseCall(`${purchasePath}/checkout`, { token: purchase.accessToken })]);
  assert.equal(checkout[0].status, 200, JSON.stringify(checkout[0].body));
  assert.equal(checkout[0].body.checkoutUrl, checkout[1].body.checkoutUrl);
  let newOrder = sql.prepare('SELECT * FROM education_stripe_orders WHERE id = ?').get(purchase.id);
  const newParameters = JSON.parse(newOrder.parameters_json);
  assert.equal(newParameters.customer_email, 'paid-first@example.com');
  assert.equal(newParameters.client_reference_id, purchase.id);
  assert.equal(JSON.stringify(newParameters).includes(purchase.accessToken), false);
  assert.equal(JSON.stringify(newParameters).includes('private-source-capability'), false);
  const slots = educationSlots().filter(slot => Date.parse(slot.startAt) >= Date.now() + 25 * 3600000);
  const beforePayment = await purchaseCall(`${purchasePath}/schedule`, { token: purchase.accessToken, startAt: slots[0].startAt });
  assert.equal(beforePayment.status, 409);
  const newSession = paid(newOrder), newEvent = `evt_${randomUUID()}`;
  assert.deepEqual((await Promise.all([webhook('checkout.session.completed', newSession, { eventId: newEvent }),
    webhook('checkout.session.completed', newSession, { eventId: newEvent })])).map(value => value.status), [200,200]);
  newOrder = sql.prepare('SELECT * FROM education_stripe_orders WHERE id = ?').get(purchase.id);
  assert.equal(newOrder.state, 'paid'); assert.equal(newOrder.lifecycle, 'awaiting_scheduling'); assert.equal(newOrder.booking_id, null);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM education_bookings').get().n, preBookings);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM education_stripe_jobs WHERE order_id = ?').get(purchase.id).n, 2);
  await processStripePurchaseJobs(env, { ...hooks, canSendWalkthroughEmail: () => false });
  assert.equal(sql.prepare('SELECT SUM(attempts) n FROM education_stripe_jobs WHERE order_id = ?').get(purchase.id).n, 0,
    'Intentional activation gating does not exhaust retry attempts');
  await processStripePurchaseJobs(env, hooks); await processStripePurchaseJobs(env, hooks);
  assert.equal(purchaseEmails.filter(email => email.purchase.id === purchase.id).length, 2);
  assert.deepEqual(new Set(purchaseEmails.filter(email => email.purchase.id === purchase.id).map(email => email.kind)), new Set(['purchase_paid_customer','purchase_paid_admin']));
  const recovered = await purchaseCall('/api/education-calls/purchases?sourceType=consumer&sourceId=paid-first-source&analysisRunId=exact-analysis-run');
  assert.equal(recovered.body.purchase.id, purchase.id); assert.equal(recovered.body.purchase.accessToken, purchase.accessToken);
  const soon = await purchaseCall(`${purchasePath}/schedule`, { token: purchase.accessToken, startAt: new Date(Date.now() + 23 * 3600000).toISOString() });
  assert.equal(soon.status, 400); assert.equal(sql.prepare('SELECT booking_id FROM education_stripe_orders WHERE id = ?').get(purchase.id).booking_id, null);
  const topics = 'Please explain my retirement scenarios and assumptions.';
  const scheduled = await purchaseCall(`${purchasePath}/schedule`, { token: purchase.accessToken, startAt: slots[0].startAt, discussionTopics: topics });
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  assert.equal(scheduled.body.purchase.status, 'scheduled'); assert.equal(scheduled.body.purchase.discussionTopics, topics);
  assert.equal(scheduled.body.purchase.booking.paymentStatus, 'verified');
  assert.equal(scheduled.body.purchase.booking.accessToken, purchase.accessToken);
  const stored = sql.prepare('SELECT * FROM education_bookings WHERE id = ?').get(scheduled.body.purchase.bookingId);
  assert.equal(stored.report_snapshot_id, 'exact-report-copy');
  assert.equal(stored.discussion_topics_ciphertext.includes(topics), false);
  assert.equal((await purchaseCall(`${purchasePath}/schedule`, { token: purchase.accessToken, startAt: slots[0].startAt })).body.purchase.bookingId, stored.id);
  await processEducationCallJobs(env, { ...hooks, canSendWalkthroughEmail: () => false });
  assert.equal(sql.prepare(`SELECT SUM(attempts) n FROM education_booking_jobs WHERE booking_id = ? AND kind IN ('booking_confirmed','booking_confirmed_admin')`).get(stored.id).n, 0);
  await processEducationCallJobs(env, hooks);
  assert.equal(sql.prepare('SELECT zoom_meeting_id FROM education_bookings WHERE id = ?').get(stored.id).zoom_meeting_id, 'paid-first-zoom');
  assert.equal(bookingEmails.filter(email => email.booking.id === stored.id && email.kind === 'booking_confirmed').length, 1);
  assert.equal(bookingEmails.filter(email => email.booking.id === stored.id && email.kind === 'booking_confirmed_admin').length, 1);
  const completePath = `/api/advisor/education-calls/purchases/${purchase.id}/completed`;
  assert.equal((await purchaseCall(completePath, {}, { source: false })).status, 401);
  assert.equal((await purchaseCall(completePath, {}, { admin: true })).body.purchase.status, 'completed');
  assert.equal((await purchaseCall('/api/education-calls/purchases?sourceType=consumer&sourceId=paid-first-source&analysisRunId=exact-analysis-run')).body.purchase, null,
    'Completed historic purchases do not block a later walkthrough purchase');
  async function extraPurchase(sourceSuffix, { verify = true } = {}) {
    const result = await purchaseCall('/api/education-calls/purchases', { ...purchaseBody, sourceId: sourceSuffix, idempotencyKey: randomUUID() });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const p = result.body.purchase, path = `/api/education-calls/purchases/${p.id}`;
    assert.equal((await purchaseCall(`${path}/checkout`, { token: p.accessToken })).status, 200);
    const order = sql.prepare('SELECT * FROM education_stripe_orders WHERE id = ?').get(p.id);
    if (verify) assert.equal((await webhook('checkout.session.completed', paid(order))).status, 200);
    return { p, path, order };
  }
  const contenderA = await extraPurchase('contender-a'), contenderB = await extraPurchase('contender-b');
  const raceSlot = slots.find(slot => Date.parse(slot.startAt) > Date.parse(slots[0].endAt) + 7200000);
  const racingBookings = await Promise.all([purchaseCall(`${contenderA.path}/schedule`, { token: contenderA.p.accessToken, startAt: raceSlot.startAt }),
    purchaseCall(`${contenderB.path}/schedule`, { token: contenderB.p.accessToken, startAt: raceSlot.startAt })]);
  assert.deepEqual(racingBookings.map(result => result.status).sort(), [200,409]);
  const raceConflict = racingBookings.find(result => result.status === 409);
  assert.equal(raceConflict.body.code, 'calendar_conflict'); assert.ok(Array.isArray(raceConflict.body.slots));
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM education_calendar_reservations WHERE start_at = ?').get(Math.floor(Date.parse(raceSlot.startAt)/1000)).n, 1);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM education_stripe_orders WHERE id IN (?,?) AND state='paid' AND booking_id IS NULL").get(contenderA.p.id,contenderB.p.id).n, 1,
    'The customer losing a slot race keeps the paid unscheduled entitlement');
  const expiredPurchase = await extraPurchase('expired-purchase', { verify: false });
  sessions.get(expiredPurchase.order.session_id).status = 'expired';
  await webhook('checkout.session.expired', sessions.get(expiredPurchase.order.session_id));
  assert.equal((await purchaseCall('/api/education-calls/purchases?sourceType=consumer&sourceId=expired-purchase&analysisRunId=exact-analysis-run')).body.purchase, null);
  assert.equal((await purchaseCall('/api/education-calls/purchases', { ...purchaseBody, sourceId: 'expired-purchase', idempotencyKey: randomUUID() })).status, 200);
  const receiptCount = purchaseEmails.filter(delivery => delivery.purchase.id === purchase.id).length;
  sql.prepare(`UPDATE education_stripe_jobs SET state = 'processing',claimed_at = ?,first_attempt_at = ?,attempts = 1
    WHERE order_id = ? AND kind = 'purchase_paid_customer'`).run(time()-90000,time()-90000,purchase.id);
  await processStripePurchaseJobs(env,hooks);
  assert.equal(sql.prepare(`SELECT state FROM education_stripe_jobs WHERE order_id = ? AND kind = 'purchase_paid_customer'`).get(purchase.id).state,'uncertain');
  assert.equal(purchaseEmails.filter(delivery => delivery.purchase.id === purchase.id).length,receiptCount,
    'A crash recovered after provider idempotency expires cannot resend an uncertain receipt');
  const confirmationCount = bookingEmails.filter(delivery => delivery.booking.id === stored.id).length;
  sql.prepare(`UPDATE education_booking_jobs SET state = 'processing',claimed_at = ?,first_attempt_at = ?,attempts = 1
    WHERE booking_id = ? AND kind = 'booking_confirmed_admin'`).run(time()-90000,time()-90000,stored.id);
  await processEducationCallJobs(env,hooks);
  assert.equal(sql.prepare(`SELECT state FROM education_booking_jobs WHERE booking_id = ? AND kind = 'booking_confirmed_admin'`).get(stored.id).state,'uncertain');
  assert.equal(bookingEmails.filter(delivery => delivery.booking.id === stored.id).length,confirmationCount);
  await assert.rejects(createWalkthroughCheckout({ ...env, STRIPE_MODE: 'live', STRIPE_API_KEY: 'rk_live_fixture' }, booking()), /activated/);
  console.log('Stripe checks passed: historic migration preservation, trusted profile authorization, paid-first recovery, checkout/webhook races, payment validation, 24-hour notice, encrypted topics, shared slot conflicts, separate recipient deliveries, activation gates and retry-window reconciliation.');
} finally { globalThis.fetch = originalFetch; runtime.close(); }
