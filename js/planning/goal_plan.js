import { GOAL_TYPES, MODULE_IDS } from './contracts.js';
import {
  getModuleIntakeReadiness,
  getPlanningModuleDefinition,
  getPlanningPlaybookManifestVersion,
  isPlanningCapability,
  isPlanningModuleSelectable
} from './module_registry.js';
import {
  effectiveConsumerAvailability,
  isConsumerVisibleModule
} from './module_availability.js';
import { MODULE_MANIFEST } from './module_manifest.generated.js';
import { normalizeHouseholdProfile } from './profile.js';
import { getSemanticFactDefinition, resolveSemanticFact } from './semantic_facts.js';
import { withoutInapplicableFacts } from './fact_preconditions.js';
import { readJsonPointer } from './utils.js';

export const GOAL_ROUTING_POLICY_VERSION = 'goal-routing-1.0.0';

const PRIORITY = Object.freeze({ high: 3, medium: 2, low: 1 });
const SOURCE_RANK = Object.freeze({ goal_direct: 3, goal_companion: 2, balance_sheet_default: 1 });
const EARLY_LIFE_STAGES = new Set(['student', 'early_adult', 'graduate', 'young_employee', 'early_career']);
const NON_OWNING_PROPERTY_STATUSES = new Set([
  'renter', 'first_time_buyer', 'buying_soon', 'delaying_purchase', 'no_property'
]);

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

/**
 * Consumer goal routes, derived from the adviser-authored module manifests.
 *
 * This replaces the hand-maintained ROUTES table. The manifest is the single
 * source of truth shared with the execution-time router in routing_rules.js, so
 * the analyses a conversation selects cannot drift from the analyses the
 * analysis layer runs. See docs/module-catalogue-reconciliation.md §10.
 *
 * Direct routes are ordered before companions, then by module id, which is the
 * order the previous table encoded by hand: a goal's own analysis leads and its
 * supporting analysis follows.
 */
const ROUTES = buildRoutesFromManifest();

function buildRoutesFromManifest() {
  const byGoal = {};
  for (const entry of MODULE_MANIFEST) {
    if (!entry.routing?.consumerRoutable) continue;
    for (const goal of entry.routing.goals || []) {
      (byGoal[goal.type] ||= []).push({
        moduleId: entry.moduleId,
        source: goal.role === 'direct' ? 'goal_direct' : 'goal_companion',
        ruleId: `manifest.${goal.type}.${entry.moduleId}.${goal.role}.v1`
      });
    }
  }
  for (const goalType of Object.keys(byGoal)) {
    byGoal[goalType] = Object.freeze(byGoal[goalType]
      .sort((left, right) => (
        Number(right.source === 'goal_direct') - Number(left.source === 'goal_direct')
        || left.moduleId.localeCompare(right.moduleId)
      ))
      .map(Object.freeze));
  }
  return Object.freeze(byGoal);
}

/** Modules the manifest pins into a plan that still has room for them. */
function pinnedModuleIds() {
  return MODULE_MANIFEST
    .filter((entry) => entry.routing?.pinned === 'when_eligible')
    .map((entry) => entry.moduleId);
}

/**
 * Circumstance-driven module suggestion.
 *
 * A stated goal selects a module. A circumstance only ever *suggests* one: an
 * overall-position request should keep listening for whether a mortgage,
 * pension, loan or education need is relevant, without quietly widening what
 * gets executed. Suggestions are explained to the client and must be confirmed
 * before they join the executed set.
 *
 * Predicates read accumulated profile state, never a single conversational
 * turn, so a suggestion appears when the evidence exists and not before.
 */
const PROFILE_HAS_PREDICATES = Object.freeze({
  cash: (profile) => profile.assets.some((asset) => asset.type === 'cash'),
  pension: (profile) => profile.pensions.length > 0,
  property: (profile) => profile.properties.length > 0,
  business: (profile) => profile.businesses.length > 0,
  dependants: (profile) => profile.dependants.length > 0,
  mortgage: (profile) => profile.liabilities.some((item) => (
    item.type === 'mortgage' || Boolean(item.linkedPropertyId)
  )),
  loan: (profile) => profile.liabilities.some((item) => (
    item.type !== 'mortgage' && !item.linkedPropertyId
  ))
});

function circumstanceValue(profile, factId) {
  const pathPattern = getSemanticFactDefinition(factId)?.mappings?.[0]?.pathPattern;
  return pathPattern ? readJsonPointer(profile, pathPattern) : undefined;
}

function conditionHolds(profile, condition) {
  if (!condition || typeof condition !== 'object') return false;
  if (typeof condition.profileHas === 'string') {
    const predicate = PROFILE_HAS_PREDICATES[condition.profileHas];
    return typeof predicate === 'function' ? predicate(profile) === true : false;
  }
  const value = circumstanceValue(profile, condition.fact);
  if (value === undefined || value === null) return false;
  if (Array.isArray(condition.in)) return condition.in.includes(value);
  if (condition.equals !== undefined) return value === condition.equals;
  if (Number.isFinite(condition.min)) return Number.isFinite(Number(value)) && Number(value) >= condition.min;
  return false;
}

function suggestionReasonFor(profile, entry) {
  for (const rule of entry.routing?.suggestedWhen || []) {
    if ((rule.anyOf || []).some((condition) => conditionHolds(profile, condition))) return rule.reason;
  }
  return null;
}

function moduleIdSet(profile, key) {
  const value = planningValues(profile)[key];
  return new Set(Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []);
}

/** Offers the client has said yes to. Acceptance alone does not execute. */
function acceptedModuleIds(profile) {
  return moduleIdSet(profile, 'acceptedModuleIds');
}

/** Offers the client has said no to. A decline is durable and silences the offer. */
function declinedModuleIds(profile) {
  return moduleIdSet(profile, 'declinedModuleIds');
}

/** The final module set the client confirmed. Only these may execute. */
function confirmedModuleIds(profile) {
  return moduleIdSet(profile, 'confirmedModuleIds');
}

/**
 * Analyses the client removed to make room for another. The analysis goes; the
 * goal behind it stays active, so it can be picked up in a later cycle.
 */
function replacedModuleIds(profile) {
  return moduleIdSet(profile, 'replacedModuleIds');
}

/**
 * Analyses the client chose to keep for a later planning cycle. Deferring is a
 * decision, not an invitation to ask again, so these are not re-offered in this
 * cycle. A new cycle makes them candidates again.
 */
function deferredForLaterModuleIds(profile) {
  return moduleIdSet(profile, 'deferredModuleIds');
}

export function planningCycleNumber(profile) {
  const value = Number(planningValues(profile).planningCycle);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

/**
 * Planning values for a fresh cycle. Goals, facts and durable declines survive;
 * the active offer and the confirmed set do not; anything deferred last time
 * becomes a candidate again and is remembered as carried over.
 */
export function nextPlanningCycleValues(planning = {}) {
  const carried = Array.isArray(planning.deferredModuleIds) ? [...planning.deferredModuleIds] : [];
  return {
    ...planning,
    planningCycle: (Number.isInteger(planning.planningCycle) ? planning.planningCycle : 1) + 1,
    acceptedModuleIds: [],
    confirmedModuleIds: [],
    replacedModuleIds: [],
    deferredModuleIds: [],
    carriedOverModuleIds: carried
  };
}

/**
 * The facts already recorded that make a module relevant. These are what the
 * conversation quotes back — "you mentioned the mortgage" — so an offer is
 * always anchored to something the client actually said.
 */
function supportingFactsFor(profile, entry) {
  const supporting = [];
  for (const rule of entry.routing?.suggestedWhen || []) {
    for (const condition of rule.anyOf || []) {
      if (!conditionHolds(profile, condition)) continue;
      supporting.push(typeof condition.profileHas === 'string'
        ? `position:${condition.profileHas}`
        : condition.fact);
    }
  }
  return [...new Set(supporting)];
}

/**
 * The current application can run at most three analyses in one planning cycle.
 * This is a product constraint, not a financial-planning rule, and it is
 * explained to the client in those terms when a fourth becomes relevant.
 */
export const MAX_CONSUMER_ANALYSES = 3;

const MANIFEST_ORDER = new Map(MODULE_MANIFEST.map((entry, index) => [entry.moduleId, index]));

function manifestOrder(moduleId) {
  const index = MANIFEST_ORDER.get(moduleId);
  return Number.isInteger(index) ? index : MANIFEST_ORDER.size;
}

/**
 * Ranking tiers. A primary goal moves its modules up; it never removes anything.
 *
 *   1. modules the client explicitly asked for
 *   2. modules serving the stated primary goal
 *   3. modules serving any other stated goal
 *   4. modules discovered from circumstances, including the pinned balance sheet
 */
function candidateTier(selection, primaryGoalType) {
  if (selection.source === 'client_accepted_offer') return 1;
  if (selection.source === 'balance_sheet_default') return 4;
  if (primaryGoalType && selection.relatedGoalTypes.includes(primaryGoalType)) return 2;
  if (selection.relatedGoalTypes.length > 0) return 3;
  return 4;
}

/**
 * Within a tier: explicit client priority first, then the order the goals were
 * mentioned. `activeGoals` is already sorted that way, so its index expresses
 * both deterministically.
 */
function goalRank(selection, goals) {
  let best = Number.MAX_SAFE_INTEGER;
  goals.forEach((goal, index) => {
    if (selection.relatedGoalTypes.includes(goal.type)) best = Math.min(best, index);
  });
  return best;
}

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

/**
 * A household that has said it does not own property has already answered the
 * balance sheet's most expensive question. Adding the analysis anyway is what
 * makes a renter saving for a first home get asked what their home is worth.
 */
function declaredNoProperty(profile) {
  const status = profile.assumptions?.values?.persona?.propertyStatus;
  return NON_OWNING_PROPERTY_STATUSES.has(String(status || ''));
}

function shouldAddBalanceSheet(profile, goalTypes) {
  if (goalTypes.includes('understand_position') || goalTypes.includes('build_wealth')) return true;
  if (isEarlyLife(profile) || declaredNoProperty(profile)) return hasMeaningfulPosition(profile);
  return true;
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

function intakeFor(moduleId, profile, allowedModuleIds, adviserOverrides = null) {
  const definition = getPlanningModuleDefinition(moduleId);
  const readiness = getModuleIntakeReadiness(moduleId, profile);
  const missingFactIds = [...new Set(withoutInapplicableFacts(
    (readiness.requiredMissing || []).map((item) => ({
      factId: resolveSemanticFact(item, { profile, moduleId }).factId,
      moduleId
    })),
    profile
  ).map((item) => item.factId))];
  // Release is decided by the four authoritative controls, not by the legacy
  // consumerAvailable boolean, so an adviser enabling an approved module takes
  // effect here rather than being overruled by stale manifest data.
  // A required input the client has told us they do not know BLOCKS this
  // analysis. We asked, we offered to take an estimate, and they do not have
  // one; continuing to hold a slot for an analysis that can never run would
  // keep a more useful one out.
  //
  // This is DERIVED, never stored, so it reverses by itself: the moment the
  // client volunteers the figure, the unknown marker is cleared by
  // clearCompletionFactMarker and the analysis returns to the plan on its own.
  // Only an ESSENTIAL input blocks. A fact the analysis can proceed without --
  // one it assumes, or treats as optional -- is simply not asked again once the
  // client says they do not know it. Blocking on those would drop analyses that
  // are perfectly runnable.
  const unknownFactIds = profile.assumptions?.values?.completionFacts?.unknownFactIds || {};
  const blockingFactIds = [...new Set(
    (readiness.requiredMissing || [])
      .filter((item) => item?.importance === 'required')
      .map((item) => resolveSemanticFact(item, { profile, moduleId }).factId)
      .filter((factId) => unknownFactIds[factId] === true)
  )];

  const releaseAllowed = isConsumerVisibleModule(moduleId, {
    allowedModuleIds, adviserOverrides
  });
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
  if (blockingFactIds.length > 0) {
    return {
      availability: 'blocked_missing_input',
      intakeStatus: readiness.status,
      missingFactIds,
      blockingFactIds,
      reasons: ['This analysis needs information the client does not have.']
    };
  }
  return {
    availability: ['ready', 'ready_with_assumptions'].includes(readiness.status) ? 'ready' : 'needs_facts',
    intakeStatus: readiness.status,
    missingFactIds,
    blockingFactIds: [],
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
export function buildGoalModulePlan(rawProfile, { allowedModuleIds, adviserOverrides = null } = {}) {
  const profile = normalizeHouseholdProfile(rawProfile);
  const goals = activeGoals(profile);
  const activeGoalTypes = [...new Set(goals.map((goal) => goal.type))];
  const supportedGoalTypes = activeGoalTypes.filter((goalType) => ROUTES[goalType]);
  const unsupportedGoalTypes = activeGoalTypes.filter((goalType) => !ROUTES[goalType]);
  const selectedFocus = selectedPrimaryGoal(profile, goals);

  // Every supported goal is routed. A primary goal changes where its modules
  // RANK; it never deletes the others. A client who wants a home and a pension
  // review has two real goals, and dropping one because it lost a focus question
  // is how a meeting quietly stops serving half of what was asked for.
  const byModuleId = new Map();
  supportedGoalTypes.forEach((goalType) => ROUTES[goalType].forEach((route) => addRoute(byModuleId, route, goalType)));

  // Manifest-pinned modules are candidates too, ranked in the lowest tier so
  // they yield to anything the client actually asked for. A pin fills space
  // beside a real goal; it never becomes the whole plan on its own, so a client
  // whose only goal has no consumer analysis still gets a clarifying question
  // rather than a balance sheet nobody asked for.
  const hasRoutedGoal = byModuleId.size > 0;
  for (const moduleId of hasRoutedGoal ? pinnedModuleIds() : []) {
    if (byModuleId.has(moduleId) || !isPlanningModuleSelectable(moduleId)) continue;
    if (moduleId === MODULE_IDS.PERSONAL_BALANCE_SHEET && !shouldAddBalanceSheet(profile, supportedGoalTypes)) continue;
    byModuleId.set(moduleId, {
      moduleId,
      source: 'balance_sheet_default',
      relatedGoalTypes: [...supportedGoalTypes],
      ruleIds: [`manifest.pinned.${moduleId}.v1`]
    });
  }

  const allowed = Array.isArray(allowedModuleIds) ? new Set(allowedModuleIds) : null;
  const visibility = { allowedModuleIds: allowed, adviserOverrides };
  const accepted = acceptedModuleIds(profile);
  const declined = declinedModuleIds(profile);
  const confirmed = confirmedModuleIds(profile);
  const replaced = replacedModuleIds(profile);
  const deferredForLater = deferredForLaterModuleIds(profile);

  // An accepted offer is a candidate in the top tier: the client asked for it.
  // It still competes for one of the three slots rather than appending beyond
  // them, because the cap is a limit on what the application can run.
  for (const moduleId of accepted) {
    if (byModuleId.has(moduleId) || isPlanningCapability(moduleId)) continue;
    byModuleId.set(moduleId, {
      moduleId,
      source: 'client_accepted_offer',
      relatedGoalTypes: [...supportedGoalTypes],
      ruleIds: [`manifest.offer.${moduleId}.accepted.v1`]
    });
  }

  // FILTER BEFORE RANKING. A module the consumer cannot see must not consume one
  // of the three slots, reach the client-facing set, or displace an analysis
  // that is actually available. Before this, a gated analysis such as the net
  // retirement cash flow silently took a slot and produced nothing.
  // A blocked analysis is filtered out BEFORE ranking, exactly like a hidden
  // one, so the slot it would have taken goes to something that can actually
  // run. It is recorded separately so the meeting can explain the drop in the
  // client's own terms.
  const blockedSelections = [];
  const eligible = [...byModuleId.values()].filter((selection) => {
    if (!isConsumerVisibleModule(selection.moduleId, visibility)
      || replaced.has(selection.moduleId)
      || deferredForLater.has(selection.moduleId)
      || declined.has(selection.moduleId)) {
      return false;
    }
    const intake = intakeFor(selection.moduleId, profile, allowed, adviserOverrides);
    if (intake.availability === 'blocked_missing_input') {
      blockedSelections.push(Object.freeze({
        moduleId: selection.moduleId,
        blockingFactIds: Object.freeze([...intake.blockingFactIds]),
        relatedGoalTypes: Object.freeze([...selection.relatedGoalTypes])
      }));
      return false;
    }
    return true;
  });

  const ranked = [...eligible].sort((left, right) => (
    candidateTier(left, selectedFocus) - candidateTier(right, selectedFocus)
    || goalRank(left, goals) - goalRank(right, goals)
    || manifestOrder(left.moduleId) - manifestOrder(right.moduleId)
  ));
  const selections = ranked.slice(0, MAX_CONSUMER_ANALYSES);
  // Anything relevant that did not fit. Recorded, never deleted.
  const overflowSelections = ranked.slice(MAX_CONSUMER_ANALYSES);

  const moduleSlots = selections.map((selection, index) => {
    const intake = intakeFor(selection.moduleId, profile, allowed, adviserOverrides);
    const isAccepted = selection.source === 'client_accepted_offer';
    return Object.freeze({
      slot: index + 1,
      moduleId: selection.moduleId,
      source: selection.source,
      // An accepted offer opens its question queue straight away, but only the
      // confirmed final set may execute.
      selectionState: isAccepted && !confirmed.has(selection.moduleId) ? 'accepted' : 'selected',
      relatedGoalTypes: Object.freeze([...selection.relatedGoalTypes]),
      availability: intake.availability,
      intakeStatus: intake.intakeStatus,
      reasons: Object.freeze([...new Set([reasonFor(selection), ...intake.reasons])]),
      missingFactIds: Object.freeze([...intake.missingFactIds]),
      ruleIds: Object.freeze([...selection.ruleIds])
    });
  });

  // Circumstance-driven opportunities.
  //
  // Consumer visibility is a HARD filter applied before anything reaches the
  // conversation layer. A module that is not effectively consumer-available is
  // classified `unavailable` and dropped from the consumer-facing output
  // entirely — it is never described as deferred, adviser-only or available
  // later, because a consumer must not learn it exists. Advisers see the same
  // modules with full status through the adviser catalogue instead.
  const selectedIds = new Set(moduleSlots.map((slot) => slot.moduleId));
  const moduleOpportunities = [];
  const withheldOpportunities = [];
  for (const entry of MODULE_MANIFEST) {
    if (selectedIds.has(entry.moduleId) || isPlanningCapability(entry.moduleId)) continue;
    // A deferred or replaced analysis has already been decided on. Re-offering
    // it would be pressing the client to reconsider within the same cycle.
    if (deferredForLater.has(entry.moduleId) || replaced.has(entry.moduleId)) continue;
    const reason = suggestionReasonFor(profile, entry);
    if (!reason) continue;
    const intake = intakeFor(entry.moduleId, profile, allowed, adviserOverrides);
    const base = {
      moduleId: entry.moduleId,
      relevanceReason: reason,
      supportingFactIds: Object.freeze(supportingFactsFor(profile, entry)),
      missingFactIds: Object.freeze([...intake.missingFactIds]),
      clientBenefit: entry.clientBenefit || '',
      ruleIds: Object.freeze([`manifest.offer.${entry.moduleId}.v1`])
    };
    const availability = effectiveConsumerAvailability(entry.moduleId, visibility);
    if (!availability.visible) {
      // Internal only. Never serialised to a consumer surface.
      withheldOpportunities.push(Object.freeze({
        ...base, state: 'unavailable', blockedBy: availability.blockedBy
      }));
      continue;
    }
    const state = declined.has(entry.moduleId) ? 'declined'
      : accepted.has(entry.moduleId) ? 'accepted'
        : intake.availability === 'needs_facts' && base.missingFactIds.length > 0 && !reason
          ? 'candidate'
          : 'offerable';
    moduleOpportunities.push(Object.freeze({
      ...base,
      state,
      effectiveConsumerAvailability: Object.freeze({ visible: true, gates: availability.gates })
    }));
  }

  // Only a selected slot may execute. An accepted offer has opened its question
  // queue but has not been through the final confirmation, so it waits.
  const executionModuleIds = moduleSlots
    .filter((slot) => slot.selectionState === 'selected')
    .filter((slot) => slot.availability === 'ready' || slot.availability === 'needs_facts')
    .map((slot) => slot.moduleId);
  const primaryGoalType = selectedFocus || supportedGoalTypes[0] || activeGoalTypes[0] || null;
  const requiresDecisionTopicQuestion = activeGoalTypes.includes('assess_decision')
    && supportedGoalTypes.length === 0;

  // Ask which goal matters most when several are live and none has been named
  // primary — but never let the unanswered question empty the plan. The ranking
  // above has already produced a workable provisional set, and the answer
  // re-ranks it rather than creating it.
  const requiresGoalPriorityQuestion = supportedGoalTypes.length > 1 && !selectedFocus;

  // Goals whose analyses did not fit, plus goals with no consumer analysis at
  // all. Recorded so a later cycle can pick them up; never deleted.
  const selectedModuleIds = new Set(moduleSlots.map((slot) => slot.moduleId));
  const unfittedGoalTypes = overflowSelections
    .flatMap((selection) => selection.relatedGoalTypes)
    .filter((goalType) => !moduleSlots.some((slot) => slot.relatedGoalTypes.includes(goalType)));
  const deferredGoalTypes = [...new Set([...unsupportedGoalTypes, ...unfittedGoalTypes])];

  // The honest product limit. When the plan is full and something relevant is
  // still waiting, the client is told plainly and chooses; the model never
  // decides what to drop.
  const capacity = Object.freeze({
    maximumAnalyses: MAX_CONSUMER_ANALYSES,
    used: moduleSlots.length,
    atLimit: moduleSlots.length >= MAX_CONSUMER_ANALYSES,
    overflowModuleIds: Object.freeze(overflowSelections.map((selection) => selection.moduleId)),
    replaceableModuleIds: Object.freeze([...selectedModuleIds])
  });
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
    // Analyses dropped because the client does not have a required input.
    // Consumer-safe: ids only, described through the manifest's client language.
    blockedModules: Object.freeze(blockedSelections),
    // Consumer-visible opportunities only. Safe to serialise into a prompt.
    moduleOpportunities: Object.freeze(moduleOpportunities.slice(0, 4)),
    // Relevant internally but not consumer-visible. NEVER serialise this to a
    // consumer surface; it exists for adviser tooling and diagnostics.
    withheldOpportunities: Object.freeze(withheldOpportunities),
    executionModuleIds: Object.freeze(executionModuleIds),
    capacity,
    planningCycle: planningCycleNumber(profile),
    requiresGoalPriorityQuestion,
    requiresDecisionTopicQuestion,
    deferredGoalTypes: Object.freeze([...deferredGoalTypes])
  });
}

export function goalPlanRecommendations(plan, rawProfile) {
  const profile = normalizeHouseholdProfile(rawProfile);
  // A blocked analysis stays in the recommendation list even though it has left
  // the slots. It is out of the plan and out of the question queue, but its
  // facts must remain acceptable: if the client later volunteers the figure
  // they did not have, the block clears and the analysis comes back. Dropping
  // it from here entirely would make that recovery impossible.
  const blocked = (plan.blockedModules || []).map((item) => ({
    slot: null,
    moduleId: item.moduleId,
    availability: 'blocked_missing_input',
    intakeStatus: 'missing_information',
    relatedGoalTypes: [...item.relatedGoalTypes],
    priority: 0,
    source: 'blocked',
    status: 'blocked',
    rationale: ['This analysis needs information the client does not have.'],
    triggeredRuleIds: [],
    blockingFactIds: [...item.blockingFactIds],
    readiness: getModuleIntakeReadiness(item.moduleId, profile)
  }));
  return blocked.concat(plan.moduleSlots.map((slot) => ({
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
  })));
}

export function getGoalLabel(goalType) {
  return GOAL_LABELS[goalType] || goalType;
}
