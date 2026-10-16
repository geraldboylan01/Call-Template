import assert from 'node:assert/strict';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startPreviewServer } from './lib/preview-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, '.worker-dry-run/product-previews');
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(root, 'assets/examples/product-preview-manifest.json'), 'utf8'));
assert.equal(manifest.clips.length, 10);
for (const clip of manifest.clips) {
  for (const format of ['mp4', 'webm']) {
    const path = resolve(root, `assets/examples/${clip.kind}-preview-${clip.size}.${format}`);
    assert.equal((await stat(path)).size, clip[`${format}Bytes`], `${path} must match the export manifest`);
    assert.ok(clip[`${format}Bytes`] < 1_000_000, 'The homepage clip should stay below one megabyte');
  }
}
const server = await startPreviewServer(root);
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'no-preference' });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/api/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await page.goto(server.origin);
    if (size === 'mobile') {
      // A tab can be visible just above an offscreen video. Choosing it must
      // queue playback until the video enters the viewport, rather than stall.
      await page.click('[data-preview-module="balance-sheet"]');
      await page.locator('[data-preview-video]').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => { const video = document.querySelector('[data-preview-video]'); return !video.paused && video.currentSrc.includes('balance-sheet'); });
      await page.click('[data-preview-module="mortgage"]');
    }
    await page.locator('[data-preview-video]').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => !document.querySelector('[data-preview-video]').paused);
    assert.equal(await page.evaluate(() => document.querySelector('[data-preview-video]').loop), false);
    assert.equal(await page.evaluate(() => document.querySelector('[data-preview-video]').muted), true);
    assert.match(await page.evaluate(() => document.querySelector('[data-preview-video]').currentSrc), new RegExp(`mortgage-preview-${size}\\.mp4`));
    await page.click('[data-preview-play]');
    assert.equal(await page.evaluate(() => document.querySelector('[data-preview-video]').paused), true);
    await page.click('[data-preview-play]');
    await page.waitForFunction(() => !document.querySelector('[data-preview-video]').paused);

    for (const kind of ['mortgage', 'balance-sheet', 'future-cost-fund', 'household-cash-flow', 'protection-gap']) {
      await page.click(`[data-preview-module="${kind}"]`);
      await page.waitForFunction(kind => {
        const video = document.querySelector('[data-preview-video]');
        return video.readyState >= 2 && video.currentSrc.includes(kind);
      }, kind);
      const metadata = await page.evaluate(() => {
        const video = document.querySelector('[data-preview-video]');
        video.pause();
        return { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
      });
      const expected = manifest.clips.find(clip => clip.kind === kind && clip.size === size);
      assert.ok(Math.abs(metadata.duration - expected.seconds) < .05, JSON.stringify(metadata));
      assert.equal(metadata.width, expected.width); assert.equal(metadata.height, expected.height);
      // Inspect both the comparison and final held result from the encoded video.
      for (const time of [kind === 'mortgage' ? 4.5 : 5, expected.seconds - .1]) {
        await page.evaluate(time => new Promise(resolve => {
          const video = document.querySelector('[data-preview-video]');
          video.addEventListener('seeked', resolve, { once: true }); video.currentTime = time;
        }), time);
        await page.locator('[data-product-preview]').screenshot({ path: `${output}/homepage-${kind}-${size}-${time}.png` });
        if (time > expected.seconds - .2) await page.screenshot({ path: `${output}/homepage-${kind}-${size}.png` });
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.click('[data-preview-play]');
      await page.waitForFunction(() => document.querySelector('[data-preview-video]').ended);
      assert.equal(await page.locator('[data-preview-play]').innerText(), 'Replay');
      await page.click('[data-preview-play]');
      await page.waitForFunction(() => { const video = document.querySelector('[data-preview-video]'); return !video.paused && video.currentTime < 1; });
      await page.click('[data-preview-enlarge]');
      assert.equal(await page.locator('.preview-dialog').evaluate(dialog => dialog.open), true);
      assert.equal(await page.evaluate(() => document.querySelector('[data-preview-video]').paused), true);
      await page.waitForFunction(() => document.querySelector('.preview-dialog video').readyState >= 2);
      assert.equal(await page.locator('.preview-dialog a').getAttribute('href'), './apply/');
      await page.click('[data-preview-close]');
      assert.equal(await page.locator('.preview-dialog video').evaluate(video => video.paused), true);
    }
    // Selecting a module stays on the page; the form remains the main CTA.
    assert.equal(new URL(page.url()).pathname, '/');
    await page.locator('[data-preview-module="balance-sheet"]').focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('[data-preview-module="mortgage"]').getAttribute('aria-selected'), 'true');
    assert.deepEqual(errors, []);
    await context.close();

    const reduced = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const still = await reduced.newPage();
    await reduced.route('**/api/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await still.goto(server.origin);
    await still.locator('[data-preview-video]').scrollIntoViewIfNeeded();
    assert.equal(await still.evaluate(() => document.querySelector('[data-preview-video]').paused), true);
    await still.click('[data-preview-module="balance-sheet"]');
    assert.equal(await still.evaluate(() => document.querySelector('[data-preview-video]').paused), true);
    assert.match(await still.locator('[data-preview-video]').getAttribute('poster'), new RegExp(`balance-sheet-preview-${size}-poster\\.png`));
    await still.locator('[data-product-preview]').screenshot({ path: `${output}/homepage-reduced-motion-${size}.png` });
    if (size === 'mobile') {
      const placement = await still.evaluate(() => ({ cta: document.querySelector('.hero-actions').getBoundingClientRect().top, preview: document.querySelector('[data-product-preview]').getBoundingClientRect().top }));
      assert.ok(placement.cta < placement.preview, 'The form CTA must precede the mobile preview');
    }
    await reduced.close();
  }
  // Decode every fallback too; all exports must contain actual playable video.
  const page = await browser.newPage();
  for (const clip of manifest.clips) {
    await page.goto(`${server.origin}/assets/examples/${clip.kind}-preview-${clip.size}.webm`);
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
    assert.equal(await page.locator('video').evaluate(video => video.videoWidth), clip.width);
  }
  console.log('Product previews passed: all exports decode; desktop/mobile playback, pause, replay, module switching, enlargement, reduced motion and CTA placement work.');
} finally { if (browser) await browser.close(); await server.close(); }
