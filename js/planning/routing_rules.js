import { CONSUMER_PLANNING_RULES_VERSION } from './contracts.js';
import { getPlanningModuleDefinition, getModuleReadiness } from './module_registry.js';
import { MODULE_MANIFEST } from './module_manifest.generated.js';
import { normalizeHouseholdProfile } from './profile.js';
import { detectRulesOnlyGoalCandidates } from './rules_only_extraction.js';

const GOAL_PRIORITY = Object.freeze({ high: 100, medium: 70, low: 40 });

/**
 * Ordering policy for this router only. The module-to-goal edges themselves are
 * owned by the shared manifest; these values decide priority and whether a
 * recommendation is required or merely recommended.
 */
const DEFAULT_ROUTE_POLICY = Object.freeze({
  offset: 0, status: 'recommended', reason: 'The stated goal maps to this analysis.'
});
const ROUTE_POLICY = Object.freeze({
  'understand_position:liquidity_analysis': { offset: 0, status: 'recommended', reason: 'Liquidity is the first deterministic consumer position check.' },
  'maintain_liquidity:liquidity_analysis': { offset: 10, status: 'required', reason: 'The goal directly requires a cash-reserve analysis.' },
  'buy_home:house_purchase': { offset: 20, status: 'required', reason: 'A home-purchase goal requires the house-purchase planner.' },
  'buy_home:liquidity_analysis': { offset: 10, status: 'recommended', reason: 'The deposit should be shown after protecting an emergency reserve.' },
  'improve_pension:pension_projection': { offset: 10, status: 'recommended', reason: 'A pension goal maps to the existing pre-tax pension projection.' },
  'retire:pension_projection': { offset: 10, status: 'recommended', reason: 'Retirement needs a pre-tax pension projection where pension data exists.' },
  'retire:net_retirement_cashflow': { offset: 5, status: 'recommended', reason: 'Retirement also needs a separate after-tax spending and income view.' },
  'retire_early:pension_projection': { offset: 15, status: 'recommended', reason: 'Early retirement requires pension timing analysis.' },
  'retire_early:net_retirement_cashflow': { offset: 15, status: 'recommended', reason: 'Early retirement requires bridge-period net cash-flow analysis.' },
  'optimise_mortgage:mortgage_analysis': { offset: 10, status: 'recommended', reason: 'The goal maps to deterministic mortgage amortisation.' },
  'manage_loan:loan_analysis': { offset: 10, status: 'recommended', reason: 'The goal maps to deterministic non-housing loan amortisation.' },
  'fund_education:college_funding': { offset: 10, status: 'recommended', reason: 'An education-funding goal maps to child-level college funding.' },
  'transfer_wealth:cat_analysis': { offset: 0, status: 'recommended', reason: 'Wealth transfer remains adviser-only until dated CAT rules are code-owned.' },
  'business_planning:business_owner_analysis': { offset: 0, status: 'recommended', reason: 'General business-owner analysis remains adviser-reviewed.' },
  'business_planning:business_relief_analysis': { offset: 5, status: 'recommended', reason: 'A confirmed business-exit intention also requires date-versioned business relief review.' },
  'agricultural_planning:agricultural_relief': { offset: 0, status: 'recommended', reason: 'Agricultural relief remains adviser-only.' }
});

const REQUIRES_FACT_PREDICATES = Object.freeze({
  business_exit_intent: (profile) => profile.assumptions?.values?.persona?.businessExit === true
});

function factSatisfied(profile, factId) {
  const predicate = REQUIRES_FACT_PREDICATES[factId];
  return typeof predicate === 'function' ? predicate(profile) : false;
}

/** Flatten the manifest into goal → module edges for the execution-time router. */
function manifestRoutingEdges(manifest = MODULE_MANIFEST) {
  const edges = [];
  for (const entry of manifest) {
    for (const goal of [...(entry.routing?.goals || []), ...(entry.routing?.adviserGoals || [])]) {
      edges.push({
        moduleId: entry.moduleId,
        goalType: goal.type,
        requiresFact: goal.requiresFact || null
      });
    }
  }
  return edges;
}

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
  userSelectedModuleIds = [],
  candidateManifest = null
} = {}) {
  const profile = normalizeHouseholdProfile(rawProfile);
  const goals = detectGoalCandidates(profile, { text });
  const byId = new Map();

  // Edges come from the shared module manifest, exactly as consumer goal
  // routing does, so the analyses a conversation selects cannot drift from the
  // analyses this execution-time fallback would run. Only the priority and
  // required/recommended policy is local to this router.
  for (const edge of manifestRoutingEdges(
    Array.isArray(candidateManifest) ? candidateManifest : MODULE_MANIFEST
  )) {
    const goal = goals.find((candidate) => candidate.type === edge.goalType);
    if (!goal) continue;
    if (edge.requiresFact && !factSatisfied(profile, edge.requiresFact)) continue;
    const policy = ROUTE_POLICY[`${edge.goalType}:${edge.moduleId}`] || DEFAULT_ROUTE_POLICY;
    addRecommendation(byId, edge.moduleId, {
      priority: goal.priority + policy.offset,
      status: policy.status,
      rationale: [policy.reason, ...goal.rationale],
      triggeredRuleIds: [`manifest.${edge.goalType}.${edge.moduleId}.v1`, ...goal.triggeredRuleIds]
    });
  }

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
