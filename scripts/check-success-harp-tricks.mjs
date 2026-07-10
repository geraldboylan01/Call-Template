import { readFile } from 'node:fs/promises';
import {
  HARP_TRICK_NAMES,
  createHarpTrickSelector
} from '../js/success_harp_character.js';

const EXPECTED_TRICKS = Object.freeze(['backflip', 'spin', 'flex', 'selfie']);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractPathData(svg, label) {
  const match = svg.match(/<path\b[^>]*\bd="([^"]+)"/);
  assert(match, `${label} must contain one path with inline path data.`);
  return match[1];
}

function splitSubpaths(pathData) {
  return pathData.trim().split(/\s+(?=M\s)/);
}

function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = ((state * 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function countOccurrences(source, value) {
  return source.split(value).length - 1;
}

function verifyWordmarkAssets(fullSvg, noHarpSvg) {
  assert(fullSvg.includes('viewBox="0 0 1330 384"'), 'Full wordmark must retain the 1330x384 viewBox.');
  assert(noHarpSvg.includes('viewBox="0 0 1330 384"'), 'No-harp wordmark must use the 1330x384 viewBox.');
  assert(fullSvg.includes('fill="#F3F8FF"'), 'Full wordmark light fill is missing.');
  assert(noHarpSvg.includes('fill="#F3F8FF"'), 'No-harp wordmark must retain the light fill.');

  const fullPath = extractPathData(fullSvg, 'Full wordmark');
  const noHarpPath = extractPathData(noHarpSvg, 'No-harp wordmark');
  const fullSubpaths = splitSubpaths(fullPath);
  const noHarpSubpaths = splitSubpaths(noHarpPath);

  assert(fullSubpaths.length === 14, `Full wordmark must contain 14 subpaths; found ${fullSubpaths.length}.`);
  assert(noHarpSubpaths.length === 11, `No-harp wordmark must contain 11 subpaths; found ${noHarpSubpaths.length}.`);
  noHarpSubpaths.forEach((subpath, index) => {
    assert(subpath === fullSubpaths[index], `No-harp wordmark subpath ${index} does not exactly match the full wordmark.`);
  });

  const exactPrefix = noHarpPath.trimEnd();
  assert(fullPath.startsWith(exactPrefix), 'No-harp path data must be an exact prefix of the full wordmark path data.');
  const omittedSubpaths = fullSubpaths.slice(11);
  const omittedStarts = ['M 987.0,10.0', 'M 1029.0,36.0', 'M 1000.0,25.0'];
  omittedStarts.forEach((start, index) => {
    assert(omittedSubpaths[index]?.startsWith(start), `Expected omitted harp subpath ${index} to begin with ${start}.`);
  });
}

function verifySuccessMarkup(html, config) {
  const baseCssIndex = html.indexOf(`href="${config.baseCss}"`);
  const sharedCssIndex = html.indexOf(`href="${config.sharedCss}"`);
  assert(baseCssIndex >= 0, `${config.file}: base stylesheet link is missing.`);
  assert(sharedCssIndex > baseCssIndex, `${config.file}: shared success stylesheet must load after the page stylesheet.`);
  assert(countOccurrences(html, `href="${config.sharedCss}"`) === 1, `${config.file}: shared success stylesheet must be linked exactly once.`);

  const overlayStart = html.indexOf(`<div id="${config.overlayId}"`);
  const timerStart = html.indexOf('<div class="lead-success-timer"', overlayStart);
  assert(overlayStart >= 0 && timerStart > overlayStart, `${config.file}: success overlay structure was not found.`);
  const overlay = html.slice(overlayStart, timerStart);

  const stageLogoPattern = new RegExp(
    `class="lead-success-stage-logo"\\s+src="${escapeRegExp(config.noHarpSrc)}"`
  );
  assert(stageLogoPattern.test(overlay), `${config.file}: success stage must use the no-harp wordmark.`);
  assert(countOccurrences(overlay, config.noHarpSrc) === 1, `${config.file}: no-harp wordmark must appear once in the overlay.`);

  const characterPattern = new RegExp([
    '<span class="lead-success-harp-character" aria-hidden="true">',
    '<span class="lead-success-harp-scale">',
    '<span class="lead-success-harp-motion">',
    '<img\\s+class="lead-success-harp-body"',
    `src="${escapeRegExp(config.harpSrc)}"`,
    'alt=""',
    'width="140"',
    'height="136"',
    'decoding="async"'
  ].join('\\s+'));
  assert(characterPattern.test(overlay), `${config.file}: harp character body structure is incomplete or out of order.`);
  assert(overlay.includes('class="lead-success-ghost-logo"'), `${config.file}: success ghost must remain present.`);
  assert(overlay.includes(`src="${config.fullWordmarkSrc}"`), `${config.file}: success ghost must retain the complete wordmark.`);

  ['lead-success-harp-eraser', 'lead-success-harp-shell', 'lead-success-harp-face'].forEach((removedClass) => {
    assert(!overlay.includes(removedClass), `${config.file}: stale ${removedClass} markup remains.`);
  });
}

function verifyTrickSelector() {
  assert(Array.isArray(HARP_TRICK_NAMES), 'HARP_TRICK_NAMES must be an exported array.');
  assert(
    JSON.stringify(HARP_TRICK_NAMES) === JSON.stringify(EXPECTED_TRICKS),
    `Expected exported tricks ${EXPECTED_TRICKS.join(', ')}; received ${Array.from(HARP_TRICK_NAMES || []).join(', ')}.`
  );
  assert(typeof createHarpTrickSelector === 'function', 'createHarpTrickSelector must be exported for deterministic checks.');

  const forcedSelector = createHarpTrickSelector(createSeededRandom(0x504c414e));
  EXPECTED_TRICKS.forEach((trick) => {
    assert(forcedSelector(trick) === trick, `Forced ${trick} override must resolve deterministically.`);
  });

  const invalidSelector = createHarpTrickSelector(createSeededRandom(0x12345678));
  const randomSelector = createHarpTrickSelector(createSeededRandom(0x12345678));
  assert(
    invalidSelector('not-a-real-trick') === randomSelector('random'),
    'An invalid forced trick must fall back to the same shuffled-bag behavior as random.'
  );

  const sequenceSelector = createHarpTrickSelector(createSeededRandom(0xdecafbad));
  const sequence = Array.from({ length: EXPECTED_TRICKS.length * 3 }, () => sequenceSelector('random'));
  for (let offset = 0; offset < sequence.length; offset += EXPECTED_TRICKS.length) {
    const bag = sequence.slice(offset, offset + EXPECTED_TRICKS.length);
    assert(new Set(bag).size === EXPECTED_TRICKS.length, `Random bag ${offset / EXPECTED_TRICKS.length + 1} contains a duplicate.`);
    EXPECTED_TRICKS.forEach((trick) => {
      assert(bag.includes(trick), `Random bag ${offset / EXPECTED_TRICKS.length + 1} is missing ${trick}.`);
    });
  }
  sequence.forEach((trick, index) => {
    assert(EXPECTED_TRICKS.includes(trick), `Random selector returned unknown trick ${trick}.`);
    if (index > 0) {
      assert(trick !== sequence[index - 1], `Random selector repeated ${trick} at positions ${index} and ${index + 1}.`);
    }
  });

  const deterministicA = createHarpTrickSelector(createSeededRandom(0xc0ffee));
  const deterministicB = createHarpTrickSelector(createSeededRandom(0xc0ffee));
  const sequenceA = Array.from({ length: 12 }, () => deterministicA('random'));
  const sequenceB = Array.from({ length: 12 }, () => deterministicB('random'));
  assert(JSON.stringify(sequenceA) === JSON.stringify(sequenceB), 'Equal random sources must produce equal trick sequences.');

  const forcedBoundarySelector = createHarpTrickSelector(createSeededRandom(0xfacefeed));
  assert(forcedBoundarySelector('flex') === 'flex', 'Forced boundary setup failed.');
  assert(forcedBoundarySelector('random') !== 'flex', 'Random selection must not immediately repeat a forced trick.');
}

const [fullSvg, noHarpSvg, landingHtml, appHtml, takeoverSource] = await Promise.all([
  readFile(new URL('../assets/brand/planeir-wordmark-light.svg', import.meta.url), 'utf8'),
  readFile(new URL('../assets/brand/planeir-wordmark-no-harp-light.svg', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../app/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../js/success_takeover.js', import.meta.url), 'utf8')
]);

verifyWordmarkAssets(fullSvg, noHarpSvg);
console.info('[SuccessHarpCheck] PASS: wordmark asset split');

verifySuccessMarkup(landingHtml, {
  file: 'index.html',
  overlayId: 'leadSuccessOverlay',
  baseCss: './styles/landing.css',
  sharedCss: './styles/success_takeover.css',
  noHarpSrc: './assets/brand/planeir-wordmark-no-harp-light.svg',
  harpSrc: './assets/brand/planeir-harp-light.svg',
  fullWordmarkSrc: './assets/brand/planeir-wordmark-light.svg'
});
verifySuccessMarkup(appHtml, {
  file: 'app/index.html',
  overlayId: 'publishSuccessOverlay',
  baseCss: '../styles/base.css',
  sharedCss: '../styles/success_takeover.css',
  noHarpSrc: '../assets/brand/planeir-wordmark-no-harp-light.svg',
  harpSrc: '../assets/brand/planeir-harp-light.svg',
  fullWordmarkSrc: '../assets/brand/planeir-wordmark-light.svg'
});
console.info('[SuccessHarpCheck] PASS: landing and app success markup');

assert(/\bharpTrick\b/.test(takeoverSource), 'Success takeover play options must include the harpTrick override.');
verifyTrickSelector();
console.info('[SuccessHarpCheck] PASS: trick registry, overrides, shuffle bags, and repeat prevention');
console.info('[SuccessHarpCheck] 3/3 success animation checks passed.');
