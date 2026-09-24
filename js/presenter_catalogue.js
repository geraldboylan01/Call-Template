// Shared by the live app and the local director tools. No DOM, storage or AI.
import { getPensionScenarioCases } from './pension_math.js';
import { getNetRetirementScenarioCases } from './net_retirement_math.js';
import { getMortgageScenarioCases, computeMortgageComparison } from './mortgage_math.js';
import { resolveLiquidityReserveForPlan, normalizeSectionToken } from './module_pipeline.js';

export const CATALOGUE_VERSION = 1;
export const plainText = (v) => String(v ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
// A revision token, not a security hash; rebuilt from source on load and start.
export function fingerprint(value) {
  let a = 2166136261, b = 5381;
  for (const c of JSON.stringify(canonical(value))) {
    a = Math.imul(a ^ c.charCodeAt(0), 16777619);
    b = Math.imul(b, 33) ^ c.charCodeAt(0);
  }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}
export function moduleSource(module) {
  const generated = structuredClone(module.generated || {});
  // Normal import assigns these chart IDs from a fresh module UUID.
  for (const chart of generated.charts || []) delete chart.id;
  return { title: module.title || '', generated, hiddenCardIds: module.ui?.hiddenCardIds || [], cardOrder: module.ui?.cardOrder || [] };
}
export function moduleKind(g) {
  for (const [key, kind] of Object.entries({ report: 'report', liquidityPlan: 'liquidity', outputsBucketed: 'balance-sheet', mortgageInputs: 'mortgage', loanInputs: 'loan', pensionInputs: 'pension', netRetirementInputs: 'net-retirement', housePurchaseInputs: 'house-purchase', education: 'education' })) {
    if (g[key]) return kind;
  }
  return 'analysis';
}
function scenarios(g, kind) {
  if (kind === 'balance-sheet') return [{ id: 'current', title: 'Current position' }, ...(g.outputsBucketed.scenarios || [])];
  if (kind === 'pension') return getPensionScenarioCases(g.pensionInputs);
  if (kind === 'net-retirement') return getNetRetirementScenarioCases(g.netRetirementInputs);
  if (kind === 'mortgage' || kind === 'loan') return getMortgageScenarioCases(g.loanInputs || g.mortgageInputs, { defaultLoanKind: kind });
  return [];
}
const money = value => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value);

export function buildPresentationCatalogue(session) {
  const modules = [], targets = [], errors = [];
  for (const module of session.modules || []) {
    const g = module.generated || {}, kind = moduleKind(g), source = moduleSource(module);
    const key = `${kind}-${fingerprint(source)}`;
    if (modules.some(m => m.key === key)) errors.push(`Identical modules need disambiguation: ${module.title}`);
    let cases = [];
    try { cases = scenarios(g, kind); } catch (e) { errors.push(`${module.title}: ${e.message}`); }
    const hidden = new Set(module.ui?.hiddenCardIds || []);
    const meta = { key, moduleId: module.id, label: module.title, kind, sourceRevision: fingerprint(source),
      outputOrigin: g.report ? 'authored-report' : (cases.length || g.liquidityPlan ? 'existing-module-calculation' : 'authored-content'),
      scenarioScope: 'this-module-only', updatesOtherModules: false,
      assumptions: (g.assumptions?.rows || []).map(row => row.map(plainText)),
      capabilities: { wholeModule: true, scenarioSelection: cases.length > 0, calculatorChartPoints: false, authoredReportSubtargets: Boolean(g.report) },
      defaultScenarioId: g.mortgageInputs?.baseScenarioId || g.loanInputs?.baseScenarioId || g.pensionInputs?.baseScenarioId || g.netRetirementInputs?.baseScenarioId || cases[0]?.id || null,
      scenarios: cases.map(s => ({ id: s.id, label: s.title, description: plainText(s.description || s.summaryHtml), supportedActions: ['state'] })) };
    if (kind === 'mortgage' || kind === 'loan') {
      try {
        const computed = computeMortgageComparison(g.loanInputs || g.mortgageInputs, { defaultLoanKind: kind });
        meta.scenarios.forEach(s => {
          const result = computed.cases.find(c => c.id === s.id);
          s.facts = { interestSaved: result.interestSaved, totalInterestLifetime: result.totalInterestLifetime, payoffDateIso: result.payoffDateIso };
          s.description ||= `Existing repayment calculation: payoff ${result.payoffDateIso}, lifetime interest ${money(result.totalInterestLifetime)}, interest saved ${money(result.interestSaved)}.`;
        });
      } catch(e) { errors.push(`${module.title}: ${e.message}`); }
    }
    modules.push(meta);
    const add = (localId, targetKind, label, ref, extra = {}) => {
      const target = { id: `${key}/${localId}`, moduleKey: key, moduleLabel: module.title, kind: targetKind, label: plainText(label),
        description: '', supportedActions: ['frame', 'focus', 'reset'], source: { moduleKey: key, ...ref }, ref,
        outputOrigin: meta.outputOrigin, available: !hidden.has(ref.cardId), ...extra };
      target.supportedEmphasis = target.supportedActions.includes('focus') ? ['spotlight', 'underline', ...(ref.type === 'chart-point' ? ['point'] : [])] : [];
      target.suggestedEmphasis = ref.type === 'chart-point' ? 'point' : ['holding', 'metric'].includes(targetKind) ? 'underline' : 'spotlight';
      targets.push(target); return target;
    };
    add('module', 'module', module.title, { type: 'module' }, { description: plainText(g.summaryHtml || g.report?.title), supportedActions: ['frame', 'focus', 'reset', ...(cases.length ? ['state'] : [])] });
    for (const [id, label, exists] of [['summary', 'Summary', g.summaryHtml && !g.report && !g.liquidityPlan], ['assumptions', 'Assumptions', g.assumptions?.rows?.length], ['outputs', 'Calculated outputs', g.outputs?.rows?.length]]) {
      if (exists) {
        const parent = add(id, 'card', label, { type: 'card', cardId: id });
        if (id === 'outputs') g.outputs.rows.forEach((row, index) => add(`outputs/row/${index}`, 'table-row', row[0], { type: 'output-row', cardId: id, row: index }, { parentId: parent.id, cells: row, columns: g.outputs.columns, description: 'Existing base output; scenario selection uses the live calculator output.' }));
      }
    }
    if (g.outputsBucketed) {
      const bucketCases = [{ id: 'current', sections: g.outputsBucketed.sections }, ...(g.outputsBucketed.scenarios || [])];
      for (const scenario of bucketCases) for (const section of scenario.sections || []) {
        const sectionKey = normalizeSectionToken(section.key || section.title);
        const base = `scenario/${scenario.id}/bucket/${sectionKey}`;
        const availability = { scenarioId: scenario.id, available: !hidden.has('outputs-bucketed') };
        const parent = add(base, 'bucket', section.title, { type: 'pbs-bucket', section: sectionKey }, availability);
        const seenRows = new Set();
        for (const [label, value] of section.rows || []) {
          const rowKey = normalizeSectionToken(label);
          if (seenRows.has(rowKey)) { errors.push(`Ambiguous balance-sheet row: ${label}`); continue; }
          seenRows.add(rowKey);
          add(`${base}/row/${rowKey}`, 'holding', label, { type: 'pbs-row', section: sectionKey, rowKey }, { ...availability, parentId: parent.id, value, displayValue: money(value), units: 'EUR', description: `${section.title}; ${scenario.title || 'Current position'}` });
        }
      }
    }
    if (g.liquidityPlan) {
      const { reserve } = resolveLiquidityReserveForPlan(g.liquidityPlan);
      for (const [id, label] of [['liquidity-hero', 'Cash Control Panel'], ['liquidity-action', 'Priority Move'], ['liquidity-cash', 'Cash Position']]) add(id, 'card', label, { type: 'card', cardId: id });
      for (const [id, label, value] of [['current-cash', 'Current cash', g.liquidityPlan.currentCash], ['target-reserve', 'Target reserve', reserve.targetCash]]) {
        add(id, 'metric', label, { type: 'liquidity-metric', key: id, cardId: 'liquidity-hero' }, { value, displayValue: Number.isFinite(value) ? money(value) : null, units: 'EUR' });
      }
    }
    if (kind === 'mortgage' || kind === 'loan') add('repayment-cases', 'card', 'Repayment comparison', { type: 'card', cardId: 'repayment-cases' });
    for (const block of g.report?.blocks || []) {
      const ref = { type: 'report-block', blockId: block.id, cardId: `report:${block.id}` };
      const parent = add(`report/${block.id}`, block.type, block.title || block.chart?.title || block.type, ref, { description: plainText(block.subtitle || block.markdown || block.bodyHtml), error: block.errorMessage || null });
      for (const item of block.items || []) {
        if (!['kpiRow', 'accordion', 'checklist', 'insightGrid'].includes(block.type)) continue;
        add(`report/${block.id}/item/${item.id}`, block.type === 'accordion' ? 'disclosure' : 'item', item.label || item.title, { ...ref, type: 'report-item', itemId: item.id }, { parentId: parent.id, value: item.value ?? null, displayValue: item.value ?? null, description: plainText(item.detail || item.note || item.markdown || item.bodyHtml) });
      }
      if (block.type === 'table') (block.table?.rows || []).forEach((row, index) => add(`report/${block.id}/row/${index}`, 'table-row', row[0], { ...ref, type: 'table-row', row: index }, { parentId: parent.id, cells: row, columns: block.table.columns }));
      if (block.type === 'timeline') {
        const spec = block.svgSpec || {};
        const events = spec.events || spec.nodes || [];
        const html = !spec.lanes?.length && new Set(events.map(e => e.lane).filter(Boolean)).size <= 1;
        events.forEach((event, index) => add(`report/${block.id}/event/${event.id || `timeline-event-${index + 1}`}`, 'timeline-event', `${event.dateLabel || event.when || ''} — ${event.title || event.label}`, { ...ref, type: 'timeline-event', eventId: event.id || `timeline-event-${index + 1}` }, { parentId: parent.id, description: plainText(event.body || event.description), available: parent.available && html, unsupportedReason: html ? null : 'Multi-lane SVG event focus is not supported in V1; frame its existing timeline instead.' }));
      }
      if (block.chart) addChartPoints(add, parent, block.chart, ref);
    }
    // Calculator charts: frame the existing chart. Point discovery is performed
    // only for authored reports, whose exact series are in the supplied output.
    if (!g.report) (g.charts || []).forEach((chart, index) => add(`chart/${index}`, 'chart', chart.title, { type: 'chart', chartIndex: index, cardId: 'charts' }, { description: plainText(chart.subtitle) }));
  }
  return { version: CATALOGUE_VERSION, caseFingerprint: fingerprint(modules.map(m => m.key).sort()), modules, targets, errors,
    rules: ['Values describe existing output, not new calculations.', 'STATE is module-local and never recalculates an authored report.', 'Choose beats for comprehension, not target coverage.'] };
}
function addChartPoints(add, parent, chart, ref) {
  (chart.datasets || []).forEach((series, datasetIndex) => (chart.labels || []).forEach((label, pointIndex) => {
    if (!Number.isFinite(series.data?.[pointIndex])) return;
    const value = series.data[pointIndex];
    const format = chart.display?.valueFormat;
    add(`${parent.id.split('/').slice(1).join('/')}/series/${datasetIndex}/point/${pointIndex}`, 'chart-point', `${series.label} — ${label}`, { ...ref, type: 'chart-point', datasetIndex, pointIndex, xLabel: String(label) }, { parentId: parent.id, supportedActions: ['focus'], value, displayValue: format === 'currency' ? money(value) : String(value), units: format || null, description: plainText(chart.subtitle), seriesLabel: series.label, xLabel: String(label) });
  }));
}

export function buildLivePresenterBrief(catalogue) {
  return { kind: 'planeir.live-presenter-brief', version: 1, catalogue,
    workflow: [
      'Read the forum and all module JSON. Write a source-grounded case understanding first.',
      'Write the complete spoken script before directing visuals. Use the supplied script/style reference: friendly, explanatory, educational, with a brief introduction. Let the financial question determine structure.',
      'Reread the completed script with this catalogue. Direct only beats that materially improve comprehension. Staying on a whole module for 30–60 seconds is valid; a spoken number does not require FOCUS.',
      'Create presentation.json using real target IDs. One step is one visual beat; navigation, scenario selection and focus may be operations inside that step. Never invent missing targets or financial results.',
      'Direct attention from the meaning of the completed script. FOCUS accepts emphasis: spotlight for an area, underline for a specific holding/figure, or point for an existing chart-point target. Use one treatment at a time; FRAME leaves the full context undimmed. Prefer a sustained quiet view over extra cues. Native scene dissolves and eased scrolling are handled by the controller, not by timed narration.',
      'For separate iPhone and screen recordings, a beat may include edit: {shot: "screen" | "presenter" | "hold", reason: "script-grounded reason"}. This is post-production advice only: it never switches cameras or adds cues. Prefer sustained views; do not turn every beat into a cut. Actual take logs retain request/arrival times and repeats relative to the visible SYNC slate. They are not speech transcripts.',
      'Validate the package and execute validateLive in the loaded app. Review spoken claims against source references, assumptions and module-local scenario boundaries. Report uncertain mappings.',
      'Generate script-presenter.md from script.md and the validated cue map. Every [→ LABEL] has exactly one step. Include [MANUAL ACTION — ...] only for unavoidable setup. Preview before recording.'
    ], requiredFiles: ['script.md', 'presentation.json', 'script-presenter.md', 'validation.json'],
    discovery: 'window.planeirPresenter.discover(); window.planeirPresenter.brief(); automatic local tooling: scripts/presenter-package.mjs discover <case-pack.json>' };
}
