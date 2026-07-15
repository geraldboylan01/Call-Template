import { ConsumerError } from './errors.js';
import { GOAL_TYPES, MODULE_IDS } from '../../../js/planning/contracts.js';
import { getSemanticFactDefinition } from '../../../js/planning/semantic_facts.js';

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

const FACT_MODULES = Object.freeze({
  primary_goal: [],
  target_home_price: [MODULE_IDS.HOUSE_PURCHASE],
  gross_household_income: [MODULE_IDS.HOUSE_PURCHASE, MODULE_IDS.PENSION_PROJECTION],
  cash_savings: [MODULE_IDS.HOUSE_PURCHASE, MODULE_IDS.LIQUIDITY, MODULE_IDS.PERSONAL_BALANCE_SHEET],
  monthly_spending: [MODULE_IDS.HOUSE_PURCHASE, MODULE_IDS.LIQUIDITY],
  annual_net_spending: [MODULE_IDS.NET_RETIREMENT],
  current_monthly_rent: [MODULE_IDS.HOUSE_PURCHASE],
  lending_category: [MODULE_IDS.HOUSE_PURCHASE],
  person_current_age: [MODULE_IDS.PENSION_PROJECTION, MODULE_IDS.NET_RETIREMENT],
  intended_retirement_age: [MODULE_IDS.PENSION_PROJECTION, MODULE_IDS.NET_RETIREMENT],
  pension_current_value: [MODULE_IDS.PENSION_PROJECTION],
  pension_employee_contribution_rate: [MODULE_IDS.PENSION_PROJECTION],
  pension_employer_contribution_rate: [MODULE_IDS.PENSION_PROJECTION],
  target_retirement_income: [MODULE_IDS.PENSION_PROJECTION, MODULE_IDS.NET_RETIREMENT],
  mortgage_current_balance: [MODULE_IDS.MORTGAGE],
  mortgage_annual_interest_rate: [MODULE_IDS.MORTGAGE],
  mortgage_remaining_term_months: [MODULE_IDS.MORTGAGE],
  dependant_current_age: [MODULE_IDS.COLLEGE_FUNDING],
  ...Object.fromEntries(Object.keys(INTAKE_FACT_PATHS).map((factId) => [factId, []]))
});

const GOAL_DEFINITIONS = Object.freeze({
  buy_home: { title: 'Buy a home', modules: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.HOUSE_PURCHASE, MODULE_IDS.LIQUIDITY] },
  maintain_liquidity: { title: 'Maintain an emergency cash reserve', modules: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.LIQUIDITY] },
  understand_position: { title: 'Understand my current position', modules: [MODULE_IDS.PERSONAL_BALANCE_SHEET] },
  build_wealth: { title: 'Build long-term wealth', modules: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.PENSION_PROJECTION] },
  improve_pension: { title: 'Improve pension readiness', modules: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.PENSION_PROJECTION] },
  retire: { title: 'Plan for retirement', modules: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.RETIREMENT_ROUTER, MODULE_IDS.PENSION_PROJECTION] },
  retire_early: { title: 'Explore early retirement', modules: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.RETIREMENT_ROUTER, MODULE_IDS.PENSION_PROJECTION] },
  optimise_mortgage: { title: 'Review the mortgage path', modules: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.MORTGAGE, MODULE_IDS.LIQUIDITY] },
  assess_decision: { title: 'Assess a financial decision', modules: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.COLLEGE_FUNDING] },
  transfer_wealth: { title: 'Plan a wealth transfer', modules: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.CAT, MODULE_IDS.RETIREMENT_ROUTER] },
  business_planning: { title: 'Plan around a business interest', modules: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.BUSINESS_OWNER_ANALYSIS, MODULE_IDS.BUSINESS_RELIEF_ANALYSIS] },
  agricultural_planning: { title: 'Plan around agricultural assets', modules: [MODULE_IDS.PERSONAL_BALANCE_SHEET, MODULE_IDS.AGRICULTURAL_RELIEF, MODULE_IDS.BUSINESS_RELIEF_ANALYSIS] }
});

export const REALTIME_CANARY_FACT_IDS = Object.freeze(Object.keys(FACT_MODULES));

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

function percentageRate(value) {
  const supplied = typeof value === 'number' ? value : Number(value);
  const normalized = supplied > 1 && supplied <= 100 ? supplied / 100 : supplied;
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

export function modulesEnabledByFacts(recommendations, facts = []) {
  const modules = new Set(
    (recommendations || [])
      .map((item) => item?.moduleId)
      .filter((moduleId) => typeof moduleId === 'string')
  );
  const primary = facts.find((fact) => fact?.factId === 'primary_goal');
  if (primary) {
    const type = goalType(primary.value);
    GOAL_DEFINITIONS[type].modules.forEach((moduleId) => modules.add(moduleId));
  }
  return modules;
}

export function realtimeFactAllowed(factId, enabledModules) {
  if (factId === 'primary_goal' || Object.hasOwn(INTAKE_FACT_PATHS, factId)) return true;
  const required = FACT_MODULES[factId];
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
    if (['pension_employee_contribution_rate', 'pension_employer_contribution_rate', 'mortgage_annual_interest_rate'].includes(factId)) {
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
export function buildRealtimeFactReadBack(factId, value, certainty = 'exact', currency = 'EUR') {
  const definition = getSemanticFactDefinition(factId);
  const label = definition?.label || humanise(factId) || 'Planning detail';
  if (certainty === 'unknown') {
    return `You do not know ${label.toLowerCase()} yet. Is that right?`;
  }
  const formatted = formattedFactValue(factId, value, currency);
  const qualifier = certainty === 'approximate' ? 'approximately ' : '';
  return `You said ${label.toLowerCase()} is ${qualifier}${formatted}. Is that right?`;
}

function mapPersonaFact(profile, fact) {
  const [key, kind] = INTAKE_FACT_PATHS[fact.factId];
  const canonicalValue = kind === 'boolean'
    ? strictBoolean(fact.value)
    : kind === 'count'
      ? boundedNumber(fact.value, { min: 0, max: 30, integer: true })
      : normalizedChoice(fact.factId, fact.value);
  return {
    fieldPath: `/assumptions/values/persona/${key}`,
    canonicalValue,
    displayValue: canonicalValue
  };
}

function pensionIndex(profile) {
  const stableId = 'pension_realtime_primary';
  const index = stableCollectionIndex(profile.pensions, (pension) => pension.pensionId === stableId);
  if (index === profile.pensions.length && profile.pensions.length > 0) {
    throw new ConsumerError(409, 'realtime_pension_review_required', 'Existing pension positions require visual review before using an aggregate spoken value.');
  }
  return { stableId, index, existing: profile.pensions[index] };
}

function mortgageIndex(profile) {
  const stableId = 'liability_realtime_mortgage';
  const existingIndex = profile.liabilities.findIndex((liability) => liability.liabilityId === stableId);
  const index = existingIndex >= 0
    ? existingIndex
    : profile.liabilities.findIndex((liability) => liability.type === 'mortgage');
  if (index < 0 && profile.liabilities.length > 0) {
    throw new ConsumerError(409, 'realtime_mortgage_review_required', 'Existing liabilities require visual review before adding a spoken mortgage aggregate.');
  }
  return { stableId, index: index < 0 ? profile.liabilities.length : index, existing: index < 0 ? null : profile.liabilities[index] };
}

export function mapRealtimeFact(profile, fact) {
  if (!REALTIME_CANARY_FACT_IDS.includes(fact.factId)) {
    throw new ConsumerError(409, 'realtime_fact_not_supported', 'That fact is not available in the realtime canary.');
  }
  if (Object.hasOwn(INTAKE_FACT_PATHS, fact.factId)) return mapPersonaFact(profile, fact);
  const currency = profile?.preferences?.baseCurrency || 'EUR';
  const primaryOwnerId = profile?.primaryPerson?.personId;
  if (!primaryOwnerId) throw new ConsumerError(409, 'realtime_profile_invalid', 'The household profile is not ready for this fact.');

  if (fact.factId === 'primary_goal') {
    const type = goalType(fact.value);
    const index = stableCollectionIndex(profile.goals, (goal) => goal.type === type);
    const existing = profile.goals[index];
    return {
      fieldPath: `/goals/${index}`,
      canonicalValue: existing || {
        goalId: `goal_realtime_${type}`,
        type,
        title: GOAL_DEFINITIONS[type].title,
        priority: 'high',
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
    const canonicalValue = boundedNumber(fact.value, { min: fact.factId === 'person_current_age' ? 16 : 18, max: 100, integer: true });
    return { fieldPath: `/primaryPerson/${key}`, canonicalValue, displayValue: canonicalValue };
  }

  if (['pension_current_value', 'pension_employee_contribution_rate', 'pension_employer_contribution_rate'].includes(fact.factId)) {
    const { stableId, index, existing } = pensionIndex(profile);
    const key = fact.factId === 'pension_current_value' ? 'currentValue'
      : fact.factId === 'pension_employee_contribution_rate' ? 'employeeContributionRate' : 'employerContributionRate';
    const canonicalValue = fact.factId === 'pension_current_value'
      ? money(fact.value, currency)
      : percentageRate(fact.value);
    if (existing) {
      return { fieldPath: `/pensions/${index}/${key}`, canonicalValue, displayValue: canonicalValue };
    }
    const pension = { ...(existing || { pensionId: stableId, ownerId: primaryOwnerId, type: 'occupational' }), [key]: canonicalValue };
    return { fieldPath: `/pensions/${index}`, canonicalValue: pension, displayValue: canonicalValue };
  }

  if (fact.factId === 'target_retirement_income') {
    const canonicalValue = money(fact.value, currency);
    return { fieldPath: '/assumptions/values/retirement', canonicalValue: {
      ...(profile.assumptions?.values?.retirement || {}), targetIncomeToday: canonicalValue
    }, displayValue: canonicalValue };
  }

  if (['mortgage_current_balance', 'mortgage_annual_interest_rate', 'mortgage_remaining_term_months'].includes(fact.factId)) {
    const { stableId, index, existing } = mortgageIndex(profile);
    const key = fact.factId === 'mortgage_current_balance' ? 'currentBalance'
      : fact.factId === 'mortgage_annual_interest_rate' ? 'annualInterestRate' : 'remainingTermMonths';
    const canonicalValue = fact.factId === 'mortgage_current_balance'
      ? money(fact.value, currency)
      : fact.factId === 'mortgage_annual_interest_rate'
        ? percentageRate(fact.value)
        : boundedNumber(fact.value, { min: 1, max: 1200, integer: true });
    if (existing) {
      return { fieldPath: `/liabilities/${index}/${key}`, canonicalValue, displayValue: canonicalValue };
    }
    const mortgage = { ...(existing || { liabilityId: stableId, ownerIds: [primaryOwnerId], type: 'mortgage', label: 'Mortgage' }), [key]: canonicalValue };
    return { fieldPath: `/liabilities/${index}`, canonicalValue: mortgage, displayValue: canonicalValue };
  }

  if (fact.factId === 'dependant_current_age') {
    const stableId = 'dependant_realtime_primary';
    const index = stableCollectionIndex(profile.dependants, (dependant) => dependant.dependantId === stableId);
    if (index === profile.dependants.length && profile.dependants.length > 0) {
      throw new ConsumerError(409, 'realtime_dependant_review_required', 'Existing dependant details require visual review before using an aggregate spoken age.');
    }
    const canonicalAge = boundedNumber(fact.value, { min: 0, max: 40, integer: true });
    return {
      fieldPath: `/dependants/${index}`,
      canonicalValue: { ...(profile.dependants[index] || { dependantId: stableId }), currentAge: canonicalAge },
      displayValue: canonicalAge
    };
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
  const add = (factId, fieldPath, value) => {
    if (value === undefined || value === null) return;
    const metadata = metadataFor(profile, fieldPath);
    facts.push({
      factId, value,
      certainty: metadata?.certainty || 'unknown',
      status: metadata?.confirmedByUser ? 'confirmed' : 'saved_draft',
      revision: Number(profile.revision || 0)
    });
  };
  const goal = profile.goals?.find((item) => GOAL_TYPES.includes(item.type));
  if (goal) add('primary_goal', `/goals/${profile.goals.indexOf(goal)}`, goal.type);
  const persona = profile.assumptions?.values?.persona || {};
  Object.entries(INTAKE_FACT_PATHS).forEach(([factId, [key]]) => add(factId, `/assumptions/values/persona/${key}`, persona[key]));
  const homeGoal = profile.goals?.find((item) => item.type === 'buy_home');
  if (homeGoal?.targetAmount) add('target_home_price', `/goals/${profile.goals.indexOf(homeGoal)}/targetAmount`, homeGoal.targetAmount);
  const income = profile.incomeSources?.find((item) => item.incomeId === 'income_realtime_household_gross')
    || (profile.incomeSources?.length === 1 ? profile.incomeSources[0] : null);
  if (income?.grossAnnual) add('gross_household_income', `/incomeSources/${profile.incomeSources.indexOf(income)}`, income.grossAnnual);
  const cash = profile.assets?.find((item) => item.type === 'cash' && item.currentValue);
  if (cash) add('cash_savings', `/assets/${profile.assets.indexOf(cash)}/currentValue`, cash.currentValue);
  add('monthly_spending', '/expenses/monthlyEssential', profile.expenses?.monthlyEssential);
  add('annual_net_spending', '/expenses/annualTotal', profile.expenses?.annualTotal);
  add('current_monthly_rent', '/expenses/currentMonthlyRent', profile.expenses?.currentMonthlyRent);
  add('lending_category', '/assumptions/values/housePurchase/lendingCategory', profile.assumptions?.values?.housePurchase?.lendingCategory);
  add('person_current_age', '/primaryPerson/age', profile.primaryPerson?.age);
  add('intended_retirement_age', '/primaryPerson/intendedRetirementAge', profile.primaryPerson?.intendedRetirementAge);
  const pension = profile.pensions?.find((item) => item.pensionId === 'pension_realtime_primary')
    || (profile.pensions?.length === 1 ? profile.pensions[0] : null);
  if (pension) {
    const pensionPath = `/pensions/${profile.pensions.indexOf(pension)}`;
    add('pension_current_value', `${pensionPath}/currentValue`, pension.currentValue);
    add('pension_employee_contribution_rate', `${pensionPath}/employeeContributionRate`, pension.employeeContributionRate);
    add('pension_employer_contribution_rate', `${pensionPath}/employerContributionRate`, pension.employerContributionRate);
  }
  add(
    'target_retirement_income',
    '/assumptions/values/retirement/targetIncomeToday',
    profile.assumptions?.values?.retirement?.targetIncomeToday
  );
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
  const dependant = profile.dependants?.find((item) => item.dependantId === 'dependant_realtime_primary')
    || (profile.dependants?.length === 1 ? profile.dependants[0] : null);
  if (dependant) {
    add(
      'dependant_current_age',
      `/dependants/${profile.dependants.indexOf(dependant)}/currentAge`,
      dependant.currentAge
    );
  }
  const completionFacts = profile.assumptions?.values?.completionFacts || {};
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
