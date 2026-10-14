import { computeRentalKeepOrSellProjection } from './rental_keep_or_sell_math.js';
import { RENTAL_KEEP_OR_SELL_SAMPLE } from './tests_rental_keep_or_sell_math.js';
import {
  buildRentalCopy,
  checkRentalLayout,
  collectRentalStrings,
  findForbiddenText,
  layoutRentalChart,
  lerpValues
} from './rental_keep_or_sell_view.js';

/**
 * THE WORDS AND THE GEOMETRY, ASKED WITHOUT A BROWSER.
 *
 * The widths are the ones the module is checked at: a phone (358), a wide phone
 * or small tablet (720), a laptop just under the wide arrangement (1000), the
 * first width of the wide arrangement (1200) and the reference screen (1776).
 * 1728 is the reference frame: a 1632-wide chart with a 1252-wide plot.
 */

const WIDTHS = Object.freeze([358, 720, 1000, 1199, 1200, 1776]);

const sample = RENTAL_KEEP_OR_SELL_SAMPLE;

/** Payload shapes that put every kind of result and every kind of number through the layout. */
const SHAPES = Object.freeze({
  sample,
  leftOver: { ...sample, rentPerYear: 25_000 },
  level: { ...sample, rentPerYear: 19_200 },
  deepShortfall: { ...sample, loanRepaymentsPerYear: 28_000 },
  underwater: { ...sample, loanBalance: 400_000 },
  nothingInHand: { ...sample, loanBalance: 293_000 },
  zeroCuts: { ...sample, runningCostsPerYear: 0, sellingCosts: 0 },
  large: { ...sample, salePrice: 2_500_000, loanBalance: 1_200_000, taxOnGain: 310_000, sellingCosts: 48_000 },
  small: { ...sample, rentPerYear: 3_600, loanRepaymentsPerYear: 1_200, runningCostsPerYear: 400, taxOnRentalProfitPerYear: 0 }
});

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

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message || 'Values differ'}: expected ${e}, got ${a}`);
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
    console.info(`[RentalKeepOrSellViewTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[RentalKeepOrSellViewTests] FAIL: ${name}\n    ${error.message}`);
    return { name, pass: false, error: error.message };
  }
}

const project = (payload) => computeRentalKeepOrSellProjection(payload);

export function runRentalKeepOrSellViewTests() {
  const cases = [];

  cases.push(runCase('The heading is the question, in "you", word for word', () => {
    const copy = buildRentalCopy(project(sample), 'keep');
    assertEqual(
      copy.heading,
      'What does this property give you each year if you keep it, and what would you have in hand if you sold it?',
      'heading'
    );
  }));

  cases.push(runCase('Keep and Sell on the sample: the buttons, the sentence and the five lines', () => {
    const projection = project(sample);
    const keep = buildRentalCopy(projection, 'keep');
    const sell = buildRentalCopy(projection, 'sell');

    assertDeepEqual(
      keep.buttons.map((button) => [button.id, button.title, button.answerLine]),
      [['keep', 'Keep', '−€1,200 a year'], ['sell', 'Sell', '€113,000 in hand']],
      'both answers are on both sets of buttons'
    );
    assertDeepEqual(sell.buttons, keep.buttons, 'the buttons do not depend on the selected case');

    assertEqual(
      keep.headline,
      'The rent does not cover the loan repayments, running costs and tax: €1,200 short each year.',
      'Keep sentence'
    );
    assertEqual(
      sell.headline,
      'Selling costs, the loan and tax come off the price: €113,000 is what you would have in hand.',
      'Sell sentence'
    );
    assertDeepEqual(
      keep.lines.map((line) => [line.name, line.value, line.word]),
      [
        ['Rent', '€18,000', ''],
        ['Loan repayments', '−€13,000', ''],
        ['Running costs', '−€2,500', ''],
        ['Tax on the rental profit', '−€3,700', ''],
        ['Net each year', '−€1,200', 'a year, short']
      ],
      'Keep lines'
    );
    assertDeepEqual(
      sell.lines.map((line) => [line.name, line.value, line.word]),
      [
        ['Sale price', '€320,000', ''],
        ['Selling costs', '−€6,000', ''],
        ['Loan repaid', '−€180,000', ''],
        ['Tax on the gain', '−€21,000', ''],
        ['In hand', '€113,000', 'in hand']
      ],
      'Sell lines'
    );
    assertEqual(
      keep.footnote,
      'Education only. Figures are as stated for this property; tax is not calculated here. This shows what is, and what each case would change.',
      'footnote'
    );
    assertEqual(keep.zeroLabel, '0', 'the zero label');
  }));

  cases.push(runCase('The other results: left over, level, nothing in hand, short', () => {
    const left = buildRentalCopy(project(SHAPES.leftOver), 'keep');
    assertEqual(
      left.headline,
      'The rent covers the loan repayments, running costs and tax, with €5,800 left over each year.',
      'left over'
    );
    assertEqual(left.lines[4].value, '€5,800', 'left over value');
    assertEqual(left.lines[4].word, 'a year, left over', 'left over word');
    assertEqual(left.buttons[0].answerLine, '€5,800 a year', 'left over button');

    const level = buildRentalCopy(project(SHAPES.level), 'keep');
    assertEqual(level.headline, 'The rent exactly covers the loan repayments, running costs and tax.', 'level');
    assertEqual(level.lines[4].value, '€0', 'level value');
    assertEqual(level.lines[4].word, 'a year, nothing left over', 'level word');

    const nothing = buildRentalCopy(project(SHAPES.nothingInHand), 'sell');
    assertEqual(
      nothing.headline,
      'Selling costs, the loan and tax take the whole price: nothing would be in hand.',
      'nothing in hand'
    );
    assertEqual(nothing.lines[4].word, 'in hand', 'nothing in hand word');

    const short = buildRentalCopy(project(SHAPES.underwater), 'sell');
    assertEqual(
      short.headline,
      'Selling costs, the loan and tax come to more than the price: €107,000 short.',
      'sale that does not clear the loan'
    );
    assertEqual(short.lines[4].value, '−€107,000', 'short value');
    assertEqual(short.lines[4].word, 'short', 'short word');
    assertEqual(short.buttons[1].answerLine, '−€107,000 short', 'short button');
  }));

  cases.push(runCase('A cut of nothing reads €0 and keeps its line', () => {
    const copy = buildRentalCopy(project(SHAPES.zeroCuts), 'keep');
    assertEqual(copy.lines.length, 5, 'five lines');
    assertEqual(copy.lines[2].value, '€0', 'the empty cut');
  }));

  cases.push(runCase('No string on screen holds a banned phrase, "we", "us", "our", a provider or a bare amount', () => {
    Object.entries(SHAPES).forEach(([label, payload]) => {
      const projection = project(payload);
      ['keep', 'sell'].forEach((id) => {
        const problems = findForbiddenText(collectRentalStrings(projection, id));
        assert(problems.length === 0, `${label}/${id}: ${problems.join('; ')}`);
      });
    });
    const dirty = findForbiddenText([
      'We recommend this', 'You should sell', 'The best option', 'p.a.', 'what we have', 'ask us', 'our house',
      'Bank of Ireland', '€12000 a year', '-€1,200'
    ]);
    assertEqual(dirty.length >= 10, true, `the scan catches what it is meant to (${dirty.length})`);
  }));

  cases.push(runCase('The reference frame: Sell puts zero at 8% and the headline at 78% of a 1252-wide plot', () => {
    const projection = project(sample);
    const layout = layoutRentalChart(projection, { width: 1728 });
    assertEqual(layout.narrow, false, 'wide');
    assertEqual(layout.chartWidth, 1632, 'chart width');
    assertEqual(layout.plot.left, 380, 'plot starts after the names');
    assertEqual(layout.plot.width, 1252, 'plot width');

    const sell = layout.values.sell;
    assertWithin(sell[0], 380 + (0.08 * 1252), 0.01, 'zero at 8%');
    assertWithin(sell[1], 380 + (0.78 * 1252), 0.01, 'headline at 78%');
    // The start bar runs from zero to the headline.
    assertWithin(sell[2], sell[0], 0.01, 'start bar begins at zero');
    assertWithin(sell[2] + sell[3], sell[1], 0.01, 'start bar ends at the headline');
  }));

  cases.push(runCase('The reference frame: Keep gives the shortfall room, zero at 12.4%, headline still at 78%', () => {
    const layout = layoutRentalChart(project(sample), { width: 1728 });
    const keep = layout.values.keep;
    assertWithin((keep[0] - 380) / 1252, 0.12375, 0.0001, 'zero at 12.375%');
    assertWithin((keep[1] - 380) / 1252, 0.78, 0.0001, 'headline at 78%');
    // The result bar runs from -1,200 up to zero, and its label sits right of zero.
    const resultLeft = keep[2 + (4 * 3)];
    const resultWidth = keep[3 + (4 * 3)];
    assertWithin(resultLeft + resultWidth, keep[0], 0.01, 'the shortfall ends at zero');
    assert(resultLeft < keep[0], 'the shortfall runs left of zero');
    assertWithin(keep[4 + (4 * 3)], keep[0] + 16, 0.01, 'its label is 16px right of zero');
  }));

  cases.push(runCase('Each cut meets the one before it, in both cases', () => {
    const layout = layoutRentalChart(project(sample), { width: 1728 });
    ['keep', 'sell'].forEach((id) => {
      const values = layout.values[id];
      const left = (index) => values[2 + (index * 3)];
      const right = (index) => values[2 + (index * 3)] + values[3 + (index * 3)];
      assertWithin(right(1), right(0), 0.01, `${id}: first cut hangs from the headline`);
      assertWithin(right(2), left(1), 0.01, `${id}: second cut hangs from the first`);
      assertWithin(right(3), left(2), 0.01, `${id}: third cut hangs from the second`);
    });
  }));

  cases.push(runCase('A −€10,000 net on €18,000 of rent keeps every bar inside the plot', () => {
    // Rent 18,000 less loan repayments of 21,800, 2,500 and 3,700.
    const deeper = project({ ...sample, loanRepaymentsPerYear: 21_800 });
    assertEqual(deeper.debug.cases[0].result, -10_000, 'minus ten thousand');
    WIDTHS.forEach((width) => {
      const layout = layoutRentalChart(deeper, { width });
      const problems = checkRentalLayout(deeper, layout);
      assert(problems.length === 0, `${width}: ${problems.join('; ')}`);
      const values = layout.values.keep;
      for (let row = 0; row < 5; row += 1) {
        const left = values[2 + (row * 3)];
        assert(left >= layout.plot.left - 0.5, `${width}: row ${row} starts inside the plot (${left})`);
      }
    });
  }));

  cases.push(runCase('Every shape at every width: nothing leaves the chart and no label sits on a bar', () => {
    Object.entries(SHAPES).forEach(([label, payload]) => {
      const projection = project(payload);
      WIDTHS.forEach((width) => {
        const layout = layoutRentalChart(projection, { width });
        const problems = checkRentalLayout(projection, layout);
        assert(problems.length === 0, `${label} at ${width}: ${problems.join('; ')}`);
        projection.debug.cases.forEach((entry) => {
          assertEqual(layout.values[entry.id].length, 2 + (5 * 3), `${label}/${entry.id}: value count`);
        });
      });
    });
  }));

  cases.push(runCase('The arrangement: wide from 1200, names above the bars under it, chart capped at 720', () => {
    const projection = project(sample);
    const wide = layoutRentalChart(projection, { width: 1200 });
    assertEqual(wide.narrow, false, '1200 is wide');
    assertEqual(wide.rows[2].name.width, 372, 'names in a column');
    assertDeepEqual(wide.rows.map((row) => row.connector !== null), [false, true, true, true, false], 'connectors on the three cuts');

    const narrow = layoutRentalChart(projection, { width: 1199 });
    assertEqual(narrow.narrow, true, '1199 is narrow');
    assertEqual(narrow.chartWidth, 720, 'capped at 720');
    assertEqual(narrow.rows[2].name.top, narrow.rows[2].top, 'the name sits at the top of its row');
    assert(narrow.rows[2].barTop > narrow.rows[2].name.top, 'and the bar below it');
    assertDeepEqual(narrow.rows.map((row) => row.connector), [null, null, null, null, null], 'no connectors');

    const phone = layoutRentalChart(projection, { width: 390 });
    assertEqual(phone.chartWidth, 358, 'a 390 phone gives a 358 chart');
    assertEqual(phone.rows[1].top, 84, 'row pitch 84 on a phone');
    assertEqual(layoutRentalChart(projection, { width: 1728 }).rows[1].top, 92, 'row pitch 92 on a wide screen');
  }));

  cases.push(runCase('Interpolation is exact at both ends, and the case is not mutated', () => {
    const layout = layoutRentalChart(project(sample), { width: 1776 });
    const from = layout.values.keep.slice();
    const to = layout.values.sell.slice();
    assertDeepEqual(lerpValues(from, to, 1), to, 'progress 1 is the target');
    assertDeepEqual(lerpValues(from, to, 0), from, 'progress 0 is where it started');
    const middle = lerpValues(from, to, 0.5);
    assertWithin(middle[0], (from[0] + to[0]) / 2, 1e-9, 'halfway');
    assertDeepEqual(layout.values.keep, from, 'the source is untouched');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };

  if (failed > 0) {
    console.warn('[RentalKeepOrSellViewTests] Completed with failures', summary);
  } else {
    console.info('[RentalKeepOrSellViewTests] All tests passed', { total: summary.total, passed: summary.passed });
  }

  return summary;
}
