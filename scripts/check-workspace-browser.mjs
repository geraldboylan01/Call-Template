import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startPreviewServer } from './lib/preview-server.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = resolve(root, '.worker-dry-run/workspace-copy');
await mkdir(output, { recursive: true });
const server = await startPreviewServer(root);
const base = server.origin;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const errors = [], submissions = [];
    await context.route('**/api/**', async (route) => {
      if (route.request().method() === 'POST') submissions.push(route.request().url());
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    for (const path of ['/', '/apply/', '/privacy/', '/plan/privacy.html', '/terms/', '/for-ai-assistants/', '/apply/preparing/']) {
      await page.goto(`${base}${path}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} overflow on ${path}`);
      // Legal pages disclose the optional paid service; marketing remains free of a pre-analysis offer.
      if (['/', '/apply/', '/apply/preparing/'].includes(path)) assert.doesNotMatch(await page.locator('body').innerText(), /€100|\bpaid\b|\bcharging\b|\bfee\b|\bpayment\b|40[ -]min/i, `${name}: pricing before analysis on ${path}`);
    }
    await page.goto(`${base}/`);
    await page.locator('.faq-item').first().locator('summary').click();
    assert.match(await page.locator('.faq-item').first().innerText(), /different routes to your financial goals/);
    assert.doesNotMatch(await page.locator('body').innerText(), /being built|in development|planned service|not open yet/i);
    await page.locator('.faq-item').first().screenshot({ path: `${output}/faq-${name}.png` });
    const aiFaq = page.locator('.faq-item').filter({ hasText: 'How will AI help with the analysis?' });
    await aiFaq.locator('summary').click();
    assert.match(await aiFaq.innerText(), /scenarios to model from your objectives/);
    assert.match(await aiFaq.innerText(), /not connected/);
    await aiFaq.screenshot({ path: `${output}/ai-faq-${name}.png` });
    const savedFaq = page.locator('.faq-item').filter({ hasText: 'Can I return to my information?' });
    await savedFaq.locator('summary').click();
    assert.match(await savedFaq.innerText(), /until you delete it\./);
    assert.doesNotMatch(await page.locator('body').innerText(), /check the figures|check the assumptions|no inactivity expiry|AI[^.]*explain the modules/i);
    await page.screenshot({ path: `${output}/homepage-${name}.png`, fullPage: true });
    await page.goto(`${base}/apply/`);
    await page.evaluate(() => localStorage.setItem('planeir.apply.draft.v1', JSON.stringify({ v: 1, draft: { question: 'Old published case' }, contact: { fullName: 'Old applicant' }, sentPayload: { consentVideo: true, consentEducation: true } })));
    await page.reload();
    assert.equal(await page.inputValue('#applyName'), '');
    assert.equal(await page.isChecked('#applyPrivacyAcknowledged'), false);
    await page.goto(`${base}/`);
    await page.goto(`${base}/apply/#topics=mortgage&household.age=41&mortgage.balance=180000&question=Compare%20mortgage%20outcomes`);
    await page.waitForFunction(() => location.hash === '');
    assert.equal(await page.inputValue('#f-question'), 'Compare mortgage outcomes');
    await page.fill('#applyName', 'Preview Person');
    await page.fill('#applyEmail', 'preview@example.com');
    await page.fill('#f-question', 'How do the outcomes compare?');
    await page.waitForFunction(() => localStorage.getItem('planeir.workspace.draft.v1')?.includes('How do the outcomes compare?'));
    await page.reload();
    assert.equal(await page.inputValue('#f-question'), 'How do the outcomes compare?');
    assert.equal(await page.isDisabled('#applySubmit'), true);
    assert.equal(await page.locator('input[type="file"]').count(), 0);
    assert.equal(await page.locator('#f-videoName').count(), 0);
    assert.doesNotMatch(await page.locator('body').innerText(), /Name to use in the video|Anything else Gerry should know|Never shown in videos/);
    // Bypass the disabled button to exercise the transport boundary itself.
    await page.evaluate(() => document.getElementById('applyForm').requestSubmit());
    await page.waitForFunction(() => document.getElementById('applyStatus').textContent.includes('currently unavailable'));
    assert.deepEqual(submissions, []);
    await page.screenshot({ path: `${output}/form-${name}.png`, fullPage: true });
    page.once('dialog', (dialog) => dialog.accept());
    await page.click('#applyClear');
    await page.waitForFunction(() => document.getElementById('f-question').value === '');
    await page.reload();
    assert.equal(await page.inputValue('#f-question'), '');

    await page.goto(`${base}/dev/education-call-preview.html`);
    await page.waitForSelector('.education-call-cta').catch(error => { throw new Error(`${error.message} Browser errors: ${errors.join('; ')}`); });
    assert.match(await page.locator('.education-call-cta').innerText(), /Personalised Planéir Walkthrough/);
    assert.match(await page.locator('.education-call-cta').innerText(), /Gerry, the creator of Planéir/);
    assert.match(await page.locator('.education-call-cta').innerText(), /€99\.99.*40 minutes on Zoom/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} call invitation overflow`);
    const gates = await page.evaluate(async () => {
      const { createEducationCallCTA, getAvailableViews } = await import('/js/plan/views.js');
      const ready = { session: { currentProfileRevision: 1, confirmedProfileRevision: 1 }, analysis: { id: 'fixture', profileRevision: 1, status: 'complete', results: [{ moduleId: 'house_purchase' }] }, bootstrap: { handoffEnabled: true } };
      const cases = [
        { ...ready, analysis: null },
        { ...ready, analysis: { ...ready.analysis, status: 'running' } },
        { ...ready, analysis: { ...ready.analysis, status: 'failed' } },
        { ...ready, session: { currentProfileRevision: 2, confirmedProfileRevision: 1 } },
        { ...ready, analysis: { ...ready.analysis, results: [] } },
        { ...ready, analysis: null, analysisPlan: { profileRevision: 1, status: 'complete', moduleIds: [], moduleSlots: [{ moduleId: 'some_gated_module', availability: 'adviser_review_required' }] } }
      ];
      return { hidden: cases.map((state) => createEducationCallCTA(state) === null), unavailableBeforeAnalysis: cases.slice(0, 5).map((state) => !getAvailableViews(state).handoff) };
    });
    assert.ok(gates.hidden.every(Boolean), `${name}: incomplete, failed, stale or review-only outcome offered a call`);
    assert.ok(gates.unavailableBeforeAnalysis.every(Boolean), `${name}: request opened before analysis`);
    await page.screenshot({ path: `${output}/analysis-call-${name}.png`, fullPage: true });
    assert.match(await page.locator('.education-call-cta').innerText(), /Walkthrough bookings are not available in this version yet/);
    assert.equal(await page.locator('.education-call-cta input, .education-call-cta select, .education-call-cta textarea, .education-call-cta button').count(), 0, 'Dormant preview cannot collect details or submit a purchase');
    assert.equal(await page.locator('#handoffForm').count(), 0);
    assert.deepEqual(submissions, []);
    assert.deepEqual(errors, [], `${name} browser errors`);
    await context.close();
  }
  console.log(`Workspace desktop/mobile, draft recovery, no-submission and post-analysis-only call checks passed. Screenshots: ${output}`);
} finally { if (browser) await browser.close(); await server.close(); }
