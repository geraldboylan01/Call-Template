import { MODULE_IDS } from './contracts.js';
import {
  getModuleIntakeReadiness,
  getPlanningModuleDefinition
} from './module_registry.js';
import { normalizeHouseholdProfile } from './profile.js';
import { resolveSemanticFact } from './semantic_facts.js';

export const PERSONA_CATALOGUE_VERSION = 'planeir-persona-1.0.0';

const PBS = MODULE_IDS.PERSONAL_BALANCE_SHEET;
const LIQUIDITY = MODULE_IDS.LIQUIDITY;
const HOUSE = MODULE_IDS.HOUSE_PURCHASE;
const PENSION = MODULE_IDS.PENSION_PROJECTION;
const RETIREMENT = MODULE_IDS.RETIREMENT_ROUTER;
const EDUCATION = MODULE_IDS.COLLEGE_FUNDING;
const CAT = MODULE_IDS.CAT;
const BUSINESS_OWNER = MODULE_IDS.BUSINESS_OWNER_ANALYSIS;
const BUSINESS_RELIEF = MODULE_IDS.BUSINESS_RELIEF_ANALYSIS;
const AGRICULTURAL = MODULE_IDS.AGRICULTURAL_RELIEF;

function definePersona({
  personaId,
  label,
  selfDescriptionSignals = [],
  goalSignals = [],
  lifeStageSignals = [],
  circumstanceSignals = [],
  contradictionSignals = [],
  defaultModuleIds,
  specificity = 0
}) {
  if (!Array.isArray(defaultModuleIds) || defaultModuleIds.length !== 3
    || new Set(defaultModuleIds).size !== 3 || !defaultModuleIds.includes(PBS)) {
    throw new Error(`Persona ${personaId} must define exactly three distinct modules including the personal balance sheet.`);
  }
  return Object.freeze({
    personaId,
    label,
    selfDescriptionSignals: Object.freeze([...selfDescriptionSignals]),
    goalSignals: Object.freeze([...goalSignals]),
    lifeStageSignals: Object.freeze([...lifeStageSignals]),
    circumstanceSignals: Object.freeze([...circumstanceSignals]),
    contradictionSignals: Object.freeze([...contradictionSignals]),
    defaultModuleIds: Object.freeze([...defaultModuleIds]),
    specificity,
    version: PERSONA_CATALOGUE_VERSION
  });
}

/**
 * Authoritative v1 persona catalogue. Labels are internal by default; the
 * public contract exposes circumstances and selection reasons instead.
 */
export const PERSONA_CATALOGUE = Object.freeze([
  definePersona({
    personaId: 'student_early_adult', label: 'Student / early adult',
    selfDescriptionSignals: ['student', 'early_adult'],
    lifeStageSignals: ['student', 'early_adult'],
    circumstanceSignals: ['studying', 'limited_income'],
    contradictionSignals: ['retired', 'business_owner'],
    defaultModuleIds: [LIQUIDITY, PBS, PENSION], specificity: 2
  }),
  definePersona({
    personaId: 'graduate_young_employee', label: 'Graduate / young employee',
    selfDescriptionSignals: ['graduate', 'young_employee'],
    lifeStageSignals: ['graduate', 'young_employee'],
    circumstanceSignals: ['employee', 'early_career'],
    contradictionSignals: ['retired'],
    defaultModuleIds: [PBS, PENSION, LIQUIDITY], specificity: 2
  }),
  definePersona({
    personaId: 'first_time_buyer', label: 'First-time buyer',
    selfDescriptionSignals: ['first_time_buyer'], goalSignals: ['buy_home'],
    lifeStageSignals: ['early_adult', 'young_employee', 'young_professional'],
    circumstanceSignals: ['first_time_buyer', 'renter'],
    contradictionSignals: ['older_retiree'],
    defaultModuleIds: [PBS, HOUSE, LIQUIDITY], specificity: 5
  }),
  definePersona({
    personaId: 'young_professional_delaying_purchase', label: 'Young professional delaying purchase',
    selfDescriptionSignals: ['young_professional'], goalSignals: ['buy_home', 'improve_pension'],
    lifeStageSignals: ['young_professional'],
    circumstanceSignals: ['delaying_purchase', 'employee'],
    contradictionSignals: ['retired', 'first_time_buyer_immediate'],
    defaultModuleIds: [PBS, HOUSE, PENSION], specificity: 4
  }),
  definePersona({
    personaId: 'couple_combining_finances', label: 'Couple combining finances',
    selfDescriptionSignals: ['combining_finances'],
    lifeStageSignals: ['young_employee', 'young_professional', 'established_professional'],
    circumstanceSignals: ['couple', 'combining_finances'],
    contradictionSignals: ['single_household'],
    defaultModuleIds: [PBS, HOUSE, PENSION], specificity: 4
  }),
  definePersona({
    personaId: 'new_parent_young_family', label: 'New parent / young family',
    selfDescriptionSignals: ['new_parent', 'young_family'], goalSignals: ['assess_decision'],
    lifeStageSignals: ['young_employee', 'young_professional'],
    circumstanceSignals: ['parent', 'new_parent', 'dependants'],
    contradictionSignals: ['no_dependants'],
    defaultModuleIds: [PBS, EDUCATION, PENSION], specificity: 5
  }),
  definePersona({
    personaId: 'established_professional', label: 'Established professional',
    selfDescriptionSignals: ['established_professional'], goalSignals: ['retire', 'improve_pension'],
    lifeStageSignals: ['established_professional'],
    circumstanceSignals: ['employee', 'established_career'],
    contradictionSignals: ['student', 'retired'],
    defaultModuleIds: [PBS, RETIREMENT, PENSION], specificity: 2
  }),
  definePersona({
    personaId: 'mid_career_behind_retirement', label: 'Mid-career and behind on retirement',
    selfDescriptionSignals: ['behind_on_retirement'], goalSignals: ['retire', 'improve_pension'],
    lifeStageSignals: ['mid_career'],
    circumstanceSignals: ['retirement_behind', 'employee'],
    contradictionSignals: ['retired'],
    defaultModuleIds: [PBS, RETIREMENT, PENSION], specificity: 5
  }),
  definePersona({
    personaId: 'self_employed_professional', label: 'Self-employed professional',
    selfDescriptionSignals: ['self_employed'], goalSignals: ['improve_pension', 'maintain_liquidity'],
    lifeStageSignals: ['young_professional', 'established_professional', 'mid_career'],
    circumstanceSignals: ['self_employed', 'variable_income'],
    contradictionSignals: ['employee_only', 'retired'],
    defaultModuleIds: [PBS, PENSION, LIQUIDITY], specificity: 4
  }),
  definePersona({
    personaId: 'company_director_owner_manager', label: 'Company director / owner-manager',
    selfDescriptionSignals: ['company_director', 'owner_manager'], goalSignals: ['business_planning', 'retire'],
    lifeStageSignals: ['young_professional', 'established_professional', 'mid_career'],
    circumstanceSignals: ['company_director', 'owner_manager', 'business_owner'],
    contradictionSignals: ['no_business_interest'],
    defaultModuleIds: [PBS, BUSINESS_OWNER, RETIREMENT], specificity: 5
  }),
  definePersona({
    personaId: 'business_owner_approaching_exit', label: 'Business owner approaching exit',
    selfDescriptionSignals: ['business_owner', 'business_exit'], goalSignals: ['business_planning', 'transfer_wealth'],
    lifeStageSignals: ['mid_career', 'pre_retiree'],
    circumstanceSignals: ['business_owner', 'business_exit'],
    contradictionSignals: ['no_business_interest'],
    defaultModuleIds: [PBS, BUSINESS_OWNER, BUSINESS_RELIEF], specificity: 5
  }),
  definePersona({
    personaId: 'farmer_agricultural_business_owner', label: 'Farmer / agricultural business owner',
    selfDescriptionSignals: ['farmer'], goalSignals: ['agricultural_planning', 'business_planning'],
    lifeStageSignals: ['young_professional', 'established_professional', 'mid_career', 'pre_retiree'],
    circumstanceSignals: ['agricultural_assets', 'business_owner'],
    contradictionSignals: ['no_agricultural_assets'],
    defaultModuleIds: [PBS, AGRICULTURAL, BUSINESS_RELIEF], specificity: 5
  }),
  definePersona({
    personaId: 'pre_retiree', label: 'Pre-retiree',
    selfDescriptionSignals: ['pre_retiree'], goalSignals: ['retire', 'retire_early'],
    lifeStageSignals: ['pre_retiree'],
    circumstanceSignals: ['approaching_retirement', 'has_pension'],
    contradictionSignals: ['retired', 'student'],
    defaultModuleIds: [PBS, RETIREMENT, PENSION], specificity: 4
  }),
  definePersona({
    personaId: 'newly_retired', label: 'Newly retired',
    selfDescriptionSignals: ['newly_retired'], goalSignals: ['retire', 'transfer_wealth'],
    lifeStageSignals: ['newly_retired'],
    circumstanceSignals: ['retired', 'recently_retired'],
    contradictionSignals: ['employee_only', 'student'],
    defaultModuleIds: [PBS, RETIREMENT, CAT], specificity: 5
  }),
  definePersona({
    personaId: 'older_retiree', label: 'Older retiree',
    selfDescriptionSignals: ['older_retiree'], goalSignals: ['transfer_wealth', 'maintain_liquidity'],
    lifeStageSignals: ['older_retiree'],
    circumstanceSignals: ['retired', 'later_retirement'],
    contradictionSignals: ['employee_only', 'student'],
    defaultModuleIds: [PBS, CAT, LIQUIDITY], specificity: 5
  }),
  definePersona({
    personaId: 'high_net_worth_family', label: 'High-net-worth family',
    selfDescriptionSignals: ['high_net_worth_family'], goalSignals: ['retire', 'transfer_wealth'],
    lifeStageSignals: ['established_professional', 'mid_career', 'pre_retiree', 'retired'],
    circumstanceSignals: ['high_net_worth', 'family'],
    contradictionSignals: ['limited_income'],
    defaultModuleIds: [PBS, RETIREMENT, CAT], specificity: 5
  }),
  definePersona({
    personaId: 'parent_funding_education', label: 'Parent funding children’s education',
    selfDescriptionSignals: ['funding_education'], goalSignals: ['assess_decision'],
    lifeStageSignals: ['young_professional', 'established_professional', 'mid_career'],
    circumstanceSignals: ['education_funding', 'dependants', 'parent'],
    contradictionSignals: ['no_dependants'],
    defaultModuleIds: [PBS, EDUCATION, RETIREMENT], specificity: 5
  }),
  definePersona({
    personaId: 'parent_grandparent_transferring_wealth', label: 'Parent/grandparent transferring wealth',
    selfDescriptionSignals: ['transferring_wealth'], goalSignals: ['transfer_wealth'],
    lifeStageSignals: ['established_professional', 'mid_career', 'pre_retiree', 'retired', 'older_retiree'],
    circumstanceSignals: ['wealth_transfer', 'parent_or_grandparent'],
    contradictionSignals: [],
    defaultModuleIds: [PBS, CAT, RETIREMENT], specificity: 5
  }),
  definePersona({
    personaId: 'lump_sum_recipient', label: 'Lump-sum recipient',
    selfDescriptionSignals: ['lump_sum_recipient'], goalSignals: ['assess_decision', 'retire'],
    lifeStageSignals: ['early_adult', 'young_employee', 'young_professional', 'established_professional', 'mid_career', 'pre_retiree', 'retired'],
    circumstanceSignals: ['lump_sum_recipient', 'cash_event'],
    contradictionSignals: [],
    defaultModuleIds: [PBS, RETIREMENT, LIQUIDITY], specificity: 5
  }),
  definePersona({
    personaId: 'immediate_financial_decision_user', label: 'Immediate financial-decision user',
    selfDescriptionSignals: ['immediate_decision'],
    goalSignals: ['buy_home', 'optimise_mortgage', 'assess_decision', 'transfer_wealth', 'business_planning', 'agricultural_planning'],
    lifeStageSignals: [], circumstanceSignals: ['immediate_decision'], contradictionSignals: [],
    defaultModuleIds: [PBS, RETIREMENT, LIQUIDITY], specificity: 1
  })
]);

const PERSONAS_BY_ID = new Map(PERSONA_CATALOGUE.map((persona, index) => [persona.personaId, { persona, index }]));

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function personaData(profile) {
  const raw = profile.assumptions?.values?.persona;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function signalSet(raw) {
  const result = new Set();
  const add = (value) => {
    const normalized = nonEmptyString(value)?.toLowerCase().replace(/[ -]+/g, '_');
    if (normalized) result.add(normalized);
  };
  if (Array.isArray(raw)) raw.forEach(add);
  else add(raw);
  return result;
}

function inferLifeStages(profile, data) {
  const stages = signalSet(data.lifeStage);
  signalSet(data.careerStage).forEach((stage) => stages.add(stage));
  const age = profile.primaryPerson?.age;
  const retired = profile.primaryPerson?.employmentStatus === 'retired'
    || ['newly_retired', 'older_retiree', 'retired'].includes(data.retirementStatus);
  if (retired) {
    stages.add(data.retirementStatus === 'older_retiree' || age >= 75 ? 'older_retiree' : 'newly_retired');
    stages.add('retired');
    return stages;
  }
  if (Number.isInteger(age)) {
    if (age <= 23) stages.add('early_adult');
    else if (age <= 30) stages.add('young_employee');
    else if (age <= 39) stages.add('young_professional');
    else if (age <= 49) stages.add('established_professional');
    else if (age <= 59) stages.add('mid_career');
    else stages.add('pre_retiree');
  }
  return stages;
}

function deriveSignals(profile) {
  const data = personaData(profile);
  const selfDescriptions = signalSet(data.selfDescription);
  const lifeStages = inferLifeStages(profile, data);
  const circumstances = signalSet(data.circumstances);
  const evidenceBySignal = new Map();
  const add = (signal, factId) => {
    circumstances.add(signal);
    if (!evidenceBySignal.has(signal)) evidenceBySignal.set(signal, factId);
  };

  selfDescriptions.forEach((signal) => evidenceBySignal.set(signal, 'self_description'));
  lifeStages.forEach((signal) => evidenceBySignal.set(signal, 'life_stage'));
  const goalTypes = new Set(profile.goals
    .filter((goal) => !['completed', 'paused'].includes(goal.status))
    .map((goal) => goal.type));

  if (profile.partner || data.householdStructure === 'couple') add('couple', 'household_structure');
  else if (data.householdStructure === 'single') add('single_household', 'household_structure');
  if (profile.dependants.length > 0 || Number(data.dependantCount) > 0) {
    add('dependants', 'dependants'); add('parent', 'dependants'); add('family', 'dependants');
  } else if (data.hasDependants === false) add('no_dependants', 'dependants');
  const employment = data.employmentContext || profile.primaryPerson?.employmentStatus;
  if (employment === 'employee') add('employee', 'employment_context');
  if (employment === 'self_employed') add('self_employed', 'employment_context');
  if (employment === 'retired') add('retired', 'retirement_status');
  if (['company_director', 'owner_manager', 'business_owner'].includes(employment)) {
    add(employment, 'employment_context'); add('business_owner', 'employment_context');
  }
  if (data.businessContext) {
    add(String(data.businessContext), 'business_context');
    if (!['no_business_interest', 'self_employed'].includes(data.businessContext)) add('business_owner', 'business_context');
    if (data.businessContext === 'farmer') add('agricultural_assets', 'business_context');
  }
  if (data.businessContext === 'no_business_interest') add('no_business_interest', 'business_context');
  if (data.retirementStatus) {
    add(String(data.retirementStatus), 'retirement_status');
    if (['newly_retired', 'retired', 'older_retiree'].includes(data.retirementStatus)) add('retired', 'retirement_status');
  }
  if (profile.pensions.length > 0 || data.hasPension === true) add('has_pension', 'pension_positions');
  if (profile.businesses.length > 0) add('business_owner', 'business_context');
  if (profile.businesses.some((business) => business.agricultural)
    || profile.assets.some((asset) => asset.type === 'agricultural')
    || profile.properties.some((property) => property.use === 'farm')
    || data.agriculturalAssets === true) add('agricultural_assets', 'agricultural_assets');
  if (data.agriculturalAssets === false) add('no_agricultural_assets', 'agricultural_assets');
  if (data.propertyStatus) add(String(data.propertyStatus), 'property_status');
  if (profile.assumptions?.values?.housePurchase?.lendingCategory === 'first_time_buyer') {
    add('first_time_buyer', 'lending_category');
  }
  if (data.financeCombining === true) add('combining_finances', 'finance_combining');
  if (data.newParent === true) add('new_parent', 'new_parent_status');
  if (data.delayingPurchase === true) add('delaying_purchase', 'property_status');
  if (data.retirementBehind === true) add('retirement_behind', 'retirement_readiness');
  if (data.retirementReadiness === 'retirement_behind') add('retirement_behind', 'retirement_readiness');
  if (data.companyDirector === true) add('company_director', 'business_context');
  if (data.ownerManager === true) add('owner_manager', 'business_context');
  if (data.businessExit === true) add('business_exit', 'business_exit_intent');
  if (data.educationFunding === true) add('education_funding', 'education_funding_intent');
  if (data.wealthTransfer === true) add('wealth_transfer', 'wealth_transfer_intent');
  if (data.parentOrGrandparent === true) add('parent_or_grandparent', 'household_structure');
  if (data.highNetWorth === true) add('high_net_worth', 'high_net_worth_context');
  if (data.lumpSumRecipient === true) add('lump_sum_recipient', 'lump_sum_status');
  if (data.immediateDecision === true) add('immediate_decision', 'immediate_decision_context');
  if (data.variableIncome === true) add('variable_income', 'employment_context');

  return { data, selfDescriptions, goalTypes, lifeStages, circumstances, evidenceBySignal };
}

function matching(set, candidates) {
  return candidates.filter((signal) => set.has(signal));
}

function assessDefinition(definition, signals, index) {
  const explicitMatches = matching(signals.selfDescriptions, definition.selfDescriptionSignals);
  const goalMatches = matching(signals.goalTypes, definition.goalSignals);
  const lifeStageMatches = matching(signals.lifeStages, definition.lifeStageSignals);
  const circumstanceMatches = matching(signals.circumstances, definition.circumstanceSignals);
  const contradictionMatches = matching(signals.circumstances, definition.contradictionSignals);
  const score = (explicitMatches.length ? 60 : 0)
    + (goalMatches.length ? 50 : 0)
    + (lifeStageMatches.length ? 40 : 0)
    + Math.min(30, circumstanceMatches.length * 15)
    - (contradictionMatches.length ? 100 : 0);
  const evidenceFactIds = new Set();
  if (explicitMatches.length) evidenceFactIds.add('self_description');
  if (goalMatches.length) evidenceFactIds.add('primary_goal');
  lifeStageMatches.forEach((signal) => evidenceFactIds.add(signals.evidenceBySignal.get(signal) || 'life_stage'));
  circumstanceMatches.forEach((signal) => evidenceFactIds.add(signals.evidenceBySignal.get(signal) || 'persona_circumstances'));
  contradictionMatches.forEach((signal) => evidenceFactIds.add(signals.evidenceBySignal.get(signal) || 'persona_circumstances'));
  return {
    personaId: definition.personaId,
    score,
    explicitMatch: explicitMatches.length > 0,
    goalMatch: goalMatches.length > 0,
    specificity: definition.specificity,
    catalogueOrder: index,
    evidenceFactIds: [...evidenceFactIds],
    matchedSignals: [...new Set([...explicitMatches, ...goalMatches, ...lifeStageMatches, ...circumstanceMatches])],
    contradictionSignals: contradictionMatches
  };
}

function compareCandidate(left, right) {
  return right.score - left.score
    || Number(right.explicitMatch) - Number(left.explicitMatch)
    || Number(right.goalMatch) - Number(left.goalMatch)
    || right.specificity - left.specificity
    || left.catalogueOrder - right.catalogueOrder;
}

export function getPersonaDefinition(personaId) {
  return PERSONAS_BY_ID.get(personaId)?.persona || null;
}

export function listPersonaDefinitions() {
  return [...PERSONA_CATALOGUE];
}

/**
 * Bounded assessment contract for browser and model-tool responses. Internal
 * scores, matched signals, contradictions and catalogue tie-break metadata do
 * not cross the Worker boundary.
 */
export function toPublicPersonaAssessment(assessment) {
  if (!assessment || typeof assessment !== 'object') return null;
  return Object.freeze({
    primaryPersonaId: typeof assessment.primaryPersonaId === 'string'
      ? assessment.primaryPersonaId
      : null,
    candidatePersonaIds: Object.freeze(
      (Array.isArray(assessment.candidatePersonaIds) ? assessment.candidatePersonaIds : [])
        .filter((item) => typeof item === 'string')
        .slice(0, 5)
    ),
    evidenceFactIds: Object.freeze(
      (Array.isArray(assessment.evidenceFactIds) ? assessment.evidenceFactIds : [])
        .filter((item) => typeof item === 'string')
        .slice(0, 20)
    ),
    confidence: ['high', 'medium', 'low'].includes(assessment.confidence)
      ? assessment.confidence
      : 'low',
    catalogueVersion: String(assessment.catalogueVersion || PERSONA_CATALOGUE_VERSION).slice(0, 80),
    profileRevision: Number(assessment.profileRevision || 0)
  });
}

/** Deterministic, versioned persona assessment. The model never supplies the result. */
export function classifyPlanningPersona(rawProfile) {
  const profile = normalizeHouseholdProfile(rawProfile);
  const signals = deriveSignals(profile);
  const candidates = PERSONA_CATALOGUE
    .map((definition, index) => assessDefinition(definition, signals, index))
    .sort(compareCandidate);
  const leading = candidates[0];
  const runnerUp = candidates[1];
  const margin = leading.score - runnerUp.score;
  // An explicit, single self-description is itself the one permitted
  // disambiguating answer and wins the documented tie-break. Do not ask for
  // that same fact again merely because a different explicit goal leaves the
  // numerical margin below 15 points.
  const explicitDisambiguationAnswered = leading.explicitMatch
    && signals.selfDescriptions.size === 1
    && leading.score >= 50;
  const needsDisambiguation = (leading.score < 50 || margin < 15)
    && !explicitDisambiguationAnswered;
  const confidence = needsDisambiguation
    ? 'low'
    : leading.score >= 90 && margin >= 30 ? 'high' : 'medium';
  return Object.freeze({
    primaryPersonaId: leading.score > 0 ? leading.personaId : null,
    candidatePersonaIds: Object.freeze(candidates.filter((item) => item.score > 0).slice(0, 5).map((item) => item.personaId)),
    evidenceFactIds: Object.freeze([...leading.evidenceFactIds]),
    confidence,
    catalogueVersion: PERSONA_CATALOGUE_VERSION,
    profileRevision: profile.revision,
    score: leading.score,
    leadMargin: margin,
    needsDisambiguation,
    disambiguationFactId: needsDisambiguation ? 'self_description' : null,
    scoredCandidates: Object.freeze(candidates.slice(0, 5).map((item) => Object.freeze({
      personaId: item.personaId,
      score: item.score,
      matchedSignals: Object.freeze([...item.matchedSignals]),
      contradictionSignals: Object.freeze([...item.contradictionSignals])
    })))
  });
}

function availabilityFor(moduleId, profile, allowedModuleIds) {
  const definition = getPlanningModuleDefinition(moduleId);
  if (!definition) {
    return { availability: 'unsupported', reasons: ['This analysis is not registered.'], missingFactIds: [] };
  }
  const releaseAllowed = definition.consumerAvailable === true
    && (!allowedModuleIds || allowedModuleIds.has(moduleId));
  const intakeReadiness = getModuleIntakeReadiness(moduleId, profile);
  const missingFactIds = [...new Set((intakeReadiness.requiredMissing || []).map((missing) => (
    resolveSemanticFact(missing, { profile, moduleId }).factId
  )))];
  if (!releaseAllowed) {
    return {
      availability: 'adviser_review_required',
      reasons: [definition.status === 'adviser_only'
        ? 'This analysis requires Gerry’s review.'
        : 'This deterministic analysis has not passed its consumer release gate.',
      ...(intakeReadiness.warnings || []).slice(0, 2)],
      missingFactIds
    };
  }
  return {
    availability: ['ready', 'ready_with_assumptions'].includes(intakeReadiness.status) ? 'ready' : 'needs_facts',
    reasons: intakeReadiness.warnings?.length
      ? intakeReadiness.warnings.slice(0, 3)
      : missingFactIds.length ? ['More confirmed information is required before this analysis can run.'] : [],
    missingFactIds
  };
}

/**
 * Build the exactly-three, user-facing analysis contract from the resolved
 * persona. `defaultModuleIds` is the sole module-selection authority: goals,
 * preferred focuses and other profile values can help classify the persona,
 * but can never replace one of its three modules. An unresolved or ambiguous
 * classification deliberately has no provisional module plan.
 *
 * Only `executionModuleIds` may be passed to deterministic engines; gated
 * catalogue slots remain visible in the confirmed plan.
 */
export function buildPersonaModulePlan(rawProfile, { allowedModuleIds } = {}) {
  const profile = normalizeHouseholdProfile(rawProfile);
  const assessment = classifyPlanningPersona(profile);
  const persona = assessment.needsDisambiguation
    ? null
    : getPersonaDefinition(assessment.primaryPersonaId);
  const moduleIds = persona ? [...persona.defaultModuleIds] : [];

  const allowed = Array.isArray(allowedModuleIds) ? new Set(allowedModuleIds) : null;
  const moduleSlots = moduleIds.map((moduleId, index) => {
    const availability = availabilityFor(moduleId, profile, allowed);
    return Object.freeze({
      slot: index + 1,
      moduleId,
      source: 'persona_default',
      availability: availability.availability,
      reasons: Object.freeze([...new Set([
        'Selected from the authoritative module table for the confirmed persona.',
        ...availability.reasons
      ])]),
      missingFactIds: Object.freeze(availability.missingFactIds)
    });
  });
  const executionModuleIds = moduleSlots
    .filter((slot) => slot.availability === 'ready' || slot.availability === 'needs_facts')
    .map((slot) => slot.moduleId);
  return Object.freeze({
    catalogueVersion: PERSONA_CATALOGUE_VERSION,
    profileRevision: profile.revision,
    personaAssessment: assessment,
    moduleSlots: Object.freeze(moduleSlots),
    overrides: Object.freeze([]),
    executionModuleIds: Object.freeze(executionModuleIds),
    requiresGoalPriorityQuestion: false,
    requiresDecisionTopicQuestion: false,
    deferredGoalTypes: Object.freeze([])
  });
}

export function personaPlanRecommendations(plan, rawProfile) {
  const profile = normalizeHouseholdProfile(rawProfile);
  return plan.moduleSlots.map((slot) => {
    const readiness = slot.availability === 'unsupported'
        ? { status: 'unsupported', requiredMissing: [], assumptionsUsed: [], warnings: [...slot.reasons] }
        : getModuleIntakeReadiness(slot.moduleId, profile);
    return {
      slot: slot.slot,
      moduleId: slot.moduleId,
      availability: slot.availability,
      priority: 300 - slot.slot,
      source: slot.source,
      status: slot.source === 'persona_default' ? 'recommended' : 'required',
      rationale: [...slot.reasons],
      triggeredRuleIds: slot.source === 'persona_default'
        ? [`persona.${plan.personaAssessment.primaryPersonaId}.v1`]
        : plan.overrides.filter((override) => override.slot === slot.slot).map((override) => override.ruleId),
      readiness
    };
  });
}
