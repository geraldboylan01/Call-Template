import { bookingElement as el, bookingRequest, createBookingSummary, formatBookingTime } from './workspace/education_booking_ui.js';
import { validateEducationSlot } from './workspace/education_booking.js';

const root = document.getElementById('educationCallStatus');
const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
const bookingId = params.get('booking') || '';
const token = params.get('token') || '';
if (location.hash) history.replaceState(null, '', location.pathname);
const baseUrl = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? 'http://127.0.0.1:8787'
  : (document.querySelector('meta[name="call-canvas-worker-base-url"]')?.content || '').replace(/\/+$/, '');
let booking;

function render() {
  root.replaceChildren(el('h1', '', 'Your walkthrough booking'), createBookingSummary({ ...booking, accessToken: '' }));
  if (booking.stripeCheckoutAvailable) {
    const pay = el('button', 'education-booking-button', 'Pay €99.99 securely with Stripe');
    pay.type = 'button';
    pay.addEventListener('click', async () => {
      pay.disabled = true;
      try {
        // This recovery reference stays in this browser, never in Stripe URLs.
        sessionStorage.setItem('planeir.stripe-return', JSON.stringify({ booking: bookingId, token }));
        const result = await bookingRequest(baseUrl, `/api/education-calls/bookings/${encodeURIComponent(bookingId)}/checkout`, { body: { token } });
        const target = new URL(result.checkoutUrl);
        if (target.protocol !== 'https:' || target.hostname !== 'checkout.stripe.com') throw new Error('The payment link is unavailable.');
        location.assign(target.href);
      } catch (error) { root.append(el('p', '', error.message)); pay.disabled = false; }
    });
    root.append(pay);
  }
  if (booking.stripePaymentState === 'processing') root.append(el('p', '', 'Your payment is processing. Refresh this page to check confirmation. Please do not pay again.'));
  if (booking.stripePaymentState === 'review') root.append(el('p', '', 'Your payment needs a check. Contact hello@planeir.ie before paying again; your booking status is shown above.'));
  if (booking.proposal) {
    const proposal = el('section');
    proposal.append(el('h2', '', 'Gerry has suggested another time'), el('p', '', formatBookingTime(booking.proposal.startAt)), el('p', '', `Please respond by ${formatBookingTime(booking.proposal.expiresAt)}. Your original appointment remains reserved while you review this proposal.`));
    if (new Date(booking.proposal.expiresAt).getTime() > Date.now()) {
      for (const [decision, label] of [['accept', 'Accept the new time'], ['decline', 'Keep my original time']]) {
        const button = el('button', 'education-booking-button', label);
        button.type = 'button';
        button.addEventListener('click', async () => {
          proposal.querySelectorAll('button').forEach((node) => { node.disabled = true; });
          try {
            if (decision === 'accept') validateEducationSlot(booking.proposal.startAt);
            const response = await bookingRequest(baseUrl, `/api/education-calls/bookings/${encodeURIComponent(bookingId)}/response`, { body: { token, revision: booking.proposal.revision ?? booking.revision, decision } });
            booking = response.booking; render();
          } catch (error) {
            proposal.append(el('p', '', error.status === 409 ? 'This proposal changed or expired. Refresh the booking before responding.' : error.message));
            proposal.querySelectorAll('button').forEach((node) => { node.disabled = false; });
          }
        });
        proposal.append(button);
      }
    } else proposal.append(el('p', '', 'This proposal has expired. The original booking status is shown above.'));
    root.append(proposal);
  }
  const refresh = el('button', 'education-booking-link', 'Refresh booking status');
  refresh.type = 'button'; refresh.addEventListener('click', load);
  root.append(refresh, el('p', '', 'For cancellation, rebooking or payment help, email hello@planeir.ie and include your booking reference.'), el('small', '', `Booking reference: ${booking.id}`));
}

async function load() {
  if (!bookingId || !token) {
    root.replaceChildren(el('h1', '', 'Booking link unavailable'), el('p', '', 'Open the full private link from your booking email.'));
    return;
  }
  try {
    const payload = await bookingRequest(baseUrl, `/api/education-calls/bookings/${encodeURIComponent(bookingId)}?token=${encodeURIComponent(token)}`);
    booking = payload.booking; render();
  } catch (error) { root.replaceChildren(el('h1', '', 'Could not open your booking'), el('p', '', error.message)); }
}

void load();
