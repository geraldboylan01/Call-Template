import { CONSUMER_PLANNING_RULES_VERSION, MODULE_IDS } from './contracts.js';
import { getPlanningModuleDefinition, getModuleReadiness } from './module_registry.js';
import { normalizeHouseholdProfile } from './profile.js';
import { detectRulesOnlyGoalCandidates } from './rules_only_extraction.js';

const GOAL_PRIORITY = Object.freeze({ high: 100, medium: 70, low: 40 });

function profileGoalCandidates(profile) {
  return profile.goals
    .filter((goal) => !['completed', 'paused'].includes(goal.status))
    .map((goal) => ({
      type: goal.type,
      priority: GOAL_PRIORITY[goal.priority] || 50,
      confidence: 'high',
      triggeredRuleIds: [`profile.goal.${goal.type}.v1`],
      rationale: [`The confirmed profile contains the goal “${goal.title}”.`]
    }));
}

function mergeGoalCandidates(candidates) {
  const byType = new Map();
  candidates.forEach((candidate) => {
    const existing = byType.get(candidate.type);
    if (!existing) {
      byType.set(candidate.type, { ...candidate, triggeredRuleIds: [...candidate.triggeredRuleIds], rationale: [...candidate.rationale] });
      return;
    }
    existing.priority = Math.max(existing.priority, candidate.priority);
    existing.confidence = existing.confidence === 'high' || candidate.confidence === 'high' ? 'high' : candidate.confidence;
    existing.triggeredRuleIds = [...new Set([...existing.triggeredRuleIds, ...candidate.triggeredRuleIds])];
    existing.rationale = [...new Set([...existing.rationale, ...candidate.rationale])];
  });
  return Array.from(byType.values()).sort((left, right) => right.priority - left.priority || left.type.localeCompare(right.type));
}

export function detectGoalCandidates(rawProfile, { text = '' } = {}) {
  const profile = normalizeHouseholdProfile(rawProfile);
  return mergeGoalCandidates([
    ...profileGoalCandidates(profile),
    ...(text ? detectRulesOnlyGoalCandidates(text) : [])
  ]);
}

function addRecommendation(byId, moduleId, {
  priority,
  source = 'deterministic_rule',
  status = 'recommended',
  rationale,
  triggeredRuleIds
}) {
  const existing = byId.get(moduleId);
  if (!existing || priority > existing.priority) {
    byId.set(moduleId, {
      moduleId,
      priority,
      source,
      status,
      rationale: [...rationale],
      triggeredRuleIds: [...triggeredRuleIds]
    });
  } else {
    existing.rationale = [...new Set([...existing.rationale, ...rationale])];
    existing.triggeredRuleIds = [...new Set([...existing.triggeredRuleIds, ...triggeredRuleIds])];
    if (status === 'required') existing.status = 'required';
  }
}

/** Deterministic goal/circumstance-to-module routing with no model authority. */
export function recommendModules(rawProfile, {
  text = '',
  userSelectedModuleIds = []
} = {}) {
  const profile = normalizeHouseholdProfile(rawProfile);
  const goals = detectGoalCandidates(profile, { text });
  const byId = new Map();
  const route = (goalType, moduleId, offset, status, ruleId, reason) => {
    const goal = goals.find((candidate) => candidate.type === goalType);
    if (!goal) return;
    addRecommendation(byId, moduleId, {
      priority: goal.priority + offset,
      status,
      rationale: [reason, ...goal.rationale],
      triggeredRuleIds: [ruleId, ...goal.triggeredRuleIds]
    });
  };

  route('understand_position', MODULE_IDS.LIQUIDITY, 0, 'recommended', 'route.position.liquidity.v1', 'Liquidity is the first deterministic consumer position check.');
  route('maintain_liquidity', MODULE_IDS.LIQUIDITY, 10, 'required', 'route.liquidity.v1', 'The goal directly requires a cash-reserve analysis.');
  route('buy_home', MODULE_IDS.HOUSE_PURCHASE, 20, 'required', 'route.buy_home.v1', 'A home-purchase goal requires the house-purchase planner.');
  route('buy_home', MODULE_IDS.LIQUIDITY, 10, 'recommended', 'route.buy_home.reserve.v1', 'The deposit should be shown after protecting an emergency reserve.');
  route('improve_pension', MODULE_IDS.PENSION_PROJECTION, 10, 'recommended', 'route.pension.v1', 'A pension goal maps to the existing pre-tax pension projection.');
  route('retire', MODULE_IDS.PENSION_PROJECTION, 10, 'recommended', 'route.retire.pension.v1', 'Retirement needs a pre-tax pension projection where pension data exists.');
  route('retire', MODULE_IDS.NET_RETIREMENT, 5, 'recommended', 'route.retire.net.v1', 'Retirement also needs a separate after-tax spending and income view.');
  route('retire_early', MODULE_IDS.PENSION_PROJECTION, 15, 'recommended', 'route.retire_early.pension.v1', 'Early retirement requires pension timing analysis.');
  route('retire_early', MODULE_IDS.NET_RETIREMENT, 15, 'recommended', 'route.retire_early.net.v1', 'Early retirement requires bridge-period net cash-flow analysis.');
  route('optimise_mortgage', MODULE_IDS.MORTGAGE, 10, 'recommended', 'route.mortgage.v1', 'The goal maps to deterministic mortgage amortisation.');
  route('manage_loan', MODULE_IDS.LOAN, 10, 'recommended', 'route.loan.v1', 'The goal maps to deterministic non-housing loan amortisation.');
  route('fund_education', MODULE_IDS.COLLEGE_FUNDING, 10, 'recommended', 'route.education.v1', 'An education-funding goal maps to child-level college funding.');
  route('transfer_wealth', MODULE_IDS.CAT, 0, 'recommended', 'route.transfer.adviser.v1', 'Wealth transfer remains adviser-only until dated CAT rules are code-owned.');
  route('business_planning', MODULE_IDS.BUSINESS_OWNER_ANALYSIS, 0, 'recommended', 'route.business_owner.adviser.v1', 'General business-owner analysis remains adviser-reviewed.');
  if (profile.assumptions?.values?.persona?.businessExit === true) {
    route('business_planning', MODULE_IDS.BUSINESS_RELIEF_ANALYSIS, 5, 'recommended', 'route.business_relief.adviser.v1', 'A confirmed business-exit intention also requires date-versioned business relief review.');
  }
  route('agricultural_planning', MODULE_IDS.AGRICULTURAL_RELIEF, 0, 'recommended', 'route.agricultural.adviser.v1', 'Agricultural relief remains adviser-only.');

  userSelectedModuleIds.forEach((moduleId) => addRecommendation(byId, moduleId, {
    priority: 200,
    source: 'user_selected',
    status: 'required',
    rationale: ['The user explicitly selected this module.'],
    triggeredRuleIds: ['route.user_selected.v1']
  }));

  return Array.from(byId.values()).map((recommendation) => {
    const definition = getPlanningModuleDefinition(recommendation.moduleId);
    const readiness = getModuleReadiness(recommendation.moduleId, profile);
    const selectionReasons = definition?.explainSelection?.(profile) || [];
    return {
      ...recommendation,
      rationale: [...new Set([...recommendation.rationale, ...selectionReasons])],
      readiness
    };
  }).sort((left, right) => right.priority - left.priority || left.moduleId.localeCompare(right.moduleId));
}

export function getRoutingRulesVersion() {
  return CONSUMER_PLANNING_RULES_VERSION;
}
