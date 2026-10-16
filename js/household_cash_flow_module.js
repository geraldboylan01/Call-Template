/**
 * THE HOUSEHOLD CASH FLOW.
 *
 * One module, shown on a shared screen during a live call, answering one
 * question: after everything you pay, what is left each year, and what would
 * change it? The adviser clicks between up to four cases while narrating; the
 * same screen is re-opened later by the client alone, so nothing here depends on
 * spoken context.
 *
 * THE PICTURE. A year of income being used up, and the size of what remains.
 * On a wide screen it is a staircase: income is a tall block, each cost steps
 * down from it, and what is left stands on the floor. On a phone it is a single
 * bar spent from the top down. Both are drawn from one model, on one scale in
 * every case, so only the marks that change travel when a case is clicked.
 *
 * WHAT LIVES WHERE. This file draws. Everything the screen decides that is not a
 * DOM node (the words, which drawing the width allows, the geometry, where each
 * label sits) is in `js/household_cash_flow_view.js`, where a check can ask it
 * without a browser. Every amount comes from `js/household_cash_flow_math.js`.
 *
 * It follows `js/repayment_case_module.js` and `js/future_cost_fund_module.js`:
 * the same 520ms clock, the same settling discipline, the same shape of
 * `build...Module(...)`, and the same `presenterSelectScenario` for the
 * presenter. The clock is copied here, not shared: a shared one is a refactor of
 * every module and belongs in its own change.
 */

import { computeHouseholdCashFlowProjection } from './household_cash_flow_math.js';
import {
  barGeometry,
  barRowSpecs,
  buildCashFlowCopy,
  chooseDrawing,
  layoutBar,
  layoutStairs,
  lerpValues,
  placeBarRows,
  readCashFlowModel,
  stairsGeometry,
  stairsOutlines
} from './household_cash_flow_view.js';

/* ------------------------------------------------------------------ motion */

/** The one clock. Long enough to follow, short enough to feel like a click. */
export const CLICK_MS = 520;

/** Timers fire in throttled tabs where animation frames do not. */
export const SETTLE_GRACE_MS = 120;

/** The width to lay out at before the module is attached and can be measured. */
const DEFAULT_WIDTH = 1728;

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
 *     monotonic token, so two overlapping loops cannot leave the marks on one
 *     case and the words on another;
 *  3. a settle timer forces the end state, because frames stop entirely in a
 *     backgrounded tab and the picture would otherwise sit half way;
 *  4. a frame that arrives AFTER the settle timer must not restart the run: the
 *     `finished` flag is checked before anything is painted.
 *
 * It takes its timers as arguments so a check can drive it with fake ones.
 */
export function createCashFlowClock({
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
  return `${Number(value).toFixed(1)}px`;
}

/**
 * The last mark is green while what is left is above nothing and red once it is
 * below, decided by the figure being DRAWN and not the case being chosen, so a
 * click that crosses the floor changes colour where the mark crosses it.
 */
function markShort(node, values) {
  node.classList.toggle('is-short', Boolean(values) && values[values.length - 1] < 0);
}

/* ---------------------------------------------------------------- the module */

/**
 * @param {object} options
 * @param {object} options.rawInputs        the payload's householdCashFlowInputs
 * @param {object} [options.projectionOptions] passed straight to the engine
 *   (tests inject the design fixture here; a payload cannot reach it)
 * @param {string} [options.selectedCaseId] the case to open on
 * @param {Function} [options.onSelectCase] told when the client picks a case
 * @param {number} [options.widthHint]      the width to lay out at before it is attached
 * @returns {HTMLElement|null} null when the payload cannot be projected or drawn
 */
export function buildHouseholdCashFlowModule({
  rawInputs,
  projectionOptions = {},
  selectedCaseId = null,
  onSelectCase = null,
  widthHint = null
} = {}) {
  let projection;
  let model;
  try {
    projection = computeHouseholdCashFlowProjection(rawInputs, projectionOptions);
    model = readCashFlowModel(projection);
  } catch (_error) {
    return null;
  }

  const cases = model.cases;
  if (cases.length === 0) return null;

  // THE MODULE OPENS ON THE BASE CASE unless it was told which case the client
  // was last on, and a remembered case the payload no longer has is ignored.
  let selectedId = cases.some((entry) => entry.id === selectedCaseId) ? selectedCaseId : model.baseId;
  const valuesOf = (id) => cases.find((entry) => entry.id === id).values;

  let drawing = null;
  let layout = null;
  let copy = null;
  let shown = null;
  let refs = null;
  let observer = null;
  let measuredWidth = 0;

  const root = el('section', 'hcf');
  root.dataset.generatedCard = 'household-cash-flow';
  root.setAttribute('aria-label', 'Your household cash flow');

  /* ----------------------------------------------------------------- head */

  const head = el('header', 'hcf-head');
  const mutedLine = el('p', 'hcf-muted');
  const heading = el('h2', 'hcf-heading');
  head.append(mutedLine, heading);

  /* ----------------------------------------------------------- the cases */

  let buttons = [];
  let group = null;
  if (cases.length > 1) {
    group = el('div', 'hcf-cases');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'What would change it');
    buttons = cases.map((entry) => {
      const button = el('button', 'hcf-case');
      button.type = 'button';
      button.dataset.caseId = entry.id;
      button.addEventListener('click', () => selectCase(entry.id));
      group.append(button);
      return button;
    });
  }

  /* --------------------------------------------------------- the answer */

  const answer = el('div', 'hcf-answer');
  const answerStatus = el('div', 'hcf-status');
  const swatch = el('span', 'hcf-swatch');
  swatch.setAttribute('aria-hidden', 'true');
  const statusWord = el('span', 'hcf-status-word');
  answerStatus.append(swatch, statusWord);
  const figure = el('div', 'hcf-figure');
  const unit = el('div', 'hcf-unit');
  const monthly = el('div', 'hcf-monthly');
  answer.append(answerStatus, figure, unit, monthly);

  const sentence = el('p', 'hcf-sentence');
  // The sentence changes on a click, so it is announced.
  sentence.setAttribute('aria-live', 'polite');

  const chartHost = el('div', 'hcf-chart');
  chartHost.setAttribute('role', 'img');

  // A zero-height strip as wide as the module's content box. The width the
  // module decides on is THIS, and not the chart's, because beside the answer
  // the chart is only part of the content and the choice between the two
  // drawings is made on the whole.
  const probe = el('div', 'hcf-probe');
  probe.setAttribute('aria-hidden', 'true');

  const stage = el('div', 'hcf-stage');
  const footnote = el('p', 'hcf-footnote');

  /* ------------------------------------------------------------- layout */

  function measure() {
    return Math.round(probe.clientWidth || widthHint || DEFAULT_WIDTH);
  }

  /** Put the parts in the order this drawing wants them. */
  function arrange() {
    const parts = [probe, head];
    if (group) parts.push(group);
    if (drawing === 'stairs' && layout.answer.placement === 'beside') {
      stage.replaceChildren(chartHost, answer);
      stage.classList.add('is-beside');
      parts.push(stage, sentence);
    } else if (drawing === 'stairs') {
      stage.classList.remove('is-beside');
      parts.push(answer, chartHost, sentence);
    } else {
      stage.classList.remove('is-beside');
      parts.push(answer, sentence, chartHost);
    }
    parts.push(footnote);
    root.replaceChildren(...parts);
    root.classList.toggle('is-stairs', drawing === 'stairs');
    root.classList.toggle('is-bar', drawing === 'bar');
    root.classList.toggle('is-compact', drawing === 'bar' && layout.compact);
  }

  /* ----------------------------------------------------------- staircase */

  function buildStairs() {
    chartHost.replaceChildren();
    chartHost.style.height = px(layout.height);
    chartHost.style.width = px(layout.plotWidth);
    const found = {
      bars: [], connectors: [], outlines: [], amounts: [], names: [], deltas: []
    };

    // With a case that runs below it, the floor is the line the picture reads
    // against, so it is drawn a little stronger and named "€0".
    const floor = el('div', layout.band > 0 ? 'hcf-floor has-band' : 'hcf-floor');
    floor.style.top = px(layout.floor);
    floor.style.left = '0px';
    floor.style.width = px(layout.plotWidth);
    chartHost.append(floor);
    if (layout.zero.visible) {
      const zero = el('div', 'hcf-zero', '€0');
      zero.style.left = px(layout.zero.left);
      zero.style.top = px(layout.zero.top);
      zero.style.width = px(layout.zero.width);
      zero.style.fontSize = px(layout.fonts.zero);
      chartHost.append(zero);
    }

    for (let index = 0; index < layout.columns - 1; index += 1) {
      const connector = el('div', 'hcf-connector');
      connector.style.left = px(layout.slots[index].left + layout.barWidth);
      connector.style.width = px(layout.pitch - layout.barWidth);
      chartHost.append(connector);
      found.connectors.push(connector);
    }

    for (let index = 0; index < layout.columns; index += 1) {
      const bar = el('div', 'hcf-bar');
      bar.style.left = px(layout.slots[index].left);
      bar.style.width = px(layout.barWidth);
      chartHost.append(bar);
      found.bars.push(bar);
    }

    for (let index = 0; index < layout.columns - 1; index += 1) {
      const outline = el('div', 'hcf-outline');
      outline.style.left = px(layout.slots[index + 1].left);
      outline.style.width = px(layout.barWidth);
      outline.hidden = true;
      chartHost.append(outline);
      found.outlines.push(outline);
    }

    for (let index = 0; index < layout.columns - 1; index += 1) {
      const amount = el('div', 'hcf-amount');
      amount.style.left = px(layout.slots[index].slotLeft);
      amount.style.width = px(layout.pitch);
      amount.style.fontSize = px(layout.fonts.amount);
      chartHost.append(amount);
      found.amounts.push(amount);
    }

    for (let index = 0; index < layout.columns; index += 1) {
      const name = el('div', 'hcf-name');
      name.style.left = px(layout.slots[index].slotLeft);
      name.style.top = px(layout.namesTop);
      name.style.width = px(layout.pitch);
      const label = el('div', 'hcf-name-label');
      label.style.fontSize = px(layout.fonts.name);
      const delta = el('div', 'hcf-name-delta');
      delta.style.fontSize = px(layout.fonts.delta);
      delta.hidden = true;
      name.append(label, delta);
      chartHost.append(name);
      found.names.push(name);
      found.deltas.push(delta);
    }

    const key = el('div', 'hcf-key');
    key.style.left = px(layout.key.left);
    key.style.top = px(layout.key.top);
    const keySwatch = el('span', 'hcf-key-swatch');
    keySwatch.setAttribute('aria-hidden', 'true');
    const keyWord = el('span', 'hcf-key-word', 'Today');
    keyWord.style.fontSize = px(layout.fonts.key);
    key.append(keySwatch, keyWord);
    key.hidden = true;
    chartHost.append(key);

    const lastLabel = el('div', 'hcf-last-label');
    lastLabel.style.width = px(layout.pitch);
    lastLabel.style.fontSize = px(layout.fonts.ghost);
    lastLabel.hidden = true;
    chartHost.append(lastLabel);

    const endMark = el('div', 'hcf-end-mark');
    endMark.style.left = px(layout.slots[layout.columns - 1].left);
    endMark.style.width = px(layout.barWidth);
    endMark.style.top = px(layout.floor - 3);
    chartHost.append(endMark);

    refs = { ...found, key, lastLabel, endMark };
  }

  function renderStairsCopy() {
    const outlines = stairsOutlines(layout, model, selectedId);
    const incomeName = copy.incomeLabel;

    setText(refs.amounts[0], copy.incomeAmount);
    copy.lines.forEach((line, index) => {
      const amount = refs.amounts[index + 1];
      setText(amount, line.amount);
      amount.classList.toggle('is-quiet', line.quiet);
    });

    refs.names.forEach((name, index) => {
      const label = name.firstChild;
      if (index === 0) {
        setText(label, incomeName);
        refs.deltas[index].hidden = true;
        name.classList.remove('is-quiet');
      } else if (index <= copy.lines.length) {
        const line = copy.lines[index - 1];
        setText(label, line.label);
        setText(refs.deltas[index], line.delta);
        refs.deltas[index].hidden = !line.hasDelta;
        name.classList.toggle('is-quiet', line.quiet);
      } else {
        setText(label, copy.lastName);
        refs.deltas[index].hidden = true;
        name.classList.remove('is-quiet');
      }
    });

    // Today's outlines: only where an amount changed, and the last column.
    outlines.outlines.forEach((outline, index) => {
      const node = refs.outlines[index];
      node.hidden = !outline.visible;
      node.style.top = px(outline.top);
      node.style.height = px(outline.height);
    });
    refs.key.hidden = !outlines.keyVisible;
    refs.lastLabel.hidden = !outlines.lastLabel.visible;
    refs.lastLabel.style.left = px(outlines.lastLabel.left);
    refs.lastLabel.replaceChildren(...outlines.lastLabel.lines.map((text, index) => (
      el('div', index === 0 ? 'hcf-last-label-today' : 'hcf-last-label-figure', text)
    )));
    refs.outlineInfo = outlines;

    // The bars that changed against today are marked in words by their delta
    // line and in colour here.
    const lines = copy.lines;
    refs.bars.forEach((bar, index) => {
      const isIncome = index === 0;
      const isLast = index === refs.bars.length - 1;
      const changed = !isIncome && !isLast && lines[index - 1].hasDelta;
      bar.className = `hcf-bar ${isIncome ? 'is-income' : (isLast ? 'is-left' : 'is-cost')}${changed ? ' is-changed' : ''}`;
      // What was on screen stays on screen until the clock moves it.
      if (isLast) markShort(bar, shown);
    });
  }

  function paintStairs(values) {
    const geometry = stairsGeometry(layout, values);
    geometry.bars.forEach((bar, index) => {
      refs.bars[index].style.top = px(bar.top);
      refs.bars[index].style.height = px(bar.height);
    });
    geometry.connectors.forEach((connector, index) => {
      refs.connectors[index].style.top = px(connector.top);
    });
    geometry.amounts.forEach((amount, index) => {
      refs.amounts[index].style.top = px(amount.top);
    });
    const leftNow = values[values.length - 1];
    markShort(refs.bars[refs.bars.length - 1], values);
    refs.lastLabel.style.top = px(refs.outlineInfo.lastLabel.topFor(leftNow));
    // Nothing left stands as a line on the floor, not as a bar.
    const target = valuesOf(selectedId);
    refs.endMark.style.opacity = target[target.length - 1] === 0 ? String(clamp(1 - leftNow / 900, 0, 1)) : '0';
  }

  /* ------------------------------------------------------------------ bar */

  function buildBar() {
    chartHost.replaceChildren();
    chartHost.style.height = px(layout.height);
    chartHost.style.width = '100%';
    const found = { segments: [], ticks: [], rows: new Map() };
    const left = layout.offsetLeft;

    const barHead = el('div', 'hcf-bar-head');
    barHead.style.left = px(left);
    barHead.style.width = px(layout.contentWidth);
    const headLabel = el('span', 'hcf-bar-head-label');
    const headAmount = el('span', 'hcf-bar-head-amount');
    barHead.append(headLabel, headAmount);
    const rule = el('div', 'hcf-bar-rule');
    rule.style.top = px(layout.headerRule);
    rule.style.left = px(left);
    rule.style.width = px(layout.contentWidth);
    chartHost.append(barHead, rule);

    const track = el('div', 'hcf-track');
    track.style.left = px(left);
    track.style.top = px(layout.barTop);
    track.style.width = px(layout.barWidth);
    track.style.height = px(layout.barHeight + layout.reserve);
    for (let index = 0; index < model.drawnLines.length + 1; index += 1) {
      const segment = el('div', 'hcf-segment');
      segment.style.width = px(layout.barWidth);
      track.append(segment);
      found.segments.push(segment);
    }
    model.drawnLines.forEach(() => {
      const tick = el('div', 'hcf-cleared-tick');
      tick.style.width = px(layout.barWidth);
      track.append(tick);
      found.ticks.push(tick);
    });
    const endMark = el('div', 'hcf-bar-end-mark');
    endMark.style.width = px(layout.barWidth);
    endMark.style.top = px(layout.barHeight - 4);
    track.append(endMark);
    chartHost.append(track);

    // Where income ends, once some case runs past it.
    if (layout.reserve > 0) {
      const incomeEnd = el('div', 'hcf-bar-income-end');
      incomeEnd.style.left = px(left - 6);
      incomeEnd.style.top = px(layout.incomeEnd);
      incomeEnd.style.width = px(layout.barWidth + 12);
      chartHost.append(incomeEnd);
    }

    const ids = [...model.drawnLines.map((line) => line.id), 'left'];
    ids.forEach((id) => {
      const row = el('div', 'hcf-row');
      row.style.left = px(left + layout.labelLeft);
      row.style.width = px(layout.labelWidth);
      const stub = el('div', 'hcf-row-stub');
      const line = el('div', 'hcf-row-line');
      const name = el('span', 'hcf-row-name');
      const leader = el('span', 'hcf-row-leader');
      const amount = el('span', 'hcf-row-amount');
      line.append(name, leader, amount);
      const delta = el('div', 'hcf-row-delta');
      row.append(stub, line, delta);
      row.hidden = true;
      chartHost.append(row);
      found.rows.set(id, { row, name, amount, delta });
    });

    refs = { ...found, headLabel, headAmount, endMark };
  }

  function renderBarCopy() {
    setText(refs.headLabel, copy.incomeLabel);
    setText(refs.headAmount, copy.incomeLine);

    const lines = copy.lines;
    refs.segments.forEach((segment, index) => {
      const isLast = index === refs.segments.length - 1;
      const changed = !isLast && lines[index].hasDelta;
      segment.className = `hcf-segment ${isLast ? 'is-left' : 'is-cost'}${changed ? ' is-changed' : ''}`;
      if (isLast) markShort(segment, shown);
    });

    refs.rows.forEach((parts, id) => {
      const line = lines.find((entry) => entry.id === id);
      if (line) {
        setText(parts.name, line.label);
        setText(parts.amount, line.amount);
        setText(parts.delta, line.delta);
        parts.delta.hidden = !line.hasDelta;
      } else {
        setText(parts.name, copy.lastName);
        setText(parts.amount, copy.figure);
        parts.delta.hidden = true;
      }
    });
  }

  function paintBar(values) {
    const geometry = barGeometry(layout, values);
    geometry.segments.forEach((segment, index) => {
      const node = refs.segments[index];
      node.style.top = px(segment.top);
      node.style.height = px(segment.height);
    });
    markShort(refs.segments[refs.segments.length - 1], values);

    // A line cleared against today is a zero-height step: a tick marks where it was.
    const base = model.cases.find((entry) => entry.id === model.baseId);
    refs.ticks.forEach((tick, index) => {
      const cleared = base.values[index] > 0 && valuesOf(selectedId)[index] === 0;
      const segment = geometry.segments[index];
      tick.style.top = px(segment.top - 1.5);
      tick.style.opacity = cleared ? String(clamp(1 - segment.raw / 10, 0, 1)) : '0';
    });
    const target = valuesOf(selectedId);
    const leftNow = values[values.length - 1];
    refs.endMark.style.opacity = target[target.length - 1] === 0 ? String(clamp(1 - leftNow / 900, 0, 1)) : '0';

    const specs = barRowSpecs(model, selectedId, values).map((spec) => ({
      ...spec,
      centre: geometry.segments[spec.segment].centre
    }));
    const placed = placeBarRows(layout, specs);
    const placedIds = new Set(placed.map((row) => row.id));
    refs.rows.forEach((parts, id) => {
      parts.row.hidden = !placedIds.has(id);
    });
    placed.forEach((row) => {
      refs.rows.get(row.id).row.style.top = px(row.top);
    });
  }

  /* --------------------------------------------------------- the words */

  function renderCopy() {
    copy = buildCashFlowCopy(projection, selectedId);

    setText(mutedLine, copy.mutedLine);
    setText(heading, copy.heading);
    setText(sentence, copy.sentence);
    setText(footnote, copy.footnote);
    setText(statusWord, copy.status.word);
    swatch.className = `hcf-swatch is-${copy.status.kind}`;
    setText(figure, copy.figure);
    setText(unit, copy.unit);
    setText(monthly, copy.monthly);
    chartHost.setAttribute('aria-label', copy.chartLabel);

    buttons.forEach((button, index) => {
      const spec = copy.buttons[index];
      const active = spec.id === selectedId;
      setText(button, spec.title);
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    if (drawing === 'stairs') renderStairsCopy();
    else renderBarCopy();
  }

  /**
   * Above the bar, the sentence keeps the room of the LONGEST case's, so a click
   * never moves the drawing under it. The sentences are the engine's, and the
   * short ones run to five lines on a phone, so the design's four is not enough.
   * Measured where the browser can measure it, which is once the module is on
   * the page; until then the stylesheet's four lines stand.
   */
  function reserveSentenceRoom() {
    if (drawing !== 'bar') {
      sentence.style.minHeight = '';
      return;
    }
    if (!root.isConnected || typeof sentence.getBoundingClientRect !== 'function') return;
    const current = sentence.textContent;
    sentence.style.minHeight = '0px';
    let tallest = 0;
    cases.forEach((entry) => {
      sentence.textContent = entry.sentence;
      tallest = Math.max(tallest, sentence.getBoundingClientRect().height);
    });
    sentence.textContent = current;
    sentence.style.minHeight = '';
    // Never less than the stylesheet's four lines.
    const four = parseFloat(getComputedStyle(sentence).lineHeight) * 4;
    sentence.style.minHeight = px(Math.max(Number.isFinite(four) ? four : 0, Math.ceil(tallest)));
  }

  function paint(values) {
    shown = values;
    if (drawing === 'stairs') paintStairs(values);
    else paintBar(values);
  }

  function relayout() {
    const width = measure();
    measuredWidth = width;
    drawing = chooseDrawing(width, drawing);
    layout = drawing === 'stairs'
      ? layoutStairs(projection, { width })
      : layoutBar(projection, { width });
    clock.stop();
    arrange();
    if (drawing === 'stairs') buildStairs();
    else buildBar();
    renderCopy();
    reserveSentenceRoom();
    // Resizing is not a transition: settle on the selected case at once.
    paint(valuesOf(selectedId));
  }

  /* ---------------------------------------------------------- the clock */

  const clock = createCashFlowClock({
    requestFrame: (fn) => requestAnimationFrame(fn),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle),
    isAlive: () => root.isConnected
  });

  function selectCase(id) {
    if (id === selectedId || !cases.some((entry) => entry.id === id)) return;

    // From what is on screen right now, so a click mid-travel carries on from
    // where the marks are and does not jump back to where they started.
    const from = shown;
    selectedId = id;
    const to = valuesOf(id);

    // Every WORD changes in the same frame as the click: the answer, the
    // sentence, the labels and the buttons. They are not counted up, because
    // the sentence changes shape between cases.
    renderCopy();

    clock.run(isReducedMotion() ? 0 : CLICK_MS, (progress) => {
      paint(lerpValues(from, to, progress));
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
      const width = Math.round(probe.clientWidth || 0);
      if (width > 0 && Math.abs(width - measuredWidth) >= 1) {
        relayout();
      }
    });
    observer.observe(root);
  }

  root.presenterSelectScenario = async (id) => {
    if (!cases.some((entry) => entry.id === id)) {
      throw new Error(`Unknown household cash flow scenario: ${id}`);
    }
    selectCase(id);
    await new Promise((resolve) => {
      window.setTimeout(resolve, isReducedMotion() ? 0 : CLICK_MS + SETTLE_GRACE_MS);
    });
  };

  /** What a check can read back: the case on screen, the values drawn and the drawing. */
  root.cashFlowState = () => ({ selectedId, values: shown, drawing, layout });

  root.destroyHouseholdCashFlow = () => {
    clock.stop();
    if (observer) observer.disconnect();
  };

  return root;
}
