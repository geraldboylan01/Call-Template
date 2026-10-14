import { computeHouseholdCashFlowProjection } from './household_cash_flow_math.js';
import {
  HOUSEHOLD_CASH_FLOW_SAMPLE,
  designFixtureOptions
} from './tests_household_cash_flow_math.js';
import {
  BAR_BELOW_WIDTH,
  STAIRS_FROM_WIDTH,
  barGeometry,
  buildCashFlowCopy,
  checkBarLayout,
  checkStairsLayout,
  chooseDrawing,
  collectCashFlowStrings,
  findForbiddenText,
  layoutBar,
  layoutStairs,
  lerpValues,
  readCashFlowModel,
  stairsGeometry,
  stairsOutlines
} from './household_cash_flow_view.js';

/**
 * The screen's own decisions, proved without a DOM: what it says, which drawing
 * it picks, where everything sits, and that nothing it draws lands on anything
 * else.
 *
 * THE WIDTHS. The staircase is checked at 1728 (the design frame), 1360 (the
 * widest the answer sits above), 1200, 976, 848 (the first width that takes the
 * staircase) and 832 (the narrowest it can be on, kept by the dead band). The
 * bar is checked at 560 (its widest), 390, 350 (a 390 phone less its sides) and
 * 320 (a 360 phone).
 */

const STAIRS_WIDTHS = Object.freeze([1728, 1360, 1200, 976, 848, 832]);
const BAR_WIDTHS = Object.freeze([560, 390, 350, 320]);
const CALCULATION = Object.freeze({ calculationYear: 2026 });

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
    console.info(`[HouseholdCashFlowViewTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[HouseholdCashFlowViewTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

function payload(mutate) {
  const next = clone(HOUSEHOLD_CASH_FLOW_SAMPLE);
  if (mutate) mutate(next);
  return next;
}

const SIX_LINES = payload((p) => {
  p.outgoings = [
    { id: 'mortgage', label: 'Mortgage', amount: 24_000 },
    { id: 'car', label: 'Car loan', amount: 6_000 },
    { id: 'food', label: 'Food', amount: 12_000 },
    { id: 'bills', label: 'Bills', amount: 8_000 },
    { id: 'children', label: 'Children', amount: 9_000 },
    { id: 'insurance', label: 'Insurance', amount: 3_000 }
  ];
});

const ONE_PERSON = {
  householdTaxStatus: 'single',
  people: [{ id: 'alex', age: 40 }],
  income: [{ personId: 'joint', type: 'employment', amount: 90_000 }],
  outgoings: [{ id: 'rent', label: 'Rent', amount: 20_000 }, { id: 'living', label: 'Living costs', amount: 30_000 }],
  scenarios: [
    { id: 'today' },
    { id: 'pension', changes: [{ type: 'extraPension', amount: 8_000 }] },
    { id: 'rent', changes: [{ type: 'clearOutgoing', outgoingId: 'rent' }] }
  ]
};

/** Payload shapes the screen must hold up under, each with the options it runs with. */
const SHAPES = Object.freeze([
  { name: 'the sample (engine tax)', raw: HOUSEHOLD_CASH_FLOW_SAMPLE, options: CALCULATION },
  { name: 'the design fixture', raw: HOUSEHOLD_CASH_FLOW_SAMPLE, options: designFixtureOptions() },
  {
    name: 'a stated take-home',
    raw: payload((p) => {
      p.people[0].statedTakeHome = 50_000;
    }),
    options: CALCULATION
  },
  { name: 'one person', raw: ONE_PERSON, options: CALCULATION },
  { name: 'six lines and a pension', raw: SIX_LINES, options: CALCULATION }
]);

function project(shape) {
  return computeHouseholdCashFlowProjection(shape.raw, shape.options);
}

/* ------------------------------------------------------------------ suite */

export function runHouseholdCashFlowViewTests() {
  const cases = [];

  cases.push(runCase('Fixed words: the muted line, the question and the income label are in the "you" voice', () => {
    const projection = project(SHAPES[0]);
    const copy = buildCashFlowCopy(projection, 'today');
    assertEqual(copy.mutedLine, 'Your household cash flow', 'muted line');
    assertEqual(copy.heading, 'After everything you pay, what is left each year?', 'the question');
    assertEqual(copy.incomeLabel, 'Your income before tax', 'income label');
    assertEqual(copy.incomeLine, '€150,000 a year', 'income line');
    assertEqual(copy.unit, 'a year', 'the unit');
  }));

  cases.push(runCase('The case buttons, answer, sentence and footnote are the engine\'s own', () => {
    const projection = project(SHAPES[1]);
    const detail = projection.debug.cases;
    detail.forEach((entry) => {
      const copy = buildCashFlowCopy(projection, entry.id);
      assertEqual(copy.sentence, entry.sentence, `${entry.id}: the sentence`);
      assertEqual(copy.monthly, entry.monthly.text, `${entry.id}: the month figure`);
      assertEqual(copy.footnote, projection.debug.footnote, `${entry.id}: the footnote`);
      assertEqual(copy.buttons.map((button) => button.title).join('|'), detail.map((item) => item.title).join('|'), 'buttons');
      assertEqual(copy.status.kind, entry.status, `${entry.id}: the status`);
    });
    // The design fixture leaves nothing in case 3: "Tight", and a month of €0.
    const tight = buildCashFlowCopy(projection, 'pension');
    assertEqual(tight.status.word, 'Tight', 'a case that leaves nothing is Tight');
    assertEqual(tight.figure, '€0', 'and shows €0');
    assertEqual(tight.todayFigure, '€6,000 left over', 'today\'s figure in words');
  }));

  cases.push(runCase('Nothing the screen says is banned wording, third person, a provider or a bare amount', () => {
    SHAPES.forEach((shape) => {
      const projection = project(shape);
      projection.debug.cases.forEach((entry) => {
        const problems = findForbiddenText(collectCashFlowStrings(projection, entry.id));
        assert(problems.length === 0, `${shape.name}, ${entry.id}: ${problems.join('; ')}`);
      });
    });
  }));

  cases.push(runCase('The drawing is chosen by the content width, with a dead band that keeps what is showing', () => {
    assertEqual(chooseDrawing(STAIRS_FROM_WIDTH - 1 === 847 ? 831 : 831), 'bar', '831 is the bar');
    assertEqual(chooseDrawing(848), 'stairs', '848 is the staircase');
    assertEqual(chooseDrawing(1920), 'stairs', 'a wide screen');
    assertEqual(chooseDrawing(390), 'bar', 'a phone');
    // Between the two, whichever is showing stays.
    assertEqual(chooseDrawing(840, 'stairs'), 'stairs', 'a staircase stays in the dead band');
    assertEqual(chooseDrawing(840, 'bar'), 'bar', 'a bar stays in the dead band');
    assertEqual(chooseDrawing(840), 'bar', 'with nothing showing yet, the narrow one');
    // A scrollbar's 15px either side of 840 does not flip a drawing back and forth.
    let drawing = 'bar';
    [850, 835, 848, 833, 846, 832].forEach((width) => {
      drawing = chooseDrawing(width, drawing);
    });
    assertEqual(drawing, 'stairs', 'a jitter inside the band never leaves the staircase');
    assertEqual(chooseDrawing(BAR_BELOW_WIDTH - 1, 'stairs'), 'bar', 'and below the band it is the bar');
  }));

  cases.push(runCase('The staircase at the design width is the design frame: nine columns, pitch 156, plot 450', () => {
    const projection = project(SHAPES[0]);
    const layout = layoutStairs(projection, { width: 1728 });
    assertEqual(layout.columns, 9, 'income, tax, pensions, five lines, left over');
    assertEqual(layout.beside, true, 'the answer sits beside it');
    assertEqual(Math.round(layout.pitch), 156, 'pitch');
    assertEqual(Math.round(layout.barWidth), 104, 'bar width');
    assertEqual(Math.round(layout.plotHeight), 450, 'plot height');
    assertEqual(Math.round(layout.fonts.amount), 28, 'amounts at 28');
    assertEqual(Math.round(layout.fonts.name), 22, 'names at 22');
  }));

  cases.push(runCase('Nothing overlaps on the staircase, at every width and over every shape', () => {
    SHAPES.forEach((shape) => {
      const projection = project(shape);
      const model = readCashFlowModel(projection);
      STAIRS_WIDTHS.forEach((width) => {
        const layout = layoutStairs(projection, { width });
        const problems = checkStairsLayout(layout, model);
        assert(problems.length === 0, `${shape.name} at ${width}: ${problems.join('; ')}`);
        assert(layout.fonts.name >= 14 && layout.fonts.amount >= 16, `${shape.name} at ${width}: type floors`);
        assert(layout.plotHeight >= 300 && layout.plotHeight <= 450, `${shape.name} at ${width}: plot height`);
        assert(layout.plotWidth <= width + 0.01, `${shape.name} at ${width}: plot width`);
        assertEqual(layout.beside, width >= 1360, `${shape.name} at ${width}: answer placement`);
      });
    });
  }));

  cases.push(runCase('One scale on the staircase: nothing rescales between cases, and every case adds up', () => {
    SHAPES.forEach((shape) => {
      const projection = project(shape);
      const model = readCashFlowModel(projection);
      [1728, 976].forEach((width) => {
        const layout = layoutStairs(projection, { width });
        model.cases.forEach((entry) => {
          const geometry = stairsGeometry(layout, entry.values);
          assertEqual(Math.round(geometry.bars[0].height * 100), Math.round(layout.plotHeight * 100), 'income is the whole plot');
          entry.drawn.forEach((line, index) => {
            assert(
              Math.abs(geometry.bars[index + 1].height - line.amount * layout.perEuro) < 0.01,
              `${shape.name} ${entry.id}: ${line.id} is drawn on the one scale`
            );
          });
          const last = geometry.bars[geometry.bars.length - 1];
          assert(Math.abs(last.top + last.height - layout.floor) < 0.01, 'what is left stands on the floor');
          const lastCost = geometry.bars[geometry.bars.length - 2];
          assert(
            Math.abs(lastCost.top + lastCost.height - last.top) < 0.01 || entry.drawn.length === 0,
            `${shape.name} ${entry.id}: the last step ends where what is left begins`
          );
        });
      });
    });
  }));

  cases.push(runCase('Today\'s outlines: only where an amount changed, plus the last column, never on a column that only moved', () => {
    [SHAPES[0], SHAPES[1]].forEach((shape) => {
      const projection = project(shape);
      const model = readCashFlowModel(projection);
      const layout = layoutStairs(projection, { width: 1728 });
      const ids = model.drawnLines.map((line) => line.id);
      const visible = (caseId) => stairsOutlines(layout, model, caseId).outlines
        .filter((outline) => outline.visible)
        .map((outline) => (outline.column <= ids.length ? ids[outline.column - 1] : 'left'));

      assertEqual(visible('today').length, 0, `${shape.name}: none on today`);
      assertEqual(stairsOutlines(layout, model, 'today').keyVisible, false, `${shape.name}: no key on today`);

      const clearCar = visible('clear-car' in {} ? 'clear-car' : model.cases[1].id).sort().join(',');
      assertEqual(clearCar, 'car,left', `${shape.name}: clearing the car loan outlines the car loan and what is left`);

      const pension = visible(model.cases[2].id).sort().join(',');
      assertEqual(pension, 'left,tax', `${shape.name}: a pension outlines tax and what is left, and not pensions`);
      ['mortgage', 'car', 'living', 'children', 'insurance', 'pensions'].forEach((id) => {
        assert(!visible(model.cases[2].id).includes(id), `${shape.name}: no outline on ${id} for the pension case`);
      });

      // Case 4: the same left over, a different household. Outlines on exactly
      // the changed columns, and none on the last column, because it did not move.
      const both = visible(model.cases[3].id).sort().join(',');
      assertEqual(both, 'car,tax', `${shape.name}: both changes outline tax and the car loan only`);
      const bothOutline = stairsOutlines(layout, model, model.cases[3].id);
      assertEqual(bothOutline.lastLabel.visible, false, `${shape.name}: no label on a last column that did not change`);
      assertEqual(bothOutline.keyVisible, true, `${shape.name}: the key is there because an outline is`);
    });
  }));

  cases.push(runCase('The last column\'s outline is labelled with today\'s figure, above whichever stands higher', () => {
    const projection = project(SHAPES[0]);
    const model = readCashFlowModel(projection);
    const layout = layoutStairs(projection, { width: 1728 });
    const copy = buildCashFlowCopy(projection, model.cases[2].id);
    assertEqual(copy.todayFigure, '€9,200 left over', 'today\'s figure');
    const outline = stairsOutlines(layout, model, model.cases[2].id);
    assertEqual(outline.lastLabel.visible, true, 'the label shows with the outline');
    const todayLeft = model.cases[0].left;
    const thisLeft = model.cases[2].left;
    const topFor = outline.lastLabel.topFor(thisLeft);
    assert(
      topFor + outline.lastLabel.height <= layout.floor - Math.max(todayLeft, thisLeft) * layout.perEuro + 0.01,
      'the label sits above both'
    );
  }));

  cases.push(runCase('Nothing overlaps on the bar, at every width and over every shape', () => {
    SHAPES.forEach((shape) => {
      const projection = project(shape);
      const model = readCashFlowModel(projection);
      BAR_WIDTHS.forEach((width) => {
        const layout = layoutBar(projection, { width });
        const problems = checkBarLayout(layout, model);
        assert(problems.length === 0, `${shape.name} at ${width}: ${problems.join('; ')}`);
        assert(layout.contentWidth <= 560, `${shape.name} at ${width}: the content stops growing at 560`);
      });
    });
  }));

  cases.push(runCase('One scale on the bar: the bar is the whole of income and spends from the top down', () => {
    const projection = project(SHAPES[0]);
    const model = readCashFlowModel(projection);
    const layout = layoutBar(projection, { width: 350 });
    assertEqual(layout.barHeight, 700, 'the bar is 700 tall');
    model.cases.forEach((entry) => {
      const { segments } = barGeometry(layout, entry.values);
      const spent = segments.slice(0, -1).reduce((sum, segment) => sum + segment.raw, 0);
      const left = segments[segments.length - 1];
      assert(Math.abs(spent + left.raw - 700) < 0.01, `${entry.id}: costs and what is left fill the bar`);
      assert(Math.abs(left.top + left.raw - 700) < 0.01, `${entry.id}: what is left is the last piece`);
    });
  }));

  cases.push(runCase('Interpolation is exact at both ends, so a settled frame is the target', () => {
    const from = [1, 2, 3];
    const to = [4, 6, 9];
    assertEqual(JSON.stringify(lerpValues(from, to, 0)), '[1,2,3]', 'start');
    assertEqual(JSON.stringify(lerpValues(from, to, 1)), '[4,6,9]', 'end');
    assertEqual(JSON.stringify(lerpValues(from, to, 0.5)), '[2.5,4,6]', 'middle');
  }));

  cases.push(runCase('A short case is not drawn: the model refuses to read one', () => {
    const projection = project(SHAPES[0]);
    projection.debug.cases[0].shownLeftOver = -2_800;
    let refused = false;
    try {
      readCashFlowModel(projection);
    } catch (error) {
      refused = /short case cannot be drawn yet/.test(error.message);
    }
    assert(refused, 'refused with its reason');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };
  if (failed > 0) {
    console.warn('[HouseholdCashFlowViewTests] Completed with failures', summary);
  } else {
    console.info('[HouseholdCashFlowViewTests] All tests passed', { total: summary.total, passed: summary.passed });
  }
  return summary;
}
