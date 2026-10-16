import {
  applyNormalizedPayloadToModule,
  createBlankModule,
  ensureGenerated,
  normalizePayload
} from './module_pipeline.js';
import { drainSessionImportWarnings, importSession, normalizeGenerated } from './state.js';
import { buildPresentationCatalogue } from './presenter_catalogue.js';
import { HOME_TRADE_DOWN_SAMPLE } from './tests_home_trade_down_math.js';
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

const SAMPLE = JSON.parse(JSON.stringify(HOME_TRADE_DOWN_SAMPLE));

const COLLEGE = Object.freeze({
  currentYear: 2026,
  childrenCount: 1,
  childCurrentAge: 10,
  collegeStartAge: 18,
  collegeDurationYears: 4,
  inflationRate: 0.02,
  scenarios: [{ id: 'home', title: 'At home', annualCostTodayPerChild: 5000 }]
});

const FIELD = 'generated.homeTradeDownInputs';

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
    console.info(`[HomeTradeDownWiringTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[HomeTradeDownWiringTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

function paste(module, generated) {
  applyNormalizedPayloadToModule(module, normalizePayload({ title: 'Test', generated }));
  return module;
}

function refusalOf(patch) {
  try {
    normalizePayload({ generated: { homeTradeDownInputs: { ...SAMPLE, ...patch } } });
  } catch (error) {
    return error.message;
  }
  return '';
}

/** Five cases, so one more than the cap, with the fifth the payload's base. */
function fiveCases(patch = {}) {
  return {
    ...SAMPLE,
    baseScenarioId: 'fifth',
    scenarios: [
      { id: 'stay', kind: 'stay' },
      { id: 'a', kind: 'move', annualRepayment: 6_000 },
      { id: 'b', kind: 'move', annualRepayment: 12_000 },
      { id: 'c', kind: 'move', annualRepayment: 18_000 },
      { id: 'fifth', kind: 'move', annualRepayment: 24_000 }
    ],
    ...patch
  };
}

export function runHomeTradeDownWiringTests() {
  const cases = [];

  cases.push(runCase('A pasted payload is accepted, its tables are derived, and its AI-written summary stays', () => {
    const module = paste(createBlankModule(), {
      summaryHtml: '<p>This shows what a yearly repayment you set would buy.</p>',
      homeTradeDownInputs: SAMPLE,
      outputs: { columns: ['Metric', 'Value'], rows: [['MODEL-SUPPLIED', 999999999]] }
    });
    const { generated } = module;
    assertEqual(generated.homeTradeDownInputs.homeValue, 650_000, 'the inputs are held');
    assertEqual(generated.outputs.rows.length, 4, 'one output row per case');
    assert(!JSON.stringify(generated).includes('MODEL-SUPPLIED'), 'a model-supplied figure is gone');
    assertEqual(generated.tables.length, 4, 'one table per case');
    assertEqual(generated.charts.length, 1, 'one chart, for the surfaces that cannot draw the module');
    assert(
      generated.assumptions.rows.some((row) => row[0] === 'Payments' && /compounded monthly/.test(row[1])),
      'the assumptions name the payment convention'
    );
    // Unlike the protection gap, the words are the AI's, under the usual rules.
    assertEqual(
      generated.summaryHtml,
      '<p>This shows what a yearly repayment you set would buy.</p>',
      'the summary the payload gave is kept'
    );
    ['collegeFundingInputs', 'futureCostFundInputs', 'householdCashFlowInputs', 'protectionGapInputs',
      'rentalKeepOrSellInputs', 'housePurchaseInputs', 'pensionInputs', 'netRetirementInputs',
      'mortgageInputs', 'loanInputs', 'liquidityPlan', 'education', 'report'].forEach((key) => {
      assertEqual(generated[key], null, `${key} is empty`);
    });
  }));

  cases.push(runCase('A budget above the home, a fifth case, a missing term, banned wording or an unknown key is refused with the engine\'s own message', () => {
    assertEqual(
      refusalOf({
        scenarios: [{ id: 'stay', kind: 'stay' }, { id: 'big', kind: 'move', annualRepayment: 30_000, title: 'All of it' }],
        newLoanTermYears: 40,
        newLoanAnnualRate: 0
      }),
      `${FIELD}.scenarios[1] (All of it): the home budget is more than the current home. This module shows trading down.`,
      'a budget above the home'
    );
    assertEqual(
      refusalOf({ scenarios: [...SAMPLE.scenarios, { id: 'fifth', kind: 'move', annualRepayment: 1 }] }),
      `${FIELD}.scenarios supports at most 4 cases; received 5.`,
      'a fifth case'
    );
    assertEqual(
      refusalOf({ newLoanTermYears: undefined }),
      `${FIELD}.newLoanTermYears must be a whole number of years from 1 to 40.`,
      'a missing term'
    );
    assertEqual(
      refusalOf({ newLoanAnnualRate: undefined }),
      `${FIELD}.newLoanAnnualRate must be a number from 0 to 0.15.`,
      'a missing rate'
    );
    assertEqual(
      refusalOf({ homeTradeDownEstimate: 1 }),
      `${FIELD}.homeTradeDownEstimate is not an input of this module.`,
      'an unknown key'
    );
    assertEqual(
      refusalOf({ scenarios: [{ id: 'stay', kind: 'stay', title: 'What we can afford' }] }),
      `${FIELD}.scenarios[0].title ("What we can afford"): this screen shows what a repayment buys, `
        + 'never a recommendation, and speaks to you, never as "we", "us" or "our".',
      'a title that says "we"'
    );
    assertEqual(
      refusalOf({
        scenarios: [{ id: 'stay', kind: 'stay' }, { id: 'a', kind: 'move', annualRepayment: 12_000, description: 'The best option for you.' }]
      }),
      `${FIELD}.scenarios[1].description ("The best option for you."): this screen shows what a repayment buys, `
        + 'never a recommendation, and speaks to you, never as "we", "us" or "our".',
      'a description that recommends'
    );
  }));

  cases.push(runCase('Cent inputs are accepted, and what is derived adds down as shown', () => {
    const module = paste(createBlankModule(), {
      homeTradeDownInputs: {
        ...SAMPLE,
        homeValue: 400_000.6,
        mortgageBalance: 150_000.3,
        currentAnnualRepayments: 18_000.6,
        sellingCosts: 8_000.4,
        buyingCosts: 6_000.4,
        scenarios: [
          { id: 'stay', kind: 'stay' },
          { id: 'less', kind: 'move', annualRepayment: 6_000.4 }
        ]
      }
    });
    const { outputs } = module.generated;
    // [case, repaid a year, freed a year, new loan, home budget]
    assertEqual(outputs.rows[0][1] + outputs.rows[0][2], 18_001, 'staying: repaid and freed are today as shown');
    assertEqual(outputs.rows[1][1], 6_000, 'moving: repaid as shown');
    assertEqual(outputs.rows[1][2], 12_001, 'and freed is 18,001 less 6,000, not 12,000.20 rounded');
    assertEqual(outputs.rows[1][1] + outputs.rows[1][2], 18_001, 'so the two add to today');
    const table = module.generated.tables[1].rows.map((row) => row[1]);
    assertEqual(table[0] + table[1], table[2], 'the blocks add to the budget in the table');
    assertEqual(
      JSON.stringify(module.generated.tables[0].rows.map((row) => row[1])),
      JSON.stringify([250_001, 150_000, 400_001]),
      'and staying adds to the home as shown'
    );
  }));

  cases.push(runCase('A refused paste leaves the module as it was', () => {
    const module = paste(createBlankModule(), { collegeFundingInputs: COLLEGE });
    let refused = false;
    try {
      paste(module, { homeTradeDownInputs: { ...SAMPLE, homeValue: 0 } });
    } catch (_error) {
      refused = true;
    }
    assert(refused, 'refused');
    assert(module.generated.collegeFundingInputs, 'college is still set');
    assertEqual(module.generated.homeTradeDownInputs, null, 'and nothing half applied');
  }));

  cases.push(runCase('Setting it clears the other engine modules, and setting one of them clears it', () => {
    const module = createBlankModule();
    paste(module, { collegeFundingInputs: COLLEGE });
    assert(module.generated.collegeFundingInputs, 'college is set');

    paste(module, { homeTradeDownInputs: SAMPLE });
    assertEqual(module.generated.collegeFundingInputs, null, 'college is cleared by the home');
    assert(module.generated.homeTradeDownInputs, 'the home is set');

    paste(module, { collegeFundingInputs: COLLEGE });
    assertEqual(module.generated.homeTradeDownInputs, null, 'the home is cleared by college');
    assert(module.generated.collegeFundingInputs, 'college is set again');

    // Every engine module that landed before it, the rental included.
    [
      ['futureCostFundInputs', FUTURE_COST_FUND_SAMPLE],
      ['householdCashFlowInputs', HOUSEHOLD_CASH_FLOW_SAMPLE],
      ['protectionGapInputs', PROTECTION_GAP_SAMPLE],
      ['rentalKeepOrSellInputs', RENTAL_KEEP_OR_SELL_SAMPLE]
    ].forEach(([key, sample]) => {
      paste(module, { homeTradeDownInputs: SAMPLE });
      assert(module.generated.homeTradeDownInputs, `the home is set before ${key}`);

      paste(module, { [key]: JSON.parse(JSON.stringify(sample)) });
      assertEqual(module.generated.homeTradeDownInputs, null, `the home is cleared by ${key}`);
      assert(module.generated[key], `${key} is set`);

      paste(module, { homeTradeDownInputs: SAMPLE });
      assertEqual(module.generated[key], null, `${key} is cleared by the home`);
      assert(module.generated.homeTradeDownInputs, 'the home is set again');
    });
  }));

  cases.push(runCase('Loading a module refreshes its derived tables', () => {
    const module = createBlankModule();
    module.generated.homeTradeDownInputs = JSON.parse(JSON.stringify(SAMPLE));
    module.generated.outputs = { columns: ['Case'], rows: [['STALE', 1]] };
    module.generated.assumptions = { columns: ['Assumption'], rows: [['STALE']] };
    ensureGenerated(module);
    assert(!JSON.stringify(module.generated.outputs).includes('STALE'), 'outputs were refreshed');
    assert(!JSON.stringify(module.generated.assumptions).includes('STALE'), 'assumptions were refreshed');
    assertEqual(module.generated.outputs.rows.length, 4, 'one output row per case');
  }));

  cases.push(runCase('A session import cuts too many cases, and keeps the base case among those kept', () => {
    drainSessionImportWarnings();
    const cut = normalizeGenerated({ homeTradeDownInputs: fiveCases() });
    assert(cut.homeTradeDownInputs, 'the module is read, not dropped');
    assertEqual(cut.homeTradeDownInputs.scenarios.length, 4, 'cut to four');
    const warnings = drainSessionImportWarnings();
    assert(warnings.some((text) => /carried 5 cases; kept the first 4/.test(text)), 'the cut was recorded');

    // The base case was the fifth. Cutting it would make the engine refuse the
    // whole module, so it takes the place of the last case kept.
    assertEqual(cut.homeTradeDownInputs.baseScenarioId, 'fifth', 'the base case is still the base case');
    assertEqual(
      cut.homeTradeDownInputs.scenarios.map((entry) => entry.id).join(','),
      'stay,a,b,fifth',
      'and sits in the place of the last case kept'
    );
    assert(warnings.some((text) => /baseScenarioId "fifth" was beyond the first 4 cases/.test(text)), 'which is recorded');
    assertEqual(cut.outputs.rows.length, 4, 'and the tables are derived from what was kept');
  }));

  cases.push(runCase('A session import drops a payload the engine will not read, and clears the figures stored beside it', () => {
    drainSessionImportWarnings();
    const staleStored = {
      assumptions: { columns: ['Assumption', 'Input Used'], rows: [['STALE', 'STALE']] },
      outputs: { columns: ['Case', 'Value'], rows: [['STALE', 1]] },
      tables: [{ title: 'STALE', columns: ['Line', 'Amount'], rows: [['STALE', 1]] }],
      charts: [{ title: 'STALE', type: 'bar', labels: ['STALE'], datasets: [{ label: 'STALE', data: [1] }] }]
    };

    [
      ['banned wording in a title', { ...SAMPLE, scenarios: [{ id: 'stay', kind: 'stay', title: 'Our best option' }] }, /this screen shows what a repayment buys/],
      ['a budget above the home', { ...SAMPLE, newLoanAnnualRate: 0, newLoanTermYears: 40, scenarios: [{ id: 'stay', kind: 'stay' }, { id: 'big', kind: 'move', annualRepayment: 30_000 }] }, /more than the current home/],
      ['an unknown key', { ...SAMPLE, estimatedRate: 0.04 }, /is not an input of this module/],
      ['a value that is not an object', 'not an object', /must be an object/]
    ].forEach(([label, homeTradeDownInputs, reason]) => {
      const dropped = normalizeGenerated({ homeTradeDownInputs, ...staleStored });
      assertEqual(dropped.homeTradeDownInputs, null, `${label}: the module is left without inputs`);
      assert(
        drainSessionImportWarnings().some((text) => /homeTradeDownInputs could not be read and was left out/.test(text) && reason.test(text)),
        `${label}: and says why`
      );
      // Stored figures were the engine's. With its inputs gone they are not
      // shown as a generic analysis, and nothing stale survives.
      assertEqual(dropped.outputs.rows.length, 0, `${label}: the stored outputs are cleared`);
      assertEqual(dropped.assumptions.rows.length, 0, `${label}: the stored assumptions are cleared`);
      assertEqual(dropped.tables.length, 0, `${label}: the stored tables are cleared`);
      assertEqual(dropped.charts.length, 0, `${label}: the stored charts are cleared`);
      assert(!JSON.stringify(dropped).includes('STALE'), `${label}: nothing stale is left`);
    });

    // A module with no home trade down keeps what it has.
    const plain = normalizeGenerated({ ...staleStored });
    assertEqual(plain.outputs.rows.length, 1, 'a module with no engine inputs keeps its own outputs');
  }));

  cases.push(runCase('A saved session normalises to the same inputs again', () => {
    const once = normalizeGenerated({ homeTradeDownInputs: SAMPLE });
    const twice = normalizeGenerated(JSON.parse(JSON.stringify(once)));
    assertEqual(
      JSON.stringify(twice.homeTradeDownInputs),
      JSON.stringify(once.homeTradeDownInputs),
      'normalising a normalised session'
    );
    assertEqual(JSON.stringify(twice.outputs), JSON.stringify(once.outputs), 'and its derived outputs');
    assertEqual(once.outputs.rows.length, 4, 'derived from its own projection');
  }));

  cases.push(runCase('The selected case is remembered on the module\'s ui across a saved session', () => {
    const imported = importSession({
      version: 1,
      sessionId: 'session-test',
      clientName: 'Client',
      order: ['home-1'],
      activeModuleId: 'home-1',
      modules: [{
        id: 'home-1',
        title: 'Home trade down',
        generated: { homeTradeDownInputs: SAMPLE },
        ui: { homeTradeDownScenarioId: ' repay-12000 ' }
      }]
    });
    assertEqual(imported.modules[0].ui.homeTradeDownScenarioId, 'repay-12000', 'trimmed and kept');
    assert(imported.modules[0].generated.homeTradeDownInputs, 'with its inputs');

    const numeric = importSession({
      version: 1,
      sessionId: 'session-test',
      clientName: 'Client',
      order: ['home-1'],
      modules: [{ id: 'home-1', title: 'Home', generated: { homeTradeDownInputs: SAMPLE }, ui: { homeTradeDownScenarioId: 7 } }]
    });
    assertEqual(numeric.modules[0].ui.homeTradeDownScenarioId, '', 'a number is not a case');
  }));

  cases.push(runCase('The presenter catalogue lists the module, its cases and its default case', () => {
    const generated = normalizeGenerated({ homeTradeDownInputs: { ...SAMPLE, baseScenarioId: 'repay-18000' } });
    const catalogue = buildPresentationCatalogue({
      modules: [{ id: 'home-1', title: 'Home trade down', generated, ui: {} }]
    });
    assertEqual(catalogue.errors.length, 0, `no catalogue errors (${catalogue.errors.join('; ')})`);
    const entry = catalogue.modules[0];
    assertEqual(entry.kind, 'home-trade-down', 'the kind');
    assertEqual(entry.defaultScenarioId, 'repay-18000', 'the default case is the payload\'s base case');
    assertEqual(
      entry.scenarios.map((scenario) => scenario.id).join(','),
      'stay,repay-18000,repay-12000,no-mortgage',
      'the case ids, in order'
    );
    assertEqual(
      entry.scenarios.map((scenario) => scenario.label).join(','),
      'Stay,Repay €18,000 a year,Repay €12,000 a year,No mortgage',
      'the case titles'
    );
    assert(entry.capabilities.scenarioSelection === true, 'case selection is offered');

    const withoutBase = buildPresentationCatalogue({
      modules: [{
        id: 'home-2',
        title: 'Home trade down',
        generated: normalizeGenerated({ homeTradeDownInputs: { ...SAMPLE, baseScenarioId: undefined } }),
        ui: {}
      }]
    });
    assertEqual(withoutBase.modules[0].defaultScenarioId, 'stay', 'a payload with no base case opens on its first case');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };
  if (failed > 0) {
    console.warn('[HomeTradeDownWiringTests] Completed with failures', summary);
  } else {
    console.info('[HomeTradeDownWiringTests] All tests passed', { total: summary.total, passed: summary.passed });
  }
  return summary;
}
