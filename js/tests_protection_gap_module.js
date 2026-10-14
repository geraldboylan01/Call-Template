import {
  CLICK_MS,
  SETTLE_GRACE_MS,
  buildProtectionGapModule,
  createGapClock
} from './protection_gap_module.js';
import { PROTECTION_GAP_SAMPLE } from './tests_protection_gap_math.js';
import { findForbiddenText } from './protection_gap_view.js';

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
    console.info(`[ProtectionGapModuleTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[ProtectionGapModuleTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

async function runAsyncCase(name, testFn) {
  try {
    await testFn();
    console.info(`[ProtectionGapModuleTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[ProtectionGapModuleTests] FAIL: ${name}`, error);
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

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  click() {
    (this.listeners.click || []).forEach((fn) => fn({ target: this }));
  }
}

function findAll(node, className, found = []) {
  if (node.className.split(/\s+/).includes(className)) found.push(node);
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

/** Everything the module draws: where each shown mark and label is, and what it says. */
function snapshot(root) {
  const marks = [];
  const walk = (node) => {
    // A hidden node and everything under it is not drawn, so what it last held
    // is not part of what is on screen.
    if (node.hidden) {
      marks.push([node.className, 'hidden']);
      return;
    }
    if (node.className.includes('pg-')) {
      marks.push([
        node.className,
        node.style.left,
        node.style.top,
        node.style.width,
        node.style.height,
        node.hidden,
        node.children.length === 0 ? node._text : ''
      ]);
    }
    node.children.forEach(walk);
  };
  walk(root);
  return JSON.stringify({ strings: visibleStrings(root), marks });
}

/** The first mark or string that differs between two snapshots, for a readable failure. */
function describeDifference(a, b) {
  const left = JSON.parse(a);
  const right = JSON.parse(b);
  for (let index = 0; index < Math.max(left.marks.length, right.marks.length); index += 1) {
    if (JSON.stringify(left.marks[index]) !== JSON.stringify(right.marks[index])) {
      return `mark ${index}: ${JSON.stringify(left.marks[index])} vs ${JSON.stringify(right.marks[index])}`;
    }
  }
  for (let index = 0; index < Math.max(left.strings.length, right.strings.length); index += 1) {
    if (left.strings[index] !== right.strings[index]) {
      return `string ${index}: ${JSON.stringify(left.strings[index])} vs ${JSON.stringify(right.strings[index])}`;
    }
  }
  return 'no difference found';
}

/** Compare two snapshots and say what differs. */
function assertSameSnapshot(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: ${describeDifference(actual, expected)}`);
  }
}

/** Install the shim and a scheduler. Returns what a test needs, and undoes it. */
function installDom({ reducedMotion = false } = {}) {
  const sched = createScheduler();
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame
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
  return {
    sched,
    restore() {
      globalThis.document = saved.document;
      globalThis.window = saved.window;
      globalThis.requestAnimationFrame = saved.requestAnimationFrame;
      globalThis.cancelAnimationFrame = saved.cancelAnimationFrame;
    }
  };
}

function mount(options = {}) {
  const root = buildProtectionGapModule({
    rawInputs: PROTECTION_GAP_SAMPLE,
    widthHint: 1776,
    ...options
  });
  assert(root, 'the module built');
  root._attached = true;
  return root;
}

const caseButton = (root, id) => findAll(root, 'pg-case').find((button) => button.dataset.caseId === id);

/* ----------------------------------------------------------------- tests */

export async function runProtectionGapModuleTests() {
  const cases = [];

  cases.push(runCase('The clock paints eased progress from the first frame and ends exactly on 1', () => {
    const sched = createScheduler();
    const clock = createGapClock(sched);
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
    const clock = createGapClock(sched);
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
    const clock = createGapClock(sched);
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
    const clock = createGapClock(sched);
    const painted = [];
    clock.run(0, (progress) => painted.push(progress));
    assertEqual(JSON.stringify(painted), '[1]', 'one paint, on 1');
    assertEqual(sched.frames.length + sched.timers.length, 0, 'nothing scheduled');
  }));

  cases.push(runCase('A module that has gone paints nothing', () => {
    const sched = createScheduler();
    let alive = true;
    const clock = createGapClock({ ...sched, requestFrame: sched.requestFrame, isAlive: () => alive });
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
        ['niamh-cannot-work', 'dara-cannot-work', 'niamh-died', 'today', 'dara-cannot-work'],
        ['niamh-died', 'today'],
        ['dara-cannot-work', 'niamh-cannot-work', 'dara-cannot-work', 'niamh-cannot-work', 'niamh-died']
      ];
      [1776, 358].forEach((widthHint) => {
        sequences.forEach((sequence, run) => {
          const root = mount({ widthHint });
          sequence.forEach((id, index) => {
            caseButton(root, id).click();
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
          assertSameSnapshot(snapshot(root), snapshot(fresh), `sequence ${run + 1} at ${widthHint} ends on a fresh render of ${last}`);
          assertEqual(root.gapState().selectedId, last, 'the selected case');
        });
      });
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Reduced motion: a click lands on the new case in the same call', () => {
    const env = installDom({ reducedMotion: true });
    try {
      const root = mount();
      caseButton(root, 'dara-cannot-work').click();
      assertEqual(env.sched.frames.length + env.sched.timers.length, 0, 'nothing was scheduled');
      assertSameSnapshot(
        snapshot(root),
        snapshot(mount({ selectedCaseId: 'dara-cannot-work' })),
        'the screen already shows the new case'
      );
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('A click changes every word at once, and the bar and strip keep their height', () => {
    const env = installDom();
    try {
      const root = mount();
      const headline = findAll(root, 'pg-line1')[0];
      const second = findAll(root, 'pg-line2')[0];
      const sentence = findAll(root, 'pg-sentence')[0];
      const heights = () => [findAll(root, 'pg-bar')[0].style.height, findAll(root, 'pg-strip')[0].style.height].join('|');
      const before = heights();
      assertEqual(headline.textContent, 'You have €6,000 a year left over.', 'opens on the first case');

      caseButton(root, 'niamh-cannot-work').click();
      // No frame has run yet: the words have already changed.
      assertEqual(headline.textContent, 'You are €38,000 a year short.', 'the answer changed at the click');
      assertEqual(second.textContent, 'Your savings would last 19 months.', 'the second line changed at the click');
      assertEqual(
        sentence.textContent,
        'Niamh’s take-home stops and a State payment starts. You still need €96,000.',
        'the sentence changed at the click'
      );
      const pressed = findAll(root, 'pg-case').map((button) => button.getAttribute('aria-pressed')).join(',');
      assertEqual(pressed, 'false,true,false,false', 'the pressed state moved');

      ['dara-cannot-work', 'niamh-died', 'today'].forEach((id) => {
        caseButton(root, id).click();
        env.sched.advance(CLICK_MS + 200);
        assertEqual(heights(), before, `${id}: nothing below the bar moves`);
      });
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Settled, the green and red are the months and the bar ends at what comes in', () => {
    const env = installDom();
    try {
      const root = mount({ selectedCaseId: 'niamh-cannot-work' });
      const { layout } = root.gapState();
      const round = (value) => `${Math.round(value * 10) / 10}px`;
      const fill = findAll(root, 'pg-fill')[0];
      const short = findAll(root, 'pg-short')[0];
      assertEqual(fill.style.width, round(19 * layout.cell), 'the green is 19 months wide');
      assertEqual(short.style.width, round(layout.chartWidth - (19 * layout.cell)), 'the red is the rest');
      const gap = findAll(root, 'pg-gap')[0];
      assertEqual(gap.style.left, round(58_000 * layout.pxPerEuro), 'the gap starts where the bar ends');
      assertEqual(gap.style.width, round(38_000 * layout.pxPerEuro), 'and is 38,000 wide');
      const end = findAll(root, 'pg-end-text')[0];
      assertEqual(end.textContent, '19 months', 'the end mark');

      const beyond = mount({ selectedCaseId: 'niamh-died' });
      assertEqual(findAll(beyond, 'pg-end-text')[0].textContent, 'Beyond three years', 'beyond three years');
      assertEqual(findAll(beyond, 'pg-short')[0].style.width, '0px', 'no red when beyond');

      const today = mount();
      assertEqual(findAll(today, 'pg-end')[0].hidden, true, 'no end mark when nothing is short');
      assertEqual(findAll(today, 'pg-word-nothing')[0].hidden, false, 'nothing to fill is said');
      assertEqual(findAll(today, 'pg-word-nothing')[0].textContent, 'Nothing to fill', 'in those words');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Nothing rendered says a banned phrase, cover or premium, a provider, "p.a." or a bare amount', () => {
    const env = installDom();
    try {
      [1776, 900, 358].forEach((widthHint) => {
        const root = mount({ widthHint });
        ['today', 'niamh-cannot-work', 'dara-cannot-work', 'niamh-died'].forEach((id) => {
          caseButton(root, id).click();
          env.sched.advance(CLICK_MS + 200);
          const strings = visibleStrings(root);
          const problems = findForbiddenText(strings);
          assert(problems.length === 0, `${id} at ${widthHint}: ${problems.join('; ')}`);
          assert(strings.some((text) => /\byou(r)?\b/i.test(text)), `${id} at ${widthHint}: speaks to you`);
        });
      });
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('The buttons sit in a rail, a row or a grid by the module’s own width', () => {
    const env = installDom();
    try {
      const wide = mount({ widthHint: 1776 });
      assert(wide.classList.contains('pg--rail'), 'rail at 1776');
      assert(!wide.classList.contains('is-narrow'), 'wide type at 1776');
      assertEqual(wide.gapState().layout.chartWidth, 1776 - 360 - 116 - 20, 'the chart takes what the rail leaves');
      const row = mount({ widthHint: 900 });
      assert(row.classList.contains('pg--row'), 'row at 900');
      const grid = mount({ widthHint: 390 });
      assert(grid.classList.contains('pg--grid'), 'grid at 390');
      assert(grid.classList.contains('is-narrow'), 'narrow type at 390');
      assertEqual(findAll(grid, 'pg-case').length, 4, 'four buttons');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Tight shows its word, left over and short do not', () => {
    const env = installDom();
    try {
      const tight = buildProtectionGapModule({
        rawInputs: {
          people: [{ id: 'a', label: 'Ann', takeHome: 30_000 }, { id: 'b', label: 'Bo', takeHome: 20_000 }],
          needed: 50_000,
          savings: 20_000,
          scenarios: [{ id: 'base' }]
        },
        widthHint: 1776
      });
      tight._attached = true;
      const status = findAll(tight, 'pg-status')[0];
      assertEqual(status.hidden, false, 'the word shows');
      assertEqual(status.textContent, 'Tight', 'and it is "Tight"');
      assertEqual(findAll(tight, 'pg-line1')[0].textContent, 'You have exactly what you need.', 'the answer');

      const sample = mount();
      assertEqual(findAll(sample, 'pg-status')[0].hidden, true, 'hidden in the sample');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('A payload that cannot be projected builds nothing, and one case builds no buttons', () => {
    const env = installDom();
    try {
      assertEqual(buildProtectionGapModule({ rawInputs: { needed: 1 } }), null, 'a bad payload');
      assertEqual(buildProtectionGapModule({ rawInputs: { ...PROTECTION_GAP_SAMPLE, coverAmount: 5 } }), null, 'a payload carrying a cover amount');
      const single = buildProtectionGapModule({
        rawInputs: { ...PROTECTION_GAP_SAMPLE, scenarios: [{ id: 'only' }] },
        widthHint: 1776
      });
      assertEqual(findAll(single, 'pg-case').length, 0, 'no buttons for one case');
      // A remembered case the payload no longer has is ignored, not shown.
      const stale = mount({ selectedCaseId: 'gone' });
      assertEqual(stale.gapState().selectedId, 'today', 'opens on the base case');
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
      caseButton(withCallback, 'dara-cannot-work').click();
      caseButton(withCallback, 'dara-cannot-work').click();
      assertEqual(JSON.stringify(told), '["dara-cannot-work"]', 'told once, and not for the case already selected');

      let settled = false;
      const pending = root.presenterSelectScenario('niamh-died').then(() => { settled = true; });
      assertEqual(root.gapState().selectedId, 'niamh-died', 'selected at once');
      env.sched.advance(CLICK_MS + SETTLE_GRACE_MS + 20);
      await pending;
      assert(settled, 'resolved after the transition');
      let refused = false;
      try {
        await root.presenterSelectScenario('nope');
      } catch (error) {
        refused = /Unknown protection gap scenario: nope/.test(error.message);
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
    console.warn('[ProtectionGapModuleTests] Completed with failures', summary);
  } else {
    console.info('[ProtectionGapModuleTests] All tests passed', { total: summary.total, passed: summary.passed });
  }
  return summary;
}
