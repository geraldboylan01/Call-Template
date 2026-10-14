/**
 * THE GOALS AND RESOURCES SCREEN.
 *
 * One module, shown on a shared screen during a live call, answering one
 * question: can your money do everything you want? The adviser clicks between
 * up to four ways of using spare cash while narrating; the same screen is
 * re-opened later by the client alone, so nothing here depends on spoken
 * context.
 *
 * THE TWO PICTURES. "Your money now" is spare cash, a one-off. "Your money each
 * year" is what is left over each year against what the goals need. They are
 * never on one scale and never added. A click moves the marks inside them; the
 * yearly scale is the same in every case, so nothing rescales.
 *
 * WHAT LIVES WHERE. This file draws. Everything the screen decides that is not
 * a DOM node -- the words, the geometry, where each label sits -- is in
 * `js/goals_and_resources_view.js`, where a check can ask it without a browser.
 * Every amount comes from `js/goals_and_resources_math.js`.
 *
 * It follows `js/future_cost_fund_module.js`: the same 520ms clock, the same
 * settling discipline, the same shape of `build...Module(...)`, and the same
 * `presenterSelectScenario` for the presenter.
 */

import { projectGoalsAndResources } from './goals_and_resources_math.js';
import {
  GAR_WORDS,
  buildGarModel,
  garValues,
  layoutGar,
  lerpGarValues,
  plotLabels
} from './goals_and_resources_view.js';

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
 *     monotonic token, so two overlapping loops cannot leave the marks on one
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
export function createGarClock({
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

/** Position or size a node in pixels. Whole numbers are written as they are. */
function put(node, props) {
  Object.keys(props).forEach((name) => {
    const value = props[name];
    node.style[name] = typeof value === 'number' ? `${Number(value.toFixed(1))}px` : value;
  });
}

function setShown(node, shown) {
  node.style.opacity = shown ? '1' : '0';
}

/** The square beside a word: a solid one for the status, an outline with a tint for a picture. */
function square(className) {
  const node = el('span', className);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

/* ---------------------------------------------------------------- the module */

/**
 * @param {object} options
 * @param {object} options.rawInputs        the payload's goalsAndResourcesInputs
 * @param {object} [options.projectionOptions] passed straight to the engine
 *   (tests inject assumptions here; a payload cannot reach it)
 * @param {string} [options.selectedCaseId] the case to open on
 * @param {Function} [options.onSelectCase] told when the client picks a case
 * @param {number} [options.widthHint]      the width to lay out at before it is attached
 * @param {string} [options.badge]          a small note beside the title, for a preview
 * @returns {HTMLElement|null} null when the payload cannot be projected
 */
export function buildGoalsAndResourcesModule({
  rawInputs,
  projectionOptions = {},
  selectedCaseId = null,
  onSelectCase = null,
  widthHint = null,
  badge = ''
} = {}) {
  let model;
  try {
    model = buildGarModel(projectGoalsAndResources(rawInputs, projectionOptions));
  } catch (_error) {
    return null;
  }

  const { cases } = model;
  if (cases.length === 0) return null;

  // THE MODULE OPENS ON THE BASE CASE unless it was told which case the client
  // was last on, and a remembered case the payload no longer has is ignored.
  let selectedId = cases.some((entry) => entry.id === selectedCaseId) ? selectedCaseId : model.baseId;
  if (!cases.some((entry) => entry.id === selectedId)) selectedId = cases[0].id;

  let layout = null;
  let ui = null;
  let shown = null;
  let observer = null;
  let measuredMode = '';

  const root = el('section', 'gar');
  root.dataset.generatedCard = 'goals-and-resources';
  root.setAttribute('aria-label', GAR_WORDS.question);

  const caseOf = (id) => cases.find((entry) => entry.id === id);

  /* ------------------------------------------------------------- layout */

  function measure() {
    return Math.round(root.clientWidth || widthHint || DEFAULT_WIDTH);
  }

  function buildHead() {
    const head = el('header', 'gar-head');
    head.append(el('h2', 'gar-title', GAR_WORDS.title));
    if (badge) head.append(el('span', 'gar-badge', badge));
    return head;
  }

  /** The cases: a table under the title on a wide screen, buttons on a smaller one. */
  function buildCases() {
    const wide = layout.wide;
    const group = el('div', 'gar-cases');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', GAR_WORDS.groupLabel);
    if (wide) group.style.gridTemplateColumns = `300px repeat(${cases.length}, minmax(0, 1fr))`;

    if (wide) {
      const labels = el('div', 'gar-rowlabels');
      labels.append(el('div', 'gar-rowlabel gar-rowlabel-gap'));
      labels.append(el('div', 'gar-rowlabel gar-rowlabel-needed', model.labels.needed));
      labels.append(el('div', 'gar-rowlabel gar-rowlabel-paid', GAR_WORDS.paidLabel));
      if (model.hasLater) labels.append(el('div', 'gar-rowlabel gar-rowlabel-later', model.labels.later));
      group.append(labels);
    }

    const buttons = cases.map((entry) => {
      const button = el('button', 'gar-case');
      button.type = 'button';
      button.dataset.caseId = entry.id;

      const head = el('span', 'gar-case-head');
      const radio = el('span', 'gar-radio');
      radio.setAttribute('aria-hidden', 'true');
      radio.append(el('span', 'gar-radio-dot'));
      const text = el('span', 'gar-case-text');
      text.append(el('span', 'gar-case-name', entry.title), el('span', 'gar-case-cash', entry.cashLine));
      head.append(radio, text);
      button.append(head);

      if (wide) {
        const needed = el('span', 'gar-case-needed');
        needed.append(el('span', 'gar-case-needed-amount', entry.needed));
        if (entry.neededNote) needed.append(el('span', 'gar-case-needed-note', entry.neededNote));
        button.append(needed, el('span', 'gar-case-paid', entry.paid));
        if (model.hasLater && entry.later) {
          const later = el('span', 'gar-case-later');
          later.append(
            el('span', 'gar-later-amount', entry.later.needed),
            square(`gar-sq is-${entry.later.kind}`),
            el('span', 'gar-later-result', entry.later.result)
          );
          button.append(later);
        }
      }

      button.addEventListener('click', () => selectCase(entry.id));
      group.append(button);
      return button;
    });

    return { group, buttons };
  }

  /** The two quiet figures, under the answer on a smaller screen. */
  function buildQuiet() {
    const quiet = el('div', 'gar-quiet');
    const paidRow = el('div', 'gar-quiet-row');
    const paidValue = el('span', 'gar-quiet-value');
    paidRow.append(el('span', 'gar-quiet-label', GAR_WORDS.paidLabel), paidValue);
    quiet.append(paidRow);

    let laterLine = null;
    let laterSquare = null;
    let laterResult = null;
    if (model.hasLater) {
      const laterRow = el('div', 'gar-quiet-row gar-quiet-row-later');
      laterRow.append(el('span', 'gar-quiet-label', model.labels.later));
      laterLine = el('span', 'gar-quiet-line');
      laterSquare = square('gar-sq');
      laterResult = el('span');
      const neededText = el('span');
      laterLine.append(neededText, laterSquare, laterResult);
      laterRow.append(laterLine);
      quiet.append(laterRow);
      laterLine = { neededText, laterSquare, laterResult };
    }
    return { quiet, paidValue, later: laterLine };
  }

  function buildFigure(label, withUnit) {
    const figure = el('div', 'gar-figure');
    const amount = el('span', 'gar-figure-amount');
    const row = el('div', 'gar-figure-row');
    row.append(amount);
    if (withUnit) row.append(el('span', 'gar-figure-unit', GAR_WORDS.aYear));
    figure.append(el('div', 'gar-figure-label', label), row);
    return { figure, amount };
  }

  /** "Your money now": the cash against what the cases put into goals. */
  function buildNowPanel() {
    const nx = layout.now;
    const panel = el('section', 'gar-panel gar-panel-now');
    const head = el('div', 'gar-panel-head');
    head.append(el('h3', 'gar-panel-title', GAR_WORDS.nowTitle), el('p', 'gar-panel-sub', GAR_WORDS.nowSub));
    panel.append(head);

    const figures = el('div', 'gar-figures');
    const have = buildFigure(GAR_WORDS.haveLabel, false);
    const use = buildFigure(GAR_WORDS.useLabel, false);
    setText(have.amount, model.cashText);
    figures.append(have.figure, use.figure);
    panel.append(figures);

    const plot = el('div', 'gar-plot gar-plot-now');
    plot.setAttribute('role', 'img');
    put(plot, { height: nx.box });
    const ceiling = el('div', 'gar-ceiling');
    put(ceiling, { left: 0, top: 0, width: nx.ceilW });
    const haveBar = el('div', 'gar-bar gar-bar-have');
    put(haveBar, { left: 0, top: 1, width: nx.haveW, height: model.haveNow ? nx.plot : 0 });
    const college = el('div', 'gar-block');
    const mortgage = el('div', 'gar-block');
    const left = el('div', 'gar-left');
    [college, mortgage, left].forEach((node) => put(node, { left: nx.useLeft, width: nx.useW }));
    put(college, { top: 1 });
    plot.append(ceiling, haveBar, college, mortgage, left);

    const names = { college: null, mortgage: null };
    const side = { college: null, mortgage: null, left: null };
    if (layout.wide) {
      names.college = el('div', 'gar-block-name', GAR_WORDS.collegeFund);
      names.mortgage = el('div', 'gar-block-name', GAR_WORDS.mortgage);
      [names.college, names.mortgage].forEach((node) => put(node, { left: nx.useLeft, width: nx.useW }));
      plot.append(names.college, names.mortgage);

      const sideRows = [
        ['college', GAR_WORDS.collegeFund, false],
        ['mortgage', GAR_WORDS.mortgage, false],
        ['left', GAR_WORDS.leftOver, true]
      ];
      sideRows.forEach(([key, label, withSquare], index) => {
        const block = el('div', 'gar-side');
        put(block, { left: nx.sideLeft, top: nx.sideTops[index], width: nx.sideW });
        const title = el('div', 'gar-side-title');
        if (withSquare) title.append(square('gar-sq gar-sq-left'));
        title.append(el('span', null, label));
        const amount = el('div', 'gar-side-amount');
        block.append(title, amount);
        plot.append(block);
        side[key] = amount;
      });
    }
    panel.append(plot);

    // Under the picture on a smaller screen, where there is no room beside it.
    const rows = {};
    if (!layout.wide) {
      const list = el('div', 'gar-now-rows');
      [['college', GAR_WORDS.collegeFund], ['mortgage', GAR_WORDS.mortgage], ['left', GAR_WORDS.leftOver]]
        .forEach(([key, label]) => {
          const row = el('div', 'gar-now-row');
          const name = el('span', 'gar-now-name');
          if (key === 'left') name.append(square('gar-sq gar-sq-left'));
          name.append(el('span', null, label));
          const amount = el('span', 'gar-now-amount');
          row.append(name, amount);
          list.append(row);
          rows[key] = amount;
        });
      panel.append(list);
    }

    return {
      panel, plot, usedAmount: use.amount, college, mortgage, left, names, side, rows
    };
  }

  function buildGoalsList() {
    const list = el('ol', 'gar-goals');
    const rows = model.cases[0].year.goals.map((goal) => {
      const item = el('li', 'gar-goal');
      const name = el('div', 'gar-goal-name', goal.name);
      const amount = el('div', 'gar-goal-amount');
      const line = el('div', 'gar-goal-line');
      const glyph = el('span', 'gar-glyph');
      glyph.setAttribute('aria-hidden', 'true');
      const state = el('span', 'gar-goal-state');
      const detail = el('span', 'gar-goal-detail');
      line.append(glyph, state, detail);
      item.append(name, amount, line);
      list.append(item);
      return { name, amount, glyph, state, detail };
    });
    return { list, rows };
  }

  /** "Your money each year": what you have against what the goals need, in order. */
  function buildYearPanel() {
    const yx = layout.year;
    const panel = el('section', 'gar-panel gar-panel-year');
    const head = el('div', 'gar-panel-head');
    head.append(el('h3', 'gar-panel-title', GAR_WORDS.yearTitle), el('p', 'gar-panel-sub', GAR_WORDS.yearSub));
    panel.append(head);

    const figures = el('div', 'gar-figures');
    const have = buildFigure(GAR_WORDS.haveLabel, true);
    const need = buildFigure(GAR_WORDS.needLabel, true);
    figures.append(have.figure, need.figure);
    panel.append(figures);

    const plot = el('div', 'gar-plot gar-plot-year');
    plot.setAttribute('role', 'img');
    put(plot, { height: yx.box });

    const ceiling = el('div', 'gar-ceiling');
    put(ceiling, { left: 0, top: 0, width: yx.ceilW });
    const haveBase = el('div', 'gar-bar gar-bar-have');
    put(haveBase, { left: 0, top: 1, width: yx.haveW });
    const freed = el('div', 'gar-bar gar-bar-freed');
    put(freed, { left: 0, width: yx.haveW });
    const note = el('div', 'gar-freed-note');
    put(note, { left: 0, width: yx.noteW });
    const water = el('div', 'gar-water');
    put(water, { left: 0, width: yx.waterW });
    plot.append(ceiling, haveBase, freed, note, water);

    const goalCount = model.goalCount;
    const blocks = [];
    for (let index = 0; index < goalCount; index += 1) {
      const inside = el('div', 'gar-block');
      const outside = el('div', 'gar-short-block');
      [inside, outside].forEach((node) => put(node, { left: yx.needLeft, width: yx.needW }));
      blocks.push({ inside, outside });
      plot.append(inside, outside);
    }
    const names = [];
    for (let index = 0; index < goalCount; index += 1) {
      const name = el('div', 'gar-block-name');
      put(name, { left: yx.needLeft, width: yx.needW });
      names.push(name);
      plot.append(name);
    }

    const short = el('div', 'gar-short');
    put(short, { left: layout.wide ? yx.labelLeft : yx.needLeft, width: yx.labelW });
    const shortLine = el('div', 'gar-short-line');
    const shortSquare = square('gar-sq');
    const shortWord = el('span', 'gar-short-word');
    shortLine.append(shortSquare, shortWord);
    const shortAmount = el('div', 'gar-short-amount');
    short.append(shortLine, shortAmount);
    plot.append(short);

    // On a wide screen the goals sit beside the picture, in the same row, and
    // the panel is as tall as the taller of the two. Elsewhere they have a
    // panel of their own under the pictures.
    const goals = buildGoalsList();
    if (layout.wide) {
      const body = el('div', 'gar-year-body');
      body.style.gridTemplateColumns = `${yx.goalsLeft}px minmax(${yx.goalsMinW}px, 1fr)`;
      body.append(plot, goals.list);
      panel.append(body);
    } else {
      panel.append(plot);
    }

    return {
      panel,
      plot,
      haveAmount: have.amount,
      needAmount: need.amount,
      haveBase,
      freed,
      note,
      water,
      blocks,
      names,
      short,
      shortSquare,
      shortWord,
      shortAmount,
      goals
    };
  }

  /** Build the whole screen for the current layout. Static until the arrangement changes. */
  function build() {
    root.replaceChildren();
    root.className = `gar is-${layout.mode}`;

    const head = buildHead();
    const caseBlock = buildCases();
    const question = el('p', 'gar-question', GAR_WORDS.question);
    const answer = el('div', 'gar-answer');
    const status = square('gar-status');
    const headline = el('h3', 'gar-headline');
    // The answer changes on a click, so it is announced.
    headline.setAttribute('aria-live', 'polite');
    answer.append(status, headline);
    const support = el('p', 'gar-support');

    root.append(head, caseBlock.group, question, answer, support);

    const quiet = layout.wide ? null : buildQuiet();
    if (quiet) root.append(quiet.quiet);

    const panels = el('div', 'gar-panels');
    const now = buildNowPanel();
    const year = buildYearPanel();
    panels.append(now.panel, year.panel);
    root.append(panels);

    if (!layout.wide) {
      const goalsPanel = el('section', 'gar-panel gar-panel-goals');
      goalsPanel.append(el('h3', 'gar-panel-title', GAR_WORDS.goalsTitle), year.goals.list);
      root.append(goalsPanel);
    }

    ui = {
      buttons: caseBlock.buttons, status, headline, support, quiet, now, year
    };
  }

  /* ------------------------------------------------------------- painting */

  /** Draw every mark that moves at `values`. Opacity is a function of the painted size. */
  function paintValues(values) {
    shown = values;
    const yx = layout.year;
    const nx = layout.now;
    const { year, now } = ui;

    put(year.haveBase, { height: values.haveBaseH });
    put(year.freed, { top: values.freedTop, height: values.freedH });
    setShown(year.freed, values.freedH > 0.5);
    put(year.note, { top: values.noteTop });
    setShown(year.note, values.freedH > 0.5);
    put(year.water, { top: values.waterTop });
    put(year.short, { top: values.shortTop });

    year.blocks.forEach((block, index) => {
      const inH = values[`g${index}InH`];
      const outH = values[`g${index}OutH`];
      put(block.inside, { top: values[`g${index}InTop`], height: inH });
      setShown(block.inside, inH > 0.5);
      put(block.outside, { top: values[`g${index}OutTop`], height: outH });
      setShown(block.outside, outH > 0.5);
      put(year.names[index], { top: values[`g${index}NameTop`] });
      setShown(year.names[index], values[`g${index}Height`] >= yx.nameMin);
    });

    put(now.college, { height: values.collegeH });
    setShown(now.college, values.collegeH > 0.5);
    put(now.mortgage, { top: values.mortgageTop, height: values.mortgageH });
    setShown(now.mortgage, values.mortgageH > 0.5);
    put(now.left, { top: values.leftTop, height: values.leftH });
    setShown(now.left, values.leftH > 0.5);
    if (now.names.college) {
      put(now.names.college, { top: values.collegeNameTop });
      setShown(now.names.college, values.collegeH >= nx.nameMin);
      put(now.names.mortgage, { top: values.mortgageNameTop });
      setShown(now.names.mortgage, values.mortgageH >= nx.nameMin);
    }
  }

  /** The words and the states that change on a click. Never on the clock. */
  function renderCopy() {
    const entry = caseOf(selectedId);
    const { year, now } = ui;
    const labels = plotLabels(entry);

    ui.buttons.forEach((button, index) => {
      const active = cases[index].id === selectedId;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    setText(ui.headline, entry.headline.text);
    setText(ui.support, entry.support);
    ['short', 'spare', 'left'].forEach((kind) => {
      ui.status.classList.toggle(`is-${kind}`, entry.headline.kind === kind);
    });

    if (ui.quiet) {
      setText(ui.quiet.paidValue, entry.paid);
      if (ui.quiet.later && entry.later) {
        const { later } = ui.quiet;
        setText(later.neededText, entry.later.neededLine);
        later.laterSquare.className = `gar-sq is-${entry.later.kind}`;
        setText(later.laterResult, entry.later.result);
      }
    }

    setText(now.usedAmount, entry.now.usedText);
    now.plot.setAttribute('aria-label', labels.now);
    if (now.side.college) {
      setText(now.side.college, entry.now.collegeText);
      setText(now.side.mortgage, entry.now.mortgageText);
      setText(now.side.left, entry.now.leftText);
    }
    if (now.rows.college) {
      setText(now.rows.college, entry.now.collegeText);
      setText(now.rows.mortgage, entry.now.mortgageText);
      setText(now.rows.left, entry.now.leftText);
    }

    setText(year.haveAmount, entry.year.haveText);
    setText(year.needAmount, entry.year.needText);
    year.plot.setAttribute('aria-label', labels.year);
    setText(year.note, entry.year.freedNote);
    year.shortSquare.className = `gar-sq is-${entry.year.kind}`;
    setText(year.shortWord, entry.year.label);
    setText(year.shortAmount, `${entry.year.amountText} ${GAR_WORDS.aYear}`);
    year.short.classList.toggle('is-short', entry.year.kind === 'short');

    entry.year.goals.forEach((goal, index) => {
      setText(year.names[index], goal.shortName);
      year.blocks[index].inside.dataset.state = goal.state;
      const row = year.goals.rows[index];
      setText(row.name, goal.name);
      setText(row.amount, goal.amount);
      setText(row.state, goal.stateWord);
      setText(row.detail, goal.detail);
      row.glyph.className = `gar-glyph is-${goal.state}`;
    });
  }

  function relayout() {
    const width = measure();
    layout = layoutGar(model, { width });
    measuredMode = layout.mode;
    clock.stop();
    build();
    renderCopy();
    // Resizing is not a transition: settle on the selected case at once.
    paintValues(garValues(layout, caseOf(selectedId)));
  }

  /* ---------------------------------------------------------- the clock */

  const clock = createGarClock({
    requestFrame: (fn) => requestAnimationFrame(fn),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle),
    isAlive: () => root.isConnected
  });

  function selectCase(id) {
    if (id === selectedId || !caseOf(id)) return;

    // From what is on screen right now, so a click mid-travel carries on from
    // where the marks are and does not jump back to where they started.
    const from = shown;
    selectedId = id;
    const to = garValues(layout, caseOf(id));

    // Every WORD changes in the same frame as the click: the headline, the
    // support line, the labels and the buttons. They are not counted up,
    // because the headline changes shape between cases.
    renderCopy();

    clock.run(isReducedMotion() ? 0 : CLICK_MS, (progress) => {
      paintValues(lerpGarValues(from, to, progress));
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
      if (width <= 0) return;
      // Only a change of arrangement needs the screen built again; inside one
      // arrangement the pictures are the same size and the goals simply flex.
      if (layoutGar(model, { width }).mode !== measuredMode) relayout();
    });
    observer.observe(root);
  }

  root.presenterSelectScenario = async (id) => {
    if (!caseOf(id)) {
      throw new Error(`Unknown goals and resources scenario: ${id}`);
    }
    selectCase(id);
    await new Promise((resolve) => {
      window.setTimeout(resolve, isReducedMotion() ? 0 : CLICK_MS + SETTLE_GRACE_MS);
    });
  };

  /** What a check can read back: the case on screen and the values drawn. */
  root.garState = () => ({ selectedId, values: shown, layout });

  root.destroyGoalsAndResources = () => {
    clock.stop();
    if (observer) observer.disconnect();
  };

  return root;
}
