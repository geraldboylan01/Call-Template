import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startPreviewServer } from './lib/preview-server.mjs';

const server = await startPreviewServer(resolve('.'));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const fixedNow = new Date('2027-02-28T12:00:00Z');
const slots = [
  { startAt: '2027-02-28T15:00:00.000Z', endAt: '2027-02-28T15:40:00.000Z' },
  { startAt: '2027-03-01T19:30:00.000Z', endAt: '2027-03-01T20:10:00.000Z' },
  { startAt: '2027-03-01T20:15:00.000Z', endAt: '2027-03-01T20:55:00.000Z' }
];
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage(), errors = [], posts = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: fixedNow });
    let purchase = { id: 'purchase-fixture', accessToken: 'private-token', status: 'pending', paymentStatus: 'pending', contact: { fullName: 'Jane Fixture', email: 'jane@example.com' }, amountCents: 9999, currency: 'EUR', booking: null };
    let existing = false, failCheckout = true, scheduleAttempts = 0, profileLoads = 0;
    await context.route('**/api/education-calls/**', async route => {
      const url = new URL(route.request().url()), method = route.request().method(), body = method === 'POST' ? JSON.parse(route.request().postData()) : null;
      if (body) posts.push({ path: url.pathname, body });
      const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      if (url.pathname.endsWith('/availability')) return send({ slots: scheduleAttempts ? slots.slice(2) : slots });
      if (url.pathname.endsWith('/profile')) { profileLoads += 1; return send({ profile: purchase.contact }); }
      if (url.pathname.endsWith('/purchases') && method === 'GET') {
        assert.equal(route.request().headers()['x-consumer-session'], 'fixture-auth'); return send({ purchase: existing ? purchase : null });
      }
      if (url.pathname.endsWith('/purchases') && method === 'POST') { existing = true; return send({ purchase }); }
      if (url.pathname.endsWith('/checkout')) return send(failCheckout ? { error: 'Please try again.' } : { checkoutUrl: 'https://checkout.stripe.com/c/pay/synthetic' }, failCheckout ? 503 : 200);
      if (url.pathname.endsWith('/schedule')) {
        scheduleAttempts += 1;
        assert.equal(body.token, 'private-token'); assert.equal(body.discussionTopics, 'How does changing my retirement age affect my projections?');
        if (scheduleAttempts === 1) return send({ error: 'Slot taken', code: 'calendar_conflict' }, 409);
        purchase = { ...purchase, status: 'scheduled', discussionTopics: body.discussionTopics, bookingId: 'booking-fixture', reportClientLink: 'https://planeir.ie/app/session.html?pub=client-specific', booking: { id: 'booking-fixture', accessToken: 'booking-token', status: 'confirmed', paymentStatus: 'verified', startAt: body.startAt, endAt: '2027-03-01T20:55:00.000Z', zoomJoinUrl: 'https://zoom.us/j/fixture' } };
        return send({ purchase });
      }
      return send({ purchase });
    });
    await context.route('https://checkout.stripe.com/**', route => {
      assert.equal(route.request().url().includes('private-token'), false);
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Synthetic hosted checkout</p>' });
    });
    await page.goto(`${server.origin}/app/education-call.html`);
    async function mountWidget() {
      await page.evaluate(async () => {
        const { createEducationBookingWidget } = await import('/js/workspace/education_booking_ui.js');
        document.querySelector('main').replaceChildren(createEducationBookingWidget({ baseUrl: location.origin, sourceType: 'consumer', sourceId: 'source-fixture', analysisRunId: 'analysis-current', getHeaders: async () => ({ 'X-Consumer-Session': 'fixture-auth' }) }));
      });
    }
    await mountWidget();
    await page.getByText('Book a Walkthrough with Gerry', { exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('button[type=submit]').disabled);
    assert.equal(profileLoads, 1);
    assert.equal(await page.locator('input:not([type=checkbox])').count(), 0, 'Saved identity is never requested again');
    assert.equal(await page.locator('select').count(), 0, 'No scheduling before payment');
    for (const name of ['reportAccessConsent', 'termsAccepted', 'earlyPerformanceConsent']) await page.check(`input[name=${name}]`);
    await page.getByRole('button', { name: 'Continue to secure payment · €99.99' }).click();
    await page.getByText('Please try again.', { exact: true }).waitFor();
    const request = posts.find(item => item.path.endsWith('/purchases')).body;
    assert.equal(request.contact, undefined); assert.equal(request.startAt, undefined); assert.equal(request.analysisRunId, 'analysis-current'); assert.equal(request.reportAccessConsent, true);
    failCheckout = false;
    await page.getByRole('button', { name: 'Continue to secure payment · €99.99' }).click();
    await page.waitForURL('https://checkout.stripe.com/c/pay/synthetic');
    await page.goto(`${server.origin}/app/walkthrough-payment.html?result=success`);
    await page.getByText('Confirming your payment…', { exact: true }).waitFor();
    assert.equal(await page.locator('select').count(), 0, 'Return URL is not payment proof');
    purchase = { ...purchase, status: 'paid', paymentStatus: 'paid' };
    await page.getByRole('button', { name: 'Refresh payment and booking status' }).click();
    await page.getByRole('button', { name: 'Confirm my walkthrough' }).waitFor();
    await page.waitForFunction(() => document.querySelector('select[name=startAt]')?.options.length === 2);
    assert.equal(await page.locator('select[name=bookingDate] option').count(), 1, 'Slots within 24 hours are hidden even if incorrectly returned');
    assert.equal(await page.locator('textarea').getAttribute('maxlength'), '1000');
    await page.locator('textarea').fill('How does changing my retirement age affect my projections?');
    await page.getByRole('button', { name: 'Confirm my walkthrough' }).click();
    await page.getByText('That time has just been booked.', { exact: false }).waitFor();
    assert.equal(await page.locator('textarea').inputValue(), 'How does changing my retirement age affect my projections?', 'Conflict preserves topics');
    await page.getByRole('button', { name: 'Confirm my walkthrough' }).click();
    await page.getByText('You’re booked in with Gerry!', { exact: true }).waitFor();
    await page.getByRole('link', { name: 'Join Zoom walkthrough' }).waitFor();
    assert.match(await page.getByRole('link', { name: 'View your Planéir analysis' }).getAttribute('href'), /client-specific/);
    assert.equal(await page.getByText('How does changing my retirement age affect my projections?', { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px scheduler overflow`);
    // Account/report recovery finds the already-paid purchase, even without browser storage.
    await page.evaluate(() => sessionStorage.clear()); await page.goto(`${server.origin}/app/education-call.html`); await mountWidget();
    await page.getByText('Book a Walkthrough with Gerry', { exact: true }).click();
    await page.getByRole('link', { name: 'Manage my walkthrough' }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Continue to secure payment/ }).count(), 0);
    const recovery = await page.getByRole('link', { name: 'Manage my walkthrough' }).getAttribute('href');
    assert.match(recovery, /walkthrough-payment.html#purchase=purchase-fixture&token=private-token/);
    await page.goto(recovery); await page.getByText('You’re booked in with Gerry!', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => location.hash), '', 'Private capability cleared after capture');
    assert.deepEqual(errors, []); await context.close();
  }
  // Profiles missing from legacy consumer sessions are saved once, separately from purchase.
  const context = await browser.newContext(), page = await context.newPage(); let savedProfile;
  await context.route('**/api/education-calls/**', async route => {
    const method = route.request().method();
    if (method === 'PATCH') savedProfile = JSON.parse(route.request().postData()).contact;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(route.request().url().includes('/profile') ? { profile: savedProfile || null } : { purchase: { id: 'older-completed-purchase', status: 'completed', paymentStatus: 'paid' } }) });
  });
  await page.goto(`${server.origin}/app/education-call.html`);
  await page.evaluate(async () => { const { createEducationBookingWidget } = await import('/js/workspace/education_booking_ui.js'); document.querySelector('main').replaceChildren(createEducationBookingWidget({ baseUrl: location.origin, sourceType: 'consumer', sourceId: 'profile-source' })); });
  await page.getByText('Book a Walkthrough with Gerry', { exact: true }).click();
  await page.getByText('Save your profile details before checkout', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Continue to secure payment · €99.99' }).isEnabled(), false);
  await page.getByLabel('Profile full name').fill('Jane Fixture'); await page.getByLabel('Profile email').fill('jane@example.com'); await page.getByRole('button', { name: 'Save profile details' }).click();
  await page.waitForFunction(() => !document.querySelector('button[type=submit]').disabled);
  assert.deepEqual(savedProfile, { fullName: 'Jane Fixture', email: 'jane@example.com' }); assert.equal(await page.locator('input:not([type=checkbox])').count(), 0);
  await context.close();
  const adminContext = await browser.newContext({ viewport: { width: 390, height: 1000 } }), adminPage = await adminContext.newPage();
  await adminPage.goto(`${server.origin}/app/education-call.html`);
  await adminPage.evaluate(async () => {
    const { createEducationBookingAdmin } = await import('/js/workspace/education_booking_admin.js');
    const host = document.createElement('section'); document.querySelector('main').replaceChildren(host);
    window.walkthroughAdminActions = [];
    let completed = false;
    const purchase = { id: 'purchase-admin', status: 'scheduled', paymentStatus: 'paid', contact: { fullName: 'Jane Fixture', email: 'jane@example.com' }, discussionTopics: 'Explore savings assumptions', paymentEmailStatus: 'sent', bookingEmailStatus: 'sent', reportAdvisorLink: 'https://planeir.ie/app/education-call-report.html?pub=exact-report&view=advisor', reportClientLink: 'https://planeir.ie/app/education-call-report.html?pub=exact-report&view=client', bookingId: 'booking-admin', booking: { id: 'booking-admin', status: 'confirmed', startAt: '2027-03-01T19:30:00Z', endAt: '2027-03-01T20:10:00Z', zoomJoinUrl: 'https://zoom.us/j/admin-fixture' } };
    const admin = createEducationBookingAdmin(host, { request: async (path, options = {}) => {
      window.walkthroughAdminActions.push({ path, ...options });
      if (path.endsWith('/completed')) completed = true;
      return { purchases: [{ ...purchase, status: completed ? 'completed' : 'scheduled' }], bookings: [purchase.booking], blocks: [] };
    } }); await admin.refresh();
  });
  await adminPage.getByText('Explore savings assumptions', { exact: true }).waitFor();
  assert.equal(await adminPage.locator('select option').count(), 1, 'Purchase and underlying booking appear only once');
  assert.match(await adminPage.getByRole('link', { name: 'View advisor analysis', exact: true }).getAttribute('href'), /exact-report.*advisor/);
  assert.match(await adminPage.getByRole('link', { name: 'View client analysis', exact: true }).getAttribute('href'), /exact-report.*client/);
  assert.equal(await adminPage.getByRole('button', { name: /Verify completed/ }).count(), 0, 'Stripe never asks for manual verification');
  await adminPage.getByRole('button', { name: 'Mark walkthrough completed' }).click();
  await adminPage.waitForFunction(() => document.body.textContent.includes('completed · payment: verified'));
  assert.ok(await adminPage.evaluate(() => window.walkthroughAdminActions.some(item => item.path === '/api/advisor/education-calls/purchases/purchase-admin/completed' && item.method === 'POST')));
  assert.equal(await adminPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await adminContext.close();
  console.log('Stripe UI: desktop/mobile saved profile, hosted checkout retry, verified paid scheduler, 24h notice, topics, conflict recovery, paid abandonment and private capability recovery passed.');
} finally { await browser.close(); await server.close(); }
