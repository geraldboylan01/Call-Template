import {
  CLICK_MS,
  SETTLE_GRACE_MS,
  buildRentalKeepOrSellModule,
  createRentalClock
} from './rental_keep_or_sell_module.js';
import { RENTAL_KEEP_OR_SELL_SAMPLE } from './tests_rental_keep_or_sell_math.js';
import { findForbiddenText } from './rental_keep_or_sell_view.js';

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
    console.info(`[RentalKeepOrSellModuleTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[RentalKeepOrSellModuleTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

async function runAsyncCase(name, testFn) {
  try {
    await testFn();
    console.info(`[RentalKeepOrSellModuleTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[RentalKeepOrSellModuleTests] FAIL: ${name}`, error);
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
    if (['rks-bar', 'rks-label', 'rks-zero', 'rks-headline-line', 'rks-connector', 'rks-zero-label']
      .some((name) => classes.includes(name))) {
      marks.push([node.className, node.style.left, node.style.width, node.style.top, node.hidden]);
    }
    node.children.forEach(walk);
  };
  walk(root);
  return JSON.stringify({ strings: visibleStrings(root), marks });
}

/** The left edges of the five bars, as numbers. */
function barLefts(root) {
  return findAll(root, 'rks-bar').map((node) => parseFloat(node.style.left));
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
  const root = buildRentalKeepOrSellModule({
    rawInputs: RENTAL_KEEP_OR_SELL_SAMPLE,
    widthHint: 1776,
    ...options
  });
  assert(root, 'the module built');
  root._attached = true;
  return root;
}

const buttonFor = (root, id) => findAll(root, 'rks-case').find((button) => button.dataset.caseId === id);

/* ----------------------------------------------------------------- tests */

export async function runRentalKeepOrSellModuleTests() {
  const cases = [];

  cases.push(runCase('The clock paints eased progress from the first frame and ends exactly on 1', () => {
    const sched = createScheduler();
    const clock = createRentalClock(sched);
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
    const clock = createRentalClock(sched);
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
    const clock = createRentalClock(sched);
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
    const clock = createRentalClock(sched);
    const painted = [];
    clock.run(0, (progress) => painted.push(progress));
    assertEqual(JSON.stringify(painted), '[1]', 'one paint, on 1');
    assertEqual(sched.frames.length + sched.timers.length, 0, 'nothing scheduled');
  }));

  cases.push(runCase('A module that has gone paints nothing', () => {
    const sched = createScheduler();
    let alive = true;
    const clock = createRentalClock({ ...sched, requestFrame: sched.requestFrame, isAlive: () => alive });
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
        ['sell', 'keep', 'sell'],
        ['sell'],
        ['sell', 'keep', 'sell', 'keep', 'sell', 'keep'],
        ['keep', 'sell', 'sell', 'keep']
      ];
      [1776, 358, 252].forEach((widthHint) => {
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
          assertEqual(root.rentalState().selectedId, last, 'the selected case');
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
      buttonFor(root, 'sell').click();
      assertEqual(env.sched.frames.length + env.sched.timers.length, 0, 'nothing was scheduled');
      assertEqual(
        snapshot(root),
        snapshot(mount({ selectedCaseId: 'sell' })),
        'the screen already shows the new case'
      );
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('A click changes every word at once, and the marks then travel', () => {
    const env = installDom();
    try {
      const root = mount();
      const headline = findAll(root, 'rks-headline')[0];
      assertEqual(
        headline.textContent,
        'The rent does not cover the loan repayments, running costs and tax: €1,200 short each year.',
        'opens on Keep'
      );
      const before = barLefts(root);
      const namesBefore = findAll(root, 'rks-name').map((node) => node.textContent).join('|');
      assertEqual(namesBefore, 'Rent|Loan repayments|Running costs|Tax on the rental profit|Net each year', 'Keep names');

      buttonFor(root, 'sell').click();
      // No frame has run yet: the words have already changed, the bars have not.
      assertEqual(
        headline.textContent,
        'Selling costs, the loan and tax come off the price: €113,000 is what you would have in hand.',
        'the sentence changed at the click'
      );
      assertEqual(
        findAll(root, 'rks-name').map((node) => node.textContent).join('|'),
        'Sale price|Selling costs|Loan repaid|Tax on the gain|In hand',
        'the names changed at the click'
      );
      assertEqual(
        findAll(root, 'rks-value').map((node) => node.textContent).join('|'),
        '€320,000|−€6,000|−€180,000|−€21,000|€113,000',
        'the values changed at the click'
      );
      assertEqual(
        findAll(root, 'rks-case').map((button) => button.getAttribute('aria-pressed')).join(','),
        'false,true',
        'the pressed state moved'
      );
      assertEqual(JSON.stringify(barLefts(root)), JSON.stringify(before), 'no bar has moved yet');

      env.sched.advance(CLICK_MS / 2);
      assert(JSON.stringify(barLefts(root)) !== JSON.stringify(before), 'half way, the bars are travelling');
      env.sched.advance(CLICK_MS + 200);
      assertEqual(
        JSON.stringify(barLefts(root)),
        JSON.stringify(barLefts(mount({ selectedCaseId: 'sell' }))),
        'the bars end where a fresh Sell has them'
      );
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('A click does not rebuild the drawing: the same elements stay put', () => {
    const env = installDom();
    try {
      const root = mount();
      const barsBefore = findAll(root, 'rks-bar');
      const labelsBefore = findAll(root, 'rks-label');
      buttonFor(root, 'sell').click();
      env.sched.advance(CLICK_MS + 200);
      const barsAfter = findAll(root, 'rks-bar');
      const labelsAfter = findAll(root, 'rks-label');
      assertEqual(barsAfter.length, 5, 'five bars');
      barsAfter.forEach((node, index) => assert(node === barsBefore[index], `bar ${index} is the same element`));
      labelsAfter.forEach((node, index) => assert(node === labelsBefore[index], `label ${index} is the same element`));
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('The result bar carries its tone beside its word, and the word is always shown', () => {
    const env = installDom();
    try {
      const root = mount();
      const resultBar = () => findAll(root, 'rks-bar')[4];
      const resultWord = () => findAll(root, 'rks-word')[4];
      assert(resultBar().className.includes('is-short'), 'Keep is short');
      assertEqual(resultWord().textContent, 'a year, short', 'beside the word');
      assertEqual(resultWord().hidden, false, 'the word is shown');

      buttonFor(root, 'sell').click();
      env.sched.advance(CLICK_MS + 200);
      assert(resultBar().className.includes('is-left-over'), 'Sell is left over');
      assert(!resultBar().className.includes('is-short'), 'and no longer short');
      assertEqual(resultWord().textContent, 'in hand', 'beside the word');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Nothing rendered says a banned phrase, "we", "us", "our", a provider or a bare amount, wide or narrow', () => {
    const env = installDom();
    try {
      [1776, 358, 252].forEach((widthHint) => {
        const root = mount({ widthHint });
        ['keep', 'sell'].forEach((id) => {
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

  cases.push(runCase('Wide shows connectors on the three cuts and names beside the bars; narrow shows neither', () => {
    const env = installDom();
    try {
      const wide = mount({ widthHint: 1776 });
      assertEqual(findAll(wide, 'rks-connector').length, 3, 'wide: three connectors');
      assert(!findAll(wide, 'rks-chart')[0].className.includes('is-narrow'), 'wide: not narrow');

      const narrow = mount({ widthHint: 358 });
      assertEqual(findAll(narrow, 'rks-connector').length, 0, 'narrow: no connectors');
      assert(findAll(narrow, 'rks-chart')[0].className.includes('is-narrow'), 'narrow: marked narrow');
      assertEqual(findAll(narrow, 'rks-chart')[0].style.width, '326px', 'narrow: 16px of padding each side');
      const phone = mount({ widthHint: 390 });
      assertEqual(findAll(phone, 'rks-chart')[0].style.width, '358px', 'a 390 phone gives a 358 chart');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('At 252 the names wrap, the word goes under the number, and nothing is cut off', () => {
    const env = installDom();
    try {
      const root = mount({ widthHint: 252 });
      const chart = findAll(root, 'rks-chart')[0];
      assertEqual(chart.style.width, '220px', 'a 252 module gives a 220 chart');
      assert(chart.className.includes('is-narrow') && chart.className.includes('is-stacked'), 'narrow and stacked');
      const names = findAll(root, 'rks-name');
      assertEqual(names.length, 5, 'five names');
      names.forEach((node, index) => {
        assertEqual(node.style.height, '40px', `name ${index}: room for two lines`);
        assertEqual(node.style.lineHeight, '20px', `name ${index}: at 20px a line`);
        assertEqual(node.style.width, 'auto', `name ${index}: as wide as its words`);
      });
      const labels = findAll(root, 'rks-label');
      labels.forEach((node, index) => {
        assert(/^\d+(\.\d+)?px$/.test(node.style.width), `label ${index}: one box width (${node.style.width})`);
        assertEqual(node.style.width, labels[0].style.width, `label ${index}: the same as the others`);
      });
      // Both cases, after a click, still lay out and say what they say.
      buttonFor(root, 'sell').click();
      env.sched.advance(CLICK_MS + 200);
      assertEqual(findAll(root, 'rks-name')[3].textContent, 'Tax on the gain', 'Sell names');
      assertEqual(findAll(root, 'rks-value')[4].textContent, '€113,000', 'Sell result');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('A payload that cannot be projected builds nothing, and a remembered case that is gone is ignored', () => {
    const env = installDom();
    try {
      assertEqual(buildRentalKeepOrSellModule({ rawInputs: { rentPerYear: 1 } }), null, 'a bad payload');
      const stale = mount({ selectedCaseId: 'gone' });
      assertEqual(stale.rentalState().selectedId, 'keep', 'opens on the base case');
      const sell = buildRentalKeepOrSellModule({
        rawInputs: { ...RENTAL_KEEP_OR_SELL_SAMPLE, baseScenarioId: 'sell' },
        widthHint: 1776
      });
      assertEqual(sell.rentalState().selectedId, 'sell', 'opens on the payload\'s base case');
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
      buttonFor(withCallback, 'sell').click();
      buttonFor(withCallback, 'sell').click();
      assertEqual(JSON.stringify(told), '["sell"]', 'told once, and not for the case already selected');

      let settled = false;
      const pending = root.presenterSelectScenario('sell').then(() => { settled = true; });
      assertEqual(root.rentalState().selectedId, 'sell', 'selected at once');
      env.sched.advance(CLICK_MS + SETTLE_GRACE_MS + 20);
      await pending;
      assert(settled, 'resolved after the transition');
      let refused = false;
      try {
        await root.presenterSelectScenario('nope');
      } catch (error) {
        refused = /Unknown rental keep or sell scenario: nope/.test(error.message);
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
    console.warn('[RentalKeepOrSellModuleTests] Completed with failures', summary);
  } else {
    console.info('[RentalKeepOrSellModuleTests] All tests passed', { total: summary.total, passed: summary.passed });
  }
  return summary;
}
