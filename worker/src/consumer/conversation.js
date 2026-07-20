import { applyProfilePatch as applyCanonicalProfilePatch } from '../../../js/planning/profile.js';
import { GOAL_TYPES } from '../../../js/planning/contracts.js';
import {
  buildGoalModulePlan,
  getGoalLabel,
  goalPlanRecommendations
} from '../../../js/planning/goal_plan.js';
import {
  buildPersonaModulePlan,
  personaPlanRecommendations
} from '../../../js/planning/persona_catalogue.js';
import { extractRulesOnlyProfilePatch } from '../../../js/planning/rules_only_extraction.js';
import { getSemanticFactDefinition } from '../../../js/planning/semantic_facts.js';
import { extractProfilePatchWithAi, selectAiRequestPolicy } from './ai_provider.js';
import { ConsumerError } from './errors.js';
import { mapRealtimeFact } from './realtime_fact_mapper.js';
import { applyProfilePatch as applyApiProfilePatch, redactSensitiveIdentifiers } from './validators.js';
import {
  countSessionTurns,
  commitTurnExchange,
  finalizeAiAttempt,
  getRollingSummary,
  getSessionRow,
  getTurnByIdempotencyKey,
  recordEvent,
  reserveAiAttempt,
  toConsumerSession
} from './repository.js';
import { buildQuestionPlan, stageFromQuestionPlan } from './question_plan.js';

const GOAL_TITLES = Object.freeze({
  understand_position: 'Understand my current position',
  maintain_liquidity: 'Maintain an emergency cash reserve',
  buy_home: 'Buy a home',
  build_wealth: 'Build long-term wealth',
  improve_pension: 'Improve pension readiness',
  retire: 'Plan for retirement',
  retire_early: 'Explore early retirement',
  optimise_mortgage: 'Review the mortgage path',
  manage_loan: 'Review or repay a non-housing loan',
  fund_education: 'Fund children’s education',
  assess_decision: 'Assess a financial decision',
  transfer_wealth: 'Plan a wealth transfer',
  business_planning: 'Plan around a business interest',
  agricultural_planning: 'Plan around agricultural assets'
});

const GOAL_EVIDENCE = Object.freeze({
  understand_position: /\b(?:understand|overview|position|finances)\b/i,
  maintain_liquidity: /\b(?:liquidity|emergency fund|cash reserve|rainy day)\b/i,
  buy_home: /\b(?:buy|purchase).{0,25}\b(?:home|house|property)\b|\bfirst[- ]time buyer\b/i,
  build_wealth: /\b(?:build|grow|create).{0,25}\b(?:wealth|investments?|portfolio)\b/i,
  improve_pension: /\b(?:pension|prsa)\b/i,
  retire: /\bretir(?:e|ement|ing)\b/i,
  retire_early: /\b(?:early retirement|retire early)\b/i,
  optimise_mortgage: /\b(?:mortgage|home loan)\b/i,
  manage_loan: /\b(?:personal|car|student|business|non[- ]housing) loan\b|\b(?:repay|pay off|review).{0,20}\bloan\b/i,
  fund_education: /\b(?:college|university|education).{0,30}\b(?:fund|funding|fees|costs?|pay)\b|\b(?:fund|funding|pay).{0,30}\b(?:college|university|education)\b/i,
  assess_decision: /\b(?:decision|compare|weigh up|options?)\b/i,
  transfer_wealth: /\b(?:inheritance|gift|transfer wealth|estate)\b/i,
  business_planning: /\b(?:business|company|shareholding)\b/i,
  agricultural_planning: /\b(?:farm|agricultural|farmland)\b/i
});

const SELF_DESCRIPTION_EVIDENCE = Object.freeze({
  student: /\bstudent\b/i,
  graduate: /\b(?:graduate|recently graduated)\b/i,
  first_time_buyer: /\bfirst[- ]time buyer\b/i,
  young_professional: /\byoung professional\b/i,
  combining_finances: /\b(?:combining|joining|merging) (?:our )?finances\b/i,
  new_parent: /\b(?:new parent|new baby|just had (?:a )?(?:baby|child))\b/i,
  established_professional: /\bestablished professional\b/i,
  behind_on_retirement: /\bbehind (?:on|with) (?:my |our )?(?:pension|retirement)\b/i,
  self_employed: /\bself[- ]employed\b/i,
  company_director: /\bcompany director\b/i,
  owner_manager: /\bowner[- ]manager\b/i,
  business_owner: /\bbusiness owner\b/i,
  farmer: /\b(?:farmer|farming)\b/i,
  pre_retiree: /\b(?:pre[- ]retiree|approaching retirement)\b/i,
  newly_retired: /\b(?:newly|recently|just) retired\b/i,
  older_retiree: /\b(?:older retiree|later in retirement)\b/i,
  high_net_worth_family: /\bhigh[- ]net[- ]worth (?:family|household)\b/i,
  funding_education: /\b(?:funding|paying for).{0,20}(?:college|university|education)\b/i,
  transferring_wealth: /\b(?:transferring wealth|gifts? to (?:my |our )?(?:children|family)|inheritance planning)\b/i,
  lump_sum_recipient: /\b(?:received|receiving|expecting).{0,20}\blump sum\b/i,
  immediate_decision: /\b(?:urgent|immediate|time[- ]sensitive).{0,20}\bdecision\b/i
});

// A short, deterministic scan runs after a primary goal is known and before
// module-specific fact finding. Each item is a semantic fact already shared by
// typed and Realtime intake; facts volunteered earlier are skipped.
const PERSONA_SCAN_FACT_IDS = Object.freeze([
  'household_structure',
  'employment_context',
  'property_status',
  'dependant_count',
  'business_context',
  'retirement_status'
]);

const NUMBER_WORDS = Object.freeze({
  no: 0, none: 0, zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10
});

function personaValues(profile) {
  const values = profile?.assumptions?.values?.persona;
  return values && typeof values === 'object' && !Array.isArray(values) ? values : {};
}

function scanFactAlreadyKnown(profile, factId) {
  const data = personaValues(profile);
  const skipped = profile?.assumptions?.values?.completionFacts?.personaScanSkipped || {};
  if (skipped[factId] === true) return true;
  if (factId === 'household_structure') {
    return typeof data.householdStructure === 'string'
      || Boolean(profile.partner)
      || profile.dependants.length > 0;
  }
  if (factId === 'employment_context') {
    return typeof data.employmentContext === 'string'
      || (typeof profile.primaryPerson?.employmentStatus === 'string'
        && profile.primaryPerson.employmentStatus !== 'unknown');
  }
  if (factId === 'property_status') {
    return typeof data.propertyStatus === 'string' || profile.properties.length > 0;
  }
  if (factId === 'dependant_count') {
    return Number.isInteger(data.dependantCount)
      || typeof data.hasDependants === 'boolean'
      || profile.dependants.length > 0;
  }
  if (factId === 'business_context') {
    return typeof data.businessContext === 'string'
      || data.companyDirector === true
      || data.ownerManager === true
      || data.agriculturalAssets === true
      || profile.businesses.length > 0;
  }
  if (factId === 'retirement_status') {
    return typeof data.retirementStatus === 'string'
      || profile.primaryPerson?.employmentStatus === 'retired';
  }
  return false;
}

function nextPersonaScanFact(profile) {
  return PERSONA_SCAN_FACT_IDS.find((factId) => !scanFactAlreadyKnown(profile, factId)) || null;
}

function personaScanQuestion(profile) {
  const factId = nextPersonaScanFact(profile);
  if (!factId) return null;
  const definition = getSemanticFactDefinition(factId);
  const path = definition?.mappings?.[0]?.pathPattern || null;
  if (!definition || !path || path.includes('*')) return null;
  return {
    questionId: `question-persona-scan-${factId}-${profile.revision}`,
    factId,
    factInstanceId: factId,
    factIds: [factId],
    facts: [{ factId, factInstanceId: factId, fieldPath: path }],
    fieldPaths: [path],
    relatedFieldPaths: [path],
    prompt: definition.questionPrompt,
    answerType: definition.answerType,
    confirmationPolicy: definition.confirmationPolicy,
    optional: false
  };
}

function firstMatchingValue(message, choices) {
  for (const [value, pattern] of choices) {
    if (pattern.test(message)) return value;
  }
  return null;
}

function dependantCountFromMessage(message) {
  if (/\b(?:no|without)\s+(?:children|kids|dependants?|people depending on (?:me|us))\b/i.test(message)) return 0;
  const numeric = message.match(/\b(\d{1,2})\s+(?:children|kids|dependants?)\b/i);
  if (numeric) return Number(numeric[1]);
  const word = message.match(/\b(no|none|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:children|kids|dependants?)\b/i);
  return word ? NUMBER_WORDS[word[1].toLowerCase()] : null;
}

function personaScanValuesFromMessage(message) {
  const values = {};
  const dependantCount = dependantCountFromMessage(message);
  if (dependantCount !== null) values.dependant_count = dependantCount;
  values.household_structure = dependantCount > 0
    ? 'family'
    : firstMatchingValue(message, [
        ['parent_or_grandparent', /\b(?:grandparent|grandmother|grandfather)\b/i],
        ['couple', /\b(?:couple|partner|spouse|wife|husband|married|civil partner)\b/i],
        ['single', /\b(?:just me|for me alone|single household|on my own|live alone)\b/i],
        ['family', /\bfamily\b/i]
      ]);
  values.employment_context = firstMatchingValue(message, [
    ['company_director', /\bcompany director\b/i],
    ['owner_manager', /\bowner[- ]manager\b/i],
    ['business_owner', /\bbusiness owner\b/i],
    ['self_employed', /\bself[- ]employed\b/i],
    ['contractor', /\bcontract(?:or|ing)\b/i],
    ['retired', /\bretired\b/i],
    ['employee', /\b(?:employee|employed|salaried)\b/i],
    ['other', /\bother employment\b/i]
  ]);
  values.property_status = firstMatchingValue(message, [
    ['first_time_buyer', /\bfirst[- ]time buyer\b/i],
    ['delaying_purchase', /\b(?:delay|delaying|not ready).{0,20}\b(?:buy|purchase)\b/i],
    ['buying_soon', /\b(?:buy|buying|purchase|purchasing).{0,20}\b(?:soon|now|home|house|property)\b/i],
    ['homeowner', /\b(?:homeowner|home owner|own (?:my|our|a) (?:home|house|property))\b/i],
    ['renter', /\b(?:rent|renter|renting)\b/i],
    ['no_property', /\b(?:no property|do not own property|don't own property)\b/i]
  ]);
  values.business_context = firstMatchingValue(message, [
    ['no_business_interest', /\b(?:no|without) (?:business|company) (?:interest|ownership)|\bdo not own (?:a )?business\b|\bdon't own (?:a )?business\b/i],
    ['farmer', /\b(?:farmer|farming|farm business)\b/i],
    ['company_director', /\bcompany director\b/i],
    ['owner_manager', /\bowner[- ]manager\b/i],
    ['business_owner', /\b(?:business owner|own (?:a|my|our) business)\b/i],
    ['self_employed', /\bself[- ]employed\b/i]
  ]);
  values.retirement_status = firstMatchingValue(message, [
    ['older_retiree', /\b(?:later in retirement|older retiree)\b/i],
    ['newly_retired', /\b(?:newly|recently|just) retired\b/i],
    ['approaching_retirement', /\b(?:approaching|near|close to) retirement\b|\bpre[- ]retiree\b/i],
    ['retired', /\bretired\b/i],
    ['working', /\b(?:still working|working|employee|employed|self[- ]employed|contractor|company director|owner[- ]manager|business owner)\b/i]
  ]);
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null));
}

function personaScanPatch(profile, question, message) {
  if (!PERSONA_SCAN_FACT_IDS.includes(question?.factId)) return null;
  if (/^\s*(?:prefer not to say|rather not say|not sure|unsure|unknown)\s*[.!]?\s*$/i.test(message)) {
    const completionFacts = { ...(profile.assumptions.values.completionFacts || {}) };
    completionFacts.personaScanSkipped = {
      ...(completionFacts.personaScanSkipped || {}),
      [question.factId]: true
    };
    return { '/assumptions/values/completionFacts': completionFacts };
  }
  const values = personaScanValuesFromMessage(message);
  if (!Object.hasOwn(values, question.factId)) return null;
  const patch = {};
  for (const [factId, value] of Object.entries(values)) {
    const mapped = mapRealtimeFact(profile, { factId, value });
    patch[mapped.fieldPath] = mapped.canonicalValue;
  }
  return patch;
}

function candidateGoalPatch(profile, candidates, message) {
  const existing = new Map(profile.goals.map((goal, index) => [goal.type, index]));
  const patch = {};
  let index = profile.goals.length;
  for (const candidate of candidates || []) {
    const goalType = candidate?.goalType || candidate?.type;
    if (!GOAL_TYPES.includes(goalType) || !['high', 'medium'].includes(candidate.confidence)) continue;
    if (!GOAL_EVIDENCE[goalType]?.test(message)) continue;
    const correctionTarget = GOAL_TYPES.includes(candidate.correctionTarget) ? candidate.correctionTarget : null;
    const correctionIndex = correctionTarget !== null ? existing.get(correctionTarget) : undefined;
    if (typeof correctionIndex === 'number' && correctionTarget !== goalType) {
      const existingGoalIndex = existing.get(goalType);
      if (typeof existingGoalIndex === 'number') {
        patch[`/goals/${correctionIndex}`] = { ...profile.goals[correctionIndex], status: 'paused' };
      } else {
        patch[`/goals/${correctionIndex}`] = {
          ...profile.goals[correctionIndex],
          type: goalType,
          title: GOAL_TITLES[goalType],
          priority: candidate.confidence === 'high' ? 'high' : 'medium',
          status: 'exploring'
        };
        existing.delete(correctionTarget);
        existing.set(goalType, correctionIndex);
      }
    } else if (!existing.has(goalType)) {
    patch[`/goals/${index}`] = {
      goalId: `ai-draft-${goalType}-${index + 1}`,
      type: goalType,
      title: GOAL_TITLES[goalType],
      priority: candidate.confidence === 'high' ? 'high' : 'medium',
      status: 'exploring'
    };
      existing.set(goalType, index);
      index += 1;
    }
    if (candidate.priorityHint === 'primary') {
      patch['/assumptions/values/planning'] = {
        ...(profile.assumptions.values.planning || {}),
        primaryGoalType: goalType
      };
    }
  }
  return patch;
}

function parseSimpleAmount(message, currency) {
  const input = String(message || '').trim();
  if (!input || /%/.test(input) || /-\s*[€$£]?\s*\d/.test(input)) return null;

  // The active question supplies the semantic context, so accept one bounded
  // amount inside a natural answer (for example, “€65,000 gross per year”).
  // Multiple figures remain ambiguous and are deliberately left for a clearer
  // follow-up rather than guessing which value belongs to the requested field.
  const matches = Array.from(input.matchAll(/([€$£])?\s*(\d[\d,.]*)(?:\s*(k|m|grand|thousand|million))?/gi));
  if (matches.length !== 1) return null;
  const match = matches[0];
  let normalized = match[2].replace(/,/g, '');
  if (/^\d{1,3}(?:\.\d{3})+$/.test(match[2])) normalized = match[2].replace(/\./g, '');
  const multiplier = ['k', 'grand', 'thousand'].includes(String(match[3] || '').toLowerCase())
    ? 1000
    : ['m', 'million'].includes(String(match[3] || '').toLowerCase()) ? 1_000_000 : 1;
  const parsed = Number(normalized) * multiplier;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000_000_000) return null;
  const symbolCurrency = { '€': 'EUR', '$': 'USD', '£': 'GBP' }[match[1]];
  const namedCurrency = /\b(?:usd|dollars?)\b/i.test(input)
    ? 'USD'
    : /\b(?:gbp|pounds?)\b/i.test(input) ? 'GBP' : /\b(?:eur|euros?)\b/i.test(input) ? 'EUR' : '';
  const monthlyCadence = /\b(?:per|a|each)\s+month\b|\/\s*(?:month|mo)\b|\bmonthly\b|\bp\.?\s*m\.?\b/i.test(input);
  const annualCadence = /\b(?:per|a|each)\s+(?:year|annum)\b|\/\s*(?:year|yr|annum)\b|\bannual(?:ly)?\b|\byearly\b|\bp\.?\s*a\.?\b/i.test(input);
  if (monthlyCadence && annualCadence) return null;
  return {
    amount: parsed,
    currency: symbolCurrency || namedCurrency || currency || 'EUR',
    cadence: monthlyCadence ? 'monthly' : annualCadence ? 'annual' : null
  };
}

function contextMoneyForPath(money, path) {
  if (!money) return null;
  const annualFlow = path === '/incomeSources'
    || /\/(?:annualTotal|grossAnnual|netAnnual|projectedAnnualIncome)$/.test(path);
  const monthlyFlow = path === '/expenses'
    || /\/(?:monthlyEssential|monthlyDiscretionary|currentMonthlyRent|monthlyPayment)$/.test(path);
  if (!annualFlow && !monthlyFlow && money.cadence) return null;
  const factor = annualFlow && money.cadence === 'monthly'
    ? 12
    : monthlyFlow && money.cadence === 'annual' ? 1 / 12 : 1;
  const amount = Math.round(money.amount * factor * 100) / 100;
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000_000) return null;
  return { amount, currency: money.currency };
}

export function extractContextBoundPatch(profile, question, message) {
  if (!question || question.fieldPaths?.length !== 1) return null;
  const scanPatch = personaScanPatch(profile, question, message);
  if (scanPatch) return scanPatch;
  const path = question.fieldPaths[0];
  if (path === '/assumptions/values/persona/selfDescription') {
    const matches = Object.entries(SELF_DESCRIPTION_EVIDENCE)
      .filter(([, pattern]) => pattern.test(message))
      .map(([value]) => value);
    if (matches.length === 1) return { [path]: matches[0] };
  }
  if (path === '/assumptions/values/planning/primaryGoalType') {
    const matches = Object.entries(GOAL_EVIDENCE)
      .filter(([, pattern]) => pattern.test(message))
      .map(([value]) => value);
    const narrowed = matches.includes('retire_early')
      ? matches.filter((value) => value !== 'retire')
      : matches;
    if (narrowed.length === 1) {
      return {
        '/assumptions/values/planning': {
          ...(profile.assumptions.values.planning || {}),
          primaryGoalType: narrowed[0]
        }
      };
    }
  }
  if (path === '/assumptions/values/housePurchase/lendingCategory') {
    const current = { ...(profile.assumptions.values.housePurchase || {}) };
    if (/\bfirst[- ]time(?: buyer)?\b/i.test(message)) {
      return {
        '/assumptions/values/housePurchase': {
          ...current,
          lendingCategory: 'first_time_buyer',
          schemeBuyerStatus: 'first_time_buyer'
        }
      };
    }
    if (/\bfresh[- ]start\b/i.test(message)) {
      return {
        '/assumptions/values/housePurchase': {
          ...current,
          lendingCategory: 'second_or_subsequent',
          schemeBuyerStatus: 'fresh_start'
        }
      };
    }
    if (/\b(?:second|subsequent|previous)(?:[- ]time)?(?: buyer| purchase| owner)?\b|\b(?:owned|bought)\s+(?:a\s+)?(?:home|house|property)\s+before\b|\bnot\s+(?:a\s+)?first[- ]time buyer\b/i.test(message)) {
      return {
        '/assumptions/values/housePurchase': {
          ...current,
          lendingCategory: 'second_or_subsequent',
          schemeBuyerStatus: 'previous_owner'
        }
      };
    }
  }
  const isNone = /^\s*(?:none|no|nothing|zero|not applicable|n\/a)\s*[.!]?\s*$/i.test(message);
  if (isNone && path === '/expenses/currentMonthlyRent') {
    return { [path]: { amount: 0, currency: profile.preferences.baseCurrency } };
  }
  if (isNone && path === '/assets') {
    return {
      [`/assets/${profile.assets.length}`]: {
        assetId: `context-cash-${profile.assets.length + 1}`,
        ownerIds: [profile.primaryPerson.personId],
        type: 'cash',
        label: 'Cash savings (confirmed none)',
        currentValue: { amount: 0, currency: profile.preferences.baseCurrency },
        liquid: true
      }
    };
  }
  const noneSection = path.split('/')[1];
  if (isNone && ['incomeSources', 'expenses', 'liabilities', 'pensions', 'properties', 'businesses', 'dependants'].includes(noneSection)) {
    const completionFacts = { ...(profile.assumptions.values.completionFacts || {}) };
    completionFacts.confirmedNonePaths = {
      ...(completionFacts.confirmedNonePaths || {}),
      [path]: true
    };
    return { '/assumptions/values/completionFacts': completionFacts };
  }

  const money = contextMoneyForPath(
    parseSimpleAmount(message, profile.preferences.baseCurrency),
    path
  );
  if (money) {
    if (/\/(?:targetAmount|currentValue|currentBalance|annualTotal|monthlyEssential|monthlyDiscretionary|currentMonthlyRent|grossAnnual|netAnnual|monthlyPayment|projectedAnnualIncome)$/.test(path)) {
      return { [path]: money };
    }
    if (path === '/assets') {
      return {
        [`/assets/${profile.assets.length}`]: {
          assetId: `context-cash-${profile.assets.length + 1}`,
          ownerIds: [profile.primaryPerson.personId],
          type: 'cash',
          label: 'Cash savings',
          currentValue: money,
          liquid: true
        }
      };
    }
    if (path === '/incomeSources') {
      return {
        [`/incomeSources/${profile.incomeSources.length}`]: {
          incomeId: `context-income-${profile.incomeSources.length + 1}`,
          ownerId: profile.primaryPerson.personId,
          type: 'employment',
          label: 'Employment income',
          grossAnnual: money
        }
      };
    }
    if (path === '/expenses') return { '/expenses/monthlyEssential': money };
  }

  if (question.answerType === 'number' && /^\s*\d+(?:\.\d+)?\s*$/.test(message)) {
    return { [path]: Number(message.trim()) };
  }
  if (question.answerType === 'boolean' && /^\s*(?:yes|no)\s*[.!]?\s*$/i.test(message)) {
    return { [path]: /^\s*yes/i.test(message) };
  }
  return null;
}

function buildRollingSummary(profile, recommendations, stage) {
  const goalTypes = profile.goals.map((goal) => goal.type).join(', ') || 'not yet identified';
  const modules = recommendations.map((item) => item.moduleId).join(', ') || 'none';
  const populatedSections = [
    profile.incomeSources.length ? 'income' : '',
    profile.assets.length ? 'assets' : '',
    profile.liabilities.length ? 'liabilities' : '',
    Object.keys(profile.expenses || {}).length ? 'expenses' : '',
    profile.pensions.length ? 'pensions' : ''
  ].filter(Boolean).join(', ') || 'none';
  return `Stage: ${stage}. Goal types: ${goalTypes}. Populated profile sections: ${populatedSections}. Deterministic module candidates: ${modules}.`;
}

export async function processTurn({ env, config, sessionRow, profile, message, idempotencyKey }) {
  const safeMessage = redactSensitiveIdentifiers(message);
  const existing = await getTurnByIdempotencyKey(env, sessionRow.id, idempotencyKey);
  if (existing) {
    if (existing.payload.userMessage !== safeMessage) {
      throw new ConsumerError(409, 'idempotency_key_conflict', 'This idempotency key was already used for a different message.');
    }
    const { userMessage, ...payload } = existing.payload;
    return {
      ...payload,
      turnId: existing.row.id,
      turns: [
        { id: `${existing.row.id}-user`, role: 'user', text: userMessage },
        { id: `${existing.row.id}-assistant`, role: 'assistant', text: payload.assistantMessage }
      ],
      idempotentReplay: true
    };
  }
  const turnCount = await countSessionTurns(env, sessionRow.id);
  if (turnCount >= config.maxTurnsPerSession) {
    throw new ConsumerError(429, 'turn_limit_reached', 'This planning session has reached its turn limit.');
  }

  const rollingSummary = await getRollingSummary(env, sessionRow);
  let mode = 'rules';
  let metadata = {};
  let extraction = null;
  let nextProfile = profile;
  let aiErrorCode = null;
  let aiAttemptId = null;
  const initialConversationState = describeConversationState(profile, config);
  const activeQuestion = initialConversationState.nextQuestion;
  const contextualPatch = extractContextBoundPatch(profile, activeQuestion, safeMessage);

  if (contextualPatch) {
    nextProfile = applyApiProfilePatch(profile, contextualPatch, [], 'consumer_edit');
    mode = 'rules_context';
    extraction = { goalCandidates: [], ambiguities: [], warnings: [] };
  }

  if (!contextualPatch && config.aiEnabled && Number(sessionRow.consent_ai_processing) === 1) {
    const liveSessionRow = await getSessionRow(env, sessionRow.id);
    if (Number(liveSessionRow?.consent_ai_processing) === 1
      && liveSessionRow?.consent_ai_notice_id === config.aiNoticeId
      && liveSessionRow?.consent_policy_version === config.consentPolicyVersion) {
      const requestPolicy = selectAiRequestPolicy(safeMessage, config);
      const attempt = await reserveAiAttempt(env, sessionRow.id, idempotencyKey, config, requestPolicy);
      if (attempt) {
      try {
        const ai = await extractProfilePatchWithAi({
          env,
          config,
          session: toConsumerSession(liveSessionRow),
          profile,
          message: safeMessage,
          rollingSummary,
          activeQuestion,
          requestPolicy
        });
        metadata = ai.metadata;
        extraction = {
          goalCandidates: ai.goalCandidates,
          ambiguities: ai.ambiguities,
          warnings: []
        };
        const groundedGoals = candidateGoalPatch(profile, ai.goalCandidates, safeMessage);
        const combinedPatch = { ...ai.patch, ...groundedGoals };
        if (Object.keys(combinedPatch).length) {
          nextProfile = applyApiProfilePatch(profile, combinedPatch, [], 'ai_extraction');
          mode = 'ai';
        }
        aiAttemptId = attempt.id;
      } catch (error) {
        if (error?.metadata) metadata = error.metadata;
        aiErrorCode = error instanceof ConsumerError ? error.code : 'ai_output_invalid';
        await finalizeAiAttempt(env, attempt.id, metadata, aiErrorCode).catch((finalizeError) => {
          console.error('Consumer AI failure finalization failed', {
            attemptId: attempt.id,
            error: finalizeError instanceof Error ? finalizeError.message : String(finalizeError)
          });
        });
      }
      } else {
        aiErrorCode = 'ai_budget_exceeded';
      }
    } else {
      aiErrorCode = Number(liveSessionRow?.consent_ai_processing) === 1
        ? 'ai_reconsent_required'
        : 'ai_consent_withdrawn';
    }
  } else if (!contextualPatch && config.aiEnabled && Number(sessionRow.consent_ai_processing) !== 1) {
    aiErrorCode = 'ai_consent_withdrawn';
  }

  if (!contextualPatch && config.aiEnabled && aiErrorCode === null && mode === 'rules' && !extraction) {
    // A reservation can be denied by request or token budgets without exposing
    // internal budget values to the consumer.
    if (Number(sessionRow.consent_ai_processing) === 1) {
      aiErrorCode = 'ai_budget_exceeded';
    }
  }

  if (mode === 'rules') {
    const rules = extractRulesOnlyProfilePatch(safeMessage, {
      profile,
      capturedAt: new Date().toISOString(),
      conversationTurnId: idempotencyKey
    });
    extraction = rules;
    if (rules.patch.operations.length) {
      nextProfile = applyCanonicalProfilePatch(profile, rules.patch).profile;
    }
  }

  const conversationState = describeConversationState(nextProfile, config);
  const recommendations = conversationState.recommendations;
  const stage = conversationState.stage;
  const question = conversationState.nextQuestion;
  // Model prose is never authoritative or returned. The server owns this copy.
  const assistantMessage = question.prompt;
  let committed;
  try {
    committed = await commitTurnExchange(env, {
      sessionRow,
      profile: nextProfile,
      profileChanged: nextProfile.revision !== profile.revision,
      stage,
      idempotencyKey,
      userMessage: safeMessage,
      metadata,
      rollingSummary: buildRollingSummary(nextProfile, recommendations, stage),
      buildPayload: (session, storedProfile) => ({
        session,
        profile: storedProfile,
        assistantMessage,
        nextQuestion: question,
        recommendations,
        selectionPolicyVersion: conversationState.selectionPolicyVersion || null,
        goalAssessment: conversationState.goalAssessment || null,
        moduleSlots: conversationState.moduleSlots || [],
        extraction: {
          mode,
          goalCandidates: extraction?.goalCandidates || [],
          goalCandidateDisposition: 'suggestion_only_deterministic_rules_authoritative',
          ambiguities: extraction?.ambiguities || [],
          warnings: extraction?.warnings || [],
          aiFallbackCode: aiErrorCode
        }
      })
    });
  } catch (error) {
    if (aiAttemptId) {
      await finalizeAiAttempt(env, aiAttemptId, metadata, 'turn_commit_failed').catch(() => {});
    }
    throw error;
  }
  if (aiAttemptId) {
    await finalizeAiAttempt(env, aiAttemptId, metadata).catch((error) => {
      console.error('Consumer AI usage finalization failed', {
        attemptId: aiAttemptId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
  if (committed.duplicate) {
    if (committed.storedPayload.userMessage !== safeMessage) {
      throw new ConsumerError(409, 'idempotency_key_conflict', 'This idempotency key was already used for a different message.');
    }
    const { userMessage, ...payload } = committed.storedPayload;
    return {
      ...payload,
      turnId: committed.turnId,
      turns: [
        { id: `${committed.turnId}-user`, role: 'user', text: userMessage },
        { id: `${committed.turnId}-assistant`, role: 'assistant', text: payload.assistantMessage }
      ],
      idempotentReplay: true
    };
  }
  const payload = committed.responsePayload;
  for (const recommendation of recommendations) {
    await recordEvent(env, sessionRow.id, 'module_recommended', {
      moduleId: recommendation.moduleId,
      priority: recommendation.priority,
      status: recommendation.status
    }).catch(() => {});
  }
  const previousModuleIds = (initialConversationState.moduleSlots || []).map((slot) => slot.moduleId);
  const currentModuleIds = (conversationState.moduleSlots || []).map((slot) => slot.moduleId);
  const planChanged = previousModuleIds.join('|') !== currentModuleIds.join('|');
  await recordEvent(env, sessionRow.id, 'goal_plan_evaluated', {
    selectionPolicyVersion: conversationState.selectionPolicyVersion || null,
    goalTypes: conversationState.goalAssessment?.activeGoalTypes || [],
    deferredGoalTypes: conversationState.goalAssessment?.deferredGoalTypes || [],
    moduleIds: currentModuleIds,
    ruleIds: recommendations.flatMap((item) => item.triggeredRuleIds || []),
    clarificationRequired: conversationState.requiresGoalPriorityQuestion === true
      || conversationState.requiresDecisionTopicQuestion === true,
    planChanged
  }).catch(() => {});
  if (planChanged) {
    await recordEvent(env, sessionRow.id, 'goal_plan_changed', {
      selectionPolicyVersion: conversationState.selectionPolicyVersion || null,
      previousModuleIds,
      moduleIds: currentModuleIds
    }).catch(() => {});
  }
  return {
    ...payload,
    turnId: committed.turnId,
    turns: [
      { id: `${committed.turnId}-user`, role: 'user', text: safeMessage },
      { id: `${committed.turnId}-assistant`, role: 'assistant', text: assistantMessage }
    ],
    idempotentReplay: false
  };
}

function describeLegacyPersonaState(profile, config) {
  const personaPlan = buildPersonaModulePlan(profile, { allowedModuleIds: config.allowedModules });
  const hasGoal = Boolean(profile?.goals?.length);
  const plannedRecommendations = hasGoal ? personaPlanRecommendations(personaPlan, profile) : [];
  const explicitPersonaResolved = personaPlan.personaAssessment.needsDisambiguation !== true
    && personaPlan.personaAssessment.evidenceFactIds.includes('self_description');
  const scanQuestion = hasGoal && !explicitPersonaResolved ? personaScanQuestion(profile) : null;
  let nextQuestion = buildQuestionPlan(profile, plannedRecommendations);
  let stage = stageFromQuestionPlan(profile, plannedRecommendations);
  if (stage === 'targeted_fact_gathering') stage = 'goal_specific_questions';
  if (hasGoal && personaPlan.personaAssessment.needsDisambiguation) {
    nextQuestion = {
      questionId: `question-persona-disambiguation-${personaPlan.personaAssessment.profileRevision}`,
      factId: 'self_description',
      factInstanceId: 'self_description',
      factIds: ['self_description'],
      facts: [{ factId: 'self_description', factInstanceId: 'self_description', fieldPath: '/assumptions/values/persona/selfDescription' }],
      fieldPaths: ['/assumptions/values/persona/selfDescription'],
      relatedFieldPaths: ['/assumptions/values/persona/selfDescription'],
      prompt: 'Which description best matches your situation right now?',
      answerType: 'text',
      confirmationPolicy: 'final_review',
      optional: false
    };
    stage = 'life_stage_scan';
  } else if (scanQuestion) {
    nextQuestion = scanQuestion;
    stage = 'life_stage_scan';
  }
  return {
    stage,
    nextQuestion,
    recommendations: plannedRecommendations,
    personaAssessment: personaPlan.personaAssessment,
    moduleSlots: personaPlan.moduleSlots,
    overrides: personaPlan.overrides,
    requiresGoalPriorityQuestion: false,
    requiresDecisionTopicQuestion: false,
    requiresPersonaScan: Boolean(scanQuestion),
    deferredGoalTypes: []
  };
}

export function describeConversationState(profile, config) {
  if (config.goalRoutingEnabled === false) return describeLegacyPersonaState(profile, config);
  const goalPlan = buildGoalModulePlan(profile, { allowedModuleIds: config.allowedModules });
  const hasGoal = goalPlan.goalAssessment.activeGoalTypes.length > 0;
  const plannedRecommendations = hasGoal ? goalPlanRecommendations(goalPlan, profile) : [];
  const recommendations = goalPlan.requiresDecisionTopicQuestion || goalPlan.requiresGoalPriorityQuestion
    ? [] : plannedRecommendations;
  const unsupportedOnly = hasGoal
    && goalPlan.moduleSlots.length === 0
    && !goalPlan.requiresDecisionTopicQuestion
    && !goalPlan.requiresGoalPriorityQuestion;
  let nextQuestion = buildQuestionPlan(profile, plannedRecommendations);
  let stage = stageFromQuestionPlan(profile, plannedRecommendations);
  if (goalPlan.requiresDecisionTopicQuestion) {
    nextQuestion = {
      questionId: `question-specific-decision-${goalPlan.profileRevision}`,
      factId: 'primary_goal',
      factInstanceId: 'primary_goal',
      factIds: ['primary_goal'],
      facts: [{
        factId: 'primary_goal',
        factInstanceId: 'primary_goal',
        fieldPath: '/goals'
      }],
      fieldPaths: ['/goals'],
      relatedFieldPaths: ['/goals'],
      prompt: 'What does that decision concern—for example buying a home, reviewing a mortgage or loan, retirement, or funding education?',
      answerType: 'text',
      confirmationPolicy: 'final_review',
      optional: false
    };
    stage = 'goal_clarification';
  } else if (goalPlan.requiresGoalPriorityQuestion) {
    const choices = goalPlan.goalAssessment.activeGoalTypes
      .filter((goalType) => !goalPlan.deferredGoalTypes.includes(goalType))
      .map(getGoalLabel);
    nextQuestion = {
      questionId: `question-primary-goal-focus-${goalPlan.profileRevision}`,
      factId: 'primary_goal_focus',
      factInstanceId: 'primary_goal_focus',
      factIds: ['primary_goal_focus'],
      facts: [{
        factId: 'primary_goal_focus',
        factInstanceId: 'primary_goal_focus',
        fieldPath: '/assumptions/values/planning/primaryGoalType'
      }],
      fieldPaths: ['/assumptions/values/planning/primaryGoalType'],
      relatedFieldPaths: ['/goals'],
      prompt: `You’ve mentioned ${choices.join(', ')}. Which would be most useful to focus on today?`,
      answerType: 'text',
      confirmationPolicy: 'final_review',
      optional: false
    };
    stage = 'goal_clarification';
  } else if (unsupportedOnly) {
    nextQuestion = {
      questionId: `question-supported-goal-${goalPlan.profileRevision}`,
      factId: 'primary_goal',
      factInstanceId: 'primary_goal',
      factIds: ['primary_goal'],
      facts: [{
        factId: 'primary_goal',
        factInstanceId: 'primary_goal',
        fieldPath: '/goals'
      }],
      fieldPaths: ['/goals'],
      relatedFieldPaths: ['/goals'],
      prompt: 'I’ve noted that goal, but it does not yet have a consumer analysis in this version. Is there another goal you would like to focus on today?',
      answerType: 'text',
      confirmationPolicy: 'final_review',
      optional: false
    };
    stage = 'goal_clarification';
  }
  return {
    stage,
    nextQuestion,
    recommendations,
    selectionPolicyVersion: goalPlan.selectionPolicyVersion,
    goalAssessment: goalPlan.goalAssessment,
    moduleSlots: hasGoal && !goalPlan.requiresDecisionTopicQuestion && !goalPlan.requiresGoalPriorityQuestion
      ? goalPlan.moduleSlots.map(({ ruleIds: _ruleIds, ...slot }) => slot) : [],
    requiresGoalPriorityQuestion: hasGoal && goalPlan.requiresGoalPriorityQuestion,
    requiresDecisionTopicQuestion: hasGoal && goalPlan.requiresDecisionTopicQuestion,
    deferredGoalTypes: hasGoal ? goalPlan.deferredGoalTypes : []
  };
}
