import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { createSuccessTakeover } from '../js/success_takeover.js';
import { alignmentFrame, createAlignmentMarkup, emphasis, SUCCESS_TIMING, PASSAGE_PATH } from '../js/success_alignment.js';
import { PLANEIR_WORDMARK_LETTER_PATH, NEWGRANGE_RING_PATH, NEWGRANGE_DISC_PATH, PLANEIR_TITTLE_TRANSFORM } from '../js/planeir_brand_artwork.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const RATIO = 1330 / 384;
const near = (actual, expected, label, tolerance = .001) => assert.ok(Math.abs(actual - expected) < tolerance, `${label}: ${actual} != ${expected}`);
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

class EventTarget {
  listeners = new Map();
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(handler);
  }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  dispatch(name, values = {}) {
    const event = {
      type: name, target: this, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; this.immediateStopped = true; },
      ...values
    };
    this.deliver(event);
    return event;
  }
  deliver(event) {
    for (const listener of [...(this.listeners.get(event.type) || [])]) {
      listener(event);
      if (event.immediateStopped) break;
    }
    if (event.type === 'click' && !event.stopped) this.parentNode?.deliver(event);
  }
  listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

const cssName = name => String(name).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
function createStyle() {
  const values = new Map();
  return new Proxy({
    setProperty(name, value) { values.set(name, String(value)); },
    removeProperty(name) { const prior = values.get(name) || ''; values.delete(name); return prior; },
    getPropertyValue(name) { return values.get(name) || ''; }
  }, {
    get(target, name) {
      if (name === 'cssText') return [...values].map(([key, value]) => `${key}: ${value};`).join(' ');
      if (name in target) return target[name];
      return values.get(cssName(name)) || '';
    },
    set(_target, name, value) {
      if (name === 'cssText') {
        values.clear();
        for (const entry of String(value).split(';')) {
          const colon = entry.indexOf(':');
          if (colon !== -1) values.set(entry.slice(0, colon).trim(), entry.slice(colon + 1).trim());
        }
      } else if (value === '') values.delete(cssName(name));
      else values.set(cssName(name), String(value));
      return true;
    }
  });
}

class ClassList {
  values = new Set();
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force = !this.contains(name)) { if (force) this.add(name); else this.remove(name); return force; }
}

function matches(node, selector) {
  return selector.split(',').some(part => {
    const item = part.trim();
    if (item.startsWith('.')) return node.classList.contains(item.slice(1));
    if (item.startsWith('#')) return node.getAttribute('id') === item.slice(1);
    const attr = item.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attr) {
      const actual = attr[1] === 'inert' && node.inert ? '' : attr[1] === 'hidden' && node.hidden ? '' : node.getAttribute(attr[1]);
      return actual !== null && (attr[2] === undefined || actual === attr[2]);
    }
    return node.tagName.toLowerCase() === item.toLowerCase();
  });
}

function parseTransform(source) {
  const match = source?.match(/translate3d\(([-\d.e+]+)px, ([-\d.e+]+)px, 0\) scale\(([-\d.e+]+)\)/);
  return match ? { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) } : { x: 0, y: 0, scale: 1 };
}

class Element extends EventTarget {
  constructor(document, tagName = 'div', className = '') {
    super();
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.classList = new ClassList();
    this.className = className;
    this.style = createStyle();
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.inert = false;
    this.hidden = false;
    this.disabled = false;
    this.rect = { left: 0, top: 0, width: 100, height: 40 };
    this._textContent = '';
  }
  set className(value) { this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classList.values].join(' '); }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
  appendChild(node) { if (node.parentNode) node.remove(); node.parentNode = this; this.children.push(node); return node; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  get textContent() { return this._textContent; }
  set textContent(value) { this._textContent = String(value); }
  set innerHTML(source) {
    this._innerHTML = String(source);
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
    // Only SVG effect lookup is needed. No fake browser parsing/layout claims.
    for (const match of this._innerHTML.matchAll(/<([a-z][\w-]*)\b([^>]*data-alignment-[^>]*)>/gi)) {
      const node = this.appendChild(new Element(this.ownerDocument, match[1]));
      for (const attribute of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attribute[1], attribute[2]);
    }
  }
  get innerHTML() { return this._innerHTML || ''; }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (matches(child, selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return matches(this, selector) ? this : this.parentNode?.closest(selector) || null; }
  getBoundingClientRect() {
    if (!this.isConnected || this.closest('[hidden]')) return { left: 0, top: 0, width: 0, height: 0 };
    const rect = { ...this.rect };
    for (let node = this; node; node = node.parentNode) {
      const pose = parseTransform(node.style.transform);
      if (pose.x || pose.y || pose.scale !== 1) {
        rect.left = node.rect.left + (rect.left - node.rect.left) * pose.scale + pose.x;
        rect.top = node.rect.top + (rect.top - node.rect.top) * pose.scale + pose.y;
        rect.width *= pose.scale;
        rect.height *= pose.scale;
      }
    }
    return rect;
  }
  getClientRects() { const rect = this.getBoundingClientRect(); return rect.width && rect.height ? [rect] : []; }
  focus() {
    if (!this.isConnected || this.disabled || this.closest('[inert], [hidden], [aria-hidden="true"]')) return;
    this.ownerDocument.activeElement = this;
  }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  decode() { return Promise.resolve(); }
}

function fixture(options = {}) {
  let now = 0;
  let nextHandle = 0;
  const pending = new Map();
  const clock = {
    now: () => now,
    request(callback) { pending.set(++nextHandle, callback); return nextHandle; },
    cancel(handle) { pending.delete(handle); }
  };
  const document = new EventTarget();
  document.hidden = false;
  document.createElement = tag => new Element(document, tag);
  document.body = new Element(document, 'body');
  document.activeElement = document.body;
  const window = new EventTarget();
  window.innerWidth = 1280;
  window.innerHeight = 900;
  window.visualViewport = { width: 1280, height: 900, offsetTop: 0, offsetLeft: 0 };
  window.performance = { now: clock.now };
  const motionQuery = new EventTarget();
  motionQuery.matches = Boolean(options.reduced);
  window.matchMedia = () => motionQuery;
  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = Element;
  globalThis.HTMLImageElement = Element;
  const add = (parent, tag = 'div', className = '') => parent.appendChild(new Element(document, tag, className));
  const background = add(document.body);
  const form = add(background, 'form');
  const trigger = add(form, 'button');
  const restoration = add(form, 'button');
  const preLocked = add(document.body);
  preLocked.inert = true;
  const origin = add(background, 'img');
  origin.rect = { left: 22, top: 18, width: 150, height: 150 / RATIO };
  const overlay = add(document.body, 'div', 'lead-success-overlay');
  overlay.setAttribute('aria-hidden', 'true');
  const target = add(overlay, 'div', 'lead-success-lockup');
  target.rect = { left: 330, top: 250, width: 620, height: 620 / RATIO };
  const shell = add(target, 'div', 'lead-success-wordmark-shell');
  shell.rect = { ...target.rect };
  const copy = add(overlay, 'div', 'lead-success-copy');
  const title = add(copy, 'h2');
  title.textContent = 'Old title';
  const body = add(copy, 'p');
  body.textContent = 'Old body';
  const timer = add(overlay, 'div', 'lead-success-timer');
  const timerBar = add(timer, 'span', 'lead-success-timer-bar');
  const controller = createSuccessTakeover({ overlay, origin, target, title, body, motionQuery, clock, lockTargets: [background, preLocked] });
  const f = { document, window, origin, overlay, target, shell, copy, title, body, timer, timerBar, trigger, restoration, background, preLocked, motionQuery, controller, pending, clock };
  f.effect = name => shell.querySelector(`[data-alignment-${name}]`);
  f.dismissButton = overlay.querySelector('.lead-success-dismiss');
  f.advance = async milliseconds => {
    assert.ok(milliseconds >= 0, 'Fake clock must not run backward');
    now += milliseconds;
    const ready = [...pending];
    ready.forEach(([handle]) => pending.delete(handle));
    ready.forEach(([, callback]) => callback(now));
    await flush();
  };
  f.start = async (playOptions = {}) => {
    if (document.activeElement === document.body) trigger.focus();
    f.playPromise = controller.play({ titleText: 'Congratulations', bodyText: 'Request received.', restoreFocusIfContainedIn: form, restoreFocusTo: restoration, ...playOptions });
    await flush();
    for (let frames = 0; !overlay.classList.contains('is-active') && frames < 40; frames += 1) await f.advance(16);
    assert.ok(overlay.classList.contains('is-active'), 'Takeover must start after bounded preparation');
    f.startedAt = now;
    return f;
  };
  f.at = time => f.advance(f.startedAt + time - now);
  f.snapshot = () => [target.style.cssText, copy.style.cssText, timerBar.style.cssText, overlay.style.cssText, ...['beam', 'ring', 'disc', 'neutral'].map(name => f.effect(name).getAttribute('opacity'))];
  f.assertClean = (label, { focus = restoration, originVisibility = '' } = {}) => {
    assert.equal(pending.size, 0, `${label}: pending RAF`);
    assert.equal(window.listenerCount() + document.listenerCount() + overlay.listenerCount() + motionQuery.listenerCount(), 0, `${label}: run listeners leaked`);
    assert.equal(overlay.getAttribute('aria-hidden'), 'true', `${label}: overlay exposed`);
    assert.equal(overlay.classList.contains('is-active'), false, `${label}: active class remains`);
    assert.equal(background.inert, false, `${label}: background inert not restored`);
    assert.equal(preLocked.inert, true, `${label}: pre-existing inert was cleared`);
    assert.equal(origin.style.visibility, originVisibility, `${label}: header visibility not restored`);
    assert.equal(f.effect('neutral').getAttribute('opacity'), '1', `${label}: artwork not neutral`);
    if (focus) assert.equal(document.activeElement, focus, `${label}: focus not restored`);
  };
  return f;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('canonical geometry, unique effects and all authored timing constants', async () => {
  assert.deepEqual(SUCCESS_TIMING, { flightStart: 80, flightEnd: 830, beamStart: 900, ignite: 1520, copyAt: 1850, copyEnd: 2270, exitAt: 5650, returnEnd: 6210, fadeOutAt: 6090, endAt: 6490 });
  const canonical = await readFile(resolve(root, 'assets/brand/planeir-lockup-light.svg'), 'utf8');
  for (const geometry of [PLANEIR_WORDMARK_LETTER_PATH, NEWGRANGE_RING_PATH, NEWGRANGE_DISC_PATH, PLANEIR_TITTLE_TRANSFORM]) assert.ok(canonical.includes(geometry), 'Generated geometry differs from handoff lockup');
  const first = createAlignmentMarkup();
  const second = createAlignmentMarkup();
  assert.equal((first.match(/<svg\b/g) || []).length, 1, 'The whole lockup must use one registered SVG');
  for (const geometry of [PLANEIR_WORDMARK_LETTER_PATH, NEWGRANGE_RING_PATH, NEWGRANGE_DISC_PATH, PLANEIR_TITTLE_TRANSFORM, PASSAGE_PATH]) assert.ok(first.includes(geometry));
  const ids = source => [...source.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const firstIds = ids(first), secondIds = ids(second);
  assert.equal(new Set([...firstIds, ...secondIds]).size, firstIds.length + secondIds.length, 'SVG IDs collide');
  for (const match of first.matchAll(/url\(#([^\)]+)\)/g)) assert.ok(firstIds.includes(match[1]), 'Unresolved SVG effect');
  near(alignmentFrame(830).glow, 0, 'Arrival unlit');
  near(alignmentFrame(900).beam, 0, 'Beam starts at900');
  near(alignmentFrame(1040).beam, 1, 'Beam fully visible');
  assert.ok(alignmentFrame(1520).glow > 0, 'Disc ignites');
  near(alignmentFrame(1200).focus, 1.08, '8% mark emphasis');
  near(alignmentFrame(2270).focus, 1, 'Emphasis settles');
  near(alignmentFrame(2270).beam, 0, 'Beam gone before hold');
});

test('normal6490ms timeline, exact return and complete cleanup', async () => {
  const f = await fixture().start();
  assert.equal(f.background.inert, true);
  assert.equal(f.origin.style.visibility, 'hidden');
  assert.equal(f.document.activeElement, f.dismissButton);
  assert.equal(f.copy.getAttribute('aria-hidden'), 'true');
  await f.at(420); near(Number(f.overlay.style.getPropertyValue('--lead-success-backdrop-opacity')), 1, 'Opaque backdrop');
  await f.at(830);
  const arrived = parseTransform(f.target.style.transform);
  near(arrived.x, 0, 'Arrival x'); near(arrived.y, 0, 'Arrival y'); near(arrived.scale, 1, 'Arrival scale');
  await f.at(1850); assert.equal(f.copy.getAttribute('aria-hidden'), null); near(Number(f.copy.style.opacity), 0, 'Copy entrance starts');
  await f.at(2060); near(Number(f.copy.style.transform.match(/translateY\(([^p]+)px\)/)[1]), 16 * (1 - emphasis(.5)), 'Prototype copy easing');
  await f.at(2270); near(Number(f.copy.style.opacity), 1, 'Copy fully shown');
  await f.at(3750); near(Number(f.timerBar.style.transform.match(/scaleX\(([^)]+)\)/)[1]), .5, '3800ms timer midpoint');
  await f.at(5650); assert.ok(f.overlay.classList.contains('is-exiting'));
  await f.at(6090); near(Number(f.overlay.style.getPropertyValue('--lead-success-backdrop-opacity')), 1, 'Fade starts6090');
  await f.at(6210);
  const landed = f.shell.getBoundingClientRect();
  for (const key of ['left', 'top', 'width', 'height']) near(landed[key], f.origin.rect[key], `Returned ${key}`);
  assert.equal(f.effect('neutral').getAttribute('opacity'), '1');
  assert.equal(f.origin.style.visibility, 'hidden');
  await f.at(6489); assert.ok(f.overlay.classList.contains('is-active'), 'Must not truncate final fade');
  await f.at(6490); assert.equal(await f.playPromise, true); f.assertClean('normal completion');
});

test('click, Escape, Close and repeated dismissal are continuous in every phase', async () => {
  for (const [at, method] of [[0, 'click'], [450, 'escape'], [1250, 'button'], [1900, 'click'], [3500, 'escape']]) {
    const f = await fixture().start();
    await f.at(at);
    const pose = f.target.style.transform;
    if (method === 'click') f.overlay.dispatch('click');
    else if (method === 'button') f.dismissButton.dispatch('click');
    else assert.equal(f.window.dispatch('keydown', { key: 'Escape' }).defaultPrevented, true);
    assert.equal(f.target.style.transform, pose, `Dismiss at${at} snaps immediately`);
    await f.advance(0); assert.equal(f.target.style.transform, pose, `Dismiss at${at} snaps on first frame`);
    f.overlay.dispatch('click'); f.window.dispatch('keydown', { key: 'Escape' });
    await f.advance(560);
    const landed = f.shell.getBoundingClientRect();
    near(landed.left, f.origin.rect.left, `Early dismissal${at} destination`);
    await f.advance(280); await f.playPromise; f.assertClean(`dismiss${at}`);
  }
});

test('reset, pagehide and popstate cancel every phase and settle pending play', async () => {
  for (const [at, action] of [[null, 'reset'], [300, 'reset'], [1100, 'pagehide'], [2000, 'popstate'], [5900, 'reset'], [6380, 'reset']]) {
    const f = fixture();
    if (at === null) {
      f.trigger.focus();
      f.playPromise = f.controller.play({ restoreFocusTo: f.restoration });
    } else { await f.start(); await f.at(at); }
    if (action === 'reset') f.controller.reset(); else f.window.dispatch(action);
    assert.equal(await f.playPromise, false);
    f.assertClean(`${action} at${at}`);
  }
});

test('replay settles old promise and retains original focus intent', async () => {
  const f = await fixture().start();
  const old = f.playPromise;
  await f.at(1200);
  await f.start();
  assert.equal(await old, false);
  assert.equal(f.overlay.children.filter(node => node.classList.contains('lead-success-dismiss')).length, 1);
  await f.at(5650); await f.at(6490); await f.playPromise;
  f.assertClean('replay');
});

test('hidden tab freezes animation and preserves all reading time', async () => {
  const f = await fixture().start();
  await f.at(3000);
  const before = f.snapshot();
  f.document.hidden = true; f.document.dispatch('visibilitychange');
  assert.equal(f.pending.size, 0);
  await f.advance(90000); assert.deepEqual(f.snapshot(), before);
  f.document.hidden = false; f.document.dispatch('visibilitychange');
  await f.advance(0); assert.deepEqual(f.snapshot(), before, 'Resume jumps authored clock');
  await f.advance(2650); assert.ok(f.overlay.classList.contains('is-exiting'));
  await f.advance(840); await f.playPromise; f.assertClean('visibility pause');
});

test('missing origin fades logo in place rather than popping or flying', async () => {
  const f = await fixture().start();
  await f.at(2500);
  f.origin.remove();
  const pose = f.target.style.transform;
  f.overlay.dispatch('click');
  await f.advance(200);
  near(Number(f.target.style.opacity), .5, 'Missing-origin logo fade');
  assert.equal(f.target.style.transform, pose, 'Missing-origin fallback moved logo');
  await f.advance(200); await f.playPromise; f.assertClean('missing origin');
});

test('resize midreturn rebases current pose, including disappearing destination', async () => {
  for (const removeOrigin of [false, true]) {
    const f = await fixture().start();
    await f.at(2500); f.overlay.dispatch('click'); await f.advance(280);
    const before = f.target.style.transform;
    if (removeOrigin) f.origin.remove();
    else f.origin.rect = { left: 55, top: 80, width: 180, height: 180 / RATIO };
    f.window.dispatch('resize'); await f.advance(0);
    assert.equal(f.target.style.transform, before, 'Resize reset to original exit pose');
    if (removeOrigin) {
      await f.advance(200); near(Number(f.target.style.opacity), .5, 'Midreturn fallback fade');
      await f.advance(200);
    } else {
      await f.advance(560);
      const landed = f.shell.getBoundingClientRect();
      near(landed.left, 55, 'Moved return destination x'); near(landed.top, 80, 'Moved return destination y');
      await f.advance(280);
    }
    await f.playPromise; f.assertClean(`resize ${removeOrigin ? 'missing' : 'moved'} origin`);
  }
});

test('reduced motion uses static lit artwork,200ms fades and3800ms timer', async () => {
  const f = await fixture({ reduced: true }).start();
  for (const time of [0, 100, 200, 1000, 3799]) {
    await f.at(time);
    assert.deepEqual(parseTransform(f.target.style.transform), { x: 0, y: 0, scale: 1 });
    assert.equal(f.effect('beam').getAttribute('opacity'), '0');
    assert.equal(f.effect('disc-bloom').getAttribute('opacity'), '0');
    assert.equal(f.effect('outer-bloom').getAttribute('opacity'), '0');
    assert.equal(f.effect('focus').getAttribute('transform'), 'translate(64 64) scale(1) translate(-64 -64)');
    if (time === 100) near(Number(f.target.style.opacity), .5, 'Reduced entrance fade');
    if (time >= 200) near(Number(f.timer.style.opacity), 1, 'Reduced timer visible');
  }
  await f.at(3800); assert.ok(f.overlay.classList.contains('is-exiting'));
  await f.at(3900); near(Number(f.target.style.opacity), .5, 'Reduced exit fade');
  await f.at(4000); assert.equal(await f.playPromise, false); f.assertClean('reduced completion');
});

test('styles, preexisting body lock and unavailable focus targets are preserved', async () => {
  const f = fixture();
  f.target.style.setProperty('outline', '1px solid red');
  f.origin.style.visibility = 'collapse';
  f.document.body.classList.add('is-lead-success-active');
  await f.start();
  f.restoration.hidden = true;
  f.controller.reset(); await f.playPromise;
  f.assertClean('saved state', { focus: null, originVisibility: 'collapse' });
  assert.equal(f.target.style.cssText, 'outline: 1px solid red;');
  assert.equal(f.document.body.classList.contains('is-lead-success-active'), true);
  assert.notEqual(f.document.activeElement, f.restoration, 'Hidden target received focus');
});

test('requested copy is measured before animation and keyboard stays in overlay', async () => {
  const f = fixture();
  f.trigger.focus();
  f.playPromise = f.controller.play({ titleText: 'New title', bodyText: 'New requested body.', restoreFocusTo: f.restoration });
  assert.equal(f.title.textContent, 'New title', 'Requested title must be set before measuring');
  assert.equal(f.body.textContent, 'New requested body.', 'Requested body must be set before measuring');
  assert.equal(f.copy.getAttribute('aria-hidden'), 'true');
  await flush();
  for (let i = 0; i < 5; i += 1) await f.advance(16);
  const tab = f.window.dispatch('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(tab.defaultPrevented, true);
  assert.equal(f.document.activeElement, f.dismissButton);
  f.controller.reset(); await f.playPromise; f.assertClean('copy and keyboard');
});

test('actual landing submit handler animates only successful requests', async () => {
  const source = await readFile(resolve(root, 'js/landing.js'), 'utf8');
  const handler = source.slice(source.indexOf('function bindLeadForm()'), source.indexOf('\nbindNavigation();'));
  assert.ok(handler.length > 500);
  for (const outcome of ['success', 'validation', 'api-error']) {
    let submit, sends = 0, animations = 0;
    const statuses = [];
    const document = { activeElement: null };
    let disabled = false;
    const button = { get disabled() { return disabled; }, set disabled(value) { disabled = value; if (value) document.activeElement = null; } };
    document.activeElement = button;
    const context = {
      document,
      leadForm: { contains: node => node === button, addEventListener: (_name, callback) => { submit = callback; }, setAttribute() {}, removeAttribute() {}, reset() {} },
      leadSubmitButton: button, leadFormStatus: {}, LEAD_SUCCESS_MESSAGE: 'Request received.',
      resetFieldValidity() {}, setFieldValidity() {}, normalizeLeadPayload: () => ({}),
      validateLeadPayload: () => outcome === 'validation' ? [{ message: 'Required', field: { focus() {} } }] : [],
      setFormStatus: (kind) => statuses.push(kind),
      submitLead: async () => { sends += 1; if (outcome === 'api-error') throw new Error('Rejected'); },
      getFriendlyLeadSubmitError: error => error.message,
      leadSuccessTakeover: { play: async options => { animations += 1; assert.equal(options.restoreFocus, true, 'Focus intent must survive disabling submit'); } }
    };
    runInNewContext(`${handler}\nbindLeadForm();`, context);
    assert.equal(animations, 0, 'Binding/page load must not animate');
    await submit({ preventDefault() {} });
    assert.equal(animations, outcome === 'success' ? 1 : 0, outcome);
    assert.equal(sends, outcome === 'validation' ? 0 : 1);
    assert.equal(button.disabled, false);
    assert.equal(statuses.at(-1), outcome === 'success' ? 'success' : 'error');
  }
});

test('actual adviser handler requires publish plus client-email success', async () => {
  const source = await readFile(resolve(root, 'js/app.js'), 'utf8');
  const handler = source.slice(source.indexOf('async function handlePublishGenerate()'), source.indexOf('\nasync function handleCopyPublishedPin()'));
  assert.ok(handler.length > 500);
  for (const outcome of ['email-success', 'share', 'publish-error', 'email-error', 'missing-email', 'read-only']) {
    let sends = 0, animations = 0;
    const document = { activeElement: null };
    let disabled = false;
    const button = { get disabled() { return disabled; }, set disabled(value) { disabled = value; if (value) document.activeElement = null; } };
    document.activeElement = button;
    const context = {
      document,
      runtimeConfig: { readOnly: outcome === 'read-only', allowPublish: true },
      ui: { publishGenerateButton: button, publishModal: { contains: node => node === button } }, appState: {},
      setPublishError() {}, showToast() {}, updatePublishActionState() {}, renderPublishedAccess() {},
      getPublishMode: () => outcome === 'share' ? 'share' : 'email',
      publishCurrentSession: async () => {
        if (outcome === 'publish-error') throw new Error('Publish failed');
        return { linkAccessMode: outcome === 'share' ? 'direct' : 'secure', clientEmail: outcome === 'missing-email' ? '' : 'test@example.invalid' };
      },
      queuePublishedAdvisorNotification: async () => {},
      sendPublishedSessionEmail: async () => { sends += 1; if (outcome === 'email-error') throw new Error('Email failed'); return {}; },
      mergePublishedEmailDelivery: (access) => access,
      playPublishSuccessTakeover: async restoreFocus => { animations += 1; assert.equal(restoreFocus, true, 'Focus intent must survive disabling publish'); }
    };
    await runInNewContext(`${handler}\nhandlePublishGenerate();`, context);
    assert.equal(animations, outcome === 'email-success' ? 1 : 0, outcome);
    assert.equal(sends, ['email-success', 'email-error'].includes(outcome) ? 1 : 0);
    assert.equal(button.disabled, false);
  }
  assert.equal((source.match(/await playPublishSuccessTakeover\(/g) || []).length, 1, 'Resends must not introduce another trigger');
});

let failed = 0;
for (const [name, fn] of tests) {
  let timeout;
  try {
    await Promise.race([fn(), new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Fake-clock test did not settle within1000ms')), 1000); })]);
    console.info(`[SuccessAlignmentCheck] PASS: ${name}`);
  }
  catch (error) { failed += 1; console.error(`[SuccessAlignmentCheck] FAIL: ${name}\n${error.stack}`); }
  finally { clearTimeout(timeout); }
}
console.info(`[SuccessAlignmentCheck] ${tests.length - failed}/${tests.length} checks passed. Fake DOM checks behavior only; browser visual/accessibility QA remains required.`);
if (failed) process.exitCode = 1;
