import { readFile } from 'node:fs/promises';
import {
  HARP_FRAME_PATH,
  HARP_STRINGS,
  HARP_STRING_STROKE_WIDTH,
  HARP_VIEW_BOX,
  PLANEIR_WORDMARK_LETTER_PATH,
  createPlaneirHarpMarkup,
  createPlaneirWordmarkLettersMarkup,
  getHarpStringPath
} from '../js/planeir_harp_artwork.js';
import {
  HARP_RESONANCE_TIMING,
  createSuccessHarpResonance
} from '../js/success_harp_resonance.js';

const EXPECTED_STRING_IDS = Object.freeze(['low', 'mid', 'high']);
const EXPECTED_AMPLITUDES = Object.freeze([2.4, 2.1, 1.8]);
const EXPECTED_FREQUENCIES = Object.freeze([5, 5.5, 6]);
const EXPECTED_TIMING = Object.freeze({
  duration: 1550,
  focusEnd: 160,
  stringStarts: [120, 210, 300],
  stringDuration: 420,
  haloStart: 250,
  haloEnd: 1050,
  beadStart: 920,
  beadEnd: 1180,
  retractStart: 1180
});
const LEGACY_MARKERS = Object.freeze([
  'HARP_TRICKS',
  'HARP_TRICK_NAMES',
  'harpTrick',
  'randomSource',
  'lead-success-harp-character',
  'lead-success-harp-limb',
  'lead-success-harp-prop',
  'lead-success-harp-phone',
  'data-harp-trick',
  'backflip',
  'selfie'
]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function approximately(actual, expected, tolerance = 0.001) {
  return Math.abs(actual - expected) <= tolerance;
}

function countOccurrences(source, value) {
  return source.split(value).length - 1;
}

function normalizePath(pathData) {
  return String(pathData || '').trim().replace(/[\s,]+/g, ' ');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getTags(source, tagName) {
  return Array.from(source.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, 'gi')), (match) => match[0]);
}

function getTagAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${escapeRegExp(name)}(?![\\w-])(?:="([^"]*)")?`));
  return match ? (match[1] ?? '') : null;
}

function assertStrictSvgXml(source, label) {
  assert(/^<svg\b[\s\S]*<\/svg>\s*$/.test(source), `${label} must be a complete SVG document.`);
  const unvaluedCustomAttributes = Array.from(
    source.matchAll(/\s(data-[\w-]+)(?=\s|\/?\>)/g),
    (match) => match[1]
  );
  assert(
    unvaluedCustomAttributes.length === 0,
    `${label} contains XML-invalid valueless attributes: ${unvaluedCustomAttributes.join(', ')}.`
  );
}

function extractTaggedPath(source, attributeName, attributeValue = null, label = 'SVG') {
  const tag = getTags(source, 'path').find((candidate) => {
    const value = getTagAttribute(candidate, attributeName);
    return value !== null && (attributeValue === null || value === attributeValue);
  });
  assert(tag, `${label} is missing <path ${attributeName}${attributeValue === null ? '' : `="${attributeValue}"`}>.`);
  const pathData = getTagAttribute(tag, 'd');
  assert(pathData, `${label} ${attributeName} path is missing d data.`);
  return { tag, pathData };
}

function parseQuadraticPath(pathData, label) {
  const numbers = String(pathData).match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)?.map(Number) || [];
  assert(numbers.length === 6, `${label} must be one M/Q quadratic with six coordinates; found ${numbers.length}.`);
  return {
    start: numbers.slice(0, 2),
    control: numbers.slice(2, 4),
    end: numbers.slice(4, 6)
  };
}

function parsePngDimensions(buffer, label) {
  const signature = '89504e470d0a1a0a';
  assert(buffer.subarray(0, 8).toString('hex') === signature, `${label} is not a valid PNG.`);
  assert(buffer.subarray(12, 16).toString('ascii') === 'IHDR', `${label} has no PNG IHDR header.`);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function verifyCanonicalGeometry() {
  assert(HARP_VIEW_BOX === '974 6 140 136', `Harp viewBox changed from the exact 974 6 140 136 footprint: ${HARP_VIEW_BOX}.`);
  assert(typeof HARP_FRAME_PATH === 'string' && HARP_FRAME_PATH.length > 200, 'Canonical harp frame path is missing or implausibly short.');
  assert((HARP_FRAME_PATH.match(/\bC/gi) || []).length >= 18, 'Harp frame must use smooth cubic contours rather than stepped polygon geometry.');
  assert((HARP_FRAME_PATH.match(/\bL/gi) || []).length <= 6, 'Harp frame contains too many hard line segments for the approved smooth silhouette.');
  assert((HARP_FRAME_PATH.match(/\bZ/gi) || []).length === 3, 'Harp frame must retain three clean closed contours.');

  assert(Array.isArray(HARP_STRINGS) && Object.isFrozen(HARP_STRINGS), 'HARP_STRINGS must be a frozen array.');
  assert(HARP_STRINGS.length === 3, `Exactly three independent harp strings are required; found ${HARP_STRINGS.length}.`);
  assert(
    JSON.stringify(HARP_STRINGS.map(({ id }) => id)) === JSON.stringify(EXPECTED_STRING_IDS),
    `Harp strings must be ordered ${EXPECTED_STRING_IDS.join(', ')}.`
  );
  assert(approximately(HARP_STRING_STROKE_WIDTH, 1.55), `Shared harp string width must be 1.55; found ${HARP_STRING_STROKE_WIDTH}.`);

  HARP_STRINGS.forEach((definition, index) => {
    assert(Object.isFrozen(definition), `${definition.id} string definition must be immutable.`);
    assert(approximately(definition.amplitude, EXPECTED_AMPLITUDES[index]), `${definition.id} amplitude must be ${EXPECTED_AMPLITUDES[index]}.`);
    assert(approximately(definition.frequency, EXPECTED_FREQUENCIES[index]), `${definition.id} frequency must be ${EXPECTED_FREQUENCIES[index]}Hz.`);

    const neutral = parseQuadraticPath(getHarpStringPath(definition), `${definition.id} neutral string`);
    const positive = parseQuadraticPath(getHarpStringPath(definition, definition.amplitude), `${definition.id} positive string`);
    const negative = parseQuadraticPath(getHarpStringPath(definition, -definition.amplitude), `${definition.id} negative string`);

    assert(JSON.stringify(positive.start) === JSON.stringify(neutral.start), `${definition.id} pluck moves its upper endpoint.`);
    assert(JSON.stringify(positive.end) === JSON.stringify(neutral.end), `${definition.id} pluck moves its lower endpoint.`);
    assert(JSON.stringify(negative.start) === JSON.stringify(neutral.start), `${definition.id} reverse pluck moves its upper endpoint.`);
    assert(JSON.stringify(negative.end) === JSON.stringify(neutral.end), `${definition.id} reverse pluck moves its lower endpoint.`);
    assert(approximately(positive.control[0] - neutral.control[0], definition.amplitude), `${definition.id} positive control displacement is incorrect.`);
    assert(approximately(negative.control[0] - neutral.control[0], -definition.amplitude), `${definition.id} negative control displacement is incorrect.`);
    assert(positive.control[1] === neutral.control[1] && negative.control[1] === neutral.control[1], `${definition.id} pluck must not vertically distort the string.`);
  });

  const runtimeMarkup = createPlaneirHarpMarkup({ includeEffects: true, className: 'qa-harp' });
  assert(/<svg\b[^>]*data-harp-artwork/.test(runtimeMarkup), 'Inline runtime markup must expose one harp artwork root.');
  assert(/<g\b[^>]*data-harp-stage/.test(runtimeMarkup), 'Inline runtime markup must expose one independently animated harp stage.');
  assert(runtimeMarkup.includes('shape-rendering="geometricPrecision"'), 'Inline harp must request geometricPrecision rendering.');
  assert(countOccurrences(runtimeMarkup, 'data-harp-string=') === 3, 'Inline runtime markup must contain exactly three independent strings.');
  assert(countOccurrences(runtimeMarkup, 'vector-effect="non-scaling-stroke"') >= 3, 'Every inline harp string must remain a non-scaling vector.');
  assert(runtimeMarkup.includes('data-harp-secondary-arc'), 'Inline markup must identify the fine mobile-optional halo arc.');
  assert(runtimeMarkup.includes('data-harp-bead-guide'), 'Inline markup must expose the completion path used by the light bead.');
  assert(runtimeMarkup.includes('data-harp-bead') && runtimeMarkup.includes('data-harp-glint'), 'Inline markup must include the bead and single glint.');
  assert(!/filter=|<filter\b|blur\(/i.test(runtimeMarkup), 'Resonant Halo markup must not use blur filters.');
}

function verifySvgAssetGeometry(source, label, expectedColor) {
  assert(source.includes('shape-rendering="geometricPrecision"'), `${label} must request geometricPrecision rendering.`);
  assert(source.includes(`fill="${expectedColor}"`) || source.includes(`stroke="${expectedColor}"`), `${label} does not use ${expectedColor}.`);
  const frame = extractTaggedPath(source, 'data-planeir-harp-frame', null, label);
  assert(normalizePath(frame.pathData) === normalizePath(HARP_FRAME_PATH), `${label} frame diverges from HARP_FRAME_PATH.`);

  EXPECTED_STRING_IDS.forEach((id, index) => {
    const string = extractTaggedPath(source, 'data-planeir-harp-string', id, label);
    assert(normalizePath(string.pathData) === normalizePath(getHarpStringPath(HARP_STRINGS[index])), `${label} ${id} string diverges from the canonical definition.`);
    assert(getTagAttribute(string.tag, 'stroke-linecap') === 'round', `${label} ${id} string must use a round cap.`);
    assert(getTagAttribute(string.tag, 'vector-effect') === 'non-scaling-stroke', `${label} ${id} string must use a non-scaling stroke.`);
    assert(approximately(Number(getTagAttribute(string.tag, 'stroke-width')), HARP_STRING_STROKE_WIDTH), `${label} ${id} string width diverges from HARP_STRING_STROKE_WIDTH.`);
  });
}

function verifySuccessMarkup(html, config) {
  const overlayStart = html.indexOf(`<div id="${config.overlayId}"`);
  const overlayEnd = html.indexOf('<div class="lead-success-timer"', overlayStart);
  assert(overlayStart >= 0 && overlayEnd > overlayStart, `${config.file}: success overlay was not found.`);
  const overlay = html.slice(overlayStart, overlayEnd);

  assert(countOccurrences(overlay, 'class="lead-success-harp-resonance"') === 1, `${config.file}: expected exactly one resonance mount.`);
  assert(/<span class="lead-success-harp-resonance" aria-hidden="true"><\/span>/.test(overlay), `${config.file}: resonance mount must be empty, decorative, and populated by inline SVG at runtime.`);
  assert(
    /<span class="lead-success-stage-logo lead-success-stage-wordmark" aria-hidden="true"><\/span>/.test(overlay),
    `${config.file}: stage must expose the empty inline no-harp wordmark mount.`
  );
  assert(!overlay.includes('planeir-harp-light.svg'), `${config.file}: the success harp must not be an external image.`);

  if (config.fullWordmarkSrc) {
    assert(overlay.includes('class="lead-success-ghost-logo"'), `${config.file}: flight ghost is missing.`);
    assert(overlay.includes(`src="${config.fullWordmarkSrc}"`), `${config.file}: flight ghost must use the complete wordmark.`);
  }

  LEGACY_MARKERS.forEach((marker) => {
    assert(!overlay.includes(marker), `${config.file}: stale ${marker} markup remains.`);
  });
}

function verifySuccessStyles(source) {
  assert(source.includes('.lead-success-harp-resonance'), 'Shared success CSS is missing the resonance mount.');
  assert(/left:\s*73\.2330827068%/.test(source) && /top:\s*1\.5625%/.test(source), 'Harp mount no longer occupies the exact 974,6 wordmark position.');
  assert(/width:\s*10\.5263157895%/.test(source) && /height:\s*35\.4166666667%/.test(source), 'Harp mount no longer occupies the exact 140x136 wordmark footprint.');
  assert(/--lead-success-harp-active-scale:\s*1\.08/.test(source), 'Desktop focus scale must be 1.08x.');
  assert(/--lead-success-harp-mobile-min-height:\s*48px/.test(source), 'Mobile harp target height must be approximately 48px.');
  assert(/--lead-success-harp-mobile-max-scale:\s*1\.75/.test(source), 'Mobile harp scale must be capped at 1.75x.');
  assert(/\[data-harp-string\][\s\S]*?stroke-linecap:\s*round[\s\S]*?vector-effect:\s*non-scaling-stroke/.test(source), 'Harp strings must use crisp round non-scaling strokes.');
  assert(/\[data-harp-arc\][\s\S]*?stroke-linecap:\s*round[\s\S]*?vector-effect:\s*non-scaling-stroke/.test(source), 'Halo arcs must use crisp round non-scaling strokes.');
  assert(/@media \(max-width:\s*540px\)[\s\S]*?\[data-harp-(?:secondary-arc|arc="secondary")\][\s\S]*?display:\s*none/.test(source), 'Mobile CSS must omit the finest secondary arc.');
  assert(/@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\[data-harp-effects\][\s\S]*?display:\s*none\s*!important/.test(source), 'Reduced-motion CSS must suppress every effect layer.');
  assert(!/(?:^|[;{]\s*)filter\s*:/m.test(source), 'Success animation must not use animated or static blur filters.');

  LEGACY_MARKERS.forEach((marker) => {
    assert(!source.includes(marker), `Shared success CSS still contains legacy marker ${marker}.`);
  });
}

function verifyControllerSource(controllerSource, takeoverSource) {
  assert(controllerSource.includes('export function createSuccessHarpResonance'), 'Resonance controller export is missing.');
  assert(controllerSource.includes('Math.exp(') && controllerSource.includes('Math.sin('), 'String movement must use damped harmonic motion.');
  assert(controllerSource.includes('getHarpStringPath(definition, displacement)'), 'Controller must pluck by changing the string control point, not translating the whole path.');
  assert(controllerSource.includes('activeAnimations') && controllerSource.includes('activeFrameHandles'), 'Controller must track both WAAPI and animation-frame handles.');
  assert(controllerSource.includes('data-harp-bead-guide'), 'Light bead must follow the halo completion guide.');
  assert(controllerSource.includes("RESONANCE_NAME = 'resonant-halo'"), 'Controller must return the deterministic resonant-halo name.');

  LEGACY_MARKERS.forEach((marker) => {
    assert(!controllerSource.includes(marker), `Resonance controller still contains legacy marker ${marker}.`);
    assert(!takeoverSource.includes(marker), `Success takeover still contains legacy marker ${marker}.`);
  });

  assert(takeoverSource.includes("import { createSuccessHarpResonance } from './success_harp_resonance.js'"), 'Success takeover must import the resonance controller.');
  assert(takeoverSource.includes("import { createPlaneirWordmarkLettersMarkup } from './planeir_harp_artwork.js'"), 'Success takeover must build the stage wordmark from shared inline vector geometry.');
  assert(takeoverSource.includes("target?.querySelector?.('.lead-success-harp-resonance')"), 'Success takeover must mount the controller on the resonance root.');
  assert(/window\.addEventListener\(['"]pagehide['"],\s*reset\)/.test(takeoverSource), 'Success takeover must reset on pagehide.');
  assert(/window\.addEventListener\(['"]popstate['"],\s*reset\)/.test(takeoverSource), 'Success takeover must reset on popstate.');

  const flightIndex = takeoverSource.indexOf('await runFlight(');
  const resonanceIndex = takeoverSource.indexOf('await harpResonance.play()', flightIndex);
  const flightToResonance = takeoverSource.slice(flightIndex, resonanceIndex);
  assert(flightIndex >= 0 && resonanceIndex > flightIndex, 'Logo flight must finish before resonance starts.');
  assert(countOccurrences(flightToResonance, 'await waitForNextFrame()') >= 2, 'Takeover must wait two neutral compositor frames after the logo flight.');

  const copyIndex = takeoverSource.indexOf("overlay.classList.add('is-showing-copy')", resonanceIndex);
  const resetIndex = takeoverSource.indexOf('harpResonance.reset()', resonanceIndex);
  assert(resetIndex > resonanceIndex && copyIndex > resetIndex, 'Copy must appear only after resonance play resolves and the harp is reset to neutral.');
}

function verifyPreview(previewHtml, previewSource) {
  assert(previewHtml.includes('<meta name="robots" content="noindex, nofollow"'), 'Preview must remain local-only/noindex.');
  ['preview-play', 'preview-replay', 'preview-cancel', 'preview-reduced-motion', 'preview-variant'].forEach((testId) => {
    assert(previewHtml.includes(`data-testid="${testId}"`), `Preview is missing ${testId}.`);
  });
  assert(previewHtml.includes('<option value="published">') && previewHtml.includes('<option value="request">'), 'Preview must retain both success-copy variants.');
  assert(
    !/preview-trick|successPreviewTrick|harpTrick|playSelectedTrick|value="(?:random|backflip|spin|flex|selfie)"/i.test(previewHtml + previewSource),
    'Preview must not expose the retired random trick selector.'
  );
  assert(!/\bfetch\s*\(|\/api\/|submitLead|publishSession/.test(previewSource), 'Preview must not submit leads or publish sessions.');
  assert(previewSource.includes('takeover.reset()') && previewSource.includes('playResonantHalo'), 'Preview replay/cancel controls must drive deterministic reset and play.');
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
    const camelName = name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    delete this[camelName];
    return previous;
  }

  getPropertyValue(name) {
    const camelName = name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    return this.values.get(name) || this[camelName] || '';
  }
}

class FakeClassList {
  constructor(initial = []) {
    this.values = new Set(initial);
  }

  add(...names) {
    names.forEach((name) => this.values.add(name));
  }

  remove(...names) {
    names.forEach((name) => this.values.delete(name));
  }

  contains(name) {
    return this.values.has(name);
  }

  toggle(name, force) {
    const next = force === undefined ? !this.values.has(name) : Boolean(force);
    if (next) this.values.add(name);
    else this.values.delete(name);
    return next;
  }
}

function dataKeyToAttribute(key) {
  return `data-${String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function dataAttributeToKey(attribute) {
  return attribute.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function matchesSelector(element, selector) {
  const trimmed = selector.trim();
  const tagName = trimmed.match(/^[a-z][\w-]*/i)?.[0];
  if (tagName && element.tagName !== tagName.toLowerCase()) return false;

  for (const match of trimmed.matchAll(/\.([\w-]+)/g)) {
    if (!element.classList.contains(match[1])) return false;
  }

  for (const match of trimmed.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    const actual = element.getAttribute(match[1]);
    if (actual === null || (match[2] !== undefined && actual !== match[2])) return false;
  }
  return true;
}

class FakeAnimation {
  constructor(runtime) {
    this.runtime = runtime;
    this.cancelled = false;
    this.finished = Promise.resolve();
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.runtime.animationCancels += 1;
  }
}

class FakeElement {
  constructor(runtime, options = {}) {
    this.runtime = runtime;
    this.tagName = String(options.tagName || 'span').toLowerCase();
    this.classList = new FakeClassList(options.classNames || []);
    this.attributes = new Map();
    this._datasetStore = {};
    this.dataset = new Proxy(this._datasetStore, {
      set: (target, key, value) => {
        const stringValue = String(value);
        target[key] = stringValue;
        this.attributes.set(dataKeyToAttribute(key), stringValue);
        if (key === 'harpPhase') runtime.phaseHistory.push(stringValue);
        return true;
      },
      deleteProperty: (target, key) => {
        delete target[key];
        this.attributes.delete(dataKeyToAttribute(key));
        return true;
      }
    });
    this.style = new FakeStyle();
    this.children = [];
    this.parentNode = null;
    this.ownerDocument = runtime.documentObject;
    this.offsetHeight = options.height ?? 32;
    this.height = options.height ?? 32;
    this._innerHTML = '';
    Object.entries(options.attributes || {}).forEach(([name, value]) => this.setAttribute(name, value));
    if (runtime.waapi === false) this.animate = undefined;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
    if (this._innerHTML.includes('data-harp-artwork')) buildFakeArtwork(this.runtime, this);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    const stringValue = String(value);
    this.attributes.set(name, stringValue);
    if (name.startsWith('data-')) this._datasetStore[dataAttributeToKey(name)] = stringValue;
    if (name === 'd' && this.attributes.has('data-harp-string')) {
      this.runtime.stringMutations.push({
        id: this.getAttribute('data-harp-string'),
        time: this.runtime.now,
        pathData: stringValue
      });
    }
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name.startsWith('data-')) delete this._datasetStore[dataAttributeToKey(name)];
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      node.children.forEach((child) => {
        if (matchesSelector(child, selector)) matches.push(child);
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
    return { width: this.height * (140 / 136), height: this.height };
  }

  getTotalLength() {
    return 1;
  }

  getPointAtLength(length) {
    const progress = Math.max(0, Math.min(1, Number(length)));
    return {
      x: 1088 + ((1057 - 1088) * progress),
      y: 18 + ((142 - 18) * progress)
    };
  }

  animate(keyframes, options = {}) {
    const animation = new FakeAnimation(this.runtime);
    this.runtime.animationRecords.push({
      element: this,
      keyframes: Array.isArray(keyframes) ? keyframes.map((frame) => ({ ...frame })) : { ...keyframes },
      options: { ...options },
      animation
    });
    return animation;
  }
}

function buildFakeArtwork(runtime, root) {
  const element = (options) => new FakeElement(runtime, options);
  const artwork = element({
    tagName: 'svg',
    classNames: ['planeir-harp-svg', 'lead-success-harp-resonance-svg'],
    attributes: { 'data-harp-artwork': '' }
  });
  const stage = element({ tagName: 'g', attributes: { 'data-harp-stage': '' } });
  const effects = element({ tagName: 'g', attributes: { 'data-harp-effects': '' } });
  const arcNames = ['primary', 'secondary', 'completion'];
  arcNames.forEach((name) => {
    effects.appendChild(element({
      tagName: 'path',
      attributes: {
        'data-harp-arc': name,
        'data-harp-halo-arc': '',
        ...(name === 'secondary' ? { 'data-harp-secondary-arc': '' } : {}),
        ...(name === 'completion' ? { 'data-harp-bead-guide': '' } : {}),
        d: 'M0 0 Q0.5 0.5 1 1'
      }
    }));
  });
  effects.appendChild(element({ tagName: 'circle', attributes: { 'data-harp-bead': '', cx: '982', cy: '105' } }));
  effects.appendChild(element({ tagName: 'path', attributes: { 'data-harp-glint': '', d: 'M0 0 L1 1' } }));
  stage.appendChild(effects);

  const base = element({ tagName: 'g', attributes: { 'data-harp-base': '' } });
  base.appendChild(element({ tagName: 'path', attributes: { 'data-harp-frame': '', d: HARP_FRAME_PATH } }));
  HARP_STRINGS.forEach((definition) => {
    base.appendChild(element({
      tagName: 'path',
      attributes: {
        'data-harp-string': definition.id,
        d: getHarpStringPath(definition)
      }
    }));
  });
  stage.appendChild(base);
  artwork.appendChild(stage);
  root.appendChild(artwork);
}

function createFakeFixture(options = {}) {
  const runtime = {
    now: 0,
    nextFrameId: 1,
    frameHandles: new Map(),
    cancelledFrames: 0,
    animationCancels: 0,
    animationRecords: [],
    stringMutations: [],
    phaseHistory: [],
    waapi: options.waapi !== false,
    autoFrames: options.autoFrames !== false,
    documentObject: null
  };
  const view = {
    innerWidth: options.width ?? 1280,
    visualViewport: { width: options.width ?? 1280 },
    performance: { now: () => runtime.now },
    requestAnimationFrame(callback) {
      const id = runtime.nextFrameId++;
      runtime.frameHandles.set(id, callback);
      if (runtime.autoFrames) {
        queueMicrotask(() => {
          const queued = runtime.frameHandles.get(id);
          if (!queued) return;
          runtime.frameHandles.delete(id);
          runtime.now += 1000 / 60;
          queued(runtime.now);
        });
      }
      return id;
    },
    cancelAnimationFrame(id) {
      if (runtime.frameHandles.delete(id)) runtime.cancelledFrames += 1;
    }
  };
  runtime.documentObject = { defaultView: view };
  const root = new FakeElement(runtime, {
    classNames: ['lead-success-harp-resonance'],
    height: options.height ?? 32
  });
  return { runtime, root, view };
}

function getAnimationRecord(fixture, attributeName, value = null) {
  return fixture.runtime.animationRecords.find(({ element }) => {
    const actual = element.getAttribute(attributeName);
    return actual !== null && (value === null || actual === value);
  });
}

function assertNeutral(fixture, label) {
  const { root } = fixture;
  assert(!root.classList.contains('is-harp-resonance-active'), `${label}: active class remains.`);
  assert(!root.classList.contains('is-harp-resonance-mobile'), `${label}: mobile class remains.`);
  assert(!Object.hasOwn(root.dataset, 'harpPhase'), `${label}: data-harp-phase remains.`);
  HARP_STRINGS.forEach((definition) => {
    const element = root.querySelector(`[data-harp-string="${definition.id}"]`);
    assert(normalizePath(element?.getAttribute('d')) === normalizePath(getHarpStringPath(definition)), `${label}: ${definition.id} string is not neutral.`);
  });
  ['[data-harp-stage]', '[data-harp-bead]', '[data-harp-glint]', '[data-harp-halo-arc]'].forEach((selector) => {
    root.querySelectorAll(selector).forEach((element) => {
      ['opacity', 'transform', 'transform-box', 'transform-origin', 'will-change'].forEach((property) => {
        assert(element.style.getPropertyValue(property) === '', `${label}: ${selector} retains inline ${property}.`);
      });
    });
  });
  const secondary = root.querySelector('[data-harp-secondary-arc]');
  assert(secondary?.style.getPropertyValue('display') === '', `${label}: secondary arc remains hidden.`);
}

function countSignChanges(values) {
  const signs = values
    .filter((value) => Math.abs(value) > 0.01)
    .map((value) => Math.sign(value));
  return signs.slice(1).reduce((count, sign, index) => count + (sign !== signs[index] ? 1 : 0), 0);
}

async function settleWithin(promise, label, timeoutMs = 500) {
  let timeoutId;
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} did not settle after reset.`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function verifyControllerRuntime() {
  assert(JSON.stringify(HARP_RESONANCE_TIMING) === JSON.stringify(EXPECTED_TIMING), 'HARP_RESONANCE_TIMING does not match the approved 1.55s choreography.');

  const normal = createFakeFixture();
  const normalController = createSuccessHarpResonance({ root: normal.root, motionQuery: { matches: false } });
  normal.runtime.stringMutations.length = 0;
  normal.runtime.phaseHistory.length = 0;
  const result = await normalController.play();
  assert(result === 'resonant-halo', `Deterministic play result must be resonant-halo; received ${result}.`);
  assertNeutral(normal, 'completed play');

  const orderedPhases = [...new Set(normal.runtime.phaseHistory)];
  assert(JSON.stringify(orderedPhases) === JSON.stringify(['focus', 'pluck', 'halo', 'glint', 'retract']), `Unexpected phase order: ${orderedPhases.join(', ')}.`);

  const artworkAnimation = getAnimationRecord(normal, 'data-harp-stage');
  assert(artworkAnimation?.options.duration === 1550, 'Harp focus/retraction animation must span the full 1550ms timeline.');
  assert(artworkAnimation.keyframes.some(({ transform }) => transform === 'scale(1.08)'), 'Desktop harp must focus at exactly 1.08x.');
  assert(artworkAnimation.keyframes.at(-1)?.transform === 'scale(1)', 'Harp must end at exactly 1x.');
  assert(normal.runtime.animationRecords.filter(({ element }) => element.getAttribute('data-harp-halo-arc') !== null).length === 3, 'Desktop must animate all three asymmetric halo arcs.');

  const beadAnimation = getAnimationRecord(normal, 'data-harp-bead');
  const glintAnimation = getAnimationRecord(normal, 'data-harp-glint');
  assert(beadAnimation?.options.delay === 920 && beadAnimation?.options.duration === 260, 'Light bead must run from 920ms to 1180ms.');
  assert(glintAnimation?.options.delay === 1040 && glintAnimation?.options.duration === 140, 'Single glint must last 140ms and finish at 1180ms.');
  assert(normal.runtime.animationRecords.every(({ animation }) => animation.cancelled), 'Completed play must cancel every tracked WAAPI handle during neutral cleanup.');

  HARP_STRINGS.forEach((definition, index) => {
    const neutral = parseQuadraticPath(getHarpStringPath(definition), `${definition.id} neutral runtime path`);
    const samples = normal.runtime.stringMutations
      .filter((sample) => sample.id === definition.id)
      .map((sample) => ({ ...sample, parsed: parseQuadraticPath(sample.pathData, `${definition.id} runtime sample`) }));
    assert(samples.length >= 20, `${definition.id} string did not receive a smooth frame-by-frame pluck.`);
    samples.forEach(({ parsed }) => {
      assert(JSON.stringify(parsed.start) === JSON.stringify(neutral.start), `${definition.id} runtime pluck moved its upper endpoint.`);
      assert(JSON.stringify(parsed.end) === JSON.stringify(neutral.end), `${definition.id} runtime pluck moved its lower endpoint.`);
    });

    const activeStart = HARP_RESONANCE_TIMING.stringStarts[index];
    const displacements = samples
      .filter(({ time }) => time >= activeStart && time <= activeStart + HARP_RESONANCE_TIMING.stringDuration)
      .map(({ parsed }) => parsed.control[0] - neutral.control[0]);
    const firstHalf = displacements.slice(0, Math.ceil(displacements.length / 2));
    const secondHalf = displacements.slice(Math.floor(displacements.length / 2));
    const earlyPeak = Math.max(...firstHalf.map(Math.abs));
    const latePeak = Math.max(...secondHalf.map(Math.abs));
    assert(earlyPeak >= definition.amplitude * 0.55 && earlyPeak <= definition.amplitude, `${definition.id} peak does not reflect its ${definition.amplitude}-unit amplitude.`);
    assert(latePeak < earlyPeak * 0.5, `${definition.id} oscillation does not visibly damp before settling.`);
    const minimumSignChanges = index === 2 ? 4 : 3;
    assert(countSignChanges(displacements) >= minimumSignChanges, `${definition.id} pluck does not reflect its ${definition.frequency}Hz frequency.`);
  });

  const mobile = createFakeFixture({ width: 320, height: 32 });
  const mobileController = createSuccessHarpResonance({ root: mobile.root, motionQuery: { matches: false } });
  assert(await mobileController.play() === 'resonant-halo', 'Mobile controller did not play the deterministic resonance.');
  const mobileArtworkAnimation = getAnimationRecord(mobile, 'data-harp-stage');
  assert(mobileArtworkAnimation.keyframes.some(({ transform }) => transform === 'scale(1.5)'), 'A 32px mobile harp must target an apparent 48px height.');
  assert(mobile.runtime.animationRecords.filter(({ element }) => element.getAttribute('data-harp-halo-arc') !== null).length === 2, 'Mobile must omit the fine secondary halo arc.');
  assertNeutral(mobile, 'mobile completion');

  const reduced = createFakeFixture();
  const reducedController = createSuccessHarpResonance({ root: reduced.root, motionQuery: { matches: true } });
  assert(await reducedController.play() === null, 'Reduced motion must skip the resonance routine.');
  assert(reduced.runtime.animationRecords.length === 0 && reduced.runtime.frameHandles.size === 0, 'Reduced motion must not start WAAPI or animation frames.');
  assertNeutral(reduced, 'reduced motion');

  const noWaapi = createFakeFixture({ waapi: false });
  const noWaapiController = createSuccessHarpResonance({ root: noWaapi.root, motionQuery: { matches: false } });
  assert(await noWaapiController.play() === null, 'Missing Web Animations must fall back to the static harp.');
  assert(noWaapi.runtime.animationRecords.length === 0 && noWaapi.runtime.frameHandles.size === 0, 'No-WAAPI fallback must not start partial choreography.');
  assertNeutral(noWaapi, 'no-WAAPI fallback');

  const cancelled = createFakeFixture({ autoFrames: false });
  const cancelledController = createSuccessHarpResonance({ root: cancelled.root, motionQuery: { matches: false } });
  const cancelledPlay = cancelledController.play();
  assert(cancelled.root.classList.contains('is-harp-resonance-active'), 'Pending play never entered its active state.');
  cancelledController.reset();
  assert(await settleWithin(cancelledPlay, 'cancelled play') === null, 'Mid-sequence reset must resolve play with null.');
  assert(cancelled.runtime.animationCancels >= 6 && cancelled.runtime.cancelledFrames >= 1, 'Reset must cancel every active animation and animation frame.');
  assertNeutral(cancelled, 'mid-sequence cancellation');

  const reentrant = createFakeFixture({ autoFrames: false });
  const reentrantController = createSuccessHarpResonance({ root: reentrant.root, motionQuery: { matches: false } });
  const firstPlay = reentrantController.play();
  const secondPlay = reentrantController.play();
  assert(await settleWithin(firstPlay, 'reentrant first play') === null, 'Reentrant play must synchronously cancel the previous run.');
  reentrantController.reset();
  assert(await settleWithin(secondPlay, 'reentrant second play') === null, 'Reset must settle the replacement run.');
  assertNeutral(reentrant, 'reentrant reset');
}

const [
  harpSvg,
  lightWordmarkSvg,
  darkWordmarkSvg,
  noHarpWordmarkSvg,
  lightWordmarkPng,
  darkWordmarkPng,
  generatorSource,
  landingHtml,
  appHtml,
  previewHtml,
  previewSource,
  controllerSource,
  takeoverSource,
  successCss
] = await Promise.all([
  readFile(new URL('../assets/brand/planeir-harp-light.svg', import.meta.url), 'utf8'),
  readFile(new URL('../assets/brand/planeir-wordmark-light.svg', import.meta.url), 'utf8'),
  readFile(new URL('../assets/brand/planeir-wordmark-dark.svg', import.meta.url), 'utf8'),
  readFile(new URL('../assets/brand/planeir-wordmark-no-harp-light.svg', import.meta.url), 'utf8'),
  readFile(new URL('../assets/brand/planeir-wordmark-light.png', import.meta.url)),
  readFile(new URL('../assets/brand/planeir-wordmark-dark.png', import.meta.url)),
  readFile(new URL('./generate-planeir-harp-assets.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../app/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../dev/success-takeover-preview.html', import.meta.url), 'utf8'),
  readFile(new URL('../dev/success_takeover_preview.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/success_harp_resonance.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/success_takeover.js', import.meta.url), 'utf8'),
  readFile(new URL('../styles/success_takeover.css', import.meta.url), 'utf8')
]);

verifyCanonicalGeometry();
console.info('[SuccessResonanceCheck] PASS: smooth canonical frame and independent fixed-endpoint strings');

[
  [harpSvg, 'Standalone harp SVG'],
  [lightWordmarkSvg, 'Light wordmark SVG'],
  [darkWordmarkSvg, 'Dark wordmark SVG'],
  [noHarpWordmarkSvg, 'No-harp wordmark SVG']
].forEach(([source, label]) => assertStrictSvgXml(source, label));
verifySvgAssetGeometry(harpSvg, 'Standalone harp SVG', '#F3F8FF');
verifySvgAssetGeometry(lightWordmarkSvg, 'Light wordmark SVG', '#F3F8FF');
verifySvgAssetGeometry(darkWordmarkSvg, 'Dark wordmark SVG', '#07101D');
assert(!noHarpWordmarkSvg.includes('data-planeir-harp'), 'No-harp success wordmark must remain free of duplicate harp geometry.');
const noHarpLetters = extractTaggedPath(noHarpWordmarkSvg, 'd', null, 'No-harp wordmark SVG');
assert(normalizePath(noHarpLetters.pathData) === normalizePath(PLANEIR_WORDMARK_LETTER_PATH), 'No-harp SVG letters diverge from the shared wordmark geometry.');
const inlineLetters = createPlaneirWordmarkLettersMarkup();
const inlineLetterPath = extractTaggedPath(inlineLetters, 'data-planeir-wordmark-letters', null, 'Inline stage wordmark');
assert(normalizePath(inlineLetterPath.pathData) === normalizePath(PLANEIR_WORDMARK_LETTER_PATH), 'Inline stage letters diverge from the shared wordmark geometry.');
assert(JSON.stringify(parsePngDimensions(lightWordmarkPng, 'Light wordmark PNG')) === JSON.stringify({ width: 1330, height: 384 }), 'Light wordmark PNG dimensions changed.');
assert(JSON.stringify(parsePngDimensions(darkWordmarkPng, 'Dark wordmark PNG')) === JSON.stringify({ width: 1330, height: 384 }), 'Dark wordmark PNG dimensions changed.');
['HARP_FRAME_PATH', 'HARP_STRINGS', 'HARP_STRING_STROKE_WIDTH', 'planeir-harp-light.svg', 'planeir-wordmark-light.svg', 'planeir-wordmark-dark.svg', "process.argv.includes('--png')"].forEach((marker) => {
  assert(generatorSource.includes(marker), `Deterministic brand generator is missing ${marker}.`);
});
assert(!/Math\.random|Date\.now|new Date/.test(generatorSource), 'Brand asset generator must not include nondeterministic inputs.');
console.info('[SuccessResonanceCheck] PASS: SVG and raster exports share deterministic canonical artwork');

verifySuccessMarkup(landingHtml, {
  file: 'index.html',
  overlayId: 'leadSuccessOverlay',
  noHarpSrc: './assets/brand/planeir-wordmark-no-harp-light.svg',
  fullWordmarkSrc: './assets/brand/planeir-wordmark-light.svg'
});
verifySuccessMarkup(appHtml, {
  file: 'app/index.html',
  overlayId: 'publishSuccessOverlay',
  noHarpSrc: '../assets/brand/planeir-wordmark-no-harp-light.svg',
  fullWordmarkSrc: '../assets/brand/planeir-wordmark-light.svg'
});
verifySuccessMarkup(previewHtml, {
  file: 'dev/success-takeover-preview.html',
  overlayId: 'successPreviewOverlay',
  noHarpSrc: '../assets/brand/planeir-wordmark-no-harp-light.svg'
});
verifySuccessStyles(successCss);
verifyPreview(previewHtml, previewSource);
console.info('[SuccessResonanceCheck] PASS: success markup, mobile/reduced CSS, and local-only preview');

verifyControllerSource(controllerSource, takeoverSource);
console.info('[SuccessResonanceCheck] PASS: deterministic integration, post-flight neutral frames, copy ordering, and navigation reset');

await verifyControllerRuntime();
console.info('[SuccessResonanceCheck] PASS: 1.55s physics, mobile treatment, cleanup, cancellation, reentry, reduced motion, and no-WAAPI fallback');
console.info('[SuccessResonanceCheck] 5/5 Resonant Halo checks passed.');
