/**
 * RENTAL, KEEP OR SELL, AS A VIEW: WHAT IT SAYS AND WHERE IT SITS.
 *
 * Everything the screen decides that is not a DOM node lives here, so a check
 * can ask it the same questions the screen asks and no DOM is needed to do it.
 * `js/rental_keep_or_sell_module.js` draws what this file works out.
 *
 *   - the WORDS: the heading, the sentence, the case buttons, the five lines and
 *     the footnote, in the "you" voice, built from the model and never typed;
 *   - the GEOMETRY: five bars, a zero line, a headline line and the connectors,
 *     for any container width.
 *
 * The screen is one bar, cut down step by step from the headline to what is
 * left. Both cases have the same five lines, so every mark has an old and a new
 * position and travels when the case changes.
 *
 * WHAT THIS FILE DOES NOT DO. It does not solve anything. Every amount comes
 * from `computeRentalKeepOrSellProjection`.
 */

import { euroText } from './rental_keep_or_sell_math.js';

/* ------------------------------------------------------------------ constants */

/** From this container width up, names sit in a column left of the bars. */
const NARROW_BELOW_PX = 1200;

/** The narrow arrangement never grows past this, and sits centred. */
const NARROW_MAX_CHART_PX = 720;

/** A bar of nothing is still drawn, so its row is not empty. */
const MIN_MARK_PX = 2;

const MINUS = '−';

const HEADING = 'What does this property give you each year if you keep it, '
  + 'and what would you have in hand if you sold it?';

const FOOTNOTE = 'Education only. Figures are as stated for this property; '
  + 'tax is not calculated here. This shows what is, and what each case would change.';

/** The two sets of constants the drawing uses. */
const WIDE = Object.freeze({
  name: 'wide',
  stagePad: 48,
  nameColumn: 372,
  nameGap: 8,
  pitch: 92,
  nameHeight: 52,
  barOffset: 4,
  barHeight: 52,
  nameFont: 25,
  nameLineHeight: 26,
  nameBoxWidth: 372,
  valueFont: 36,
  wordFont: 22,
  wordGap: 12,
  labelOffset: 16,
  basePct: 8,
  spanPct: 70,
  axisGap: 8,
  axisHeight: 28,
  edgeMargin: 8
});

const NARROW = Object.freeze({
  name: 'narrow',
  stagePad: 16,
  nameColumn: 0,
  nameGap: 0,
  pitch: 84,
  nameHeight: 24,
  nameHeightTwoLines: 40,
  nameLineHeight: 20,
  nameGapBelow: 4,
  barOffset: 28,
  barHeight: 30,
  rowTail: 26,
  nameFont: 16,
  namePadRight: 8,
  valueFont: 19,
  wordFont: 14,
  wordGap: 6,
  valueLine: 22,
  wordLine: 16,
  stackWordBelowPx: 300,
  stackWordWrapPx: 120,
  labelOffset: 10,
  basePct: 6,
  spanPct: 62,
  axisGap: 4,
  axisHeight: 22,
  edgeMargin: 4
});

/** The phrases that must never reach a client, and the names of providers. */
const BANNED_PHRASES = Object.freeze([
  /\bwe recommend\b/i,
  /\byou should\b/i,
  /\bbest option\b/i,
  /\bbest\b/i,
  /\bideal\b/i,
  /\boptimal\b/i,
  /\bp\.a\./i,
  /\bwe\b/i,
  /\bus\b/i,
  /\bour\b/i
]);

const PROVIDER_NAMES = Object.freeze([
  /\bbank of ireland\b/i,
  /\baib\b/i,
  /\bptsb\b/i,
  /\bpermanent tsb\b/i,
  /\brevolut\b/i,
  /\bzurich\b/i,
  /\birish life\b/i,
  /\bdavy\b/i
]);

/* --------------------------------------------------------------------- helpers */

/** "€1,200", or "−€1,200" under zero. */
function signedEuro(amount) {
  const rounded = Math.round(amount);
  return `${rounded < 0 ? MINUS : ''}${euroText(Math.abs(rounded))}`;
}

/** A cut, "−€13,000". A cut of nothing reads "€0". */
function cutEuro(amount) {
  return Math.round(amount) === 0 ? euroText(0) : `${MINUS}${euroText(amount)}`;
}

/**
 * A conservative text width, for collision checks that must agree between Node
 * and a browser. Digits and euro signs are wide in Manrope, so this leans wide:
 * a layout that clears this estimate clears the real text.
 */
function estimateTextWidth(text, fontPx, weight = 700) {
  return Math.ceil(String(text).length * fontPx * (weight >= 700 ? 0.62 : 0.58));
}

function findCase(projection, caseId) {
  const { cases, baseScenarioId } = projection.debug;
  return cases.find((entry) => entry.id === caseId)
    || cases.find((entry) => entry.id === baseScenarioId)
    || cases[0];
}

/** "loan repayments, running costs and tax on the rental profit" */
function joinNames(names) {
  const lower = names.map((name) => name.toLowerCase());
  if (lower.length <= 1) {
    return lower.join('');
  }
  return `${lower.slice(0, -1).join(', ')} and ${lower[lower.length - 1]}`;
}

/* ----------------------------------------------------------------------- words */

/** The sentence for a case: what it shows, in the "you" voice. */
function sentenceFor(entry) {
  const shown = Math.abs(entry.shownResult);
  if (entry.id === 'keep') {
    if (entry.resultTone === 'short') {
      return `The rent does not cover the loan repayments, running costs and tax: ${euroText(shown)} short each year.`;
    }
    if (entry.resultTone === 'left_over') {
      return `The rent covers the loan repayments, running costs and tax, with ${euroText(shown)} left over each year.`;
    }
    return 'The rent exactly covers the loan repayments, running costs and tax.';
  }
  if (entry.resultTone === 'short') {
    return `Selling costs, the loan and tax come to more than the price: ${euroText(shown)} short.`;
  }
  if (entry.resultTone === 'level') {
    return 'Selling costs, the loan and tax take the whole price: nothing would be in hand.';
  }
  return `Selling costs, the loan and tax come off the price: ${euroText(shown)} is what you would have in hand.`;
}

/** The word beside the result, so colour never carries meaning alone. */
function resultWordFor(entry) {
  if (entry.id === 'keep') {
    if (entry.resultTone === 'short') return 'a year, short';
    if (entry.resultTone === 'left_over') return 'a year, left over';
    return 'a year, nothing left over';
  }
  return entry.resultTone === 'short' ? 'short' : 'in hand';
}

/** The answer a case button carries, so both answers are visible without a click. */
function answerLineFor(entry) {
  const value = signedEuro(entry.shownResult);
  if (entry.id === 'keep') {
    return `${value} a year`;
  }
  return `${value} ${entry.resultTone === 'short' ? 'short' : 'in hand'}`;
}

/** One line of the chart as it is read: name, value and the word beside the result. */
function lineCopy(entry, row) {
  // Always the shown figures, so what is on screen adds down to its last line.
  if (row.key === 'start') {
    return { key: row.key, name: row.name, value: euroText(row.shownAmount), word: '' };
  }
  if (row.key === 'result') {
    return { key: row.key, name: row.name, value: signedEuro(row.shownAmount), word: resultWordFor(entry) };
  }
  return { key: row.key, name: row.name, value: cutEuro(row.shownAmount), word: '' };
}

/**
 * Every string the screen shows for one case.
 *
 * @param {object} projection what `computeRentalKeepOrSellProjection` returned
 * @param {string} caseId
 */
export function buildRentalCopy(projection, caseId) {
  const entry = findCase(projection, caseId);
  const headline = sentenceFor(entry);
  const cuts = entry.rows.filter((row) => row.key.startsWith('cut')).map((row) => row.name);

  return {
    heading: HEADING,
    headline,
    footnote: FOOTNOTE,
    buttons: projection.debug.cases.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      answerLine: answerLineFor(candidate)
    })),
    lines: entry.rows.map((row) => lineCopy(entry, row)),
    tone: entry.resultTone,
    zeroLabel: '0',
    chartLabel: `${headline} The ${entry.startName.toLowerCase()} is cut down line by line: `
      + `${joinNames(cuts)}, then ${entry.resultName.toLowerCase()}.`,
    groupLabel: 'Keep or sell'
  };
}

/** Every string a case puts on screen, flattened, for the words scan. */
export function collectRentalStrings(projection, caseId) {
  const copy = buildRentalCopy(projection, caseId);
  const out = [copy.heading, copy.headline, copy.footnote, copy.chartLabel, copy.zeroLabel, copy.groupLabel];
  copy.buttons.forEach((button) => out.push(button.title, button.answerLine));
  copy.lines.forEach((line) => out.push(line.name, line.value, line.word));
  return out.filter(Boolean);
}

/**
 * What must never be on screen. Returns a list of problems, empty when clean.
 *
 * @param {string[]} strings
 */
export function findForbiddenText(strings) {
  const problems = [];
  strings.forEach((text) => {
    BANNED_PHRASES.forEach((pattern) => {
      if (pattern.test(text)) problems.push(`"${text}" matches ${pattern}`);
    });
    PROVIDER_NAMES.forEach((pattern) => {
      if (pattern.test(text)) problems.push(`"${text}" names a provider (${pattern})`);
    });
    // An amount of four or more digits with no thousands separator.
    if (/€\d{4,}/.test(text)) problems.push(`"${text}" has an amount without a thousands separator`);
    // A hyphen used as a minus.
    if (/(^|\s)-€/.test(text)) problems.push(`"${text}" uses a hyphen as a minus`);
  });
  return problems;
}

/* -------------------------------------------------------------------- geometry */

/** Interpolate two value lists of the same length. */
export function lerpValues(from, to, progress) {
  // Exact at both ends, so the settled frame is the target and not a rounding
  // of it: the drawn state after any run must equal a fresh render.
  if (progress >= 1) return to.slice();
  if (progress <= 0) return Array.from(to, (value, index) => (Number.isFinite(from[index]) ? from[index] : value));
  const out = new Array(to.length);
  for (let i = 0; i < to.length; i += 1) {
    const a = Number.isFinite(from[i]) ? from[i] : to[i];
    out[i] = a + ((to[i] - a) * progress);
  }
  return out;
}

/**
 * Where the marks of one case sit, as one flat list of numbers so two cases can
 * be interpolated point by point.
 *
 *   [ zeroX, headlineX, then for each of the five lines: barLeft, barWidth, labelLeft ]
 *
 * It is laid out from the SHOWN rows, so the bars, the words and the result all
 * say the same thing.
 *
 * The scale starts at zero and is one per case. The start bar always runs from
 * 8% (6% narrow) of the plot to a fixed end, and a result below zero gets room
 * to its left in proportion to how far below zero it goes. When a label would
 * not fit to the right of its bar at that scale, the scale tightens until it
 * does, so nothing is ever clipped.
 */
function caseValues(entry, copy, geometry) {
  const { k, plotLeft, plotWidth, stacked, stackBox } = geometry;
  const start = entry.rows[0].shownAmount;
  const deepest = Math.max(0, -entry.shownResult);
  // A start that rounds to nothing still has a scale to draw on.
  const total = Math.max(start + deepest, 1);

  const spanPx = (plotWidth * k.spanPct) / 100;
  const basePx = (plotWidth * k.basePct) / 100;
  let unit = spanPx / total;

  // Room for each label to the right of its bar, at this scale. A stacked label
  // has one box width for every label, with the word wrapping inside it.
  entry.rows.forEach((row, index) => {
    const line = copy.lines[index];
    const valueWidth = estimateTextWidth(line.value, k.valueFont, 700);
    const wordWidth = line.word ? estimateTextWidth(line.word, k.wordFont, 500) : 0;
    const labelWidth = stacked
      ? stackBox
      : valueWidth + (line.word ? k.wordGap + wordWidth : 0);
    const reach = deepest + row.shownHi;
    if (reach > 0) {
      const room = plotWidth - basePx - k.edgeMargin - k.labelOffset - labelWidth;
      unit = Math.min(unit, Math.max(room, 0.0001) / reach);
    }
  });

  const zeroX = plotLeft + basePx + (deepest * unit);
  const xAt = (amount) => zeroX + (amount * unit);

  const values = [zeroX, xAt(start)];
  entry.rows.forEach((row) => {
    const left = xAt(row.shownLo);
    const width = Math.max(MIN_MARK_PX, (row.shownHi - row.shownLo) * unit);
    values.push(left, width, left + width + k.labelOffset);
  });
  return values;
}

/**
 * How many lines the names need, for the whole layout.
 *
 * It is decided over BOTH cases and every row, so every row has the same height
 * and nothing moves vertically when the case changes. A name that is wider than
 * its box wraps to a second line rather than being cut off.
 */
function countNameLines(projection, boxWidth, fontPx) {
  let lines = 1;
  projection.debug.cases.forEach((entry) => {
    entry.rows.forEach((row) => {
      if (estimateTextWidth(row.name, fontPx, 700) > boxWidth) {
        lines = 2;
      }
    });
  });
  return lines;
}

/**
 * The drawing's frame for a container width.
 *
 * @param {object} projection
 * @param {object} options
 * @param {number} options.width the module's width in px
 */
export function layoutRentalChart(projection, { width } = {}) {
  const narrow = width < NARROW_BELOW_PX;
  const k = narrow ? NARROW : WIDE;

  const chartWidth = narrow
    ? Math.max(0, Math.min(width - (2 * k.stagePad), NARROW_MAX_CHART_PX))
    : Math.max(0, width - (2 * k.stagePad));
  const plotLeft = narrow ? 0 : k.nameColumn + k.nameGap;
  const plotWidth = chartWidth - plotLeft;

  // On a very narrow chart the word goes under the number, because the two side
  // by side would leave the bars nothing to be drawn in.
  const stacked = narrow && chartWidth < k.stackWordBelowPx;

  // A stacked label is one box width for all of them: as wide as the widest
  // number, or as the word when it is short, and a long word wraps to a second
  // line inside it.
  let stackBox = 0;
  if (stacked) {
    projection.debug.cases.forEach((entry) => {
      buildRentalCopy(projection, entry.id).lines.forEach((line) => {
        const valueWidth = estimateTextWidth(line.value, k.valueFont, 700);
        const wordWidth = line.word
          ? Math.min(estimateTextWidth(line.word, k.wordFont, 500), k.stackWordWrapPx)
          : 0;
        stackBox = Math.max(stackBox, valueWidth, wordWidth);
      });
    });
  }

  // NAMES WRAP, THEY ARE NEVER CUT OFF.
  const nameBox = narrow ? Math.max(0, chartWidth - k.namePadRight) : k.nameBoxWidth;
  const nameLines = countNameLines(projection, nameBox, k.nameFont);

  let nameHeight;
  let nameLineHeight;
  let barOffset;
  let pitch;
  if (narrow) {
    nameHeight = nameLines === 1 ? k.nameHeight : k.nameHeightTwoLines;
    nameLineHeight = nameLines === 1 ? k.nameHeight : k.nameLineHeight;
    barOffset = nameHeight + k.nameGapBelow;
    pitch = barOffset + k.barHeight + k.rowTail;
  } else {
    // The name sits beside its bar, so two lines fit in the bar's own height.
    nameHeight = k.nameHeight;
    nameLineHeight = nameLines === 1 ? k.nameHeight : k.nameLineHeight;
    barOffset = k.barOffset;
    pitch = k.pitch;
  }

  // The number, and the word on up to two lines under it. It fits in the tail of
  // the row below the bar, so nothing is pushed.
  const labelHeight = stacked ? k.valueLine + (2 * k.wordLine) : k.barHeight;

  const rowsHeight = 5 * pitch;
  const geometry = { k, plotLeft, plotWidth, stacked, stackBox };

  const rows = Array.from({ length: 5 }, (_, index) => {
    const top = index * pitch;
    const barTop = top + barOffset;
    return {
      index,
      top,
      barTop,
      barHeight: k.barHeight,
      labelTop: barTop,
      labelHeight,
      name: narrow
        ? { left: 0, top, width: chartWidth, height: nameHeight, lineHeight: nameLineHeight }
        : { left: 0, top: barTop, width: k.nameColumn, height: nameHeight, lineHeight: nameLineHeight },
      // A connector joins each cut to the next line, at the cut's lower end.
      connector: !narrow && index >= 1 && index <= 3
        ? { top: barTop + k.barHeight, height: pitch - k.barHeight }
        : null
    };
  });

  const values = {};
  projection.debug.cases.forEach((entry) => {
    const copy = buildRentalCopy(projection, entry.id);
    values[entry.id] = caseValues(entry, copy, geometry);
  });

  return {
    width,
    chartWidth,
    narrow,
    stacked,
    stackBox,
    nameLines,
    constants: k,
    plot: { left: plotLeft, width: plotWidth },
    rowsHeight,
    axis: { top: rowsHeight + k.axisGap, height: k.axisHeight },
    height: rowsHeight + k.axisGap + k.axisHeight,
    rows,
    values
  };
}

/**
 * The checks the screen relies on: every bar and label inside the chart, every
 * name inside its box (on two lines if it must), and no label crossing a bar it
 * does not belong to. Returns a list of problems, empty when the layout holds.
 */
export function checkRentalLayout(projection, layout) {
  const problems = [];
  const { constants: k, chartWidth } = layout;

  projection.debug.cases.forEach((entry) => {
    const copy = buildRentalCopy(projection, entry.id);
    const values = layout.values[entry.id];
    const where = `${entry.id} at ${layout.width}`;

    const zeroX = values[0];
    if (zeroX < 0 || zeroX > chartWidth) {
      problems.push(`${where}: the zero line is outside the chart (${zeroX.toFixed(1)})`);
    }

    entry.rows.forEach((row, index) => {
      const left = values[2 + (index * 3)];
      const barWidth = values[3 + (index * 3)];
      const labelLeft = values[4 + (index * 3)];
      const line = copy.lines[index];
      const valueWidth = estimateTextWidth(line.value, k.valueFont, 700);
      const wordWidth = line.word ? estimateTextWidth(line.word, k.wordFont, 500) : 0;
      const labelWidth = layout.stacked
        ? layout.stackBox
        : valueWidth + (line.word ? k.wordGap + wordWidth : 0);
      if (layout.stacked && wordWidth > (2 * layout.stackBox) - 12) {
        problems.push(`${where}/${row.key}: the word "${line.word}" does not fit in two lines of ${layout.stackBox}`);
      }

      if (left < -0.5 || left + barWidth > chartWidth + 0.5) {
        problems.push(`${where}/${row.key}: the bar leaves the chart (${left.toFixed(1)} to ${(left + barWidth).toFixed(1)})`);
      }
      if (labelLeft + labelWidth > chartWidth + 0.5) {
        problems.push(`${where}/${row.key}: the label runs past the chart (${(labelLeft + labelWidth).toFixed(1)} > ${chartWidth})`);
      }
      if (labelLeft < left + barWidth) {
        problems.push(`${where}/${row.key}: the label sits on its bar`);
      }

      // A name may wrap onto a second line, never beyond it. A word that cannot
      // break costs a little of the second line, so some slack is kept.
      const nameWidth = estimateTextWidth(line.name, k.nameFont, 700);
      const box = layout.rows[index].name.width - (layout.narrow ? k.namePadRight : 0);
      const limit = layout.nameLines === 1 ? box : (2 * box) - 12;
      if (nameWidth > limit) {
        problems.push(`${where}/${row.key}: the name "${line.name}" does not fit in ${layout.nameLines} line(s) of ${box} (${nameWidth})`);
      }
    });
  });

  return problems;
}
