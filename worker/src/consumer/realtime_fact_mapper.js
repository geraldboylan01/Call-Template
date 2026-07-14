import { ConsumerError } from './errors.js';
import { GOAL_TYPES } from '../../../js/planning/contracts.js';

const FACT_MODULES = Object.freeze({
  primary_goal: [],
  target_home_price: ['house_purchase'],
  gross_household_income: ['house_purchase'],
  cash_savings: ['house_purchase', 'liquidity_analysis'],
  monthly_spending: ['house_purchase', 'liquidity_analysis'],
  current_monthly_rent: ['house_purchase'],
  lending_category: ['house_purchase']
});

const GOAL_DEFINITIONS = Object.freeze({
  buy_home: { title: 'Buy a home', modules: ['house_purchase', 'liquidity_analysis'] },
  maintain_liquidity: { title: 'Maintain an emergency cash reserve', modules: ['liquidity_analysis'] },
  understand_position: { title: 'Understand my current position', modules: ['liquidity_analysis'] },
  build_wealth: { title: 'Build long-term wealth', modules: [] },
  improve_pension: { title: 'Improve pension readiness', modules: [] },
  retire: { title: 'Plan for retirement', modules: [] },
  retire_early: { title: 'Explore early retirement', modules: [] },
  optimise_mortgage: { title: 'Review the mortgage path', modules: [] },
  assess_decision: { title: 'Assess a financial decision', modules: [] },
  transfer_wealth: { title: 'Plan a wealth transfer', modules: [] },
  business_planning: { title: 'Plan around a business interest', modules: [] },
  agricultural_planning: { title: 'Plan around agricultural assets', modules: [] }
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
      .filter((moduleId) => ['house_purchase', 'liquidity_analysis'].includes(moduleId))
  );
  const primary = facts.find((fact) => fact?.factId === 'primary_goal');
  if (primary) {
    const type = goalType(primary.value);
    GOAL_DEFINITIONS[type].modules.forEach((moduleId) => modules.add(moduleId));
  }
  return modules;
}

export function realtimeFactAllowed(factId, enabledModules) {
  if (factId === 'primary_goal') return true;
  const required = FACT_MODULES[factId];
  return Boolean(required && required.some((moduleId) => enabledModules.has(moduleId)));
}

export function mapRealtimeFact(profile, fact) {
  if (!REALTIME_CANARY_FACT_IDS.includes(fact.factId)) {
    throw new ConsumerError(409, 'realtime_fact_not_supported', 'That fact is not available in the realtime canary.');
  }
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
      ...(existing || {
        incomeId: stableId,
        ownerId: primaryOwnerId,
        type: 'employment',
        label: 'Household gross income'
      }),
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
      return {
        fieldPath: `/assets/${cashIndex}/currentValue`,
        canonicalValue: canonicalMoney,
        displayValue: canonicalMoney
      };
    }
    return {
      fieldPath: `/assets/${profile.assets.length}`,
      canonicalValue: {
        assetId: stableId,
        ownerIds: [primaryOwnerId],
        type: 'cash',
        label: 'Cash savings',
        currentValue: canonicalMoney,
        liquid: true
      },
      displayValue: canonicalMoney
    };
  }

  if (fact.factId === 'monthly_spending') {
    const canonicalValue = money(fact.value, currency);
    return { fieldPath: '/expenses/monthlyEssential', canonicalValue, displayValue: canonicalValue };
  }

  if (fact.factId === 'current_monthly_rent') {
    const canonicalValue = money(fact.value, currency);
    return { fieldPath: '/expenses/currentMonthlyRent', canonicalValue, displayValue: canonicalValue };
  }

  const category = typeof fact.value === 'string' ? fact.value.trim().toLowerCase() : '';
  if (!['first_time_buyer', 'fresh_start', 'second_or_subsequent'].includes(category)) {
    throw new ConsumerError(400, 'realtime_lending_category_invalid', 'That lending category requires visual review.');
  }
  const current = profile.assumptions?.values?.housePurchase || {};
  const lendingCategory = category === 'first_time_buyer' ? 'first_time_buyer' : 'second_or_subsequent';
  const schemeBuyerStatus = category === 'first_time_buyer'
    ? 'first_time_buyer'
    : category === 'fresh_start'
      ? 'fresh_start'
      : 'previous_owner';
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
      factId,
      value,
      certainty: metadata?.certainty || 'unknown',
      status: metadata?.confirmedByUser ? 'confirmed' : 'saved_draft',
      revision: Number(profile.revision || 0)
    });
  };
  const goal = profile.goals?.find((item) => GOAL_TYPES.includes(item.type));
  if (goal) add('primary_goal', `/goals/${profile.goals.indexOf(goal)}`, goal.type);
  const homeGoal = profile.goals?.find((item) => item.type === 'buy_home');
  if (homeGoal?.targetAmount) add('target_home_price', `/goals/${profile.goals.indexOf(homeGoal)}/targetAmount`, homeGoal.targetAmount);
  const income = profile.incomeSources?.find((item) => item.incomeId === 'income_realtime_household_gross')
    || (profile.incomeSources?.length === 1 ? profile.incomeSources[0] : null);
  if (income?.grossAnnual) add('gross_household_income', `/incomeSources/${profile.incomeSources.indexOf(income)}`, income.grossAnnual);
  const cash = profile.assets?.find((item) => item.type === 'cash' && item.currentValue);
  if (cash) add('cash_savings', `/assets/${profile.assets.indexOf(cash)}/currentValue`, cash.currentValue);
  add('monthly_spending', '/expenses/monthlyEssential', profile.expenses?.monthlyEssential);
  add('current_monthly_rent', '/expenses/currentMonthlyRent', profile.expenses?.currentMonthlyRent);
  add('lending_category', '/assumptions/values/housePurchase/lendingCategory', profile.assumptions?.values?.housePurchase?.lendingCategory);
  return facts.slice(0, REALTIME_CANARY_FACT_IDS.length);
}
