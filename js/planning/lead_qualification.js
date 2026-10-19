/** Auditable pilot qualification. A readiness score is not a conversion probability. */
export const LEAD_QUALIFICATION_VERSION = 'lead-qualification-1.0.0';
const LEAD_PRICE_VERSION = 'lead-prices-pilot-1.0.0';
const PROFILE_REVIEW_MAX_DAYS = 30;
const PFUM_BANDS = Object.freeze([
  { minimumCents: 5_000_000, standardCents: 16_500 },
  { minimumCents: 10_000_000, standardCents: 23_500 },
  { minimumCents: 25_000_000, standardCents: 35_000 },
  { minimumCents: 50_000_000, standardCents: 50_000 },
  { minimumCents: 100_000_000, standardCents: 75_000 }
].map(Object.freeze));

const ASSET_TYPES = new Set([
  'cash', 'deposit', 'money_market', 'investment', 'prsa', 'personal_pension',
  'buyout_bond', 'occupational_dc', 'defined_benefit', 'state_pension', 'annuity_income',
  'home', 'property', 'business', 'farm', 'property_proceeds', 'business_proceeds',
  'inheritance_received', 'future_inheritance', 'crypto', 'collectible',
  'personal_possession', 'future_income', 'borrowing_capacity', 'other'
]);
const EXCLUDED_TYPES = new Set([
  'defined_benefit', 'state_pension', 'annuity_income', 'home', 'property', 'business', 'farm',
  'future_inheritance', 'crypto', 'collectible', 'personal_possession',
  'future_income', 'borrowing_capacity'
]);
const SOURCE_COLLECTIONS = new Set(['assets', 'pensions', 'properties', 'businesses', 'native_input', 'manual']);
const DEDUCTION_KINDS = new Set(['emergency_reserve', 'committed_spending', 'debt_settlement', 'sale_cost', 'tax', 'replacement_housing', 'other']);
const MAX_CENTS = 1_000_000_000_000_000;
const DAY_MS = 86_400_000;

function fail(message) {
  throw Object.assign(new Error(message), { status: 400, code: 'invalid_qualification' });
}
function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object.`);
  return value;
}
function string(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${field} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
}
function flag(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') fail(`${field} must be true, false or null.`);
  return value;
}
function amount(value, field, { nullable = true, max = MAX_CENTS } = {}) {
  if (nullable && (value === undefined || value === null)) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(`${field} must be a non-negative safe integer in cents.`);
  return value;
}
function date(value, field, { nullable = false } = {}) {
  if (nullable && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${field} must be an ISO timestamp.`);
  return new Date(value).toISOString();
}
function list(value, field, max = 200) {
  if (!Array.isArray(value) || value.length > max) fail(`${field} must be an array with at most ${max} entries.`);
  return value;
}
function ids(value, field) {
  const result = list(value, field, 20).map((id) => string(id, field));
  if (new Set(result).size !== result.length) fail(`${field} contains duplicate people.`);
  return result;
}
function ref(value, field) {
  object(value, field);
  if (!SOURCE_COLLECTIONS.has(value.collection)) fail(`${field}.collection is invalid.`);
  return { collection: value.collection, id: string(value.id, `${field}.id`) };
}
const refKey = (value) => `${value.collection}:${value.id}`;
function add(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result > MAX_CENTS) fail('Qualification total exceeds the supported amount.');
  return result;
}

/** All money is integer cents. Deductions and availableAmountCents concern the participating owners' share. */
export function normalizeQualificationAssessment(raw) {
  object(raw, 'assessment');
  if (raw.schemaVersion !== 1) fail('assessment.schemaVersion must be 1.');
  const assessedAt = date(raw.assessedAt, 'assessedAt');
  const participatingOwnerIds = ids(raw.participatingOwnerIds, 'participatingOwnerIds');
  if (!participatingOwnerIds.length) fail('Name at least one participating owner.');
  const adviser = object(raw.adviser, 'adviser');
  const normalizedAdviser = {
    id: string(adviser.id, 'adviser.id'),
    name: string(adviser.name, 'adviser.name'),
    serviceFitConfirmed: flag(adviser.serviceFitConfirmed, 'adviser.serviceFitConfirmed'),
    minimumPfumCents: amount(adviser.minimumPfumCents, 'adviser.minimumPfumCents')
  };
  const seenHoldings = new Set(), seenReferences = new Set(), seenDeductions = new Set();
  const assets = list(raw.assets, 'assets').map((rawAsset, index) => {
    const field = `assets[${index}]`;
    const asset = object(rawAsset, field);
    const holdingId = string(asset.holdingId, `${field}.holdingId`);
    if (seenHoldings.has(holdingId)) fail('Each economic holding must appear once.');
    seenHoldings.add(holdingId);
    if (!ASSET_TYPES.has(asset.type)) fail(`${field}.type is invalid.`);
    const sourceRefs = list(asset.sourceRefs, `${field}.sourceRefs`, 20).map((value) => ref(value, `${field}.sourceRefs`));
    if (!sourceRefs.length) fail(`${field} needs a stable source reference.`);
    for (const sourceRef of sourceRefs) {
      if (seenReferences.has(refKey(sourceRef))) fail('A source holding cannot appear in multiple assessment entries.');
      seenReferences.add(refKey(sourceRef));
    }
    const ownerIds = ids(asset.ownerIds, `${field}.ownerIds`);
    const deductions = list(asset.deductions ?? [], `${field}.deductions`, 100).map((rawDeduction) => {
      const deduction = object(rawDeduction, `${field}.deductions`);
      const deductionId = string(deduction.deductionId, 'deductionId');
      if (seenDeductions.has(deductionId)) fail('A reserve, debt or other deduction cannot be deducted twice.');
      seenDeductions.add(deductionId);
      if (!DEDUCTION_KINDS.has(deduction.kind)) fail('Deduction kind is invalid.');
      return { deductionId, kind: deduction.kind, amountCents: amount(deduction.amountCents, 'deduction.amountCents'), confirmed: flag(deduction.confirmed, 'deduction.confirmed') };
    });
    const evidence = list(asset.evidence ?? [], `${field}.evidence`, 20).map((value) => string(value, `${field}.evidence`, 1000));
    const representsProceedsOf = asset.representsProceedsOf ? ref(asset.representsProceedsOf, `${field}.representsProceedsOf`) : null;
    if (['property_proceeds', 'business_proceeds'].includes(asset.type) && !representsProceedsOf) fail('Sale proceeds must identify the original holding.');
    return {
      holdingId, label: string(asset.label, `${field}.label`), type: asset.type, sourceRefs, ownerIds,
      currency: string(asset.currency, `${field}.currency`, 3),
      valueCents: amount(asset.valueCents, `${field}.valueCents`),
      valueConfirmed: flag(asset.valueConfirmed, `${field}.valueConfirmed`),
      identityConfirmed: flag(asset.identityConfirmed, `${field}.identityConfirmed`),
      ownershipShareBps: amount(asset.ownershipShareBps, `${field}.ownershipShareBps`, { max: 10000 }),
      ownershipConfirmed: flag(asset.ownershipConfirmed, `${field}.ownershipConfirmed`),
      availableAmountCents: amount(asset.availableAmountCents, `${field}.availableAmountCents`),
      availabilityConfirmed: flag(asset.availabilityConfirmed, `${field}.availabilityConfirmed`),
      availableWithin12Months: flag(asset.availableWithin12Months, `${field}.availableWithin12Months`),
      eligibilityConfirmed: flag(asset.eligibilityConfirmed, `${field}.eligibilityConfirmed`),
      manageableByAdviser: flag(asset.manageableByAdviser, `${field}.manageableByAdviser`),
      alreadyManagedByRecipient: flag(asset.alreadyManagedByRecipient, `${field}.alreadyManagedByRecipient`),
      exclusionReason: asset.exclusionReason ? string(asset.exclusionReason, `${field}.exclusionReason`, 1000) : null,
      deductions, evidence, representsProceedsOf
    };
  });
  const proceedsOrigins = new Set();
  for (const asset of assets.filter((entry) => entry.representsProceedsOf)) {
    const key = refKey(asset.representsProceedsOf);
    if (proceedsOrigins.has(key)) fail('Sale proceeds for one original holding cannot appear twice.');
    proceedsOrigins.add(key);
    // Even an excluded original is represented by the one proceeds entry.
    if (seenReferences.has(key) && !asset.sourceRefs.some((sourceRef) => refKey(sourceRef) === key)) fail('Do not record both an original holding and its sale proceeds.');
  }
  const readiness = object(raw.readiness ?? {}, 'readiness');
  const meeting = object(readiness.meeting ?? {}, 'readiness.meeting');
  if (meeting.kind !== undefined && !['adviser', 'education'].includes(meeting.kind)) fail('Meeting kind is invalid.');
  if (meeting.status !== undefined && !['none', 'requested', 'confirmed', 'cancelled', 'held'].includes(meeting.status)) fail('Meeting status is invalid.');
  const consent = object(raw.consent ?? {}, 'consent');
  return {
    schemaVersion: 1, assessedAt, participatingOwnerIds, adviser: normalizedAdviser, assets,
    assetReviewComplete: flag(raw.assetReviewComplete, 'assetReviewComplete'),
    consumerConfirmedAt: date(raw.consumerConfirmedAt, 'consumerConfirmedAt', { nullable: true }),
    readiness: {
      introductionRequested: flag(readiness.introductionRequested, 'readiness.introductionRequested'),
      willingToMeet: flag(readiness.willingToMeet, 'readiness.willingToMeet'),
      meeting: { kind: meeting.kind || null, status: meeting.status || 'none' },
      decisionWithinSixMonths: flag(readiness.decisionWithinSixMonths, 'readiness.decisionWithinSixMonths'),
      specificDecisionConfirmed: flag(readiness.specificDecisionConfirmed, 'readiness.specificDecisionConfirmed'),
      contactVerified: flag(readiness.contactVerified, 'readiness.contactVerified'),
      profileReviewedAt: date(readiness.profileReviewedAt, 'profileReviewedAt', { nullable: true })
    },
    consent: {
      granted: flag(consent.granted, 'consent.granted'),
      purpose: consent.purpose ? string(consent.purpose, 'consent.purpose') : null,
      sharedDataCategories: ids(consent.sharedDataCategories ?? [], 'consent.sharedDataCategories'),
      recipientId: consent.recipientId ? string(consent.recipientId, 'consent.recipientId') : null,
      policyVersion: consent.policyVersion ? string(consent.policyVersion, 'consent.policyVersion') : null,
      capturedAt: date(consent.capturedAt, 'consent.capturedAt', { nullable: true }),
      withdrawnAt: date(consent.withdrawnAt, 'consent.withdrawnAt', { nullable: true })
    }
  };
}

function assessAsset(asset, participatingOwnerIds) {
  const base = { holdingId: asset.holdingId, label: asset.label, contributionCents: 0, ownedValueCents: null, deductionsCents: null, netAvailableCents: null };
  if (EXCLUDED_TYPES.has(asset.type)) return { ...base, status: 'excluded', reasons: [`${asset.type} is excluded from pilot pFUM.`] };
  const evidenced = asset.evidence.length > 0;
  const reviewedExclusion = Boolean(asset.exclusionReason && asset.eligibilityConfirmed === true && evidenced);
  const alreadyManaged = asset.alreadyManagedByRecipient === true && asset.eligibilityConfirmed === true && evidenced;
  const outsideHorizon = asset.availableWithin12Months === false && asset.availabilityConfirmed === true && evidenced;
  const notManageable = asset.manageableByAdviser === false && asset.eligibilityConfirmed === true && evidenced;
  if (reviewedExclusion || alreadyManaged || outsideHorizon || notManageable) {
    return { ...base, status: 'excluded', reasons: [reviewedExclusion ? asset.exclusionReason : alreadyManaged ? 'Already managed by this recipient.' : outsideHorizon ? 'Not available within 12 months.' : 'Not manageable by this adviser.'] };
  }
  const reasons = [];
  if (asset.exclusionReason && !reviewedExclusion) reasons.push('Review and evidence the exclusion decision.');
  if (asset.currency !== 'EUR') reasons.push('A reviewed EUR valuation is required; no implicit FX conversion.');
  if (asset.type === 'other') reasons.push('Classify the holding before assessing its eligibility.');
  if (asset.valueCents === null || asset.valueConfirmed !== true) reasons.push('Confirm the current or net realised value.');
  if (asset.identityConfirmed !== true) reasons.push('Confirm this is one distinct economic holding, including any aliases.');
  if (asset.ownershipShareBps === null || asset.ownershipConfirmed !== true || !asset.ownerIds.length) reasons.push('Confirm participating ownership and its share.');
  if (asset.ownerIds.length && !asset.ownerIds.some((id) => participatingOwnerIds.includes(id))) reasons.push('No participating owner is named for this holding.');
  if (asset.availableAmountCents === null || asset.availabilityConfirmed !== true || asset.availableWithin12Months !== true) reasons.push('Confirm the amount available within 12 months.');
  if (asset.eligibilityConfirmed !== true || asset.manageableByAdviser !== true || asset.alreadyManagedByRecipient !== false) reasons.push('Confirm eligibility and whether the recipient already manages it.');
  if (!asset.evidence.length) reasons.push('Record the source of the confirmation.');
  if (asset.deductions.some((deduction) => deduction.confirmed !== true || deduction.amountCents === null)) reasons.push('Confirm every reserve and deduction.');
  if (reasons.length) return { ...base, status: 'unassessed', reasons };
  const ownedValueCents = Number(BigInt(asset.valueCents) * BigInt(asset.ownershipShareBps) / 10000n);
  const deductionsCents = asset.deductions.reduce((sum, deduction) => add(sum, deduction.amountCents), 0);
  const netAvailableCents = Math.max(0, ownedValueCents - deductionsCents);
  return { ...base, ownedValueCents, deductionsCents, netAvailableCents, contributionCents: Math.min(netAvailableCents, asset.availableAmountCents), status: 'assessed', reasons: [] };
}

/** Monetary pilot quote only; this function neither authorises distribution nor bills anyone. */
export function priceLeadIntroduction(pfumCents, priority = false) {
  amount(pfumCents, 'pfumCents', { nullable: false });
  if (typeof priority !== 'boolean') fail('priority must be a boolean.');
  const band = [...PFUM_BANDS].reverse().find((entry) => pfumCents >= entry.minimumCents);
  if (!band) return null;
  // Integer arithmetic, nearest EUR 5; positive half increments round upwards.
  const numerator = BigInt(band.standardCents) * BigInt(priority ? 130 : 100);
  const feeCents = Number((numerator + 25_000n) / 50_000n * 500n);
  return { currency: 'EUR', feeCents, standardCents: band.standardCents, bandMinimumCents: band.minimumCents, priority, priceVersion: LEAD_PRICE_VERSION };
}

export function isPriorityQualification(score, flags) {
  if (!Number.isInteger(score) || score < 0 || score > 100) fail('readinessScore must be an integer from 0 to 100.');
  return score >= 80 && [
    'introduction_requested', 'willing_to_meet', 'adviser_meeting_confirmed',
    'contact_verified', 'asset_data_confirmed', 'adviser_service_fit', 'adviser_minimum_met', 'profile_current'
  ].every((id) => flags[id] === true);
}

/** Internal queue only. Wealth is displayed separately, never used as a hidden readiness multiplier. */
export function rankLeadQualifications(entries) {
  return list(entries, 'ranked entries', 100_000)
    .filter((entry) => entry?.result?.distributionEligible === true && entry.result.quote)
    .map((entry) => {
      if (!Number.isSafeInteger(entry.leadId) || entry.leadId < 1) fail('Ranked entries must identify a lead.');
      const requestedAt = date(entry.requestedAt, 'requestedAt');
      return { ...entry, requestedAt };
    })
    .sort((left, right) => Number(right.result.classification === 'priority') - Number(left.result.classification === 'priority')
      || right.result.readinessScore - left.result.readinessScore
      || Date.parse(left.requestedAt) - Date.parse(right.requestedAt)
      || left.leadId - right.leadId)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

export function evaluateLeadQualification(raw) {
  const input = normalizeQualificationAssessment(raw);
  const timestamp = Date.parse(input.assessedAt);
  const positions = input.assets.map((asset) => assessAsset(asset, input.participatingOwnerIds));
  const pfumCents = positions.reduce((sum, position) => add(sum, position.contributionCents), 0);
  const unassessedHoldingIds = positions.filter((position) => position.status === 'unassessed').map((position) => position.holdingId);
  const confirmedInTime = Boolean(input.consumerConfirmedAt && Date.parse(input.consumerConfirmedAt) <= timestamp);
  const assetDataConfirmed = confirmedInTime && input.assetReviewComplete === true && unassessedHoldingIds.length === 0;
  const minimumMet = input.adviser.minimumPfumCents !== null && pfumCents >= input.adviser.minimumPfumCents;
  const meetingConfirmed = input.readiness.meeting.kind === 'adviser' && ['confirmed', 'held'].includes(input.readiness.meeting.status);
  const reviewAge = input.readiness.profileReviewedAt ? timestamp - Date.parse(input.readiness.profileReviewedAt) : -1;
  const flags = {
    introduction_requested: input.readiness.introductionRequested === true,
    willing_to_meet: input.readiness.willingToMeet === true,
    adviser_meeting_confirmed: meetingConfirmed,
    decision_within_six_months: input.readiness.decisionWithinSixMonths === true,
    specific_decision_confirmed: input.readiness.specificDecisionConfirmed === true,
    adviser_service_fit: input.adviser.serviceFitConfirmed === true,
    adviser_minimum_met: minimumMet,
    contact_verified: input.readiness.contactVerified === true,
    asset_data_confirmed: assetDataConfirmed,
    profile_current: reviewAge >= 0 && reviewAge <= PROFILE_REVIEW_MAX_DAYS * DAY_MS
  };
  const weights = [20, 10, 10, 15, 10, 10, 10, 5, 5, 5];
  const components = Object.entries(flags).map(([id, satisfied], index) => ({ id, satisfied, points: satisfied ? weights[index] : 0, maximumPoints: weights[index] }));
  const readinessScore = components.reduce((sum, component) => sum + component.points, 0);
  const priority = isPriorityQualification(readinessScore, flags);
  const consentValid = input.consent.granted === true && input.consent.purpose === 'adviser_introduction'
    && ['contact', 'asset_availability', 'qualification'].every((category) => input.consent.sharedDataCategories.includes(category))
    && input.consent.recipientId === input.adviser.id
    && Boolean(input.consent.policyVersion && input.consent.capturedAt)
    && Date.parse(input.consent.capturedAt) <= timestamp && !input.consent.withdrawnAt;
  const pricingBlockedReasons = [];
  if (!assetDataConfirmed) pricingBlockedReasons.push('Complete and consumer-confirm the asset availability review.');
  if (unassessedHoldingIds.length) pricingBlockedReasons.push('Resolve every unassessed holding before assigning a fee band.');
  if (!flags.introduction_requested) pricingBlockedReasons.push('A requested adviser introduction is required.');
  if (!flags.contact_verified) pricingBlockedReasons.push('Verify a contact route.');
  if (!flags.adviser_service_fit) pricingBlockedReasons.push('Confirm the named adviser offers the required service.');
  if (!minimumMet) pricingBlockedReasons.push('Confirm the named adviser minimum and meet it.');
  if (!consentValid) pricingBlockedReasons.push('Capture current sharing consent for this named recipient.');
  if (pfumCents < PFUM_BANDS[0].minimumCents) pricingBlockedReasons.push('pFUM is below the pilot fee schedule.');
  const distributionEligible = pricingBlockedReasons.length === 0;
  return {
    rulesVersion: LEAD_QUALIFICATION_VERSION, assessedAt: input.assessedAt, currency: 'EUR', horizonMonths: 12,
    pfumCents, assetReviewComplete: assetDataConfirmed, unassessedHoldingIds, positions,
    readinessScore, components, classification: priority ? 'priority' : 'standard',
    probabilityOfConversion: null, namedRecipientConsentValid: consentValid, distributionEligible,
    pricingBlockedReasons, qualificationStatus: distributionEligible ? 'qualified' : 'needs_review',
    quote: distributionEligible ? priceLeadIntroduction(pfumCents, priority) : null,
    billingEnabled: false
  };
}

/** Prefill only. Caller supplies authorised confirmed sources; availability and eligibility always need a new review. */
export function prefillQualificationAssets({ profile = {}, nativeModuleInputs = {} } = {}) {
  const assets = [], warnings = [], seen = new Map();
  function candidate(collection, id, label, type, money, ownerIds = [], confirmed = false) {
    if (!id) return;
    const sourceRef = { collection, id: String(id) }, key = refKey(sourceRef);
    const valueCents = money && Number.isFinite(money.amount) && money.amount >= 0 ? Math.round(money.amount * 100) : null;
    if (seen.has(key)) {
      const previous = seen.get(key);
      if (previous.valueCents !== valueCents || previous.currency !== (money?.currency || 'EUR')) {
        warnings.push(`Conflicting valuations for ${key}; review the holding.`);
        previous.valueCents = null;
        previous.valueConfirmed = false;
      }
      return;
    }
    const entry = { holdingId: key, sourceRefs: [sourceRef], label: label || key, type, ownerIds,
      valueCents, currency: money?.currency || 'EUR', valueConfirmed: confirmed, identityConfirmed: false,
      ownershipShareBps: null, ownershipConfirmed: false, deductions: [],
      availableAmountCents: null, availabilityConfirmed: false, availableWithin12Months: null,
      eligibilityConfirmed: false, manageableByAdviser: null, alreadyManagedByRecipient: null,
      evidence: [], exclusionReason: null, representsProceedsOf: null };
    assets.push(entry); seen.set(key, entry);
  }
  const generic = { cash: 'cash', investment: 'investment', pension: 'other', property: 'property', business: 'business', agricultural: 'farm', other: 'other' };
  for (const [index, asset] of (profile.assets || []).entries()) candidate('assets', asset.assetId, asset.label, generic[asset.type] || 'other', asset.currentValue, asset.ownerIds, profile.fieldMetadata?.[`/assets/${index}/currentValue`]?.confirmedByUser === true);
  const pensions = { occupational: 'occupational_dc', prsa: 'prsa', personal: 'personal_pension', defined_benefit: 'defined_benefit', buyout_bond: 'buyout_bond', other: 'other' };
  for (const [index, pension] of (profile.pensions || []).entries()) candidate('pensions', pension.pensionId, pension.label, pensions[pension.type] || 'other', pension.currentValue, [pension.ownerId].filter(Boolean), profile.fieldMetadata?.[`/pensions/${index}/currentValue`]?.confirmedByUser === true);
  for (const property of profile.properties || []) candidate('properties', property.propertyId, property.label, property.use === 'home' ? 'home' : property.use === 'farm' ? 'farm' : 'property', property.currentValue, property.ownerIds);
  for (const business of profile.businesses || []) candidate('businesses', business.businessId, business.label, business.agricultural ? 'farm' : 'business', business.estimatedValue, business.ownerIds);
  const balanceSheet = nativeModuleInputs.personal_balance_sheet;
  for (const position of balanceSheet?.assetPositions || []) {
    const collection = ['assets', 'pensions', 'properties', 'businesses'].includes(position.source) ? position.source : 'native_input';
    const type = position.bucket === 'spendable_reserves' ? 'cash' : 'other';
    candidate(collection, position.id, position.label, type, { amount: position.amount, currency: balanceSheet.currency || 'EUR' });
  }
  return { assets, warnings, requiresConsumerAvailabilityReview: true };
}
