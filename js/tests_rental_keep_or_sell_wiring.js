import {
  applyNormalizedPayloadToModule,
  createBlankModule,
  ensureGenerated,
  normalizePayload
} from './module_pipeline.js';
import { drainSessionImportWarnings, importSession, normalizeGenerated } from './state.js';
import { buildPresentationCatalogue } from './presenter_catalogue.js';
import { RENTAL_KEEP_OR_SELL_SAMPLE } from './tests_rental_keep_or_sell_math.js';
import { FUTURE_COST_FUND_SAMPLE } from './tests_future_cost_fund_math.js';
import { HOUSEHOLD_CASH_FLOW_SAMPLE } from './tests_household_cash_flow_math.js';
import { PROTECTION_GAP_SAMPLE } from './tests_protection_gap_math.js';

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

const SAMPLE = JSON.parse(JSON.stringify(RENTAL_KEEP_OR_SELL_SAMPLE));

const COLLEGE = Object.freeze({
  currentYear: 2026,
  childrenCount: 1,
  childCurrentAge: 10,
  collegeStartAge: 18,
  collegeDurationYears: 4,
  inflationRate: 0.02,
  scenarios: [{ id: 'home', title: 'At home', annualCostTodayPerChild: 5000 }]
});

const FIELD = 'generated.rentalKeepOrSellInputs';

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
    console.info(`[RentalKeepOrSellWiringTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[RentalKeepOrSellWiringTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

function paste(module, generated) {
  applyNormalizedPayloadToModule(module, normalizePayload({ title: 'Test', generated }));
  return module;
}

function refusalOf(patch) {
  try {
    normalizePayload({ generated: { rentalKeepOrSellInputs: { ...SAMPLE, ...patch } } });
  } catch (error) {
    return error.message;
  }
  return '';
}

export function runRentalKeepOrSellWiringTests() {
  const cases = [];

  cases.push(runCase('A pasted payload is accepted, and its tables are derived, never the payload\'s own', () => {
    const module = paste(createBlankModule(), {
      rentalKeepOrSellInputs: SAMPLE,
      outputs: { columns: ['Metric', 'Value'], rows: [['MODEL-SUPPLIED', 999999999]] }
    });
    const { generated } = module;
    assertEqual(generated.rentalKeepOrSellInputs.rentPerYear, 18_000, 'the inputs are held');
    assertEqual(generated.outputs.rows.length, 2, 'one output row per case');
    assert(!JSON.stringify(generated).includes('MODEL-SUPPLIED'), 'a model-supplied figure is gone');
    assertEqual(generated.tables.length, 2, 'one table per case');
    assertEqual(generated.charts.length, 1, 'one chart, for the surfaces that cannot draw the module');
    assert(
      generated.assumptions.rows.some((row) => row[0] === 'Tax' && /not calculated here/.test(row[1])),
      'the assumptions say the tax is not calculated'
    );
    ['collegeFundingInputs', 'futureCostFundInputs', 'householdCashFlowInputs', 'protectionGapInputs',
      'housePurchaseInputs', 'pensionInputs', 'netRetirementInputs', 'mortgageInputs', 'loanInputs',
      'liquidityPlan', 'education', 'report'].forEach((key) => {
      assertEqual(generated[key], null, `${key} is empty`);
    });
  }));

  cases.push(runCase('A figure out of range, a scenarios array, a bad base case or an unknown key is refused with the engine\'s own message', () => {
    assertEqual(
      refusalOf({ rentPerYear: 0 }),
      `${FIELD}.rentPerYear must be a number greater than 0.`,
      'no rent'
    );
    assertEqual(
      refusalOf({ taxOnGain: -1 }),
      `${FIELD}.taxOnGain must be a number greater than or equal to 0.`,
      'negative tax on the gain'
    );
    assertEqual(
      refusalOf({ scenarios: [] }),
      `${FIELD}.scenarios is not an input of this module.`,
      'a scenarios array'
    );
    assertEqual(
      refusalOf({ baseScenarioId: 'hold' }),
      `${FIELD}.baseScenarioId must be "keep" or "sell".`,
      'a bad base case'
    );
    assertEqual(
      refusalOf({ netYield: 0.03 }),
      `${FIELD}.netYield is not an input of this module.`,
      'an unknown key'
    );
  }));

  cases.push(runCase('Cent inputs are accepted, and what is derived adds down to the result shown', () => {
    const module = paste(createBlankModule(), {
      rentalKeepOrSellInputs: {
        ...SAMPLE,
        rentPerYear: 100.4,
        loanRepaymentsPerYear: 33.4,
        runningCostsPerYear: 33.4,
        taxOnRentalProfitPerYear: 33.4
      }
    });
    const [keep] = module.generated.outputs.rows;
    assertEqual(JSON.stringify(keep), JSON.stringify(['Keep', 100, 33, 33, 33, 1]), 'the outputs row adds down');
    const table = module.generated.tables[0].rows.map((row) => row[1]);
    assertEqual(JSON.stringify(table), JSON.stringify([100, -33, -33, -33, 1]), 'and so does the table');
    assertEqual(
      JSON.stringify(module.generated.charts[0].datasets[0].data),
      JSON.stringify([100, -33, -33, -33, 1]),
      'and the chart'
    );
  }));

  cases.push(runCase('A refused paste leaves the module as it was', () => {
    const module = paste(createBlankModule(), { collegeFundingInputs: COLLEGE });
    let refused = false;
    try {
      paste(module, { rentalKeepOrSellInputs: { ...SAMPLE, salePrice: 0 } });
    } catch (_error) {
      refused = true;
    }
    assert(refused, 'refused');
    assert(module.generated.collegeFundingInputs, 'college is still set');
    assertEqual(module.generated.rentalKeepOrSellInputs, null, 'and nothing half applied');
  }));

  cases.push(runCase('Setting it clears the other engine modules, and setting one of them clears it', () => {
    const module = createBlankModule();
    paste(module, { collegeFundingInputs: COLLEGE });
    assert(module.generated.collegeFundingInputs, 'college is set');

    paste(module, { rentalKeepOrSellInputs: SAMPLE });
    assertEqual(module.generated.collegeFundingInputs, null, 'college is cleared by the rental');
    assert(module.generated.rentalKeepOrSellInputs, 'the rental is set');

    paste(module, { collegeFundingInputs: COLLEGE });
    assertEqual(module.generated.rentalKeepOrSellInputs, null, 'the rental is cleared by college');
    assert(module.generated.collegeFundingInputs, 'college is set again');

    // The three engine modules that landed before it.
    [
      ['futureCostFundInputs', FUTURE_COST_FUND_SAMPLE],
      ['householdCashFlowInputs', HOUSEHOLD_CASH_FLOW_SAMPLE],
      ['protectionGapInputs', PROTECTION_GAP_SAMPLE]
    ].forEach(([key, sample]) => {
      paste(module, { rentalKeepOrSellInputs: SAMPLE });
      assert(module.generated.rentalKeepOrSellInputs, `the rental is set before ${key}`);

      paste(module, { [key]: JSON.parse(JSON.stringify(sample)) });
      assertEqual(module.generated.rentalKeepOrSellInputs, null, `the rental is cleared by ${key}`);
      assert(module.generated[key], `${key} is set`);

      paste(module, { rentalKeepOrSellInputs: SAMPLE });
      assertEqual(module.generated[key], null, `${key} is cleared by the rental`);
      assert(module.generated.rentalKeepOrSellInputs, 'the rental is set again');
    });
  }));

  cases.push(runCase('Loading a module refreshes its derived tables', () => {
    const module = createBlankModule();
    module.generated.rentalKeepOrSellInputs = JSON.parse(JSON.stringify(SAMPLE));
    module.generated.outputs = { columns: ['Case'], rows: [['STALE', 1]] };
    module.generated.assumptions = { columns: ['Assumption'], rows: [['STALE']] };
    ensureGenerated(module);
    assert(!JSON.stringify(module.generated.outputs).includes('STALE'), 'outputs were refreshed');
    assert(!JSON.stringify(module.generated.assumptions).includes('STALE'), 'assumptions were refreshed');
    assertEqual(module.generated.outputs.rows.length, 2, 'one output row per case');
  }));

  cases.push(runCase('A session import drops a payload the engine will not read, and says why', () => {
    drainSessionImportWarnings();
    const withScenarios = normalizeGenerated({ rentalKeepOrSellInputs: { ...SAMPLE, scenarios: [{ id: 'keep' }] } });
    assertEqual(withScenarios.rentalKeepOrSellInputs, null, 'a scenarios array leaves the module without inputs');
    assert(
      drainSessionImportWarnings().some((text) => /rentalKeepOrSellInputs could not be read and was left out/.test(text)
        && /scenarios is not an input of this module/.test(text)),
      'and says why'
    );
    assertEqual(withScenarios.outputs.rows.length, 0, 'nothing derived from nothing');

    const negative = normalizeGenerated({ rentalKeepOrSellInputs: { ...SAMPLE, sellingCosts: -5 } });
    assertEqual(negative.rentalKeepOrSellInputs, null, 'a negative figure is dropped, not drawn');
    assert(drainSessionImportWarnings().length === 1, 'with its reason');

    const text = normalizeGenerated({ rentalKeepOrSellInputs: 'not an object' });
    assertEqual(text.rentalKeepOrSellInputs, null, 'a value that is not an object is dropped quietly');
  }));

  cases.push(runCase('A saved session normalises to the same inputs again', () => {
    const once = normalizeGenerated({ rentalKeepOrSellInputs: SAMPLE });
    const twice = normalizeGenerated(JSON.parse(JSON.stringify(once)));
    assertEqual(
      JSON.stringify(twice.rentalKeepOrSellInputs),
      JSON.stringify(once.rentalKeepOrSellInputs),
      'normalising a normalised session'
    );
    assertEqual(JSON.stringify(twice.outputs), JSON.stringify(once.outputs), 'and its derived outputs');
    assertEqual(once.outputs.rows.length, 2, 'derived from its own projection');
  }));

  cases.push(runCase('The selected case is remembered on the module\'s ui across a saved session', () => {
    const imported = importSession({
      version: 1,
      sessionId: 'session-test',
      clientName: 'Client',
      order: ['rental-1'],
      activeModuleId: 'rental-1',
      modules: [{
        id: 'rental-1',
        title: 'Rental keep or sell',
        generated: { rentalKeepOrSellInputs: SAMPLE },
        ui: { rentalKeepOrSellScenarioId: ' sell ' }
      }]
    });
    assertEqual(imported.modules[0].ui.rentalKeepOrSellScenarioId, 'sell', 'trimmed and kept');
    assert(imported.modules[0].generated.rentalKeepOrSellInputs, 'with its inputs');

    const numeric = importSession({
      version: 1,
      sessionId: 'session-test',
      clientName: 'Client',
      order: ['rental-1'],
      modules: [{ id: 'rental-1', title: 'Rental', generated: { rentalKeepOrSellInputs: SAMPLE }, ui: { rentalKeepOrSellScenarioId: 7 } }]
    });
    assertEqual(numeric.modules[0].ui.rentalKeepOrSellScenarioId, '', 'a number is not a case');
  }));

  cases.push(runCase('The presenter catalogue lists the module, its two cases and its default case', () => {
    const generated = normalizeGenerated({ rentalKeepOrSellInputs: { ...SAMPLE, baseScenarioId: 'sell' } });
    const catalogue = buildPresentationCatalogue({
      modules: [{ id: 'rental-1', title: 'Rental keep or sell', generated, ui: {} }]
    });
    assertEqual(catalogue.errors.length, 0, `no catalogue errors (${catalogue.errors.join('; ')})`);
    const entry = catalogue.modules[0];
    assertEqual(entry.kind, 'rental-keep-or-sell', 'the kind');
    assertEqual(entry.defaultScenarioId, 'sell', 'the default case is the payload\'s base case');
    assertEqual(entry.scenarios.map((scenario) => scenario.id).join(','), 'keep,sell', 'the case ids, in order');
    assertEqual(entry.scenarios.map((scenario) => scenario.label).join(','), 'Keep,Sell', 'the case titles');
    assert(entry.capabilities.scenarioSelection === true, 'case selection is offered');

    const withoutBase = buildPresentationCatalogue({
      modules: [{ id: 'rental-2', title: 'Rental keep or sell', generated: normalizeGenerated({ rentalKeepOrSellInputs: SAMPLE }), ui: {} }]
    });
    assertEqual(withoutBase.modules[0].defaultScenarioId, 'keep', 'a payload with no base case opens on Keep');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };
  if (failed > 0) {
    console.warn('[RentalKeepOrSellWiringTests] Completed with failures', summary);
  } else {
    console.info('[RentalKeepOrSellWiringTests] All tests passed', { total: summary.total, passed: summary.passed });
  }
  return summary;
}
