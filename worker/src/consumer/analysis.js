import { runConsumerAnalysis } from '../../../js/planning/orchestrator.js';
import { getConsumerModuleDescriptors } from '../../../js/planning/module_registry.js';
import { ConsumerError } from './errors.js';
import {
  completeAnalysisRun,
  createAnalysisRun,
  failAnalysisRun,
  getSessionRow,
  recordEvent,
  saveAnalysisNeedsInformation,
  toConsumerSession
} from './repository.js';

export function getAvailableConsumerModules(config) {
  const byId = new Map(getConsumerModuleDescriptors().map((descriptor) => [descriptor.id, descriptor]));
  return config.allowedModules
    .filter((moduleId) => byId.has(moduleId))
    .map((moduleId) => byId.get(moduleId));
}

export async function runStoredConsumerAnalysis({ env, config, sessionRow, profile, moduleIds, scenarioOverrides }) {
  if (!sessionRow.confirmed_profile_revision
    || Number(sessionRow.confirmed_profile_revision) !== Number(sessionRow.current_profile_revision)) {
    throw new ConsumerError(409, 'profile_confirmation_required', 'Confirm the current profile before running an analysis.');
  }
  const run = await createAnalysisRun(env, sessionRow, profile, moduleIds);
  try {
    const result = await runConsumerAnalysis({
      profile,
      moduleIds,
      allowedModuleIds: config.allowedModules,
      scenarioOverrides,
      analysisPlanId: `plan_${run.id}`,
      calculationDateIso: profile.assumptions.calculationDateIso
    });
    if (result.analysisPlan?.status !== 'complete' || !Array.isArray(result.results) || result.results.length === 0) {
      const pending = await saveAnalysisNeedsInformation(env, run, sessionRow.id, result);
      throw new ConsumerError(
        409,
        'analysis_missing_information',
        'More information is required before this analysis can run.',
        {
          analysis: pending,
          requiredQuestions: result.analysisPlan?.requiredQuestions || [],
          recommendations: result.recommendations || []
        }
      );
    }
    const effectiveIds = result.analysisPlan?.selectedModules?.map((item) => item.moduleId) || moduleIds || [];
    const stored = await completeAnalysisRun(env, run, sessionRow.id, result, effectiveIds);
    for (const selected of result.analysisPlan?.selectedModules || []) {
      const moduleResult = result.results?.find((item) => item.moduleId === selected.moduleId);
      await recordEvent(env, sessionRow.id, 'module_run', {
        moduleId: selected.moduleId,
        status: moduleResult ? 'complete' : selected.readiness?.status || 'not_ready'
      }).catch(() => {});
    }
    if (Object.keys(scenarioOverrides || {}).length) {
      await recordEvent(env, sessionRow.id, 'scenario_run', { moduleIds: effectiveIds }).catch(() => {});
    }
    return {
      session: toConsumerSession(await getSessionRow(env, sessionRow.id)),
      analysis: stored
    };
  } catch (error) {
    if (error instanceof ConsumerError && error.code === 'analysis_missing_information') throw error;
    await failAnalysisRun(env, run, sessionRow.id).catch(() => {});
    if (error instanceof ConsumerError) throw error;
    throw new ConsumerError(422, 'analysis_not_ready', error instanceof Error ? error.message : 'Analysis could not be completed.');
  }
}
