import {
  applyNormalizedPayloadToModule,
  createBlankModule,
  ensureGenerated,
  normalizePayload
} from './module_pipeline.js';
import { drainSessionImportWarnings, normalizeGenerated } from './state.js';
import { buildPresentationCatalogue } from './presenter_catalogue.js';
import { FUTURE_COST_FUND_SAMPLE } from './tests_future_cost_fund_math.js';
import { HOUSEHOLD_CASH_FLOW_SAMPLE } from './tests_household_cash_flow_math.js';
import { PROTECTION_GAP_SAMPLE } from './tests_protection_gap_math.js';
import { RENTAL_KEEP_OR_SELL_SAMPLE } from './tests_rental_keep_or_sell_math.js';

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

  cases.push(runCase('An engine payload a session cannot read takes its stored figures with it, for every engine module', () => {
    const stored = {
      assumptions: { columns: ['Assumption', 'Value'], rows: [['MODEL-SUPPLIED', 1]] },
      outputs: { columns: ['Metric', 'Value'], rows: [['MODEL-SUPPLIED', 999999999]] },
      tables: [{ title: 'Stale', columns: ['A', 'B'], rows: [['MODEL-SUPPLIED', 1]] }],
      charts: [{ title: 'Stale', type: 'bar', labels: ['A'], datasets: [{ label: 'A', data: [1] }] }]
    };
    const unreadable = {
      futureCostFundInputs: { ...SAMPLE, dirtRate: 0 },
      householdCashFlowInputs: { ...HOUSEHOLD_CASH_FLOW_SAMPLE, leftOver: 1 },
      protectionGapInputs: { ...PROTECTION_GAP_SAMPLE, gap: 1 },
      rentalKeepOrSellInputs: { ...RENTAL_KEEP_OR_SELL_SAMPLE, rentPerYear: -1 }
    };
    unreadable.futureCostFundPrimitive = 'not an object';
    Object.entries(unreadable).forEach(([entryKey, inputs]) => {
      const key = entryKey === 'futureCostFundPrimitive' ? 'futureCostFundInputs' : entryKey;
      drainSessionImportWarnings();
      const generated = normalizeGenerated({ summaryHtml: '<p>Kept.</p>', ...stored, [key]: inputs });
      assertEqual(generated[key], null, `${key} is left out`);
      assert(drainSessionImportWarnings().some((text) => text.startsWith(`${key} could not be read`)), `${key}: and says why`);
      assertEqual(generated.outputs.rows.length, 0, `${key}: no stored outputs`);
      assertEqual(generated.assumptions.rows.length, 0, `${key}: no stored assumptions`);
      assertEqual(generated.tables.length, 0, `${key}: no stored tables`);
      assertEqual(generated.charts.length, 0, `${key}: no stored charts`);
      // The protection gap's summary is only ever its engine's, so it goes with
      // its inputs. Every other module's written summary is kept.
      const summaryKept = key !== 'protectionGapInputs';
      assertEqual(generated.summaryHtml, summaryKept ? '<p>Kept.</p>' : '', `${key}: the written summary is ${summaryKept ? 'kept' : 'left out'}`);
    });
    const plain = normalizeGenerated({ ...stored });
    assertEqual(plain.outputs.rows.length, 1, 'a module with no engine payload keeps its own tables');
  }));

  cases.push(runCase('Cutting an imported module to four cases keeps its base among them', () => {
    const fifth = (inputs, extra) => ({ ...inputs, scenarios: [...inputs.scenarios, extra], baseScenarioId: extra.id });
    const modules = {
      futureCostFundInputs: fifth(SAMPLE, { id: 'fifth', lumpShare: 0.25 }),
      householdCashFlowInputs: fifth(HOUSEHOLD_CASH_FLOW_SAMPLE, { id: 'fifth' }),
      protectionGapInputs: fifth(PROTECTION_GAP_SAMPLE, { id: 'fifth' })
    };
    Object.entries(modules).forEach(([key, inputs]) => {
      drainSessionImportWarnings();
      const generated = normalizeGenerated({ [key]: inputs });
      assert(generated[key], `${key} survives the cut`);
      assertEqual(generated[key].scenarios.length, 4, `${key}: cut to four`);
      assertEqual(generated[key].baseScenarioId, 'fifth', `${key}: the named base is kept`);
      assertEqual(generated[key].scenarios[3].id, 'fifth', `${key}: in place of the last case kept`);
      const warnings = drainSessionImportWarnings();
      assert(warnings.some((text) => /baseScenarioId "fifth" was beyond the first 4 cases/.test(text)), `${key}: the kept base is recorded (${warnings.join(' | ')})`);
    });
    // The protection gap's base is its only case with no event, so losing it
    // would lose the module: today, named as the base, sits fifth.
    const events = PROTECTION_GAP_SAMPLE.scenarios.slice(1);
    const todayLast = {
      ...PROTECTION_GAP_SAMPLE,
      baseScenarioId: 'today',
      scenarios: [...events, { ...events[0], id: 'niamh-cannot-work-again' }, PROTECTION_GAP_SAMPLE.scenarios[0]]
    };
    drainSessionImportWarnings();
    const kept = normalizeGenerated({ protectionGapInputs: todayLast }).protectionGapInputs;
    assert(kept, 'the protection gap survives with today kept');
    assertEqual(kept.baseScenarioId, 'today', 'today is still the base');
    assertEqual(kept.scenarios.map((entry) => entry.id).join(','), 'niamh-cannot-work,dara-cannot-work,niamh-died,today', 'three events and today');
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
