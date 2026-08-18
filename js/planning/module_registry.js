import { MODULE_IDS } from './contracts.js';
import { normalizeHouseholdProfile } from './profile.js';
import { MODULE_FAILURE_CODES, ModuleFailureError } from './module_failures.js';
import { liquidityConversationGuidance } from '../liquidity_reserve.js';
import { pensionConversationGuidance } from '../pension_math.js';
import {
  buildLiquidityInput,
  getLiquidityReadiness,
  runLiquidityAnalysis,
  validateLiquidityInput
} from './adapters/liquidity.js';
import {
  buildHousePurchaseInput,
  getHousePurchaseReadiness,
  runHousePurchaseAnalysis,
  validateHousePurchaseInput
} from './adapters/house_purchase.js';
import {
  buildNetRetirementInput,
  buildPensionProjectionInput,
  getNetRetirementReadiness,
  getPensionProjectionReadiness,
  runNetRetirementCashflow,
  runPensionProjection
} from './adapters/retirement.js';
import {
  buildMortgageInput,
  getMortgageReadiness,
  runMortgageAnalysis,
  validateMortgageInput
} from './adapters/mortgage.js';
import {
  buildLoanInput,
  getLoanReadiness,
  runLoanAnalysis,
  validateLoanInput
} from './adapters/loan.js';
import {
  buildCollegeFundingInput,
  getCollegeFundingReadiness,
  runCollegeFundingAnalysis
} from './adapters/college_funding.js';
import {
  buildPersonalBalanceSheetInput,
  getPersonalBalanceSheetReadiness,
  runPersonalBalanceSheet,
  validatePersonalBalanceSheetInput
} from './adapters/personal_balance_sheet.js';
import { readJsonPointer, sha256Json } from './utils.js';
import {
  PLANNING_PLAYBOOK_MANIFEST,
  PLANNING_PLAYBOOK_MANIFEST_VERSION
} from './playbook_manifest.generated.js';

export const MODULE_INTAKE_CONTRACT_VERSION = 'consumer-module-intake-1.0.0';

const MODULE_INTAKE_MODES = Object.freeze(['calculation', 'composition', 'adviser_handoff']);
const MODULE_INTAKE_STATUSES = Object.freeze(['approved', 'incomplete']);

const INTAKE_FACTS = Object.freeze({
  [MODULE_IDS.LIQUIDITY]: Object.freeze([
    'primary_goal', 'cash_savings', 'monthly_spending', 'retirement_status'
  ]),
  [MODULE_IDS.HOUSE_PURCHASE]: Object.freeze([
    'primary_goal', 'partner_person', 'target_home_price', 'income_sources', 'gross_household_income',
    'cash_savings', 'liability_position', 'liability_monthly_payment', 'monthly_spending',
    'current_monthly_rent', 'lending_category',
    'household_structure'
  ]),
  [MODULE_IDS.PENSION_PROJECTION]: Object.freeze([
    'primary_goal', 'partner_person', 'pension_positions', 'person_current_age', 'intended_retirement_age',
    'income_sources', 'gross_household_income', 'pension_current_value',
    'pension_contribution_status',
    'pension_employee_contribution_rate', 'pension_employer_contribution_rate',
    'pension_projected_annual_income', 'pension_benefit_start_age', 'pension_retirement_lump_sum',
    'target_retirement_income'
  ]),
  [MODULE_IDS.NET_RETIREMENT]: Object.freeze([
    'primary_goal', 'person_current_age', 'annual_net_spending', 'income_sources',
    'asset_position'
  ]),
  [MODULE_IDS.MORTGAGE]: Object.freeze([
    'primary_goal', 'mortgage_position', 'mortgage_current_balance',
    'mortgage_annual_interest_rate', 'mortgage_remaining_term_months'
  ]),
  [MODULE_IDS.LOAN]: Object.freeze([
    'primary_goal', 'loan_position', 'loan_current_balance',
    'loan_annual_interest_rate', 'loan_remaining_term_months'
  ]),
  [MODULE_IDS.COLLEGE_FUNDING]: Object.freeze([
    'primary_goal', 'dependants', 'dependant_current_age', 'college_cost_scenarios'
  ]),
  [MODULE_IDS.PERSONAL_BALANCE_SHEET]: Object.freeze([
    'primary_goal', 'partner_person', 'asset_position', 'liability_position', 'property_position',
    'business_position', 'pension_positions', 'pension_current_value',
    // Monthly spending is what turns a pile of reserves into "how long could we
    // last". The module has always read it -- /expenses is already an optional
    // profile path -- but it was absent from the intake contract, so the meeting
    // had no reason to ask and reserveMonths could never be computed. It is
    // asked for, never required: plenty of people do not know what they spend.
    'monthly_spending',
    'specialist_asset_reconciliation'
  ])
});

function approvedIntake(mode, semanticFactIds, getIntakeReadiness, composedModuleIds = []) {
  return {
    version: MODULE_INTAKE_CONTRACT_VERSION,
    mode,
    status: 'approved',
    semanticFactIds,
    composedModuleIds,
    getIntakeReadiness
  };
}

function incompleteIntake(mode, reason, semanticFactIds = []) {
  return {
    version: MODULE_INTAKE_CONTRACT_VERSION,
    mode,
    status: 'incomplete',
    semanticFactIds,
    composedModuleIds: [],
    getIntakeReadiness: () => ({
      status: 'intake_contract_incomplete',
      requiredMissing: [],
      assumptionsUsed: [],
      warnings: [reason]
    })
  };
}

function withRequiredPartnerForCouple(getReadiness, moduleId) {
  return (profile) => {
    const readiness = getReadiness(profile);
    if (['not_relevant', 'adviser_review_required', 'unsupported', 'intake_contract_incomplete'].includes(readiness.status)) {
      return readiness;
    }
    const householdStructure = profile.assumptions?.values?.persona?.householdStructure;
    if (householdStructure !== 'couple' || profile.partner?.personId) return readiness;
    return {
      ...readiness,
      status: 'missing_information',
      requiredMissing: [{
        fieldPath: '/partner',
        reason: 'Add the partner as a separate household person before collecting joint positions.',
        blockingModuleIds: [moduleId],
        importance: 'required'
      }, ...(readiness.requiredMissing || [])]
    };
  };
}

function withTerminalConfirmedNone(getReadiness, moduleId, terminalPaths) {
  return (profile) => {
    const readiness = getReadiness(profile);
    if (['not_relevant', 'adviser_review_required', 'unsupported', 'intake_contract_incomplete'].includes(readiness.status)) {
      return readiness;
    }
    const markers = profile.assumptions?.values?.completionFacts?.confirmedNonePaths || {};
    const terminalPath = terminalPaths.find((path) => markers[path] === true
      && (readiness.requiredMissing || []).some((item) => (
        item.fieldPath === path || item.fieldPath.startsWith(`${path}/`)
      )));
    if (!terminalPath) return readiness;
    return {
      status: 'adviser_review_required',
      requiredMissing: [],
      assumptionsUsed: readiness.assumptionsUsed || [],
      warnings: [
        ...(readiness.warnings || []),
        `${moduleId} cannot calculate after the household explicitly confirmed no data at ${terminalPath}; stop intake for adviser review.`
      ]
    };
  };
}

function withRequiredReviewedInputs(getReadiness, moduleId, inputs) {
  return (profile) => {
    const readiness = getReadiness(profile);
    if (['not_relevant', 'adviser_review_required', 'unsupported', 'intake_contract_incomplete'].includes(readiness.status)) {
      return readiness;
    }
    const markers = profile.assumptions?.values?.completionFacts?.confirmedNonePaths || {};
    const additions = inputs
      .filter((input) => !input.hasValue(profile)
        && !(input.confirmedNonePaths || [input.fieldPath]).some((path) => markers[path] === true))
      .filter((input) => !(readiness.requiredMissing || []).some((item) => item.fieldPath === input.fieldPath))
      .map((input) => ({
        fieldPath: input.fieldPath,
        reason: input.reason,
        blockingModuleIds: [moduleId],
        importance: 'required'
      }));
    if (additions.length === 0) return readiness;
    return {
      ...readiness,
      status: 'missing_information',
      requiredMissing: [...(readiness.requiredMissing || []), ...additions]
    };
  };
}

function hasMoney(value, currency) {
  return Boolean(value && value.currency === currency && Number.isFinite(value.amount));
}

function withReviewedLiabilityPayments(getReadiness, moduleId) {
  return (profile) => {
    const readiness = getReadiness(profile);
    if (['not_relevant', 'adviser_review_required', 'unsupported', 'intake_contract_incomplete'].includes(readiness.status)) {
      return readiness;
    }
    const additions = profile.liabilities.flatMap((liability, index) => (
      hasMoney(liability.monthlyPayment, profile.preferences.baseCurrency)
        ? []
        : [{
          fieldPath: `/liabilities/${index}/monthlyPayment`,
          entityId: liability.liabilityId,
          reason: `Add the reviewed monthly payment for ${liability.label}, including zero if there is no payment.`,
          blockingModuleIds: [moduleId],
          importance: 'required'
        }]
    ));
    if (additions.length === 0) return readiness;
    return {
      ...readiness,
      status: 'missing_information',
      requiredMissing: [...(readiness.requiredMissing || []), ...additions]
    };
  };
}

function combineIntakeReadiness(readinesses) {
  const active = readinesses.filter((item) => item?.status !== 'not_relevant');
  if (active.length === 0) {
    return { status: 'not_relevant', requiredMissing: [], assumptionsUsed: [], warnings: [] };
  }
  if (active.some((item) => item?.status === 'intake_contract_incomplete')) {
    return {
      status: 'intake_contract_incomplete',
      requiredMissing: [],
      assumptionsUsed: [],
      warnings: active.flatMap((item) => item?.warnings || [])
    };
  }
  const blocked = active.find((item) => ['adviser_review_required', 'unsupported'].includes(item?.status));
  if (blocked) {
    return {
      status: blocked.status,
      requiredMissing: active.flatMap((item) => item?.requiredMissing || []),
      assumptionsUsed: active.flatMap((item) => item?.assumptionsUsed || []),
      warnings: active.flatMap((item) => item?.warnings || [])
    };
  }
  const requiredMissing = active.flatMap((item) => item?.requiredMissing || []);
  const assumptionsUsed = active.flatMap((item) => item?.assumptionsUsed || []);
  const warnings = active.flatMap((item) => item?.warnings || []);
  return {
    status: requiredMissing.length > 0
      ? 'missing_information'
      : assumptionsUsed.length > 0 ? 'ready_with_assumptions' : 'ready',
    requiredMissing,
    assumptionsUsed,
    warnings
  };
}

const adviserReviewRequired = (moduleId, reason) => () => ({
  status: 'adviser_review_required',
  requiredMissing: [],
  assumptionsUsed: [],
  warnings: [`${moduleId} remains adviser-only. ${reason}`]
});

const unsupported = (reason) => () => ({
  status: 'unsupported',
  requiredMissing: [],
  assumptionsUsed: [],
  warnings: [reason]
});

/** @type {Map<string, Object>} */
const REGISTRY = new Map();

function register(definition) {
  if (REGISTRY.has(definition.id)) throw new Error(`Duplicate planning module id: ${definition.id}`);
  const intake = definition.intakeContract;
  if (!intake || !MODULE_INTAKE_MODES.includes(intake.mode)
    || !MODULE_INTAKE_STATUSES.includes(intake.status)
    || typeof intake.version !== 'string'
    || !Array.isArray(intake.semanticFactIds)
    || !Array.isArray(intake.composedModuleIds)
    || typeof intake.getIntakeReadiness !== 'function') {
    throw new Error(`Planning module ${definition.id} requires a valid intake contract.`);
  }
  REGISTRY.set(definition.id, Object.freeze({
    ...definition,
    intakeContract: Object.freeze({
      ...intake,
      semanticFactIds: Object.freeze([...new Set(intake.semanticFactIds)]),
      composedModuleIds: Object.freeze([...new Set(intake.composedModuleIds)])
    }),
    applicableGoals: Object.freeze([...(definition.applicableGoals || [])]),
    exclusionRuleIds: Object.freeze([...(definition.exclusionRuleIds || [])]),
    prerequisiteModuleIds: Object.freeze([...(definition.prerequisiteModuleIds || [])]),
    requiredProfilePaths: Object.freeze([...(definition.requiredProfilePaths || [])]),
    optionalProfilePaths: Object.freeze([...(definition.optionalProfilePaths || [])]),
    conversationGuidance: Object.freeze(
      (definition.conversationGuidance || []).map((line) => String(line || '').trim()).filter(Boolean)
    )
  }));
}

register({
  id: MODULE_IDS.LIQUIDITY,
  kind: 'calculation',
  name: 'Liquidity reserve',
  description: 'Compares working cash with a deterministic minimum and target reserve.',
  status: 'active',
  moduleVersion: '1.0.0',
  applicableGoals: ['understand_position', 'maintain_liquidity', 'buy_home'],
  requiredProfilePaths: ['/assets', '/expenses'],
  optionalProfilePaths: [
    '/assumptions/values/liquidity',
    '/assumptions/values/persona/retirementStatus'
  ],
  conversationGuidance: liquidityConversationGuidance(),
  adviserAvailable: true,
  consumerAvailable: true,
  intakeContract: approvedIntake('calculation', INTAKE_FACTS[MODULE_IDS.LIQUIDITY], getLiquidityReadiness),
  canRun: getLiquidityReadiness,
  explainSelection: (profile) => profile.goals.some((goal) => goal.type === 'buy_home')
    ? ['A protected cash reserve should be separated from the home deposit.']
    : ['Cash resilience is relevant to the household goal.'],
  buildInput: buildLiquidityInput,
  validateInput: validateLiquidityInput,
  run: runLiquidityAnalysis
});

register({
  id: MODULE_IDS.HOUSE_PURCHASE,
  kind: 'calculation',
  name: 'House purchase planner',
  description: 'Illustrates affordability, protected cash, timing, costs and dated Irish support screens.',
  status: 'beta',
  moduleVersion: '1.0.0',
  applicableGoals: ['buy_home'],
  requiredProfilePaths: ['/goals', '/incomeSources', '/assets', '/expenses'],
  optionalProfilePaths: ['/partner', '/dependants', '/liabilities', '/assumptions/values/housePurchase'],
  prerequisiteModuleIds: [MODULE_IDS.LIQUIDITY],
  adviserAvailable: true,
  consumerAvailable: true,
  intakeContract: approvedIntake(
    'calculation',
    INTAKE_FACTS[MODULE_IDS.HOUSE_PURCHASE],
    withRequiredPartnerForCouple(
      withReviewedLiabilityPayments(
        withRequiredReviewedInputs(getHousePurchaseReadiness, MODULE_IDS.HOUSE_PURCHASE, [{
          fieldPath: '/liabilities',
          reason: 'Add current household debts and monthly repayments, or explicitly confirm there are none.',
          hasValue: (profile) => profile.liabilities.length > 0
        }]),
        MODULE_IDS.HOUSE_PURCHASE
      ),
      MODULE_IDS.HOUSE_PURCHASE
    )
  ),
  canRun: getHousePurchaseReadiness,
  explainSelection: () => ['The household has an active home-purchase goal.', 'The planner keeps emergency cash separate from deposit capacity.'],
  buildInput: buildHousePurchaseInput,
  validateInput: validateHousePurchaseInput,
  run: runHousePurchaseAnalysis
});

register({
  id: MODULE_IDS.PENSION_PROJECTION,
  kind: 'calculation',
  name: 'Pension projection',
  description: 'Projects pre-tax pension pots and target-income readiness through the existing deterministic engine.',
  status: 'beta',
  moduleVersion: '1.0.0-readiness',
  applicableGoals: ['improve_pension', 'retire', 'retire_early'],
  requiredProfilePaths: ['/primaryPerson/age', '/pensions', '/incomeSources', '/expenses'],
  optionalProfilePaths: ['/partner', '/assumptions/values/retirement'],
  conversationGuidance: pensionConversationGuidance(),
  adviserAvailable: true,
  consumerAvailable: true,
  intakeContract: approvedIntake(
    'calculation',
    INTAKE_FACTS[MODULE_IDS.PENSION_PROJECTION],
    withRequiredPartnerForCouple(
      withTerminalConfirmedNone(
        getPensionProjectionReadiness,
        MODULE_IDS.PENSION_PROJECTION,
        ['/pensions', '/incomeSources']
      ),
      MODULE_IDS.PENSION_PROJECTION
    )
  ),
  canRun: getPensionProjectionReadiness,
  explainSelection: () => ['A pension projection is relevant to the retirement goal, but remains gated for consumer release.'],
  buildInput: buildPensionProjectionInput,
  run: runPensionProjection
});

register({
  id: MODULE_IDS.NET_RETIREMENT,
  kind: 'calculation',
  name: 'Net retirement cash flow',
  description: 'Compares after-tax income sources with net spending and a required investment fund.',
  status: 'beta',
  moduleVersion: '1.0.0-readiness',
  applicableGoals: ['retire', 'retire_early'],
  requiredProfilePaths: ['/primaryPerson/age', '/expenses'],
  optionalProfilePaths: ['/incomeSources', '/assets', '/assumptions/values/retirement'],
  adviserAvailable: true,
  consumerAvailable: false,
  intakeContract: approvedIntake(
    'calculation',
    INTAKE_FACTS[MODULE_IDS.NET_RETIREMENT],
    withRequiredReviewedInputs(getNetRetirementReadiness, MODULE_IDS.NET_RETIREMENT, [
      {
        fieldPath: '/incomeSources',
        confirmedNonePaths: ['/incomeSources', '/incomeSources/netAnnual'],
        reason: 'Add each after-tax retirement income source, or explicitly confirm there will be none.',
        hasValue: (profile) => profile.incomeSources.some((income) => hasMoney(income.netAnnual, profile.preferences.baseCurrency))
      },
      {
        fieldPath: '/assets',
        confirmedNonePaths: ['/assets', '/assets/retirementAvailable'],
        reason: 'Add cash or liquid investments available for retirement, or explicitly confirm there are none.',
        hasValue: (profile) => profile.assets.some((asset) => (
          (asset.type === 'cash' || (asset.type === 'investment' && asset.liquid === true))
          && hasMoney(asset.currentValue, profile.preferences.baseCurrency)
        ))
      }
    ])
  ),
  canRun: getNetRetirementReadiness,
  explainSelection: () => ['Retirement spending needs a separate after-tax cash-flow view; pension balances are pre-tax.'],
  buildInput: buildNetRetirementInput,
  run: runNetRetirementCashflow
});

register({
  id: MODULE_IDS.MORTGAGE,
  kind: 'calculation',
  name: 'Mortgage analysis',
  description: 'Projects amortisation, repayments, payoff timing and lifetime interest.',
  status: 'beta',
  moduleVersion: '1.0.0-readiness',
  applicableGoals: ['optimise_mortgage'],
  requiredProfilePaths: ['/liabilities'],
  optionalProfilePaths: ['/assumptions/values/mortgage'],
  adviserAvailable: true,
  consumerAvailable: true,
  intakeContract: approvedIntake(
    'calculation',
    INTAKE_FACTS[MODULE_IDS.MORTGAGE],
    withTerminalConfirmedNone(getMortgageReadiness, MODULE_IDS.MORTGAGE, ['/liabilities'])
  ),
  canRun: getMortgageReadiness,
  explainSelection: () => ['An existing mortgage or mortgage-optimisation goal makes amortisation analysis relevant.'],
  buildInput: buildMortgageInput,
  validateInput: validateMortgageInput,
  run: runMortgageAnalysis
});

register({
  id: MODULE_IDS.LOAN,
  kind: 'calculation',
  name: 'Loan analysis',
  description: 'Projects repayment, payoff timing and lifetime interest for a non-housing loan.',
  status: 'beta',
  moduleVersion: '1.0.0-readiness',
  applicableGoals: ['manage_loan'],
  requiredProfilePaths: ['/liabilities'],
  optionalProfilePaths: ['/assumptions/values/loan'],
  adviserAvailable: true,
  consumerAvailable: true,
  intakeContract: approvedIntake(
    'calculation',
    INTAKE_FACTS[MODULE_IDS.LOAN],
    withTerminalConfirmedNone(getLoanReadiness, MODULE_IDS.LOAN, ['/liabilities'])
  ),
  canRun: getLoanReadiness,
  explainSelection: () => ['A non-housing loan goal maps to the deterministic repayment and interest engine.'],
  buildInput: buildLoanInput,
  validateInput: validateLoanInput,
  run: runLoanAnalysis
});

register({
  id: MODULE_IDS.COLLEGE_FUNDING,
  kind: 'calculation',
  name: 'College funding',
  description: 'Builds child-level, inflation-aware college cost scenarios.',
  status: 'beta',
  moduleVersion: '1.0.0-readiness',
  applicableGoals: ['fund_education'],
  requiredProfilePaths: ['/dependants', '/assumptions/values/collegeFunding/scenarios'],
  optionalProfilePaths: ['/assumptions/inflationRate'],
  adviserAvailable: true,
  consumerAvailable: true,
  intakeContract: approvedIntake(
    'calculation',
    INTAKE_FACTS[MODULE_IDS.COLLEGE_FUNDING],
    withTerminalConfirmedNone(getCollegeFundingReadiness, MODULE_IDS.COLLEGE_FUNDING, ['/dependants'])
  ),
  canRun: getCollegeFundingReadiness,
  explainSelection: () => ['A stated education-funding question makes child-level timing relevant.'],
  buildInput: buildCollegeFundingInput,
  run: runCollegeFundingAnalysis
});

register({
  id: MODULE_IDS.RETIREMENT_ROUTER,
  kind: 'composition',
  name: 'Retirement Goal Analysis',
  description: 'User-facing composition of pension projection and net-retirement cash flow.',
  status: 'beta',
  moduleVersion: '1.0.0',
  applicableGoals: ['improve_pension', 'retire', 'retire_early'],
  adviserAvailable: true,
  consumerAvailable: false,
  intakeContract: approvedIntake(
    'composition',
    [...new Set([
      ...INTAKE_FACTS[MODULE_IDS.PENSION_PROJECTION],
      ...INTAKE_FACTS[MODULE_IDS.NET_RETIREMENT]
    ])],
    (profile) => combineIntakeReadiness([
      getModuleIntakeReadiness(MODULE_IDS.PENSION_PROJECTION, profile),
      getModuleIntakeReadiness(MODULE_IDS.NET_RETIREMENT, profile)
    ]),
    [MODULE_IDS.PENSION_PROJECTION, MODULE_IDS.NET_RETIREMENT]
  ),
  canRun: adviserReviewRequired(
    MODULE_IDS.RETIREMENT_ROUTER,
    'Consumer use waits for the pension and net-retirement calculation and wording gates.'
  ),
  explainSelection: () => ['Retirement Goal Analysis brings the pension and after-tax retirement views together.']
});

register({
  id: MODULE_IDS.PERSONAL_BALANCE_SHEET,
  kind: 'calculation',
  name: 'Personal balance sheet',
  description: 'Reconciles household assets and liabilities into code-owned net-worth and purpose buckets.',
  status: 'beta',
  moduleVersion: '1.1.0',
  applicableGoals: [
    'understand_position',
    'maintain_liquidity',
    'buy_home',
    'build_wealth',
    'improve_pension',
    'retire',
    'retire_early',
    'optimise_mortgage',
    'manage_loan',
    'fund_education',
    'assess_decision',
    'transfer_wealth',
    'business_planning',
    'agricultural_planning'
  ],
  requiredProfilePaths: ['/assets', '/liabilities'],
  optionalProfilePaths: ['/properties', '/pensions', '/businesses', '/expenses'],
  adviserAvailable: true,
  consumerAvailable: true,
  intakeContract: approvedIntake(
    'calculation',
    INTAKE_FACTS[MODULE_IDS.PERSONAL_BALANCE_SHEET],
    withRequiredPartnerForCouple(
      withRequiredReviewedInputs(getPersonalBalanceSheetReadiness, MODULE_IDS.PERSONAL_BALANCE_SHEET, [
        {
          fieldPath: '/assets',
          reason: 'Add cash, investments and other general assets, or explicitly confirm there are none.',
          hasValue: (profile) => profile.assets.length > 0
        },
        {
          fieldPath: '/properties',
          reason: 'Add each property position, or explicitly confirm there are none.',
          hasValue: (profile) => profile.properties.length > 0
        },
        {
          fieldPath: '/pensions',
          reason: 'Add each pension position, or explicitly confirm there are none.',
          hasValue: (profile) => profile.pensions.length > 0
        },
        {
          fieldPath: '/businesses',
          reason: 'Add each business or agricultural interest, or explicitly confirm there are none.',
          hasValue: (profile) => profile.businesses.length > 0
        }
      ]),
      MODULE_IDS.PERSONAL_BALANCE_SHEET
    )
  ),
  canRun: getPersonalBalanceSheetReadiness,
  explainSelection: () => ['A reconciled personal balance sheet provides a useful view of the household’s overall position.'],
  buildInput: buildPersonalBalanceSheetInput,
  validateInput: validatePersonalBalanceSheetInput,
  run: runPersonalBalanceSheet
});

register({
  id: MODULE_IDS.SCENARIO_ANALYSIS,
  kind: 'composition',
  name: 'Scenario analysis',
  description: 'Composition capability over scenario-aware calculations; it does not calculate independently.',
  status: 'unsupported',
  moduleVersion: '1.0.0',
  applicableGoals: ['assess_decision'],
  adviserAvailable: false,
  consumerAvailable: false,
  intakeContract: incompleteIntake(
    'composition',
    'Scenario analysis has no independent intake contract; use a scenario-aware calculation module.'
  ),
  canRun: unsupported('scenario_analysis must be applied through a scenario-aware module.'),
  explainSelection: () => []
});

register({
  id: MODULE_IDS.PROTECTION,
  kind: 'composition',
  name: 'Protection analysis',
  description: 'Protection-needs playbook awaiting a complete planning adapter and approved intake contract.',
  status: 'unsupported',
  moduleVersion: 'template-only',
  applicableGoals: [],
  adviserAvailable: true,
  consumerAvailable: false,
  intakeContract: incompleteIntake(
    'adviser_handoff',
    'Protection is present in the master prompt but is not planning-ready.'
  ),
  canRun: unsupported('Protection does not yet have a complete planning adapter.'),
  explainSelection: () => []
});

[
  {
    id: MODULE_IDS.CAT,
    name: 'Capital Acquisitions Tax analysis',
    description: 'Adviser-only CAT planning.',
    goals: ['transfer_wealth'],
    reason: 'Consumer use waits for deterministic, date-versioned rules and tests.'
  },
  {
    id: MODULE_IDS.BUSINESS_OWNER_ANALYSIS,
    name: 'Business Owner Analysis',
    description: 'Adviser-reviewed planning around the household business interest.',
    goals: ['business_planning'],
    reason: 'Consumer use waits for a code-owned general business-owner analysis.'
  },
  {
    id: MODULE_IDS.BUSINESS_RELIEF_ANALYSIS,
    name: 'Business Relief Analysis',
    description: 'Adviser-reviewed, date-versioned business relief analysis.',
    goals: ['business_planning', 'transfer_wealth'],
    reason: 'Consumer use waits for deterministic, date-versioned business relief rules and tests.'
  },
  {
    id: MODULE_IDS.AGRICULTURAL_RELIEF,
    name: 'Agricultural relief',
    description: 'Adviser-only agricultural succession and relief planning.',
    goals: ['agricultural_planning'],
    reason: 'Consumer use waits for deterministic, date-versioned rules and tests.'
  }
].forEach((entry) => register({
  id: entry.id,
  kind: 'composition',
  name: entry.name,
  description: entry.description,
  status: 'adviser_only',
  moduleVersion: 'adviser-existing',
  applicableGoals: entry.goals,
  adviserAvailable: true,
  consumerAvailable: false,
  intakeContract: incompleteIntake(
    'adviser_handoff',
    `${entry.id} does not yet have an adviser-approved fact-find. Intake must stop for adviser review.`
  ),
  canRun: adviserReviewRequired(entry.id, entry.reason),
  explainSelection: () => [entry.reason]
}));

/**
 * Retired module ids that still resolve to their canonical replacement.
 *
 * `business_owner_relief` was renamed to `business_relief_analysis`. The rename
 * had already been completed everywhere that routes or maps facts — only the
 * registry entry survived, which made one analysis look like two modules. The
 * old id stays resolvable so any stored adviser payload still finds its module,
 * but it is deliberately NOT a registry entry: it must never appear as a
 * separate module in the adviser UI, the generated catalogue, or module counts.
 *
 * See docs/module-catalogue-reconciliation.md §9.
 */
export const RETIRED_MODULE_ID_ALIASES = Object.freeze({
  [MODULE_IDS.BUSINESS_RELIEF]: MODULE_IDS.BUSINESS_RELIEF_ANALYSIS
});

/** Canonical id for any module id, resolving retired aliases. */
export function resolvePlanningModuleId(moduleId) {
  const id = typeof moduleId === 'string' ? moduleId : '';
  return RETIRED_MODULE_ID_ALIASES[id] || id;
}

export function getPlanningModuleDefinition(moduleId) {
  return REGISTRY.get(resolvePlanningModuleId(moduleId)) || null;
}

export function listPlanningModuleDefinitions() {
  return Array.from(REGISTRY.values());
}

const PLAYBOOK_BY_MODULE_ID = new Map(
  PLANNING_PLAYBOOK_MANIFEST.map((entry) => [entry.moduleId, entry])
);

export function getPlanningPlaybookManifestVersion() {
  return PLANNING_PLAYBOOK_MANIFEST_VERSION;
}

export function getPlanningPlaybookEntry(moduleId) {
  return PLAYBOOK_BY_MODULE_ID.get(moduleId) || null;
}

export function isPlanningModuleTemplateAvailable(moduleId) {
  return PLAYBOOK_BY_MODULE_ID.has(moduleId);
}

/**
 * Cross-module capabilities are not modules. Scenario handling is composed over
 * scenario-aware modules (house purchase, pension projection, net retirement
 * cash flow), which receive overrides and hash them into their result identity.
 * `scenario_analysis` exists only as a placeholder for that capability: it must
 * never be offered in an adviser selector, routed to a consumer, counted as a
 * runnable module, or expected to produce output.
 *
 * See docs/module-catalogue-reconciliation.md §4.
 */
export const PLANNING_CAPABILITY_MODULE_IDS = Object.freeze([MODULE_IDS.SCENARIO_ANALYSIS]);

export function isPlanningCapability(moduleId) {
  return PLANNING_CAPABILITY_MODULE_IDS.includes(resolvePlanningModuleId(moduleId));
}

/** Modules that can actually be executed: a real engine, never a capability. */
export function isRunnablePlanningModule(moduleId) {
  const definition = getPlanningModuleDefinition(moduleId);
  return Boolean(definition && !isPlanningCapability(definition.id) && typeof definition.run === 'function');
}

export function listRunnablePlanningModuleDefinitions() {
  return listPlanningModuleDefinitions().filter((definition) => isRunnablePlanningModule(definition.id));
}

/** Modules an adviser may pick. Excludes capabilities by construction. */
export function listAdviserSelectableModuleDefinitions() {
  return listPlanningModuleDefinitions().filter((definition) => (
    definition.adviserAvailable === true && !isPlanningCapability(definition.id)
  ));
}

export function isPlanningModuleSelectable(moduleId) {
  const canonical = resolvePlanningModuleId(moduleId);
  const definition = getPlanningModuleDefinition(canonical);
  return Boolean(
    !isPlanningCapability(canonical)
    && PLAYBOOK_BY_MODULE_ID.has(canonical)
    && definition?.intakeContract?.status === 'approved'
    && typeof definition.buildInput === 'function'
    && typeof definition.run === 'function'
  );
}

export function listSelectablePlanningModuleDefinitions() {
  return listPlanningModuleDefinitions().filter((definition) => isPlanningModuleSelectable(definition.id));
}

function toDescriptor(definition) {
  return {
    id: definition.id,
    kind: definition.kind,
    name: definition.name,
    description: definition.description,
    status: definition.status,
    moduleVersion: definition.moduleVersion,
    applicableGoals: [...definition.applicableGoals],
    requiredProfilePaths: [...definition.requiredProfilePaths],
    optionalProfilePaths: [...definition.optionalProfilePaths],
    conversationGuidance: [...definition.conversationGuidance],
    exclusionRuleIds: [...definition.exclusionRuleIds],
    prerequisiteModuleIds: [...definition.prerequisiteModuleIds],
    adviserAvailable: definition.adviserAvailable,
    consumerAvailable: definition.consumerAvailable,
    templateAvailable: isPlanningModuleTemplateAvailable(definition.id),
    planningSelectable: isPlanningModuleSelectable(definition.id),
    intakeContract: {
      version: definition.intakeContract.version,
      mode: definition.intakeContract.mode,
      status: definition.intakeContract.status,
      semanticFactIds: [...definition.intakeContract.semanticFactIds],
      composedModuleIds: [...definition.intakeContract.composedModuleIds]
    }
  };
}

export function getPlanningModuleDescriptors() {
  return listPlanningModuleDefinitions().map(toDescriptor);
}

/** Serializable, Worker-safe descriptors for the modules enabled in v1. */
export function getConsumerModuleDescriptors() {
  return listPlanningModuleDefinitions().filter((definition) => definition.consumerAvailable).map(toDescriptor);
}

export function getModuleIntakeContract(moduleId) {
  return getPlanningModuleDefinition(moduleId)?.intakeContract || null;
}

export function getModuleIntakeReadiness(moduleId, rawProfile) {
  const contract = getModuleIntakeContract(moduleId);
  if (!contract) {
    return {
      status: 'intake_contract_incomplete',
      requiredMissing: [],
      assumptionsUsed: [],
      warnings: [`Unknown planning module or missing intake contract: ${moduleId}`]
    };
  }
  return contract.getIntakeReadiness(normalizeHouseholdProfile(rawProfile));
}

export function getPlanningModulesForSemanticFact(factId) {
  return listPlanningModuleDefinitions()
    .filter((definition) => definition.intakeContract.status === 'approved'
      && definition.intakeContract.semanticFactIds.includes(factId))
    .map((definition) => definition.id);
}

export function getRealtimeModuleSemanticFactIds() {
  return Object.freeze([...new Set(
    listPlanningModuleDefinitions()
      .filter((definition) => definition.intakeContract.status === 'approved')
      .flatMap((definition) => definition.intakeContract.semanticFactIds)
  )]);
}

export function getModuleReadiness(moduleId, rawProfile) {
  const definition = getPlanningModuleDefinition(moduleId);
  if (!definition) {
    return {
      status: 'unsupported',
      requiredMissing: [],
      assumptionsUsed: [],
      warnings: [`Unknown planning module: ${moduleId}`]
    };
  }
  return definition.canRun(normalizeHouseholdProfile(rawProfile));
}

/**
 * Build a module's engine input and hold it to the engine's own contract.
 *
 * The phase matters, not just the throw. An input that fails the engine's
 * schema is a mapping defect in this layer; an engine that throws on input it
 * accepted is a calculation defect. They read identically from the outside, so
 * the boundary is drawn here, once, for every module.
 *
 * `validateInput` is the module's own normaliser. Declaring it moves an input
 * contract breach out of the run phase, where it would otherwise masquerade as
 * an engine crash.
 */
export function buildPlanningModuleInput(definition, profile) {
  let input;
  try {
    input = definition.buildInput(profile);
    if (typeof definition.validateInput === 'function') definition.validateInput(input);
  } catch (error) {
    throw new ModuleFailureError(
      MODULE_FAILURE_CODES.INPUT_INVALID,
      definition.id,
      error instanceof Error ? error.message : String(error),
      error
    );
  }
  return input;
}

function assertRunnableModule(moduleId) {
  const definition = getPlanningModuleDefinition(moduleId);
  if (!definition) {
    throw new ModuleFailureError(
      MODULE_FAILURE_CODES.UNSUPPORTED_STATE,
      moduleId,
      `Unknown planning module: ${moduleId}`
    );
  }
  if (typeof definition.run !== 'function' || typeof definition.buildInput !== 'function') {
    throw new ModuleFailureError(
      MODULE_FAILURE_CODES.UNSUPPORTED_STATE,
      moduleId,
      `${moduleId} does not have a deterministic runtime engine.`
    );
  }
  return definition;
}

export async function runPlanningModule(moduleId, rawProfile, context) {
  const definition = assertRunnableModule(moduleId);
  const profile = normalizeHouseholdProfile(rawProfile);
  const input = buildPlanningModuleInput(definition, profile);
  try {
    return await definition.run(input, {
      ...context,
      moduleVersion: definition.moduleVersion,
      baseCurrency: profile.preferences.baseCurrency
    });
  } catch (error) {
    if (error instanceof ModuleFailureError) throw error;
    throw new ModuleFailureError(
      MODULE_FAILURE_CODES.EXECUTION_FAILED,
      moduleId,
      error instanceof Error ? error.message : String(error),
      error
    );
  }
}

/**
 * Build the deterministic identity used to decide whether a previously stored
 * module result can be reused. It binds the registry-declared profile
 * dependencies, normalized engine input, and effective scenario. Session
 * scoping, readiness, and engine/module versions are bound by the Worker layer.
 */
export async function getPlanningModuleRunIdentity(moduleId, rawProfile, context = {}) {
  const definition = assertRunnableModule(moduleId);
  const profile = normalizeHouseholdProfile(rawProfile);
  const input = buildPlanningModuleInput(definition, profile);
  const scenarioOverrides = context.scenarioOverrides || {};
  const dependencyPaths = [...new Set([
    ...definition.requiredProfilePaths,
    ...definition.optionalProfilePaths
  ])].sort();
  const dependencySnapshot = dependencyPaths.map((path) => {
    const value = readJsonPointer(profile, path);
    return typeof value === 'undefined'
      ? { path, present: false }
      : { path, present: true, value };
  });
  return Object.freeze({
    moduleId,
    moduleVersion: definition.moduleVersion,
    calculationVersion: context.calculationVersion,
    calculationDateIso: context.calculationDateIso || profile.assumptions.calculationDateIso,
    dependencySnapshotHash: await sha256Json(dependencySnapshot),
    inputSnapshotHash: await sha256Json({ input, scenarioOverrides }),
    scenarioSnapshotHash: await sha256Json(scenarioOverrides)
  });
}
