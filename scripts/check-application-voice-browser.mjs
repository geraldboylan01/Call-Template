// Real pages + real Worker handlers + SQLite; synthetic audio and captured mail.
// Browser tooling is a local development dependency, as in presenter checks.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createTestRuntime, captureEmail, wavFixture } from './lib/application-test-runtime.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mail = captureEmail(); const runtime = createTestRuntime();
const output = resolve(root, '.worker-dry-run/application-voice'); await mkdir(output, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = createServer(async (request, response) => {
  try {
    let pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname.endsWith('/')) pathname += 'index.html';
    if (!/^\/(apply|js|styles|assets|app)\//.test(pathname) && !/^\/(favicon[^/]*|apple-touch-icon\.png)$/.test(pathname)) { response.writeHead(404).end(); return; }
    const path = resolve(root, `.${pathname}`);
    if (!path.startsWith(`${root}/`)) { response.writeHead(403).end(); return; }
    const bytes = await readFile(path); response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' }).end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const errors = []; let submitRequests = 0, loseNextSubmissionResponse = false;
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
context.setDefaultTimeout(15_000);
await context.route('http://127.0.0.1:8787/**', async route => {
  const request = route.request();
  if (request.method() === 'POST' && request.url().endsWith('/api/applications')) submitRequests++;
  const response = await runtime.dispatch(new Request(request.url(), { method: request.method(), headers: request.headers(), body: ['GET', 'HEAD'].includes(request.method()) ? undefined : request.postDataBuffer() }));
  if (loseNextSubmissionResponse && request.url().endsWith('/api/applications')) {
    loseNextSubmissionResponse = false;
    await route.abort('failed'); return;
  }
  await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
});
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
async function form(email) {
  const page = await context.newPage(); await page.goto(`${base}/apply/`);
  await page.locator('#applyVoiceNote').waitFor({ state: 'visible' });
  await page.fill('#f-question', 'Can I retire earlier?'); await page.fill('#applyName', 'Test Person'); await page.fill('#applyEmail', email);
  await page.check('#applyConsentVideo'); await page.check('#applyConsentEducation');
  return page;
}
async function choose(page, bytes = wavFixture()) {
  await page.setInputFiles('[data-voice="file"]', { name: 'voice.wav', mimeType: 'audio/wav', buffer: bytes });
  await page.waitForFunction(() => document.querySelector('[data-voice="status"]').textContent.includes('Listen back'));
}
try {
  const page = await form('browser-one@example.com'); await choose(page);
  await page.click('#applySubmit');
  await page.waitForFunction(() => document.querySelector('#applyStatus').textContent.includes('permission box'));
  assert.equal(submitRequests, 0); assert.equal(runtime.objects.size, 0);
  await page.check('[data-voice="consent"]'); await choose(page);
  assert.equal(await page.isChecked('[data-voice="consent"]'), false, 'replacement resets permission');
  await page.screenshot({ path: `${output}/application-mobile.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.check('[data-voice="consent"]'); runtime.bucket.failPut = true;
  await page.click('#applySubmit');
  await page.waitForFunction(() => document.querySelector('#applySubmit').textContent === 'Retry voice note');
  assert.equal(runtime.sql.prepare('SELECT COUNT(*) n FROM leads').get().n, 1);
  assert.equal(await page.isDisabled('#applyName'), true);
  runtime.bucket.failPut = false;
  await page.click('#applySubmit'); await page.locator('#applyDone').waitFor({ state: 'visible' });
  assert.equal(submitRequests, 1, 'audio retry must not resubmit the written application');
  assert.equal(runtime.sql.prepare("SELECT COUNT(*) n FROM application_voice_notes WHERE state='ready'").get().n, 1);
  console.log('ok - mobile consent gate, fresh consent on replacement, upload recovery and written submission isolation');

  const recorder = await form('browser-two@example.com');
  await recorder.click('[data-voice="record"]'); await recorder.locator('[data-voice="stop"]').waitFor({ state: 'visible' });
  await recorder.waitForTimeout(800); // Deliberately collect a short synthetic microphone sample.
  await recorder.click('[data-voice="stop"]');
  await recorder.waitForFunction(() => document.querySelector('[data-voice="status"]').textContent.includes('Listen back'));
  assert.equal(await recorder.isChecked('[data-voice="consent"]'), false);
  await recorder.click('[data-voice="remove"]'); await recorder.locator('[data-voice="preview"]').waitFor({ state: 'hidden' });
  await recorder.click('#applySubmit'); await recorder.locator('#applyDone').waitFor({ state: 'visible' });
  assert.equal(runtime.sql.prepare('SELECT COUNT(*) n FROM leads').get().n, 2);
  console.log('ok - actual MediaRecorder sample previews and can be removed before a text-only submission');

  const receipt = mail.emails.find(email => email.to.includes('browser-two@example.com'));
  const token = /#voice=([A-Za-z0-9_-]{43})/.exec(receipt.text)[1];
  const later = await context.newPage(); await later.goto(`${base}/apply/confirm/#voice=${token}`);
  await later.locator('#confirmVoiceSection').waitFor({ state: 'visible' });
  assert.equal(new URL(later.url()).hash, '');
  await choose(later); await later.click('#confirmVoiceSubmit');
  await later.waitForFunction(() => document.querySelector('#confirmVoiceStatus').textContent.includes('permission box'));
  await later.check('[data-voice="consent"]'); await later.click('#confirmVoiceSubmit');
  await later.waitForFunction(() => document.querySelector('#confirmVoiceStatus').textContent.includes('saved with permission'));
  console.log('ok - receipt link strips its token and requires separate consent for later audio');

  const recovery = await form('browser-recovery@example.com');
  await recovery.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); }; });
  await recovery.click('[data-voice="record"]');
  await recovery.waitForFunction(() => document.querySelector('[data-voice="status"]').textContent.includes('Check permission'));
  assert.equal(await recovery.isDisabled('[data-voice="file"]'), false);
  await recovery.setInputFiles('[data-voice="file"]', { name: 'too-large.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
  await recovery.waitForFunction(() => document.querySelector('[data-voice="status"]').textContent.includes('smaller than 10 MiB'));
  loseNextSubmissionResponse = true;
  await recovery.click('#applySubmit');
  await recovery.waitForFunction(() => document.querySelector('#applyStatus').textContent.includes('could not be sent'));
  assert.equal(runtime.sql.prepare('SELECT COUNT(*) n FROM leads').get().n, 3);
  const emailsBeforeRetry = mail.emails.length;
  await recovery.reload(); await recovery.locator('#applyVoiceNote').waitFor({ state: 'visible' });
  assert.equal(await recovery.isDisabled('#applyName'), true);
  assert.equal(await recovery.inputValue('#applyEmail'), 'browser-recovery@example.com');
  await recovery.click('#applySubmit'); await recovery.locator('#applyDone').waitFor({ state: 'visible' });
  assert.equal(runtime.sql.prepare('SELECT COUNT(*) n FROM leads').get().n, 3);
  assert.equal(mail.emails.length, emailsBeforeRetry);
  console.log('ok - denied microphone and oversized file preserve written submission; reload after lost response creates no duplicate case or email');

  const auth = await runtime.login();
  await context.addCookies([{ name: 'planeir_advisor_session', value: auth.Cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  const admin = await context.newPage(); await admin.setViewportSize({ width: 1280, height: 900 });
  console.log('Checking advisor page');
  await admin.goto(`${base}/app/clients.html?client=1&lead=1`);
  await admin.locator('#clientVoiceNote').waitFor({ state: 'visible' });
  console.log('Checking audio playback');
  await admin.getByRole('button', { name: 'Play voice note', exact: true }).click();
  await admin.waitForFunction(() => document.querySelector('#clientVoiceNote audio').currentTime > 0);
  const downloading = admin.waitForEvent('download');
  console.log('Checking WAV download');
  await admin.getByRole('button', { name: 'Download WAV', exact: true }).click();
  const download = await downloading; assert.equal(download.suggestedFilename(), 'application-1-voice-note.wav');
  const bytes = await readFile(await download.path()); assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.ok(bytes.length > 44);
  await admin.screenshot({ path: `${output}/advisor-desktop.png`, fullPage: true });
  await admin.check('#clientVoiceFilter');
  console.log('Checking list filter and deletion');
  await admin.waitForFunction(() => document.querySelector('#clientList').textContent.includes('Voice note ready'));
  admin.on('dialog', dialog => dialog.accept());
  await admin.getByRole('button', { name: 'Delete voice note', exact: true }).click();
  await admin.locator('#clientVoiceNote').waitFor({ state: 'hidden' });
  await admin.waitForFunction(() => !document.querySelector('#clientList').textContent.includes('browser-one@example.com'));
  assert.equal(runtime.sql.prepare("SELECT COUNT(*) n FROM application_voice_notes WHERE lead_id=1 AND state='ready'").get().n, 0);
  assert.deepEqual(errors, []);
  console.log('ok - signed-in playback, local WAV export, list filter and CSRF-protected deletion');
  console.log(`Screenshots: ${output}`);
} finally {
  await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); runtime.close(); mail.restore();
}
