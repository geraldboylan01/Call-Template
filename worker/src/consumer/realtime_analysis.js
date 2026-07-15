import { runStoredConsumerAnalysis } from './analysis.js';
import { ConsumerError } from './errors.js';
import { getCurrentProfile, getSessionRow } from './repository.js';
import { getPlanningModuleDefinition } from '../../../js/planning/module_registry.js';
import {
  completeRealtimeAnalysisPlan,
  confirmRealtimeAnalysisPlan,
  markRealtimeAnalysisPlanRunning,
  recordRealtimeRunProvenance,
  toPublicRealtimeAnalysisPlan
} from './realtime_repository.js';

function adviserReviewModules(moduleSlots) {
  return (Array.isArray(moduleSlots) ? moduleSlots : [])
    .filter((slot) => slot?.availability === 'adviser_review_required')
    .map((slot) => ({
      moduleId: slot.moduleId,
      name: getPlanningModuleDefinition(slot.moduleId)?.name || slot.moduleId
    }))
    .filter((item) => typeof item.moduleId === 'string' && typeof item.name === 'string')
    .slice(0, 3);
}

function joinedNames(names) {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

export function buildGatedModuleDisclosure(moduleSlots, { allGated = false } = {}) {
  const modules = adviserReviewModules(moduleSlots);
  const names = modules.map((item) => item.name);
  if (names.length === 0) {
    return { moduleIds: [], speakableText: '' };
  }
  const subject = joinedNames(names);
  const speakableText = allGated
    ? `Your three-analysis plan is saved. ${subject} ${names.length === 1 ? 'requires' : 'require'} Gerry’s review, so no automated financial result has been produced for ${names.length === 1 ? 'that analysis' : 'those analyses'}.`
    : `${subject} ${names.length === 1 ? 'remains' : 'remain'} in your three-analysis plan and ${names.length === 1 ? 'requires' : 'require'} Gerry’s review; no automated result was produced for ${names.length === 1 ? 'that analysis' : 'those analyses'}.`;
  return { moduleIds: modules.map((item) => item.moduleId), speakableText };
}

function boundedSpeakableResult(analysis, config, moduleSlots = []) {
  const deterministicSummary = typeof analysis?.summary?.speakableText === 'string'
    ? analysis.summary.speakableText
    : '';
  const disclosure = buildGatedModuleDisclosure(moduleSlots);
  const speakableText = [deterministicSummary, disclosure.speakableText].filter(Boolean).join(' ');
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
      .slice(0, 12),
    gatedModuleIds: disclosure.moduleIds
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
      analysisPlan: toPublicRealtimeAnalysisPlan(confirmed.row, confirmed.input),
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
    if (!Array.isArray(confirmed.input.moduleIds) || confirmed.input.moduleIds.length === 0) {
      const disclosure = buildGatedModuleDisclosure(confirmed.input.moduleSlots, { allGated: true });
      const result = {
        speakableText: disclosure.speakableText
          ? disclosure.speakableText
          : 'Your three-analysis plan is saved, but no analysis in it is released for automated calculation yet.',
        promptVersion: config.realtimePromptVersion,
        toolsetVersion: config.realtimeToolsetVersion,
        calculationVersion: null,
        completedModuleIds: [],
        gatedModuleIds: disclosure.moduleIds
      };
      const completed = await completeRealtimeAnalysisPlan(env, {
        sessionId,
        planId,
        status: 'complete',
        result,
        analysisRunId: null
      });
      return {
        analysisPlan: toPublicRealtimeAnalysisPlan(completed, confirmed.input),
        analysis: null,
        result,
        idempotentReplay: false
      };
    }
    const run = await runStoredConsumerAnalysis({
      env,
      config,
      sessionRow,
      profile,
      moduleIds: confirmed.input.moduleIds,
      scenarioOverrides: confirmed.input.scenarioOverrides
    });
    const result = boundedSpeakableResult(run.analysis, config, confirmed.input.moduleSlots);
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
      analysisPlan: toPublicRealtimeAnalysisPlan(completed, confirmed.input),
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
        analysisPlan: toPublicRealtimeAnalysisPlan(pending, confirmed.input),
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
