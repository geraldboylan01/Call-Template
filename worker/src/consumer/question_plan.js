import { buildQuestionPlan as buildCanonicalQuestionPlan } from '../../../js/planning/question_plan.js';

function acknowledgedMissing(profile, item) {
  if (item?.importance === 'required') return false;
  const path = String(item?.fieldPath || '');
  return Boolean(path && profile?.assumptions?.values?.completionFacts?.confirmedNonePaths?.[path]);
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
    prompt: 'What would you most like this plan to help you understand?',
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
      fieldPath
    }]
  };
}

export function stageFromQuestionPlan(profile, recommendations) {
  if (!profile?.goals?.length) return 'goal_discovery';
  return buildQuestionPlan(profile, recommendations).fieldPaths.length
    ? 'goal_specific_questions'
    : 'review';
}
