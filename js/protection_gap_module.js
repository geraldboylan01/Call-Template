/**
 * THE PROTECTION GAP.
 *
 * One module, shown on a shared screen during a live call, answering one
 * question: if one income stopped, how big is the hole, and how long would
 * savings fill it? The adviser clicks between up to four cases while narrating;
 * the same screen is re-opened later by the client alone, so nothing here
 * depends on spoken context.
 *
 * THE PICTURE. Two things, one above the other. A bar of what comes in, built
 * from the State floor and each take-home, against what you need: the gap is the
 * space between the end of the bar and the need tick. Under it a strip of 36
 * months, green for as many months as savings last and red for what is short.
 * When a case is clicked, the segments, the gap and the green MOVE from their
 * old values to the new ones. Nothing else does.
 *
 * WHAT LIVES WHERE. This file draws. Everything the screen decides that is not
 * a DOM node -- the words it adds, the geometry, where each label sits -- is in
 * `js/protection_gap_view.js`, where a check can ask it without a browser. Every
 * figure and every sentence comes from `js/protection_gap_math.js`.
 *
 * It follows `js/future_cost_fund_module.js` and `js/repayment_case_module.js`:
 * the same 520ms clock, the same settling discipline, the same shape of
 * `build...Module(...)`, and the same `presenterSelectScenario`.
 */

import { computeProtectionGapProjection } from './protection_gap_math.js';
import {
  buildProtectionGapCopy,
  chooseButtonLayout,
  deriveBarGeometry,
  layoutProtectionGap,
  lerpValues,
  placeBarLabels,
  placeStripWords,
  stripAxis,
  valuesForCase
} from './protection_gap_view.js';

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
 *     monotonic token, so two overlapping loops cannot leave the bar on one
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
export function createGapClock({
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

const px = (value) => `${Math.round(value * 10) / 10}px`;

/** A label with a title line and an amount line. */
function labelNode() {
  const node = el('div', 'pg-label');
  const title = el('span', 'pg-label-title');
  const amount = el('span', 'pg-label-amount');
  node.append(title, amount);
  node.hidden = true;
  return { node, title, amount };
}

/* ---------------------------------------------------------------- the module */

/**
 * @param {object} options
 * @param {object} options.rawInputs        the payload's protectionGapInputs
 * @param {string} [options.selectedCaseId] the case to open on
 * @param {Function} [options.onSelectCase] told when the client picks a case
 * @param {number} [options.widthHint]      the width to lay out at before it is attached
 * @returns {HTMLElement|null} null when the payload cannot be projected
 */
export function buildProtectionGapModule({
  rawInputs,
  selectedCaseId = null,
  onSelectCase = null,
  widthHint = null
} = {}) {
  let projection;
  try {
    projection = computeProtectionGapProjection(rawInputs);
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
  let mode = null;
  let nodes = null;
  let observer = null;
  let measuredWidth = 0;

  const root = el('section', 'pg');
  root.dataset.generatedCard = 'protection-gap';
  root.setAttribute(
    'aria-label',
    `${projection.debug.inputs.householdLabel || 'Protection gap'}: if one income stopped`
  );

  /* ------------------------------------------------------------------ rail */

  const rail = el('div', 'pg-rail');
  const head = el('header', 'pg-head');
  const kicker = el('p', 'pg-kicker');
  const household = el('h2', 'pg-household');
  const savingsLine = el('p', 'pg-savings');
  head.append(kicker, household, savingsLine);
  rail.append(head);

  let buttons = [];
  if (cases.length > 1) {
    const group = el('div', 'pg-cases');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'What changes');
    buttons = cases.map((entry) => {
      const button = el('button', 'pg-case');
      button.type = 'button';
      button.dataset.caseId = entry.id;
      button.addEventListener('click', () => selectCase(entry.id));
      group.append(button);
      return button;
    });
    rail.append(group);
  }

  /* ------------------------------------------------------------------ main */

  const main = el('div', 'pg-main');

  const answer = el('div', 'pg-answer');
  const headline = el('h3', 'pg-headline');
  // The answer changes on a click, so it is announced.
  headline.setAttribute('aria-live', 'polite');
  const line1 = el('span', 'pg-line1');
  const status = el('span', 'pg-status');
  const line2 = el('span', 'pg-line2');
  headline.append(line1, status, line2);
  const sentence = el('p', 'pg-sentence');
  sentence.setAttribute('aria-live', 'polite');
  answer.append(headline, sentence);

  const barSection = el('section', 'pg-block');
  const barCaption = el('h4', 'pg-caption');
  const barHost = el('div', 'pg-bar');
  barHost.setAttribute('role', 'img');
  barSection.append(barCaption, barHost);

  const stripSection = el('section', 'pg-block');
  const stripCaption = el('h4', 'pg-caption');
  const stripHost = el('div', 'pg-strip');
  stripHost.setAttribute('role', 'img');
  stripSection.append(stripCaption, stripHost);

  const footnote = el('p', 'pg-footnote');

  main.append(answer, barSection, stripSection, footnote);
  root.append(rail, main);

  /* ------------------------------------------------------------- layout */

  function measure() {
    return Math.round(root.clientWidth || widthHint || DEFAULT_WIDTH);
  }

  /** Build the bar's elements for the current layout. Static until resized. */
  function buildBar() {
    barHost.replaceChildren();
    const { bar, chartWidth, k } = layout;
    barHost.style.height = px(bar.height);

    const track = el('div', 'pg-track');
    track.style.left = '0px';
    track.style.top = px(bar.barTop);
    track.style.width = px(chartWidth);
    track.style.height = px(k.barHeight);
    barHost.append(track);

    const segments = layout.slots.map((slot) => {
      const node = el('div', `pg-seg pg-seg-${slot.kind}`);
      node.dataset.slot = slot.id;
      node.style.top = px(bar.barTop);
      node.style.height = px(k.barHeight);
      const text = el('div', 'pg-seg-text');
      const first = el('span', 'pg-seg-l1');
      const second = el('span', 'pg-seg-l2');
      const amount = el('span', 'pg-seg-amount');
      text.append(first, second, amount);
      node.append(text);
      barHost.append(node);
      return { node, text, first, second, amount };
    });

    const gapBlock = el('div', 'pg-gap');
    gapBlock.style.top = px(bar.barTop);
    gapBlock.style.height = px(k.barHeight);
    barHost.append(gapBlock);

    const bracketIn = el('div', 'pg-bracket');
    bracketIn.style.top = px(bar.bracketTop);
    bracketIn.style.height = px(k.bracketHeight);
    const bracketGap = el('div', 'pg-bracket pg-bracket-gap');
    bracketGap.style.top = px(bar.bracketTop);
    bracketGap.style.height = px(k.bracketHeight);
    barHost.append(bracketIn, bracketGap);

    const tick = el('div', 'pg-need-tick');
    tick.style.top = px(bar.tickTop);
    tick.style.height = px(bar.tickBottom - bar.tickTop);
    barHost.append(tick);

    const labels = {};
    ['moneyIn', 'gap', 'need', ...layout.slots.map((slot) => `seg:${slot.id}`)].forEach((key) => {
      labels[key] = labelNode();
      labels[key].node.dataset.key = key.split(':')[0];
      barHost.append(labels[key].node);
    });

    const scaleStart = el('div', 'pg-scale pg-scale-start');
    scaleStart.style.top = px(bar.scaleTop);
    const scaleEnd = el('div', 'pg-scale pg-scale-end');
    scaleEnd.style.top = px(bar.scaleTop);
    barHost.append(scaleStart, scaleEnd);

    return { segments, gapBlock, bracketIn, bracketGap, tick, labels, scaleStart, scaleEnd };
  }

  /** Build the strip's elements for the current layout. Static until resized. */
  function buildStrip() {
    stripHost.replaceChildren();
    const { strip, chartWidth, k } = layout;
    stripHost.style.height = px(strip.height);

    const endLabel = el('div', 'pg-end');
    endLabel.style.top = '0px';
    endLabel.style.height = px(strip.endHeight);
    const endLead = el('span', 'pg-end-lead');
    const endText = el('span', 'pg-end-text');
    endLabel.append(endLead, endText);
    const endTick = el('div', 'pg-end-tick');
    endTick.style.top = px(strip.tickTop);
    endTick.style.height = px(strip.tickHeight);
    stripHost.append(endLabel, endTick);

    const track = el('div', 'pg-strip-track');
    track.style.top = px(strip.top);
    track.style.width = px(chartWidth);
    track.style.height = px(k.stripHeight);
    stripHost.append(track);

    const fill = el('div', 'pg-fill');
    fill.style.top = px(strip.top);
    fill.style.height = px(k.stripHeight);
    const short = el('div', 'pg-short');
    short.style.top = px(strip.top);
    short.style.height = px(k.stripHeight);
    stripHost.append(fill, short);

    layout.dividers.forEach((divider) => {
      const node = el('div', `pg-divider${divider.year ? ' is-year' : ''}`);
      node.style.left = px(divider.x);
      node.style.top = px(strip.top);
      node.style.height = px(k.stripHeight);
      stripHost.append(node);
    });

    const words = {};
    ['filled', 'short', 'nothing'].forEach((key) => {
      words[key] = el('div', `pg-word pg-word-${key}`);
      words[key].style.top = px(strip.top);
      words[key].style.height = px(k.stripHeight);
      words[key].hidden = true;
      stripHost.append(words[key]);
    });

    const axis = [0, 1, 2, 3].map((index) => {
      const x = [0, 12, 24, layout.months][index] * layout.cell;
      const tick = el('div', 'pg-axis-tick');
      tick.style.left = px(Math.min(x, chartWidth - 1));
      tick.style.top = px(strip.axisTickTop);
      const name = el('div', 'pg-axis-name');
      name.style.top = px(strip.axisLabelTop);
      stripHost.append(tick, name);
      return { name };
    });

    return { endLabel, endLead, endText, endTick, fill, short, words, axis };
  }

  /** The words and the states that change on a click. Never on the clock. */
  function renderCopy() {
    const entry = cases.find((candidate) => candidate.id === selectedId);
    copy = buildProtectionGapCopy(projection, selectedId, { narrow: layout.narrow });

    setText(kicker, copy.module);
    setText(household, copy.household);
    household.hidden = !copy.household;
    setText(savingsLine, copy.savingsLine);

    setText(line1, copy.headline.line1);
    setText(line2, copy.headline.line2);
    setText(status, copy.statusWord);
    status.hidden = !copy.isTight;
    setText(sentence, copy.sentence);
    setText(footnote, copy.footnote);

    setText(barCaption, copy.captions.bar);
    setText(stripCaption, copy.captions.strip);
    barHost.setAttribute('aria-label', copy.bar.ariaLabel);
    stripHost.setAttribute('aria-label', copy.strip.ariaLabel);

    buttons.forEach((button, index) => {
      const spec = copy.buttons[index];
      const active = spec.id === selectedId;
      setText(button, spec.title);
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    root.dataset.status = entry.status;
    root.classList.toggle('is-left-over', entry.status === 'left_over');
    root.classList.toggle('is-short', entry.status === 'short');
    root.classList.toggle('is-tight', entry.status === 'tight');

    nodes.bar.segments.forEach((segment, index) => {
      const spec = copy.segments[index];
      setText(segment.first, spec.lines[0] || '');
      setText(segment.second, spec.lines[1] || '');
      segment.second.hidden = !spec.lines[1];
      setText(segment.amount, spec.amountText);
    });
    setText(nodes.bar.scaleStart, copy.bar.scaleStart);
    setText(nodes.bar.scaleEnd, copy.bar.scaleEnd);

    const names = stripAxis(layout, copy);
    names.forEach((entryName, index) => {
      const target = nodes.strip.axis[index].name;
      setText(target, entryName.text);
      target.classList.toggle('is-center', entryName.align === 'center');
      target.classList.toggle('is-right', entryName.align === 'right');
      target.style.left = px(entryName.x);
    });
  }

  /** Draw the bar at `values`. Everything that moves is painted here. */
  function paintBar(values) {
    const geometry = deriveBarGeometry(layout, values);
    const { segments, gapBlock, bracketIn, bracketGap, tick, labels } = nodes.bar;

    geometry.segments.forEach((placed, index) => {
      segments[index].node.style.left = px(placed.left);
      segments[index].node.style.width = px(placed.width);
    });
    gapBlock.style.left = px(geometry.gapLeft);
    gapBlock.style.width = px(geometry.gapWidth);
    bracketIn.style.left = '0px';
    bracketIn.style.width = px(geometry.inX);
    bracketGap.style.left = px(geometry.gapLeft);
    bracketGap.style.width = px(geometry.gapWidth);
    bracketGap.hidden = !copy.bar.gap || copy.bar.gap.title !== 'Gap';
    tick.style.left = px(geometry.needX - 1);

    const plan = placeBarLabels(layout, selectedId, values, copy);
    layout.slots.forEach((slot, index) => {
      segments[index].text.hidden = plan.inside[slot.id] !== 'in';
    });
    Object.values(labels).forEach((entry) => { entry.node.hidden = true; });
    [...plan.above, ...plan.below].forEach((item) => {
      const entry = labels[item.key];
      if (!entry) return;
      entry.node.hidden = false;
      setText(entry.title, item.title);
      setText(entry.amount, item.amountText);
      entry.node.style.left = px(item.left);
      entry.node.style.top = px(item.top);
      entry.node.style.width = px(item.width);
    });
  }

  /** Draw the strip at `values`. */
  function paintStrip(values) {
    const words = placeStripWords(layout, values, copy);
    const { fill, short, endLabel, endLead, endText, endTick } = nodes.strip;

    fill.style.left = '0px';
    fill.style.width = px(words.fillWidth);
    short.style.left = px(words.fillWidth);
    short.style.width = px(words.shortWidth);

    [['filled', words.filled], ['short', words.short], ['nothing', words.nothing]].forEach(([key, spec]) => {
      const node = nodes.strip.words[key];
      node.hidden = !spec;
      if (spec) {
        setText(node, spec.text);
        node.style.left = px(spec.left);
      }
    });

    endLabel.hidden = !words.end;
    endTick.hidden = !words.end;
    if (words.end) {
      setText(endLead, words.end.lead);
      setText(endText, words.end.text);
      endLabel.style.left = px(words.end.left);
      endLabel.style.width = px(words.end.width);
      endTick.style.left = px(words.end.tickLeft);
    }
  }

  function paintValues(values) {
    shown = values;
    paintBar(values);
    paintStrip(values);
  }

  function relayout() {
    const width = measure();
    measuredWidth = width;
    mode = chooseButtonLayout(width, mode);
    layout = layoutProtectionGap(projection, { width, mode });
    clock.stop();

    root.classList.toggle('pg--rail', mode === 'rail');
    root.classList.toggle('pg--row', mode === 'row');
    root.classList.toggle('pg--grid', mode === 'grid');
    root.classList.toggle('is-narrow', layout.narrow);

    nodes = { bar: buildBar(), strip: buildStrip() };
    renderCopy();
    // Resizing is not a transition: settle on the selected case at once.
    paintValues(valuesForCase(layout, selectedId));
  }

  /* ---------------------------------------------------------- the clock */

  const clock = createGapClock({
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
    const to = valuesForCase(layout, id);

    // Every WORD changes in the same frame as the click: the answer, the
    // sentence, the labels and the buttons. They are not counted up.
    renderCopy();
    paintValues(from);

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
      throw new Error(`Unknown protection gap scenario: ${id}`);
    }
    selectCase(id);
    await new Promise((resolve) => {
      window.setTimeout(resolve, isReducedMotion() ? 0 : CLICK_MS + SETTLE_GRACE_MS);
    });
  };

  /** What a check can read back: the case on screen and the values drawn. */
  root.gapState = () => ({ selectedId, values: shown, layout, mode });

  root.destroyProtectionGap = () => {
    clock.stop();
    if (observer) observer.disconnect();
  };

  return root;
}
