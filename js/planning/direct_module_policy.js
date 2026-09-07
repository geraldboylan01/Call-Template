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
import { readJsonPointer, stableStringify } from './utils.js';

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

/**
 * `recite` declares that this assumption is MATERIAL TO THE CLIENT and must be
 * read back with its actual value before they confirm.
 *
 * THE DEFECT THIS FIXES. Both prompts required "material numeric financial
 * assumptions" in the read-back, and both had to infer which ones those were.
 * They disagreed: the planner said "standard cost and rate assumptions" and the
 * auditor withheld approval for eight omissions -- the DIRT rate, the mortgage
 * illustration rate, the term, the purchase costs, the deposit savings rate.
 * Materiality of a SERVER-OWNED value is a policy decision the server already
 * owns, so it is declared here once and supplied to both, rather than guessed
 * twice. It is a FLOOR: the auditor keeps its own judgement on top for
 * client-authored figures, and nothing here tells it to approve anything.
 *
 * Deliberately NOT recited: identifiers and schema versions, the ordinary
 * calculation date, a repayment discriminator with no contract alternative, an
 * unspecified optional payment, and a mode label -- the same exemptions the
 * verifier prompt already names. Reciting those would bury the figures that
 * matter under bookkeeping nobody would question.
 */
function policy(path, value, source = 'planning_policy', mode = 'fixed', recite = false) {
  return Object.freeze({ path, value, source, mode, recite });
}

/** The same declaration, for a value the client must hear read back. */
function recited(path, value, source = 'planning_policy', mode = 'fixed') {
  return policy(path, value, source, mode, true);
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
    // Whether a State Pension is counted at all, and from what age, changes the
    // answer materially and a client can check both. The fraction and the
    // escalation rate refine the same assumption and are left to the auditor's
    // own judgement rather than forced into every read-back.
    Object.freeze({ field: 'includeStatePension', value: true, source: 'planning_policy', mode: 'default', recite: true }),
    Object.freeze({ field: 'statePensionFraction', value: 1, source: 'planning_policy', mode: 'default', recite: false }),
    Object.freeze({ field: 'statePensionStartAge', value: IRISH_STATE_PENSION_CONTRIBUTORY.defaultStartAge, source: 'planning_policy', mode: 'default', recite: true }),
    Object.freeze({ field: 'statePensionEscalationRate', value: IRISH_STATE_PENSION_CONTRIBUTORY.defaultEscalationRate, source: 'planning_policy', mode: 'fixed', recite: false })
  ]),
  collegeChild: Object.freeze([
    // These are defaults, not facts. A client may name a different start age
    // or course length and the semantic planner's value must survive.
    Object.freeze({ field: 'collegeStartAge', value: PLANEIR_ASSUMPTIONS.collegeFunding.startAge, source: 'contract_default', mode: 'default', recite: true }),
    Object.freeze({ field: 'collegeDurationYears', value: PLANEIR_ASSUMPTIONS.collegeFunding.durationYears, source: 'contract_default', mode: 'default', recite: true })
  ])
});

function expandPerElement(specs, collection, prefix) {
  return (Array.isArray(collection) ? collection : []).flatMap((_item, index) => (
    specs.map((spec) => policy(`${prefix}/${index}/${spec.field}`, spec.value, spec.source, spec.mode, spec.recite === true))
  ));
}

/** The same specs, shaped for the planner's serverPolicy envelope. */
function describePerElement(specs, pathTemplate) {
  return Object.freeze({
    pathTemplate,
    fields: Object.freeze(specs.map((spec) => Object.freeze({
      field: spec.field, value: spec.value, source: spec.source, mode: spec.mode, recite: spec.recite === true
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
        targetIncomePctOfSalary: Object.freeze({ path: '/targetIncomePctOfSalary', value: 0.5, source: 'contract_default', mode: 'default', recite: true, appliesWhen: "incomeMode is 'target'" }),
        affordableEndAges: Object.freeze({ path: '/affordableEndAges', value: AFFORDABLE_END_AGE_DEFAULTS, source: 'contract_default', mode: 'default', recite: true, appliesWhen: "incomeMode is 'affordable'" })
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
        recited('/growthRate', PLANEIR_ASSUMPTIONS.investment.nominalGrowthRate),
        recited('/inflationRate', PLANEIR_ASSUMPTIONS.inflation.generalRate),
        recited('/wageGrowthRate', PLANEIR_ASSUMPTIONS.inflation.generalRate, 'planning_policy', 'default'),
        // Mode is semantic: affordable versus target comes from the client's
        // question. Target is only the documented fallback when neither was
        // expressed, never a fixed value that can overrule the AI's reading.
        policy('/incomeMode', 'target', 'contract_default', 'default'),
        recited('/horizonEndAge', 100, 'contract_default', 'default')
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
        recited('/inflationRate', PLANEIR_ASSUMPTIONS.inflation.educationRate),
        policy('/scenarios', approvedCollegeScenarios())
      ]),
      house_purchase: Object.freeze([
        policy('/schemaVersion', house.schemaVersion),
        policy('/calculationDateIso', date),
        recited('/depositSavingsGrossAer', house.depositSavingsGrossAer),
        recited('/dirtRate', house.dirtRate),
        recited('/mortgageIllustrationRate', house.mortgageIllustrationRate),
        recited('/mortgageTermYears', house.mortgageTermYears),
        recited('/purchaseCosts', house.purchaseCosts),
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
      recited('/minimumBufferMonths', reserve.minimumBufferMonths),
      recited('/targetBufferMonths', reserve.targetBufferMonths)
    );
  }
  if (moduleId === 'pension_projection') {
    if (input?.incomeMode === 'target') {
      entries.push(
        recited('/targetIncomePctOfSalary', 0.5, 'contract_default', 'default')
      );
    } else if (input?.incomeMode === 'affordable') {
      entries.push(
        recited('/affordableEndAges', AFFORDABLE_END_AGE_DEFAULTS, 'contract_default', 'default')
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
      entries[index] = recited('/purchaseCosts', {
        ...entries[index].value,
        surveyOrEngineer: survey
      });
    }
  }
  return entries;
}

/**
 * The server-owned assumptions this particular calculation actually relies on,
 * with their actual values, for the read-back the client confirms.
 *
 * SPECIFIC TO THIS CALCULATION, not a blanket recital. directModulePolicyEntries
 * is already conditional on the authored input -- the liquidity buffer resolves
 * from clientStatus, pension emits the target OR the affordable default but
 * never both, per-member and per-child entries expand only for the members and
 * children that exist, and house purchase resolves its survey cost from the
 * acquisition type. On top of that, an entry the CLIENT overrode is dropped
 * here: a parent who said their child starts at nineteen is not being told an
 * assumption, they are being read back their own answer, and the auditor
 * already covers that. What remains is the floor -- the values the client never
 * supplied, that move the result, and that they cannot check unless we say them.
 */
export function directModuleMaterialAssumptions(moduleId, input, envelope) {
  return directModulePolicyEntries(moduleId, input, envelope)
    .filter((entry) => entry.recite === true)
    .filter((entry) => {
      const actual = readJsonPointer(input, entry.path);
      return actual === undefined || stableStringify(actual) === stableStringify(entry.value);
    })
    // AN OBJECT IS NOT A VALUE ANYONE CAN READ BACK. "Recite /purchaseCosts
    // with its actual value" left both sides to decide what that meant, and
    // they decided differently: the planner said "the stated purchase costs"
    // and the auditor wanted the five amounts inside it. Neither was wrong
    // about the rule, because the rule did not say. Expanding to the scalar
    // amounts here says it once, to both, in the only form a person can check.
    .flatMap((entry) => scalarLeaves(entry.path, entry.value)
      .map(([path, value]) => Object.freeze({ path, value, source: entry.source })));
}

/**
 * Each scalar inside a policy value, addressed by its own pointer.
 *
 * Numbers and booleans only. A null is a value nobody supplied, and there is
 * nothing to read back about it; a string at a policy path is a mode
 * discriminator -- stampDutyMode "rules" -- which the auditor already exempts
 * and which no client could check. Reciting either would bury the amounts that
 * matter under bookkeeping, which is the failure this list exists to prevent.
 */
function scalarLeaves(path, value) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'number' || typeof value === 'boolean' ? [[path, value]] : [];
  }
  return Object.entries(value).flatMap(([key, nested]) => scalarLeaves(
    `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`,
    nested
  ));
}
