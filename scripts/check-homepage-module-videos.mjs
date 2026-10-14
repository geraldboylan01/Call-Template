import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const output = fileURLToPath(new URL('../.worker-dry-run/homepage-module-videos/', import.meta.url));
await mkdir(output, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4' };
const server = createServer(async (request, response) => {
  try {
    let pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(root)) return response.writeHead(403).end();
    const bytes = await readFile(file);
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    const headers = { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    if (range) {
      const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      if (start > end) return response.writeHead(416).end();
      response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 }).end(bytes.subarray(start, end + 1));
    } else response.writeHead(200, { ...headers, 'Content-Length': bytes.length }).end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [], missing = [], mediaRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.url().startsWith(origin) && response.status() >= 400) missing.push(response.url()); });
    page.on('request', request => { if (new URL(request.url()).pathname.endsWith('.mp4')) mediaRequests.push(request.url()); });
    await page.route('https://api.planeir.ie/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await page.route('https://www.youtube-nocookie.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '' }));
    await page.goto(origin);
    await page.locator('#module-examples').scrollIntoViewIfNeeded();
    const links = page.locator('[data-module-video]');
    assert.equal(await links.count(), 3);
    assert.equal(await page.locator('.module-video-dialog video').getAttribute('src'), null);
    assert.deepEqual(mediaRequests, [], 'No clip should download before a visitor chooses one');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('#module-examples').screenshot({ path: `${output}/${size}-cards.png` });

    for (let index = 0; index < 3; index++) {
      const link = links.nth(index), href = await link.getAttribute('href');
      assert.match(href, /\.mp4\?v=/, 'The built media link must be versioned');
      const poster = link.locator('img');
      await poster.scrollIntoViewIfNeeded();
      await poster.evaluate(image => image.decode());
      await link.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => {
        const video = document.querySelector('.module-video-dialog video');
        return video.readyState >= 2 && !video.paused && video.currentTime > 0;
      });
      const video = page.locator('.module-video-dialog video');
      const meta = await video.evaluate(video => ({ width: video.videoWidth, height: video.videoHeight, duration: video.duration, controls: video.controls, inline: video.playsInline, muted: video.muted, error: video.error }));
      assert.equal(meta.width, 1920); assert.equal(meta.height, 1080);
      assert.ok(meta.duration > 20 && meta.duration < 40);
      assert.ok(meta.controls && meta.inline && meta.muted); assert.equal(meta.error, null);
      assert.ok(await page.locator('#moduleVideoContext').innerText());
      assert.equal(await page.locator('.module-video-dialog').evaluate(dialog => dialog.open && dialog.getBoundingClientRect().right <= innerWidth), true);
      if (index === 0) assert.match(await page.locator('#moduleVideoContext').innerText(), /€15,000.*€2,500.*€8,000.*€4,500.*4%/);
      await video.evaluate(video => new Promise(done => {
        video.pause(); video.addEventListener('seeked', done, { once: true }); video.currentTime = video.duration - .15;
      }));
      await page.locator('.module-video-dialog').screenshot({ path: `${output}/${size}-${index + 1}-player.png` });
      await video.evaluate(video => video.play());
      await page.waitForFunction(() => document.querySelector('.module-video-dialog video').ended);
      await video.evaluate(video => video.play());
      await page.waitForFunction(() => { const video = document.querySelector('.module-video-dialog video'); return !video.paused && video.currentTime < 1; });
      if (index % 2) await page.click('[data-module-video-close]');
      else await page.keyboard.press('Escape');
      await page.waitForFunction(() => { const video = document.querySelector('.module-video-dialog video'); return video.paused && !video.getAttribute('src'); });
      assert.equal(await page.locator('.module-video-dialog').evaluate(dialog => dialog.open), false);
      assert.equal(await video.evaluate(video => video.paused && !video.getAttribute('src')), true);
      assert.equal(await link.evaluate(link => document.activeElement === link), true);
    }
    assert.deepEqual(errors, []); assert.deepEqual(missing, []);
    assert.equal(new URL(page.url()).pathname, '/');
    await context.close();
    console.log(`${size}: all three videos play, seek, replay, close and restore keyboard focus; downloads wait for a click.`);
  }
  const noScript = await browser.newContext({ javaScriptEnabled: false });
  const page = await noScript.newPage(); await page.goto(origin);
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/future-cost-fund.mp4')),
    page.locator('[data-module-video]').first().click()
  ]);
  assert.equal(response.headers()['content-type'], 'video/mp4');
  assert.ok(Number(response.headers()['content-length']) > 1_000_000);
  assert.ok(new URL(page.url()).pathname.endsWith('/future-cost-fund.mp4'));
  await noScript.close();
  console.log('The direct MP4 fallback works without JavaScript. Homepage module videos passed.');
} finally { await browser?.close(); await new Promise(done => server.close(done)); }
