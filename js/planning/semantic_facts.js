import { MODULE_IDS } from './contracts.js';

/**
 * Confirmation is intentionally separate from provenance. A conversational
 * answer remains a draft profile value until the existing profile review is
 * confirmed; these policies describe any extra confirmation a fact needs.
 */
export const FACT_CONFIRMATION_POLICIES = Object.freeze({
  FINAL_REVIEW: 'final_review',
  READ_BACK: 'read_back',
  VISUAL_AND_FINAL: 'visual_and_final',
  // Compatibility names for callers introduced during the foundation work.
  PROFILE_REVIEW: 'final_review',
  EXPLICIT_VALUE_OR_NONE: 'visual_and_final',
  EXPLICIT_CHOICE: 'visual_and_final'
});

export const FACT_VALUE_TYPES = Object.freeze(['money', 'number', 'date', 'choice', 'boolean', 'entity']);
export const FACT_SENSITIVITIES = Object.freeze(['normal', 'material', 'restricted']);

/**
 * @typedef {Object} FactDefinition
 * @property {string} factId Stable semantic identity, independent of profile storage.
 * @property {'money'|'number'|'date'|'choice'|'boolean'|'entity'} valueType
 * @property {string} profilePathTemplate Canonical HouseholdProfile JSON-pointer template.
 * @property {string[]} moduleIds Modules that consume the fact.
 * @property {'normal'|'material'|'restricted'} sensitivity
 * @property {'final_review'|'read_back'|'visual_and_final'} confirmationPolicy
 */

function defineFact(definition) {
  const factId = definition.factId || definition.id;
  const moduleIds = [...new Set(definition.mappings.flatMap((mapping) => mapping.moduleIds || []))];
  const valueType = definition.valueType
    || (definition.answerType === 'money' ? 'money' : definition.answerType === 'number' ? 'number' : 'entity');
  const profilePathTemplate = definition.profilePathTemplate
    || definition.preferredProfilePath
    || definition.mappings[0].pathPattern;
  const sensitivity = definition.sensitivity || (definition.materiality >= 4 ? 'material' : 'normal');
  if (typeof factId !== 'string' || !factId) throw new Error('Semantic facts require a stable factId.');
  if (!FACT_VALUE_TYPES.includes(valueType)) throw new Error(`Invalid valueType for semantic fact ${factId}.`);
  if (typeof profilePathTemplate !== 'string' || !profilePathTemplate.startsWith('/')) {
    throw new Error(`Invalid profilePathTemplate for semantic fact ${factId}.`);
  }
  if (!FACT_SENSITIVITIES.includes(sensitivity)) throw new Error(`Invalid sensitivity for semantic fact ${factId}.`);
  if (![...new Set(Object.values(FACT_CONFIRMATION_POLICIES))].includes(definition.confirmationPolicy)) {
    throw new Error(`Invalid confirmationPolicy for semantic fact ${factId}.`);
  }
  return Object.freeze({
    ...definition,
    factId,
    id: factId,
    valueType,
    profilePathTemplate,
    moduleIds: Object.freeze([...(definition.moduleIds || moduleIds)]),
    sensitivity,
    aliases: Object.freeze([...(definition.aliases || [])]),
    mappings: Object.freeze(definition.mappings.map((mapping) => Object.freeze({
      ...mapping,
      moduleIds: Object.freeze([...(mapping.moduleIds || [])])
    }))),
    ...(definition.entity ? { entity: Object.freeze({ ...definition.entity }) } : {})
  });
}

/**
 * Stable semantic concepts used by question planning. Profile paths are
 * mappings, not identities: a future HouseholdProfile migration can add a new
 * mapping without changing the fact id, persisted question id or audit event.
 *
 * Ranking values use a bounded 1-5 scale. `ambiguity` is the value of resolving
 * ambiguity now (higher means ask sooner), while `userEffort` is the expected
 * burden of supplying a usable answer (lower means ask sooner).
 */
export const SEMANTIC_FACT_CATALOGUE = Object.freeze([
  defineFact({
    factId: 'primary_goal',
    aliases: ['fact.goal.primary', 'goal.primary'],
    valueType: 'entity',
    sensitivity: 'normal',
    label: 'Primary planning goal',
    description: 'The main outcome the household wants the planning journey to address.',
    mappings: [{
      pathPattern: '/goals',
      moduleIds: [
        MODULE_IDS.LIQUIDITY,
        MODULE_IDS.HOUSE_PURCHASE,
        MODULE_IDS.PENSION_PROJECTION,
        MODULE_IDS.NET_RETIREMENT,
        MODULE_IDS.MORTGAGE,
        MODULE_IDS.COLLEGE_FUNDING,
        MODULE_IDS.CAT,
        MODULE_IDS.BUSINESS_RELIEF,
        MODULE_IDS.AGRICULTURAL_RELIEF
      ]
    }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'What would you most like this plan to help you understand?',
    answerType: 'text',
    materiality: 5,
    ambiguity: 5,
    userEffort: 2
  }),
  defineFact({
    factId: 'target_home_price',
    aliases: ['goal.target_purchase_price'],
    label: 'Target property price',
    description: 'The approximate purchase price attached to a home-buying goal.',
    mappings: [{ pathPattern: '/goals/*/targetAmount', moduleIds: [MODULE_IDS.HOUSE_PURCHASE] }],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'goalId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'What approximate property price would you like us to plan around?',
    answerType: 'money',
    materiality: 5,
    ambiguity: 2,
    userEffort: 1
  }),
  defineFact({
    factId: 'gross_household_income',
    aliases: ['household.gross_income_sources'],
    label: 'Gross household income',
    description: 'Gross annual employment or self-employment income for the household.',
    mappings: [{
      pathPattern: '/incomeSources',
      moduleIds: [MODULE_IDS.HOUSE_PURCHASE, MODULE_IDS.PENSION_PROJECTION]
    }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'What is the household\'s gross annual employment or self-employment income?',
    answerType: 'money',
    materiality: 5,
    ambiguity: 4,
    userEffort: 2
  }),
  defineFact({
    factId: 'cash_savings',
    aliases: ['household.cash_available'],
    label: 'Available cash',
    description: 'Cash currently available to the household for resilience and near-term goals.',
    mappings: [{
      pathPattern: '/assets',
      moduleIds: [MODULE_IDS.LIQUIDITY, MODULE_IDS.HOUSE_PURCHASE]
    }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'How much cash savings are currently available to the household?',
    answerType: 'money',
    materiality: 5,
    ambiguity: 3,
    userEffort: 1
  }),
  defineFact({
    factId: 'monthly_spending',
    aliases: ['household.monthly_essential_spending'],
    label: 'Essential monthly spending',
    description: 'Essential household spending excluding rent and housing debt.',
    mappings: [
      {
        pathPattern: '/expenses/monthlyEssential',
        moduleIds: [MODULE_IDS.LIQUIDITY, MODULE_IDS.HOUSE_PURCHASE]
      },
      {
        pathPattern: '/expenses/annualTotal',
        moduleIds: [MODULE_IDS.LIQUIDITY]
      },
      {
        pathPattern: '/expenses',
        moduleIds: [MODULE_IDS.LIQUIDITY, MODULE_IDS.HOUSE_PURCHASE]
      }
    ],
    preferredProfilePath: '/expenses/monthlyEssential',
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'About how much does the household spend each month on essentials, excluding rent and housing debt?',
    answerType: 'money',
    materiality: 5,
    ambiguity: 4,
    userEffort: 2
  }),
  defineFact({
    factId: 'annual_net_spending',
    aliases: ['household.annual_net_spending'],
    label: 'Annual net household spending',
    description: 'Annual after-tax household spending used for retirement cash-flow analysis.',
    mappings: [{ pathPattern: '/expenses/annualTotal', moduleIds: [MODULE_IDS.NET_RETIREMENT] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'What is the household\'s total annual after-tax spending?',
    answerType: 'money',
    materiality: 5,
    ambiguity: 4,
    userEffort: 2
  }),
  defineFact({
    factId: 'current_monthly_rent',
    aliases: ['household.current_monthly_rent'],
    label: 'Current monthly rent',
    description: 'Current monthly rent, including an explicit zero where there is none.',
    mappings: [{ pathPattern: '/expenses/currentMonthlyRent', moduleIds: [MODULE_IDS.HOUSE_PURCHASE] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.EXPLICIT_VALUE_OR_NONE,
    questionPrompt: 'What is the household\'s current monthly rent? Enter zero if there is no rent.',
    answerType: 'money',
    materiality: 3,
    ambiguity: 2,
    userEffort: 1
  }),
  defineFact({
    factId: 'lending_category',
    aliases: ['house_purchase.lending_category'],
    valueType: 'choice',
    label: 'Lending category',
    description: 'The applicant category used by the dated mortgage-lending rules.',
    mappings: [{
      pathPattern: '/assumptions/values/housePurchase/lendingCategory',
      moduleIds: [MODULE_IDS.HOUSE_PURCHASE]
    }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.EXPLICIT_CHOICE,
    questionPrompt: 'Is this a first-time-buyer application, a fresh-start application, or a second/subsequent purchase?',
    answerType: 'text',
    materiality: 5,
    ambiguity: 5,
    userEffort: 1
  }),
  defineFact({
    factId: 'pension_positions',
    aliases: ['pension.positions'],
    valueType: 'entity',
    sensitivity: 'restricted',
    label: 'Pension positions',
    description: 'The household pension positions to include in projection.',
    mappings: [{ pathPattern: '/pensions', moduleIds: [MODULE_IDS.PENSION_PROJECTION] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.EXPLICIT_VALUE_OR_NONE,
    questionPrompt: 'What pension positions should be included in the projection?',
    answerType: 'text',
    materiality: 5,
    ambiguity: 4,
    userEffort: 4
  }),
  defineFact({
    factId: 'person_current_age',
    aliases: ['person.current_age'],
    label: 'Current age',
    description: 'A household person\'s current age for time-based projections.',
    mappings: [
      {
        pathPattern: '/primaryPerson/age',
        moduleIds: [MODULE_IDS.PENSION_PROJECTION, MODULE_IDS.NET_RETIREMENT]
      },
      { pathPattern: '/partner/age', moduleIds: [MODULE_IDS.PENSION_PROJECTION] }
    ],
    entity: { kind: 'root_object', rootSegment: 0, idKey: 'personId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'What is this person\'s current age?',
    answerType: 'number',
    materiality: 4,
    ambiguity: 1,
    userEffort: 1
  }),
  defineFact({
    factId: 'intended_retirement_age',
    aliases: ['person.intended_retirement_age'],
    label: 'Intended retirement age',
    description: 'The age at which a household person intends to retire.',
    mappings: [
      { pathPattern: '/primaryPerson/intendedRetirementAge', moduleIds: [MODULE_IDS.PENSION_PROJECTION] },
      { pathPattern: '/partner/intendedRetirementAge', moduleIds: [MODULE_IDS.PENSION_PROJECTION] }
    ],
    entity: { kind: 'root_object', rootSegment: 0, idKey: 'personId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'At what age does this person intend to retire?',
    answerType: 'number',
    materiality: 5,
    ambiguity: 2,
    userEffort: 1
  }),
  defineFact({
    factId: 'pension_current_value',
    aliases: ['pension.current_value'],
    sensitivity: 'restricted',
    label: 'Current pension value',
    description: 'The current value of one pension position.',
    mappings: [{ pathPattern: '/pensions/*/currentValue', moduleIds: [MODULE_IDS.PENSION_PROJECTION] }],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'pensionId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'What is the current value of this pension?',
    answerType: 'money',
    materiality: 5,
    ambiguity: 2,
    userEffort: 2
  }),
  defineFact({
    factId: 'pension_employee_contribution_rate',
    aliases: ['pension.employee_contribution_rate'],
    label: 'Personal pension contribution rate',
    description: 'The employee or personal contribution rate for one pension position.',
    mappings: [{
      pathPattern: '/pensions/*/employeeContributionRate',
      moduleIds: [MODULE_IDS.PENSION_PROJECTION]
    }],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'pensionId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'What percentage of pay is personally contributed to this pension?',
    answerType: 'number',
    materiality: 4,
    ambiguity: 3,
    userEffort: 2
  }),
  defineFact({
    factId: 'pension_employer_contribution_rate',
    aliases: ['pension.employer_contribution_rate'],
    label: 'Employer pension contribution rate',
    description: 'The employer contribution rate for one pension position, including zero.',
    mappings: [{
      pathPattern: '/pensions/*/employerContributionRate',
      moduleIds: [MODULE_IDS.PENSION_PROJECTION]
    }],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'pensionId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.EXPLICIT_VALUE_OR_NONE,
    questionPrompt: 'What percentage does the employer contribute to this pension? Enter zero if there is none.',
    answerType: 'number',
    materiality: 4,
    ambiguity: 3,
    userEffort: 2
  }),
  defineFact({
    factId: 'target_retirement_income',
    aliases: ['retirement.target_income_today'],
    label: 'Target retirement income',
    description: 'Target annual retirement income expressed in today\'s money.',
    mappings: [{
      pathPattern: '/assumptions/values/retirement/targetIncomeToday',
      moduleIds: [MODULE_IDS.PENSION_PROJECTION]
    }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'What annual retirement income would the household like, in today\'s money?',
    answerType: 'money',
    materiality: 5,
    ambiguity: 4,
    userEffort: 3
  }),
  defineFact({
    factId: 'mortgage_position',
    aliases: ['mortgage.position'],
    valueType: 'entity',
    sensitivity: 'restricted',
    label: 'Mortgage position',
    description: 'The mortgage liability selected for analysis.',
    mappings: [{ pathPattern: '/liabilities', moduleIds: [MODULE_IDS.MORTGAGE] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.EXPLICIT_VALUE_OR_NONE,
    questionPrompt: 'Which current mortgage should be analysed?',
    answerType: 'text',
    materiality: 5,
    ambiguity: 4,
    userEffort: 3
  }),
  defineFact({
    factId: 'mortgage_current_balance',
    aliases: ['mortgage.current_balance'],
    sensitivity: 'restricted',
    label: 'Current mortgage balance',
    description: 'The current balance of one mortgage liability.',
    mappings: [{ pathPattern: '/liabilities/*/currentBalance', moduleIds: [MODULE_IDS.MORTGAGE] }],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'liabilityId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'What is the current balance of this mortgage?',
    answerType: 'money',
    materiality: 5,
    ambiguity: 1,
    userEffort: 1
  }),
  defineFact({
    factId: 'mortgage_annual_interest_rate',
    aliases: ['mortgage.annual_interest_rate'],
    label: 'Mortgage interest rate',
    description: 'The current annual interest rate of one mortgage liability.',
    mappings: [{ pathPattern: '/liabilities/*/annualInterestRate', moduleIds: [MODULE_IDS.MORTGAGE] }],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'liabilityId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'What is the current annual interest rate on this mortgage?',
    answerType: 'number',
    materiality: 5,
    ambiguity: 2,
    userEffort: 1
  }),
  defineFact({
    factId: 'mortgage_remaining_term_months',
    aliases: ['mortgage.remaining_term_months'],
    label: 'Remaining mortgage term',
    description: 'The remaining term of one mortgage liability in months.',
    mappings: [{ pathPattern: '/liabilities/*/remainingTermMonths', moduleIds: [MODULE_IDS.MORTGAGE] }],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'liabilityId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'How many months remain on this mortgage?',
    answerType: 'number',
    materiality: 4,
    ambiguity: 2,
    userEffort: 1
  }),
  defineFact({
    factId: 'dependants',
    aliases: ['dependant.positions'],
    valueType: 'entity',
    label: 'Children or dependants',
    description: 'The children or dependants included in education-funding analysis.',
    mappings: [{ pathPattern: '/dependants', moduleIds: [MODULE_IDS.COLLEGE_FUNDING] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.EXPLICIT_VALUE_OR_NONE,
    questionPrompt: 'Which children or dependants should be included?',
    answerType: 'text',
    materiality: 5,
    ambiguity: 3,
    userEffort: 3
  }),
  defineFact({
    factId: 'dependant_current_age',
    aliases: ['dependant.current_age'],
    label: 'Dependant current age',
    description: 'The current age of one child or dependant for education timing.',
    mappings: [{ pathPattern: '/dependants/*/currentAge', moduleIds: [MODULE_IDS.COLLEGE_FUNDING] }],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'dependantId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'What is this child or dependant\'s current age?',
    answerType: 'number',
    materiality: 4,
    ambiguity: 1,
    userEffort: 1
  }),
  defineFact({
    factId: 'college_cost_scenarios',
    aliases: ['college_funding.cost_scenarios'],
    valueType: 'choice',
    label: 'College cost scenarios',
    description: 'Explicit annual-cost scenarios used by the college funding engine.',
    mappings: [{
      pathPattern: '/assumptions/values/collegeFunding/scenarios',
      moduleIds: [MODULE_IDS.COLLEGE_FUNDING]
    }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.EXPLICIT_CHOICE,
    questionPrompt: 'Which reviewed annual-cost scenario should be used for college funding?',
    answerType: 'text',
    materiality: 5,
    ambiguity: 5,
    userEffort: 4
  })
]);

const FACTS_BY_ID = new Map(SEMANTIC_FACT_CATALOGUE.flatMap((definition) => [
  [definition.factId, definition],
  ...definition.aliases.map((alias) => [alias, definition])
]));
const ENTITY_ROOTS = Object.freeze({
  goals: 'goalId',
  assets: 'assetId',
  liabilities: 'liabilityId',
  incomeSources: 'incomeId',
  pensions: 'pensionId',
  properties: 'propertyId',
  businesses: 'businessId',
  dependants: 'dependantId'
});

function pointerTokens(pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return [];
  return pointer.slice(1).split('/').map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function matchesPattern(pathTokens, pattern) {
  const patternTokens = pointerTokens(pattern);
  return patternTokens.length === pathTokens.length
    && patternTokens.every((token, index) => token === '*' || token === pathTokens[index]);
}

function mappingScore(mapping, pathTokens, moduleIds) {
  if (!matchesPattern(pathTokens, mapping.pathPattern)) return -1;
  const mappingModules = mapping.moduleIds || [];
  const overlap = mappingModules.filter((moduleId) => moduleIds.includes(moduleId)).length;
  if (moduleIds.length > 0 && mappingModules.length > 0 && overlap === 0) return -1;
  const literalSegments = pointerTokens(mapping.pathPattern).filter((token) => token !== '*').length;
  return (overlap * 1000) + (mappingModules.length === 0 ? 0 : 100) + literalSegments;
}

function findMappedFact(pathTokens, moduleIds) {
  let best = null;
  SEMANTIC_FACT_CATALOGUE.forEach((definition) => {
    definition.mappings.forEach((mapping) => {
      const score = mappingScore(mapping, pathTokens, moduleIds);
      if (score < 0) return;
      if (!best || score > best.score) {
        best = { definition, score };
      }
    });
  });
  return best;
}

function fallbackFactId(tokens) {
  const suffix = tokens
    .map((token) => (/^\d+$/.test(token) ? 'item' : token.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()))
    .filter(Boolean)
    .join('.');
  return `profile.${suffix || 'unknown'}`;
}

function entityIdentity(definition, pathTokens, profile, explicitEntityId) {
  if (typeof explicitEntityId === 'string' && explicitEntityId.trim()) {
    return { entityId: explicitEntityId.trim(), identityStability: 'explicit_entity_id' };
  }
  const entity = definition?.entity;
  if (entity?.kind === 'indexed_collection') {
    const indexToken = pathTokens[entity.indexSegment];
    const collection = profile?.[pathTokens[0]];
    const record = /^\d+$/.test(indexToken || '') && Array.isArray(collection)
      ? collection[Number(indexToken)]
      : null;
    if (typeof record?.[entity.idKey] === 'string' && record[entity.idKey]) {
      return { entityId: record[entity.idKey], identityStability: 'profile_entity_id' };
    }
    if (indexToken) return { entityId: `index-${indexToken}`, identityStability: 'path_fallback' };
  }
  if (entity?.kind === 'root_object') {
    const root = pathTokens[entity.rootSegment];
    const record = profile?.[root];
    if (typeof record?.[entity.idKey] === 'string' && record[entity.idKey]) {
      return { entityId: record[entity.idKey], identityStability: 'profile_entity_id' };
    }
    if (root) return { entityId: root, identityStability: 'path_fallback' };
  }

  const rootIdKey = ENTITY_ROOTS[pathTokens[0]];
  if (rootIdKey && /^\d+$/.test(pathTokens[1] || '')) {
    const record = profile?.[pathTokens[0]]?.[Number(pathTokens[1])];
    if (typeof record?.[rootIdKey] === 'string' && record[rootIdKey]) {
      return { entityId: record[rootIdKey], identityStability: 'profile_entity_id' };
    }
    return { entityId: `index-${pathTokens[1]}`, identityStability: 'path_fallback' };
  }
  return { entityId: null, identityStability: 'singleton' };
}

function fallbackAnswerType(path) {
  if (/\/(?:age|currentAge|intendedRetirementAge|remainingTermMonths|annualInterestRate|employeeContributionRate|employerContributionRate)$/.test(path)) {
    return 'number';
  }
  if (/(?:amount|value|income|expense|balance|cash|rent|spending)/i.test(path)) return 'money';
  return 'text';
}

export function getSemanticFactDefinition(factId) {
  return FACTS_BY_ID.get(factId) || null;
}

export function listSemanticFactDefinitions() {
  return [...SEMANTIC_FACT_CATALOGUE];
}

/**
 * Resolve a readiness missing item (or a JSON pointer string) to a stable fact
 * and, where applicable, the stable entity id already present in the profile.
 */
export function resolveSemanticFact(itemOrPath, {
  profile,
  moduleId,
  moduleIds = []
} = {}) {
  const item = typeof itemOrPath === 'string' ? { fieldPath: itemOrPath } : (itemOrPath || {});
  const fieldPath = typeof item.fieldPath === 'string' ? item.fieldPath : '';
  const pathTokens = pointerTokens(fieldPath);
  const relevantModuleIds = [...new Set([
    ...(Array.isArray(moduleIds) ? moduleIds : []),
    ...(typeof moduleId === 'string' ? [moduleId] : []),
    ...(Array.isArray(item.blockingModuleIds) ? item.blockingModuleIds : [])
  ].filter(Boolean))];
  const match = findMappedFact(pathTokens, relevantModuleIds);
  const definition = match?.definition || null;
  const factId = definition?.factId || fallbackFactId(pathTokens);
  const identity = entityIdentity(definition, pathTokens, profile, item.entityId);
  const factInstanceId = identity.entityId ? `${factId}:${identity.entityId}` : factId;
  const answerType = definition?.answerType || fallbackAnswerType(fieldPath);
  return {
    factId,
    factInstanceId,
    fieldPath,
    preferredProfilePath: definition?.preferredProfilePath || fieldPath,
    profilePathTemplate: definition?.profilePathTemplate || fieldPath,
    moduleIds: definition ? [...definition.moduleIds] : relevantModuleIds,
    valueType: definition?.valueType || (answerType === 'text' ? 'entity' : answerType),
    sensitivity: definition?.sensitivity || 'normal',
    confirmationPolicy: definition?.confirmationPolicy || FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: definition?.questionPrompt || item.reason || `Please provide ${fieldPath || 'the missing information'}.`,
    answerType,
    materiality: definition?.materiality ?? 3,
    ambiguity: definition?.ambiguity ?? 3,
    userEffort: definition?.userEffort ?? 3,
    entityId: identity.entityId,
    identityStability: identity.identityStability,
    mapped: Boolean(definition)
  };
}
