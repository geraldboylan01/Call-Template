/**
 * HOME, TRADE DOWN, AS A VIEW: WHAT IT SAYS AND WHERE IT SITS.
 *
 * Everything the screen decides that is not a DOM node lives here, so a check
 * can ask it the same questions the screen asks and no DOM is needed to do it.
 * `js/home_trade_down_module.js` draws what this file works out.
 *
 *   - the WORDS: the heading, the sentence, the case buttons, every label and
 *     the footnote, in the "you" voice, built from the model and never typed;
 *   - the GEOMETRY: the home bar in two blocks, today's home marker, and the
 *     year track, for any container width.
 *
 * Two things sit side by side and are on different scales, and are labelled as
 * such. The HOME is a bar whose whole length is today's home. The YEAR is a
 * track whose whole length is what is repaid on the mortgage today. Neither is
 * ever drawn on the other's scale.
 *
 * WHAT THIS FILE DOES NOT DO. It does not solve anything. Every amount comes
 * from `computeHomeTradeDownProjection`, and the loan term and rate on screen
 * are read from the projection's `assumptionsUsed`.
 */

import { euroText, HOME_TRADE_DOWN_BANNED_PHRASES } from './home_trade_down_math.js';

/* ------------------------------------------------------------------ constants */

/**
 * From this container width up the home and the year sit side by side.
 *
 * The first block's label has to fit under the first block, and the smallest
 * that block gets is a little over half of the bar. That needs a bar of about
 * 840px, plus the year beside it, which is why this is not the 1200 the rental
 * module changes arrangement at.
 */
const WIDE_FROM_PX = 1632;

/** The stacked arrangement never grows past this, and sits centred. */
const NARROW_MAX_CHART_PX = 720;

/**
 * Under this chart width the stacked arrangement is the compact one: the figures
 * put their word beneath them, the two labels sit one above the other and the
 * two year rows stack their name over their amount. The app's phone shell leaves
 * about 252px for the module on a 320px phone, which is a 220px chart, and the
 * stacked arrangement's figure alone is 288px wide there.
 *
 * 400 is where a ten-character home ("€1,250,000") and its word fit on one line.
 */
const COMPACT_BELOW_PX = 400;

/** The space a label keeps for the swatch that ties it to its block, compact only. */
const SWATCH_INSET_PX = 20;

/** The clear space between the first label and the second. */
const LABEL_GAP_PX = 12;

const WIDE = Object.freeze({
  name: 'wide',
  stagePad: 48,
  panelWidth: 380,
  panelInset: 382,
  hairlineGap: 40,
  barToHairline: 270,
  figureTop: 0,
  figureHeight: 84,
  figureFont: 72,
  figureWordFont: 26,
  todayTop: 104,
  todayHeight: 236,
  todayGap: 18,
  todayFont: 22,
  todayValueFont: 30,
  barTop: 120,
  barHeight: 120,
  labelTop: 256,
  labelOneWidth: 600,
  labelTwoWidth: 320,
  amountFont: 36,
  nameFont: 24,
  noteFont: 22,
  hairlineHeight: 360,
  freedTop: 0,
  freedHeight: 84,
  freedFont: 72,
  freedWordTop: 88,
  freedWordFont: 26,
  trackTop: 140,
  trackHeight: 36,
  row1Top: 192,
  row2Top: 232,
  rowHeight: 36,
  rowNameFont: 24,
  rowValueFont: 28,
  trackNoteTop: 284,
  trackNoteFont: 22,
  height: 380
});

const NARROW = Object.freeze({
  name: 'narrow',
  stagePad: 16,
  figureTop: 0,
  figureHeight: 52,
  figureFont: 44,
  figureWordFont: 16,
  todayLabelTop: 56,
  todayLabelHeight: 18,
  todayFont: 14,
  todayLineTop: 76,
  todayLineHeight: 64,
  barTop: 80,
  barHeight: 52,
  labelTop: 148,
  labelOneWidth: 176,
  labelTwoWidth: 150,
  amountFont: 20,
  nameFont: 14,
  noteFont: 13,
  noteTop: 218,
  noteHeight: 34,
  ruleTop: 262,
  freedTop: 278,
  freedHeight: 48,
  freedFont: 40,
  freedWordFont: 16,
  trackTop: 336,
  trackHeight: 28,
  row1Top: 374,
  row2Top: 404,
  rowHeight: 28,
  rowNameFont: 16,
  rowValueFont: 18,
  trackNoteTop: 436,
  trackNoteHeight: 34,
  trackNoteFont: 13,
  height: 470
});

const COMPACT = Object.freeze({
  name: 'compact',
  stagePad: 16,
  figureTop: 0,
  figureHeight: 64,
  figureFont: 36,
  figureMinFont: 24,
  figureWordFont: 16,
  todayLabelTop: 70,
  todayLabelHeight: 18,
  todayFont: 14,
  todayLineTop: 90,
  todayLineHeight: 64,
  barTop: 94,
  barHeight: 52,
  labelTop: 158,
  labelOneHeight: 62,
  labelTwoTop: 228,
  labelTwoHeight: 44,
  amountFont: 20,
  nameFont: 14,
  noteFont: 13,
  noteTop: 280,
  noteHeight: 34,
  ruleTop: 326,
  freedTop: 342,
  freedHeight: 66,
  freedFont: 36,
  freedMinFont: 24,
  freedWordFont: 16,
  trackTop: 412,
  trackHeight: 28,
  row1Top: 452,
  row2Top: 500,
  rowHeight: 44,
  rowNameFont: 14,
  rowValueFont: 18,
  trackNoteTop: 552,
  trackNoteHeight: 34,
  trackNoteFont: 13,
  height: 590
});

const HEADING = 'If you set a yearly repayment you are comfortable with, what home does that buy?';

/** The names of providers. The banned phrases are the engine's: it checks a payload's text against them. */
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

/** "4%" when whole, otherwise at most two decimals ("3.25%"). */
function percentText(decimal) {
  const rounded = Math.round(decimal * 100 * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

function yearsText(count) {
  return `${count} ${count === 1 ? 'year' : 'years'}`;
}

/**
 * A conservative text width, for collision checks that must agree between Node
 * and a browser. Digits and euro signs are wide in Manrope, so this leans wide:
 * a layout that clears this estimate clears the real text.
 */
function estimateTextWidth(text, fontPx, weight = 700) {
  return Math.ceil(String(text).length * fontPx * (weight >= 700 ? 0.62 : 0.58));
}

/**
 * The largest font, up to `maxFont` and down to `minFont`, at which the longest of
 * these texts fits `width` on one line by the estimate above.
 */
function fitFont(texts, maxFont, minFont, width, weight = 700) {
  const longest = Math.max(1, ...texts.map((text) => String(text).length));
  const perPx = longest * (weight >= 700 ? 0.62 : 0.58);
  return Math.max(minFont, Math.min(maxFont, Math.floor(width / perPx)));
}

/** How many lines a text takes in a box, by the same estimate. */
function linesFor(text, fontPx, weight, width) {
  return Math.max(1, Math.ceil(estimateTextWidth(text, fontPx, weight) / Math.max(1, width)));
}

function findCase(projection, caseId) {
  const { cases, baseScenarioId } = projection.debug;
  return cases.find((entry) => entry.id === caseId)
    || cases.find((entry) => entry.id === baseScenarioId)
    || cases[0];
}

/* ----------------------------------------------------------------------- words */

/** Every amount on the screen is the amount as shown, so what is said adds up. */
function sentenceFor(entry, debug) {
  const current = euroText(debug.shown.currentAnnualRepayments);
  const budget = euroText(entry.homeBudget);
  if (entry.kind === 'stay') {
    return `Staying keeps the home at ${budget}, with ${current} a year going on the mortgage.`;
  }
  if (entry.annualRepayment === 0) {
    return `With no mortgage the home budget is ${budget}, and all ${current} a year is freed.`;
  }
  const freed = entry.shownFreed > 0 ? `${euroText(entry.shownFreed)} a year freed` : 'nothing freed';
  return `Repaying ${euroText(entry.shownRepaid)} a year supports a loan of ${euroText(entry.block2)}: `
    + `a home budget of ${budget}, with ${freed}.`;
}

/** A year amount, "€12,000 a year", or "Nothing". */
function yearAmount(amount) {
  return amount > 0 ? `${euroText(amount)} a year` : 'Nothing';
}

/**
 * Every string the screen shows for one case.
 *
 * @param {object} projection what `computeHomeTradeDownProjection` returned
 * @param {string} caseId
 */
export function buildTradeDownCopy(projection, caseId) {
  const { debug } = projection;
  const { inputs, shown } = debug;
  const entry = findCase(projection, caseId);
  const stay = entry.kind === 'stay';
  const headline = sentenceFor(entry, debug);

  const block1 = stay
    ? {
      amount: euroText(entry.block1),
      name: 'Your share of the home',
      note: `${euroText(shown.homeValue)} less the ${euroText(shown.mortgageBalance)} mortgage`
    }
    : {
      amount: euroText(entry.block1),
      name: 'From selling, after buying costs',
      note: `${euroText(shown.released)} released, less ${euroText(shown.buyingCosts)} buying costs`
    };

  let block2Name = 'New loan';
  if (stay) {
    block2Name = 'Mortgage';
  } else if (entry.block2 === 0) {
    block2Name = 'No new loan';
  }

  const rateText = percentText(inputs.newLoanAnnualRate);
  const footnote = 'Education only. '
    + `New loans run ${yearsText(inputs.newLoanTermYears)} at ${rateText}, `
    + `and buying costs are ${euroText(shown.buyingCosts)}. `
    + 'Loans are rounded to the nearest €1,000. '
    + 'This shows what each case would change.';

  return {
    heading: HEADING,
    headline,
    footnote,
    groupLabel: 'Ways to trade down',
    buttons: debug.cases.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      subLine: `${candidate.kind === 'stay' ? 'Home' : 'Home budget'} ${euroText(candidate.homeBudget)}`
    })),
    figure: {
      value: euroText(entry.homeBudget),
      word: stay ? 'home worth' : 'home budget'
    },
    today: { label: 'Today’s home', value: euroText(shown.homeValue) },
    block1,
    block2: { amount: euroText(entry.block2), name: block2Name },
    freed: { value: entry.shownFreed > 0 ? euroText(entry.shownFreed) : '€0', word: 'freed each year' },
    rows: {
      repaid: { name: 'Still repaid', value: yearAmount(entry.shownRepaid) },
      freed: { name: 'Freed', value: yearAmount(entry.shownFreed) }
    },
    trackNote: `The full track is today’s ${euroText(shown.currentAnnualRepayments)} a year.`,
    chartLabel: `${headline} The bar is the home, in two blocks: ${block1.name.toLowerCase()} `
      + `and ${block2Name.toLowerCase()}. The track beside it is today’s repayments, `
      + 'split into what is still repaid and what is freed.',
    flags: { stay, hasLoan: entry.block2 > 0 }
  };
}

/** Every string a case puts on screen, flattened, for the words scan. */
export function collectTradeDownStrings(projection, caseId) {
  const copy = buildTradeDownCopy(projection, caseId);
  const out = [
    copy.heading, copy.headline, copy.footnote, copy.chartLabel, copy.groupLabel,
    copy.figure.value, copy.figure.word, copy.today.label, copy.today.value,
    copy.block1.amount, copy.block1.name, copy.block1.note,
    copy.block2.amount, copy.block2.name,
    copy.freed.value, copy.freed.word,
    copy.rows.repaid.name, copy.rows.repaid.value, copy.rows.freed.name, copy.rows.freed.value,
    copy.trackNote
  ];
  copy.buttons.forEach((button) => out.push(button.title, button.subLine));
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
    HOME_TRADE_DOWN_BANNED_PHRASES.forEach((pattern) => {
      if (pattern.test(text)) problems.push(`"${text}" matches ${pattern}`);
    });
    PROVIDER_NAMES.forEach((pattern) => {
      if (pattern.test(text)) problems.push(`"${text}" names a provider (${pattern})`);
    });
    // An amount of four or more digits with no thousands separator.
    if (/€\d{4,}/.test(text)) problems.push(`"${text}" has an amount without a thousands separator`);
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
 * be interpolated point by point:
 *
 *   [ blockOneWidth, blockTwoLeft, blockTwoWidth, labelTwoLeft,
 *     repaidWidth, freedLeft, freedWidth ]
 *
 * The bar's scale is today's home, always, so the same width means the same
 * euros in every case and nothing rescales on a click. The track's scale is
 * today's repayments.
 *
 * The second label sits under the second block, which begins where the first
 * ends. When the first block is too short to hold the first label's two lines
 * (the buying costs have taken most of the money from selling), the second
 * label moves right to clear them instead of meeting them.
 */
function caseValues(entry, copy, geometry) {
  const { barScale, trackWidth, homeValue, currentRepayments, k, narrow } = geometry;
  // Sized from the amounts as shown, so the marks are what the words say. A
  // scale of nothing (cents only) is no scale, not a division by zero.
  const bar = (amount) => (homeValue > 0 ? (amount / homeValue) * barScale : 0);
  const track = (amount) => (currentRepayments > 0 ? (amount / currentRepayments) * trackWidth : 0);

  const blockOne = bar(entry.block1);
  const blockTwo = bar(entry.block2);
  const repaid = track(entry.shownRepaid);
  const freed = track(entry.shownFreed);

  // How far the first label's amount and name reach, which is what the second
  // label must clear. The note is the third line and the second label has no
  // third line, so the note may run under it.
  const firstLabelReach = narrow
    ? k.labelOneWidth
    : Math.max(
      estimateTextWidth(copy.block1.amount, k.amountFont, 700),
      estimateTextWidth(copy.block1.name, k.nameFont, 500)
    );
  // Compact: the second label sits under the first, not beside it.
  const labelTwoLeft = k.name === 'compact'
    ? 0
    : Math.max(blockOne, firstLabelReach + LABEL_GAP_PX);

  return [blockOne, blockOne, blockTwo, labelTwoLeft, repaid, repaid, freed];
}

/**
 * The drawing's frame for a container width.
 *
 * @param {object} projection
 * @param {object} options
 * @param {number} options.width the module's width in px
 */
export function layoutTradeDownChart(projection, { width } = {}) {
  const { shown } = projection.debug;
  const wide = width >= WIDE_FROM_PX;
  const narrow = !wide;
  // The chart's width is the same in both stacked arrangements, so it is worked
  // out with the narrow padding first.
  const stackedWidth = Math.max(0, Math.min(width - (2 * NARROW.stagePad), NARROW_MAX_CHART_PX));
  const compact = narrow && stackedWidth < COMPACT_BELOW_PX;
  const k = wide ? WIDE : (compact ? COMPACT : NARROW);

  const chartWidth = wide
    ? Math.max(0, width - (2 * k.stagePad))
    : stackedWidth;

  let geometry;
  let boxes;

  if (wide) {
    const panelLeft = chartWidth - k.panelInset;
    const hairlineLeft = panelLeft - k.hairlineGap;
    const barScale = hairlineLeft - k.barToHairline;
    geometry = { barScale, trackWidth: k.panelWidth };
    boxes = {
      figure: { left: 0, top: k.figureTop, height: k.figureHeight },
      todayLine: { left: barScale, top: k.todayTop, height: k.todayHeight },
      todayLabel: { left: barScale + k.todayGap, top: k.todayTop },
      bar: { top: k.barTop, height: k.barHeight },
      labelOne: { left: 0, top: k.labelTop, width: k.labelOneWidth },
      labelTwo: { top: k.labelTop, width: k.labelTwoWidth },
      noteInLabel: true,
      noteFull: null,
      rule: { left: hairlineLeft, top: 0, height: k.hairlineHeight },
      freed: { left: panelLeft, top: k.freedTop, height: k.freedHeight },
      freedWord: { left: panelLeft, top: k.freedWordTop },
      track: { left: panelLeft, top: k.trackTop, width: k.panelWidth, height: k.trackHeight },
      rowRepaid: { left: panelLeft, top: k.row1Top, width: k.panelWidth, height: k.rowHeight },
      rowFreed: { left: panelLeft, top: k.row2Top, width: k.panelWidth, height: k.rowHeight },
      trackNote: { left: panelLeft, top: k.trackNoteTop, width: k.panelWidth }
    };
  } else if (compact) {
    geometry = { barScale: chartWidth, trackWidth: chartWidth };
    const allCases = projection.debug.cases.map((entry) => buildTradeDownCopy(projection, entry.id));
    boxes = {
      compact: true,
      // One font for the figure and one for the freed amount, whatever the case,
      // so a click never changes a size.
      figure: {
        left: 0,
        top: k.figureTop,
        height: k.figureHeight,
        font: fitFont(allCases.map((c) => c.figure.value), k.figureFont, k.figureMinFont, chartWidth)
      },
      todayLine: { left: chartWidth - 1, top: k.todayLineTop, height: k.todayLineHeight },
      todayLabel: { left: 0, top: k.todayLabelTop, width: chartWidth, height: k.todayLabelHeight },
      bar: { top: k.barTop, height: k.barHeight },
      // Two rows of two lines and one, each behind a swatch of its own block.
      labelOne: { left: 0, top: k.labelTop, width: chartWidth, height: k.labelOneHeight },
      labelTwo: { left: 0, top: k.labelTwoTop, width: chartWidth, height: k.labelTwoHeight },
      noteInLabel: false,
      noteFull: { left: 0, top: k.noteTop, width: chartWidth, height: k.noteHeight },
      rule: { left: 0, top: k.ruleTop, width: chartWidth },
      freed: {
        left: 0,
        top: k.freedTop,
        height: k.freedHeight,
        font: fitFont(allCases.map((c) => c.freed.value), k.freedFont, k.freedMinFont, chartWidth)
      },
      freedWord: { left: 0, top: k.freedTop },
      track: { left: 0, top: k.trackTop, width: chartWidth, height: k.trackHeight },
      rowRepaid: { left: 0, top: k.row1Top, width: chartWidth, height: k.rowHeight },
      rowFreed: { left: 0, top: k.row2Top, width: chartWidth, height: k.rowHeight },
      trackNote: { left: 0, top: k.trackNoteTop, width: chartWidth, height: k.trackNoteHeight }
    };
  } else {
    geometry = { barScale: chartWidth, trackWidth: chartWidth };
    boxes = {
      figure: { left: 0, top: k.figureTop, height: k.figureHeight },
      todayLine: { left: chartWidth - 1, top: k.todayLineTop, height: k.todayLineHeight },
      todayLabel: { left: 0, top: k.todayLabelTop, width: chartWidth, height: k.todayLabelHeight },
      bar: { top: k.barTop, height: k.barHeight },
      labelOne: { left: 0, top: k.labelTop, width: k.labelOneWidth },
      labelTwo: { top: k.labelTop, width: k.labelTwoWidth },
      noteInLabel: false,
      noteFull: { left: 0, top: k.noteTop, width: chartWidth, height: k.noteHeight },
      rule: { left: 0, top: k.ruleTop, width: chartWidth },
      freed: { left: 0, top: k.freedTop, height: k.freedHeight },
      freedWord: { left: 0, top: k.freedTop },
      track: { left: 0, top: k.trackTop, width: chartWidth, height: k.trackHeight },
      rowRepaid: { left: 0, top: k.row1Top, width: chartWidth, height: k.rowHeight },
      rowFreed: { left: 0, top: k.row2Top, width: chartWidth, height: k.rowHeight },
      trackNote: { left: 0, top: k.trackNoteTop, width: chartWidth, height: k.trackNoteHeight }
    };
  }

  const values = {};
  projection.debug.cases.forEach((entry) => {
    const copy = buildTradeDownCopy(projection, entry.id);
    values[entry.id] = caseValues(entry, copy, {
      ...geometry,
      homeValue: shown.homeValue,
      currentRepayments: shown.currentAnnualRepayments,
      k,
      narrow
    });
  });

  return {
    width,
    chartWidth,
    narrow,
    compact,
    constants: k,
    barScale: geometry.barScale,
    trackWidth: geometry.trackWidth,
    height: k.height,
    boxes,
    values
  };
}

/**
 * The stacked arrangement's figure, freed amount and two rows, each on one line:
 * none runs past the chart. The wide arrangement has its own room for them.
 */
function checkStackedFit(problems, copy, layout, label) {
  const { constants: k, chartWidth } = layout;
  const figure = estimateTextWidth(copy.figure.value, k.figureFont, 700)
    + 10 + estimateTextWidth(copy.figure.word, k.figureWordFont, 500);
  if (figure > chartWidth + 0.5) {
    problems.push(`${label}: the home figure and its word run past the chart (${figure} > ${chartWidth})`);
  }
  const freed = estimateTextWidth(copy.freed.value, k.freedFont, 700)
    + 10 + estimateTextWidth(copy.freed.word, k.freedWordFont, 500);
  if (freed > chartWidth + 0.5) {
    problems.push(`${label}: the freed figure and its word run past the chart (${freed} > ${chartWidth})`);
  }
  ['repaid', 'freed'].forEach((key) => {
    const row = estimateTextWidth(copy.rows[key].name, k.rowNameFont, 500)
      + estimateTextWidth(copy.rows[key].value, k.rowValueFont, 700);
    if (row + 8 > chartWidth) {
      problems.push(`${label}: the "${copy.rows[key].name}" row runs past the chart (${row} > ${chartWidth})`);
    }
  });
}

/**
 * The compact arrangement, case by case. Everything is stacked, so what must
 * hold is that each text fits its box and each box ends above the next one:
 * a figure on one line at the font chosen for it, the first name in two lines
 * at most, the note and the track note in two lines at most, and the rows' name
 * and amount on a line of their own each.
 */
function checkCompactCase(problems, copy, layout, label) {
  const { constants: k, chartWidth, boxes } = layout;
  const text = (value, font, weight) => estimateTextWidth(value, font, weight);
  const inLabel = chartWidth - SWATCH_INSET_PX;

  const figureFont = boxes.figure.font;
  if (text(copy.figure.value, figureFont, 700) > chartWidth + 0.5) {
    problems.push(`${label}: the home figure runs past the chart at ${figureFont}px`);
  }
  if (text(copy.figure.word, k.figureWordFont, 500) > chartWidth + 0.5) {
    problems.push(`${label}: the word under the home figure runs past the chart`);
  }
  const freedFont = boxes.freed.font;
  if (text(copy.freed.value, freedFont, 700) > chartWidth + 0.5) {
    problems.push(`${label}: the freed figure runs past the chart at ${freedFont}px`);
  }
  if (text(copy.freed.word, k.freedWordFont, 500) > chartWidth + 0.5) {
    problems.push(`${label}: the word under the freed figure runs past the chart`);
  }
  if (text(`${copy.today.label} ${copy.today.value}`, k.todayFont, 500) > chartWidth + 0.5) {
    problems.push(`${label}: "Today's home" and its amount run past the chart`);
  }

  // Labels: amount on one line, the first name in at most two, the second in one.
  if (text(copy.block1.amount, k.amountFont, 700) > inLabel + 0.5
    || text(copy.block2.amount, k.amountFont, 700) > inLabel + 0.5) {
    problems.push(`${label}: a label's amount runs past the chart`);
  }
  if (linesFor(copy.block1.name, k.nameFont, 500, inLabel) > 2) {
    problems.push(`${label}: the first label's name takes more than two lines`);
  }
  if (linesFor(copy.block2.name, k.nameFont, 500, inLabel) > 1) {
    problems.push(`${label}: the second label's name takes more than one line`);
  }
  if (linesFor(copy.block1.note, k.noteFont, 500, chartWidth) > 2) {
    problems.push(`${label}: the note under the labels takes more than two lines`);
  }
  if (linesFor(copy.trackNote, k.trackNoteFont, 500, chartWidth) > 2) {
    problems.push(`${label}: the note under the year takes more than two lines`);
  }

  // The year's rows: the name and the amount each on a line of their own.
  ['repaid', 'freed'].forEach((key) => {
    if (text(copy.rows[key].name, k.rowNameFont, 500) > chartWidth + 0.5
      || text(copy.rows[key].value, k.rowValueFont, 700) > chartWidth + 0.5) {
      problems.push(`${label}: the "${copy.rows[key].name}" row runs past the chart`);
    }
  });

  // Each box ends above the next one starts, and the last ends inside the chart.
  const column = [
    ['the home figure', boxes.figure.top, boxes.figure.top + boxes.figure.height],
    ['today\'s home', boxes.todayLabel.top, boxes.todayLabel.top + boxes.todayLabel.height],
    ['the bar', boxes.bar.top, boxes.bar.top + boxes.bar.height],
    ['the first label', boxes.labelOne.top, boxes.labelOne.top + boxes.labelOne.height],
    ['the second label', boxes.labelTwo.top, boxes.labelTwo.top + boxes.labelTwo.height],
    ['the note', boxes.noteFull.top, boxes.noteFull.top + boxes.noteFull.height],
    ['the year', boxes.freed.top, boxes.freed.top + boxes.freed.height],
    ['the track', boxes.track.top, boxes.track.top + boxes.track.height],
    ['the repaid row', boxes.rowRepaid.top, boxes.rowRepaid.top + boxes.rowRepaid.height],
    ['the freed row', boxes.rowFreed.top, boxes.rowFreed.top + boxes.rowFreed.height],
    ['the note under the year', boxes.trackNote.top, boxes.trackNote.top + boxes.trackNote.height]
  ];
  for (let i = 1; i < column.length; i += 1) {
    // Today's home sits above the bar and the bar is the line under it, so they
    // may touch; everything else must clear what is above it.
    if (column[i][1] < column[i - 1][2] - 0.5) {
      problems.push(`${label}: ${column[i][0]} starts above where ${column[i - 1][0]} ends`);
    }
  }
  if (column[column.length - 1][2] > layout.height + 0.5) {
    problems.push(`${label}: the last box ends below the chart`);
  }
}

/**
 * The checks the screen relies on: the blocks inside the bar and starting where
 * the last ended, the track repaid then freed, every label inside the chart and
 * clear of the one before it, and today's home clear of the year.
 * Returns a list of problems, empty when the layout holds.
 */
export function checkTradeDownLayout(projection, layout) {
  const problems = [];
  const { constants: k, chartWidth, boxes } = layout;
  const where = `at ${layout.width}`;

  if (!(layout.barScale > 0)) {
    problems.push(`${where}: the bar has no width`);
  }
  if (layout.barScale > chartWidth + 0.5) {
    problems.push(`${where}: the bar is wider than the chart`);
  }

  projection.debug.cases.forEach((entry) => {
    const copy = buildTradeDownCopy(projection, entry.id);
    const [blockOne, blockTwoLeft, blockTwo, labelTwoLeft, repaid, freedLeft, freed] = layout.values[entry.id];
    const label = `${entry.id} ${where}`;

    if (blockOne < -0.5 || blockOne + blockTwo > layout.barScale + 0.5) {
      problems.push(`${label}: the blocks leave the bar (${(blockOne + blockTwo).toFixed(1)} > ${layout.barScale.toFixed(1)})`);
    }
    if (Math.abs(blockTwoLeft - blockOne) > 0.01) {
      problems.push(`${label}: the second block does not start where the first ends`);
    }
    if (repaid + freed > layout.trackWidth + 0.5 || Math.abs(freedLeft - repaid) > 0.01) {
      problems.push(`${label}: the track is not repaid then freed`);
    }

    if (layout.compact) {
      checkCompactCase(problems, copy, layout, label);
      return;
    }

    // The second label clears the first label's amount and name.
    const firstReach = layout.narrow
      ? k.labelOneWidth
      : Math.max(
        estimateTextWidth(copy.block1.amount, k.amountFont, 700),
        estimateTextWidth(copy.block1.name, k.nameFont, 500)
      );
    if (labelTwoLeft < firstReach + LABEL_GAP_PX - 0.5) {
      problems.push(`${label}: the second label meets the first (${labelTwoLeft.toFixed(1)} < ${firstReach + LABEL_GAP_PX})`);
    }
    // ... and stays inside the chart, wrapping within what is left if it must.
    const secondReach = Math.max(
      estimateTextWidth(copy.block2.amount, k.amountFont, 700),
      layout.narrow ? 0 : estimateTextWidth(copy.block2.name, k.nameFont, 500)
    );
    if (labelTwoLeft + secondReach > chartWidth + 0.5) {
      problems.push(`${label}: the second label runs past the chart`);
    }
    // The first label's name must be able to sit under the first block, or the
    // second label has already moved clear of it.
    if (!layout.narrow && entry.block2 > 0 && labelTwoLeft < blockOne - 0.5) {
      problems.push(`${label}: the second label has moved left of its block`);
    }
    if (layout.narrow) {
      checkStackedFit(problems, copy, layout, label);
    }
  });

  if (!layout.narrow) {
    // Today's home sits between the bar's end and the year's hairline.
    const { today } = buildTradeDownCopy(projection, projection.debug.baseScenarioId);
    const todayWidth = Math.max(
      estimateTextWidth(today.label, k.todayFont, 500),
      estimateTextWidth(today.value, k.todayValueFont, 700)
    );
    if (boxes.todayLabel.left + todayWidth > boxes.rule.left - 8) {
      problems.push(`${where}: "Today's home" runs into the year`);
    }
    if (boxes.track.left + boxes.track.width > chartWidth + 2.5) {
      problems.push(`${where}: the year runs past the chart`);
    }
  }

  return problems;
}
