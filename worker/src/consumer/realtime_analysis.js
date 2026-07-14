import { runStoredConsumerAnalysis } from './analysis.js';
import { ConsumerError } from './errors.js';
import { getCurrentProfile, getSessionRow } from './repository.js';
import {
  completeRealtimeAnalysisPlan,
  confirmRealtimeAnalysisPlan,
  markRealtimeAnalysisPlanRunning,
  recordRealtimeRunProvenance,
  toPublicRealtimeAnalysisPlan
} from './realtime_repository.js';

function boundedSpeakableResult(analysis, config) {
  const speakableText = typeof analysis?.summary?.speakableText === 'string'
    ? analysis.summary.speakableText
    : '';
  if (!speakableText || speakableText !== speakableText.trim() || speakableText.length > 2_400) {
    throw new ConsumerError(409, 'analysis_speakable_summary_invalid', 'The deterministic spoken summary is unavailable or exceeds its safe bound.');
  }
  const calculationVersions = [...new Set(
    (analysis?.results || [])
      .map((result) => result?.calculationVersion)
      .filter((value) => typeof value === 'string')
  )];
  return {
    speakableText,
    promptVersion: config.realtimePromptVersion,
    toolsetVersion: config.realtimeToolsetVersion,
    calculationVersion: calculationVersions.length === 1 ? calculationVersions[0] : null,
    completedModuleIds: (analysis?.results || [])
      .map((result) => result?.moduleId)
      .filter((value) => typeof value === 'string')
      .slice(0, 12)
  };
}

export async function confirmAndRunRealtimeAnalysisPlan({
  env,
  config,
  sessionId,
  planId,
  planNonce,
  expectedRevision
}) {
  const confirmed = await confirmRealtimeAnalysisPlan(env, {
    sessionId,
    planId,
    planNonce,
    profileRevision: expectedRevision
  });
  if (confirmed.idempotentReplay) {
    return {
      analysisPlan: toPublicRealtimeAnalysisPlan(confirmed.row),
      result: confirmed.result,
      idempotentReplay: true
    };
  }

  try {
    await markRealtimeAnalysisPlanRunning(env, sessionId, planId);
    const sessionRow = await getSessionRow(env, sessionId);
    if (!sessionRow || Number(sessionRow.current_profile_revision) !== expectedRevision
      || Number(sessionRow.confirmed_profile_revision) !== expectedRevision) {
      throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed before the analysis started.');
    }
    const profile = await getCurrentProfile(env, sessionRow);
    const run = await runStoredConsumerAnalysis({
      env,
      config,
      sessionRow,
      profile,
      moduleIds: confirmed.input.moduleIds,
      scenarioOverrides: confirmed.input.scenarioOverrides
    });
    const result = boundedSpeakableResult(run.analysis, config);
    const completed = await completeRealtimeAnalysisPlan(env, {
      sessionId,
      planId,
      status: 'complete',
      result,
      analysisRunId: run.analysis.id
    });
    if (completed.realtime_session_id) {
      await recordRealtimeRunProvenance(env, {
        leaseId: completed.realtime_session_id,
        sessionId,
        analysisRunId: run.analysis.id,
        profileRevision: expectedRevision,
        promptVersion: config.realtimePromptVersion,
        toolsetVersion: config.realtimeToolsetVersion
      });
    }
    return {
      analysisPlan: toPublicRealtimeAnalysisPlan(completed),
      analysis: run.analysis,
      result,
      idempotentReplay: false
    };
  } catch (error) {
    if (error instanceof ConsumerError && error.code === 'analysis_missing_information') {
      const result = {
        speakableText: 'More information is needed before the deterministic analysis can run.',
        promptVersion: config.realtimePromptVersion,
        toolsetVersion: config.realtimeToolsetVersion,
        calculationVersion: null,
        completedModuleIds: []
      };
      const pending = await completeRealtimeAnalysisPlan(env, {
        sessionId,
        planId,
        status: 'needs_information',
        result,
        analysisRunId: error.details?.analysis?.id || null,
        errorCode: error.code
      });
      return {
        analysisPlan: toPublicRealtimeAnalysisPlan(pending),
        analysis: error.details?.analysis || null,
        requiredQuestions: error.details?.requiredQuestions || [],
        result,
        idempotentReplay: false
      };
    }
    await completeRealtimeAnalysisPlan(env, {
      sessionId,
      planId,
      status: 'failed',
      result: {
        speakableText: '',
        promptVersion: config.realtimePromptVersion,
        toolsetVersion: config.realtimeToolsetVersion,
        calculationVersion: null,
        completedModuleIds: []
      },
      errorCode: error instanceof ConsumerError ? error.code : 'analysis_failed'
    }).catch(() => {});
    throw error;
  }
}
