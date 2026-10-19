import { EDUCATION_CALL } from './education_call.js';
import { validateEducationSlot } from './education_booking.js';

export function bookingElement(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = String(text);
  return node;
}

export function loadBookingStyles() {
  if (document.querySelector?.('link[data-education-booking-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../../styles/education-booking.css', import.meta.url).href;
  link.dataset.educationBookingStyle = 'true';
  document.head?.append(link);
}

export function formatBookingTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not set' : new Intl.DateTimeFormat('en-IE', {
    timeZone: EDUCATION_CALL.timezone, weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  }).format(date);
}

export function bookingDay(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: EDUCATION_CALL.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function bookingHoldDeadline(startAt, now = Date.now()) {
  return new Date(Math.min(Number(now) + EDUCATION_CALL.holdHours * 3600000, new Date(startAt).getTime())).toISOString();
}

export async function bookingRequest(baseUrl, path, { headers = {}, body, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    credentials: 'omit', cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.error || payload?.message || 'The booking service could not complete your request.');
    error.status = response.status;
    error.details = payload;
    throw error;
  }
  return payload;
}

function consentRow(name, copy) {
  const label = bookingElement('label', 'education-booking-consent');
  const input = bookingElement('input');
  Object.assign(input, { type: 'checkbox', name, required: true });
  label.append(input, bookingElement('span', '', copy));
  return label;
}

export function createBookingSummary(booking) {
  const panel = bookingElement('div', 'education-booking-summary');
  const labels = { awaiting_payment: 'Time held — awaiting payment', confirmed: 'Walkthrough confirmed', expired: 'Reservation expired', cancelled: 'Booking cancelled' };
  panel.append(bookingElement('h3', '', labels[booking.status] || 'Your walkthrough booking'));
  panel.append(bookingElement('p', '', `${formatBookingTime(booking.startAt)} – ${new Intl.DateTimeFormat('en-IE', { timeZone: EDUCATION_CALL.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(booking.endAt))} · Europe/Dublin`));
  if (booking.status === 'awaiting_payment') panel.append(bookingElement('p', '', booking.paymentProvider === 'stripe'
    ? `Payment must be confirmed by ${formatBookingTime(booking.holdExpiresAt)}. Open your private booking page to pay. Your time is provisional until payment is confirmed; Zoom follows by email.`
    : `Gerry must verify your payment by ${formatBookingTime(booking.holdExpiresAt)}. Your time is provisional until then. Payment instructions arrive by email; Zoom follows once payment is verified.`));
  if (booking.paymentStatus === 'late_review') panel.append(bookingElement('p', '', 'Your payment needs rebooking or refund review. Contact hello@planeir.ie; this payment has not confirmed a time.'));
  if (booking.paymentLink && /^https:\/\//i.test(booking.paymentLink) && booking.status === 'awaiting_payment') {
    const payment = bookingElement('a', 'education-booking-button', 'Pay using Revolut');
    Object.assign(payment, { href: booking.paymentLink, target: '_blank', rel: 'noopener noreferrer' });
    panel.append(payment);
  }
  if (booking.zoomJoinUrl && /^https:\/\//i.test(booking.zoomJoinUrl) && booking.status === 'confirmed') {
    const zoom = bookingElement('a', 'education-booking-button', 'Join Zoom walkthrough');
    Object.assign(zoom, { href: booking.zoomJoinUrl, target: '_blank', rel: 'noopener noreferrer' });
    panel.append(zoom);
  }
  if (booking.accessToken) {
    const manage = bookingElement('a', 'education-booking-link', 'View booking and respond to time proposals');
    const url = new URL('../../app/education-call.html', import.meta.url);
    url.hash = new URLSearchParams({ booking: booking.id, token: booking.accessToken }).toString();
    manage.href = url.href;
    panel.append(manage);
  }
  return panel;
}

/** Creates only a private capability link: report keys never leave the source page. */
function walkthroughPurchaseUrl(purchase) {
  const target = new URL('../../app/walkthrough-payment.html', import.meta.url);
  target.hash = new URLSearchParams({ purchase: purchase.id, token: purchase.accessToken }).toString();
  return target.href;
}

export function rememberWalkthroughPurchase(purchase) {
  try {
    if (purchase?.id && purchase?.accessToken) sessionStorage.setItem('planeir.stripe-return', JSON.stringify({ purchase: purchase.id, token: purchase.accessToken }));
  } catch { /* The authenticated report and private email link also recover a purchase. */ }
}

export function validateStripeCheckoutUrl(value) {
  const target = new URL(value);
  if (target.protocol !== 'https:' || target.hostname !== 'checkout.stripe.com') throw new Error('The secure payment link is unavailable.');
  return target.href;
}

/** Keeps report credentials in the closure; sends them only after explicit consent. */
export function createEducationBookingWidget({ baseUrl = '', sourceType, sourceId, analysisRunId = null, getHeaders = async () => ({}), getReportKey = async () => '', enabled = true } = {}) {
  loadBookingStyles();
  const card = bookingElement('section', 'education-booking');
  card.dataset.callOfferVersion = EDUCATION_CALL.version;
  card.append(bookingElement('h2', '', 'Personalised Planéir Walkthrough'), bookingElement('p', '', 'Get more out of your financial analysis with a one-to-one walkthrough from Gerry, the creator of Planéir.'), bookingElement('p', 'education-booking-price', `${EDUCATION_CALL.priceLabel} · ${EDUCATION_CALL.durationMinutes} minutes on Zoom`));
  card.append(bookingElement('p', '', 'Understand your projections, explore scenarios and assumptions, and learn how to make the most of Planéir’s tools. Your session is tailored to you.'));
  if (!enabled || !sourceId) {
    card.append(bookingElement('p', '', 'Walkthrough bookings are not available in this version yet.'));
    return card;
  }
  const details = bookingElement('details');
  details.append(bookingElement('summary', 'education-booking-button', 'Book a Walkthrough with Gerry'));
  const form = bookingElement('form', 'education-booking-form');
  form.append(bookingElement('p', '', 'Pay securely, then choose a time at least 24 hours ahead and optionally share topics you’d like to discuss. Your existing Planéir profile is used for the booking.'));
  form.append(consentRow('reportAccessConsent', 'I give Gerry Boylan access to an encrypted copy of this exact report and my contact details to prepare for this walkthrough. This is separate from an adviser introduction.'));
  form.append(consentRow('termsAccepted', `I accept the ${EDUCATION_CALL.priceLabel} price and walkthrough terms below.`));
  form.append(consentRow('earlyPerformanceConsent', 'If my call falls within the 14-day withdrawal period, I expressly request the service to start then and acknowledge that my withdrawal right ends once the call is fully performed.'));
  const terms = bookingElement('details', 'education-booking-terms');
  terms.append(bookingElement('summary', '', 'Walkthrough terms and cancellation'));
  terms.append(bookingElement('p', '', 'Seller: Gerry Boylan, trading as Planéir. Contact hello@planeir.ie for cancellation, rebooking or a refund. €99.99 is the total price for one 40-minute Zoom education session. The session explains Planéir and your analysis; no financial product, tax or legal advice is provided.'));
  terms.append(bookingElement('p', '', 'Cancel before the call for a full refund. You may withdraw from this online service contract within 14 days by emailing your name, booking reference and request to cancel to hello@planeir.ie. Statutory consumer rights remain. If Gerry proposes another time, your original time remains held while you review it.'));
  const privacy = bookingElement('a', '', 'Privacy and report access');
  privacy.href = new URL('../../privacy/', import.meta.url).href; privacy.target = '_blank'; privacy.rel = 'noopener noreferrer'; terms.append(privacy);
  const status = bookingElement('p', 'education-booking-notice'); status.setAttribute('role', 'status');
  const submit = bookingElement('button', 'education-booking-button', `Continue to secure payment · ${EDUCATION_CALL.priceLabel}`); submit.type = 'submit'; submit.disabled = true;
  const methods = bookingElement('p', 'education-booking-notice', 'Secure payment via Stripe. Apple Pay, Google Pay and cards are available where supported. Your analysis remains free.');
  form.append(terms, status, submit, methods); details.append(form); card.append(details);
  let busy = false, checked = false, profileReady = false;
  const idempotencyKey = crypto.randomUUID();
  function showRecovery(purchase) {
    rememberWalkthroughPurchase(purchase);
    const panel = bookingElement('div', 'education-booking-summary');
    const paid = ['paid', 'scheduled', 'completed'].includes(purchase.status) || purchase.paymentStatus === 'paid';
    panel.append(bookingElement('h3', '', paid ? 'Your walkthrough is already paid' : 'Continue your walkthrough purchase'));
    panel.append(bookingElement('p', '', purchase.booking?.startAt ? `Booked for ${formatBookingTime(purchase.booking.startAt)}.` : paid ? 'Choose a time for your walkthrough. You do not need to pay again.' : 'Your existing purchase is saved. Continue to check its payment status.'));
    if (analysisRunId && purchase.analysisRunId && purchase.analysisRunId !== analysisRunId) {
      panel.append(bookingElement('p', 'education-booking-notice', 'This purchase retains the report you shared at checkout. You can open that exact report from your walkthrough page.'));
    }
    const link = bookingElement('a', 'education-booking-button', paid ? purchase.booking ? 'Manage my walkthrough' : 'Choose my walkthrough time' : 'Continue my purchase');
    link.href = walkthroughPurchaseUrl(purchase); panel.append(link); form.replaceWith(panel);
  }
  async function checkExisting() {
    if (checked || busy) return;
    busy = true; submit.disabled = true; status.textContent = 'Checking your existing walkthrough…';
    try {
      const query = new URLSearchParams({ sourceType, sourceId, ...(analysisRunId ? { analysisRunId } : {}) });
      const result = await bookingRequest(baseUrl, `/api/education-calls/purchases?${query}`, { headers: await getHeaders() });
      const recovered = result.purchase || result.purchases?.find(item => !['cancelled', 'expired', 'completed'].includes(item.status));
      const purchase = recovered && !['cancelled', 'expired', 'completed'].includes(recovered.status) ? recovered : null;
      if (purchase) showRecovery(purchase);
      if (!purchase) {
        const saved = await bookingRequest(baseUrl, `/api/education-calls/profile?${query}`, { headers: await getHeaders() });
        profileReady = Boolean(saved.profile?.fullName && saved.profile?.email);
        if (!profileReady) showProfileFields();
      }
      checked = true; status.textContent = '';
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; submit.disabled = !profileReady; }
  }
  function showProfileFields() {
    if (form.querySelector('[data-walkthrough-profile]')) return;
    const profile = bookingElement('section', 'education-booking-terms'); profile.dataset.walkthroughProfile = 'true';
    profile.append(bookingElement('h3', '', 'Save your profile details before checkout'), bookingElement('p', '', 'Your Planéir profile needs a name and email so we can associate your purchase and send the meeting details. Save these once; you will not need to enter them again at checkout.'));
    const grid = bookingElement('div', 'education-booking-grid');
    function input(label, name, type, autocomplete) {
      const wrapper = bookingElement('label', 'education-booking-field'), value = bookingElement('input');
      Object.assign(value, { name, type, required: true, autocomplete, maxLength: name === 'profileFullName' ? 120 : 200 }); wrapper.append(bookingElement('span', '', label), value); grid.append(wrapper); return value;
    }
    const fullName = input('Profile full name', 'profileFullName', 'text', 'name'), email = input('Profile email', 'profileEmail', 'email', 'email');
    const save = bookingElement('button', 'education-booking-button', 'Save profile details'); save.type = 'button';
    save.addEventListener('click', async () => {
      if (!fullName.reportValidity() || !email.reportValidity() || busy) return;
      busy = true; save.disabled = true; status.textContent = 'Saving your profile details…';
      try {
        await bookingRequest(baseUrl, '/api/education-calls/profile', { method: 'PATCH', headers: await getHeaders(), body: { sourceType, sourceId, ...(analysisRunId ? { analysisRunId } : {}), contact: { fullName: fullName.value.trim(), email: email.value.trim() } } });
        profileReady = true; profile.replaceWith(bookingElement('p', 'education-booking-notice', 'Your profile details are saved. You can continue to secure payment.')); status.textContent = '';
      } catch (error) { status.textContent = error.message; }
      finally { busy = false; save.disabled = false; submit.disabled = !profileReady; }
    });
    profile.append(grid, save); form.prepend(profile);
  }
  details.addEventListener('toggle', () => { if (details.open) void checkExisting(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); event.stopPropagation();
    if (busy || !profileReady || !form.reportValidity()) return;
    busy = true; submit.disabled = true; status.textContent = 'Opening your secure checkout…';
    try {
      const reportDekB64u = sourceType === 'published' ? await getReportKey() : '';
      const result = await bookingRequest(baseUrl, '/api/education-calls/purchases', { headers: await getHeaders(), body: {
        sourceType, sourceId, ...(sourceType === 'consumer' ? { analysisRunId } : {}),
        consent: true, reportAccessConsent: true, termsAccepted: true, earlyPerformanceConsent: true,
        policyVersion: 'education-walkthrough-v3', offerVersion: EDUCATION_CALL.version, idempotencyKey,
        ...(reportDekB64u ? { reportDekB64u } : {})
      } });
      const purchase = result.purchase; rememberWalkthroughPurchase(purchase);
      if (purchase.paymentStatus === 'paid' || ['paid', 'scheduled', 'completed'].includes(purchase.status)) {
        location.assign(walkthroughPurchaseUrl(purchase)); return;
      }
      const checkout = result.checkoutUrl ? result : await bookingRequest(baseUrl, `/api/education-calls/purchases/${encodeURIComponent(purchase.id)}/checkout`, { body: { token: purchase.accessToken } });
      location.assign(validateStripeCheckoutUrl(checkout.checkoutUrl));
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; submit.disabled = false; }
  });
  return card;
}

/** The same paid scheduler is used after Stripe and when a customer returns later. */
export function createPaidWalkthroughScheduler({ baseUrl = '', purchase, token, onScheduled = () => {} } = {}) {
  const form = bookingElement('form', 'education-booking-form');
  form.append(bookingElement('h2', '', 'Let’s get your walkthrough booked'), bookingElement('p', '', 'Choose a suitable time and share anything you’d particularly like to discuss.'), bookingElement('p', 'education-booking-notice', 'Walkthroughs must be booked at least 24 hours in advance to allow Gerry time to review your analysis and prepare for our discussion. Weekdays 19:30–21:00; weekends 12:00–17:00. Times follow Europe/Dublin, including clock changes.'));
  const grid = bookingElement('div', 'education-booking-grid');
  function selectField(label, name) {
    const wrapper = bookingElement('label', 'education-booking-field'); const input = bookingElement('select'); input.name = name; input.required = true;
    wrapper.append(bookingElement('span', '', label), input); grid.append(wrapper); return input;
  }
  const date = selectField('Available date', 'bookingDate'), time = selectField('Start time · Europe/Dublin', 'startAt');
  const topicLabel = bookingElement('label', 'education-booking-field'); topicLabel.append(bookingElement('span', '', 'Is there anything you’d particularly like to discuss? (optional)'));
  const topics = bookingElement('textarea'); topics.name = 'discussionTopics'; topics.rows = 4; topics.maxLength = 1000;
  topics.placeholder = 'Let me know what you’d like to focus on during our walkthrough…'; topics.value = purchase.discussionTopics || '';
  const hint = bookingElement('p', 'education-booking-notice', 'Share a couple of questions or topics to help Gerry prepare, such as changing your retirement age or exploring savings scenarios. Please avoid sensitive account numbers or passwords.'); hint.id = `topics-hint-${purchase.id}`; topics.setAttribute('aria-describedby', hint.id);
  const count = bookingElement('small', 'education-booking-notice');
  function updateCount() { count.textContent = `${topics.value.length}/1,000 characters`; }
  topics.addEventListener('input', updateCount); updateCount(); topicLabel.append(topics, count);
  const status = bookingElement('p', 'education-booking-notice'); status.setAttribute('role', 'status');
  const submit = bookingElement('button', 'education-booking-button', 'Confirm my walkthrough'); submit.type = 'submit'; submit.disabled = true;
  const refresh = bookingElement('button', 'education-booking-link', 'Refresh available times'); refresh.type = 'button';
  form.append(grid, topicLabel, hint, status, submit, refresh);
  let slots = [], busy = false, idempotencyKey = crypto.randomUUID();
  function renderTimes() {
    const selected = time.value; time.replaceChildren();
    for (const slot of slots.filter(slot => bookingDay(slot.startAt) === date.value)) {
      const option = bookingElement('option', '', `${formatBookingTime(slot.startAt)} – ${new Intl.DateTimeFormat('en-IE', { timeZone: EDUCATION_CALL.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(slot.endAt))}`); option.value = slot.startAt; time.append(option);
    }
    if ([...time.options].some(option => option.value === selected)) time.value = selected;
    submit.disabled = busy || !time.value;
  }
  async function loadSlots() {
    if (busy) return;
    busy = true; submit.disabled = true; refresh.disabled = true; status.textContent = 'Checking available times…';
    try {
      const result = await bookingRequest(baseUrl, `/api/education-calls/availability?from=${bookingDay(Date.now())}`);
      // Recheck locally as time may have passed since the server response.
      slots = (result.slots || []).filter(slot => { try { validateEducationSlot(slot.startAt); return true; } catch { return false; } });
      const selected = date.value; date.replaceChildren();
      for (const day of [...new Set(slots.map(slot => bookingDay(slot.startAt)))]) {
        const option = bookingElement('option', '', new Intl.DateTimeFormat('en-IE', { timeZone: EDUCATION_CALL.timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${day}T12:00:00Z`))); option.value = day; date.append(option);
      }
      if ([...date.options].some(option => option.value === selected)) date.value = selected;
      status.textContent = slots.length ? '' : 'No times are currently available in the next 28 days. Your payment is saved; return later to choose a time or contact hello@planeir.ie.';
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; refresh.disabled = false; renderTimes(); }
  }
  date.addEventListener('change', () => { idempotencyKey = crypto.randomUUID(); renderTimes(); });
  time.addEventListener('change', () => { idempotencyKey = crypto.randomUUID(); });
  refresh.addEventListener('click', loadSlots);
  form.addEventListener('submit', async event => {
    event.preventDefault(); event.stopPropagation(); if (busy || !form.reportValidity() || !time.value) return;
    try { validateEducationSlot(time.value); } catch (error) { status.textContent = error.message; void loadSlots(); return; }
    busy = true; submit.disabled = true; refresh.disabled = true; status.textContent = 'Confirming your walkthrough…';
    try {
      const result = await bookingRequest(baseUrl, `/api/education-calls/purchases/${encodeURIComponent(purchase.id)}/schedule`, { body: { token, startAt: time.value, discussionTopics: topics.value.trim(), idempotencyKey } });
      onScheduled(result.purchase || { ...purchase, booking: result.booking, status: 'scheduled', discussionTopics: topics.value.trim() });
    } catch (error) {
      if (error.status === 409 && error.details?.code === 'calendar_conflict') {
        busy = false; await loadSlots(); status.textContent = 'That time has just been booked. Choose another available time; your payment is saved.'; idempotencyKey = crypto.randomUUID();
      } else status.textContent = error.message;
    } finally { busy = false; refresh.disabled = false; submit.disabled = !time.value; }
  });
  void loadSlots(); return form;
}
