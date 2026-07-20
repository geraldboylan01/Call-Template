import { GOAL_TYPES, MODULE_IDS } from './contracts.js';
import {
  getModuleIntakeReadiness,
  getPlanningModuleDefinition,
  getPlanningPlaybookManifestVersion,
  isPlanningModuleSelectable
} from './module_registry.js';
import { normalizeHouseholdProfile } from './profile.js';
import { resolveSemanticFact } from './semantic_facts.js';

export const GOAL_ROUTING_POLICY_VERSION = 'goal-routing-1.0.0';

const PRIORITY = Object.freeze({ high: 3, medium: 2, low: 1 });
const SOURCE_RANK = Object.freeze({ goal_direct: 3, goal_companion: 2, balance_sheet_default: 1 });
const EARLY_LIFE_STAGES = new Set(['student', 'early_adult', 'graduate', 'young_employee', 'early_career']);

const GOAL_LABELS = Object.freeze({
  understand_position: 'understanding your overall position',
  maintain_liquidity: 'building cash resilience',
  buy_home: 'buying a home',
  build_wealth: 'building wealth',
  improve_pension: 'improving your pension position',
  retire: 'planning retirement',
  retire_early: 'planning early retirement',
  optimise_mortgage: 'reviewing your mortgage',
  manage_loan: 'reviewing or repaying your loan',
  fund_education: 'funding education',
  assess_decision: 'assessing a financial decision',
  transfer_wealth: 'transferring wealth',
  business_planning: 'business planning',
  agricultural_planning: 'agricultural planning'
});

const ROUTES = Object.freeze({
  understand_position: Object.freeze([
    Object.freeze({ moduleId: MODULE_IDS.PERSONAL_BALANCE_SHEET, source: 'goal_direct', ruleId: 'goal.position.balance_sheet.v1' })
  ]),
  build_wealth: Object.freeze([
    Object.freeze({ moduleId: MODULE_IDS.PERSONAL_BALANCE_SHEET, source: 'goal_direct', ruleId: 'goal.wealth.balance_sheet.v1' })
  ]),
  maintain_liquidity: Object.freeze([
    Object.freeze({ moduleId: MODULE_IDS.LIQUIDITY, source: 'goal_direct', ruleId: 'goal.liquidity.direct.v1' })
  ]),
  buy_home: Object.freeze([
    Object.freeze({ moduleId: MODULE_IDS.HOUSE_PURCHASE, source: 'goal_direct', ruleId: 'goal.home.direct.v1' }),
    Object.freeze({ moduleId: MODULE_IDS.LIQUIDITY, source: 'goal_companion', ruleId: 'goal.home.liquidity.v1' })
  ]),
  improve_pension: Object.freeze([
    Object.freeze({ moduleId: MODULE_IDS.PENSION_PROJECTION, source: 'goal_direct', ruleId: 'goal.pension.direct.v1' })
  ]),
  retire: Object.freeze([
    Object.freeze({ moduleId: MODULE_IDS.PENSION_PROJECTION, source: 'goal_direct', ruleId: 'goal.retirement.pension.v1' }),
    Object.freeze({ moduleId: MODULE_IDS.NET_RETIREMENT, source: 'goal_companion', ruleId: 'goal.retirement.net_cashflow.v1' })
  ]),
  retire_early: Object.freeze([
    Object.freeze({ moduleId: MODULE_IDS.PENSION_PROJECTION, source: 'goal_direct', ruleId: 'goal.early_retirement.pension.v1' }),
    Object.freeze({ moduleId: MODULE_IDS.NET_RETIREMENT, source: 'goal_companion', ruleId: 'goal.early_retirement.net_cashflow.v1' })
  ]),
  optimise_mortgage: Object.freeze([
    Object.freeze({ moduleId: MODULE_IDS.MORTGAGE, source: 'goal_direct', ruleId: 'goal.mortgage.direct.v1' })
  ]),
  manage_loan: Object.freeze([
    Object.freeze({ moduleId: MODULE_IDS.LOAN, source: 'goal_direct', ruleId: 'goal.loan.direct.v1' })
  ]),
  fund_education: Object.freeze([
    Object.freeze({ moduleId: MODULE_IDS.COLLEGE_FUNDING, source: 'goal_direct', ruleId: 'goal.education.direct.v1' })
  ])
});

function activeGoals(profile) {
  return profile.goals
    .map((goal, index) => ({ ...goal, index }))
    .filter((goal) => !['completed', 'paused'].includes(goal.status))
    .sort((left, right) => (PRIORITY[right.priority] || 0) - (PRIORITY[left.priority] || 0) || left.index - right.index);
}

function planningValues(profile) {
  const value = profile.assumptions?.values?.planning;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function selectedPrimaryGoal(profile, goals) {
  const planningGoal = planningValues(profile).primaryGoalType;
  const legacyGoal = profile.assumptions?.values?.persona?.primaryGoalType;
  return [planningGoal, legacyGoal].find((goalType) => (
    GOAL_TYPES.includes(goalType) && goals.some((goal) => goal.type === goalType)
  )) || null;
}

function hasMeaningfulPosition(profile) {
  return profile.properties.length > 0
    || profile.pensions.length > 0
    || profile.businesses.length > 0
    || profile.assets.some((asset) => asset.type !== 'cash')
    || profile.liabilities.some((liability) => (liability.currentBalance?.amount || 0) > 0);
}

function isEarlyLife(profile) {
  const context = profile.assumptions?.values?.persona || {};
  const signals = [context.lifeStage, context.careerStage, context.selfDescription]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => typeof value === 'string')
    .map((value) => value.toLowerCase().replace(/[ -]+/g, '_'));
  if (signals.some((signal) => EARLY_LIFE_STAGES.has(signal))) return true;
  return Number.isInteger(profile.primaryPerson.age) && profile.primaryPerson.age <= 30;
}

function shouldAddBalanceSheet(profile, goalTypes) {
  if (goalTypes.includes('understand_position') || goalTypes.includes('build_wealth')) return true;
  if (!isEarlyLife(profile)) return true;
  return hasMeaningfulPosition(profile);
}

function addRoute(byModuleId, route, goalType) {
  if (!isPlanningModuleSelectable(route.moduleId)) return;
  const existing = byModuleId.get(route.moduleId);
  if (!existing) {
    byModuleId.set(route.moduleId, {
      moduleId: route.moduleId,
      source: route.source,
      relatedGoalTypes: [goalType],
      ruleIds: [route.ruleId]
    });
    return;
  }
  existing.relatedGoalTypes = [...new Set([...existing.relatedGoalTypes, goalType])];
  existing.ruleIds = [...new Set([...existing.ruleIds, route.ruleId])];
  if (SOURCE_RANK[route.source] > SOURCE_RANK[existing.source]) existing.source = route.source;
}

function intakeFor(moduleId, profile, allowedModuleIds) {
  const definition = getPlanningModuleDefinition(moduleId);
  const readiness = getModuleIntakeReadiness(moduleId, profile);
  const missingFactIds = [...new Set((readiness.requiredMissing || []).map((item) => (
    resolveSemanticFact(item, { profile, moduleId }).factId
  )))];
  const releaseAllowed = definition?.consumerAvailable === true
    && (!allowedModuleIds || allowedModuleIds.has(moduleId));
  if (!releaseAllowed) {
    return {
      availability: 'adviser_review_required',
      intakeStatus: readiness.status,
      missingFactIds,
      reasons: [definition?.status === 'adviser_only'
        ? 'This analysis requires Gerry’s review.'
        : 'This analysis is relevant, but its consumer release gate is not yet open.',
      ...(readiness.warnings || []).slice(0, 2)]
    };
  }
  return {
    availability: ['ready', 'ready_with_assumptions'].includes(readiness.status) ? 'ready' : 'needs_facts',
    intakeStatus: readiness.status,
    missingFactIds,
    reasons: (readiness.warnings || []).slice(0, 3)
  };
}

function reasonFor(selection) {
  const goals = selection.relatedGoalTypes.map((type) => GOAL_LABELS[type] || type).join(' and ');
  if (selection.source === 'goal_companion') return `Included because it is needed alongside ${goals}.`;
  if (selection.source === 'balance_sheet_default') return 'Included to put the selected goals in the context of the household’s overall position.';
  return `Selected directly for ${goals}.`;
}

export function toPublicGoalAssessment(assessment) {
  if (!assessment || typeof assessment !== 'object') return null;
  return Object.freeze({
    primaryGoalType: GOAL_TYPES.includes(assessment.primaryGoalType) ? assessment.primaryGoalType : null,
    activeGoalTypes: Object.freeze((assessment.activeGoalTypes || []).filter((type) => GOAL_TYPES.includes(type)).slice(0, 12)),
    deferredGoalTypes: Object.freeze((assessment.deferredGoalTypes || []).filter((type) => GOAL_TYPES.includes(type)).slice(0, 12)),
    evidenceFactIds: Object.freeze((assessment.evidenceFactIds || []).filter((id) => typeof id === 'string').slice(0, 20)),
    confidence: ['high', 'medium', 'low'].includes(assessment.confidence) ? assessment.confidence : 'low'
  });
}

/** Build the deterministic one-to-three-module plan. Model output never supplies module ids. */
export function buildGoalModulePlan(rawProfile, { allowedModuleIds } = {}) {
  const profile = normalizeHouseholdProfile(rawProfile);
  const goals = activeGoals(profile);
  const activeGoalTypes = [...new Set(goals.map((goal) => goal.type))];
  const supportedGoalTypes = activeGoalTypes.filter((goalType) => ROUTES[goalType]);
  const unsupportedGoalTypes = activeGoalTypes.filter((goalType) => !ROUTES[goalType]);
  const selectedFocus = selectedPrimaryGoal(profile, goals);
  const directUnion = new Set(supportedGoalTypes.flatMap((goalType) => ROUTES[goalType].map((route) => route.moduleId)));
  const overloaded = directUnion.size > 3;
  const focusResolved = overloaded && supportedGoalTypes.includes(selectedFocus);
  const plannedGoalTypes = focusResolved ? [selectedFocus] : overloaded ? [] : supportedGoalTypes;
  const deferredGoalTypes = [...new Set([
    ...unsupportedGoalTypes,
    ...(focusResolved ? activeGoalTypes.filter((type) => type !== selectedFocus) : [])
  ])];
  const byModuleId = new Map();
  plannedGoalTypes.forEach((goalType) => ROUTES[goalType].forEach((route) => addRoute(byModuleId, route, goalType)));

  if (byModuleId.size > 0 && byModuleId.size < 3
    && !byModuleId.has(MODULE_IDS.PERSONAL_BALANCE_SHEET)
    && shouldAddBalanceSheet(profile, plannedGoalTypes)
    && isPlanningModuleSelectable(MODULE_IDS.PERSONAL_BALANCE_SHEET)) {
    byModuleId.set(MODULE_IDS.PERSONAL_BALANCE_SHEET, {
      moduleId: MODULE_IDS.PERSONAL_BALANCE_SHEET,
      source: 'balance_sheet_default',
      relatedGoalTypes: [...plannedGoalTypes],
      ruleIds: ['goal.balance_sheet.default.v1']
    });
  }

  const allowed = Array.isArray(allowedModuleIds) ? new Set(allowedModuleIds) : null;
  const moduleSlots = [...byModuleId.values()].slice(0, 3).map((selection, index) => {
    const intake = intakeFor(selection.moduleId, profile, allowed);
    return Object.freeze({
      slot: index + 1,
      moduleId: selection.moduleId,
      source: selection.source,
      relatedGoalTypes: Object.freeze([...selection.relatedGoalTypes]),
      availability: intake.availability,
      intakeStatus: intake.intakeStatus,
      reasons: Object.freeze([...new Set([reasonFor(selection), ...intake.reasons])]),
      missingFactIds: Object.freeze([...intake.missingFactIds]),
      ruleIds: Object.freeze([...selection.ruleIds])
    });
  });
  const executionModuleIds = moduleSlots
    .filter((slot) => slot.availability === 'ready' || slot.availability === 'needs_facts')
    .map((slot) => slot.moduleId);
  const primaryGoalType = focusResolved ? selectedFocus : selectedFocus || supportedGoalTypes[0] || activeGoalTypes[0] || null;
  const requiresDecisionTopicQuestion = activeGoalTypes.includes('assess_decision')
    && supportedGoalTypes.length === 0;
  const requiresGoalPriorityQuestion = overloaded && !focusResolved;
  const confidence = primaryGoalType ? (requiresGoalPriorityQuestion || requiresDecisionTopicQuestion ? 'medium' : 'high') : 'low';

  return Object.freeze({
    selectionPolicyVersion: GOAL_ROUTING_POLICY_VERSION,
    catalogueVersion: getPlanningPlaybookManifestVersion(),
    profileRevision: profile.revision,
    goalAssessment: Object.freeze({
      primaryGoalType,
      activeGoalTypes: Object.freeze([...activeGoalTypes]),
      deferredGoalTypes: Object.freeze([...deferredGoalTypes]),
      evidenceFactIds: Object.freeze(activeGoalTypes.length ? ['primary_goal'] : []),
      confidence
    }),
    moduleSlots: Object.freeze(moduleSlots),
    executionModuleIds: Object.freeze(executionModuleIds),
    requiresGoalPriorityQuestion,
    requiresDecisionTopicQuestion,
    deferredGoalTypes: Object.freeze([...deferredGoalTypes])
  });
}

export function goalPlanRecommendations(plan, rawProfile) {
  const profile = normalizeHouseholdProfile(rawProfile);
  return plan.moduleSlots.map((slot) => ({
    slot: slot.slot,
    moduleId: slot.moduleId,
    availability: slot.availability,
    intakeStatus: slot.intakeStatus,
    relatedGoalTypes: [...slot.relatedGoalTypes],
    priority: 300 - slot.slot,
    source: slot.source,
    status: slot.source === 'goal_companion' ? 'required' : 'recommended',
    rationale: [...slot.reasons],
    triggeredRuleIds: [...slot.ruleIds],
    readiness: getModuleIntakeReadiness(slot.moduleId, profile)
  }));
}

export function getGoalLabel(goalType) {
  return GOAL_LABELS[goalType] || goalType;
}
