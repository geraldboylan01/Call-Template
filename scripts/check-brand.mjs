import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBrandAssets, CANONICAL_ASSET_PATHS, GENERATED_ASSET_PATHS } from './generate-planeir-brand-assets.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEPLOYED_HTML = [
  'index.html', 'session.html', 'app/index.html', 'app/session.html',
  'app/clients.html', 'app/analytics.html', 'app/modules.html', 'app/access.html',
  'app/leads.html', 'app/video.html', 'plan/index.html', 'plan/privacy.html'
];
const RETIRED = [
  'js/planeir_harp_artwork.js', 'js/success_harp_resonance.js',
  'assets/brand/planeir-harp-light.svg', 'assets/brand/planeir-wordmark-no-harp-light.svg'
];
const OLD_MARKERS = /planeir_harp_artwork|success_harp_resonance|data-planeir-harp|lead-success-harp|SuccessGhost/;

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? filesIn(resolve(directory, entry.name)) : resolve(directory, entry.name)))).flat();
}

async function verifyBrand({ dist = false } = {}) {
  if (!dist) await generateBrandAssets({ root: ROOT, check: true });
  const base = dist ? resolve(ROOT, 'dist') : ROOT;
  for (const file of [...CANONICAL_ASSET_PATHS, ...GENERATED_ASSET_PATHS]) {
    await access(resolve(base, file));
  }
  for (const file of RETIRED) {
    await assert.rejects(access(resolve(base, file)), { code: 'ENOENT' }, `Retired asset is still published: ${file}`);
  }
  let headerCount = 0;
  for (const file of DEPLOYED_HTML) {
    const html = await readFile(resolve(base, file), 'utf8');
    assert.ok(!OLD_MARKERS.test(html), `${file} still contains obsolete brand markup.`);
    assert.ok(!html.includes('planeir-wordmark-light.svg'), `${file} uses a compatibility URL internally.`);
    for (const name of ['favicon.svg', 'favicon-32.png', 'favicon.ico', 'apple-touch-icon.png']) {
      assert.ok(html.includes(name), `${file} omits ${name}.`);
    }
    assert.match(html, /sizes="32x32"/);
    assert.match(html, /sizes="180x180"/);
    if (html.includes('planeir-lockup-light.svg')) {
      headerCount += 1;
      if (file.startsWith('app/')) assert.ok(html.includes('js/brand_header.js'), `${file} omits responsive header sizing.`);
    }
    for (const [, url] of html.matchAll(/(?:src|href)="((?:\.\/|\.\.\/)[^"]+)"/g)) {
      const asset = url.split(/[?#]/)[0];
      if (!/\.(?:svg|png|ico|css|js)$/.test(asset)) continue;
      await access(resolve(base, dirname(file), asset));
      if (dist) assert.match(url, /[?&]v=/, `Unversioned deployed asset in ${file}: ${url}`);
    }
  }
  assert.equal(headerCount, 9, 'Expected exactly nine migrated header placements.');
  const landing = await readFile(resolve(base, 'index.html'), 'utf8');
  assert.equal(landing.split('https://planeir.ie/assets/brand/planeir-social-card-newgrange.png').length - 1, 2);
  for (const file of [...await filesIn(resolve(base, 'js')), ...await filesIn(resolve(base, 'assets/brand'))]) {
    if (!['.js', '.svg'].includes(extname(file))) continue;
    assert.ok(!OLD_MARKERS.test(await readFile(file, 'utf8')), `Retired brand implementation remains: ${file}`);
  }
  const mark = await readFile(resolve(base, 'assets/brand/planeir-mark.svg'), 'utf8');
  assert.ok(mark.includes('M106.07 33.44 A52 52 0 1 1 93.82 21.41 L81.21 39.43 A30 30 0 1 0 88.27 46.37 Z'));
  const lockup = await readFile(resolve(base, 'assets/brand/planeir-lockup.svg'), 'utf8');
  assert.ok(lockup.includes('translate(978 38) scale(0.90625)'));
  assert.ok(lockup.includes('viewBox="0 0 1330 384"'));
  if (!dist) {
    const worker = await readFile(resolve(ROOT, 'worker/src/index.js'), 'utf8');
    assert.ok(worker.includes('/assets/brand/planeir-social-card-newgrange.png'));
    assert.equal((worker.match(/\$\{buildPlaneirEmailCardHtml\(\)\}/g) || []).length, 5, 'All five email variants must retain shared branding.');
  }
  console.log(`Verified ${dist ? 'deployed' : 'source'} branding across 12 pages, 9 headers, and all exports.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyBrand({ dist: process.argv.includes('--dist') });
}
