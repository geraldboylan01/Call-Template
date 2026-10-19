import { bookingElement as el, formatBookingTime, loadBookingStyles } from './education_booking_ui.js';
import { validateEducationSlot } from './education_booking.js';

/** Interpret an entered wall-clock value in Dublin, independently of the administrator's device zone. */
export function dublinDateTimeToIso(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) throw new Error('Enter a date and time in Europe/Dublin.');
  const target = Date.UTC(...[Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])]);
  let instant = target;
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    const actual = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    if (actual === target) return new Date(instant).toISOString();
    instant += target - actual;
  }
  throw new Error('That time does not exist in Europe/Dublin because the clocks change.');
}

function field(label, type = 'text', value = '') {
  const wrapper = el('label', 'education-booking-field');
  const input = el('input'); input.type = type; input.value = value; input.required = true;
  wrapper.append(el('span', '', label), input);
  return { wrapper, input };
}

export function createEducationBookingAdmin(root, { request, toast = () => {} }) {
  loadBookingStyles();
  let selectedId = '', bookings = [], blocks = [], busy = false;
  root.classList.add('education-booking');
  const heading = el('h2', '', 'Paid walkthroughs');
  const notice = el('p', 'education-booking-notice', '€99.99 · 40 minutes · Europe/Dublin. Stripe confirms new payments automatically. Appointments require at least 24 hours’ notice.');
  const error = el('p'); error.setAttribute('role', 'status');
  const refresh = el('button', 'education-booking-link', 'Refresh walkthroughs'); refresh.type = 'button';
  const selectLabel = el('label', 'education-booking-field');
  const select = el('select'); select.setAttribute('aria-label', 'Select paid walkthrough booking');
  selectLabel.append(el('span', '', 'Booking'), select);
  const overview = el('p', 'education-booking-notice');
  const upcoming = el('details', 'education-booking-terms'); upcoming.append(el('summary', '', 'Upcoming appointments'));
  const upcomingList = el('div'); upcoming.append(upcomingList);
  const detail = el('div');
  const blockSection = el('details', 'education-booking-terms');
  blockSection.append(el('summary', '', 'Block unavailable dates or times'));
  const blockForm = el('form');
  const blockGrid = el('div', 'education-booking-grid');
  const blockStart = field('Unavailable from · Europe/Dublin', 'datetime-local');
  const blockEnd = field('Unavailable until · Europe/Dublin', 'datetime-local');
  const blockReason = field('Reason (private)', 'text'); blockReason.input.required = false; blockReason.input.maxLength = 500;
  blockGrid.append(blockStart.wrapper, blockEnd.wrapper, blockReason.wrapper);
  const addBlock = el('button', 'education-booking-button', 'Add unavailable period'); addBlock.type = 'submit';
  blockForm.append(blockGrid, addBlock);
  const blockList = el('div'); blockSection.append(blockForm, blockList);
  root.append(heading, notice, error, refresh, overview, upcoming, selectLabel, detail, blockSection);

  async function action(operation, message) {
    if (busy) return;
    busy = true; error.textContent = '';
    root.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try { await operation(); toast(message); await load(); }
    catch (failure) { error.textContent = failure.message; }
    finally { busy = false; root.querySelectorAll('button').forEach((button) => { button.disabled = false; }); }
  }
  function post(id, operation, body) {
    return request(`/api/advisor/education-calls/bookings/${encodeURIComponent(bookings.find(item => item.id === id)?.bookingId || id)}/${operation}`, { method: 'POST', body });
  }
  function verificationForm(booking, late = false) {
    const form = el('form', 'education-booking-admin-row');
    const reference = field('Completed payment reference from Revolut', 'text'); reference.input.maxLength = 200;
    const attestation = el('label', 'education-booking-consent');
    const checked = el('input'); checked.type = 'checkbox'; checked.required = true;
    attestation.append(checked, el('span', '', 'I checked Revolut and verified the completed €99.99 EUR payment for this booking.'));
    const verify = el('button', 'education-booking-button', late ? 'Record late payment for review' : 'Verify completed €99.99 EUR payment'); verify.type = 'submit';
    form.append(reference.wrapper, attestation, verify);
    if (late) form.append(el('p', '', 'This will record the payment for refund or rebooking review. It will not restore the expired or cancelled appointment.'));
    form.addEventListener('submit', (event) => {
      event.preventDefault(); if (!form.reportValidity()) return;
      void action(() => post(booking.id, 'verify-payment', { paymentReference: reference.input.value.trim(), amountCents: booking.amountCents ?? 9999, currency: booking.currency || 'EUR', completed: true }), late ? 'Payment recorded for refund or rebooking review.' : 'Payment verification saved; Zoom confirmation processed.');
    });
    return form;
  }
  function renderDetail() {
    detail.replaceChildren();
    const booking = bookings.find((item) => item.id === selectedId);
    if (!booking) { detail.append(el('p', '', 'No walkthrough bookings yet.')); return; }
    detail.append(el('h3', '', booking.contact?.fullName || booking.fullName || booking.id));
    detail.append(el('p', '', `${booking.contact?.email || booking.email || ''} · ${booking.status} · payment: ${booking.paymentStatus || 'pending'}`));
    detail.append(el('p', '', booking.startAt ? `${formatBookingTime(booking.startAt)} to ${formatBookingTime(booking.endAt)}` : booking.paymentStatus === 'verified' ? 'Paid — awaiting appointment scheduling' : 'Awaiting payment confirmation'));
    if (booking.discussionTopics !== undefined) detail.append(el('h4', '', 'Discussion topics'), el('p', 'education-booking-topics', booking.discussionTopics || 'No specific discussion topics provided.'));
    if (booking.paymentEmailStatus || booking.bookingEmailStatus) detail.append(el('p', 'education-booking-notice', `Payment email: ${booking.paymentEmailStatus || 'pending'} · booking email: ${booking.bookingEmailStatus || (booking.startAt ? 'pending' : 'not scheduled')}`));
    if (booking.holdExpiresAt) detail.append(el('p', '', `Payment deadline: ${formatBookingTime(booking.holdExpiresAt)}`));
    if (booking.proposal) detail.append(el('p', '', `Replacement proposed: ${formatBookingTime(booking.proposal.startAt)}; response deadline ${formatBookingTime(booking.proposal.expiresAt)}. Original reservation is retained.`));
    if (booking.paymentReference) detail.append(el('p', '', `Verified reference: ${booking.paymentReference}`));
    if (booking.paymentProvider === 'stripe') detail.append(el('p', '', 'Stripe payment: confirmation is automatic. Manage payments and refunds in the Stripe Dashboard.'));
    if (booking.stripePaymentReview) detail.append(el('p', 'education-booking-notice', `Stripe payment needs review: ${booking.stripePaymentReview.replaceAll('_', ' ')}. Check Stripe before changing this booking.`));
    if (booking.zoomState) detail.append(el('p', '', `Zoom: ${booking.zoomState}`));
    if (booking.zoomJoinUrl) {
      const zoom = el('a', 'education-booking-link', 'Open Zoom meeting');
      if (/^https:\/\//i.test(booking.zoomJoinUrl)) { zoom.href = booking.zoomJoinUrl; zoom.target = '_blank'; zoom.rel = 'noopener noreferrer'; detail.append(zoom); }
    }
    const advisorAnalysisLink = booking.reportAdvisorLink || booking.advisorAnalysisLink || booking.analysis?.advisorUrl;
    if (advisorAnalysisLink && /^https:\/\//i.test(advisorAnalysisLink)) {
      const report = el('a', 'education-booking-link', 'View advisor analysis');
      report.href = advisorAnalysisLink; report.target = '_blank'; report.rel = 'noopener noreferrer'; detail.append(report);
    } else if (booking.reportSnapshotId) {
      const recover = el('button', 'education-booking-link', 'Load consented report link'); recover.type = 'button';
      recover.addEventListener('click', async () => {
        recover.disabled = true;
        try {
          const payload = await request(`/api/advisor/published-sessions/${encodeURIComponent(booking.reportSnapshotId)}`);
          if (!payload.session?.advisorSecretB64u) throw new Error('The report recovery key is not available.');
          const url = new URL('../../app/education-call-report.html', import.meta.url);
          url.searchParams.set('pub', booking.reportSnapshotId); url.searchParams.set('view', 'overview');
          url.hash = new URLSearchParams({ ak: payload.session.advisorSecretB64u }).toString();
          const report = el('a', 'education-booking-link', 'View advisor analysis');
          report.href = url.href; report.target = '_blank'; report.rel = 'noopener noreferrer'; recover.replaceWith(report);
        } catch (failure) { error.textContent = failure.message; recover.disabled = false; }
      });
      detail.append(recover);
    }
    const clientAnalysisLink = booking.reportClientPreviewLink || booking.reportClientLink || booking.clientAnalysisLink || booking.analysis?.clientUrl;
    if (clientAnalysisLink && /^https:\/\//i.test(clientAnalysisLink)) {
      const clientReport = el('a', 'education-booking-link', 'View client analysis'); clientReport.href = clientAnalysisLink; clientReport.target = '_blank'; clientReport.rel = 'noopener noreferrer'; detail.append(clientReport);
    }
    if (booking.purchaseId && ['confirmed', 'scheduled'].includes(booking.status)) {
      const complete = el('button', 'education-booking-button', 'Mark walkthrough completed'); complete.type = 'button';
      complete.addEventListener('click', () => { void action(() => request(`/api/advisor/education-calls/purchases/${encodeURIComponent(booking.purchaseId)}/completed`, { method: 'POST', body: {} }), 'Walkthrough marked completed.'); }); detail.append(complete);
    }
    if (!['expired', 'cancelled', 'completed'].includes(booking.status)) {
      if (booking.paymentStatus !== 'verified' && booking.paymentProvider !== 'stripe') {
        const paymentForm = el('form', 'education-booking-admin-row');
        const link = field('Request-specific Revolut Pro HTTPS payment link', 'url', booking.paymentLink || '');
        const send = el('button', 'education-booking-button', 'Save and email payment link'); send.type = 'submit';
        paymentForm.append(link.wrapper, send);
        paymentForm.addEventListener('submit', (event) => {
          event.preventDefault();
          if (!paymentForm.reportValidity()) return;
          if (!/^https:\/\//i.test(link.input.value.trim())) { error.textContent = 'Use the HTTPS payment link copied from Revolut Pro.'; return; }
          void action(() => post(booking.id, 'payment-link', { paymentLink: link.input.value.trim() }), 'Payment instructions queued.');
        });
        detail.append(paymentForm, verificationForm(booking));
      }
      if (booking.startAt) {
      const proposeForm = el('form', 'education-booking-admin-row');
      const proposed = field('Propose another start · Europe/Dublin', 'datetime-local'); proposed.input.step = '900';
      const propose = el('button', 'education-booking-button', 'Propose replacement time'); propose.type = 'submit';
      proposeForm.append(proposed.wrapper, el('p', 'education-booking-notice', 'Choose a 15-minute start at least 24 hours ahead, within weekday 19:30–20:15 or weekend 12:00–16:15. The original time remains reserved until the customer accepts.'), propose);
      proposeForm.addEventListener('submit', (event) => {
        event.preventDefault(); if (!proposeForm.reportValidity()) return;
        void action(() => { const slot = validateEducationSlot(dublinDateTimeToIso(proposed.input.value)); return post(booking.id, 'propose', { startAt: slot.startAt, revision: booking.revision }); }, 'Replacement time proposed.');
      });
      const cancel = el('button', 'education-booking-link', 'Cancel reservation'); cancel.type = 'button';
      cancel.addEventListener('click', () => {
        if (!window.confirm('Cancel this walkthrough reservation? Any verified payment will need a refund or rebooking review.')) return;
        void action(() => post(booking.id, 'cancel', { reason: 'Cancelled by Gerry in the client pipeline' }), 'Reservation cancelled. Review any payment for refund or rebooking.');
      });
      detail.append(proposeForm, cancel);
      }
    }
    if (['expired', 'cancelled'].includes(booking.status) && booking.paymentStatus === 'pending' && booking.paymentProvider !== 'stripe') detail.append(verificationForm(booking, true));
    if (['refund_required', 'late_review'].includes(booking.paymentStatus) && booking.paymentProvider !== 'stripe') {
      const form = el('form', 'education-booking-admin-row');
      const reference = field('Completed Revolut refund reference', 'text'); reference.input.maxLength = 200;
      const submit = el('button', 'education-booking-button', 'Record completed refund'); submit.type = 'submit';
      form.append(el('p', '', 'Complete the refund in Revolut first, then record its reference here.'), reference.wrapper, submit);
      form.addEventListener('submit', (event) => { event.preventDefault(); if (form.reportValidity()) void action(() => post(booking.id, 'refund', { refundReference: reference.input.value.trim() }), 'Completed refund recorded.'); });
      detail.append(form);
    }
    if (booking.zoomState === 'uncertain') {
      const form = el('form', 'education-booking-admin-row');
      const meeting = field('Existing Zoom meeting ID', 'text');
      const join = field('Existing Zoom join URL', 'url');
      const submit = el('button', 'education-booking-button', 'Reconcile existing Zoom meeting'); submit.type = 'submit';
      form.append(el('p', '', 'Zoom may already have created the meeting. Check Zoom for this appointment and enter its existing details before retrying confirmation.'), meeting.wrapper, join.wrapper, submit);
      form.addEventListener('submit', (event) => { event.preventDefault(); if (form.reportValidity()) void action(() => post(booking.id, 'reconcile-zoom', { zoomMeetingId: meeting.input.value.trim(), zoomJoinUrl: join.input.value.trim() }), 'Existing Zoom meeting reconciled.'); });
      detail.append(form);
    }
    const retry = el('button', 'education-booking-link', 'Retry failed email or meeting delivery'); retry.type = 'button';
    retry.addEventListener('click', () => { void action(() => post(booking.id, 'retry', {}), 'Failed deliveries queued for retry.'); });
    if (!booking.purchaseId || booking.bookingId) detail.append(retry);
  }
  function render() {
    const pendingSchedule = bookings.filter(booking => booking.paymentStatus === 'verified' && !booking.startAt && !['cancelled', 'completed'].includes(booking.status)).length;
    const appointments = bookings.filter(booking => booking.startAt && Date.parse(booking.startAt) >= Date.now() && !['expired', 'cancelled', 'completed'].includes(booking.status)).sort((left, right) => left.startAt.localeCompare(right.startAt));
    overview.textContent = `${pendingSchedule} paid and awaiting scheduling · ${appointments.length} upcoming appointments · ${bookings.filter(booking => booking.status === 'completed').length} completed`;
    upcomingList.replaceChildren();
    if (!appointments.length) upcomingList.append(el('p', '', 'No upcoming walkthrough appointments.'));
    for (const appointment of appointments) {
      const choose = el('button', 'education-booking-link', `${formatBookingTime(appointment.startAt)} · ${appointment.contact?.fullName || appointment.fullName || 'Customer'}`); choose.type = 'button';
      choose.addEventListener('click', () => { selectedId = appointment.id; select.value = selectedId; renderDetail(); detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }); upcomingList.append(choose);
    }
    select.replaceChildren();
    for (const booking of bookings) {
      const option = el('option', '', `${booking.contact?.fullName || booking.fullName || 'Customer'} · ${booking.startAt ? formatBookingTime(booking.startAt) : 'Awaiting scheduling'} · ${booking.status}`);
      option.value = booking.id; select.append(option);
    }
    if (!bookings.some((item) => item.id === selectedId)) selectedId = bookings[0]?.id || '';
    select.value = selectedId; renderDetail();
    blockList.replaceChildren();
    for (const block of blocks) {
      const row = el('div', 'education-booking-admin-row');
      row.append(el('p', '', `${formatBookingTime(block.startAt)} – ${formatBookingTime(block.endAt)}${block.reason ? ` · ${block.reason}` : ''}`));
      const remove = el('button', 'education-booking-link', 'Remove block'); remove.type = 'button';
      remove.addEventListener('click', () => { void action(() => request(`/api/advisor/education-calls/blocks/${encodeURIComponent(block.id)}`, { method: 'DELETE' }), 'Unavailable period removed.'); });
      row.append(remove); blockList.append(row);
    }
  }
  async function load() {
    refresh.disabled = true;
    try {
      const payload = await request('/api/advisor/education-calls/bookings');
      const purchases = (payload.purchases || []).map(purchase => ({
        ...purchase, ...(purchase.booking || {}), id: purchase.id, purchaseId: purchase.id, bookingId: purchase.bookingId || purchase.booking?.id,
        status: purchase.status === 'completed' ? 'completed' : purchase.booking?.status || purchase.status,
        paymentProvider: 'stripe', paymentStatus: purchase.paymentStatus === 'paid' ? 'verified' : purchase.paymentStatus,
        contact: purchase.contact, discussionTopics: purchase.discussionTopics,
        reportAdvisorLink: purchase.reportAdvisorLink || purchase.advisorAnalysisLink || purchase.analysis?.advisorUrl,
        reportClientLink: purchase.reportClientPreviewLink || purchase.reportClientLink || purchase.clientAnalysisLink || purchase.analysis?.clientUrl
      }));
      const purchaseBookingIds = new Set(purchases.map(purchase => purchase.bookingId).filter(Boolean));
      bookings = [...purchases, ...(payload.bookings || []).filter(booking => !purchaseBookingIds.has(booking.id))]; blocks = payload.blocks || []; render();
    } catch (failure) { error.textContent = failure.message; }
    finally { refresh.disabled = false; }
  }
  select.addEventListener('change', () => { selectedId = select.value; renderDetail(); });
  refresh.addEventListener('click', () => { void load(); });
  blockForm.addEventListener('submit', (event) => {
    event.preventDefault(); if (!blockForm.reportValidity()) return;
    void action(async () => {
      const startAt = dublinDateTimeToIso(blockStart.input.value), endAt = dublinDateTimeToIso(blockEnd.input.value);
      if (startAt >= endAt) throw new Error('The block must finish after it starts.');
      await request('/api/advisor/education-calls/blocks', { method: 'POST', body: { startAt, endAt, reason: blockReason.input.value.trim() } });
      blockForm.reset();
    }, 'Unavailable period added.');
  });
  return { refresh: load };
}
