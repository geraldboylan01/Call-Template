import {
  CLICK_MS,
  SETTLE_GRACE_MS,
  buildGoalsAndResourcesModule,
  createGarClock
} from './goals_and_resources_module.js';
import { GOALS_AND_RESOURCES_SAMPLE } from './tests_goals_and_resources_math.js';
import { findForbiddenText } from './goals_and_resources_view.js';

/**
 * THE MODULE'S CLOCK AND DOM, DRIVEN FOR REAL.
 *
 * The repo has no DOM dependency and that is worth keeping, so the module is
 * run against the small shim below: it implements only what the module uses.
 * Time is fake and stepped by hand, which is what lets a check do the two
 * things a browser makes awkward: starve every animation frame, and deliver a
 * stale frame late.
 *
 * THE ACCEPTANCE RULE (it is the repayment module's). After any sequence of
 * clicks the drawn state must equal a fresh render of the last case, and no two
 * figures on screen may disagree at any point.
 */

const NAMES = Object.freeze(['Niamh', 'Dara']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function runCase(name, testFn) {
  try {
    testFn();
    console.info(`[GoalsAndResourcesModuleTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[GoalsAndResourcesModuleTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

async function runAsyncCase(name, testFn) {
  try {
    await testFn();
    console.info(`[GoalsAndResourcesModuleTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[GoalsAndResourcesModuleTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

/* ------------------------------------------------------------ fake time */

function createScheduler() {
  const sched = { now: 0, frames: [], timers: [], nextId: 1 };

  sched.requestFrame = (fn) => {
    const id = sched.nextId;
    sched.nextId += 1;
    sched.frames.push({ id, fn });
    return id;
  };
  sched.cancelFrame = (id) => {
    sched.frames = sched.frames.filter((frame) => frame.id !== id);
  };
  sched.setTimer = (fn, ms) => {
    const id = sched.nextId;
    sched.nextId += 1;
    sched.timers.push({ id, at: sched.now + ms, fn });
    return id;
  };
  sched.clearTimer = (id) => {
    sched.timers = sched.timers.filter((timer) => timer.id !== id);
  };

  /** Step time by hand. `frames: false` is a starved, backgrounded tab. */
  sched.advance = (ms, { frames = true } = {}) => {
    const end = sched.now + ms;
    while (sched.now < end) {
      const next = Math.min(sched.now + 16, end);
      sched.now = next;
      const due = sched.timers.filter((timer) => timer.at <= sched.now).sort((a, b) => a.at - b.at);
      sched.timers = sched.timers.filter((timer) => timer.at > sched.now);
      due.forEach((timer) => timer.fn());
      if (frames) {
        const batch = sched.frames;
        sched.frames = [];
        batch.forEach((frame) => frame.fn(sched.now));
      }
    }
  };
  return sched;
}

/* -------------------------------------------------------------- DOM shim */

class FakeNode {
  constructor(tag, namespace = null) {
    this.tagName = tag;
    this.namespace = namespace;
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.listeners = {};
    this.className = '';
    this.type = '';
    this.clientWidth = 0;
    this._text = '';
    this._attached = false;
  }

  get classList() {
    const self = this;
    const names = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add: (name) => { if (!names().includes(name)) self.className = [...names(), name].join(' '); },
      remove: (name) => { self.className = names().filter((entry) => entry !== name).join(' '); },
      toggle: (name, on) => {
        const has = names().includes(name);
        const want = on === undefined ? !has : Boolean(on);
        if (want && !has) self.className = [...names(), name].join(' ');
        if (!want && has) self.className = names().filter((entry) => entry !== name).join(' ');
      },
      contains: (name) => names().includes(name)
    };
  }

  get isConnected() {
    let node = this;
    while (node) {
      if (node._attached) return true;
      node = node.parent;
    }
    return false;
  }

  get firstChild() { return this.children[0] || null; }

  get lastChild() { return this.children[this.children.length - 1] || null; }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }

  append(...nodes) {
    nodes.forEach((node) => {
      node.parent = this;
      this.children.push(node);
    });
  }

  replaceChildren(...nodes) {
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }

  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  click() {
    (this.listeners.click || []).forEach((fn) => fn({ target: this }));
  }
}

function hasClass(node, className) {
  return node.className.split(/\s+/).includes(className);
}

function findAll(node, className, found = []) {
  if (hasClass(node, className)) found.push(node);
  node.children.forEach((child) => findAll(child, className, found));
  return found;
}

/** What a person would read: visible text, plus every accessible name. */
function visibleStrings(node, out = []) {
  if (node.hidden) return out;
  if (node.children.length === 0 && node._text.trim()) out.push(node._text.trim());
  const label = node.getAttribute('aria-label');
  if (label) out.push(label);
  node.children.forEach((child) => visibleStrings(child, out));
  return out;
}

/** Everything a person could see differ: the words, every mark's place and size, every state class. */
function snapshot(root) {
  const marks = [];
  const walk = (node) => {
    if (node.className.includes('gar-') && !node.className.includes('gar-plot ')) {
      const { top, left, height, width, opacity } = node.style;
      if (top !== undefined || height !== undefined || opacity !== undefined) {
        marks.push([node.className, node.textContent, top, left, height, width, opacity]);
      } else if (/is-(short|spare|covered|partly|not|active)/.test(node.className)) {
        marks.push([node.className, node.textContent]);
      }
    }
    node.children.forEach(walk);
  };
  walk(root);
  return JSON.stringify({ strings: visibleStrings(root), marks, root: root.className });
}

/** Install the shim, a scheduler and a resize observer that a test can fire. */
function installDom({ reducedMotion = false } = {}) {
  const sched = createScheduler();
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver
  };
  const observers = [];
  globalThis.document = {
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (namespace, tag) => new FakeNode(tag, namespace)
  };
  globalThis.window = {
    matchMedia: () => ({ matches: reducedMotion }),
    setTimeout: sched.setTimer,
    clearTimeout: sched.clearTimer
  };
  globalThis.requestAnimationFrame = sched.requestFrame;
  globalThis.cancelAnimationFrame = sched.cancelFrame;
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.live = true;
      observers.push(this);
    }

    observe() {}

    disconnect() { this.live = false; }
  };
  return {
    sched,
    observers,
    restore() {
      globalThis.document = saved.document;
      globalThis.window = saved.window;
      globalThis.requestAnimationFrame = saved.requestAnimationFrame;
      globalThis.cancelAnimationFrame = saved.cancelAnimationFrame;
      globalThis.ResizeObserver = saved.ResizeObserver;
    }
  };
}

function mount(options = {}) {
  const root = buildGoalsAndResourcesModule({
    rawInputs: GOALS_AND_RESOURCES_SAMPLE,
    widthHint: 1776,
    ...options
  });
  assert(root, 'the module built');
  root._attached = true;
  return root;
}

const CASE_IDS = Object.freeze(['cash-stays', 'college-today', 'mortgage-all-cash', 'mortgage-then-college']);

const press = (root, id) => findAll(root, 'gar-case').find((button) => button.dataset.caseId === id).click();

/* ----------------------------------------------------------------- tests */

export async function runGoalsAndResourcesModuleTests() {
  const cases = [];

  cases.push(runCase('The clock paints eased progress from the first frame and ends exactly on 1', () => {
    const sched = createScheduler();
    const clock = createGarClock(sched);
    const painted = [];
    clock.run(CLICK_MS, (progress) => painted.push(progress));
    sched.advance(CLICK_MS + 200);
    assert(painted.length >= 5, `frames were painted (${painted.length})`);
    assertEqual(painted[painted.length - 1], 1, 'the last paint is exactly 1');
    painted.forEach((value, index) => {
      assert(value >= 0 && value <= 1, `progress ${value} is inside 0 to 1`);
      if (index > 0) assert(value >= painted[index - 1], 'progress never runs backwards');
    });
    assertEqual(painted.filter((value) => value === 1).length, 1, 'the end state is painted once');
    assertEqual(sched.frames.length + sched.timers.length, 0, 'nothing is left scheduled');
  }));

  cases.push(runCase('A starved tab still lands the end state, and a late frame cannot undo it', () => {
    const sched = createScheduler();
    const clock = createGarClock(sched);
    const painted = [];
    clock.run(CLICK_MS, (progress) => painted.push(progress));
    // The frame the browser would deliver, held back.
    const lateFrame = sched.frames[0].fn;

    sched.advance(CLICK_MS + SETTLE_GRACE_MS + 50, { frames: false });
    assertEqual(painted.length, 1, 'only the settle timer painted');
    assertEqual(painted[0], 1, 'and it painted the end state');

    // A frame arriving after the timer must not restart the run from 0.
    lateFrame(sched.now + 5000);
    lateFrame(sched.now + 5016);
    assertEqual(painted.length, 1, 'the late frames painted nothing');
  }));

  cases.push(runCase('A click mid-travel cancels the run in flight: stale frames never paint', () => {
    const sched = createScheduler();
    const clock = createGarClock(sched);
    const first = [];
    const second = [];
    clock.run(CLICK_MS, (progress) => first.push(progress));
    sched.advance(160);
    const staleFrame = sched.frames[0].fn;
    const firstCount = first.length;

    clock.run(CLICK_MS, (progress) => second.push(progress));
    staleFrame(sched.now + 16);
    assertEqual(first.length, firstCount, 'the first run painted nothing more');

    sched.advance(CLICK_MS + 200);
    assertEqual(second[second.length - 1], 1, 'the second run ended on 1');
    assertEqual(first.length, firstCount, 'the first run is still silent');
  }));

  cases.push(runCase('Reduced motion paints the end state at once and schedules nothing', () => {
    const sched = createScheduler();
    const clock = createGarClock(sched);
    const painted = [];
    clock.run(0, (progress) => painted.push(progress));
    assertEqual(JSON.stringify(painted), '[1]', 'one paint, on 1');
    assertEqual(sched.frames.length + sched.timers.length, 0, 'nothing scheduled');
  }));

  cases.push(runCase('A module that has gone paints nothing', () => {
    const sched = createScheduler();
    let alive = true;
    const clock = createGarClock({ ...sched, requestFrame: sched.requestFrame, isAlive: () => alive });
    const painted = [];
    clock.run(CLICK_MS, (progress) => painted.push(progress));
    sched.advance(48);
    const before = painted.length;
    alive = false;
    sched.advance(200);
    assertEqual(painted.length, before, 'no paint once it is gone');
  }));

  cases.push(runCase('After any sequence of clicks the drawn state equals a fresh render of the last case', () => {
    const env = installDom();
    try {
      const sequences = [
        ['college-today', 'mortgage-all-cash', 'mortgage-then-college', 'cash-stays', 'mortgage-all-cash'],
        ['mortgage-then-college', 'cash-stays'],
        ['mortgage-all-cash', 'college-today', 'mortgage-all-cash', 'college-today', 'mortgage-then-college']
      ];
      [1776, 1100, 390].forEach((widthHint) => {
        sequences.forEach((sequence, run) => {
          const root = mount({ widthHint });
          sequence.forEach((id, index) => {
            press(root, id);
            // Alternate between a patient click-through, a fast one and a starved tab.
            const mode = (index + run) % 3;
            if (mode === 0) env.sched.advance(80);
            if (mode === 1) env.sched.advance(8);
            if (mode === 2) env.sched.advance(30, { frames: false });
          });
          env.sched.advance(CLICK_MS * 3, { frames: false });
          env.sched.advance(CLICK_MS * 2);

          const last = sequence[sequence.length - 1];
          const fresh = mount({ widthHint, selectedCaseId: last });
          assertEqual(snapshot(root), snapshot(fresh), `${widthHint}: sequence ${run + 1} ends on a fresh render of ${last}`);
          assertEqual(root.garState().selectedId, last, 'the selected case');
        });
      });
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Halfway through a click every mark is between its two ends, and the words are already the new ones', () => {
    const env = installDom();
    try {
      const root = mount();
      const before = { ...root.garState().values };
      press(root, 'mortgage-all-cash');
      const headline = findAll(root, 'gar-headline')[0];
      assertEqual(headline.textContent, 'You’re short by €8,736 a year', 'the headline changed at the click');
      assertEqual(
        findAll(root, 'gar-support')[0].textContent,
        'Your goals need €14,736 a year against the €6,000 you have, counting the €1,245 a lower repayment frees.',
        'the support line changed at the click'
      );

      const target = mount({ selectedCaseId: 'mortgage-all-cash' }).garState().values;
      env.sched.advance(CLICK_MS / 2);
      const middle = root.garState().values;
      Object.keys(target).forEach((key) => {
        const low = Math.min(before[key], target[key]) - 1e-9;
        const high = Math.max(before[key], target[key]) + 1e-9;
        assert(middle[key] >= low && middle[key] <= high, `${key} is between its ends mid-travel`);
      });
      env.sched.advance(CLICK_MS);
      assertEqual(JSON.stringify(root.garState().values), JSON.stringify(target), 'and it lands exactly on the target');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Reduced motion: a click lands on the new case in the same call', () => {
    const env = installDom({ reducedMotion: true });
    try {
      const root = mount();
      press(root, 'college-today');
      assertEqual(env.sched.frames.length + env.sched.timers.length, 0, 'nothing was scheduled');
      assertEqual(
        snapshot(root),
        snapshot(mount({ selectedCaseId: 'college-today' })),
        'the screen already shows the new case'
      );
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('A click moves the pressed state and the marks, and the scale does not move', () => {
    const env = installDom();
    try {
      const root = mount();
      const scale = () => {
        const year = findAll(root, 'gar-plot-year')[0];
        const have = findAll(year, 'gar-bar-have')[0];
        return `${year.style.height}|${have.style.height}|${have.style.width}`;
      };
      const before = scale();
      const pressed = () => findAll(root, 'gar-case').map((button) => button.getAttribute('aria-pressed')).join(',');
      assertEqual(pressed(), 'true,false,false,false', 'opens on case 1');

      press(root, 'mortgage-all-cash');
      assertEqual(pressed(), 'false,false,true,false', 'the pressed state moved at the click');
      env.sched.advance(CLICK_MS + 200);
      assertEqual(scale(), before, 'the yearly scale is the same in the next case');
      assertEqual(root.garState().selectedId, 'mortgage-all-cash', 'the case on screen');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('The short state is a word and a square beside it, in the headline and in the picture', () => {
    const env = installDom();
    try {
      const root = mount();
      const status = findAll(root, 'gar-status')[0];
      assert(hasClass(status, 'is-short'), 'the headline square is the short square');
      assertEqual(status.textContent, '', 'a solid square has no text of its own');
      assertEqual(findAll(root, 'gar-short-word')[0].textContent, 'Short by', 'the word beside the picture square');
      assertEqual(findAll(root, 'gar-short-amount')[0].textContent, '€14,062 a year', 'and the amount');
      assert(hasClass(findAll(root, 'gar-short-line')[0].children[0], 'is-short'), 'the picture square is red');

      const spare = mount({ rawInputs: { ...GOALS_AND_RESOURCES_SAMPLE, leftOverEachYear: 26_000 } });
      assert(hasClass(findAll(spare, 'gar-status')[0], 'is-spare'), 'the headline square is green when there is spare');
      assertEqual(findAll(spare, 'gar-short-word')[0].textContent, 'To spare', 'and the word changes');
      assertEqual(
        findAll(spare, 'gar-headline')[0].textContent,
        'You have €5,938 a year to spare',
        'the spare headline'
      );
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Money left over with a goal not met says "left over", in amber, with the target sentence', () => {
    const env = installDom();
    try {
      const raw = {
        ...GOALS_AND_RESOURCES_SAMPLE,
        leftOverEachYear: 30_000,
        retirement: { retirementAge: 55, targetIncomeToday: 200_000 }
      };
      [1776, 390].forEach((widthHint) => {
        const root = mount({ rawInputs: raw, widthHint });
        assert(hasClass(findAll(root, 'gar-status')[0], 'is-left'), `${widthHint}: the headline square is amber`);
        assert(!hasClass(findAll(root, 'gar-status')[0], 'is-spare'), `${widthHint}: and not green`);
        assertEqual(findAll(root, 'gar-headline')[0].textContent, 'You have €1,203 a year left over', `${widthHint}: headline`);
        assertEqual(
          findAll(root, 'gar-support')[0].textContent,
          'Your retirement target is not met, even at the most income tax relief allows.',
          `${widthHint}: support`
        );
        assertEqual(findAll(root, 'gar-short-word')[0].textContent, 'Left over', `${widthHint}: the picture's word`);
        const goalDetails = findAll(root, 'gar-goal-detail').map((node) => node.textContent);
        assert(
          goalDetails.some((text) => text === 'At the most income tax relief allows, and still short of your target.'),
          `${widthHint}: the retirement row carries the approved sentence`
        );
        const problems = findForbiddenText(visibleStrings(root), { names: NAMES });
        assert(problems.length === 0, `${widthHint}: ${problems.join('; ')}`);
      });
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Goals not covered are drawn as an outline above the line and covered goals as solid ones below it', () => {
    const env = installDom();
    try {
      const root = mount();
      const shorts = findAll(root, 'gar-short-block');
      const solids = findAll(findAll(root, 'gar-plot-year')[0], 'gar-block');
      assertEqual(shorts.length, 4, 'one outline per goal');
      assertEqual(solids.length, 4, 'one solid per goal');
      const water = parseFloat(findAll(root, 'gar-water')[0].style.top);
      shorts.forEach((node, index) => {
        if (node.style.opacity !== '1') return;
        assert(parseFloat(node.style.top) - 1 >= water - 0.05, `outline ${index} starts at or below the line`);
      });
      solids.forEach((node, index) => {
        if (node.style.opacity !== '1') return;
        const end = parseFloat(node.style.top) - 1 + parseFloat(node.style.height);
        assert(end <= water + 0.05, `solid ${index} ends at or above the line`);
      });
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Nothing rendered says a banned phrase, a provider, "p.a.", a bare amount or a name, at every width', () => {
    const env = installDom();
    try {
      [1776, 1100, 390].forEach((widthHint) => {
        const root = mount({ widthHint, badge: 'Illustrative household, not real figures' });
        CASE_IDS.forEach((id) => {
          press(root, id);
          env.sched.advance(CLICK_MS + 200);
          const problems = findForbiddenText(visibleStrings(root), { names: NAMES });
          assert(problems.length === 0, `${id} at ${widthHint}: ${problems.join('; ')}`);
        });
      });
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('The arrangement follows the width: a table and goals beside, side by side, or one column', () => {
    const env = installDom();
    try {
      const wide = mount({ widthHint: 1776 });
      assert(hasClass(wide, 'is-wide'), 'wide');
      assertEqual(findAll(wide, 'gar-rowlabels').length, 1, 'wide: the row labels sit beside the cases');
      assertEqual(findAll(wide, 'gar-year-body').length, 1, 'wide: the goals sit beside the yearly picture');
      assertEqual(findAll(wide, 'gar-panel-goals').length, 0, 'wide: no panel of its own for the goals');
      assertEqual(findAll(wide, 'gar-quiet').length, 0, 'wide: the quiet figures are in the table');
      assertEqual(findAll(wide, 'gar-now-rows').length, 0, 'wide: the cash amounts sit beside the picture');
      assertEqual(findAll(wide, 'gar-side').length, 3, 'wide: three labels beside the cash picture');

      [1100, 390].forEach((widthHint) => {
        const compact = mount({ widthHint });
        assert(hasClass(compact, widthHint >= 760 ? 'is-pair' : 'is-single'), `${widthHint}: arrangement`);
        assertEqual(findAll(compact, 'gar-rowlabels').length, 0, `${widthHint}: no row labels`);
        assertEqual(findAll(compact, 'gar-panel-goals').length, 1, `${widthHint}: the goals have a panel`);
        assertEqual(findAll(compact, 'gar-quiet').length, 1, `${widthHint}: the quiet figures sit under the answer`);
        assertEqual(findAll(compact, 'gar-now-rows').length, 1, `${widthHint}: the cash amounts sit under the picture`);
        assertEqual(findAll(compact, 'gar-side').length, 0, `${widthHint}: nothing beside the cash picture`);
      });

      // The quiet figures: paid out is a plain figure, never beside "needed" on one scale.
      const quiet = visibleStrings(findAll(mount({ widthHint: 390 }), 'gar-quiet')[0]).join(' | ');
      assert(/Paid out over the life of your goals/.test(quiet) && /€834,168/.test(quiet), 'the paid-out figure');
      assert(/If you retire at 65 on €46,000/.test(quiet) && /still short by €4,797/.test(quiet), 'the later option');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Crossing an arrangement rebuilds the screen on the same case; moving within one does not', () => {
    const env = installDom();
    try {
      const root = mount({ widthHint: 1776 });
      press(root, 'mortgage-all-cash');
      env.sched.advance(CLICK_MS + 200);
      assertEqual(env.observers.length, 1, 'one resize observer');

      const headline = findAll(root, 'gar-headline')[0];
      root.clientWidth = 1800;
      env.observers[0].callback();
      assert(findAll(root, 'gar-headline')[0] === headline, 'within the arrangement nothing is rebuilt');

      root.clientWidth = 900;
      env.observers[0].callback();
      assert(hasClass(root, 'is-pair'), 'now side by side');
      assertEqual(root.garState().selectedId, 'mortgage-all-cash', 'still on the same case');
      assertEqual(
        snapshot(root),
        snapshot(mount({ widthHint: 900, selectedCaseId: 'mortgage-all-cash' })),
        'what is drawn is a fresh render at the new width'
      );

      root.clientWidth = 400;
      env.observers[0].callback();
      assert(hasClass(root, 'is-single'), 'then one column');
      root.clientWidth = 2000;
      env.observers[0].callback();
      assert(hasClass(root, 'is-wide'), 'then the frame again');
      assertEqual(
        snapshot(root),
        snapshot(mount({ widthHint: 2000, selectedCaseId: 'mortgage-all-cash' })),
        'and again a fresh render'
      );
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('A payload that cannot be projected builds nothing, and a stale remembered case is ignored', () => {
    const env = installDom();
    try {
      assertEqual(buildGoalsAndResourcesModule({ rawInputs: { spareCash: 1 } }), null, 'a bad payload');
      assertEqual(buildGoalsAndResourcesModule({}), null, 'no payload');
      const stale = mount({ selectedCaseId: 'gone' });
      assertEqual(stale.garState().selectedId, 'cash-stays', 'opens on the base case');
      const remembered = mount({ selectedCaseId: 'college-today' });
      assertEqual(remembered.garState().selectedId, 'college-today', 'opens where the client was');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('No spare cash is one case, an empty cash picture, and no later option when there is none', () => {
    const env = installDom();
    try {
      const noCash = mount({ rawInputs: { ...GOALS_AND_RESOURCES_SAMPLE, spareCash: 0 } });
      assertEqual(findAll(noCash, 'gar-case').length, 1, 'one case');
      const have = findAll(findAll(noCash, 'gar-plot-now')[0], 'gar-bar-have')[0];
      assertEqual(have.style.height, '0px', 'no bar for money you do not have');

      const noLater = { ...GOALS_AND_RESOURCES_SAMPLE };
      delete noLater.laterRetirement;
      const root = mount({ rawInputs: noLater });
      assertEqual(findAll(root, 'gar-case-later').length, 0, 'no later line in a case');
      assertEqual(findAll(root, 'gar-rowlabel-later').length, 0, 'and no label for it');
      const narrow = mount({ rawInputs: noLater, widthHint: 390 });
      assertEqual(findAll(narrow, 'gar-quiet-row-later').length, 0, 'nor under the answer on a phone');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('The household\'s names never reach the screen', () => {
    const env = installDom();
    try {
      const raw = {
        ...GOALS_AND_RESOURCES_SAMPLE,
        children: [
          { id: 'child-1', title: 'Aoife', age: 10 },
          { id: 'child-2', title: 'Cian', age: 8 }
        ]
      };
      [1776, 390].forEach((widthHint) => {
        const root = mount({ rawInputs: raw, widthHint });
        CASE_IDS.forEach((id) => {
          press(root, id);
          env.sched.advance(CLICK_MS + 200);
          const text = visibleStrings(root).join(' | ');
          ['Niamh', 'Dara', 'Aoife', 'Cian'].forEach((name) => {
            assert(!new RegExp(`\\b${name}\\b`, 'i').test(text), `${id} at ${widthHint} names ${name}`);
          });
        });
      });
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Nothing animates through CSS and nothing is left running after the module is destroyed', () => {
    const env = installDom();
    try {
      const root = mount();
      const transitions = [];
      const walk = (node) => {
        if (node.style && node.style.transition) transitions.push(node.className);
        node.children.forEach(walk);
      };
      walk(root);
      assertEqual(transitions.length, 0, 'no inline transitions');

      press(root, 'college-today');
      assert(env.sched.frames.length + env.sched.timers.length > 0, 'a click schedules the travel');
      root.destroyGoalsAndResources();
      assertEqual(env.sched.frames.length + env.sched.timers.length, 0, 'destroy cancels it');
      assertEqual(env.observers[0].live, false, 'and stops watching the width');
    } finally {
      env.restore();
    }
  }));

  cases.push(await runAsyncCase('The presenter can select a case by id, and an unknown id is refused', async () => {
    const env = installDom();
    try {
      const root = mount();
      const told = [];
      const withCallback = mount({ onSelectCase: (id) => told.push(id) });
      press(withCallback, 'college-today');
      press(withCallback, 'college-today');
      assertEqual(JSON.stringify(told), '["college-today"]', 'told once, and not for the case already selected');

      let settled = false;
      const pending = root.presenterSelectScenario('college-today').then(() => { settled = true; });
      assertEqual(root.garState().selectedId, 'college-today', 'selected at once');
      env.sched.advance(CLICK_MS + SETTLE_GRACE_MS + 20);
      await pending;
      assert(settled, 'resolved after the transition');
      let refused = false;
      try {
        await root.presenterSelectScenario('nope');
      } catch (error) {
        refused = /Unknown goals and resources scenario: nope/.test(error.message);
      }
      assert(refused, 'an unknown id is refused with its name');
    } finally {
      env.restore();
    }
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };
  if (failed > 0) {
    console.warn('[GoalsAndResourcesModuleTests] Completed with failures', summary);
  } else {
    console.info('[GoalsAndResourcesModuleTests] All tests passed', { total: summary.total, passed: summary.passed });
  }
  return summary;
}
