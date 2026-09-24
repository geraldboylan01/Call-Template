import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function checkPresenterDesign(dir = 'private/aam-makeovers/presenter-regression') {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'no-preference' });
    await page.bringToFront();
    let phase = 'open';
    const mark = value => { phase = value; console.log('Design check:', phase); };
    const evaluate = async (fn, arg) => {
      let timer;
      try { return await Promise.race([page.evaluate(fn, arg), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out during ' + phase)), 20000); })]); }
      finally { clearTimeout(timer); }
    };
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:8788/${dir}/`);
    await page.waitForFunction(() => window.planeirPresenter?.state().active && !window.planeirPresenter.state().busy);
    mark('load treatments');
    const selected = await evaluate(async () => {
      const pkg = await (await fetch('presentation.json')).json();
      const cat = window.planeirPresenter.discover();
      const target = op => cat.targets.find(t => t.id === op?.target);
      const indices = {};
      for (const [i, step] of pkg.steps.entries()) {
        const op = step.operations.at(-1);
        if (op.action === 'focus') {
          const kind = target(op).ref.type;
          const emphasis = op.emphasis || (kind === 'chart-point' ? 'point' : kind === 'pbs-row' ? 'underline' : 'spotlight');
          op.emphasis = emphasis;
          indices[emphasis] ??= i;
        } else if (op.action === 'frame' || op.action === 'reset') indices.frame = i;
      }
      await window.planeirPresenter.exit(); document.querySelector('.presenter-setup').close();
      window.planeirPresenter.load(pkg, await (await fetch('script.md')).text());
      await window.planeirPresenter.start();
      return indices;
    });
    const out = path.join(dir, 'design-review'); await fs.mkdir(out, { recursive: true });
    for (const treatment of ['underline', 'spotlight', 'point']) {
      mark(treatment);
      assert.ok(Number.isInteger(selected[treatment]), `Fixture needs ${treatment}`);
      await evaluate(i => window.planeirPresenter.goTo(i), selected[treatment]);
      const view = await page.locator('.presenter-attention').evaluate(el => ({ treatment: el.dataset.treatment, opacity: getComputedStyle(el).opacity, pointerEvents: getComputedStyle(el).pointerEvents }));
      assert.equal(view.treatment, treatment); assert.equal(view.opacity, '1'); assert.equal(view.pointerEvents, 'none');
      await page.screenshot({ path: path.join(out, `${treatment}.png`) });
    }
    mark('resize alignment');
    // A point annotation must stay on the actual data point after resizing.
    for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(650);
      const offset = await evaluate(() => {
        const block = document.querySelector('.presenter-focus');
        const canvas = block.querySelector('canvas[data-chart-key]');
        const chart = Chart.getChart(canvas) || [...document.querySelectorAll('.callcanvas-chart-overlay-canvas')].map(c => Chart.getChart(c)).find(c => c?.getActiveElements().length);
        const active = chart.getActiveElements()[0];
        const r = chart.canvas.getBoundingClientRect();
        const h = document.querySelector('.presenter-point-halo').getBoundingClientRect();
        return { x: Math.abs(h.left + h.width / 2 - (r.left + active.element.x * r.width / chart.width)), y: Math.abs(h.top + h.height / 2 - (r.top + active.element.y * r.height / chart.height)) };
      });
      assert.ok(offset.x < 2 && offset.y < 2, `Chart marker drift: ${JSON.stringify(offset)}`);
    }
    mark('temporary wide view');
    const original = await evaluate(() => ({ state: window.planeirPresenter.state(), scroll: document.querySelector('.focused-module-card').scrollTop }));
    await page.keyboard.down('ArrowUp'); await page.waitForTimeout(380);
    assert.equal(await page.locator('.presenter-attention').evaluate(el => getComputedStyle(el).opacity), '0');
    await page.keyboard.up('ArrowUp'); await page.waitForTimeout(380);
    assert.equal(await page.locator('.presenter-attention').evaluate(el => getComputedStyle(el).opacity), '1');
    assert.equal(await evaluate(() => document.querySelector('.focused-module-card').scrollTop), original.scroll);
    assert.equal(await evaluate(() => window.planeirPresenter.state().index), original.state.index);
    // Sample the actual scrolling helper: arrival must be gradual and monotonic.
    mark('scroll interpolation');
    const motion = await evaluate(async () => {
      const { glideTo } = await import('/js/presenter_attention.js');
      const root = document.querySelector('.focused-module-card'); root.scrollTop = Math.min(800, root.scrollHeight - root.clientHeight);
      const values = [root.scrollTop]; let done = false;
      const moving = glideTo(root, 0).then(() => { done = true; });
      while (!done) { await new Promise(requestAnimationFrame); values.push(root.scrollTop); }
      await moving; return values;
    });
    assert.ok(new Set(motion).size >= 4, 'Scroll should have intermediate positions');
    assert.ok(motion.every((n, i) => i === 0 || n <= motion[i - 1])); assert.equal(motion.at(-1), 0);
    mark('frame cleanup');
    await evaluate(i => window.planeirPresenter.goTo(i), selected.frame);
    await page.waitForTimeout(380);
    assert.equal(await page.locator('.presenter-attention').evaluate(el => getComputedStyle(el).opacity), '0');
    mark('fallback');
    // Fallback for browsers without native view transitions and reduced motion.
    await evaluate(() => { document.startViewTransition = undefined; });
    await evaluate(() => window.planeirPresenter.goTo(0));
    mark('reduced motion');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await evaluate(i => window.planeirPresenter.goTo(i), selected.point);
    const quiet = await evaluate(async () => {
      const { glideTo } = await import('/js/presenter_attention.js');
      const root = document.querySelector('.focused-module-card'); await glideTo(root, 0);
      return { top: root.scrollTop, transition: getComputedStyle(document.querySelector('.presenter-attention')).transitionDuration };
    });
    assert.equal(quiet.top, 0); assert.ok(parseFloat(quiet.transition) <= .001, 'Reduced motion must not animate the light');
    await evaluate(() => window.planeirPresenter.exit());
    assert.equal(await page.locator('.presenter-attention.is-visible').count(), 0);
    assert.equal(await page.locator('.presenter-focus').count(), 0);
    assert.deepEqual(errors, []);
    const result = { status: 'passed', checks: ['three attention treatments', 'native scene transitions without timeout', 'chart marker alignment after resize', 'UP restores focus', 'monotonic eased scrolling', 'FRAME clears emphasis', 'non-native fallback', 'reduced motion', 'exit cleanup'], screenshots: out };
    await fs.writeFile(path.join(dir, 'validation-design.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
}
