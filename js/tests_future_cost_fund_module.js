import {
  CLICK_MS,
  SETTLE_GRACE_MS,
  buildFutureCostFundModule,
  createFundClock
} from './future_cost_fund_module.js';
import { FUTURE_COST_FUND_SAMPLE } from './tests_future_cost_fund_math.js';
import { findForbiddenText } from './future_cost_fund_view.js';

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
    console.info(`[FutureCostFundModuleTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[FutureCostFundModuleTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

async function runAsyncCase(name, testFn) {
  try {
    await testFn();
    console.info(`[FutureCostFundModuleTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[FutureCostFundModuleTests] FAIL: ${name}`, error);
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

function snapshot(root) {
  const paths = [];
  const walk = (node) => {
    if (node.attributes.d) paths.push(node.attributes.d);
    node.children.forEach(walk);
  };
  walk(root);
  const boxes = [];
  const note = (node) => {
    if (node.className.includes('fcf-label') && !node.hidden) {
      boxes.push([node.textContent, node.style.top, node.style.left, node.style.right]);
    }
    node.children.forEach(note);
  };
  note(root);
  return JSON.stringify({ strings: visibleStrings(root), paths, boxes });
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
  const root = buildFutureCostFundModule({
    rawInputs: FUTURE_COST_FUND_SAMPLE,
    projectionOptions: { calculationYear: 2026 },
    widthHint: 1776,
    ...options
  });
  assert(root, 'the module built');
  root._attached = true;
  return root;
}

/* ----------------------------------------------------------------- tests */

export async function runFutureCostFundModuleTests() {
  const cases = [];

  cases.push(runCase('The clock paints eased progress from the first frame and ends exactly on 1', () => {
    const sched = createScheduler();
    const clock = createFundClock(sched);
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
    const clock = createFundClock(sched);
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
    const clock = createFundClock(sched);
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
    const clock = createFundClock(sched);
    const painted = [];
    clock.run(0, (progress) => painted.push(progress));
    assertEqual(JSON.stringify(painted), '[1]', 'one paint, on 1');
    assertEqual(sched.frames.length + sched.timers.length, 0, 'nothing scheduled');
  }));

  cases.push(runCase('A module that has gone paints nothing', () => {
    const sched = createScheduler();
    let alive = true;
    const clock = createFundClock({ ...sched, requestFrame: sched.requestFrame, isAlive: () => alive });
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
        ['yearly', 'half', 'delayed', 'lump', 'half'],
        ['delayed', 'lump'],
        ['half', 'yearly', 'half', 'yearly', 'delayed']
      ];
      sequences.forEach((sequence, run) => {
        const root = mount();
        const buttons = findAll(root, 'fcf-case');
        sequence.forEach((id, index) => {
          buttons.find((button) => button.dataset.caseId === id).click();
          // Alternate between a patient click-through, a fast one and a starved tab.
          const mode = (index + run) % 3;
          if (mode === 0) env.sched.advance(80);
          if (mode === 1) env.sched.advance(8);
          if (mode === 2) env.sched.advance(30, { frames: false });
        });
        env.sched.advance(CLICK_MS * 3, { frames: false });
        env.sched.advance(CLICK_MS * 2);

        const last = sequence[sequence.length - 1];
        const fresh = mount({ selectedCaseId: last });
        assertEqual(snapshot(root), snapshot(fresh), `sequence ${run + 1} ends on a fresh render of ${last}`);
        assertEqual(root.fundState().selectedId, last, 'the selected case');
      });
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Reduced motion: a click lands on the new case in the same call', () => {
    const env = installDom({ reducedMotion: true });
    try {
      const root = mount();
      const buttons = findAll(root, 'fcf-case');
      buttons.find((button) => button.dataset.caseId === 'delayed').click();
      assertEqual(env.sched.frames.length + env.sched.timers.length, 0, 'nothing was scheduled');
      assertEqual(
        snapshot(root),
        snapshot(mount({ selectedCaseId: 'delayed' })),
        'the screen already shows the new case'
      );
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('A click changes every word at once and keeps the cost where it is', () => {
    const env = installDom();
    try {
      const root = mount();
      const blocks = () => findAll(root, 'fcf-block').map((node) => `${node.style.left}|${node.style.top}|${node.style.height}`).join(';');
      const before = blocks();
      const headline = findAll(root, 'fcf-headline')[0];
      assertEqual(headline.textContent, 'Setting aside €86,100 today covers the whole cost.', 'opens on the first case');

      findAll(root, 'fcf-case').find((button) => button.dataset.caseId === 'yearly').click();
      // No frame has run yet: the words have already changed, the line has not.
      assertEqual(headline.textContent, 'Putting in €10,800 a year for 8 years covers the whole cost.', 'the headline changed at the click');
      assertEqual(
        findAll(root, 'fcf-support')[0].textContent,
        'You pay in €86,500 and growth adds €700. Together that is the €87,200 you need.',
        'the support line changed at the click'
      );
      const pressed = findAll(root, 'fcf-case').map((button) => button.getAttribute('aria-pressed')).join(',');
      assertEqual(pressed, 'false,true,false,false', 'the pressed state moved');
      env.sched.advance(CLICK_MS + 200);
      assertEqual(blocks(), before, 'the cost blocks did not move');
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('Nothing rendered says a banned phrase, a provider, "p.a." or a bare amount, wide or narrow', () => {
    const env = installDom();
    try {
      [1776, 358].forEach((widthHint) => {
        const root = mount({ widthHint });
        ['lump', 'yearly', 'half', 'delayed'].forEach((id) => {
          findAll(root, 'fcf-case').find((button) => button.dataset.caseId === id).click();
          env.sched.advance(CLICK_MS + 200);
          const problems = findForbiddenText(visibleStrings(root));
          assert(problems.length === 0, `${id} at ${widthHint}: ${problems.join('; ')}`);
        });
      });
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('A phone shows the covered line and the cost by year under the chart; a wide screen does not', () => {
    const env = installDom();
    try {
      const wide = mount({ widthHint: 1776 });
      assertEqual(findAll(wide, 'fcf-covered')[0].hidden, true, 'wide: the covered line is hidden');
      assertEqual(findAll(wide, 'fcf-by-year')[0].hidden, true, 'wide: the by-year line is hidden');
      const narrow = mount({ widthHint: 358 });
      assertEqual(findAll(narrow, 'fcf-covered')[0].hidden, false, 'narrow: the covered line shows');
      assertEqual(
        findAll(narrow, 'fcf-by-year')[0].textContent,
        'The cost by year: year 8 €20,500, year 9 €21,300, year 10 €22,200, year 11 €23,100.',
        'narrow: the by-year line'
      );
    } finally {
      env.restore();
    }
  }));

  cases.push(runCase('A payload that cannot be projected builds nothing, and one case builds no buttons', () => {
    const env = installDom();
    try {
      assertEqual(buildFutureCostFundModule({ rawInputs: { costTitle: 'x' } }), null, 'a bad payload');
      const single = buildFutureCostFundModule({
        rawInputs: { ...FUTURE_COST_FUND_SAMPLE, scenarios: [{ id: 'only', lumpShare: 1 }] },
        projectionOptions: { calculationYear: 2026 },
        widthHint: 1776
      });
      assertEqual(findAll(single, 'fcf-case').length, 0, 'no buttons for one case');
      // A remembered case the payload no longer has is ignored, not shown.
      const stale = mount({ selectedCaseId: 'gone' });
      assertEqual(stale.fundState().selectedId, 'lump', 'opens on the base case');
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
      findAll(withCallback, 'fcf-case').find((button) => button.dataset.caseId === 'half').click();
      findAll(withCallback, 'fcf-case').find((button) => button.dataset.caseId === 'half').click();
      assertEqual(JSON.stringify(told), '["half"]', 'told once, and not for the case already selected');

      let settled = false;
      const pending = root.presenterSelectScenario('half').then(() => { settled = true; });
      assertEqual(root.fundState().selectedId, 'half', 'selected at once');
      env.sched.advance(CLICK_MS + SETTLE_GRACE_MS + 20);
      await pending;
      assert(settled, 'resolved after the transition');
      let refused = false;
      try {
        await root.presenterSelectScenario('nope');
      } catch (error) {
        refused = /Unknown future cost fund scenario: nope/.test(error.message);
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
    console.warn('[FutureCostFundModuleTests] Completed with failures', summary);
  } else {
    console.info('[FutureCostFundModuleTests] All tests passed', { total: summary.total, passed: summary.passed });
  }
  return summary;
}
