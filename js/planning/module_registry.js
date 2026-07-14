import { MODULE_IDS } from './contracts.js';
import { normalizeHouseholdProfile } from './profile.js';
import {
  buildLiquidityInput,
  getLiquidityReadiness,
  runLiquidityAnalysis
} from './adapters/liquidity.js';
import {
  buildHousePurchaseInput,
  getHousePurchaseReadiness,
  runHousePurchaseAnalysis
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
  runMortgageAnalysis
} from './adapters/mortgage.js';
import {
  buildCollegeFundingInput,
  getCollegeFundingReadiness,
  runCollegeFundingAnalysis
} from './adapters/college_funding.js';
import { readJsonPointer, sha256Json } from './utils.js';

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
  REGISTRY.set(definition.id, Object.freeze({
    ...definition,
    applicableGoals: Object.freeze([...(definition.applicableGoals || [])]),
    exclusionRuleIds: Object.freeze([...(definition.exclusionRuleIds || [])]),
    prerequisiteModuleIds: Object.freeze([...(definition.prerequisiteModuleIds || [])]),
    requiredProfilePaths: Object.freeze([...(definition.requiredProfilePaths || [])]),
    optionalProfilePaths: Object.freeze([...(definition.optionalProfilePaths || [])])
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
  optionalProfilePaths: ['/assumptions/values/liquidity'],
  adviserAvailable: true,
  consumerAvailable: true,
  canRun: getLiquidityReadiness,
  explainSelection: (profile) => profile.goals.some((goal) => goal.type === 'buy_home')
    ? ['A protected cash reserve should be separated from the home deposit.']
    : ['Cash resilience is relevant to the household goal.'],
  buildInput: buildLiquidityInput,
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
  canRun: getHousePurchaseReadiness,
  explainSelection: () => ['The household has an active home-purchase goal.', 'The planner keeps emergency cash separate from deposit capacity.'],
  buildInput: buildHousePurchaseInput,
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
  adviserAvailable: true,
  consumerAvailable: false,
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
  consumerAvailable: false,
  canRun: getMortgageReadiness,
  explainSelection: () => ['An existing mortgage or mortgage-optimisation goal makes amortisation analysis relevant.'],
  buildInput: buildMortgageInput,
  run: runMortgageAnalysis
});

register({
  id: MODULE_IDS.COLLEGE_FUNDING,
  kind: 'calculation',
  name: 'College funding',
  description: 'Builds child-level, inflation-aware college cost scenarios.',
  status: 'beta',
  moduleVersion: '1.0.0-readiness',
  applicableGoals: ['assess_decision'],
  requiredProfilePaths: ['/dependants', '/assumptions/values/collegeFunding/scenarios'],
  optionalProfilePaths: ['/assumptions/inflationRate'],
  adviserAvailable: true,
  consumerAvailable: false,
  canRun: getCollegeFundingReadiness,
  explainSelection: () => ['A stated education-funding question makes child-level timing relevant.'],
  buildInput: buildCollegeFundingInput,
  run: runCollegeFundingAnalysis
});

register({
  id: MODULE_IDS.RETIREMENT_ROUTER,
  kind: 'composition',
  name: 'Retirement goal routing',
  description: 'Routing label that selects pension projection, net retirement cash flow, or both; it is not a calculator.',
  status: 'unsupported',
  moduleVersion: '1.0.0',
  applicableGoals: ['improve_pension', 'retire', 'retire_early'],
  adviserAvailable: false,
  consumerAvailable: false,
  canRun: unsupported('retirement_goal_analysis is a routing label, not an independently runnable engine.'),
  explainSelection: () => []
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
  canRun: unsupported('scenario_analysis must be applied through a scenario-aware module.'),
  explainSelection: () => []
});

[
  {
    id: MODULE_IDS.PERSONAL_BALANCE_SHEET,
    name: 'Personal balance sheet',
    description: 'Adviser-composed balance sheet; classification and reconciliation are not yet fully code-owned.',
    goals: ['understand_position'],
    reason: 'Consumer use waits for deterministic classification, totals, reconciliation and scenario movements.'
  },
  {
    id: MODULE_IDS.CAT,
    name: 'Capital Acquisitions Tax analysis',
    description: 'Adviser-only CAT planning.',
    goals: ['transfer_wealth'],
    reason: 'Consumer use waits for deterministic, date-versioned rules and tests.'
  },
  {
    id: MODULE_IDS.BUSINESS_RELIEF,
    name: 'Business owner relief',
    description: 'Adviser-only business succession and relief planning.',
    goals: ['business_planning'],
    reason: 'Consumer use waits for deterministic, date-versioned rules and tests.'
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
  canRun: adviserReviewRequired(entry.id, entry.reason),
  explainSelection: () => [entry.reason]
}));

export function getPlanningModuleDefinition(moduleId) {
  return REGISTRY.get(moduleId) || null;
}

export function listPlanningModuleDefinitions() {
  return Array.from(REGISTRY.values());
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
    exclusionRuleIds: [...definition.exclusionRuleIds],
    prerequisiteModuleIds: [...definition.prerequisiteModuleIds],
    adviserAvailable: definition.adviserAvailable,
    consumerAvailable: definition.consumerAvailable
  };
}

export function getPlanningModuleDescriptors() {
  return listPlanningModuleDefinitions().map(toDescriptor);
}

/** Serializable, Worker-safe descriptors for the modules enabled in v1. */
export function getConsumerModuleDescriptors() {
  return listPlanningModuleDefinitions().filter((definition) => definition.consumerAvailable).map(toDescriptor);
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

export async function runPlanningModule(moduleId, rawProfile, context) {
  const definition = getPlanningModuleDefinition(moduleId);
  if (!definition) throw new Error(`Unknown planning module: ${moduleId}`);
  if (typeof definition.run !== 'function' || typeof definition.buildInput !== 'function') {
    throw new Error(`${moduleId} does not have a deterministic runtime engine.`);
  }
  const profile = normalizeHouseholdProfile(rawProfile);
  const input = definition.buildInput(profile);
  return definition.run(input, {
    ...context,
    moduleVersion: definition.moduleVersion,
    baseCurrency: profile.preferences.baseCurrency
  });
}

/**
 * Build the deterministic identity used to decide whether a previously stored
 * module result can be reused. It binds the registry-declared profile
 * dependencies, normalized engine input, and effective scenario. Session
 * scoping, readiness, and engine/module versions are bound by the Worker layer.
 */
export async function getPlanningModuleRunIdentity(moduleId, rawProfile, context = {}) {
  const definition = getPlanningModuleDefinition(moduleId);
  if (!definition) throw new Error(`Unknown planning module: ${moduleId}`);
  if (typeof definition.run !== 'function' || typeof definition.buildInput !== 'function') {
    throw new Error(`${moduleId} does not have a deterministic runtime engine.`);
  }
  const profile = normalizeHouseholdProfile(rawProfile);
  const input = definition.buildInput(profile);
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
