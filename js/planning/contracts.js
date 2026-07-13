/**
 * Runtime constants for the consumer-planning contracts. These values are kept
 * DOM-free so the browser journey and the Worker can share the same policy.
 */

export const HOUSEHOLD_PROFILE_SCHEMA_VERSION = 1;
export const CONSUMER_PLANNING_RULES_VERSION = 'consumer-routing-1.0.0';
export const CONSUMER_CALCULATION_VERSION = 'consumer-calculation-1.0.0';

export const CURRENCY_CODES = Object.freeze(['EUR', 'GBP', 'USD']);
export const PROFILE_SOURCES = Object.freeze(['adviser', 'consumer']);
export const PERSON_ROLES = Object.freeze(['primary', 'partner']);
export const EMPLOYMENT_STATUSES = Object.freeze([
  'employee',
  'self_employed',
  'contractor',
  'retired',
  'other',
  'unknown'
]);

export const GOAL_TYPES = Object.freeze([
  'understand_position',
  'maintain_liquidity',
  'buy_home',
  'build_wealth',
  'improve_pension',
  'retire',
  'retire_early',
  'optimise_mortgage',
  'assess_decision',
  'transfer_wealth',
  'business_planning',
  'agricultural_planning'
]);

export const GOAL_PRIORITIES = Object.freeze(['high', 'medium', 'low']);
export const GOAL_STATUSES = Object.freeze(['exploring', 'active', 'completed', 'paused']);
export const MODULE_AVAILABILITIES = Object.freeze(['active', 'beta', 'adviser_only', 'unsupported']);
export const MODULE_KINDS = Object.freeze(['calculation', 'composition', 'presentation']);
export const MODULE_READINESS_STATUSES = Object.freeze([
  'ready',
  'ready_with_assumptions',
  'missing_information',
  'not_relevant',
  'adviser_review_required',
  'unsupported'
]);

export const PROVENANCE_SOURCES = Object.freeze([
  'user_statement',
  'user_confirmation',
  'adviser_entry',
  'calculated',
  'imported'
]);
export const PROVENANCE_CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
export const VALUE_CERTAINTIES = Object.freeze(['exact', 'approximate', 'range', 'unknown', 'inferred']);

export const PROFILE_PATCH_ROOTS = Object.freeze([
  'primaryPerson',
  'partner',
  'dependants',
  'assets',
  'liabilities',
  'incomeSources',
  'expenses',
  'pensions',
  'properties',
  'businesses',
  'goals',
  'preferences',
  'assumptions'
]);

export const MODULE_IDS = Object.freeze({
  LIQUIDITY: 'liquidity_analysis',
  HOUSE_PURCHASE: 'house_purchase',
  PENSION_PROJECTION: 'pension_projection',
  NET_RETIREMENT: 'net_retirement_cashflow',
  MORTGAGE: 'mortgage_analysis',
  COLLEGE_FUNDING: 'college_funding',
  RETIREMENT_ROUTER: 'retirement_goal_analysis',
  SCENARIO_ANALYSIS: 'scenario_analysis',
  PERSONAL_BALANCE_SHEET: 'personal_balance_sheet',
  CAT: 'cat_analysis',
  BUSINESS_RELIEF: 'business_owner_relief',
  AGRICULTURAL_RELIEF: 'agricultural_relief'
});

