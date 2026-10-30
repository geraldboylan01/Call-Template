import { buildPresentationCatalogue } from '../../presenter_catalogue.js';
import { StoryBasis } from './story_basis.js';
import { storyDisplay as display, shownMoneyValue } from './story_display.js';
import { euroText as protectionEuroText } from '../../protection_gap_math.js';
import { euroText as cashFlowEuroText } from '../../household_cash_flow_view.js';

export function pointerValue(root, pointer) {
  return pointer.split('/').slice(1).reduce((value, part) => value?.[part.replaceAll('~1', '/').replaceAll('~0', '~')], root);
}
const pointerPart = value => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
const finite = value => typeof value === 'number' && Number.isFinite(value);
/** A local registry, with no global state, UI, tool dispatch or story checker. */
export class StoryRegistry {
  constructor(compiled, route, index) {
    this.compiled = compiled; this.route = route; this.routePath = '/routes/' + index;
    this.facts = {}; this.catalogues = new Map(); this.bases = new StoryBasis(this);
    const i = compiled.resourceLedger?.routes?.findIndex(row => row.routeId === route.id) ?? -1;
    this.ledger = i >= 0 ? compiled.resourceLedger.routes[i] : null;
    this.ledgerPath = i >= 0 ? '/resourceLedger/routes/' + i : null;
    this.pack = compiled.source.normalizedPlanPack;
    if (route.sourceHousehold) this.householdPath = this.routePath + '/sourceHousehold';
    else {
      const chapter = ['household_cash_flow', 'personal_balance_sheet', 'protection_gap'].map(id => this.chapter(id)).find(Boolean);
      this.householdPath = chapter?.entry.provenance?.builderHousehold ? chapter.path + '/provenance/builderHousehold'
        : route.id === 'current' ? '/source/normalizedPlanPack/household' : null;
    }
    this.household = this.householdPath ? pointerValue(compiled, this.householdPath) : null;
  }
  chapter(id) {
    const ci = this.compiled.chapters.findIndex(row => row.id === id);
    if (ci < 0) return null;
    const si = this.compiled.chapters[ci].cases.findIndex(row => row.id === this.route.chapterCases[id]);
    if (si < 0) throw new Error('Compiled route ' + this.route.id + ' has no matching case for ' + id + '.');
    return { id, entry: this.compiled.chapters[ci].cases[si], path: `/chapters/${ci}/cases/${si}` };
  }
  source(path, extra = {}) {
    return { kind: 'plan', chapter: null, routeId: this.route.id, caseId: null, nativeCaseId: null, focusTargetId: null,
      panel: 'plan_facts', ...(path ? { path } : {}), versions: { ...this.compiled.versions, storyFacts: 'story-facts-1.2.0' }, ...extra };
  }
  chapterSource(chapter, relative, value, requestedCaseId = chapter.entry.nativeCaseId) {
    const { entry } = chapter;
    const source = this.source(chapter.path + relative, { kind: 'chapter', chapter: chapter.id, panel: null, caseId: entry.id,
      nativeCaseId: requestedCaseId, versions: { ...this.compiled.versions, ...entry.provenance?.versions, storyFacts: 'story-facts-1.2.0' },
      basis: entry.basis, inputHash: entry.inputHash });
    // Discover actual existing targets from the compiled payload and outputs.
    // No target is invented when the catalogue offers no corresponding figure.
    if (!this.catalogues.has(entry.id)) {
      const generated = { ...entry.payload.generated, ...entry.derived };
      this.catalogues.set(entry.id, buildPresentationCatalogue({ modules: [{ id: entry.id, title: entry.payload.title, generated }] }));
    }
    const catalogue = this.catalogues.get(entry.id);
    const module = catalogue.modules[0];
    const native = module?.scenarios.find(row => row.id === requestedCaseId)
      ?? module?.scenarios.find(row => row.id === module.defaultScenarioId);
    source.nativeCaseId = native?.id ?? null;
    if (entry.nativeCaseId !== source.nativeCaseId) source.compiledNativeCaseId = entry.nativeCaseId;
    const candidates = catalogue.targets.filter(row => row.available && (row.scenarioId === undefined || row.scenarioId === source.nativeCaseId));
    const metric = relative.split('/').at(-1);
    const labels = metric.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    const liquidityKey = { currentCash: 'current-cash', targetCash: 'target-reserve' }[metric];
    const cashFlowColumn = relative.startsWith('/metrics/') && chapter.id === 'household_cash_flow'
      ? { tax: 'Tax (€)', pensions: 'Pensions (€)', leftOver: 'Left over (€)' }[metric] : null;
    const target = chapter.id === 'liquidity_analysis'
      ? candidates.find(row => liquidityKey && row.ref.key === liquidityKey && row.value === value)
      : cashFlowColumn ? candidates.find(row => row.kind === 'table-row' && row.cells?.[0] === native?.label && row.columns?.includes(cashFlowColumn))
      : chapter.id === 'household_cash_flow' ? null
      : candidates.find(row => row.kind === 'holding' && row.label.toLowerCase() === labels && row.value === value)
        ?? candidates.find(row => row.kind === 'table-row' && String(row.cells?.[0]).toLowerCase() === labels && row.cells.some(cell => cell === value || chapter.id === 'property_move' && cell === display(value, chapter.entry.units[metric])))
        ?? candidates.find(row => row.kind === 'table-row' && native && row.cells?.[0] === native.label && row.cells.some(cell => cell === value || chapter.id === 'property_move' && cell === display(value, chapter.entry.units[metric])));
    if (target) {
      source.focusTargetId = target.id;
      if (target.value === value && target.displayValue) source.display = target.displayValue;
      if (cashFlowColumn) source.display = cashFlowEuroText(target.cells[target.columns.indexOf(cashFlowColumn)]);
      if (chapter.id === 'property_move') source.display = display(value, chapter.entry.units[metric]);
    }
    return source;
  }
  add(key, value, unit, source, shown) {
    if (Object.hasOwn(this.facts, key)) throw new Error('Duplicate story fact ' + key);
    if (value === undefined || value === null || (typeof value === 'number' && !finite(value))) {
      return this.unavailable(key, 'This figure was not produced by the compiled plan.', source);
    }
    const fact = { key, value: structuredClone(value), unit, display: ['EUR', 'EUR/year', 'EUR/month'].includes(unit) ? display(shownMoneyValue(shown ?? source.display ?? value), unit)
        : unit === 'text' && /goals\..*\.(?:state|chosenWay)$/.test(key) ? String(value).replace(/^./, c => c.toLowerCase()) : shown ?? source.display ?? display(value, unit), status: 'available', source,
      basis: this.bases.for(key, value, source), ...(source.explainerId ? { explainerId: source.explainerId } : {}) };
    this.facts[key] = fact; return fact;
  }
  from(key, path, unit, extra = {}) { return this.add(key, pointerValue(this.compiled, path), unit, this.source(path, extra)); }
  metric(key, id, metric, unit = 'EUR') {
    const chapter = this.chapter(id);
    if (!chapter) return this.unavailable(key, 'This plan has no compiled ' + id.replaceAll('_', ' ') + ' chapter.');
    const value = chapter.entry.metrics[metric];
    return this.add(key, value, unit, this.chapterSource(chapter, '/metrics/' + pointerPart(metric), value,
      id === 'protection_gap' ? metric.split('.')[0] : chapter.entry.nativeCaseId),
    id === 'protection_gap' && typeof value === 'number' ? unit === 'months' ? String(value) : protectionEuroText(value) : undefined);
  }
  calculated(key, value, unit, inputs, calculation, extra = {}) {
    return this.add(key, value, unit, this.source(null, { kind: 'calculation', inputs, calculation, panel: 'plan_facts', ...extra }));
  }
  unavailable(key, message, source = this.source(null), notApplicable = false, code = 'not_produced') {
    const reason = { code, message };
    this.facts[key] = { key, value: null, unit: null, display: message, status: notApplicable ? 'not_applicable' : 'missing', reason, source,
      basis: this.bases.calculated('story_facts', source, { description: message }), ...(source.explainerId ? { explainerId: source.explainerId } : {}) };
    if (notApplicable) {
      const { path, ...origin } = source;
      this.add(key + '.notApplicable', message, 'text', { ...origin, kind: 'calculation', chapter: null, caseId: null, nativeCaseId: null, focusTargetId: null, panel: 'plan_facts',
        inputs: path ? [path] : [], calculation: 'not_applicable_reason', reasonCode: code });
    }
    return this.facts[key];
  }
}
