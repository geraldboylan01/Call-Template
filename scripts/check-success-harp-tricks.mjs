import { readFile } from 'node:fs/promises';
import {
  HARP_TRICKS,
  HARP_TRICK_REQUIRED_PARTS,
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

function extractCssRule(source, marker, occurrence = 0) {
  let markerIndex = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    markerIndex = source.indexOf(marker, markerIndex + 1);
    assert(markerIndex >= 0, `CSS rule containing ${marker} occurrence ${occurrence + 1} is missing.`);
  }
  const openingBraceIndex = source.indexOf('{', markerIndex);
  const closingBraceIndex = source.indexOf('}', openingBraceIndex);
  assert(openingBraceIndex > markerIndex && closingBraceIndex > openingBraceIndex, `CSS rule containing ${marker} is malformed.`);
  return source.slice(markerIndex, closingBraceIndex + 1);
}

function extractNumericDeclaration(rule, property) {
  const match = rule.match(new RegExp(`${escapeRegExp(property)}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  assert(match, `${property} must have a numeric value in ${rule.slice(0, rule.indexOf('{')).trim()}.`);
  return Number(match[1]);
}

function parseTransform(transform = '') {
  const translateMatch = transform.match(/translate3d\([^,]+,\s*(-?\d+(?:\.\d+)?)(%|px)?,/);
  const rotateMatch = transform.match(/rotate\((-?\d+(?:\.\d+)?)deg\)/);
  const scaleMatch = transform.match(/scale\((-?\d+(?:\.\d+)?)\)/);
  return {
    y: translateMatch ? Number(translateMatch[1]) : null,
    yUnit: translateMatch?.[2] || null,
    rotation: rotateMatch ? Number(rotateMatch[1]) : null,
    scale: scaleMatch ? Number(scaleMatch[1]) : null
  };
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

  animate(keyframes, animationOptions = {}) {
    this.runtime.animationStarts += 1;
    const animation = new FakeAnimation(this.runtime);
    this.runtime.animations.push(animation);
    this.runtime.animationRecords.push({
      element: this,
      keyframes: Array.from(keyframes || [], (keyframe) => ({ ...keyframe })),
      options: { ...animationOptions },
      animation
    });
    return animation;
  }
}

function createFakeCharacter(options = {}) {
  const runtime = {
    animationStarts: 0,
    animationCancels: 0,
    animations: [],
    animationRecords: [],
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

  const omittedParts = new Set(options.omitParts || []);
  const addPart = (parent, partName, partOptions = {}) => {
    if (!parent || omittedParts.has(partName)) {
      return null;
    }
    const {
      tagName = 'g',
      classNames = [],
      originValue = null,
      attributes = {}
    } = partOptions;
    const part = element({
      tagName,
      classNames,
      attributes: {
        'data-part': partName,
        ...(originValue ? { 'data-origin': originValue } : {}),
        ...attributes
      }
    });
    parent.appendChild(part);
    return part;
  };

  const addArm = (group, side, { includeBicep = false } = {}) => {
    const arm = addPart(group, `${side}-arm`, { originValue: '26px 66px' });
    addPart(arm, `${side}-upper-arm-line`, {
      tagName: 'path',
      classNames: ['lead-success-harp-limb', 'lead-success-harp-upper-limb'],
      attributes: { 'data-limb': '', 'data-growth-order': '0', pathLength: '1' }
    });
    if (includeBicep) {
      addPart(arm, `${side}-bicep`, {
        classNames: ['lead-success-harp-bicep-shell'],
        originValue: '7px 61px',
        attributes: { 'data-extremity': '', 'data-growth-order': '1' }
      });
    }
    addPart(arm, `${side}-elbow`, {
      tagName: 'circle',
      classNames: ['lead-success-harp-joint'],
      attributes: { 'data-extremity': '', 'data-growth-order': '1' }
    });
    const forearm = addPart(arm, `${side}-forearm`, { originValue: '0px 55px' });
    addPart(forearm, `${side}-forearm-line`, {
      tagName: 'path',
      classNames: ['lead-success-harp-limb', 'lead-success-harp-lower-limb'],
      attributes: { 'data-limb': '', 'data-growth-order': '1', pathLength: '1' }
    });
    addPart(forearm, `${side}-hand`, {
      tagName: 'ellipse',
      classNames: ['lead-success-harp-hand'],
      attributes: { 'data-extremity': '', 'data-growth-order': '2' }
    });
  };

  const addLeg = (group, side) => {
    const leg = addPart(group, `${side}-leg`, { originValue: '52px 120px' });
    addPart(leg, `${side}-thigh-line`, {
      tagName: 'path',
      classNames: ['lead-success-harp-limb', 'lead-success-harp-upper-limb'],
      attributes: { 'data-limb': '', 'data-growth-order': '0', pathLength: '1' }
    });
    addPart(leg, `${side}-knee`, {
      tagName: 'circle',
      classNames: ['lead-success-harp-joint'],
      attributes: { 'data-extremity': '', 'data-growth-order': '1' }
    });
    const shin = addPart(leg, `${side}-shin`, { originValue: '45px 143px' });
    addPart(shin, `${side}-shin-line`, {
      tagName: 'path',
      classNames: ['lead-success-harp-limb', 'lead-success-harp-lower-limb'],
      attributes: { 'data-limb': '', 'data-growth-order': '1', pathLength: '1' }
    });
    addPart(shin, `${side}-foot`, {
      tagName: 'ellipse',
      classNames: ['lead-success-harp-foot'],
      attributes: { 'data-extremity': '', 'data-growth-order': '2' }
    });
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
    ['left', 'right'].forEach((side) => {
      addArm(backGroup, side, { includeBicep: trickName === 'flex' });
      addLeg(backGroup, side);
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
      addPart(frontGroup, 'left-bicep-crease', {
        tagName: 'path',
        classNames: ['lead-success-harp-muscle-crease', 'lead-success-harp-limb-accent'],
        originValue: '7px 61px',
        attributes: { pathLength: '1' }
      });
      addPart(frontGroup, 'right-bicep-crease', {
        tagName: 'path',
        classNames: ['lead-success-harp-muscle-crease', 'lead-success-harp-limb-accent'],
        originValue: '133px 61px',
        attributes: { pathLength: '1' }
      });
    }
    if (trickName === 'selfie') {
      addPart(frontGroup, 'phone', { originValue: '168px 11px' });
      addPart(frontGroup, 'peace-sign', { originValue: '-24px 35px' });
      addPart(frontGroup, 'camera-flash', {
        tagName: 'circle',
        originValue: '174px -2px'
      });
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
  assert(!Object.hasOwn(character.root.dataset, 'harpPhase'), `${label}: lifecycle phase dataset remains.`);
  [...character.backRig.querySelectorAll('[data-trick]'), ...character.frontRig.querySelectorAll('[data-trick]')]
    .forEach((group) => {
      assert(group.attributes.has('hidden'), `${label}: a trick group is still exposed.`);
      assert(group.getAttribute('visibility') === 'hidden', `${label}: a trick group remains visible.`);
    });
  [character.scale, character.motion].forEach((node) => {
    assert(node.style.getPropertyValue('transform') === '', `${label}: an inline transform remains.`);
    assert(node.style.getPropertyValue('transform-origin') === '', `${label}: an inline transform origin remains.`);
    assert(node.style.getPropertyValue('will-change') === '', `${label}: will-change remains.`);
  });
  [...character.backRig.querySelectorAll('[data-origin]'), ...character.frontRig.querySelectorAll('[data-origin]')]
    .forEach((part) => {
      const partName = part.getAttribute('data-part') || 'unnamed articulated part';
      assert(part.style.getPropertyValue('transform-box') === '', `${label}: ${partName} retains transform-box.`);
      assert(part.style.getPropertyValue('transform-origin') === '', `${label}: ${partName} retains transform-origin.`);
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

function verifyArticulatedRigSource(characterSource) {
  assert(characterSource.includes('function createArmMarkup(options)'), 'Production rig must build arms through createArmMarkup.');
  assert(characterSource.includes('function createLegMarkup(options)'), 'Production rig must build legs through createLegMarkup.');
  assert(countOccurrences(characterSource, 'createArmMarkup({ side:') === 8, 'Every trick must create both articulated arms.');
  assert(countOccurrences(characterSource, 'createLegMarkup({ side:') === 8, 'Every trick must create both articulated legs.');

  [
    '${side}-arm',
    '${side}-upper-arm-line',
    '${side}-elbow',
    '${side}-forearm',
    '${side}-forearm-line',
    '${side}-hand',
    '${side}-leg',
    '${side}-thigh-line',
    '${side}-knee',
    '${side}-shin',
    '${side}-shin-line',
    '${side}-foot',
    '${side}-bicep'
  ].forEach((partName) => {
    assert(characterSource.includes(`data-part="${partName}"`), `Production rig generator is missing ${partName}.`);
  });

  [
    '${side}-upper-arm-line',
    '${side}-forearm-line',
    '${side}-thigh-line',
    '${side}-shin-line'
  ].forEach((partName) => {
    const normalizedPathPattern = new RegExp(
      `data-part="${escapeRegExp(partName)}"[^>]*data-limb[^>]*pathLength="1"`
    );
    assert(normalizedPathPattern.test(characterSource), `${partName} must be a normalized drawable limb segment.`);
  });

  ['left-bicep-crease', 'right-bicep-crease'].forEach((partName) => {
    assert(characterSource.includes(`data-part="${partName}"`), `Flex rig is missing ${partName}.`);
  });
  EXPECTED_TRICKS.forEach((trickName) => {
    assert(
      countOccurrences(characterSource, `data-trick="${trickName}"`) === 2,
      `${trickName} must have exactly one back rig group and one front rig group.`
    );
  });
}

function verifySuccessCharacterStyles(successCss) {
  const characterRule = extractCssRule(successCss, '.lead-success-harp-character {');
  assert(
    /--lead-success-harp-ink\s*:\s*#f3f8ff/i.test(characterRule),
    'Character ink must exactly match the light wordmark text.'
  );

  const limbRule = extractCssRule(successCss, '.lead-success-harp-limb,');
  assert(
    /stroke\s*:\s*var\(--lead-success-harp-ink\)/.test(limbRule),
    'Primary limbs must use the white wordmark ink rather than the blue accent.'
  );
  assert(/stroke-linecap\s*:\s*round/.test(limbRule), 'Primary limbs must retain rounded caps.');
  assert(/stroke-linejoin\s*:\s*round/.test(limbRule), 'Primary limbs must retain rounded joins.');
  const baseLimbWidth = extractNumericDeclaration(limbRule, 'stroke-width');
  assert(baseLimbWidth >= 9, `Primary limbs must be at least 9 units thick; found ${baseLimbWidth}.`);

  const upperLimbRule = extractCssRule(successCss, '.lead-success-harp-upper-limb {');
  const lowerLimbRule = extractCssRule(successCss, '.lead-success-harp-lower-limb {');
  const upperLimbWidth = extractNumericDeclaration(upperLimbRule, 'stroke-width');
  const lowerLimbWidth = extractNumericDeclaration(lowerLimbRule, 'stroke-width');
  assert(upperLimbWidth > baseLimbWidth, 'Upper limbs must be subtly thicker than the primary limb profile.');
  assert(lowerLimbWidth >= 8.5, `Lower limbs must retain a substantial white profile; found ${lowerLimbWidth}.`);

  const anatomyRule = extractCssRule(successCss, '.lead-success-harp-joint,');
  assert(/fill\s*:\s*var\(--lead-success-harp-ink\)/.test(anatomyRule), 'Hands, feet, joints, and biceps must be filled with wordmark white.');
  assert(/stroke\s*:\s*var\(--lead-success-harp-ink\)/.test(anatomyRule), 'Hands, feet, joints, and biceps must use a white outline.');
  const bicepRule = extractCssRule(successCss, '.lead-success-harp-bicep {', 1);
  assert(/paint-order\s*:\s*stroke fill/.test(bicepRule), 'Bicep silhouettes must render as clean filled forms.');

  const mobileLimbRule = extractCssRule(successCss, '.lead-success-harp-limb,', 1);
  const mobileLimbWidth = extractNumericDeclaration(mobileLimbRule, 'stroke-width');
  assert(
    mobileLimbWidth >= baseLimbWidth,
    `Mobile limbs must not become thinner than desktop limbs; found ${mobileLimbWidth} versus ${baseLimbWidth}.`
  );
}

function findFakePart(character, trickName, partName) {
  const groups = [
    ...character.backRig.querySelectorAll(`[data-trick="${trickName}"]`),
    ...character.frontRig.querySelectorAll(`[data-trick="${trickName}"]`)
  ];
  for (const group of groups) {
    const part = group.querySelector(`[data-part="${partName}"]`);
    if (part) {
      return part;
    }
  }
  return null;
}

function verifyFakeRigContract() {
  const character = createFakeCharacter();
  EXPECTED_TRICKS.forEach((trickName) => {
    HARP_TRICK_REQUIRED_PARTS[trickName].forEach((partName) => {
      assert(findFakePart(character, trickName, partName), `${trickName} fake rig is missing required part ${partName}.`);
    });

    const trickGroups = [
      ...character.backRig.querySelectorAll(`[data-trick="${trickName}"]`),
      ...character.frontRig.querySelectorAll(`[data-trick="${trickName}"]`)
    ];
    const partNames = trickGroups
      .flatMap((group) => group.querySelectorAll('[data-part]'))
      .map((part) => part.getAttribute('data-part'));
    assert(new Set(partNames).size === partNames.length, `${trickName} fake rig contains duplicate data-part names.`);

    const limbSegments = trickGroups.flatMap((group) => group.querySelectorAll('[data-limb]'));
    assert(limbSegments.length === 8, `${trickName} must have eight upper/lower limb paths; found ${limbSegments.length}.`);
    limbSegments.forEach((segment) => {
      assert(segment.getAttribute('pathLength') === '1', `${segment.getAttribute('data-part')} must use pathLength="1".`);
      assert(['0', '1'].includes(segment.getAttribute('data-growth-order')), `${segment.getAttribute('data-part')} has an invalid growth order.`);
    });

    trickGroups.flatMap((group) => group.querySelectorAll('[data-origin]')).forEach((part) => {
      assert(
        /^-?\d+(?:\.\d+)?px -?\d+(?:\.\d+)?px$/.test(part.getAttribute('data-origin')),
        `${part.getAttribute('data-part')} must have an explicit two-axis pixel origin.`
      );
    });
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
  assert(
    JSON.stringify(Object.keys(HARP_TRICK_REQUIRED_PARTS)) === JSON.stringify(EXPECTED_TRICKS),
    `HARP_TRICK_REQUIRED_PARTS must register exactly ${EXPECTED_TRICKS.join(', ')}.`
  );
  EXPECTED_TRICKS.forEach((trick) => {
    const definition = HARP_TRICKS[trick];
    const requiredParts = HARP_TRICK_REQUIRED_PARTS[trick];
    assert(typeof definition?.play === 'function', `${trick} must register a playable routine.`);
    assert(Number(definition?.duration) > 0, `${trick} must register a positive duration.`);
    assert(/^\d+(?:\.\d+)?% \d+(?:\.\d+)?%$/.test(definition?.motionOrigin || ''), `${trick} must register a percentage motion origin.`);
    assert(Array.isArray(requiredParts) && Object.isFrozen(requiredParts), `${trick} required parts must be a frozen array.`);
    assert(requiredParts.length === new Set(requiredParts).size, `${trick} required parts must not contain duplicates.`);
    assert(definition.requiredParts === requiredParts, `${trick} registry must use its exported required-parts contract.`);
  });
  const articulatedCore = [
    'left-arm', 'left-elbow', 'left-forearm', 'left-hand',
    'right-arm', 'right-elbow', 'right-forearm', 'right-hand',
    'left-leg', 'left-knee', 'left-shin', 'left-foot',
    'right-leg', 'right-knee', 'right-shin', 'right-foot'
  ];
  EXPECTED_TRICKS.forEach((trick) => {
    articulatedCore.forEach((partName) => {
      assert(HARP_TRICK_REQUIRED_PARTS[trick].includes(partName), `${trick} required parts are missing ${partName}.`);
    });
  });
  ['left-bicep', 'right-bicep', 'left-bicep-crease', 'right-bicep-crease'].forEach((partName) => {
    assert(HARP_TRICK_REQUIRED_PARTS.flex.includes(partName), `Flex required parts are missing ${partName}.`);
  });
  ['phone', 'peace-sign', 'camera-flash'].forEach((partName) => {
    assert(HARP_TRICK_REQUIRED_PARTS.selfie.includes(partName), `Selfie required parts are missing ${partName}.`);
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

function getTrickAnimationRecords(character, trickName) {
  const duration = HARP_TRICKS[trickName].duration;
  return character.runtime.animationRecords.filter((record) => record.options.duration === duration);
}

function findPartAnimationRecord(records, partName) {
  return records.find((record) => record.element.getAttribute('data-part') === partName) || null;
}

function getRotationAtOffset(record, offset) {
  const keyframe = record?.keyframes.find((candidate) => candidate.offset === offset);
  return keyframe ? parseTransform(keyframe.transform).rotation : null;
}

function assertMirroredRotations(leftRecord, rightRecord, label) {
  assert(leftRecord && rightRecord, `${label} mirrored animation records are missing.`);
  assert(leftRecord.keyframes.length === rightRecord.keyframes.length, `${label} mirrored keyframe counts differ.`);
  leftRecord.keyframes.forEach((leftKeyframe, index) => {
    const rightKeyframe = rightRecord.keyframes[index];
    assert(leftKeyframe.offset === rightKeyframe.offset, `${label} mirrored offsets differ at keyframe ${index + 1}.`);
    const leftRotation = parseTransform(leftKeyframe.transform).rotation;
    const rightRotation = parseTransform(rightKeyframe.transform).rotation;
    assert(leftRotation !== null && rightRotation !== null, `${label} keyframe ${index + 1} must rotate both sides.`);
    assert(Math.abs(leftRotation + rightRotation) < 0.001, `${label} keyframe ${index + 1} is not physically mirrored.`);
  });
}

async function verifyBackflipPhysics() {
  const character = createFakeCharacter();
  const controller = createSuccessHarpCharacter({
    root: character.root,
    motionQuery: { matches: false }
  });
  const result = await controller.play({ trickName: 'backflip' });
  assert(result === 'backflip', 'Articulated backflip must complete in the fake runtime.');
  assertCharacterIsNeutral(character, 'Completed backflip cleanup');

  const records = getTrickAnimationRecords(character, 'backflip');
  assert(records.length >= 9, `Backflip must animate the body and articulated limbs; found ${records.length} records.`);
  records.forEach((record) => {
    const partName = record.element.getAttribute('data-part') || 'character motion';
    assert(
      record.keyframes.every((keyframe) => !String(keyframe.transform || '').includes('scaleY(')),
      `Backflip ${partName} must bend at joints rather than compress with scaleY.`
    );
  });

  const motionRecord = records.find((record) => record.element === character.motion);
  assert(motionRecord, 'Backflip body trajectory animation is missing.');
  const trajectory = motionRecord.keyframes.map((keyframe) => ({
    offset: keyframe.offset,
    ...parseTransform(keyframe.transform)
  }));
  trajectory.forEach((frame, index) => {
    assert(
      frame.y !== null && (frame.y === 0 || frame.yUnit === '%'),
      `Backflip body keyframe ${index + 1} must use proportional vertical motion.`
    );
    assert(frame.rotation !== null, `Backflip body keyframe ${index + 1} must include rotation.`);
    if (index > 0) {
      assert(frame.offset > trajectory[index - 1].offset, `Backflip body offsets must increase at keyframe ${index + 1}.`);
      assert(frame.rotation <= trajectory[index - 1].rotation, `Backflip rotation must progress monotonically at keyframe ${index + 1}.`);
    }
  });
  assert(trajectory[0].y === 0 && trajectory[0].rotation === 0, 'Backflip must begin from a grounded neutral pose.');
  assert(trajectory.at(-1).y === 0 && trajectory.at(-1).rotation === -360, 'Backflip must finish grounded at exactly -360 degrees.');

  const firstAirborneIndex = trajectory.findIndex((frame) => frame.y < 0);
  assert(firstAirborneIndex > 0, 'Backflip must become airborne after its grounded setup.');
  const crouchIndex = trajectory.slice(0, firstAirborneIndex).findLastIndex((frame) => frame.y > 0);
  assert(crouchIndex >= 0, 'Backflip must crouch downward before takeoff.');

  const apexY = Math.min(...trajectory.map((frame) => frame.y));
  const apexIndices = trajectory
    .map((frame, index) => ({ frame, index }))
    .filter(({ frame }) => Math.abs(frame.y - apexY) < 0.001)
    .map(({ index }) => index);
  assert(apexIndices.length === 1, `Backflip must have one clean apex; found ${apexIndices.length}.`);
  const apexIndex = apexIndices[0];
  assert(apexIndex > firstAirborneIndex && trajectory[apexIndex].offset > 0.4 && trajectory[apexIndex].offset < 0.7, 'Backflip apex must occur once near the middle of the rotation.');
  for (let index = crouchIndex + 1; index <= apexIndex; index += 1) {
    assert(trajectory[index].y < trajectory[index - 1].y, `Backflip must rise continuously toward the apex at keyframe ${index + 1}.`);
  }

  const contactIndex = trajectory.findIndex((frame, index) => (
    index > apexIndex
    && frame.y === 0
    && frame.rotation === -360
    && frame.offset < 1
  ));
  assert(contactIndex > apexIndex, 'Backflip must return to ground after the apex with its rotation complete.');
  for (let index = apexIndex + 1; index <= contactIndex; index += 1) {
    assert(trajectory[index].y > trajectory[index - 1].y, `Backflip must descend continuously toward contact at keyframe ${index + 1}.`);
  }
  const absorptionIndex = trajectory.findIndex((frame, index) => index > contactIndex && frame.y > 0);
  assert(absorptionIndex > contactIndex, 'Backflip must absorb impact with a downward landing bend.');
  assert(
    trajectory.slice(absorptionIndex + 1).some((frame) => frame.y <= 0),
    'Backflip must recover upward after absorbing the landing.'
  );

  const leftLeg = findPartAnimationRecord(records, 'left-leg');
  const rightLeg = findPartAnimationRecord(records, 'right-leg');
  const leftShin = findPartAnimationRecord(records, 'left-shin');
  const rightShin = findPartAnimationRecord(records, 'right-shin');
  assertMirroredRotations(leftLeg, rightLeg, 'Backflip thighs');
  assertMirroredRotations(leftShin, rightShin, 'Backflip shins');

  [leftLeg, rightLeg].forEach((record) => {
    const partName = record.element.getAttribute('data-part');
    const tuckMagnitude = Math.max(...record.keyframes
      .filter((keyframe) => keyframe.offset >= 0.35 && keyframe.offset <= 0.7)
      .map((keyframe) => Math.abs(parseTransform(keyframe.transform).rotation)));
    assert(tuckMagnitude >= 80, `${partName} must drive a visible airborne tuck.`);
  });
  [leftShin, rightShin].forEach((record) => {
    const partName = record.element.getAttribute('data-part');
    assert(Math.abs(getRotationAtOffset(record, 0.16)) >= 40, `${partName} must flex during the takeoff crouch.`);
    const tuckMagnitude = Math.max(...record.keyframes
      .filter((keyframe) => keyframe.offset >= 0.35 && keyframe.offset <= 0.7)
      .map((keyframe) => Math.abs(parseTransform(keyframe.transform).rotation)));
    assert(tuckMagnitude >= 100, `${partName} must fold decisively during the airborne tuck.`);
    assert(Math.abs(getRotationAtOffset(record, 0.8)) <= 15, `${partName} must extend before ground contact.`);
    assert(Math.abs(getRotationAtOffset(record, 0.91)) >= 30, `${partName} must bend again to absorb landing impact.`);
    assert(parseTransform(record.keyframes.at(-1).transform).rotation === 0, `${partName} must recover to neutral.`);
  });
}

async function verifyFlexBiceps() {
  const character = createFakeCharacter();
  const controller = createSuccessHarpCharacter({
    root: character.root,
    motionQuery: { matches: false }
  });
  const result = await controller.play({ trickName: 'flex' });
  assert(result === 'flex', 'Articulated flex must complete in the fake runtime.');
  assertCharacterIsNeutral(character, 'Completed flex cleanup');

  const records = getTrickAnimationRecords(character, 'flex');
  const leftBicep = findPartAnimationRecord(records, 'left-bicep');
  const rightBicep = findPartAnimationRecord(records, 'right-bicep');
  const leftCrease = findPartAnimationRecord(records, 'left-bicep-crease');
  const rightCrease = findPartAnimationRecord(records, 'right-bicep-crease');
  assert(leftBicep && rightBicep, 'Flex must animate both filled bicep silhouettes.');
  assert(leftCrease && rightCrease, 'Flex must animate both bicep crease accents.');
  assert(JSON.stringify(leftBicep.keyframes) === JSON.stringify(rightBicep.keyframes), 'Flex bicep pulses must be symmetrical.');

  const scales = leftBicep.keyframes.map((keyframe) => parseTransform(keyframe.transform).scale);
  const strongPeaks = scales.filter((scale, index) => (
    index > 0
    && index < scales.length - 1
    && scale >= 1.08
    && scale > scales[index - 1]
    && scale > scales[index + 1]
  ));
  assert(strongPeaks.length === 2, `Flex must contain exactly two restrained bicep peaks; found ${strongPeaks.length}.`);
  assert(scales.at(-1) === 1, 'Flex biceps must settle to their neutral geometry.');
}

async function verifyCharacterChoreography() {
  await verifyBackflipPhysics();
  await verifyFlexBiceps();
}

async function verifyCharacterLifecycle() {
  const reducedCharacter = createFakeCharacter();
  const mutableMotionQuery = { matches: true };
  const reducedController = createSuccessHarpCharacter({
    root: reducedCharacter.root,
    motionQuery: mutableMotionQuery,
    randomSource: createSeededRandom(0xa11ce)
  });
  assert(
    await reducedController.play({ trickName: 'selfie' }) === null,
    'Reduced motion must skip the requested trick.'
  );
  assert(reducedCharacter.runtime.animationStarts === 0, 'Reduced motion must not start limb, prop, scale, or flash animations.');
  assert(reducedCharacter.runtime.animationRecords.length === 0, 'Reduced motion must not record any character animation keyframes.');
  assertCharacterIsNeutral(reducedCharacter, 'Reduced-motion cleanup');

  mutableMotionQuery.matches = false;
  const firstAfterReducedSkip = await reducedController.play({ trickName: 'random' });
  const mirrorCharacter = createFakeCharacter();
  const mirrorController = createSuccessHarpCharacter({
    root: mirrorCharacter.root,
    motionQuery: { matches: false },
    randomSource: createSeededRandom(0xa11ce)
  });
  const firstWithoutReducedSkip = await mirrorController.play({ trickName: 'random' });
  assert(
    firstAfterReducedSkip === firstWithoutReducedSkip,
    'A reduced-motion skip must not consume an entry from the shuffled trick bag.'
  );
  assertCharacterIsNeutral(reducedCharacter, 'Post-reduced random cleanup');
  assertCharacterIsNeutral(mirrorCharacter, 'Reduced-motion bag mirror cleanup');

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

  const incompleteCharacter = createFakeCharacter({ omitParts: ['left-knee'] });
  const incompleteController = createSuccessHarpCharacter({
    root: incompleteCharacter.root,
    motionQuery: { matches: false }
  });
  assert(
    await incompleteController.play({ trickName: 'backflip' }) === null,
    'A trick with a missing required articulated part must fail closed.'
  );
  assert(incompleteCharacter.runtime.animationStarts === 0, 'An incomplete rig must not begin emergence or choreography.');
  assertCharacterIsNeutral(incompleteCharacter, 'Incomplete-rig cleanup');

  const character = createFakeCharacter();
  const controller = createSuccessHarpCharacter({
    root: character.root,
    motionQuery: { matches: false },
    randomSource: createSeededRandom(0xdecafbad)
  });
  const cancelledPlay = controller.play({ trickName: 'backflip' });
  assert(character.root.dataset.harpTrick === 'backflip', 'Forced backflip must activate synchronously.');
  assert(character.root.dataset.harpPhase === 'emergence', 'Backflip must begin in the emergence phase.');
  controller.reset();
  assertCharacterIsNeutral(character, 'Synchronous reset');
  assert(character.runtime.animationCancels > 0, 'Reset must synchronously cancel active Web Animation handles.');
  assert(
    character.runtime.animationCancels === character.runtime.animationStarts,
    'Immediate reset must synchronously cancel every animation handle that was started.'
  );
  assert(await cancelledPlay === null, 'Cancelled playback must resolve without reporting a completed trick.');

  const supersededPlay = controller.play({ trickName: 'backflip' });
  const winningPlay = controller.play({ trickName: 'spin' });
  assert(character.root.dataset.harpTrick === 'spin', 'Reentrant playback must synchronously replace the active trick.');
  const [supersededResult, winningResult] = await Promise.all([supersededPlay, winningPlay]);
  assert(supersededResult === null, 'Superseded playback must not report completion.');
  assert(winningResult === 'spin', 'The latest reentrant playback must complete deterministically.');
  assertCharacterIsNeutral(character, 'Completed reentrant playback');
}

const [fullSvg, noHarpSvg, landingHtml, appHtml, takeoverSource, characterSource, successCss] = await Promise.all([
  readFile(new URL('../assets/brand/planeir-wordmark-light.svg', import.meta.url), 'utf8'),
  readFile(new URL('../assets/brand/planeir-wordmark-no-harp-light.svg', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../app/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../js/success_takeover.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/success_harp_character.js', import.meta.url), 'utf8'),
  readFile(new URL('../styles/success_takeover.css', import.meta.url), 'utf8')
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

verifyArticulatedRigSource(characterSource);
verifySuccessCharacterStyles(successCss);
verifyFakeRigContract();
console.info('[SuccessHarpCheck] PASS: articulated rig structure and white anatomical styling');

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
console.info('[SuccessHarpCheck] PASS: trick registry, required parts, overrides, shuffle bags, and repeat prevention');
await verifyCharacterChoreography();
console.info('[SuccessHarpCheck] PASS: articulated backflip physics and flex bicep choreography');
await verifyCharacterLifecycle();
console.info('[SuccessHarpCheck] PASS: reduced motion, no-WAAPI fallback, cancellation, reentrancy, and neutral cleanup');
console.info('[SuccessHarpCheck] 6/6 success animation checks passed.');
