/**
 * WHAT OVERPAYING BUYS YOU.
 *
 * One module, shown on a shared screen during a live call, answering one
 * question. The adviser sets up two to four repayment cases and clicks between
 * them while narrating; the same screen is re-opened later by the client with
 * nobody talking over it, so nothing here may depend on spoken context.
 *
 * EVERY CASE HOLDS THE SAME MONTHLY REPAYMENT. That is what makes them
 * comparable, and it is the one thing a client cannot infer from the screen --
 * which is why it is stated in prose under the buttons rather than left to be
 * worked out.
 *
 * The module takes two positions at once, both at hero scale, side by side:
 * the answer is a DATE (when this ends) and the answer is a PROPORTION (how
 * much of the interest bill goes, and what it costs). The previous module had
 * one hero that silently swapped meaning between the base case and the others,
 * so the same large figure meant "interest you pay" on one click and "interest
 * you save" on the next. Two permanently labelled heroes is the fix.
 *
 * A third question -- which case is the better use of a euro -- is deliberately
 * demoted to a quiet line and a table column with two explanatory notes,
 * because it ranks the cases differently from every other measure on the
 * screen and would otherwise read as a contradiction.
 */

import {
  computeMortgageComparison,
  formatMonthYear,
  formatMonthsDurationLong
} from './mortgage_math.js';

/* ------------------------------------------------------------------ motion */

/** The one clock. Long enough to follow, short enough to feel like a click. */
const CLICK_MS = 520;

/** Timers fire in throttled tabs where animation frames do not. */
const SETTLE_GRACE_MS = 120;

/** Below this a figure is rounding residue, not money. */
const EPSILON = 0.005;

/** The years offered when the money is already in hand. */
const DEFAULT_LUMP_YEAR_OFFSETS = Object.freeze([0, 1, 2, 3, 5]);

/**
 * WHICH YEARS THE TIMING ROW OFFERS, given when the client said they could
 * pay.
 *
 * "In about five years" is a real answer, and the useful question after it is
 * not "what about next year" -- it is "what if it came a year sooner, and what
 * if it slips". So a deferred lump sum gets a window around the year it was
 * given: one year earlier, that year, and the two after it.
 *
 * Paying now stays on the row whatever the default is. It is the comparison
 * the timing note is built on -- what the wait costs -- and dropping it would
 * leave the client with four adjacent years that barely differ.
 */
function buildLumpYearOffsets(authoredMonth, termMonths) {
  const authoredYear = authoredMonth > 0 ? Math.round(authoredMonth / 12) : 0;
  const offsets = authoredYear > 0
    ? [0, authoredYear - 1, authoredYear, authoredYear + 1, authoredYear + 2]
    : [...DEFAULT_LUMP_YEAR_OFFSETS];

  return Object.freeze([...new Set(offsets)]
    .filter((offset) => offset >= 0 && offset * 12 < termMonths)
    .sort((left, right) => left - right));
}

/** Ease-out cubic: fast enough to feel caused, slow enough to be followed. */
function easeOutCubic(k) {
  return 1 - Math.pow(1 - k, 3);
}

function isReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/* -------------------------------------------------------------- formatting */

const WHOLE_EURO = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

const EXACT_EURO = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

function eur(value) {
  return WHOLE_EURO.format(Number.isFinite(value) ? Math.round(value) : 0);
}

function eur2(value) {
  return EXACT_EURO.format(Number.isFinite(value) ? value : 0);
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

function setAttrs(node, attributes) {
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
}

/** A figure set in mono inside a sentence, so the number is read as a number. */
function withFigure(paragraph, before, figure, after) {
  paragraph.append(before);
  paragraph.append(el('span', 'rcm-inline-figure', figure));
  paragraph.append(after);
  return paragraph;
}

/* ------------------------------------------------------------ the case set */

/**
 * The monthly balance path, in whole months from the start of the schedule.
 *
 * Index 0 is the balance the schedule opens on -- after an upfront lump sum,
 * before the first month's interest -- so two cases are always directly
 * comparable at the same index.
 */
function buildBalancePath(projection, termMonths) {
  const balances = new Array(termMonths + 1).fill(0);
  balances[0] = projection.openingBalance;
  projection.monthlySchedule.forEach((month, index) => {
    if (index + 1 <= termMonths) balances[index + 1] = month.balanceEnd;
  });
  return balances;
}

/** Interest charged in each year of the base term, zero-filled past payoff. */
function buildYearInterest(projection, years) {
  const byYear = new Map(projection.annualSchedule.map((row) => [row.year, row.interestPaidRaw]));
  return years.map((year) => byYear.get(year) || 0);
}

/**
 * Everything the screen needs about one case, at one lump-sum timing.
 *
 * Derived rather than stored: all of the cases plus the repayment-reduction
 * variant are a handful of loops over a few hundred months, which is cheap
 * enough to recompute on a click and far cheaper than keeping a second copy
 * of the truth that can drift from the engine's.
 */
function buildCaseSet(rawInputs, engineOptions, lumpMonth) {
  // A null month means "as the payload authored it". Forcing 0 here would
  // silently move a lump sum the client said they cannot pay until 2029 to
  // money they have today, and every figure on the screen would be wrong in
  // the client's favour.
  const comparison = computeMortgageComparison(rawInputs, {
    ...engineOptions,
    ...(Number.isFinite(lumpMonth) ? { oneOffOverpaymentMonth: lumpMonth } : {})
  });

  const termMonths = comparison.termMonths;
  const startYear = Number(String(comparison.startDateIso).slice(0, 4));
  const yearCount = Math.ceil(termMonths / 12);
  const years = Array.from({ length: yearCount }, (_, index) => startYear + index);
  const baseInterest = comparison.baseCase.totalInterestLifetime;
  const openingBalance = comparison.baseCase.projection.openingBalance;

  const cases = comparison.cases.map((item) => ({
    id: item.id,
    title: item.title,
    isBase: item.isBase,
    hasLump: item.projection.lumpSumApplied > EPSILON,
    months: item.monthsSimulated,
    monthsSaved: Math.max(0, item.monthsSaved),
    interest: item.totalInterestLifetime,
    saved: Math.max(0, item.interestSaved),
    paidIn: item.totalOverpaid > EPSILON ? item.totalOverpaid : 0,
    perEuro: item.savedPerEuroOverpaid,
    payoffDateIso: item.payoffDateIso,
    balances: buildBalancePath(item.projection, termMonths),
    yearInterest: buildYearInterest(item.projection, years)
  }));

  return {
    comparison,
    cases,
    termMonths,
    years,
    startYear,
    baseInterest,
    openingBalance,
    maxPaidIn: Math.max(...cases.map((item) => item.paidIn), 1),
    contractualPayment: comparison.contractualPayment,
    termEndIso: comparison.baseCase.payoffDateIso,
    repaymentReduction: comparison.repaymentReduction,
    // What the engine actually used, which on first render is whatever the
    // payload authored rather than whatever this module would have defaulted.
    lumpSumMonth: comparison.lumpSumMonth
  };
}

/* --------------------------------------------------------------- the module */

/**
 * @param {object} options
 * @param {object} options.rawInputs        the payload's mortgageInputs/loanInputs
 * @param {object} [options.engineOptions]  passed straight to the engine (defaultLoanKind)
 * @param {string} [options.selectedCaseId] the case to open on
 * @param {Function} [options.onSelectCase] told when the client picks a case
 */
export function buildRepaymentCaseModule({
  rawInputs,
  engineOptions = {},
  selectedCaseId = null,
  onSelectCase = null
} = {}) {
  let set = buildCaseSet(rawInputs, engineOptions, null);
  if (set.cases.length === 0) {
    return null;
  }

  // FIXED AT CONSTRUCTION, FROM THE PAYLOAD.
  //
  // Deriving the window from the currently selected year instead would make
  // it re-centre on every click: the pills would shift under the cursor, and
  // the row would stop being one of the static anchors the moving figures are
  // read against.
  const lumpYearOffsets = buildLumpYearOffsets(set.lumpSumMonth, set.termMonths);

  const loanKind = set.comparison.loanKind === 'loan' ? 'loan' : 'mortgage';
  const freeWord = loanKind === 'loan' ? 'Loan-free' : 'Mortgage-free';
  const freeWordLower = loanKind === 'loan' ? 'loan-free' : 'mortgage-free';

  // THE MODULE OPENS ON THE BASE CASE. Every figure starts on the current path
  // and the click is what changes it -- which is only true if the first thing
  // on screen is the path the client is already on.
  const baseIndex = Math.max(0, set.cases.findIndex((item) => item.isBase));
  let selectedIndex = baseIndex;
  if (selectedCaseId) {
    const requested = set.cases.findIndex((item) => item.id === selectedCaseId);
    if (requested >= 0) selectedIndex = requested;
  }

  // `frozen` holds the pre-change case set for the length of a lump-year
  // transition, so the outgoing figures stay coherent while the schedules
  // underneath them are recomputed.
  const anim = { from: selectedIndex, t: 1, frozen: null };
  let rafHandle = null;
  let settleTimer = null;
  let token = 0;

  const root = el('section', 'rcm');
  root.dataset.generatedCard = 'repayment-cases';
  root.setAttribute('aria-label', `What overpaying this ${loanKind} buys you`);

  const refs = {};

  /* --------------------------------------------------------- 1. context */

  const context = el('div', 'rcm-context');
  context.append(el('span', 'rcm-eyebrow', 'What overpaying buys you'));
  refs.contextFacts = el('span', 'rcm-context-facts');
  context.append(refs.contextFacts);
  root.append(context);

  /* ----------------------------------------------------- 2. case ladder */

  refs.ladder = el('div', 'rcm-ladder');
  refs.ladder.setAttribute('role', 'radiogroup');
  refs.ladder.setAttribute('aria-label', 'Choose a repayment case');
  root.append(refs.ladder);

  /* --------------------------------- 3. the unchanged-repayment premise */

  refs.premise = el('p', 'rcm-premise');
  root.append(refs.premise);

  /* ------------------------------------------------ 4. lump-sum timing */

  refs.timing = el('div', 'rcm-timing');
  refs.timingLabel = el('span', 'rcm-eyebrow', 'Lump sum paid in');
  refs.timingPills = el('div', 'rcm-timing-pills');
  refs.timingPills.setAttribute('role', 'radiogroup');
  refs.timingPills.setAttribute('aria-label', 'When the lump sum is paid');
  refs.timingNote = el('span', 'rcm-timing-note');
  refs.timing.append(refs.timingLabel, refs.timingPills, refs.timingNote);
  root.append(refs.timing);

  /* ---------------------------------------------------- 5. the hero card */

  const hero = el('div', 'rcm-card');
  root.append(hero);

  // Band 1: two heroes, each permanently labelled.
  const heroBand = el('div', 'rcm-hero-band');
  const heroLeft = el('div', 'rcm-hero');
  heroLeft.append(el('div', 'rcm-eyebrow', freeWord));
  refs.heroDate = el('div', 'rcm-hero-figure');
  refs.heroDateSub = el('div', 'rcm-hero-sub');
  heroLeft.append(refs.heroDate, refs.heroDateSub);

  const heroRight = el('div', 'rcm-hero');
  heroRight.append(el('div', 'rcm-eyebrow', 'Interest removed'));
  const heroPair = el('div', 'rcm-hero-pair');
  refs.heroPct = el('span', 'rcm-hero-figure rcm-hero-figure-positive');
  refs.heroSaved = el('span', 'rcm-hero-money');
  heroPair.append(refs.heroPct, refs.heroSaved);
  refs.heroPctSub = el('div', 'rcm-hero-sub');
  heroRight.append(heroPair, refs.heroPctSub);
  heroBand.append(heroLeft, heroRight);
  hero.append(heroBand);

  // Band 2: the time rail. January of the first year to the contractual end.
  const railBand = el('div', 'rcm-band');
  const railLabels = el('div', 'rcm-split-row');
  refs.payingLabel = el('span', 'rcm-label-accent');
  refs.freeLabel = el('span', 'rcm-label-positive');
  railLabels.append(refs.payingLabel, refs.freeLabel);

  const rail = el('div', 'rcm-rail');
  refs.railFill = el('div', 'rcm-rail-fill');
  refs.railRemainder = el('div', 'rcm-rail-remainder');
  refs.railMarker = el('div', 'rcm-rail-marker');
  const railEnd = el('div', 'rcm-rail-end');
  refs.railTicks = el('div', 'rcm-rail-ticks');
  rail.append(refs.railFill, refs.railRemainder, refs.railMarker, railEnd, refs.railTicks);
  railBand.append(railLabels, rail, el('div', 'rcm-rail-gutter'));
  hero.append(railBand);

  // Band 3: the interest bar. THE CUT LINE IS THE MODULE.
  //
  // Its travel is the design. The client's eye is already on the line when the
  // number changes, so they understand without being told that money going in
  // is the thing that moves it. Nothing re-tints during the move: length and
  // position carry the change, and a fill that changed colour as it travelled
  // would turn the gesture into decoration on a bar chart.
  const interestBand = el('div', 'rcm-band');
  const interestLabels = el('div', 'rcm-split-row rcm-split-row-baseline');
  interestLabels.append(el('span', 'rcm-eyebrow', 'Interest on the original path'));
  refs.baseInterestLabel = el('span', 'rcm-mono-muted');
  interestLabels.append(refs.baseInterestLabel);

  const interestBar = el('div', 'rcm-interest-bar');
  refs.interestFill = el('div', 'rcm-interest-fill');
  refs.interestFigure = el('span', 'rcm-interest-figure');
  refs.interestFill.append(refs.interestFigure);
  refs.interestHatch = el('div', 'rcm-interest-hatch');
  interestBar.append(refs.interestFill, refs.interestHatch);

  const interestCaption = el('div', 'rcm-split-row rcm-caption');
  interestCaption.append(el('span', null, 'Interest you still pay'));
  refs.freedLabel = el('span', 'rcm-label-positive');
  interestCaption.append(refs.freedLabel);
  interestBand.append(interestLabels, interestBar, interestCaption);
  hero.append(interestBand);

  // Band 4: the cost bar, on the identical denominator, so the client's own
  // money is not a small grey pill beside a large green saving.
  const costBand = el('div', 'rcm-band');
  costBand.append(el(
    'div',
    'rcm-eyebrow',
    'Your own money, paid on top of the unchanged repayment · same ruler'
  ));
  const costBar = el('div', 'rcm-cost-bar');
  refs.costFill = el('div', 'rcm-cost-fill');
  refs.costFigure = el('span', 'rcm-cost-figure');
  refs.costFill.append(refs.costFigure);
  costBar.append(refs.costFill);
  const costCaption = el('div', 'rcm-split-row rcm-caption');
  costCaption.append(el('span', null, 'Paid in over the life of the plan'));
  refs.perEuroLabel = el('span', 'rcm-mono-muted');
  costCaption.append(refs.perEuroLabel);
  costBand.append(costBar, costCaption);
  hero.append(costBand);

  // Band 5: the two charts.
  //
  // Bespoke SVG rather than Chart.js because the balance curve is interpolated
  // frame by frame between two schedules on the same clock as the rail, and
  // because the shaded band, the payoff marker and the rail above have to
  // agree pixel for pixel.
  const chartsBand = el('div', 'rcm-charts');

  const balanceChart = el('div', 'rcm-chart');
  refs.balanceChartLabel = el('div', 'rcm-eyebrow');
  const balanceSvg = svgEl('svg', {
    viewBox: '0 0 1000 215',
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
    focusable: 'false'
  });
  balanceSvg.classList.add('rcm-svg');
  refs.balanceArea = svgEl('path', { fill: 'rgba(122, 215, 180, 0.14)' });
  refs.balanceBasePath = svgEl('path', {
    fill: 'none',
    stroke: 'rgba(190, 202, 207, 0.42)',
    'stroke-width': '1.5',
    'stroke-dasharray': '5 5',
    'vector-effect': 'non-scaling-stroke'
  });
  refs.balanceCasePath = svgEl('path', {
    fill: 'none',
    stroke: '#8dd3ff',
    'stroke-width': '2.4',
    'vector-effect': 'non-scaling-stroke'
  });
  refs.balanceMarker = svgEl('line', {
    y1: '0',
    y2: '205',
    stroke: '#f4f8fc',
    'stroke-width': '1',
    'vector-effect': 'non-scaling-stroke'
  });
  const balanceBaseline = svgEl('line', {
    x1: '0', y1: '205', x2: '1000', y2: '205',
    stroke: 'rgba(149, 188, 225, 0.22)',
    'stroke-width': '1',
    'vector-effect': 'non-scaling-stroke'
  });
  balanceSvg.append(refs.balanceArea, refs.balanceBasePath, refs.balanceCasePath, refs.balanceMarker, balanceBaseline);
  refs.balanceAxis = el('div', 'rcm-chart-axis');
  balanceChart.append(refs.balanceChartLabel, balanceSvg, refs.balanceAxis);

  // The year columns read left to right, the columns shrink, and then they
  // stop existing: the hollow ones are years the client never reaches. That is
  // time and proportion in one mark, and it makes the front-loading of
  // interest visible, which is the mechanism nobody explains.
  const yearChart = el('div', 'rcm-chart');
  yearChart.append(el('div', 'rcm-eyebrow', 'Interest charged each year · hollow years never arrive'));
  refs.yearSvg = svgEl('svg', {
    viewBox: '0 0 1000 200',
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
    focusable: 'false'
  });
  refs.yearSvg.classList.add('rcm-svg');
  refs.yearAxis = el('div', 'rcm-chart-axis');
  yearChart.append(refs.yearSvg, refs.yearAxis);

  chartsBand.append(balanceChart, yearChart);
  hero.append(chartsBand);

  /* ------------------------------------------------ 6. comparison table */

  const tablePanel = el('div', 'rcm-panel rcm-table-panel');
  const tableScroll = el('div', 'rcm-table-scroll');
  refs.table = el('table', 'rcm-table');
  tableScroll.append(refs.table);
  tablePanel.append(tableScroll);
  root.append(tablePanel);

  /* ---------------------------------------- 7. the two per-euro notes */

  const notes = el('div', 'rcm-panel rcm-notes');
  const meaningNote = el('div', 'rcm-note');
  meaningNote.append(el('div', 'rcm-eyebrow rcm-eyebrow-accent', 'What “interest saved per €1 in” means'));
  refs.meaningBody = el('p', 'rcm-note-body');
  meaningNote.append(refs.meaningBody);

  const rankNote = el('div', 'rcm-note');
  rankNote.append(el('div', 'rcm-eyebrow rcm-eyebrow-amber', 'Why the lump sum always wins this one column'));
  rankNote.append(el('p', 'rcm-note-body', 'Everything else on this screen is measured in totals — the whole '
    + 'interest bill, the whole term, all the money paid in. This one column is measured per euro, and that is a '
    + 'different question, so it can give a different answer. The lump sum lands once, early, against the largest '
    + `balance the ${loanKind} will ever have, and every euro of it works for the full remaining term. Money paid in `
    + 'later — a yearly amount, or a lump sum deferred by a few years — has less time and a smaller balance to work '
    + 'against, so it does less per euro even when it removes more interest in total. Read the two together: the '
    + 'totals tell you how much is on the table, this column tells you how hard each euro worked to get it.'));
  notes.append(meaningNote, rankNote);
  root.append(notes);

  /* ------------------------------------------ 8. keep the term instead */

  refs.reductionSection = el('div', 'rcm-reduction');
  root.append(refs.reductionSection);

  /* --------------------------------------------------- 9. disclosure */

  root.append(el('p', 'rcm-disclosure', 'Every figure here is calculated from the balance, rate and repayment shown '
    + 'above, and assumes the rate and the repayment stay as they are for the rest of the term. Lenders differ on '
    + 'whether an overpayment shortens the term or reduces the repayment, and some apply limits or fees on a fixed '
    + 'rate, so your own lender’s terms may change these numbers. This is education only: it does not sell products, '
    + 'arrange products, or provide regulated financial advice, tax advice, legal advice, or product '
    + 'recommendations.'));

  /* ------------------------------------------------------------- state */

  function currentCase() {
    return set.cases[selectedIndex];
  }

  /** The case the transition is leaving, from the frozen set if there is one. */
  function fromCase() {
    const source = anim.frozen || set.cases;
    return source[Math.min(anim.from, source.length - 1)];
  }

  function mix(key) {
    const from = fromCase()[key];
    const to = currentCase()[key];
    if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.isFinite(to) ? to : 0;
    return from + ((to - from) * anim.t);
  }

  /** The date at a month index, counted from the first month of the schedule. */
  function monthYearAt(monthIndex) {
    const start = new Date(`${set.comparison.startDateIso}T00:00:00Z`);
    const shifted = new Date(Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth() + Math.max(0, Math.round(monthIndex) - 1),
      1
    ));
    return formatMonthYear(shifted.toISOString().slice(0, 10));
  }

  const termEndLabel = () => monthYearAt(set.termMonths);

  /**
   * THE CONTRACTUAL END DATE, SPELLED OUT.
   *
   * It is the anchor every case is measured against and the one date on the
   * screen that never moves, so in prose it gets its full name. Payoff dates
   * stay abbreviated: they are the figures that change, they appear beside
   * mono columns, and spelling all of them out would make the sentence the
   * thing being read rather than the difference between two dates.
   */
  const termEndLabelLong = () => {
    const start = new Date(`${set.comparison.startDateIso}T00:00:00Z`);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + set.termMonths - 1, 1));
    return new Intl.DateTimeFormat('en-IE', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(end);
  };

  /* -------------------------------------------------------- the clock */

  function stopClock() {
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer);
      settleTimer = null;
    }
  }

  /**
   * NO TWO FIGURES ON SCREEN MAY EVER DISAGREE.
   *
   * Not at any point in a transition, and not after any sequence of clicks.
   * Four things are needed for that and all four were learned the hard way:
   *
   *  1. progress is clamped to 0-1 and timed from the FIRST FRAME, not from a
   *     clock read at click time -- otherwise the first frame can come out
   *     negative and the figures extrapolate past the base case ("-1%",
   *     "-1 years -2 months");
   *  2. any in-flight run is cancelled before a new one starts, and the loop
   *     is guarded by a monotonic token, because two overlapping loops leave
   *     the hero on one case while the table shows another;
   *  3. a settle timer forces the end state, because frames stop entirely in a
   *     backgrounded tab and the module would otherwise sit there permanently
   *     showing two cases at once;
   *  4. the media query is read at click time, not once at load, because a
   *     client can turn reduced motion on during the call.
   */
  function runClock(durationMs) {
    stopClock();

    if (!durationMs) {
      anim.t = 1;
      anim.frozen = null;
      paint();
      return;
    }

    const runToken = (token += 1);
    let startedAt = null;
    // Set once this run has reached its end state, by whichever of the two
    // routes got there first.
    let finished = false;

    const step = (now) => {
      // A stale loop must never write to the clock, and a module whose pane
      // has been swapped out has nothing to animate. Neither case touches the
      // settle timer: stopping the frames is not the same as abandoning the
      // end state, and the timer below is the only thing that guarantees it.
      if (finished || runToken !== token || !root.isConnected) {
        rafHandle = null;
        return;
      }

      // A FRAME THAT ARRIVES AFTER THE SETTLE TIMER MUST NOT RESTART THE
      // TRANSITION.
      //
      // Frames are starved in a hidden or throttled tab and then delivered
      // late, sometimes in a burst. If the first of them arrives after the
      // timer has already landed the end state, this line would take its
      // timestamp as the start of the tween, compute a progress of zero, and
      // repaint the case the client just navigated away from -- leaving the
      // ladder and the table on one case and every figure on another, with no
      // further frame coming to correct it.
      if (startedAt === null) startedAt = now;

      const progress = clamp((now - startedAt) / durationMs, 0, 1);
      anim.t = easeOutCubic(progress);
      paint();

      if (progress < 1) {
        rafHandle = requestAnimationFrame(step);
        return;
      }

      finished = true;
      rafHandle = null;
      anim.frozen = null;
      stopClock();
    };

    rafHandle = requestAnimationFrame(step);

    // THE END STATE IS NOT CONDITIONAL ON ANYTHING.
    //
    // Frames stop in a backgrounded tab, arrive in bursts with timestamps far
    // apart in a throttled one, and never arrive at all for a module that was
    // briefly detached while the cards around it were patched. Timers fire in
    // all three. So this forces the end state without asking whether the
    // module is visible, connected or part-way through: halfway between
    // 218,474 and 47,797 is 164,973, a figure that is true of nothing, and it
    // must not be possible to leave it on screen.
    settleTimer = window.setTimeout(() => {
      settleTimer = null;
      if (finished || runToken !== token) return;
      finished = true;
      anim.t = 1;
      anim.frozen = null;
      paint();
    }, durationMs + SETTLE_GRACE_MS);
  }

  function selectCase(index) {
    if (index === selectedIndex) return;
    const duration = isReducedMotion() ? 0 : CLICK_MS;
    anim.from = selectedIndex;
    anim.t = duration ? 0 : 1;
    anim.frozen = null;
    selectedIndex = index;
    renderStatic();
    runClock(duration);
    if (typeof onSelectCase === 'function') {
      onSelectCase(set.cases[index].id);
    }
  }

  function selectLumpYear(offset) {
    if (offset * 12 === set.lumpSumMonth) return;
    stopClock();
    // The outgoing figures have to stay coherent while the schedules under
    // them are recomputed, so the whole pre-change set is held for the length
    // of the transition rather than read back out of the new one.
    anim.frozen = set.cases;
    anim.from = selectedIndex;
    set = buildCaseSet(rawInputs, engineOptions, offset * 12);
    const duration = isReducedMotion() ? 0 : CLICK_MS;
    anim.t = duration ? 0 : 1;
    renderStatic();
    runClock(duration);
  }

  /* --------------------------------------------- the parts that do not move */

  /**
   * The ladder, the timing row, the table and the notes.
   *
   * These are the static anchors that make the motion read as cause and
   * effect: they are rebuilt when the client changes something, never on the
   * clock. If they moved too, nothing on screen would be still enough for the
   * movement to be measured against.
   */
  function renderStatic() {
    const selected = currentCase();
    const rate = set.comparison.baseCase.projection.inputs.annualInterestRate;

    refs.contextFacts.textContent = [
      `${eur(set.openingBalance)} outstanding`,
      `${(rate * 100).toFixed(2).replace(/\.?0+$/, '')}%`,
      `to ${termEndLabel()}`,
      `${eur2(set.contractualPayment)} a month in every case`
    ].join(' · ');

    // Row two of each card is a commitment rail, filled to this case's share
    // of the largest amount anyone puts in. That is what makes the ladder a
    // ladder: the cards are not four equal options, they are increasing
    // commitment, and the rail says so before a word is read.
    refs.ladder.replaceChildren(...set.cases.map((item, index) => {
      const isActive = index === selectedIndex;
      const button = el('button', 'rcm-case');
      button.type = 'button';
      button.dataset.caseId = item.id;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', isActive ? 'true' : 'false');

      const top = el('div', 'rcm-case-top');
      top.append(el('span', 'rcm-case-name', item.title));
      top.append(el('span', 'rcm-case-amount', item.paidIn ? `${eur(item.paidIn)} in` : 'Nothing extra'));

      const track = el('div', 'rcm-case-rail');
      const fill = el('div', 'rcm-case-rail-fill');
      fill.style.width = `${((item.paidIn / set.maxPaidIn) * 100).toFixed(1)}%`;
      track.append(fill);

      button.append(top, track);
      button.addEventListener('click', () => selectCase(index));
      return button;
    }));

    // THE PREMISE THE CLIENT CANNOT INFER AND WILL OTHERWISE GET WRONG.
    refs.premise.replaceChildren();
    withFigure(
      refs.premise,
      'In all of these cases your monthly repayment stays at ',
      eur2(set.contractualPayment),
      `. A lump sum or a yearly amount is paid on top of it, and the term shortens instead — so nothing here `
        + `changes what leaves your account each month.`
    );
    if (set.repaymentReduction) {
      refs.premise.append(' The last section shows what happens if you keep the term and lower the repayment '
        + 'instead.');
    }

    renderTimingRow(selected);
    renderTable();
    renderMeaningNote();
    renderReductionSection();
  }

  function renderTimingRow(selected) {
    // A lump sum is the only thing timing applies to, and only the two
    // lump-sum cases have one. The row is dimmed rather than hidden, and the
    // sentence says why, so the client is not left with a dead control.
    const anyLump = set.cases.some((item) => item.hasLump);
    refs.timing.hidden = !anyLump;
    if (!anyLump) return;

    const isActive = selected.hasLump;
    refs.timing.classList.toggle('is-inactive', !isActive);

    const authored = set.lumpSumMonth;
    const offsets = lumpYearOffsets;

    refs.timingPills.replaceChildren(...offsets.map((offset) => {
      const on = offset * 12 === authored;
      const pill = el('button', 'rcm-pill', offset === 0
        ? `Now (${set.startYear})`
        : String(set.startYear + offset));
      pill.type = 'button';
      pill.classList.toggle('is-active', on);
      pill.disabled = !isActive;
      pill.setAttribute('role', 'radio');
      pill.setAttribute('aria-checked', on ? 'true' : 'false');
      pill.addEventListener('click', () => selectLumpYear(offset));
      return pill;
    }));

    if (!isActive) {
      refs.timingNote.textContent = 'This case has no lump sum, so the timing does not apply. It applies to the '
        + 'cases that have one.';
      return;
    }

    // STATED FOR THE SELECTED CASE ONLY, never as a total across cases, so it
    // cannot contradict the hero directly above it.
    const currentOffset = authored / 12;
    const alternateOffset = currentOffset === 0 ? offsets[offsets.length - 1] : 0;
    if (alternateOffset === currentOffset) {
      refs.timingNote.textContent = '';
      return;
    }

    const alternate = buildCaseSet(rawInputs, engineOptions, alternateOffset * 12)
      .cases.find((item) => item.id === selected.id);
    if (!alternate) {
      refs.timingNote.textContent = '';
      return;
    }

    const thisYear = set.startYear + currentOffset;
    const otherYear = set.startYear + alternateOffset;
    const difference = Math.abs(alternate.interest - selected.interest);
    const lumpSum = set.comparison.cases
      .find((item) => item.id === selected.id)?.projection.lumpSumApplied || 0;
    const lumpLabel = lumpSum > EPSILON ? `same ${eur(lumpSum)}` : 'same lump sum';

    refs.timingNote.textContent = alternateOffset > currentOffset
      ? `Paid in ${thisYear} rather than ${otherYear}, the ${lumpLabel} removes ${eur(difference)} more interest `
        + 'in this case.'
      : `Deferred to ${thisYear} rather than ${otherYear}, the ${lumpLabel} removes ${eur(difference)} less `
        + 'interest in this case.';
  }

  function renderTable() {
    const { columns, rows } = set.comparison.comparisonTable
      || { columns: [], rows: [] };
    if (columns.length === 0) {
      refs.table.replaceChildren();
      refs.table.hidden = true;
      return;
    }
    refs.table.hidden = false;

    const thead = el('thead');
    const headRow = el('tr');
    columns.forEach((column) => headRow.append(el('th', null, column)));
    thead.append(headRow);

    const tbody = el('tbody');
    rows.forEach((row, index) => {
      const tr = el('tr');
      tr.classList.toggle('is-active', index === selectedIndex);
      row.forEach((cell, cellIndex) => {
        const td = el('td', cellIndex === 0 ? 'rcm-table-case' : null, cell);
        if (cellIndex === columns.length - 1) td.classList.add('rcm-table-per-euro');
        tr.append(td);
      });
      tbody.append(tr);
    });

    refs.table.replaceChildren(thead, tbody);
  }

  function renderMeaningNote() {
    // The worked example follows the lump-sum year, because a note that keeps
    // quoting the 2026 figures beside a table showing 2029's is a note the
    // client has to be told to ignore.
    const worked = set.cases.find((item) => item.hasLump && item.perEuro !== null)
      || set.cases.find((item) => item.perEuro !== null);

    refs.meaningBody.replaceChildren();
    if (!worked) {
      refs.meaningBody.append('It is the interest you avoid, divided by the money you put in to avoid it. A figure '
        + 'below €1 is not a loss: the money you pay in is not a fee, it comes straight off what you owe either '
        + 'way. This column only ranks how hard each euro worked at removing interest — it is not a return, an '
        + 'interest rate, or a product yield.');
      return;
    }

    refs.meaningBody.append('It is the interest you avoid, divided by the money you put in to avoid it. ');
    refs.meaningBody.append(`${worked.title} puts in `);
    refs.meaningBody.append(el('span', 'rcm-inline-figure', eur(worked.paidIn)));
    refs.meaningBody.append(' and avoids ');
    refs.meaningBody.append(el('span', 'rcm-inline-figure', eur(worked.saved)));
    refs.meaningBody.append(' of interest, so each euro of it takes ');
    refs.meaningBody.append(el('span', 'rcm-inline-figure', eur2(worked.perEuro)));
    refs.meaningBody.append(' of interest off the bill. A figure below €1 is not a loss: the money you pay in is '
      + 'not a fee, it comes straight off what you owe either way, and every case here still clears the '
      + `${loanKind} years early. This column only ranks how hard each euro worked at removing interest — it is `
      + 'not a return, an interest rate, or a product yield.');
  }

  /**
   * The other thing a lump sum can do: keep the term, lower the repayment.
   *
   * Both bars share one scale from zero, so a repayment that falls by eight
   * per cent is shown falling by eight per cent. The difference figure is NOT
   * put inside the gap between them -- at true scale it never fits.
   */
  function renderReductionSection() {
    const reduction = set.repaymentReduction;
    refs.reductionSection.replaceChildren();
    refs.reductionSection.hidden = !reduction;
    if (!reduction) return;

    const header = el('div', 'rcm-reduction-header');
    header.append(el('div', 'rcm-eyebrow', 'If you keep the term instead'));
    header.append(el('h2', 'rcm-reduction-title',
      `What a ${eur(reduction.lumpSum)} lump sum does to the monthly repayment`));
    header.append(el('p', 'rcm-reduction-lede',
      `A lender can keep the ${loanKind} running to ${termEndLabelLong()} and recalculate the repayment against the `
      + 'smaller balance. The term does not move, so what changes is the amount leaving your account each month.'));
    refs.reductionSection.append(header);

    const card = el('div', 'rcm-card rcm-reduction-card');

    const nowBlock = el('div', 'rcm-band');
    const nowRow = el('div', 'rcm-split-row rcm-split-row-baseline');
    nowRow.append(el('span', 'rcm-eyebrow', 'Now'));
    nowRow.append(el('span', 'rcm-reduction-figure', eur2(reduction.contractualPayment)));
    const nowBar = el('div', 'rcm-payment-bar');
    nowBar.append(el('div', 'rcm-payment-fill-now'));
    nowBlock.append(nowRow, nowBar);

    const afterBlock = el('div', 'rcm-band');
    const afterRow = el('div', 'rcm-split-row rcm-split-row-baseline');
    afterRow.append(el('span', 'rcm-eyebrow rcm-eyebrow-amber', 'After the lump sum, same term'));
    afterRow.append(el('span', 'rcm-reduction-figure', eur2(reduction.newPayment)));
    const afterBar = el('div', 'rcm-payment-bar');
    const afterFill = el('div', 'rcm-payment-fill-after');
    const afterWidth = clamp((reduction.newPayment / reduction.contractualPayment) * 100, 0, 100);
    afterFill.style.width = `${afterWidth.toFixed(2)}%`;
    const afterHatch = el('div', 'rcm-payment-hatch');
    afterHatch.style.left = `${afterWidth.toFixed(2)}%`;
    afterBar.append(afterFill, afterHatch);
    afterBlock.append(afterRow, afterBar, el('div', 'rcm-payment-caption',
      `Recalculated against the smaller balance, still running to ${termEndLabelLong()}.`));

    const bars = el('div', 'rcm-payment-bars');
    bars.append(nowBlock, afterBlock);
    card.append(bars);

    const stats = el('div', 'rcm-stat-row');
    [
      ['Freed each month', eur2(reduction.monthlyReduction)],
      [
        'Over the rest of the term',
        `${eur(reduction.freedOverRemainingTerm)} over ${formatMonthsDurationLong(reduction.monthsAtNewPayment)}`
      ],
      [freeWord, `${termEndLabel()} · unchanged`]
    ].forEach(([label, value]) => {
      const stat = el('div', 'rcm-stat');
      stat.append(el('span', 'rcm-eyebrow', label));
      stat.append(el('span', 'rcm-stat-value', value));
      stats.append(stat);
    });
    card.append(stats);

    // THE TRADE, SAID OUT LOUD. A lower repayment looks like a saving on its
    // own, and the only honest way to show it beside a shorter term is to
    // price what the extra years of interest cost.
    const shorterPayoff = reduction.shorterTermPayoffDateIso
      ? formatMonthYear(reduction.shorterTermPayoffDateIso)
      : termEndLabel();
    card.append(el('p', 'rcm-reduction-note',
      `The repayment falls to ${eur2(reduction.newPayment)} because the same balance is now smaller but still `
      + `spread to ${termEndLabelLong()}. Because the ${loanKind} keeps running for the full term, the interest `
      + 'bill '
      + `comes to ${eur(reduction.totalInterestLifetime)} — ${eur(reduction.interestSavedVsBase)} less than doing `
      + `nothing, but ${eur(reduction.extraInterestVsShorterTerm)} more interest than if you had kept the repayment `
      + `at ${eur2(reduction.contractualPayment)} and let the ${loanKind} clear in ${shorterPayoff}. Lower `
      + 'repayments cost more interest over a longer term. That is the trade: you keep '
      + `${eur2(reduction.monthlyReduction)} a month in your account now, and pay for it in interest later.`));

    refs.reductionSection.append(card);
  }

  /* ------------------------------------------------- the parts that move */

  function pathData(points) {
    return points
      .map((point, index) => `${index ? 'L' : 'M'}${point[0].toFixed(1)} ${point[1].toFixed(1)}`)
      .join(' ');
  }

  /** Sampled every three months: enough to draw the curve, cheap to tween. */
  function samplePath(balances) {
    const points = [];
    const step = Math.max(1, Math.round(set.termMonths / 108));
    for (let month = 0; month <= set.termMonths; month += step) {
      const balance = month < balances.length ? balances[month] : 0;
      points.push([
        (month / set.termMonths) * 1000,
        205 - ((balance / set.openingBalance) * 190)
      ]);
    }
    return points;
  }

  function paint() {
    const selected = currentCase();
    const previous = fromCase();
    const base = set.cases[baseIndex];
    const t = anim.t;
    const baseInterest = set.baseInterest || 1;

    // EVERY FIGURE DERIVED FROM THE CLOCK IS CLAMPED. A duration must never
    // render negative, and a percentage must never exceed what the base case
    // could possibly give back.
    const monthsNow = clamp(mix('months'), 0, set.termMonths);
    const interestNow = clamp(mix('interest'), 0, baseInterest);
    const savedNow = clamp(mix('saved'), 0, baseInterest);
    const paidInNow = Math.max(0, mix('paidIn'));
    const fraction = monthsNow / set.termMonths;

    // A DATE IS NOT A QUANTITY. Rolling its digits would claim the client is
    // mortgage-free in a month that exists in neither case, so the date and
    // every subline beside it switch at the midpoint instead -- all on the
    // same midpoint, because "Dec 2052" above "3 years 7 months sooner than
    // December 2052" is exactly the contradiction this module exists to avoid.
    const shown = t < 0.5 ? previous : selected;

    refs.heroDate.textContent = shown.payoffDateIso
      ? formatMonthYear(shown.payoffDateIso)
      : termEndLabel();
    refs.heroDate.style.opacity = (0.4 + (0.6 * Math.abs(t - 0.5) * 2)).toFixed(3);
    refs.heroDateSub.textContent = shown.monthsSaved > 0
      ? `${formatMonthsDurationLong(shown.monthsSaved)} sooner than ${termEndLabelLong()}.`
      : 'The last payment on your current terms, with nothing added.';

    refs.heroPct.textContent = `${Math.max(0, Math.round((savedNow / baseInterest) * 100))}%`;
    refs.heroSaved.textContent = savedNow > 500 ? eur(savedNow) : eur(0);
    refs.heroPctSub.textContent = shown.saved > 0
      ? `Of the ${eur(baseInterest)} interest bill, for ${eur(shown.paidIn)} of your own money.`
      : 'The full interest bill, paid in full over the original term.';

    const widthPct = `${(fraction * 100).toFixed(2)}%`;
    refs.railFill.style.width = widthPct;
    refs.railRemainder.style.left = widthPct;
    refs.railMarker.style.left = widthPct;
    refs.payingLabel.textContent = `Still paying · ${formatMonthsDurationLong(monthsNow)}`;
    refs.freeLabel.textContent = shown.monthsSaved > 0
      ? `${formatMonthsDurationLong(set.termMonths - monthsNow)} ${freeWordLower}`
      : 'Paying to the end of the term';

    refs.baseInterestLabel.textContent = eur(baseInterest);
    refs.interestFill.style.width = `${((interestNow / baseInterest) * 100).toFixed(2)}%`;
    refs.interestFigure.textContent = eur(interestNow);
    refs.freedLabel.textContent = savedNow > 500 ? `${eur(savedNow)} you never pay` : 'Nothing removed';

    const paidInWidth = clamp((paidInNow / baseInterest) * 100, 0, 100);
    refs.costFill.style.width = `${paidInWidth.toFixed(2)}%`;
    // At zero width the fill would still draw its rounded end and read as a
    // small amount of money rather than none.
    refs.costFill.classList.toggle('is-empty', paidInNow <= 100);
    refs.costFigure.textContent = paidInNow > 100 ? eur(paidInNow) : 'Nothing';
    refs.perEuroLabel.textContent = selected.perEuro === null
      ? '—'
      : `${eur2(selected.perEuro)} of interest avoided per €1 in`;

    // The curve is interpolated frame by frame between the two schedules so it
    // lands under the marker at the same instant the marker stops.
    const fromPoints = samplePath(previous.balances);
    const toPoints = samplePath(selected.balances);
    const casePoints = fromPoints.map((point, index) => [
      point[0],
      point[1] + ((toPoints[index][1] - point[1]) * t)
    ]);
    const basePoints = samplePath(base.balances);

    refs.balanceCasePath.setAttribute('d', pathData(casePoints));
    refs.balanceBasePath.setAttribute('d', pathData(basePoints));
    refs.balanceArea.setAttribute('d', `${pathData(casePoints)} ${basePoints
      .slice()
      .reverse()
      .map((point) => `L${point[0].toFixed(1)} ${point[1].toFixed(1)}`)
      .join(' ')} Z`);
    setAttrs(refs.balanceMarker, { x1: (fraction * 1000).toFixed(1), x2: (fraction * 1000).toFixed(1) });
    refs.balanceChartLabel.textContent = shown.monthsSaved > 0
      ? 'What you still owe · shaded: the balance you never carry'
      : 'What you still owe · your current path';

    paintYearColumns(previous, selected, base, t);
  }

  function paintYearColumns(previous, selected, base, t) {
    const count = set.years.length;
    const width = 1000 / count;
    const tallest = Math.max(...base.yearInterest, 1);

    if (refs.yearSvg.childElementCount !== count * 2) {
      const nodes = [];
      for (let index = 0; index < count; index += 1) {
        nodes.push(svgEl('rect', { fill: 'none', stroke: 'rgba(190, 202, 207, 0.34)', 'stroke-width': '1' }));
        nodes.push(svgEl('rect', { fill: 'rgba(78, 176, 255, 0.5)' }));
      }
      refs.yearSvg.replaceChildren(...nodes);
    }

    for (let index = 0; index < count; index += 1) {
      const outline = refs.yearSvg.children[index * 2];
      const solid = refs.yearSvg.children[(index * 2) + 1];
      const baseValue = base.yearInterest[index] || 0;
      const from = previous.yearInterest[index] || 0;
      const to = selected.yearInterest[index] || 0;
      const value = clamp(from + ((to - from) * t), 0, tallest);

      const baseHeight = (baseValue / tallest) * 180;
      const caseHeight = (value / tallest) * 180;
      const x = ((index * width) + 2).toFixed(1);
      const w = Math.max(1, width - 4).toFixed(1);

      setAttrs(outline, { x, width: w, y: (190 - baseHeight).toFixed(1), height: baseHeight.toFixed(1) });
      setAttrs(solid, { x, width: w, y: (190 - caseHeight).toFixed(1), height: caseHeight.toFixed(1) });
    }
  }

  function renderAxes() {
    refs.balanceAxis.replaceChildren(
      el('span', null, String(set.startYear)),
      el('span', null, String(set.years[set.years.length - 1]))
    );
    refs.yearAxis.replaceChildren(
      el('span', null, String(set.startYear)),
      el('span', null, String(set.years[Math.floor((set.years.length - 1) / 2)])),
      el('span', null, String(set.years[set.years.length - 1]))
    );

    // A tick every four years, positioned by month so it sits over the same
    // point on the rail as it does on the chart below.
    const ticks = [];
    for (let year = set.startYear; year <= set.years[set.years.length - 1]; year += 4) {
      const months = (year - set.startYear) * 12;
      const tick = el('span', 'rcm-rail-tick', String(year));
      tick.style.left = `${((months / set.termMonths) * 100).toFixed(2)}%`;
      ticks.push(tick);
    }
    refs.railTicks.replaceChildren(...ticks);
  }

  renderAxes();
  renderStatic();
  paint();

  return root;
}
