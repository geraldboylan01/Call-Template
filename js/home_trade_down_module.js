/**
 * HOME, TRADE DOWN.
 *
 * One module, shown on a shared screen during a live call, answering one
 * question: if you set a yearly repayment you are comfortable with, what home
 * does that buy? The adviser clicks between up to four cases while narrating;
 * the same screen is re-opened later by the client alone, so nothing here
 * depends on spoken context.
 *
 * THE PICTURE. A home budget built from two blocks, left to right: the money
 * from selling after buying costs, and a new loan. The loan block changes by
 * case, and that is the mark that travels. Beside it, a track of what is repaid
 * on the mortgage today, split into what is still repaid and what is freed. The
 * home is on one scale (today's home) and the year on another (today's
 * repayments), and each says so.
 *
 * WHAT LIVES WHERE. This file draws. Everything the screen decides that is not
 * a DOM node -- the words and the geometry -- is in
 * `js/home_trade_down_view.js`, where a check can ask it without a browser.
 * Every amount comes from `js/home_trade_down_math.js`.
 *
 * It follows `js/repayment_case_module.js` and `js/future_cost_fund_module.js`:
 * the same 520ms clock, the same settling discipline, the same shape of
 * `build...Module(...)`, and the same `presenterSelectScenario`.
 */

import { computeHomeTradeDownProjection } from './home_trade_down_math.js';
import {
  buildTradeDownCopy,
  layoutTradeDownChart,
  lerpValues
} from './home_trade_down_view.js';

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
 *     monotonic token, so two overlapping loops cannot leave the blocks on one
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
export function createTradeDownClock({
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

function place(node, box) {
  if (box.left !== undefined) node.style.left = `${box.left}px`;
  if (box.top !== undefined) node.style.top = `${box.top}px`;
  if (box.width !== undefined) node.style.width = `${box.width}px`;
  if (box.height !== undefined) node.style.height = `${box.height}px`;
}

/* ---------------------------------------------------------------- the module */

/**
 * @param {object} options
 * @param {object} options.rawInputs        the payload's homeTradeDownInputs
 * @param {string} [options.selectedCaseId] the case to open on
 * @param {Function} [options.onSelectCase] told when the client picks a case
 * @param {number} [options.widthHint]      the width to lay out at before it is attached
 * @returns {HTMLElement|null} null when the payload cannot be projected
 */
export function buildHomeTradeDownModule({
  rawInputs,
  selectedCaseId = null,
  onSelectCase = null,
  widthHint = null
} = {}) {
  let projection;
  try {
    projection = computeHomeTradeDownProjection(rawInputs);
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

  const root = el('section', 'htd');
  root.dataset.generatedCard = 'home-trade-down';
  root.setAttribute('aria-label', 'Trade down the home');

  /* ----------------------------------------------------------------- head */

  const head = el('header', 'htd-head');
  const title = el('h2', 'htd-title');
  head.append(title);
  root.append(head);

  /* ----------------------------------------------------------- the cases */

  let group = null;
  let buttons = [];
  if (cases.length > 1) {
    group = el('div', 'htd-cases');
    group.setAttribute('role', 'group');
    buttons = cases.map((entry) => {
      const button = el('button', 'htd-case');
      button.type = 'button';
      button.dataset.caseId = entry.id;
      button.append(el('span', 'htd-case-name'), el('span', 'htd-case-sub'));
      button.addEventListener('click', () => selectCase(entry.id));
      group.append(button);
      return button;
    });
    root.append(group);
  }

  /* ----------------------------------------------------------- the stage */

  const stage = el('div', 'htd-stage');
  const headline = el('p', 'htd-headline');
  // The answer changes on a click, so it is announced.
  headline.setAttribute('aria-live', 'polite');
  const chartHost = el('div', 'htd-chart');
  chartHost.setAttribute('role', 'img');
  stage.append(headline, chartHost);
  root.append(stage);

  const footnote = el('p', 'htd-footnote');
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
    chartHost.classList.toggle('is-compact', Boolean(layout.compact));
    stage.classList.toggle('is-narrow', layout.narrow);
    root.classList.toggle('is-narrow', layout.narrow);
    const { boxes, constants: k } = layout;

    // The home.
    const figure = el('div', 'htd-figure');
    const figureValue = el('span', 'htd-figure-value');
    const figureWord = el('span', 'htd-figure-word');
    figure.append(figureValue, figureWord);
    place(figure, boxes.figure);
    if (boxes.figure.font) {
      // Compact: one font for every case, fitted to the chart, so a click never
      // changes a size and the amount never runs past the chart.
      figureValue.style.fontSize = `${boxes.figure.font}px`;
      figureValue.style.lineHeight = `${Math.round(boxes.figure.font * 1.15)}px`;
    }

    const todayLine = el('div', 'htd-today-line');
    place(todayLine, boxes.todayLine);
    const todayLabel = el('div', 'htd-today-label');
    const todayName = el('span', 'htd-today-name');
    const todayValue = el('span', 'htd-today-value');
    todayLabel.append(todayName, todayValue);
    place(todayLabel, boxes.todayLabel);

    const blockOne = el('div', 'htd-block is-one');
    const blockTwo = el('div', 'htd-block is-two');
    [blockOne, blockTwo].forEach((node) => {
      node.style.top = `${boxes.bar.top}px`;
      node.style.height = `${boxes.bar.height}px`;
    });
    blockOne.style.left = '0px';

    const labelOne = el('div', 'htd-label is-one');
    const amountOne = el('div', 'htd-amount');
    const nameOne = el('div', 'htd-name');
    const noteOne = el('div', 'htd-note');
    labelOne.append(amountOne, nameOne, noteOne);
    place(labelOne, boxes.labelOne);
    noteOne.hidden = !boxes.noteInLabel;

    const labelTwo = el('div', 'htd-label is-two');
    const amountTwo = el('div', 'htd-amount');
    const nameTwo = el('div', 'htd-name');
    labelTwo.append(amountTwo, nameTwo);
    labelTwo.style.top = `${boxes.labelTwo.top}px`;

    let noteFull = null;
    if (boxes.noteFull) {
      noteFull = el('div', 'htd-note-full');
      place(noteFull, boxes.noteFull);
    }

    // The year.
    const rule = el('div', 'htd-rule');
    place(rule, boxes.rule);

    const freed = el('div', 'htd-freed');
    const freedValue = el('span', 'htd-freed-value');
    const freedWord = el('span', 'htd-freed-word');
    freed.append(freedValue, freedWord);
    place(freed, { left: boxes.freed.left, top: boxes.freed.top });
    if (boxes.freed.font) {
      freedValue.style.fontSize = `${boxes.freed.font}px`;
      freedValue.style.lineHeight = `${Math.round(boxes.freed.font * 1.15)}px`;
    }

    const track = el('div', 'htd-track');
    place(track, boxes.track);
    const trackRepaid = el('div', 'htd-track-repaid');
    const trackFreed = el('div', 'htd-track-freed');
    [trackRepaid, trackFreed].forEach((node) => {
      node.style.top = '0px';
      node.style.height = `${boxes.track.height}px`;
    });
    trackRepaid.style.left = '0px';
    track.append(trackRepaid, trackFreed);

    const rowRepaid = el('div', 'htd-row is-repaid');
    const rowRepaidName = el('span', 'htd-row-name');
    const rowRepaidValue = el('span', 'htd-row-value');
    rowRepaid.append(rowRepaidName, rowRepaidValue);
    place(rowRepaid, boxes.rowRepaid);
    // Compact rows hold two lines, so they keep the line height of their words.
    if (!layout.compact) rowRepaid.style.lineHeight = `${boxes.rowRepaid.height}px`;

    const rowFreed = el('div', 'htd-row is-freed');
    const rowFreedName = el('span', 'htd-row-name');
    const rowFreedValue = el('span', 'htd-row-value');
    rowFreed.append(rowFreedName, rowFreedValue);
    place(rowFreed, boxes.rowFreed);
    if (!layout.compact) rowFreed.style.lineHeight = `${boxes.rowFreed.height}px`;

    const trackNote = el('div', 'htd-track-note');
    place(trackNote, boxes.trackNote);

    chartHost.append(
      figure, todayLine, todayLabel, blockOne, blockTwo, labelOne, labelTwo,
      ...(noteFull ? [noteFull] : []),
      rule, freed, track, rowRepaid, rowFreed, trackNote
    );

    chart = {
      figureValue,
      figureWord,
      todayName,
      todayValue,
      blockOne,
      blockTwo,
      amountOne,
      nameOne,
      noteOne,
      labelTwo,
      amountTwo,
      nameTwo,
      noteFull,
      freedValue,
      freedWord,
      trackRepaid,
      trackFreed,
      rowRepaidName,
      rowRepaidValue,
      rowFreedName,
      rowFreedValue,
      trackNote,
      constants: k
    };
  }

  /** Draw the marks at `values`. Everything that moves is painted here. */
  function paintValues(values) {
    shown = values;
    const [blockOneWidth, blockTwoLeft, blockTwoWidth, labelTwoLeft, repaidWidth, freedLeft, freedWidth] = values;
    chart.blockOne.style.width = px(blockOneWidth);
    chart.blockTwo.style.left = px(blockTwoLeft);
    chart.blockTwo.style.width = px(blockTwoWidth);
    chart.labelTwo.style.left = px(labelTwoLeft);
    // What is left of the chart, so the label wraps inside it and never past it.
    chart.labelTwo.style.width = px(
      Math.max(0, Math.min(layout.boxes.labelTwo.width, layout.chartWidth - labelTwoLeft))
    );
    chart.trackRepaid.style.width = px(repaidWidth);
    chart.trackFreed.style.left = px(freedLeft);
    chart.trackFreed.style.width = px(freedWidth);
  }

  /** The words and the states that change on a click. Never on the clock. */
  function renderCopy() {
    copy = buildTradeDownCopy(projection, selectedId);

    setText(title, copy.heading);
    setText(headline, copy.headline);
    setText(footnote, copy.footnote);
    chartHost.setAttribute('aria-label', copy.chartLabel);
    if (group) group.setAttribute('aria-label', copy.groupLabel);

    buttons.forEach((button, index) => {
      const spec = copy.buttons[index];
      const active = spec.id === selectedId;
      setText(button.firstChild, spec.title);
      setText(button.lastChild, spec.subLine);
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    if (!chart) return;
    setText(chart.figureValue, copy.figure.value);
    setText(chart.figureWord, copy.figure.word);
    setText(chart.todayName, copy.today.label);
    setText(chart.todayValue, copy.today.value);
    setText(chart.amountOne, copy.block1.amount);
    setText(chart.nameOne, copy.block1.name);
    setText(chart.noteOne, copy.block1.note);
    if (chart.noteFull) setText(chart.noteFull, copy.block1.note);
    setText(chart.amountTwo, copy.block2.amount);
    setText(chart.nameTwo, copy.block2.name);
    setText(chart.freedValue, copy.freed.value);
    setText(chart.freedWord, copy.freed.word);
    setText(chart.rowRepaidName, copy.rows.repaid.name);
    setText(chart.rowRepaidValue, copy.rows.repaid.value);
    setText(chart.rowFreedName, copy.rows.freed.name);
    setText(chart.rowFreedValue, copy.rows.freed.value);
    setText(chart.trackNote, copy.trackNote);
  }

  function relayout() {
    const width = measure();
    measuredWidth = width;
    layout = layoutTradeDownChart(projection, { width });
    clock.stop();
    buildChart();
    renderCopy();
    // Resizing is not a transition: settle on the selected case at once.
    paintValues(layout.values[selectedId]);
  }

  /* ---------------------------------------------------------- the clock */

  const clock = createTradeDownClock({
    requestFrame: (fn) => requestAnimationFrame(fn),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle),
    isAlive: () => root.isConnected
  });

  function selectCase(id) {
    if (id === selectedId || !cases.some((entry) => entry.id === id)) return;

    // From what is on screen right now, so a click mid-travel carries on from
    // where the blocks are and does not jump back to where they started.
    const from = shown;
    selectedId = id;
    const to = layout.values[id];

    // Every WORD changes in the same frame as the click: the sentence, the
    // figure, the labels and the buttons. They are not counted up.
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
      throw new Error(`Unknown home trade down scenario: ${id}`);
    }
    selectCase(id);
    await new Promise((resolve) => {
      window.setTimeout(resolve, isReducedMotion() ? 0 : CLICK_MS + SETTLE_GRACE_MS);
    });
  };

  /** What a check can read back: the case on screen and the values drawn. */
  root.tradeDownState = () => ({ selectedId, values: shown, layout });

  root.destroyHomeTradeDown = () => {
    clock.stop();
    if (observer) observer.disconnect();
  };

  return root;
}
