import { createDefaultHousePurchaseInputs } from '../house_purchase/index.js';
import { DEFAULT_HOUSE_PURCHASE_RULES } from '../house_purchase/config.js';
import { LIQUIDITY_RESERVE_POLICY, resolveLiquidityReservePolicy } from '../liquidity_reserve.js';
import {
  PLANEIR_ASSUMPTIONS,
  PLANEIR_ASSUMPTIONS_VERSION,
  approvedCollegeScenarios
} from './planeir_assumptions.js';
import {
  IRELAND_RULES_CATALOGUE_VERSION,
  IRISH_STATE_PENSION_CONTRIBUTORY
} from './ireland_rules.js';

/**
 * Version of the server-owned portion of direct module inputs.
 *
 * This is deliberately not a semantic mapper. It contains only values that the
 * existing deterministic modules or central Planéir policy already own. Client
 * facts (amounts, owners, goals, corrections and collection completion) never
 * enter here and remain authored by the semantic model.
 */
export const DIRECT_MODULE_POLICY_VERSION = 'direct-module-policy-1.1.0';
const AFFORDABLE_END_AGE_DEFAULTS = Object.freeze([85, 90, 95, 100]);

function policy(path, value, source = 'planning_policy', mode = 'fixed') {
  return Object.freeze({ path, value, source, mode });
}

/**
 * Per-element policy, defined once.
 *
 * These values apply to an array element whose index only exists once the
 * planner has authored the array, so they cannot be listed as fixed module
 * paths. The planner is shown them, and directModulePolicyEntries() expands
 * the same specs into the indexed paths the disclosure check asserts.
 *
 * SOURCE AND MODE TRAVEL WITH THE VALUE. A disclosure is refused unless its
 * source tag matches exactly, so showing the planner a bare value and asking
 * it to guess the tag made a correct disclosure impossible -- and one wrong
 * guess fails the whole pass, not just the field.
 */
const PER_ELEMENT_POLICY = Object.freeze({
  pensionMember: Object.freeze([
    Object.freeze({ field: 'includeStatePension', value: true, source: 'planning_policy', mode: 'default' }),
    Object.freeze({ field: 'statePensionFraction', value: 1, source: 'planning_policy', mode: 'default' }),
    Object.freeze({ field: 'statePensionStartAge', value: IRISH_STATE_PENSION_CONTRIBUTORY.defaultStartAge, source: 'planning_policy', mode: 'default' }),
    Object.freeze({ field: 'statePensionEscalationRate', value: IRISH_STATE_PENSION_CONTRIBUTORY.defaultEscalationRate, source: 'planning_policy', mode: 'fixed' })
  ]),
  collegeChild: Object.freeze([
    // These are defaults, not facts. A client may name a different start age
    // or course length and the semantic planner's value must survive.
    Object.freeze({ field: 'collegeStartAge', value: PLANEIR_ASSUMPTIONS.collegeFunding.startAge, source: 'contract_default', mode: 'default' }),
    Object.freeze({ field: 'collegeDurationYears', value: PLANEIR_ASSUMPTIONS.collegeFunding.durationYears, source: 'contract_default', mode: 'default' })
  ])
});

function expandPerElement(specs, collection, prefix) {
  return (Array.isArray(collection) ? collection : []).flatMap((_item, index) => (
    specs.map((spec) => policy(`${prefix}/${index}/${spec.field}`, spec.value, spec.source, spec.mode))
  ));
}

/** The same specs, shaped for the planner's serverPolicy envelope. */
function describePerElement(specs, pathTemplate) {
  return Object.freeze({
    pathTemplate,
    fields: Object.freeze(specs.map((spec) => Object.freeze({
      field: spec.field, value: spec.value, source: spec.source, mode: spec.mode
    })))
  });
}

function validCalculationDate(value) {
  const date = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('A calculationDateIso is required for direct module policy.');
  }
  return date;
}

/** Values supplied to the semantic planner and independently enforced later. */
export function buildDirectModulePolicyEnvelope({ calculationDateIso, baseCurrency = 'EUR' } = {}) {
  const date = validCalculationDate(calculationDateIso);
  const year = Number(date.slice(0, 4));
  const currency = String(baseCurrency || 'EUR').trim().toUpperCase() || 'EUR';
  const house = createDefaultHousePurchaseInputs(date);
  return Object.freeze({
    version: DIRECT_MODULE_POLICY_VERSION,
    assumptionsVersion: PLANEIR_ASSUMPTIONS_VERSION,
    irelandRulesVersion: IRELAND_RULES_CATALOGUE_VERSION,
    calculationDateIso: date,
    baseCurrency: currency,
    conditionalPolicy: Object.freeze({
      liquidityAnalysis: Object.freeze({
        selectorPath: '/clientStatus',
        policyVersion: LIQUIDITY_RESERVE_POLICY.policyVersion,
        working: LIQUIDITY_RESERVE_POLICY.working,
        retired: LIQUIDITY_RESERVE_POLICY.retired
      }),
      pensionMemberDefaults: describePerElement(PER_ELEMENT_POLICY.pensionMember, '/pensions/{index}'),
      pensionModeDefaults: Object.freeze({
        incomeMode: Object.freeze({ path: '/incomeMode', value: 'target', source: 'contract_default', mode: 'default' }),
        targetIncomePctOfSalary: Object.freeze({ path: '/targetIncomePctOfSalary', value: 0.5, source: 'contract_default', mode: 'default', appliesWhen: "incomeMode is 'target'" }),
        affordableEndAges: Object.freeze({ path: '/affordableEndAges', value: AFFORDABLE_END_AGE_DEFAULTS, source: 'contract_default', mode: 'default', appliesWhen: "incomeMode is 'affordable'" })
      }),
      collegeChildPolicy: describePerElement(PER_ELEMENT_POLICY.collegeChild, '/children/{index}')
    }),
    modules: Object.freeze({
      personal_balance_sheet: Object.freeze([
        policy('/currency', currency),
        policy('/reconciliationWarnings', []),
        policy('/currencyWarnings', []),
        policy('/monthlyExpenditure', null, 'contract_default', 'default')
      ]),
      pension_projection: Object.freeze([
        policy('/currentYear', year),
        policy('/growthRate', PLANEIR_ASSUMPTIONS.investment.nominalGrowthRate),
        policy('/inflationRate', PLANEIR_ASSUMPTIONS.inflation.generalRate),
        policy('/wageGrowthRate', PLANEIR_ASSUMPTIONS.inflation.generalRate, 'planning_policy', 'default'),
        // Mode is semantic: affordable versus target comes from the client's
        // question. Target is only the documented fallback when neither was
        // expressed, never a fixed value that can overrule the AI's reading.
        policy('/incomeMode', 'target', 'contract_default', 'default'),
        policy('/horizonEndAge', 100, 'contract_default', 'default')
      ]),
      liquidity_analysis: Object.freeze([]),
      mortgage_analysis: Object.freeze([
        policy('/loanKind', 'mortgage'),
        policy('/startDateIso', date),
        policy('/repaymentType', 'repayment'),
        // The engine takes an end date OR a remaining term. The playbook tells
        // the planner to null the one the client did not give, so "no end date
        // was supplied" has to be a declarable default like any other -- with
        // no entry here the planner does exactly as instructed and the ready
        // snapshot is then refused for an unevidenced leaf it could not omit.
        // Declaring it changes nothing a client says: a stated end date is
        // still authored and still carries its own evidence.
        policy('/endDateIso', null, 'contract_default', 'default'),
        policy('/fixedPaymentAmount', null, 'contract_default', 'default'),
        policy('/oneOffOverpayment', 0, 'contract_default', 'default'),
        policy('/annualOverpayment', 0, 'contract_default', 'default')
      ]),
      loan_analysis: Object.freeze([
        policy('/loanKind', 'loan'),
        policy('/startDateIso', date),
        policy('/repaymentType', 'repayment'),
        policy('/endDateIso', null, 'contract_default', 'default'),
        policy('/fixedPaymentAmount', null, 'contract_default', 'default'),
        policy('/oneOffOverpayment', 0, 'contract_default', 'default'),
        policy('/annualOverpayment', 0, 'contract_default', 'default')
      ]),
      college_funding: Object.freeze([
        policy('/currentYear', year),
        policy('/inflationRate', PLANEIR_ASSUMPTIONS.inflation.educationRate),
        policy('/scenarios', approvedCollegeScenarios())
      ]),
      house_purchase: Object.freeze([
        policy('/schemaVersion', house.schemaVersion),
        policy('/calculationDateIso', date),
        policy('/depositSavingsGrossAer', house.depositSavingsGrossAer),
        policy('/dirtRate', house.dirtRate),
        policy('/mortgageIllustrationRate', house.mortgageIllustrationRate),
        policy('/mortgageTermYears', house.mortgageTermYears),
        policy('/purchaseCosts', house.purchaseCosts),
        policy('/emergencyReserveMode', 'suggested', 'contract_default', 'default'),
        policy('/emergencyReserveTarget', null, 'contract_default', 'default'),
        policy('/intendedUse', 'principal_private_residence')
      ])
    })
  });
}

/**
 * Expand policy that depends only on an already-semantic field (for example the
 * AI-authored retired/working cohort). The deterministic choice is the module's
 * own policy lookup, not an interpretation of the transcript.
 */
export function directModulePolicyEntries(moduleId, input, envelope) {
  const entries = [...(envelope?.modules?.[moduleId] || [])];
  if (moduleId === 'liquidity_analysis') {
    const reserve = resolveLiquidityReservePolicy(input?.clientStatus);
    entries.push(
      policy('/policyVersion', LIQUIDITY_RESERVE_POLICY.policyVersion),
      policy('/minimumBufferMonths', reserve.minimumBufferMonths),
      policy('/targetBufferMonths', reserve.targetBufferMonths)
    );
  }
  if (moduleId === 'pension_projection') {
    if (input?.incomeMode === 'target') {
      entries.push(
        policy('/targetIncomePctOfSalary', 0.5, 'contract_default', 'default')
      );
    } else if (input?.incomeMode === 'affordable') {
      entries.push(
        policy('/affordableEndAges', AFFORDABLE_END_AGE_DEFAULTS, 'contract_default', 'default')
      );
    }
    entries.push(...expandPerElement(PER_ELEMENT_POLICY.pensionMember, input?.pensions, '/pensions'));
  }
  if (moduleId === 'college_funding') {
    entries.push(...expandPerElement(PER_ELEMENT_POLICY.collegeChild, input?.children, '/children'));
  }
  if (moduleId === 'house_purchase') {
    const acquisition = String(input?.acquisitionType || 'unknown');
    const survey = DEFAULT_HOUSE_PURCHASE_RULES.purchaseCosts
      .surveyOrEngineerByAcquisition[acquisition]
      ?? DEFAULT_HOUSE_PURCHASE_RULES.purchaseCosts.surveyOrEngineerByAcquisition.unknown;
    const index = entries.findIndex((entry) => entry.path === '/purchaseCosts');
    if (index >= 0) {
      entries[index] = policy('/purchaseCosts', {
        ...entries[index].value,
        surveyOrEngineer: survey
      });
    }
  }
  return entries;
}
