import { bookingElement as el, bookingRequest, createBookingSummary, createPaidWalkthroughScheduler, rememberWalkthroughPurchase, validateStripeCheckoutUrl } from './workspace/education_booking_ui.js';

const root = document.getElementById('stripePaymentReturn');
const params = new URLSearchParams(location.hash.slice(1));
const returnResult = new URLSearchParams(location.search).get('result');
const baseUrl = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8787'
  : (document.querySelector('meta[name="call-canvas-worker-base-url"]')?.content || '').replace(/\/+$/, '');
let purchaseId = params.get('purchase'), token = params.get('token'), current, timer, attempts = 0;
try {
  if (!purchaseId || !token) {
    const saved = JSON.parse(sessionStorage.getItem('planeir.stripe-return') || 'null');
    if (typeof saved?.purchase === 'string' && typeof saved?.token === 'string') { purchaseId = saved.purchase; token = saved.token; }
    else if (typeof saved?.booking === 'string' && typeof saved?.token === 'string') {
      const link = el('a', 'education-booking-button', 'Check my booking status');
      const target = new URL('./education-call.html', location.href); target.hash = new URLSearchParams(saved).toString(); link.href = target.href;
      root.replaceChildren(el('h1', '', 'Check your walkthrough booking'), el('p', '', 'Your previous booking is saved. Check its payment and appointment status below.'), link);
    }
  }
} catch { /* Private email and authenticated report recovery remain available. */ }
// Keep capability credentials out of the visible address bar and any later navigation.
if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);

function message(title, copy) { root.replaceChildren(el('h1', '', title), el('p', '', copy)); }
function refreshControl() {
  const refresh = el('button', 'education-booking-link', 'Refresh payment and booking status'); refresh.type = 'button'; refresh.addEventListener('click', () => { attempts = 0; void load(); }); root.append(refresh);
}
function render() {
  clearTimeout(timer);
  const firstName = current.contact?.firstName || current.contact?.fullName?.split(' ')[0] || '';
  if (current.paymentStatus === 'paid' && ['paid', 'scheduled', 'completed'].includes(current.status)) {
    if (current.booking) {
      message(current.status === 'completed' ? 'Your walkthrough with Gerry is complete' : 'You’re booked in with Gerry!', 'Your payment is confirmed. Your Zoom details and analysis link will also arrive by email.');
      root.append(createBookingSummary({ ...current.booking, accessToken: current.booking.accessToken || '' }));
      if (current.discussionTopics) { const topics = el('section'); topics.append(el('h2', '', 'Your discussion topics'), el('p', 'education-booking-topics', current.discussionTopics)); root.append(topics); }
      if (current.clientAnalysisLink || current.reportClientLink) {
        const analysis = el('a', 'education-booking-link', 'View your Planéir analysis'); analysis.href = current.clientAnalysisLink || current.reportClientLink; root.append(analysis);
      }
      if (!current.booking.accessToken && current.bookingId) root.append(el('p', '', 'Use the private booking link in your confirmation email to review time proposals.'));
      refreshControl();
    } else {
      message('Thank you for choosing Planéir!', `${firstName ? `${firstName}, your` : 'Your'} payment has been confirmed. I’m looking forward to helping you explore your analysis and get the most out of Planéir.`);
      root.append(el('p', '', 'As the person who designed and built Planéir, I’ll walk you through your results, explain how the tools work and explore your questions.'));
      root.append(createPaidWalkthroughScheduler({ baseUrl, purchase: current, token, onScheduled: purchase => { current = purchase; render(); } }));
    }
  } else if (['cancelled', 'review', 'expired'].includes(current.status) || ['review', 'refunded'].includes(current.paymentStatus)) {
    const refunded = current.paymentStatus === 'refunded';
    message(refunded ? 'Your walkthrough payment was refunded' : current.status === 'cancelled' ? 'Your walkthrough was cancelled' : 'Your payment needs a check', refunded ? 'This purchase is no longer available for scheduling.' : 'Please contact hello@planeir.ie with your reference before paying again. Your payment record is saved.'); refreshControl();
  } else {
    const processing = current.paymentStatus === 'processing' || (returnResult === 'success' && current.paymentStatus === 'pending');
    message(processing ? 'Confirming your payment…' : current.paymentStatus === 'failed' ? 'Your payment was not completed' : returnResult === 'cancelled' ? 'Your purchase is saved' : 'Your walkthrough payment', processing ? 'Stripe is confirming your payment securely. Please do not pay again while this is processing. Once verified, you can choose your appointment here.' : 'Choose a time after your payment is confirmed. Your existing purchase is saved, so you can continue when you’re ready.');
    if (!processing && ['pending', 'failed'].includes(current.paymentStatus)) {
      const pay = el('button', 'education-booking-button', `Continue to secure payment · ${new Intl.NumberFormat('en-IE', { style: 'currency', currency: current.currency || 'EUR' }).format((current.amountCents ?? 9999) / 100)}`); pay.type = 'button';
      pay.addEventListener('click', async () => {
        pay.disabled = true;
        try { rememberWalkthroughPurchase({ ...current, accessToken: token }); const result = await bookingRequest(baseUrl, `/api/education-calls/purchases/${encodeURIComponent(purchaseId)}/checkout`, { body: { token } }); location.assign(validateStripeCheckoutUrl(result.checkoutUrl)); }
        catch (error) { root.append(el('p', '', error.message)); pay.disabled = false; }
      }); root.append(pay);
    }
    refreshControl();
    if (processing && attempts < 30) timer = setTimeout(() => { attempts += 1; void load(); }, 2000);
    if (processing && attempts >= 30) root.append(el('p', '', 'Confirmation is taking a little longer. Your purchase is saved; return from your report or payment email later to continue.'));
  }
  root.append(el('small', 'education-booking-reference', `Walkthrough reference: ${current.id}`));
}
async function load() {
  clearTimeout(timer);
  if (!purchaseId || !token) {
    if (!root.querySelector('a.education-booking-button')) message('Continue your walkthrough', 'Open the private link from your payment email, or return to the walkthrough panel beside your signed-in Planéir analysis. Your paid purchase will be waiting there.');
    return;
  }
  try {
    const result = await bookingRequest(baseUrl, `/api/education-calls/purchases/${encodeURIComponent(purchaseId)}?token=${encodeURIComponent(token)}`); current = result.purchase;
    rememberWalkthroughPurchase({ ...current, accessToken: token }); render();
  } catch (error) { message('Could not open your walkthrough', error.message); refreshControl(); }
}
window.addEventListener('pagehide', () => clearTimeout(timer));
void load();
