import { ConsumerError } from './errors.js';
import {
  claimHandoffForLink,
  createHandoff,
  getHandoff,
  getLatestAnalysis,
  linkHandoff,
  markHandoffFailed,
  readHandoffPackage
} from './repository.js';
import { getRealtimeAnalysisPlanResult } from './realtime_repository.js';

async function getCurrentAdviserReviewOutcome(env, sessionRow) {
  const stored = await getRealtimeAnalysisPlanResult(env, sessionRow.id);
  if (!stored || stored.row.status !== 'complete'
    || Number(stored.row.profile_revision) !== Number(sessionRow.current_profile_revision)
    || Number(stored.row.profile_revision) !== Number(sessionRow.confirmed_profile_revision)) {
    return null;
  }
  const completedModuleIds = stored.result?.completedModuleIds;
  const gatedModuleIds = stored.result?.gatedModuleIds;
  if (!Array.isArray(completedModuleIds) || completedModuleIds.length !== 0
    || !Array.isArray(gatedModuleIds) || gatedModuleIds.length < 1 || gatedModuleIds.length > 3
    || gatedModuleIds.some((moduleId) => typeof moduleId !== 'string' || !moduleId)
    || new Set(gatedModuleIds).size !== gatedModuleIds.length) {
    return null;
  }
  return {
    id: null,
    profileRevision: Number(stored.row.profile_revision),
    status: 'complete',
    calculationPerformed: false,
    outcome: 'adviser_review_required',
    analysisPlan: {
      id: stored.row.id,
      status: 'complete',
      rulesVersion: null,
      calculationPerformed: false,
      outcome: 'adviser_review_required',
      selectedModules: gatedModuleIds.map((moduleId) => ({
        moduleId,
        status: 'adviser_review_required'
      }))
    }
  };
}

export function toPublicHandoff(row) {
  return {
    id: row.id,
    handoffId: row.id,
    status: row.status,
    recipient: row.recipient,
    consentPolicyVersion: row.consent_policy_version,
    policyUrl: row.policy_url,
    consentCapturedAt: row.consent_captured_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retentionPolicyId: row.retention_policy_id || null,
    retentionExpiresAt: row.retention_expires_at || null,
    packagePurgedAt: row.package_purged_at || null
  };
}

export async function requestAdviserHandoff({
  env,
  config,
  sessionRow,
  profile,
  handoff,
  createPipelineHandoff
}) {
  if (!config.handoffEnabled) {
    throw new ConsumerError(404, 'handoff_disabled', 'Adviser handoff is not available.');
  }
  if (handoff?.consent !== true) {
    throw new ConsumerError(400, 'handoff_consent_required', 'Explicit adviser handoff consent is required.');
  }
  if (!sessionRow.confirmed_profile_revision
    || Number(sessionRow.confirmed_profile_revision) !== Number(sessionRow.current_profile_revision)) {
    throw new ConsumerError(409, 'profile_confirmation_required', 'Confirm the current profile before requesting an adviser handoff.');
  }

  let row = await getHandoff(env, sessionRow.id);
  if (row && ['linked', 'delivered'].includes(row.status)) {
    return { handoff: toPublicHandoff(row), bookingUrl: config.bookingUrl, deliveryConfirmed: true, pipelineLinkPending: false };
  }
  if (row?.status === 'purged' || (row?.retention_expires_at && row.retention_expires_at <= new Date().toISOString())) {
    throw new ConsumerError(410, 'handoff_package_expired', 'The saved adviser handoff package has reached its retention deadline.');
  }
  if (row?.status === 'revoked') {
    throw new ConsumerError(410, 'handoff_revoked', 'This adviser handoff was withdrawn and cannot be retried.');
  }
  if (!row) {
    if (handoff.retry) {
      throw new ConsumerError(409, 'handoff_retry_unavailable', 'There is no saved adviser handoff to retry.');
    }
    const calculatedAnalysis = await getLatestAnalysis(
      env,
      sessionRow.id,
      sessionRow.confirmed_profile_revision,
      { completedOnly: true }
    );
    const analysis = calculatedAnalysis || await getCurrentAdviserReviewOutcome(env, sessionRow);
    if (!analysis) {
      throw new ConsumerError(409, 'current_analysis_required', 'Complete the confirmed analysis plan before sending it to an adviser.');
    }
    row = await createHandoff(env, sessionRow, handoff, profile, { analysis }, config);
  }

  if (typeof createPipelineHandoff !== 'function') {
    return { handoff: toPublicHandoff(row), bookingUrl: null, deliveryConfirmed: false, pipelineLinkPending: true };
  }
  const claimed = await claimHandoffForLink(env, sessionRow.id, row.id);
  if (!claimed) {
    const current = await getHandoff(env, sessionRow.id);
    if (current && ['linked', 'delivered'].includes(current.status)) {
      return { handoff: toPublicHandoff(current), bookingUrl: config.bookingUrl, deliveryConfirmed: true, pipelineLinkPending: false };
    }
    return { handoff: toPublicHandoff(current || row), bookingUrl: null, deliveryConfirmed: false, pipelineLinkPending: true };
  }
  row = claimed;
  const immutablePackage = await readHandoffPackage(env, row);
  try {
    const linked = await createPipelineHandoff({
      handoffId: row.id,
      fullName: immutablePackage.contact.fullName,
      email: immutablePackage.contact.email,
      phone: immutablePackage.contact.phone,
      requestedHelp: immutablePackage.requestedHelp,
      consentPolicyVersion: row.consent_policy_version,
      policyUrl: row.policy_url,
      consentCapturedAt: row.consent_captured_at,
      sharedDataDigestB64u: immutablePackage.consent.sharedDataDigestB64u,
      retentionPolicyId: row.retention_policy_id
    });
    row = await linkHandoff(
      env,
      sessionRow.id,
      row.id,
      claimed.linking_started_at,
      linked?.clientId,
      linked?.leadId
    );
    return { handoff: toPublicHandoff(row), bookingUrl: config.bookingUrl, deliveryConfirmed: true, pipelineLinkPending: false };
  } catch (error) {
    await markHandoffFailed(env, sessionRow.id, row.id, claimed.linking_started_at).catch(() => {});
    console.error('Consumer handoff pipeline link failed', {
      handoffId: row.id,
      error: error instanceof Error ? error.message : String(error)
    });
    const failed = await getHandoff(env, sessionRow.id).catch(() => row);
    throw new ConsumerError(
      502,
      'handoff_pipeline_unavailable',
      'Your handoff was saved, but it could not be placed in the adviser queue yet. Please try again.',
      { handoff: toPublicHandoff(failed), deliveryConfirmed: false, pipelineLinkPending: true }
    );
  }
}
