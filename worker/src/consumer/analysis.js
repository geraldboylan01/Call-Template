import { runConsumerAnalysis } from '../../../js/planning/orchestrator.js';
import { getConsumerModuleDescriptors } from '../../../js/planning/module_registry.js';
import {
  MODULE_FAILURE_CODES,
  hasBlockingModuleFailure,
  isModuleFailureCode,
  primaryModuleFailure
} from '../../../js/planning/module_failures.js';
import { ConsumerError } from './errors.js';
import {
  completeAnalysisRun,
  createAnalysisRun,
  failAnalysisRun,
  findReusableConsumerModuleRun,
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
    const moduleExecutions = [];
    const result = await runConsumerAnalysis({
      profile,
      moduleIds,
      allowedModuleIds: config.allowedModules,
      scenarioOverrides,
      analysisPlanId: `plan_${run.id}`,
      calculationDateIso: profile.assumptions.calculationDateIso,
      resolveReusableModuleResult: (identity) => findReusableConsumerModuleRun(
        env,
        sessionRow.id,
        identity
      ).catch(() => null),
      onModuleResult: (execution) => {
        moduleExecutions.push(execution);
      }
    });
    if (result.analysisPlan?.status !== 'complete' || !Array.isArray(result.results) || result.results.length === 0) {
      // A MODULE THAT BROKE IS NOT A CLIENT WHO HAS NOT ANSWERED.
      //
      // Both used to arrive here as `analysis_missing_information`, so a
      // module crashing on a complete profile told the meeting to go back and
      // ask for facts the client had already given -- a loop with no exit. The
      // two are now separated by the failure codes the orchestrator records.
      const moduleFailures = (result.errors || []).filter((item) => isModuleFailureCode(item?.code));
      if (hasBlockingModuleFailure(moduleFailures)) {
        const pending = await saveAnalysisNeedsInformation(env, run, sessionRow.id, result);
        const primary = primaryModuleFailure(moduleFailures);
        throw new ConsumerError(
          422,
          'analysis_module_failed',
          'A deterministic analysis could not be completed from the confirmed profile.',
          {
            analysis: pending,
            // Engine-level diagnostics. Server-side only: the client-facing
            // wording is derived from `code`, never from these strings.
            moduleFailures,
            failureCode: primary?.code || MODULE_FAILURE_CODES.UNKNOWN,
            failedModuleId: primary?.moduleId || null,
            requiredQuestions: result.analysisPlan?.requiredQuestions || [],
            recommendations: result.recommendations || []
          }
        );
      }
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
    const stored = await completeAnalysisRun(
      env,
      run,
      sessionRow.id,
      result,
      effectiveIds,
      moduleExecutions
    );
    for (const selected of result.analysisPlan?.selectedModules || []) {
      const moduleResult = result.results?.find((item) => item.moduleId === selected.moduleId);
      const execution = moduleExecutions.find((item) => item.moduleId === selected.moduleId);
      await recordEvent(env, sessionRow.id, 'module_run', {
        moduleId: selected.moduleId,
        status: moduleResult
          ? (execution?.reused ? 'reused' : 'complete')
          : selected.readiness?.status || 'not_ready'
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
    if (error instanceof ConsumerError
      && ['analysis_missing_information', 'analysis_module_failed'].includes(error.code)) throw error;
    await failAnalysisRun(env, run, sessionRow.id).catch(() => {});
    if (error instanceof ConsumerError) throw error;
    throw new ConsumerError(422, 'analysis_not_ready', error instanceof Error ? error.message : 'Analysis could not be completed.');
  }
}
