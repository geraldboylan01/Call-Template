import { buildPresentationCatalogue } from '../../presenter_catalogue.js';
import { computePersonalBalanceSheet } from '../../personal_balance_sheet.js';
import { computeHouseholdCashFlowProjection } from '../../household_cash_flow_math.js';
import { euroText as cashFlowEuroText } from '../../household_cash_flow_view.js';
import { computeProtectionGapProjection, euroText as protectionEuroText } from '../../protection_gap_math.js';
import { resolveLiquidityReserveForPlan } from '../../module_pipeline.js';
import { PLANEIR_ASSUMPTIONS_VERSION } from '../planeir_assumptions.js';
import { IE_TAX_RULES_VERSION } from '../tax/rules_ie.js';
import { figuresVersionLabel } from '../figures/get_figures.js';
import { pointerValue } from './story_registry.js';
import { storyDisplay, shownMoneyValue } from './story_display.js';
import { propertyMoveChapter, propertyMoveRows } from './property_move_story.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function nativeFigure(entry, source, compiled, target) {
  if (source.chapter === 'property_move') {
    const ledger = compiled.resourceLedger.routes.find(row => row.routeId === source.routeId);
    const property = compiled.source.normalizedPlanPack.household.properties.find(row => row.propertyId === ledger.propertyMove.propertyId);
    const built = propertyMoveChapter(ledger.propertyMove, property);
    if (!same(entry.input, built.input) || !same(entry.payload, built.payload) || !same(entry.metrics, built.metrics)) throw new Error('The transaction module differs from its priced ledger.');
    const row = propertyMoveRows(ledger.propertyMove, property).find(row => row.key === source.path.split('/').at(-1));
    if (!row || source.nativeCaseId !== null) throw new Error('No matching transaction figure.');
    return { value: row.value, unit: row.unit, display: row.display, targetValue: row.display };
  }
  const metric = source.path?.split('/metrics/')[1]?.replaceAll('~1', '/').replaceAll('~0', '~');
  if (source.chapter === 'personal_balance_sheet') {
    if (source.nativeCaseId !== 'current' || !['base', 'current'].includes(entry.nativeCaseId)) throw new Error('The balance sheet link must open the compiled current-position case.');
    const result = computePersonalBalanceSheet(entry.input);
    if (!metric || !Number.isFinite(result[metric])) throw new Error('This balance-sheet result has no independently calculated metric to link.');
    return { value: result[metric], unit: entry.input.currency, display: target.displayValue };
  }
  if (source.chapter === 'liquidity_analysis') {
    if (source.nativeCaseId !== null) throw new Error('The reserve module has no native scenario to select.');
    const { reserve } = resolveLiquidityReserveForPlan(entry.input);
    const value = metric === 'targetCash' ? reserve.targetCash : metric === 'currentCash' ? entry.input.currentCash : undefined;
    return { value, unit: 'EUR', display: target.displayValue };
  }
  if (source.chapter === 'protection_gap') {
    if (!metric || metric.split('.')[0] !== source.nativeCaseId) throw new Error('The protection figure must select its own compiled income-stop or death case.');
    const field = metric.slice(source.nativeCaseId.length + 1);
    const projection = computeProtectionGapProjection(entry.input);
    const scenario = projection.debug.cases.find(row => row.id === source.nativeCaseId);
    if (!scenario) throw new Error('The protection scenario is absent from the compiled chapter.');
    return { value: scenario[field], unit: field === 'months' ? 'months' : 'EUR/year',
      display: field === 'months' ? String(scenario[field]) : protectionEuroText(scenario[field]) };
  }
  if (source.chapter === 'household_cash_flow') {
    if (source.nativeCaseId !== entry.nativeCaseId) throw new Error('The cash-flow link must open the compiled route scenario.');
    const projection = computeHouseholdCashFlowProjection(entry.input, { calculationYear: Number(compiled.calculationDate.slice(0, 4)) });
    const summary = projection.summary.cases.find(row => row.id === source.nativeCaseId);
    const model = projection.debug.cases.find(row => row.id === source.nativeCaseId || row.scenario?.id === source.nativeCaseId);
    const values = { income: summary?.income.total, bankTakeHome: summary?.takeHome.bankTotal, tax: summary?.outgoings.tax,
      pensions: summary?.outgoings.pensionContributions, leftOver: summary?.leftOver.amount };
    const shown = { income: model?.shownIncome, tax: model?.lines.find(row => row.id === 'tax')?.shownAmount,
      pensions: model?.lines.find(row => row.id === 'pensions')?.shownAmount, leftOver: summary?.leftOver.shown };
    if (!(metric in values) || !Number.isFinite(shown[metric])) throw new Error('This per-person or undisplayed cash-flow figure has no exact native screen target.');
    return { value: values[metric], unit: 'EUR/year', display: cashFlowEuroText(shown[metric]), targetValue: shown[metric] };
  }
  throw new Error('No exact linked-figure adapter exists for this compiled module.');
}

/** Inspect the actual compiled case and replay its engine, never samples. */
export function checkStoryLink(compiled, fact, path) {
  const source = fact.source;
  const refuse = (code, message) => ({ ok: false, refusal: { code, path, message } });
  if (!source || (!source.chapter && source.panel !== 'plan_facts')) return refuse('unlinkable_fact', 'This fact has no registered module or compiled plan panel to open.');
  if (source.chapter && source.panel) return refuse('unlinkable_fact', 'A source must identify a module or a plan panel, rather than both.');
  for (const [key, value] of Object.entries(compiled.versions)) if (source.versions?.[key] !== value) return refuse('link_versions', 'The linked fact and compiled plan use different calculation versions.');
  if (!source.chapter) {
    if (source.caseId || source.nativeCaseId || source.focusTargetId) return refuse('link_case', 'A plan-panel fact cannot also select a module case.');
    if (source.path && !same(pointerValue(compiled, source.path), fact.value)) return refuse('link_value', 'The linked plan fact differs from its compiled source.');
    if (!source.path && !source.calculation) return refuse('unlinkable_fact', 'A plan-panel link needs a code-produced calculation or an exact compiled pointer.');
    return { ok: true, key: fact.key, value: fact.value, unit: fact.unit, display: fact.display, source };
  }
  if (compiled.versions.assumptions !== PLANEIR_ASSUMPTIONS_VERSION || compiled.versions.taxRules !== IE_TAX_RULES_VERSION
    || compiled.versions.figures !== figuresVersionLabel()) return refuse('link_versions', 'Recompile with the matching engines and register before checking a module link.');
  const route = compiled.routes.find(row => row.id === source.routeId);
  if (!route || route.chapterCases[source.chapter] !== source.caseId) return refuse('link_case', 'The link does not select this compiled route’s chapter case.');
  const chapterIndex = compiled.chapters.findIndex(row => row.id === source.chapter);
  const caseIndex = compiled.chapters[chapterIndex]?.cases.findIndex(row => row.id === source.caseId) ?? -1;
  const entry = compiled.chapters[chapterIndex]?.cases[caseIndex];
  if (!entry || !source.path?.startsWith(`/chapters/${chapterIndex}/cases/${caseIndex}/`)) return refuse('link_case', 'The fact pointer is outside the linked compiled case.');
  if (!same(pointerValue(compiled, source.path), fact.value)) return refuse('link_value', 'The linked fact differs from the figure held by its compiled chapter.');
  try {
    const catalogue = buildPresentationCatalogue({ modules: [{ id: entry.id, title: entry.payload.title,
      generated: { ...entry.payload.generated, ...entry.derived } }] });
    const target = catalogue.targets.find(row => row.id === source.focusTargetId);
    if (!target?.available) return refuse('link_target', 'The compiled presenter catalogue has no available exact focus target for this figure.');
    if (target.scenarioId !== undefined && target.scenarioId !== source.nativeCaseId) return refuse('link_case', 'The focus target belongs to another native scenario.');
    const shown = nativeFigure(entry, source, compiled, target);
    if (shown.value === undefined || !same(fact.value, shown.value)) return refuse('link_value', 'The story figure differs from the native module calculation for this route’s case.');
    if (fact.unit !== shown.unit || target.units && target.units !== shown.unit) return refuse('link_unit', 'The story and linked module measure this figure in different units.');
    const targetValue = shown.targetValue ?? shown.value;
    if (!same(target.value, targetValue) && !target.cells?.some(cell => same(cell, targetValue))) return refuse('link_target', 'The selected target does not show this calculated figure.');
    if (['EUR', 'EUR/year', 'EUR/month'].includes(shown.unit)) shown.display = storyDisplay(shownMoneyValue(shown.display), shown.unit);
    if (fact.display !== shown.display) return refuse('link_display', 'The linked figure must read exactly as the module formats it: ' + shown.display + '.');
    return { ok: true, key: fact.key, ...shown, source };
  } catch (error) { return refuse('link_calculation', error.message); }
}
