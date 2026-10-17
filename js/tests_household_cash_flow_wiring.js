import {
  applyNormalizedPayloadToModule,
  createBlankModule,
  ensureGenerated,
  normalizePayload
} from './module_pipeline.js';
import { drainSessionImportWarnings, normalizeGenerated } from './state.js';
import { buildPresentationCatalogue } from './presenter_catalogue.js';
import {
  HOUSEHOLD_CASH_FLOW_PENSION_SHORT_SAMPLE,
  HOUSEHOLD_CASH_FLOW_SAMPLE,
  HOUSEHOLD_CASH_FLOW_SHORT_SAMPLE
} from './tests_household_cash_flow_math.js';

/**
 * THE MODULE, WIRED INTO THE APP, WITHOUT THE APP.
 *
 * The paste pipeline, the session importer and the presenter catalogue are all
 * plain JavaScript with no DOM, so what a pasted payload does to a module can
 * be proved here. The browser runs the same files, which is the point: a
 * payload this accepts cannot be refused in the Dev Panel.
 *
 * The video scene and the codex brief are proved where their other modules are,
 * in check-video-scene.mjs and check-codex-video-brief.mjs.
 */

const SAMPLE = JSON.parse(JSON.stringify(HOUSEHOLD_CASH_FLOW_SAMPLE));

const COLLEGE = Object.freeze({
  currentYear: 2026,
  childrenCount: 1,
  childCurrentAge: 10,
  collegeStartAge: 18,
  collegeDurationYears: 4,
  inflationRate: 0.02,
  scenarios: [{ id: 'home', title: 'At home', annualCostTodayPerChild: 5000 }]
});

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
    console.info(`[HouseholdCashFlowWiringTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[HouseholdCashFlowWiringTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

function paste(module, generated) {
  applyNormalizedPayloadToModule(module, normalizePayload({ title: 'Test', generated }));
  return module;
}

function refusalOf(patch) {
  try {
    normalizePayload({ generated: { householdCashFlowInputs: { ...SAMPLE, ...patch } } });
  } catch (error) {
    return error.message;
  }
  return '';
}

export function runHouseholdCashFlowWiringTests() {
  const cases = [];
  cases.push(runCase('Current pension deductions survive paste and import without reducing bank pay twice', () => {
    const raw = JSON.parse(JSON.stringify(SAMPLE));
    raw.people[0].personalPensionContribution = 5000;
    raw.people[0].statedTakeHome = 50000;
    const module = paste(createBlankModule(), { householdCashFlowInputs: raw });
    const imported = normalizeGenerated(JSON.parse(JSON.stringify(module.generated)));
    assertEqual(imported.householdCashFlowInputs.people[0].personalPensionContribution, 5000, 'saved contribution');
    assertEqual(JSON.stringify(imported.outputs), JSON.stringify(module.generated.outputs), 'derived figures survive reopening');
    ensureGenerated(module);
    assertEqual(JSON.stringify(imported.tables), JSON.stringify(module.generated.tables), 'refresh and import agree');
  }));


  cases.push(runCase('A pasted payload is accepted, and its tables are derived, never the payload\'s own', () => {
    const module = paste(createBlankModule(), {
      householdCashFlowInputs: SAMPLE,
      outputs: { columns: ['Metric', 'Value'], rows: [['MODEL-SUPPLIED', 999999999]] }
    });
    const { generated } = module;
    assertEqual(generated.householdCashFlowInputs.people.length, 2, 'the inputs are held');
    assertEqual(generated.outputs.rows.length, 4, 'one output row per case');
    assert(!JSON.stringify(generated).includes('MODEL-SUPPLIED'), 'a model-supplied figure is gone');
    assertEqual(generated.tables.length, 4, 'one table per case');
    assertEqual(generated.charts.length, 1, 'one chart, for the surfaces that cannot draw the module');
    assert(
      generated.assumptions.rows.some((row) => row[0] === 'Where your tax comes from'),
      'the assumptions say which tax was used'
    );
    ['collegeFundingInputs', 'futureCostFundInputs', 'housePurchaseInputs', 'pensionInputs',
      'netRetirementInputs', 'mortgageInputs', 'loanInputs', 'liquidityPlan', 'education', 'report'].forEach((key) => {
      assertEqual(generated[key], null, `${key} is empty`);
    });
  }));

  cases.push(runCase('A stated tax line, a typed left over or a fifth case is refused with the engine\'s own message', () => {
    assertEqual(
      refusalOf({ outgoings: [...SAMPLE.outgoings, { id: 'tax', label: 'Tax', amount: 48_000 }] }),
      'generated.householdCashFlowInputs.outgoings[5] (Tax): tax is calculated from income by the Irish tax engine and '
        + "cannot be stated as a cost. Give a person's take-home in people[].statedTakeHome instead.",
      'a stated tax line'
    );
    assertEqual(
      refusalOf({ leftOver: 6_000 }),
      'generated.householdCashFlowInputs.leftOver is not accepted. It is calculated.',
      'a typed left over'
    );
    assertEqual(
      refusalOf({ scenarios: [...SAMPLE.scenarios, { id: 'fifth' }] }),
      'generated.householdCashFlowInputs.scenarios supports at most 4 cases; received 5.',
      'a fifth case'
    );
  }));

  cases.push(runCase('A case that leaves less than nothing is accepted by the paste, and derived tables carry it with its sign', () => {
    // A short household is an ordinary year, so nothing refuses it any more.
    const short = refusalOf({ outgoings: SAMPLE.outgoings.map((line) => (line.id === 'living' ? { ...line, amount: 80_000 } : line)) });
    assertEqual(short, '', 'a short case is not refused');

    const module = paste(createBlankModule(), { householdCashFlowInputs: HOUSEHOLD_CASH_FLOW_SHORT_SAMPLE });
    const { generated } = module;
    assertEqual(generated.householdCashFlowInputs.people.length, 2, 'the inputs are held');
    assertEqual(generated.outputs.rows.length, 4, 'one output row per case');
    const today = generated.outputs.rows[0];
    assert(today[4] < 0, 'today leaves less than nothing, and the ledger says so with a sign');
    assert(/^About −€\d+ a month$|^−€\d+ a month$/.test(today[5]), `and so does its month: ${today[5]}`);
    assert(generated.outputs.rows[1][4] > 0, 'clearing the car loan is left over');
    const chart = generated.charts[0];
    assertEqual(chart.labels[chart.labels.length - 1], 'Short', 'the chart for other surfaces says Short');
    assert(chart.datasets[0].data[chart.datasets[0].data.length - 1] > 0, 'with the size');
  }));

  cases.push(runCase('A refused paste leaves the module as it was', () => {
    const module = paste(createBlankModule(), { collegeFundingInputs: COLLEGE });
    let refused = false;
    try {
      paste(module, {
        householdCashFlowInputs: {
          ...SAMPLE,
          outgoings: [...SAMPLE.outgoings, { id: 'tax', label: 'Tax', amount: 48_000 }]
        }
      });
    } catch (_error) {
      refused = true;
    }
    assert(refused, 'refused');
    assert(module.generated.collegeFundingInputs, 'college is still set');
    assertEqual(module.generated.householdCashFlowInputs, null, 'and nothing half applied');
  }));

  cases.push(runCase('Setting it clears the other engine modules, and setting one of them clears it', () => {
    const module = createBlankModule();
    paste(module, { collegeFundingInputs: COLLEGE });
    assert(module.generated.collegeFundingInputs, 'college is set');

    paste(module, { householdCashFlowInputs: SAMPLE });
    assertEqual(module.generated.collegeFundingInputs, null, 'college is cleared by the cash flow');
    assert(module.generated.householdCashFlowInputs, 'the cash flow is set');

    paste(module, { collegeFundingInputs: COLLEGE });
    assertEqual(module.generated.householdCashFlowInputs, null, 'the cash flow is cleared by college');
    assert(module.generated.collegeFundingInputs, 'college is set again');

    // And the future cost fund, the one it shares a lane with.
    paste(module, { householdCashFlowInputs: SAMPLE });
    paste(module, {
      futureCostFundInputs: {
        costTitle: 'College',
        costKind: 'education',
        startsInYears: 8,
        durationYears: 4,
        annualCostToday: 15_000,
        scenarios: [{ id: 'lump', lumpShare: 1 }]
      }
    });
    assertEqual(module.generated.householdCashFlowInputs, null, 'the cash flow is cleared by the fund');
    assert(module.generated.futureCostFundInputs, 'the fund is set');
  }));

  cases.push(runCase('Loading a module refreshes its derived tables, so a change in the tax rules shows', () => {
    const module = createBlankModule();
    module.generated.householdCashFlowInputs = JSON.parse(JSON.stringify(SAMPLE));
    module.generated.outputs = { columns: ['Case'], rows: [['STALE', 1]] };
    module.generated.assumptions = { columns: ['Assumption'], rows: [['STALE']] };
    ensureGenerated(module);
    assert(!JSON.stringify(module.generated.outputs).includes('STALE'), 'outputs were refreshed');
    assert(!JSON.stringify(module.generated.assumptions).includes('STALE'), 'assumptions were refreshed');
    assertEqual(module.generated.outputs.rows.length, 4, 'one output row per case');
  }));

  cases.push(runCase('A session import tolerates too many cases, and drops a payload the engine will not read', () => {
    drainSessionImportWarnings();
    const tooMany = normalizeGenerated({
      householdCashFlowInputs: { ...SAMPLE, scenarios: [...SAMPLE.scenarios, { id: 'fifth' }] }
    });
    assertEqual(tooMany.householdCashFlowInputs.scenarios.length, 4, 'cut to four');
    const warnings = drainSessionImportWarnings();
    assert(warnings.some((text) => /carried 5 cases; kept the first 4/.test(text)), 'the cut was recorded');

    const withTax = normalizeGenerated({
      householdCashFlowInputs: { ...SAMPLE, outgoings: [...SAMPLE.outgoings, { id: 'tax', label: 'Tax', amount: 1 }] }
    });
    assertEqual(withTax.householdCashFlowInputs, null, 'a stated tax line leaves the module without inputs');
    assert(drainSessionImportWarnings().some((text) => /tax is calculated from income/.test(text)), 'and says why');
    assertEqual(withTax.outputs.rows.length, 0, 'nothing derived from nothing');

    // A short case is an ordinary year now: it is kept, and nothing warns.
    drainSessionImportWarnings();
    const short = normalizeGenerated({
      householdCashFlowInputs: {
        ...SAMPLE,
        outgoings: SAMPLE.outgoings.map((line) => (line.id === 'living' ? { ...line, amount: 80_000 } : line))
      }
    });
    assert(short.householdCashFlowInputs, 'a short case is kept, not dropped');
    assert(short.outputs.rows.length === 4, 'and its tables are derived');
    assertEqual(drainSessionImportWarnings().length, 0, 'with nothing to warn about');
  }));

  cases.push(runCase('A saved short session normalises to the same inputs again, and the presenter lists its cases', () => {
    [HOUSEHOLD_CASH_FLOW_SHORT_SAMPLE, HOUSEHOLD_CASH_FLOW_PENSION_SHORT_SAMPLE].forEach((raw, index) => {
      const once = normalizeGenerated({ householdCashFlowInputs: raw });
      const twice = normalizeGenerated(JSON.parse(JSON.stringify(once)));
      assertEqual(
        JSON.stringify(twice.householdCashFlowInputs),
        JSON.stringify(once.householdCashFlowInputs),
        `sample ${index + 1}: normalising a normalised session`
      );
      assertEqual(JSON.stringify(twice.outputs), JSON.stringify(once.outputs), `sample ${index + 1}: and its derived outputs`);
    });
    const generated = normalizeGenerated({ householdCashFlowInputs: HOUSEHOLD_CASH_FLOW_SHORT_SAMPLE });
    const catalogue = buildPresentationCatalogue({
      modules: [{ id: 'cash-1', title: 'Household cash flow', generated, ui: {} }]
    });
    assertEqual(catalogue.errors.length, 0, `no catalogue errors (${catalogue.errors.join('; ')})`);
    assertEqual(
      catalogue.modules[0].scenarios.map((scenario) => scenario.id).join(','),
      'today,clear-car,pension,both',
      'a short household still lists its cases'
    );
  }));

  cases.push(runCase('An import that cannot be read takes its stored figures with it', () => {
    const stored = {
      summaryHtml: '<p>Kept.</p>',
      assumptions: { columns: ['Assumption', 'Value'], rows: [['MODEL-SUPPLIED', 1]] },
      outputs: { columns: ['Metric', 'Value'], rows: [['MODEL-SUPPLIED', 999999999]] },
      tables: [{ title: 'Stale', columns: ['A', 'B'], rows: [['MODEL-SUPPLIED', 1]] }],
      charts: [{ title: 'Stale', type: 'bar', labels: ['A'], datasets: [{ label: 'A', data: [1] }] }]
    };
    [
      ['a calculated field', { ...SAMPLE, leftOver: 1 }],
      ['a stated tax line', { ...SAMPLE, outgoings: [...SAMPLE.outgoings, { id: 'tax', label: 'Tax', amount: 1 }] }],
      ['a label that recommends', { ...SAMPLE, outgoings: [{ id: 'mortgage', label: 'Best mortgage', amount: 30_000 }] }],
      ['not an object', 'not an object']
    ].forEach(([name, inputs]) => {
      drainSessionImportWarnings();
      const generated = normalizeGenerated({ ...stored, householdCashFlowInputs: inputs });
      assertEqual(generated.householdCashFlowInputs, null, `${name}: left out`);
      assert(
        drainSessionImportWarnings().some((text) => text.startsWith('householdCashFlowInputs could not be read')),
        `${name}: and says why`
      );
      assertEqual(generated.outputs.rows.length, 0, `${name}: no stored outputs`);
      assertEqual(generated.assumptions.rows.length, 0, `${name}: no stored assumptions`);
      assertEqual(generated.tables.length, 0, `${name}: no stored tables`);
      assertEqual(generated.charts.length, 0, `${name}: no stored charts`);
      assertEqual(generated.summaryHtml, '<p>Kept.</p>', `${name}: the written summary is the module's own and stays`);
    });
  }));

  cases.push(runCase('Cutting an import to four cases keeps its base among them', () => {
    drainSessionImportWarnings();
    const fifth = { ...SAMPLE, scenarios: [...SAMPLE.scenarios, { id: 'fifth' }], baseScenarioId: 'fifth' };
    const kept = normalizeGenerated({ householdCashFlowInputs: fifth }).householdCashFlowInputs;
    assert(kept, 'it survives the cut');
    assertEqual(kept.scenarios.length, 4, 'cut to four');
    assertEqual(kept.baseScenarioId, 'fifth', 'the named base is kept');
    assertEqual(kept.scenarios[3].id, 'fifth', 'in place of the last case kept');
    assert(
      drainSessionImportWarnings().some((text) => /baseScenarioId "fifth" was beyond the first 4 cases/.test(text)),
      'and the kept base is recorded'
    );
  }));

  cases.push(runCase('A saved session normalises to the same inputs again', () => {
    const once = normalizeGenerated({ householdCashFlowInputs: SAMPLE });
    const twice = normalizeGenerated(JSON.parse(JSON.stringify(once)));
    assertEqual(
      JSON.stringify(twice.householdCashFlowInputs),
      JSON.stringify(once.householdCashFlowInputs),
      'normalising a normalised session'
    );
    assertEqual(JSON.stringify(twice.outputs), JSON.stringify(once.outputs), 'and its derived outputs');
  }));

  cases.push(runCase('The presenter catalogue lists the module, its cases and its default case', () => {
    const generated = normalizeGenerated({ householdCashFlowInputs: { ...SAMPLE, baseScenarioId: 'today' } });
    const catalogue = buildPresentationCatalogue({
      modules: [{ id: 'cash-1', title: 'Household cash flow', generated, ui: {} }]
    });
    assertEqual(catalogue.errors.length, 0, `no catalogue errors (${catalogue.errors.join('; ')})`);
    const entry = catalogue.modules[0];
    assertEqual(entry.kind, 'household-cash-flow', 'the kind');
    assertEqual(entry.defaultScenarioId, 'today', 'the default case is the payload\'s base case');
    assertEqual(
      entry.scenarios.map((scenario) => scenario.id).join(','),
      'today,clear-car,pension,both',
      'the case ids, in order'
    );
    assert(entry.capabilities.scenarioSelection === true, 'case selection is offered');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };
  if (failed > 0) {
    console.warn('[HouseholdCashFlowWiringTests] Completed with failures', summary);
  } else {
    console.info('[HouseholdCashFlowWiringTests] All tests passed', { total: summary.total, passed: summary.passed });
  }
  return summary;
}
