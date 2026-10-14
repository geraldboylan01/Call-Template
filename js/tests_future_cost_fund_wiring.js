import {
  applyNormalizedPayloadToModule,
  createBlankModule,
  ensureGenerated,
  normalizePayload
} from './module_pipeline.js';
import { drainSessionImportWarnings, normalizeGenerated } from './state.js';
import { buildPresentationCatalogue } from './presenter_catalogue.js';
import { FUTURE_COST_FUND_SAMPLE } from './tests_future_cost_fund_math.js';

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

const SAMPLE = JSON.parse(JSON.stringify(FUTURE_COST_FUND_SAMPLE));

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
    console.info(`[FutureCostFundWiringTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[FutureCostFundWiringTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

function paste(module, generated) {
  applyNormalizedPayloadToModule(module, normalizePayload({ title: 'Test', generated }));
  return module;
}

export function runFutureCostFundWiringTests() {
  const cases = [];

  cases.push(runCase('A pasted payload is accepted, and its tables are derived, never the payload\'s own', () => {
    const module = paste(createBlankModule(), {
      futureCostFundInputs: SAMPLE,
      outputs: { columns: ['Metric', 'Value'], rows: [['MODEL-SUPPLIED', 999999999]] }
    });
    const generated = module.generated;
    assertEqual(generated.futureCostFundInputs.costTitle, 'College', 'the inputs are held');
    assertEqual(generated.outputs.rows.length, 4, 'one output row per case');
    assert(!JSON.stringify(generated).includes('MODEL-SUPPLIED'), 'a model-supplied figure is gone');
    assertEqual(generated.tables.length, 4, 'one funding profile per case');
    assertEqual(generated.charts.length, 1, 'one chart, for the surfaces that cannot draw the fund');
    assert(generated.assumptions.rows.some((row) => /DIRT/.test(row[0])), 'the assumptions name DIRT');
    ['collegeFundingInputs', 'housePurchaseInputs', 'pensionInputs', 'netRetirementInputs',
      'mortgageInputs', 'loanInputs', 'liquidityPlan', 'education', 'report'].forEach((key) => {
      assertEqual(generated[key], null, `${key} is empty`);
    });
  }));

  cases.push(runCase('A rate, an unsolvable case or a fifth case is refused with the engine\'s own message', () => {
    const refuse = (patch, expected) => {
      let message = '';
      try {
        normalizePayload({ generated: { futureCostFundInputs: { ...SAMPLE, ...patch } } });
      } catch (error) {
        message = error.message;
      }
      assertEqual(message, expected, `refusal for ${JSON.stringify(patch).slice(0, 60)}`);
    };
    refuse(
      { priceGrowthRate: 0.1 },
      'generated.futureCostFundInputs.priceGrowthRate is not accepted. Rates are set centrally in the Planéir assumptions.'
    );
    refuse(
      { scenarios: [...SAMPLE.scenarios, { id: 'e', lumpShare: 0.25 }] },
      'generated.futureCostFundInputs.scenarios supports at most 4 cases; received 5.'
    );
    refuse(
      { startsInYears: 41 },
      'generated.futureCostFundInputs.startsInYears must be a whole number of years from 1 to 40.'
    );
    refuse({ costKind: undefined }, 'generated.futureCostFundInputs.costKind must be "education" or "general".');
  }));

  cases.push(runCase('Setting it clears the other engine modules, and setting one of them clears it', () => {
    const module = createBlankModule();
    paste(module, { collegeFundingInputs: COLLEGE });
    assert(module.generated.collegeFundingInputs, 'college is set');

    paste(module, { futureCostFundInputs: SAMPLE });
    assertEqual(module.generated.collegeFundingInputs, null, 'college is cleared by the fund');
    assert(module.generated.futureCostFundInputs, 'the fund is set');

    paste(module, { collegeFundingInputs: COLLEGE });
    assertEqual(module.generated.futureCostFundInputs, null, 'the fund is cleared by college');
    assert(module.generated.collegeFundingInputs, 'college is set again');
  }));

  cases.push(runCase('Loading a module refreshes its derived tables from the central assumptions', () => {
    const module = createBlankModule();
    module.generated.futureCostFundInputs = JSON.parse(JSON.stringify(SAMPLE));
    module.generated.outputs = { columns: ['Case'], rows: [['STALE', 1]] };
    module.generated.assumptions = { columns: ['Assumption'], rows: [['STALE']] };
    ensureGenerated(module);
    assert(!JSON.stringify(module.generated.outputs).includes('STALE'), 'outputs were refreshed');
    assert(!JSON.stringify(module.generated.assumptions).includes('STALE'), 'assumptions were refreshed');
    assertEqual(module.generated.outputs.rows.length, 4, 'one output row per case');
  }));

  cases.push(runCase('A session import tolerates too many cases and a payload carrying a rate', () => {
    drainSessionImportWarnings();
    const tooMany = normalizeGenerated({
      futureCostFundInputs: { ...SAMPLE, scenarios: [...SAMPLE.scenarios, { id: 'e', lumpShare: 0.25 }] }
    });
    assertEqual(tooMany.futureCostFundInputs.scenarios.length, 4, 'cut to four');
    const warnings = drainSessionImportWarnings();
    assert(warnings.some((text) => /carried 5 cases; kept the first 4/.test(text)), 'the cut was recorded');

    const withRate = normalizeGenerated({ futureCostFundInputs: { ...SAMPLE, dirtRate: 0 } });
    assertEqual(withRate.futureCostFundInputs, null, 'a rate in the payload leaves the module without inputs');
    assert(drainSessionImportWarnings().some((text) => /dirtRate is not accepted/.test(text)), 'and says why');
    assertEqual(withRate.outputs.rows.length, 0, 'nothing derived from nothing');
  }));

  cases.push(runCase('A saved session normalises to the same inputs again', () => {
    const once = normalizeGenerated({ futureCostFundInputs: SAMPLE });
    const twice = normalizeGenerated(JSON.parse(JSON.stringify(once)));
    assertEqual(
      JSON.stringify(twice.futureCostFundInputs),
      JSON.stringify(once.futureCostFundInputs),
      'normalising a normalised session'
    );
    assertEqual(JSON.stringify(twice.outputs), JSON.stringify(once.outputs), 'and its derived outputs');
  }));

  cases.push(runCase('The presenter catalogue lists the module, its cases and its default case', () => {
    const generated = normalizeGenerated({
      futureCostFundInputs: { ...SAMPLE, baseScenarioId: 'half' }
    });
    const catalogue = buildPresentationCatalogue({
      modules: [{ id: 'fund-1', title: 'College', generated, ui: {} }]
    });
    assertEqual(catalogue.errors.length, 0, `no catalogue errors (${catalogue.errors.join('; ')})`);
    const entry = catalogue.modules[0];
    assertEqual(entry.kind, 'future-cost-fund', 'the kind');
    assertEqual(entry.defaultScenarioId, 'half', 'the default case is the payload\'s base case');
    assertEqual(entry.scenarios.map((scenario) => scenario.id).join(','), 'lump,yearly,half,delayed', 'the case ids, in order');
    assert(entry.capabilities.scenarioSelection === true, 'case selection is offered');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };
  if (failed > 0) {
    console.warn('[FutureCostFundWiringTests] Completed with failures', summary);
  } else {
    console.info('[FutureCostFundWiringTests] All tests passed', { total: summary.total, passed: summary.passed });
  }
  return summary;
}
