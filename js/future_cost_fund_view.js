/**
 * THE FUTURE COST FUND, AS A VIEW: WHAT IT SAYS AND WHERE IT SITS.
 *
 * Everything the screen decides that is not a DOM node lives here, so a check
 * can ask it the same questions the screen asks and no DOM is needed to do it.
 * `js/future_cost_fund_module.js` draws what this file works out.
 *
 *   - the WORDS: the headline, the support line, the case buttons, every direct
 *     label and the footnote, in the "you" voice, built from the model and never
 *     typed;
 *   - the GEOMETRY: the year columns, the axis, the cost panel, the cost blocks
 *     and the fund polyline, for any container width;
 *   - the LABEL PLACEMENT: where each direct label sits against the fund line,
 *     so that none overlaps another or the line.
 *
 * The screen is the fund over the years. It rises as money goes in, peaks when
 * the cost starts, and the cost then takes it out in labelled blocks. The cost
 * never moves when the case changes, only the path to it does.
 *
 * WHAT THIS FILE DOES NOT DO. It does not solve anything. Every amount comes
 * from `computeFutureCostFundProjection`, and every rate on screen is read from
 * the projection's `assumptionsUsed`.
 */

import { euroText, percentText, roundToHundred } from './future_cost_fund_math.js';

/* ------------------------------------------------------------------ constants */

/** Points drawn per year: the riser, then the line growing over the year. */
export const SAMPLES_PER_YEAR = 8;

/** Under this container width the narrow layout is used. */
export const NARROW_BELOW_PX = 720;

/** The fund never reaches above this share of the axis, so labels have room. */
export const PEAK_SHARE_OF_AXIS = 0.8;

const NICE_STEPS = Object.freeze([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8]);

const NUMBER_WORDS = Object.freeze([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'
]);

/** The two sets of constants the drawing uses. */
const WIDE = Object.freeze({
  name: 'wide',
  gutter: 96,
  axisHeight: 44,
  labelFont: 22,
  labelHeight: 30,
  labelClearance: 46,
  labelGap: 14,
  yearlyGap: 10,
  blockInset: 6,
  blockTextFont: 22,
  blockTextMinWidth: 72,
  fundFont: 18,
  fundHeight: 26,
  gapFont: 20,
  gapHeight: 28,
  panelInsideMinWidth: 300,
  headerPad: 20,
  headerTop: 18
});

const NARROW = Object.freeze({
  name: 'narrow',
  gutter: 10,
  axisHeight: 30,
  labelFont: 14,
  labelHeight: 20,
  labelClearance: 30,
  labelGap: 6,
  yearlyGap: 6,
  blockInset: 2,
  blockTextFont: 0,
  blockTextMinWidth: Infinity,
  fundFont: 12,
  fundHeight: 32,
  gapFont: 12,
  gapHeight: 32,
  panelInsideMinWidth: 100,
  headerPad: 8,
  headerTop: 8
});

/** The phrases that must never reach a client, and the names of providers. */
const BANNED_PHRASES = Object.freeze([
  /\bwe recommend\b/i,
  /\byou should\b/i,
  /\bbest option\b/i,
  /\bbest\b/i,
  /\bideal\b/i,
  /\boptimal\b/i,
  /\bp\.a\./i
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

const euro = (amount) => euroText(roundToHundred(amount));

function yearsPhrase(count) {
  return `${count} ${count === 1 ? 'year' : 'years'}`;
}

/** "four-year" for 1 to 10 and "12-year" above. */
function yearAdjective(count) {
  const word = count >= 0 && count <= 10 ? NUMBER_WORDS[count] : String(count);
  return `${word}-year`;
}

/**
 * A conservative text width, for collision checks that must agree between Node
 * and a browser. Digits and euro signs are wide in Manrope, so this leans wide:
 * a layout that clears this estimate clears the real text.
 */
export function estimateTextWidth(text, fontPx, weight = 700) {
  return Math.ceil(String(text).length * fontPx * (weight >= 700 ? 0.62 : 0.58));
}

/** An axis amount. Whole euros up to a million, then "€1.5m". */
function axisEuro(amount) {
  if (amount >= 1_000_000) {
    const millions = amount / 1_000_000;
    const text = Number.isInteger(millions) ? String(millions) : millions.toFixed(1).replace(/\.0$/, '');
    return `€${text}m`;
  }
  return euroText(amount);
}

/**
 * The smallest "nice" axis maximum that keeps the largest balance at or under
 * 80% of the axis. Chosen over ALL cases, never per case, so the axis does not
 * rescale when the client clicks.
 */
export function chooseAxisMaximum(peak) {
  const needed = Math.max(1, peak / PEAK_SHARE_OF_AXIS);
  for (let power = 0; power < 14; power += 1) {
    for (const step of NICE_STEPS) {
      const candidate = step * (10 ** power);
      if (candidate >= needed) return candidate;
    }
  }
  return needed;
}

/* ----------------------------------------------------------------------- model */

/**
 * The projection, reduced to what the view reads. Cheap: it only reads.
 *
 * @param {object} projection what `computeFutureCostFundProjection` returned
 */
export function readFundModel(projection) {
  const { debug } = projection;
  const { inputs, costYears, cases, assumptionsUsed } = debug;
  return {
    inputs,
    costYears,
    cases,
    baseScenarioId: debug.baseScenarioId,
    totalCost: debug.totalCost,
    rates: {
      price: assumptionsUsed.priceGrowthRate,
      cashGross: assumptionsUsed.cashRateGross,
      dirt: assumptionsUsed.dirtRate,
      cashNet: assumptionsUsed.cashRateNet
    },
    columns: inputs.startsInYears + inputs.durationYears
  };
}

function findCase(model, caseId) {
  return model.cases.find((entry) => entry.id === caseId)
    || model.cases.find((entry) => entry.id === model.baseScenarioId)
    || model.cases[0];
}

/* ----------------------------------------------------------------------- words */

/**
 * Every string the screen shows for one case.
 *
 * The voice is "you", and a headline DESCRIBES the case rather than instructing:
 * "Putting in €10,800 a year for 8 years covers the whole cost."
 *
 * @param {object} projection
 * @param {string} caseId
 * @param {object} [options]
 * @param {boolean} [options.narrow] the phone wording (shorter direct labels)
 */
export function buildFundCopy(projection, caseId, { narrow = false } = {}) {
  const model = readFundModel(projection);
  const entry = findCase(model, caseId);
  const { inputs, rates } = model;

  const total = roundToHundred(model.totalCost);
  const paid = roundToHundred(entry.paidIn);
  // Total minus paid in AS SHOWN, never rounded on its own, so it adds up.
  const growth = total - paid;

  const hasLump = entry.lumpShare > 0;
  const hasYearly = entry.lumpShare < 1 && entry.savingYears > 0;
  const lumpAmount = euro(entry.lumpSumToday);
  const yearlyAmount = euro(entry.yearlyAmount);
  const savingStart = entry.savingStartsInYears;

  const startingIn = savingStart > 0 ? `, starting in year ${savingStart},` : '';
  let phrase;
  if (hasLump && !hasYearly) {
    phrase = `Setting aside ${lumpAmount} today`;
  } else if (!hasLump && hasYearly) {
    phrase = `Putting in ${yearlyAmount} a year for ${yearsPhrase(entry.savingYears)}${startingIn}`;
  } else {
    phrase = `Putting in ${lumpAmount} today and ${yearlyAmount} a year for ${yearsPhrase(entry.savingYears)}${startingIn}`;
  }
  const headline = `${phrase} covers the whole cost.`;

  const support = growth > 0
    ? `You pay in ${euro(paid)} and growth adds ${euro(growth)}. Together that is the ${euro(total)} you need.`
    : `You pay in ${euro(paid)}, which is the whole ${euro(total)} you need.`;

  const priceSentence = inputs.costKind === 'education'
    ? `Education costs rise ${percentText(rates.price)} a year.`
    : `Prices rise ${percentText(rates.price)} a year.`;
  const footnote = [
    `${euroText(inputs.annualCostToday)} a year in today’s money.`,
    priceSentence,
    `Your savings earn ${percentText(rates.cashGross)} a year before DIRT, and ${percentText(rates.cashNet)} after DIRT at ${percentText(rates.dirt)}.`,
    'Amounts are rounded to the nearest €100.'
  ].join(' ');

  const buttons = model.cases.map((item) => {
    const itemLump = item.lumpShare > 0;
    const itemYearly = item.lumpShare < 1 && item.savingYears > 0;
    let amountLine;
    if (itemLump && !itemYearly) {
      amountLine = `${euro(item.lumpSumToday)} today`;
    } else if (!itemLump && itemYearly) {
      amountLine = `${euro(item.yearlyAmount)} a year for ${yearsPhrase(item.savingYears)}`;
    } else {
      amountLine = `${euro(item.lumpSumToday)} today and ${euro(item.yearlyAmount)} a year`;
    }
    return { id: item.id, title: item.title, amountLine };
  });

  const costByYear = `The cost by year: ${model.costYears
    .map((year) => `year ${year.yearIndex} ${euro(year.cost)}`)
    .join(', ')}.`;

  const labels = {
    lump: hasLump ? (narrow ? `${lumpAmount} today` : `You pay in ${lumpAmount} today`) : '',
    yearly: hasYearly
      ? (hasLump
        ? `and ${yearlyAmount} a year`
        : (narrow ? `${yearlyAmount} a year` : `You pay in ${yearlyAmount} a year`))
      : '',
    // The same labels without "You pay in", for a run so long that the full
    // wording would reach the cost panel.
    lumpShort: hasLump ? `${lumpAmount} today` : '',
    yearlyShort: hasYearly ? (hasLump ? `and ${yearlyAmount} a year` : `${yearlyAmount} a year`) : '',
    // Only when nothing at all is paid in the early years: with a lump sum there
    // is a payment today, and "nothing set aside" would be untrue.
    gap: !hasLump && savingStart > 0 ? `Nothing set aside for ${yearsPhrase(savingStart)}` : '',
    fund: `Your fund, growing ${percentText(rates.cashNet)} a year`,
    // Where the saving years are too few to hold the sentence.
    fundShort: 'Your fund'
  };

  const panel = narrow
    ? { title: 'What you need', amount: euro(total), covered: 'Covered', coveredFull: 'Covered by your fund' }
    : {
      title: `What you need: ${euro(total)} in total`,
      amount: euro(total),
      covered: 'Covered by your fund',
      coveredFull: 'Covered by your fund'
    };

  const chartLabel = `${headline} ${support} Your fund builds up until the cost starts in year `
    + `${inputs.startsInYears}, then pays out ${yearsPhrase(inputs.durationYears)} of the cost.`;

  return {
    heading: inputs.costTitle,
    subtitle: `A ${yearAdjective(inputs.durationYears)} cost starting in ${yearsPhrase(inputs.startsInYears)}`,
    headline,
    support,
    footnote,
    buttons,
    costByYear,
    labels,
    panel,
    chartLabel,
    flags: { hasLump, hasYearly, savingStart, savingYears: entry.savingYears },
    figures: { total, paid, growth }
  };
}

/** Every string a case puts on screen, flattened, for the words scan. */
export function collectFundStrings(projection, caseId) {
  const out = [];
  [false, true].forEach((narrow) => {
    const copy = buildFundCopy(projection, caseId, { narrow });
    out.push(copy.heading, copy.subtitle, copy.headline, copy.support, copy.footnote,
      copy.costByYear, copy.chartLabel);
    copy.buttons.forEach((button) => out.push(button.title, button.amountLine));
    Object.values(copy.labels).forEach((text) => out.push(text));
    out.push(copy.panel.title, copy.panel.covered, copy.panel.coveredFull);
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

/* -------------------------------------------------------------------- geometry */

/**
 * The fund's balance at each sample, for one case: for every year the opening
 * balance, the closing balance (after that year's payment and cost) and seven
 * interior points as the closing balance grows, then one last point.
 *
 * The count is fixed, `columns x 9 + 1`, so two cases can be interpolated point
 * by point and the line travels instead of redrawing.
 */
export function fundSampleValues(entry, rateNet, columns) {
  const values = [];
  for (let year = 0; year < columns; year += 1) {
    const row = entry.rows[year];
    const opening = row ? row.openingBalance : 0;
    const closing = row ? row.closingBalance : 0;
    values.push(Math.max(0, opening), Math.max(0, closing));
    for (let k = 1; k < SAMPLES_PER_YEAR; k += 1) {
      values.push(Math.max(0, closing * (1 + rateNet) ** (k / SAMPLES_PER_YEAR)));
    }
  }
  const last = entry.rows[columns - 1];
  values.push(Math.max(0, last ? last.closingBalance * (1 + rateNet) : 0));
  return values;
}

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
 * The drawing's frame for a container width.
 *
 * @param {object} projection
 * @param {object} options
 * @param {number} options.width the chart container's width in px
 */
export function layoutFutureCostChart(projection, { width } = {}) {
  const model = readFundModel(projection);
  const { inputs, columns } = model;
  const narrow = width < NARROW_BELOW_PX;
  const k = narrow ? NARROW : WIDE;

  // 320 on a phone, not 300: the fund peaks at 80% of the axis, so the top 20%
  // is 64px, which is exactly the height of the cost panel's three-line header.
  const plotHeight = narrow ? 320 : (width >= 1200 ? 540 : 420);
  const yearWidth = (width - k.gutter) / columns;

  const peak = Math.max(1, ...model.cases.flatMap((entry) => entry.rows.map(
    (row) => Math.max(row.openingBalance, row.closingBalance)
  )));
  const axisMax = chooseAxisMaximum(peak);
  const scale = plotHeight / axisMax;

  const xAt = (year) => k.gutter + (yearWidth * year);
  const yAt = (value) => plotHeight - (value * scale);

  const sampleYears = [];
  for (let year = 0; year < columns; year += 1) {
    sampleYears.push(year, year);
    for (let step = 1; step < SAMPLES_PER_YEAR; step += 1) {
      sampleYears.push(year + (step / SAMPLES_PER_YEAR));
    }
  }
  sampleYears.push(columns);
  const sampleX = sampleYears.map(xAt);

  const startYear = inputs.startsInYears;
  const panelLeft = xAt(startYear);
  const panelWidth = width - panelLeft;

  // The gap either side of a block, shrinking with the column so that a block
  // never reaches zero width in a long run.
  const inset = Math.max(1, Math.min(k.blockInset, Math.round(yearWidth * 0.1)));
  const blockWidth = Math.max(1, yearWidth - (inset * 2));

  // Axis labels: every year while there is room for the widest name, then every
  // 2, 5, 10, 20 or 50, chosen from the column width so that two names never
  // touch. The cost's first year is always named, because it is the year the
  // picture turns, and any name that would crowd it gives way.
  const nameFont = narrow ? 12 : 18;
  const nameWidth = estimateTextWidth(`Year ${columns - 1}`, nameFont, 500) + 4;
  const step = [1, 2, 5, 10, 20, 50].find((candidate) => candidate * yearWidth >= nameWidth) || 50;
  const labelYears = new Set();
  for (let year = 0; year < columns; year += step) labelYears.add(year);
  Array.from(labelYears).forEach((year) => {
    if (year !== startYear && Math.abs(xAt(year) - xAt(startYear)) < nameWidth) labelYears.delete(year);
  });
  labelYears.add(startYear);
  const axisLabels = Array.from(labelYears).sort((a, b) => a - b).map((year) => ({
    year,
    x: xAt(year),
    text: year === 0 ? 'Today' : `Year ${year}`,
    emphasised: year >= startYear
  }));

  const grid = [
    { value: 0, y: yAt(0), text: '€0', baseline: true },
    { value: axisMax / 2, y: yAt(axisMax / 2), text: axisEuro(axisMax / 2), baseline: false }
  ];

  const values = {};
  model.cases.forEach((entry) => {
    values[entry.id] = fundSampleValues(entry, model.rates.cashNet, columns);
  });

  return {
    model,
    mode: k.name,
    narrow,
    constants: k,
    width,
    plotHeight,
    height: plotHeight + k.axisHeight,
    columns,
    yearWidth,
    axisMax,
    scale,
    peak,
    peakShareOfAxis: peak / axisMax,
    xAt,
    yAt,
    sampleX,
    sampleYears,
    values,
    startYear,
    panel: { left: panelLeft, width: panelWidth, top: 0, height: plotHeight + k.axisHeight },
    blockInset: inset,
    blockWidth,
    axisLabels,
    labelStep: step,
    labelNameWidth: nameWidth,
    grid
  };
}

/**
 * The cost blocks for one case: one per cost year, hanging from that year's
 * opening balance by the cost. Identical across solved cases, which is the
 * property the whole picture rests on.
 */
export function layoutCostBlocks(layout, caseId, projection) {
  const model = layout.model;
  const entry = findCase(model, caseId);
  return model.costYears.map((year) => {
    const opening = entry.rows[year.yearIndex].openingBalance;
    const height = year.cost * layout.scale;
    const showText = !layout.narrow && layout.blockWidth >= layout.constants.blockTextMinWidth;
    return {
      yearIndex: year.yearIndex,
      left: layout.xAt(year.yearIndex) + layout.blockInset,
      top: layout.yAt(opening),
      width: layout.blockWidth,
      height,
      amount: year.cost,
      text: showText ? euro(year.cost) : '',
      showText
    };
  });
}

/** SVG path data for a value list: the line and the area under it. */
export function buildFundPaths(layout, values) {
  const points = values.map((value, index) => `${layout.sampleX[index].toFixed(1)},${layout.yAt(value).toFixed(1)}`);
  const line = `M${points.join('L')}`;
  const base = layout.plotHeight.toFixed(1);
  const area = `${line}L${layout.xAt(layout.columns).toFixed(1)},${base}L${layout.xAt(0).toFixed(1)},${base}Z`;
  return { line, area };
}

/* -------------------------------------------------------------- label placement */

function boxesOverlap(a, b, pad = 0) {
  return a.left < b.right + pad && b.left < a.right + pad && a.top < b.bottom + pad && b.top < a.bottom + pad;
}

function lowestRowUnder(layout, values, left, right) {
  // The highest the line reaches on screen is the SMALLEST row number.
  let highest = layout.plotHeight;
  for (let i = 0; i < values.length; i += 1) {
    const x = layout.sampleX[i];
    if (x >= left && x <= right) {
      const row = layout.yAt(values[i]);
      if (row < highest) highest = row;
    }
  }
  return highest;
}

function makeBox(left, top, width, height, extra = {}) {
  return { left, top, width, height, right: left + width, bottom: top + height, ...extra };
}

/**
 * Where each direct label sits, for one case, against the fund line in `values`.
 *
 * Called every frame with the interpolated values, and by the checks with the
 * target values. The ORDER is the design: the yearly label is placed first, the
 * lump label is placed against the line and then stacked clear of the yearly
 * label if they would meet, and as a last resort it goes inside the area just
 * under the riser, where nothing else lives.
 *
 * @param {object} layout from `layoutFutureCostChart`
 * @param {string} caseId
 * @param {number[]} values the fund's sample values (interpolated or final)
 * @param {object} copy from `buildFundCopy`
 */
export function placeFundLabels(layout, caseId, values, copy) {
  const k = layout.constants;
  const model = layout.model;
  const entry = findCase(model, caseId);
  const { hasLump, hasYearly, savingStart, savingYears } = copy.flags;
  const startYear = layout.startYear;
  const out = { lump: null, yearly: null, gap: null, fund: null };

  // 1. The yearly label, first.
  if (hasYearly) {
    let text = copy.labels.yearly;
    let width = estimateTextWidth(text, k.labelFont);
    const room = layout.xAt(startYear) - k.gutter - k.yearlyGap - 8;
    if (width > room && copy.labels.yearlyShort) {
      text = copy.labels.yearlyShort;
      width = estimateTextWidth(text, k.labelFont);
    }
    const anchorYear = Math.min(startYear, savingStart + Math.ceil(savingYears / 2) + (hasLump ? 1 : 0));
    let right = layout.xAt(anchorYear) - k.yearlyGap;
    let left = right - width;
    if (left < k.gutter) {
      left = k.gutter + 4;
      right = left + width;
    }
    const top = Math.max(2, lowestRowUnder(layout, values, left, right) - k.labelClearance);
    out.yearly = makeBox(left, top, width, k.labelHeight, { text });
  }

  // 2. The lump label, against the line, then clear of the yearly label.
  if (hasLump) {
    let text = copy.labels.lump;
    let width = estimateTextWidth(text, k.labelFont);
    const left = layout.xAt(0) + k.labelGap;
    if (left + width > layout.panel.left - 8 && copy.labels.lumpShort) {
      text = copy.labels.lumpShort;
      width = estimateTextWidth(text, k.labelFont);
    }
    const right = left + width;
    let top = Math.max(2, lowestRowUnder(layout, values, left, right) - k.labelClearance);
    let box = makeBox(left, top, width, k.labelHeight, { text, placement: 'above the line' });

    if (out.yearly && boxesOverlap(box, out.yearly, 6)) {
      const stacked = out.yearly.top - k.labelHeight - 6;
      if (stacked >= 2) {
        box = makeBox(left, stacked, width, k.labelHeight, { text, placement: 'stacked above the yearly label' });
      } else {
        // Nowhere above: sit inside the area, just under the riser's top edge.
        const closingToday = values[1] ?? 0;
        top = layout.yAt(closingToday) + 10;
        box = makeBox(left, top, width, k.labelHeight, { text, placement: 'inside the area' });
      }
    }
    out.lump = box;
  }

  // 3. The gap label: only where the early years are empty and it fits there.
  if (copy.labels.gap) {
    const text = copy.labels.gap;
    const roomWidth = layout.xAt(savingStart) - layout.xAt(0) - 20;
    if (layout.narrow) {
      const width = 80;
      if (width <= roomWidth) {
        out.gap = makeBox(12, layout.plotHeight - 60, width, k.gapHeight, { text });
      }
    } else {
      const width = estimateTextWidth(text, k.gapFont, 500);
      if (width <= roomWidth) {
        out.gap = makeBox(layout.xAt(0) + 14, layout.plotHeight - 44, width, k.gapHeight, { text });
      }
    }
  }

  // 4. The fund label, inside the area near the baseline. It has to sit where
  // the area is, between the first payment and the cost panel, so a short run
  // gets the short wording and a shorter still gets none.
  {
    const earliest = hasLump ? layout.xAt(0) + 8 : layout.xAt(savingStart) + 8;
    const limit = layout.xAt(startYear) - 8;
    const available = limit - earliest;
    const sentenceWidth = layout.narrow ? 130 : estimateTextWidth(copy.labels.fund, k.fundFont, 600);
    const shortWidth = estimateTextWidth(copy.labels.fundShort, k.fundFont, 600);
    let text = null;
    let width = 0;
    if (sentenceWidth <= available) {
      text = copy.labels.fund;
      width = sentenceWidth;
    } else if (shortWidth <= available) {
      text = copy.labels.fundShort;
      width = shortWidth;
    }
    if (text) {
      const centreYear = hasYearly ? savingStart + (savingYears / 2) : startYear / 2;
      const latest = limit - width;
      let left = layout.xAt(centreYear) - (width / 2);
      left = Math.max(earliest, Math.min(left, latest));
      const top = layout.plotHeight - (layout.narrow ? 38 : 46);
      const height = text === copy.labels.fund ? k.fundHeight : (layout.narrow ? 16 : k.fundHeight);
      let box = makeBox(left, top, width, height, { text });
      if (out.gap && boxesOverlap(box, out.gap, 6)) {
        const shifted = out.gap.right + 12;
        box = shifted + width <= limit ? makeBox(shifted, top, width, height, { text }) : null;
      }
      out.fund = box;
    }
  }

  return out;
}

/**
 * Check a placement. Returns a list of problems, empty when the picture is clean.
 * Used by the checks, and available to a dev preview.
 */
export function checkLabelPlacement(layout, labels, values) {
  const problems = [];
  const named = Object.entries(labels).filter(([, box]) => box);

  named.forEach(([name, box]) => {
    if (box.top < 0) problems.push(`${name} label is above the chart (top ${box.top.toFixed(0)})`);
    if (box.left < 0) problems.push(`${name} label is off the left edge (${box.left.toFixed(0)})`);
    if (box.right > layout.width + 0.5) problems.push(`${name} label is off the right edge (${box.right.toFixed(0)})`);
    if (box.bottom > layout.plotHeight + 0.5) problems.push(`${name} label is below the baseline`);
    if (name !== 'fund' && name !== 'gap' && box.right > layout.panel.left + 0.5 && layout.startYear > 0) {
      problems.push(`${name} label runs into the cost panel (${box.right.toFixed(0)} > ${layout.panel.left.toFixed(0)})`);
    }
  });

  for (let i = 0; i < named.length; i += 1) {
    for (let j = i + 1; j < named.length; j += 1) {
      if (boxesOverlap(named[i][1], named[j][1], 0)) {
        problems.push(`${named[i][0]} and ${named[j][0]} labels overlap`);
      }
    }
  }

  // The line must not pass through a label that sits above it. The fund label
  // sits INSIDE the area, so the line passes above it and is not checked.
  ['lump', 'yearly'].forEach((name) => {
    const box = labels[name];
    if (!box) return;
    for (let i = 1; i < values.length; i += 1) {
      const x0 = layout.sampleX[i - 1];
      const y0 = layout.yAt(values[i - 1]);
      const x1 = layout.sampleX[i];
      const y1 = layout.yAt(values[i]);
      if (Math.max(x0, x1) < box.left || Math.min(x0, x1) > box.right) continue;
      const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4));
      for (let s = 0; s <= steps; s += 1) {
        const x = x0 + ((x1 - x0) * (s / steps));
        const y = y0 + ((y1 - y0) * (s / steps));
        if (x > box.left && x < box.right && y > box.top && y < box.bottom) {
          problems.push(`the line passes through the ${name} label`);
          return;
        }
      }
    }
  });

  return Array.from(new Set(problems));
}

/**
 * Where the cost panel's header sits: inside the panel when its title fits on
 * one line, and in a row above the chart when it does not (a one-year cost, or
 * a cost so large that its total is a long figure).
 */
export function placePanelHeader(layout, copy) {
  const k = layout.constants;
  const titleFont = layout.narrow ? 13 : 22;
  const titleWidth = estimateTextWidth(copy.panel.title, titleFont, 700);
  const needed = Math.max(k.panelInsideMinWidth, titleWidth + (k.headerPad * 2));
  if (layout.panel.width >= needed) {
    return {
      placement: 'inside',
      left: layout.panel.left + k.headerPad,
      top: k.headerTop,
      width: layout.panel.width - (k.headerPad * 2)
    };
  }
  const width = layout.narrow ? 150 : titleWidth + 24;
  return {
    placement: 'above',
    left: Math.max(0, layout.width - width),
    top: -(layout.narrow ? 46 : 40),
    width
  };
}
