import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startPreviewServer } from './lib/preview-server.mjs';
import { bookingDay, bookingHoldDeadline } from '../js/workspace/education_booking_ui.js';
import { dublinDateTimeToIso } from '../js/workspace/education_booking_admin.js';
import { EDUCATION_CALL, EDUCATION_CALL_V1, educationCallOffer } from '../js/workspace/education_call.js';

assert.equal(EDUCATION_CALL.priceMinor, 9999);
assert.equal(educationCallOffer({ source: EDUCATION_CALL.leadSource }).priceMinor, 10000, 'Historical unversioned calls retain their offer');
assert.equal(educationCallOffer({ callOfferVersion: EDUCATION_CALL.version }).priceMinor, 9999);
assert.equal(EDUCATION_CALL_V1.priceMinor, 10000);
assert.equal(bookingDay('2026-06-01T23:30:00Z'), '2026-06-02');
assert.equal(dublinDateTimeToIso('2026-06-01T19:30'), '2026-06-01T18:30:00.000Z');
assert.equal(dublinDateTimeToIso('2026-12-01T19:30'), '2026-12-01T19:30:00.000Z');
assert.throws(() => dublinDateTimeToIso('2026-03-29T01:30'), /does not exist/);
assert.equal(bookingHoldDeadline('2026-10-18T12:00:00Z', Date.parse('2026-10-17T15:00:00Z')), '2026-10-18T12:00:00.000Z');

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const server = await startPreviewServer(root);
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const adminContext = await browser.newContext({ viewport: { width: 1000, height: 1000 } });
  const adminPage = await adminContext.newPage();
  await adminPage.clock.install({ time: new Date('2030-04-18T12:00:00Z') });
  const adminErrors = [];
  adminPage.on('pageerror', (error) => adminErrors.push(error.message));
  await adminPage.goto(`${server.origin}/app/education-call.html`);
  await adminPage.evaluate(async () => {
    const { createEducationBookingAdmin } = await import('/js/workspace/education_booking_admin.js');
    window.adminRequests = [];
    let fixture = { id: 'eb_admin', revision: 1, status: 'awaiting_payment', paymentStatus: 'pending', amountCents: 9999, currency: 'EUR', startAt: '2030-04-20T11:00:00Z', endAt: '2030-04-20T11:40:00Z', holdExpiresAt: '2030-04-19T11:00:00Z', contact: { fullName: 'Admin Fixture', email: 'fixture@example.com' } };
    const host = document.createElement('section'); document.querySelector('main').replaceChildren(host);
    const admin = createEducationBookingAdmin(host, { request: async (path, options = {}) => {
      window.adminRequests.push({ path, ...options });
      if (options.method === 'POST' && path.endsWith('/verify-payment')) fixture = { ...fixture, status: 'confirmed', paymentStatus: 'verified', revision: 2 };
      if (options.method === 'POST' && path.endsWith('/cancel')) fixture = { ...fixture, status: 'cancelled', paymentStatus: 'refund_required', revision: 3 };
      if (path === '/api/advisor/education-calls/bookings') return { bookings: [fixture], blocks: [] };
      return { booking: fixture };
    } });
    await admin.refresh();
  });
  await adminPage.getByLabel('Request-specific Revolut Pro HTTPS payment link').fill('https://revolut.me/fixture');
  await adminPage.getByRole('button', { name: 'Save and email payment link' }).click();
  await adminPage.getByLabel('Completed payment reference from Revolut').fill('paid-reference');
  await adminPage.getByRole('checkbox').check();
  await adminPage.getByRole('button', { name: 'Verify completed €99.99 EUR payment' }).click();
  await adminPage.waitForFunction(() => document.body.textContent.includes('payment: verified'));
  const payment = await adminPage.evaluate(() => window.adminRequests.find((request) => request.path.endsWith('/verify-payment')));
  assert.deepEqual(payment.body, { paymentReference: 'paid-reference', amountCents: 9999, currency: 'EUR', completed: true });
  await adminPage.getByLabel('Propose another start · Europe/Dublin').fill('2030-04-21T12:00');
  await adminPage.getByRole('button', { name: 'Propose replacement time' }).click();
  const proposal = await adminPage.evaluate(() => window.adminRequests.find((request) => request.path.endsWith('/propose')));
  assert.equal(proposal.body.startAt, '2030-04-21T11:00:00.000Z');
  assert.equal(proposal.body.revision, 2);
  await adminPage.locator('summary', { hasText: 'Block unavailable dates' }).click();
  await adminPage.getByLabel('Unavailable from · Europe/Dublin').fill('2030-04-22T19:30');
  await adminPage.getByLabel('Unavailable until · Europe/Dublin').fill('2030-04-22T21:00');
  await adminPage.getByRole('button', { name: 'Add unavailable period' }).click();
  assert.ok(await adminPage.evaluate(() => window.adminRequests.some((request) => request.path.endsWith('/blocks') && request.body.startAt === '2030-04-22T18:30:00.000Z')));
  adminPage.once('dialog', (dialog) => dialog.accept());
  await adminPage.getByRole('button', { name: 'Cancel reservation' }).click();
  await adminPage.getByLabel('Completed Revolut refund reference').fill('refund-reference');
  await adminPage.getByRole('button', { name: 'Record completed refund' }).click();
  assert.ok(await adminPage.evaluate(() => window.adminRequests.some((request) => request.path.endsWith('/refund') && request.body.refundReference === 'refund-reference')));
  assert.deepEqual(adminErrors, []);
  await adminContext.close();

  const statusContext = await browser.newContext();
  const statusPage = await statusContext.newPage();
  await statusPage.clock.install({ time: new Date('2030-04-18T12:00:00Z') });
  const responses = [];
  let accepted = false;
  await statusContext.route('**/api/education-calls/bookings/**', async (route) => {
    if (route.request().method() === 'POST') { responses.push(JSON.parse(route.request().postData())); accepted = true; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ booking: { id: 'eb_status', revision: accepted ? 3 : 2, status: 'confirmed', startAt: accepted ? '2030-04-21T11:00:00Z' : '2030-04-20T11:00:00Z', endAt: accepted ? '2030-04-21T11:40:00Z' : '2030-04-20T11:40:00Z', proposal: accepted ? null : { startAt: '2030-04-21T11:00:00Z', endAt: '2030-04-21T11:40:00Z', revision: 2, expiresAt: '2030-04-19T11:00:00Z' } } }) });
  });
  await statusPage.goto(`${server.origin}/app/education-call.html#booking=eb_status&token=fixture-status-token`);
  await statusPage.getByRole('button', { name: 'Accept the new time' }).click();
  await statusPage.waitForFunction(() => !document.body.textContent.includes('Gerry has suggested another time'));
  assert.deepEqual(responses, [{ token: 'fixture-status-token', revision: 2, decision: 'accept' }]);
  await statusContext.close();
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${server.origin}/app/education-call.html`);
    await page.evaluate(async () => {
      const { createQualificationAdmin } = await import('/js/workspace/qualification_admin.js');
      const host = document.createElement('section'); document.querySelector('main').replaceChildren(host);
      window.rankingRequests = 0; window.failRanking = false;
      createQualificationAdmin(host, { request: async (path) => {
        if (path !== '/api/advisor/qualification/ranking') throw new Error(`Unexpected path ${path}`);
        window.rankingRequests += 1;
        if (window.failRanking) throw new Error('Fixture service unavailable');
        return { evaluatedAt: '2026-10-18T12:00:00Z', rulesVersion: 'fixture', billingEnabled: false,
          counts: { assessed: 3, eligible: window.rankingRequests === 1 ? 2 : 0, needsReview: window.rankingRequests === 1 ? 1 : 3 },
          ranked: window.rankingRequests === 1 ? [
            { leadId: 2, fullName: 'Priority Candidate', requestedAt: '2026-10-16T12:00:00Z', pfumCents: 40000000, readinessScore: 90, classification: 'priority', quote: { feeCents: 45500 }, rank: 1 },
            { leadId: 1, fullName: 'Standard Candidate', requestedAt: '2026-10-15T12:00:00Z', pfumCents: 15000000, readinessScore: 75, classification: 'standard', quote: { feeCents: 23500 }, rank: 2 }
          ] : [] };
      } });
    });
    await page.getByText('Internal introduction ranking', { exact: true }).click();
    const table = page.getByRole('table', { name: 'Eligible adviser introductions' });
    await table.waitFor();
    const rows = table.locator('tbody tr');
    assert.equal(await rows.count(), 2);
    assert.match(await rows.nth(0).innerText(), /1\. Priority Candidate.*€400,000\.00.*90\/100.*Priority.*€455\.00/s);
    assert.match(await rows.nth(1).innerText(), /2\. Standard Candidate.*€150,000\.00.*75\/100.*Standard.*€235\.00/s);
    assert.match(await page.locator('[role=status]').first().innerText(), /3 assessed · 2 eligible · 1 need review/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px ranking overflow`);
    await page.getByRole('button', { name: 'Refresh introduction ranking' }).click();
    await page.waitForFunction(() => document.body.textContent.includes('No eligible introductions are currently in the queue.'));
    assert.match(await page.locator('[role=status]').first().innerText(), /3 assessed · 0 eligible · 3 need review/);
    await page.evaluate(() => { window.failRanking = true; });
    await page.getByRole('button', { name: 'Refresh introduction ranking' }).click();
    await page.waitForFunction(() => document.body.textContent.includes('Could not refresh introduction ranking: Fixture service unavailable'));
    assert.equal(await page.getByRole('button', { name: 'Refresh introduction ranking' }).isEnabled(), true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Education booking UI: Dublin clock changes, historical offers, admin payment/proposal/blocks/refund, customer responses and internal ranking/refresh/error states passed.');
} finally { await browser?.close(); await server.close(); }
