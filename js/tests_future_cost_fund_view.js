import { computeFutureCostFundProjection } from './future_cost_fund_math.js';
import {
  FUTURE_COST_FUND_SAMPLE,
  designFixtureOptions
} from './tests_future_cost_fund_math.js';
import {
  PEAK_SHARE_OF_AXIS,
  SAMPLES_PER_YEAR,
  buildFundCopy,
  buildFundPaths,
  checkLabelPlacement,
  chooseAxisMaximum,
  collectFundStrings,
  findForbiddenText,
  layoutCostBlocks,
  layoutFutureCostChart,
  lerpValues,
  placeFundLabels,
  placePanelHeader
} from './future_cost_fund_view.js';

/**
 * The screen's own decisions, proved without a DOM: what it says, where it
 * sits, and that nothing it draws lands on anything else.
 *
 * THE WIDTHS. The agreed set is 358, 720, 1000 and 1776. 358 is a phone, 720 is
 * the first width that uses the wide layout, 1000 is a laptop pane, and 1776 is
 * the design frame (a 1920 screen less its gutters). The half-and-half case
 * overlapped its own labels at 1000 and 358 before the placement was ordered,
 * which is why every case is checked at every width and not just the sample.
 */

const WIDTHS = Object.freeze([358, 720, 1000, 1776]);
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
    console.info(`[FutureCostFundViewTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[FutureCostFundViewTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

const caseSet = (extra = {}) => ({ ...FUTURE_COST_FUND_SAMPLE, ...extra });

/** Payload shapes the screen must hold up under, beyond the sample. */
const STRESS_SHAPES = Object.freeze([
  { name: 'the sample', payload: caseSet() },
  { name: 'a general cost', payload: caseSet({ costKind: 'general', costTitle: 'Care for Mam' }) },
  {
    name: 'a long run: starts in 40 years and runs for 30 (70 columns)',
    payload: caseSet({ startsInYears: 40, durationYears: 30 })
  },
  {
    name: 'a short run: starts next year and lasts a year',
    payload: caseSet({ startsInYears: 1, durationYears: 1, scenarios: [
      { id: 'lump', lumpShare: 1 },
      { id: 'yearly', lumpShare: 0 }
    ] })
  },
  {
    name: 'a one-year cost far away (the cost panel is one column wide)',
    payload: caseSet({ startsInYears: 25, durationYears: 1 })
  },
  {
    name: 'a large cost: amounts over a million',
    payload: caseSet({ annualCostToday: 1_200_000 })
  },
  {
    name: 'mixed shares and a late start',
    payload: caseSet({
      startsInYears: 15,
      durationYears: 6,
      scenarios: [
        { id: 'quarter', lumpShare: 0.25, savingStartsInYears: 5 },
        { id: 'most', lumpShare: 0.75 },
        { id: 'late', lumpShare: 0, savingStartsInYears: 10 },
        { id: 'all', lumpShare: 1 }
      ]
    })
  }
]);

export function runFutureCostFundViewTests() {
  const cases = [];
  const central = computeFutureCostFundProjection(FUTURE_COST_FUND_SAMPLE, CALCULATION);

  cases.push(runCase('Headlines describe the case, in the approved form, at the central figures', () => {
    const expected = {
      lump: 'Setting aside €86,100 today covers the whole cost.',
      yearly: 'Putting in €10,800 a year for 8 years covers the whole cost.',
      half: 'Putting in €43,000 today and €5,400 a year for 8 years covers the whole cost.',
      delayed: 'Putting in €17,300 a year for 5 years, starting in year 3, covers the whole cost.'
    };
    Object.entries(expected).forEach(([id, headline]) => {
      assertEqual(buildFundCopy(central, id).headline, headline, `the ${id} headline`);
    });
  }));

  cases.push(runCase('The support line adds up as shown, and the footnote is read from the model', () => {
    const yearly = buildFundCopy(central, 'yearly');
    assertEqual(
      yearly.support,
      'You pay in €86,500 and growth adds €700. Together that is the €87,200 you need.',
      'the yearly support line'
    );
    assertEqual(
      yearly.footnote,
      '€15,000 a year in today’s money.'
        + ' Education costs rise 4% a year.'
        + ' Your savings earn 0.2% a year before DIRT, and 0.13% after DIRT at 33%.'
        + ' Amounts are rounded to the nearest €100.',
      'the footnote'
    );
    ['lump', 'yearly', 'half', 'delayed'].forEach((id) => {
      const { figures } = buildFundCopy(central, id);
      assertEqual(figures.paid + figures.growth, figures.total, `${id}: paid in plus growth is the total as shown`);
    });
    const general = computeFutureCostFundProjection(caseSet({ costKind: 'general' }), CALCULATION);
    assert(buildFundCopy(general, 'yearly').footnote.includes('Prices rise 2% a year.'), 'a general cost says prices');
  }));

  cases.push(runCase('Case buttons, labels and panel use the "you" wording', () => {
    const copy = buildFundCopy(central, 'half');
    assertEqual(copy.subtitle, 'A four-year cost starting in 8 years', 'the subtitle');
    assertEqual(
      copy.buttons.map((button) => button.amountLine).join(' | '),
      '€86,100 today | €10,800 a year for 8 years | €43,000 today and €5,400 a year | €17,300 a year for 5 years',
      'the amount lines'
    );
    assertEqual(copy.labels.lump, 'You pay in €43,000 today', 'the lump label');
    assertEqual(copy.labels.yearly, 'and €5,400 a year', 'the yearly label after a lump sum');
    assertEqual(copy.labels.fund, 'Your fund, growing 0.13% a year', 'the fund label');
    assertEqual(copy.panel.title, 'What you need: €87,200 in total', 'the panel title');
    assertEqual(copy.panel.covered, 'Covered by your fund', 'the covered line');
    assertEqual(buildFundCopy(central, 'delayed').labels.gap, 'Nothing set aside for 3 years', 'the gap label');
    assertEqual(buildFundCopy(central, 'half').labels.gap, '', 'no gap label when a lump sum is paid today');
    assertEqual(
      buildFundCopy(central, 'yearly', { narrow: true }).labels.yearly,
      '€10,800 a year',
      'the narrow yearly label'
    );
    assertEqual(
      buildFundCopy(central, 'yearly').costByYear,
      'The cost by year: year 8 €20,500, year 9 €21,300, year 10 €22,200, year 11 €23,100.',
      'the by-year line'
    );
  }));

  cases.push(runCase('No banned phrase, provider name, "p.a." or bare amount on any case of any shape', () => {
    STRESS_SHAPES.forEach((shape) => {
      const projection = computeFutureCostFundProjection(shape.payload, CALCULATION);
      projection.debug.cases.forEach((entry) => {
        const problems = findForbiddenText(collectFundStrings(projection, entry.id));
        assert(problems.length === 0, `${shape.name}, ${entry.id}: ${problems.join('; ')}`);
      });
    });
    // The scan itself must catch what it is for.
    assert(findForbiddenText(['We recommend the lump sum']).length > 0, 'it catches "we recommend"');
    assert(findForbiddenText(['AIB pays 0.25%']).length > 0, 'it catches a provider');
    assert(findForbiddenText(['€86100 today']).length > 0, 'it catches an unseparated amount');
    assert(findForbiddenText(['€86,100 p.a.']).length > 0, 'it catches "p.a."');
  }));

  cases.push(runCase('The axis keeps the fund at or under 80% of it, the same for every case', () => {
    assertEqual(chooseAxisMaximum(77_131), 100_000, 'the design fixture peak');
    assertEqual(chooseAxisMaximum(87_174), 120_000, 'the central peak');
    STRESS_SHAPES.forEach((shape) => {
      const projection = computeFutureCostFundProjection(shape.payload, CALCULATION);
      WIDTHS.forEach((width) => {
        const layout = layoutFutureCostChart(projection, { width });
        assert(layout.peakShareOfAxis <= PEAK_SHARE_OF_AXIS + 1e-9,
          `${shape.name} at ${width}: peak is ${(layout.peakShareOfAxis * 100).toFixed(0)}% of the axis`);
      });
    });
    // One axis for every case: clicking never rescales.
    const a = layoutFutureCostChart(central, { width: 1776 });
    assertEqual(a.axisMax, layoutFutureCostChart(central, { width: 1776 }).axisMax, 'repeatable');
  }));

  cases.push(runCase('Cost blocks are identical across solved cases, and sit under the panel header', () => {
    STRESS_SHAPES.forEach((shape) => {
      const projection = computeFutureCostFundProjection(shape.payload, CALCULATION);
      WIDTHS.forEach((width) => {
        const layout = layoutFutureCostChart(projection, { width });
        const first = projection.debug.cases[0].id;
        // To a micro-pixel: the cases are solved separately, so the same
        // balance agrees to floating-point noise and no further.
        const stable = (blocks) => JSON.stringify(blocks, (key, value) => (
          typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value
        ));
        const reference = stable(layoutCostBlocks(layout, first, projection));
        projection.debug.cases.forEach((entry) => {
          assertEqual(
            stable(layoutCostBlocks(layout, entry.id, projection)),
            reference,
            `${shape.name} at ${width}: blocks for ${entry.id} match`
          );
        });
        const blocks = layoutCostBlocks(layout, first, projection);
        blocks.forEach((block) => {
          assert(block.width >= 1, `${shape.name} at ${width}: a block has width ${block.width}`);
          assert(block.left >= 0 && block.left + block.width <= width + 0.5, `${shape.name} at ${width}: a block leaves the container`);
          assert(block.top >= 0 && block.top + block.height <= layout.plotHeight + 0.5, `${shape.name} at ${width}: a block leaves the plot`);
        });
        // The panel header, when it is inside the panel, must clear the first block.
        const header = placePanelHeader(layout, buildFundCopy(projection, first, { narrow: layout.narrow }));
        if (header.placement === 'inside') {
          const headerBottom = layout.narrow ? 64 : 80;
          assert(blocks[0].top >= headerBottom - 0.5,
            `${shape.name} at ${width}: the first block (top ${blocks[0].top.toFixed(0)}) meets the panel header (bottom ${headerBottom})`);
        }
      });
    });
  }));

  cases.push(runCase('No label overlaps another or the line: every case, every shape, at 358, 720, 1000 and 1776', () => {
    let checked = 0;
    STRESS_SHAPES.forEach((shape) => {
      const projection = computeFutureCostFundProjection(shape.payload, CALCULATION);
      WIDTHS.forEach((width) => {
        const layout = layoutFutureCostChart(projection, { width });
        projection.debug.cases.forEach((entry) => {
          const copy = buildFundCopy(projection, entry.id, { narrow: layout.narrow });
          const values = layout.values[entry.id];
          const labels = placeFundLabels(layout, entry.id, values, copy);
          const problems = checkLabelPlacement(layout, labels, values);
          assert(problems.length === 0, `${shape.name}, ${entry.id}, ${width}px: ${problems.join('; ')}`);
          checked += 1;
        });
      });
    });
    assert(checked >= 100, `a thin check (${checked})`);
  }));

  cases.push(runCase('Half and half keeps the yearly label first and stacks the lump label clear of it', () => {
    WIDTHS.forEach((width) => {
      const layout = layoutFutureCostChart(central, { width });
      const copy = buildFundCopy(central, 'half', { narrow: layout.narrow });
      const labels = placeFundLabels(layout, 'half', layout.values.half, copy);
      assert(labels.yearly && labels.lump, `both labels exist at ${width}`);
      const clear = labels.lump.bottom <= labels.yearly.top
        || labels.lump.top >= labels.yearly.bottom
        || labels.lump.right <= labels.yearly.left
        || labels.lump.left >= labels.yearly.right;
      assert(clear, `the lump label is clear of the yearly label at ${width}`);
    });
  }));

  cases.push(runCase('The fund line has a fixed number of points, from nothing to nothing', () => {
    const layout = layoutFutureCostChart(central, { width: 1776 });
    Object.entries(layout.values).forEach(([id, values]) => {
      assertEqual(values.length, (layout.columns * (SAMPLES_PER_YEAR + 1)) + 1, `${id}: the point count`);
      assertEqual(values[0], 0, `${id}: starts at nothing`);
      assert(values[values.length - 1] < 0.01, `${id}: ends at nothing`);
      assert(values.every((value) => value >= 0), `${id}: never below nothing`);
    });
    for (let i = 1; i < layout.sampleX.length; i += 1) {
      assert(layout.sampleX[i] >= layout.sampleX[i - 1], 'x never runs backwards');
    }
    const from = layout.values.lump;
    const to = layout.values.yearly;
    assertEqual(JSON.stringify(lerpValues(from, to, 0)), JSON.stringify(from), 'progress 0 is where it was');
    assertEqual(JSON.stringify(lerpValues(from, to, 1)), JSON.stringify(to), 'progress 1 is where it goes');
    const { line, area } = buildFundPaths(layout, to);
    assert(line.startsWith('M') && area.endsWith('Z'), 'the paths close');
  }));

  cases.push(runCase('Axis labels thin out with the column width and always name the year the cost starts', () => {
    const steps = {};
    STRESS_SHAPES.forEach((shape) => {
      const projection = computeFutureCostFundProjection(shape.payload, CALCULATION);
      WIDTHS.forEach((width) => {
        const layout = layoutFutureCostChart(projection, { width });
        assert(layout.axisLabels.some((label) => label.year === layout.startYear),
          `${shape.name} at ${width}: the start year is named`);
        assert(layout.axisLabels.length <= layout.columns, `${shape.name} at ${width}: too many labels`);
        const expected = layout.yearWidth >= 56 ? 1 : (layout.yearWidth >= 28 ? 2 : (layout.yearWidth >= 12 ? 5 : 10));
        assertEqual(layout.labelStep, expected, `${shape.name} at ${width}: the label step`);
        steps[`${shape.name} @${width}`] = layout.labelStep;
      });
    });
    assertEqual(steps['the sample @1776'], 1, 'every year on a wide sample');
    assertEqual(steps['the sample @358'], 2, 'every second year on a phone');
    assert(steps['a long run: starts in 40 years and runs for 30 (70 columns) @358'] >= 5, 'thinned in a long run');
  }));

  cases.push(runCase('A one-year cost far away puts the panel header above the chart, not inside a sliver', () => {
    const projection = computeFutureCostFundProjection(caseSet({ startsInYears: 25, durationYears: 1 }), CALCULATION);
    const layout = layoutFutureCostChart(projection, { width: 1776 });
    const header = placePanelHeader(layout, buildFundCopy(projection, 'lump'));
    assertEqual(header.placement, 'above', 'the header is above');
    const sample = layoutFutureCostChart(central, { width: 1776 });
    assertEqual(placePanelHeader(sample, buildFundCopy(central, 'lump')).placement, 'inside', 'inside for the sample');
  }));

  cases.push(runCase('At the design fixture the same layout holds, with the larger growth', () => {
    const fixture = computeFutureCostFundProjection(FUTURE_COST_FUND_SAMPLE, designFixtureOptions());
    assertEqual(buildFundCopy(fixture, 'lump').headline, 'Setting aside €65,800 today covers the whole cost.', 'fixture headline');
    assertEqual(buildFundCopy(fixture, 'yearly').figures.growth, 9_000, 'fixture growth, case 2');
    WIDTHS.forEach((width) => {
      const layout = layoutFutureCostChart(fixture, { width });
      fixture.debug.cases.forEach((entry) => {
        const copy = buildFundCopy(fixture, entry.id, { narrow: layout.narrow });
        const problems = checkLabelPlacement(
          layout,
          placeFundLabels(layout, entry.id, layout.values[entry.id], copy),
          layout.values[entry.id]
        );
        assert(problems.length === 0, `fixture ${entry.id} at ${width}: ${problems.join('; ')}`);
      });
    });
    assertEqual(layoutFutureCostChart(fixture, { width: 1776 }).axisMax, 100_000, 'the fixture axis');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };

  if (failed > 0) {
    console.warn('[FutureCostFundViewTests] Completed with failures', summary);
  } else {
    console.info('[FutureCostFundViewTests] All tests passed', { total: summary.total, passed: summary.passed });
  }

  return summary;
}
