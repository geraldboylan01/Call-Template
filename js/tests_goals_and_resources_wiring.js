import { applyNormalizedPayloadToModule, createBlankModule, ensureGenerated, normalizePayload } from './module_pipeline.js';
import { normalizeGenerated, drainSessionImportWarnings } from './state.js';
import { buildPresentationCatalogue } from './presenter_catalogue.js';
import { buildVideoSceneManifest } from './video_scene.js';
import { GOALS_AND_RESOURCES_SAMPLE } from './tests_goals_and_resources_math.js';
import { HOME_TRADE_DOWN_SAMPLE } from './tests_home_trade_down_math.js';
import { projectGoalsAndResources } from './goals_and_resources_math.js';
import { buildGarModel, goalsAndResourcesReliefNotes } from './goals_and_resources_view.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
function assert(condition, message) { if (!condition) throw new Error(message); }
function paste(module, generated) {
  applyNormalizedPayloadToModule(module, normalizePayload({ title: 'Your goals and resources', generated }));
  return module;
}
export function runGoalsAndResourcesWiringTests() {
  const cases = [];
  function check(name, run) {
    try { run(); cases.push({ name, pass: true }); console.info(`[GoalsAndResourcesWiringTests] PASS: ${name}`); }
    catch (error) { cases.push({ name, pass: false, error: error.message }); console.error(`[GoalsAndResourcesWiringTests] FAIL: ${name}`, error); }
  }
  check('Paste and refresh derive tables from inputs and replace supplied figures', () => {
    const module = paste(createBlankModule(), {
      goalsAndResourcesInputs: GOALS_AND_RESOURCES_SAMPLE,
      outputs: { columns: ['Fake'], rows: [['MODEL FIGURE']] }
    });
    const expected = projectGoalsAndResources(GOALS_AND_RESOURCES_SAMPLE);
    assert(JSON.stringify(module.generated.outputs) === JSON.stringify(expected.outputsTable), 'outputs derived');
    module.generated.outputs = { columns: [], rows: [['STALE']] };
    ensureGenerated(module);
    assert(JSON.stringify(module.generated.outputs) === JSON.stringify(expected.outputsTable), 'refresh derives them again');
    assert(module.generated.tables[0].rows[0][0] === String(expected.debug.calculationYear), 'ledger uses calendar years');
  });
  check('Child names never enter rendered ledger headings or the video ledger', () => {
    const raw = clone(GOALS_AND_RESOURCES_SAMPLE);
    raw.children[0].title = 'Aoife'; raw.children[1].title = 'Cian';
    const module = paste(createBlankModule(), { goalsAndResourcesInputs: raw });
    assert(!/Aoife|Cian/i.test(JSON.stringify(module.generated.tables)), 'all case ledgers use ordinals');
    assert(module.generated.tables.every((table) => table.columns.includes('College, first child (€)')), 'first child label');
    const manifest = buildVideoSceneManifest({ module, session: {} });
    assert(!/Aoife|Cian/i.test(JSON.stringify(manifest.story)), 'video ledger uses ordinals');
  });
  check('Switching between report and goals clears the previous native input and figures', () => {
    const module = paste(createBlankModule(), { goalsAndResourcesInputs: GOALS_AND_RESOURCES_SAMPLE });
    paste(module, { report: { title: 'Report', blocks: [] } });
    assert(module.generated.goalsAndResourcesInputs === null, 'report clears goals');
    paste(module, { goalsAndResourcesInputs: GOALS_AND_RESOURCES_SAMPLE });
    assert(module.generated.report === null && module.generated.homeTradeDownInputs === null, 'goals clears other kinds');
  });
  check('Home trade down and goals replace one another on paste and remain exclusive on import', () => {
    const module = paste(createBlankModule(), { goalsAndResourcesInputs: GOALS_AND_RESOURCES_SAMPLE });
    paste(module, { homeTradeDownInputs: HOME_TRADE_DOWN_SAMPLE });
    assert(module.generated.homeTradeDownInputs && module.generated.goalsAndResourcesInputs === null, 'home replaces goals');
    paste(module, { goalsAndResourcesInputs: GOALS_AND_RESOURCES_SAMPLE });
    assert(module.generated.goalsAndResourcesInputs && module.generated.homeTradeDownInputs === null, 'goals replaces home');
    const imported = normalizeGenerated({ homeTradeDownInputs: HOME_TRADE_DOWN_SAMPLE, goalsAndResourcesInputs: GOALS_AND_RESOURCES_SAMPLE });
    assert(imported.homeTradeDownInputs && imported.goalsAndResourcesInputs === null, 'import priority keeps only the home calculator');
  });
  check('Import recomputes valid figures and drops malformed inputs with stale figures', () => {
    const imported = normalizeGenerated({ goalsAndResourcesInputs: GOALS_AND_RESOURCES_SAMPLE, tables: [{ title: 'FAKE', rows: [] }] });
    assert(imported.goalsAndResourcesInputs && !JSON.stringify(imported.tables).includes('FAKE'), 'valid import recomputed');
    drainSessionImportWarnings();
    const invalid = normalizeGenerated({ goalsAndResourcesInputs: { ...GOALS_AND_RESOURCES_SAMPLE, spareCash: -1 }, outputs: { columns: ['Old'], rows: [['STALE']] } });
    assert(invalid.goalsAndResourcesInputs === null && invalid.outputs.rows.length === 0, 'bad input and derived figures dropped');
    assert(drainSessionImportWarnings().some((line) => line.includes('goalsAndResourcesInputs')), 'import warning names the input');
  });
  check('Authored scenarios are refused instead of replacing the engine-derived cases', () => {
    let refused = false;
    try { normalizePayload({ generated: { goalsAndResourcesInputs: { ...GOALS_AND_RESOURCES_SAMPLE, scenarios: [{ id: 'invented' }] } } }); }
    catch (_error) { refused = true; }
    assert(refused, 'authored cases refused');
  });
  check('Presenter exposes all derived cases and its own default', () => {
    const module = paste(createBlankModule(), { goalsAndResourcesInputs: GOALS_AND_RESOURCES_SAMPLE });
    const catalogue = buildPresentationCatalogue({ modules: [module] });
    assert(catalogue.modules[0].kind === 'goals-and-resources', 'native presenter kind');
    assert(catalogue.modules[0].scenarios.length === 4, 'four cases');
    assert(catalogue.modules[0].defaultScenarioId === 'cash-stays', 'engine default');
  });
  check('Every video case uses its own shown figures, ledger and headline', () => {
    const module = paste(createBlankModule(), { goalsAndResourcesInputs: GOALS_AND_RESOURCES_SAMPLE });
    const projection = projectGoalsAndResources(GOALS_AND_RESOURCES_SAMPLE);
    const model = buildGarModel(projection);
    for (const shown of model.cases) {
      const manifest = buildVideoSceneManifest({ module, session: {}, activeScenario: { goalsAndResourcesScenarioId: shown.id } });
      assert(manifest.source.moduleKind === 'goals-and-resources', 'video kind');
      assert(manifest.source.activeScenario.id === shown.id && manifest.source.calculationStatus === 'resolved', 'selected case resolved');
      assert(manifest.story.summary.includes(shown.headline.text), 'headline matches selected screen');
      assert(!JSON.stringify(manifest).includes('NaN'), 'no invalid figures');
      const values = manifest.story.charts[0].datasets[0].data;
      assert(values[0] === shown.year.haveTotal && values[1] === shown.year.needTotal, 'chart uses selected yearly figures');
    }
  });
  check('Relief footnotes come from the tax catalogue and only appear at the limit', () => {
    const normal = projectGoalsAndResources(GOALS_AND_RESOURCES_SAMPLE);
    assert(normal.debug.cases.every((entry) => goalsAndResourcesReliefNotes(normal, entry.id).length === 0), 'no limit, no notes');
    const raw = clone(GOALS_AND_RESOURCES_SAMPLE);
    raw.retirement = { retirementAge: 55, targetIncomeToday: 200000 };
    const capped = projectGoalsAndResources(raw);
    for (const entry of capped.debug.cases) {
      const notes = goalsAndResourcesReliefNotes(capped, entry.id);
      assert(notes.length > 0 && notes.every((note) => note.code && note.text), 'limit notes rendered by catalogue');
      assert(JSON.stringify(notes).includes('relief'), 'notes explain relief');
    }
    assert(goalsAndResourcesReliefNotes(capped, 'missing').length === 0, 'no notes for an unknown case');
  });
  return { total: cases.length, passed: cases.filter((entry) => entry.pass).length, failed: cases.filter((entry) => !entry.pass).length, cases };
}
