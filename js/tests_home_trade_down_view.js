import { computeHomeTradeDownProjection } from './home_trade_down_math.js';
import { HOME_TRADE_DOWN_SAMPLE } from './tests_home_trade_down_math.js';
import {
  buildTradeDownCopy,
  checkTradeDownLayout,
  collectTradeDownStrings,
  findForbiddenText,
  layoutTradeDownChart,
  lerpValues
} from './home_trade_down_view.js';

/**
 * THE WORDS AND THE GEOMETRY, ASKED WITHOUT A BROWSER.
 *
 * The widths are the ones the module is checked at. 252 is what the app's mobile
 * shell leaves for the module on a 320px phone, and 280 and 320 are what it
 * leaves on slightly wider ones. Then a phone (358, 390), the last compact width
 * (431) and the first that is not (432), a wide phone or small tablet (720), a
 * laptop (1000), a wide laptop that still stacks the year under the home (1631),
 * the first width that puts them side by side (1632) and the reference screen
 * (1776). 1728 is the reference frame: a 1632-wide chart with a 940-wide bar.
 */

const WIDTHS = Object.freeze([252, 280, 320, 358, 390, 431, 432, 720, 1000, 1631, 1632, 1776]);

const sample = HOME_TRADE_DOWN_SAMPLE;

const shape = (patch) => ({ ...sample, baseScenarioId: undefined, ...patch });

/** Payload shapes that put every kind of case and every kind of number through the layout. */
const SHAPES = Object.freeze({
  sample,
  noLoanOnly: shape({ scenarios: [{ id: 'stay', kind: 'stay' }, { id: 'none', kind: 'move', annualRepayment: 0 }] }),
  oneCase: shape({ scenarios: [{ id: 'stay', kind: 'stay' }] }),
  nothingFreed: shape({
    newLoanTermYears: 5,
    scenarios: [{ id: 'stay', kind: 'stay' }, { id: 'same', kind: 'move', annualRepayment: 30_000 }]
  }),
  tinyFirstBlock: shape({
    buyingCosts: 354_000,
    scenarios: [{ id: 'stay', kind: 'stay' }, { id: 'a', kind: 'move', annualRepayment: 18_000 }, { id: 'b', kind: 'move', annualRepayment: 0 }]
  }),
  longTerm: shape({
    newLoanTermYears: 35,
    newLoanAnnualRate: 0.0475,
    scenarios: [{ id: 'stay', kind: 'stay' }, { id: 'a', kind: 'move', annualRepayment: 9_000 }, { id: 'b', kind: 'move', annualRepayment: 15_000 }]
  }),
  large: shape({
    homeValue: 4_850_000,
    mortgageBalance: 1_900_000,
    currentAnnualRepayments: 142_000,
    sellingCosts: 97_000,
    buyingCosts: 61_000,
    scenarios: [{ id: 'stay', kind: 'stay' }, { id: 'a', kind: 'move', annualRepayment: 60_000 }, { id: 'b', kind: 'move', annualRepayment: 0 }]
  }),
  longTitles: shape({
    scenarios: [
      { id: 'stay', kind: 'stay', title: 'Stay where you are and keep the same mortgage' },
      { id: 'a', kind: 'move', annualRepayment: 18_000, title: 'Move to a smaller home and repay a lower amount each year' }
    ]
  })
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
    console.info(`[HomeTradeDownViewTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[HomeTradeDownViewTests] FAIL: ${name}\n    ${error.message}`);
    return { name, pass: false, error: error.message };
  }
}

const project = (payload) => computeHomeTradeDownProjection(payload);

export function runHomeTradeDownViewTests() {
  const cases = [];

  cases.push(runCase('The heading is the question, in "you", word for word', () => {
    const copy = buildTradeDownCopy(project(sample), 'stay');
    assertEqual(
      copy.heading,
      'If you set a yearly repayment you are comfortable with, what home does that buy?',
      'heading'
    );
  }));

  cases.push(runCase('The sample: the buttons, and the sentence for each of the four cases', () => {
    const projection = project(sample);
    const copy = buildTradeDownCopy(projection, 'stay');
    assertDeepEqual(
      copy.buttons.map((button) => [button.id, button.title, button.subLine]),
      [
        ['stay', 'Stay', 'Home €650,000'],
        ['repay-18000', 'Repay €18,000 a year', 'Home budget €546,000'],
        ['repay-12000', 'Repay €12,000 a year', 'Home budget €478,000'],
        ['no-mortgage', 'No mortgage', 'Home budget €343,000']
      ],
      'buttons'
    );

    const sentences = ['stay', 'repay-18000', 'repay-12000', 'no-mortgage']
      .map((id) => buildTradeDownCopy(projection, id).headline);
    assertDeepEqual(sentences, [
      'Staying keeps the home at €650,000, with €30,000 a year going on the mortgage.',
      'Repaying €18,000 a year supports a loan of €203,000: a home budget of €546,000, with €12,000 a year freed.',
      'Repaying €12,000 a year supports a loan of €135,000: a home budget of €478,000, with €18,000 a year freed.',
      'With no mortgage the home budget is €343,000, and all €30,000 a year is freed.'
    ], 'sentences');
  }));

  cases.push(runCase('The sample: the figure, the two blocks and the year, case by case', () => {
    const projection = project(sample);
    const stay = buildTradeDownCopy(projection, 'stay');
    assertDeepEqual(stay.figure, { value: '€650,000', word: 'home worth' }, 'stay figure');
    assertDeepEqual(
      stay.block1,
      { amount: '€370,000', name: 'Your share of the home', note: '€650,000 less the €280,000 mortgage' },
      'stay block 1'
    );
    assertDeepEqual(stay.block2, { amount: '€280,000', name: 'Mortgage' }, 'stay block 2');
    assertDeepEqual(stay.freed, { value: '€0', word: 'freed each year' }, 'stay freed');
    assertDeepEqual(stay.rows.repaid, { name: 'Still repaid', value: '€30,000 a year' }, 'stay repaid');
    assertDeepEqual(stay.rows.freed, { name: 'Freed', value: 'Nothing' }, 'stay freed row');

    const repay = buildTradeDownCopy(projection, 'repay-18000');
    assertDeepEqual(repay.figure, { value: '€546,000', word: 'home budget' }, 'figure');
    assertDeepEqual(
      repay.block1,
      { amount: '€343,000', name: 'From selling, after buying costs', note: '€355,000 released, less €12,000 buying costs' },
      'block 1'
    );
    assertDeepEqual(repay.block2, { amount: '€203,000', name: 'New loan' }, 'block 2');
    assertDeepEqual(repay.freed, { value: '€12,000', word: 'freed each year' }, 'freed');
    assertDeepEqual(repay.rows.repaid, { name: 'Still repaid', value: '€18,000 a year' }, 'repaid row');
    assertDeepEqual(repay.rows.freed, { name: 'Freed', value: '€12,000 a year' }, 'freed row');
    assertDeepEqual(repay.today, { label: 'Today’s home', value: '€650,000' }, 'today');
    assertEqual(repay.trackNote, 'The full track is today’s €30,000 a year.', 'track note');

    const none = buildTradeDownCopy(projection, 'no-mortgage');
    assertDeepEqual(none.block2, { amount: '€0', name: 'No new loan' }, 'no loan');
    assertDeepEqual(none.rows.repaid, { name: 'Still repaid', value: 'Nothing' }, 'nothing repaid');
    assertDeepEqual(none.rows.freed, { name: 'Freed', value: '€30,000 a year' }, 'all freed');

    assertEqual(
      repay.footnote,
      'Education only. New loans run 15 years at 4%, and buying costs are €12,000. Loans are rounded to the nearest €1,000. This shows what each case would change.',
      'footnote'
    );
  }));

  cases.push(runCase('A repayment that frees nothing says so, in the sentence and in the year', () => {
    const projection = project(SHAPES.nothingFreed);
    const copy = buildTradeDownCopy(projection, 'same');
    assert(/with nothing freed\.$/.test(copy.headline), `sentence: ${copy.headline}`);
    assertEqual(copy.freed.value, '€0', 'freed figure');
    assertEqual(copy.rows.freed.value, 'Nothing', 'freed row');
  }));

  cases.push(runCase('The footnote reads the loan terms from the model, and says one year in the singular', () => {
    const copy = buildTradeDownCopy(project(shape({
      newLoanTermYears: 1,
      newLoanAnnualRate: 0.0325,
      scenarios: [{ id: 'a', kind: 'move', annualRepayment: 1_000 }]
    })), 'a');
    assert(copy.footnote.includes('New loans run 1 year at 3.25%'), copy.footnote);
  }));

  cases.push(runCase('No string on screen holds a banned phrase, "we", "us", "our", a provider or a bare amount', () => {
    Object.entries(SHAPES).forEach(([label, payload]) => {
      const projection = project(payload);
      projection.debug.cases.forEach((entry) => {
        const problems = findForbiddenText(collectTradeDownStrings(projection, entry.id));
        assert(problems.length === 0, `${label}/${entry.id}: ${problems.join('; ')}`);
      });
    });
    const dirty = findForbiddenText(['We recommend', 'You should repay', 'The best option', 'p.a.', 'ask us', 'our home', 'AIB', '€180000']);
    assertEqual(dirty.length >= 8, true, `the scan catches what it is meant to (${dirty.length})`);
  }));

  cases.push(runCase('The reference frame: a 940-wide bar, the year at 1250, its hairline at 1210', () => {
    const layout = layoutTradeDownChart(project(sample), { width: 1728 });
    assertEqual(layout.narrow, false, 'wide');
    assertEqual(layout.chartWidth, 1632, 'chart width');
    assertEqual(layout.barScale, 940, 'the bar is today’s home');
    assertEqual(layout.boxes.rule.left, 1210, 'hairline');
    assertEqual(layout.boxes.track.left, 1250, 'the year');
    assertEqual(layout.boxes.track.width, 380, 'the track');
    assertEqual(layout.boxes.todayLine.left, 940, 'the marker is the end of the bar');
  }));

  cases.push(runCase('The reference frame: the blocks and the track for each of the four cases', () => {
    const layout = layoutTradeDownChart(project(sample), { width: 1728 });
    const [stay, a, b, none] = ['stay', 'repay-18000', 'repay-12000', 'no-mortgage'].map((id) => layout.values[id]);
    // [blockOneWidth, blockTwoLeft, blockTwoWidth, labelTwoLeft, repaidWidth, freedLeft, freedWidth]
    assertWithin(stay[0], (370_000 / 650_000) * 940, 0.01, 'stay block 1');
    assertWithin(stay[2], (280_000 / 650_000) * 940, 0.01, 'stay block 2');
    assertWithin(stay[0] + stay[2], 940, 0.01, 'the stay fills the bar: the whole home');
    assertWithin(a[0], (343_000 / 650_000) * 940, 0.01, 'move block 1');
    assertWithin(a[0], 496, 0.1, 'about 496px');
    assertWithin(a[2], (203_000 / 650_000) * 940, 0.01, 'a loan of 203,000');
    assertWithin(a[2], 293.6, 0.1, 'about 294px');
    assertWithin(b[2], (135_000 / 650_000) * 940, 0.01, 'a loan of 135,000');
    assertEqual(none[2], 0, 'no loan, no second block');
    assertWithin(a[1], a[0], 0.01, 'block 2 starts where block 1 ends');

    assertWithin(stay[4], 380, 0.01, 'stay: the whole track is repaid');
    assertWithin(stay[6], 0, 0.01, 'stay: nothing freed');
    assertWithin(a[4], 228, 0.01, '18,000 of 30,000 repaid');
    assertWithin(a[6], 152, 0.01, '12,000 of 30,000 freed');
    assertWithin(a[5], a[4], 0.01, 'freed starts where repaid ends');
    assertWithin(none[4], 0, 0.01, 'no mortgage: nothing repaid');
    assertWithin(none[6], 380, 0.01, 'no mortgage: the whole track is freed');
  }));

  cases.push(runCase('The bar’s scale is the same in every case, so nothing rescales on a click', () => {
    Object.entries(SHAPES).forEach(([label, payload]) => {
      const projection = project(payload);
      WIDTHS.forEach((width) => {
        const layout = layoutTradeDownChart(projection, { width });
        const { homeValue } = projection.debug.inputs;
        projection.debug.cases.forEach((entry) => {
          const [blockOne, , blockTwo] = layout.values[entry.id];
          assertWithin(
            blockOne + blockTwo,
            (entry.homeBudget / homeValue) * layout.barScale,
            0.01,
            `${label}/${entry.id} at ${width}: the bar length is the budget over today's home`
          );
        });
      });
    });
  }));

  cases.push(runCase('Every shape at every width: nothing leaves the chart and no label meets another', () => {
    Object.entries(SHAPES).forEach(([label, payload]) => {
      const projection = project(payload);
      WIDTHS.forEach((width) => {
        const layout = layoutTradeDownChart(projection, { width });
        const problems = checkTradeDownLayout(projection, layout);
        assert(problems.length === 0, `${label} at ${width}: ${problems.join('; ')}`);
        projection.debug.cases.forEach((entry) => {
          assertEqual(layout.values[entry.id].length, 7, `${label}/${entry.id}: value count`);
        });
      });
    });
  }));

  cases.push(runCase('A first block the buying costs have nearly emptied does not meet the second label', () => {
    const projection = project(SHAPES.tinyFirstBlock);
    // Side by side the second label moves right; compact, it sits under the first.
    [432, 1776].forEach((width) => {
      const layout = layoutTradeDownChart(projection, { width });
      const [blockOne, , , labelTwoLeft] = layout.values.a;
      assert(blockOne < 3, `${width}: the first block is a sliver (${blockOne.toFixed(2)})`);
      assert(labelTwoLeft > blockOne + 100, `${width}: the second label has moved clear (${labelTwoLeft.toFixed(1)})`);
    });
    [252, 358].forEach((width) => {
      const layout = layoutTradeDownChart(projection, { width });
      const [, , , labelTwoLeft] = layout.values.a;
      const { labelOne, labelTwo } = layout.boxes;
      assertEqual(layout.compact, true, `${width} is compact`);
      assertEqual(labelTwoLeft, 0, `${width}: the second label starts at the left, under the first`);
      assert(labelTwo.top >= labelOne.top + labelOne.height, `${width}: the second label is under the first`);
    });
  }));

  cases.push(runCase('Compact, from a 252px module: stacked words, a fitted figure and rows, nothing past the chart', () => {
    const projection = project(sample);
    const phone = layoutTradeDownChart(projection, { width: 252 });
    assertEqual(phone.chartWidth, 220, 'a 252 module gives a 220 chart');
    assertEqual(phone.compact, true, '252 is compact');
    assertEqual(phone.narrow, true, 'and stacked');
    assertEqual(phone.height, 590, 'compact height');
    assert(phone.boxes.figure.font >= 24 && phone.boxes.figure.font <= 36, `the figure font ${phone.boxes.figure.font}`);
    assert(phone.boxes.freed.font >= 24 && phone.boxes.freed.font <= 36, `the freed font ${phone.boxes.freed.font}`);
    assertEqual(phone.boxes.rowRepaid.height, 44, 'a row holds a name over an amount');
    assert(phone.boxes.rowFreed.top >= phone.boxes.rowRepaid.top + phone.boxes.rowRepaid.height, 'the rows do not meet');
    assert(phone.boxes.track.top >= phone.boxes.freed.top + phone.boxes.freed.height, 'the track is below the freed amount');

    // The boundary: a 431 module is compact, a 432 module is the stacked arrangement.
    assertEqual(layoutTradeDownChart(projection, { width: 431 }).compact, true, '431 is compact');
    assertEqual(layoutTradeDownChart(projection, { width: 432 }).compact, false, '432 is not');
    assertEqual(layoutTradeDownChart(projection, { width: 1632 }).compact, false, 'wide is never compact');

    // A bigger home gets a smaller figure, never a wider one.
    const large = layoutTradeDownChart(project(SHAPES.large), { width: 252 });
    assert(large.boxes.figure.font <= phone.boxes.figure.font, 'a longer home figure is no larger');
    assertDeepEqual(checkTradeDownLayout(project(SHAPES.large), large), [], 'a €4.85m home still fits at 252');

    // The font is one per layout, so nothing resizes on a click.
    assertEqual(typeof phone.boxes.figure.font, 'number', 'one figure font for every case');
  }));

  cases.push(runCase('The arrangement: side by side from 1632, stacked and capped at 720 under it', () => {
    const projection = project(sample);
    const wide = layoutTradeDownChart(projection, { width: 1632 });
    assertEqual(wide.narrow, false, '1632 is wide');
    assertEqual(wide.boxes.noteInLabel, true, 'the note sits in the first label');
    assertEqual(wide.boxes.noteFull, null, 'no separate note');
    assertEqual(wide.height, 380, 'wide height');

    const stacked = layoutTradeDownChart(projection, { width: 1631 });
    assertEqual(stacked.narrow, true, '1631 is stacked');
    assertEqual(stacked.chartWidth, 720, 'capped at 720');
    assertEqual(stacked.barScale, 720, 'the bar fills the chart');
    assertEqual(stacked.boxes.noteInLabel, false, 'the note moves under both labels');
    assertEqual(stacked.boxes.noteFull.width, 720, 'full width');
    assertEqual(stacked.height, 470, 'stacked height');

    const phone = layoutTradeDownChart(projection, { width: 390 });
    assertEqual(phone.chartWidth, 358, 'a 390 phone gives a 358 chart');
    assertEqual(phone.boxes.track.width, 358, 'the track fills the chart');
    assertEqual(phone.boxes.todayLine.left, 357, 'the marker is the bar’s right edge');
  }));

  cases.push(runCase('Interpolation is exact at both ends, and the case is not mutated', () => {
    const layout = layoutTradeDownChart(project(sample), { width: 1776 });
    const from = layout.values.stay.slice();
    const to = layout.values['repay-18000'].slice();
    assertDeepEqual(lerpValues(from, to, 1), to, 'progress 1 is the target');
    assertDeepEqual(lerpValues(from, to, 0), from, 'progress 0 is where it started');
    const middle = lerpValues(from, to, 0.5);
    assertWithin(middle[0], (from[0] + to[0]) / 2, 1e-9, 'halfway');
    assertDeepEqual(layout.values.stay, from, 'the source is untouched');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };

  if (failed > 0) {
    console.warn('[HomeTradeDownViewTests] Completed with failures', summary);
  } else {
    console.info('[HomeTradeDownViewTests] All tests passed', { total: summary.total, passed: summary.passed });
  }

  return summary;
}
