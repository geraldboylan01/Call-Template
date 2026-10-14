/**
 * THE GOALS AND RESOURCES SCREEN, WITHOUT A SCREEN.
 *
 * Everything the screen decides that is not a DOM node lives here: the words,
 * the geometry of the two pictures at every width, and where each label sits.
 * It is pure, so a check can ask it questions in Node, without a browser, and
 * `js/goals_and_resources_module.js` only has to draw what it is told.
 *
 * Every amount comes from `js/goals_and_resources_math.js`. Nothing here is
 * calculated except stacking the goals against the money the household has,
 * which is placing, not maths.
 *
 * THE TWO PICTURES. "Your money now" (spare cash, a one-off) and "Your money
 * each year" (what is left over each year) are never drawn on one scale and
 * never added. Each has its own scale, and the yearly scale is the same in
 * every case, so when a case is clicked the marks move and nothing rescales.
 *
 * THE SHORT STATE. Money you do not have is a red outline with a light tint,
 * and a solid red square sits beside the word. Red is never alone: a word
 * always sits beside it. It is the same treatment as the household cash flow
 * screen.
 *
 * THE SCREEN NEVER NAMES THE HOUSEHOLD. The payload carries first names for
 * the engine's sake; none of them reaches a string here.
 */

/** From this container width the two pictures sit side by side with the goals beside the yearly one. */
export const WIDE_MIN_WIDTH = 1740;

/** From this width the two pictures sit side by side and the goals sit under them. */
export const PAIR_MIN_WIDTH = 760;

/** Every word on the screen that is not derived from a figure. */
export const GAR_WORDS = Object.freeze({
  title: 'Your goals and resources',
  question: 'Can your money do everything you want?',
  paidLabel: 'Paid out over the life of your goals',
  nowTitle: 'Your money now',
  nowSub: 'After your emergency reserve',
  yearTitle: 'Your money each year',
  yearSub: 'In this order: the costs that come soonest, your mortgage, then retirement',
  goalsTitle: 'Your goals, in order',
  haveLabel: 'What you have',
  useLabel: 'What you use',
  needLabel: 'What your goals need',
  aYear: 'a year',
  collegeFund: 'College fund',
  mortgage: 'Mortgage',
  retirement: 'Retirement',
  leftOver: 'Left over',
  shortBy: 'Short by',
  toSpare: 'To spare',
  atTheLimit: 'At the most income tax relief allows, and still short of your target.',
  groupLabel: 'Ways to use your cash'
});

/** The word beside the square in the yearly picture, by what the money amounts to. */
const YEAR_LABELS = Object.freeze({
  short: GAR_WORDS.shortBy,
  spare: GAR_WORDS.toSpare,
  left: GAR_WORDS.leftOver
});

/**
 * The geometry of the two layouts, in pixels. The wide set is the 1920 frame
 * and the compact set is the phone frame; the side-by-side layout between them
 * reuses the compact pictures at their phone size.
 */
const GEOMETRY = Object.freeze({
  // `plot` is the height the scale draws in; `box` is the room the picture has,
  // a little more, so that the note under the line and the label beside the
  // short part still fit when what you have is the largest figure on the screen.
  wide: Object.freeze({
    year: Object.freeze({
      plot: 331, box: 380, haveW: 150, needLeft: 220, needW: 190, waterW: 410, ceilW: 560,
      labelLeft: 432, labelW: 270, labelH: 64, noteW: 170, noteH: 38, noteGap: 8,
      goalsLeft: 740, goalsMinW: 320, nameMin: 26
    }),
    now: Object.freeze({
      plot: 330, box: 331, haveW: 130, useLeft: 220, useW: 170, ceilW: 390, nameMin: 28,
      sideLeft: 410, sideW: 134, sideTops: Object.freeze([0, 96, 192])
    })
  }),
  compact: Object.freeze({
    year: Object.freeze({
      plot: 250, box: 338, haveW: 84, needLeft: 130, needW: 112, waterW: 242, ceilW: 242,
      labelLeft: 130, labelW: 196, labelH: 50, noteW: 116, noteH: 34, noteGap: 8,
      goalsLeft: 0, goalsMinW: 0, nameMin: 22
    }),
    now: Object.freeze({
      plot: 200, box: 201, haveW: 84, useLeft: 130, useW: 112, ceilW: 242, nameMin: Infinity,
      sideLeft: 0, sideW: 0, sideTops: Object.freeze([])
    })
  })
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

const eur = (amount) => `${amount < 0 ? '−' : ''}€${Math.abs(Math.round(amount)).toLocaleString('en-IE')}`;
const years = (count) => `${count} ${count === 1 ? 'year' : 'years'}`;

/* ------------------------------------------------------------------ model */

function repaymentVerb(monthly, today) {
  const a = Math.round(monthly);
  const b = Math.round(today);
  if (a === b) return 'stays at';
  return a > b ? 'rises to' : 'falls to';
}

const CHILD_ORDINALS = Object.freeze(['First', 'Second', 'Third', 'Fourth']);

/** One goal as the screen shows it: its block in the picture and its row in the list. */
function buildGoal(goal, entry, debug, children) {
  const { need, covered } = goal;
  const partly = goal.state === 'partly' ? `${eur(covered)} of ${eur(need)} a year` : '';
  const common = {
    name: goal.title,
    need,
    covered,
    state: goal.state,
    stateWord: goal.stateWord
  };

  if (goal.kind === 'college') {
    const child = entry.college.perChild.find((candidate) => candidate.id === goal.goal);
    const lump = child ? child.lumpSumToday : 0;
    let detail = '';
    if (lump > 0.5 && need <= 0.5) detail = `Paid today with ${eur(lump)}`;
    else if (lump > 0.5) detail = `After ${eur(lump)} today`;
    // A child is "first", "second" and so on, by position, whatever the payload
    // calls them: the screen never carries a name.
    const position = Math.max(0, children.findIndex((candidate) => candidate.id === goal.goal));
    const ordinal = `${CHILD_ORDINALS[position] || `Child ${position + 1}`} child`;
    return {
      ...common,
      name: `College, ${ordinal.toLowerCase()}`,
      key: goal.goal,
      kind: 'college',
      shortName: ordinal,
      amount: need > 0.5 ? `${eur(need)} a year for ${years(child ? child.savingYears : 0)}` : 'Nothing a year',
      detail: partly || detail
    };
  }

  if (goal.kind === 'mortgage') {
    const change = entry.mortgage.yearlyChange;
    let amount = 'Nothing more a year';
    if (change > 0.5) amount = `${eur(change)} a year more`;
    if (change < -0.5) amount = `${eur(-change)} a year less`;
    const detail = debug.mortgageAlreadyEnds
      ? goal.note
      : `Repayment ${repaymentVerb(entry.mortgage.monthlyPayment, entry.mortgage.todayMonthlyPayment)} `
        + `${eur(entry.mortgage.monthlyPayment)} a month`;
    return {
      ...common,
      key: 'mortgage',
      kind: 'mortgage',
      shortName: GAR_WORDS.mortgage,
      amount,
      detail: partly || detail
    };
  }

  // At the most income tax relief allows, a target can still be out of reach.
  // The money is then found and the target is not met, so "€X of €X a year"
  // would be nonsense: say what is true instead.
  const capped = entry.pension.reachedCap && entry.pension.gapLeftOver > 0.5;
  let detail = partly || (need > 0.5 ? 'after income tax relief' : 'Already on track at what you pay in now');
  if (capped) {
    detail = partly && covered < need - 0.5 ? `${partly}. ${GAR_WORDS.atTheLimit}` : GAR_WORDS.atTheLimit;
  }
  return {
    ...common,
    key: 'retirement',
    kind: 'retirement',
    shortName: GAR_WORDS.retirement,
    amount: need > 0.5 ? `${eur(need)} a year` : 'Nothing more a year',
    detail
  };
}

/**
 * The model the screen draws, from one projection. One entry per case; the
 * yearly axis maximum is over every case so the scale never moves.
 */
export function buildGarModel(projection) {
  const { debug } = projection;
  const { inputs } = debug;
  const laterLabel = debug.cases[0] && debug.cases[0].laterRetirement
    ? debug.cases[0].laterRetirement.words.label
    : '';
  const leftOver = inputs.leftOverEachYear;

  const cases = debug.cases.map((entry) => {
    const freed = Math.max(0, -entry.mortgage.yearlyChange);
    const goals = entry.states.map((goal) => buildGoal(goal, entry, debug, inputs.children));
    const needTotal = goals.reduce((sum, goal) => sum + goal.need, 0);
    const haveTotal = leftOver + freed;
    const short = Math.max(0, needTotal - haveTotal);
    const spare = Math.max(0, haveTotal - needTotal);
    // What the yearly money amounts to is the engine's to say, so the screen and
    // the presenter cannot disagree: short, spare (every goal covered), or left
    // over (money found and a goal still not met).
    const { state } = entry.words;
    const laterWords = entry.laterRetirement ? entry.laterRetirement.words : null;

    return {
      id: entry.id,
      title: entry.title,
      cashLine: entry.words.amountLine,
      needed: eur(entry.neededThisYear),
      neededNote: freed > 0.5 ? `after ${eur(freed)} freed` : '',
      paid: eur(entry.paidOutOverLife.total),
      later: laterWords
        ? {
          needed: eur(entry.laterRetirement.neededThisYear),
          neededLine: laterWords.neededLine,
          result: laterWords.result,
          kind: laterWords.state
        }
        : null,
      headline: { text: entry.words.headline, kind: state },
      support: entry.words.support,
      now: {
        cash: inputs.spareCash,
        college: entry.collegeLump,
        mortgage: entry.mortgageLump,
        left: entry.cashLeft,
        usedText: eur(entry.collegeLump + entry.mortgageLump),
        collegeText: eur(entry.collegeLump),
        mortgageText: eur(entry.mortgageLump),
        leftText: eur(entry.cashLeft)
      },
      year: {
        base: leftOver,
        freed,
        haveTotal,
        needTotal,
        short,
        spare,
        kind: state,
        label: YEAR_LABELS[state],
        amountText: eur(state === 'short' ? short : spare),
        haveText: eur(haveTotal),
        needText: eur(needTotal),
        freedNote: freed > 0.5 ? `${eur(freed)} freed by a lower repayment` : '',
        goals
      }
    };
  });

  const yearMax = Math.max(1, ...cases.map((entry) => Math.max(entry.year.needTotal, entry.year.haveTotal)));

  return {
    cases,
    baseId: debug.baseScenarioId,
    axis: { yearMax, cash: Math.max(1, inputs.spareCash) },
    cashText: eur(inputs.spareCash),
    haveNow: inputs.spareCash > 0,
    labels: {
      needed: `Needed this year, against the ${eur(leftOver)} you have`,
      later: laterLabel
    },
    hasLater: laterLabel !== '' && cases.every((entry) => entry.later),
    goalCount: cases.reduce((most, entry) => Math.max(most, entry.year.goals.length), 0)
  };
}

/* ----------------------------------------------------------------- layout */

/**
 * The geometry for one width. Three arrangements: the 1920 frame (two panels,
 * the goals beside the yearly picture), the same two pictures at phone size
 * side by side with the goals under them, and the phone's single column. The
 * pictures themselves are drawn at one of two sizes.
 */
export function layoutGar(model, { width }) {
  const mode = width >= WIDE_MIN_WIDTH ? 'wide' : (width >= PAIR_MIN_WIDTH ? 'pair' : 'single');
  const wide = mode === 'wide';
  const set = wide ? GEOMETRY.wide : GEOMETRY.compact;
  return {
    mode,
    wide,
    width,
    year: set.year,
    now: set.now,
    kYear: set.year.plot / model.axis.yearMax,
    kNow: set.now.plot / model.axis.cash
  };
}

/** Where every mark in "your money each year" sits for one case. */
export function placeYear(layout, entry) {
  const k = layout.kYear;
  const water = entry.year.haveTotal * k;
  let cumulative = 0;
  const blocks = entry.year.goals.map((goal) => {
    const top = cumulative * k;
    const end = (cumulative + goal.need) * k;
    cumulative += goal.need;
    const inEnd = Math.min(end, water);
    const outTop = Math.max(top, water);
    return {
      inTop: top + 1,
      inH: Math.max(0, inEnd - top),
      outTop: outTop + 1,
      outH: Math.max(0, end - outTop),
      nameTop: top + ((end - top) / 2) - 8,
      height: end - top
    };
  });
  const bottom = cumulative * k;

  // Beside the need column on a wide screen, so the short part and its label
  // read as one; under it on a smaller one, where there is no room beside.
  const middle = (water + bottom) / 2;
  const lowest = layout.year.box - layout.year.labelH;
  let shortTop;
  if (layout.wide) {
    const wanted = entry.year.kind === 'short' ? Math.max(water, middle - 36) : middle - (layout.year.labelH / 2);
    shortTop = Math.min(lowest, Math.max(0, wanted));
  } else {
    shortTop = Math.max(bottom, water) + 12;
  }

  return {
    haveBaseH: entry.year.base * k,
    freedTop: 1 + (entry.year.base * k),
    freedH: entry.year.freed * k,
    noteTop: 1 + water + layout.year.noteGap,
    waterTop: water,
    blocks,
    bottom,
    shortTop
  };
}

/** Where every mark in "your money now" sits for one case. */
export function placeNow(layout, entry) {
  const k = layout.kNow;
  const collegeH = entry.now.college * k;
  const mortgageH = entry.now.mortgage * k;
  const leftH = entry.now.left * k;
  return {
    collegeH,
    mortgageTop: 1 + collegeH,
    mortgageH,
    leftTop: 1 + collegeH + mortgageH,
    leftH,
    collegeNameTop: 1 + (collegeH / 2) - 10,
    mortgageNameTop: 1 + collegeH + (mortgageH / 2) - 10
  };
}

/** Everything that moves on a click, as plain numbers, so it can be blended. */
export function garValues(layout, entry) {
  const year = placeYear(layout, entry);
  const now = placeNow(layout, entry);
  const values = {
    haveBaseH: year.haveBaseH,
    freedTop: year.freedTop,
    freedH: year.freedH,
    noteTop: year.noteTop,
    waterTop: year.waterTop,
    shortTop: year.shortTop,
    collegeH: now.collegeH,
    mortgageTop: now.mortgageTop,
    mortgageH: now.mortgageH,
    leftTop: now.leftTop,
    leftH: now.leftH,
    collegeNameTop: now.collegeNameTop,
    mortgageNameTop: now.mortgageNameTop
  };
  year.blocks.forEach((block, index) => {
    values[`g${index}InTop`] = block.inTop;
    values[`g${index}InH`] = block.inH;
    values[`g${index}OutTop`] = block.outTop;
    values[`g${index}OutH`] = block.outH;
    values[`g${index}NameTop`] = block.nameTop;
    values[`g${index}Height`] = block.height;
  });
  return values;
}

/** A blend of two sets of values, `progress` of the way from `from` to `to`. */
export function lerpGarValues(from, to, progress) {
  const out = {};
  const keys = Object.keys(to);
  // Exact at the end, so the settled frame is the target and not a rounding
  // of it: the drawn state after any run must equal a fresh render.
  if (progress >= 1) {
    keys.forEach((key) => { out[key] = to[key]; });
    return out;
  }
  keys.forEach((key) => {
    const start = Number.isFinite(from[key]) ? from[key] : to[key];
    out[key] = progress <= 0 ? start : start + ((to[key] - start) * progress);
  });
  return out;
}

/** The accessible names of the two pictures, which the screen does not say twice. */
export function plotLabels(entry) {
  return {
    now: `Your money now: you have ${eur(entry.now.cash)}, and ${entry.now.usedText} of it goes into your goals, `
      + `leaving ${entry.now.leftText}.`,
    year: `Your money each year: you have ${entry.year.haveText} a year and your goals need ${entry.year.needText} a year. `
      + (entry.year.kind === 'short'
        ? `You’re short by ${entry.year.amountText} a year.`
        : `You have ${entry.year.amountText} a year ${entry.year.kind === 'spare' ? 'to spare' : 'left over'}.`)
  };
}

/* ------------------------------------------------------------------ checks */

/** Every string the screen would show for a model, for a words scan. */
export function collectGarStrings(model) {
  const out = [...Object.values(GAR_WORDS)];
  out.push(model.labels.needed, model.labels.later);
  model.cases.forEach((entry) => {
    out.push(entry.title, entry.cashLine, entry.needed, entry.neededNote, entry.paid,
      entry.headline.text, entry.support, entry.year.label, entry.year.freedNote,
      entry.year.amountText, entry.year.haveText, entry.year.needText);
    if (entry.later) out.push(entry.later.needed, entry.later.neededLine, entry.later.result);
    entry.year.goals.forEach((goal) => {
      out.push(goal.shortName, goal.name, goal.amount, goal.detail, goal.stateWord);
    });
    const labels = plotLabels(entry);
    out.push(labels.now, labels.year);
  });
  return out.filter((text) => typeof text === 'string' && text.length > 0);
}

/**
 * What must never be on screen. Returns a list of problems, empty when clean.
 * `names` is the people in the payload: none of them may appear.
 */
export function findForbiddenText(strings, { names = [] } = {}) {
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
    names.forEach((name) => {
      if (name && new RegExp(`\\b${name}\\b`, 'i').test(text)) problems.push(`"${text}" names ${name}`);
    });
  });
  return problems;
}

/**
 * Ask the geometry whether it holds, for every case at one layout. An empty
 * list is a screen that fits: nothing sits outside its picture, nothing in the
 * yearly picture overlaps, and the same euro is the same height in every case.
 */
export function checkGarGeometry(layout, model) {
  const problems = [];
  const tolerance = 0.01;
  const yx = layout.year;
  const nx = layout.now;

  if (yx.haveW + 8 > yx.needLeft) problems.push('the have column runs into the need column');
  if (yx.noteW + 8 > yx.needLeft) problems.push('the freed note runs into the need column');
  if (yx.needLeft + yx.needW > yx.waterW + tolerance) problems.push('the waterline stops short of the need column');
  if (yx.waterW > yx.ceilW + tolerance) problems.push('the waterline is longer than the ceiling');
  if (layout.wide) {
    if (yx.labelLeft < yx.needLeft + yx.needW + 12) problems.push('the short label sits on the need column');
    if (yx.labelLeft + yx.labelW + 24 > yx.goalsLeft) problems.push('the short label runs into the goals');
  }
  if (nx.haveW + 8 > nx.useLeft) problems.push('the have column runs into the use column');
  if (nx.useLeft + nx.useW > nx.ceilW + tolerance) problems.push('the use column leaves the ceiling');

  model.cases.forEach((entry) => {
    const { id } = entry;
    const year = placeYear(layout, entry);
    const now = placeNow(layout, entry);

    let previousEnd = 0;
    year.blocks.forEach((block, index) => {
      const goal = entry.year.goals[index];
      if (Math.abs(block.height - (goal.need * layout.kYear)) > tolerance) {
        problems.push(`${id}: goal ${index} is not drawn on the yearly scale`);
      }
      if (Math.abs(block.inH + block.outH - block.height) > tolerance) {
        problems.push(`${id}: goal ${index} loses height at the line`);
      }
      if (block.outH > 0.5 && block.outTop - 1 < year.waterTop - tolerance) {
        problems.push(`${id}: goal ${index} shows short above the line`);
      }
      if (block.inH > 0.5 && (block.inTop - 1) + block.inH > year.waterTop + tolerance) {
        problems.push(`${id}: goal ${index} shows covered below the line`);
      }
      if (block.inTop - 1 < previousEnd - tolerance) {
        problems.push(`${id}: goal ${index} overlaps the one above`);
      }
      previousEnd = (block.inTop - 1) + block.height;
      if (previousEnd > yx.plot + tolerance) problems.push(`${id}: goal ${index} leaves the picture`);
    });

    if (entry.year.freed > 0.5 && year.noteTop + yx.noteH > yx.box + tolerance) {
      problems.push(`${id}: the freed note leaves the picture`);
    }
    if (year.shortTop < -tolerance) problems.push(`${id}: the short label leaves the top`);
    if (year.shortTop + yx.labelH > yx.box + tolerance) problems.push(`${id}: the short label leaves the bottom`);
    if (!layout.wide && year.shortTop < year.bottom + 8) problems.push(`${id}: the short label touches the need column`);

    const stacked = now.collegeH + now.mortgageH + now.leftH;
    const expected = (entry.now.college + entry.now.mortgage + entry.now.left) * layout.kNow;
    if (Math.abs(stacked - expected) > tolerance) problems.push(`${id}: your money now does not add up to the cash`);
    if (1 + stacked > nx.box + 1) problems.push(`${id}: your money now leaves the picture`);
  });

  return problems;
}
