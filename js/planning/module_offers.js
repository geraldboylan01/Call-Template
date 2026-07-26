/**
 * Spoken module offers.
 *
 * A relevant module is never added silently and never triggers its own
 * fact-find before the client has agreed to it. It is offered in one turn that
 * does three things: names something the client actually said, explains what
 * the analysis would do for them in ordinary language, and asks.
 *
 *     "You mentioned [circumstance]. [Outcome we can explore]. [Question]"
 *
 * Every client-facing description is owned by the module manifest, not by
 * conversation branches, so adding a module does not mean editing the
 * conversation.
 */

import { MODULE_IDS } from './contracts.js';
import { getModuleManifest, listModuleManifests } from './module_availability.js';

export const MODULE_OFFER_POLICY_VERSION = 'module-offer-1.1.0';

const LEGACY_FORMAL_MODULE_TERMS = Object.freeze([
  'House Purchase',
  'Liquidity Analysis'
]);

function normalizedTerminology(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[_\u2010-\u2015-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const INTERNAL_MODULE_TERMS = Object.freeze([
  ...listModuleManifests().flatMap((manifest) => [manifest.moduleId, manifest.name]),
  ...Object.values(MODULE_IDS),
  ...LEGACY_FORMAL_MODULE_TERMS
]
  .filter((value, index, values) => (
    typeof value === 'string' && value && values.indexOf(value) === index
  ))
  .map(normalizedTerminology));

/**
 * Detect catalogue names or ids in prose before it reaches a consumer surface.
 * This is a boundary check for legacy/model-authored copy, not a substitute for
 * composing new copy from the validated descriptors below.
 */
export function containsInternalModuleTerminology(value) {
  const text = normalizedTerminology(value);
  return Boolean(text) && INTERNAL_MODULE_TERMS.some((term) => text.includes(term));
}

function sentence(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function activeGoalTypes(profile) {
  return new Set((profile?.goals || [])
    .filter((goal) => !['completed', 'paused'].includes(goal?.status))
    .map((goal) => goal?.type)
    .filter(Boolean));
}

function offerClauseApplies(clause, profile) {
  const anyGoal = clause?.when?.anyGoal;
  if (!Array.isArray(anyGoal) || anyGoal.length === 0) return false;
  const goals = activeGoalTypes(profile);
  return anyGoal.some((goalType) => goals.has(goalType));
}

/**
 * The sole translation from an internal module id to deterministic language
 * that may be shown or spoken to a client. Missing metadata has no fallback to
 * the formal module name: an incomplete module stays silent.
 */
export function consumerLanguageForModule(moduleId, { profile } = {}) {
  const manifest = getModuleManifest(moduleId);
  const language = manifest?.consumerLanguage;
  if (
    !manifest
    || manifest?.availability?.platformConsumerApproved !== true
    || manifest?.implementation?.hasRunnableEngine !== true
    || !language
  ) {
    return null;
  }

  const shortDescription = String(language.consumerShortLabel || '').trim();
  const confirmationDescription = String(language.consumerConfirmationDescription || '').trim();
  const offerQuestion = String(language.offerQuestion || '').trim();
  let offerDescription = String(language.consumerOfferDescription || '').trim();
  if (!shortDescription || !confirmationDescription || !offerQuestion || !offerDescription) return null;

  for (const clause of language.offerClauses || []) {
    if (offerClauseApplies(clause, profile)) offerDescription += String(clause.text || '');
  }

  return Object.freeze({
    moduleId,
    offerDescription: offerDescription.trim(),
    shortDescription,
    confirmationDescription,
    offerQuestion
  });
}

/**
 * How a supporting fact is referred to back to the client. These are the
 * client's circumstances in their terms, not our field names.
 */
const FACT_PHRASES = Object.freeze({
  property_status: {
    homeowner: 'you own your home',
    first_time_buyer: 'you are looking to buy your first place',
    buying_soon: 'you are hoping to buy soon',
    renter: 'you are renting at the moment'
  },
  employment_context: {
    self_employed: 'you are self-employed',
    company_director: 'you are a company director',
    owner_manager: 'you run your own business'
  },
  retirement_status: {
    approaching_retirement: 'retirement is coming into view',
    newly_retired: 'you have recently retired',
    retired: 'you are retired'
  },
  life_stage: {
    pre_retiree: 'retirement is coming into view',
    retired: 'you are retired'
  },
  has_pension: { true: 'you have a pension' },
  education_funding_intent: { true: 'you want to help with education costs' },
  agricultural_assets: { true: 'you have agricultural assets' },
  business_exit_intent: { true: 'you are thinking about exiting the business' },
  wealth_transfer_intent: { true: 'passing on wealth matters to you' }
});

const POSITION_PHRASES = Object.freeze({
  'position:mortgage': 'you have a mortgage',
  'position:loan': 'you mentioned a loan',
  'position:pension': 'you have a pension',
  'position:cash': 'you told me what you have in savings',
  'position:property': 'you own property',
  'position:business': 'you have a business interest',
  'position:dependants': 'you have children to plan for'
});

function circumstanceValueFor(profile, factId) {
  const persona = profile?.assumptions?.values?.persona || {};
  const keys = {
    property_status: 'propertyStatus',
    employment_context: 'employmentContext',
    retirement_status: 'retirementStatus',
    life_stage: 'lifeStage',
    has_pension: 'hasPension',
    education_funding_intent: 'educationFunding',
    agricultural_assets: 'agriculturalAssets',
    business_exit_intent: 'businessExit',
    wealth_transfer_intent: 'wealthTransfer',
    dependant_count: 'dependantCount'
  };
  return persona[keys[factId]];
}

/**
 * The clause that anchors an offer to something the client said. Returns null
 * when nothing specific is available, so the caller can decline to offer rather
 * than fall back on generic promotional wording.
 */
export function anchorPhrase(supportingFactIds, profile) {
  for (const factId of supportingFactIds || []) {
    if (POSITION_PHRASES[factId]) return POSITION_PHRASES[factId];
    if (factId === 'dependant_count') {
      const count = Number(circumstanceValueFor(profile, factId));
      if (Number.isFinite(count) && count > 0) {
        return count === 1 ? 'you have a child to plan for' : `you have ${count} children to plan for`;
      }
      continue;
    }
    const value = circumstanceValueFor(profile, factId);
    const phrase = FACT_PHRASES[factId]?.[String(value)];
    if (phrase) return phrase;
  }
  return null;
}

/**
 * Compose the spoken offer for one opportunity.
 *
 * @returns {null|{moduleId, spokenOffer, anchor, benefit, supportingFactIds, requiredFactIds}}
 *   null when the offer cannot be anchored to a stated circumstance or the
 *   module has no validated client language — in both cases it is better to
 *   stay quiet than to sound like an advert.
 */
export function composeModuleOffer(opportunity, { profile } = {}) {
  if (!opportunity || opportunity.state !== 'offerable') return null;
  const manifest = getModuleManifest(opportunity.moduleId);
  const language = consumerLanguageForModule(opportunity.moduleId, { profile });
  if (!language) return null;

  // A client who asked for the analysis outright is already anchored — their own
  // request is the reason. Only a circumstance-driven offer needs a fact quoted
  // back, because that is the one the client did not ask for.
  const goalAnchor = goalAnchorPhrase(opportunity.moduleId, profile);
  const anchor = goalAnchor || anchorPhrase(opportunity.supportingFactIds, profile);
  if (!anchor) return null;
  return Object.freeze({
    moduleId: opportunity.moduleId,
    policyVersion: MODULE_OFFER_POLICY_VERSION,
    anchor,
    anchorSource: goalAnchor ? 'client_request' : 'circumstance',
    // Backward-compatible field: it now carries the validated consumer offer
    // description rather than the older generic clientBenefit.
    benefit: language.offerDescription,
    offerDescription: language.offerDescription,
    shortDescription: language.shortDescription,
    confirmationDescription: language.confirmationDescription,
    offerQuestion: language.offerQuestion,
    spokenOffer: goalAnchor
      ? `${sentence(goalAnchor)} ${sentence(language.offerDescription)} ${language.offerQuestion}`
      : `You mentioned ${anchor}. ${sentence(language.offerDescription)} ${language.offerQuestion}`,
    supportingFactIds: Object.freeze([...(opportunity.supportingFactIds || [])]),
    requiredFactIds: Object.freeze([...(manifest?.requiredFacts || [])])
  });
}

const GOAL_REQUEST_PHRASES = Object.freeze({
  buy_home: 'You said you want to buy a home',
  optimise_mortgage: 'You asked about your mortgage',
  manage_loan: 'You asked about your loan',
  improve_pension: 'You want to get your pension in better shape',
  retire: 'You want to plan for retirement',
  retire_early: 'You want to look at retiring early',
  fund_education: 'You want to plan for education costs',
  maintain_liquidity: 'You want to be sure you have enough put by',
  understand_position: 'You want to see where you stand overall',
  build_wealth: 'You want to build up what you have'
});

/**
 * The client's own request as an anchor, when a goal they stated is one this
 * module directly serves.
 */
export function goalAnchorPhrase(moduleId, profile) {
  const manifest = getModuleManifest(moduleId);
  const served = new Set((manifest?.routing?.goals || []).map((goal) => goal.type));
  const stated = (profile?.goals || [])
    .filter((goal) => !['completed', 'paused'].includes(goal.status))
    .map((goal) => goal.type);
  const match = stated.find((goalType) => served.has(goalType) && GOAL_REQUEST_PHRASES[goalType]);
  return match ? GOAL_REQUEST_PHRASES[match] : null;
}

/**
 * The single next offer for a plan, or null.
 *
 * One at a time: a client asked to choose between three analyses at once will
 * either pick none or agree to all of them without hearing what they are.
 */
export function nextModuleOffer(plan, { profile } = {}) {
  for (const opportunity of plan?.moduleOpportunities || []) {
    const offer = composeModuleOffer(opportunity, { profile });
    if (offer) return offer;
  }
  return null;
}

function readableList(names) {
  return names.join(', ').replace(/, ([^,]*)$/, ' and $1');
}

function lowerInitial(text) {
  const value = String(text || '');
  return value ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : value;
}

function upperInitial(text) {
  const value = String(text || '');
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

/**
 * The spoken explanation when a fourth analysis becomes relevant and the plan is
 * already full.
 *
 * The three-analysis limit is a current product constraint, so it is described
 * as one — not as a planning principle, and never with any suggestion that three
 * is always enough. The client chooses what to drop; the model must not.
 *
 * @returns {null|{spoken, currentModuleIds, candidateModuleId, ...}}
 */
export function composeCapacityChoice(plan, { profile } = {}) {
  if (!plan?.capacity?.atLimit) return null;
  const candidateId = plan.capacity.overflowModuleIds?.[0]
    || plan.moduleOpportunities?.find((item) => item.state === 'offerable')?.moduleId
    || null;
  if (!candidateId) return null;
  const candidate = consumerLanguageForModule(candidateId, { profile });
  if (!candidate) return null;

  const current = (plan.moduleSlots || []).map((slot) => {
    const language = consumerLanguageForModule(slot.moduleId, { profile });
    return language
      ? Object.freeze({ moduleId: slot.moduleId, description: language.shortDescription })
      : null;
  });
  // A hidden or incompletely described module must not be smuggled into a
  // partial capacity message.
  if (current.some((item) => item === null)) return null;

  const currentModuleIds = Object.freeze(current.map((item) => item.moduleId));
  const currentDescriptions = Object.freeze(current.map((item) => item.description));
  const candidateDescription = candidate.shortDescription;
  const opportunity = plan.moduleOpportunities?.find((item) => item.moduleId === candidateId);
  const anchor = goalAnchorPhrase(candidateId, profile)
    || (opportunity ? anchorPhrase(opportunity.supportingFactIds, profile) : null);
  if (!anchor) return null;
  const why = `${upperInitial(candidateDescription)} could also be useful because ${lowerInitial(anchor)}.`;
  const replacementPrompt = `Would you prefer to replace one of these — ${readableList(currentDescriptions)} — `
    + `with ${candidateDescription}, or keep the current three and leave it for a separate follow-up?`;
  const deferralAcknowledgement = `Okay. We will keep ${readableList(currentDescriptions)}, `
    + `and leave ${candidateDescription} for a separate follow-up.`;

  return Object.freeze({
    candidateModuleId: candidateId,
    candidateDescription,
    // Backward-compatible aliases now contain client descriptions, never formal
    // product names.
    candidateName: candidateDescription,
    currentModuleIds,
    currentDescriptions,
    currentNames: currentDescriptions,
    replacementChoices: Object.freeze(current.map((item) => Object.freeze({ ...item }))),
    replacementPrompt,
    deferralAcknowledgement,
    maximumAnalyses: plan.capacity.maximumAnalyses,
    spoken: `At the moment the application can run up to ${plan.capacity.maximumAnalyses} analyses in this planning session. `
      + `We currently have ${readableList(currentDescriptions)} outlined. `
      + `${why} `
      + replacementPrompt
  });
}

/**
 * Apply an explicit replacement. Only the analysis the client named is removed,
 * and the goal behind it stays active so a later cycle can return to it.
 */
export function applyModuleReplacement(planning = {}, { removeModuleId, addModuleId }) {
  const replaced = new Set(Array.isArray(planning.replacedModuleIds) ? planning.replacedModuleIds : []);
  const accepted = new Set(Array.isArray(planning.acceptedModuleIds) ? planning.acceptedModuleIds : []);
  const deferred = new Set(Array.isArray(planning.deferredModuleIds) ? planning.deferredModuleIds : []);
  replaced.add(removeModuleId);
  accepted.delete(removeModuleId);
  accepted.add(addModuleId);
  deferred.delete(addModuleId);
  return {
    ...planning,
    replacedModuleIds: [...replaced],
    acceptedModuleIds: [...accepted],
    deferredModuleIds: [...deferred],
    // The set has changed, so the previous confirmation no longer describes it.
    confirmedModuleIds: []
  };
}

/**
 * Keep an analysis for a later cycle. It stops being offered now — deferring is
 * a decision, not an invitation to keep asking.
 */
export function applyModuleDeferral(planning = {}, moduleId) {
  const deferred = new Set(Array.isArray(planning.deferredModuleIds) ? planning.deferredModuleIds : []);
  deferred.add(moduleId);
  return { ...planning, deferredModuleIds: [...deferred] };
}

/**
 * The set the client is asked to confirm before anything runs, with the reason
 * each module is in it, so the confirmation can be read out rather than
 * presented as a list of internal ids.
 */
export function confirmationSummary(plan) {
  const modules = (plan?.moduleSlots || []).flatMap((slot) => {
    const language = consumerLanguageForModule(slot.moduleId);
    if (!language) return [];
    return [{
      moduleId: slot.moduleId,
      description: language.confirmationDescription,
      // Backward-compatible alias; unlike the old value this is safe to speak.
      name: language.confirmationDescription,
      accepted: slot.source === 'client_accepted_offer',
      reason: slot.reasons?.[0] || ''
    }];
  });
  return Object.freeze({
    modules: Object.freeze(modules),
    moduleIds: Object.freeze(modules.map((item) => item.moduleId)),
    spoken: modules.length === 0
      ? ''
      : `So I will ${readableList(modules.map((item) => item.description))}. Have I got that right?`
  });
}
