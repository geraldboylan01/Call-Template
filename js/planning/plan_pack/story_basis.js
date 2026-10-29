import { SECTIONS, APPLICATION_SCHEMA, APPLICATION_SCHEMA_VERSION } from '../../case_application/schema.js';
import { readJsonPointer } from '../utils.js';
import { PLANEIR_ASSUMPTIONS, PLANEIR_ASSUMPTIONS_VERSION } from '../planeir_assumptions.js';
import { figuresVersionLabel, getFigures } from '../figures/get_figures.js';

const ENGINES = Object.freeze({
  personal_balance_sheet: 'personal_balance_sheet', liquidity_analysis: 'resolveLiquidityReserveForPlan',
  household_cash_flow: 'household_cash_flow_math', protection_gap: 'protection_gap_math',
  mortgage_analysis: 'mortgage_math', loan_analysis: 'mortgage_math', pension_projection: 'pension_math',
  college_funding: 'college_funding_math', future_cost_fund: 'future_cost_fund_math',
  property_move: 'property_moves', net_retirement_cashflow: 'net_retirement_math'
});
function question(path) {
  for (const section of SECTIONS) {
    const field = section.fields?.find(row => row.path === path)
      ?? (section.repeater && new RegExp('^' + section.repeater.path.replaceAll('.', '\\.') + '\\.\\d+\\.[^.]+$').test(path)
        ? section.repeater.fields.find(row => row.key === path.split('.').at(-1)) : null);
    if (field) return { path, label: field.label, type: field.type, sectionId: section.id };
  }
  // These are form controls rather than fields inside a section.
  if (path.startsWith('topics.')) return { path, label: 'What would you like to understand?', type: 'topics', sectionId: 'topics' };
  return { path, label: null, reason: 'The recorded form question is not in this schema version.' };
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const scalar = value => value && typeof value === 'object' && value.currency === 'EUR' ? value.amount : value;

/** Describes evidence already retained by the compiled plan; never infers an answer. */
export class StoryBasis {
  constructor(registry) { this.r = registry; }
  calculated(engine, source, extra = {}) {
    return { kind: 'calculated', engine, calculation: source.calculation ?? 'compiled_result',
      inputs: [...(source.inputs ?? (source.path ? [source.path] : []))], ...extra };
  }
  stated(path, value) {
    const r = this.r, originalPrefix = '/source/normalizedPlanPack/household';
    const prefix = path.startsWith(r.householdPath + '/') ? r.householdPath : path.startsWith(originalPrefix + '/') ? originalPrefix : null;
    if (!prefix) return { kind: 'stated', inputPath: path, formQuestions: [], origin: 'plan_pack',
      reason: { code: 'no_form_provenance', message: 'This plan input has no recorded form question.' } };
    const profilePath = path.slice(prefix.length), profile = prefix === originalPrefix ? r.pack.household : r.household;
    const metadataPath = Object.keys(profile.fieldMetadata ?? {}).filter(key => profilePath === key || profilePath.startsWith(key + '/'))
      .sort((a, b) => b.length - a.length)[0];
    const metadata = profile.fieldMetadata?.[metadataPath], application = metadata?.application;
    const currentSchema = application?.schema === APPLICATION_SCHEMA && application?.version === APPLICATION_SCHEMA_VERSION;
    const formQuestions = (application?.paths ?? []).map(path => currentSchema ? question(path)
      : { path, label: null, reason: 'The recorded form schema version is unavailable; its question wording is not guessed.' });
    const stated = { kind: 'stated', inputPath: path, profilePath, origin: profile.source, formQuestions,
      ...(application ? { form: { schema: application.schema, version: application.version, revision: application.revision ?? null,
        mappingVersion: application.mappingVersion, confirmedAt: profile.confirmedAt ?? null } } : {}),
      ...(!formQuestions.length ? { reason: { code: 'no_form_provenance', message: 'This household input has no recorded form question.' } } : {}) };
    const original = scalar(readJsonPointer(r.pack.household, profilePath));
    // A route can retain the original metadata after changing a balance. It is
    // then a calculated route value, never a newly stated answer.
    if (r.route.id !== 'current' && !equal(original, value)) return this.calculated('resource_ledger',
      { inputs: [path, r.routePath + '/changes'], calculation: 'route_changed_stated_fact' },
      { evidence: [{ ...stated, inputPath: originalPrefix + profilePath }] });
    if (application?.derivation) return this.calculated('application_to_profile', { inputs: [path], calculation: 'form_to_profile_derivation' },
      { description: application.derivation, evidence: [stated] });
    return stated;
  }
  cashRateEvidence() {
    const r = this.r;
    if (r.compiled.versions.assumptions !== PLANEIR_ASSUMPTIONS_VERSION || r.compiled.versions.figures !== figuresVersionLabel()) return [];
    const cash = PLANEIR_ASSUMPTIONS.cash;
    const dirt = getFigures({ onDate: r.compiled.calculationDate, kinds: ['law'] }).find(row => /^ie\.dirt\.[^.]+\.rate$/.test(row.id));
    return [{ kind: 'assumption', assumptionId: 'cash.instantAccessGrossRate', value: cash.instantAccessGrossRate,
      version: PLANEIR_ASSUMPTIONS_VERSION, description: cash.basis, disclosure: cash.disclosure,
      figureId: cash.figureId, checkedOn: cash.checkedOn }, ...(dirt ? [{ kind: 'official', registerId: dirt.id, value: dirt.value,
        source: { ...dirt.source }, checkedOn: dirt.checkedOn, catalogueVersion: dirt.catalogueVersion }] : [])];
  }
  for(key, value, source) {
    const r = this.r;
    if (key === 'position.reserveMonths' && r.compiled.versions.assumptions === PLANEIR_ASSUMPTIONS_VERSION) {
      const status = r.ledger?.reserve?.input?.clientStatus ?? r.chapter('liquidity_analysis')?.entry.input.clientStatus;
      const policyVersion = r.ledger?.reserve?.input?.policyVersion ?? r.chapter('liquidity_analysis')?.entry.input.policyVersion;
      const policy = status === 'retired' ? 'retired' : status === 'not-retired' ? 'working' : null;
      const assumption = policy && PLANEIR_ASSUMPTIONS.liquidity[policy];
      if (assumption?.targetBufferMonths === value && policyVersion === PLANEIR_ASSUMPTIONS.liquidity.policyVersion) return { kind: 'assumption', assumptionId: `liquidity.${policy}.targetBufferMonths`,
        version: PLANEIR_ASSUMPTIONS_VERSION, policyVersion: PLANEIR_ASSUMPTIONS.liquidity.policyVersion,
        description: assumption.basis, disclosure: PLANEIR_ASSUMPTIONS.liquidity.disclosure };
    }
    if (source.statedPath) return this.stated(source.statedPath, value);
    let engine = source.engine ?? ENGINES[source.chapter]
      ?? (source.path?.startsWith('/resourceLedger/') ? 'resource_ledger' : 'story_facts');
    if (source.calculation?.startsWith('native_tax_')) engine = 'irish_tax_engine';
    if (source.calculation?.startsWith('native_amortisation') || source.calculation === 'native_contract_end') engine = 'mortgage_math';
    if (source.calculation === 'central_cash_rate_after_dirt') return this.calculated('irish_tax_engine', source, { evidence: this.cashRateEvidence() });
    return this.calculated(engine, source);
  }
}
