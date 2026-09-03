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
      pensionMemberDefaults: Object.freeze({
        includeStatePension: true,
        statePensionFraction: 1,
        statePensionStartAge: IRISH_STATE_PENSION_CONTRIBUTORY.defaultStartAge,
        statePensionEscalationRate: IRISH_STATE_PENSION_CONTRIBUTORY.defaultEscalationRate
      }),
      pensionModeDefaults: Object.freeze({
        incomeMode: 'target',
        targetIncomePctOfSalary: 0.5,
        affordableEndAges: AFFORDABLE_END_AGE_DEFAULTS
      }),
      collegeChildPolicy: Object.freeze({
        collegeStartAge: PLANEIR_ASSUMPTIONS.collegeFunding.startAge,
        collegeDurationYears: PLANEIR_ASSUMPTIONS.collegeFunding.durationYears
      })
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
        policy('/fixedPaymentAmount', null, 'contract_default', 'default'),
        policy('/oneOffOverpayment', 0, 'contract_default', 'default'),
        policy('/annualOverpayment', 0, 'contract_default', 'default')
      ]),
      loan_analysis: Object.freeze([
        policy('/loanKind', 'loan'),
        policy('/startDateIso', date),
        policy('/repaymentType', 'repayment'),
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
    (Array.isArray(input?.pensions) ? input.pensions : []).forEach((_member, index) => {
      entries.push(
        policy(`/pensions/${index}/includeStatePension`, true, 'planning_policy', 'default'),
        policy(`/pensions/${index}/statePensionFraction`, 1, 'planning_policy', 'default'),
        policy(`/pensions/${index}/statePensionStartAge`, IRISH_STATE_PENSION_CONTRIBUTORY.defaultStartAge, 'planning_policy', 'default'),
        policy(`/pensions/${index}/statePensionEscalationRate`, IRISH_STATE_PENSION_CONTRIBUTORY.defaultEscalationRate)
      );
    });
  }
  if (moduleId === 'college_funding') {
    (Array.isArray(input?.children) ? input.children : []).forEach((_child, index) => {
      entries.push(
        // These are defaults, not facts. A client may name a different start
        // age or course length and the semantic planner's value must survive.
        policy(`/children/${index}/collegeStartAge`, PLANEIR_ASSUMPTIONS.collegeFunding.startAge, 'contract_default', 'default'),
        policy(`/children/${index}/collegeDurationYears`, PLANEIR_ASSUMPTIONS.collegeFunding.durationYears, 'contract_default', 'default')
      );
    });
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
