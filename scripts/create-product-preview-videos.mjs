import assert from 'node:assert/strict';
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { startPreviewServer } from './lib/preview-server.mjs';
import { balanceSheetCases, mortgageComparison } from '../dev/product-preview-fixtures.js';
import { newModulePreviews } from '../dev/new-module-preview-fixtures.js';
import { computeFutureCostFundProjection } from '../js/future_cost_fund_math.js';
import { computeHouseholdCashFlowProjection } from '../js/household_cash_flow_math.js';
import { computeProtectionGapProjection } from '../js/protection_gap_math.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'assets/examples');
const review = resolve(root, '.worker-dry-run/product-previews');
const layoutOnly = process.argv.includes('--layout-only');
const selectedKind = process.argv.find(value => value.startsWith('--module='))?.split('=')[1];
if (selectedKind && !['mortgage', 'balance-sheet', 'future-cost-fund', 'household-cash-flow', 'protection-gap'].includes(selectedKind)) throw new Error('Unknown preview module.');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const fps = 30;
const manifestTarget = process.env.PREVIEW_MANIFEST_TARGET || resolve(output, 'product-preview-manifest.json');
await mkdir(output, { recursive: true }); await mkdir(review, { recursive: true });
for (const item of balanceSheetCases) {
  assert.equal(item.result.netWorth, 735000);
  assert.equal(item.result.reconciliationDifference, 0);
}
assert.equal(balanceSheetCases[1].result.spendableReserves, 215000);
assert.equal(balanceSheetCases[2].result.totalLiabilities, 100000);
assert.ok(mortgageComparison.cases.length === 3);

// The captions name these results. Refuse to encode them if a later engine or
// assumption change means the fictional examples no longer support the words.
const sourceChecks = {
  'future-cost-fund': () => {
    const inputs = newModulePreviews['future-cost-fund'].generated.futureCostFundInputs;
    const rows = computeFutureCostFundProjection(inputs).outputsTable.rows;
    assert.deepEqual(rows.map(row => [row[1], row[2], row[6]]), [[86100,0,87200],[0,10800,87200],[43000,5400,87200],[0,17300,87200]]);
  },
  'household-cash-flow': () => {
    const inputs = newModulePreviews['household-cash-flow'].generated.householdCashFlowInputs;
    const rows = computeHouseholdCashFlowProjection(inputs).outputsTable.rows;
    assert.deepEqual(rows.map(row => [row[1],row[2],row[4]]), [[44800,0,9200],[44800,0,15200],[40800,10000,3200],[40800,10000,9200]]);
  },
  'protection-gap': () => {
    const inputs = newModulePreviews['protection-gap'].generated.protectionGapInputs;
    const rows = computeProtectionGapProjection(inputs).outputsTable.rows;
    assert.deepEqual(rows.map(row => [row[1],row[3],row[5]]), [[102000,0,'Not needed'],[58000,38000,19],[70000,26000,28],[58500,1500,'Beyond three years']]);
  }
};
for (const [kind, check] of Object.entries(sourceChecks)) if (!selectedKind || selectedKind === kind) check();
if (process.argv.includes('--verify-source-only')) {
  console.log('Preview captions match the current engine outputs for all selected fictional examples.');
  process.exit(0);
}

const storyboards = {
  'future-cost-fund': {seconds:18,opening:'€15,000 a year today: fees, accommodation and living costs.',events:[
    {at:3.6,index:0,caption:'Set the money aside now: about €86,100 as a lump sum.'},
    {at:7.8,index:2,caption:'Or combine €43,000 today with €5,400 a year.'},
    {at:12,index:3,caption:'Wait three years and the yearly amount rises to €17,300.'},
    {at:16,caption:'The college cost stays the same. The saving path changes.'}]},
  'household-cash-flow': {seconds:18,opening:'After the year’s bills and estimated tax: €9,200 left over.',events:[
    {at:3.6,index:1,caption:'Clear the car loan from savings: €6,000 less goes out each year.'},
    {at:7.8,index:2,caption:'Add €10,000 to pensions: the net yearly cash cost is €6,000.'},
    {at:12,index:3,caption:'Do both: the same €9,200 surplus, with different choices.'},
    {at:16,caption:'Compare the yearly cash effect of each choice.'}]},
  'protection-gap': {seconds:18,opening:'Two take-home incomes. €60,000 in savings. What if one stopped?',events:[
    {at:3.6,index:1,caption:'If Maeve cannot work: a €38,000 yearly gap; savings last 19 months.'},
    {at:7.8,index:2,caption:'If Finn cannot work: a €26,000 gap; savings last 28 months.'},
    {at:12,index:3,caption:'If Maeve died: changed costs leave a €1,500 yearly gap.'},
    {at:16,caption:'State payments and the lower costs shown are illustrative assumptions.'}]},
  mortgage: { seconds: 14, opening: 'See what extra repayments change.', events: [
    { at: 3.2, index: 1, caption: 'A lump sum brings the finish date closer and reduces interest.' },
    { at: 7.6, index: 2, caption: 'Compare regular overpayments with the same starting mortgage.' },
    { at: 11.5, caption: 'See the effect of regular overpayments on the mortgage.' }
  ] },
  'balance-sheet': { seconds: 18, opening: 'See where your assets are held and what you owe.', events: [
    { at: 3.6, index: 1, caption: 'The property sale clears its loan. The remaining proceeds become cash.' },
    { at: 8.8, index: 2, caption: 'Use €100,000 of that cash to reduce the home mortgage.' },
    { at: 14.2, caption: 'The same net worth, with less debt and more money in cash.' }
  ] }
};
const smooth = value => value * value * (3 - 2 * value);
const server = await startPreviewServer(root);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
async function runEncoder(args) {
  const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  let error = ''; child.stderr.on('data', data => { error += data; });
  const [code] = await once(child, 'close');
  if (code !== 0) throw new Error(error || `Encoder exited ${code}`);
}
const previous = selectedKind ? JSON.parse(await readFile(resolve(output, 'product-preview-manifest.json'), 'utf8')) : null;
const manifest = { fictionalFigures: true, fps, clips: previous?.clips.filter(item => item.kind !== selectedKind) || [] };
try {
  for (const kind of selectedKind ? [selectedKind] : Object.keys(storyboards)) {
    for (const [size, viewport] of [['desktop', { width: 960, height: 720 }], ['mobile', { width: 480, height: 860 }]]) {
      const stem = `${kind}-preview-${size}`;
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1.5, reducedMotion: 'no-preference' });
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${server.origin}/dev/product-preview.html?module=${kind}`);
      await page.waitForSelector('body[data-ready="true"]');
      const firstCase = await page.evaluate(() => window.previewCapture.selected());
      const caseCount = await page.evaluate(() => window.previewCapture.cases().length);
      if (kind !== 'mortgage' && kind !== 'balance-sheet') {
        for (let index = 0; index < caseCount; index++) {
          await page.evaluate(index => window.previewCapture.clickCase(index), index);
          await page.waitForTimeout(700);
          const selected = await page.evaluate(() => window.previewCapture.selected());
          await page.screenshot({ path: `${review}/${stem}-case-${selected}.png` });
          const bounds = await page.evaluate(() => {
            const host = document.getElementById('module');
            const outer = host.getBoundingClientRect();
            const nodes = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
            const clipped = [];
            while (nodes.nextNode()) {
              const node = nodes.currentNode;
              if (!node.textContent.trim()) continue;
              const range = document.createRange(); range.selectNodeContents(node);
              const rect = range.getBoundingClientRect();
              if (rect.width && rect.height && (rect.left < outer.left - 2 || rect.right > outer.right + 2 || rect.top < outer.top - 2 || rect.bottom > outer.bottom + 2)) clipped.push(node.textContent.trim());
              if (rect.width && rect.height && node.parentElement.classList.contains('fcf-block') && node.parentElement.scrollWidth > node.parentElement.clientWidth) clipped.push('cost block: ' + node.textContent.trim());
            }
            const stage = document.getElementById('stage').getBoundingClientRect();
            return { clipped, scrollHeight: host.scrollHeight, height: host.clientHeight, top: stage.top, bottom: stage.bottom, viewportHeight: innerHeight };
          });
          console.log(`${stem} / ${selected}: ${JSON.stringify(bounds)}`);
          assert.deepEqual(bounds.clipped, [], `${stem} clips visible words in ${selected}`);
          assert.ok(bounds.scrollHeight <= bounds.height + 1, `${stem} overflows in ${selected}`);
          assert.ok(bounds.top >= -1 && bounds.bottom <= bounds.viewportHeight + 1, `${stem} scrolls the filming frame`);
        }
        await page.evaluate(id => {
          const index = window.previewCapture.cases().indexOf(id);
          window.previewCapture.clickCase(index);
        }, firstCase);
        await page.waitForTimeout(700);
      }
      const layout = await page.evaluate(() => ({
        contentHeight: document.querySelector('#module').scrollHeight,
        availableHeight: document.querySelector('#module').clientHeight,
        width: document.documentElement.scrollWidth,
        selected: window.previewCapture.selected(),
        blocks: [...document.querySelector('#module').children[0].children].map(node => ({ className: node.className, height: Math.round(node.getBoundingClientRect().height) }))
      }));
      await page.screenshot({ path: `${review}/${stem}-layout.png` });
      console.log(`${stem} layout: ${JSON.stringify(layout)}`);
      if (layoutOnly) { await context.close(); continue; }
      assert.equal(layout.width, viewport.width, `${stem} horizontal overflow`);
      assert.ok(layout.contentHeight <= layout.availableHeight + 1, `${stem} cuts off content: ${layout.contentHeight} > ${layout.availableHeight}`);
      const story = storyboards[kind];
      await page.evaluate(text=>window.previewCapture.setCaption(text),story.opening);
      await page.clock.install();
      await page.clock.pauseAt(new Date(Date.now() + 200));
      const targets = await page.evaluate(() => Array.from({ length: window.previewCapture.cases().length }, (_, index) => window.previewCapture.buttonRect(index)));
      const videoPath = resolve(output, `${stem}.mp4`);
      const encoder = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-', '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath]);
      let encoderError = ''; encoder.stderr.on('data', data => { encoderError += data; });
      const encoderDone = once(encoder, 'close');
      let eventIndex = 0;
      const parking = { x: viewport.width - 50, y: viewport.height - 80 };
      const snapshots = new Set([0, ...story.events.flatMap(event => [Math.round(event.at * fps), Math.round((event.at + .35) * fps), Math.round((event.at + 1.2) * fps)]), story.seconds * fps - 1]);
      for (let frame = 0; frame < story.seconds * fps; frame++) {
        if (frame % 90 === 0) console.log(`${stem}: rendering second ${frame / fps} of ${story.seconds}`);
        const time = frame / fps;
        while (eventIndex < story.events.length && time >= story.events[eventIndex].at) {
          const event = story.events[eventIndex++];
          await page.evaluate(event => { if (Number.isInteger(event.index)) window.previewCapture.clickCase(event.index); window.previewCapture.setCaption(event.caption); }, event);
        }
        let cursor = parking, visible = false, click = null;
        const event = story.events.find(event => Number.isInteger(event.index) && time >= event.at - .8 && time <= event.at + 1.3);
        if (event) {
          const target = targets[event.index];
          const approach = time < event.at;
          const progress = approach ? smooth(Math.max(0, (time - event.at + .8) / .8)) : time <= event.at + .45 ? 1 : 1 - smooth(Math.min(1, (time - event.at - .45) / .85));
          cursor = { x: parking.x + (target.x - parking.x) * progress, y: parking.y + (target.y - parking.y) * progress };
          visible = true;
          if (time >= event.at && time < event.at + .4) click = { ...target, progress: (time - event.at) / .4 };
        }
        await page.evaluate(({ cursor, visible, click, time }) => {
          window.previewCapture.moveCursor(cursor.x, cursor.y, visible);
          window.previewCapture.showClick(click?.x || 0, click?.y || 0, click?.progress ?? 1);
          // Native JS motion uses Playwright's virtual clock. Freeze and seek CSS
          // motion as well, so a busy encoder cannot change the captured pacing.
          window.__captureAnimationStarts ||= new WeakMap();
          for (const animation of document.getAnimations()) {
            if (!window.__captureAnimationStarts.has(animation)) window.__captureAnimationStarts.set(animation, time * 1000 - Number(animation.currentTime || 0));
            animation.pause(); animation.currentTime = time * 1000 - window.__captureAnimationStarts.get(animation);
          }
          window.previewCapture.polishFrame();
        }, { cursor, visible, click, time });
        const buffer = await page.screenshot({ type: 'png' });
        if (!encoder.stdin.write(buffer)) await once(encoder.stdin, 'drain');
        if (snapshots.has(frame)) await writeFile(`${review}/${stem}-${String(frame).padStart(4, '0')}.png`, buffer);
        await page.clock.runFor(1000 / fps);
      }
      encoder.stdin.end();
      const [code] = await encoderDone;
      if (code !== 0) throw new Error(encoderError || 'Frame encoding failed');
      assert.deepEqual(errors, [], `${stem} browser errors`);
      await runEncoder(['-i', videoPath, '-an', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-deadline', 'good', '-cpu-used', '2', resolve(output, `${stem}.webm`)]);
      await runEncoder(['-sseof', '-0.04', '-i', videoPath, '-frames:v', '1', '-update', '1', resolve(output, `${stem}-poster.png`)]);
      const entry = { kind, size, seconds: story.seconds, width: viewport.width * 1.5, height: viewport.height * 1.5, mp4Bytes: (await stat(videoPath)).size, webmBytes: (await stat(resolve(output, `${stem}.webm`))).size };
      manifest.clips.push(entry);
      console.log(`Created ${stem}: ${JSON.stringify(entry)}`);
      await context.close();
    }
  }
  if (!layoutOnly) {
    await writeFile(manifestTarget, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Completed the selected preview exports. Review frames: ${review}`);
  }
} finally { await browser.close(); await server.close(); }
