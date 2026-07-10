import { readFile } from 'node:fs/promises';
import {
  HARP_TRICKS,
  HARP_TRICK_NAMES,
  createHarpTrickSelector,
  createSuccessHarpCharacter
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

class FakeStyle {
  constructor() {
    this.values = new Map();
  }

  setProperty(name, value) {
    this.values.set(name, String(value));
  }

  removeProperty(name) {
    const previous = this.values.get(name) || '';
    this.values.delete(name);
    return previous;
  }

  getPropertyValue(name) {
    return this.values.get(name) || '';
  }
}

class FakeClassList {
  constructor(classNames = []) {
    this.values = new Set(classNames);
  }

  add(...classNames) {
    classNames.forEach((className) => this.values.add(className));
  }

  remove(...classNames) {
    classNames.forEach((className) => this.values.delete(className));
  }

  contains(className) {
    return this.values.has(className);
  }
}

class FakeAnimation {
  constructor(runtime) {
    this.runtime = runtime;
    this.settled = false;
    this.finished = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    queueMicrotask(() => {
      if (!this.settled) {
        this.settled = true;
        this.resolve();
      }
    });
  }

  cancel() {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.runtime.animationCancels += 1;
    this.reject(new Error('Animation cancelled by lifecycle check.'));
  }
}

function matchesFakeSelector(element, selector) {
  if (selector.startsWith('.')) {
    return element.classList.contains(selector.slice(1));
  }

  const tagAndClass = selector.match(/^([a-z]+)\.([\w-]+)$/i);
  if (tagAndClass) {
    return element.tagName === tagAndClass[1].toLowerCase()
      && element.classList.contains(tagAndClass[2]);
  }

  const attribute = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (attribute) {
    return element.attributes.has(attribute[1])
      && (attribute[2] === undefined || element.getAttribute(attribute[1]) === attribute[2]);
  }

  return false;
}

class FakeElement {
  constructor(runtime, options = {}) {
    const {
      tagName = 'span',
      classNames = [],
      attributes = {},
      height = 32
    } = options;
    this.runtime = runtime;
    this.tagName = tagName.toLowerCase();
    this.classList = new FakeClassList(classNames);
    this.attributes = new Map(Object.entries(attributes).map(([name, value]) => [name, String(value)]));
    this.dataset = {};
    this.style = new FakeStyle();
    this.children = [];
    this.parentNode = null;
    this.ownerDocument = runtime.documentObject;
    this.height = height;
    this.offsetHeight = height;
  }

  get nextSibling() {
    if (!this.parentNode) {
      return null;
    }
    const index = this.parentNode.children.indexOf(this);
    return this.parentNode.children[index + 1] || null;
  }

  get previousSibling() {
    if (!this.parentNode) {
      return null;
    }
    const index = this.parentNode.children.indexOf(this);
    return index > 0 ? this.parentNode.children[index - 1] : null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    if (child.parentNode) {
      const previousIndex = child.parentNode.children.indexOf(child);
      if (previousIndex >= 0) {
        child.parentNode.children.splice(previousIndex, 1);
      }
    }
    child.parentNode = this;
    const referenceIndex = reference ? this.children.indexOf(reference) : -1;
    if (referenceIndex >= 0) {
      this.children.splice(referenceIndex, 0, child);
    } else {
      this.children.push(child);
    }
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  toggleAttribute(name, force) {
    const shouldSet = force === undefined ? !this.attributes.has(name) : Boolean(force);
    if (shouldSet) {
      this.attributes.set(name, '');
    } else {
      this.attributes.delete(name);
    }
    return shouldSet;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      node.children.forEach((child) => {
        if (matchesFakeSelector(child, selector)) {
          matches.push(child);
        }
        visit(child);
      });
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  getBoundingClientRect() {
    return { height: this.height };
  }

  animate() {
    this.runtime.animationStarts += 1;
    const animation = new FakeAnimation(this.runtime);
    this.runtime.animations.push(animation);
    return animation;
  }
}

function createFakeCharacter(options = {}) {
  const runtime = {
    animationStarts: 0,
    animationCancels: 0,
    animations: [],
    documentObject: {}
  };
  const element = (elementOptions) => new FakeElement(runtime, elementOptions);
  const root = element({ classNames: ['lead-success-harp-character'] });
  const scale = element({ classNames: ['lead-success-harp-scale'] });
  const motion = element({ classNames: ['lead-success-harp-motion'] });
  const backRig = element({ tagName: 'svg', classNames: ['lead-success-harp-rig', 'lead-success-harp-rig-back'] });
  const body = element({
    tagName: 'img',
    classNames: ['lead-success-harp-body'],
    height: options.height || 32
  });
  const frontRig = element({ tagName: 'svg', classNames: ['lead-success-harp-rig', 'lead-success-harp-rig-front'] });

  root.appendChild(scale);
  scale.appendChild(motion);
  motion.appendChild(backRig);
  motion.appendChild(body);
  motion.appendChild(frontRig);

  const addPart = (group, partName, extraAttribute = null) => {
    const attributes = {
      'data-part': partName,
      'data-origin': '50px 50px'
    };
    if (extraAttribute) {
      attributes[extraAttribute] = '';
    }
    const part = element({ tagName: 'g', attributes });
    group.appendChild(part);
    return part;
  };

  HARP_TRICK_NAMES.forEach((trickName) => {
    const backGroup = element({
      tagName: 'g',
      attributes: {
        'data-trick': trickName,
        'data-part': `${trickName}-back-parts`,
        hidden: '',
        visibility: 'hidden'
      }
    });
    ['left-arm', 'right-arm', 'left-leg', 'right-leg'].forEach((partName) => {
      const part = addPart(backGroup, partName);
      part.appendChild(element({ tagName: 'path', attributes: { 'data-limb': '' } }));
      part.appendChild(element({ tagName: 'circle', attributes: { 'data-extremity': '' } }));
    });
    backRig.appendChild(backGroup);

    const frontGroup = element({
      tagName: 'g',
      attributes: {
        'data-trick': trickName,
        'data-part': `${trickName}-front-parts`,
        hidden: '',
        visibility: 'hidden'
      }
    });
    if (trickName === 'flex') {
      addPart(frontGroup, 'left-bicep-accent');
      addPart(frontGroup, 'right-bicep-accent');
    }
    if (trickName === 'selfie') {
      addPart(frontGroup, 'phone');
      addPart(frontGroup, 'peace-sign');
      addPart(frontGroup, 'camera-flash');
    }
    frontRig.appendChild(frontGroup);
  });

  if (options.waapi === false) {
    motion.animate = undefined;
    scale.animate = undefined;
  }

  return { runtime, root, scale, motion, backRig, frontRig };
}

function assertCharacterIsNeutral(character, label) {
  assert(!character.root.classList.contains('is-harp-character-active'), `${label}: active character class remains.`);
  assert(!Object.hasOwn(character.root.dataset, 'harpTrick'), `${label}: selected trick dataset remains.`);
  [...character.backRig.querySelectorAll('[data-trick]'), ...character.frontRig.querySelectorAll('[data-trick]')]
    .forEach((group) => {
      assert(group.attributes.has('hidden'), `${label}: a trick group is still exposed.`);
      assert(group.getAttribute('visibility') === 'hidden', `${label}: a trick group remains visible.`);
    });
  [character.scale, character.motion].forEach((node) => {
    assert(node.style.getPropertyValue('transform') === '', `${label}: an inline transform remains.`);
    assert(node.style.getPropertyValue('will-change') === '', `${label}: will-change remains.`);
  });
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
  assert(
    JSON.stringify(Object.keys(HARP_TRICKS)) === JSON.stringify(EXPECTED_TRICKS),
    `HARP_TRICKS must register exactly ${EXPECTED_TRICKS.join(', ')}.`
  );
  EXPECTED_TRICKS.forEach((trick) => {
    assert(typeof HARP_TRICKS[trick]?.play === 'function', `${trick} must register a playable routine.`);
    assert(Number(HARP_TRICKS[trick]?.duration) > 0, `${trick} must register a positive duration.`);
  });
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

  const boundarySeed = 0x504c414e;
  const boundaryMirror = createHarpTrickSelector(createSeededRandom(boundarySeed));
  const boundaryBag = Array.from({ length: EXPECTED_TRICKS.length }, () => boundaryMirror('random'));
  const nearExhaustionSelector = createHarpTrickSelector(createSeededRandom(boundarySeed));
  const consumed = Array.from({ length: EXPECTED_TRICKS.length - 1 }, () => nearExhaustionSelector('random'));
  assert(
    JSON.stringify(consumed) === JSON.stringify(boundaryBag.slice(0, -1)),
    'Forced near-exhaustion setup must consume the first three deterministic bag entries.'
  );
  const forcedLastEntry = nearExhaustionSelector(boundaryBag.at(-1));
  const afterForcedLastEntry = nearExhaustionSelector('random');
  assert(
    afterForcedLastEntry !== forcedLastEntry,
    `Random selection repeated forced final bag entry ${forcedLastEntry}.`
  );
}

async function verifyCharacterLifecycle() {
  const reducedCharacter = createFakeCharacter();
  const reducedController = createSuccessHarpCharacter({
    root: reducedCharacter.root,
    motionQuery: { matches: true }
  });
  assert(
    await reducedController.play({ trickName: 'selfie' }) === null,
    'Reduced motion must skip the requested trick.'
  );
  assert(reducedCharacter.runtime.animationStarts === 0, 'Reduced motion must not start limb, prop, scale, or flash animations.');
  assertCharacterIsNeutral(reducedCharacter, 'Reduced-motion cleanup');

  const unsupportedCharacter = createFakeCharacter({ waapi: false });
  const unsupportedController = createSuccessHarpCharacter({
    root: unsupportedCharacter.root,
    motionQuery: { matches: false }
  });
  assert(
    await unsupportedController.play({ trickName: 'backflip' }) === null,
    'Missing Web Animations support must skip the requested trick.'
  );
  assert(unsupportedCharacter.runtime.animationStarts === 0, 'No-WAAPI fallback must remain completely static.');
  assertCharacterIsNeutral(unsupportedCharacter, 'No-WAAPI cleanup');

  const character = createFakeCharacter();
  const controller = createSuccessHarpCharacter({
    root: character.root,
    motionQuery: { matches: false },
    randomSource: createSeededRandom(0xdecafbad)
  });
  const cancelledPlay = controller.play({ trickName: 'backflip' });
  assert(character.root.dataset.harpTrick === 'backflip', 'Forced backflip must activate synchronously.');
  controller.reset();
  assertCharacterIsNeutral(character, 'Synchronous reset');
  assert(character.runtime.animationCancels > 0, 'Reset must synchronously cancel active Web Animation handles.');
  assert(await cancelledPlay === null, 'Cancelled playback must resolve without reporting a completed trick.');

  const supersededPlay = controller.play({ trickName: 'backflip' });
  const winningPlay = controller.play({ trickName: 'spin' });
  assert(character.root.dataset.harpTrick === 'spin', 'Reentrant playback must synchronously replace the active trick.');
  const [supersededResult, winningResult] = await Promise.all([supersededPlay, winningPlay]);
  assert(supersededResult === null, 'Superseded playback must not report completion.');
  assert(winningResult === 'spin', 'The latest reentrant playback must complete deterministically.');
  assertCharacterIsNeutral(character, 'Completed reentrant playback');
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
assert(
  /window\.addEventListener\(['"]pagehide['"],\s*reset\)/.test(takeoverSource),
  'Success takeover must reset on pagehide navigation.'
);
assert(
  /window\.addEventListener\(['"]popstate['"],\s*reset\)/.test(takeoverSource),
  'Success takeover must reset on same-document history navigation.'
);
verifyTrickSelector();
console.info('[SuccessHarpCheck] PASS: trick registry, overrides, shuffle bags, and repeat prevention');
await verifyCharacterLifecycle();
console.info('[SuccessHarpCheck] PASS: reduced motion, no-WAAPI fallback, cancellation, reentrancy, and neutral cleanup');
console.info('[SuccessHarpCheck] 4/4 success animation checks passed.');
