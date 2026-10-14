import {
  CLICK_MS,
  SETTLE_GRACE_MS,
  buildHomeTradeDownModule,
  createTradeDownClock
} from './home_trade_down_module.js';
import { HOME_TRADE_DOWN_SAMPLE } from './tests_home_trade_down_math.js';
import { findForbiddenText } from './home_trade_down_view.js';

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
    console.info(`[HomeTradeDownModuleTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[HomeTradeDownModuleTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

async function runAsyncCase(name, testFn) {
  try {
    await testFn();
    console.info(`[HomeTradeDownModuleTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[HomeTradeDownModuleTests] FAIL: ${name}`, error);
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

/** Every mark's place and every word, so two renders can be compared. */
function snapshot(root) {
  const marks = [];
  const walk = (node) => {
    const classes = node.className.split(/\s+/);
    if (['htd-block', 'htd-label', 'htd-track-repaid', 'htd-track-freed']
      .some((name) => classes.includes(name))) {
      marks.push([node.className, node.style.left, node.style.width, node.style.top, node.hidden]);
    }
    node.children.forEach(walk);
  };
  walk(root);
  return JSON.stringify({ strings: visibleStrings(root), marks });
}

/** The widths of the two blocks, as numbers. */
function blockWidths(root) {
  return findAll(root, 'htd-block').map((node) => parseFloat(node.style.width));
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
  const root = buildHomeTradeDownModule({
    rawInputs: HOME_TRADE_DOWN_SAMPLE,
    widthHint: 1776,
    ...options
  });
  assert(root, 'the module built');
  root._attached = true;
  return root;
}

const buttonFor = (root, id) => findAll(root, 'htd-case').find((button) => button.dataset.caseId === id);

const CASE_IDS = ['stay', 'repay-18000', 'repay-12000', 'no-mortgage'];

/* ----------------------------------------------------------------- tests */

export async function runHomeTradeDownModuleTests() {
  const cases = [];

  cases.push(runCase('The clock paints eased progress from the first frame and ends exactly on 1', () => {
    const sched = createScheduler();
    const clock = createTradeDownClock(sched);
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
    const clock = createTradeDownClock(sched);
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
    const clock = createTradeDownClock(sched);
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
    const clock = createTradeDownClock(sched);
    const painted = [];
    clock.run(0, (progress) => painted.push(progress));
    assertEqual(JSON.stringify(painted), '[1]', 'one paint, on 1');
    assertEqual(sched.frames.length + sched.timers.length, 0, 'nothing scheduled');
  }));

  cases.push(runCase('A module that has gone paints nothing', () => {
    const sched = createScheduler();
    let alive = true;
    const clock = createTradeDownClock({ ...sched, requestFrame: sched.requestFrame, isAlive: () => alive });
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
        ['repay-18000', 'repay-12000', 'no-mortgage', 'stay', 'repay-12000'],
        ['no-mortgage', 'stay'],
        ['repay-12000', 'repay-18000', 'repay-12000', 'repay-18000', 'no-mortgage'],
        ['no-mortgage']
      ];
      [1776, 358].forEach((widthHint) => {
        sequences.forEach((sequence, run) => {
          const root = mount({ widthHint });
          sequence.forEach((id, index) => {
            buttonFor(root, id).click();
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
            snapshot(root),
            snapshot(fresh),
            `at ${widthHint}, sequence ${run + 1} ends on a fresh render of ${last}`
          );
          assertEqual(root.tradeDownState().selectedId, last, 'the selected case');
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
      buttonFor(root, 'repay-18000').click();
      assertEqual(env.sched.frames.length + env.sched.timers.length, 0, 'nothing was scheduled');
      assertEqual(
        snapshot(root),
        snapshot(mount({ selectedCaseId: 'repay-18000' })),
        'the screen already shows the new case'
      );
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('A click changes every word at once, and the blocks then travel', () => {
    const env = installDom();
    try {
      const root = mount();
      const headline = findAll(root, 'htd-headline')[0];
      assertEqual(
        headline.textContent,
        'Staying keeps the home at €650,000, with €30,000 a year going on the mortgage.',
        'opens on Stay'
      );
      const before = blockWidths(root);
      assertEqual(findAll(root, 'htd-figure-value')[0].textContent, '€650,000', 'the figure');

      buttonFor(root, 'repay-18000').click();
      // No frame has run yet: the words have already changed, the blocks have not.
      assertEqual(
        headline.textContent,
        'Repaying €18,000 a year supports a loan of €203,000: a home budget of €546,000, with €12,000 a year freed.',
        'the sentence changed at the click'
      );
      assertEqual(findAll(root, 'htd-figure-value')[0].textContent, '€546,000', 'the figure changed at the click');
      assertEqual(findAll(root, 'htd-figure-word')[0].textContent, 'home budget', 'and its word');
      assertEqual(
        findAll(root, 'htd-name').map((node) => node.textContent).join('|'),
        'From selling, after buying costs|New loan',
        'the block names changed at the click'
      );
      assertEqual(
        findAll(root, 'htd-amount').map((node) => node.textContent).join('|'),
        '€343,000|€203,000',
        'the amounts changed at the click'
      );
      assertEqual(
        findAll(root, 'htd-row-value').map((node) => node.textContent).join('|'),
        '€18,000 a year|€12,000 a year',
        'the year changed at the click'
      );
      assertEqual(
        findAll(root, 'htd-case').map((button) => button.getAttribute('aria-pressed')).join(','),
        'false,true,false,false',
        'the pressed state moved'
      );
      assertEqual(JSON.stringify(blockWidths(root)), JSON.stringify(before), 'no block has moved yet');

      env.sched.advance(CLICK_MS / 2);
      assert(JSON.stringify(blockWidths(root)) !== JSON.stringify(before), 'half way, the blocks are travelling');
      env.sched.advance(CLICK_MS + 200);
      assertEqual(
        JSON.stringify(blockWidths(root)),
        JSON.stringify(blockWidths(mount({ selectedCaseId: 'repay-18000' }))),
        'the blocks end where a fresh render has them'
      );
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('The loan block changes by case and the first block does not move far', () => {
    const env = installDom();
    try {
      const widths = {};
      CASE_IDS.forEach((id) => {
        widths[id] = blockWidths(mount({ selectedCaseId: id }));
      });
      assert(widths.stay[1] > widths['repay-18000'][1], 'the loan shrinks from the mortgage to 203,000');
      assert(widths['repay-18000'][1] > widths['repay-12000'][1], 'and again to 135,000');
      assertEqual(widths['no-mortgage'][1], 0, 'and is gone with no mortgage');
      assertEqual(widths['repay-18000'][0], widths['repay-12000'][0], 'the money from selling is the same in every move');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('A click does not rebuild the drawing: the same elements stay put', () => {
    const env = installDom();
    try {
      const root = mount();
      const blocksBefore = findAll(root, 'htd-block');
      const labelsBefore = findAll(root, 'htd-label');
      const trackBefore = findAll(root, 'htd-track-freed');
      buttonFor(root, 'no-mortgage').click();
      env.sched.advance(CLICK_MS + 200);
      const blocksAfter = findAll(root, 'htd-block');
      const labelsAfter = findAll(root, 'htd-label');
      assertEqual(blocksAfter.length, 2, 'two blocks');
      blocksAfter.forEach((node, index) => assert(node === blocksBefore[index], `block ${index} is the same element`));
      labelsAfter.forEach((node, index) => assert(node === labelsBefore[index], `label ${index} is the same element`));
      assert(findAll(root, 'htd-track-freed')[0] === trackBefore[0], 'the track is the same element');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Nothing rendered says a banned phrase, "we", "us", "our", a provider or a bare amount, wide or narrow', () => {
    const env = installDom();
    try {
      [1776, 358].forEach((widthHint) => {
        const root = mount({ widthHint });
        CASE_IDS.forEach((id) => {
          buttonFor(root, id).click();
          env.sched.advance(CLICK_MS + 200);
          const problems = findForbiddenText(visibleStrings(root));
          assert(problems.length === 0, `${id} at ${widthHint}: ${problems.join('; ')}`);
        });
      });
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Wide keeps the note in the first label; narrow puts it under both labels', () => {
    const env = installDom();
    try {
      const wide = mount({ widthHint: 1776 });
      assertEqual(findAll(wide, 'htd-note-full').length, 0, 'wide: no separate note');
      assertEqual(findAll(wide, 'htd-note')[0].hidden, false, 'wide: the note is in the label');
      assert(!findAll(wide, 'htd-chart')[0].className.includes('is-narrow'), 'wide: not stacked');
      assertEqual(findAll(wide, 'htd-rule')[0].style.left, '1258px', 'wide: the hairline sits 40px left of the year');
      const reference = mount({ widthHint: 1728 });
      assertEqual(findAll(reference, 'htd-rule')[0].style.left, '1210px', 'the reference frame: the hairline');

      const narrow = mount({ widthHint: 358 });
      assertEqual(findAll(narrow, 'htd-note-full').length, 1, 'narrow: one note under both labels');
      assertEqual(findAll(narrow, 'htd-note')[0].hidden, true, 'narrow: the label’s own note is hidden');
      assertEqual(
        findAll(narrow, 'htd-note-full')[0].textContent,
        '€650,000 less the €280,000 mortgage',
        'narrow: the note says the same'
      );
      assert(findAll(narrow, 'htd-chart')[0].className.includes('is-narrow'), 'narrow: stacked');

      const phone = mount({ widthHint: 390 });
      assertEqual(findAll(phone, 'htd-chart')[0].style.width, '358px', 'a 390 phone gives a 358 chart');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('A payload that cannot be projected builds nothing, one case builds no buttons, a gone case is ignored', () => {
    const env = installDom();
    try {
      assertEqual(buildHomeTradeDownModule({ rawInputs: { homeValue: 1 } }), null, 'a bad payload');
      const single = buildHomeTradeDownModule({
        rawInputs: { ...HOME_TRADE_DOWN_SAMPLE, baseScenarioId: undefined, scenarios: [{ id: 'stay', kind: 'stay' }] },
        widthHint: 1776
      });
      assertEqual(findAll(single, 'htd-case').length, 0, 'no buttons for one case');
      const stale = mount({ selectedCaseId: 'gone' });
      assertEqual(stale.tradeDownState().selectedId, 'stay', 'opens on the base case');
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
      buttonFor(withCallback, 'repay-12000').click();
      buttonFor(withCallback, 'repay-12000').click();
      assertEqual(JSON.stringify(told), '["repay-12000"]', 'told once, and not for the case already selected');

      let settled = false;
      const pending = root.presenterSelectScenario('no-mortgage').then(() => { settled = true; });
      assertEqual(root.tradeDownState().selectedId, 'no-mortgage', 'selected at once');
      env.sched.advance(CLICK_MS + SETTLE_GRACE_MS + 20);
      await pending;
      assert(settled, 'resolved after the transition');
      let refused = false;
      try {
        await root.presenterSelectScenario('nope');
      } catch (error) {
        refused = /Unknown home trade down scenario: nope/.test(error.message);
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
    console.warn('[HomeTradeDownModuleTests] Completed with failures', summary);
  } else {
    console.info('[HomeTradeDownModuleTests] All tests passed', { total: summary.total, passed: summary.passed });
  }
  return summary;
}
