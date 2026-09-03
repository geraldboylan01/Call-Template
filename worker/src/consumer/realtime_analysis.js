import { runStoredConsumerAnalysis, runStoredConsumerAnalysisWithInputs } from './analysis.js';
import { ConsumerError } from './errors.js';
import {
  MODULE_FAILURE_CODES,
  clientFailureMessage
} from '../../../js/planning/module_failures.js';
import { getCurrentProfile, getSessionRow } from './repository.js';
import { consumerLanguageForModule } from '../../../js/planning/module_offers.js';
import { describeConversationState } from './conversation.js';
import { buildGoalModulePlan } from '../../../js/planning/goal_plan.js';
import {
  resolveConfirmationCandidateModuleIds,
  resolveExecutionModuleIds
} from './planning_context.js';
import {
  completeRealtimeAnalysisPlan,
  confirmRealtimeAnalysisPlan,
  getLatestRealtimeMeetingBrief,
  markRealtimeAnalysisPlanRunning,
  prepareRealtimeAnalysisPlan,
  recordRealtimeRunProvenance,
  toPublicRealtimeAnalysisPlan
} from './realtime_repository.js';
import { verifyDirectModuleCertificate } from './direct_module_planner.js';

export async function prepareRealtimeVoiceAnalysisPlan({
  env,
  config,
  sessionRow,
  profile,
  leaseId,
  idempotencyKey
}) {
  if (config.modulePlannerMode === 'apply') {
    const latest = await getLatestRealtimeMeetingBrief(env, sessionRow.id, leaseId);
    const brief = latest?.brief;
    const snapshot = brief?.schemaVersion === 'MeetingBriefV3' ? brief.directModuleSnapshot : null;
    const certificate = brief?.verificationCertificate || null;
    if (!snapshot || brief.readyToConfirm !== true
      || Number(certificate?.profileRevision) !== Number(sessionRow.current_profile_revision)
      || !(await verifyDirectModuleCertificate(env, certificate, snapshot, null, {
        config,
        calculationDateIso: profile.assumptions.calculationDateIso,
        baseCurrency: profile.preferences.baseCurrency,
        currentProfileContext: profile
      }))) {
      throw new ConsumerError(409, 'module_planning_pending', 'The background module inputs still need review before confirmation.');
    }
    const ready = snapshot.modules.filter((item) => item.status === 'ready');
    const moduleInputs = Object.fromEntries(ready.map((item) => [item.moduleId, item.input]));
    if (ready.length === 0) throw new ConsumerError(409, 'analysis_plan_empty', 'Clarify a supported goal before preparing this analysis.');
    const planInput = {
      moduleIds: ready.map((item) => item.moduleId),
      scenarioOverrides: {},
      directModuleSnapshot: snapshot,
      verificationCertificate: certificate,
      moduleInputs,
      inputSource: 'verified_direct_module_input'
    };
    const prepared = await prepareRealtimeAnalysisPlan(env, {
      sessionId: sessionRow.id,
      leaseId,
      idempotencyKey: `${idempotencyKey}:module-snapshot-${snapshot.snapshotRevision}`,
      profileRevision: Number(sessionRow.current_profile_revision),
      ...planInput
    });
    return {
      row: prepared.row,
      planNonce: prepared.planNonce,
      publicPlan: toPublicRealtimeAnalysisPlan(prepared.row, planInput),
      moduleIds: planInput.moduleIds,
      idempotentReplay: prepared.idempotentReplay
    };
  }
  const planningState = describeConversationState(profile, config);
  if (planningState.requiresDecisionTopicQuestion) {
    throw new ConsumerError(409, 'decision_topic_required', 'Name the specific financial decision before confirming the analysis plan.');
  }
  if (planningState.requiresGoalPriorityQuestion) {
    throw new ConsumerError(409, 'goal_priority_required', 'Choose which explicit goal the analysis plan should address first.');
  }
  if (!(planningState.moduleSlots || []).length) {
    throw new ConsumerError(409, 'analysis_plan_empty', 'Clarify a supported goal before preparing this analysis.');
  }
  // The set read out to the client for confirmation — see D15 in
  // docs/agent-testing-parity-contract.md §4. This was an inline copy of the
  // then-current executionModuleIds rule that was never updated when that rule
  // was tightened; it is now the named shared rule, shared with the agent
  // transport. Behaviour is unchanged.
  const moduleIds = resolveConfirmationCandidateModuleIds(planningState, config);
  const planInput = {
    moduleIds,
    scenarioOverrides: {},
    selectionPolicyVersion: planningState.selectionPolicyVersion,
    goalAssessment: planningState.goalAssessment,
    moduleSlots: planningState.moduleSlots,
    requiresGoalPriorityQuestion: planningState.requiresGoalPriorityQuestion,
    deferredGoalTypes: planningState.deferredGoalTypes
  };
  const prepared = await prepareRealtimeAnalysisPlan(env, {
    sessionId: sessionRow.id,
    leaseId,
    idempotencyKey,
    profileRevision: Number(sessionRow.current_profile_revision),
    ...planInput
  });
  return {
    row: prepared.row,
    planNonce: prepared.planNonce,
    publicPlan: toPublicRealtimeAnalysisPlan(prepared.row, planInput),
    idempotentReplay: prepared.idempotentReplay
  };
}

function adviserReviewModules(moduleSlots) {
  return (Array.isArray(moduleSlots) ? moduleSlots : [])
    .filter((slot) => slot?.availability === 'adviser_review_required')
    .map((slot) => ({
      moduleId: slot.moduleId,
      description: consumerLanguageForModule(slot.moduleId)?.shortDescription || ''
    }))
    // Fail closed: an analysis with no approved client descriptor is omitted
    // entirely, including from the consumer-facing gated id list.
    .filter((item) => typeof item.moduleId === 'string' && item.description)
    .slice(0, 3);
}

function joinedNames(names) {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

export function buildGatedModuleDisclosure(moduleSlots, { allGated = false } = {}) {
  const modules = adviserReviewModules(moduleSlots);
  if (modules.length === 0) {
    return { moduleIds: [], speakableText: '' };
  }
  const descriptions = modules.map((item) => item.description);
  const describedSubject = joinedNames(descriptions);
  const subject = `${describedSubject[0].toUpperCase()}${describedSubject.slice(1)}`;
  const speakableText = allGated
    ? `Your analysis plan is saved. ${subject} ${modules.length === 1 ? 'requires' : 'require'} Gerry’s review, so no automated financial result has been produced for ${modules.length === 1 ? 'that analysis' : 'those analyses'}.`
    : `${subject} ${modules.length === 1 ? 'remains' : 'remain'} in your analysis plan and ${modules.length === 1 ? 'requires' : 'require'} Gerry’s review; no automated result was produced for ${modules.length === 1 ? 'that analysis' : 'those analyses'}.`;
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
    // D-01 fail-closed guard: the prepared plan may only run if it is still
    // exactly the set the client confirmed. The revision checks above already
    // make divergence unreachable in normal operation (any planning write nulls
    // confirmed_profile_revision), so this can fire only if the confirmed set
    // and the prepared set genuinely disagree — in which case running either
    // one would be running something the client did not authorise.
    const directInput = confirmed.input.inputSource === 'verified_direct_module_input';
    if (directInput) {
      const latest = await getLatestRealtimeMeetingBrief(
        env,
        sessionId,
        confirmed.row.realtime_session_id
      );
      if (latest?.brief?.schemaVersion !== 'MeetingBriefV3'
        || Number(latest.brief.snapshotRevision) !== Number(confirmed.input.directModuleSnapshot?.snapshotRevision)
        || latest.brief.verificationCertificate?.signature !== confirmed.input.verificationCertificate?.signature) {
        throw new ConsumerError(409, 'module_snapshot_revision_conflict', 'The module inputs changed after the plan was prepared. Review and confirm them again.');
      }
    }
    const executionModuleIds = directInput
      ? Object.keys(confirmed.input.moduleInputs || {})
      : resolveExecutionModuleIds(
          buildGoalModulePlan(profile, { allowedModuleIds: config.allowedModules })
        );
    const preparedModuleIds = Array.isArray(confirmed.input.moduleIds) ? confirmed.input.moduleIds : [];
    if ([...preparedModuleIds].sort().join('|') !== [...executionModuleIds].sort().join('|')) {
      throw new ConsumerError(
        409,
        'analysis_plan_not_confirmed',
        'The confirmed analyses no longer match the prepared plan. Review and confirm the plan again.'
      );
    }
    if (!Array.isArray(confirmed.input.moduleIds) || confirmed.input.moduleIds.length === 0) {
      const disclosure = buildGatedModuleDisclosure(confirmed.input.moduleSlots, { allGated: true });
      const result = {
        speakableText: disclosure.speakableText
          ? disclosure.speakableText
          : 'Your analysis plan is saved, but no analysis in it is released for automated calculation yet.',
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
    if (directInput && (
      !(await verifyDirectModuleCertificate(
        env,
        confirmed.input.verificationCertificate,
        confirmed.input.directModuleSnapshot,
        confirmed.input.moduleInputs,
        {
          config,
          calculationDateIso: profile.assumptions.calculationDateIso,
          baseCurrency: profile.preferences.baseCurrency,
          currentProfileContext: profile
        }
      ))
      || Number(confirmed.input.verificationCertificate?.profileRevision) !== expectedRevision
    )) {
      throw new ConsumerError(409, 'module_verification_invalid', 'The verified module inputs changed before analysis.');
    }
    const run = directInput
      ? await runStoredConsumerAnalysisWithInputs({
          env,
          config,
          sessionRow,
          profile,
          moduleInputs: confirmed.input.moduleInputs
        })
      : await runStoredConsumerAnalysis({
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
    // A module that broke gets its own terminal outcome. It is not retried as
    // a question to the client, and the engine's own diagnostic never travels:
    // only the failure code and a client-safe sentence leave this layer.
    if (error instanceof ConsumerError && error.code === 'analysis_module_failed') {
      const failureCode = error.details?.failureCode || MODULE_FAILURE_CODES.UNKNOWN;
      const result = {
        speakableText: clientFailureMessage(failureCode),
        promptVersion: config.realtimePromptVersion,
        toolsetVersion: config.realtimeToolsetVersion,
        calculationVersion: null,
        completedModuleIds: []
      };
      const failed = await completeRealtimeAnalysisPlan(env, {
        sessionId,
        planId,
        status: 'failed',
        result,
        analysisRunId: error.details?.analysis?.id || null,
        errorCode: failureCode
      });
      return {
        analysisPlan: toPublicRealtimeAnalysisPlan(failed, confirmed.input),
        analysis: error.details?.analysis || null,
        failureCode,
        failedModuleId: error.details?.failedModuleId || null,
        result,
        idempotentReplay: false
      };
    }
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
