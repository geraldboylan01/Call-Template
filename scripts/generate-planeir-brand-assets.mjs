/**
 * Deterministic Newgrange brand exports. The six handoff SVGs are canonical inputs;
 * every logo path and the tittle transform are copied verbatim, never redrawn.
 * Run normally to write outputs, or with --check to compare without writing.
 * Pinned resvg is development-only; all fixed copy is already outlined.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const require = createRequire(import.meta.url);
const RENDERER_VERSION = '2.6.2';
export const LIGHT = '#F4F8FC';
export const DARK = '#050A11';
const TILE = '#07131E';
export const CANONICAL_ASSET_PATHS = Object.freeze([
  'assets/brand/planeir-lockup.svg',
  'assets/brand/planeir-lockup-light.svg',
  'assets/brand/planeir-lockup-dark.svg',
  'assets/brand/planeir-mark.svg',
  'assets/brand/planeir-mark-light.svg',
  'assets/brand/planeir-wordmark-dotless.svg'
]);
const YOUTUBE_NAMES = [
  'planeir-youtube-bg-wordmark-top-left-url-bottom-left',
  'planeir-youtube-bg-wordmark-bottom-left',
  'planeir-youtube-bg-mirror-edit-wordmark-bottom-right-reversed'
];
export const GENERATED_ASSET_PATHS = Object.freeze([
  'js/planeir_brand_artwork.js',
  'favicon.svg', 'favicon.png', 'favicon-32.png', 'favicon.ico', 'apple-touch-icon.png',
  'assets/brand/planeir-app-icon-192.png', 'assets/brand/planeir-app-icon-512.png',
  'assets/brand/planeir-lockup-light.png', 'assets/brand/planeir-lockup-dark.png',
  'assets/brand/planeir-wordmark-light.svg', 'assets/brand/planeir-wordmark-dark.svg',
  'assets/brand/planeir-wordmark-light.png', 'assets/brand/planeir-wordmark-dark.png',
  'assets/brand/planeir-social-card-newgrange.svg',
  'assets/brand/planeir-social-card-newgrange.png', 'assets/brand/planeir-social-card.png',
  ...YOUTUBE_NAMES.flatMap((name) => [`assets/brand/youtube/${name}.svg`, `assets/brand/youtube/${name}.png`]),
  ...[300, 400, 512, 1024].map((size) => `assets/brand/zoom/planeir-wordmark-dark-square-${size}.png`),
  'Planeir_logo_transparent.png',
  'assets/brand/planeir-brand-manifest.json'
]);
const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const TEXT_PATH = 'scripts/brand/planeir-text-outlines.json';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const escapeXml = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const pathData = (source) => [...source.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((match) => match[1]);

function extractBrandArtwork(sources) {
  const lockup = sources['assets/brand/planeir-lockup.svg'];
  const [letterPath, ringPath, discPath] = pathData(lockup);
  const tittleTransform = lockup.match(/<g\b[^>]*data-planeir-mark="tittle"[^>]*transform="([^"]+)"/)?.[1];
  assert.equal(pathData(lockup).length, 3, 'Canonical lockup must have letters, ring, and central disc.');
  assert.ok(letterPath && ringPath && discPath && tittleTransform, 'Incomplete canonical Newgrange artwork.');
  for (const name of ['planeir-lockup-light.svg', 'planeir-lockup-dark.svg']) {
    const source = sources[`assets/brand/${name}`];
    assert.deepEqual(pathData(source), [letterPath, ringPath, discPath], `${name}: geometry differs from canonical lockup.`);
    assert.ok(source.includes(`transform="${tittleTransform}"`), `${name}: tittle transform differs.`);
  }
  for (const name of ['planeir-mark.svg', 'planeir-mark-light.svg']) {
    assert.deepEqual(pathData(sources[`assets/brand/${name}`]), [ringPath, discPath], `${name}: standalone mark geometry differs.`);
  }
  assert.deepEqual(pathData(sources['assets/brand/planeir-wordmark-dotless.svg']), [letterPath], 'Dotless letters differ from lockup.');
  return { letterPath, ringPath, discPath, tittleTransform };
}

function svg(width, height, label, content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(label)}" shape-rendering="geometricPrecision">\n${content}\n</svg>\n`;
}

function mark(art, color) {
  return `<path data-planeir-mark-ring="" fill="${color}" d="${art.ringPath}"/>\n<path data-planeir-mark-disc="" fill="${color}" d="${art.discPath}"/>`;
}

function lockup(art, color) {
  return `<path data-planeir-wordmark-letters="" fill="${color}" d="${art.letterPath}"/>\n<g data-planeir-mark="tittle" transform="${art.tittleTransform}">\n${mark(art, color)}\n</g>`;
}

function outlinedText(outlines, id, x, baseline, color, center = false) {
  const line = outlines.lines[id];
  assert.ok(line?.path && !/[<>]/.test(line.path), `Missing or invalid text outline: ${id}`);
  const origin = center ? x - line.bounds.x - line.bounds.width / 2 : x;
  return `<g aria-label="${escapeXml(line.text)}" transform="translate(${origin} ${baseline - outlines.baseline})"><path fill="${color}" d="${line.path}"/></g>`;
}

function socialCard(art, outlines) {
  return svg(1200, 630, 'Planeir — Irish financial education calls', `  <defs>
    <linearGradient id="socialBase" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#101A22"/><stop offset="0.6" stop-color="#192936"/><stop offset="1" stop-color="#163326"/></linearGradient>
    <radialGradient id="socialGlow" cx="85%" cy="15%" r="62%"><stop offset="0" stop-color="#477E64" stop-opacity="0.26"/><stop offset="1" stop-color="#477E64" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#socialBase)"/>
  <rect width="1200" height="630" fill="url(#socialGlow)"/>
  <rect x="32" y="32" width="1136" height="566" rx="30" fill="none" stroke="${LIGHT}" stroke-opacity="0.16"/>
  <g transform="translate(84 72) scale(0.412)">${lockup(art, LIGHT)}</g>
  ${outlinedText(outlines, 'headline', 84, 308, LIGHT)}
  ${outlinedText(outlines, 'headlineSecond', 84, 378, LIGHT)}
  ${outlinedText(outlines, 'description', 85, 443, '#BEC7D0')}
  ${outlinedText(outlines, 'disclaimer', 85, 535, '#BAC4CE')}
  <rect x="976" y="496" width="138" height="60" rx="30" fill="#143326" fill-opacity="0.4" stroke="#4B9968"/>
  ${outlinedText(outlines, 'url', 1045, 535, '#BCEBC9', true)}`);
}

function youtubeBackground(art, outlines, layout) {
  const positions = [
    'translate(96 92) scale(0.3157894736842105)',
    'translate(96 852) scale(0.3157894736842105)',
    // Intentional mirror: after an editor flips the complete video horizontally,
    // the wordmark (including its alignment mark) reads correctly at bottom left.
    'translate(1824 852) scale(-0.3157894736842105 0.3157894736842105)'
  ];
  const urlBadge = layout === 0 ? `
  <g transform="translate(96 910)">
    <rect width="168" height="58" rx="29" fill="#0B261D" opacity="0.55" stroke="#4BA66E" stroke-width="1.25"/>
    ${outlinedText(outlines, 'url', 84, 37, '#D8F2DF', true)}
  </g>` : '';
  return svg(1920, 1080, layout === 2 ? 'Planeir YouTube background — editing-only; flip back before publication' : 'Planeir YouTube background', `  <defs>
    <radialGradient id="softDepth" cx="72%" cy="20%" r="86%">
      <stop offset="0%" stop-color="#102235" stop-opacity="0.45"/>
      <stop offset="46%" stop-color="#091622" stop-opacity="0.82"/>
      <stop offset="100%" stop-color="#06111B" stop-opacity="1"/>
    </radialGradient>
    <linearGradient id="frameStroke" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#F3F8FF" stop-opacity="0.16"/>
      <stop offset="64%" stop-color="#F3F8FF" stop-opacity="0.07"/>
      <stop offset="100%" stop-color="#49A56D" stop-opacity="0.22"/>
    </linearGradient>
  </defs>
  <rect width="1920" height="1080" fill="#07131E"/>
  <rect width="1920" height="1080" fill="url(#softDepth)"/>
  <rect x="54" y="54" width="1812" height="972" rx="42" fill="none" stroke="url(#frameStroke)" stroke-width="1.5" opacity="0.62"/>
  <rect x="78" y="78" width="1764" height="924" rx="30" fill="none" stroke="#F3F8FF" stroke-width="1" opacity="0.035"/>
  <g transform="${positions[layout]}" opacity="0.9">${lockup(art, LIGHT)}</g>${urlBadge}`);
}

function renderPng(source, width) {
  assert.ok(!/<text\b|<image\b|(?:href|src)=/i.test(source), 'Exports must contain paths only, with no font or linked-image dependency.');
  return new Resvg(source, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: false },
    shapeRendering: 2,
    logLevel: 'off'
  }).render().asPng();
}

function createIco(frames) {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, bytes }, i) => {
    const entry = 6 + i * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bytes.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  });
  return Buffer.concat([header, ...frames.map((frame) => frame.bytes)]);
}

async function buildBrandAssets({ root = DEFAULT_ROOT } = {}) {
  const installedVersion = require('@resvg/resvg-js/package.json').version;
  assert.equal(installedVersion, RENDERER_VERSION, 'Renderer version drift: run npm ci using the committed lockfile.');
  const inputs = new Map(await Promise.all([...CANONICAL_ASSET_PATHS, TEXT_PATH].map(async (path) => [path, await readFile(resolve(root, path))])));
  const sources = Object.fromEntries([...inputs].map(([path, bytes]) => [path, bytes.toString('utf8')]));
  const art = extractBrandArtwork(sources);
  const outlines = JSON.parse(sources[TEXT_PATH]);
  const expectedCopy = {
    headline: 'Irish financial education', headlineSecond: 'calls',
    description: 'Experience-led live visual explanations.',
    disclaimer: 'Educational only, not financial advice.', url: 'planeir.ie'
  };
  for (const [id, text] of Object.entries(expectedCopy)) assert.equal(outlines.lines[id]?.text, text, `Fixed copy changed for ${id}.`);
  const outputs = new Map();
  const dimensions = new Map();
  const put = (path, value, width, height) => {
    assert.ok(!outputs.has(path), `Duplicate generated asset: ${path}`);
    outputs.set(path, Buffer.isBuffer(value) ? value : Buffer.from(value));
    if (width) dimensions.set(path, { width, height });
  };
  const png = (path, source, width, height) => put(path, renderPng(source, width), width, height);
  const exports = {
    PLANEIR_WORDMARK_LETTER_PATH: art.letterPath,
    NEWGRANGE_RING_PATH: art.ringPath,
    NEWGRANGE_DISC_PATH: art.discPath,
    PLANEIR_TITTLE_TRANSFORM: art.tittleTransform,
    PLANEIR_LOCKUP_VIEW_BOX: '0 0 1330 384',
    NEWGRANGE_VIEW_BOX: '0 0 128 128',
    LIGHT, DARK
  };
  put('js/planeir_brand_artwork.js', '// Generated by scripts/generate-planeir-brand-assets.mjs. Do not edit.\n// Exact geometry from the canonical Newgrange SVG handoff.\n' + Object.entries(exports).map(([key, value]) => `export const ${key} = ${JSON.stringify(value)};`).join('\n') + '\n');

  // The complete 128-unit source viewBox fits inside the tile with extra padding;
  // the canonical ring already includes 12 units of internal clear space.
  const icon = svg(512, 512, 'Planeir Newgrange alignment mark', `  <rect width="512" height="512" rx="96" fill="${TILE}"/>\n  <g transform="translate(48 48) scale(3.25)">${mark(art, LIGHT)}</g>`);
  put('favicon.svg', icon, 512, 512);
  for (const [path, size] of [
    ['favicon.png', 512], ['favicon-32.png', 32], ['apple-touch-icon.png', 180],
    ['assets/brand/planeir-app-icon-192.png', 192], ['assets/brand/planeir-app-icon-512.png', 512]
  ]) png(path, icon, size, size);
  put('favicon.ico', createIco([16, 32, 48].map((size) => ({ size, bytes: renderPng(icon, size) }))));

  for (const tone of ['light', 'dark']) {
    const canonical = sources[`assets/brand/planeir-lockup-${tone}.svg`];
    const pixels = renderPng(canonical, 1330);
    put(`assets/brand/planeir-lockup-${tone}.png`, pixels, 1330, 384);
    // Neutral old URLs remain explicit compatibility aliases to the new identity.
    put(`assets/brand/planeir-wordmark-${tone}.svg`, canonical, 1330, 384);
    put(`assets/brand/planeir-wordmark-${tone}.png`, pixels, 1330, 384);
  }
  const social = socialCard(art, outlines);
  put('assets/brand/planeir-social-card-newgrange.svg', social, 1200, 630);
  const socialPng = renderPng(social, 1200);
  put('assets/brand/planeir-social-card-newgrange.png', socialPng, 1200, 630);
  put('assets/brand/planeir-social-card.png', socialPng, 1200, 630);
  for (const [i, name] of YOUTUBE_NAMES.entries()) {
    const source = youtubeBackground(art, outlines, i);
    put(`assets/brand/youtube/${name}.svg`, source, 1920, 1080);
    png(`assets/brand/youtube/${name}.png`, source, 1920, 1080);
  }
  for (const size of [300, 400, 512, 1024]) {
    const width = size * 0.8;
    const scale = width / 1330;
    const source = svg(size, size, 'Planeir dark lockup on white', `  <rect width="${size}" height="${size}" fill="#FFFFFF"/>\n  <g transform="translate(${size * 0.1} ${(size - 384 * scale) / 2}) scale(${scale})">${lockup(art, DARK)}</g>`);
    png(`assets/brand/zoom/planeir-wordmark-dark-square-${size}.png`, source, size, size);
  }
  const transparent = svg(2000, 2000, 'Planeir dark lockup with transparent background', `  <g transform="translate(335 808)">${lockup(art, DARK)}</g>`);
  png('Planeir_logo_transparent.png', transparent, 2000, 2000);

  const manifest = {
    schemaVersion: 1,
    identity: 'Planeir Newgrange alignment mark',
    renderer: `@resvg/resvg-js@${RENDERER_VERSION}`,
    sourceOfTruth: 'The six canonical SVGs. Logo path data and tittle placement remain verbatim.',
    fonts: 'Fixed copy is stored as licensed font outlines; no system fonts are loaded.',
    editingOnly: {
      files: ['svg', 'png'].map(extension => `assets/brand/youtube/${YOUTUBE_NAMES[2]}.${extension}`),
      warning: 'Editing-only; flip back before publication. Final text must read normally and the mark must open upper-right.'
    },
    inputs: [...inputs].map(([path, bytes]) => ({ path, sha256: sha256(bytes) })),
    outputs: [...outputs].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes), ...dimensions.get(path), ...(path.endsWith('.ico') ? { frames: [16, 32, 48] } : {}) })),
    compatibilityAliases: {
      'assets/brand/planeir-wordmark-light.svg': 'assets/brand/planeir-lockup-light.svg',
      'assets/brand/planeir-wordmark-dark.svg': 'assets/brand/planeir-lockup-dark.svg',
      'assets/brand/planeir-wordmark-light.png': 'assets/brand/planeir-lockup-light.png',
      'assets/brand/planeir-wordmark-dark.png': 'assets/brand/planeir-lockup-dark.png',
      'assets/brand/planeir-social-card.png': 'assets/brand/planeir-social-card-newgrange.png'
    }
  };
  put('assets/brand/planeir-brand-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  assert.deepEqual([...outputs.keys()].sort(), [...GENERATED_ASSET_PATHS].sort(), 'Generated-file inventory is incomplete.');
  return outputs;
}

export async function generateBrandAssets({ root = DEFAULT_ROOT, check = false, log = console.log } = {}) {
  const outputs = await buildBrandAssets({ root });
  const drift = [];
  for (const [path, bytes] of outputs) {
    const destination = resolve(root, path);
    if (check) {
      let current;
      try { current = await readFile(destination); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!current?.equals(bytes)) drift.push(path);
    } else {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
  }
  if (drift.length) throw new Error(`Brand assets differ or are missing:\n${drift.map((path) => `  ${path}`).join('\n')}\nRun npm run generate:brand.`);
  log(`${check ? 'Verified' : 'Generated'} ${outputs.size} deterministic Newgrange brand files.`);
  return outputs;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(2);
  if (flags.some((flag) => flag !== '--check')) throw new Error('Usage: node scripts/generate-planeir-brand-assets.mjs [--check]');
  await generateBrandAssets({ check: flags.includes('--check') });
}
