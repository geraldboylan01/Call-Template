/**
 * THE PROTECTION GAP SCREEN: everything it decides that is not a DOM node.
 *
 * The screen answers one question: if one income stopped, how big is the hole,
 * and how long would savings fill it? It has two pictures, one above the other:
 *
 *   HOW BIG IS THE HOLE   a bar of what comes in, built from the State floor and
 *                         each take-home, against what you need. The gap is the
 *                         space between the end of the bar and the need tick.
 *   HOW LONG SAVINGS FILL IT   a strip of 36 months. The green runs for as many
 *                         months as savings last, and red is what is short.
 *
 * This file holds the words, the geometry for any container width, and where
 * every label sits, with the checks that nothing overlaps. It is pure, so a
 * check can ask it without a browser. `js/protection_gap_module.js` draws.
 *
 * WHAT THIS FILE DOES NOT DO. It does not solve anything and it does not write
 * the answer, the sentence or the footnote: those come from the engine
 * (`computeProtectionGapProjection`), so the screen, the video and any summary
 * read the same words. The client is "you".
 *
 * ONE SCALE. Every amount is drawn on the module's own scale, `scaleMax`, the
 * same in every case, so nothing rescales on a click. The container's height is
 * the same in every case too, so nothing below it moves.
 */

import { PROTECTION_GAP_HORIZON_MONTHS, euroText } from './protection_gap_math.js';

/* ------------------------------------------------------------------ constants */

/** Content width at which the case buttons sit in a rail beside the chart. */
export const RAIL_MIN_WIDTH = 1100;

/** Content width at which four buttons fit in one row above the chart. */
export const ROW_MIN_WIDTH = 760;

/** A scrollbar appearing narrows the module by about this much, so a line holds. */
export const HYSTERESIS_PX = 16;

/** Under this chart width the narrow type and heights are used. */
const NARROW_BELOW_PX = 720;

const RAIL_PX = 360;
const RAIL_GAP_PX = 116;
const RIGHT_INSET_PX = 20;
const MIN_CHART_PX = 240;

/** Clear space between two labels on one row. */
const LABEL_GAP_PX = 8;

const WIDE = Object.freeze({
  name: 'wide',
  barHeight: 80,
  labelHeight: 58,
  labelFont: 18,
  amountFont: 30,
  rowGap: 6,
  bracketHeight: 8,
  bracketLift: 6,
  tickOver: 14,
  segNameFont: 18,
  segAmountFont: 28,
  segFloorFont: 16,
  segFloorAmountFont: 26,
  segPad: 14,
  outsideNameFont: 16,
  outsideAmountFont: 22,
  scaleFont: 18,
  scaleHeight: 22,
  stripHeight: 160,
  stripFont: 30,
  stripPad: 24,
  endHeight: 96,
  endLeadFont: 20,
  endBigFont: 64,
  axisFont: 20,
  axisHeight: 24
});

const NARROW = Object.freeze({
  name: 'narrow',
  barHeight: 56,
  labelHeight: 46,
  labelFont: 15,
  amountFont: 20,
  rowGap: 6,
  bracketHeight: 8,
  bracketLift: 6,
  tickOver: 10,
  segNameFont: 14,
  segAmountFont: 20,
  segFloorFont: 14,
  segFloorAmountFont: 20,
  segPad: 8,
  outsideNameFont: 14,
  outsideAmountFont: 18,
  scaleFont: 14,
  scaleHeight: 18,
  stripHeight: 96,
  stripFont: 16,
  stripPad: 12,
  endHeight: 62,
  endLeadFont: 15,
  endBigFont: 32,
  axisFont: 15,
  axisHeight: 20
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
  /\bcover(s|ed|ing|age)?\b/i,
  /premium/i,
  /\bpolic(y|ies)\b/i,
  /insur/i,
  /\bquote/i,
  /income protection/i,
  /serious illness/i,
  /\b(he|she|his|her|hers|him)\b/i,
  /the household/i,
  /the client/i
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

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const sum = (list) => list.reduce((total, value) => total + value, 0);

/**
 * A conservative text width, for collision checks that must agree between Node
 * and a browser. Digits and euro signs are wide in Manrope, so this leans wide.
 */
function estimateTextWidth(text, fontPx, weight = 700) {
  return Math.ceil(String(text).length * fontPx * (weight >= 700 ? 0.62 : 0.58));
}

function monthsPhrase(count) {
  return `${count} ${count === 1 ? 'month' : 'months'}`;
}

/* ----------------------------------------------------------------------- words */

/**
 * Every client-facing string the screen adds to what the engine wrote.
 *
 * @param {object} projection `computeProtectionGapProjection(...)`
 * @param {string} caseId
 * @param {object} [options]
 * @param {boolean} [options.narrow] the phone wording (a shorter lead on the strip)
 */
export function buildProtectionGapCopy(projection, caseId, { narrow = false } = {}) {
  const { cases, inputs, footnote } = projection.debug;
  const entry = cases.find((candidate) => candidate.id === caseId) || cases[0];
  const savings = euroText(inputs.savings);

  const segments = entry.segments.map((segment) => {
    if (segment.kind === 'floor') {
      const words = segment.label.split(' ');
      return {
        id: segment.id,
        kind: 'floor',
        label: segment.label,
        lines: [words[0], words.slice(1).join(' ')].filter(Boolean),
        amountText: euroText(segment.amount)
      };
    }
    return {
      id: segment.id,
      kind: 'takeHome',
      label: segment.label,
      lines: [segment.label],
      amountText: euroText(segment.amount)
    };
  });

  let gap = null;
  if (entry.status === 'short') {
    gap = { title: 'Gap', amountText: `${euroText(entry.gap)} a year` };
  } else if (entry.status === 'left_over') {
    gap = { title: 'Left over', amountText: `${euroText(entry.spare)} a year` };
  }

  let end = null;
  if (entry.status === 'short') {
    let text;
    if (entry.beyond) {
      text = 'Beyond three years';
    } else if (inputs.savings > 0 && entry.months === 0) {
      text = 'Less than a month';
    } else {
      text = monthsPhrase(entry.months);
    }
    end = {
      lead: narrow ? 'Your savings last' : `Your savings of ${savings} would last`,
      text
    };
  }

  const hasEvent = Boolean(entry.event);
  const answer = `${entry.headline.line1} ${entry.headline.line2}`;
  const barLabel = `${answer} What comes in is ${euroText(entry.moneyIn)} a year and what you need is ${euroText(entry.needed)} a year.`;

  return {
    module: 'Protection gap',
    household: inputs.householdLabel || '',
    savingsLine: `Your savings ${savings}`,
    headline: entry.headline,
    sentence: entry.sentence,
    footnote,
    statusWord: entry.statusWord,
    isTight: entry.status === 'tight',
    buttons: cases.map((candidate) => ({ id: candidate.id, title: candidate.title })),
    casesLabel: 'What changes',
    captions: {
      bar: 'How big is the hole, in € a year',
      strip: 'How long your savings fill it'
    },
    bar: {
      moneyIn: { title: 'What comes in', amountText: euroText(entry.moneyIn) },
      need: { title: 'What you need', amountText: euroText(entry.needed) },
      gap,
      scaleStart: '0',
      scaleEnd: euroText(projection.debug.scaleMax).replace('€', ''),
      ariaLabel: barLabel
    },
    segments,
    strip: {
      filled: ['Filled by your savings', 'Filled'],
      short: ['Short'],
      nothing: 'Nothing to fill',
      startText: hasEvent ? 'Income stops' : 'Today',
      axis: ['1 year', '2 years', '3 years'],
      end,
      ariaLabel: end
        ? `${end.lead} ${end.text}. ${entry.headline.line1}`
        : `There is nothing for your savings to fill. ${entry.headline.line1}`
    }
  };
}

/** Every string a case puts on screen, flattened, for the words scan. */
export function collectProtectionGapStrings(projection, caseId) {
  const out = [];
  [false, true].forEach((narrow) => {
    const copy = buildProtectionGapCopy(projection, caseId, { narrow });
    out.push(
      copy.module, copy.household, copy.savingsLine, copy.headline.line1, copy.headline.line2,
      copy.sentence, copy.footnote, copy.statusWord, copy.casesLabel,
      copy.captions.bar, copy.captions.strip,
      copy.bar.moneyIn.title, copy.bar.moneyIn.amountText,
      copy.bar.need.title, copy.bar.need.amountText, copy.bar.scaleStart, copy.bar.scaleEnd,
      copy.bar.ariaLabel, copy.strip.ariaLabel, copy.strip.nothing, copy.strip.startText
    );
    if (copy.bar.gap) out.push(copy.bar.gap.title, copy.bar.gap.amountText);
    if (copy.strip.end) out.push(copy.strip.end.lead, copy.strip.end.text);
    copy.buttons.forEach((button) => out.push(button.title));
    copy.segments.forEach((segment) => out.push(segment.label, segment.amountText, ...segment.lines));
    out.push(...copy.strip.filled, ...copy.strip.short, ...copy.strip.axis);
  });
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
  });
  return problems;
}

/* --------------------------------------------------------------- the arrangement */

/**
 * How the case buttons are arranged: a `rail` beside the chart, a `row` of four
 * above it, or a 2x2 `grid`.
 *
 * With no `previous`, the lines are sharp. With one, a width within the
 * hysteresis of the line between two neighbouring arrangements keeps the one
 * already showing, so a scrollbar appearing does not flip the layout back and
 * forth.
 *
 * @param {number} width the module's own content width
 * @param {string|null} [previous]
 */
export function chooseButtonLayout(width, previous = null) {
  const order = ['grid', 'row', 'rail'];
  const lines = [ROW_MIN_WIDTH, RAIL_MIN_WIDTH];
  let fresh = 'grid';
  if (width >= RAIL_MIN_WIDTH) fresh = 'rail';
  else if (width >= ROW_MIN_WIDTH) fresh = 'row';

  const before = order.indexOf(previous);
  const now = order.indexOf(fresh);
  if (before >= 0 && Math.abs(before - now) === 1) {
    const line = lines[Math.min(before, now)];
    if (Math.abs(width - line) < HYSTERESIS_PX) return previous;
  }
  return fresh;
}

/* --------------------------------------------------------------------- geometry */

/**
 * Put a list of labels into rows, left to right, so none overlaps another on a
 * row. A label keeps its preferred place when it can, is pushed right past
 * whatever it would touch, and drops to the next row when that would take it off
 * the chart or away from the mark it names (`anchor`).
 *
 * Sets `left` and `row` on each item. Returns the number of rows used.
 */
function placeInRows(items, chartWidth) {
  const rows = [];
  let used = 0;
  items.forEach((item) => {
    for (let row = 0; row < 8; row += 1) {
      rows[row] = rows[row] || [];
      let left = clamp(item.preferredLeft, 0, Math.max(0, chartWidth - item.width));
      let moved = true;
      while (moved) {
        moved = false;
        rows[row].forEach((placed) => {
          if (left < placed.right + LABEL_GAP_PX && left + item.width + LABEL_GAP_PX > placed.left) {
            left = placed.right + LABEL_GAP_PX;
            moved = true;
          }
        });
      }
      const onChart = left + item.width <= chartWidth + 0.5;
      const holdsAnchor = item.anchor === undefined
        || (left <= item.anchor + 1 && left + item.width >= item.anchor - 1);
      if ((onChart && holdsAnchor) || row === 7) {
        item.left = left;
        item.row = row;
        rows[row].push({ left, right: left + item.width });
        used = Math.max(used, row + 1);
        return;
      }
    }
  });
  return used;
}

function labelWidth(k, title, amountText) {
  return Math.max(
    estimateTextWidth(title, k.labelFont, 500),
    estimateTextWidth(amountText, k.amountFont, 700)
  ) + 4;
}

/**
 * Where the labels on the bar go, for one set of drawn values.
 *
 * `values` is `[...segment widths, needX, fillWidth]` in px. A segment whose
 * text fits is labelled inside it; one that does not (the State payment on a
 * phone) is labelled just below the bar, at its start.
 */
function planBarLabels(base, copy, values) {
  const { k, chartWidth, slots } = base;
  const count = slots.length;
  const widths = values.slice(0, count);
  const needX = values[count];
  const inX = sum(widths);
  const gapLeft = Math.min(inX, needX);
  const gapWidth = Math.abs(inX - needX);

  const inside = {};
  const outside = [];
  let cursor = 0;
  slots.forEach((slot, index) => {
    const width = widths[index];
    const spec = copy.segments[index];
    if (width < 1) {
      inside[slot.id] = 'none';
    } else {
      const nameFont = spec.kind === 'floor' ? k.segFloorFont : k.segNameFont;
      const amountFont = spec.kind === 'floor' ? k.segFloorAmountFont : k.segAmountFont;
      const longest = Math.max(
        ...spec.lines.map((line) => estimateTextWidth(line, nameFont, 600)),
        estimateTextWidth(spec.amountText, amountFont, 700)
      );
      if (width >= longest + (2 * k.segPad)) {
        inside[slot.id] = 'in';
      } else {
        inside[slot.id] = 'out';
        outside.push({
          key: `seg:${slot.id}`,
          title: spec.label,
          amountText: spec.amountText,
          preferredLeft: cursor,
          width: Math.max(
            estimateTextWidth(spec.label, k.outsideNameFont, 600),
            estimateTextWidth(spec.amountText, k.outsideAmountFont, 700)
          ) + 4
        });
      }
    }
    cursor += width;
  });

  const above = [{
    key: 'moneyIn',
    title: copy.bar.moneyIn.title,
    amountText: copy.bar.moneyIn.amountText,
    preferredLeft: 0,
    width: labelWidth(k, copy.bar.moneyIn.title, copy.bar.moneyIn.amountText)
  }];
  if (copy.bar.gap) {
    const width = labelWidth(k, copy.bar.gap.title, copy.bar.gap.amountText);
    above.push({
      key: 'gap',
      title: copy.bar.gap.title,
      amountText: copy.bar.gap.amountText,
      preferredLeft: gapLeft + (gapWidth / 2) - (width / 2),
      width
    });
  }

  const needWidth = labelWidth(k, copy.bar.need.title, copy.bar.need.amountText);
  const below = [
    ...outside,
    {
      key: 'need',
      title: copy.bar.need.title,
      amountText: copy.bar.need.amountText,
      preferredLeft: needX - (needWidth / 2),
      width: needWidth,
      anchor: needX
    }
  ];

  const rowsAbove = placeInRows(above, chartWidth);
  const rowsBelow = placeInRows(below, chartWidth);
  return { above, below, rowsAbove, rowsBelow, inside, inX, needX, gapLeft, gapWidth };
}

/**
 * The geometry for a module `width` px wide.
 *
 * @param {object} projection `computeProtectionGapProjection(...)`
 * @param {object} options
 * @param {number} options.width the module's own content width
 * @param {string} [options.mode] force an arrangement (otherwise from the width)
 */
export function layoutProtectionGap(projection, { width, mode = null } = {}) {
  const { cases, scaleMax } = projection.debug;
  const resolvedMode = mode || chooseButtonLayout(width);
  const chartWidth = Math.max(
    MIN_CHART_PX,
    Math.round(resolvedMode === 'rail' ? width - RAIL_PX - RAIL_GAP_PX - RIGHT_INSET_PX : width)
  );
  const narrow = chartWidth < NARROW_BELOW_PX;
  const k = narrow ? NARROW : WIDE;

  const pxPerEuro = chartWidth / scaleMax;
  const cell = chartWidth / PROTECTION_GAP_HORIZON_MONTHS;
  const slots = cases[0].segments.map((segment) => ({ id: segment.id, kind: segment.kind }));
  const base = { mode: resolvedMode, width, chartWidth, narrow, k, slots, scaleMax, pxPerEuro, cell };

  // Settled values for every case: segment widths, where the need tick is, and
  // how far the green runs. These are what a click travels between.
  const values = {};
  let rowsAbove = 1;
  let rowsBelow = 1;
  cases.forEach((entry) => {
    const fillWidth = entry.status !== 'short'
      ? 0
      : (entry.beyond ? chartWidth : entry.months * cell);
    values[entry.id] = [
      ...entry.segments.map((segment) => segment.amount * pxPerEuro),
      entry.needed * pxPerEuro,
      fillWidth
    ];
    const copy = buildProtectionGapCopy(projection, entry.id, { narrow });
    const plan = planBarLabels(base, copy, values[entry.id]);
    rowsAbove = Math.max(rowsAbove, plan.rowsAbove);
    rowsBelow = Math.max(rowsBelow, plan.rowsBelow);
  });

  // The same height in every case: rows are reserved for the worst case.
  const rowHeight = k.labelHeight + k.rowGap;
  const bar = {};
  bar.rowsAbove = rowsAbove;
  bar.rowsBelow = rowsBelow;
  bar.rowHeight = rowHeight;
  bar.aboveHeight = rowsAbove * rowHeight;
  bar.bracketTop = bar.aboveHeight + 2;
  bar.barTop = bar.bracketTop + k.bracketHeight + k.bracketLift;
  bar.barBottom = bar.barTop + k.barHeight;
  bar.tickTop = bar.bracketTop;
  bar.tickBottom = bar.barBottom + k.tickOver;
  bar.belowTop = bar.tickBottom + 2;
  bar.scaleTop = bar.belowTop + (rowsBelow * rowHeight) + 2;
  bar.height = bar.scaleTop + k.scaleHeight;

  const strip = {};
  strip.endHeight = k.endHeight;
  strip.tickTop = k.endHeight;
  strip.top = k.endHeight + 8;
  strip.tickHeight = (strip.top - strip.tickTop) + 12;
  strip.bottom = strip.top + k.stripHeight;
  strip.axisTickTop = strip.bottom;
  strip.axisLabelTop = strip.bottom + 14;
  strip.height = strip.axisLabelTop + k.axisHeight;

  const dividers = [];
  for (let month = 1; month < PROTECTION_GAP_HORIZON_MONTHS; month += 1) {
    dividers.push({ x: month * cell, year: month % 12 === 0 });
  }

  return { ...base, values, bar, strip, dividers, months: PROTECTION_GAP_HORIZON_MONTHS };
}

/** The drawn values of one case. */
export function valuesForCase(layout, caseId) {
  return layout.values[caseId];
}

/** Interpolate two value lists of the same length. Exact at both ends. */
export function lerpValues(from, to, progress) {
  if (progress <= 0) return from.slice();
  if (progress >= 1) return to.slice();
  return from.map((value, index) => value + ((to[index] - value) * progress));
}

/** Where the bar's marks are, for a set of drawn values. */
export function deriveBarGeometry(layout, values) {
  const count = layout.slots.length;
  let left = 0;
  const segments = layout.slots.map((slot, index) => {
    const width = values[index];
    const placed = { id: slot.id, kind: slot.kind, left, width };
    left += width;
    return placed;
  });
  const inX = left;
  const needX = values[count];
  return {
    segments,
    inX,
    needX,
    gapLeft: Math.min(inX, needX),
    gapWidth: Math.abs(inX - needX)
  };
}

/** The bar's labels with their rows turned into a `top`, for a set of drawn values. */
export function placeBarLabels(layout, caseId, values, copy) {
  const plan = planBarLabels(layout, copy, values);
  const { bar } = layout;
  const lastAbove = bar.rowsAbove - 1;
  const lastBelow = bar.rowsBelow - 1;
  plan.above.forEach((item) => {
    // Row 0 is the row nearest the bracket, so extra rows stack upward.
    item.top = (lastAbove - Math.min(item.row, lastAbove)) * bar.rowHeight;
  });
  plan.below.forEach((item) => {
    item.top = bar.belowTop + (Math.min(item.row, lastBelow) * bar.rowHeight);
  });
  return plan;
}

/** The words inside the strip and the mark where the green ends, for drawn values. */
export function placeStripWords(layout, values, copy) {
  const { k, chartWidth, slots } = layout;
  const fillWidth = values[slots.length + 1];
  const shortWidth = Math.max(0, chartWidth - fillWidth);
  const fits = (candidates, available) => candidates.find(
    (text) => estimateTextWidth(text, k.stripFont, 600) + (2 * k.stripPad) <= available
  ) || null;

  const hasEnd = Boolean(copy.strip.end);
  const filledText = hasEnd ? fits(copy.strip.filled, fillWidth) : null;
  const shortText = hasEnd ? fits(copy.strip.short, shortWidth) : null;

  let end = null;
  if (hasEnd) {
    const width = Math.max(
      estimateTextWidth(copy.strip.end.lead, k.endLeadFont, 500),
      estimateTextWidth(copy.strip.end.text, k.endBigFont, 800)
    ) + 4;
    end = {
      lead: copy.strip.end.lead,
      text: copy.strip.end.text,
      width,
      left: clamp(fillWidth - 12 - width, 0, Math.max(0, chartWidth - width)),
      tickLeft: clamp(fillWidth - 1, 0, chartWidth - 2)
    };
  }

  return {
    fillWidth,
    shortWidth,
    filled: filledText ? { text: filledText, left: k.stripPad } : null,
    short: shortText ? { text: shortText, left: fillWidth + k.stripPad } : null,
    nothing: hasEnd ? null : { text: copy.strip.nothing, left: k.stripPad },
    end
  };
}

/** The axis under the strip: a tick and a name at 0, 12, 24 and 36 months. */
export function stripAxis(layout, copy) {
  const { cell, chartWidth } = layout;
  return [
    { x: 0, align: 'left', text: copy.strip.startText },
    { x: 12 * cell, align: 'center', text: copy.strip.axis[0] },
    { x: 24 * cell, align: 'center', text: copy.strip.axis[1] },
    { x: chartWidth, align: 'right', text: copy.strip.axis[2] }
  ];
}

/**
 * Check a label plan. Returns a list of problems, empty when clean: a label off
 * the chart, two on one row that touch, or the need label no longer over its tick.
 */
export function checkLabelPlacement(layout, plan) {
  const problems = [];
  [['above', plan.above], ['below', plan.below]].forEach(([where, items]) => {
    items.forEach((item) => {
      if (item.left < -0.5 || item.left + item.width > layout.chartWidth + 0.5) {
        problems.push(`${item.key} (${where}) is off the chart`);
      }
    });
    items.forEach((a, i) => {
      items.forEach((b, j) => {
        if (j <= i || a.row !== b.row) return;
        const apart = a.left + a.width + LABEL_GAP_PX <= b.left + 0.5
          || b.left + b.width + LABEL_GAP_PX <= a.left + 0.5;
        if (!apart) problems.push(`${a.key} and ${b.key} (${where}) touch on row ${a.row}`);
      });
    });
  });
  const need = plan.below.find((item) => item.key === 'need');
  if (need && !(need.left <= plan.needX + 1 && need.left + need.width >= plan.needX - 1)) {
    problems.push('the need label is no longer over its tick');
  }
  return problems;
}
