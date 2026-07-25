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
  const anchor = anchorPhrase(opportunity.supportingFactIds, profile);
  if (!anchor) return null;
  return Object.freeze({
    moduleId: opportunity.moduleId,
    policyVersion: MODULE_OFFER_POLICY_VERSION,
    anchor,
    benefit,
    spokenOffer: `You mentioned ${anchor}. I can ${benefit}. Would that be useful?`,
    supportingFactIds: Object.freeze([...(opportunity.supportingFactIds || [])]),
    requiredFactIds: Object.freeze([...(manifest?.requiredFacts || [])])
  });
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
      : `So I will put together ${modules.map((item) => item.name).join(', ').replace(/, ([^,]*)$/, ' and $1')}. Have I got that right?`
  });
}
