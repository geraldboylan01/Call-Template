import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startPreviewServer } from './lib/preview-server.mjs';
import { createTestRuntime, captureEmail } from './lib/application-test-runtime.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const output = resolve(root, '.worker-dry-run/demo'); await mkdir(output, { recursive: true });
const server = await startPreviewServer(root), mail = captureEmail();
const runtime = createTestRuntime({ DEMO_REQUESTS_ENABLED: 'true', DEMO_DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64url') });
let browser, ip = 0;
const errors = [];
async function context(viewport) {
  const result = await browser.newContext({ viewport }); const clientIp = `198.51.100.${++ip}`;
  await result.route('**/api/**', async route => {
    const req = route.request();
    const response = await runtime.dispatch(new Request(req.url(), { method: req.method(), headers: { ...await req.allHeaders(), 'CF-Connecting-IP': clientIp }, ...(req.postDataBuffer() ? { body: req.postDataBuffer() } : {}) }));
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  result.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  return result;
}
const acknowledge = async page => { for (const id of ['applyAdultConfirmed', 'applyEducationAcknowledged', 'applyPrivacyAcknowledged', 'applyTermsAccepted']) await page.check(`#${id}`); };
const latestLink = email => mail.emails.filter(item => item.to.includes(email) && item.text.includes('#access=')).at(-1).text.match(/https:\/\/planeir\.ie\/demo\/#access=[\w-]+/)[0].replace('https://planeir.ie', server.origin);
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const adminHeaders = await runtime.login();
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const email = `${name}@example.com`, visitor = await context(viewport), page = await visitor.newPage();
    await page.goto(server.origin);
    assert.match(await page.locator('h1').innerText(), /different routes to your financial goals/);
    assert.match(await page.locator('body').innerText(), /Currently available for demos only/i);
    assert.doesNotMatch(await page.locator('main').innerText(), /call with Gerry|book a call|talk through your results/i);
    await page.screenshot({ path: `${output}/homepage-${name}.png`, fullPage: true });
    await page.goto(`${server.origin}/apply/`);
    await page.waitForFunction(() => !document.getElementById('applySubmit').disabled);
    assert.equal(await page.locator('#f-question').getAttribute('required'), null);
    await page.fill('#applyName', `${name} Person`); await page.fill('#applyEmail', email); await acknowledge(page);
    // No goal or financial figure is needed for a public request.
    await page.click('#applySubmit'); await page.waitForFunction(() => document.getElementById('applyStatus').textContent.includes('Your demo request is saved'));
    assert.equal(await page.locator('#applySubmit').innerText(), 'Save changes');
    const id = runtime.sql.prepare('SELECT id FROM demo_requests WHERE access_status=? ORDER BY created_at DESC LIMIT 1').get('pending').id;
    await page.fill('#f-question', 'Compare the routes to my goals'); await page.click('#applySubmit');
    await page.waitForFunction(() => document.getElementById('applyStatus').textContent.includes('Your changes are saved'));
    await page.reload(); await page.waitForFunction(() => document.getElementById('f-question').value === 'Compare the routes to my goals');
    await page.fill('#f-question', 'Unfinished edits stay on this device');
    await page.waitForFunction(() => localStorage.getItem('planeir.workspace.draft.v1').includes('Unfinished edits stay on this device'));
    await page.reload(); await page.waitForFunction(() => document.getElementById('f-question').value === 'Unfinished edits stay on this device');
    await page.screenshot({ path: `${output}/saved-${name}.png`, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    page.once('dialog', dialog => dialog.accept()); await page.click('#applyClear');
    assert.equal(runtime.sql.prepare('SELECT COUNT(*) AS n FROM demo_requests WHERE id=?').get(id).n, 1, 'Clearing the browser must retain server information.');

    const device2 = await context(viewport), restored = await device2.newPage();
    await restored.goto(latestLink(email));
    assert.equal(await restored.evaluate(() => location.hash), '');
    assert.equal(await restored.locator('.apply-layout').isVisible(), false, 'Email scanners cannot open or consume the form by visiting the link.');
    await restored.click('#demoContinue');
    await restored.waitForFunction(() => document.getElementById('f-question').value === 'Compare the routes to my goals');
    await runtime.call(`/api/advisor/demo/requests/${id}/approve`, {}, { headers: adminHeaders });
    await restored.reload(); await restored.waitForFunction(() => document.getElementById('applySubmit').textContent === 'Generate my analysis');
    await restored.click('#applySubmit');
    await restored.waitForFunction(() => document.getElementById('applyStatus').textContent.includes('Analysis generation is not connected yet'));
    await restored.screenshot({ path: `${output}/confirmed-${name}.png`, fullPage: true });
    assert.equal(runtime.sql.prepare('SELECT confirmed_revision,revision FROM demo_requests WHERE id=?').get(id).confirmed_revision, 3);

    // A generic invitation opens a blank independent form and bypasses approval.
    const invite = await runtime.call('/api/advisor/demo/invitations', {}, { headers: adminHeaders });
    const direct = await context(viewport), directPage = await direct.newPage();
    await directPage.goto(invite.json.url.replace('https://planeir.ie', server.origin));
    await directPage.click('#demoContinue'); await directPage.waitForFunction(() => document.getElementById('applySubmit').textContent === 'Generate my analysis');
    assert.equal(await directPage.inputValue('#applyName'), '');
    await directPage.fill('#applyName', 'Invited Person'); await directPage.fill('#applyEmail', `invited-${email}`); await acknowledge(directPage);
    await directPage.fill('#f-question', 'Can I buy a home?'); await directPage.click('#applySubmit');
    await directPage.waitForFunction(() => document.getElementById('applyStatus').textContent.includes('Your information is confirmed and saved'));
    assert.equal(await directPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    directPage.once('dialog', dialog => dialog.accept()); await directPage.click('#demoDelete');
    await directPage.waitForURL('**/apply/?deleted=1');
    await direct.close(); await device2.close(); await visitor.close();
  }
  const adminContext = await context({ width: 390, height: 844 }), adminPage = await adminContext.newPage();
  await adminPage.goto(`${server.origin}/app/demos.html`);
  await adminPage.fill('#demoAdminPassword', runtime.env.ADVISOR_PASSWORD); await adminPage.click('#demoAdminLogin button');
  await adminPage.waitForSelector('#demoAdminContent:not([hidden])'); await adminPage.waitForSelector('#demoAdminList button');
  await adminPage.locator('#demoAdminList button').first().click();
  await adminPage.waitForSelector('#demoAdminDetail h2');
  await adminPage.locator('#demoInvitationForm button').click(); await adminPage.waitForFunction(() => document.getElementById('demoInvitationUrl').value.includes('#invite='));
  assert.equal(await adminPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await adminPage.screenshot({ path: `${output}/admin-mobile.png`, fullPage: true });
  await adminContext.close();
  assert.deepEqual(errors, []);
  console.log(`Demo browser journeys passed on desktop and mobile. Screenshots: ${output}`);
} finally { await browser?.close(); runtime.close(); mail.restore(); await server.close(); }
