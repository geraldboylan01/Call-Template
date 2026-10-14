import { computeProtectionGapProjection } from './protection_gap_math.js';
import { PROTECTION_GAP_SAMPLE } from './tests_protection_gap_math.js';
import {
  HYSTERESIS_PX,
  RAIL_MIN_WIDTH,
  ROW_MIN_WIDTH,
  buildProtectionGapCopy,
  checkLabelPlacement,
  chooseButtonLayout,
  collectProtectionGapStrings,
  deriveBarGeometry,
  findForbiddenText,
  layoutProtectionGap,
  lerpValues,
  placeBarLabels,
  placeStripWords,
  stripAxis,
  valuesForCase
} from './protection_gap_view.js';

/**
 * THE SCREEN'S WORDS AND GEOMETRY, ASKED WITHOUT A BROWSER.
 *
 * The view is pure, so everything here is a plain question and a plain answer:
 * what is said, where each mark and label sits at any width, and that nothing
 * touches. The widths are the ones the wiring list names (358, 720, 1000 and
 * 1776) plus the lines between arrangements.
 */

const WIDTHS = Object.freeze([358, 720, 1000, 1776]);
const MORE_WIDTHS = Object.freeze([320, 390, 759, 760, 1099, 1100, 1280]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Values differ'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertWithin(actual, expected, tolerance, message) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message || 'Values differ'}: expected ${expected} ± ${tolerance}, got ${actual}`);
  }
}

function runCase(name, fn) {
  try {
    fn();
    console.info(`[ProtectionGapViewTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[ProtectionGapViewTests] FAIL: ${name}\n    ${error.message}`);
    return { name, pass: false, error: error.message };
  }
}

/** Household shapes the layout must hold for, besides the sample. */
const SHAPES = Object.freeze({
  sample: PROTECTION_GAP_SAMPLE,
  onePerson: {
    people: [{ id: 'ann', label: 'Ann', takeHome: 50_000 }],
    needed: 62_000,
    savings: 35_500,
    scenarios: [
      { id: 'base' },
      { id: 'stops', event: { type: 'cannotWork', personId: 'ann', statePayment: 13_000 } }
    ]
  },
  noSavings: {
    people: [{ id: 'a', label: 'Ann', takeHome: 40_000 }, { id: 'b', label: 'Bo', takeHome: 30_000 }],
    needed: 80_000,
    savings: 0,
    scenarios: [{ id: 'base' }, { id: 'a-stops', event: { type: 'cannotWork', personId: 'a', statePayment: 9_000 } }]
  },
  tight: {
    people: [{ id: 'a', label: 'Ann', takeHome: 30_000 }, { id: 'b', label: 'Bo', takeHome: 20_000 }],
    needed: 50_000,
    savings: 20_000,
    scenarios: [{ id: 'base' }, { id: 'b-stops', event: { type: 'cannotWork', personId: 'b', statePayment: 5_000 } }]
  },
  longNames: {
    people: [
      { id: 'a', label: 'Bartholomew-Alexander', takeHome: 61_000 },
      { id: 'b', label: 'Guinevere-Marguerite', takeHome: 52_000 }
    ],
    needed: 120_000,
    savings: 85_000,
    scenarios: [
      { id: 'base' },
      { id: 'a-stops', event: { type: 'cannotWork', personId: 'a', statePayment: 14_000 } },
      { id: 'a-died', event: { type: 'dies', personId: 'a', survivorsPension: 14_500, neededAfter: 70_000, neededBecause: ['mortgageCleared'] } }
    ]
  },
  large: {
    people: [{ id: 'a', label: 'Ann', takeHome: 1_250_000 }, { id: 'b', label: 'Bo', takeHome: 900_000 }],
    needed: 2_400_000,
    savings: 3_000_000,
    scenarios: [{ id: 'base' }, { id: 'a-stops', event: { type: 'cannotWork', personId: 'a', statePayment: 15_000 } }]
  }
});

const project = (shape) => computeProtectionGapProjection(SHAPES[shape]);

export function runProtectionGapViewTests() {
  const cases = [];

  cases.push(runCase('The arrangement: rail from 1100, a row from 760, a grid below', () => {
    assertEqual(RAIL_MIN_WIDTH, 1100, 'rail line');
    assertEqual(ROW_MIN_WIDTH, 760, 'row line');
    assertEqual(chooseButtonLayout(1100), 'rail', 'rail at 1100');
    assertEqual(chooseButtonLayout(1099), 'row', 'row at 1099');
    assertEqual(chooseButtonLayout(760), 'row', 'row at 760');
    assertEqual(chooseButtonLayout(759), 'grid', 'grid at 759');
    assertEqual(chooseButtonLayout(390), 'grid', 'grid on a phone');
  }));

  cases.push(runCase('Hysteresis: a jitter of 15px around a line does not flip it, 16px does', () => {
    assertEqual(HYSTERESIS_PX, 16, 'the hysteresis');
    assertEqual(chooseButtonLayout(1090, 'rail'), 'rail', 'rail holds 10px under the line');
    assertEqual(chooseButtonLayout(1085, 'rail'), 'rail', 'rail holds 15px under the line');
    assertEqual(chooseButtonLayout(1084, 'rail'), 'row', 'rail gives way 16px under it');
    assertEqual(chooseButtonLayout(1105, 'row'), 'row', 'row holds 5px over the line');
    assertEqual(chooseButtonLayout(1115, 'row'), 'row', 'row holds 15px over the line');
    assertEqual(chooseButtonLayout(1116, 'row'), 'rail', 'row gives way 16px over it');
    assertEqual(chooseButtonLayout(770, 'grid'), 'grid', 'grid holds 10px over the line');
    assertEqual(chooseButtonLayout(776, 'grid'), 'row', 'grid gives way 16px over it');
    assertEqual(chooseButtonLayout(500, 'rail'), 'grid', 'two steps is not a jitter');
    assertEqual(chooseButtonLayout(1200, null), 'rail', 'no previous: the sharp line');
  }));

  cases.push(runCase('Words: the captions, the labels and the strip, for each of the four cases', () => {
    const projection = project('sample');
    const base = buildProtectionGapCopy(projection, 'today');
    assertEqual(base.module, 'Protection gap', 'module name');
    assertEqual(base.household, 'Niamh and Dara, both 45', 'household line');
    assertEqual(base.savingsLine, 'Your savings €60,000', 'savings line');
    assertEqual(base.captions.bar, 'How big is the hole, in € a year', 'bar caption');
    assertEqual(base.captions.strip, 'How long your savings fill it', 'strip caption');
    assertEqual(base.bar.moneyIn.title, 'What comes in', 'what comes in');
    assertEqual(base.bar.need.title, 'What you need', 'what you need');
    assertEqual(base.bar.scaleStart, '0', 'scale start');
    assertEqual(base.bar.scaleEnd, '110,000', 'scale end is the module scale');
    assertEqual(base.bar.gap.title, 'Left over', 'left over title');
    assertEqual(base.bar.gap.amountText, '€6,000 a year', 'left over amount');
    assertEqual(base.strip.nothing, 'Nothing to fill', 'nothing to fill');
    assertEqual(base.strip.startText, 'Today', 'axis start in the base case');
    assertEqual(base.strip.end, null, 'no end mark when nothing is short');
    assertEqual(base.isTight, false, 'not tight');

    const second = buildProtectionGapCopy(projection, 'niamh-cannot-work');
    assertEqual(second.bar.gap.title, 'Gap', 'gap title');
    assertEqual(second.bar.gap.amountText, '€38,000 a year', 'gap amount');
    assertEqual(second.strip.startText, 'Income stops', 'axis start after an event');
    assertEqual(second.strip.end.lead, 'Your savings of €60,000 would last', 'wide lead');
    assertEqual(second.strip.end.text, '19 months', 'end text');
    assertEqual(
      buildProtectionGapCopy(projection, 'niamh-cannot-work', { narrow: true }).strip.end.lead,
      'Your savings last',
      'narrow lead'
    );
    assertEqual(buildProtectionGapCopy(projection, 'niamh-died').strip.end.text, 'Beyond three years', 'beyond');
    assertEqual(
      JSON.stringify(second.segments.map((segment) => segment.lines)),
      JSON.stringify([['State', 'payment'], ['Niamh’s take-home'], ['Dara’s take-home']]),
      'segment names'
    );
    assertEqual(
      JSON.stringify(buildProtectionGapCopy(projection, 'niamh-died').segments[0].lines),
      JSON.stringify(['Survivor’s', 'pension']),
      'survivor’s pension lines'
    );
    assertEqual(
      JSON.stringify(second.buttons.map((button) => button.title)),
      JSON.stringify(['Today', 'Niamh cannot work', 'Dara cannot work', 'If Niamh died']),
      'button titles'
    );
  }));

  cases.push(runCase('Words: end text for under a month, no savings and the tight state', () => {
    const noSavings = buildProtectionGapCopy(project('noSavings'), 'a-stops');
    assertEqual(noSavings.strip.end.text, '0 months', 'no savings is 0 months');
    const under = computeProtectionGapProjection({
      people: [{ id: 'a', label: 'Ann', takeHome: 50_000 }],
      needed: 62_000,
      savings: 100,
      scenarios: [{ id: 'base' }]
    });
    assertEqual(buildProtectionGapCopy(under, 'base').strip.end.text, 'Less than a month', 'under a month');
    const tight = buildProtectionGapCopy(project('tight'), 'base');
    assertEqual(tight.isTight, true, 'tight');
    assertEqual(tight.statusWord, 'Tight', 'status word');
    assertEqual(tight.bar.gap, null, 'no gap label when money in equals what you need');
    assertEqual(tight.strip.end, null, 'no end mark');
  }));

  cases.push(runCase('Words scan: nothing banned, no provider, no bare amount, wide or narrow, in any shape', () => {
    Object.keys(SHAPES).forEach((shape) => {
      const projection = project(shape);
      projection.debug.cases.forEach((entry) => {
        const strings = collectProtectionGapStrings(projection, entry.id);
        const problems = findForbiddenText(strings);
        assert(problems.length === 0, `${shape}/${entry.id}: ${problems.join('; ')}`);
        assert(strings.some((text) => /\byou(r)?\b/i.test(text)), `${shape}/${entry.id}: speaks to you`);
      });
    });
    const problems = findForbiddenText([
      'We recommend this', 'You should save', 'A cover amount', 'Your premium', 'p.a.', '€12000 a year',
      'Bank of Ireland', 'the household needs'
    ]);
    assert(problems.length >= 8, `the scan catches what it should (${problems.length} found)`);
  }));

  cases.push(runCase('Geometry: one scale, everything inside the chart, the bar and the strip share an edge', () => {
    ['sample', 'onePerson', 'noSavings', 'tight', 'longNames', 'large'].forEach((shape) => {
      const projection = project(shape);
      [...WIDTHS, ...MORE_WIDTHS].forEach((width) => {
        const layout = layoutProtectionGap(projection, { width });
        const label = `${shape} at ${width}`;
        assertWithin(layout.pxPerEuro, layout.chartWidth / projection.debug.scaleMax, 1e-12, `${label}: scale`);
        assertWithin(layout.cell, layout.chartWidth / 36, 1e-12, `${label}: one cell a month`);
        projection.debug.cases.forEach((entry) => {
          const values = valuesForCase(layout, entry.id);
          const geometry = deriveBarGeometry(layout, values);
          entry.segments.forEach((segment, index) => {
            assertWithin(geometry.segments[index].width, segment.amount * layout.pxPerEuro, 1e-9, `${label}/${entry.id}: segment ${index} on the one scale`);
          });
          assertWithin(geometry.inX, entry.moneyIn * layout.pxPerEuro, 1e-6, `${label}/${entry.id}: bar ends at money in`);
          assertWithin(geometry.needX, entry.needed * layout.pxPerEuro, 1e-6, `${label}/${entry.id}: tick at what you need`);
          assert(geometry.inX <= layout.chartWidth + 1e-6, `${label}/${entry.id}: the bar is inside the chart`);
          assert(geometry.needX <= layout.chartWidth + 1e-6, `${label}/${entry.id}: the tick is inside the chart`);
          const words = placeStripWords(layout, values, buildProtectionGapCopy(projection, entry.id, { narrow: layout.narrow }));
          assert(words.fillWidth >= 0 && words.fillWidth <= layout.chartWidth + 1e-6, `${label}/${entry.id}: green inside the strip`);
          assertWithin(words.fillWidth + words.shortWidth, layout.chartWidth, 1e-6, `${label}/${entry.id}: green and red make the strip`);
        });
      });
    });
  }));

  cases.push(runCase('The months strip: green runs for the months, beyond fills it, nothing short has no green', () => {
    const projection = project('sample');
    const layout = layoutProtectionGap(projection, { width: 1776 });
    const copyFor = (id) => buildProtectionGapCopy(projection, id, { narrow: layout.narrow });
    const wordsFor = (id) => placeStripWords(layout, valuesForCase(layout, id), copyFor(id));

    assertWithin(wordsFor('niamh-cannot-work').fillWidth, 19 * layout.cell, 1e-9, '19 months of green');
    assertWithin(wordsFor('dara-cannot-work').fillWidth, 28 * layout.cell, 1e-9, '28 months of green');
    assertWithin(wordsFor('niamh-died').fillWidth, layout.chartWidth, 1e-9, 'beyond fills the strip');
    assertEqual(wordsFor('niamh-died').shortWidth, 0, 'no red when beyond');
    assertEqual(wordsFor('today').fillWidth, 0, 'no green when nothing is short');
    assertEqual(wordsFor('today').end, null, 'no end mark');
    assertEqual(wordsFor('today').nothing.text, 'Nothing to fill', 'words when nothing is short');

    const second = wordsFor('niamh-cannot-work');
    assertEqual(second.filled.text, 'Filled by your savings', 'the green is named');
    assertEqual(second.short.text, 'Short', 'the red is named');
    assertEqual(second.end.text, '19 months', 'the end mark');
    assertWithin(second.end.tickLeft, 19 * layout.cell - 1, 1e-9, 'the tick is where the green ends');
    assert(second.end.left + second.end.width <= 19 * layout.cell + 1e-6, 'the label ends at the tick');
    assert(second.end.left >= 0, 'the label is on the chart');

    const phone = layoutProtectionGap(projection, { width: 358 });
    const narrowCopy = buildProtectionGapCopy(projection, 'dara-cannot-work', { narrow: true });
    const narrowWords = placeStripWords(phone, valuesForCase(phone, 'dara-cannot-work'), narrowCopy);
    assertEqual(narrowWords.short.text, 'Short', 'the red is named on a phone');
    assert(narrowWords.end.left >= 0 && narrowWords.end.left + narrowWords.end.width <= phone.chartWidth + 1e-6, 'the label is on a phone');
  }));

  cases.push(runCase('The strip names its red and green only where the words fit', () => {
    const tiny = computeProtectionGapProjection({
      people: [{ id: 'a', label: 'Ann', takeHome: 50_000 }],
      needed: 62_000,
      savings: 3_000,
      scenarios: [{ id: 'base' }]
    });
    const layout = layoutProtectionGap(tiny, { width: 358 });
    const copy = buildProtectionGapCopy(tiny, 'base', { narrow: true });
    const words = placeStripWords(layout, valuesForCase(layout, 'base'), copy);
    assertEqual(copy.strip.end.text, '3 months', 'three months');
    assertEqual(words.filled, null, 'a three-month green cannot hold its name, and the end mark carries the months');
    assertEqual(words.short.text, 'Short', 'the red is long enough');
  }));

  cases.push(runCase('The axis: a name at 0, 12, 24 and 36 months, on the cells', () => {
    const projection = project('sample');
    const layout = layoutProtectionGap(projection, { width: 1776 });
    const axis = stripAxis(layout, buildProtectionGapCopy(projection, 'niamh-cannot-work'));
    assertEqual(JSON.stringify(axis.map((entry) => entry.text)), JSON.stringify(['Income stops', '1 year', '2 years', '3 years']), 'names');
    assertWithin(axis[1].x, 12 * layout.cell, 1e-9, '1 year');
    assertWithin(axis[2].x, 24 * layout.cell, 1e-9, '2 years');
    assertEqual(axis[3].x, layout.chartWidth, '3 years is the end');
    assertEqual(layout.dividers.length, 35, 'a divider between every month');
    assertEqual(layout.dividers.filter((divider) => divider.year).length, 2, 'two year dividers');
  }));

  cases.push(runCase('Labels: nothing overlaps, nothing is off the chart, the need label stays over its tick', () => {
    Object.keys(SHAPES).forEach((shape) => {
      const projection = project(shape);
      [...WIDTHS, ...MORE_WIDTHS].forEach((width) => {
        const layout = layoutProtectionGap(projection, { width });
        projection.debug.cases.forEach((entry) => {
          const copy = buildProtectionGapCopy(projection, entry.id, { narrow: layout.narrow });
          const plan = placeBarLabels(layout, entry.id, valuesForCase(layout, entry.id), copy);
          const problems = checkLabelPlacement(layout, plan);
          assert(problems.length === 0, `${shape} at ${width}/${entry.id}: ${problems.join('; ')}`);
          plan.above.concat(plan.below).forEach((item) => {
            assert(item.row < 8, `${shape} at ${width}/${entry.id}: ${item.key} found a row`);
          });
        });
      });
    });
  }));

  cases.push(runCase('The State payment is named inside its segment when it fits and below the bar when it does not', () => {
    const projection = project('sample');
    const planFor = (width, id) => {
      const layout = layoutProtectionGap(projection, { width });
      const copy = buildProtectionGapCopy(projection, id, { narrow: layout.narrow });
      return placeBarLabels(layout, id, valuesForCase(layout, id), copy);
    };
    assertEqual(planFor(1776, 'niamh-cannot-work').inside.floor, 'in', 'inside on a wide screen');
    assertEqual(planFor(358, 'niamh-cannot-work').inside.floor, 'out', 'below on a phone');
    assertEqual(planFor(1776, 'today').inside.floor, 'none', 'no segment, no label, in the base case');
    assertEqual(planFor(358, 'niamh-cannot-work').inside.niamh, 'none', 'the person whose pay stopped has no segment');
    const phone = planFor(358, 'niamh-cannot-work');
    const stateLabel = phone.below.find((item) => item.key === 'seg:floor');
    assert(stateLabel, 'the State label is below the bar on a phone');
    assertEqual(stateLabel.title, 'State payment', 'named in full');
    assertEqual(stateLabel.left, 0, 'at the start of its segment');
    assert(phone.below.find((item) => item.key === 'need'), 'and the need label is there too');
  }));

  cases.push(runCase('The same height in every case, and a row reserved when labels would collide', () => {
    const projection = project('sample');
    [358, 1776].forEach((width) => {
      const layout = layoutProtectionGap(projection, { width });
      assert(layout.bar.height > 0 && layout.strip.height > 0, 'heights exist');
      assertEqual(layout.bar.rowsAbove >= 1 && layout.bar.rowsBelow >= 1, true, 'at least one row each side');
    });
    // Two outside labels that start close together must not share a row.
    const crowded = computeProtectionGapProjection({
      people: [{ id: 'a', label: 'Bartholomew-Alexander', takeHome: 3_000 }, { id: 'b', label: 'Guinevere-Marguerite', takeHome: 2_000 }],
      needed: 90_000,
      savings: 20_000,
      scenarios: [{ id: 'base' }]
    });
    const layout = layoutProtectionGap(crowded, { width: 358 });
    const plan = placeBarLabels(layout, 'base', valuesForCase(layout, 'base'), buildProtectionGapCopy(crowded, 'base', { narrow: true }));
    assert(layout.bar.rowsBelow >= 2, `crowded labels take a second row (${layout.bar.rowsBelow})`);
    assertEqual(checkLabelPlacement(layout, plan).length, 0, 'and still do not touch');
  }));

  cases.push(runCase('lerpValues is exact at both ends and in between at the middle', () => {
    const from = [0, 100, 40, 3];
    const to = [10, 0, 40, 9];
    assertEqual(JSON.stringify(lerpValues(from, to, 0)), JSON.stringify(from), 'start');
    assertEqual(JSON.stringify(lerpValues(from, to, 1)), JSON.stringify(to), 'end');
    assertEqual(JSON.stringify(lerpValues(from, to, 0.5)), JSON.stringify([5, 50, 40, 6]), 'middle');
    assert(lerpValues(from, to, 1) !== to, 'a copy, not the same list');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };

  if (failed > 0) {
    console.warn('[ProtectionGapViewTests] Completed with failures', summary);
  } else {
    console.info('[ProtectionGapViewTests] All tests passed', { total: summary.total, passed: summary.passed });
  }

  return summary;
}
