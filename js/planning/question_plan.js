import {
  FACT_CONFIRMATION_POLICIES,
  resolveSemanticFact
} from './semantic_facts.js';

const IMPORTANCE_RANK = Object.freeze({ required: 3, recommended: 2, optional: 1 });
const CONFIRMATION_RANK = Object.freeze({
  [FACT_CONFIRMATION_POLICIES.FINAL_REVIEW]: 1,
  [FACT_CONFIRMATION_POLICIES.READ_BACK]: 2,
  [FACT_CONFIRMATION_POLICIES.VISUAL_AND_FINAL]: 3
});
const SENSITIVITY_RANK = Object.freeze({ normal: 1, material: 2, restricted: 3 });

function asSources(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.flatMap(asSources);
  if (Array.isArray(input.selectedModules)) return input.selectedModules.flatMap(asSources);
  if (Array.isArray(input.recommendations)) return input.recommendations.flatMap(asSources);
  if (typeof input.fieldPath === 'string') {
    return [{ moduleId: null, requiredModule: false, missingItems: [input] }];
  }
  const readiness = input.readiness || input;
  if (!Array.isArray(readiness?.requiredMissing)) return [];
  return [{
    moduleId: typeof input.moduleId === 'string' ? input.moduleId : null,
    requiredModule: input.required === true || input.status === 'required',
    missingItems: readiness.requiredMissing
  }];
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value))]
    .sort((left, right) => left.localeCompare(right));
}

function importanceFor(rank) {
  if (rank >= IMPORTANCE_RANK.required) return 'required';
  if (rank >= IMPORTANCE_RANK.recommended) return 'recommended';
  return 'optional';
}

function boundedScore(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(5, value))
    : fallback;
}

function priorityValues(item, resolution) {
  const unresolvedAmbiguity = typeof item.unresolvedAmbiguity === 'boolean'
    ? (item.unresolvedAmbiguity ? 5 : 0)
    : item.unresolvedAmbiguity;
  return {
    materiality: boundedScore(item.materialityScore ?? item.priority?.materiality, resolution.materiality),
    ambiguity: boundedScore(
      unresolvedAmbiguity ?? item.ambiguityScore ?? item.priority?.ambiguity,
      resolution.ambiguity
    ),
    userEffort: boundedScore(item.userEffort ?? item.priority?.userEffort, resolution.userEffort)
  };
}

function stableQuestionId(factInstanceId) {
  const value = String(factInstanceId || 'unknown');
  const slug = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 72) || 'unknown';
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fact-${slug}-${(hash >>> 0).toString(36)}`;
}

function createAggregate(item, source, resolution) {
  const importanceRank = IMPORTANCE_RANK[item.importance] || IMPORTANCE_RANK.required;
  const ranking = priorityValues(item, resolution);
  return {
    factId: resolution.factId,
    factInstanceId: resolution.factInstanceId,
    entityId: resolution.entityId,
    identityStability: resolution.identityStability,
    mapped: resolution.mapped,
    fieldPaths: new Set([resolution.fieldPath].filter(Boolean)),
    preferredPaths: new Set([resolution.preferredProfilePath].filter(Boolean)),
    reasons: new Set([item.reason].filter((reason) => typeof reason === 'string' && reason)),
    blockingModuleIds: new Set([
      ...(Array.isArray(item.blockingModuleIds) ? item.blockingModuleIds : []),
      source.moduleId
    ].filter(Boolean)),
    importanceRank,
    requiredModuleBlocker: source.requiredModule || item.requiredModuleBlocker === true,
    confirmationPolicy: resolution.confirmationPolicy,
    valueType: resolution.valueType,
    profilePathTemplate: resolution.profilePathTemplate,
    sensitivity: resolution.sensitivity,
    questionPrompt: resolution.questionPrompt,
    answerType: resolution.answerType,
    materiality: ranking.materiality,
    ambiguity: ranking.ambiguity,
    userEffort: ranking.userEffort
  };
}

function mergeAggregate(aggregate, item, source, resolution) {
  const ranking = priorityValues(item, resolution);
  if (resolution.fieldPath) aggregate.fieldPaths.add(resolution.fieldPath);
  if (resolution.preferredProfilePath) aggregate.preferredPaths.add(resolution.preferredProfilePath);
  if (typeof item.reason === 'string' && item.reason) aggregate.reasons.add(item.reason);
  (Array.isArray(item.blockingModuleIds) ? item.blockingModuleIds : [])
    .forEach((moduleId) => aggregate.blockingModuleIds.add(moduleId));
  if (source.moduleId) aggregate.blockingModuleIds.add(source.moduleId);
  aggregate.importanceRank = Math.max(
    aggregate.importanceRank,
    IMPORTANCE_RANK[item.importance] || IMPORTANCE_RANK.required
  );
  aggregate.requiredModuleBlocker ||= source.requiredModule || item.requiredModuleBlocker === true;
  aggregate.materiality = Math.max(aggregate.materiality, ranking.materiality);
  aggregate.ambiguity = Math.max(aggregate.ambiguity, ranking.ambiguity);
  aggregate.userEffort = Math.min(aggregate.userEffort, ranking.userEffort);
  if ((CONFIRMATION_RANK[resolution.confirmationPolicy] || 0)
    > (CONFIRMATION_RANK[aggregate.confirmationPolicy] || 0)) {
    aggregate.confirmationPolicy = resolution.confirmationPolicy;
  }
  if ((SENSITIVITY_RANK[resolution.sensitivity] || 0) > (SENSITIVITY_RANK[aggregate.sensitivity] || 0)) {
    aggregate.sensitivity = resolution.sensitivity;
  }
}

function toQuestion(aggregate) {
  const relatedFieldPaths = uniqueSorted([...aggregate.fieldPaths]);
  const preferredPaths = uniqueSorted([...aggregate.preferredPaths]);
  const targetPath = preferredPaths[0] || relatedFieldPaths[0];
  const reasons = uniqueSorted([...aggregate.reasons]);
  const blockingModuleIds = uniqueSorted([...aggregate.blockingModuleIds]);
  const importance = importanceFor(aggregate.importanceRank);
  const requiredBlocker = importance === 'required';
  return {
    questionId: stableQuestionId(aggregate.factInstanceId),
    fieldPaths: targetPath ? [targetPath] : [],
    reason: reasons[0] || aggregate.questionPrompt,
    blockingModuleIds,
    prompt: aggregate.questionPrompt,
    answerType: aggregate.answerType,
    optional: !requiredBlocker,
    factId: aggregate.factId,
    factInstanceId: aggregate.factInstanceId,
    relatedFieldPaths,
    confirmationPolicy: aggregate.confirmationPolicy,
    valueType: aggregate.valueType,
    profilePathTemplate: aggregate.profilePathTemplate,
    sensitivity: aggregate.sensitivity,
    importance,
    priority: {
      requiredBlocker,
      requiredModuleBlocker: aggregate.requiredModuleBlocker,
      sharedModuleCount: blockingModuleIds.length,
      materiality: aggregate.materiality,
      ambiguity: aggregate.ambiguity,
      userEffort: aggregate.userEffort
    },
    identityStability: aggregate.identityStability,
    mapped: aggregate.mapped
  };
}

function compareQuestions(left, right) {
  return Number(right.priority.requiredModuleBlocker) - Number(left.priority.requiredModuleBlocker)
    || right.priority.sharedModuleCount - left.priority.sharedModuleCount
    || right.priority.materiality - left.priority.materiality
    || right.priority.ambiguity - left.priority.ambiguity
    || left.priority.userEffort - right.priority.userEffort
    || Number(right.priority.requiredBlocker) - Number(left.priority.requiredBlocker)
    || left.factInstanceId.localeCompare(right.factInstanceId);
}

/**
 * Convert one or more module-readiness results to a deterministic, globally
 * ranked question plan. The function has no I/O, time, random or mutation
 * dependencies, so identical readiness/profile inputs produce identical ids
 * and ordering in the browser, Worker and tests.
 *
 * Accepted input shapes include selected modules (`{ moduleId, readiness }`),
 * readiness objects (`{ requiredMissing }`), individual missing items and an
 * analysis-plan-like object containing `selectedModules`.
 */
export function buildQuestionPlan(readinessInput, { profile } = {}) {
  const byFactInstance = new Map();
  asSources(readinessInput).forEach((source) => {
    source.missingItems.forEach((item) => {
      if (!item || typeof item.fieldPath !== 'string' || !item.fieldPath.startsWith('/')) return;
      const resolution = resolveSemanticFact(item, {
        profile,
        moduleId: source.moduleId
      });
      const aggregate = byFactInstance.get(resolution.factInstanceId);
      if (aggregate) mergeAggregate(aggregate, item, source, resolution);
      else byFactInstance.set(resolution.factInstanceId, createAggregate(item, source, resolution));
    });
  });
  return [...byFactInstance.values()].map(toQuestion).sort(compareQuestions);
}
