/**
 * THE HOUSEHOLD CASH FLOW, AS A VIEW: WHAT IT SAYS AND WHERE IT SITS.
 *
 * Everything the screen decides that is not a DOM node lives here, so a check
 * can ask it the same questions the screen asks and no DOM is needed to do it.
 * `js/household_cash_flow_module.js` draws what this file works out.
 *
 *   - the WORDS: the heading, the case buttons, the answer, the sentence, the
 *     footnote and every direct label, in the "you" voice, built from the model
 *     and never typed;
 *   - the WIDTH SWITCH: which of the two drawings the space allows, with a dead
 *     band so a scrollbar appearing cannot flip it back and forth;
 *   - the GEOMETRY of both drawings for any container width: the staircase on a
 *     wide screen and the single bar on a phone, on ONE scale in every case;
 *   - the PLACEMENT of every label, with the checks that nothing overlaps.
 *
 * WHAT THIS FILE DOES NOT DO. It does not calculate. Every amount is a figure
 * the engine already rounded to the nearest €100, and what is left over is the
 * engine's shown income less its shown lines, so the picture always adds up.
 *
 * SHORT. A case may leave less than nothing. The costs then keep stepping past
 * the floor, and what is short hangs below it in red, on the same scale as
 * everything else. The room for the deepest case is kept in every case, so
 * nothing moves when a case is chosen. On the bar the costs run past the end of
 * income and what is short is the part past it.
 */

import {
  HOUSEHOLD_CASH_FLOW_BANNED_PHRASES,
  HOUSEHOLD_CASH_FLOW_PROVIDER_NAMES
} from './household_cash_flow_math.js';

/* ------------------------------------------------------------------ constants */

/** The staircase from this content width up. */
export const STAIRS_FROM_WIDTH = 848;

/** The bar below this content width. Between the two, whichever is showing stays. */
export const BAR_BELOW_WIDTH = 832;

/** With this much room the answer sits beside the staircase, not above it. */
const ANSWER_BESIDE_FROM = 1360;

const ANSWER_WIDTH = 328;
const ANSWER_GAP = 48;

/** Below the floor, past the deepest step, on the staircase, and on the bar. */
const STAIRS_BAND_PAD = 20;
const BAR_RESERVE_PAD = 16;
// Maximum plotted spans, including the deepest shortfall. The scale stays the
// same in every case; only an unusually deep shortfall reduces income's height.
const STAIRS_MAX_SPAN = 600;
const BAR_MAX_SPAN = 900;

/** The pitch of the design frame (1728 of content, nine columns). */
const REFERENCE_PITCH = 156;

export const BAR = Object.freeze({
  maxWidth: 560,
  width: 64,
  height: 700,
  top: 52,
  labelLeft: 84,
  gap: 2,
  rowGap: 4,
  headerRule: 32,
  rowHeight: 20,
  rowHeightWithDelta: 38,
  chartHeight: 780
});

/* -------------------------------------------------------------------- helpers */

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

export function euroText(amount) {
  return `€${Math.round(Math.abs(amount)).toLocaleString('en-IE')}`;
}

/**
 * How wide a string sets, in px. An estimate, and a deliberately generous one:
 * Manrope is wide, tabular figures are wider again, and a label that is
 * estimated too wide costs a line wrap while one estimated too narrow costs an
 * overlap.
 */
export function estimateTextWidth(text, fontPx, weight = 600) {
  const bold = weight >= 700 ? 1.04 : 1;
  let em = 0;
  for (const char of String(text)) {
    if (/[0-9]/.test(char)) em += 0.64;
    else if (char === '€') em += 0.66;
    else if (char === ',' || char === '.') em += 0.32;
    else if (char === ' ') em += 0.3;
    else if (/[A-Z]/.test(char)) em += 0.7;
    else em += 0.6;
  }
  return em * fontPx * bold;
}

/** How many lines `text` takes in `width`, wrapping on spaces. At least one. */
function estimateLines(text, fontPx, width, weight = 600) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  let lines = 1;
  let used = 0;
  const space = estimateTextWidth(' ', fontPx, weight);
  words.forEach((word) => {
    const size = estimateTextWidth(word, fontPx, weight);
    if (used > 0 && used + space + size > width) {
      lines += 1;
      used = size;
    } else {
      used += (used > 0 ? space : 0) + size;
    }
  });
  return lines;
}

/** Interpolate two value lists of the same length. Exact at both ends. */
export function lerpValues(from, to, progress) {
  if (progress <= 0) return from.slice();
  if (progress >= 1) return to.slice();
  return to.map((value, index) => from[index] + (value - from[index]) * progress);
}

/* ---------------------------------------------------------------- the model */

/**
 * Read the engine's projection into what the screen needs. Only `debug` is read:
 * the screen never recomputes, so it can never disagree with the tables.
 */
export function readCashFlowModel(projection) {
  const { debug } = projection;
  const drawnLines = debug.drawnLines.map((line) => ({ id: line.id, label: line.label }));
  const cases = debug.cases.map((entry) => {
    const byId = new Map(entry.lines.map((line) => [line.id, line]));
    const drawn = drawnLines.map((line) => {
      const found = byId.get(line.id);
      return {
        id: line.id,
        label: line.label,
        amount: found.shownAmount,
        delta: found.deltaVsToday
      };
    });
    return {
      id: entry.id,
      title: entry.title,
      isBase: Boolean(entry.isBase),
      income: entry.shownIncome,
      drawn,
      left: entry.shownLeftOver,
      status: entry.status,
      monthly: entry.monthly,
      sentence: entry.sentence,
      values: [...drawn.map((line) => line.amount), entry.shownLeftOver]
    };
  });
  const base = cases.find((entry) => entry.isBase) || cases[0];
  return {
    drawnLines,
    cases,
    baseId: base.id,
    income: base.income,
    // How far below the floor the deepest case goes, kept in every case so the
    // drawing never moves when a case is chosen. 0 when nothing is short.
    deepest: Math.max(0, ...cases.map((entry) => -entry.left)),
    footnote: debug.footnote,
    hasPensionColumn: Boolean(debug.hasPensionColumn)
  };
}

function findCase(model, caseId) {
  return model.cases.find((entry) => entry.id === caseId) || model.cases.find((entry) => entry.id === model.baseId);
}

/* ---------------------------------------------------------------------- words */

/** What today's outline says: where you were, in words. */
function todayFigureText(todayLeft) {
  if (todayLeft > 0) return `${euroText(todayLeft)} left over`;
  if (todayLeft < 0) return `${euroText(todayLeft)} short`;
  return '€0 left over';
}

const HEADING = 'After everything you pay, what is left each year?';
const MUTED_LINE = 'Your household cash flow';
const INCOME_LABEL = 'Your income before tax';

/**
 * Every word a case puts on screen, in the "you" voice.
 *
 * The sentence and the footnote are the engine's own, derived from its model,
 * so the screen and the tables cannot say different things.
 */
export function buildCashFlowCopy(projection, caseId) {
  const model = readCashFlowModel(projection);
  const entry = findCase(model, caseId);
  const today = findCase(model, model.baseId);

  let status = { kind: 'tight', word: 'Tight' };
  if (entry.status === 'left_over') {
    status = { kind: 'left_over', word: 'Left over' };
  } else if (entry.status === 'short') {
    status = { kind: 'short', word: 'Short' };
  }

  const lines = entry.drawn.map((line) => ({
    id: line.id,
    label: line.label,
    amount: euroText(line.amount),
    hasDelta: line.delta !== 0,
    delta: `${euroText(line.delta)} ${line.delta < 0 ? 'less' : 'more'} than today`,
    // A pension line this case does not use stays as a quiet slot on the
    // staircase and is left out of the bar.
    quiet: line.id === 'pensions' && line.amount === 0
  }));

  return {
    mutedLine: MUTED_LINE,
    heading: HEADING,
    incomeLabel: INCOME_LABEL,
    incomeAmount: euroText(entry.income),
    incomeLine: `${euroText(entry.income)} a year`,
    buttons: model.cases.map((item) => ({ id: item.id, title: item.title })),
    status,
    figure: euroText(entry.left),
    unit: 'a year',
    monthly: entry.monthly.text,
    sentence: entry.sentence,
    footnote: model.footnote,
    lines,
    // The last column and the last row take the word the answer takes.
    lastName: entry.left < 0 ? 'Short' : 'Left over',
    key: 'Today',
    todayFigure: todayFigureText(today.left),
    chartLabel: `${status.word}: ${euroText(entry.left)} a year. ${entry.sentence}`
  };
}

/** Every string a case puts on screen, flattened, for the words scan. */
export function collectCashFlowStrings(projection, caseId) {
  const copy = buildCashFlowCopy(projection, caseId);
  const out = [copy.mutedLine, copy.heading, copy.incomeLabel, copy.incomeLine, copy.status.word,
    copy.figure, copy.unit, copy.monthly, copy.sentence, copy.footnote, copy.lastName, copy.key,
    copy.todayFigure, copy.chartLabel];
  copy.buttons.forEach((button) => out.push(button.title));
  copy.lines.forEach((line) => out.push(line.label, line.amount, line.hasDelta ? line.delta : ''));
  return out.filter(Boolean);
}

/** What must never be on screen. Returns a list of problems, empty when clean. */
export function findForbiddenText(strings) {
  const problems = [];
  strings.forEach((text) => {
    HOUSEHOLD_CASH_FLOW_BANNED_PHRASES.forEach((pattern) => {
      if (pattern.test(text)) problems.push(`"${text}" matches ${pattern}`);
    });
    HOUSEHOLD_CASH_FLOW_PROVIDER_NAMES.forEach((pattern) => {
      if (pattern.test(text)) problems.push(`"${text}" names a provider (${pattern})`);
    });
    if (/€\d{4,}/.test(text)) problems.push(`"${text}" has an amount without a thousands separator`);
  });
  return problems;
}

/* ----------------------------------------------------------- the width switch */

/**
 * Which drawing a content width allows.
 *
 * 848 and up is the staircase, under 832 is the bar, and between the two
 * whichever is showing stays. A vertical scrollbar appearing on the taller bar
 * narrows the box by about 15px, which would otherwise flip the layout back and
 * forth at the line.
 */
export function chooseDrawing(width, previous = null) {
  if (width >= STAIRS_FROM_WIDTH) return 'stairs';
  if (width < BAR_BELOW_WIDTH) return 'bar';
  return previous === 'stairs' ? 'stairs' : 'bar';
}

/* ------------------------------------------------------------ the staircase */

/**
 * The staircase for any width. One scale for the whole module: the plot height
 * over income, so nothing rescales when a case is chosen.
 */
export function layoutStairs(projection, { width } = {}) {
  const model = readCashFlowModel(projection);
  const columns = model.drawnLines.length + 2;
  const beside = width >= ANSWER_BESIDE_FROM;
  const plotWidth = beside ? width - (ANSWER_WIDTH + ANSWER_GAP) : width;
  const pitch = plotWidth / (columns - 1 + 2 / 3);
  const barWidth = (pitch * 2) / 3;
  // Type follows the column. The floors (16 for amounts, 14 for names, 13 for
  // the delta line) are the only clamp at the small end, so ten columns at the
  // narrowest wide width still fit their amounts.
  const scale = clamp(pitch / REFERENCE_PITCH, 0.5, 1);
  const fonts = {
    amount: clamp(28 * scale, 16, 28),
    name: clamp(22 * scale, 14, 22),
    delta: clamp(20 * scale, 13, 20),
    ghost: clamp(18 * scale, 14, 18),
    key: clamp(22 * scale, 16, 22),
    // "€0" at the floor. It has to fit the 28px the module keeps either side.
    zero: clamp(18 * scale, 13, 18)
  };
  const preferredPlotHeight = clamp(pitch * 2.9, 300, 450);
  const income = model.income;
  const plotHeight = Math.min(preferredPlotHeight, income * ((STAIRS_MAX_SPAN - STAIRS_BAND_PAD) / (income + model.deepest)));
  const perEuro = plotHeight / income;
  const amountGap = Math.round(fonts.amount + 14);
  // Keep the outline key in its own band above every amount and Today label.
  const top = amountGap + Math.ceil(fonts.key * 1.2) + 12;
  const floor = top + plotHeight;
  // Room below the floor for the deepest case, and a little more, so the names
  // clear it. Nothing when no case is short.
  const band = model.deepest > 0 ? Math.round(model.deepest * perEuro + STAIRS_BAND_PAD) : 0;

  const names = ['Your income before tax', ...model.drawnLines.map((line) => line.label), 'Left over', 'Short'];
  const namesTop = Math.round(floor + band + 16 * scale);
  const slotInset = (pitch - barWidth) / 2;
  let nameLines = 1;
  let deltaLines = 0;
  model.cases.forEach((entry) => {
    entry.drawn.forEach((line) => {
      if (line.delta !== 0) {
        deltaLines = Math.max(
          deltaLines,
          estimateLines(`${euroText(line.delta)} less than today`, fonts.delta, pitch, 500)
        );
      }
    });
  });
  names.forEach((name) => {
    nameLines = Math.max(nameLines, estimateLines(name, fonts.name, pitch, 600));
  });
  const namesHeight = Math.ceil(nameLines * fonts.name * 1.2 + (deltaLines > 0 ? 6 + deltaLines * fonts.delta * 1.2 : 0));
  const height = namesTop + namesHeight + 8;

  const slots = [];
  for (let index = 0; index < columns; index += 1) {
    const left = index * pitch;
    slots.push({
      index,
      kind: index === 0 ? 'income' : (index === columns - 1 ? 'left' : 'line'),
      left,
      slotLeft: left - slotInset,
      slotWidth: pitch
    });
  }

  const keySize = { swatchWidth: 36, swatchHeight: 18, gap: 12 };
  const keyWidth = keySize.swatchWidth + keySize.gap + estimateTextWidth('Today', fonts.key, 600);

  // "€0" names the floor once some case runs below it. It sits left of the
  // plot, right-aligned a few px from it, centred on the line.
  const zeroWidth = estimateTextWidth('€0', fonts.zero, 500);
  const zero = {
    visible: band > 0,
    width: zeroWidth,
    height: Math.ceil(fonts.zero * 1.2),
    left: -(zeroWidth + 4),
    top: floor - Math.ceil(fonts.zero * 1.2) / 2
  };

  return {
    mode: 'stairs',
    width,
    height,
    columns,
    slots,
    beside,
    plotWidth,
    answer: beside
      ? { placement: 'beside', left: plotWidth + ANSWER_GAP, width: ANSWER_WIDTH }
      : { placement: 'above', left: 0, width },
    pitch,
    barWidth,
    scale,
    fonts,
    plotHeight,
    perEuro,
    income,
    top,
    floor,
    band,
    deepest: model.deepest,
    zero,
    amountGap,
    namesTop,
    namesHeight,
    key: {
      left: plotWidth - keyWidth,
      top: 0,
      width: keyWidth,
      height: Math.max(keySize.swatchHeight, fonts.key * 1.2),
      ...keySize
    },
    // The one lookup the drawing and the checks share.
    yAt: (level) => floor - level * perEuro
  };
}

/** The bars, connectors and amount-label tops for a list of values. */
export function stairsGeometry(layout, values) {
  const lines = values.length - 1;
  const levels = [layout.income];
  for (let index = 0; index < lines; index += 1) {
    levels.push(levels[index] - values[index]);
  }
  const bars = [{ left: layout.slots[0].left, top: layout.top, height: layout.plotHeight, kind: 'income' }];
  for (let index = 0; index < lines; index += 1) {
    bars.push({
      left: layout.slots[index + 1].left,
      top: layout.yAt(levels[index]),
      height: values[index] * layout.perEuro,
      kind: 'cost'
    });
  }
  // What is left stands on the floor. What is short hangs from it, down to
  // where the last step ended, so the two ends meet at the same depth.
  const left = values[lines];
  bars.push({
    left: layout.slots[lines + 1].left,
    top: left >= 0 ? layout.floor - left * layout.perEuro : layout.floor,
    height: Math.abs(left) * layout.perEuro,
    kind: left >= 0 ? 'left' : 'short'
  });
  const connectors = [];
  for (let index = 0; index <= lines; index += 1) {
    connectors.push({
      left: layout.slots[index].left + layout.barWidth,
      top: layout.yAt(levels[index]),
      width: layout.pitch - layout.barWidth
    });
  }
  const amounts = bars.slice(0, lines + 1).map((bar, index) => ({
    left: layout.slots[index].slotLeft,
    top: bar.top - layout.amountGap,
    width: layout.pitch
  }));
  return { levels, bars, connectors, amounts };
}

/**
 * Today's outlines for a case, and the one label that says what they are.
 *
 * An outline is drawn only on a column whose OWN amount changed against today
 * (and where today had an amount to outline), and on the last column whenever
 * its figure differs. A column that merely moved because a line above it
 * changed gets none.
 */
export function stairsOutlines(layout, model, caseId) {
  const entry = findCase(model, caseId);
  const today = findCase(model, model.baseId);
  const isToday = entry.id === today.id;
  const todayGeometry = stairsGeometry(layout, today.values);
  const lines = today.values.length - 1;

  const outlines = [];
  for (let index = 0; index < lines; index += 1) {
    const changed = entry.values[index] !== today.values[index];
    const had = today.values[index] > 0;
    outlines.push({
      column: index + 1,
      visible: !isToday && changed && had,
      left: layout.slots[index + 1].left,
      top: todayGeometry.bars[index + 1].top,
      height: todayGeometry.bars[index + 1].height
    });
  }
  const lastChanged = !isToday && entry.left !== today.left;
  outlines.push({
    column: lines + 1,
    visible: lastChanged,
    left: layout.slots[lines + 1].left,
    top: todayGeometry.bars[lines + 1].top,
    height: todayGeometry.bars[lines + 1].height
  });

  // "Today" over today's figure. At a narrow pitch the figure itself wraps, so
  // the label is three short lines instead of two long ones.
  const figure = todayFigureText(today.left);
  const fits = estimateTextWidth(figure, layout.fonts.ghost, 600) <= layout.pitch;
  const labelText = fits
    ? ['Today', figure]
    : ['Today', figure.slice(0, figure.indexOf(' ')), figure.slice(figure.indexOf(' ') + 1)];
  const labelHeight = Math.ceil(labelText.length * layout.fonts.ghost * 1.2);
  return {
    outlines,
    keyVisible: outlines.some((outline) => outline.visible),
    lastLabel: {
      visible: lastChanged,
      slot: lines + 1,
      todayLeft: today.left,
      lines: labelText,
      height: labelHeight,
      width: layout.pitch,
      left: layout.slots[lines + 1].slotLeft,
      // Above whichever stands higher, today's outline or this case's bar, and
      // never below the floor: a short column hangs down, and the label stays up.
      topFor: (leftOverNow) => (
        layout.floor - Math.max(0, leftOverNow, today.left) * layout.perEuro - labelHeight - 8
      )
    }
  };
}

/**
 * What overlaps what on the staircase. Returns a list of problems.
 *
 * @param {object} layout from layoutStairs
 * @param {object} model from readCashFlowModel
 */
export function checkStairsLayout(layout, model) {
  const problems = [];

  model.cases.forEach((entry) => {
    const geometry = stairsGeometry(layout, entry.values);
    const copy = [euroText(entry.income), ...entry.drawn.map((line) => euroText(line.amount))];
    const caseBoxes = [];
    geometry.amounts.forEach((amount, index) => {
      const text = copy[index];
      const textWidth = estimateTextWidth(text, layout.fonts.amount, 700);
      if (textWidth > layout.pitch - 4) {
        problems.push(`${entry.id}: the amount ${text} (${Math.round(textWidth)}px) is wider than the ${Math.round(layout.pitch)}px column`);
      }
      caseBoxes.push({
        name: `${entry.id} amount ${index}`,
        left: amount.left + (layout.pitch - textWidth) / 2,
        top: amount.top,
        width: textWidth,
        height: layout.fonts.amount * 1.1
      });
    });

    if (layout.zero.visible) {
      caseBoxes.push({
        name: `${entry.id} zero label`,
        left: layout.zero.left,
        top: layout.zero.top,
        width: layout.zero.width,
        height: layout.zero.height
      });
    }
    // Nothing may reach the names, in any case.
    caseBoxes.forEach((box) => {
      if (box.top + box.height > layout.namesTop + 0.5) {
        problems.push(`${entry.id}: ${box.name} reaches the names`);
      }
    });
    // What hangs below the floor stays inside the room kept for it.
    const hangs = Math.max(0, -entry.left) * layout.perEuro;
    if (hangs > layout.band + 0.5) {
      problems.push(`${entry.id}: what is short (${Math.round(hangs)}px) is deeper than the room kept for it`);
    }

    const outline = stairsOutlines(layout, model, entry.id);
    if (outline.keyVisible) {
      caseBoxes.push({
        name: `${entry.id} key`,
        left: layout.key.left,
        top: layout.key.top,
        width: layout.key.width,
        height: layout.key.height
      });
    }
    if (outline.lastLabel.visible) {
      const todayWidth = Math.max(
        ...outline.lastLabel.lines.map((line) => estimateTextWidth(line, layout.fonts.ghost, 600))
      );
      if (todayWidth > layout.pitch) {
        problems.push(`${entry.id}: today's label is wider than its slot`);
      }
      caseBoxes.push({
        name: `${entry.id} today label`,
        left: outline.lastLabel.left + (layout.pitch - todayWidth) / 2,
        top: outline.lastLabel.topFor(entry.left),
        width: todayWidth,
        height: outline.lastLabel.height
      });
    }

    for (let a = 0; a < caseBoxes.length; a += 1) {
      for (let b = a + 1; b < caseBoxes.length; b += 1) {
        const p = caseBoxes[a];
        const q = caseBoxes[b];
        const overlap = p.left < q.left + q.width && q.left < p.left + p.width
          && p.top < q.top + q.height && q.top < p.top + p.height;
        if (overlap) problems.push(`${p.name} overlaps ${q.name}`);
      }
    }
    // A label is centred on its bar, so it may reach one slot inset past the
    // plot's edge. The module keeps that much side padding for it.
    const inset = (layout.pitch - layout.barWidth) / 2;
    caseBoxes.forEach((box) => {
      const room = box.name.endsWith('zero label') ? 28 : inset;
      if (box.left < -room - 0.5 || box.top < -0.5 || box.left + box.width > layout.width + room + 0.5) {
        problems.push(`${box.name} is outside the container`);
      }
    });
  });

  // Names: the longest word must fit its slot, so a name wraps and never runs on.
  const names = ['Your income before tax', ...model.drawnLines.map((line) => line.label), 'Left over', 'Short'];
  names.forEach((name, index) => {
    name.split(/\s+/).forEach((word) => {
      if (estimateTextWidth(word, layout.fonts.name, 600) > layout.pitch) {
        problems.push(`the name "${name}" has a word wider than column ${index}`);
      }
    });
  });

  if (layout.fonts.name < 14) problems.push('names are under 14px');
  if (layout.fonts.amount < 16) problems.push('amounts are under 16px');
  return problems;
}

/* ------------------------------------------------------------------- the bar */

/** One scale for all cases; deep shortfalls share a fixed maximum span. */
export function layoutBar(projection, { width } = {}) {
  const model = readCashFlowModel(projection);
  const contentWidth = Math.min(width, BAR.maxWidth);
  const compact = contentWidth < 400;
  const headerHeight = compact
    ? 20 * estimateLines('Your income before tax', 15, contentWidth, 500)
      + 2 + 20 * Math.max(1, Math.ceil(estimateTextWidth(`${euroText(model.income)} a year`, 17, 700) / contentWidth))
    : 20;
  const headerRule = compact ? headerHeight + 12 : BAR.headerRule;
  const barTop = headerRule + 20;
  const barHeight = Math.min(BAR.height, model.income * ((BAR_MAX_SPAN - BAR_RESERVE_PAD) / (model.income + model.deepest)));
  const perEuro = barHeight / model.income;
  // The costs run past the end of income, so the bar is as much taller as the
  // deepest case needs, in every case. Nothing when no case is short.
  const reserve = model.deepest > 0 ? Math.round(model.deepest * perEuro + BAR_RESERVE_PAD) : 0;
  return {
    mode: 'bar',
    width,
    contentWidth,
    compact,
    headerRule,
    offsetLeft: Math.max(0, (width - contentWidth) / 2),
    barWidth: BAR.width,
    barHeight,
    barTop,
    labelLeft: BAR.labelLeft,
    labelWidth: contentWidth - BAR.labelLeft,
    height: barTop + barHeight + reserve + (BAR.chartHeight - BAR.top - BAR.height),
    perEuro,
    income: model.income,
    deepest: model.deepest,
    reserve,
    // Where income ends: a hairline across the bar once some case runs past it.
    incomeEnd: barTop + barHeight
  };
}

/**
 * The segments for a list of values: spent from the top down, left over last.
 * The costs run on past the end of income when the year is short, and the last
 * segment is then the part past it.
 */
export function barGeometry(layout, values) {
  const lines = values.length - 1;
  const segments = [];
  let spent = 0;
  for (let index = 0; index < lines; index += 1) {
    const height = values[index] * layout.perEuro;
    segments.push({ top: spent, height: Math.max(0, height - BAR.gap), centre: spent + height / 2, kind: 'cost', raw: height });
    spent += height;
  }
  const left = values[lines];
  if (left >= 0) {
    const leftHeight = left * layout.perEuro;
    segments.push({ top: spent, height: leftHeight, centre: spent + leftHeight / 2, kind: 'left', raw: leftHeight });
  } else {
    const over = -left * layout.perEuro;
    segments.push({
      top: layout.barHeight,
      height: over,
      centre: layout.barHeight + over / 2,
      kind: 'short',
      raw: over
    });
  }
  return { segments };
}

/**
 * The label rows beside the bar, placed so that none touches another: pushed
 * down in order, then pulled back up from the floor.
 *
 * @param {object} layout from layoutBar
 * @param {object[]} specs `{ id, centre, hasDelta }` in bar order
 */
export function placeBarRows(layout, specs) {
  const rows = specs.map((spec) => ({
    ...spec,
    height: spec.measuredHeight > 0 ? spec.measuredHeight : layout.compact
      ? 20 * estimateLines(spec.label, 15, layout.labelWidth)
        + 20 * Math.max(1, Math.ceil(estimateTextWidth(spec.amount, 17, 700) / layout.labelWidth))
        + (spec.hasDelta ? 18 * estimateLines(spec.delta, 14, layout.labelWidth, 500) : 0)
      : (spec.hasDelta ? BAR.rowHeightWithDelta : BAR.rowHeight),
    c: layout.barTop + spec.centre
  }));
  for (let index = 1; index < rows.length; index += 1) {
    const need = rows[index - 1].c + (rows[index - 1].height + rows[index].height) / 2 + BAR.rowGap;
    if (rows[index].c < need) rows[index].c = need;
  }
  const last = rows.length - 1;
  if (last >= 0) {
    const floor = (layout.rowFloor || (layout.barTop + layout.barHeight + (layout.reserve || 0) + 8)) - rows[last].height / 2;
    if (rows[last].c > floor) {
      rows[last].c = floor;
      for (let index = last - 1; index >= 0; index -= 1) {
        const limit = rows[index + 1].c - (rows[index + 1].height + rows[index].height) / 2 - BAR.rowGap;
        if (rows[index].c > limit) rows[index].c = limit;
      }
    }
  }
  return rows.map((row) => ({ ...row, top: row.c - row.height / 2 }));
}

/** The row specs for a case, in bar order, with the pension row left out when unused. */
export function barRowSpecs(model, caseId, values) {
  const entry = findCase(model, caseId);
  const specs = [];
  entry.drawn.forEach((line, index) => {
    if (line.id === 'pensions' && line.amount === 0) return;
    specs.push({
      id: line.id,
      label: line.label,
      amount: euroText(line.amount),
      hasDelta: line.delta !== 0,
      delta: `${euroText(line.delta)} ${line.delta < 0 ? 'less' : 'more'} than today`,
      segment: index
    });
  });
  // Nothing left stands as a mark and not a row, so only a figure above or
  // below nothing gets one.
  if (entry.left !== 0) {
    specs.push({
      id: 'left',
      label: entry.left < 0 ? 'Short' : 'Left over',
      amount: euroText(entry.left),
      hasDelta: false,
      delta: '',
      segment: values.length - 1
    });
  }
  return specs;
}

/** What overlaps what on the bar. Returns a list of problems. */
export function checkBarLayout(layout, model) {
  const problems = [];
  model.cases.forEach((entry) => {
    const geometry = barGeometry(layout, entry.values);
    const specs = barRowSpecs(model, entry.id, entry.values).map((spec) => ({
      ...spec,
      centre: geometry.segments[spec.segment].centre
    }));
    const rows = placeBarRows(layout, specs);
    rows.forEach((row, index) => {
      if (index > 0) {
        const previous = rows[index - 1];
        if (row.top < previous.top + previous.height + BAR.rowGap - 0.01) {
          problems.push(`${entry.id}: row "${row.label}" touches "${previous.label}"`);
        }
      }
      if (row.top + row.height > layout.barTop + layout.barHeight + layout.reserve + 12) {
        problems.push(`${entry.id}: row "${row.label}" is below the floor`);
      }
      const need = layout.compact
        ? Math.max(...row.label.split(/\s+/).map((word) => estimateTextWidth(word, 15, 600)))
        : estimateTextWidth(row.label, 15, 600) + 8 + estimateTextWidth(row.amount, 17, 700);
      if (need > layout.labelWidth) {
        problems.push(`${entry.id}: row "${row.label}" does not fit ${Math.round(layout.labelWidth)}px`);
      }
    });
  });
  return problems;
}
