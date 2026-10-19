import { HOUSEHOLD_CASH_FLOW_BANNED_PHRASES, HOUSEHOLD_CASH_FLOW_PROVIDER_NAMES } from '../../household_cash_flow_math.js';
import { normalizeHouseholdProfile } from '../profile.js';
import { assertIsoDate, assertJsonCompatible, cloneJson, isPlainObject } from '../utils.js';

const PLAN_PACK_VERSION = 1;
const PLAN_PACK_CONTRACT = Object.freeze({
  version: PLAN_PACK_VERSION,
  fields: ['planPackVersion', 'clientName', 'calculationDate', 'household', 'planningInputs', 'goalFlexibility', 'routes', 'chapters', 'narration'],
  chapters: ['personal_balance_sheet', 'liquidity_analysis', 'household_cash_flow', 'protection_gap', 'mortgage_analysis', 'loan_analysis', 'pension_projection', 'net_retirement_cashflow', 'college_funding', 'future_cost_fund', 'goals_and_resources'],
  planningFields: ['spendingLabel', 'takeHomeBasis', 'spendingBasis', 'householdTaxStatus', 'personalPensionContributions', 'cashAssetId', 'outgoingBindings', 'goalBindings', 'chapterGoals', 'protectionCases', 'leftOverEachYear'],
  goalFields: ['retirementAge', 'targetIncomeToday', 'clearByAge', 'targetDate', 'targetAmount']
});

Object.values(PLAN_PACK_CONTRACT).filter(Array.isArray).forEach(Object.freeze);

export class PlanPackError extends Error {
  constructor(path, message, code = 'invalid_input') {
    super(path + ': ' + message);
    this.name = 'PlanPackError';
    this.path = path;
    this.code = code;
  }
}
export function fail(path, message, code) { throw new PlanPackError(path, message, code); }
export function finiteJson(value, path = '/compiled') {
  if (typeof value === 'number' && !Number.isFinite(value)) fail(path, 'a calculated value is not finite.', 'non_finite_result');
  if (Array.isArray(value)) return value.map((entry, i) => finiteJson(entry, path + '/' + i));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([key, entry]) => [key, finiteJson(entry, path + '/' + key)]));
  return value;
}

export function object(value, path, keys) {
  if (!isPlainObject(value)) fail(path, 'must be an object.');
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail((path === '/' ? '' : path) + '/' + key, 'is not an accepted field.');
  return value;
}
export function number(value, path, { min = 0, integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    fail(path, 'must be a finite ' + (integer ? 'whole number' : 'number') + ' at least ' + min + '.');
  }
  return value;
}
export function text(value, path) {
  if (typeof value !== 'string' || !value.trim()) fail(path, 'must be a non-empty string.');
  return value.trim();
}
function id(value, path) {
  const result = text(value, path);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(result)) fail(path, 'must use lowercase letters, digits, hyphens or underscores, starting with a letter (at most 64 characters).');
  return result;
}
function array(value, path) {
  if (!Array.isArray(value)) fail(path, 'must be an array.');
  return value;
}
function date(value, path) {
  try { return assertIsoDate(value, path); } catch (error) { fail(path, error.message); }
}
function reference(value, ids, path) {
  text(value, path);
  if (!ids.has(value)) fail(path, 'names an unknown entity: ' + value + '.');
  return value;
}
function unique(items, key, path) {
  const seen = new Set();
  items.forEach((item, index) => {
    if (seen.has(item[key])) fail(path + '/' + index + '/' + key, 'must be unique.');
    seen.add(item[key]);
  });
}
function noDiscardedFacts(raw, normalized, path) {
  if (Array.isArray(raw)) {
    raw.forEach((entry, index) => noDiscardedFacts(entry, normalized?.[index], path + '/' + index));
  } else if (isPlainObject(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (!normalized || !Object.hasOwn(normalized, key)) fail(path + '/' + key, 'would be discarded by HouseholdProfile v1. Supply canonical household facts.');
      noDiscardedFacts(value, normalized[key], path + '/' + key);
    }
  }
}
function requireEuroMoney(value, path) {
  if (!value || typeof value !== 'object') return;
  if (Object.hasOwn(value, 'amount') && Object.hasOwn(value, 'currency') && value.currency !== 'EUR') {
    fail(path + '/currency', 'B0 accepts EUR amounts only; no currency conversion or zero-value substitution is allowed.');
  }
  for (const [key, entry] of Object.entries(value)) requireEuroMoney(entry, path + '/' + key);
}
function goalValue(value, key, path) {
  if (key === 'targetDate') return date(value, path);
  return number(value, path, { min: ['retirementAge', 'clearByAge'].includes(key) ? 18 : 0, integer: ['retirementAge', 'clearByAge'].includes(key) });
}
function normalizePlanning(raw, household) {
  const path = '/planningInputs';
  const value = object(raw ?? {}, path, PLAN_PACK_CONTRACT.planningFields);
  const people = new Set([household.primaryPerson.personId, household.partner?.personId].filter(Boolean));
  const goals = new Set(household.goals.map(g => g.goalId));
  const liabilities = new Set(household.liabilities.map(l => l.liabilityId));
  const result = {};
  if (Object.hasOwn(value, 'spendingLabel')) result.spendingLabel = text(value.spendingLabel, path + '/spendingLabel');
  for (const [key, expected] of [['takeHomeBasis', 'after_personal_pension'], ['spendingBasis', 'regular_costs_including_debt_excluding_tax_and_pensions']]) {
    if (Object.hasOwn(value, key)) {
      if (value[key] !== expected) fail(path + '/' + key, 'must be ' + expected + '.');
      result[key] = value[key];
    }
  }
  if (Object.hasOwn(value, 'householdTaxStatus')) {
    if (!['single', 'married_or_civil_partners', 'widowed_or_surviving_civil_partner'].includes(value.householdTaxStatus)) fail(path + '/householdTaxStatus', 'is not a supported tax status.');
    result.householdTaxStatus = value.householdTaxStatus;
  }
  if (Object.hasOwn(value, 'leftOverEachYear')) result.leftOverEachYear = number(value.leftOverEachYear, path + '/leftOverEachYear', { min: -Number.MAX_VALUE });
  if (Object.hasOwn(value, 'cashAssetId')) {
    const asset = household.assets.find(a => a.assetId === value.cashAssetId);
    if (!asset || asset.type !== 'cash') fail(path + '/cashAssetId', 'must identify a household cash asset.');
    result.cashAssetId = value.cashAssetId;
  }
  for (const [field, fields, key] of [
    ['personalPensionContributions', ['personId', 'annualAmount'], 'personId'],
    ['outgoingBindings', ['id', 'liabilityId', 'label'], 'id'],
    ['goalBindings', ['goalId', 'personId', 'liabilityId'], 'goalId']
  ]) {
    result[field] = array(value[field] ?? [], path + '/' + field).map((entry, index) => {
      const here = path + '/' + field + '/' + index;
      object(entry, here, fields);
      const next = {};
      if (field === 'personalPensionContributions') {
        next.personId = reference(entry.personId, people, here + '/personId');
        next.annualAmount = number(entry.annualAmount, here + '/annualAmount');
        const ownerPensions = household.pensions.filter(p => p.ownerId === entry.personId);
        if (ownerPensions.some(p => typeof p.employeeContributionRate === 'number')) fail(here + '/annualAmount', 'duplicates pension contribution rates already recorded in household/pensions.');
      } else if (field === 'outgoingBindings') {
        next.id = id(entry.id, here + '/id');
        if (!/^[a-z0-9_]+$/.test(next.id) || ['tax', 'pensions', 'left_over', 'living'].includes(next.id)) fail(here + '/id', 'must be a cash-flow-safe outgoing id; tax, pensions, left_over and living are reserved.');
        next.liabilityId = reference(entry.liabilityId, liabilities, here + '/liabilityId');
        if (entry.label !== undefined) next.label = text(entry.label, here + '/label');
      } else {
        next.goalId = reference(entry.goalId, goals, here + '/goalId');
        if (entry.personId !== undefined) next.personId = reference(entry.personId, people, here + '/personId');
        if (entry.liabilityId !== undefined) {
          next.liabilityId = reference(entry.liabilityId, liabilities, here + '/liabilityId');
          const goal = household.goals.find(g => g.goalId === entry.goalId);
          const loan = household.liabilities.find(l => l.liabilityId === entry.liabilityId);
          if (!((goal.type === 'optimise_mortgage' && loan.type === 'mortgage') || (goal.type === 'manage_loan' && ['loan', 'credit_card'].includes(loan.type)))) fail(here + '/liabilityId', 'must bind a debt goal to the matching liability type.');
        }
      }
      return next;
    });
    unique(result[field], key, path + '/' + field);
  }
  unique(result.outgoingBindings, 'liabilityId', path + '/outgoingBindings');
  result.chapterGoals = {};
  object(value.chapterGoals ?? {}, path + '/chapterGoals', PLAN_PACK_CONTRACT.chapters);
  for (const [chapter, goalId] of Object.entries(value.chapterGoals ?? {})) result.chapterGoals[chapter] = reference(goalId, goals, path + '/chapterGoals/' + chapter);
  result.protectionCases = array(value.protectionCases ?? [], path + '/protectionCases').map((entry, index) => {
    const here = path + '/protectionCases/' + index;
    object(entry, here, ['id', 'event']);
    const next = { id: id(entry.id, here + '/id') };
    if (next.id === 'today') fail(here + '/id', 'today is the code-owned base case.');
    object(entry.event, here + '/event', ['type', 'personId', 'statePayment', 'survivorsPension', 'neededAfter', 'neededBecause']);
    reference(entry.event.personId, people, here + '/event/personId');
    next.event = cloneJson(entry.event);
    return next;
  });
  unique(result.protectionCases, 'id', path + '/protectionCases');
  if (result.protectionCases.length > 3) fail(path + '/protectionCases', 'at most three event cases are supported beside today.');
  return result;
}

export function normalizePlanPack(raw) {
  try { assertJsonCompatible(raw, 'PlanPack'); } catch (error) { fail('/', error.message); }
  object(raw, '/', PLAN_PACK_CONTRACT.fields);
  if (raw.planPackVersion !== PLAN_PACK_VERSION) fail('/planPackVersion', 'must be exactly 1.');
  const clientName = text(raw.clientName, '/clientName');
  const calculationDate = date(raw.calculationDate, '/calculationDate');
  let household;
  try { household = normalizeHouseholdProfile(raw.household); } catch (error) { fail('/household', error.message); }
  noDiscardedFacts(raw.household, household, '/household');
  requireEuroMoney(household, '/household');
  if (household.assumptions.calculationDateIso !== calculationDate) fail('/household/assumptions/calculationDateIso', 'must match calculationDate.');
  if (household.preferences.baseCurrency !== 'EUR') fail('/household/preferences/baseCurrency', 'B0 supports EUR; no currency conversion is inferred.');
  const chapters = array(raw.chapters, '/chapters').map((chapter, i) => {
    if (!PLAN_PACK_CONTRACT.chapters.includes(chapter)) fail('/chapters/' + i, 'unsupported chapter ' + chapter + '. Property chapters are outside v1.');
    return chapter;
  });
  if (!chapters.length || new Set(chapters).size !== chapters.length) fail('/chapters', 'must name distinct supported chapters, at least one.');
  const planningInputs = normalizePlanning(raw.planningInputs, household);
  if (chapters.includes('household_cash_flow') && planningInputs.leftOverEachYear !== undefined) fail('/planningInputs/leftOverEachYear', 'must not restate a result calculated by the cash-flow chapter.');
  const goals = new Map(household.goals.map(g => [g.goalId, g]));
  object(raw.goalFlexibility ?? {}, '/goalFlexibility', [...goals.keys()]);
  const goalFlexibility = {};
  for (const [goalId, bounds] of Object.entries(raw.goalFlexibility ?? {})) {
    object(bounds, '/goalFlexibility/' + goalId, PLAN_PACK_CONTRACT.goalFields);
    goalFlexibility[goalId] = {};
    for (const [key, range] of Object.entries(bounds)) {
      const path = '/goalFlexibility/' + goalId + '/' + key;
      if (!Array.isArray(range) || range.length !== 2) fail(path, 'must be [minimum, maximum].');
      const [low, high] = range.map((v, i) => goalValue(v, key, path + '/' + i));
      if (low > high) fail(path, 'minimum must not exceed maximum.');
      goalFlexibility[goalId][key] = [low, high];
    }
  }
  const routes = array(raw.routes, '/routes').map((route, index) => {
    const path = '/routes/' + index;
    object(route, path, ['id', 'title', 'changes']);
    const next = { id: id(route.id, path + '/id'), changes: [] };
    if (route.title !== undefined) {
      next.title = text(route.title, path + '/title');
      if ([...HOUSEHOLD_CASH_FLOW_BANNED_PHRASES, ...HOUSEHOLD_CASH_FLOW_PROVIDER_NAMES].some(p => p.test(next.title))) fail(path + '/title', 'use neutral wording without recommendations or provider names.');
    }
    const touched = new Set();
    next.changes = array(route.changes ?? [], path + '/changes').map((change, ci) => {
      const here = path + '/changes/' + ci;
      const fields = change?.type === 'moveGoal'
        ? ['type', 'goalId', ...PLAN_PACK_CONTRACT.goalFields]
        : change?.type === 'useCash' ? ['type', 'goalId', 'amount']
          : ['type', 'outgoingId', 'paidFrom'];
      object(change, here, fields);
      if (!['moveGoal', 'useCash', 'clearOutgoing'].includes(change.type)) fail(here + '/type', 'unsupported route change.');
      const result = cloneJson(change);
      if (change.type === 'clearOutgoing') {
        reference(change.outgoingId, new Set(planningInputs.outgoingBindings.map(b => b.id)), here + '/outgoingId');
        if (change.paidFrom !== 'savings') fail(here + '/paidFrom', 'must be savings.');
      } else {
        reference(change.goalId, new Set(goals.keys()), here + '/goalId');
        if (['completed', 'paused'].includes(goals.get(change.goalId).status)) fail(here + '/goalId', 'cannot change an inactive goal.');
        if (change.type === 'useCash') {
          if (!['whole', 'remaining'].includes(change.amount)) {
            number(change.amount, here + '/amount', { min: 1, integer: true });
          }
        } else {
          const changes = Object.keys(change).filter(k => PLAN_PACK_CONTRACT.goalFields.includes(k));
          if (!changes.length) fail(here, 'moveGoal must change at least one bounded field.');
          for (const field of changes) {
            const retirement = ['retire', 'retire_early', 'improve_pension'].includes(goals.get(change.goalId).type);
            if (['retirementAge', 'targetIncomeToday'].includes(field) && !retirement) fail(here + '/' + field, 'requires a retirement goal.');
            if (field === 'targetAmount' && retirement) fail(here + '/' + field, 'use targetIncomeToday for a retirement goal; it cannot have two target-amount fields.');
            if (field === 'clearByAge' && goals.get(change.goalId).type !== 'optimise_mortgage') fail(here + '/' + field, 'requires a mortgage goal.');
            result[field] = goalValue(change[field], field, here + '/' + field);
            if (field === 'targetDate' && result[field] < calculationDate) fail(here + '/' + field, 'cannot move an active goal into the past.');
            const range = goalFlexibility[change.goalId]?.[field];
            if (!range || result[field] < range[0] || result[field] > range[1]) fail(here + '/' + field, 'is outside the stated goal flexibility.');
          }
        }
      }
      for (const key of Object.keys(result).filter(k => !['type', 'goalId', 'outgoingId', 'paidFrom'].includes(k))) {
        const token = change.type + ':' + (change.goalId ?? change.outgoingId) + ':' + key;
        if (touched.has(token)) fail(here, 'duplicates a conflicting route change.');
        touched.add(token);
      }
      const identity = change.type + ':' + (change.goalId ?? change.outgoingId);
      if (change.type !== 'moveGoal') {
        if (touched.has(identity)) fail(here, 'duplicates a route change.');
        touched.add(identity);
      }
      return result;
    });
    return next;
  });
  if (!routes.length || routes.length > 4) fail('/routes', 'must contain current plus at most three alternatives.');
  unique(routes, 'id', '/routes');
  if (routes[0].id !== 'current' || routes[0].changes.length) fail('/routes/0', 'must be current with no changes.');
  object(raw.narration ?? {}, '/narration', routes.map(r => r.id));
  const narration = {};
  for (const [routeId, template] of Object.entries(raw.narration ?? {})) narration[routeId] = text(template, '/narration/' + routeId);
  return { planPackVersion: 1, clientName, calculationDate, household, planningInputs, goalFlexibility, routes, chapters, narration };
}
