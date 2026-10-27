import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startPreviewServer } from './lib/preview-server.mjs';
import { buildPublishedCapabilityToken, encryptPublishedSessionV4 } from '../js/crypto_session.js';

// Exercise the real encrypted report viewer with the same capability and PIN
// envelopes as the Worker; provider endpoints remain local browser fixtures.
const snapshot = JSON.stringify({
  kind: 'consumer-analysis-snapshot', clientName: 'Report Customer',
  session: { id: 'cs_private_fixture', currentProfileRevision: 3, confirmedProfileRevision: 3 },
  profile: { revision: 3, missingInformation: [] },
  analysis: { id: 'analysis_private_fixture', profileRevision: 3, status: 'complete',
    results: [{ moduleId: 'pension_projection', status: 'complete',
      outputs: { columns: ['Output', 'Value'], rows: [['Projected pot at target start (current)', '€422,748']] } }] }
});
const encrypted = await encryptPublishedSessionV4({ clientSessionJson: snapshot, advisorSessionJson: snapshot });
const capabilities = {
  client: await buildPublishedCapabilityToken(encrypted.clientSecretB64u, 'client'),
  advisor: await buildPublishedCapabilityToken(encrypted.advisorSecretB64u, 'advisor')
};
const publishedId = 'report_snapshot_fixture';
const server = await startPreviewServer(resolve(process.env.PLANEIR_REPORT_PREVIEW_ROOT || '.'));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  for (const width of [390, 1440]) {
    let clientBundle = structuredClone(encrypted.requestBody.clientBundle);
    let pinSetups = 0;
    const requests = [];
    async function prepare({ staff = false } = {}) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      if (staff) await context.addCookies([{ name: 'planeir_advisor_session', value: 'fixture-staff', domain: '127.0.0.1', path: '/' }]);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      if (process.env.PLANEIR_REPORT_PREVIEW_ROOT) {
        // The production build removes development API origins from its CSP.
        // This local fixture intercepts that API at 127.0.0.1:8787; allow only
        // that fixture origin while exercising the otherwise unchanged build.
        await context.route('**/app/education-call-report.html*', async route => {
          const response = await route.fetch();
          const body = (await response.text()).replace("connect-src 'self'", "connect-src 'self' http://127.0.0.1:8787");
          await route.fulfill({ response, body });
        });
      }
      await context.route('**/api/published-sessions/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        requests.push({ path, headers: request.headers() });
        const role = path.endsWith('/advisor') ? 'advisor' : 'client';
        let status = 200, payload;
        if (request.headers()['x-published-capability'] !== capabilities[role]) {
          status = 404; payload = { error: 'Not found.' };
        } else if (role === 'advisor' && !request.headers().cookie?.includes('planeir_advisor_session=fixture-staff')) {
          status = 401; payload = { error: 'Advisor login required.' };
        } else if (path.endsWith('/client-pin/setup')) {
          const body = request.postDataJSON();
          assert.equal(body.expectedRevision, 1);
          assert.equal(JSON.stringify(body).includes('135790'), false, 'PIN is never sent to the Worker');
          assert.equal(body.clientBundle.clientAccess.pinState, 'active');
          assert.equal(body.clientBundle.clientAccess.revision, 2);
          clientBundle = body.clientBundle; pinSetups += 1;
          payload = { ok: true, clientAccessRevision: 2 };
        } else payload = role === 'advisor' ? encrypted.requestBody.advisorBundle : clientBundle;
        await route.fulfill({ status, contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': server.origin, 'Access-Control-Allow-Credentials': 'true' },
          body: JSON.stringify(payload) });
      });
      return { context, page, errors };
    }
    const base = `${server.origin}/app/education-call-report.html?pub=${publishedId}`;
    const client = await prepare();
    await client.page.goto(`${base}#ck=${encrypted.clientSecretB64u}`);
    await client.page.getByRole('heading', { name: 'Protect your report' }).waitFor();
    assert.equal(await client.page.evaluate(() => location.hash), '', 'Fragment key is cleared before network access');
    await client.page.getByLabel('Create a 6-digit PIN').fill('135790');
    await client.page.getByLabel('Confirm your 6-digit PIN').fill('135791');
    await client.page.getByRole('button', { name: 'Save PIN and open report' }).click();
    await client.page.getByText('PINs do not match.').waitFor();
    assert.equal(pinSetups, 0);
    await client.page.getByLabel('Confirm your 6-digit PIN').fill('135790');
    await client.page.getByRole('button', { name: 'Save PIN and open report' }).click();
    await client.page.getByText('€422,748', { exact: true }).waitFor();
    assert.equal(pinSetups, 1);
    assert.equal(await client.page.locator('.education-call-cta, [data-action]').count(), 0);
    assert.equal(await client.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px report overflow`);
    assert.deepEqual(client.errors, []);
    await client.context.close();

    const returning = await prepare();
    await returning.page.goto(`${base}#ck=${encrypted.clientSecretB64u}`);
    await returning.page.getByRole('heading', { name: 'Unlock your report' }).waitFor();
    await returning.page.getByLabel('6-digit PIN', { exact: true }).fill('111111');
    await returning.page.getByRole('button', { name: 'Open report', exact: true }).click();
    await returning.page.getByText('That PIN did not unlock this report. Please try again.').waitFor();
    assert.equal(await returning.page.locator('#educationReportResults').innerText(), '');
    await returning.page.getByLabel('6-digit PIN', { exact: true }).fill('135790');
    await returning.page.getByRole('button', { name: 'Open report', exact: true }).click();
    await returning.page.getByText('€422,748', { exact: true }).waitFor();
    assert.equal(pinSetups, 1, 'Returning access preserves the established PIN');
    assert.deepEqual(returning.errors, []);
    await returning.context.close();

    const unauthorised = await prepare();
    await unauthorised.page.goto(`${base}#ak=${encrypted.advisorSecretB64u}`);
    await unauthorised.page.getByRole('link', { name: 'Sign in to workspace' }).waitFor();
    assert.equal(await unauthorised.page.locator('#educationReportResults').innerText(), '');
    await unauthorised.page.goto(`${base}&attempt=invalid#ck=${'x'.repeat(43)}`);
    await unauthorised.page.getByText('This report is no longer available.', { exact: false }).waitFor();
    assert.equal(await unauthorised.page.locator('#educationReportResults').innerText(), '');
    assert.deepEqual(unauthorised.errors, []);
    await unauthorised.context.close();

    const advisor = await prepare({ staff: true });
    await advisor.page.goto(`${base}#ak=${encrypted.advisorSecretB64u}`);
    await advisor.page.getByText('€422,748', { exact: true }).waitFor();
    await advisor.page.goto(`${base}&view=client#ak=${encrypted.advisorSecretB64u}`);
    await advisor.page.getByText('€422,748', { exact: true }).waitFor();
    assert.equal(await advisor.page.locator('.beta-badge').textContent(), 'Your analysis · Read only');
    assert.equal(await advisor.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(advisor.errors, []);
    await advisor.context.close();
    assert.ok(requests.some(request => request.path.endsWith('/client')));
    assert.ok(requests.some(request => request.path.endsWith('/advisor')));
  }
  console.log('Walkthrough report UI: exact native customer/staff views, encrypted PIN setup/return, access denial, private keys and desktop/mobile rendering passed.');
} finally { await browser?.close(); await server.close(); }
