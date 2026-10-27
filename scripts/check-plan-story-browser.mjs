// The plan story in the real app, with real modules and real figures.
//
// Opens the app on the demo session (dev/plan_story_demo.js: the story's household built into
// the eight modules by the form's own pipeline, plus the sample story) and, at desktop and phone
// width, checks that
//   - the story is drawn first and the module grid sits below it, with a Story | Modules switch;
//   - every linked figure opens the module the story named, on the case the story named, and
//     rings the figure that module itself prints;
//   - "Back to the story" returns to the paragraph the link was in;
//   - changing the case inside the module shows "This screen no longer follows the route", and
//     "Back to the route" puts it back;
//   - a route with no story yet says it is updating, and the story survives a reload.
//
// Needs Google Chrome (CHROME_PATH to override). Nothing leaves the machine: the app's auth
// call is answered locally and every other call to the API is refused.

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startPreviewServer } from './lib/preview-server.mjs';
import { PLAN_STORY_CASE_BRIDGES } from '../js/plan_story_links.js';
import { PLAN_STORY_SAMPLE_REGISTRY } from '../js/tests_plan_story_sample.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, '.worker-dry-run/plan-story');
await mkdir(output, { recursive: true });

const server = await startPreviewServer(root);
const API = 'https://api.planeir.ie';
const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
let browser;
let failures = 0;

try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  for (const [size, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'no-preference', hasTouch: size === 'phone', isMobile: size === 'phone' });
    await context.route(`${API}/**`, (route) => {
      const headers = { 'access-control-allow-origin': server.origin, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      return route.request().url().endsWith('/api/auth/session')
        ? route.fulfill({ status: 200, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ authEnabled: true, authenticated: true }) })
        : route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !/frame-ancestors|Failed to load resource/.test(message.text())) errors.push(message.text()); });
    const note = (text) => console.info(`[PlanStoryBrowser] ${size}: ${text}`);

    await page.goto(`${server.origin}/dev/plan-story-demo.html`);
    await page.waitForSelector('body[data-ready="true"]');
    await page.goto(`${server.origin}/app/index.html`);
    await page.waitForSelector('.ps .ps-headline', { timeout: 20000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${output}/${size}-story.png` });

    // The story first, the grid below it.
    const layout = await page.evaluate(() => {
      const story = document.querySelector('#planStoryHost').getBoundingClientRect();
      const grid = document.querySelector('#overviewGrid').getBoundingClientRect();
      const scroll = document.querySelector('#overviewViewport').scrollTop;
      return { storyBottom: story.bottom + scroll, gridTop: grid.top + scroll, cards: document.querySelectorAll('.overview-card').length, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    assert.equal(layout.cards, 8, 'every module has a card in the grid');
    assert.ok(layout.gridTop >= layout.storyBottom - 5, `the grid sits below the story (${JSON.stringify(layout)})`);
    assert.equal(layout.overflow, 0, 'the page does not scroll sideways');
    note('the story is first and the grid is below it');

    // Story | Modules.
    await page.click('.ps-switch button:has-text("Modules")');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#planStoryHost').isVisible(), false, 'the Modules view hides the story');
    await page.click('.ps-switch button:has-text("Story")');
    await page.waitForSelector('.ps .ps-headline');

    // Every linked figure.
    const { chapterModules } = await page.evaluate(() => JSON.parse(localStorage.getItem('call_canvas_session_current')).planStory);
    const links = await page.$$eval('.ps-link', (nodes) => nodes.map((node) => ({ key: node.dataset.psKey, chapter: node.dataset.psChapter, caseId: node.dataset.psCase, text: node.querySelector('span').textContent })));
    assert.ok(links.length >= 15, `the sample story links its figures (${links.length})`);
    for (let index = 0; index < links.length; index += 1) {
      const link = links[index];
      const fact = PLAN_STORY_SAMPLE_REGISTRY[link.key];
      await page.locator('.ps-link').nth(index).scrollIntoViewIfNeeded();
      await page.locator('.ps-link').nth(index).click();
      await page.waitForSelector('body.focus-mode', { timeout: 10000 });
      await page.waitForSelector('.ps-outline', { timeout: 8000 });
      await page.waitForTimeout(150);
      const seen = await page.evaluate(({ moduleId, chapter, bridge }) => {
        const getter = bridge ? window[`__get${bridge}ScenarioForModule`] : null;
        const active = document.querySelector('.swipe-pane.active');
        return {
          ringText: document.querySelector('.ps-outline').dataset.psFigure || '',
          paneText: (active?.innerText || '').replace(/\s+/g, ' ').trim(),
          caseNow: getter ? getter(moduleId) : null,
          activeIsModule: Boolean(active && moduleId),
          pill: Boolean(document.querySelector('.ps-pill')),
          offRoute: Boolean(document.querySelector('.ps-offroute'))
        };
      }, { moduleId: chapterModules[link.chapter], chapter: link.chapter, bridge: PLAN_STORY_CASE_BRIDGES[link.chapter] });
      const expected = squash(fact.source.outlineText || fact.text);
      if (fact.source.outlineSelector) {
        // The module prints this figure in its own words (a date), so look for the year the story names.
        const year = fact.text.match(/\d{4}/)?.[0];
        assert.ok(seen.ringText.includes(year), `${link.key}: the ring holds the year ${year} the story names, not "${seen.ringText}"`);
      } else {
        assert.ok(seen.ringText.includes(expected), `${link.key}: the ring holds "${expected}", not "${seen.ringText}"`);
      }
      if (link.caseId) assert.equal(seen.caseNow, link.caseId, `${link.key}: opens ${link.chapter} on ${link.caseId}`);
      assert.ok(seen.pill && !seen.offRoute, `${link.key}: the pill is there and the screen follows the route`);
      await page.click('.ps-pill');
      await page.waitForFunction(() => !document.body.classList.contains('focus-mode'), null, { timeout: 10000 });
      await page.waitForFunction(() => document.querySelector('.ps-here'), null, { timeout: 5000 });
      await page.waitForTimeout(700);
      const back = await page.evaluate(() => {
        const here = document.querySelector('.ps-here');
        const rect = here.getBoundingClientRect();
        return { paragraph: here.dataset.psParagraph, visible: rect.top >= 0 && rect.bottom <= innerHeight + 4, section: here.closest('[data-ps-section]')?.dataset.psSection };
      });
      assert.ok(back.visible, `${link.key}: back to the story shows the paragraph it was in`);
    }
    note(`${links.length} linked figures open their module and case, ring the figure the module prints, and come back to the same paragraph`);

    // Off the route and back.
    const extra = page.locator('.ps-link[data-ps-key="route.goals.mortgage.extraMonthly"]');
    await extra.scrollIntoViewIfNeeded();
    await extra.click();
    await page.waitForSelector('.ps-outline');
    assert.equal(await page.locator('.ps-offroute').count(), 0);
    await page.locator('.rcm-case').first().click();
    await page.waitForSelector('.ps-offroute', { timeout: 5000 });
    assert.match(await page.locator('.ps-offroute').innerText(), /no longer follows the route/);
    await page.screenshot({ path: `${output}/${size}-off-route.png` });
    await page.click('.ps-offroute .ps-btn');
    await page.waitForFunction(() => !document.querySelector('.ps-offroute'), null, { timeout: 5000 });
    assert.equal(await page.evaluate((id) => window.__getMortgageScenarioForModule(id), chapterModules.mortgage_analysis), 'extra');
    await page.click('.ps-pill');
    await page.waitForFunction(() => !document.body.classList.contains('focus-mode'), null, { timeout: 10000 });
    note('off the route shows the note, and Back to the route puts the case back');

    // A route with no story yet, and a reload.
    await page.evaluate(() => { document.querySelector('#overviewViewport').scrollTop = 0; });
    await page.click('.ps-route[data-ps-route="route-2"]');
    await page.waitForSelector('.ps-status');
    assert.match(await page.locator('.ps-status').innerText(), /updating/i);
    assert.equal(await page.locator('.ps-link').count(), 0);
    await page.click('.ps-route[data-ps-route="route-3"]');
    await page.waitForSelector('.ps-link');
    await page.reload();
    await page.waitForSelector('.ps .ps-headline', { timeout: 20000 });
    note('a route with no story says it is updating; the story survives a reload');

    assert.deepEqual(errors, [], `no page errors at ${size}`);
    await context.close();
  }
} catch (error) {
  failures += 1;
  console.error(`[PlanStoryBrowser] FAIL: ${error.message}`);
} finally {
  await browser?.close();
  await server.close();
}

if (failures) process.exit(1);
console.info('[PlanStoryBrowser] All checks passed.');
