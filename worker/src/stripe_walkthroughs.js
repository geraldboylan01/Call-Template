import Stripe from 'stripe';
import { EDUCATION_CALL } from '../../js/workspace/education_call.js';
import { schedulePaidStripePurchase, serializeEducationBooking, processEducationCallJobs, availableSlots } from './education_calls.js';

const now = () => Math.floor(Date.now() / 1000);
const fail = (message, status = 503) => Object.assign(new Error(message), { status });
const stmt = (env, sql, ...values) => env.LEADS_DB.prepare(sql).bind(...values);
const getOrder = (env, bookingId) => stmt(env, 'SELECT * FROM education_stripe_orders WHERE booking_id = ?', bookingId).first();
const response = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const idOf = (value) => typeof value === 'string' ? value : value?.id;
const liveMode = (env) => env.STRIPE_MODE === 'live';

const stripeWalkthroughsEnabled = (env) => String(env.STRIPE_WALKTHROUGHS_ENABLED) === 'true';

export function stripeClient(env) {
  const key = String(env.STRIPE_API_KEY || '').trim();
  const mode = env.STRIPE_MODE || 'test';
  if (!['test', 'live'].includes(mode) || !new RegExp(`^(rk|sk)_${mode}_`).test(key)) {
    throw fail('Stripe credentials do not match the configured sandbox or live environment.');
  }
  return new Stripe(key, { httpClient: Stripe.createFetchHttpClient(), timeout: 10000, maxNetworkRetries: 2 });
}

function configured(env) {
  if (!stripeWalkthroughsEnabled(env) || !/^price_/.test(env.STRIPE_WALKTHROUGH_PRICE_ID || '')
    || !/^whsec_/.test(env.STRIPE_WEBHOOK_SECRET || '') || env.STRIPE_TAX_MODE !== 'no_collection') {
    throw fail('Stripe walkthrough checkout is not configured.');
  }
  if (liveMode(env) && String(env.STRIPE_WALKTHROUGH_LIVE_ACTIVATED) !== 'true') {
    throw fail('Live walkthrough payments have not been activated.');
  }
}

export async function stripeBookingDetails(env, booking) {
  // Without the feature flag, old deployments need not query the new tables.
  if (!stripeWalkthroughsEnabled(env) && booking.paymentProvider !== 'stripe') return {};
  const order = await getOrder(env, booking.id);
  const currentOffer = booking.amountCents === EDUCATION_CALL.priceMinor && booking.currency === EDUCATION_CALL.currency;
  return {
    paymentProvider: order ? 'stripe' : booking.paymentLink || !currentOffer ? 'revolut' : 'stripe',
    stripeCheckoutAvailable: stripeWalkthroughsEnabled(env) && currentOffer && booking.setupState === 'ready'
      && !booking.paymentLink && booking.status === 'awaiting_payment'
      && booking.paymentStatus === 'pending' && (!order || ['creating', 'open'].includes(order.state)),
    stripePaymentState: order?.state || null,
    stripePaymentReview: order?.review_reason || null
  };
}

export async function createWalkthroughCheckout(env, booking) {
  configured(env);
  if (booking.status !== 'awaiting_payment' || booking.payment_status !== 'pending' || booking.setup_state !== 'ready'
    || booking.payment_link || booking.hold_expires_at <= now() + 1860 || booking.start_at <= now()
    || booking.amount_cents !== EDUCATION_CALL.priceMinor || booking.currency !== EDUCATION_CALL.currency) {
    throw fail('This booking cannot start checkout. Refresh it or contact hello@planeir.ie.', 409);
  }
  const stripe = stripeClient(env);
  let order = await getOrder(env, booking.id);
  if (!order) {
    const price = await stripe.prices.retrieve(env.STRIPE_WALKTHROUGH_PRICE_ID);
    if (price.livemode !== liveMode(env) || !price.active || price.currency !== 'eur' || price.unit_amount !== 9999 || price.recurring
      || price.tax_behavior !== 'inclusive') throw fail('The configured Stripe Price does not match the walkthrough.');
    const origin = new URL(env.STRIPE_RETURN_ORIGIN || 'https://planeir.ie');
    if (origin.origin !== origin.href.replace(/\/$/, '') || (origin.protocol !== 'https:'
      && !['http://127.0.0.1:8080', 'http://localhost:8080'].includes(origin.origin))) throw fail('Stripe return origin is invalid.');
    const id = crypto.randomUUID();
    const suffix = [...crypto.getRandomValues(new Uint8Array(8))].map(v => String.fromCharCode(97 + v % 26)).join('');
    const params = {
      mode: 'payment', line_items: [{ price: price.id, quantity: 1 }],
      expires_at: Math.min(booking.hold_expires_at, now() + 23 * 3600),
      metadata: { planeir_order: id }, payment_intent_data: { metadata: { planeir_order: id } },
      success_url: `${origin.origin}/app/walkthrough-payment.html?result=success`,
      cancel_url: `${origin.origin}/app/walkthrough-payment.html?result=cancelled`,
      integration_identifier: `planeir-walkthrough-${suffix}`,
      automatic_tax: { enabled: false }, adaptive_pricing: { enabled: false }
    };
    // Receipt collection is handled by Checkout. Paid invoice generation is an
    // explicit separate choice because it can incur additional Invoicing fees.
    if (String(env.STRIPE_WALKTHROUGH_INVOICES_ENABLED) === 'true') params.invoice_creation = { enabled: true };
    await stmt(env, `INSERT OR IGNORE INTO education_stripe_orders
      (id, booking_id, created_at, expires_at, parameters_json, livemode) VALUES (?, ?, ?, ?, ?, ?)`,
    id, booking.id, now(), params.expires_at, JSON.stringify(params), Number(liveMode(env))).run();
    order = await getOrder(env, booking.id);
  }
  if (Boolean(order.livemode) !== liveMode(env)) throw fail('This order belongs to a different Stripe environment.');
  if (!['creating', 'open'].includes(order.state) || order.expires_at <= now() + 30) throw fail('This checkout is no longer available. Refresh your booking.', 409);
  // After the provider's idempotency retention window we never re-create an
  // attempt: expires_at is earlier than 24h and remains immutable in D1.
  const session = order.session_id ? await stripe.checkout.sessions.retrieve(order.session_id)
    : await stripe.checkout.sessions.create(JSON.parse(order.parameters_json), { idempotencyKey: `planeir-checkout-${order.id}` });
  if (session.livemode !== liveMode(env) || session.metadata?.planeir_order !== order.id) throw fail('Stripe checkout identity did not match.');
  await stmt(env, `UPDATE education_stripe_orders SET session_id = ?, state = CASE WHEN state = 'creating' THEN 'open' ELSE state END
    WHERE id = ? AND (session_id IS NULL OR session_id = ?)`, session.id, order.id, session.id).run();
  // A cancellation or webhook may win while Stripe is creating the Session.
  const current = await stmt(env, 'SELECT * FROM education_bookings WHERE id = ?', booking.id).first();
  const currentOrder = await getOrder(env, booking.id);
  if (current.status !== 'awaiting_payment' || current.payment_status !== 'pending' || current.hold_expires_at <= now()
    || !['creating','open'].includes(currentOrder.state) || session.status !== 'open') throw fail('This checkout is no longer available.', 409);
  const checkoutUrl = new URL(session.url);
  if (checkoutUrl.protocol !== 'https:' || checkoutUrl.hostname !== 'checkout.stripe.com') throw fail('Stripe returned an invalid checkout URL.');
  return { checkoutUrl: checkoutUrl.href };
}

const iso = value => value == null ? null : new Date(value * 1000).toISOString();
const orderById = (env, id) => stmt(env, 'SELECT * FROM education_stripe_orders WHERE id = ? AND source_type IS NOT NULL', id).first();
const randomToken = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
const clean = (value, max, label) => {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw fail(`Enter a valid ${label}.`, 400);
  return text;
};
async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function requestBody(request) {
  if (Number(request.headers.get('Content-Length')) > 50_000) throw fail('Request is too large.', 413);
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > 50_000) throw new Error();
    return body;
  } catch { throw fail('Invalid walkthrough request.', 400); }
}
function sourceValues(body) {
  if (!['consumer', 'published'].includes(body.sourceType)) throw fail('Choose a completed report.', 400);
  return { sourceType: body.sourceType, sourceId: clean(body.sourceId, 200, 'report identity'),
    analysisRunId: body.sourceType === 'consumer' ? clean(body.analysisRunId, 200, 'completed analysis identity') : null };
}
function purchaseStatus(order) {
  if (order.lifecycle === 'cancelled') return 'cancelled';
  if (order.lifecycle === 'completed') return 'completed';
  if (order.state === 'review') return 'review';
  if (order.state === 'expired') return 'expired';
  if (order.state === 'paid') return order.booking_id ? 'scheduled' : 'paid';
  return 'pending';
}
async function publicPurchase(env, order, hooks = {}, includeToken = true) {
  let booking = order.booking_id ? serializeEducationBooking(await stmt(env, 'SELECT * FROM education_bookings WHERE id = ?', order.booking_id).first(), { includeToken }) : null;
  if (booking && hooks.decorateBooking) booking = await hooks.decorateBooking(booking, { advisor: !includeToken });
  let value = {
    id: order.id, sourceType: order.source_type, sourceId: order.source_id, analysisRunId: order.analysis_run_id,
    customerId: order.customer_id, contact: { fullName: order.full_name, email: order.email, phone: order.phone || '' },
    fullName: order.full_name, email: order.email, createdAt: iso(order.created_at), updatedAt: iso(order.updated_at),
    paidAt: iso(order.paid_at), paymentVerifiedAt: iso(order.paid_at), completedAt: iso(order.completed_at),
    status: purchaseStatus(order), lifecycle: order.lifecycle,
    paymentStatus: order.refund_status === 'refunded' ? 'refunded'
      : order.state === 'review' ? order.review_reason === 'payment_failed' ? 'failed' : 'review'
        : order.state === 'paid' ? 'paid' : order.state === 'processing' ? 'processing' : order.state === 'expired' ? 'failed' : 'pending',
    paymentReference: order.payment_intent_id ? `stripe:${order.payment_intent_id}` : '',
    amountCents: order.amount_cents, currency: order.currency, offerVersion: order.offer_version,
    reportSnapshotId: order.report_snapshot_id, leadId: order.lead_id, bookingId: order.booking_id, booking,
    discussionTopics: order.discussion_topics_ciphertext && hooks.decryptDiscussionTopics
      ? await hooks.decryptDiscussionTopics(order.discussion_topics_ciphertext, order.id) : '',
    setupState: order.setup_state, reviewReason: order.review_reason,
    ...(includeToken ? { accessToken: order.access_token } : {})
  };
  const jobs = (await stmt(env, 'SELECT kind,state FROM education_stripe_jobs WHERE order_id = ?', order.id).all()).results || [];
  value.paymentEmailStatus = jobs.find(job => job.kind === 'purchase_paid_customer')?.state || 'pending';
  value.adminPaymentEmailStatus = jobs.find(job => job.kind === 'purchase_paid_admin')?.state || 'pending';
  if (booking) {
    const bookingJobs = (await stmt(env, `SELECT kind,state FROM education_booking_jobs WHERE booking_id = ?
      AND revision = ? AND kind IN ('booking_confirmed','booking_confirmed_admin')`, booking.id, booking.scheduleRevision).all()).results || [];
    value.bookingEmailStatus = bookingJobs.find(job => job.kind === 'booking_confirmed')?.state || 'pending';
    value.adminBookingEmailStatus = bookingJobs.find(job => job.kind === 'booking_confirmed_admin')?.state || 'pending';
  } else value.bookingEmailStatus = 'not scheduled';
  if (order.booking_id) {
    const bookingJobs = (await stmt(env, `SELECT kind,state FROM education_booking_jobs WHERE booking_id = ?
      AND revision = (SELECT schedule_revision FROM education_bookings WHERE id = ?)
      AND kind IN ('booking_confirmed','booking_confirmed_admin')`, order.booking_id, order.booking_id).all()).results || [];
    value.bookingEmailStatus = bookingJobs.find(job => job.kind === 'booking_confirmed')?.state || 'pending';
    value.adminBookingEmailStatus = bookingJobs.find(job => job.kind === 'booking_confirmed_admin')?.state || 'pending';
  }
  if (hooks.decoratePurchase) value = await hooks.decoratePurchase(value, { advisor: !includeToken });
  return value;
}
export function stripePurchaseRouteMethods(path) {
  if (path === '/api/education-calls/purchases') return 'GET,POST,OPTIONS';
  if (/^\/api\/education-calls\/purchases\/[^/]+$/.test(path)) return 'GET,OPTIONS';
  if (/^\/api\/education-calls\/purchases\/[^/]+\/(checkout|schedule)$/.test(path)) return 'POST,OPTIONS';
  if (path === '/api/advisor/education-calls/purchases') return 'GET,OPTIONS';
  if (/^\/api\/advisor\/education-calls\/purchases\/[^/]+\/completed$/.test(path)) return 'POST,OPTIONS';
  return null;
}
export async function listStripePurchases(env, hooks = {}) {
  const orders = (await stmt(env, 'SELECT * FROM education_stripe_orders WHERE source_type IS NOT NULL ORDER BY created_at DESC LIMIT 250').all()).results || [];
  return Promise.all(orders.map(order => publicPurchase(env, order, hooks, false)));
}
async function preparePurchase(request, env, hooks, body) {
  configured(env);
  const source = sourceValues(body), key = clean(body.idempotencyKey, 120, 'purchase request identity');
  if (body.offerVersion !== EDUCATION_CALL.version) throw fail('The walkthrough offer changed. Refresh before continuing.', 409);
  if (![body.consent, body.reportAccessConsent, body.termsAccepted, body.earlyPerformanceConsent].every(value => value === true)) {
    throw fail('Accept the walkthrough terms and give permission to view this report.', 400);
  }
  const context = await hooks.resolveCustomer?.(request, { ...body, ...source });
  if (context instanceof Response) return context;
  if (!context) throw fail('This report is unavailable.', 403);
  const contact = context.contact;
  if (!contact?.fullName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email || '')) {
    throw Object.assign(fail('Save your name and email in your profile before booking a walkthrough.', 409), { code: 'profile_contact_required' });
  }
  const sourceKey = JSON.stringify([source.sourceType, source.sourceId]);
  // No provider Session means no payment can be in flight. Such abandoned
  // setup attempts can safely expire without waiting for a provider webhook.
  await stmt(env, `UPDATE education_stripe_orders SET state = 'expired',updated_at = unixepoch()
    WHERE source_key = ? AND session_id IS NULL AND state = 'creating' AND expires_at <= unixepoch()`, sourceKey).run();
  const requestDigest = await hash({ ...source, contact, offerVersion: body.offerVersion, consent: true });
  let order = await stmt(env, 'SELECT * FROM education_stripe_orders WHERE source_type = ? AND source_id = ? AND idempotency_key = ?', source.sourceType, source.sourceId, key).first();
  if (order && order.request_digest !== requestDigest) throw fail('This purchase request was already used for another report.', 409);
  order ||= await stmt(env, `SELECT * FROM education_stripe_orders WHERE source_key = ? AND state != 'expired'
    AND lifecycle NOT IN ('completed','cancelled') ORDER BY created_at DESC LIMIT 1`, sourceKey).first();
  if (order && order.setup_state !== 'ready' && order.analysis_run_id !== source.analysisRunId) {
    // An interrupted pre-payment setup cannot use a newly calculated report to
    // repair an older purchase's immutable consent. No Checkout can exist yet.
    const expired = await stmt(env, `UPDATE education_stripe_orders SET state = 'expired',updated_at = unixepoch()
      WHERE id = ? AND setup_state != 'ready' AND state = 'creating' AND session_id IS NULL`, order.id).run();
    if (expired.meta?.changes) order = null;
    else {
      order = await orderById(env, order.id);
      if (order.setup_state !== 'ready') throw Object.assign(fail('The saved report changed. Refresh your walkthrough before continuing.',409), { code: 'purchase_report_changed' });
    }
  }
  if (!order) {
    const activeBooking = await stmt(env, `SELECT id FROM education_bookings WHERE source_type = ? AND source_id = ?
      AND ((status = 'confirmed' AND end_at > unixepoch()) OR (status = 'awaiting_payment' AND hold_expires_at > unixepoch())) LIMIT 1`, source.sourceType, source.sourceId).first();
    if (activeBooking) throw fail('This report already has an active walkthrough booking. Use its existing booking link.', 409);
    const id = crypto.randomUUID(), timestamp = now();
    await stmt(env, `INSERT OR IGNORE INTO education_stripe_orders
      (id,created_at,updated_at,expires_at,livemode,parameters_json,source_type,source_id,analysis_run_id,source_key,customer_id,
       access_token,idempotency_key,request_digest,full_name,email,phone,amount_cents,currency,offer_version,offer_json,consent_json,setup_state)
      VALUES (?,?,?,?,?,'{}',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending')`,
    id, timestamp, timestamp, timestamp + 23 * 3600, Number(liveMode(env)), source.sourceType, source.sourceId, source.analysisRunId,
    sourceKey, context.customerId || source.sourceId, randomToken(), key, requestDigest, contact.fullName, contact.email.toLowerCase(), contact.phone || '',
    EDUCATION_CALL.priceMinor, EDUCATION_CALL.currency, body.offerVersion, JSON.stringify(EDUCATION_CALL),
    JSON.stringify({ consent: true, reportAccessConsent: true, termsAccepted: true, earlyPerformanceConsent: true,
      offerVersion: body.offerVersion, policyVersion: body.policyVersion || '', at: iso(timestamp), ...source })).run();
    order = await stmt(env, 'SELECT * FROM education_stripe_orders WHERE source_key = ? AND state != \'expired\' AND lifecycle NOT IN (\'completed\',\'cancelled\')', sourceKey).first();
  }
  if (order.setup_state !== 'ready') {
    const claim = randomToken(), timestamp = now();
    const claimed = await stmt(env, `UPDATE education_stripe_orders SET setup_token = ?, setup_claimed_at = ?, setup_state = 'pending'
      WHERE id = ? AND setup_state != 'ready' AND (setup_claimed_at IS NULL OR setup_claimed_at <= ?)`, claim, timestamp, order.id, timestamp - 120).run();
    if (!claimed.meta?.changes) throw fail('Your walkthrough is being prepared. Retry shortly.', 409);
    try {
      const savedContact = { fullName: order.full_name, email: order.email, phone: order.phone || '' };
      const payload = { ...body, sourceType: order.source_type, sourceId: order.source_id, analysisRunId: order.analysis_run_id,
        offerVersion: order.offer_version, contact: savedContact, bookingId: order.id };
      const lead = await hooks.createLead(context, payload), leadId = lead?.leadId || lead?.id || lead;
      if (!leadId) throw fail('The customer record is unavailable.');
      const snapshot = await hooks.createReportSnapshot(context, { ...payload, leadId });
      const snapshotId = snapshot?.id || snapshot?.snapshotId || snapshot;
      if (!snapshotId) throw fail('The consented report is unavailable.');
      await stmt(env, `UPDATE education_stripe_orders SET setup_state = 'ready',lead_id = ?,report_snapshot_id = ?,updated_at = ?
        WHERE id = ? AND setup_token = ? AND setup_state = 'pending'`, leadId, String(snapshotId), now(), order.id, claim).run();
    } catch (error) {
      await stmt(env, `UPDATE education_stripe_orders SET setup_state = 'failed',setup_claimed_at = NULL,updated_at = ?
        WHERE id = ? AND setup_token = ? AND setup_state = 'pending'`, now(), order.id, claim).run();
      throw error;
    }
    order = await orderById(env, order.id);
  }
  return order;
}
async function purchaseCheckout(env, order) {
  configured(env);
  if (!['creating','open'].includes(order.state) || order.setup_state !== 'ready' || order.booking_id
    || order.lifecycle !== 'pending' || order.expires_at <= now() + 30) throw fail('This checkout is no longer available.', 409);
  if (!order.session_id && order.expires_at <= now() + 1800) throw fail('This checkout expired. Return to your report to start again.', 409);
  if (Boolean(order.livemode) !== liveMode(env)) throw fail('This purchase belongs to a different Stripe environment.', 409);
  const stripe = stripeClient(env);
  if (order.parameters_json === '{}') {
    const price = await stripe.prices.retrieve(env.STRIPE_WALKTHROUGH_PRICE_ID);
    if (price.livemode !== liveMode(env) || !price.active || price.currency !== 'eur' || price.unit_amount !== order.amount_cents
      || price.recurring || price.tax_behavior !== 'inclusive') throw fail('The configured Stripe Price does not match the walkthrough.');
    const origin = new URL(env.STRIPE_RETURN_ORIGIN || 'https://planeir.ie');
    if (origin.origin !== origin.href.replace(/\/$/, '') || (origin.protocol !== 'https:'
      && !['http://127.0.0.1:8080','http://localhost:8080'].includes(origin.origin))) throw fail('Stripe return origin is invalid.');
    const suffix = Array.from(crypto.getRandomValues(new Uint8Array(8)), value => String.fromCharCode(97 + value % 26)).join('');
    const params = { mode: 'payment', line_items: [{ price: price.id, quantity: 1 }], expires_at: order.expires_at,
      customer_email: order.email, client_reference_id: order.id, metadata: { planeir_order: order.id },
      payment_intent_data: { metadata: { planeir_order: order.id } },
      success_url: `${origin.origin}/app/walkthrough-payment.html?result=success&purchase=${encodeURIComponent(order.id)}`,
      cancel_url: `${origin.origin}/app/walkthrough-payment.html?result=cancelled&purchase=${encodeURIComponent(order.id)}`,
      integration_identifier: `planeir-walkthrough-${suffix}`, automatic_tax: { enabled: false }, adaptive_pricing: { enabled: false } };
    if (String(env.STRIPE_WALKTHROUGH_INVOICES_ENABLED) === 'true') params.invoice_creation = { enabled: true };
    await stmt(env, `UPDATE education_stripe_orders SET parameters_json = ? WHERE id = ? AND parameters_json = '{}'`, JSON.stringify(params), order.id).run();
    order = await orderById(env, order.id);
  }
  const session = order.session_id ? await stripe.checkout.sessions.retrieve(order.session_id)
    : await stripe.checkout.sessions.create(JSON.parse(order.parameters_json), { idempotencyKey: `planeir-checkout-${order.id}` });
  if (session.livemode !== liveMode(env) || session.metadata?.planeir_order !== order.id || session.client_reference_id !== order.id) throw fail('Stripe checkout identity did not match.');
  await stmt(env, `UPDATE education_stripe_orders SET session_id = ?,state = CASE WHEN state = 'creating' THEN 'open' ELSE state END,updated_at = ?
    WHERE id = ? AND (session_id IS NULL OR session_id = ?)`, session.id, now(), order.id, session.id).run();
  const current = await orderById(env, order.id);
  if (!['creating','open'].includes(current.state) || session.status !== 'open') throw fail('This checkout is no longer available.', 409);
  const url = new URL(session.url);
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') throw fail('Stripe returned an invalid checkout URL.');
  return url.href;
}
export async function handleStripePurchases(request, env, hooks = {}) {
  const url = new URL(request.url), path = url.pathname;
  if (!stripePurchaseRouteMethods(path)) return null;
  try {
    let body = request.method === 'POST' ? await requestBody(request) : {}, result;
    const admin = path.startsWith('/api/advisor/');
    if (admin) {
      const auth = await hooks.requireAdvisor?.(request);
      if (auth instanceof Response) return auth;
      if (auth?.response) return auth.response;
      if (!auth) throw fail('Sign in to manage walkthroughs.', 401);
    }
    if (path === '/api/education-calls/purchases' && request.method === 'POST') {
      const order = await preparePurchase(request, env, hooks, body);
      if (order instanceof Response) return order;
      result = { purchase: await publicPurchase(env, order, hooks) };
    } else if (path === '/api/education-calls/purchases' && request.method === 'GET') {
      const source = sourceValues(Object.fromEntries(url.searchParams));
      const context = await hooks.resolveCustomer?.(request, source, { profileOnly: true });
      if (context instanceof Response) return context;
      if (!context) throw fail('This report is unavailable.', 403);
      const sourceKey = JSON.stringify([source.sourceType, source.sourceId]);
      await stmt(env, `UPDATE education_stripe_orders SET state = 'expired',updated_at = unixepoch()
        WHERE source_key = ? AND session_id IS NULL AND state = 'creating' AND expires_at <= unixepoch()`, sourceKey).run();
      const order = await stmt(env, `SELECT * FROM education_stripe_orders WHERE source_key = ? AND state != 'expired'
        AND lifecycle NOT IN ('completed','cancelled') ORDER BY created_at DESC LIMIT 1`, sourceKey).first();
      result = { purchase: order ? await publicPurchase(env, order, hooks) : null };
    } else if (admin && path === '/api/advisor/education-calls/purchases' && request.method === 'GET') {
      result = { purchases: await listStripePurchases(env, hooks) };
    } else {
      const match = /^\/api\/(advisor\/)?education-calls\/purchases\/([^/]+)(?:\/(checkout|schedule|completed))?$/.exec(path);
      if (!match) throw fail('Purchase route not found.', 404);
      let order = await orderById(env, match[2]);
      if (!order) throw fail('Purchase not found.', 404);
      if (!admin && (body.token || url.searchParams.get('token')) !== order.access_token) throw fail('This private purchase link is invalid.', 403);
      const action = match[3];
      if (request.method === 'GET' && !action) result = { purchase: await publicPurchase(env, order, hooks, !admin) };
      else if (request.method !== 'POST') throw fail('Method not allowed.', 405);
      else if (!admin && action === 'checkout') result = { checkoutUrl: await purchaseCheckout(env, order), purchase: await publicPurchase(env, await orderById(env, order.id), hooks) };
      else if (!admin && action === 'schedule') {
        if (!order.booking_id) await schedulePaidStripePurchase(env, order, body, hooks);
        order = await orderById(env, order.id);
        result = { purchase: await publicPurchase(env, order, hooks) };
      } else if (admin && action === 'completed') {
        if (order.state !== 'paid' || !order.booking_id || !['scheduled','completed'].includes(order.lifecycle)) throw fail('Only a paid scheduled walkthrough can be completed.', 409);
        const completed = await env.LEADS_DB.batch([
          stmt(env, `UPDATE education_stripe_orders SET lifecycle = 'completed',completed_at = COALESCE(completed_at,unixepoch()),updated_at = unixepoch()
            WHERE id = ? AND lifecycle = 'scheduled' AND state = 'paid'
            AND EXISTS (SELECT 1 FROM education_bookings WHERE id = education_stripe_orders.booking_id AND status = 'confirmed')`, order.id),
          stmt(env, `UPDATE education_bookings SET completed_at = COALESCE(completed_at,unixepoch()),updated_at = unixepoch()
            WHERE id = ? AND status = 'confirmed' AND EXISTS (SELECT 1 FROM education_stripe_orders WHERE id = ? AND lifecycle = 'completed')`, order.booking_id, order.id)
        ]);
        if (!completed[0].meta?.changes && order.lifecycle !== 'completed') throw fail('The walkthrough changed. Refresh it before marking it completed.', 409);
        result = { purchase: await publicPurchase(env, await orderById(env, order.id), hooks, false) };
      } else throw fail('Purchase action not found.', 404);
    }
    if (request.method === 'POST' && hooks.sendEmail) {
      const work = processEducationCallJobs(env, hooks).catch(() => {});
      if (hooks.waitUntil) hooks.waitUntil(work); else await work;
    }
    const output = response(result);
    const origin = request.headers.get('Origin');
    if (origin && String(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).includes(origin)) {
      output.headers.set('Access-Control-Allow-Origin', origin); output.headers.set('Vary','Origin');
    }
    return output;
  } catch (error) {
    const message = String(error?.message || ''), conflict = /education_calendar_conflict|education_source_already_booked|stripe_purchase_not_schedulable|UNIQUE constraint failed/.test(message);
    const status = conflict ? 409 : error.status || error.statusCode || 500;
    return response({ error: message.includes('education_calendar_conflict') ? 'That time was just reserved. Choose another available time.'
      : status >= 500 ? 'The walkthrough service is temporarily unavailable. Please try again.' : error.message,
      code: ['profile_contact_required','purchase_report_changed'].includes(error.code) ? error.code : (message.includes('education_calendar_conflict') ? 'calendar_conflict' : conflict ? 'purchase_changed' : 'walkthrough_error'),
      ...(message.includes('education_calendar_conflict') ? { slots: await availableSlots(env) } : {}) }, status);
  }
}

// Separate recipient jobs ensure a failed administrator delivery never repeats
// a customer receipt that has already succeeded (and vice versa).
export async function processStripePurchaseJobs(env, hooks = {}, { limit = 20 } = {}) {
  if (!hooks.sendPurchaseEmail || !env.LEADS_DB) return [];
  if (hooks.canSendWalkthroughEmail && !hooks.canSendWalkthroughEmail()) return [];
  await stmt(env, `UPDATE education_stripe_jobs SET state = 'pending',updated_at = unixepoch()
    WHERE state = 'processing' AND claimed_at <= unixepoch() - 600`).run();
  await stmt(env, `UPDATE education_stripe_jobs SET state = 'uncertain',updated_at = unixepoch(),
    last_error = 'Delivery requires reconciliation after the provider idempotency window.'
    WHERE state IN ('pending','failed') AND attempts > 0 AND first_attempt_at <= unixepoch() - 82800`).run();
  const jobs = (await stmt(env, `SELECT * FROM education_stripe_jobs WHERE state = 'pending'
    OR (state = 'failed' AND attempts < 8 AND updated_at <= unixepoch() - MIN(3600,60 * (1 << attempts))) ORDER BY created_at LIMIT ?`, limit).all()).results || [];
  const results = [];
  for (const job of jobs) {
    const claim = randomToken();
    const claimed = await stmt(env, `UPDATE education_stripe_jobs SET state = 'processing',claim_token = ?,claimed_at = unixepoch(),
      updated_at = unixepoch(),attempts = attempts + 1,first_attempt_at = COALESCE(first_attempt_at,unixepoch())
      WHERE id = ? AND state IN ('pending','failed')`, claim, job.id).run();
    if (!claimed.meta?.changes) continue;
    try {
      const order = await orderById(env, job.order_id);
      if (!order?.paid_at || order.state !== 'paid') {
        await stmt(env, `UPDATE education_stripe_jobs SET state = 'superseded',updated_at = unixepoch() WHERE id = ? AND claim_token = ?`, job.id, claim).run();
        continue;
      }
      await hooks.sendPurchaseEmail({ id: job.id, kind: job.kind, idempotencyKey: `walkthrough-${order.id}-${job.kind}`,
        purchase: await publicPurchase(env, order, hooks) });
      await stmt(env, `UPDATE education_stripe_jobs SET state = 'sent',updated_at = unixepoch(),last_error = NULL WHERE id = ? AND claim_token = ? AND state = 'processing'`, job.id, claim).run();
      results.push({ id: job.id, state: 'sent' });
    } catch (error) {
      await stmt(env, `UPDATE education_stripe_jobs SET state = 'failed',updated_at = unixepoch(),last_error = ? WHERE id = ? AND claim_token = ? AND state = 'processing'`,
      String(error?.message || 'Email delivery failed').slice(0,500), job.id, claim).run();
      results.push({ id: job.id, state: 'failed' });
    }
  }
  return results;
}

async function readRawBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw fail('Missing webhook body.', 400);
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 256000) { await reader.cancel(); throw fail('Webhook is too large.', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

const eventStmt = (env, event, order) => stmt(env,
  'INSERT INTO education_stripe_events (id, order_id, type, processed_at) VALUES (?, ?, ?, ?)', event.id, order.id, event.type, now());

async function recordReview(env, event, order, reason, paymentIntent = null, fullyRefunded = false) {
  await env.LEADS_DB.batch([
    eventStmt(env, event, order),
    stmt(env, `UPDATE education_stripe_orders SET state = 'review', review_reason = ?,
      payment_intent_id = COALESCE(payment_intent_id, ?), refund_status = CASE WHEN ? THEN 'refunded' ELSE refund_status END
      WHERE id = ?`, reason, paymentIntent, Number(fullyRefunded), order.id),
    ...(fullyRefunded ? [stmt(env, `UPDATE education_bookings SET payment_status = 'refunded',
      payment_reference = COALESCE(payment_reference, ?), updated_at = unixepoch(), revision = revision + 1
      WHERE id = ? AND (payment_reference IS NULL OR payment_reference = ?)`, `stripe:${paymentIntent}`, order.booking_id, `stripe:${paymentIntent}`)] : [])
  ]);
}

async function processEvent(env, stripe, event) {
  if (await stmt(env, 'SELECT id FROM education_stripe_events WHERE id = ?', event.id).first()) return;
  const value = event.data.object;
  if (['charge.refunded', 'charge.dispute.created', 'charge.dispute.closed'].includes(event.type)) {
    const pi = await stripe.paymentIntents.retrieve(idOf(value.payment_intent), { expand: ['latest_charge'] });
    const order = await stmt(env, 'SELECT * FROM education_stripe_orders WHERE id = ?', pi.metadata?.planeir_order || '').first();
    if (!order) return;
    if (Boolean(order.livemode) !== liveMode(env) || pi.livemode !== liveMode(env)) throw fail('Payment environment mismatch.');
    if (order.payment_intent_id && order.payment_intent_id !== pi.id) throw fail('Payment identity mismatch.');
    await recordReview(env, event, order, event.type === 'charge.refunded' ? 'refund_requires_review' : 'dispute_requires_review',
      pi.id, pi.latest_charge?.amount_refunded >= 9999);
    return;
  }
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired'].includes(event.type)) return;
  const order = await stmt(env, 'SELECT * FROM education_stripe_orders WHERE id = ?', value.metadata?.planeir_order || '').first();
  if (!order) return; // Other products can share the account and webhook endpoint.
  const session = await stripe.checkout.sessions.retrieve(value.id, { expand: ['line_items', 'payment_intent.latest_charge'] });
  if (Boolean(order.livemode) !== liveMode(env) || session.livemode !== liveMode(env) || session.mode !== 'payment' || session.metadata?.planeir_order !== order.id
    || (order.session_id && order.session_id !== session.id) || (order.source_type && session.client_reference_id !== order.id)) throw fail('Checkout identity mismatch.');
  const line = session.line_items?.data?.[0];
  if (session.currency !== 'eur' || session.amount_total !== 9999 || session.line_items?.has_more
    || session.line_items?.data?.length !== 1 || line?.quantity !== 1
    || idOf(line.price) !== JSON.parse(order.parameters_json).line_items[0].price) {
    await recordReview(env, event, order, 'amount_or_price_mismatch'); return;
  }
  const pi = session.payment_intent;
  if (pi && typeof pi === 'object' && (pi.metadata?.planeir_order !== order.id || pi.livemode !== liveMode(env))) throw fail('Payment identity mismatch.');
  const charge = pi?.latest_charge;
  if (charge && typeof charge === 'object' && (charge.amount_refunded > 0 || charge.disputed)) {
    await recordReview(env, event, order, charge.disputed ? 'dispute_requires_review' : 'refund_requires_review', pi.id, charge.amount_refunded >= 9999); return;
  }
  if (session.payment_status !== 'paid' || session.status !== 'complete') {
    const state = order.payment_intent_id ? order.state : session.status === 'expired' ? 'expired'
      : event.type === 'checkout.session.async_payment_failed' ? 'review' : 'processing';
    await env.LEADS_DB.batch([eventStmt(env, event, order), stmt(env,
      `UPDATE education_stripe_orders SET state = ?, session_id = COALESCE(session_id, ?),
      review_reason = CASE WHEN ? = 'review' THEN 'payment_failed' ELSE review_reason END WHERE id = ?`, state, session.id, state, order.id)]);
    return;
  }
  if (!pi || typeof pi !== 'object' || pi.status !== 'succeeded' || !pi.id) throw fail('Payment is not confirmed.');
  if (pi.currency !== 'eur' || pi.amount !== 9999 || pi.amount_received !== 9999) {
    await recordReview(env, event, order, 'payment_amount_mismatch', pi.id); return;
  }
  if (order.payment_intent_id) {
    if (order.payment_intent_id !== pi.id) throw fail('Payment identity mismatch.');
    await eventStmt(env, event, order).run(); return;
  }
  if (order.state === 'review') { await eventStmt(env, event, order).run(); return; }
  if (order.source_type) {
    if (order.setup_state !== 'ready') throw fail('The consented report is not ready.');
    const guard = crypto.randomUUID();
    await env.LEADS_DB.batch([
      stmt(env, 'INSERT INTO education_stripe_payment_operations (id,order_id) VALUES (?,?)', guard, order.id),
      eventStmt(env, event, order),
      stmt(env, `UPDATE education_stripe_orders SET state = 'paid',session_id = ?,payment_intent_id = ?,paid_at = unixepoch(),
        updated_at = unixepoch(),lifecycle = 'awaiting_scheduling',review_reason = NULL WHERE id = ?`, session.id, pi.id, order.id),
      ...['purchase_paid_customer','purchase_paid_admin'].map(kind => stmt(env, `INSERT OR IGNORE INTO education_stripe_jobs
        (id,order_id,kind,created_at,updated_at) VALUES (?,?,?,unixepoch(),unixepoch())`, `${order.id}-${kind}`, order.id, kind)),
      stmt(env, 'DELETE FROM education_stripe_payment_operations WHERE id = ?', guard)
    ]);
    return;
  }
  const booking = await stmt(env, 'SELECT * FROM education_bookings WHERE id = ?', order.booking_id).first();
  if (!booking) throw fail('Booking is unavailable.');
  const eligible = `status = 'awaiting_payment' AND payment_status = 'pending' AND setup_state = 'ready'
    AND hold_expires_at > unixepoch() AND start_at > unixepoch()
    AND EXISTS (SELECT 1 FROM education_calendar_reservations r WHERE r.booking_id = education_bookings.id
      AND r.expires_at > unixepoch() AND r.start_at = education_bookings.start_at AND r.end_at = education_bookings.end_at)`;
  const reference = `stripe:${pi.id}`;
  const guard = crypto.randomUUID();
  // Event, payment, reservation and durable delivery job commit together. Every
  // CASE sees the original row. Eligibility is checked by the database clock.
  await env.LEADS_DB.batch([
    stmt(env, 'INSERT INTO education_stripe_payment_operations (id, order_id) VALUES (?, ?)', guard, order.id),
    stmt(env, 'INSERT INTO education_booking_operations (id, booking_id, expected_revision) VALUES (?, ?, ?)', guard, booking.id, booking.revision),
    eventStmt(env, event, order),
    stmt(env, `UPDATE education_bookings SET
      status = CASE WHEN ${eligible} THEN 'confirmed' ELSE status END,
      payment_status = CASE WHEN ${eligible} THEN 'verified' ELSE 'late_review' END,
      zoom_state = CASE WHEN ${eligible} THEN 'pending' ELSE zoom_state END,
      hold_expires_at = CASE WHEN ${eligible} THEN NULL ELSE hold_expires_at END,
      payment_reference = ?, payment_verified_at = unixepoch(), updated_at = unixepoch(), revision = revision + 1
      WHERE id = ?`, reference, booking.id),
    stmt(env, `UPDATE education_calendar_reservations SET expires_at = NULL WHERE booking_id = ?
      AND EXISTS (SELECT 1 FROM education_bookings b WHERE b.id = ? AND b.payment_status = 'verified' AND b.payment_reference = ?)`, booking.id, booking.id, reference),
    stmt(env, `INSERT OR IGNORE INTO education_booking_jobs (id, booking_id, revision, kind, created_at, updated_at, payload_json)
      SELECT ?, id, schedule_revision, 'zoom_create', unixepoch(), unixepoch(),
        json_object('scheduleRevision', schedule_revision, 'startAt', start_at, 'endAt', end_at)
      FROM education_bookings WHERE id = ? AND payment_status = 'verified' AND payment_reference = ?`, `stripe-zoom-${order.id}`, booking.id, reference),
    stmt(env, `UPDATE education_stripe_orders SET session_id = ?, payment_intent_id = ?,
      state = CASE WHEN (SELECT payment_status FROM education_bookings WHERE id = ?) = 'verified' THEN 'paid' ELSE 'review' END,
      review_reason = CASE WHEN (SELECT payment_status FROM education_bookings WHERE id = ?) = 'verified' THEN NULL ELSE 'late_payment' END
      WHERE id = ?`, session.id, pi.id, booking.id, booking.id, order.id),
    stmt(env, `INSERT INTO education_booking_events (booking_id, created_at, actor, event_type, metadata_json)
      VALUES (?, unixepoch(), 'stripe', 'stripe_payment_received', ?)`, booking.id, JSON.stringify({ paymentIntent: pi.id })),
    stmt(env, 'DELETE FROM education_booking_operations WHERE id = ?', guard),
    stmt(env, 'DELETE FROM education_stripe_payment_operations WHERE id = ?', guard)
  ]);
}

export async function handleStripeWebhook(request, env) {
  if (request.method !== 'POST') return response({ error: 'Method not allowed.' }, 405);
  if (!env.LEADS_DB || !/^whsec_/.test(env.STRIPE_WEBHOOK_SECRET || '')) return response({ error: 'Webhook is not configured.' }, 503);
  let event;
  try {
    const stripe = stripeClient(env);
    event = await stripe.webhooks.constructEventAsync(await readRawBody(request), request.headers.get('stripe-signature'),
      env.STRIPE_WEBHOOK_SECRET, 300, Stripe.createSubtleCryptoProvider());
    if (event.livemode !== liveMode(env)) return response({ error: 'Unexpected payment environment.' }, 400);
  } catch (error) { return response({ error: 'Invalid webhook.' }, error.status === 413 ? 413 : 400); }
  try {
    await processEvent(env, stripeClient(env), event);
    return response({ received: true });
  } catch {
    // A simultaneous duplicate loses its unique-event transaction. It can be
    // acknowledged only after the winning transaction is durably visible.
    if (await stmt(env, 'SELECT id FROM education_stripe_events WHERE id = ?', event.id).first()) return response({ received: true });
    return response({ error: 'Payment processing will retry.' }, 503);
  }
}
