import {
  applyNormalizedPayloadToModule,
  createBlankModule,
  ensureGenerated,
  normalizePayload
} from './module_pipeline.js';
import { drainSessionImportWarnings, normalizeGenerated } from './state.js';
import { buildPresentationCatalogue } from './presenter_catalogue.js';
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

const SAMPLE = JSON.parse(JSON.stringify(PROTECTION_GAP_SAMPLE));

const COLLEGE = Object.freeze({
  currentYear: 2026,
  childrenCount: 1,
  childCurrentAge: 10,
  collegeStartAge: 18,
  collegeDurationYears: 4,
  inflationRate: 0.02,
  scenarios: [{ id: 'home', title: 'At home', annualCostTodayPerChild: 5000 }]
});

const FIELD = 'generated.protectionGapInputs';

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
    console.info(`[ProtectionGapWiringTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[ProtectionGapWiringTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

function paste(module, generated) {
  applyNormalizedPayloadToModule(module, normalizePayload({ title: 'Test', generated }));
  return module;
}

function refusalOf(patch) {
  try {
    normalizePayload({ generated: { protectionGapInputs: { ...SAMPLE, ...patch } } });
  } catch (error) {
    return error.message;
  }
  return '';
}

export function runProtectionGapWiringTests() {
  const cases = [];

  cases.push(runCase('A pasted payload is accepted, and its tables are derived, never the payload\'s own', () => {
    const module = paste(createBlankModule(), {
      protectionGapInputs: SAMPLE,
      outputs: { columns: ['Metric', 'Value'], rows: [['MODEL-SUPPLIED', 999999999]] }
    });
    const { generated } = module;
    assertEqual(generated.protectionGapInputs.people.length, 2, 'the inputs are held');
    assertEqual(generated.outputs.rows.length, 4, 'one output row per case');
    assert(!JSON.stringify(generated).includes('MODEL-SUPPLIED'), 'a model-supplied figure is gone');
    assertEqual(generated.tables.length, 4, 'one table per case');
    assertEqual(generated.charts.length, 1, 'one chart, for the surfaces that cannot draw the module');
    assert(
      generated.assumptions.rows.some((row) => row[0] === 'Your savings'),
      'the assumptions name the savings'
    );
    ['collegeFundingInputs', 'futureCostFundInputs', 'householdCashFlowInputs', 'housePurchaseInputs',
      'pensionInputs', 'netRetirementInputs', 'mortgageInputs', 'loanInputs', 'liquidityPlan', 'education',
      'report'].forEach((key) => {
      assertEqual(generated[key], null, `${key} is empty`);
    });
  }));

  cases.push(runCase('A calculated field, a cover or premium key, a fifth case or a lone death is refused with the engine\'s own message', () => {
    assertEqual(
      refusalOf({ gap: 38_000 }),
      `${FIELD}.gap is not accepted. It is calculated.`,
      'a typed gap'
    );
    assertEqual(
      refusalOf({ coverAmount: 250_000 }),
      `${FIELD}.coverAmount: this screen shows the gap and the time, never a cover amount, a premium or a product.`,
      'a cover amount'
    );
    assertEqual(
      refusalOf({ scenarios: [...SAMPLE.scenarios, { id: 'fifth' }] }),
      `${FIELD}.scenarios supports at most 4 cases; received 5.`,
      'a fifth case'
    );
    assertEqual(
      refusalOf({
        people: [SAMPLE.people[0]],
        scenarios: [{ id: 'today' }, { id: 'gone', event: { type: 'dies', personId: 'niamh', survivorsPension: 1 } }]
      }),
      `${FIELD}.scenarios[1] (If Niamh died): needs two people in the household.`,
      'a death with one person'
    );
    assertEqual(
      refusalOf({
        scenarios: [{
          id: 'higher',
          event: { type: 'dies', personId: 'niamh', survivorsPension: 1, neededAfter: 100_000 }
        }]
      }),
      `${FIELD}.scenarios[0] (If Niamh died): a higher need after a death is not drawn yet.`,
      'a higher need after a death'
    );
  }));

  cases.push(runCase('A refused paste leaves the module as it was', () => {
    const module = paste(createBlankModule(), { collegeFundingInputs: COLLEGE });
    let refused = false;
    try {
      paste(module, { protectionGapInputs: { ...SAMPLE, premium: 120 } });
    } catch (_error) {
      refused = true;
    }
    assert(refused, 'refused');
    assert(module.generated.collegeFundingInputs, 'college is still set');
    assertEqual(module.generated.protectionGapInputs, null, 'and nothing half applied');
  }));

  cases.push(runCase('Setting it clears the other engine modules, and setting one of them clears it', () => {
    const module = createBlankModule();
    paste(module, { collegeFundingInputs: COLLEGE });
    assert(module.generated.collegeFundingInputs, 'college is set');

    paste(module, { protectionGapInputs: SAMPLE });
    assertEqual(module.generated.collegeFundingInputs, null, 'college is cleared by the protection gap');
    assert(module.generated.protectionGapInputs, 'the protection gap is set');

    paste(module, { collegeFundingInputs: COLLEGE });
    assertEqual(module.generated.protectionGapInputs, null, 'the protection gap is cleared by college');
    assert(module.generated.collegeFundingInputs, 'college is set again');

    // The two modules it shares a lane with.
    paste(module, { protectionGapInputs: SAMPLE });
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
    assertEqual(module.generated.protectionGapInputs, null, 'the protection gap is cleared by the fund');
    assert(module.generated.futureCostFundInputs, 'the fund is set');

    paste(module, { protectionGapInputs: SAMPLE });
    assertEqual(module.generated.futureCostFundInputs, null, 'the fund is cleared by the protection gap');
    assert(module.generated.protectionGapInputs, 'the protection gap is set again');
  }));

  cases.push(runCase('A summary is held to the same wording limit: refused on paste, cleared on import and on load', () => {
    let refused = '';
    try {
      normalizePayload({ generated: { summaryHtml: '<p>The best income protection policy for you.</p>', protectionGapInputs: SAMPLE } });
    } catch (error) {
      refused = error.message;
    }
    assert(/^generated\.summaryHtml: a protection gap summary shows the gap and the time/.test(refused), `refused on paste: ${refused}`);
    const fine = paste(createBlankModule(), { summaryHtml: '<p>How big the gap would be, and how long your savings fill it.</p>', protectionGapInputs: SAMPLE });
    assertEqual(fine.generated.summaryHtml, '<p>How big the gap would be, and how long your savings fill it.</p>', 'a plain summary is kept');

    drainSessionImportWarnings();
    const imported = normalizeGenerated({ summaryHtml: '<p>Your premium would be low.</p>', protectionGapInputs: SAMPLE });
    assertEqual(imported.summaryHtml, '', 'cleared on import');
    assert(drainSessionImportWarnings().some((text) => /summary used wording this screen never shows/.test(text)), 'and says why');

    const loaded = createBlankModule();
    loaded.generated.protectionGapInputs = JSON.parse(JSON.stringify(SAMPLE));
    loaded.generated.summaryHtml = '<p>Ask your insurer for a quote.</p>';
    ensureGenerated(loaded);
    assertEqual(loaded.generated.summaryHtml, '', 'cleared on load');
  }));

  cases.push(runCase('Loading a module refreshes its derived tables', () => {
    const module = createBlankModule();
    module.generated.protectionGapInputs = JSON.parse(JSON.stringify(SAMPLE));
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
      protectionGapInputs: { ...SAMPLE, scenarios: [...SAMPLE.scenarios, { id: 'fifth' }] }
    });
    assertEqual(tooMany.protectionGapInputs.scenarios.length, 4, 'cut to four');
    const warnings = drainSessionImportWarnings();
    assert(warnings.some((text) => /carried 5 cases; kept the first 4/.test(text)), 'the cut was recorded');

    const withCover = normalizeGenerated({ protectionGapInputs: { ...SAMPLE, coverAmount: 1 } });
    assertEqual(withCover.protectionGapInputs, null, 'a cover amount leaves the module without inputs');
    assert(
      drainSessionImportWarnings().some((text) => /never a cover amount, a premium or a product/.test(text)),
      'and says why'
    );
    assertEqual(withCover.outputs.rows.length, 0, 'nothing derived from nothing');

    const lone = normalizeGenerated({
      protectionGapInputs: {
        ...SAMPLE,
        people: [SAMPLE.people[0]],
        scenarios: [{ id: 'today' }, { id: 'gone', event: { type: 'dies', personId: 'niamh', survivorsPension: 1 } }]
      }
    });
    assertEqual(lone.protectionGapInputs, null, 'a death with one person is dropped, not drawn');
    assert(drainSessionImportWarnings().some((text) => /needs two people/.test(text)), 'with its reason');
  }));

  cases.push(runCase('A saved session normalises to the same inputs again', () => {
    const once = normalizeGenerated({ protectionGapInputs: SAMPLE });
    const twice = normalizeGenerated(JSON.parse(JSON.stringify(once)));
    assertEqual(
      JSON.stringify(twice.protectionGapInputs),
      JSON.stringify(once.protectionGapInputs),
      'normalising a normalised session'
    );
    assertEqual(JSON.stringify(twice.outputs), JSON.stringify(once.outputs), 'and its derived outputs');
  }));

  cases.push(runCase('The presenter catalogue lists the module, its cases and its default case', () => {
    const generated = normalizeGenerated({ protectionGapInputs: { ...SAMPLE, baseScenarioId: 'today' } });
    const catalogue = buildPresentationCatalogue({
      modules: [{ id: 'gap-1', title: 'Protection gap', generated, ui: {} }]
    });
    assertEqual(catalogue.errors.length, 0, `no catalogue errors (${catalogue.errors.join('; ')})`);
    const entry = catalogue.modules[0];
    assertEqual(entry.kind, 'protection-gap', 'the kind');
    assertEqual(entry.defaultScenarioId, 'today', 'the default case is the payload\'s base case');
    assertEqual(
      entry.scenarios.map((scenario) => scenario.id).join(','),
      'today,niamh-cannot-work,dara-cannot-work,niamh-died',
      'the case ids, in order'
    );
    assertEqual(entry.scenarios[3].label, 'If Niamh died', 'the death case is titled "If Niamh died"');
    assert(entry.capabilities.scenarioSelection === true, 'case selection is offered');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };
  if (failed > 0) {
    console.warn('[ProtectionGapWiringTests] Completed with failures', summary);
  } else {
    console.info('[ProtectionGapWiringTests] All tests passed', { total: summary.total, passed: summary.passed });
  }
  return summary;
}
