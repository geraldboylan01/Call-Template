import { EDUCATION_CALL } from '../../js/workspace/education_call.js';
import { EDUCATION_BOOKING, dublinParts, educationSlots, intervalsOverlap, validateEducationSlot as validateSlot } from '../../js/workspace/education_booking.js';
import { createWalkthroughCheckout, stripeBookingDetails, listStripePurchases } from './stripe_walkthroughs.js';

const SECOND = 1000;
const SCHEDULE_JOB_KINDS = new Set(['zoom_create', 'zoom_update', 'booking_confirmed', 'booking_confirmed_admin', 'booking_updated']);
const nowSeconds = () => Math.floor(Date.now() / SECOND);
const seconds = (value) => Math.floor(Date.parse(value) / SECOND);
const iso = (value) => value == null ? null : new Date(value * SECOND).toISOString();
const database = (env) => {
  if (!env.LEADS_DB) throw failure('Booking storage is unavailable.', 503);
  return env.LEADS_DB;
};
function failure(message, status = 400) { return Object.assign(new Error(message), { status }); }
function validateEducationSlot(value) {
  try { return validateSlot(value); } catch (error) { throw failure(error.message, 400); }
}
function uuid() { return crypto.randomUUID(); }
function token() { return uuid().replaceAll('-', '') + uuid().replaceAll('-', ''); }
function statement(env, sql, ...values) { return database(env).prepare(sql).bind(...values); }
async function row(env, id) { return statement(env, 'SELECT * FROM education_bookings WHERE id = ?', id).first(); }
async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function json(request, env, payload, status = 200) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((item) => item.trim());
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', Vary: 'Origin' };
  if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(JSON.stringify(payload), { status, headers });
}
async function bodyJson(request) {
  if (Number(request.headers.get('Content-Length')) > 50_000) throw failure('Request is too large.', 413);
  let body;
  try { body = await request.json(); } catch { throw failure('Invalid JSON request.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > 50_000) throw failure('Invalid booking request.');
  return body;
}
function cleanText(value, max, name, required = true) {
  const text = String(value || '').trim();
  if ((required && !text) || text.length > max) throw failure(`Enter a valid ${name}.`);
  return text;
}
function contactValues(body) {
  const contact = body.contact || body;
  const fullName = cleanText(contact.fullName, 200, 'name');
  const email = cleanText(contact.email, 320, 'email address').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw failure('Enter a valid email address.');
  return { fullName, email, phone: cleanText(contact.phone, 80, 'phone number', false) };
}
function paymentLink(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw failure('Enter a Revolut Pro payment link.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || !(url.hostname === 'revolut.me' || url.hostname === 'revolut.com' || url.hostname.endsWith('.revolut.com'))) {
    throw failure('Use an HTTPS payment link hosted by Revolut.');
  }
  if (url.href.length > 2048) throw failure('Payment link is too long.');
  return url.href;
}
function eventStatement(env, id, actor, kind, metadata = {}) {
  return statement(env, 'INSERT INTO education_booking_events (booking_id, created_at, actor, event_type, metadata_json) VALUES (?, ?, ?, ?, ?)', id, nowSeconds(), actor, kind, JSON.stringify(metadata));
}
function jobStatement(env, id, revision, kind, payload = {}) {
  const time = nowSeconds();
  if (SCHEDULE_JOB_KINDS.has(kind)) {
    // Read the committed schedule *inside* the surrounding transaction, after
    // its preceding UPDATE. Proposals affect the general CAS revision only.
    return statement(env, `INSERT OR IGNORE INTO education_booking_jobs (id, booking_id, revision, kind, created_at, updated_at, payload_json)
      SELECT ?, id, schedule_revision, ?, ?, ?, json_set(?, '$.scheduleRevision', schedule_revision, '$.startAt', start_at, '$.endAt', end_at)
      FROM education_bookings WHERE id = ?`, uuid(), kind, time, time, JSON.stringify(payload), id);
  }
  return statement(env, `INSERT OR IGNORE INTO education_booking_jobs (id, booking_id, revision, kind, created_at, updated_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`, uuid(), id, revision, kind, time, time, JSON.stringify(payload));
}
function guardStatement(env, booking, setupToken = null) {
  return statement(env, 'INSERT INTO education_booking_operations (id, booking_id, expected_revision, expected_setup_token) VALUES (?, ?, ?, ?)', uuid(), booking.id, booking.revision, setupToken);
}
function clearGuards(env, id) { return statement(env, 'DELETE FROM education_booking_operations WHERE booking_id = ?', id); }
function jobGuard(env, job, claim) {
  return statement(env, 'INSERT INTO education_job_operations (id, job_id, claim_token) VALUES (?, ?, ?)', uuid(), job.id, claim);
}
function finishJob(env, job, claim) {
  return statement(env, `UPDATE education_booking_jobs SET state = 'sent', updated_at = ?, last_error = NULL WHERE id = ? AND claim_token = ? AND state = 'processing'`, nowSeconds(), job.id, claim);
}
function clearJobGuard(env, job) { return statement(env, 'DELETE FROM education_job_operations WHERE job_id = ?', job.id); }
function queueZoomCompletion(env, bookingId, appliedStart, appliedEnd) {
  const time = nowSeconds();
  return statement(env, `INSERT OR IGNORE INTO education_booking_jobs (id, booking_id, revision, kind, created_at, updated_at, payload_json)
    SELECT ?, id, CASE WHEN status = 'cancelled' THEN revision ELSE schedule_revision END,
      CASE WHEN status = 'cancelled' THEN 'zoom_cancel' WHEN start_at != ? OR end_at != ? THEN 'zoom_update' ELSE 'booking_confirmed' END,
      ?, ?, json_object('scheduleRevision', schedule_revision, 'startAt', start_at, 'endAt', end_at)
    FROM education_bookings WHERE id = ?`, uuid(), appliedStart, appliedEnd, time, time, bookingId);
}
function queueAdministratorConfirmation(env, bookingId) {
  return statement(env, `INSERT OR IGNORE INTO education_booking_jobs (id,booking_id,revision,kind,created_at,updated_at,payload_json)
    SELECT ?,id,schedule_revision,'booking_confirmed_admin',unixepoch(),unixepoch(),
      json_object('scheduleRevision',schedule_revision,'startAt',start_at,'endAt',end_at)
    FROM education_bookings WHERE id = ? AND stripe_purchase_id IS NOT NULL
      AND status = 'confirmed' AND zoom_state = 'ready'`, uuid(), bookingId);
}

export function educationCallRouteMethods(pathname) {
  if (pathname === '/api/education-calls/availability') return 'GET,OPTIONS';
  if (pathname === '/api/education-calls/bookings') return 'POST,OPTIONS';
  if (pathname === '/api/advisor/education-calls/bookings') return 'GET,OPTIONS';
  if (pathname === '/api/advisor/education-calls/blocks') return 'POST,OPTIONS';
  if (/^\/api\/advisor\/education-calls\/blocks\/[^/]+$/.test(pathname)) return 'DELETE,OPTIONS';
  if (/^\/api\/(?:advisor\/)?education-calls\/bookings\/[^/]+$/.test(pathname)) return 'GET,OPTIONS';
  if (/^\/api\/education-calls\/bookings\/[^/]+\/(response|checkout)$/.test(pathname)) return 'POST,OPTIONS';
  if (/^\/api\/advisor\/education-calls\/bookings\/[^/]+\/(payment-link|verify-payment|propose|cancel|refund|reconcile-zoom|retry)$/.test(pathname)) return 'POST,OPTIONS';
  return null;
}

async function syncEducationBookingLead(env, id) {
  const value = await row(env, id);
  if (!value?.lead_id) return;
  await statement(env, `UPDATE leads SET status = ?, scheduled_start_at = ?, scheduled_end_at = ?, scheduled_timezone = 'Europe/Dublin',
    scheduled_location = ?, zoom_meeting_id = ?, zoom_join_url = ?, zoom_meeting_password = ?, updated_at = ? WHERE id = ?`,
  value.status === 'confirmed' ? 'booked' : value.status === 'awaiting_payment' ? 'awaiting-client' : value.status === 'cancelled' ? 'declined' : 'expired',
  iso(value.start_at), iso(value.end_at), value.zoom_join_url || 'Zoom', value.zoom_meeting_id, value.zoom_join_url,
  value.zoom_meeting_password, iso(nowSeconds()), value.lead_id).run();
}

export function serializeEducationBooking(value, { includeToken = false } = {}) {
  if (!value) return null;
  return {
    id: value.id, sourceType: value.source_type, sourceId: value.source_id, leadId: value.lead_id,
    createdAt: iso(value.created_at), updatedAt: iso(value.updated_at), status: value.status,
    setupState: value.setup_state, revision: value.revision, scheduleRevision: value.schedule_revision,
    contact: { fullName: value.full_name, email: value.email, phone: value.phone || '' },
    startAt: iso(value.start_at), endAt: iso(value.end_at), timezone: EDUCATION_BOOKING.timezone,
    holdExpiresAt: iso(value.hold_expires_at), amountCents: value.amount_cents, currency: value.currency,
    offerVersion: value.offer_version, paymentLink: value.payment_link || '', paymentStatus: value.payment_status,
    paymentProvider: value.payment_provider || 'revolut',
    purchaseId: value.stripe_purchase_id || null, completedAt: iso(value.completed_at),
    paymentReference: value.payment_reference || '', paymentVerifiedAt: iso(value.payment_verified_at),
    reportSnapshotId: value.report_snapshot_id, cancellationReason: value.cancellation_reason || '',
    zoomMeetingId: value.zoom_meeting_id || '', zoomJoinUrl: value.zoom_join_url || '',
    zoomMeetingPassword: value.zoom_meeting_password || '', zoomState: value.zoom_state,
    proposal: value.proposal_start_at && value.proposal_expires_at > nowSeconds() ? {
      startAt: iso(value.proposal_start_at), endAt: iso(value.proposal_end_at),
      expiresAt: iso(value.proposal_expires_at), revision: value.proposal_revision
    } : null,
    ...(includeToken ? { accessToken: value.access_token } : {})
  };
}

// This is also called before GETs: expiry is authoritative in SQL and does not
// depend on the scheduled cleanup running on time.
export async function reconcileEducationBookings(env) {
  const time = nowSeconds();
  await database(env).batch([
    statement(env, `INSERT OR IGNORE INTO education_booking_jobs (id, booking_id, revision, kind, created_at, updated_at)
      SELECT 'expired-' || id || '-' || (revision + 1), id, revision + 1, 'booking_expired', ?, ?
      FROM education_bookings WHERE status = 'awaiting_payment' AND hold_expires_at <= ? AND setup_state = 'ready'`, time, time, time),
    statement(env, `INSERT INTO education_booking_events (booking_id, created_at, actor, event_type, metadata_json)
      SELECT id, ?, 'system', 'hold_expired', '{}' FROM education_bookings WHERE status = 'awaiting_payment' AND hold_expires_at <= ?`, time, time),
    statement(env, `UPDATE education_bookings SET status = 'expired', updated_at = ?, revision = revision + 1
      WHERE status = 'awaiting_payment' AND hold_expires_at <= ?`, time, time),
    statement(env, `DELETE FROM education_calendar_reservations WHERE booking_id IN (SELECT id FROM education_bookings WHERE status IN ('expired', 'cancelled'))`),
    statement(env, `UPDATE education_bookings SET proposal_start_at = NULL, proposal_end_at = NULL, proposal_expires_at = NULL, proposal_revision = NULL, updated_at = ?
      WHERE proposal_expires_at <= ?`, time, time),
    statement(env, `UPDATE education_calendar_reservations SET proposal_start_at = NULL, proposal_end_at = NULL, proposal_expires_at = NULL WHERE proposal_expires_at <= ?`, time),
    statement(env, `UPDATE leads SET status = 'expired', updated_at = ? WHERE id IN (SELECT lead_id FROM education_bookings WHERE status = 'expired') AND status != 'expired'`, iso(time)),
    statement(env, `UPDATE education_bookings SET zoom_state = 'uncertain', updated_at = ?
      WHERE EXISTS (SELECT 1 FROM education_booking_jobs j WHERE j.booking_id = education_bookings.id AND j.kind = 'zoom_create' AND j.state = 'processing' AND j.claimed_at <= ?)`, time, time - 600),
    statement(env, `UPDATE education_booking_jobs SET state = CASE WHEN kind = 'zoom_create' THEN 'uncertain' ELSE 'pending' END,
      updated_at = ?, last_error = 'Worker stopped before confirming delivery; reconcile uncertain Zoom creation.'
      WHERE state = 'processing' AND claimed_at <= ?`, time, time - 600)
  ]);
}

export async function availableSlots(env, from) {
  const time = nowSeconds();
  const reservations = (await statement(env, `SELECT * FROM education_calendar_reservations
    WHERE host_id = 'gerry' AND ((end_at > ? AND (expires_at IS NULL OR expires_at > ?)) OR (proposal_end_at > ? AND proposal_expires_at > ?))`, time, time, time, time).all()).results || [];
  return educationSlots({ from: from || dublinParts(Date.now()).date }).filter((slot) => {
    const start = seconds(slot.startAt), end = seconds(slot.endAt);
    return !reservations.some((reservation) => (
      ((reservation.expires_at == null || reservation.expires_at > time) && intervalsOverlap(start, end, reservation.start_at, reservation.end_at))
      || (reservation.proposal_expires_at > time && intervalsOverlap(start, end, reservation.proposal_start_at, reservation.proposal_end_at))
    ));
  });
}

async function book(request, env, hooks, body) {
  if (!['consumer', 'published'].includes(body.sourceType)) throw failure('Choose a completed report.');
  const sourceId = cleanText(body.sourceId, 200, 'report identity');
  const analysisRunId = body.sourceType === 'consumer' ? cleanText(body.analysisRunId, 200, 'completed analysis identity') : null;
  const key = cleanText(body.idempotencyKey, 120, 'booking request identity');
  if (body.consent !== true || body.reportAccessConsent !== true || body.termsAccepted !== true || body.earlyPerformanceConsent !== true) {
    throw failure('Accept the call terms and give permission to view this report.');
  }
  if (body.offerVersion !== EDUCATION_CALL.version) throw failure('The call offer has changed. Refresh the page before booking.', 409);
  const contact = contactValues(body);
  const context = await hooks.resolveCustomer(request, { ...body, sourceId });
  if (context instanceof Response) return context;
  if (!context) throw failure('This report is unavailable.', 403);
  const requestDigest = await digest({ sourceType: body.sourceType, sourceId, analysisRunId, startAt: body.startAt, contact, offerVersion: body.offerVersion, consent: true });
  const existing = await statement(env, 'SELECT * FROM education_bookings WHERE source_type = ? AND source_id = ? AND idempotency_key = ?', body.sourceType, sourceId, key).first();
  if (existing) {
    if (existing.request_digest !== requestDigest) throw failure('This booking request identity was already used for a different time.', 409);
    if (existing.setup_state === 'pending') {
      const claim = token();
      const claimed = await statement(env, `UPDATE education_bookings SET setup_token = ?, setup_claimed_at = ? WHERE id = ?
        AND setup_state = 'pending' AND status = 'awaiting_payment' AND hold_expires_at > ? AND (setup_claimed_at IS NULL OR setup_claimed_at <= ?)`,
      claim, nowSeconds(), existing.id, nowSeconds(), nowSeconds() - 120).run();
      if (!claimed.meta?.changes) throw failure('Your booking is still being prepared. Retry shortly.', 409);
      await completeSetup(env, hooks, context, body, existing, claim);
      return { booking: serializeEducationBooking(await row(env, existing.id), { includeToken: true }) };
    }
    return { booking: serializeEducationBooking(existing, { includeToken: true }) };
  }
  const slot = validateEducationSlot(body.startAt);
  const time = nowSeconds(), id = uuid(), accessToken = token(), setupToken = token();
  const holdExpiry = Math.min(time + 24 * 3600, seconds(slot.startAt));
  const offer = { ...EDUCATION_CALL, priceCents: 9999, currency: 'EUR', durationMinutes: 40 };
  const receipt = { consent: true, reportAccessConsent: true, termsAccepted: true, earlyPerformanceConsent: true,
    offerVersion: body.offerVersion, policyVersion: body.policyVersion || '', at: iso(time), sourceType: body.sourceType, sourceId, analysisRunId };
  await database(env).batch([
    statement(env, `INSERT INTO education_bookings
      (id, source_type, source_id, idempotency_key, request_digest, access_token, created_at, updated_at, status, full_name, email, phone, start_at, end_at, hold_expires_at, amount_cents, offer_version, offer_json, consent_json, setup_token, setup_claimed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, body.sourceType, sourceId, key, requestDigest, accessToken, time, time, contact.fullName, contact.email, contact.phone,
    seconds(slot.startAt), seconds(slot.endAt), holdExpiry, 9999, body.offerVersion, JSON.stringify(offer), JSON.stringify(receipt), setupToken, time),
    statement(env, `INSERT INTO education_calendar_reservations (id, booking_id, kind, start_at, end_at, expires_at) VALUES (?, ?, 'booking', ?, ?, ?)`,
      id, id, seconds(slot.startAt), seconds(slot.endAt), holdExpiry),
    eventStatement(env, id, 'customer', 'slot_reserved', { holdExpiresAt: iso(holdExpiry) })
  ]);
  await completeSetup(env, hooks, context, body, await row(env, id), setupToken);
  return { booking: serializeEducationBooking(await row(env, id), { includeToken: true }) };
}

async function completeSetup(env, hooks, context, body, booking, claim) {
  const id = booking.id, contact = contactValues(body);
  try {
    const createdLead = await hooks.createLead(context, { ...body, contact, bookingId: id });
    const leadId = createdLead?.leadId || createdLead?.id || createdLead;
    if (!leadId) throw failure('The booking could not be linked to the client pipeline.', 503);
    const snapshot = await hooks.createReportSnapshot(context, { ...body, contact, bookingId: id, leadId });
    const snapshotId = snapshot?.id || snapshot?.snapshotId || snapshot;
    if (!snapshotId) throw failure('The report could not be saved for this call.', 503);
    await database(env).batch([
      guardStatement(env, booking, claim),
      statement(env, `UPDATE education_bookings SET setup_state = 'ready', lead_id = ?, report_snapshot_id = ?, updated_at = ? WHERE id = ?`, leadId, String(snapshotId), nowSeconds(), id),
      jobStatement(env, id, 1, 'booking_received'), clearGuards(env, id)
    ]);
  } catch (error) {
    await database(env).batch([
      statement(env, `UPDATE education_bookings SET setup_state = 'failed', status = 'cancelled', cancellation_reason = 'Booking setup failed', updated_at = ? WHERE id = ? AND setup_token = ? AND setup_state = 'pending'`, nowSeconds(), id, claim),
      statement(env, `DELETE FROM education_calendar_reservations WHERE booking_id = ? AND EXISTS (SELECT 1 FROM education_bookings WHERE id = ? AND setup_state = 'failed' AND setup_token = ?)`, id, id, claim),
      eventStatement(env, id, 'system', 'booking_setup_failed')
    ]);
    throw error;
  }
}

async function verifyPayment(env, booking, body) {
  const reference = cleanText(body.paymentReference, 200, 'completed Revolut payment reference');
  if (body.completed !== true || Number(body.amountCents) !== booking.amount_cents || body.currency !== booking.currency) {
    throw failure('Verify a completed Revolut payment for the exact booking amount and currency.');
  }
  if (booking.payment_status === 'verified') {
    if (booking.payment_reference !== reference) throw failure('A different payment has already been verified for this booking.', 409);
    return;
  }
  const time = nowSeconds();
  if (booking.setup_state !== 'ready') throw failure('The report and client record must be ready before payment is confirmed.', 409);
  if (booking.status !== 'awaiting_payment' || booking.hold_expires_at <= time || booking.start_at <= time) {
    await database(env).batch([
      guardStatement(env, booking),
      statement(env, `UPDATE education_bookings SET payment_status = 'late_review', payment_reference = ?, payment_verified_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`, reference, time, time, booking.id),
      eventStatement(env, booking.id, 'advisor', 'late_payment_review', { reference }), clearGuards(env, booking.id)
    ]);
    return;
  }
  // No external API calls occur until the durable payment/slot transition commits.
  await database(env).batch([
    guardStatement(env, booking),
    statement(env, `UPDATE education_calendar_reservations SET expires_at = NULL WHERE booking_id = ? AND expires_at > ?`, booking.id, time),
    statement(env, `UPDATE education_bookings SET payment_status = 'verified', payment_reference = ?, payment_verified_at = ?,
      status = 'confirmed', hold_expires_at = NULL, zoom_state = 'pending', updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'awaiting_payment' AND hold_expires_at > ?`, reference, time, time, booking.id, time),
    eventStatement(env, booking.id, 'advisor', 'payment_verified', { reference }),
    jobStatement(env, booking.id, booking.revision + 1, 'zoom_create'), clearGuards(env, booking.id)
  ]);
}

async function propose(env, booking, body) {
  if (!['awaiting_payment', 'confirmed'].includes(booking.status)) throw failure('This booking cannot be rescheduled.', 409);
  if (Number(body.revision) !== booking.revision) throw failure('The booking changed. Refresh it before proposing a time.', 409);
  const slot = validateEducationSlot(body.startAt), time = nowSeconds();
  if (seconds(slot.startAt) === booking.start_at) throw failure('Choose a different time.');
  const revision = booking.revision + 1;
  const expiry = Math.min(time + 24 * 3600, booking.start_at, seconds(slot.startAt), booking.hold_expires_at || Infinity);
  if (expiry <= time) throw failure('This call has already started or expired.', 409);
  await database(env).batch([
    guardStatement(env, booking),
    statement(env, `UPDATE education_calendar_reservations SET proposal_start_at = ?, proposal_end_at = ?, proposal_expires_at = ? WHERE booking_id = ?`, seconds(slot.startAt), seconds(slot.endAt), expiry, booking.id),
    statement(env, `UPDATE education_bookings SET proposal_start_at = ?, proposal_end_at = ?, proposal_expires_at = ?, proposal_revision = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?`,
      seconds(slot.startAt), seconds(slot.endAt), expiry, revision, revision, time, booking.id, booking.revision),
    eventStatement(env, booking.id, 'advisor', 'replacement_proposed', { startAt: slot.startAt, revision }),
    jobStatement(env, booking.id, revision, 'replacement_proposed'), clearGuards(env, booking.id)
  ]);
}

async function respond(env, booking, body) {
  const time = nowSeconds();
  if (!['accept', 'decline'].includes(body.decision)) throw failure('Choose accept or decline.');
  if (!booking.proposal_start_at || booking.proposal_expires_at <= time || Number(body.revision) !== booking.proposal_revision) {
    throw failure('This proposed time is no longer available. Refresh the booking.', 409);
  }
  const revision = booking.revision + 1;
  if (body.decision === 'accept') {
    // A proposal may have remained open overnight. Recheck the preparation
    // period at acceptance, not only when the administrator proposed it.
    validateEducationSlot(iso(booking.proposal_start_at));
    await database(env).batch([
      guardStatement(env, booking),
      statement(env, `UPDATE education_calendar_reservations SET start_at = proposal_start_at, end_at = proposal_end_at,
        proposal_start_at = NULL, proposal_end_at = NULL, proposal_expires_at = NULL WHERE booking_id = ? AND proposal_expires_at > ?`, booking.id, time),
      statement(env, `UPDATE education_bookings SET start_at = proposal_start_at, end_at = proposal_end_at,
        proposal_start_at = NULL, proposal_end_at = NULL, proposal_expires_at = NULL, proposal_revision = NULL,
        revision = ?, schedule_revision = schedule_revision + 1, updated_at = ?, zoom_state = CASE WHEN payment_status = 'verified' THEN 'pending' ELSE zoom_state END WHERE id = ? AND proposal_revision = ?`, revision, time, booking.id, Number(body.revision)),
      eventStatement(env, booking.id, 'customer', 'replacement_accepted', { revision }),
      jobStatement(env, booking.id, revision, booking.payment_status === 'verified' ? (booking.zoom_meeting_id ? 'zoom_update' : 'zoom_create') : 'booking_updated'), clearGuards(env, booking.id)
    ]);
  } else {
    await database(env).batch([
      guardStatement(env, booking),
      statement(env, `UPDATE education_calendar_reservations SET proposal_start_at = NULL, proposal_end_at = NULL, proposal_expires_at = NULL WHERE booking_id = ?`, booking.id),
      statement(env, `UPDATE education_bookings SET proposal_start_at = NULL, proposal_end_at = NULL, proposal_expires_at = NULL, proposal_revision = NULL, revision = ?, updated_at = ? WHERE id = ? AND proposal_revision = ?`, revision, time, booking.id, Number(body.revision)),
      eventStatement(env, booking.id, 'customer', 'replacement_declined', { revision }),
      jobStatement(env, booking.id, revision, 'replacement_declined'), clearGuards(env, booking.id)
    ]);
  }
}

// Called only after the signed Stripe webhook has durably verified payment.
// Purchase transition and the shared calendar write are one transaction, so a
// competing schedule request cannot attach two appointments to one payment.
export async function schedulePaidStripePurchase(env, order, body, hooks = {}) {
  if (order.booking_id) {
    const existing = await row(env, order.booking_id);
    if (existing) return serializeEducationBooking(existing, { includeToken: true });
  }
  const slot = validateEducationSlot(body.startAt);
  const topics = cleanText(body.discussionTopics, 1000, 'discussion topics', false);
  if (topics && !hooks.encryptDiscussionTopics) throw failure('Private discussion topics cannot be saved right now.', 503);
  const encrypted = topics ? await hooks.encryptDiscussionTopics(topics, order.id) : null;
  const requestDigest = await digest({ startAt: slot.startAt, discussionTopics: topics });
  const id = uuid(), time = nowSeconds(), operation = uuid();
  await database(env).batch([
    statement(env, 'INSERT INTO education_stripe_schedule_operations (id,order_id) VALUES (?,?)', operation, order.id),
    statement(env, `INSERT INTO education_bookings
      (id,source_type,source_id,idempotency_key,request_digest,access_token,created_at,updated_at,status,setup_state,
       full_name,email,phone,start_at,end_at,amount_cents,currency,offer_version,offer_json,consent_json,
       lead_id,report_snapshot_id,payment_status,payment_reference,payment_verified_at,payment_provider,zoom_state,
       stripe_purchase_id,discussion_topics_ciphertext)
      VALUES (?,?,?,?,?,?,?,?, 'confirmed','ready',?,?,?,?,?,?,?,?,?,?,?,?,'verified',?,?,'stripe','pending',?,?)`,
    id, order.source_type, order.source_id, `stripe-purchase-${order.id}`, requestDigest, order.access_token, time, time,
    order.full_name, order.email, order.phone || '', seconds(slot.startAt), seconds(slot.endAt), order.amount_cents, order.currency,
    order.offer_version, order.offer_json, order.consent_json, order.lead_id, order.report_snapshot_id,
    `stripe:${order.payment_intent_id}`, order.paid_at, order.id, encrypted),
    statement(env, `INSERT INTO education_calendar_reservations (id,booking_id,kind,start_at,end_at)
      VALUES (?,?,'booking',?,?)`, id, id, seconds(slot.startAt), seconds(slot.endAt)),
    statement(env, `UPDATE education_stripe_orders SET booking_id = ?, lifecycle = 'scheduled',
      discussion_topics_ciphertext = ?, schedule_request_digest = ?, updated_at = ? WHERE id = ?`,
    id, encrypted, requestDigest, time, order.id),
    eventStatement(env, id, 'customer', 'paid_slot_selected', { purchaseId: order.id }),
    jobStatement(env, id, 1, 'zoom_create'),
    statement(env, 'DELETE FROM education_stripe_schedule_operations WHERE id = ?', operation)
  ]);
  await syncEducationBookingLead(env, id);
  return serializeEducationBooking(await row(env, id), { includeToken: true });
}

async function cancel(env, booking, body) {
  if (booking.status === 'cancelled') return;
  const time = nowSeconds(), revision = booking.revision + 1;
  await database(env).batch([
    guardStatement(env, booking),
    statement(env, `UPDATE education_bookings SET status = 'cancelled', revision = ?, updated_at = ?, cancellation_reason = ?,
      payment_status = CASE WHEN payment_status = 'verified' THEN 'refund_required' ELSE payment_status END,
      proposal_start_at = NULL, proposal_end_at = NULL, proposal_expires_at = NULL, proposal_revision = NULL WHERE id = ?`,
    revision, time, cleanText(body.reason, 1000, 'cancellation reason', false), booking.id),
    statement(env, 'DELETE FROM education_calendar_reservations WHERE booking_id = ?', booking.id),
    statement(env, `UPDATE education_stripe_orders SET lifecycle = 'cancelled',updated_at = ? WHERE booking_id = ? AND source_type IS NOT NULL`, time, booking.id),
    eventStatement(env, booking.id, 'advisor', 'booking_cancelled'),
    jobStatement(env, booking.id, revision, booking.zoom_meeting_id ? 'zoom_cancel' : 'booking_cancelled'), clearGuards(env, booking.id)
  ]);
}

// Legacy lead scheduling must claim the same calendar before creating Zoom.
export async function reserveAdvisorCalendar(env, { leadId, startAt, endAt, status = 'confirmed', expiresAt = null }) {
  const id = `lead-${leadId}`;
  if (['cancelled', 'declined', 'expired'].includes(status)) {
    await statement(env, 'DELETE FROM education_calendar_reservations WHERE id = ?', id).run();
    return;
  }
  const start = seconds(startAt), end = seconds(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw failure('Choose a valid call interval.');
  await statement(env, `INSERT INTO education_calendar_reservations (id, kind, lead_id, start_at, end_at, expires_at)
    VALUES (?, 'lead', ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET start_at = excluded.start_at, end_at = excluded.end_at, expires_at = excluded.expires_at`,
  id, leadId, start, end, expiresAt ? seconds(expiresAt) : null).run();
}

export async function handleEducationCalls(request, env, hooks = {}) {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/api/education-calls/') && !path.startsWith('/api/advisor/education-calls/')) return null;
  try {
    const advisor = path.startsWith('/api/advisor/');
    if (advisor) {
      if (!hooks.requireAdvisor) throw failure('Advisor access is unavailable.', 503);
      const auth = await hooks.requireAdvisor(request);
      if (auth instanceof Response) return auth;
      if (auth?.response) return auth.response;
      if (auth === false) throw failure('Sign in to manage calls.', 401);
    } else if (String(env.EDUCATION_CALLS_ENABLED) !== 'true'
      && (path === '/api/education-calls/availability' || path === '/api/education-calls/bookings')) {
      throw failure('Call bookings are not available yet.', 503);
    }
    await reconcileEducationBookings(env);
    let result;
    if (request.method === 'GET' && path === '/api/education-calls/availability') {
      result = { slots: await availableSlots(env, url.searchParams.get('from')), ...EDUCATION_BOOKING };
    } else if (request.method === 'POST' && path === '/api/education-calls/bookings') {
      result = await book(request, env, hooks, await bodyJson(request));
      if (result instanceof Response) return result;
    } else if (request.method === 'GET' && path === '/api/advisor/education-calls/bookings') {
      result = {
        bookings: ((await statement(env, 'SELECT * FROM education_bookings ORDER BY created_at DESC LIMIT 250').all()).results || []).map((value) => serializeEducationBooking(value)),
        purchases: await listStripePurchases(env, hooks),
        blocks: ((await statement(env, `SELECT * FROM education_calendar_reservations WHERE kind = 'block' AND end_at > ? ORDER BY start_at`, nowSeconds()).all()).results || []).map((block) => ({ id: block.id, startAt: iso(block.start_at), endAt: iso(block.end_at), reason: block.reason || '' }))
      };
    } else if (request.method === 'POST' && path === '/api/advisor/education-calls/blocks') {
      const body = await bodyJson(request), start = seconds(body.startAt), end = seconds(body.endAt), id = uuid();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end <= nowSeconds()) throw failure('Choose a valid future unavailable period.');
      await statement(env, `INSERT INTO education_calendar_reservations (id, kind, start_at, end_at, reason) VALUES (?, 'block', ?, ?, ?)`, id, start, end, cleanText(body.reason, 500, 'reason', false)).run();
      result = { block: { id, startAt: iso(start), endAt: iso(end), reason: body.reason || '' } };
    } else if (request.method === 'DELETE' && /^\/api\/advisor\/education-calls\/blocks\/[^/]+$/.test(path)) {
      await statement(env, `DELETE FROM education_calendar_reservations WHERE kind = 'block' AND id = ?`, path.split('/').pop()).run();
      result = { deleted: true };
    } else {
      const match = /^\/api\/(advisor\/)?education-calls\/bookings\/([^/]+)(?:\/(payment-link|verify-payment|propose|cancel|response|checkout|refund|reconcile-zoom|retry))?$/.exec(path);
      if (!match) throw failure('Booking route not found.', 404);
      const booking = await row(env, match[2]);
      if (!booking) throw failure('Booking not found.', 404);
      const body = request.method === 'POST' ? await bodyJson(request) : {};
      if (!advisor && (body.token || url.searchParams.get('token')) !== booking.access_token) throw failure('This booking link is invalid.', 403);
      const action = match[3];
      if (advisor && ['payment-link', 'verify-payment', 'refund'].includes(action) && booking.payment_provider === 'stripe') {
        throw failure('Stripe payments and refunds are reconciled through Stripe. Do not use manual Revolut verification.', 409);
      }
      if (request.method === 'GET' && !action) {
        result = { booking: serializeEducationBooking(booking, { includeToken: !advisor }) };
      } else if (request.method !== 'POST') throw failure('Method not allowed.', 405);
      else if (!advisor && action === 'checkout') {
        result = await createWalkthroughCheckout(env, booking);
      } else if (!advisor && action === 'response') {
        await respond(env, booking, body);
      } else if (advisor && action === 'payment-link') {
        if (booking.status !== 'awaiting_payment') throw failure('This booking is not awaiting payment.', 409);
        const link = paymentLink(body.paymentLink), revision = booking.revision + 1;
        await database(env).batch([
          guardStatement(env, booking),
          statement(env, 'UPDATE education_bookings SET payment_link = ?, revision = ?, updated_at = ? WHERE id = ?', link, revision, nowSeconds(), booking.id),
          eventStatement(env, booking.id, 'advisor', 'payment_link_added'),
          jobStatement(env, booking.id, revision, 'payment_instructions'), clearGuards(env, booking.id)
        ]);
      } else if (advisor && action === 'verify-payment') await verifyPayment(env, booking, body);
      else if (advisor && action === 'propose') await propose(env, booking, body);
      else if (advisor && action === 'cancel') await cancel(env, booking, body);
      else if (advisor && action === 'refund') {
        if (!['refund_required', 'late_review'].includes(booking.payment_status)) throw failure('This booking is not awaiting a refund.', 409);
        const reference = cleanText(body.refundReference, 200, 'completed refund reference');
        await database(env).batch([
          guardStatement(env, booking),
          statement(env, `UPDATE education_bookings SET payment_status = 'refunded', updated_at = ?, revision = revision + 1 WHERE id = ?`, nowSeconds(), booking.id),
          eventStatement(env, booking.id, 'advisor', 'refund_verified', { reference }), clearGuards(env, booking.id)
        ]);
      } else if (advisor && action === 'retry') {
        await statement(env, `UPDATE education_booking_jobs SET state = 'pending', attempts = 0, updated_at = ?
          WHERE booking_id = ? AND state = 'failed'`, nowSeconds(), booking.id).run();
      } else if (advisor && action === 'reconcile-zoom') {
        const meetingId = cleanText(body.zoomMeetingId, 100, 'Zoom meeting identity');
        const join = new URL(String(body.zoomJoinUrl));
        if (join.protocol !== 'https:' || !/(^|\.)zoom\.us$/.test(join.hostname)) throw failure('Enter the existing Zoom join URL.');
        await database(env).batch([
          guardStatement(env, booking),
          statement(env, `UPDATE education_bookings SET zoom_meeting_id = ?, zoom_join_url = ?, zoom_state = 'pending', updated_at = ? WHERE id = ?`, meetingId, join.href, nowSeconds(), booking.id),
          statement(env, `UPDATE education_booking_jobs SET state = 'sent', updated_at = ? WHERE booking_id = ? AND kind = 'zoom_create' AND state IN ('uncertain', 'failed')`, nowSeconds(), booking.id),
          eventStatement(env, booking.id, 'advisor', 'zoom_reconciled'),
          jobStatement(env, booking.id, booking.revision, booking.status === 'cancelled' ? 'zoom_cancel' : 'zoom_update'), clearGuards(env, booking.id)
        ]);
      } else throw failure('Booking action not found.', 404);
      if (!result) result = { booking: serializeEducationBooking(await row(env, booking.id), { includeToken: !advisor }) };
    }
    if (result?.booking?.id) await syncEducationBookingLead(env, result.booking.id);
    // Persisted outbox delivery is independent of the HTTP result. A failure
    // leaves a visible retryable job without rolling back the reservation.
    if (request.method !== 'GET' && hooks.sendEmail) {
      const work = processEducationCallJobs(env, hooks).catch(() => {});
      if (hooks.waitUntil) hooks.waitUntil(work); else await work;
      if (result?.booking?.id) result.booking = serializeEducationBooking(await row(env, result.booking.id), { includeToken: !advisor });
    }
    if (result?.booking) {
      Object.assign(result.booking, await stripeBookingDetails(env, result.booking));
      if (hooks.decorateBooking) result.booking = await hooks.decorateBooking(result.booking, { advisor });
    }
    if (result?.bookings) for (let i = 0; i < result.bookings.length; i++) {
      Object.assign(result.bookings[i], await stripeBookingDetails(env, result.bookings[i]));
      if (hooks.decorateBooking) result.bookings[i] = await hooks.decorateBooking(result.bookings[i], { advisor });
    }
    return json(request, env, result);
  } catch (error) {
    const message = String(error?.message);
    const calendarConflict = message.includes('education_calendar_conflict');
    const revisionConflict = message.includes('education_booking_revision_conflict');
    const sourceConflict = message.includes('education_source_already_booked');
    const duplicatePayment = /UNIQUE constraint failed: education_bookings.payment_reference/.test(message);
    const stripeConflict = /stripe_collection_already_started|stripe_booking_unavailable/.test(message);
    const conflict = calendarConflict || revisionConflict || sourceConflict || stripeConflict || /UNIQUE constraint failed/.test(message);
    const status = conflict ? 409 : Number(error?.status || error?.statusCode) || 500;
    return json(request, env, {
      error: calendarConflict ? 'That time was just reserved. Choose another available time.'
        : revisionConflict ? 'This booking changed. Refresh it before trying again.'
          : sourceConflict ? 'This report already has an active walkthrough booking.'
            : duplicatePayment ? 'That payment reference has already been used for another booking.'
              : stripeConflict ? 'The payment or booking changed. Refresh it before continuing.'
              : status >= 500 ? 'Call booking is temporarily unavailable. Please try again.' : error.message,
      code: calendarConflict ? 'calendar_conflict' : revisionConflict ? 'booking_changed' : sourceConflict ? 'booking_exists'
        : duplicatePayment ? 'payment_reference_used' : 'education_booking_error',
      ...(calendarConflict ? { slots: await availableSlots(env) } : {})
    }, status);
  }
}

export async function processEducationCallJobs(env, hooks = {}, { limit = 20 } = {}) {
  await reconcileEducationBookings(env);
  await statement(env, `UPDATE education_booking_jobs SET state = 'uncertain',updated_at = unixepoch(),
    last_error = 'Delivery requires reconciliation after the provider idempotency window.'
    WHERE state IN ('pending','failed') AND attempts > 0 AND first_attempt_at <= unixepoch() - 82800
    AND kind NOT IN ('zoom_create','zoom_update','zoom_cancel') AND EXISTS
      (SELECT 1 FROM education_bookings b WHERE b.id = education_booking_jobs.booking_id AND b.payment_provider = 'stripe')`).run();
  const results = [], seen = new Set();
  while (seen.size < limit) {
    const jobs = (await statement(env, `SELECT * FROM education_booking_jobs WHERE state IN ('pending', 'failed') AND attempts < 5
      AND (? = 1 OR kind IN ('zoom_create','zoom_update','zoom_cancel') OR NOT EXISTS
        (SELECT 1 FROM education_bookings b WHERE b.id = education_booking_jobs.booking_id AND b.payment_provider = 'stripe'))
      ORDER BY CASE WHEN kind IN ('zoom_create', 'zoom_update', 'zoom_cancel') THEN 0 ELSE 1 END, created_at, id LIMIT ?`,
    Number(!hooks.canSendWalkthroughEmail || hooks.canSendWalkthroughEmail()), limit).all()).results || [];
    const job = jobs.find((candidate) => !seen.has(candidate.id));
    if (!job) break;
    seen.add(job.id);
    const claim = token(), time = nowSeconds();
    let claimed;
    try {
      claimed = await statement(env, `UPDATE education_booking_jobs SET state = 'processing', claim_token = ?, claimed_at = ?, updated_at = ?, attempts = attempts + 1
        ,first_attempt_at = COALESCE(first_attempt_at,?)
        WHERE id = ? AND state IN ('pending', 'failed')`, claim, time, time, time, job.id).run();
    } catch (error) {
      // Another runner owns this booking's Zoom mutation lease. The failed
      // claim leaves this job pending, with no external request and no retry
      // penalty. The owner processes the next committed operation on release.
      if (/UNIQUE constraint failed: education_booking_jobs.booking_id/.test(String(error?.message))) continue;
      throw error;
    }
    if (!claimed.meta?.changes) continue;
    let booking = await row(env, job.booking_id);
    try {
      if (!booking || booking.setup_state !== 'ready') throw failure('Booking setup is incomplete.');
      const cancelled = ['cancelled', 'expired'].includes(booking.status);
      const staleProposal = job.kind === 'replacement_proposed' && booking.proposal_revision !== job.revision;
      const staleSchedule = SCHEDULE_JOB_KINDS.has(job.kind) && booking.schedule_revision !== job.revision;
      const stripeReview = booking.payment_provider === 'stripe' && SCHEDULE_JOB_KINDS.has(job.kind)
        && (await statement(env, 'SELECT state FROM education_stripe_orders WHERE booking_id = ?', booking.id).first())?.state !== 'paid';
      if (stripeReview || staleProposal || staleSchedule || (cancelled && !['zoom_cancel', 'booking_cancelled', 'booking_expired'].includes(job.kind))
        || (job.kind === 'payment_instructions' && booking.payment_status !== 'pending')) {
        await statement(env, `UPDATE education_booking_jobs SET state = 'superseded', updated_at = ? WHERE id = ? AND claim_token = ?`, nowSeconds(), job.id, claim).run();
        continue;
      }
      let publicBooking = serializeEducationBooking(booking, { includeToken: true });
      if (hooks.decorateBooking) publicBooking = await hooks.decorateBooking(publicBooking);
      if (job.kind.startsWith('zoom_')) {
        if (job.kind !== 'zoom_cancel' && booking.payment_status !== 'verified') throw failure('Payment has not been verified.');
        if (job.kind === 'zoom_create') {
          let meeting = null;
          if (!booking.zoom_meeting_id) {
            // Only one create may be in flight for a booking, including jobs
            // from different schedule revisions.
            const other = await statement(env, `SELECT id FROM education_booking_jobs WHERE booking_id = ? AND kind = 'zoom_create' AND id != ? AND state IN ('processing', 'uncertain') LIMIT 1`, booking.id, job.id).first();
            if (other) throw failure('An earlier Zoom creation needs reconciliation.');
            if (!hooks.createZoom) throw failure('Zoom is unavailable.');
            meeting = await hooks.createZoom(publicBooking);
            const meetingId = meeting?.zoomMeetingId || meeting?.id;
            const joinUrl = meeting?.zoomJoinUrl || meeting?.joinUrl;
            if (!meetingId || !joinUrl) throw Object.assign(new Error('Zoom returned incomplete meeting details.'), { uncertain: true });
          }
          const appliedStart = meeting ? seconds(publicBooking.startAt) : -1;
          const appliedEnd = meeting ? seconds(publicBooking.endAt) : -1;
          await database(env).batch([
            jobGuard(env, job, claim),
            ...(meeting ? [statement(env, `UPDATE education_bookings SET zoom_meeting_id = ?, zoom_join_url = ?, zoom_meeting_password = ?,
              zoom_state = CASE WHEN start_at = ? AND end_at = ? AND status = 'confirmed' THEN 'ready' ELSE 'pending' END, updated_at = ? WHERE id = ?`,
            String(meeting.zoomMeetingId || meeting.id), meeting.zoomJoinUrl || meeting.joinUrl, meeting.zoomMeetingPassword || '', appliedStart, appliedEnd, nowSeconds(), booking.id)] : []),
            queueZoomCompletion(env, booking.id, appliedStart, appliedEnd), queueAdministratorConfirmation(env, booking.id), finishJob(env, job, claim), clearJobGuard(env, job)
          ]);
        } else if (job.kind === 'zoom_update') {
          if (!booking.zoom_meeting_id || !hooks.updateZoom) throw failure('An existing Zoom meeting is required.');
          await hooks.updateZoom(publicBooking);
          await database(env).batch([
            jobGuard(env, job, claim),
            statement(env, `UPDATE education_bookings SET zoom_state = CASE WHEN start_at = ? AND end_at = ? AND status = 'confirmed' THEN 'ready' ELSE 'pending' END,
              updated_at = ? WHERE id = ?`, seconds(publicBooking.startAt), seconds(publicBooking.endAt), nowSeconds(), booking.id),
            queueZoomCompletion(env, booking.id, seconds(publicBooking.startAt), seconds(publicBooking.endAt)), queueAdministratorConfirmation(env, booking.id),
            finishJob(env, job, claim), clearJobGuard(env, job)
          ]);
        } else if (job.kind === 'zoom_cancel') {
          if (booking.zoom_meeting_id && hooks.cancelZoom) await hooks.cancelZoom(publicBooking);
          await database(env).batch([
            jobGuard(env, job, claim),
            statement(env, `UPDATE education_bookings SET zoom_state = 'cancelled', updated_at = ? WHERE id = ?`, nowSeconds(), booking.id),
            jobStatement(env, booking.id, booking.revision, 'booking_cancelled'), finishJob(env, job, claim), clearJobGuard(env, job)
          ]);
        }
      } else {
        if (!hooks.sendEmail) throw failure('Email is unavailable.');
        if (job.kind === 'booking_confirmed' && (!booking.zoom_meeting_id || booking.zoom_state !== 'ready')) throw failure('Zoom has not been confirmed for this time.');
        await hooks.sendEmail({ id: job.id, kind: job.kind, revision: job.revision,
          idempotencyKey: `education-${job.booking_id}-${job.revision}-${job.kind}`, booking: publicBooking, payload: JSON.parse(job.payload_json || '{}') });
      }
      if (!job.kind.startsWith('zoom_')) await finishJob(env, job, claim).run();
      await syncEducationBookingLead(env, booking.id);
      results.push({ id: job.id, state: 'sent' });
    } catch (error) {
      if (String(error?.message).includes('education_job_claim_lost')) {
        results.push({ id: job.id, state: 'claim_lost' });
        continue;
      }
      // A network timeout or process crash may have happened after Zoom created
      // a meeting. Preserve this uncertainty for explicit reconciliation.
      const uncertain = job.kind === 'zoom_create' && (error?.uncertain || error?.name === 'AbortError' || error?.name === 'TypeError' || !error?.status);
      const state = uncertain ? 'uncertain' : 'failed';
      await database(env).batch([
        ...(job.kind.startsWith('zoom_') ? [statement(env, `UPDATE education_bookings SET zoom_state = ?, updated_at = ? WHERE id = ?
          AND EXISTS (SELECT 1 FROM education_booking_jobs WHERE id = ? AND claim_token = ? AND state = 'processing')`, state, nowSeconds(), job.booking_id, job.id, claim)] : []),
        statement(env, `UPDATE education_booking_jobs SET state = ?, updated_at = ?, last_error = ? WHERE id = ? AND claim_token = ? AND state = 'processing'`, state, nowSeconds(), String(error?.message || 'Delivery failed').slice(0, 500), job.id, claim)
      ]);
      results.push({ id: job.id, state });
    }
  }
  return results;
}
