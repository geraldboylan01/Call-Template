/**
 * THE FUTURE COST FUND.
 *
 * One module, shown on a shared screen during a live call, answering one
 * question: a known cost is coming, what does it take to have the money ready,
 * and what are the ways to get there? The adviser clicks between up to four
 * ways while narrating; the same screen is re-opened later by the client alone,
 * so nothing here depends on spoken context.
 *
 * THE PICTURE. The fund over the years. It rises as money goes in, peaks when
 * the cost starts, and the cost then takes it out in labelled blocks. EVERY WAY
 * ARRIVES AT THE SAME PLACE, so the cost on the right never moves when the case
 * changes. Only the path to it does, and that path is the one thing that
 * travels when a case is clicked.
 *
 * WHAT LIVES WHERE. This file draws. Everything the screen decides that is not
 * a DOM node -- the words, the geometry, where each label sits -- is in
 * `js/future_cost_fund_view.js`, where a check can ask it without a browser.
 * Every amount comes from `js/future_cost_fund_math.js`.
 *
 * It follows `js/repayment_case_module.js`: the same 520ms clock, the same
 * settling discipline, the same shape of `build...Module(...)`, and the same
 * `presenterSelectScenario` for the presenter.
 */

import { computeFutureCostFundProjection } from './future_cost_fund_math.js';
import {
  buildFundCopy,
  buildFundPaths,
  layoutCostBlocks,
  layoutFutureCostChart,
  lerpValues,
  placeFundLabels,
  placePanelHeader
} from './future_cost_fund_view.js';

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
 * and not after any sequence of clicks. Four things are needed for that, and the
 * repayment module learned each of them the hard way:
 *
 *  1. progress is clamped to 0-1 and timed from the FIRST FRAME, not from a
 *     clock read at click time, so the first frame cannot come out negative;
 *  2. a new run cancels the one in flight, and every loop is guarded by a
 *     monotonic token, so two overlapping loops cannot leave the line on one
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
export function createFundClock({
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

function svgEl(tag, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  return node;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

/* ---------------------------------------------------------------- the module */

/**
 * @param {object} options
 * @param {object} options.rawInputs        the payload's futureCostFundInputs
 * @param {object} [options.projectionOptions] passed straight to the engine
 *   (tests inject assumptions here; a payload cannot reach it)
 * @param {string} [options.selectedCaseId] the case to open on
 * @param {Function} [options.onSelectCase] told when the client picks a case
 * @param {number} [options.widthHint]      the width to lay out at before it is attached
 * @returns {HTMLElement|null} null when the payload cannot be projected
 */
export function buildFutureCostFundModule({
  rawInputs,
  projectionOptions = {},
  selectedCaseId = null,
  onSelectCase = null,
  widthHint = null
} = {}) {
  let projection;
  try {
    projection = computeFutureCostFundProjection(rawInputs, projectionOptions);
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

  const root = el('section', 'fcf');
  root.dataset.generatedCard = 'future-cost-fund';
  root.setAttribute('aria-label', `${projection.debug.inputs.costTitle}: ways to have the money ready`);

  /* ----------------------------------------------------------------- head */

  const head = el('header', 'fcf-head');
  const title = el('h2', 'fcf-title');
  const subtitle = el('p', 'fcf-subtitle');
  head.append(title, subtitle);
  root.append(head);

  /* ----------------------------------------------------------- the cases */

  let buttons = [];
  if (cases.length > 1) {
    const group = el('div', 'fcf-cases');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Ways to have the money ready');
    buttons = cases.map((entry) => {
      const button = el('button', 'fcf-case');
      button.type = 'button';
      button.dataset.caseId = entry.id;
      button.append(el('span', 'fcf-case-name'), el('span', 'fcf-case-amount'));
      button.addEventListener('click', () => selectCase(entry.id));
      group.append(button);
      return button;
    });
    root.append(group);
  }

  /* --------------------------------------------------------- the answer */

  const headline = el('h3', 'fcf-headline');
  // The answer changes on a click, so it is announced.
  headline.setAttribute('aria-live', 'polite');
  const support = el('p', 'fcf-support');
  root.append(headline, support);

  /* ------------------------------------------------------------ the chart */

  const chartHost = el('div', 'fcf-chart');
  chartHost.setAttribute('role', 'img');
  root.append(chartHost);

  const coveredLine = el('p', 'fcf-covered');
  const coveredDot = el('span', 'fcf-dot');
  coveredDot.setAttribute('aria-hidden', 'true');
  const coveredText = el('span');
  coveredLine.append(coveredDot, coveredText);
  const byYear = el('p', 'fcf-by-year');
  root.append(coveredLine, byYear);

  const footnote = el('p', 'fcf-footnote');
  root.append(footnote);

  /* ------------------------------------------------------------- layout */

  function measure() {
    const fromChart = chartHost.clientWidth;
    const fromRoot = root.clientWidth;
    return Math.round(fromChart || fromRoot || widthHint || DEFAULT_WIDTH);
  }

  /** Build the drawing's elements for the current layout. Static until resized. */
  function buildChart() {
    chartHost.replaceChildren();
    const k = layout.constants;

    chartHost.style.height = `${layout.height}px`;
    chartHost.classList.toggle('is-narrow', layout.narrow);

    const panel = el('div', 'fcf-panel');
    panel.style.left = `${layout.panel.left}px`;
    panel.style.width = `${layout.panel.width}px`;
    panel.style.height = `${layout.panel.height}px`;

    const svg = svgEl('svg', {
      width: layout.width,
      height: layout.plotHeight,
      viewBox: `0 0 ${layout.width} ${layout.plotHeight}`,
      'aria-hidden': 'true',
      focusable: 'false'
    });
    svg.classList.add('fcf-svg');
    layout.grid.forEach((line) => {
      svg.append(svgEl('line', {
        x1: k.gutter,
        x2: layout.width,
        y1: line.y.toFixed(1),
        y2: line.y.toFixed(1),
        class: line.baseline ? 'fcf-base' : 'fcf-grid'
      }));
    });
    const area = svgEl('path', { class: 'fcf-area' });
    const line = svgEl('path', { class: 'fcf-line' });
    svg.append(area, line);

    chartHost.append(panel, svg);

    // The gridline amounts: in the gutter, centred on their line, on a wide
    // screen; just above their line, inside the plot, on a phone.
    layout.grid.forEach((entry) => {
      const label = el('div', 'fcf-grid-label', entry.text);
      if (layout.narrow) {
        label.style.left = '12px';
        label.style.top = `${entry.y - 17}px`;
      } else {
        label.style.left = '0px';
        label.style.width = `${k.gutter - 12}px`;
        label.style.textAlign = 'right';
        label.style.top = `${entry.y - 11}px`;
      }
      chartHost.append(label);
    });

    // The cost blocks. One per cost year, hanging from that year's balance.
    const blocks = projection.debug.costYears.map(() => {
      const block = el('div', 'fcf-block');
      chartHost.append(block);
      return block;
    });

    // The panel header, in the panel when it fits and in a row above when not.
    const header = el('div', 'fcf-panel-head');
    const headerTitle = el('div', 'fcf-panel-title');
    const headerAmount = el('div', 'fcf-panel-amount');
    const headerCovered = el('div', 'fcf-panel-covered');
    const headerDot = el('span', 'fcf-dot');
    headerDot.setAttribute('aria-hidden', 'true');
    const headerCoveredText = el('span');
    headerCovered.append(headerDot, headerCoveredText);
    header.append(headerTitle, headerAmount, headerCovered);
    chartHost.append(header);

    const labelNodes = {
      lump: el('div', 'fcf-label'),
      yearly: el('div', 'fcf-label'),
      gap: el('div', 'fcf-label fcf-label-muted'),
      fund: el('div', 'fcf-label fcf-label-fund')
    };
    Object.values(labelNodes).forEach((node) => {
      node.hidden = true;
      chartHost.append(node);
    });

    // The axis: a tick at every boundary, a name where the label step allows.
    const nameAt = new Map(layout.axisLabels.map((entry) => [entry.year, entry]));
    for (let year = 0; year < layout.columns; year += 1) {
      const tick = el('div', 'fcf-tick');
      tick.style.left = `${layout.xAt(year).toFixed(1)}px`;
      tick.style.top = `${layout.plotHeight}px`;
      chartHost.append(tick);
      const named = nameAt.get(year);
      if (named) {
        const label = el('div', `fcf-axis-label${named.emphasised ? ' is-cost' : ''}`, named.text);
        label.style.left = `${named.x.toFixed(1)}px`;
        label.style.top = `${layout.plotHeight + (layout.narrow ? 8 : 12)}px`;
        if (year === 0 && layout.narrow) label.classList.add('is-first');
        chartHost.append(label);
      }
    }

    chart = {
      area, line, blocks, header, headerTitle, headerAmount, headerCoveredText, labelNodes
    };
  }

  /** The blocks do not move between solved cases; this still reads the case's own. */
  function placeBlocks() {
    const placed = layoutCostBlocks(layout, selectedId, projection);
    placed.forEach((spec, index) => {
      const node = chart.blocks[index];
      node.style.left = `${spec.left.toFixed(1)}px`;
      node.style.top = `${spec.top.toFixed(1)}px`;
      node.style.width = `${spec.width.toFixed(1)}px`;
      node.style.height = `${spec.height.toFixed(1)}px`;
      setText(node, spec.text);
    });
  }

  function placeHeader() {
    const spot = placePanelHeader(layout, copy);
    const { header } = chart;
    header.style.left = `${spot.left}px`;
    header.style.top = `${spot.top}px`;
    header.style.width = `${spot.width}px`;
    header.classList.toggle('is-above', spot.placement === 'above');
    chartHost.classList.toggle('has-header-row', spot.placement === 'above');
    setText(chart.headerTitle, copy.panel.title);
    // The amount is its own line only on a phone, where the title is short.
    setText(chart.headerAmount, layout.narrow ? copy.panel.amount : '');
    chart.headerAmount.hidden = !layout.narrow;
    setText(chart.headerCoveredText, copy.panel.covered);
  }

  function setLabel(node, box, align) {
    if (!box) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    setText(node, box.text);
    node.style.top = `${box.top.toFixed(1)}px`;
    if (align === 'right') {
      node.style.left = 'auto';
      node.style.right = `${(layout.width - box.right).toFixed(1)}px`;
      node.style.textAlign = 'right';
    } else {
      node.style.right = 'auto';
      node.style.left = `${box.left.toFixed(1)}px`;
      node.style.textAlign = 'left';
    }
    node.style.width = layout.narrow && (node === chart.labelNodes.gap || node === chart.labelNodes.fund)
      ? `${box.width}px`
      : 'auto';
  }

  /** Draw the fund at `values`. Everything that moves is painted here. */
  function paintValues(values) {
    shown = values;
    const paths = buildFundPaths(layout, values);
    chart.area.setAttribute('d', paths.area);
    chart.line.setAttribute('d', paths.line);

    const labels = placeFundLabels(layout, selectedId, values, copy);
    setLabel(chart.labelNodes.lump, labels.lump, 'left');
    setLabel(chart.labelNodes.yearly, labels.yearly, 'right');
    setLabel(chart.labelNodes.gap, labels.gap, 'left');
    setLabel(chart.labelNodes.fund, labels.fund, 'left');
  }

  /** The words and the states that change on a click. Never on the clock. */
  function renderCopy() {
    copy = buildFundCopy(projection, selectedId, { narrow: layout.narrow });

    setText(title, copy.heading);
    setText(subtitle, copy.subtitle);
    setText(headline, copy.headline);
    setText(support, copy.support);
    setText(footnote, copy.footnote);
    chartHost.setAttribute('aria-label', copy.chartLabel);

    buttons.forEach((button, index) => {
      const spec = copy.buttons[index];
      const active = spec.id === selectedId;
      setText(button.firstChild, spec.title);
      setText(button.lastChild, spec.amountLine);
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    // On a phone the full "Covered by your fund" and the yearly amounts sit
    // under the chart, because the cost panel is too narrow to hold them.
    coveredLine.hidden = !layout.narrow;
    byYear.hidden = !layout.narrow;
    setText(coveredText, copy.panel.coveredFull);
    setText(byYear, copy.costByYear);
  }

  function relayout() {
    const width = measure();
    measuredWidth = width;
    layout = layoutFutureCostChart(projection, { width });
    clock.stop();
    buildChart();
    renderCopy();
    placeBlocks();
    placeHeader();
    // Resizing is not a transition: settle on the selected case at once.
    paintValues(layout.values[selectedId]);
  }

  /* ---------------------------------------------------------- the clock */

  const clock = createFundClock({
    requestFrame: (fn) => requestAnimationFrame(fn),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle),
    isAlive: () => root.isConnected
  });

  function selectCase(id) {
    if (id === selectedId || !cases.some((entry) => entry.id === id)) return;

    // From what is on screen right now, so a click mid-travel carries on from
    // where the line is and does not jump back to where it started.
    const from = shown;
    selectedId = id;
    const to = layout.values[id];

    // Every WORD changes in the same frame as the click: the headline, the
    // support line, the labels and the buttons. They are not counted up,
    // because the headline changes shape between cases.
    renderCopy();
    placeBlocks();

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
      const width = Math.round(chartHost.clientWidth || root.clientWidth || 0);
      if (width > 0 && Math.abs(width - measuredWidth) >= 1) {
        relayout();
      }
    });
    observer.observe(root);
  }

  root.presenterSelectScenario = async (id) => {
    if (!cases.some((entry) => entry.id === id)) {
      throw new Error(`Unknown future cost fund scenario: ${id}`);
    }
    selectCase(id);
    await new Promise((resolve) => {
      window.setTimeout(resolve, isReducedMotion() ? 0 : CLICK_MS + SETTLE_GRACE_MS);
    });
  };

  /** What a check can read back: the case on screen and the values drawn. */
  root.fundState = () => ({ selectedId, values: shown, layout });

  root.destroyFutureCostFund = () => {
    clock.stop();
    if (observer) observer.disconnect();
  };

  return root;
}
