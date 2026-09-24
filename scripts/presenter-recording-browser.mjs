import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

export async function checkPresenterRecording() {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] });
  const dir = 'private/aam-makeovers/presenter-recording-regression'; await fs.mkdir(dir, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce', acceptDownloads: true });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${process.env.PRESENTER_BASE_URL || 'http://127.0.0.1:8788'}/private/aam-makeovers/presenter-regression/`);
    await page.waitForFunction(() => window.planeirPresenter?.state().active && !window.planeirPresenter.state().busy);
    const original = await page.evaluate(() => ({ catalogue: JSON.stringify(window.planeirPresenter.discover()), storage: JSON.stringify({ ...localStorage }) }));
    await page.keyboard.press('c');
    await page.locator('.presenter-capture-confirm').check();
    assert.match(await page.evaluate(() => window.planeirPresenter.take.start().catch(e => e.message)), /validation/);
    await page.locator('.presenter-setup').evaluate(el => el.close());
    console.log('Validating recording fixture');
    assert.equal((await page.evaluate(() => window.planeirPresenter.validateLive())).status, 'passed');
    await page.keyboard.press('c');
    await page.getByRole('button', { name: 'Start clean take', exact: true }).click();
    await page.waitForFunction(() => window.planeirPresenter.take.countingDown);
    await page.keyboard.press('ArrowRight'); assert.equal(await page.evaluate(() => window.planeirPresenter.state().index), -1);
    await page.waitForFunction(() => window.planeirPresenter.take.active && !window.planeirPresenter.take.countingDown);
    assert.equal(await page.locator('.presenter-hud').isVisible(), false);
    await page.keyboard.press('h'); assert.equal(await page.locator('.presenter-hud').isVisible(), false);
    assert.equal(await page.locator('.presenter-camera').isVisible(), false);
    assert.equal(await page.locator('.presenter-emergency-stop').isVisible(), false);
    assert.match(await page.evaluate(() => window.planeirPresenter.validateLive().catch(e => e.message)), /Finish the take/);
    for (const key of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowRight']) {
      await page.keyboard.press(key); await page.waitForFunction(() => !window.planeirPresenter.state().busy);
    }
    await page.keyboard.press('m');
    await page.screenshot({ path: `${dir}/clean-view.png` });
    await page.keyboard.press('c'); assert.equal(await page.locator('.presenter-setup').isVisible(), true);
    await page.getByRole('button', { name: 'Close controls', exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForFunction(() => window.planeirPresenter.take.snapshot().events.some(e => e.type === 'viewport-changed'));
    await page.keyboard.press('s');
    const take = await page.evaluate(() => window.planeirPresenter.take.snapshot());
    assert.equal(take.status, 'completed');
    assert.equal(take.events.filter(e => e.type === 'requested').length, 4);
    assert.equal(take.events.filter(e => e.type === 'arrived').length, 4);
    assert.ok(take.events.some(e => e.type === 'retake'));
    assert.ok(take.events.some(e => e.type === 'controls-opened'));
    assert.equal(take.events[0].type, 'sync'); assert.equal(take.events[0].elapsedMs, 0);
    for (let i = 1; i < take.events.length; i++) assert.ok(take.events[i].elapsedMs >= take.events[i - 1].elapsedMs);
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download edit package', exact: true }).click();
    const download = await downloadEvent; const zip = `${dir}/test-take.zip`; await download.saveAs(zip);
    execFileSync('/usr/bin/unzip', ['-t', zip]);
    assert.match(execFileSync('/usr/bin/unzip', ['-p', zip, 'script-timed.md'], { encoding: 'utf8' }), /backward/);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(100);
    await page.locator('.presenter-capture-confirm').check();
    await page.getByRole('button', { name: 'Start clean take', exact: true }).click();
    await page.waitForFunction(() => window.planeirPresenter.take.active && !window.planeirPresenter.take.countingDown);
    await page.keyboard.press('ArrowRight'); await page.waitForFunction(() => !window.planeirPresenter.state().busy);
    page.on('dialog', d => d.accept());
    await page.reload();
    await page.waitForFunction(() => window.planeirPresenter?.state().active && !window.planeirPresenter.state().busy);
    const recovered = await page.evaluate(() => window.planeirPresenter.take.snapshot());
    assert.equal(recovered.status, 'interrupted'); assert.ok(recovered.events.some(e => e.type === 'arrived'));
    assert.equal(await page.evaluate(() => window.planeirPresenter.take.active), false);
    await page.evaluate(() => window.planeirPresenter.exit());
    assert.equal(await page.evaluate(() => JSON.stringify(window.planeirPresenter.discover())), original.catalogue);
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage })), original.storage);
    await page.goto(`${process.env.PRESENTER_BASE_URL || 'http://127.0.0.1:8788'}/app/recording.html`);
    await page.screenshot({ path: `${dir}/guide.png`, fullPage: true });
    assert.equal(await page.locator('h1').innerText(), 'Record Planéir and yourself, then choose the picture');
    assert.deepEqual(errors, []);
    await fs.writeFile(`${dir}/validation.json`, JSON.stringify({ status: 'passed', checks: ['validation gate', 'countdown does not consume cue', 'clean 1920 view', 'hidden HUD/camera/cursor controls', 'validation blocked during take', 'four paired moves with backward visit', 'retake and controls markers', 'resize flag', 'S finishes log', 'downloaded ZIP integrity', 'reload recovery', 'original case and financial storage unchanged', 'guide renders'], physicalCaptureTested: false }, null, 2));
    console.log('Clean recording browser checks passed; no physical devices used.');
  } finally { await browser.close(); }
}
