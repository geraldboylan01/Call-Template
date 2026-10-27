import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startPreviewServer } from './lib/preview-server.mjs';

const server = await startPreviewServer(resolve('dist'));
const output = resolve('.worker-dry-run/form-journey');
await mkdir(output, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const calls = [], errors = [];
    await context.route('**/api/**', async route => {
      calls.push(route.request().url());
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    for (const path of ['/plan/#invite=old-private-invite', '/app/analytics.html']) {
      await page.goto(server.origin + path);
      assert.equal(await page.locator('a[href="../apply/"]').count(), 1);
      assert.equal(await page.locator('a[href="../demo/"]').count(), 1);
      assert.equal(await page.locator('audio, video, [data-lane], #realtimeVoiceCompanion, #analyticsShell').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator('a[href*="invite="]').count(), 0, 'Old bearer fragments must never be forwarded into the new form.');
    }
    await page.goto(server.origin + '/plan/');
    await page.screenshot({ path: resolve(output, `retired-plan-${width}.png`), fullPage: true });
    assert.deepEqual(calls, [], 'Old bookmarks must not start meetings or contact consumer services.');
    assert.deepEqual(errors, []);
    const controller = await page.request.get(server.origin + '/js/plan/live_voice.js');
    assert.equal(controller.status(), 404, 'The built site must not publish the old voice controller.');
    await context.close();
  }
  console.log('Built form journey: retired bookmarks, no conversation requests, no forwarded invites and desktop/mobile layout passed.');
} finally {
  await browser?.close();
  await server.close();
}
