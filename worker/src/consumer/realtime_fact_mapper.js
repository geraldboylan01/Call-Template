import { ConsumerError } from './errors.js';
import { GOAL_TYPES } from '../../../js/planning/contracts.js';
import { getSemanticFactDefinition } from '../../../js/planning/semantic_facts.js';
import {
  getPlanningModulesForSemanticFact,
  getRealtimeModuleSemanticFactIds
} from '../../../js/planning/module_registry.js';
import { buildGoalModulePlan } from '../../../js/planning/goal_plan.js';
import { normalizeHouseholdProfile } from '../../../js/planning/profile.js';
import { escapeJsonPointerToken } from '../../../js/planning/utils.js';

const INTAKE_FACT_PATHS = Object.freeze({
  self_description: ['selfDescription', 'choice'],
  primary_goal_focus: ['primaryGoalType', 'choice'],
  life_stage: ['lifeStage', 'choice'],
  household_structure: ['householdStructure', 'choice'],
  career_stage: ['careerStage', 'choice'],
  property_status: ['propertyStatus', 'choice'],
  employment_context: ['employmentContext', 'choice'],
  retirement_status: ['retirementStatus', 'choice'],
  dependant_count: ['dependantCount', 'count'],
  has_pension: ['hasPension', 'boolean'],
  finance_combining: ['financeCombining', 'boolean'],
  new_parent_status: ['newParent', 'boolean'],
  retirement_readiness: ['retirementReadiness', 'choice'],
  business_context: ['businessContext', 'choice'],
  business_exit_intent: ['businessExit', 'boolean'],
  agricultural_assets: ['agriculturalAssets', 'boolean'],
  education_funding_intent: ['educationFunding', 'boolean'],
  wealth_transfer_intent: ['wealthTransfer', 'boolean'],
  high_net_worth_context: ['highNetWorth', 'boolean'],
  lump_sum_status: ['lumpSumRecipient', 'boolean'],
  immediate_decision_context: ['immediateDecision', 'boolean']
});

const CHOICES = Object.freeze({
  self_description: new Set([
    'student', 'early_adult', 'graduate', 'young_employee', 'first_time_buyer',
    'young_professional', 'combining_finances', 'new_parent', 'young_family',
    'established_professional', 'behind_on_retirement', 'self_employed',
    'company_director', 'owner_manager', 'business_owner', 'business_exit',
    'farmer', 'pre_retiree', 'newly_retired', 'older_retiree',
    'high_net_worth_family', 'funding_education', 'transferring_wealth',
    'lump_sum_recipient', 'immediate_decision'
  ]),
  primary_goal_focus: new Set(GOAL_TYPES),
  life_stage: new Set([
    'student', 'early_adult', 'graduate', 'young_employee', 'young_professional',
    'established_professional', 'mid_career', 'pre_retiree', 'newly_retired',
    'retired', 'older_retiree'
  ]),
  household_structure: new Set(['single', 'couple', 'family', 'parent_or_grandparent']),
  career_stage: new Set(['student', 'early_career', 'established_career', 'mid_career', 'approaching_retirement', 'retired']),
  property_status: new Set(['renter', 'first_time_buyer', 'buying_soon', 'delaying_purchase', 'homeowner', 'no_property']),
  employment_context: new Set(['employee', 'self_employed', 'contractor', 'company_director', 'owner_manager', 'business_owner', 'retired', 'other']),
  retirement_status: new Set(['working', 'approaching_retirement', 'newly_retired', 'retired', 'older_retiree']),
  retirement_readiness: new Set(['on_track', 'retirement_behind', 'unsure']),
  business_context: new Set(['no_business_interest', 'self_employed', 'company_director', 'owner_manager', 'business_owner', 'farmer'])
});

const GOAL_DEFINITIONS = Object.freeze({
  buy_home: { title: 'Buy a home' },
  maintain_liquidity: { title: 'Maintain an emergency cash reserve' },
  understand_position: { title: 'Understand my current position' },
  build_wealth: { title: 'Build long-term wealth' },
  improve_pension: { title: 'Improve pension readiness' },
  retire: { title: 'Plan for retirement' },
  retire_early: { title: 'Explore early retirement' },
  optimise_mortgage: { title: 'Review the mortgage path' },
  manage_loan: { title: 'Review a non-housing loan' },
  fund_education: { title: 'Fund children’s education' },
  assess_decision: { title: 'Assess a financial decision' },
  transfer_wealth: { title: 'Plan a wealth transfer' },
  business_planning: { title: 'Plan around a business interest' },
  agricultural_planning: { title: 'Plan around agricultural assets' }
});

// The Realtime model maps free speech onto server-owned vocabularies. It can
// only do that surgically when the exact allowed values are visible to it, so
// the planning-state tool and rejected-call guidance both expose this list.
export function realtimeFactValueVocabulary(factId) {
  const id = String(factId || '');
  if (id === 'primary_goal') return [...GOAL_TYPES];
  if (id === 'lending_category') return ['first_time_buyer', 'fresh_start', 'second_or_subsequent'];
  const choices = CHOICES[id];
  return choices ? [...choices] : null;
}

export const REALTIME_CANARY_FACT_IDS = Object.freeze([...new Set([
  ...getRealtimeModuleSemanticFactIds(),
  ...Object.keys(INTAKE_FACT_PATHS),
  // These are optional, rules-backed retirement assumptions rather than
  // required intake facts. Keep them writable when volunteered without
  // making the question planner ask for values that have safe IE defaults.
  'state_pension_fraction',
  'state_pension_start_age'
])]);

function money(value, currency) {
  const amount = typeof value === 'number'
    ? value
    : value && typeof value === 'object' && !Array.isArray(value)
      ? value.amount
      : NaN;
  const suppliedCurrency = value && typeof value === 'object' && !Array.isArray(value)
    ? value.currency
    : currency;
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000_000
    || suppliedCurrency !== currency) {
    throw new ConsumerError(400, 'realtime_fact_value_invalid', 'That monetary fact is not valid in the profile base currency.');
  }
  return { amount, currency };
}

function boundedNumber(value, { min = 0, max = 120, integer = false } = {}) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw new ConsumerError(400, 'realtime_fact_value_invalid', 'That numerical fact is outside the accepted range.');
  }
  return number;
}

function percentageRate(value, { decimal = false } = {}) {
  const supplied = typeof value === 'number' ? value : Number(value);
  const normalized = decimal ? supplied : supplied / 100;
  return boundedNumber(normalized, { min: 0, max: 1 });
}

function strictBoolean(value) {
  if (typeof value !== 'boolean') {
    throw new ConsumerError(400, 'realtime_fact_value_invalid', 'That fact requires an explicit yes or no.');
  }
  return value;
}

function normalizedChoice(factId, value) {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase().replace(/[ -]+/g, '_') : '';
  if (!candidate || !CHOICES[factId]?.has(candidate)) {
    throw new ConsumerError(400, 'realtime_fact_value_invalid', 'That planning-context choice requires visual review.');
  }
  return candidate;
}

function goalType(value) {
  const candidate = typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[ -]+/g, '_')
    : typeof value?.type === 'string'
      ? value.type.trim().toLowerCase()
      : '';
  if (!GOAL_TYPES.includes(candidate) || !GOAL_DEFINITIONS[candidate]) {
    throw new ConsumerError(400, 'realtime_goal_invalid', 'That goal is not available in the realtime canary.');
  }
  return candidate;
}

function stableCollectionIndex(collection, predicate) {
  const index = (collection || []).findIndex(predicate);
  return index >= 0 ? index : (collection || []).length;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function containsProhibitedIdentifierText(value) {
  const text = String(value || '');
  return /[\r\n@]/.test(text)
    || /https?:\/\//i.test(text)
    || /(?:pps|password|passcode|iban|swift|routing|sort\s*code)\b/i.test(text)
    || /(?:account|card)\s*(?:number|no\.?|is|:)\s*\w+/i.test(text)
    || /\d{7,}/.test(text)
    || /\b[A-Z]\d{2}\s?[A-Z0-9]{4}\b/i.test(text)
    || /\b\d{1,5}\s+[A-Za-z][A-Za-z '-]{1,40}\s(?:street|st|road|rd|avenue|ave|drive|dr|lane|ln|close|court|ct|park|way)\b/i.test(text);
}

function safeLabel(value, fallback = '') {
  const label = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : fallback;
  if (!label || label.length > 100 || containsProhibitedIdentifierText(label)) {
    throw new ConsumerError(400, 'realtime_fact_value_invalid', 'That position label is not valid for the planning profile.');
  }
  return label;
}

function canonicalEntityId(prefix, value, fallbackLabel = '') {
  const source = String(value || fallbackLabel || '').trim();
  if (!source || source.length > 80 || containsProhibitedIdentifierText(source)) {
    throw new ConsumerError(400, 'realtime_entity_id_invalid', 'That position needs a safe, non-sensitive stable short name.');
  }
  const raw = source
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 56);
  const unprefixed = raw.startsWith(`${prefix}_`) ? raw.slice(prefix.length + 1) : raw;
  if (!unprefixed) {
    throw new ConsumerError(400, 'realtime_entity_id_invalid', 'That position needs a stable short name before it can be saved.');
  }
  return `${prefix}_realtime_${unprefixed.replace(/^realtime_/, '')}`;
}

function collectionEntityId(collection, idKey, prefix, supplied, fallbackLabel = '') {
  const exact = typeof supplied === 'string' ? supplied.trim() : '';
  if (exact && collection.some((item) => item?.[idKey] === exact)) return exact;
  return canonicalEntityId(prefix, supplied, fallbackLabel);
}

function entityOperation(value) {
  if (!plainObject(value)) {
    throw new ConsumerError(400, 'realtime_fact_value_invalid', 'That position must be supplied as a structured value.');
  }
  if (value.confirmNone === true || value.none === true) return 'confirm_none';
  if (value.remove === true) return 'remove';
  const operation = String(value.operation || value.action || 'upsert').trim().toLowerCase();
  if (!['upsert', 'remove', 'confirm_none', 'complete_section'].includes(operation)) {
    throw new ConsumerError(400, 'realtime_entity_operation_invalid', 'That position operation is not supported.');
  }
  return operation;
}

function ownerId(profile, raw, { allowHousehold = false } = {}) {
  if (raw !== null && typeof raw !== 'undefined' && (typeof raw !== 'string' || !raw.trim())) {
    throw new ConsumerError(400, 'realtime_owner_invalid', 'That position owner is not part of the household.');
  }
  const candidate = String(raw ?? 'primary').trim().toLowerCase();
  if (candidate === 'primary' || candidate === profile.primaryPerson.personId.toLowerCase()) {
    return profile.primaryPerson.personId;
  }
  if (candidate === 'partner' || candidate === String(profile.partner?.personId || '').toLowerCase()) {
    if (!profile.partner?.personId) {
      throw new ConsumerError(409, 'realtime_partner_required', 'Add the partner to the household before assigning a position to them.');
    }
    return profile.partner.personId;
  }
  if (allowHousehold && candidate === 'household') return 'household';
  throw new ConsumerError(400, 'realtime_owner_invalid', 'That position owner is not part of the household.');
}

function ownerIds(profile, value) {
  const hasExplicitOwner = Object.hasOwn(value, 'ownerIds')
    || Object.hasOwn(value, 'owners')
    || Object.hasOwn(value, 'owner');
  const supplied = hasExplicitOwner ? (value.ownerIds ?? value.owners ?? value.owner) : 'primary';
  const choices = Array.isArray(supplied) ? supplied : [supplied];
  if (choices.length < 1 || choices.some((choice) => typeof choice !== 'string' || !choice.trim())) {
    throw new ConsumerError(400, 'realtime_owner_invalid', 'Provide at least one valid household owner.');
  }
  const jointChoices = choices.filter((choice) => choice.trim().toLowerCase() === 'joint');
  if (jointChoices.length > 0) {
    if (choices.length !== 1) {
      throw new ConsumerError(400, 'realtime_owner_invalid', 'Use joint by itself, or list the individual owners without joint.');
    }
    if (!profile.partner?.personId) {
      throw new ConsumerError(409, 'realtime_partner_required', 'Add the partner before recording joint ownership.');
    }
    return [profile.primaryPerson.personId, profile.partner.personId];
  }
  return [...new Set(choices.map((choice) => ownerId(profile, choice, { allowHousehold: true })))];
}

function optionalMoney(value, currency) {
  return value === null || typeof value === 'undefined' ? undefined : money(value, currency);
}

function optionalRate(value, options) {
  return value === null || typeof value === 'undefined' ? undefined : percentageRate(value, options);
}

function optionalBounded(value, options) {
  return value === null || typeof value === 'undefined' ? undefined : boundedNumber(value, options);
}

function optionalRemainingTermMonths(value, { required = false } = {}) {
  if (!plainObject(value)) return optionalBounded(value, { min: 1, max: 1200, integer: true });
  if (value.remainingTermMonths !== null && typeof value.remainingTermMonths !== 'undefined') {
    return optionalBounded(value.remainingTermMonths, { min: 1, max: 1200, integer: true });
  }
  if (value.months !== null && typeof value.months !== 'undefined') {
    return optionalBounded(value.months, { min: 1, max: 1200, integer: true });
  }
  if (value.value !== null && typeof value.value !== 'undefined') {
    return optionalBounded(value.value, { min: 1, max: 1200, integer: true });
  }
  const yearsValue = value.remainingTermYears ?? value.years;
  if (yearsValue === null || typeof yearsValue === 'undefined') {
    if (required) {
      throw new ConsumerError(
        400,
        'realtime_fact_value_invalid',
        'A remaining-term fact needs months or years.'
      );
    }
    return undefined;
  }
  return boundedNumber(yearsValue, { min: 1, max: 100, integer: true }) * 12;
}

function scalarValue(value, keys = []) {
  if (!plainObject(value)) return value;
  for (const key of keys) {
    if (Object.hasOwn(value, key)) return value[key];
  }
  if (Object.hasOwn(value, 'value')) return value.value;
  return value;
}

function completionNoneMapping(profile, markerPath, factId, scope = null) {
  const completionFacts = {
    ...(profile.assumptions?.values?.completionFacts || {}),
    confirmedNonePaths: {
      ...(profile.assumptions?.values?.completionFacts?.confirmedNonePaths || {}),
      [markerPath]: true
    }
  };
  return {
    fieldPath: '/assumptions/values/completionFacts',
    metadataPath: `/assumptions/values/completionFacts/confirmedNonePaths/${escapeJsonPointerToken(markerPath)}`,
    canonicalValue: completionFacts,
    displayValue: { operation: 'confirm_none', factId, ...(scope ? { scope } : {}) }
  };
}

function completionSectionMapping(profile, markerPath, factId) {
  const completionFacts = {
    ...(profile.assumptions?.values?.completionFacts || {}),
    completedPaths: {
      ...(profile.assumptions?.values?.completionFacts?.completedPaths || {}),
      [markerPath]: true
    }
  };
  return {
    fieldPath: '/assumptions/values/completionFacts',
    metadataPath: `/assumptions/values/completionFacts/completedPaths/${escapeJsonPointerToken(markerPath)}`,
    canonicalValue: completionFacts,
    displayValue: { operation: 'complete_section', factId },
    proposalValue: { operation: 'complete_section' }
  };
}

function confirmedNoneMapping(profile, collectionPath, factId) {
  const collection = profile[collectionPath.slice(1)];
  if (Array.isArray(collection) && collection.length > 0) {
    throw new ConsumerError(409, 'realtime_entity_review_required', 'Remove the existing positions before confirming that there are none.');
  }
  return completionNoneMapping(profile, collectionPath, factId);
}

function scopedNoneMapping(profile, fact, expectedScope, markerPath) {
  if (!plainObject(fact.value) || entityOperation(fact.value) !== 'confirm_none') return null;
  if (typeof fact.value.scope === 'undefined') return null;
  const scope = String(fact.value.scope).trim().toLowerCase();
  if (scope !== expectedScope) {
    throw new ConsumerError(400, 'realtime_entity_scope_invalid', 'That explicit-none scope is not valid for this planning fact.');
  }
  return {
    ...completionNoneMapping(profile, markerPath, fact.factId, scope),
    proposalValue: { operation: 'confirm_none', scope }
  };
}

function withSpecialistReconciliationInvalidation(profile, mapped, categories) {
  const completionFacts = profile.assumptions?.values?.completionFacts || {};
  const current = completionFacts.specialistAssetReconciliation;
  if (!plainObject(current)) return mapped;
  const next = { ...current };
  let changed = false;
  categories.forEach((category) => {
    if (!Object.hasOwn(next, category)) return;
    delete next[category];
    changed = true;
  });
  if (!changed) return mapped;
  const nextCompletionFacts = { ...completionFacts };
  if (Object.keys(next).length > 0) {
    nextCompletionFacts.specialistAssetReconciliation = next;
  } else {
    delete nextCompletionFacts.specialistAssetReconciliation;
  }
  return {
    ...mapped,
    additionalPatch: {
      ...(mapped.additionalPatch || {}),
      '/assumptions/values/completionFacts': nextCompletionFacts
    }
  };
}

function mapCollectionEntity(profile, fact, {
  collectionKey,
  idKey,
  idPrefix,
  buildValue,
  allowConfirmedNone = false
}) {
  const value = fact.value;
  const items = Array.isArray(value) ? value : (Array.isArray(value?.items) ? value.items : null);
  if (items) {
    if (items.length < 1 || items.length > 12) {
      throw new ConsumerError(400, 'realtime_entity_count_invalid', 'Provide between one and twelve positions in one answer.');
    }
    let projected = profile;
    let last = null;
    const proposalItems = [];
    for (const item of items) {
      last = mapCollectionEntity(projected, { ...fact, value: item }, {
        collectionKey, idKey, idPrefix, buildValue, allowConfirmedNone
      });
      if (last.fieldPath !== `/${collectionKey}`) {
        throw new ConsumerError(400, 'realtime_entity_operation_invalid', 'A multiple-position answer cannot mix positions with a none declaration.');
      }
      projected = { ...projected, [collectionKey]: last.canonicalValue };
      proposalItems.push(last.proposalValue);
    }
    return {
      fieldPath: `/${collectionKey}`,
      canonicalValue: projected[collectionKey],
      displayValue: { operation: 'batch', count: items.length },
      proposalValue: { items: proposalItems }
    };
  }
  const operation = entityOperation(value);
  const collectionPath = `/${collectionKey}`;
  if (operation === 'confirm_none') {
    if (!allowConfirmedNone) {
      throw new ConsumerError(409, 'realtime_entity_none_invalid', 'At least one reviewed position is required for this fact.');
    }
    return {
      ...confirmedNoneMapping(profile, collectionPath, fact.factId),
      proposalValue: { operation: 'confirm_none' }
    };
  }
  if (operation === 'complete_section') {
    return completionSectionMapping(profile, collectionPath, fact.factId);
  }
  const rawLabel = value.label ?? value.displayName ?? value.title;
  const label = typeof rawLabel === 'string' ? safeLabel(rawLabel) : '';
  const collection = [...(profile[collectionKey] || [])];
  const entityId = collectionEntityId(
    collection,
    idKey,
    idPrefix,
    value.entityId || value.id || value[idKey],
    label
  );
  const index = collection.findIndex((item) => item[idKey] === entityId);
  if (operation === 'remove') {
    if (index < 0) {
      throw new ConsumerError(409, 'realtime_entity_not_found', 'That position is not present in the current profile.');
    }
    collection.splice(index, 1);
    return {
      fieldPath: collectionPath,
      canonicalValue: collection,
      displayValue: { operation, entityId },
      proposalValue: { operation, entityId }
    };
  }
  const existing = index >= 0 ? collection[index] : null;
  const canonicalValue = buildValue({ value, existing, entityId, label });
  if (index >= 0) collection[index] = canonicalValue;
  else collection.push(canonicalValue);
  return {
    fieldPath: collectionPath,
    canonicalValue: collection,
    displayValue: { operation, entityId, label: canonicalValue.label || canonicalValue.displayName || label || undefined },
    proposalValue: { operation, entityId, ...canonicalValue }
  };
}

function withDecimalRateProposal(mapped) {
  const mark = (value) => plainObject(value) ? { ...value, rateUnit: 'decimal' } : value;
  return {
    ...mapped,
    proposalValue: Array.isArray(mapped.proposalValue?.items)
      ? { ...mapped.proposalValue, items: mapped.proposalValue.items.map(mark) }
      : mark(mapped.proposalValue)
  };
}

function projectPersonaFacts(profile, facts) {
  if (!profile) return null;
  const projected = JSON.parse(JSON.stringify(profile));
  projected.assumptions = projected.assumptions || { values: {} };
  projected.assumptions.values = projected.assumptions.values || {};
  projected.assumptions.values.persona = {
    ...(projected.assumptions.values.persona || {})
  };
  projected.assumptions.values.planning = {
    ...(projected.assumptions.values.planning || {})
  };
  for (const fact of facts || []) {
    if (fact?.factId === 'primary_goal') {
      const type = goalType(fact.value);
      const correctionTarget = plainObject(fact.value) && GOAL_TYPES.includes(fact.value.correctionTarget)
        ? fact.value.correctionTarget : null;
      const correctionIndex = correctionTarget
        ? projected.goals.findIndex((goal) => goal.type === correctionTarget)
        : -1;
      const existingTypeIndex = projected.goals.findIndex((goal) => goal.type === type);
      if (correctionIndex >= 0 && existingTypeIndex >= 0 && existingTypeIndex !== correctionIndex) {
        projected.goals[correctionIndex] = { ...projected.goals[correctionIndex], status: 'paused' };
        continue;
      }
      const index = correctionIndex >= 0 ? correctionIndex
        : existingTypeIndex >= 0 ? existingTypeIndex : projected.goals.length;
      if (index === projected.goals.length) {
        projected.goals.push({
          goalId: `goal_realtime_${type}`,
          type,
          title: GOAL_DEFINITIONS[type].title,
          priority: 'high',
          status: 'active'
        });
      } else if (correctionIndex >= 0) {
        projected.goals[index] = {
          ...projected.goals[index],
          goalId: `goal_realtime_${type}`,
          type,
          title: GOAL_DEFINITIONS[type].title,
          priority: 'high',
          status: 'active'
        };
      }
      continue;
    }
    if (!Object.hasOwn(INTAKE_FACT_PATHS, fact?.factId)) continue;
    const [key, kind] = INTAKE_FACT_PATHS[fact.factId];
    const target = fact.factId === 'primary_goal_focus'
      ? projected.assumptions.values.planning
      : projected.assumptions.values.persona;
    // Same wrapper tolerance as mapPersonaFact: this projection runs BEFORE the
    // mapper, so a wrapped value rejected here never reaches it.
    const projectedValue = scalarValue(fact.value, ['value']);
    target[key] = kind === 'boolean'
      ? strictBoolean(projectedValue)
      : kind === 'count'
        ? boundedNumber(projectedValue, { min: 0, max: 30, integer: true })
        : normalizedChoice(fact.factId, projectedValue);
  }
  return normalizeHouseholdProfile(projected);
}

export function modulesEnabledByFacts(recommendations, facts = [], profile = null) {
  const projectedProfile = projectPersonaFacts(profile, facts);
  const modules = new Set(projectedProfile
    ? []
    : (recommendations || [])
      .map((item) => item?.moduleId)
      .filter((moduleId) => typeof moduleId === 'string'));
  if (projectedProfile) {
    const plan = buildGoalModulePlan(projectedProfile);
    plan.moduleSlots.forEach((slot) => modules.add(slot.moduleId));
  }
  return modules;
}

export function realtimeFactAllowed(factId, enabledModules) {
  if (factId === 'primary_goal' || Object.hasOwn(INTAKE_FACT_PATHS, factId)) return true;
  const required = getPlanningModulesForSemanticFact(factId);
  return Boolean(required && required.some((moduleId) => enabledModules.has(moduleId)));
}

function humanise(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

function formattedFactValue(factId, value, currency = 'EUR') {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.hasOwn(value, 'value')) {
      return formattedFactValue(factId, value.value, currency);
    }
    if (Number.isFinite(value.amount)) {
      return new Intl.NumberFormat('en-IE', {
        style: 'currency',
        currency: /^[A-Z]{3}$/.test(String(value.currency || '')) ? value.currency : currency,
        maximumFractionDigits: Number.isInteger(value.amount) ? 0 : 2
      }).format(value.amount);
    }
    const range = value.range && typeof value.range === 'object' ? value.range : value;
    if (range && Object.hasOwn(range, 'min') && Object.hasOwn(range, 'max')) {
      return `between ${formattedFactValue(factId, range.min, currency)} and ${formattedFactValue(factId, range.max, currency)}`;
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (['pension_employee_contribution_rate', 'pension_employer_contribution_rate', 'mortgage_annual_interest_rate', 'loan_annual_interest_rate'].includes(factId)) {
      return new Intl.NumberFormat('en-IE', { style: 'percent', maximumFractionDigits: 2 }).format(value);
    }
    return new Intl.NumberFormat('en-IE', { maximumFractionDigits: 2 }).format(value);
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return humanise(value);
}

/**
 * Code-owned spoken confirmation. The model may speak this text verbatim, but
 * may not create or paraphrase the value being confirmed.
 */
export function buildRealtimeFactReadBack(
  factId, value, certainty = 'exact', currency = 'EUR', statedRange = null
) {
  const definition = getSemanticFactDefinition(factId);
  const label = definition?.label || humanise(factId) || 'Planning detail';
  if (certainty === 'unknown') {
    return `You do not know ${label.toLowerCase()} yet. Is that right?`;
  }
  // A stated range is confirmed as a range, alongside the single figure the
  // analysis will actually use. Reading back only the midpoint would put words
  // in the client's mouth; reading back only the range would hide the number
  // the result depends on.
  if (statedRange) {
    const minimum = formattedFactValue(factId, statedRange.min, currency);
    const maximum = formattedFactValue(factId, statedRange.max, currency);
    const midpoint = formattedFactValue(factId, value, currency);
    return `You said ${label.toLowerCase()} is between ${minimum} and ${maximum}, `
      + `so I will work with ${midpoint}. Is that right?`;
  }
  const formatted = formattedFactValue(factId, value, currency);
  const qualifier = certainty === 'approximate' ? 'approximately ' : '';
  return `You said ${label.toLowerCase()} is ${qualifier}${formatted}. Is that right?`;
}

function mapPersonaFact(profile, fact) {
  const [key, kind] = INTAKE_FACT_PATHS[fact.factId];
  // The planner routinely wraps a scalar as {"value": x} — its schema carries
  // every fact value as a JSON string, and that is the shape it naturally
  // produces. Numeric facts already unwrap ({"age":25} maps fine) and goals
  // already accept {"type":...}, but orientation facts did not, so every
  // life_stage, career_stage, property_status, employment_context,
  // retirement_status and household_structure candidate was rejected with
  // realtime_fact_value_invalid. Those are exactly the facts that drive
  // routing. Unwrap once, here, so all three kinds behave the same.
  const rawValue = scalarValue(fact.value, ['value']);
  const canonicalValue = kind === 'boolean'
    ? strictBoolean(rawValue)
    : kind === 'count'
      ? boundedNumber(rawValue, { min: 0, max: 30, integer: true })
      : normalizedChoice(fact.factId, rawValue);
  return {
    fieldPath: fact.factId === 'primary_goal_focus'
      ? `/assumptions/values/planning/${key}`
      : `/assumptions/values/persona/${key}`,
    canonicalValue,
    displayValue: canonicalValue
  };
}

function selectedEntityId(value, prefix, collection, idKey) {
  if (!plainObject(value)) return null;
  const supplied = value.entityId || value.id;
  return supplied ? collectionEntityId(collection, idKey, prefix, supplied) : null;
}

function pensionIndex(profile, value) {
  const selectedId = selectedEntityId(value, 'pension', profile.pensions, 'pensionId');
  const stableId = selectedId || 'pension_realtime_primary';
  const index = stableCollectionIndex(profile.pensions, (pension) => pension.pensionId === stableId);
  if (!selectedId && index === profile.pensions.length && profile.pensions.length > 0) {
    throw new ConsumerError(409, 'realtime_pension_review_required', 'Existing pension positions require visual review before using an aggregate spoken value.');
  }
  return { stableId, index, existing: profile.pensions[index] };
}

function selectedDebtIndex(profile, value, type) {
  const selectedId = selectedEntityId(value, 'liability', profile.liabilities, 'liabilityId');
  const stableId = selectedId || `liability_realtime_${type}`;
  const existingIndex = profile.liabilities.findIndex((liability) => liability.liabilityId === stableId);
  const index = selectedId || existingIndex >= 0
    ? existingIndex
    : profile.liabilities.findIndex((liability) => liability.type === type);
  if (!selectedId && index < 0 && profile.liabilities.length > 0) {
    throw new ConsumerError(409, `realtime_${type}_review_required`, `Existing liabilities require visual review before adding a spoken ${type} aggregate.`);
  }
  return { stableId, index: index < 0 ? profile.liabilities.length : index, existing: index < 0 ? null : profile.liabilities[index] };
}

function mortgageIndex(profile, value) {
  return selectedDebtIndex(profile, value, 'mortgage');
}

function liabilityIndex(profile, value) {
  const selectedId = selectedEntityId(value, 'liability', profile.liabilities, 'liabilityId');
  if (selectedId) {
    const index = profile.liabilities.findIndex((liability) => liability.liabilityId === selectedId);
    if (index >= 0) return { stableId: selectedId, index, existing: profile.liabilities[index] };
  }
  if (!selectedId && profile.liabilities.length === 1) {
    return {
      stableId: profile.liabilities[0].liabilityId,
      index: 0,
      existing: profile.liabilities[0]
    };
  }
  throw new ConsumerError(
    409,
    profile.liabilities.length > 0 ? 'realtime_liability_review_required' : 'realtime_liability_required',
    profile.liabilities.length > 0
      ? 'Identify which existing liability this monthly payment belongs to.'
      : 'Add the liability before recording its monthly payment.'
  );
}

function mapPartnerPerson(profile, fact) {
  const value = fact.value;
  const operation = entityOperation(value);
  if (['remove', 'confirm_none'].includes(operation)) {
    if (profile.assumptions?.values?.persona?.householdStructure === 'couple') {
      throw new ConsumerError(
        409,
        'realtime_household_structure_conflict',
        'Change the household structure from couple before removing or declining the partner record.'
      );
    }
    const partnerId = profile.partner?.personId;
    if (partnerId) {
      const linked = [
        ...(profile.assets || []).filter((item) => item.ownerIds?.includes(partnerId)),
        ...(profile.liabilities || []).filter((item) => item.ownerIds?.includes(partnerId)),
        ...(profile.incomeSources || []).filter((item) => item.ownerId === partnerId),
        ...(profile.pensions || []).filter((item) => item.ownerId === partnerId),
        ...(profile.properties || []).filter((item) => item.ownerIds?.includes(partnerId)),
        ...(profile.businesses || []).filter((item) => item.ownerIds?.includes(partnerId))
      ];
      if (linked.length > 0) {
        throw new ConsumerError(
          409,
          'realtime_partner_positions_exist',
          'Remove or reassign the partner’s financial positions before removing the partner.'
        );
      }
    }
    return {
      fieldPath: '/partner',
      canonicalValue: null,
      displayValue: { operation: 'remove' },
      proposalValue: { operation: 'remove' }
    };
  }
  const employmentStatus = String(value.employmentStatus || profile.partner?.employmentStatus || 'unknown')
    .trim()
    .toLowerCase();
  if (!['employee', 'self_employed', 'contractor', 'retired', 'other', 'unknown'].includes(employmentStatus)) {
    throw new ConsumerError(400, 'realtime_employment_status_invalid', 'That partner employment status requires visual review.');
  }
  const partner = {
    ...(profile.partner || {}),
    personId: profile.partner?.personId || 'partner_realtime',
    role: 'partner',
    employmentStatus
  };
  if (typeof value.displayName === 'string' || typeof value.label === 'string') {
    partner.displayName = safeLabel(value.displayName ?? value.label);
  }
  const age = optionalBounded(value.age ?? value.currentAge, { min: 18, max: 120, integer: true });
  const retirementAge = optionalBounded(
    value.intendedRetirementAge ?? value.retirementAge,
    { min: 18, max: 120, integer: true }
  );
  if (typeof age === 'number') partner.age = age;
  if (typeof retirementAge === 'number') partner.intendedRetirementAge = retirementAge;
  return {
    fieldPath: '/partner',
    canonicalValue: partner,
    displayValue: { operation: 'upsert', personId: partner.personId },
    proposalValue: { operation: 'upsert', ...partner }
  };
}

function mapIncomeSource(profile, fact, currency) {
  const scopedNone = scopedNoneMapping(
    profile,
    fact,
    'net_retirement_income',
    '/incomeSources/netAnnual'
  );
  if (scopedNone) return scopedNone;
  return mapCollectionEntity(profile, fact, {
    collectionKey: 'incomeSources',
    idKey: 'incomeId',
    idPrefix: 'income',
    allowConfirmedNone: true,
    buildValue: ({ value, existing, entityId, label }) => {
      const type = String(value.type || existing?.type || '').trim().toLowerCase();
      if (!['employment', 'self_employment', 'rental', 'pension', 'state_pension', 'other'].includes(type)) {
        throw new ConsumerError(400, 'realtime_income_type_invalid', 'That income type requires visual review.');
      }
      const grossAnnual = optionalMoney(value.grossAnnual ?? value.gross, currency);
      const netAnnual = optionalMoney(value.netAnnual ?? value.net, currency);
      if (!existing && !grossAnnual && !netAnnual) {
        throw new ConsumerError(400, 'realtime_income_value_required', 'A new income source needs a gross or net annual amount.');
      }
      const canonical = {
        ...(existing || {}),
        incomeId: entityId,
        ownerId: ownerId(profile, value.owner ?? value.ownerId ?? existing?.ownerId),
        type,
        label: label || existing?.label || safeLabel(`${humanise(type)} income`)
      };
      if (grossAnnual) canonical.grossAnnual = grossAnnual;
      if (netAnnual) canonical.netAnnual = netAnnual;
      const startAge = optionalBounded(value.startAge, { min: 0, max: 120, integer: true });
      const endAge = optionalBounded(value.endAge, { min: 0, max: 120, integer: true });
      if (typeof startAge === 'number') canonical.startAge = startAge;
      if (typeof endAge === 'number') canonical.endAge = endAge;
      if (typeof value.inflationIndexed === 'boolean') canonical.inflationIndexed = value.inflationIndexed;
      return canonical;
    }
  });
}

function mapAssetPosition(profile, fact, currency) {
  const scopedNone = scopedNoneMapping(
    profile,
    fact,
    'retirement_available_assets',
    '/assets/retirementAvailable'
  );
  if (scopedNone) return scopedNone;
  return withSpecialistReconciliationInvalidation(profile, mapCollectionEntity(profile, fact, {
    collectionKey: 'assets',
    idKey: 'assetId',
    idPrefix: 'asset',
    allowConfirmedNone: true,
    buildValue: ({ value, existing, entityId, label }) => {
      const type = String(value.type || existing?.type || '').trim().toLowerCase();
      if (!['cash', 'investment', 'other'].includes(type)) {
        throw new ConsumerError(
          400,
          'realtime_asset_type_invalid',
          'Use the dedicated property, pension or business position fact for that asset type.'
        );
      }
      const canonical = {
        ...(existing || {}),
        assetId: entityId,
        ownerIds: Object.hasOwn(value, 'ownerIds') || Object.hasOwn(value, 'owners') || Object.hasOwn(value, 'owner')
          ? ownerIds(profile, value)
          : (existing?.ownerIds || ownerIds(profile, value)),
        type,
        label: label || existing?.label || safeLabel(humanise(type))
      };
      const currentValue = optionalMoney(value.currentValue ?? value.amount, currency);
      if (currentValue) canonical.currentValue = currentValue;
      if (value.country) canonical.country = safeLabel(value.country);
      if (typeof value.liquid === 'boolean') canonical.liquid = value.liquid;
      else if (!existing && type === 'cash') canonical.liquid = true;
      return canonical;
    }
  }), ['property', 'pension', 'business']);
}

function mapLiabilityPosition(profile, fact, currency) {
  const mortgageOnly = fact.factId === 'mortgage_position';
  const loanOnly = fact.factId === 'loan_position';
  const mapped = withDecimalRateProposal(mapCollectionEntity(profile, fact, {
    collectionKey: 'liabilities',
    idKey: 'liabilityId',
    idPrefix: 'liability',
    allowConfirmedNone: true,
    buildValue: ({ value, existing, entityId, label }) => {
      const type = String(value.type || existing?.type || '').trim().toLowerCase();
      if (!['mortgage', 'loan', 'credit_card', 'other'].includes(type)) {
        throw new ConsumerError(400, 'realtime_liability_type_invalid', 'That liability type requires visual review.');
      }
      if (mortgageOnly && type !== 'mortgage') {
        throw new ConsumerError(400, 'realtime_mortgage_type_required', 'The mortgage comparison requires a mortgage liability, not another debt type.');
      }
      if (loanOnly && type !== 'loan') {
        throw new ConsumerError(400, 'realtime_loan_type_required', 'The loan repayment comparison requires a non-housing loan liability.');
      }
      const canonical = {
        ...(existing || {}),
        liabilityId: entityId,
        ownerIds: Object.hasOwn(value, 'ownerIds') || Object.hasOwn(value, 'owners') || Object.hasOwn(value, 'owner')
          ? ownerIds(profile, value)
          : (existing?.ownerIds || ownerIds(profile, value)),
        type,
        label: label || existing?.label || safeLabel(humanise(type))
      };
      const currentBalance = optionalMoney(value.currentBalance ?? value.amount, currency);
      const monthlyPayment = optionalMoney(value.monthlyPayment, currency);
      const annualInterestRate = optionalRate(
        value.annualInterestRate ?? value.interestRate,
        { decimal: value.rateUnit === 'decimal' }
      );
      const remainingTermMonths = optionalRemainingTermMonths(value);
      if (currentBalance) canonical.currentBalance = currentBalance;
      if (monthlyPayment) canonical.monthlyPayment = monthlyPayment;
      if (typeof annualInterestRate === 'number') canonical.annualInterestRate = annualInterestRate;
      if (typeof remainingTermMonths === 'number') canonical.remainingTermMonths = remainingTermMonths;
      return canonical;
    }
  }));
  const linkedPropertyId = typeof fact.value?.linkedPropertyId === 'string'
    ? fact.value.linkedPropertyId.trim()
    : '';
  if (!linkedPropertyId || entityOperation(fact.value) !== 'upsert') return mapped;
  const canonicalLinkedId = linkedPropertyId.startsWith('property_')
    ? linkedPropertyId
    : canonicalEntityId('property', linkedPropertyId);
  const propertyIndex = profile.properties.findIndex((property) => property.propertyId === canonicalLinkedId);
  if (propertyIndex < 0) return mapped;
  const liabilityId = mapped.proposalValue?.entityId || mapped.displayValue?.entityId;
  if (!liabilityId) return mapped;
  const property = profile.properties[propertyIndex];
  return {
    ...mapped,
    additionalPatch: {
      ...(mapped.additionalPatch || {}),
      [`/properties/${propertyIndex}`]: {
        ...property,
        associatedLiabilityIds: [...new Set([...(property.associatedLiabilityIds || []), liabilityId])]
      }
    }
  };
}

function mapPropertyPosition(profile, fact, currency) {
  return withSpecialistReconciliationInvalidation(profile, mapCollectionEntity(profile, fact, {
    collectionKey: 'properties',
    idKey: 'propertyId',
    idPrefix: 'property',
    allowConfirmedNone: true,
    buildValue: ({ value, existing, entityId }) => {
      const use = String(value.use || existing?.use || '').trim().toLowerCase();
      if (!['home', 'rental', 'farm', 'business', 'other'].includes(use)) {
        throw new ConsumerError(400, 'realtime_property_use_invalid', 'That property use requires visual review.');
      }
      const canonical = {
        ...(existing || {}),
        propertyId: entityId,
        ownerIds: Object.hasOwn(value, 'ownerIds') || Object.hasOwn(value, 'owners') || Object.hasOwn(value, 'owner')
          ? ownerIds(profile, value)
          : (existing?.ownerIds || ownerIds(profile, value)),
        use,
        associatedLiabilityIds: existing?.associatedLiabilityIds || []
      };
      const currentValue = optionalMoney(value.currentValue ?? value.amount, currency);
      if (currentValue) canonical.currentValue = currentValue;
      return canonical;
    }
  }), ['property']);
}

function mapBusinessPosition(profile, fact, currency) {
  return withSpecialistReconciliationInvalidation(profile, mapCollectionEntity(profile, fact, {
    collectionKey: 'businesses',
    idKey: 'businessId',
    idPrefix: 'business',
    allowConfirmedNone: true,
    buildValue: ({ value, existing, entityId, label }) => {
      if (!existing && typeof value.agricultural !== 'boolean') {
        throw new ConsumerError(400, 'realtime_business_type_required', 'Confirm whether the business interest is agricultural.');
      }
      const canonical = {
        ...(existing || {}),
        businessId: entityId,
        ownerIds: Object.hasOwn(value, 'ownerIds') || Object.hasOwn(value, 'owners') || Object.hasOwn(value, 'owner')
          ? ownerIds(profile, value)
          : (existing?.ownerIds || ownerIds(profile, value)),
        label: label || existing?.label || safeLabel('Business interest'),
        agricultural: typeof value.agricultural === 'boolean' ? value.agricultural : existing.agricultural
      };
      const estimatedValue = optionalMoney(value.estimatedValue ?? value.amount, currency);
      if (estimatedValue) canonical.estimatedValue = estimatedValue;
      return canonical;
    }
  }), ['business']);
}

function mapPensionPosition(profile, fact, currency) {
  return withSpecialistReconciliationInvalidation(profile, withDecimalRateProposal(mapCollectionEntity(profile, fact, {
    collectionKey: 'pensions',
    idKey: 'pensionId',
    idPrefix: 'pension',
    allowConfirmedNone: true,
    buildValue: ({ value, existing, entityId }) => {
      const type = String(value.type || existing?.type || '').trim().toLowerCase();
      if (!['occupational', 'prsa', 'personal', 'defined_benefit', 'other'].includes(type)) {
        throw new ConsumerError(400, 'realtime_pension_type_invalid', 'That pension type requires visual review.');
      }
      const canonical = {
        ...(existing || {}),
        pensionId: entityId,
        ownerId: ownerId(profile, value.owner ?? value.ownerId ?? existing?.ownerId),
        type
      };
      const currentValue = optionalMoney(value.currentValue ?? value.amount, currency);
      const rateOptions = { decimal: value.rateUnit === 'decimal' };
      const employeeRate = value.employeeContributionRate === null || typeof value.employeeContributionRate === 'undefined'
        ? optionalRate(value.personalContributionRate, rateOptions)
        : optionalRate(value.employeeContributionRate, rateOptions);
      const employerRate = optionalRate(value.employerContributionRate, rateOptions);
      if (currentValue) canonical.currentValue = currentValue;
      if (typeof employeeRate === 'number') canonical.employeeContributionRate = employeeRate;
      if (typeof employerRate === 'number') canonical.employerContributionRate = employerRate;
      return canonical;
    }
  })), ['pension']);
}

function mapDependantPosition(profile, fact) {
  return mapCollectionEntity(profile, fact, {
    collectionKey: 'dependants',
    idKey: 'dependantId',
    idPrefix: 'dependant',
    allowConfirmedNone: true,
    buildValue: ({ value, existing, entityId, label }) => {
      const canonical = { ...(existing || {}), dependantId: entityId };
      if (label) canonical.displayName = label;
      const currentAge = optionalBounded(value.currentAge ?? value.age, { min: 0, max: 100, integer: true });
      const dependencyEnd = optionalBounded(value.expectedDependencyEndAge, { min: 0, max: 100, integer: true });
      if (typeof currentAge === 'number') canonical.currentAge = currentAge;
      if (typeof dependencyEnd === 'number') canonical.expectedDependencyEndAge = dependencyEnd;
      return canonical;
    }
  });
}

function mapCollegeCostScenario(profile, fact, currency) {
  const value = fact.value;
  const items = Array.isArray(value) ? value : (Array.isArray(value?.items) ? value.items : null);
  if (items) {
    if (items.length < 1 || items.length > 8) {
      throw new ConsumerError(400, 'realtime_entity_count_invalid', 'Provide between one and eight college scenarios.');
    }
    let projected = profile;
    let last = null;
    const proposalItems = [];
    for (const item of items) {
      last = mapCollegeCostScenario(projected, { ...fact, value: item }, currency);
      projected = {
        ...projected,
        assumptions: {
          ...projected.assumptions,
          values: {
            ...projected.assumptions.values,
            collegeFunding: last.canonicalValue
          }
        }
      };
      proposalItems.push(last.proposalValue);
    }
    return {
      fieldPath: '/assumptions/values/collegeFunding',
      canonicalValue: projected.assumptions.values.collegeFunding,
      displayValue: { operation: 'batch', count: items.length },
      proposalValue: { items: proposalItems }
    };
  }
  const operation = entityOperation(value);
  if (operation === 'confirm_none') {
    throw new ConsumerError(409, 'realtime_college_scenario_required', 'The future college-cost estimate requires at least one reviewed cost scenario.');
  }
  const settings = { ...(profile.assumptions?.values?.collegeFunding || {}) };
  const scenarios = [...(Array.isArray(settings.scenarios) ? settings.scenarios : [])];
  const scenarioId = collectionEntityId(
    scenarios,
    'id',
    'college_scenario',
    value.entityId || value.scenarioId || value.id,
    value.title
  );
  const index = scenarios.findIndex((scenario) => scenario.id === scenarioId);
  if (operation === 'remove') {
    if (index < 0) throw new ConsumerError(409, 'realtime_entity_not_found', 'That college cost scenario is not present.');
    scenarios.splice(index, 1);
  } else {
    const existing = index >= 0 ? scenarios[index] : null;
    const annual = optionalMoney(value.annualCostTodayPerChild ?? value.annualCostToday, currency);
    const oneOff = optionalMoney(value.oneOffCostTodayPerChild ?? value.oneOffCostToday, currency);
    const scenario = {
      ...(existing || {}),
      id: scenarioId,
      title: safeLabel(value.title, existing?.title || 'College cost scenario'),
      category: safeLabel(value.category, existing?.category || value.title || 'Reviewed scenario')
    };
    if (annual) scenario.annualCostTodayPerChild = annual.amount;
    if (oneOff) scenario.oneOffCostTodayPerChild = oneOff.amount;
    if (!Number.isFinite(scenario.annualCostTodayPerChild)) scenario.annualCostTodayPerChild = 0;
    if (!Number.isFinite(scenario.oneOffCostTodayPerChild)) scenario.oneOffCostTodayPerChild = 0;
    if (scenario.annualCostTodayPerChild <= 0 && scenario.oneOffCostTodayPerChild <= 0) {
      throw new ConsumerError(400, 'realtime_college_scenario_value_required', 'A college scenario needs an annual or one-off cost.');
    }
    if (index >= 0) scenarios[index] = scenario;
    else scenarios.push(scenario);
  }
  return {
    fieldPath: '/assumptions/values/collegeFunding',
    canonicalValue: { ...settings, requested: true, scenarios },
    displayValue: { operation, scenarioId },
    proposalValue: operation === 'remove'
      ? { operation, scenarioId }
      : { operation: 'upsert', scenarioId, ...scenarios.find((scenario) => scenario.id === scenarioId) }
  };
}

const SPECIALIST_RECONCILIATION_CATEGORIES = Object.freeze({
  property: Object.freeze({ collectionKey: 'properties', idKey: 'propertyId', idPrefix: 'property', genericTypes: ['property'] }),
  pension: Object.freeze({ collectionKey: 'pensions', idKey: 'pensionId', idPrefix: 'pension', genericTypes: ['pension'] }),
  business: Object.freeze({ collectionKey: 'businesses', idKey: 'businessId', idPrefix: 'business', genericTypes: ['business', 'agricultural'] })
});

function mapSpecialistAssetReconciliation(profile, fact) {
  const value = fact.value;
  if (!plainObject(value)) {
    throw new ConsumerError(400, 'realtime_fact_value_invalid', 'That reconciliation must identify the record and whether it is duplicate or distinct.');
  }
  const category = String(value.category || value.type || '').trim().toLowerCase();
  const definition = SPECIALIST_RECONCILIATION_CATEGORIES[category];
  if (!definition) {
    throw new ConsumerError(400, 'realtime_reconciliation_category_invalid', 'That reconciliation category requires visual review.');
  }
  const decision = String(value.decision || value.value || '').trim().toLowerCase();
  if (!['duplicate', 'distinct'].includes(decision)) {
    throw new ConsumerError(400, 'realtime_reconciliation_decision_invalid', 'Choose duplicate or distinct for that specialist position.');
  }
  if (!(profile.assets || []).some((asset) => definition.genericTypes.includes(asset.type))) {
    throw new ConsumerError(409, 'realtime_reconciliation_not_required', 'There is no overlapping generic asset for that specialist position.');
  }
  const records = profile[definition.collectionKey] || [];
  const suppliedId = typeof (value.entityId ?? value.recordId ?? value.id) === 'string'
    ? String(value.entityId ?? value.recordId ?? value.id).trim()
    : '';
  let record = suppliedId
    ? records.find((item) => item[definition.idKey] === suppliedId)
    : records.length === 1 ? records[0] : null;
  if (!record && suppliedId) {
    const canonicalId = canonicalEntityId(definition.idPrefix, suppliedId);
    record = records.find((item) => item[definition.idKey] === canonicalId);
  }
  if (!record) {
    throw new ConsumerError(409, 'realtime_reconciliation_record_required', 'Identify exactly which specialist position this duplicate-or-distinct choice applies to.');
  }
  const recordId = record[definition.idKey];
  const completionFacts = profile.assumptions?.values?.completionFacts || {};
  const reconciliation = completionFacts.specialistAssetReconciliation || {};
  const canonicalValue = {
    ...completionFacts,
    specialistAssetReconciliation: {
      ...reconciliation,
      [category]: {
        ...(reconciliation[category] || {}),
        [recordId]: decision
      }
    }
  };
  const proposalValue = { category, entityId: recordId, decision };
  return {
    fieldPath: '/assumptions/values/completionFacts',
    metadataPath: `/assumptions/values/completionFacts/specialistAssetReconciliation/${escapeJsonPointerToken(category)}/${escapeJsonPointerToken(recordId)}`,
    canonicalValue,
    displayValue: proposalValue,
    proposalValue
  };
}

export function mapRealtimeFact(profile, fact) {
  if (!REALTIME_CANARY_FACT_IDS.includes(fact.factId)) {
    throw new ConsumerError(409, 'realtime_fact_not_supported', 'That fact is not available in the realtime canary.');
  }
  if (Object.hasOwn(INTAKE_FACT_PATHS, fact.factId)) return mapPersonaFact(profile, fact);
  const currency = profile?.preferences?.baseCurrency || 'EUR';
  const primaryOwnerId = profile?.primaryPerson?.personId;
  if (!primaryOwnerId) throw new ConsumerError(409, 'realtime_profile_invalid', 'The household profile is not ready for this fact.');

  if (fact.factId === 'partner_person') return mapPartnerPerson(profile, fact);
  if (fact.factId === 'income_sources') return mapIncomeSource(profile, fact, currency);
  if (fact.factId === 'asset_position') return mapAssetPosition(profile, fact, currency);
  if (fact.factId === 'liability_position' || fact.factId === 'mortgage_position' || fact.factId === 'loan_position') {
    return mapLiabilityPosition(profile, fact, currency);
  }
  if (fact.factId === 'property_position') return mapPropertyPosition(profile, fact, currency);
  if (fact.factId === 'business_position') return mapBusinessPosition(profile, fact, currency);
  if (fact.factId === 'pension_positions') return mapPensionPosition(profile, fact, currency);
  if (fact.factId === 'dependants') return mapDependantPosition(profile, fact);
  if (fact.factId === 'college_cost_scenarios') return mapCollegeCostScenario(profile, fact, currency);
  if (fact.factId === 'specialist_asset_reconciliation') return mapSpecialistAssetReconciliation(profile, fact);

  if (fact.factId === 'primary_goal') {
    const type = goalType(fact.value);
    const correctionTarget = plainObject(fact.value) && GOAL_TYPES.includes(fact.value.correctionTarget)
      ? fact.value.correctionTarget : null;
    const correctionIndex = correctionTarget
      ? profile.goals.findIndex((goal) => goal.type === correctionTarget)
      : -1;
    const existingTypeIndex = profile.goals.findIndex((goal) => goal.type === type);
    if (correctionIndex >= 0 && existingTypeIndex >= 0 && existingTypeIndex !== correctionIndex) {
      return {
        fieldPath: `/goals/${existingTypeIndex}`,
        canonicalValue: profile.goals[existingTypeIndex],
        additionalPatch: {
          [`/goals/${correctionIndex}`]: { ...profile.goals[correctionIndex], status: 'paused' }
        },
        displayValue: type
      };
    }
    const index = correctionIndex >= 0 ? correctionIndex
      : existingTypeIndex >= 0 ? existingTypeIndex : profile.goals.length;
    const existing = profile.goals[index];
    return {
      fieldPath: `/goals/${index}`,
      canonicalValue: {
        ...(existing || {}),
        goalId: correctionIndex >= 0 || !existing ? `goal_realtime_${type}` : existing.goalId,
        type,
        title: GOAL_DEFINITIONS[type].title,
        // Neutral by default. Explicit client priority is expressed through
        // primary_goal_focus. Marking every goal "high" made the priority sort
        // inert and silently collapsed ranking to mention order.
        priority: 'medium',
        status: 'active'
      },
      displayValue: type
    };
  }

  if (fact.factId === 'target_home_price') {
    const index = profile.goals.findIndex((goal) => goal.type === 'buy_home');
    if (index < 0) throw new ConsumerError(409, 'realtime_home_goal_required', 'Confirm the home-buying goal before its target price.');
    const canonicalValue = money(fact.value, currency);
    return { fieldPath: `/goals/${index}/targetAmount`, canonicalValue, displayValue: canonicalValue };
  }

  if (fact.factId === 'gross_household_income') {
    if (profile.partner?.personId) {
      throw new ConsumerError(
        409,
        'realtime_joint_income_breakdown_required',
        'Joint applicants must record each person’s income separately.'
      );
    }
    const canonicalMoney = money(fact.value, currency);
    const stableId = 'income_realtime_household_gross';
    const index = stableCollectionIndex(profile.incomeSources, (income) => income.incomeId === stableId);
    if (index === profile.incomeSources.length && profile.incomeSources.length > 0) {
      throw new ConsumerError(409, 'realtime_income_review_required', 'Existing income sources require visual review before replacing them with an aggregate.');
    }
    const existing = profile.incomeSources[index];
    const canonicalValue = {
      ...(existing || { incomeId: stableId, ownerId: primaryOwnerId, type: 'employment', label: 'Household gross income' }),
      grossAnnual: canonicalMoney
    };
    return { fieldPath: `/incomeSources/${index}`, canonicalValue, displayValue: canonicalMoney };
  }

  if (fact.factId === 'cash_savings') {
    const canonicalMoney = money(fact.value, currency);
    const stableId = 'asset_realtime_cash_savings';
    const existingIndex = profile.assets.findIndex((asset) => asset.assetId === stableId);
    const cashIndex = existingIndex >= 0
      ? existingIndex
      : profile.assets.findIndex((asset) => asset.type === 'cash' && asset.liquid !== false);
    if (cashIndex >= 0) {
      return { fieldPath: `/assets/${cashIndex}/currentValue`, canonicalValue: canonicalMoney, displayValue: canonicalMoney };
    }
    return {
      fieldPath: `/assets/${profile.assets.length}`,
      canonicalValue: { assetId: stableId, ownerIds: [primaryOwnerId], type: 'cash', label: 'Cash savings', currentValue: canonicalMoney, liquid: true },
      displayValue: canonicalMoney
    };
  }

  if (fact.factId === 'monthly_spending' || fact.factId === 'annual_net_spending' || fact.factId === 'current_monthly_rent') {
    const key = fact.factId === 'monthly_spending' ? 'monthlyEssential'
      : fact.factId === 'annual_net_spending' ? 'annualTotal' : 'currentMonthlyRent';
    const canonicalValue = money(fact.value, currency);
    return { fieldPath: `/expenses/${key}`, canonicalValue, displayValue: canonicalValue };
  }

  if (fact.factId === 'person_current_age' || fact.factId === 'intended_retirement_age') {
    const key = fact.factId === 'person_current_age' ? 'age' : 'intendedRetirementAge';
    const selectedOwnerId = plainObject(fact.value)
      ? ownerId(profile, fact.value.owner ?? fact.value.ownerId ?? fact.value.personId)
      : primaryOwnerId;
    const canonicalValue = boundedNumber(
      scalarValue(fact.value, [key, fact.factId === 'person_current_age' ? 'currentAge' : 'retirementAge', 'age']),
      { min: fact.factId === 'person_current_age' ? 16 : 18, max: 100, integer: true }
    );
    const personPath = selectedOwnerId === profile.partner?.personId ? '/partner' : '/primaryPerson';
    return {
      fieldPath: `${personPath}/${key}`,
      canonicalValue,
      displayValue: canonicalValue,
      ...(plainObject(fact.value) ? { proposalValue: { ownerId: selectedOwnerId, value: canonicalValue } } : {})
    };
  }

  if (fact.factId === 'state_pension_fraction' || fact.factId === 'state_pension_start_age') {
    const selectedOwnerId = plainObject(fact.value)
      ? ownerId(profile, fact.value.owner ?? fact.value.ownerId ?? fact.value.personId)
      : primaryOwnerId;
    const current = profile.assumptions?.values?.retirement || {};
    const mapKey = fact.factId === 'state_pension_fraction'
      ? 'statePensionFraction'
      : 'statePensionStartAge';
    const canonicalValue = fact.factId === 'state_pension_fraction'
      ? boundedNumber(scalarValue(fact.value, ['fraction', 'value']), { min: 0, max: 1 })
      : boundedNumber(scalarValue(fact.value, ['startAge', 'age', 'value']), { min: 66, max: 70, integer: true });
    return {
      fieldPath: '/assumptions/values/retirement',
      metadataPath: `/assumptions/values/retirement/${mapKey}/${escapeJsonPointerToken(selectedOwnerId)}`,
      canonicalValue: {
        ...current,
        [mapKey]: { ...(current[mapKey] || {}), [selectedOwnerId]: canonicalValue },
        ...(fact.factId === 'state_pension_fraction'
          ? { includeStatePension: { ...(current.includeStatePension || {}), [selectedOwnerId]: canonicalValue > 0 } }
          : {})
      },
      displayValue: canonicalValue,
      proposalValue: { ownerId: selectedOwnerId, value: canonicalValue }
    };
  }

  if (['pension_current_value', 'pension_employee_contribution_rate', 'pension_employer_contribution_rate'].includes(fact.factId)) {
    const { stableId, index, existing } = pensionIndex(profile, fact.value);
    const key = fact.factId === 'pension_current_value' ? 'currentValue'
      : fact.factId === 'pension_employee_contribution_rate' ? 'employeeContributionRate' : 'employerContributionRate';
    const canonicalValue = fact.factId === 'pension_current_value'
      ? money(fact.value, currency)
      : percentageRate(
        scalarValue(fact.value, [key, 'rate']),
        { decimal: plainObject(fact.value) && fact.value.rateUnit === 'decimal' }
      );
    const proposalValue = fact.factId === 'pension_current_value'
      ? { entityId: stableId, ...canonicalValue }
      : { entityId: stableId, value: canonicalValue, rateUnit: 'decimal' };
    if (existing) {
      return withSpecialistReconciliationInvalidation(profile, {
        fieldPath: `/pensions/${index}/${key}`,
        canonicalValue,
        displayValue: canonicalValue,
        proposalValue
      }, ['pension']);
    }
    const pensionOwnerId = plainObject(fact.value)
      ? ownerId(profile, fact.value.owner ?? fact.value.ownerId)
      : primaryOwnerId;
    const pension = { ...(existing || { pensionId: stableId, ownerId: pensionOwnerId, type: 'occupational' }), [key]: canonicalValue };
    return withSpecialistReconciliationInvalidation(profile, {
      fieldPath: `/pensions/${index}`,
      canonicalValue: pension,
      displayValue: canonicalValue,
      proposalValue: { ...proposalValue, ownerId: pensionOwnerId }
    }, ['pension']);
  }

  if (fact.factId === 'target_retirement_income') {
    const canonicalValue = money(fact.value, currency);
    return { fieldPath: '/assumptions/values/retirement', canonicalValue: {
      ...(profile.assumptions?.values?.retirement || {}), targetIncomeToday: canonicalValue.amount
    }, displayValue: canonicalValue };
  }

  if (fact.factId === 'liability_monthly_payment') {
    const { stableId, index } = liabilityIndex(profile, fact.value);
    const canonicalValue = money(fact.value, currency);
    return {
      fieldPath: `/liabilities/${index}/monthlyPayment`,
      canonicalValue,
      displayValue: canonicalValue,
      proposalValue: { entityId: stableId, ...canonicalValue }
    };
  }

  const debtScalarFacts = ['mortgage_current_balance', 'mortgage_annual_interest_rate', 'mortgage_remaining_term_months', 'loan_current_balance', 'loan_annual_interest_rate', 'loan_remaining_term_months'];
  if (debtScalarFacts.includes(fact.factId)) {
    const debtType = fact.factId.startsWith('loan_') ? 'loan' : 'mortgage';
    const { stableId, index, existing } = selectedDebtIndex(profile, fact.value, debtType);
    const key = fact.factId.endsWith('_current_balance') ? 'currentBalance'
      : fact.factId.endsWith('_annual_interest_rate') ? 'annualInterestRate' : 'remainingTermMonths';
    const canonicalValue = fact.factId.endsWith('_current_balance')
      ? money(fact.value, currency)
      : fact.factId.endsWith('_annual_interest_rate')
        ? percentageRate(
          scalarValue(fact.value, [key, 'rate']),
          { decimal: plainObject(fact.value) && fact.value.rateUnit === 'decimal' }
        )
        : optionalRemainingTermMonths(fact.value, { required: true });
    const proposalValue = fact.factId.endsWith('_current_balance')
      ? { entityId: stableId, ...canonicalValue }
      : {
        entityId: stableId,
        value: canonicalValue,
        ...(fact.factId.endsWith('_annual_interest_rate') ? { rateUnit: 'decimal' } : {})
      };
    if (existing) {
      return {
        fieldPath: `/liabilities/${index}/${key}`,
        canonicalValue,
        displayValue: canonicalValue,
        proposalValue
      };
    }
    const mortgage = { ...(existing || { liabilityId: stableId, ownerIds: [primaryOwnerId], type: debtType, label: debtType === 'loan' ? 'Loan' : 'Mortgage' }), [key]: canonicalValue };
    return {
      fieldPath: `/liabilities/${index}`,
      canonicalValue: mortgage,
      displayValue: canonicalValue,
      proposalValue
    };
  }

  if (fact.factId === 'dependant_current_age') {
    const selectedId = selectedEntityId(fact.value, 'dependant', profile.dependants, 'dependantId');
    const stableId = selectedId || 'dependant_realtime_primary';
    const index = stableCollectionIndex(profile.dependants, (dependant) => dependant.dependantId === stableId);
    if (!selectedId && index === profile.dependants.length && profile.dependants.length > 0) {
      throw new ConsumerError(409, 'realtime_dependant_review_required', 'Existing dependant details require visual review before using an aggregate spoken age.');
    }
    const canonicalAge = boundedNumber(
      scalarValue(fact.value, ['currentAge', 'age']),
      { min: 0, max: 40, integer: true }
    );
    return {
      fieldPath: `/dependants/${index}`,
      canonicalValue: { ...(profile.dependants[index] || { dependantId: stableId }), currentAge: canonicalAge },
      displayValue: canonicalAge,
      proposalValue: { entityId: stableId, value: canonicalAge }
    };
  }

  if (fact.factId !== 'lending_category') {
    throw new ConsumerError(409, 'realtime_fact_not_supported', 'That semantic fact does not have a writable realtime mapping.');
  }
  const category = typeof fact.value === 'string' ? fact.value.trim().toLowerCase() : '';
  if (!['first_time_buyer', 'fresh_start', 'second_or_subsequent'].includes(category)) {
    throw new ConsumerError(400, 'realtime_lending_category_invalid', 'That lending category requires visual review.');
  }
  const current = profile.assumptions?.values?.housePurchase || {};
  const lendingCategory = category === 'first_time_buyer' ? 'first_time_buyer' : 'second_or_subsequent';
  const schemeBuyerStatus = category === 'first_time_buyer' ? 'first_time_buyer'
    : category === 'fresh_start' ? 'fresh_start' : 'previous_owner';
  return {
    fieldPath: '/assumptions/values/housePurchase',
    canonicalValue: { ...current, lendingCategory, schemeBuyerStatus },
    displayValue: category
  };
}

function metadataFor(profile, fieldPath) {
  const entries = Object.entries(profile?.fieldMetadata || {})
    .filter(([path]) => path === fieldPath || path.startsWith(`${fieldPath}/`))
    .sort(([left], [right]) => left.localeCompare(right));
  return entries[0]?.[1] || null;
}

export function buildConfirmedRealtimeFactSummary(profile) {
  const facts = [];
  const add = (factId, fieldPath, value, entityId = null) => {
    if (value === undefined || value === null) return;
    const metadata = metadataFor(profile, fieldPath);
    facts.push({
      factId, value,
      ...(entityId ? { entityId } : {}),
      certainty: metadata?.certainty || 'unknown',
      status: metadata?.confirmedByUser ? 'confirmed' : 'saved_draft',
      revision: Number(profile.revision || 0)
    });
  };
  const goal = profile.goals?.find((item) => GOAL_TYPES.includes(item.type));
  if (goal) add('primary_goal', `/goals/${profile.goals.indexOf(goal)}`, goal.type);
  const persona = profile.assumptions?.values?.persona || {};
  const planning = profile.assumptions?.values?.planning || {};
  Object.entries(INTAKE_FACT_PATHS).forEach(([factId, [key]]) => {
    if (factId === 'primary_goal_focus') add(factId, `/assumptions/values/planning/${key}`, planning[key]);
    else add(factId, `/assumptions/values/persona/${key}`, persona[key]);
  });
  if (profile.partner?.personId) {
    add('partner_person', '/partner', {
      personId: profile.partner.personId,
      ...(profile.partner.displayName ? { displayName: profile.partner.displayName } : {}),
      employmentStatus: profile.partner.employmentStatus
    }, profile.partner.personId);
  }
  const homeGoal = profile.goals?.find((item) => item.type === 'buy_home');
  if (homeGoal?.targetAmount) add('target_home_price', `/goals/${profile.goals.indexOf(homeGoal)}/targetAmount`, homeGoal.targetAmount);
  const income = profile.incomeSources?.find((item) => item.incomeId === 'income_realtime_household_gross')
    || (profile.incomeSources?.length === 1 ? profile.incomeSources[0] : null);
  if (income?.grossAnnual) add('gross_household_income', `/incomeSources/${profile.incomeSources.indexOf(income)}`, income.grossAnnual);
  profile.incomeSources?.forEach((item, index) => add(
    'income_sources',
    `/incomeSources/${index}`,
    {
      entityId: item.incomeId,
      ownerId: item.ownerId,
      type: item.type,
      label: item.label,
      ...(item.grossAnnual ? { grossAnnual: item.grossAnnual } : {}),
      ...(item.netAnnual ? { netAnnual: item.netAnnual } : {})
    },
    item.incomeId
  ));
  profile.assets?.forEach((item, index) => add(
    'asset_position',
    `/assets/${index}`,
    item,
    item.assetId
  ));
  profile.properties?.forEach((item, index) => add(
    'property_position',
    `/properties/${index}`,
    item,
    item.propertyId
  ));
  profile.businesses?.forEach((item, index) => add(
    'business_position',
    `/businesses/${index}`,
    item,
    item.businessId
  ));
  profile.liabilities?.forEach((item, index) => {
    add('liability_position', `/liabilities/${index}`, item, item.liabilityId);
    add(
      'liability_monthly_payment',
      `/liabilities/${index}/monthlyPayment`,
      item.monthlyPayment,
      item.liabilityId
    );
  });
  const cash = profile.assets?.find((item) => item.type === 'cash' && item.currentValue);
  if (cash) add('cash_savings', `/assets/${profile.assets.indexOf(cash)}/currentValue`, cash.currentValue);
  add('monthly_spending', '/expenses/monthlyEssential', profile.expenses?.monthlyEssential);
  add('annual_net_spending', '/expenses/annualTotal', profile.expenses?.annualTotal);
  add('current_monthly_rent', '/expenses/currentMonthlyRent', profile.expenses?.currentMonthlyRent);
  add('lending_category', '/assumptions/values/housePurchase/lendingCategory', profile.assumptions?.values?.housePurchase?.lendingCategory);
  [
    ['/primaryPerson', profile.primaryPerson],
    ['/partner', profile.partner]
  ].forEach(([personPath, person]) => {
    if (!person?.personId) return;
    add('person_current_age', `${personPath}/age`, person.age, person.personId);
    add(
      'intended_retirement_age',
      `${personPath}/intendedRetirementAge`,
      person.intendedRetirementAge,
      person.personId
    );
  });
  profile.pensions?.forEach((pension, index) => {
    const pensionPath = `/pensions/${index}`;
    add('pension_positions', pensionPath, {
      entityId: pension.pensionId,
      ownerId: pension.ownerId,
      type: pension.type
    }, pension.pensionId);
    add('pension_current_value', `${pensionPath}/currentValue`, pension.currentValue, pension.pensionId);
    add(
      'pension_employee_contribution_rate',
      `${pensionPath}/employeeContributionRate`,
      pension.employeeContributionRate,
      pension.pensionId
    );
    add(
      'pension_employer_contribution_rate',
      `${pensionPath}/employerContributionRate`,
      pension.employerContributionRate,
      pension.pensionId
    );
  });
  add(
    'target_retirement_income',
    '/assumptions/values/retirement/targetIncomeToday',
    profile.assumptions?.values?.retirement?.targetIncomeToday
  );
  const retirement = profile.assumptions?.values?.retirement || {};
  Object.entries(retirement.statePensionFraction || {}).forEach(([personId, value]) => add(
    'state_pension_fraction',
    `/assumptions/values/retirement/statePensionFraction/${escapeJsonPointerToken(personId)}`,
    value,
    personId
  ));
  Object.entries(retirement.statePensionStartAge || {}).forEach(([personId, value]) => add(
    'state_pension_start_age',
    `/assumptions/values/retirement/statePensionStartAge/${escapeJsonPointerToken(personId)}`,
    value,
    personId
  ));
  const mortgage = profile.liabilities?.find((item) => item.liabilityId === 'liability_realtime_mortgage')
    || (profile.liabilities?.filter((item) => item.type === 'mortgage').length === 1
      ? profile.liabilities.find((item) => item.type === 'mortgage')
      : null);
  if (mortgage) {
    const mortgagePath = `/liabilities/${profile.liabilities.indexOf(mortgage)}`;
    add('mortgage_current_balance', `${mortgagePath}/currentBalance`, mortgage.currentBalance);
    add('mortgage_annual_interest_rate', `${mortgagePath}/annualInterestRate`, mortgage.annualInterestRate);
    add('mortgage_remaining_term_months', `${mortgagePath}/remainingTermMonths`, mortgage.remainingTermMonths);
  }
  const loan = profile.liabilities?.find((item) => item.liabilityId === 'liability_realtime_loan')
    || (profile.liabilities?.filter((item) => item.type === 'loan').length === 1
      ? profile.liabilities.find((item) => item.type === 'loan')
      : null);
  if (loan) {
    const loanPath = `/liabilities/${profile.liabilities.indexOf(loan)}`;
    add('loan_current_balance', `${loanPath}/currentBalance`, loan.currentBalance);
    add('loan_annual_interest_rate', `${loanPath}/annualInterestRate`, loan.annualInterestRate);
    add('loan_remaining_term_months', `${loanPath}/remainingTermMonths`, loan.remainingTermMonths);
  }
  profile.dependants?.forEach((dependant, index) => {
    const dependantPath = `/dependants/${index}`;
    add('dependants', dependantPath, {
      entityId: dependant.dependantId,
      ...(dependant.displayName ? { displayName: dependant.displayName } : {})
    }, dependant.dependantId);
    add('dependant_current_age', `${dependantPath}/currentAge`, dependant.currentAge, dependant.dependantId);
  });
  (profile.assumptions?.values?.collegeFunding?.scenarios || []).forEach((scenario, index) => add(
    'college_cost_scenarios',
    `/assumptions/values/collegeFunding/scenarios/${index}`,
    scenario,
    scenario.id
  ));
  const completionFacts = profile.assumptions?.values?.completionFacts || {};
  Object.entries(completionFacts.specialistAssetReconciliation || {}).forEach(([category, decisions]) => {
    Object.entries(decisions || {}).forEach(([entityId, decision]) => add(
      'specialist_asset_reconciliation',
      `/assumptions/values/completionFacts/specialistAssetReconciliation/${escapeJsonPointerToken(category)}/${escapeJsonPointerToken(entityId)}`,
      { category, entityId, decision },
      entityId
    ));
  });
  const noneFactIds = {
    '/incomeSources': { factId: 'income_sources' },
    '/incomeSources/netAnnual': { factId: 'income_sources', scope: 'net_retirement_income' },
    '/assets': { factId: 'asset_position' },
    '/assets/retirementAvailable': { factId: 'asset_position', scope: 'retirement_available_assets' },
    '/liabilities': { factId: 'liability_position' },
    '/properties': { factId: 'property_position' },
    '/businesses': { factId: 'business_position' },
    '/pensions': { factId: 'pension_positions' },
    '/dependants': { factId: 'dependants' }
  };
  Object.entries(completionFacts.confirmedNonePaths || {}).forEach(([path, confirmed]) => {
    const definition = noneFactIds[path];
    if (confirmed !== true || !definition
      || (!definition.scope && facts.some((fact) => fact.factId === definition.factId))) return;
    facts.push({
      factId: definition.factId,
      value: definition.scope
        ? { operation: 'confirm_none', scope: definition.scope }
        : 'None',
      certainty: 'exact',
      status: 'saved_draft',
      revision: Number(profile.revision || 0)
    });
  });
  Object.entries(completionFacts.unknownFactIds || {}).forEach(([factId, acknowledged]) => {
    if (acknowledged !== true || facts.some((fact) => fact.factId === factId)) return;
    facts.push({
      factId,
      value: 'Unknown',
      certainty: 'unknown',
      status: 'saved_draft',
      revision: Number(profile.revision || 0)
    });
  });
  Object.entries(completionFacts.rangedFactValues || {}).forEach(([factId, range]) => {
    if (!range || facts.some((fact) => fact.factId === factId)) return;
    facts.push({
      factId,
      value: range,
      certainty: 'range',
      status: 'saved_draft',
      revision: Number(profile.revision || 0)
    });
  });
  return facts.slice(0, 48);
}
