import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { EDUCATION_CALL } from '../js/workspace/education_call.js';
import { dublinParts, dublinWallTime, educationSlots, validateEducationSlot } from '../js/workspace/education_booking.js';
import { handleEducationCalls, processEducationCallJobs, reconcileEducationBookings, reserveAdvisorCalendar } from '../worker/src/education_calls.js';

class Statement {
  constructor(sql, query, values = []) { Object.assign(this, { sql, query, values }); }
  bind(...values) { return new Statement(this.sql, this.query, values.map((value) => value === undefined ? null : value)); }
  async first() { return this.sql.prepare(this.query).get(...this.values) || null; }
  async all() { return { results: this.sql.prepare(this.query).all(...this.values) }; }
  execute() { const value = this.sql.prepare(this.query).run(...this.values); return { meta: { changes: Number(value.changes) } }; }
  async run() { return this.execute(); }
}
function fixture() {
  const sql = new DatabaseSync(':memory:');
  const directory = new URL('../worker/migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(file, directory), 'utf8'));
  const db = { prepare: (query) => new Statement(sql, query), async batch(statements) {
    sql.exec('BEGIN');
    try { const results = statements.map((value) => value.execute()); sql.exec('COMMIT'); return results; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } };
  const env = { LEADS_DB: db, EDUCATION_CALLS_ENABLED: 'true', ALLOWED_ORIGINS: 'https://planeir.ie' };
  const emails = [], meetings = [], updates = [], cancellations = [], leadIds = new Map();
  const hooks = {
    requireAdvisor: async () => true,
    resolveCustomer: async (_request, body) => body.sourceId === 'unauthorised' ? null : { sourceId: body.sourceId },
    createLead: async (_context, body) => {
      if (leadIds.has(body.bookingId)) return { id: leadIds.get(body.bookingId) };
      const result = sql.prepare(`INSERT INTO leads (created_at, full_name, email, help_reason, source) VALUES (?, ?, ?, 'Walkthrough', ?)`).run(new Date().toISOString(), body.contact.fullName, body.contact.email, EDUCATION_CALL.leadSource);
      const id = Number(result.lastInsertRowid); leadIds.set(body.bookingId, id); return { id };
    },
    createReportSnapshot: async (_context, body) => ({ id: `report-${body.bookingId}` }),
    sendEmail: async (job) => { emails.push(job); },
    createZoom: async (booking) => { meetings.push(booking); return { zoomMeetingId: `fixture-${meetings.length}`, zoomJoinUrl: 'https://zoom.us/j/123456789' }; },
    updateZoom: async (booking) => { updates.push(booking); },
    cancelZoom: async (booking) => { cancellations.push(booking); }
  };
  const route = async (path, body, override = {}, method) => {
    const response = await handleEducationCalls(new Request(`https://api.planeir.ie${path}`, {
      method: method || (body === undefined ? 'GET' : 'POST'), headers: { Origin: 'https://planeir.ie', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }), env, { ...hooks, ...override });
    return { status: response.status, json: await response.json() };
  };
  const data = (sourceId, startAt) => ({ sourceType: 'consumer', sourceId, startAt, analysisRunId: `analysis-${sourceId}`,
    contact: { fullName: 'Booking Test', email: `${sourceId}@example.com` }, consent: true, reportAccessConsent: true,
    termsAccepted: true, earlyPerformanceConsent: true, offerVersion: EDUCATION_CALL.version, idempotencyKey: `key-${sourceId}` });
  return { sql, db, env, hooks, route, data, emails, meetings, updates, cancellations, close: () => sql.close() };
}
const now = Date.now();
const slots = educationSlots({ now }).filter((slot) => Date.parse(slot.startAt) > now + 2 * 86_400_000);
const weekend = slots.find((slot) => dublinParts(slot.startAt).weekend && dublinParts(slot.startAt).minute === 12 * 60);
assert.ok(weekend);
const nextStart = (start, minutes) => new Date(Date.parse(start) + minutes * 60_000).toISOString();
const instant = (value) => Math.floor(Date.parse(value) / 1000);
const paid = (reference) => ({ paymentReference: reference, amountCents: 9999, currency: 'EUR', completed: true });

// Cutoffs refer to the call's finish. Europe/Dublin changes UTC offset with DST.
const monday = '2027-03-01', ruleNow = Date.parse('2027-02-28T00:00:00Z');
const noticeStart = dublinWallTime(monday, 19 * 60 + 30);
assert.equal(validateEducationSlot(noticeStart, { now: Date.parse(noticeStart) - 24 * 3600000 }).startAt, noticeStart);
assert.throws(() => validateEducationSlot(noticeStart, { now: Date.parse(noticeStart) - 24 * 3600000 + 1 }), /24 hours/);
assert.equal(validateEducationSlot(dublinWallTime(monday, 20 * 60 + 15), { now: ruleNow }).endAt, '2027-03-01T20:55:00.000Z');
assert.throws(() => validateEducationSlot(dublinWallTime(monday, 20 * 60 + 30), { now: ruleNow }));
assert.throws(() => validateEducationSlot(dublinWallTime(monday, 19 * 60 + 15), { now: ruleNow }));
assert.throws(() => validateEducationSlot('2027-03-01T19:31:00Z', { now: ruleNow }));
assert.throws(() => validateEducationSlot('2027-03-01T19:30:01Z', { now: ruleNow }));
assert.equal(dublinWallTime('2027-03-28', 12 * 60), '2027-03-28T11:00:00.000Z');
assert.equal(dublinWallTime('2027-10-31', 12 * 60), '2027-10-31T12:00:00.000Z');
const fixedSlots = educationSlots({ from: monday, now: ruleNow });
assert.equal(fixedSlots.filter((slot) => dublinParts(slot.startAt).date === monday).length, 4);
assert.equal(fixedSlots.filter((slot) => dublinParts(slot.startAt).date === '2027-03-06').length, 18);
assert.throws(() => educationSlots({ from: '2027-02-30', now: ruleNow }));

const f = fixture();
try {
  let result = await f.route('/api/education-calls/availability');
  assert.equal(result.status, 200);
  assert.equal(result.json.timezone, 'Europe/Dublin');
  assert.ok(result.json.slots.every((slot) => Date.parse(slot.startAt) <= Date.now() + 28 * 86_400_000));
  assert.equal((await f.route('/api/education-calls/bookings', { ...f.data('consent', weekend.startAt), reportAccessConsent: false })).status, 400);
  assert.equal((await f.route('/api/education-calls/bookings', f.data('unauthorised', weekend.startAt))).status, 403);
  assert.equal((await f.route('/api/advisor/education-calls/bookings', undefined, { requireAdvisor: async () => false })).status, 401);

  // These requests read the same initial calendar before racing to reserve it.
  const bodies = [f.data('race-a', weekend.startAt), f.data('race-b', nextStart(weekend.startAt, 15))];
  const raced = await Promise.all(bodies.map((body) => f.route('/api/education-calls/bookings', body)));
  assert.deepEqual(raced.map((value) => value.status).sort(), [200, 409]);
  const winner = raced.find((value) => value.status === 200).json.booking;
  const winnerBody = bodies[raced.findIndex((value) => value.status === 200)];
  assert.equal(winner.amountCents, 9999);
  assert.equal(winner.paymentStatus, 'pending');
  assert.equal(f.meetings.length, 0, 'Payment must precede Zoom creation');
  assert.equal((await f.route('/api/education-calls/bookings', winnerBody)).json.booking.id, winner.id);
  assert.equal((await f.route('/api/education-calls/bookings', { ...winnerBody, startAt: nextStart(winnerBody.startAt, 45) })).status, 409);
  assert.equal((await f.route(`/api/education-calls/bookings/${winner.id}?token=invalid`)).status, 403);
  const calendar = (id) => f.sql.prepare('SELECT * FROM education_calendar_reservations WHERE booking_id = ?').get(id);
  assert.ok(calendar(winner.id));
  const occupied = await f.route('/api/education-calls/availability');
  assert.ok(!occupied.json.slots.some((slot) => slot.startAt === winner.startAt));

  const paymentPath = `/api/advisor/education-calls/bookings/${winner.id}/verify-payment`;
  assert.equal((await f.route(`/api/advisor/education-calls/bookings/${winner.id}/payment-link`, { paymentLink: 'https://revolut.me.evil.example/pay' })).status, 400);
  assert.equal((await f.route(`/api/advisor/education-calls/bookings/${winner.id}/payment-link`, { paymentLink: 'https://revolut.me/fixture-payment' })).status, 200);
  assert.equal((await f.route(paymentPath, { ...paid('payment-1'), amountCents: 100 })).status, 400);
  result = await f.route(paymentPath, paid('payment-1'));
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.booking.status, 'confirmed');
  assert.equal(f.meetings.length, 1);
  assert.ok(f.emails.some((email) => email.kind === 'booking_confirmed'));
  await f.route(paymentPath, paid('payment-1'));
  assert.equal(f.meetings.length, 1, 'Duplicate payment verification must reuse the meeting');

  // Two advisor proposals carrying the same revision cannot alter separate
  // calendar/booking rows inconsistently, even when neither proposed time overlaps.
  const initial = result.json.booking;
  const candidateTimes = [nextStart(initial.startAt, 60), nextStart(initial.startAt, 120)];
  const proposals = await Promise.all(candidateTimes.map((startAt) => f.route(`/api/advisor/education-calls/bookings/${winner.id}/propose`, { startAt, revision: initial.revision })));
  assert.deepEqual(proposals.map((value) => value.status).sort(), [200, 409]);
  let booking = (await f.route(`/api/education-calls/bookings/${winner.id}?token=${winner.accessToken}`)).json.booking;
  assert.equal(calendar(winner.id).proposal_start_at, instant(booking.proposal.startAt));
  assert.ok(Date.parse(booking.proposal.expiresAt) <= Date.now() + 24 * 3600_000);
  const decisions = await Promise.all(['accept', 'decline'].map((decision) => f.route(`/api/education-calls/bookings/${winner.id}/response`, { token: winner.accessToken, revision: booking.proposal.revision, decision })));
  assert.deepEqual(decisions.map((value) => value.status).sort(), [200, 409]);
  booking = (await f.route(`/api/education-calls/bookings/${winner.id}?token=${winner.accessToken}`)).json.booking;
  assert.equal(calendar(winner.id).start_at, instant(booking.startAt));
  assert.equal(calendar(winner.id).proposal_start_at, null);

  // An overlapping replacement reserves the union; accepting it releases the
  // original interval without allowing another booking into either interval.
  const original = booking.startAt, overlap = nextStart(original, 15);
  result = await f.route(`/api/advisor/education-calls/bookings/${winner.id}/propose`, { startAt: overlap, revision: booking.revision });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  booking = result.json.booking;
  assert.equal((await f.route('/api/education-calls/bookings', f.data('union-conflict', original))).status, 409);
  assert.equal((await f.route(`/api/education-calls/bookings/${winner.id}/response`, { token: winner.accessToken, revision: booking.proposal.revision, decision: 'accept' })).status, 200);
  assert.equal(calendar(winner.id).start_at, instant(overlap));
  assert.equal(f.meetings.length, 1);
  assert.ok(f.updates.length >= 1);

  result = await f.route(`/api/advisor/education-calls/bookings/${winner.id}/cancel`, { reason: 'Pilot test completed' });
  assert.equal(result.json.booking.paymentStatus, 'refund_required');
  assert.equal(calendar(winner.id), undefined);
  assert.equal(f.cancellations.length, 1);
  assert.equal((await f.route(`/api/advisor/education-calls/bookings/${winner.id}/refund`, { refundReference: 'refund-1' })).json.booking.paymentStatus, 'refunded');

  // Both manually blocked dates and existing adviser meetings share the ledger.
  result = await f.route('/api/advisor/education-calls/blocks', { startAt: weekend.startAt, endAt: weekend.endAt, reason: 'Unavailable' });
  assert.equal(result.status, 200);
  assert.equal((await f.route('/api/education-calls/bookings', f.data('blocked', weekend.startAt))).status, 409);
  await f.route(`/api/advisor/education-calls/blocks/${result.json.block.id}`, undefined, {}, 'DELETE');
  await reserveAdvisorCalendar(f.env, { leadId: 98765, startAt: weekend.startAt, endAt: weekend.endAt, status: 'confirmed' });
  await reserveAdvisorCalendar(f.env, { leadId: 98765, startAt: weekend.startAt, endAt: weekend.endAt, status: 'confirmed' });
  assert.equal((await f.route('/api/education-calls/bookings', f.data('legacy-conflict', weekend.startAt))).status, 409);
  await reserveAdvisorCalendar(f.env, { leadId: 98765, status: 'cancelled' });

  // Expired holds disappear even before cron. A subsequently discovered payment
  // is recorded for review and never takes the new customer's reservation.
  const expiring = (await f.route('/api/education-calls/bookings', f.data('expiring', weekend.startAt))).json.booking;
  f.sql.prepare('UPDATE education_bookings SET hold_expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, expiring.id);
  f.sql.prepare('UPDATE education_calendar_reservations SET expires_at = ? WHERE booking_id = ?').run(Math.floor(Date.now() / 1000) - 1, expiring.id);
  const successor = await f.route('/api/education-calls/bookings', f.data('successor', weekend.startAt));
  assert.equal(successor.status, 200);
  result = await f.route(`/api/advisor/education-calls/bookings/${expiring.id}/verify-payment`, paid('late-payment'));
  assert.equal(result.json.booking.paymentStatus, 'late_review');
  assert.ok(calendar(successor.json.booking.id));
  assert.equal(calendar(expiring.id), undefined);
  assert.ok(f.emails.some((email) => email.kind === 'booking_expired'));

  // A failed delivery remains retryable without losing the verified payment.
  let shouldFailMail = true;
  const failMail = { sendEmail: async (job) => { if (shouldFailMail) throw new Error('Fixture mail unavailable'); f.emails.push(job); } };
  const succ = successor.json.booking;
  result = await f.route(`/api/advisor/education-calls/bookings/${succ.id}/verify-payment`, paid('payment-2'), failMail);
  assert.equal(result.json.booking.status, 'confirmed');
  const creates = f.meetings.length;
  shouldFailMail = false;
  await f.route(`/api/advisor/education-calls/bookings/${succ.id}/retry`, {}, failMail);
  assert.equal(f.meetings.length, creates);
  assert.ok(f.emails.some((email) => email.kind === 'booking_confirmed' && email.booking.id === succ.id));
  const succCurrent = (await f.route(`/api/education-calls/bookings/${succ.id}?token=${succ.accessToken}`)).json.booking;
  result = await f.route(`/api/advisor/education-calls/bookings/${succ.id}/propose`, { startAt: nextStart(succ.startAt, 15), revision: succCurrent.revision });
  assert.equal(result.status, 200);
  f.sql.prepare('UPDATE education_bookings SET proposal_expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, succ.id);
  f.sql.prepare('UPDATE education_calendar_reservations SET proposal_expires_at = ? WHERE booking_id = ?').run(Math.floor(Date.now() / 1000) - 1, succ.id);
  const afterProposalExpiry = (await f.route(`/api/education-calls/bookings/${succ.id}?token=${succ.accessToken}`)).json.booking;
  assert.equal(afterProposalExpiry.proposal, null);
  assert.equal(afterProposalExpiry.startAt, succ.startAt, 'Expiring a proposal must retain the original time');
  assert.equal(calendar(succ.id).proposal_start_at, null);

  // Ambiguous Zoom creation is never retried automatically.
  const uncertainTime = nextStart(weekend.startAt, 180);
  const uncertain = (await f.route('/api/education-calls/bookings', f.data('uncertain', uncertainTime))).json.booking;
  let uncertainCreates = 0;
  const failZoom = { ...f.hooks, createZoom: async () => { uncertainCreates += 1; throw new TypeError('Fixture connection lost after send'); } };
  result = await f.route(`/api/advisor/education-calls/bookings/${uncertain.id}/verify-payment`, paid('payment-3'), failZoom);
  assert.equal(result.json.booking.zoomState, 'uncertain');
  await processEducationCallJobs(f.env, failZoom);
  assert.equal(uncertainCreates, 1);
  result = await f.route(`/api/advisor/education-calls/bookings/${uncertain.id}/reconcile-zoom`, { zoomMeetingId: 'recovered-123', zoomJoinUrl: 'https://zoom.us/j/123' });
  assert.equal(result.json.booking.zoomState, 'ready');
  assert.equal(uncertainCreates, 1);

  // Retry a setup interrupted by process termination. The same booking identity,
  // lead and consented analysis are retained under a fenced replacement claim.
  const recoveryTime = slots.find((slot) => !dublinParts(slot.startAt).weekend).startAt;
  const recoveryBody = f.data('setup-recovery', recoveryTime);
  const recovery = (await f.route('/api/education-calls/bookings', recoveryBody)).json.booking;
  const leadCount = f.sql.prepare('SELECT COUNT(*) AS n FROM leads').get().n;
  f.sql.prepare("UPDATE education_bookings SET setup_state = 'pending', setup_token = 'crashed-claim', setup_claimed_at = ?, report_snapshot_id = NULL WHERE id = ?").run(Math.floor(Date.now() / 1000) - 121, recovery.id);
  result = await f.route('/api/education-calls/bookings', recoveryBody);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.booking.id, recovery.id);
  assert.equal(result.json.booking.setupState, 'ready');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM leads').get().n, leadCount);
  assert.equal((await f.route('/api/education-calls/bookings', { ...recoveryBody, analysisRunId: 'another-analysis' })).status, 409);
  assert.equal((await f.route(`/api/advisor/education-calls/bookings/${recovery.id}/verify-payment`, paid('payment-1'))).status, 409, 'A completed payment reference cannot pay for two bookings');

  const paymentCancellation = await Promise.all([
    f.route(`/api/advisor/education-calls/bookings/${recovery.id}/verify-payment`, paid('payment-recovery')),
    f.route(`/api/advisor/education-calls/bookings/${recovery.id}/cancel`, { reason: 'Concurrent cancellation fixture' })
  ]);
  assert.deepEqual(paymentCancellation.map((value) => value.status).sort(), [200, 409]);
  const recoveryCurrent = (await f.route(`/api/education-calls/bookings/${recovery.id}?token=${recovery.accessToken}`)).json.booking;
  assert.equal(Boolean(calendar(recovery.id)), recoveryCurrent.status === 'confirmed');

  f.env.EDUCATION_CALLS_ENABLED = 'false';
  assert.equal((await f.route('/api/education-calls/availability')).status, 503);
  assert.equal((await f.route(`/api/education-calls/bookings/${succ.id}?token=${succ.accessToken}`)).status, 200, 'Stopping new bookings must retain access to existing bookings');
  f.env.EDUCATION_CALLS_ENABLED = 'true';

  // A report storage error releases the hold instead of trapping the time.
  const failureTime = nextStart(weekend.startAt, 240);
  result = await f.route('/api/education-calls/bookings', f.data('snapshot-failure', failureTime), { createReportSnapshot: async () => { throw new Error('Fixture storage failure'); } });
  assert.equal(result.status, 500);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM education_calendar_reservations r JOIN education_bookings b ON b.id = r.booking_id WHERE b.source_id = 'snapshot-failure'").get().n, 0);
  await reconcileEducationBookings(f.env);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM education_booking_operations').get().n, 0);
  console.log('Education booking: Dublin/DST cutoffs, concurrent interval reservations and revision races, report consent, holds, payment verification, union rescheduling, legacy calls/blocks, expiry, setup/delivery recovery and uncertain Zoom checks passed.');
} finally { f.close(); }

// Proposing and declining another time changes the command revision, but must
// neither erase work for the committed time nor generate duplicate invitations.
const revisionFixture = fixture();
try {
  const f = revisionFixture;
  const initial = (await f.route('/api/education-calls/bookings', f.data('schedule-revisions', weekend.startAt))).json.booking;
  await f.route(`/api/advisor/education-calls/bookings/${initial.id}/verify-payment`, paid('schedule-revision-payment'));
  const get = async () => (await f.route(`/api/education-calls/bookings/${initial.id}?token=${initial.accessToken}`)).json.booking;
  let booking = await get();
  let result = await f.route(`/api/advisor/education-calls/bookings/${initial.id}/propose`, { startAt: nextStart(weekend.startAt, 45), revision: booking.revision }, { sendEmail: null });
  const failUpdate = { updateZoom: async () => { throw new Error('Fixture update outage'); } };
  result = await f.route(`/api/education-calls/bookings/${initial.id}/response`, { token: initial.accessToken, revision: result.json.booking.proposal.revision, decision: 'accept' }, failUpdate);
  assert.equal(result.json.booking.zoomState, 'failed');
  const committed = result.json.booking;
  result = await f.route(`/api/advisor/education-calls/bookings/${initial.id}/propose`, { startAt: nextStart(weekend.startAt, 90), revision: committed.revision }, { sendEmail: null });
  await f.route(`/api/education-calls/bookings/${initial.id}/response`, { token: initial.accessToken, revision: result.json.booking.proposal.revision, decision: 'decline' }, { sendEmail: null });
  booking = await get();
  assert.equal(booking.scheduleRevision, committed.scheduleRevision);
  assert.ok(booking.revision > committed.revision);
  await processEducationCallJobs(f.env, f.hooks);
  booking = await get();
  assert.equal(booking.zoomState, 'ready');
  assert.equal(f.updates.at(-1).startAt, committed.startAt, 'A proposal/decline must not supersede the outstanding update for the accepted time');
  assert.equal(f.emails.filter((mail) => mail.kind === 'booking_confirmed' && mail.booking.startAt === committed.startAt).length, 1);
  await processEducationCallJobs(f.env, f.hooks);
  assert.equal(f.emails.filter((mail) => mail.kind === 'booking_confirmed' && mail.booking.startAt === committed.startAt).length, 1);
} finally { revisionFixture.close(); }

const confirmationFixture = fixture();
try {
  const f = confirmationFixture;
  const initial = (await f.route('/api/education-calls/bookings', f.data('confirmation-revisions', weekend.startAt))).json.booking;
  await f.route(`/api/advisor/education-calls/bookings/${initial.id}/verify-payment`, paid('confirmation-revision-payment'), {
    sendEmail: async (job) => { if (job.kind === 'booking_confirmed') throw new Error('Fixture confirmation outage'); f.emails.push(job); }
  });
  let booking = (await f.route(`/api/education-calls/bookings/${initial.id}?token=${initial.accessToken}`)).json.booking;
  const proposed = await f.route(`/api/advisor/education-calls/bookings/${initial.id}/propose`, { startAt: nextStart(weekend.startAt, 45), revision: booking.revision }, { sendEmail: null });
  await f.route(`/api/education-calls/bookings/${initial.id}/response`, { token: initial.accessToken, revision: proposed.json.booking.proposal.revision, decision: 'decline' }, { sendEmail: null });
  await processEducationCallJobs(f.env, f.hooks);
  assert.equal(f.emails.filter((mail) => mail.kind === 'booking_confirmed' && mail.booking.startAt === initial.startAt).length, 1,
    'An unsent final invitation must survive a proposed/declined alternative');
  assert.equal(f.meetings.length, 1);
} finally { confirmationFixture.close(); }

// Reverse-completion attempt: B's remote PATCH is deliberately held open while
// C becomes accepted and a second outbox runner tries to PATCH C. A database
// lease prevents C's request starting until B's request has completed.
const leaseFixture = fixture();
try {
  const f = leaseFixture;
  const initial = (await f.route('/api/education-calls/bookings', f.data('zoom-mutation-lease', weekend.startAt))).json.booking;
  await f.route(`/api/advisor/education-calls/bookings/${initial.id}/verify-payment`, paid('zoom-lease-payment'));
  const get = async () => (await f.route(`/api/education-calls/bookings/${initial.id}?token=${initial.accessToken}`)).json.booking;
  const accept = async (startAt) => {
    const booking = await get();
    const proposal = await f.route(`/api/advisor/education-calls/bookings/${initial.id}/propose`, { startAt, revision: booking.revision }, { sendEmail: null });
    return f.route(`/api/education-calls/bookings/${initial.id}/response`, { token: initial.accessToken, revision: proposal.json.booking.proposal.revision, decision: 'accept' }, { sendEmail: null });
  };
  const bTime = nextStart(weekend.startAt, 45), cTime = nextStart(weekend.startAt, 90);
  await accept(bTime);
  let releaseFirst, firstStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const starts = [], completions = [];
  let remoteTime = initial.startAt;
  const deferredHooks = { ...f.hooks, updateZoom: async (booking) => {
    starts.push(booking.startAt);
    if (starts.length === 1) { firstStarted(); await firstGate; }
    remoteTime = booking.startAt;
    completions.push(booking.startAt);
  } };
  const firstRunner = processEducationCallJobs(f.env, deferredHooks);
  await started;
  await accept(cTime);
  await processEducationCallJobs(f.env, deferredHooks);
  assert.deepEqual(starts, [bTime], 'The second remote update must wait for the booking-wide lease');
  releaseFirst();
  await firstRunner;
  await processEducationCallJobs(f.env, deferredHooks);
  assert.deepEqual(completions, [bTime, cTime]);
  assert.equal(remoteTime, cTime);
  assert.equal((await get()).zoomState, 'ready');
  assert.equal(f.emails.filter((mail) => mail.kind === 'booking_confirmed' && mail.booking.startAt === cTime).length, 1);
} finally { leaseFixture.close(); }
console.log('Education booking committed-schedule regressions: failed update/confirmation survive proposal changes; concurrent Zoom updates are serialised.');

// A worker disappearing during Zoom creation must expose the same uncertainty
// on the booking which drives the admin recovery form. A late result from the
// old worker cannot overwrite the meeting an operator has since reconciled.
const crashedCreateFixture = fixture();
try {
  const f = crashedCreateFixture;
  const initial = (await f.route('/api/education-calls/bookings', f.data('crashed-zoom-create', weekend.startAt))).json.booking;
  await f.route(`/api/advisor/education-calls/bookings/${initial.id}/verify-payment`, paid('crashed-create-payment'), { sendEmail: null });
  let releaseCreate, createStarted;
  const gate = new Promise((resolve) => { releaseCreate = resolve; });
  const started = new Promise((resolve) => { createStarted = resolve; });
  const oldWorker = processEducationCallJobs(f.env, { ...f.hooks, createZoom: async () => {
    createStarted(); await gate;
    return { zoomMeetingId: 'old-worker-result', zoomJoinUrl: 'https://zoom.us/j/111' };
  } });
  await started;
  f.sql.prepare("UPDATE education_booking_jobs SET claimed_at = ? WHERE booking_id = ? AND kind = 'zoom_create' AND state = 'processing'").run(Math.floor(Date.now() / 1000) - 601, initial.id);
  await reconcileEducationBookings(f.env);
  let booking = (await f.route(`/api/education-calls/bookings/${initial.id}?token=${initial.accessToken}`)).json.booking;
  assert.equal(booking.zoomState, 'uncertain');
  assert.equal(f.sql.prepare("SELECT state FROM education_booking_jobs WHERE booking_id = ? AND kind = 'zoom_create'").get(initial.id).state, 'uncertain');
  await f.route(`/api/advisor/education-calls/bookings/${initial.id}/reconcile-zoom`, { zoomMeetingId: 'operator-reconciled', zoomJoinUrl: 'https://zoom.us/j/222' });
  releaseCreate();
  const oldResult = await oldWorker;
  assert.ok(oldResult.some((value) => value.state === 'claim_lost'));
  booking = (await f.route(`/api/education-calls/bookings/${initial.id}?token=${initial.accessToken}`)).json.booking;
  assert.equal(booking.zoomMeetingId, 'operator-reconciled');
  assert.equal(booking.zoomState, 'ready');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM education_job_operations').get().n, 0);
} finally { crashedCreateFixture.close(); }
console.log('Education booking crash recovery: stale Zoom creation exposes uncertainty; late worker results cannot overwrite an operator reconciliation.');
