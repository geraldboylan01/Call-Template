import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

export async function checkPresenterControls() {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] });
  const dir = 'private/aam-makeovers/presenter-controls-regression'; await fs.mkdir(dir, { recursive: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce', acceptDownloads: true });
    await context.addInitScript(() => {
      if (location.origin !== 'http://127.0.0.1:8790') return;
      window.mockOBS = { active: false, paused: false, failStart: false, failStop: false, requests: [], sockets: [] };
      window.WebSocket = class extends EventTarget {
        readyState = 1;
        constructor() { super(); window.mockOBS.sockets.push(this); queueMicrotask(() => this.receive(0, { authentication: { salt: 'salt', challenge: 'challenge' } })); }
        receive(op, d) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ op, d }) })); }
        close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
        async send(raw) {
          const { op, d } = JSON.parse(raw), mock = window.mockOBS;
          if (op === 1) { this.receive(2, {}); return; }
          mock.requests.push(d.requestType);
          let result = true;
          if (d.requestType === 'StartRecord') { await window.verifyClean(); if (mock.failStart) result = false; else mock.active = true; }
          if (d.requestType === 'StopRecord') { if (mock.failStop) result = false; else mock.active = false; }
          this.receive(7, { requestId: d.requestId, requestStatus: { result, code: result ? 100 : 500, comment: result ? '' : 'Simulated OBS failure' }, responseData: { outputActive: mock.active, outputPaused: mock.paused, outputTimecode: mock.active ? '00:01:23.456' : '00:00:00.000' } });
        }
      };
    });
    const page = await context.newPage(), errors = []; context.on('page', p => p.on('pageerror', e => errors.push(e.message))); page.on('pageerror', e => errors.push(e.message));
    let cleanChecks = 0;
    await context.exposeBinding('verifyClean', async () => {
      assert.equal(await page.locator('.presenter-hud').isVisible(), false);
      assert.equal(await page.locator('.presenter-setup').isVisible(), false);
      assert.equal(await page.evaluate(() => window.planeirPresenter.state().index), -1); cleanChecks++;
    });
    await page.goto('http://127.0.0.1:8788/private/aam-makeovers/presenter-regression/');
    await page.waitForFunction(() => window.planeirPresenter?.state().active && !window.planeirPresenter.state().busy);
    const source = await page.evaluate(() => ({ case: JSON.stringify(window.planeirPresenter.discover()), storage: JSON.stringify({ ...localStorage }) }));
    console.log('Checking real chart hover and pinned point restoration');
    await page.evaluate(() => window.planeirPresenter.goTo(5));
    const point = await page.evaluate(() => {
      const charts = [...document.querySelectorAll('canvas')].map(c => window.Chart.getChart(c)).filter(Boolean);
      const chart = charts.find(c => c.data.labels?.join(',') === '60,65');
      const r = chart.canvas.getBoundingClientRect(), p = chart.getDatasetMeta(0).data[0];
      return { x: r.left + p.x * r.width / chart.width, y: r.top + p.y * r.height / chart.height };
    });
    await page.mouse.move(point.x, point.y);
    await page.waitForFunction(() => [...document.querySelectorAll('canvas')].map(c => window.Chart.getChart(c)).find(c => c?.data.labels?.join(',') === '60,65')?.tooltip.getActiveElements()[0]?.index === 0);
    await page.mouse.move(5, 5);
    await page.waitForFunction(() => [...document.querySelectorAll('canvas')].map(c => window.Chart.getChart(c)).find(c => c?.data.labels?.join(',') === '60,65')?.tooltip.getActiveElements()[0]?.index === 1);
    console.log('Checking mortgage timing exploration on the real Frasier case');
    const frasier = await context.newPage(); frasier.on('pageerror', e => errors.push(e.message));
    await frasier.goto('http://127.0.0.1:8788/private/aam-makeovers/2026-09-23-frasier-presenter/');
    await frasier.waitForFunction(() => window.planeirPresenter?.state().active && !window.planeirPresenter.state().busy);
    const fsource = await frasier.evaluate(() => JSON.stringify(window.planeirPresenter.discover()));
    const mortgageIndex = await frasier.evaluate(() => window.planeirPresenter.recordingBundle().compiled.steps.findIndex(s => s.operations.some(o => o.action === 'state' && o.scenarioId === 'clear-mortgage')));
    assert.ok(mortgageIndex >= 0);
    await frasier.evaluate(index => window.planeirPresenter.goTo(index), mortgageIndex);
    const authoredYear = await frasier.locator('.rcm-timing-pills [aria-checked=true]').innerText();
    const beforeText = await frasier.locator('.rcm').innerText();
    await frasier.locator('.rcm-timing-pills button:not([aria-checked=true]):enabled').first().click();
    await frasier.waitForFunction(() => window.planeirPresenter.state().exploring);
    assert.notEqual(await frasier.locator('.rcm-timing-pills [aria-checked=true]').innerText(), authoredYear);
    assert.notEqual(await frasier.locator('.rcm').innerText(), beforeText);
    await frasier.evaluate(() => window.planeirPresenter.resume());
    assert.equal(await frasier.locator('.rcm-timing-pills [aria-checked=true]').innerText(), authoredYear);
    assert.equal(await frasier.evaluate(() => window.planeirPresenter.state().exploring), false);
    await frasier.locator('.rcm-timing-pills button:not([aria-checked=true]):enabled').first().click();
    await frasier.evaluate(() => window.planeirPresenter.next());
    assert.equal(await frasier.evaluate(() => window.planeirPresenter.state().index), mortgageIndex + 1);
    await frasier.evaluate(() => window.planeirPresenter.previous());
    assert.equal(await frasier.locator('.rcm-timing-pills [aria-checked=true]').innerText(), authoredYear);
    assert.equal(await frasier.evaluate(() => JSON.stringify(window.planeirPresenter.discover())), fsource);
    await frasier.evaluate(() => window.planeirPresenter.exit()); await frasier.close();
    console.log('Checking separate controls and mocked OBS start/stop');
    assert.equal((await page.evaluate(() => window.planeirPresenter.validateLive())).status, 'passed');
    await page.keyboard.press('c');
    const popupEvent = page.waitForEvent('popup'); await page.getByRole('button', { name: 'Open recording controls', exact: true }).click();
    const desk = await popupEvent; await desk.waitForFunction(() => document.getElementById('connection').textContent.includes('Planéir connected'));
    assert.equal(await page.locator('.presenter-hud').isVisible(), false);
    await desk.locator('#password').fill('test-only'); await desk.locator('#connect').click();
    await desk.waitForFunction(() => document.getElementById('record-state').textContent.startsWith('STOPPED'));
    assert.equal(await desk.locator('#password').inputValue(), '');
    // Invalid nonce from the real popup must not execute, even with the right origin.
    const indexBefore = await page.evaluate(() => window.planeirPresenter.state().index);
    await desk.evaluate(() => opener.postMessage({ channel: 'planeir-presenter', session: 'invalid', type: 'command', command: 'next', id: 'malicious' }, 'http://127.0.0.1:8788'));
    await page.waitForTimeout(200); assert.equal(await page.evaluate(() => window.planeirPresenter.state().index), indexBefore);
    await desk.locator('#ready').check(); await desk.locator('#record').click();
    await desk.waitForFunction(() => document.getElementById('record-state').textContent.startsWith('RECORDING'));
    assert.equal(await desk.locator('#timer').innerText(), '00:01:23');
    await page.waitForFunction(() => window.planeirPresenter.take.active && !window.planeirPresenter.take.countingDown);
    await desk.screenshot({ path: `${dir}/recording-controls.png`, fullPage: true });
    assert.equal(await page.evaluate(() => window.planeirPresenter.take.snapshot().capture.obsRecordingConfirmed), true);
    await desk.getByRole('button', { name: 'Next →', exact: true }).click();
    await page.waitForFunction(() => window.planeirPresenter.state().index === 0 && !window.planeirPresenter.state().busy);
    await page.keyboard.press('h'); await page.keyboard.press('c'); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.presenter-hud').isVisible(), false); assert.equal(await page.locator('.presenter-setup').isVisible(), false);
    await desk.evaluate(() => window.mockOBS.failStop = true); await desk.locator('#stop').click();
    await desk.waitForFunction(() => document.getElementById('error').textContent.includes('Simulated OBS failure'));
    assert.equal(await page.evaluate(() => window.planeirPresenter.take.controlled), true);
    assert.equal(await page.locator('.presenter-setup').isVisible(), false);
    await desk.evaluate(() => { window.mockOBS.failStop = false; window.mockOBS.sockets.at(-1).close(); });
    await desk.waitForFunction(() => document.getElementById('record-state').textContent.includes('unknown'));
    assert.equal(await page.evaluate(() => window.planeirPresenter.take.active), true);
    await desk.locator('#obs-setup').evaluate(el => el.open = true);
    await desk.locator('#password').fill('test-only'); await desk.locator('#connect').click();
    await desk.waitForFunction(() => document.getElementById('record-state').textContent.startsWith('RECORDING'));
    await page.keyboard.press('s');
    await desk.waitForFunction(() => document.getElementById('record-state').textContent.startsWith('STOPPED'));
    await page.waitForFunction(() => !window.planeirPresenter.take.controlled);
    assert.equal(await page.evaluate(() => window.planeirPresenter.take.snapshot().status), 'completed');
    assert.equal(await page.locator('.presenter-setup').isVisible(), false);
    const download = page.waitForEvent('download'); await desk.locator('#download').click(); await (await download).saveAs(`${dir}/controlled-take.zip`);
    await desk.waitForFunction(() => document.getElementById('take-state').textContent.includes('downloaded'));
    // Do not silently take ownership of an existing recording.
    await desk.evaluate(() => window.mockOBS.active = true);
    await desk.waitForFunction(() => document.getElementById('record-state').textContent.startsWith('RECORDING'));
    assert.equal(await desk.locator('#record').isDisabled(), true);
    await desk.locator('#stop').click();
    await desk.waitForFunction(() => document.getElementById('record-state').textContent.startsWith('STOPPED'));
    assert.equal(await page.evaluate(() => window.planeirPresenter.take.snapshot().status), 'completed');
    // Stop remains usable during the countdown, without showing output controls.
    await desk.locator('#ready').check(); await desk.locator('#record').click();
    await page.waitForFunction(() => window.planeirPresenter.take.countingDown);
    await desk.locator('#stop').click();
    await page.waitForFunction(() => !window.planeirPresenter.take.controlled);
    assert.equal(await page.evaluate(() => window.planeirPresenter.take.snapshot().status), 'cancelled');
    assert.equal(await page.locator('.presenter-sync-slate').isVisible(), false);
    const abortedDownload = page.waitForEvent('download'); await desk.locator('#download').click(); await abortedDownload;
    await desk.waitForFunction(() => document.getElementById('take-state').textContent.includes('downloaded'));
    // An external pause/stop is labelled interrupted rather than a normal take.
    await desk.locator('#ready').check(); await desk.locator('#record').click();
    await page.waitForFunction(() => window.planeirPresenter.take.active && !window.planeirPresenter.take.countingDown);
    await desk.evaluate(() => window.mockOBS.paused = true);
    await page.waitForFunction(() => window.planeirPresenter.take.snapshot().events.some(e => e.type === 'capture-warning'));
    await desk.evaluate(() => { window.mockOBS.active = false; window.mockOBS.paused = false; });
    await page.waitForFunction(() => !window.planeirPresenter.take.controlled);
    assert.equal(await page.evaluate(() => window.planeirPresenter.take.snapshot().status), 'interrupted');
    const interruptedDownload = page.waitForEvent('download'); await desk.locator('#download').click(); await interruptedDownload;
    await desk.waitForFunction(() => document.getElementById('take-state').textContent.includes('downloaded'));
    // A failed OBS start does not leave a fake recording indicator or a stuck take.
    await desk.evaluate(() => window.mockOBS.failStart = true);
    await desk.locator('#ready').check(); await desk.locator('#record').click();
    await desk.waitForFunction(() => document.getElementById('error').textContent.includes('Simulated OBS failure'));
    assert.equal(await page.evaluate(() => window.planeirPresenter.take.controlled), false);
    assert.match(await desk.locator('#record-state').innerText(), /^STOPPED/);
    await desk.screenshot({ path: `${dir}/controls.png`, fullPage: true });
    await page.screenshot({ path: `${dir}/clean-presentation.png` });
    await desk.locator('#exit').click(); await page.waitForFunction(() => !window.planeirPresenter.state().active);
    assert.equal(await page.evaluate(() => JSON.stringify(window.planeirPresenter.discover())), source.case);
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage })), source.storage);
    assert.ok(cleanChecks >= 2); assert.deepEqual(errors, []);
    console.log('Interactive presenter + separate OBS controls passed: hover, timing restoration, isolation, nonce rejection, clean start, confirmed status, stop failure, disconnect/reconnect, S stop, ZIP, existing recording, countdown stop, pause/external stop, failed start. No physical recorder used.');
  } finally { for (const context of browser.contexts()) await context.close(); await browser.close(); }
}
