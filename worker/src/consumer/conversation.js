import { applyProfilePatch as applyCanonicalProfilePatch } from '../../../js/planning/profile.js';
import { GOAL_TYPES } from '../../../js/planning/contracts.js';
import { recommendModules } from '../../../js/planning/routing_rules.js';
import { extractRulesOnlyProfilePatch } from '../../../js/planning/rules_only_extraction.js';
import { extractProfilePatchWithAi, selectAiRequestPolicy } from './ai_provider.js';
import { ConsumerError } from './errors.js';
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

function allowedRecommendations(profile, message, config) {
  if (!config.moduleRoutingEnabled) return [];
  return recommendModules(profile, { text: message })
    .filter((item) => (
      config.allowedModules.includes(item.moduleId)
      || ['adviser_review_required', 'unsupported'].includes(item.readiness?.status)
    ));
}

function acknowledgedMissing(profile, item) {
  if (item?.importance === 'required') return false;
  const path = String(item?.fieldPath || '');
  return Boolean(path && profile.assumptions.values.completionFacts?.confirmedNonePaths?.[path]);
}

function stageFromProfile(profile, recommendations) {
  if (!profile.goals.length) return 'goal_discovery';
  if (recommendations.some((item) => (item.readiness?.requiredMissing || []).some((missing) => (
    missing.importance === 'required' && !acknowledgedMissing(profile, missing)
  )))) {
    return 'goal_specific_questions';
  }
  return 'review';
}

function nextQuestion(profile, recommendations) {
  if (!profile.goals.length) {
    return {
      questionId: 'goal-primary',
      fieldPaths: ['/goals'],
      prompt: 'What would you most like this plan to help you understand?',
      answerType: 'text',
      optional: false
    };
  }
  const requiredMissing = recommendations
    .flatMap((item) => item.readiness?.requiredMissing || [])
    .filter((item) => !acknowledgedMissing(profile, item))
    .sort((left, right) => {
      const rank = { required: 0, recommended: 1, optional: 2 };
      return (rank[left.importance] ?? 3) - (rank[right.importance] ?? 3);
    });
  if (requiredMissing[0]) {
    const item = requiredMissing[0];
    return {
      questionId: `missing-${item.fieldPath.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      fieldPaths: [item.fieldPath],
      reason: item.reason,
      blockingModuleIds: item.blockingModuleIds,
      prompt: item.reason,
      answerType: /amount|value|income|balance|expense|cash/i.test(item.fieldPath) ? 'money' : 'text',
      optional: item.importance !== 'required'
    };
  }
  return {
    questionId: 'review-profile',
    fieldPaths: [],
    prompt: 'Please review the details shown and correct anything that is not right before confirming.',
    answerType: 'text',
    optional: false
  };
}

const GOAL_TITLES = Object.freeze({
  understand_position: 'Understand my current position',
  maintain_liquidity: 'Maintain an emergency cash reserve',
  buy_home: 'Buy a home',
  build_wealth: 'Build long-term wealth',
  improve_pension: 'Improve pension readiness',
  retire: 'Plan for retirement',
  retire_early: 'Explore early retirement',
  optimise_mortgage: 'Review the mortgage path',
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
  assess_decision: /\b(?:decision|compare|college|university|education fund)\b/i,
  transfer_wealth: /\b(?:inheritance|gift|transfer wealth|estate)\b/i,
  business_planning: /\b(?:business|company|shareholding)\b/i,
  agricultural_planning: /\b(?:farm|agricultural|farmland)\b/i
});

function candidateGoalPatch(profile, candidates, message) {
  const existing = new Set(profile.goals.map((goal) => goal.type));
  const patch = {};
  let index = profile.goals.length;
  for (const candidate of candidates || []) {
    if (!GOAL_TYPES.includes(candidate?.type) || !['high', 'medium'].includes(candidate.confidence)) continue;
    if (existing.has(candidate.type) || !GOAL_EVIDENCE[candidate.type]?.test(message)) continue;
    patch[`/goals/${index}`] = {
      goalId: `ai-draft-${candidate.type}-${index + 1}`,
      type: candidate.type,
      title: GOAL_TITLES[candidate.type],
      priority: candidate.confidence === 'high' ? 'high' : 'medium',
      status: 'exploring'
    };
    existing.add(candidate.type);
    index += 1;
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
  const path = question.fieldPaths[0];
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
  const activeRecommendations = allowedRecommendations(profile, '', config);
  const activeQuestion = nextQuestion(profile, activeRecommendations);
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

  const recommendations = allowedRecommendations(nextProfile, safeMessage, config);
  const stage = stageFromProfile(nextProfile, recommendations);
  const question = nextQuestion(nextProfile, recommendations);
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

export function describeConversationState(profile, config) {
  const recommendations = allowedRecommendations(profile, '', config);
  return {
    stage: stageFromProfile(profile, recommendations),
    nextQuestion: nextQuestion(profile, recommendations),
    recommendations
  };
}
