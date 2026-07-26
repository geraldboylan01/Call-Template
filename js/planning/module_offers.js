/**
 * Spoken module offers.
 *
 * A relevant module is never added silently and never triggers its own
 * fact-find before the client has agreed to it. It is offered in one turn that
 * does three things: names something the client actually said, explains what
 * the analysis would do for them in ordinary language, and asks.
 *
 *     "You mentioned [circumstance]. I can [benefit]. Would that be useful?"
 *
 * The benefit text is owned by the module manifest, not by conversation
 * branches, so adding a module does not mean editing the conversation.
 */

import { getModuleManifest } from './module_availability.js';

export const MODULE_OFFER_POLICY_VERSION = 'module-offer-1.0.0';

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
 *   module has no client-facing benefit — in both cases it is better to stay
 *   quiet than to sound like an advert.
 */
export function composeModuleOffer(opportunity, { profile } = {}) {
  if (!opportunity || opportunity.state !== 'offerable') return null;
  const manifest = getModuleManifest(opportunity.moduleId);
  const benefit = String(manifest?.clientBenefit || '').trim();
  if (!benefit) return null;

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
    benefit,
    spokenOffer: goalAnchor
      ? `${goalAnchor}, so I can ${benefit}. Would you like me to include that?`
      : `You mentioned ${anchor}. I can ${benefit}. Would that be useful?`,
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
  const candidate = getModuleManifest(candidateId);
  if (!candidate) return null;

  const currentNames = plan.moduleSlots.map((slot) => getModuleManifest(slot.moduleId)?.name || slot.moduleId);
  const opportunity = plan.moduleOpportunities?.find((item) => item.moduleId === candidateId);
  const anchor = opportunity
    ? anchorPhrase(opportunity.supportingFactIds, profile)
    : goalAnchorPhrase(candidateId, profile);
  const why = anchor
    ? `${candidate.name} could also be useful, because ${anchor.replace(/^You (?:said|asked about|mentioned) /i, 'you mentioned ')}.`
    : `${candidate.name} could also be useful based on what you have told me.`;

  return Object.freeze({
    candidateModuleId: candidateId,
    candidateName: candidate.name,
    currentModuleIds: Object.freeze(plan.moduleSlots.map((slot) => slot.moduleId)),
    currentNames: Object.freeze(currentNames),
    maximumAnalyses: plan.capacity.maximumAnalyses,
    spoken: `At the moment the application can run up to ${plan.capacity.maximumAnalyses} analyses in this planning session. `
      + `We currently have ${readableList(currentNames)} outlined. `
      + `${why} `
      + 'Would you prefer to replace one of those three with it, or keep it for a separate follow-up?'
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
  const confirmed = new Set(Array.isArray(planning.confirmedModuleIds) ? planning.confirmedModuleIds : []);
  replaced.add(removeModuleId);
  accepted.delete(removeModuleId);
  confirmed.delete(removeModuleId);
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
  const modules = (plan?.moduleSlots || []).map((slot) => {
    const manifest = getModuleManifest(slot.moduleId);
    return {
      moduleId: slot.moduleId,
      name: manifest?.name || slot.moduleId,
      accepted: slot.source === 'client_accepted_offer',
      reason: slot.reasons?.[0] || ''
    };
  });
  return Object.freeze({
    modules: Object.freeze(modules),
    moduleIds: Object.freeze(modules.map((item) => item.moduleId)),
    spoken: modules.length === 0
      ? ''
      : `So I will put together ${readableList(modules.map((item) => item.name))}. Have I got that right?`
  });
}
