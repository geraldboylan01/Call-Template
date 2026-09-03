import {
  CONSUMER_CALCULATION_VERSION,
  CONSUMER_PLANNING_RULES_VERSION
} from './contracts.js';
import {
  getPlanningModuleRunIdentity,
  getPlanningModuleDefinition,
  getModuleReadiness,
  runPlanningModule,
  runPlanningModuleWithInput
} from './module_registry.js';
import { normalizeHouseholdProfile } from './profile.js';
import {
  MODULE_FAILURE_CODES,
  classifyModuleFailure,
  moduleFailureDetail
} from './module_failures.js';
import { buildQuestionPlan } from './question_plan.js';
import { recommendModules } from './routing_rules.js';
import { summarizeAnalysisResults } from './result_summary.js';
import { assertIsoDate, cloneJson, createOpaqueId, sha256Json } from './utils.js';

const RUNNABLE_READINESS = new Set(['ready', 'ready_with_assumptions']);

function resolvePrerequisites(moduleIds) {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = (moduleId) => {
    if (visited.has(moduleId)) return;
    if (visiting.has(moduleId)) throw new Error(`Planning module prerequisite cycle at ${moduleId}.`);
    visiting.add(moduleId);
    const definition = getPlanningModuleDefinition(moduleId);
    if (!definition) throw new Error(`Unknown planning module: ${moduleId}`);
    definition.prerequisiteModuleIds.forEach(visit);
    visiting.delete(moduleId);
    visited.add(moduleId);
    ordered.push(moduleId);
  };
  moduleIds.forEach(visit);
  return ordered;
}

function scenarioFor(moduleId, scenarioOverrides, selectedCount) {
  if (!scenarioOverrides || typeof scenarioOverrides !== 'object' || Array.isArray(scenarioOverrides)) return {};
  if (scenarioOverrides[moduleId] && typeof scenarioOverrides[moduleId] === 'object') return scenarioOverrides[moduleId];
  if (selectedCount === 1) return scenarioOverrides;
  return {};
}

/**
 * Worker-safe deterministic analysis entrypoint.
 *
 * @param {Object} options
 * @param {Object} options.profile Canonical HouseholdProfile v1.
 * @param {string[]} [options.moduleIds] Explicit consumer modules; omitted means deterministic routing.
 * @param {string[]} [options.allowedModuleIds] Server-evaluated allowlist without user-selection semantics.
 * @param {Object} [options.scenarioOverrides] Overrides keyed by module id (or flat for one module).
 * @param {Function} [options.resolveReusableModuleResult] Worker-owned exact-match cache lookup.
 * @param {Function} [options.onModuleResult] Internal execution metadata callback; never part of the public result.
 * @returns {Promise<{analysisPlan:Object,plan:Object,recommendations:Object[],results:Object[],summary:Object,errors:Object[]}>}
 */
export async function runConsumerAnalysis({
  profile: rawProfile,
  moduleIds,
  allowedModuleIds,
  scenarioOverrides = {},
  calculationDateIso,
  analysisPlanId = createOpaqueId('analysis-plan'),
  rulesVersion = CONSUMER_PLANNING_RULES_VERSION,
  calculationVersion = CONSUMER_CALCULATION_VERSION,
  calculatedAt = new Date().toISOString(),
  resolveReusableModuleResult,
  onModuleResult,
  signal
} = {}) {
  let profile = normalizeHouseholdProfile(rawProfile);
  const effectiveCalculationDate = assertIsoDate(
    calculationDateIso || profile.assumptions.calculationDateIso,
    'calculationDateIso'
  );
  if (effectiveCalculationDate !== profile.assumptions.calculationDateIso) {
    profile = cloneJson(profile);
    profile.assumptions.calculationDateIso = effectiveCalculationDate;
  }
  if (typeof moduleIds !== 'undefined' && (!Array.isArray(moduleIds) || moduleIds.some((id) => typeof id !== 'string'))) {
    throw new Error('moduleIds must be an array of module id strings when provided.');
  }
  if (typeof allowedModuleIds !== 'undefined'
    && (!Array.isArray(allowedModuleIds) || allowedModuleIds.some((id) => typeof id !== 'string'))) {
    throw new Error('allowedModuleIds must be an array of module id strings when provided.');
  }

  const explicitIds = moduleIds ? [...new Set(moduleIds)] : null;
  const allowedIds = allowedModuleIds ? new Set(allowedModuleIds) : null;
  const recommendations = recommendModules(profile, {
    userSelectedModuleIds: explicitIds || []
  });
  const defaultIds = recommendations
    .filter((recommendation) => recommendation.status !== 'excluded')
    .filter((recommendation) => getPlanningModuleDefinition(recommendation.moduleId)?.consumerAvailable)
    .filter((recommendation) => !allowedIds || allowedIds.has(recommendation.moduleId))
    .map((recommendation) => recommendation.moduleId);
  const requestedIds = explicitIds || defaultIds;
  const errors = [];
  const consumerRequestedIds = requestedIds.filter((moduleId) => {
    const definition = getPlanningModuleDefinition(moduleId);
    if (!definition) {
      errors.push({ moduleId, code: 'unknown_module', message: `Unknown planning module: ${moduleId}` });
      return false;
    }
    if (!definition.consumerAvailable) {
      errors.push({
        moduleId,
        code: definition.status === 'adviser_only' ? 'adviser_only' : 'module_not_consumer_available',
        message: `${moduleId} is not available through the consumer analysis path.`
      });
      return false;
    }
    if (allowedIds && !allowedIds.has(moduleId)) {
      errors.push({ moduleId, code: 'module_not_allowed', message: `${moduleId} is disabled by the evaluated consumer module allowlist.` });
      return false;
    }
    const blockedPrerequisite = definition.prerequisiteModuleIds.find((prerequisiteId) => !allowedIds?.has(prerequisiteId));
    if (allowedIds && blockedPrerequisite) {
      errors.push({
        moduleId,
        code: 'prerequisite_not_allowed',
        message: `${moduleId} requires disabled prerequisite ${blockedPrerequisite}.`
      });
      return false;
    }
    return true;
  });

  let orderedIds = [];
  try {
    orderedIds = resolvePrerequisites(consumerRequestedIds).filter((moduleId) => {
      const definition = getPlanningModuleDefinition(moduleId);
      if (definition.consumerAvailable) return true;
      errors.push({ moduleId, code: 'prerequisite_not_consumer_available', message: `${moduleId} is not an available consumer prerequisite.` });
      return false;
    });
  } catch (error) {
    errors.push({ moduleId: null, code: 'invalid_analysis_plan', message: error.message });
  }

  const selectedModules = orderedIds.map((moduleId) => {
    const recommendation = recommendations.find((entry) => entry.moduleId === moduleId);
    return {
      moduleId,
      priority: recommendation?.priority ?? 0,
      required: recommendation?.status === 'required' || Boolean(explicitIds?.includes(moduleId)),
      readiness: getModuleReadiness(moduleId, profile)
    };
  });
  const selectedRecommendations = recommendations.filter((recommendation) => (
    orderedIds.includes(recommendation.moduleId) || recommendation.readiness.status === 'adviser_review_required'
  ));
  const requiredQuestions = buildQuestionPlan(selectedModules, { profile });
  const createdAt = calculatedAt;
  const analysisPlan = {
    analysisPlanId,
    profileId: profile.profileId,
    profileRevision: profile.revision,
    selectedModules,
    recommendations: selectedRecommendations,
    requiredQuestions,
    assumptions: cloneJson(profile.assumptions),
    rulesVersion,
    status: requiredQuestions.length > 0 ? 'needs_review' : (orderedIds.length > 0 ? 'running' : 'needs_review'),
    createdAt,
    updatedAt: createdAt
  };

  const results = [];
  for (const selected of selectedModules) {
    if (signal?.aborted) {
      errors.push({ moduleId: selected.moduleId, code: 'analysis_aborted', message: 'Analysis was aborted.' });
      break;
    }
    if (!RUNNABLE_READINESS.has(selected.readiness.status)) {
      // A selected module that never became runnable used to drop out with no
      // trace, so a caller could only infer it from a short results array. It
      // is recorded as an ordinary failure now, which is what it is.
      errors.push({
        moduleId: selected.moduleId,
        code: MODULE_FAILURE_CODES.READINESS_NOT_MET,
        message: `${selected.moduleId} readiness is ${selected.readiness.status}; it was not run.`,
        readinessStatus: selected.readiness.status
      });
      continue;
    }
    try {
      const moduleContext = {
        calculationDateIso: effectiveCalculationDate,
        calculationVersion,
        calculatedAt,
        scenarioOverrides: scenarioFor(selected.moduleId, scenarioOverrides, selectedModules.length),
        signal
      };
      const cacheIdentity = Object.freeze({
        ...await getPlanningModuleRunIdentity(selected.moduleId, profile, moduleContext),
        readinessSnapshotHash: await sha256Json(selected.readiness)
      });
      let result = null;
      let reused = false;
      if (typeof resolveReusableModuleResult === 'function') {
        const candidate = await resolveReusableModuleResult(cacheIdentity);
        if (candidate
          && candidate.moduleId === cacheIdentity.moduleId
          && candidate.moduleVersion === cacheIdentity.moduleVersion
          && candidate.calculationVersion === cacheIdentity.calculationVersion
          && candidate.inputSnapshotHash === cacheIdentity.inputSnapshotHash) {
          result = cloneJson(candidate);
          reused = true;
        }
      }
      if (!result) {
        result = await runPlanningModule(selected.moduleId, profile, moduleContext);
      }
      results.push(result);
      selected.inputSnapshotHash = result.inputSnapshotHash;
      selected.runId = result.runId;
      if (typeof onModuleResult === 'function') {
        await onModuleResult(Object.freeze({
          moduleId: selected.moduleId,
          cacheIdentity,
          result,
          reused
        }));
      }
    } catch (error) {
      // `message` is the engine's own diagnostic. It stays server-side: the
      // client-facing wording is derived from `code`, never from this text.
      errors.push({
        moduleId: selected.moduleId,
        code: classifyModuleFailure(error),
        message: moduleFailureDetail(error)
      });
    }
  }

  analysisPlan.status = errors.length > 0 || requiredQuestions.length > 0
    ? 'needs_review'
    : (results.length === selectedModules.length && results.length > 0 ? 'complete' : 'needs_review');
  analysisPlan.updatedAt = calculatedAt;
  const summary = summarizeAnalysisResults({ results, errors, analysisPlan });
  return {
    analysisPlan,
    plan: analysisPlan,
    recommendations,
    results,
    summary,
    errors
  };
}

/**
 * Execute AI-authored native module inputs without translating them through a
 * HouseholdProfile. The semantic planner has already chosen the modules and
 * produced their contracts; this function supplies only deterministic module
 * validation, calculation and the normal result summary.
 */
export async function runConsumerAnalysisWithInputs({
  profile,
  moduleInputs,
  allowedModuleIds,
  calculationDateIso,
  analysisPlanId = createOpaqueId('analysis-plan'),
  calculationVersion = CONSUMER_CALCULATION_VERSION,
  calculatedAt = new Date().toISOString(),
  onModuleResult,
  signal
} = {}) {
  if (!moduleInputs || typeof moduleInputs !== 'object' || Array.isArray(moduleInputs)) {
    throw new Error('moduleInputs must be an object keyed by module id.');
  }
  const allowed = new Set(Array.isArray(allowedModuleIds) ? allowedModuleIds : []);
  const moduleIds = Object.keys(moduleInputs);
  const selectedModules = [];
  const results = [];
  const errors = [];
  const effectiveDate = assertIsoDate(
    calculationDateIso || profile?.assumptions?.calculationDateIso,
    'calculationDateIso'
  );
  for (const moduleId of moduleIds) {
    const definition = getPlanningModuleDefinition(moduleId);
    if (!definition || !definition.consumerAvailable || (allowed.size && !allowed.has(moduleId))) {
      errors.push({ moduleId, code: 'module_not_allowed', message: `${moduleId} is not an approved consumer module.` });
      continue;
    }
    const selected = {
      moduleId,
      priority: 0,
      required: true,
      readiness: { status: 'ready', requiredMissing: [], assumptionsUsed: [], warnings: [] }
    };
    selectedModules.push(selected);
    if (signal?.aborted) {
      errors.push({ moduleId, code: 'analysis_aborted', message: 'Analysis was aborted.' });
      break;
    }
    try {
      const result = await runPlanningModuleWithInput(moduleId, cloneJson(moduleInputs[moduleId]), {
        calculationDateIso: effectiveDate,
        calculationVersion,
        calculatedAt,
        scenarioOverrides: {},
        baseCurrency: profile?.preferences?.baseCurrency || 'EUR',
        signal
      });
      results.push(result);
      selected.inputSnapshotHash = result.inputSnapshotHash;
      selected.runId = result.runId;
      if (typeof onModuleResult === 'function') {
        await onModuleResult(Object.freeze({
          moduleId,
          cacheIdentity: null,
          inputSnapshotHash: result.inputSnapshotHash,
          result,
          reused: false
        }));
      }
    } catch (error) {
      errors.push({
        moduleId,
        code: classifyModuleFailure(error),
        message: moduleFailureDetail(error)
      });
    }
  }
  const analysisPlan = {
    analysisPlanId,
    profileId: profile?.profileId || null,
    profileRevision: Number(profile?.revision || 0),
    selectedModules,
    recommendations: [],
    requiredQuestions: [],
    assumptions: cloneJson(profile?.assumptions || {}),
    rulesVersion: CONSUMER_PLANNING_RULES_VERSION,
    status: errors.length === 0 && results.length === selectedModules.length && results.length > 0
      ? 'complete'
      : 'needs_review',
    createdAt: calculatedAt,
    updatedAt: calculatedAt
  };
  return {
    analysisPlan,
    plan: analysisPlan,
    recommendations: [],
    results,
    summary: summarizeAnalysisResults({ results, errors, analysisPlan }),
    errors
  };
}
