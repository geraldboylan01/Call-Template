import { buildQuestionPlan as buildCanonicalQuestionPlan } from '../../../js/planning/question_plan.js';
import {
  completionResponseFor,
  resolveSemanticFact
} from '../../../js/planning/semantic_facts.js';

function acknowledgedMissing(profile, item) {
  const completionFacts = profile?.assumptions?.values?.completionFacts || {};
  const semantic = resolveSemanticFact(item, { profile });
  const response = completionResponseFor(profile, {
    ...item,
    factId: semantic.factId,
    factInstanceId: semantic.factInstanceId,
    entityId: semantic.entityId
  });
  if (['answered_range', 'complete', 'confirmed_none', 'estimate_declined'].includes(response?.resolution)) {
    return true;
  }
  // A first unknown is deliberately unacknowledged: it earns one estimate
  // question for this exact fact instance.
  if (response?.resolution === 'unknown') return false;
  if (item?.importance === 'required') return false;
  const path = String(item?.fieldPath || '');
  return Boolean(path && completionFacts.confirmedNonePaths?.[path]);
}

function unacknowledgedRecommendations(profile, recommendations) {
  return (recommendations || []).map((item) => ({
    ...item,
    readiness: {
      ...(item.readiness || {}),
      requiredMissing: (item.readiness?.requiredMissing || [])
        .filter((missing) => !acknowledgedMissing(profile, missing))
    }
  }));
}

function goalDiscoveryQuestion() {
  return {
    questionId: 'question-goal-primary',
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
    prompt: 'What brought you here today, and what would you most like help with?',
    answerType: 'text',
    confirmationPolicy: 'final_review',
    optional: false
  };
}

function reviewQuestion() {
  return {
    questionId: 'question-review-profile',
    factId: null,
    factInstanceId: null,
    factIds: [],
    facts: [],
    fieldPaths: [],
    relatedFieldPaths: [],
    prompt: 'Please review the details shown and correct anything that is not right before confirming.',
    answerType: 'text',
    confirmationPolicy: 'final_review',
    optional: false
  };
}

export function buildQuestionPlan(profile, recommendations) {
  if (!profile?.goals?.length) return goalDiscoveryQuestion();
  const questions = buildCanonicalQuestionPlan(
    unacknowledgedRecommendations(profile, recommendations),
    { profile }
  );
  const selected = questions[0];
  if (!selected) return reviewQuestion();
  const fieldPath = selected.fieldPaths?.[0] || selected.relatedFieldPaths?.[0] || null;
  return {
    ...selected,
    factIds: [selected.factId],
    facts: [{
      factId: selected.factId,
      factInstanceId: selected.factInstanceId,
      fieldPath,
      entityId: selected.entityId || null,
      ownerId: selected.ownerId || null,
      status: selected.status,
      answerPolicy: selected.answerPolicy
    }]
  };
}

export function stageFromQuestionPlan(profile, recommendations) {
  if (!profile?.goals?.length) return 'goal_discovery';
  return buildQuestionPlan(profile, recommendations).fieldPaths.length
    ? 'targeted_fact_gathering'
    : 'review';
}
