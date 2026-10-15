import { computeHouseholdCashFlowProjection } from './household_cash_flow_math.js';
import {
  HOUSEHOLD_CASH_FLOW_PENSION_SHORT_SAMPLE,
  HOUSEHOLD_CASH_FLOW_SAMPLE,
  HOUSEHOLD_CASH_FLOW_SHORT_SAMPLE,
  designFixtureOptions
} from './tests_household_cash_flow_math.js';
import {
  BAR_BELOW_WIDTH,
  STAIRS_FROM_WIDTH,
  barGeometry,
  barRowSpecs,
  buildCashFlowCopy,
  checkBarLayout,
  checkStairsLayout,
  chooseDrawing,
  collectCashFlowStrings,
  findForbiddenText,
  layoutBar,
  layoutStairs,
  lerpValues,
  placeBarRows,
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
  { name: 'six lines and a pension', raw: SIX_LINES, options: CALCULATION },
  // The short state, in the three ways a household gets there.
  { name: 'today short (the frames)', raw: HOUSEHOLD_CASH_FLOW_SHORT_SAMPLE, options: CALCULATION },
  { name: 'left over tipped under by a case', raw: HOUSEHOLD_CASH_FLOW_PENSION_SHORT_SAMPLE, options: CALCULATION },
  { name: 'today short on the design fixture', raw: HOUSEHOLD_CASH_FLOW_SHORT_SAMPLE, options: designFixtureOptions() }
]);

const SHORT_TODAY = SHAPES[5];
const SHORT_TIPPED = SHAPES[6];
const SHORT_DESIGN = SHAPES[7];

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
          const lastCost = geometry.bars[geometry.bars.length - 2];
          if (entry.left >= 0) {
            assert(Math.abs(last.top + last.height - layout.floor) < 0.01, 'what is left stands on the floor');
            assert(
              Math.abs(lastCost.top + lastCost.height - last.top) < 0.01 || entry.drawn.length === 0,
              `${shape.name} ${entry.id}: the last step ends where what is left begins`
            );
          } else {
            // What is short hangs from the floor, to where the last step ended.
            assertEqual(last.kind, 'short', `${shape.name} ${entry.id}: it is a short bar`);
            assert(Math.abs(last.top - layout.floor) < 0.01, `${shape.name} ${entry.id}: what is short hangs from the floor`);
            assert(
              Math.abs(last.height - -entry.left * layout.perEuro) < 0.01,
              `${shape.name} ${entry.id}: and is drawn on the one scale`
            );
            assert(
              Math.abs(lastCost.top + lastCost.height - (last.top + last.height)) < 0.01 || entry.drawn.length === 0,
              `${shape.name} ${entry.id}: the last step and what is short end at the same depth`
            );
          }
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
    assertEqual(layout.reserve, 0, 'nothing is short, so no room is kept below the bar');
    assertEqual(layout.height, 780, 'and the chart is its usual height');
  }));

  cases.push(runCase('Interpolation is exact at both ends, so a settled frame is the target', () => {
    const from = [1, 2, 3];
    const to = [4, 6, 9];
    assertEqual(JSON.stringify(lerpValues(from, to, 0)), '[1,2,3]', 'start');
    assertEqual(JSON.stringify(lerpValues(from, to, 1)), '[4,6,9]', 'end');
    assertEqual(JSON.stringify(lerpValues(from, to, 0.5)), '[2.5,4,6]', 'middle');
  }));

  cases.push(runCase('A short case is read and drawn: the model carries it and the room for the deepest', () => {
    const model = readCashFlowModel(project(SHORT_TODAY));
    assert(model.cases[0].left < 0, 'today is short');
    assertEqual(model.cases[0].status, 'short', 'with the status the engine gave it');
    assertEqual(model.deepest, Math.max(...model.cases.map((entry) => -entry.left)), 'the deepest case sets the room');
    assert(readCashFlowModel(project(SHAPES[0])).deepest === 0, 'nothing short, nothing kept');
  }));

  cases.push(runCase('Short words: the word, the figure, the last name and today\'s outline are in the "you" voice', () => {
    const projection = project(SHORT_DESIGN);
    const today = buildCashFlowCopy(projection, 'today');
    assertEqual(today.status.kind, 'short', 'the status kind');
    assertEqual(today.status.word, 'Short', 'the status word');
    assertEqual(today.figure, '€6,000', 'the size, with no sign: the word carries it');
    assertEqual(today.monthly, '€500 a month', 'and the month, the same way');
    assertEqual(today.lastName, 'Short', 'the last column and row take the word');
    assertEqual(today.todayFigure, '€6,000 short', 'today\'s outline says where you were, in words');
    assertEqual(
      today.sentence,
      'Today, €156,000 goes out against your €150,000, and you are short by €6,000.',
      'today\'s sentence'
    );
    assertEqual(today.chartLabel, `Short: €6,000 a year. ${today.sentence}`, 'the drawing is named for the word and the size');

    const clear = buildCashFlowCopy(projection, projection.debug.cases[1].id);
    assertEqual(clear.status.word, 'Tight', 'a case that clears it exactly is Tight');
    assertEqual(clear.lastName, 'Left over', 'and the last column takes the other word');
    assertEqual(clear.todayFigure, '€6,000 short', 'today\'s outline still says short');

    // The word is "Short" in every place a case can be short: nothing says "negative".
    SHAPES.slice(5).forEach((shape) => {
      const shapeProjection = project(shape);
      shapeProjection.debug.cases.forEach((entry) => {
        const strings = collectCashFlowStrings(shapeProjection, entry.id).join(' | ');
        assert(!/-|−|negative|deficit|overdrawn/i.test(strings.replace(/\d+-\w+/g, '')), `${shape.name} ${entry.id}: no sign or accounting word: ${strings}`);
      });
    });
  }));

  cases.push(runCase('Below the floor: one scale, room kept for the deepest case in every case, and the floor named', () => {
    [SHORT_TODAY, SHORT_TIPPED].forEach((shape) => {
      const projection = project(shape);
      const model = readCashFlowModel(projection);
      STAIRS_WIDTHS.forEach((width) => {
        const layout = layoutStairs(projection, { width });
        const hang = model.deepest * layout.perEuro;
        assert(layout.band >= hang + 19 && layout.band <= hang + 21, `${shape.name} at ${width}: the band is the deepest case and 20`);
        assert(layout.namesTop >= layout.floor + layout.band, `${shape.name} at ${width}: names clear the band`);
        assertEqual(layout.zero.visible, true, `${shape.name} at ${width}: the floor is named`);
        assert(layout.zero.left + layout.zero.width <= 0, `${shape.name} at ${width}: "€0" is left of the plot`);
        assert(layout.zero.left >= -28 - 0.5, `${shape.name} at ${width}: and inside the 28px kept for it`);
        // The same layout for every case: the chart is as tall for a case that is not short.
        assertEqual(layout.height, layout.namesTop + layout.namesHeight + 8, `${shape.name} at ${width}: height is in the layout, not the case`);
      });
    });

    // Nothing short, nothing kept: the staircase is exactly as it was.
    const plain = layoutStairs(project(SHAPES[0]), { width: 1728 });
    assertEqual(plain.band, 0, 'no band when nothing is short');
    assertEqual(plain.zero.visible, false, 'and no "€0"');
    assertEqual(Math.round(plain.namesTop - plain.floor), 16, 'names sit as they did');
  }));

  cases.push(runCase('The staircase runs past the floor: a step that starts above it ends below it, and what is short hangs', () => {
    const projection = project(SHORT_TODAY);
    const model = readCashFlowModel(projection);
    const layout = layoutStairs(projection, { width: 1728 });
    model.cases.filter((entry) => entry.left < 0).forEach((entry) => {
      const geometry = stairsGeometry(layout, entry.values);
      const last = geometry.bars[geometry.bars.length - 1];
      assertEqual(last.kind, 'short', `${entry.id}: the last bar is the short bar`);
      assertEqual(Math.round(last.top), Math.round(layout.floor), `${entry.id}: it hangs from the floor`);
      assert(last.height > 0, `${entry.id}: with a height`);
      assert(last.top + last.height < layout.namesTop, `${entry.id}: and stops above the names`);
      // Some step crosses the floor: it starts above it and ends below.
      const crossing = geometry.bars.slice(1, -1).find((bar) => bar.top < layout.floor && bar.top + bar.height > layout.floor);
      assert(crossing, `${entry.id}: a cost step crosses the floor`);
      // The amounts of steps that start below the floor sit above their bars,
      // inside the room kept, and never reach the names.
      geometry.amounts.forEach((amount, index) => {
        assert(amount.top + layout.fonts.amount * 1.1 < layout.namesTop, `${entry.id}: amount ${index} stays above the names`);
      });
    });
    // A case that is left over still stands on the floor in the same layout.
    const standing = stairsGeometry(layout, model.cases[1].values);
    assertEqual(standing.bars[standing.bars.length - 1].kind, 'left', 'a case that is left over stands');
  }));

  cases.push(runCase('Short outlines: today\'s hangs below the floor, and the label stays above it either way', () => {
    // Short today, left over in a case: the outline hangs, the label is above the green bar.
    const projection = project(SHORT_TODAY);
    const model = readCashFlowModel(projection);
    const layout = layoutStairs(projection, { width: 1728 });
    const clear = stairsOutlines(layout, model, model.cases[1].id);
    const last = clear.outlines[clear.outlines.length - 1];
    assertEqual(last.visible, true, 'the last column is outlined');
    assertEqual(Math.round(last.top), Math.round(layout.floor), 'today\'s outline hangs from the floor');
    assert(last.height > 0, 'with today\'s depth');
    assertEqual(clear.lastLabel.lines[0], 'Today', 'the label says Today');
    assert(/short$/.test(clear.lastLabel.lines[clear.lastLabel.lines.length - 1]), 'and where you were: short');
    const thisLeft = model.cases[1].left;
    assert(
      clear.lastLabel.topFor(thisLeft) + clear.lastLabel.height <= layout.floor - thisLeft * layout.perEuro + 0.01,
      'the label is above the bar that stands'
    );
    // Short in both: both hang, and the label sits on the floor, not under it.
    const both = stairsOutlines(layout, model, model.cases[2].id);
    const shortNow = model.cases[2].left;
    assert(shortNow < 0, 'the pension case is short');
    assert(both.lastLabel.topFor(shortNow) + both.lastLabel.height <= layout.floor + 0.01, 'the label never goes below the floor');

    // Left over today, short in a case: the outline stands and the red bar hangs.
    const tipped = project(SHORT_TIPPED);
    const tippedModel = readCashFlowModel(tipped);
    const tippedLayout = layoutStairs(tipped, { width: 1728 });
    const tipOutline = stairsOutlines(tippedLayout, tippedModel, tippedModel.cases[2].id);
    const standing = tipOutline.outlines[tipOutline.outlines.length - 1];
    assertEqual(standing.visible, true, 'the last column is outlined');
    assertEqual(
      Math.round(standing.top + standing.height),
      Math.round(tippedLayout.floor),
      'today\'s outline stands on the floor'
    );
    const tipLeft = tippedModel.cases[2].left;
    assert(tipLeft < 0, 'the case is short');
    assert(
      tipOutline.lastLabel.topFor(tipLeft) + tipOutline.lastLabel.height <= standing.top + 0.01,
      'and the label sits above today\'s outline'
    );
  }));

  cases.push(runCase('The bar runs past the end of income: room kept in every case, the short part in red, and its row below', () => {
    const projection = project(SHORT_TODAY);
    const model = readCashFlowModel(projection);
    BAR_WIDTHS.forEach((width) => {
      const layout = layoutBar(projection, { width });
      const hang = model.deepest * layout.perEuro;
      assert(layout.reserve >= hang + 15 && layout.reserve <= hang + 17, `at ${width}: the reserve is the deepest case and 16`);
      assertEqual(layout.height, 780 + layout.reserve, `at ${width}: the chart is that much taller, in every case`);
      assertEqual(layout.incomeEnd, layout.barTop + layout.barHeight, `at ${width}: income ends at 700`);

      model.cases.forEach((entry) => {
        const { segments } = barGeometry(layout, entry.values);
        const last = segments[segments.length - 1];
        if (entry.left < 0) {
          assertEqual(last.kind, 'short', `${entry.id}: the part past income is the short segment`);
          assertEqual(last.top, layout.barHeight, `${entry.id}: it starts where income ends`);
          assert(Math.abs(last.raw - -entry.left * layout.perEuro) < 0.01, `${entry.id}: on the one scale`);
          const lastCost = segments[segments.length - 2];
          assert(
            Math.abs(lastCost.top + lastCost.raw - (layout.barHeight + last.raw)) < 0.01,
            `${entry.id}: the costs run on to the same depth`
          );
          const spec = barRowSpecs(model, entry.id, entry.values).find((row) => row.id === 'left');
          assertEqual(spec.label, 'Short', `${entry.id}: the row is named Short`);
          const rows = placeBarRows(layout, barRowSpecs(model, entry.id, entry.values).map((row) => ({
            ...row,
            centre: segments[row.segment].centre
          })));
          const shortRow = rows[rows.length - 1];
          assert(shortRow.top + shortRow.height <= layout.barTop + layout.barHeight + layout.reserve + 12, `${entry.id}: its row is inside the room`);
          assert(shortRow.c >= layout.barTop + layout.barHeight - 1, `${entry.id}: and below where income ends`);
        } else if (entry.left > 0) {
          assertEqual(last.kind, 'left', `${entry.id}: what is left is the last piece`);
        }
      });
    });
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
