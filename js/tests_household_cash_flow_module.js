import {
  CLICK_MS,
  SETTLE_GRACE_MS,
  buildHouseholdCashFlowModule,
  createCashFlowClock
} from './household_cash_flow_module.js';
import {
  HOUSEHOLD_CASH_FLOW_PENSION_SHORT_SAMPLE,
  HOUSEHOLD_CASH_FLOW_SAMPLE,
  HOUSEHOLD_CASH_FLOW_SHORT_SAMPLE,
  designFixtureOptions
} from './tests_household_cash_flow_math.js';
import { findForbiddenText } from './household_cash_flow_view.js';

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

const CASE_IDS = Object.freeze(['today', 'clear-car', 'pension', 'both']);

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
    console.info(`[HouseholdCashFlowModuleTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[HouseholdCashFlowModuleTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

async function runAsyncCase(name, testFn) {
  try {
    await testFn();
    console.info(`[HouseholdCashFlowModuleTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[HouseholdCashFlowModuleTests] FAIL: ${name}`, error);
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
  constructor(tag) {
    this.tagName = tag;
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

/** The words, and where every mark and label sits, as one comparable string. */
function snapshot(root) {
  const marks = [];
  const walk = (node) => {
    const marked = ['hcf-bar', 'hcf-segment', 'hcf-connector', 'hcf-amount', 'hcf-outline', 'hcf-row', 'hcf-last-label', 'hcf-key']
      .some((name) => hasClass(node, name));
    if (marked) {
      // A hidden mark draws nothing, so what it remembers of where it last was
      // is not part of what is on screen.
      marks.push(node.hidden
        ? [node.className, true]
        : [node.className, false, node.style.top, node.style.height, node.style.left, node.style.opacity]);
    }
    node.children.forEach(walk);
  };
  walk(root);
  return JSON.stringify({ strings: visibleStrings(root), marks, drawing: root.cashFlowState().drawing });
}

/** The first thing that differs between two snapshots, for a failure message. */
function snapshotDiff(actual, expected) {
  if (actual === expected) return 'identical';
  const a = JSON.parse(actual);
  const b = JSON.parse(expected);
  if (a.drawing !== b.drawing) return `drawing ${a.drawing} vs ${b.drawing}`;
  const strings = a.strings.findIndex((text, index) => text !== b.strings[index]);
  if (strings >= 0 || a.strings.length !== b.strings.length) {
    return `string ${strings}: ${JSON.stringify(a.strings[strings])} vs ${JSON.stringify(b.strings[strings])}`;
  }
  const mark = a.marks.findIndex((entry, index) => JSON.stringify(entry) !== JSON.stringify(b.marks[index]));
  return `mark ${mark}: ${JSON.stringify(a.marks[mark])} vs ${JSON.stringify(b.marks[mark])}`;
}

/** Install the shim and a scheduler. Returns what a test needs, and undoes it. */
function installDom({ reducedMotion = false } = {}) {
  const sched = createScheduler();
  const observers = [];
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver
  };
  globalThis.document = {
    createElement: (tag) => new FakeNode(tag)
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
      observers.push(this);
    }

    observe() {}

    disconnect() {}
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
  const root = buildHouseholdCashFlowModule({
    rawInputs: HOUSEHOLD_CASH_FLOW_SAMPLE,
    projectionOptions: designFixtureOptions(),
    widthHint: 1728,
    ...options
  });
  assert(root, 'the module built');
  root._attached = true;
  return root;
}

function button(root, id) {
  return findAll(root, 'hcf-case').find((node) => node.dataset.caseId === id);
}

/* ----------------------------------------------------------------- tests */

export async function runHouseholdCashFlowModuleTests() {
  const cases = [];

  cases.push(runCase('The clock paints eased progress from the first frame and ends exactly on 1', () => {
    const sched = createScheduler();
    const clock = createCashFlowClock(sched);
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
    const clock = createCashFlowClock(sched);
    const painted = [];
    clock.run(CLICK_MS, (progress) => painted.push(progress));
    const lateFrame = sched.frames[0].fn;

    sched.advance(CLICK_MS + SETTLE_GRACE_MS + 50, { frames: false });
    assertEqual(painted.length, 1, 'only the settle timer painted');
    assertEqual(painted[0], 1, 'and it painted the end state');

    lateFrame(sched.now + 5000);
    lateFrame(sched.now + 5016);
    assertEqual(painted.length, 1, 'the late frames painted nothing');
  }));

  cases.push(runCase('A click mid-travel cancels the run in flight: stale frames never paint', () => {
    const sched = createScheduler();
    const clock = createCashFlowClock(sched);
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
    const clock = createCashFlowClock(sched);
    const painted = [];
    clock.run(0, (progress) => painted.push(progress));
    assertEqual(JSON.stringify(painted), '[1]', 'one paint, on 1');
    assertEqual(sched.frames.length + sched.timers.length, 0, 'nothing scheduled');
  }));

  cases.push(runCase('A module that has gone paints nothing', () => {
    const sched = createScheduler();
    let alive = true;
    const clock = createCashFlowClock({ ...sched, requestFrame: sched.requestFrame, isAlive: () => alive });
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
        ['clear-car', 'pension', 'both', 'today', 'pension'],
        ['both', 'today'],
        ['pension', 'clear-car', 'pension', 'clear-car', 'both']
      ];
      [1728, 390].forEach((widthHint) => {
        sequences.forEach((sequence, run) => {
          const root = mount({ widthHint });
          sequence.forEach((id, index) => {
            button(root, id).click();
            // Alternate between a patient click-through, a fast one and a starved tab.
            const mode = (index + run) % 3;
            if (mode === 0) env.sched.advance(80);
            if (mode === 1) env.sched.advance(8);
            if (mode === 2) env.sched.advance(30, { frames: false });
          });
          env.sched.advance(CLICK_MS * 3, { frames: false });
          env.sched.advance(CLICK_MS * 2);

          const last = sequence[sequence.length - 1];
          const fresh = mount({ selectedCaseId: last, widthHint });
          assertEqual(
            snapshotDiff(snapshot(root), snapshot(fresh)),
            'identical',
            `${widthHint}: sequence ${run + 1} ends on a fresh render of ${last}`
          );
          assertEqual(root.cashFlowState().selectedId, last, 'the selected case');
        });
      });
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Short is drawn: the word, a red mark beside it, the size, the frames\' sentence, and room below the floor', () => {
    const env = installDom();
    try {
      [1728, 390].forEach((widthHint) => {
        const root = mount({ rawInputs: HOUSEHOLD_CASH_FLOW_SHORT_SAMPLE, widthHint });
        const text = (name) => findAll(root, name)[0].textContent;
        assertEqual(text('hcf-status-word'), 'Short', `${widthHint}: the word`);
        assert(hasClass(findAll(root, 'hcf-swatch')[0], 'is-short'), `${widthHint}: red beside the word`);
        assertEqual(text('hcf-figure'), '€6,000', `${widthHint}: the size, with no sign`);
        assertEqual(text('hcf-monthly'), '€500 a month', `${widthHint}: and the month`);
        assertEqual(
          text('hcf-sentence'),
          'Today, €156,000 goes out against your €150,000, and you are short by €6,000.',
          `${widthHint}: today's sentence`
        );
        const marks = widthHint === 1728 ? findAll(root, 'hcf-bar') : findAll(root, 'hcf-segment');
        assert(hasClass(marks[marks.length - 1], 'is-short'), `${widthHint}: the last mark is red`);
        assert(
          marks.slice(0, -1).every((mark) => !hasClass(mark, 'is-short')),
          `${widthHint}: and nothing else is`
        );
        if (widthHint === 1728) {
          assert(hasClass(findAll(root, 'hcf-floor')[0], 'has-band'), 'the floor is drawn stronger');
          assertEqual(findAll(root, 'hcf-zero')[0].textContent, '€0', 'and named');
          const names = findAll(root, 'hcf-name-label');
          assertEqual(names[names.length - 1].textContent, 'Short', 'the last column is named Short');
        } else {
          assertEqual(findAll(root, 'hcf-bar-income-end').length, 1, 'income ends on the bar');
          const rows = findAll(root, 'hcf-row').filter((row) => !row.hidden);
          const last = rows[rows.length - 1];
          assertEqual(findAll(last, 'hcf-row-name')[0].textContent, 'Short', 'the last row is named Short');
          assertEqual(findAll(last, 'hcf-row-amount')[0].textContent, '€6,000', 'with the size');
        }
      });

      // Cleared to nothing is Tight, and nothing is red.
      const tight = mount({ rawInputs: HOUSEHOLD_CASH_FLOW_SHORT_SAMPLE, selectedCaseId: 'clear-car' });
      assertEqual(findAll(tight, 'hcf-status-word')[0].textContent, 'Tight', 'nothing left over is Tight');
      assert(!hasClass(findAll(tight, 'hcf-swatch')[0], 'is-short'), 'and not red');
      assert(findAll(tight, 'hcf-bar').every((mark) => !hasClass(mark, 'is-short')), 'no red mark');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('A click across the floor changes colour with the mark: red exactly while what is drawn is below it', () => {
    const env = installDom();
    try {
      [[1728, 'hcf-bar'], [390, 'hcf-segment']].forEach(([widthHint, markClass]) => {
        const root = mount({ rawInputs: HOUSEHOLD_CASH_FLOW_PENSION_SHORT_SAMPLE, widthHint });
        const last = () => {
          const marks = findAll(root, markClass);
          return marks[marks.length - 1];
        };
        const checkFrame = (where) => {
          const values = root.cashFlowState().values;
          assertEqual(
            hasClass(last(), 'is-short'),
            values[values.length - 1] < 0,
            `${widthHint} ${where}: red follows the figure drawn (${values[values.length - 1]})`
          );
        };
        checkFrame('opening');
        assert(!hasClass(last(), 'is-short'), `${widthHint}: today is not short`);

        // Left over to short, frame by frame, then back.
        ['pension', 'today'].forEach((id) => {
          button(root, id).click();
          checkFrame(`${id} at the click`);
          for (let step = 0; step < 40; step += 1) {
            env.sched.advance(16);
            checkFrame(`${id} frame ${step}`);
          }
          env.sched.advance(CLICK_MS);
          checkFrame(`${id} settled`);
        });
        assert(!hasClass(last(), 'is-short'), `${widthHint}: back on today it is not red`);

        button(root, 'pension').click();
        env.sched.advance(CLICK_MS * 2);
        assert(hasClass(last(), 'is-short'), `${widthHint}: and settled on the short case it is`);
        assertEqual(findAll(root, 'hcf-status-word')[0].textContent, 'Short', `${widthHint}: with the word`);
        assert(/you are short by €6,000\.$/.test(findAll(root, 'hcf-sentence')[0].textContent), `${widthHint}: and the sentence`);
      });
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Short: any sequence of clicks ends on a fresh render, and outlines say where you were', () => {
    const env = installDom();
    try {
      const sequences = [
        ['clear-car', 'pension', 'both', 'today', 'pension'],
        ['pension', 'clear-car', 'pension', 'both']
      ];
      [HOUSEHOLD_CASH_FLOW_SHORT_SAMPLE, HOUSEHOLD_CASH_FLOW_PENSION_SHORT_SAMPLE].forEach((rawInputs, sample) => {
        [1728, 390].forEach((widthHint) => {
          sequences.forEach((sequence, run) => {
            const root = mount({ rawInputs, widthHint });
            sequence.forEach((id, index) => {
              button(root, id).click();
              const mode = (index + run) % 3;
              if (mode === 0) env.sched.advance(80);
              if (mode === 1) env.sched.advance(8);
              if (mode === 2) env.sched.advance(30, { frames: false });
            });
            env.sched.advance(CLICK_MS * 3, { frames: false });
            env.sched.advance(CLICK_MS * 2);
            const last = sequence[sequence.length - 1];
            assertEqual(
              snapshotDiff(snapshot(root), snapshot(mount({ rawInputs, selectedCaseId: last, widthHint }))),
              'identical',
              `sample ${sample + 1} at ${widthHint}: sequence ${run + 1} ends on a fresh render of ${last}`
            );
          });
        });
      });

      // Short today, cleared to nothing: the last column is outlined and says short.
      const root = mount({ rawInputs: HOUSEHOLD_CASH_FLOW_SHORT_SAMPLE, selectedCaseId: 'clear-car' });
      const label = findAll(root, 'hcf-last-label')[0];
      assertEqual(label.hidden, false, 'the last column is labelled');
      assertEqual(label.children.map((node) => node.textContent).join(' '), 'Today €6,000 short', 'with where you were');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('A short-to-tight transition fades the zero mark by distance from zero', () => {
    const env = installDom();
    try {
      [1728, 390].forEach((widthHint) => {
        const root = mount({ rawInputs: HOUSEHOLD_CASH_FLOW_SHORT_SAMPLE, widthHint });
        button(root, 'clear-car').click();
        env.sched.advance(100);
        const marker = findAll(root, widthHint === 390 ? 'hcf-bar-end-mark' : 'hcf-end-mark')[0];
        assert(marker, 'zero marker exists');
        assertEqual(marker.style.opacity, '0', 'no zero marker while still visibly short');
        env.sched.advance(CLICK_MS + 200);
        assertEqual(marker.style.opacity, '1', 'zero marker at the settled tight case');
      });
    } finally { env.restore(); }
  }));

  cases.push(runCase('The sentence above the bar keeps the stylesheet\'s room, and the staircase leaves its sentence alone', () => {
    const env = installDom();
    try {
      const phone = mount({ rawInputs: HOUSEHOLD_CASH_FLOW_SHORT_SAMPLE, widthHint: 390 });
      const sentence = findAll(phone, 'hcf-sentence')[0];
      // The shim cannot measure, so the stylesheet's four lines stand; a browser
      // measures the longest case's sentence and keeps that (checked by eye).
      assert(sentence.style.minHeight === undefined || sentence.style.minHeight === '', 'nothing inline where nothing can be measured');
      const wide = mount({ rawInputs: HOUSEHOLD_CASH_FLOW_SHORT_SAMPLE, widthHint: 1728 });
      assert(!findAll(wide, 'hcf-sentence')[0].style.minHeight, 'the staircase sets none');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Reduced motion: a click lands on the new case in the same call', () => {
    const env = installDom({ reducedMotion: true });
    try {
      const root = mount();
      button(root, 'pension').click();
      assertEqual(env.sched.frames.length + env.sched.timers.length, 0, 'nothing was scheduled');
      assertEqual(snapshot(root), snapshot(mount({ selectedCaseId: 'pension' })), 'the screen already shows the new case');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('A click changes every word at once, and only the marks that changed travel', () => {
    const env = installDom();
    try {
      const root = mount();
      const sentence = findAll(root, 'hcf-sentence')[0];
      const figure = findAll(root, 'hcf-figure')[0];
      const names = () => findAll(root, 'hcf-name').map((node) => `${node.style.left}|${node.style.top}`).join(';');
      const floor = () => findAll(root, 'hcf-floor').map((node) => node.style.top).join(';');
      const namesBefore = names();
      const floorBefore = floor();
      assertEqual(figure.textContent, '€6,000', 'opens on today');

      button(root, 'clear-car').click();
      // No frame has run yet: the words have already changed, the marks have not.
      assertEqual(figure.textContent, '€12,000', 'the answer changed at the click');
      assert(/doubles, from €6,000 to €12,000/.test(sentence.textContent), 'the sentence changed at the click');
      const pressed = findAll(root, 'hcf-case').map((node) => node.getAttribute('aria-pressed')).join(',');
      assertEqual(pressed, 'false,true,false,false', 'the pressed state moved');
      env.sched.advance(CLICK_MS + 200);
      assertEqual(names(), namesBefore, 'the names did not move');
      assertEqual(floor(), floorBefore, 'the floor did not move');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Nothing rendered says a banned phrase, a provider, "p.a.", a third person or a bare amount', () => {
    const env = installDom();
    try {
      [1728, 976, 390].forEach((widthHint) => {
        const root = mount({ widthHint });
        CASE_IDS.forEach((id) => {
          button(root, id).click();
          env.sched.advance(CLICK_MS + 200);
          const problems = findForbiddenText(visibleStrings(root));
          assert(problems.length === 0, `${id} at ${widthHint}: ${problems.join('; ')}`);
        });
      });
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Today\'s outlines are on the changed columns only, with a key and a labelled last column', () => {
    const env = installDom();
    try {
      const root = mount({ selectedCaseId: 'pension' });
      const outlines = () => findAll(root, 'hcf-outline').filter((node) => !node.hidden).length;
      const key = () => findAll(root, 'hcf-key')[0].hidden;
      const label = () => findAll(root, 'hcf-last-label')[0];
      // Pension: tax changed, and what is left changed. Nothing else.
      assertEqual(outlines(), 2, 'two outlines for a pension');
      assertEqual(key(), false, 'the key shows');
      assertEqual(label().hidden, false, 'the last column is labelled');
      assertEqual(label().children.map((node) => node.textContent).join(' '), 'Today €6,000 left over', 'with today\'s figure');

      button(root, 'both').click();
      env.sched.advance(CLICK_MS + 200);
      // Both: tax and the car loan changed, and what is left did not.
      assertEqual(outlines(), 2, 'two outlines for both');
      assertEqual(label().hidden, true, 'no label on a last column that did not change');
      assertEqual(key(), false, 'the key is there because an outline is');

      button(root, 'today').click();
      env.sched.advance(CLICK_MS + 200);
      assertEqual(outlines(), 0, 'none on today');
      assertEqual(key(), true, 'and no key');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('The drawing follows the width, keeps the case across a switch and does not flip inside the dead band', () => {
    const env = installDom();
    try {
      const wide = mount({ widthHint: 1728 });
      assertEqual(wide.cashFlowState().drawing, 'stairs', 'a wide screen is the staircase');
      assert(findAll(wide, 'hcf-bar').length > 0 && findAll(wide, 'hcf-segment').length === 0, 'staircase marks only');
      const narrow = mount({ widthHint: 390 });
      assertEqual(narrow.cashFlowState().drawing, 'bar', 'a phone is the bar');
      assert(findAll(narrow, 'hcf-segment').length > 0 && findAll(narrow, 'hcf-bar').length === 0, 'bar marks only');

      // Resize the wide one: the case survives, and the dead band keeps the staircase.
      button(wide, 'pension').click();
      env.sched.advance(CLICK_MS + 200);
      const host = findAll(wide, 'hcf-probe')[0];
      // The first observer created belongs to `wide`, the second to `narrow`.
      const observerOfWide = env.observers[0];
      host.clientWidth = 840;
      observerOfWide.callback();
      assertEqual(wide.cashFlowState().drawing, 'stairs', '840 stays the staircase');
      host.clientWidth = 831;
      observerOfWide.callback();
      assertEqual(wide.cashFlowState().drawing, 'bar', '831 is the bar');
      assertEqual(wide.cashFlowState().selectedId, 'pension', 'the case survived the switch');
      host.clientWidth = 840;
      observerOfWide.callback();
      assertEqual(wide.cashFlowState().drawing, 'bar', '840 stays the bar once it is the bar');
      host.clientWidth = 848;
      observerOfWide.callback();
      assertEqual(wide.cashFlowState().drawing, 'stairs', '848 is the staircase');
      assertEqual(
        snapshot(wide),
        snapshot(mount({ selectedCaseId: 'pension', widthHint: 848 })),
        'after the round trip it is a fresh render'
      );
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('A payload that cannot be projected or drawn builds nothing, and one case builds no buttons', () => {
    const env = installDom();
    try {
      assertEqual(buildHouseholdCashFlowModule({ rawInputs: { people: [] } }), null, 'a bad payload');
      const short = JSON.parse(JSON.stringify(HOUSEHOLD_CASH_FLOW_SAMPLE));
      short.outgoings[2].amount = 80_000;
      assert(
        buildHouseholdCashFlowModule({ rawInputs: short, projectionOptions: designFixtureOptions(), widthHint: 1728 }),
        'a short case is drawn'
      );
      const single = buildHouseholdCashFlowModule({
        rawInputs: { ...JSON.parse(JSON.stringify(HOUSEHOLD_CASH_FLOW_SAMPLE)), scenarios: [{ id: 'only' }] },
        projectionOptions: designFixtureOptions(),
        widthHint: 1728
      });
      assertEqual(findAll(single, 'hcf-case').length, 0, 'no buttons for one case');
      const stale = mount({ selectedCaseId: 'gone' });
      assertEqual(stale.cashFlowState().selectedId, 'today', 'a remembered case the payload no longer has is ignored');
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
      button(withCallback, 'pension').click();
      button(withCallback, 'pension').click();
      assertEqual(JSON.stringify(told), '["pension"]', 'told once, and not for the case already selected');

      let settled = false;
      const pending = root.presenterSelectScenario('pension').then(() => { settled = true; });
      assertEqual(root.cashFlowState().selectedId, 'pension', 'selected at once');
      env.sched.advance(CLICK_MS + SETTLE_GRACE_MS + 20);
      await pending;
      assert(settled, 'resolved after the transition');
      let refused = false;
      try {
        await root.presenterSelectScenario('nope');
      } catch (error) {
        refused = /Unknown household cash flow scenario: nope/.test(error.message);
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
    console.warn('[HouseholdCashFlowModuleTests] Completed with failures', summary);
  } else {
    console.info('[HouseholdCashFlowModuleTests] All tests passed', { total: summary.total, passed: summary.passed });
  }
  return summary;
}
