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
    ...(definition.entity ? {
      entity: Object.freeze({
        ...definition.entity,
        ...(Array.isArray(definition.entity.segmentIndexes)
          ? { segmentIndexes: Object.freeze([...definition.entity.segmentIndexes]) }
          : {})
      })
    } : {})
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
        MODULE_IDS.LOAN,
        MODULE_IDS.COLLEGE_FUNDING,
        MODULE_IDS.CAT,
        MODULE_IDS.BUSINESS_OWNER_ANALYSIS,
        MODULE_IDS.BUSINESS_RELIEF_ANALYSIS,
        MODULE_IDS.AGRICULTURAL_RELIEF
      ]
    }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'What brought you here today, and what would you most like help with?',
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
    factId: 'partner_person',
    aliases: ['household.partner_person'],
    valueType: 'entity',
    sensitivity: 'restricted',
    label: 'Partner household person',
    description: 'The separate partner record required before joint income, pension, asset or liability positions are collected.',
    mappings: [{
      pathPattern: '/partner',
      moduleIds: [MODULE_IDS.HOUSE_PURCHASE, MODULE_IDS.PENSION_PROJECTION, MODULE_IDS.PERSONAL_BALANCE_SHEET]
    }],
    entity: { kind: 'root_object', rootSegment: 0, idKey: 'personId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.VISUAL_AND_FINAL,
    questionPrompt: 'Should this plan include your partner as a separate person for joint income, pensions, assets and debts?',
    answerType: 'text',
    materiality: 5,
    ambiguity: 2,
    userEffort: 1
  }),
  defineFact({
    factId: 'income_sources',
    aliases: ['household.income_sources'],
    valueType: 'entity',
    sensitivity: 'restricted',
    label: 'Household income source',
    description: 'One owner-specific gross or net household income source, with stable identity for corrections.',
    mappings: [
      {
        pathPattern: '/incomeSources',
        moduleIds: [MODULE_IDS.HOUSE_PURCHASE, MODULE_IDS.PENSION_PROJECTION, MODULE_IDS.NET_RETIREMENT]
      },
      {
        pathPattern: '/incomeSources/*/grossAnnual',
        moduleIds: [MODULE_IDS.HOUSE_PURCHASE, MODULE_IDS.PENSION_PROJECTION]
      },
      {
        pathPattern: '/incomeSources/*/netAnnual',
        moduleIds: [MODULE_IDS.NET_RETIREMENT]
      }
    ],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'incomeId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.VISUAL_AND_FINAL,
    questionPrompt: 'Please add each person’s income separately, including who receives it and whether the amount is gross or net.',
    answerType: 'text',
    materiality: 5,
    ambiguity: 4,
    userEffort: 3
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
    factId: 'asset_position',
    aliases: ['balance_sheet.asset_position'],
    valueType: 'entity',
    sensitivity: 'restricted',
    label: 'Asset position',
    description: 'One cash, investment or other asset position with stable identity for additions, corrections and removal.',
    mappings: [
      {
        pathPattern: '/assets',
        moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.NET_RETIREMENT]
      },
      {
        pathPattern: '/assets/*/currentValue',
        moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.NET_RETIREMENT]
      }
    ],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'assetId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.VISUAL_AND_FINAL,
    questionPrompt: 'Please add each cash, investment or other asset and its current value, or confirm that there are none.',
    answerType: 'text',
    materiality: 5,
    ambiguity: 4,
    userEffort: 3
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
    factId: 'liability_position',
    aliases: ['balance_sheet.liability_position'],
    valueType: 'entity',
    sensitivity: 'restricted',
    label: 'Liability position',
    description: 'One household debt with stable identity for additions, corrections and removal.',
    mappings: [
      {
        pathPattern: '/liabilities',
        moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.HOUSE_PURCHASE]
      },
      {
        pathPattern: '/liabilities/*/currentBalance',
        moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET]
      }
    ],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'liabilityId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.VISUAL_AND_FINAL,
    questionPrompt: 'Please add each mortgage, loan or other debt and its current balance, or confirm that there are none.',
    answerType: 'text',
    materiality: 5,
    ambiguity: 4,
    userEffort: 3
  }),
  defineFact({
    factId: 'liability_monthly_payment',
    aliases: ['house_purchase.liability_monthly_payment'],
    sensitivity: 'restricted',
    label: 'Monthly debt payment',
    description: 'The reviewed monthly repayment for one household liability, including an explicit zero.',
    mappings: [{
      pathPattern: '/liabilities/*/monthlyPayment',
      moduleIds: [MODULE_IDS.HOUSE_PURCHASE]
    }],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'liabilityId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'What is the monthly payment for this debt? Enter zero if there is no current payment.',
    answerType: 'money',
    materiality: 4,
    ambiguity: 2,
    userEffort: 1
  }),
  defineFact({
    factId: 'property_position',
    aliases: ['balance_sheet.property_position'],
    valueType: 'entity',
    sensitivity: 'restricted',
    label: 'Property position',
    description: 'One property position with stable identity and reviewed ownership and value.',
    mappings: [
      { pathPattern: '/properties', moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET] },
      { pathPattern: '/properties/*/currentValue', moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET] }
    ],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'propertyId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.VISUAL_AND_FINAL,
    questionPrompt: 'Please add each property, its use, ownership and current value.',
    answerType: 'text',
    materiality: 5,
    ambiguity: 4,
    userEffort: 3
  }),
  defineFact({
    factId: 'business_position',
    aliases: ['balance_sheet.business_position'],
    valueType: 'entity',
    sensitivity: 'restricted',
    label: 'Business position',
    description: 'One business or agricultural interest with stable identity, ownership and estimated value.',
    mappings: [
      { pathPattern: '/businesses', moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET] },
      { pathPattern: '/businesses/*/estimatedValue', moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET] }
    ],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'businessId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.VISUAL_AND_FINAL,
    questionPrompt: 'Please add each business or agricultural interest, its ownership and estimated value.',
    answerType: 'text',
    materiality: 5,
    ambiguity: 4,
    userEffort: 3
  }),
  defineFact({
    factId: 'monthly_spending',
    aliases: ['household.monthly_essential_spending'],
    label: 'Essential monthly spending',
    description: 'Essential household spending excluding rent and housing debt.',
    mappings: [
      {
        // The Personal Balance Sheet reads this too: reserves divided by monthly
        // spending is what it reports as months of cover. Without the module
        // named here the path could not resolve back to this fact, so the
        // question was never asked and the figure was never calculable.
        pathPattern: '/expenses/monthlyEssential',
        moduleIds: [
          MODULE_IDS.LIQUIDITY, MODULE_IDS.HOUSE_PURCHASE, MODULE_IDS.PERSONAL_BALANCE_SHEET
        ]
      },
      {
        pathPattern: '/expenses/annualTotal',
        moduleIds: [MODULE_IDS.LIQUIDITY, MODULE_IDS.PERSONAL_BALANCE_SHEET]
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
    mappings: [{
      pathPattern: '/pensions',
      moduleIds: [MODULE_IDS.PENSION_PROJECTION, MODULE_IDS.PERSONAL_BALANCE_SHEET]
    }],
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
    factId: 'state_pension_fraction',
    aliases: ['retirement.state_pension_fraction'],
    label: 'Irish State Pension planning fraction',
    description: 'The fraction of the maximum Irish State Pension (Contributory) used as an editable, per-person planning assumption.',
    mappings: [{
      pathPattern: '/assumptions/values/retirement/statePensionFraction/*',
      moduleIds: [MODULE_IDS.PENSION_PROJECTION]
    }],
    entity: { kind: 'root_object', rootSegment: 0, idKey: 'personId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'For this person, should the illustration use the full Irish State Pension, a percentage of it, or none?',
    answerType: 'number',
    materiality: 4,
    ambiguity: 2,
    userEffort: 1
  }),
  defineFact({
    factId: 'state_pension_start_age',
    aliases: ['retirement.state_pension_start_age'],
    label: 'Irish State Pension start age',
    description: 'The per-person State Pension start age, defaulting to 66 unless an eligible deferral is explicitly specified.',
    mappings: [{
      pathPattern: '/assumptions/values/retirement/statePensionStartAge/*',
      moduleIds: [MODULE_IDS.PENSION_PROJECTION]
    }],
    entity: { kind: 'root_object', rootSegment: 0, idKey: 'personId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'Should this person’s Irish State Pension start at 66, or at a specified eligible deferred age?',
    answerType: 'number',
    materiality: 3,
    ambiguity: 1,
    userEffort: 1
  }),
  defineFact({
    factId: 'pension_current_value',
    aliases: ['pension.current_value'],
    sensitivity: 'restricted',
    label: 'Current pension value',
    description: 'The current value of one pension position.',
    mappings: [{
      pathPattern: '/pensions/*/currentValue',
      moduleIds: [MODULE_IDS.PENSION_PROJECTION, MODULE_IDS.PERSONAL_BALANCE_SHEET]
    }],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'pensionId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'What is the current value of this pension?',
    answerType: 'money',
    materiality: 5,
    ambiguity: 2,
    userEffort: 2
  }),
  defineFact({
    factId: 'pension_contribution_status',
    aliases: ['pension.contribution_status'],
    valueType: 'choice',
    label: 'Pension contribution status',
    description: 'Whether contributions are currently being paid to one pension position.',
    mappings: [{
      pathPattern: '/pensions/*/contributionStatus',
      moduleIds: [MODULE_IDS.PENSION_PROJECTION]
    }],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'pensionId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'Are contributions currently being paid into this pension, or is it paid up?',
    answerType: 'text',
    materiality: 4,
    ambiguity: 3,
    userEffort: 1
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
    factId: 'pension_projected_annual_income',
    aliases: ['pension.projected_annual_income', 'pension.annual_benefit'],
    valueType: 'money',
    sensitivity: 'restricted',
    label: 'Defined-benefit pension income',
    description: 'The gross annual income expected from one defined-benefit pension.',
    mappings: [{
      pathPattern: '/pensions/*/projectedAnnualIncome',
      moduleIds: [MODULE_IDS.PENSION_PROJECTION]
    }],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'pensionId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'What gross annual income is expected from this defined-benefit pension?',
    answerType: 'money',
    materiality: 5,
    ambiguity: 2,
    userEffort: 2
  }),
  defineFact({
    factId: 'pension_benefit_start_age',
    aliases: ['pension.benefit_start_age'],
    label: 'Defined-benefit pension start age',
    description: 'The age at which one defined-benefit pension starts paying.',
    mappings: [{
      pathPattern: '/pensions/*/benefitStartAge',
      moduleIds: [MODULE_IDS.PENSION_PROJECTION]
    }],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'pensionId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'At what age does this defined-benefit pension start paying?',
    answerType: 'number',
    materiality: 5,
    ambiguity: 2,
    userEffort: 1
  }),
  defineFact({
    factId: 'pension_retirement_lump_sum',
    aliases: ['pension.retirement_lump_sum'],
    valueType: 'money',
    sensitivity: 'restricted',
    label: 'Defined-benefit retirement lump sum',
    description: 'The retirement lump sum attached to one defined-benefit pension.',
    mappings: [{
      pathPattern: '/pensions/*/retirementLumpSum',
      moduleIds: [MODULE_IDS.PENSION_PROJECTION]
    }],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'pensionId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'Is there a retirement lump sum attached to this defined-benefit pension, and if so how much?',
    answerType: 'money',
    materiality: 4,
    ambiguity: 2,
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
    factId: 'loan_position',
    aliases: ['loan.position'],
    valueType: 'entity',
    sensitivity: 'restricted',
    label: 'Loan position',
    description: 'The non-housing loan selected for analysis.',
    mappings: [{ pathPattern: '/liabilities', moduleIds: [MODULE_IDS.LOAN] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.EXPLICIT_VALUE_OR_NONE,
    questionPrompt: 'Which non-housing loan would you like to review?',
    answerType: 'text', materiality: 5, ambiguity: 4, userEffort: 2
  }),
  defineFact({
    factId: 'loan_current_balance',
    aliases: ['loan.current_balance'],
    sensitivity: 'restricted',
    label: 'Current loan balance',
    description: 'The current balance of one non-housing loan.',
    mappings: [{ pathPattern: '/liabilities/*/currentBalance', moduleIds: [MODULE_IDS.LOAN] }],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'liabilityId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'What is the current balance of this loan?',
    answerType: 'money', materiality: 5, ambiguity: 1, userEffort: 1
  }),
  defineFact({
    factId: 'loan_annual_interest_rate',
    aliases: ['loan.annual_interest_rate'],
    label: 'Loan interest rate',
    description: 'The annual interest rate of one non-housing loan.',
    mappings: [{ pathPattern: '/liabilities/*/annualInterestRate', moduleIds: [MODULE_IDS.LOAN] }],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'liabilityId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'What annual interest rate applies to this loan?',
    answerType: 'number', materiality: 5, ambiguity: 2, userEffort: 1
  }),
  defineFact({
    factId: 'loan_remaining_term_months',
    aliases: ['loan.remaining_term_months'],
    label: 'Remaining loan term',
    description: 'The remaining term of one non-housing loan in months.',
    mappings: [{ pathPattern: '/liabilities/*/remainingTermMonths', moduleIds: [MODULE_IDS.LOAN] }],
    entity: { kind: 'indexed_collection', indexSegment: 1, idKey: 'liabilityId' },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'How many months remain on this loan?',
    answerType: 'number', materiality: 4, ambiguity: 2, userEffort: 1
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
    valueType: 'entity',
    label: 'College cost scenarios',
    description: 'Explicit annual-cost scenarios used by the college funding engine.',
    mappings: [{
      pathPattern: '/assumptions/values/collegeFunding/scenarios',
      moduleIds: [MODULE_IDS.COLLEGE_FUNDING]
    }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.VISUAL_AND_FINAL,
    questionPrompt: 'Which reviewed annual-cost scenario should be used for college funding?',
    answerType: 'text',
    materiality: 5,
    ambiguity: 5,
    userEffort: 4
  }),
  defineFact({
    factId: 'specialist_asset_reconciliation',
    aliases: ['balance_sheet.specialist_asset_reconciliation'],
    valueType: 'choice',
    sensitivity: 'restricted',
    label: 'Specialist asset reconciliation',
    description: 'A reviewed choice that a property, pension or business record is distinct from, or duplicates, a generic asset position.',
    mappings: [{
      pathPattern: '/assumptions/values/completionFacts/specialistAssetReconciliation/*/*',
      moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET]
    }],
    entity: { kind: 'path_segments', segmentIndexes: [4, 5] },
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.VISUAL_AND_FINAL,
    questionPrompt: 'Is this specialist property, pension or business record a separate position, or does it duplicate an asset already listed?',
    answerType: 'text',
    materiality: 5,
    ambiguity: 5,
    userEffort: 1
  }),
  defineFact({
    factId: 'self_description',
    valueType: 'choice',
    label: 'Current situation',
    description: 'The consumer’s own plain-language description of their present situation; it is a signal, not an authoritative persona assignment.',
    mappings: [{
      pathPattern: '/assumptions/values/persona/selfDescription',
      moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET]
    }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'Which best describes your situation right now—for example first-time buyer, new parent, self-employed, company director, pre-retiree, retired, or something else?',
    answerType: 'text', materiality: 3, ambiguity: 5, userEffort: 1
  }),
  defineFact({
    factId: 'primary_goal_focus', valueType: 'choice', label: 'First planning focus',
    description: 'The consumer-selected first goal when more than two explicit goal modules cannot fit into one three-analysis plan.',
    mappings: [{ pathPattern: '/assumptions/values/persona/primaryGoalType', moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'Which of your goals should this first three-analysis plan address first?',
    answerType: 'text', materiality: 5, ambiguity: 5, userEffort: 1
  }),
  defineFact({
    factId: 'life_stage', valueType: 'choice', label: 'Life stage',
    description: 'A broad life-stage signal used only by deterministic persona routing.',
    mappings: [{ pathPattern: '/assumptions/values/persona/lifeStage', moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'What life or career stage would you say you are at?',
    answerType: 'text', materiality: 3, ambiguity: 4, userEffort: 1
  }),
  defineFact({
    factId: 'household_structure', valueType: 'choice', label: 'Household structure',
    description: 'Whether planning is for one person, a couple, or a wider family context.',
    mappings: [{ pathPattern: '/assumptions/values/persona/householdStructure', moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.HOUSE_PURCHASE, MODULE_IDS.PENSION_PROJECTION, MODULE_IDS.COLLEGE_FUNDING] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'Is this plan for you alone, for you and a partner, or for a wider family?',
    answerType: 'text', materiality: 4, ambiguity: 3, userEffort: 1
  }),
  defineFact({
    factId: 'career_stage', valueType: 'choice', label: 'Career stage',
    description: 'The consumer’s confirmed broad career stage.',
    mappings: [{ pathPattern: '/assumptions/values/persona/careerStage', moduleIds: [MODULE_IDS.PENSION_PROJECTION, MODULE_IDS.RETIREMENT_ROUTER] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'Are you early in your career, established, mid-career, approaching retirement, or retired?',
    answerType: 'text', materiality: 3, ambiguity: 4, userEffort: 1
  }),
  defineFact({
    factId: 'property_status', valueType: 'choice', label: 'Property status',
    description: 'Current property position and whether a purchase is immediate or being delayed.',
    mappings: [{ pathPattern: '/assumptions/values/persona/propertyStatus', moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.HOUSE_PURCHASE, MODULE_IDS.MORTGAGE] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'Do you currently rent, own a home, plan to buy soon, or expect to delay buying?',
    answerType: 'text', materiality: 4, ambiguity: 4, userEffort: 1
  }),
  defineFact({
    factId: 'employment_context', valueType: 'choice', label: 'Employment context',
    description: 'Whether income comes from employment, self-employment, contracting, a company-director role, or retirement.',
    mappings: [{ pathPattern: '/assumptions/values/persona/employmentContext', moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.PENSION_PROJECTION, MODULE_IDS.LIQUIDITY, MODULE_IDS.BUSINESS_OWNER_ANALYSIS] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'Are you employed, self-employed, contracting, a company director or owner-manager, or retired?',
    answerType: 'text', materiality: 4, ambiguity: 4, userEffort: 1
  }),
  defineFact({
    factId: 'retirement_status', valueType: 'choice', label: 'Retirement status',
    description: 'Whether the consumer is working, approaching retirement, newly retired, or later in retirement.',
    mappings: [{ pathPattern: '/assumptions/values/persona/retirementStatus', moduleIds: [MODULE_IDS.RETIREMENT_ROUTER, MODULE_IDS.PENSION_PROJECTION, MODULE_IDS.CAT, MODULE_IDS.LIQUIDITY] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'Are you still working, approaching retirement, newly retired, or later in retirement?',
    answerType: 'text', materiality: 4, ambiguity: 4, userEffort: 1
  }),
  defineFact({
    factId: 'dependant_count', valueType: 'number', label: 'Number of dependants',
    description: 'A bounded count used for family and education-routing context.',
    mappings: [{ pathPattern: '/assumptions/values/persona/dependantCount', moduleIds: [MODULE_IDS.COLLEGE_FUNDING, MODULE_IDS.PERSONAL_BALANCE_SHEET] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'How many children or other dependants should this plan consider?',
    answerType: 'number', materiality: 4, ambiguity: 2, userEffort: 1
  }),
  defineFact({
    factId: 'has_pension', valueType: 'boolean', label: 'Existing pension',
    description: 'Whether at least one pension position exists; detailed pension values remain separate facts.',
    mappings: [{ pathPattern: '/assumptions/values/persona/hasPension', moduleIds: [MODULE_IDS.PENSION_PROJECTION, MODULE_IDS.RETIREMENT_ROUTER] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'Do you currently have a pension or retirement account?',
    answerType: 'boolean', materiality: 3, ambiguity: 1, userEffort: 1
  }),
  defineFact({
    factId: 'finance_combining', valueType: 'boolean', label: 'Combining finances',
    description: 'Whether a couple is bringing finances together for this plan.',
    mappings: [{ pathPattern: '/assumptions/values/persona/financeCombining', moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.HOUSE_PURCHASE] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'Are you and a partner combining finances for this plan?',
    answerType: 'boolean', materiality: 3, ambiguity: 2, userEffort: 1
  }),
  defineFact({
    factId: 'new_parent_status', valueType: 'boolean', label: 'New parent',
    description: 'Whether the household has recently become a parent or is planning around a young family.',
    mappings: [{ pathPattern: '/assumptions/values/persona/newParent', moduleIds: [MODULE_IDS.COLLEGE_FUNDING, MODULE_IDS.PENSION_PROJECTION] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'Have you recently become a parent or are you planning around a young family?',
    answerType: 'boolean', materiality: 3, ambiguity: 2, userEffort: 1
  }),
  defineFact({
    factId: 'retirement_readiness', valueType: 'choice', label: 'Retirement readiness',
    description: 'The consumer’s stated view of whether retirement saving is behind their goal.',
    mappings: [{ pathPattern: '/assumptions/values/persona/retirementReadiness', moduleIds: [MODULE_IDS.RETIREMENT_ROUTER, MODULE_IDS.PENSION_PROJECTION] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'Do you feel broadly on track for retirement, behind, or unsure?',
    answerType: 'text', materiality: 4, ambiguity: 3, userEffort: 1
  }),
  defineFact({
    factId: 'business_context', valueType: 'choice', label: 'Business context',
    description: 'A bounded business role such as self-employed, company director, owner-manager, or business owner.',
    mappings: [{ pathPattern: '/assumptions/values/persona/businessContext', moduleIds: [MODULE_IDS.BUSINESS_OWNER_ANALYSIS, MODULE_IDS.BUSINESS_RELIEF_ANALYSIS, MODULE_IDS.PERSONAL_BALANCE_SHEET] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.VISUAL_AND_FINAL,
    questionPrompt: 'Do you own a business, act as a company director or owner-manager, or have no business interest?',
    answerType: 'text', materiality: 4, ambiguity: 4, userEffort: 1
  }),
  defineFact({
    factId: 'business_exit_intent', valueType: 'boolean', label: 'Business exit intention',
    description: 'Whether an owner is actively approaching a sale, succession, or exit.',
    mappings: [{ pathPattern: '/assumptions/values/persona/businessExit', moduleIds: [MODULE_IDS.BUSINESS_OWNER_ANALYSIS, MODULE_IDS.BUSINESS_RELIEF_ANALYSIS] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.VISUAL_AND_FINAL,
    questionPrompt: 'Are you actively approaching a sale, succession, or exit from the business?',
    answerType: 'boolean', materiality: 4, ambiguity: 2, userEffort: 1
  }),
  defineFact({
    factId: 'agricultural_assets', valueType: 'boolean', label: 'Agricultural assets',
    description: 'Whether the household owns or operates a farm or other agricultural assets.',
    mappings: [{ pathPattern: '/assumptions/values/persona/agriculturalAssets', moduleIds: [MODULE_IDS.AGRICULTURAL_RELIEF, MODULE_IDS.BUSINESS_RELIEF_ANALYSIS, MODULE_IDS.PERSONAL_BALANCE_SHEET] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.VISUAL_AND_FINAL,
    questionPrompt: 'Do you own or operate a farm or other agricultural assets?',
    answerType: 'boolean', materiality: 4, ambiguity: 2, userEffort: 1
  }),
  defineFact({
    factId: 'education_funding_intent', valueType: 'boolean', label: 'Education funding goal',
    description: 'Whether education funding is an explicit planning priority.',
    mappings: [{ pathPattern: '/assumptions/values/persona/educationFunding', moduleIds: [MODULE_IDS.COLLEGE_FUNDING] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'Is funding a child’s or dependant’s education an explicit priority?',
    answerType: 'boolean', materiality: 4, ambiguity: 2, userEffort: 1
  }),
  defineFact({
    factId: 'wealth_transfer_intent', valueType: 'boolean', label: 'Wealth transfer intention',
    description: 'Whether gifts, inheritance, or transfer planning is an explicit priority.',
    mappings: [{ pathPattern: '/assumptions/values/persona/wealthTransfer', moduleIds: [MODULE_IDS.CAT, MODULE_IDS.RETIREMENT_ROUTER] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.VISUAL_AND_FINAL,
    questionPrompt: 'Are gifts, inheritance, or transferring wealth an explicit planning priority?',
    answerType: 'boolean', materiality: 4, ambiguity: 2, userEffort: 1
  }),
  defineFact({
    factId: 'high_net_worth_context', valueType: 'boolean', label: 'Complex family wealth context',
    description: 'An explicit consumer signal that family wealth and legacy planning are material; no threshold is inferred.',
    mappings: [{ pathPattern: '/assumptions/values/persona/highNetWorth', moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.RETIREMENT_ROUTER, MODULE_IDS.CAT] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.VISUAL_AND_FINAL,
    questionPrompt: 'Would you describe family wealth and legacy planning as a material part of this plan?',
    answerType: 'boolean', materiality: 4, ambiguity: 3, userEffort: 1
  }),
  defineFact({
    factId: 'lump_sum_status', valueType: 'boolean', label: 'Lump-sum event',
    description: 'Whether a recent or expected lump sum is driving the planning request.',
    mappings: [{ pathPattern: '/assumptions/values/persona/lumpSumRecipient', moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.RETIREMENT_ROUTER, MODULE_IDS.LIQUIDITY] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.READ_BACK,
    questionPrompt: 'Is a recent or expected lump sum driving this planning request?',
    answerType: 'boolean', materiality: 4, ambiguity: 2, userEffort: 1
  }),
  defineFact({
    factId: 'immediate_decision_context', valueType: 'boolean', label: 'Immediate decision',
    description: 'Whether the consumer has a time-sensitive financial decision to assess.',
    mappings: [{ pathPattern: '/assumptions/values/persona/immediateDecision', moduleIds: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.LIQUIDITY] }],
    confirmationPolicy: FACT_CONFIRMATION_POLICIES.FINAL_REVIEW,
    questionPrompt: 'Is there a particular financial decision you need to address first?',
    answerType: 'boolean', materiality: 4, ambiguity: 3, userEffort: 1
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

/**
 * What to call the thing a question is about, in the client's own words.
 *
 * A question scoped to an entity is useless unless it says WHICH. "At what age
 * does this person intend to retire?" and "What percentage of pay is personally
 * contributed to this pension?" are the prompts a household with a partner and
 * three pensions was actually asked, and neither can be answered. Nobody
 * volunteers a partner's retirement age or a second pension's contribution rate
 * unless they are asked for it by name.
 */
function entityLabelFor(pathTokens, profile) {
  const [collection, index] = pathTokens;
  if (collection === 'partner') {
    return String(profile?.partner?.displayName || profile?.partner?.name || '').trim() || 'your partner';
  }
  if (collection === 'primaryPerson') return 'you';
  const record = Array.isArray(profile?.[collection]) && /^\d+$/.test(String(index))
    ? profile[collection][Number(index)]
    : null;
  if (!record) return '';

  // Whose it is, in the second person, because the question is asked of the
  // client: "your partner's", or nothing at all when it is their own.
  const owner = profile?.partner && record.ownerId === profile.partner.personId
    ? String(profile.partner.displayName || profile.partner.name || '').trim()
      ? `your partner ${String(profile.partner.displayName || profile.partner.name).trim()}'s`
      : "your partner's"
    : 'your';

  const label = String(record.label || record.name || '').trim();
  if (label) return `${owner} ${label}`;

  // A stored profile keeps no label for a pension -- only its type -- so the
  // question describes it the way a person would. "your partner's pension" is
  // answerable; "this pension" is not.
  if (collection === 'pensions') {
    return `${owner} ${PENSION_TYPE_WORDS[record.type] || 'pension'}`;
  }
  return '';
}

/** How a client would say each pension type aloud. */
const PENSION_TYPE_WORDS = Object.freeze({
  occupational: 'company pension',
  prsa: 'PRSA',
  personal: 'personal pension',
  defined_benefit: 'defined-benefit pension',
  buyout_bond: 'buyout bond',
  other: 'pension'
});

/**
 * Put the entity's name into a prompt written for a single unnamed one.
 *
 * The fact definitions are written once and reused for every instance, so they
 * say "this person" and "this pension". Substituting here keeps one definition
 * per fact while letting the question name what it is asking about.
 */
// Internal: every caller goes through resolveSemanticFact, which applies it.
function personaliseQuestionPrompt(prompt, label) {
  const text = String(prompt || '');
  if (!label) return text;
  const possessive = label === 'you'
    ? 'your'
    : /(?:'s|’s)$/i.test(label) ? label : `${label}'s`;
  const personalised = text
    .replace(/\bthis person(?:'s|’s)\b/gi, possessive)
    .replace(/\bthis person\b/gi, label)
    .replace(/\bthis (pension|property|loan|mortgage|account|policy|business)\b/gi, `${label}`)
    .replace(/\bthe (pension|property|loan|mortgage|account|policy|business)\b/gi, `${label}`);
  if (label !== 'you') return personalised;
  return personalised
    .replace(/\bdoes you\b/gi, 'do you')
    .replace(/\bhas you\b/gi, 'have you')
    .replace(/\bis you\b/gi, 'are you');
}

function entityIdentity(definition, pathTokens, profile, explicitEntityId) {
  const entity = definition?.entity;
  if (entity?.kind === 'path_segments') {
    const segmentIndexes = Array.isArray(entity.segmentIndexes) ? entity.segmentIndexes : [];
    const segments = segmentIndexes.map((index) => pathTokens[index]);
    if (segments.length > 0 && segments.every((segment) => typeof segment === 'string' && segment)) {
      const entityId = segments
        .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (character) => (
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`
        )))
        .join(':');
      return { entityId, identityStability: 'path_entity_id' };
    }
  }
  if (typeof explicitEntityId === 'string' && explicitEntityId.trim()) {
    return { entityId: explicitEntityId.trim(), identityStability: 'explicit_entity_id' };
  }
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

function ownerIdentity(pathTokens, profile, item, entityId) {
  if (typeof item?.ownerId === 'string' && item.ownerId.trim()) return item.ownerId.trim();
  const [collection, index] = pathTokens;
  if (collection === 'primaryPerson') return profile?.primaryPerson?.personId || entityId || null;
  if (collection === 'partner') return profile?.partner?.personId || entityId || null;
  const record = Array.isArray(profile?.[collection]) && /^\d+$/.test(String(index))
    ? profile[collection][Number(index)]
    : null;
  if (typeof record?.ownerId === 'string' && record.ownerId) return record.ownerId;
  if (Array.isArray(record?.ownerIds) && record.ownerIds.length === 1) return record.ownerIds[0];
  return null;
}

function fallbackAnswerType(path) {
  if (/\/(?:age|currentAge|intendedRetirementAge|remainingTermMonths|annualInterestRate|employeeContributionRate|employerContributionRate)$/.test(path)) {
    return 'number';
  }
  if (/(?:amount|value|income|expense|balance|cash|rent|spending)/i.test(path)) return 'money';
  return 'text';
}

/**
 * THE CANONICAL FIELDS EACH COLLECTION RECORD HOLDS, DERIVED FROM THE MAPPINGS.
 *
 * ONE SOURCE FOR A NAME THAT WAS ABOUT TO HAVE FOUR. That a pension's money
 * lives in `currentValue`, and an income's in `grossAnnual` or `netAnnual`, is
 * already stated here — as the `/pensions/*​/currentValue` and
 * `/incomeSources/*​/grossAnnual` path patterns. It was ALSO hand-written as
 * prose in the live prompt, was about to be hand-written a third time for the
 * reconciler, and is documented a fourth time in the prompt pack for a
 * different layer entirely.
 *
 * Not knowing the name cost three paid probes: a real planner wrote a perfectly
 * shaped income record carrying `amount` because nothing told it the key, and
 * the projector wrote it raw and dropped the field. So the names are read from
 * the registry that defines them, by every surface that needs to state them.
 *
 * @returns {Record<string, string[]>} collection name -> canonical field names
 */
export function canonicalCollectionFields() {
  const byCollection = {};
  for (const definition of SEMANTIC_FACT_CATALOGUE) {
    for (const mapping of definition.mappings || []) {
      const pattern = mapping?.pathPattern;
      // Only `/collection/*/field` says anything about a RECORD's shape. A
      // collection root is the collection itself, and a plain scalar path
      // belongs to the household, not to a member of a collection.
      if (typeof pattern !== 'string' || !pattern.includes('/*/')) continue;
      const [, collection, , ...rest] = pattern.split('/');
      const field = rest.join('.');
      if (!collection || !field) continue;
      byCollection[collection] = byCollection[collection] || [];
      if (!byCollection[collection].includes(field)) byCollection[collection].push(field);
    }
  }
  for (const collection of Object.keys(byCollection)) byCollection[collection].sort();
  return byCollection;
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
  const entityLabel = String(item.entityLabel || '').trim()
    || (identity.entityId ? entityLabelFor(pathTokens, profile) : '');
  const ownerId = ownerIdentity(pathTokens, profile, item, identity.entityId);
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
    questionPrompt: personaliseQuestionPrompt(
      item.prompt || definition?.questionPrompt || item.reason || `Please provide ${fieldPath || 'the missing information'}.`,
      entityLabel
    ),
    entityLabel,
    answerType,
    materiality: definition?.materiality ?? 3,
    ambiguity: definition?.ambiguity ?? 3,
    userEffort: definition?.userEffort ?? 3,
    entityId: identity.entityId,
    ownerId,
    identityStability: identity.identityStability,
    mapped: Boolean(definition)
  };
}


/** Resolve a candidate or need to the exact semantic fact instance it affects. */
export function semanticFactInstanceId(fact, profile) {
  const factId = typeof fact?.factId === 'string' ? fact.factId : '';
  if (!factId) return '';
  const explicit = typeof fact?.factInstanceId === 'string' ? fact.factInstanceId.trim() : '';
  if (explicit === factId || explicit.startsWith(`${factId}:`)) return explicit;
  const value = fact?.value && typeof fact.value === 'object' && !Array.isArray(fact.value)
    ? fact.value
    : {};
  const rawEntityId = value.entityId ?? value.id ?? fact?.entityId;
  if (typeof rawEntityId === 'string' && rawEntityId.trim()) {
    return `${factId}:${rawEntityId.trim()}`;
  }
  const rawOwner = value.ownerId ?? value.owner ?? fact?.ownerId;
  const ownerId = rawOwner === 'primary'
    ? profile?.primaryPerson?.personId
    : rawOwner === 'partner'
      ? profile?.partner?.personId
      : rawOwner;
  if (typeof ownerId === 'string' && ownerId.trim() && factId === 'pension_positions') {
    return `${factId}:${ownerId.trim()}`;
  }
  return factId;
}

/**
 * Read instance-scoped completion state, with legacy singleton compatibility.
 *
 * A legacy marker keyed only by `factId` is safe for singleton facts. It is
 * deliberately ignored for an entity-scoped need: an old generic pension-rate
 * marker cannot suppress every pension in a household.
 */
export function completionResponseFor(profile, itemOrFact, { moduleId = null } = {}) {
  const completionFacts = profile?.assumptions?.values?.completionFacts || {};
  const resolved = itemOrFact?.fieldPath
    ? resolveSemanticFact(itemOrFact, { profile, moduleId })
    : null;
  const factId = resolved?.factId || itemOrFact?.factId || '';
  const factInstanceId = resolved?.factInstanceId
    || semanticFactInstanceId(itemOrFact, profile)
    || factId;
  const response = completionFacts.responsesByFactInstance?.[factInstanceId];
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    return { ...response, factId, factInstanceId, source: 'fact_instance' };
  }
  if (!factId || factInstanceId !== factId) return null;
  if (completionFacts.estimateDeclinedFactIds?.[factId] === true) {
    return {
      resolution: 'estimate_declined', attempts: 2, factId, factInstanceId, source: 'legacy'
    };
  }
  if (completionFacts.unknownFactIds?.[factId] === true) {
    return { resolution: 'unknown', attempts: 1, factId, factInstanceId, source: 'legacy' };
  }
  if (completionFacts.rangedFactValues?.[factId]) {
    return {
      resolution: 'answered_range',
      attempts: 1,
      range: completionFacts.rangedFactValues[factId],
      factId,
      factInstanceId,
      source: 'legacy'
    };
  }
  return null;
}
