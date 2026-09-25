import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

export async function checkPresenterLoading(source = 'private/aam-makeovers/presenter-regression') {
  const directory = 'private/aam-makeovers/presenter-loading-regression';
  await fs.mkdir(directory, { recursive: true });
  const html = await fs.readFile(path.join(source, 'index.html'), 'utf8');
  const bootstrap = (await fs.readFile(path.join(source, 'preview.js'), 'utf8'))
    .replace(/window\.planeirPresenter\.load\([^\n]+\n/, '')
    .replace('await window.planeirPresenter.start();', 'window.presenterLoadingReady = true;');
  await fs.writeFile(path.join(directory, 'index.html'), html);
  await fs.writeFile(path.join(directory, 'preview.js'), bootstrap);
  await fs.copyFile(path.join(source, 'session.json'), path.join(directory, 'session.json'));
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${process.env.PRESENTER_BASE_URL || 'http://127.0.0.1:8788'}/${directory}/`);
    await page.waitForFunction(() => window.presenterLoadingReady);
    await page.getByRole('button', { name: 'Presenter Mode', exact: true }).click();
    const start = page.getByRole('button', { name: 'Start preview', exact: true });
    const json = page.locator('.presenter-package-file'), script = page.locator('.presenter-script-file');
    assert.equal(await start.isEnabled(), false);
    assert.match(await page.evaluate(() => window.planeirPresenter.start().catch(e => e.message)), /Both files are required/);
    await json.setInputFiles(path.join(source, 'presentation.json'));
    assert.equal(await start.isEnabled(), false);
    assert.match(await page.locator('.presenter-message').innerText(), /Now choose script.md/);
    await page.screenshot({ path: `${directory}/script-needed.png` });
    await script.setInputFiles(path.join(source, 'script.md'));
    await page.waitForFunction(() => window.planeirPresenter.state().loaded);
    assert.equal(await start.isEnabled(), true);
    const count = await page.evaluate(() => window.planeirPresenter.state().count);
    await page.screenshot({ path: `${directory}/ready.png` });
    await start.click();
    await page.waitForFunction(() => window.planeirPresenter.state().active && !window.planeirPresenter.state().busy);
    await page.keyboard.press('ArrowRight'); await page.waitForFunction(() => !window.planeirPresenter.state().busy);
    assert.equal(await page.evaluate(() => window.planeirPresenter.state().index), 0);
    await page.evaluate(() => window.planeirPresenter.exit());
    // An invalid replacement must not silently leave the old presentation ready.
    await json.setInputFiles({ name: 'presentation.json', mimeType: 'application/json', buffer: Buffer.from('{') });
    await page.waitForFunction(() => document.querySelector('.presenter-message').textContent.includes('not valid JSON'));
    assert.equal(await start.isEnabled(), false); assert.equal(await page.evaluate(() => window.planeirPresenter.state().loaded), false);
    await json.setInputFiles([path.join(source, 'presentation.json'), path.join(source, 'script.md')]);
    await page.waitForFunction(() => window.planeirPresenter.state().loaded);
    assert.equal(await start.isEnabled(), true);
    await script.setInputFiles({ name: 'script-presenter.md', mimeType: 'text/markdown', buffer: Buffer.from('Wrong reading copy') });
    assert.equal(await start.isEnabled(), false);
    assert.match(await page.locator('.presenter-message').innerText(), /reading copy/);
    await script.setInputFiles({ name: 'script.md', mimeType: 'text/markdown', buffer: Buffer.from('Edited script') });
    await page.waitForFunction(() => document.querySelector('.presenter-message').textContent.includes('script has changed'));
    assert.equal(await start.isEnabled(), false);
    await script.setInputFiles(path.join(source, 'script.md'));
    await page.waitForFunction(() => window.planeirPresenter.state().loaded);
    assert.equal(await page.evaluate(() => window.planeirPresenter.state().count), count);
    // Programmatic invalid loads clear the old compiled package too.
    assert.match(await page.evaluate(() => { try { window.planeirPresenter.load(null, ''); } catch (e) { return e.message; } }), /must be an object/);
    assert.equal(await start.isEnabled(), false);
    await json.setInputFiles([]);
    await json.setInputFiles([path.join(source, 'presentation.json'), path.join(source, 'script.md')]);
    await page.waitForFunction(() => window.planeirPresenter.state().loaded);
    assert.deepEqual(errors, []);
    await fs.writeFile(`${directory}/validation.json`, JSON.stringify({ status: 'passed', source, count, checks: ['missing-file guidance and start guard', 'separate file selection', 'both files in one selection', 'preview and first cue', 'invalid replacement clears stale package', 'annotated script rejected', 'script mismatch rejected', 'corrected files recover', 'programmatic invalid load clears stale package'] }, null, 2));
    console.log(`Presenter loading passed: ${count} beats, separate/together selection, guarded start, stale-package prevention and recovery.`);
  } finally { await browser.close(); }
}
