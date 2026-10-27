import { projectGoalsAndResources } from './goals_and_resources_math.js';
import { GOALS_AND_RESOURCES_SAMPLE, withDesignTaxRules } from './tests_goals_and_resources_math.js';
import {
  GAR_WORDS,
  PAIR_MIN_WIDTH,
  WIDE_MIN_WIDTH,
  buildGarModel,
  checkGarGeometry,
  collectGarStrings,
  findForbiddenText,
  garValues,
  layoutGar,
  lerpGarValues,
  placeNow,
  placeYear,
  plotLabels
} from './goals_and_resources_view.js';

/**
 * The screen's own decisions, proved without a DOM: what it says, where it
 * sits, and that nothing it draws lands on anything else.
 *
 * THE WIDTHS. 390 is a phone, 760 is the first width that puts the two pictures
 * side by side, 1100 is a laptop pane, 1740 is the first width that puts the
 * goals beside the yearly picture, and 1776 is the design frame (a 1920 screen
 * less its gutters). Every case of every payload shape is checked at every one,
 * not just the sample.
 */

const WIDTHS = Object.freeze([252, 280, 320, 390, 500, 760, 1100, 1739, 1740, 1776, 1920]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function runCase(name, testFn) {
  try {
    testFn();
    console.info(`[GoalsAndResourcesViewTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[GoalsAndResourcesViewTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

const SAMPLE = GOALS_AND_RESOURCES_SAMPLE;
const withoutLater = (() => {
  const copy = { ...SAMPLE };
  delete copy.laterRetirement;
  return copy;
})();

/** Payload shapes the screen must hold up under, beyond the sample. */
const GAR_STRESS_SHAPES = Object.freeze([
  { name: 'the illustrative household', payload: SAMPLE },
  { name: 'one child', payload: { ...SAMPLE, children: [SAMPLE.children[0]] } },
  { name: 'four children', payload: { ...SAMPLE, children: [
    { id: 'c1', title: 'Aoife', age: 14 },
    { id: 'c2', title: 'Cian', age: 11 },
    { id: 'c3', title: 'Saoirse', age: 8 },
    { id: 'c4', title: 'Oisin', age: 5 }
  ] } },
  { name: 'a mortgage that ends before the age it is cleared by', payload: {
    ...SAMPLE, mortgage: { ...SAMPLE.mortgage, remainingTermYears: 9 }
  } },
  { name: 'money to spare in every case', payload: { ...SAMPLE, leftOverEachYear: 26_000 } },
  { name: 'no spare cash, so one case', payload: { ...SAMPLE, spareCash: 0 } },
  { name: 'no later retirement option', payload: withoutLater },
  { name: 'a hard target, retiring early', payload: {
    ...SAMPLE, retirement: { retirementAge: 55, targetIncomeToday: 120_000 }
  } },
  { name: 'money left this year, short in a later year', payload: {
    ...SAMPLE, leftOverEachYear: 14_500
  } },
  { name: 'a target out of reach at the relief limit', payload: {
    ...SAMPLE, retirement: { retirementAge: 55, targetIncomeToday: 200_000 }
  } },
  { name: 'a target out of reach at the relief limit, with the money to pay in the most', payload: {
    ...SAMPLE, leftOverEachYear: 30_000, retirement: { retirementAge: 55, targetIncomeToday: 200_000 }
  } }
]);

const modelCache = new Map();
function modelFor(payload) {
  if (!modelCache.has(payload)) {
    modelCache.set(payload, buildGarModel(projectGoalsAndResources(payload)));
  }
  return modelCache.get(payload);
}

const byId = (model, id) => model.cases.find((entry) => entry.id === id);

/** The frames are drawn on the rules in force when they were approved. */
export function runGoalsAndResourcesViewTests() {
  return withDesignTaxRules(runGoalsAndResourcesViewTestsOnDesignRules);
}

function runGoalsAndResourcesViewTestsOnDesignRules() {
  const cases = [];

  cases.push(runCase('The cases carry the engine\'s figures to the euro, as the approved frames show them', () => {
    const model = modelFor(SAMPLE);
    assertEqual(model.cases.map((entry) => entry.id).join(','),
      'cash-stays,college-today,mortgage-all-cash,mortgage-then-college', 'the four cases, in order');
    assertEqual(model.baseId, 'cash-stays', 'case 1 is the base');

    const expected = {
      'cash-stays': ['Nothing from your cash', '€20,062', '', '€834,168', '€10,797', 'still short by €4,797', 'short'],
      'college-today': ['€59,635 into the college fund', '€13,346', '', '€833,847', '€4,081', '€1,919 to spare', 'spare'],
      'mortgage-all-cash': ['€60,000 into the mortgage', '€14,736', 'after €1,245 freed', '€814,282', '€5,471', '€529 to spare', 'spare'],
      'mortgage-then-college': ['€45,974, then €14,026', '€14,402', '', '€818,855', '€5,137', '€863 to spare', 'spare']
    };
    Object.entries(expected).forEach(([id, [cash, needed, note, paid, later, result, kind]]) => {
      const entry = byId(model, id);
      assertEqual(entry.cashLine, cash, `${id}: the cash line`);
      assertEqual(entry.needed, needed, `${id}: needed this year`);
      assertEqual(entry.neededNote, note, `${id}: the freed note`);
      assertEqual(entry.paid, paid, `${id}: paid out over the life`);
      assertEqual(entry.later.needed, later, `${id}: the later option's needed`);
      assertEqual(entry.later.result, result, `${id}: the later option's result`);
      assertEqual(entry.later.kind, kind, `${id}: the later option's state`);
    });

    assertEqual(model.labels.needed, 'Needed this year, against the €6,000 you have', 'the needed label');
    assertEqual(model.labels.later, 'If you retire at 65 on €46,000', 'the later label');
    assertEqual(model.hasLater, true, 'a later option is shown');
  }));

  cases.push(runCase('The headline and the yearly picture say the same thing, in every case', () => {
    const model = modelFor(SAMPLE);
    const expected = {
      'cash-stays': 'You’re short by €14,062 a year',
      'college-today': 'You’re short by €7,346 a year',
      'mortgage-all-cash': 'You’re short by €8,736 a year',
      'mortgage-then-college': 'You’re short by €8,402 a year'
    };
    Object.entries(expected).forEach(([id, headline]) => {
      const entry = byId(model, id);
      assertEqual(entry.headline.text, headline, `${id}: the headline`);
      assertEqual(entry.headline.kind, 'short', `${id}: short`);
      assertEqual(entry.year.kind, 'short', `${id}: the picture is short`);
      assertEqual(`You’re short by ${entry.year.amountText} a year`, headline, `${id}: picture and headline agree`);
      assertEqual(entry.year.label, GAR_WORDS.shortBy, `${id}: the word beside the square`);
    });

    const spare = modelFor({ ...SAMPLE, leftOverEachYear: 26_000 });
    spare.cases.forEach((entry) => {
      assertEqual(entry.headline.kind, 'spare', `${entry.id}: spare`);
      assertEqual(entry.year.label, GAR_WORDS.toSpare, `${entry.id}: the word beside the square`);
      assertEqual(`You have ${entry.year.amountText} a year to spare`, entry.headline.text, `${entry.id}: agree`);
    });
  }));

  cases.push(runCase('The screen reads the engine\'s words and builds none of its own', () => {
    GAR_STRESS_SHAPES.forEach((shape) => {
      const projection = projectGoalsAndResources(shape.payload);
      const model = modelFor(shape.payload);
      model.cases.forEach((entry, index) => {
        const { words, laterRetirement } = projection.debug.cases[index];
        assertEqual(entry.title, words.title, `${shape.name} ${entry.id}: the title`);
        assertEqual(entry.cashLine, words.amountLine, `${shape.name} ${entry.id}: the amount line`);
        assertEqual(entry.headline.text, words.headline, `${shape.name} ${entry.id}: the headline`);
        assertEqual(entry.headline.kind, words.state, `${shape.name} ${entry.id}: what it amounts to`);
        assertEqual(entry.support, words.support, `${shape.name} ${entry.id}: the support line`);
        if (laterRetirement) {
          assertEqual(entry.later.result, laterRetirement.words.result, `${shape.name} ${entry.id}: the later result`);
          assertEqual(entry.later.neededLine, laterRetirement.words.neededLine, `${shape.name} ${entry.id}: the later needed line`);
          assertEqual(entry.later.kind, laterRetirement.words.state, `${shape.name} ${entry.id}: the later state`);
          assertEqual(model.labels.later, laterRetirement.words.label, `${shape.name}: the later label`);
        }
      });
    });
  }));

  cases.push(runCase('"To spare" is only said when every goal is covered; otherwise it is "left over"', () => {
    const atTheLimit = modelFor(GAR_STRESS_SHAPES.find(
      (shape) => shape.name === 'a target out of reach at the relief limit, with the money to pay in the most'
    ).payload);
    atTheLimit.cases.forEach((entry) => {
      assertEqual(entry.headline.kind, 'left', `${entry.id}: left over`);
      assert(/^You have €[\d,]+ a year left over$/.test(entry.headline.text), `${entry.id}: ${entry.headline.text}`);
      assertEqual(entry.support, 'Your retirement target is not met, even at the most income tax relief allows.', `${entry.id}: support`);
      assertEqual(entry.year.label, GAR_WORDS.leftOver, `${entry.id}: the word beside the picture`);
      assertEqual(entry.year.kind, 'left', `${entry.id}: the picture's state`);
      const labels = plotLabels(entry);
      assert(/left over\.$/.test(labels.year) && !/to spare/.test(labels.year), `${entry.id}: the accessible name (${labels.year})`);
      assert(entry.later.result.endsWith('to spare') || entry.later.result.endsWith('left over'), `${entry.id}: later result`);
    });

    // The later option follows the same rule when its own target is out of reach.
    const laterAtTheLimit = modelFor({
      ...SAMPLE,
      leftOverEachYear: 30_000,
      laterRetirement: { retirementAge: 58, targetIncomeToday: 200_000 }
    });
    laterAtTheLimit.cases.forEach((entry) => {
      assertEqual(entry.later.kind, 'left', `${entry.id}: the later option is left over`);
      assert(/^€[\d,]+ left over$/.test(entry.later.result), `${entry.id}: ${entry.later.result}`);
    });

    // And nowhere on the screen does a goal that is not met sit beside "to spare".
    GAR_STRESS_SHAPES.forEach((shape) => {
      modelFor(shape.payload).cases.forEach((entry) => {
        if (entry.year.goals.every((goal) => goal.state === 'covered')) return;
        assert(entry.headline.kind !== 'spare', `${shape.name} ${entry.id}: not "to spare" with a goal unmet`);
        assert(entry.year.label !== GAR_WORDS.toSpare, `${shape.name} ${entry.id}: the picture does not say "To spare"`);
      });
    });
  }));

  cases.push(runCase('Every goal row is the engine\'s state, in order, with its own words', () => {
    const model = modelFor(SAMPLE);
    const rows = (id) => byId(model, id).year.goals.map((goal) => [
      goal.name, goal.amount, goal.stateWord, goal.detail
    ].join(' | '));

    assertEqual(rows('cash-stays').join('\n'), [
      'College, first child | €3,603 a year for 8 years | Covered | ',
      'College, second child | €3,113 a year for 10 years | Partly covered | €2,397 of €3,113 a year. Covered from 2034.',
      'Your mortgage cleared by 60 | €4,081 a year more | Partly covered | Nothing this year. Covered from 2036.',
      'You retire at 62 on €50,000 a year | €9,265 a year | Partly covered | Nothing this year. Some of it from 2036, never all of it.'
    ].join('\n'), 'case 1');

    assertEqual(rows('college-today').join('\n'), [
      'College, first child | Nothing a year | Covered | Paid today with €28,689',
      'College, second child | Nothing a year | Covered | Paid today with €30,947',
      'Your mortgage cleared by 60 | €4,081 a year more | Covered | Repayment rises to €2,811 a month',
      'You retire at 62 on €50,000 a year | €9,265 a year | Partly covered | €1,919 of €9,265 a year'
    ].join('\n'), 'case 2');

    assertEqual(rows('mortgage-all-cash')[2],
      'Your mortgage cleared by 60 | €1,245 a year less | Covered | Repayment falls to €2,367 a month', 'case 3 mortgage');
    assertEqual(rows('mortgage-then-college')[2],
      'Your mortgage cleared by 60 | Nothing more a year | Covered | Repayment stays at €2,471 a month', 'case 4 mortgage');
    assertEqual(rows('mortgage-then-college')[0],
      'College, first child | €2,756 a year for 8 years | Covered | After €6,748 today', 'case 4 college');
  }));

  cases.push(runCase('A target out of reach at the relief limit says so, and never "€X of €X a year"', () => {
    ['a target out of reach at the relief limit',
      'a target out of reach at the relief limit, with the money to pay in the most'].forEach((name) => {
      const model = modelFor(GAR_STRESS_SHAPES.find((shape) => shape.name === name).payload);
      model.cases.forEach((entry) => {
        const retirement = entry.year.goals[entry.year.goals.length - 1];
        assert(
          retirement.detail.endsWith(GAR_WORDS.atTheLimit),
          `${name} ${entry.id}: the retirement row says it is at the limit (${retirement.detail})`
        );
        const same = /€([\d,]+) of €([\d,]+) a year/.exec(retirement.detail);
        assert(!same || same[1] !== same[2], `${entry.id}: no "€X of €X a year" (${retirement.detail})`);
        assert(retirement.state !== 'covered', `${name} ${entry.id}: never "covered" while the target is not met`);
      });
    });
    // And an ordinary target does not say it.
    const ordinary = modelFor(SAMPLE);
    ordinary.cases.forEach((entry) => {
      const retirement = entry.year.goals[entry.year.goals.length - 1];
      assert(!retirement.detail.includes(GAR_WORDS.atTheLimit), `${entry.id}: not at the limit`);
    });
  }));

  cases.push(runCase('Proposal A dates the timeline and preserves the three state words', () => {
    const later = modelFor({ ...SAMPLE, leftOverEachYear: 14_500 });
    const retirement = byId(later, 'mortgage-then-college').year.goals.at(-1);
    assertEqual(retirement.detail, 'Covered this year. Short from 2027, covered again from 2034.', 'covered now, short later, then covered again');
    const partial = byId(modelFor(SAMPLE), 'mortgage-then-college').year.goals.at(-1);
    assertEqual(partial.detail, '€863 of €9,265 a year', 'some this year, never all');

    const earlier = { ...SAMPLE, retirement: { retirementAge: 60, targetIncomeToday: 50_000 } };
    const initial = projectGoalsAndResources(earlier).debug.cases.find((entry) => entry.id === 'college-today');
    const projection = projectGoalsAndResources({ ...earlier, leftOverEachYear: initial.neededThisYear + 100 });
    const goal = byId(buildGarModel(projection), 'college-today').year.goals.at(-1);
    assertEqual(goal.coveredFromYear, null, 'no recovery before retirement');
    assert(goal.firstShortYear > 0, 'covered now, short in a later year');
    assertEqual(goal.detail, `Covered this year. Short from ${2026 + goal.firstShortYear}.`, 'short later and never covered again');

    const shifted = buildGarModel(projectGoalsAndResources(SAMPLE, { calculationYear: 2030 }));
    const mortgage = byId(shifted, 'cash-stays').year.goals.find((goal) => goal.kind === 'mortgage');
    assertEqual(mortgage.detail, `Nothing this year. Covered from ${2030 + mortgage.coveredFromYear}.`, 'calendar dates follow the calculation year');
    [later, shifted].forEach((model) => model.cases.forEach((entry) => entry.year.goals.forEach((goal) => {
      assert(['Covered', 'Partly covered', 'Not covered'].includes(goal.stateWord), 'the approved state word stays unchanged');
      assert(!/\bfrom year \d+/i.test(goal.detail), 'no zero-based year reaches the detail');
    })));
  }));

  cases.push(runCase('The future support line is generic when several goals become short together', () => {
    const model = modelFor({
      ...SAMPLE,
      spareCash: 380_000,
      leftOverEachYear: 1_000,
      retirement: { retirementAge: 62, targetIncomeToday: 1 },
      children: [0, 1, 2, 3].map((age) => ({ id: `child-${age}`, title: `Child ${age}`, age }))
    });
    const entry = byId(model, 'mortgage-all-cash');
    assert(entry.year.goals.filter((goal) => goal.firstShortYear === 15).length > 1, 'several goals become short in 2041');
    assert(entry.support.endsWith('From 2041, your goals need more than you have left over.'), 'the generic approved sentence');
  }));

  cases.push(runCase('The target sentence is only said at the relief limit, never for a goal short in a later year', () => {
    const later = modelFor(GAR_STRESS_SHAPES.find((shape) => shape.name === 'money left this year, short in a later year').payload);
    const entry = later.cases.find((candidate) => candidate.id === 'mortgage-then-college');
    // This year everything fits, with €98 over, but a later year is short.
    assertEqual(entry.headline.text, 'You have €98 a year left over', 'not "to spare": a goal is short later');
    assertEqual(
      entry.support,
      'Your goals need €14,402 a year against the €14,500 you have. From 2027, your retirement saving costs more than you have left over.',
      'and the support line is the ordinary one, not the relief-limit sentence'
    );
    const retirement = entry.year.goals[entry.year.goals.length - 1];
    assertEqual(retirement.state, 'partly', 'retirement is partly covered over the years');
    assert(retirement.firstShortYear >= 1, 'short from a later year');
    assert(!retirement.detail.includes(GAR_WORDS.atTheLimit), 'and its row does not say it is at the limit');
    assert(!/€[\d,]+ of €[\d,]+ a year/.test(retirement.detail), 'nor "€X of €X a year"');

    // At the limit, the sentence is said.
    const limit = modelFor(GAR_STRESS_SHAPES.find(
      (shape) => shape.name === 'a target out of reach at the relief limit, with the money to pay in the most'
    ).payload);
    limit.cases.forEach((candidate) => {
      assertEqual(
        candidate.support,
        'Your retirement target is not met, even at the most income tax relief allows.',
        `${candidate.id}: said at the limit`
      );
    });
    // Everywhere else it is not.
    GAR_STRESS_SHAPES.forEach((shape) => {
      const model = modelFor(shape.payload);
      model.cases.forEach((candidate) => {
        const atTheLimit = candidate.year.goals.some((goal) => goal.detail.endsWith(GAR_WORDS.atTheLimit));
        if (!atTheLimit) {
          assert(!/relief allows/.test(candidate.support), `${shape.name} ${candidate.id}: not said away from the limit`);
        }
      });
    });
  }));

  cases.push(runCase('Each child is first, second, third by position, and no payload name reaches the screen', () => {
    const payload = GAR_STRESS_SHAPES.find((shape) => shape.name === 'four children').payload;
    const model = modelFor(payload);
    const names = model.cases[0].year.goals.filter((goal) => goal.kind === 'college').map((goal) => goal.shortName);
    assertEqual(names.join(','), 'First child,Second child,Third child,Fourth child', 'ordinals by position');

    const people = ['Aoife', 'Cian', 'Saoirse', 'Oisin', 'Niamh', 'Dara'];
    GAR_STRESS_SHAPES.forEach((shape) => {
      const problems = findForbiddenText(collectGarStrings(modelFor(shape.payload)), { names: people });
      assert(problems.length === 0, `${shape.name}: ${problems.join('; ')}`);
    });
    // The pension titles are real names in the sample's payload and must not
    // appear, which is the household-name rule.
    assert(SAMPLE.pensions.some((person) => person.title === 'Niamh'), 'the sample does carry a name');
  }));

  cases.push(runCase('The yearly scale is one scale: the same euro is the same height in every case', () => {
    const model = modelFor(SAMPLE);
    assertEqual(Math.round(model.axis.yearMax), 20062, 'the axis is the largest figure over every case');
    WIDTHS.forEach((width) => {
      const layout = layoutGar(model, { width });
      const heightOfBase = model.cases.map((entry) => placeYear(layout, entry).haveBaseH);
      assert(heightOfBase.every((h) => h === heightOfBase[0]), `${width}: the have bar is one height`);
      model.cases.forEach((entry) => {
        const placed = placeYear(layout, entry);
        entry.year.goals.forEach((goal, index) => {
          assert(
            Math.abs(placed.blocks[index].height - (goal.need * layout.kYear)) < 1e-9,
            `${width} ${entry.id}: goal ${index} is on the scale`
          );
        });
        assert(
          Math.abs((placed.waterTop) - (entry.year.haveTotal * layout.kYear)) < 1e-9,
          `${width} ${entry.id}: the line is at what you have`
        );
      });
    });
  }));

  cases.push(runCase('Your money now has its own scale and is never added to the yearly picture', () => {
    const model = modelFor(SAMPLE);
    const layout = layoutGar(model, { width: 1776 });
    assert(layout.kNow !== layout.kYear, 'the two scales are different numbers');
    assertEqual(model.axis.cash, 60_000, 'the cash axis is the spare cash');
    model.cases.forEach((entry) => {
      const now = placeNow(layout, entry);
      const total = now.collegeH + now.mortgageH + now.leftH;
      assert(Math.abs(total - layout.now.plot) < 1e-6, `${entry.id}: the cash adds up to the cash, and nothing else`);
      assert(entry.now.college + entry.now.mortgage + entry.now.left === 60_000 || Math.abs(entry.now.college + entry.now.mortgage + entry.now.left - 60_000) < 1e-6,
        `${entry.id}: used and left over are the cash`);
    });
    // No figure on the page is a sum of the two pictures.
    const strings = collectGarStrings(model).join('\n');
    assert(!/€80,062|€66,000|€74,062/.test(strings), 'the cash and the yearly money are never added');
  }));

  cases.push(runCase('A goal is covered, partly or not, exactly where the line falls on it', () => {
    GAR_STRESS_SHAPES.forEach((shape) => {
      const model = modelFor(shape.payload);
      const layout = layoutGar(model, { width: 1776 });
      model.cases.forEach((entry) => {
        const placed = placeYear(layout, entry);
        entry.year.goals.forEach((goal, index) => {
          const block = placed.blocks[index];
          const drawnCovered = block.inH / layout.kYear;
          assert(
            Math.abs(drawnCovered - goal.covered) < 0.01,
            `${shape.name} ${entry.id}: goal ${index} draws ${drawnCovered} covered, the engine says ${goal.covered}`
          );
          if (goal.state === 'covered') assert(block.outH < 0.01, `${entry.id}: a covered goal has no short part`);
          if (goal.state === 'not') assert(block.inH < 0.01, `${entry.id}: an uncovered goal has no covered part`);
          // "Partly" is over the years and the picture is this year's money, so
          // a partly covered goal can show only a covered part (short later), or
          // only a short part (met later), or both.
          if (goal.state === 'partly') {
            assert(
              goal.firstShortYear !== null || goal.detail.endsWith(GAR_WORDS.atTheLimit),
              `${entry.id}: a partly covered goal says when it is short, or that it is at the limit`
            );
          }
        });
      });
    });
  }));

  cases.push(runCase('The geometry holds at every agreed width, for every case of every shape', () => {
    GAR_STRESS_SHAPES.forEach((shape) => {
      const model = modelFor(shape.payload);
      WIDTHS.forEach((width) => {
        const layout = layoutGar(model, { width });
        const problems = checkGarGeometry(layout, model);
        assert(problems.length === 0, `${shape.name} at ${width} (${layout.mode}): ${problems.join('; ')}`);
      });
    });
  }));

  cases.push(runCase('The arrangement changes at 760 and at 1740, and the pictures are two sizes', () => {
    const model = modelFor(SAMPLE);
    const mode = (width) => layoutGar(model, { width }).mode;
    assertEqual(PAIR_MIN_WIDTH, 760, 'the side-by-side width');
    assertEqual(WIDE_MIN_WIDTH, 1740, 'the wide width');
    assertEqual(mode(390), 'single', '390 is one column');
    assertEqual(mode(PAIR_MIN_WIDTH - 1), 'single', 'just under 760');
    assertEqual(mode(PAIR_MIN_WIDTH), 'pair', '760 is side by side');
    assertEqual(mode(WIDE_MIN_WIDTH - 1), 'pair', 'just under 1740');
    assertEqual(mode(WIDE_MIN_WIDTH), 'wide', '1740 is the frame');
    assertEqual(mode(1920), 'wide', '1920 is the frame');
    // Within an arrangement the pictures do not change size, so a resize there
    // never has to rebuild the screen.
    assertEqual(layoutGar(model, { width: 390 }).year.plot, layoutGar(model, { width: 1100 }).year.plot, 'one compact size');
    assert(layoutGar(model, { width: 1776 }).year.plot > layoutGar(model, { width: 1100 }).year.plot, 'the frame is larger');
  }));

  cases.push(runCase('Blending is exact at both ends and in between, and a missing mark takes its target', () => {
    const model = modelFor(SAMPLE);
    const layout = layoutGar(model, { width: 1776 });
    const from = garValues(layout, byId(model, 'cash-stays'));
    const to = garValues(layout, byId(model, 'mortgage-all-cash'));
    assertEqual(JSON.stringify(lerpGarValues(from, to, 1)), JSON.stringify(to), 'progress 1 is the target');
    assertEqual(JSON.stringify(lerpGarValues(from, to, 0)), JSON.stringify(from), 'progress 0 is the start');
    const half = lerpGarValues(from, to, 0.5);
    Object.keys(to).forEach((key) => {
      const low = Math.min(from[key], to[key]) - 1e-9;
      const high = Math.max(from[key], to[key]) + 1e-9;
      assert(half[key] >= low && half[key] <= high, `${key} is between its ends`);
    });
    const partial = lerpGarValues({}, to, 0.3);
    assertEqual(JSON.stringify(partial), JSON.stringify(to), 'with no start, every mark is already at its target');
  }));

  cases.push(runCase('The short label sits beside the short part, inside the picture, in every state', () => {
    GAR_STRESS_SHAPES.forEach((shape) => {
      const model = modelFor(shape.payload);
      [1776, 1100, 390].forEach((width) => {
        const layout = layoutGar(model, { width });
        model.cases.forEach((entry) => {
          const placed = placeYear(layout, entry);
          assert(placed.shortTop >= 0, `${shape.name} ${width} ${entry.id}: not above the picture`);
          assert(placed.shortTop + layout.year.labelH <= layout.year.box + 0.01,
            `${shape.name} ${width} ${entry.id}: not below the picture`);
          if (!layout.wide) {
            assert(placed.shortTop >= placed.bottom + 12 - 0.01, `${width} ${entry.id}: under the need column`);
            assert(placed.shortTop >= placed.waterTop + 12 - 0.01, `${width} ${entry.id}: under the line`);
          }
        });
      });
    });
  }));

  cases.push(runCase('Nothing in any case says a banned phrase, a provider, "p.a.", a bare amount or a name', () => {
    GAR_STRESS_SHAPES.forEach((shape) => {
      const strings = collectGarStrings(modelFor(shape.payload));
      assert(strings.length > 40, `${shape.name}: the scan has something to scan`);
      const problems = findForbiddenText(strings, { names: ['Aoife', 'Cian', 'Saoirse', 'Oisin', 'Niamh', 'Dara'] });
      assert(problems.length === 0, `${shape.name}: ${problems.join('; ')}`);
    });
  }));

  cases.push(runCase('The scan itself catches what it is for', () => {
    assert(findForbiddenText(['We recommend the mortgage']).length > 0, 'we recommend');
    assert(findForbiddenText(['You should clear it']).length > 0, 'you should');
    assert(findForbiddenText(['The best option']).length > 0, 'best option');
    assert(findForbiddenText(['An ideal split']).length > 0, 'ideal');
    assert(findForbiddenText(['The optimal case']).length > 0, 'optimal');
    assert(findForbiddenText(['€500 p.a.']).length > 0, 'p.a.');
    assert(findForbiddenText(['With AIB']).length > 0, 'a provider');
    assert(findForbiddenText(['€12345 a year']).length > 0, 'a bare amount');
    assert(findForbiddenText(['Niamh retires at 62'], { names: ['Niamh'] }).length > 0, 'a name');
    assert(findForbiddenText(['You have €12,345 a year to spare']).length === 0, 'a clean line passes');
  }));

  cases.push(runCase('The picture\'s accessible names say the figures once, in words', () => {
    const model = modelFor(SAMPLE);
    const labels = plotLabels(byId(model, 'mortgage-all-cash'));
    assertEqual(labels.now,
      'Your money now: you have €60,000, and €60,000 of it goes into your goals, leaving €0.', 'now');
    assertEqual(labels.year,
      'Your money each year: you have €7,245 a year and your goals need €15,981 a year. You’re short by €8,736 a year.',
      'year');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };
  if (failed > 0) {
    console.warn('[GoalsAndResourcesViewTests] Completed with failures', summary);
  } else {
    console.info('[GoalsAndResourcesViewTests] All tests passed', { total: summary.total, passed: summary.passed });
  }
  return summary;
}
