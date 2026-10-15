/**
 * RENTAL, KEEP OR SELL.
 *
 * One module, shown on a shared screen during a live call, answering one
 * question: what does this property give you each year if you keep it, and what
 * would you have in hand if you sold it? The adviser clicks between Keep and
 * Sell while narrating; the same screen is re-opened later by the client alone,
 * so nothing here depends on spoken context.
 *
 * THE PICTURE. One bar, cut down step by step from the headline to what is left.
 * Keep starts at the rent and ends at the net each year; Sell starts at the sale
 * price and ends at what is in hand. Both have the same five lines, so every
 * mark has an old position and a new one, and those marks are what travel when
 * a case is clicked.
 *
 * WHAT LIVES WHERE. This file draws. Everything the screen decides that is not
 * a DOM node -- the words and the geometry -- is in
 * `js/rental_keep_or_sell_view.js`, where a check can ask it without a browser.
 * Every amount comes from `js/rental_keep_or_sell_math.js`.
 *
 * It follows `js/repayment_case_module.js` and `js/future_cost_fund_module.js`:
 * the same 520ms clock, the same settling discipline, the same shape of
 * `build...Module(...)`, and the same `presenterSelectScenario`.
 */

import { computeRentalKeepOrSellProjection } from './rental_keep_or_sell_math.js';
import {
  buildRentalCopy,
  layoutRentalChart,
  lerpValues
} from './rental_keep_or_sell_view.js';

/* ------------------------------------------------------------------ motion */

/** The one clock. Long enough to follow, short enough to feel like a click. */
export const CLICK_MS = 520;

/** Timers fire in throttled tabs where animation frames do not. */
export const SETTLE_GRACE_MS = 120;

/** The width to lay out at before the module is attached and can be measured. */
const DEFAULT_WIDTH = 1776;

function easeOutCubic(k) {
  return 1 - ((1 - k) ** 3);
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function isReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * THE CLOCK, WITH EVERYTHING IT NEEDS TO BE TRUSTED.
 *
 * No two figures on screen may ever disagree: not at any point in a transition,
 * and not after any sequence of clicks. Four things are needed for that:
 *
 *  1. progress is clamped to 0-1 and timed from the FIRST FRAME, not from a
 *     clock read at click time, so the first frame cannot come out negative;
 *  2. a new run cancels the one in flight, and every loop is guarded by a
 *     monotonic token, so two overlapping loops cannot leave the bars on one
 *     case and the words on another;
 *  3. a settle timer forces the end state, because frames stop entirely in a
 *     backgrounded tab and the picture would otherwise sit half way;
 *  4. a frame that arrives AFTER the settle timer must not restart the run: the
 *     `finished` flag is checked before anything is painted.
 *
 * It takes its timers as arguments so a check can drive it with fake ones.
 *
 * @param {object} timers
 * @param {Function} timers.requestFrame  like requestAnimationFrame
 * @param {Function} timers.cancelFrame   like cancelAnimationFrame
 * @param {Function} timers.setTimer      like setTimeout
 * @param {Function} timers.clearTimer    like clearTimeout
 * @param {Function} [timers.isAlive]     false once the module is gone
 */
export function createRentalClock({
  requestFrame,
  cancelFrame,
  setTimer,
  clearTimer,
  isAlive = () => true
}) {
  let frameHandle = null;
  let settleHandle = null;
  let token = 0;

  function stop() {
    if (frameHandle !== null) {
      cancelFrame(frameHandle);
      frameHandle = null;
    }
    if (settleHandle !== null) {
      clearTimer(settleHandle);
      settleHandle = null;
    }
  }

  /**
   * @param {number} durationMs 0 means no travel: paint the end state at once
   * @param {Function} paint called with eased progress, 0 to 1, ending on 1
   */
  function run(durationMs, paint) {
    stop();
    token += 1;
    const runToken = token;

    if (!durationMs) {
      paint(1);
      return;
    }

    let startedAt = null;
    let finished = false;

    const step = (now) => {
      // A stale loop must never write, and neither does one that arrives after
      // the settle timer has already landed the end state.
      if (finished || runToken !== token || !isAlive()) {
        frameHandle = null;
        return;
      }
      if (startedAt === null) startedAt = now;

      const progress = clamp((now - startedAt) / durationMs, 0, 1);
      paint(progress >= 1 ? 1 : easeOutCubic(progress));

      if (progress < 1) {
        frameHandle = requestFrame(step);
        return;
      }
      finished = true;
      frameHandle = null;
      stop();
    };

    frameHandle = requestFrame(step);

    // THE END STATE IS NOT CONDITIONAL ON ANYTHING.
    settleHandle = setTimer(() => {
      settleHandle = null;
      if (finished || runToken !== token) return;
      finished = true;
      paint(1);
    }, durationMs + SETTLE_GRACE_MS);
  }

  return { run, stop, get token() { return token; } };
}

/* ------------------------------------------------------------------- DOM */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function px(value) {
  return `${value.toFixed(1)}px`;
}

const ROW_KEYS = Object.freeze(['start', 'cut1', 'cut2', 'cut3', 'result']);

/* ---------------------------------------------------------------- the module */

/**
 * @param {object} options
 * @param {object} options.rawInputs        the payload's rentalKeepOrSellInputs
 * @param {string} [options.selectedCaseId] the case to open on
 * @param {Function} [options.onSelectCase] told when the client picks a case
 * @param {number} [options.widthHint]      the width to lay out at before it is attached
 * @returns {HTMLElement|null} null when the payload cannot be projected
 */
export function buildRentalKeepOrSellModule({
  rawInputs,
  selectedCaseId = null,
  onSelectCase = null,
  widthHint = null
} = {}) {
  let projection;
  try {
    projection = computeRentalKeepOrSellProjection(rawInputs);
  } catch (_error) {
    return null;
  }

  const cases = projection.debug.cases;
  if (cases.length === 0) return null;

  // THE MODULE OPENS ON THE BASE CASE unless it was told which case the client
  // was last on, and a remembered case the payload no longer has is ignored.
  let selectedId = cases.some((entry) => entry.id === selectedCaseId)
    ? selectedCaseId
    : projection.debug.baseScenarioId;

  let layout = null;
  let copy = null;
  let shown = null;
  let chart = null;
  let observer = null;
  let measuredWidth = 0;

  const root = el('section', 'rks');
  root.dataset.generatedCard = 'rental-keep-or-sell';
  root.setAttribute('aria-label', 'Keep or sell a rental property');

  /* ----------------------------------------------------------------- head */

  const head = el('header', 'rks-head');
  const title = el('h2', 'rks-title');
  head.append(title);
  root.append(head);

  /* ----------------------------------------------------------- the cases */

  const group = el('div', 'rks-cases');
  group.setAttribute('role', 'group');
  const buttons = cases.map((entry) => {
    const button = el('button', 'rks-case');
    button.type = 'button';
    button.dataset.caseId = entry.id;
    button.append(el('span', 'rks-case-name'), el('span', 'rks-case-answer'));
    button.addEventListener('click', () => selectCase(entry.id));
    group.append(button);
    return button;
  });
  root.append(group);

  /* ----------------------------------------------------------- the stage */

  const stage = el('div', 'rks-stage');
  const headline = el('p', 'rks-headline');
  // The answer changes on a click, so it is announced.
  headline.setAttribute('aria-live', 'polite');
  const chartHost = el('div', 'rks-chart');
  chartHost.setAttribute('role', 'img');
  stage.append(headline, chartHost);
  root.append(stage);

  const footnote = el('p', 'rks-footnote');
  root.append(footnote);

  /* ------------------------------------------------------------- layout */

  function measure() {
    return Math.round(root.clientWidth || widthHint || DEFAULT_WIDTH);
  }

  /** Build the drawing's elements for the current layout. Static until resized. */
  function buildChart() {
    chartHost.replaceChildren();
    chartHost.style.width = `${layout.chartWidth}px`;
    chartHost.style.height = `${layout.height}px`;
    chartHost.classList.toggle('is-narrow', layout.narrow);
    // On a very narrow chart the word sits under the number.
    chartHost.classList.toggle('is-stacked', layout.stacked);
    stage.classList.toggle('is-narrow', layout.narrow);
    root.classList.toggle('is-narrow', layout.narrow);

    const zero = el('div', 'rks-zero');
    zero.style.height = `${layout.rowsHeight}px`;
    const headlineLine = el('div', 'rks-headline-line');
    headlineLine.style.height = `${layout.rowsHeight}px`;
    const zeroLabel = el('div', 'rks-zero-label');
    zeroLabel.style.top = `${layout.axis.top}px`;
    chartHost.append(zero, headlineLine, zeroLabel);

    const rows = layout.rows.map((spec, index) => {
      const key = ROW_KEYS[index];
      const kind = key === 'start' ? 'is-start' : (key === 'result' ? 'is-result' : 'is-cut');

      const name = el('div', `rks-name ${kind}`);
      name.style.left = `${spec.name.left}px`;
      name.style.top = `${spec.name.top}px`;
      // Above its bar a name is as wide as its text, so the lines behind it
      // stop only under the words.
      name.style.width = layout.narrow ? 'auto' : `${spec.name.width}px`;
      name.style.height = `${spec.name.height}px`;
      // A name that is too long wraps onto a second line; it is never cut off.
      name.style.lineHeight = `${spec.name.lineHeight}px`;

      const bar = el('div', `rks-bar ${kind}`);
      bar.style.top = `${spec.barTop}px`;
      bar.style.height = `${spec.barHeight}px`;

      const label = el('div', `rks-label ${kind}`);
      label.style.top = `${spec.labelTop}px`;
      label.style.height = `${spec.labelHeight}px`;
      // Stacked, the number and the word are two lines and the stylesheet sets them.
      label.style.lineHeight = layout.stacked ? '' : `${spec.labelHeight}px`;
      // Stacked, every label is one box wide and the word wraps inside it.
      if (layout.stacked) {
        label.style.width = `${layout.stackBox}px`;
      }
      const value = el('span', 'rks-value');
      const word = el('span', 'rks-word');
      label.append(value, word);

      let connector = null;
      if (spec.connector) {
        connector = el('div', 'rks-connector');
        connector.style.top = `${spec.connector.top}px`;
        connector.style.height = `${spec.connector.height}px`;
      }

      chartHost.append(...[connector, bar, name, label].filter(Boolean));
      return { name, bar, label, value, word, connector };
    });

    chart = { zero, headlineLine, zeroLabel, rows };
  }

  /** Draw the marks at `values`. Everything that moves is painted here. */
  function paintValues(values) {
    shown = values;
    chart.zero.style.left = px(values[0]);
    chart.headlineLine.style.left = px(values[1]);
    chart.zeroLabel.style.left = px(values[0]);

    chart.rows.forEach((row, index) => {
      const left = values[2 + (index * 3)];
      const width = values[3 + (index * 3)];
      const labelLeft = values[4 + (index * 3)];
      row.bar.style.left = px(left);
      row.bar.style.width = px(width);
      row.label.style.left = px(labelLeft);
      if (row.connector) {
        row.connector.style.left = px(left);
      }
    });
  }

  /** The words and the states that change on a click. Never on the clock. */
  function renderCopy() {
    copy = buildRentalCopy(projection, selectedId);

    setText(title, copy.heading);
    setText(headline, copy.headline);
    setText(footnote, copy.footnote);
    group.setAttribute('aria-label', copy.groupLabel);
    chartHost.setAttribute('aria-label', copy.chartLabel);

    buttons.forEach((button, index) => {
      const spec = copy.buttons[index];
      const active = spec.id === selectedId;
      setText(button.firstChild, spec.title);
      setText(button.lastChild, spec.answerLine);
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    if (chart) {
      setText(chart.zeroLabel, copy.zeroLabel);
      chart.rows.forEach((row, index) => {
        const line = copy.lines[index];
        setText(row.name, line.name);
        setText(row.value, line.value);
        setText(row.word, line.word);
        row.word.hidden = !line.word;
        if (index === 4) {
          // The result bar's tone, always beside its word.
          row.bar.classList.toggle('is-left-over', copy.tone === 'left_over');
          row.bar.classList.toggle('is-short', copy.tone === 'short');
          row.bar.classList.toggle('is-level', copy.tone === 'level');
        }
      });
    }
  }

  function relayout() {
    const width = measure();
    measuredWidth = width;
    layout = layoutRentalChart(projection, { width });
    clock.stop();
    buildChart();
    renderCopy();
    // Resizing is not a transition: settle on the selected case at once.
    paintValues(layout.values[selectedId]);
  }

  /* ---------------------------------------------------------- the clock */

  const clock = createRentalClock({
    requestFrame: (fn) => requestAnimationFrame(fn),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle),
    isAlive: () => root.isConnected
  });

  function selectCase(id) {
    if (id === selectedId || !cases.some((entry) => entry.id === id)) return;

    // From what is on screen right now, so a click mid-travel carries on from
    // where the bars are and does not jump back to where they started.
    const from = shown;
    selectedId = id;
    const to = layout.values[id];

    // Every WORD changes in the same frame as the click: the sentence, the
    // names, the values and the buttons. They are not counted up.
    renderCopy();

    clock.run(isReducedMotion() ? 0 : CLICK_MS, (progress) => {
      paintValues(lerpValues(from, to, progress));
    });

    if (typeof onSelectCase === 'function') {
      onSelectCase(id);
    }
  }

  /* ------------------------------------------------------------- start */

  relayout();

  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => {
      if (!root.isConnected) return;
      const width = Math.round(root.clientWidth || 0);
      if (width > 0 && Math.abs(width - measuredWidth) >= 1) {
        relayout();
      }
    });
    observer.observe(root);
  }

  root.presenterSelectScenario = async (id) => {
    if (!cases.some((entry) => entry.id === id)) {
      throw new Error(`Unknown rental keep or sell scenario: ${id}`);
    }
    selectCase(id);
    await new Promise((resolve) => {
      window.setTimeout(resolve, isReducedMotion() ? 0 : CLICK_MS + SETTLE_GRACE_MS);
    });
  };

  /** What a check can read back: the case on screen and the values drawn. */
  root.rentalState = () => ({ selectedId, values: shown, layout });

  root.destroyRentalKeepOrSell = () => {
    clock.stop();
    if (observer) observer.disconnect();
  };

  return root;
}
