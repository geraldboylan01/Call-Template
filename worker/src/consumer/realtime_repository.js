import { ConsumerError, notFound } from './errors.js';
import { redactSensitiveIdentifiers } from './validators.js';
import { sanitizeRealtimeEventPayload } from './realtime_event_schema.js';
import { toPublicGoalAssessment } from '../../../js/planning/goal_plan.js';
import { normalizePlanningNoteV1 } from '../../../js/planning/reconciliation.js';
import {
  applyModuleDeferral,
  applyModuleReplacement,
  consumerLanguageForModule
} from '../../../js/planning/module_offers.js';
import {
  constantTimeEqual,
  decryptJson,
  encryptJson,
  hmacSha256Base64Url,
  randomId,
  sha256Base64Url,
  stableStringify
} from './crypto.js';

function db(env) {
  if (!env.CONSUMER_DB) {
    throw new ConsumerError(503, 'consumer_storage_unavailable', 'This planning journey is not available right now.');
  }
  return env.CONSUMER_DB;
}

function nowIso() {
  return new Date().toISOString();
}

function safeInteger(value) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function planningNoteAad(sessionId, leaseId, noteId) {
  return `consumer/planning-note/${sessionId}/${leaseId}/${noteId}`;
}

function plannerReconciliationInputAad(sessionId, leaseId, reconciliationId) {
  return `consumer/planner-reconciliation/${sessionId}/${leaseId}/${reconciliationId}/input`;
}

function plannerReconciliationOutputAad(sessionId, leaseId, reconciliationId) {
  return `consumer/planner-reconciliation/${sessionId}/${leaseId}/${reconciliationId}/output`;
}

export function toPublicRealtimeConsent(row) {
  return row
    ? {
        granted: Number(row.granted) === 1,
        noticeId: row.notice_id,
        policyVersion: row.policy_version,
        privacyNoticeUrl: row.privacy_notice_url,
        capturedAt: row.captured_at,
        withdrawnAt: row.withdrawn_at || null,
        updatedAt: row.updated_at
      }
    : { granted: false };
}

export function toPublicRealtimeLease(row) {
  if (!row) return null;
  return {
    leaseId: row.id,
    status: row.status,
    model: row.model,
    voice: row.voice,
    reasoningEffort: row.reasoning_effort,
    promptVersion: row.prompt_version,
    toolsetVersion: row.toolset_version,
    pricingVersion: row.pricing_version,
    reservationMicroEur: safeInteger(row.reservation_eur_micros),
    dispatchStopMicroEur: safeInteger(row.dispatch_stop_eur_micros),
    startingProfileRevision: safeInteger(row.starting_profile_revision),
    latestProfileRevision: safeInteger(row.latest_profile_revision),
    hardExpiresAt: row.hard_expires_at,
    idleExpiresAt: row.idle_expires_at,
    responseCount: safeInteger(row.response_count),
    toolCallCount: safeInteger(row.tool_call_count),
    estimatedCostMicroEur: safeInteger(row.estimated_cost_eur_micros),
    closeReason: row.close_reason || null,
    errorCode: row.error_code || null,
    createdAt: row.created_at,
    activatedAt: row.activated_at || null,
    lastActiveAt: row.last_active_at,
    endedAt: row.ended_at || null,
    meetingPhase: row.meeting_phase || 'discovery',
    analysisPlanId: row.completion_analysis_plan_id || null,
    completionProfileRevision: row.completion_profile_revision === null
      || typeof row.completion_profile_revision === 'undefined'
      ? null
      : safeInteger(row.completion_profile_revision),
    navigationTarget: row.completion_navigation_target || null,
    outroSpeechId: row.completion_outro_speech_id || null
  };
}

export async function getRealtimeConsent(env, sessionId) {
  return db(env).prepare(`
    SELECT session_id, granted, notice_id, data_policy_id, policy_version,
           privacy_notice_url, captured_at, withdrawn_at, updated_at,
           last_event_id
    FROM consumer_realtime_consents
    WHERE session_id = ?
    LIMIT 1
  `).bind(sessionId).first();
}

export function realtimeConsentIsCurrent(row, config) {
  return Boolean(
    row
    && Number(row.granted) === 1
    && row.notice_id === config.realtimeNoticeId
    && row.data_policy_id === config.realtimeDataPolicyId
    && row.policy_version === config.consentPolicyVersion
    && row.privacy_notice_url === config.privacyNoticeUrl
    && !row.withdrawn_at
  );
}

export async function setRealtimeConsent(env, sessionRow, config, granted) {
  const timestamp = nowIso();
  const eventId = randomId('realtime_consent');
  if (!granted) {
    await db(env).batch([
      db(env).prepare(`
        UPDATE consumer_realtime_consents
        SET granted = 0, withdrawn_at = ?, updated_at = ?, last_event_id = ?
        WHERE session_id = ? AND granted = 1
          AND EXISTS (
            SELECT 1 FROM consumer_sessions
            WHERE id = ? AND deleted_at IS NULL
          )
      `).bind(timestamp, timestamp, eventId, sessionRow.id, sessionRow.id),
      db(env).prepare(`
        INSERT INTO consumer_realtime_consent_events (
          id, session_id, action, notice_id, data_policy_id, policy_version,
          privacy_notice_url, capture_method, occurred_at
        )
        SELECT ?, session_id, 'withdrawn', notice_id, data_policy_id,
               policy_version, privacy_notice_url,
               'consumer_explicit_realtime_control', ?
        FROM consumer_realtime_consents
        WHERE session_id = ? AND last_event_id = ?
      `).bind(eventId, timestamp, sessionRow.id, eventId)
    ]);
    return getRealtimeConsent(env, sessionRow.id);
  }

  await db(env).batch([
    db(env).prepare(`
      INSERT INTO consumer_realtime_consents (
        session_id, granted, notice_id, data_policy_id, policy_version,
        privacy_notice_url, captured_at, withdrawn_at, updated_at,
        last_event_id
      )
      SELECT ?, 1, ?, ?, ?, ?, ?, NULL, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM consumer_sessions
        WHERE id = ? AND deleted_at IS NULL
          AND status IN ('active', 'completed')
          AND provider_cost_limit_eur_micros >= 2000000
      )
      ON CONFLICT(session_id) DO UPDATE SET
        granted = 1,
        notice_id = excluded.notice_id,
        data_policy_id = excluded.data_policy_id,
        policy_version = excluded.policy_version,
        privacy_notice_url = excluded.privacy_notice_url,
        captured_at = excluded.captured_at,
        withdrawn_at = NULL,
        updated_at = excluded.updated_at,
        last_event_id = excluded.last_event_id
      WHERE consumer_realtime_consents.granted <> 1
        OR consumer_realtime_consents.notice_id <> excluded.notice_id
        OR consumer_realtime_consents.data_policy_id <> excluded.data_policy_id
        OR consumer_realtime_consents.policy_version <> excluded.policy_version
        OR consumer_realtime_consents.privacy_notice_url <> excluded.privacy_notice_url
        OR consumer_realtime_consents.withdrawn_at IS NOT NULL
    `).bind(
      sessionRow.id,
      config.realtimeNoticeId,
      config.realtimeDataPolicyId,
      config.consentPolicyVersion,
      config.privacyNoticeUrl,
      timestamp,
      timestamp,
      eventId,
      sessionRow.id
    ),
    db(env).prepare(`
      INSERT INTO consumer_realtime_consent_events (
        id, session_id, action, notice_id, data_policy_id, policy_version,
        privacy_notice_url, capture_method, occurred_at
      )
      SELECT ?, session_id, 'granted', notice_id, data_policy_id,
             policy_version, privacy_notice_url,
             'consumer_explicit_realtime_control', ?
      FROM consumer_realtime_consents
      WHERE session_id = ? AND last_event_id = ?
    `).bind(eventId, timestamp, sessionRow.id, eventId)
  ]);
  const row = await getRealtimeConsent(env, sessionRow.id);
  if (!row) {
    throw new ConsumerError(409, 'realtime_budget_unavailable', 'Realtime voice is not available for this saved session. Start a new adviser-test session.');
  }
  return row;
}

export const REALTIME_CONSENT_PURPOSES = Object.freeze([
  'live_voice_processing',
  'automated_planning_analysis',
  'redacted_turn_retention'
]);

export const REQUIRED_REALTIME_CONSENT_PURPOSES = Object.freeze([
  'live_voice_processing',
  'automated_planning_analysis'
]);

export async function getRealtimeConsentPurposes(env, sessionId) {
  const result = await db(env).prepare(`
    SELECT session_id, purpose, granted, notice_id, data_policy_id,
           policy_version, privacy_notice_url, captured_at, withdrawn_at,
           updated_at, last_event_id
    FROM consumer_realtime_consent_purposes
    WHERE session_id = ?
    ORDER BY purpose ASC
  `).bind(sessionId).all();
  return result.results || [];
}

function realtimePurposeConsentIsCurrent(row, config) {
  return Boolean(
    row
    && Number(row.granted) === 1
    && row.notice_id === config.realtimeNoticeId
    && row.data_policy_id === config.realtimeDataPolicyId
    && row.policy_version === config.consentPolicyVersion
    && row.privacy_notice_url === config.privacyNoticeUrl
    && !row.withdrawn_at
  );
}

export function realtimePurposeConsentsAreCurrent(rows, config) {
  const byPurpose = new Map((rows || []).map((row) => [row.purpose, row]));
  return REQUIRED_REALTIME_CONSENT_PURPOSES.every((purpose) => (
    realtimePurposeConsentIsCurrent(byPurpose.get(purpose), config)
  ));
}

export function realtimeRetentionConsentIsCurrent(rows, config) {
  const row = (rows || []).find((candidate) => candidate.purpose === 'redacted_turn_retention');
  return realtimePurposeConsentIsCurrent(row, config);
}

export function toPublicRealtimeConsentPurposes(rows) {
  const byPurpose = new Map((rows || []).map((row) => [row.purpose, row]));
  return Object.fromEntries(REALTIME_CONSENT_PURPOSES.map((purpose) => {
    const row = byPurpose.get(purpose);
    return [purpose, row
      ? {
          granted: Number(row.granted) === 1,
          noticeId: row.notice_id,
          policyVersion: row.policy_version,
          privacyNoticeUrl: row.privacy_notice_url,
          capturedAt: row.captured_at,
          withdrawnAt: row.withdrawn_at || null,
          updatedAt: row.updated_at
        }
      : { granted: false }];
  }));
}

// This domain operation is intentionally not wired to the current bundled
// consent endpoint. The UI must present each purpose independently before an
// API route may call it; until then the existing receipt remains authoritative.
export async function setRealtimeConsentPurposes(env, sessionRow, config, decisions) {
  if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) {
    throw new ConsumerError(400, 'realtime_consent_purposes_invalid', 'Live voice consent purposes are invalid.');
  }
  const entries = Object.entries(decisions);
  if (!entries.length || entries.some(([purpose, granted]) => (
    !REALTIME_CONSENT_PURPOSES.includes(purpose) || typeof granted !== 'boolean'
  ))) {
    throw new ConsumerError(400, 'realtime_consent_purposes_invalid', 'Live voice consent purposes are invalid.');
  }
  const timestamp = nowIso();
  const statements = [];
  for (const [purpose, granted] of entries) {
    const eventId = randomId('realtime_purpose_consent');
    const action = granted ? 'granted' : 'withdrawn';
    statements.push(
      db(env).prepare(`
        INSERT INTO consumer_realtime_consent_purposes (
          session_id, purpose, granted, notice_id, data_policy_id,
          policy_version, privacy_notice_url, captured_at, withdrawn_at,
          updated_at, last_event_id
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM consumer_sessions
          WHERE id = ? AND deleted_at IS NULL
            AND status IN ('active', 'completed')
        )
        ON CONFLICT(session_id, purpose) DO UPDATE SET
          granted = excluded.granted,
          notice_id = excluded.notice_id,
          data_policy_id = excluded.data_policy_id,
          policy_version = excluded.policy_version,
          privacy_notice_url = excluded.privacy_notice_url,
          captured_at = CASE
            WHEN excluded.granted = 1 THEN excluded.captured_at
            ELSE consumer_realtime_consent_purposes.captured_at
          END,
          withdrawn_at = excluded.withdrawn_at,
          updated_at = excluded.updated_at,
          last_event_id = excluded.last_event_id
        WHERE consumer_realtime_consent_purposes.granted <> excluded.granted
          OR consumer_realtime_consent_purposes.notice_id <> excluded.notice_id
          OR consumer_realtime_consent_purposes.data_policy_id <> excluded.data_policy_id
          OR consumer_realtime_consent_purposes.policy_version <> excluded.policy_version
          OR consumer_realtime_consent_purposes.privacy_notice_url <> excluded.privacy_notice_url
          OR (excluded.granted = 1 AND consumer_realtime_consent_purposes.withdrawn_at IS NOT NULL)
          OR (excluded.granted = 0 AND consumer_realtime_consent_purposes.withdrawn_at IS NULL)
      `).bind(
        sessionRow.id,
        purpose,
        granted ? 1 : 0,
        config.realtimeNoticeId,
        config.realtimeDataPolicyId,
        config.consentPolicyVersion,
        config.privacyNoticeUrl,
        timestamp,
        granted ? null : timestamp,
        timestamp,
        eventId,
        sessionRow.id
      ),
      db(env).prepare(`
        INSERT INTO consumer_realtime_consent_purpose_events (
          id, session_id, purpose, action, notice_id, data_policy_id,
          policy_version, privacy_notice_url, capture_method, occurred_at
        )
        SELECT ?, session_id, purpose, ?, notice_id, data_policy_id,
               policy_version, privacy_notice_url,
               'consumer_explicit_realtime_purpose_control', ?
        FROM consumer_realtime_consent_purposes
        WHERE session_id = ? AND purpose = ? AND last_event_id = ?
      `).bind(eventId, action, timestamp, sessionRow.id, purpose, eventId)
    );
  }
  await db(env).batch(statements);
  return getRealtimeConsentPurposes(env, sessionRow.id);
}

export async function createRealtimeLease(
  env,
  sessionRow,
  config,
  providerCostEntry,
  controlTokenHashB64u = null,
  activationIdHashB64u = null
) {
  const timestamp = nowIso();
  const hardExpiresAt = new Date(Date.now() + config.realtimeMaxDurationSeconds * 1_000).toISOString();
  const idleExpiresAt = new Date(Date.now() + config.realtimeIdleTimeoutSeconds * 1_000).toISOString();
  const id = randomId('rt');
  const invite = await db(env).prepare(`
    SELECT uses.jti_hash_b64u
    FROM consumer_invite_uses AS uses
    INNER JOIN consumer_invite_redemptions AS redemptions
      ON redemptions.jti_hash_b64u = uses.jti_hash_b64u
    WHERE uses.session_id = ? AND redemptions.revoked_at IS NULL
      AND redemptions.expires_at > ?
    LIMIT 1
  `).bind(sessionRow.id, timestamp).first();
  if (!invite?.jti_hash_b64u) {
    throw new ConsumerError(403, 'realtime_invite_required', 'This protected live voice invitation is no longer active.');
  }
  if (activationIdHashB64u) {
    const existingActivation = await getRealtimeLeaseByActivationHash(
      env,
      sessionRow.id,
      activationIdHashB64u
    );
    if (existingActivation) {
      throw new ConsumerError(409, 'realtime_activation_already_used', 'That live voice activation id was already used.');
    }
  }
  try {
    const row = await db(env).prepare(`
      INSERT INTO consumer_realtime_sessions (
        id, session_id, provider_cost_id, provider, provider_call_id_hash_b64u,
        provider_call_id_encrypted, status, model, voice, reasoning_effort,
        prompt_version, toolset_version, pricing_version,
        reservation_eur_micros, dispatch_stop_eur_micros,
        starting_profile_revision, latest_profile_revision,
        hard_expires_at, idle_expires_at, last_event_sequence,
        response_count, tool_call_count, estimated_cost_eur_micros,
        close_reason, error_code, created_at, activated_at,
        last_active_at, ended_at, control_token_hash_b64u,
        invite_jti_hash_b64u, activation_id_hash_b64u
      )
      SELECT ?, ?, ?, 'openai', NULL, NULL, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, 0, 0, 0, 0, NULL, NULL, ?, NULL, ?, NULL, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM consumer_sessions AS sessions
        INNER JOIN consumer_realtime_consents AS consent
          ON consent.session_id = sessions.id
        INNER JOIN consumer_provider_costs AS costs
          ON costs.id = ? AND costs.session_id = sessions.id
        WHERE sessions.id = ? AND sessions.deleted_at IS NULL
          AND sessions.status IN ('active', 'completed')
          AND consent.granted = 1
          AND consent.notice_id = ?
          AND consent.data_policy_id = ?
          AND consent.policy_version = ?
          AND consent.privacy_notice_url = ?
          AND consent.withdrawn_at IS NULL
          AND costs.status = 'reserved' AND costs.dispatched_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM consumer_invite_uses AS uses
            INNER JOIN consumer_invite_redemptions AS redemptions
              ON redemptions.jti_hash_b64u = uses.jti_hash_b64u
            WHERE uses.session_id = sessions.id
              AND uses.jti_hash_b64u = ?
              AND redemptions.revoked_at IS NULL
              AND redemptions.expires_at > ?
          )
      )
      RETURNING *
    `).bind(
      id,
      sessionRow.id,
      providerCostEntry.id,
      config.realtimeModel,
      config.realtimeVoice,
      config.realtimeReasoningEffort,
      config.realtimePromptVersion,
      config.realtimeToolsetVersion,
      config.realtimePricingVersion,
      safeInteger(providerCostEntry.reservedCostEurMicros),
      Math.max(0, safeInteger(providerCostEntry.reservedCostEurMicros) - config.realtimeSafetyReserveMicroEur),
      Number(sessionRow.current_profile_revision),
      Number(sessionRow.current_profile_revision),
      hardExpiresAt,
      idleExpiresAt,
      timestamp,
      timestamp,
      controlTokenHashB64u,
      invite.jti_hash_b64u,
      activationIdHashB64u,
      providerCostEntry.id,
      sessionRow.id,
      config.realtimeNoticeId,
      config.realtimeDataPolicyId,
      config.consentPolicyVersion,
      config.privacyNoticeUrl,
      invite.jti_hash_b64u,
      timestamp
    ).first();
    if (!row) {
      throw new ConsumerError(403, 'realtime_consent_required', 'Review and accept the current live voice disclosure before starting.');
    }
    return row;
  } catch (error) {
    if (error instanceof ConsumerError) throw error;
    const active = await getActiveRealtimeLease(env, sessionRow.id).catch(() => null);
    if (active) {
      throw new ConsumerError(409, 'realtime_call_active', 'A live voice call is already active for this planning session.');
    }
    const existingActivation = activationIdHashB64u
      ? await getRealtimeLeaseByActivationHash(env, sessionRow.id, activationIdHashB64u).catch(() => null)
      : null;
    if (existingActivation) {
      throw new ConsumerError(409, 'realtime_activation_already_used', 'That live voice activation id was already used.');
    }
    throw error;
  }
}

export async function getRealtimeLease(env, sessionId, leaseId) {
  return db(env).prepare(`
    SELECT * FROM consumer_realtime_sessions
    WHERE id = ? AND session_id = ?
    LIMIT 1
  `).bind(leaseId, sessionId).first();
}

export async function getRealtimeLeaseByActivationHash(env, sessionId, activationIdHashB64u) {
  const value = typeof activationIdHashB64u === 'string' ? activationIdHashB64u.trim() : '';
  if (!value || value.length > 64 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  return db(env).prepare(`
    SELECT * FROM consumer_realtime_sessions
    WHERE session_id = ? AND activation_id_hash_b64u = ?
    LIMIT 1
  `).bind(sessionId, value).first();
}

export async function getActiveRealtimeLease(env, sessionId) {
  return db(env).prepare(`
    SELECT * FROM consumer_realtime_sessions
    WHERE session_id = ? AND channel = 'voice' AND status IN ('pending', 'active', 'closing')
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(sessionId).first();
}

export async function getLatestRealtimeLease(env, sessionId) {
  return db(env).prepare(`
    SELECT * FROM consumer_realtime_sessions
    WHERE session_id = ? AND channel = 'voice'
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(sessionId).first();
}

/**
 * What the server can actually prove about a meeting, PER LANE.
 *
 * The v1/v2 lanes and the live lane write different event types for the same
 * physical milestones, because they are driven by different Durable Objects:
 * `realtime.*` from realtime_session.js, `live.*` from live/live_session.js.
 * A live meeting therefore satisfies NONE of the three original columns — its
 * sideband is up, but under `live.provider.connected`, and its tool surface is
 * save_facts/get_state/confirm_and_run, so `get_planning_state` can never
 * succeed. Collapsing the two vocabularies into one column would make a lane
 * that never ran look proven, so each lane keeps its own.
 */
export const LIVE_TOOL_NAMES = Object.freeze(['save_facts', 'get_state', 'confirm_and_run']);

export async function getRealtimeControlPlaneProof(env, sessionId, leaseId) {
  const row = await db(env).prepare(`
    SELECT
      EXISTS (
        SELECT 1 FROM consumer_realtime_events
        WHERE session_id = ? AND realtime_session_id = ?
          AND event_type = 'realtime.provider.connected'
      ) AS sideband_connected,
      EXISTS (
        SELECT 1 FROM consumer_realtime_tool_attempts
        WHERE session_id = ? AND realtime_session_id = ?
          AND tool_name = 'get_planning_state' AND status = 'succeeded'
          AND completed_at IS NOT NULL
      ) AS read_only_tool_succeeded,
      EXISTS (
        SELECT 1 FROM consumer_realtime_events
        WHERE session_id = ? AND realtime_session_id = ?
          AND event_type = 'realtime.response.completed'
      ) AS initial_welcome_succeeded,
      EXISTS (
        SELECT 1 FROM consumer_realtime_events
        WHERE session_id = ? AND realtime_session_id = ?
          AND event_type = 'live.call.activated'
      ) AS live_call_activated,
      EXISTS (
        SELECT 1 FROM consumer_realtime_events
        WHERE session_id = ? AND realtime_session_id = ?
          AND event_type = 'live.provider.connected'
      ) AS live_sideband_connected,
      EXISTS (
        SELECT 1 FROM consumer_realtime_events
        WHERE session_id = ? AND realtime_session_id = ?
          AND event_type = 'live.response.completed'
      ) AS live_response_completed,
      EXISTS (
        SELECT 1 FROM consumer_realtime_tool_attempts
        WHERE session_id = ? AND realtime_session_id = ?
          AND tool_name IN (${LIVE_TOOL_NAMES.map((name) => `'${name}'`).join(', ')})
          AND status = 'succeeded' AND completed_at IS NOT NULL
      ) AS live_tool_succeeded
  `).bind(
    sessionId, leaseId,
    sessionId, leaseId,
    sessionId, leaseId,
    sessionId, leaseId,
    sessionId, leaseId,
    sessionId, leaseId,
    sessionId, leaseId
  ).first();
  return {
    sidebandConnected: Number(row?.sideband_connected) === 1,
    readOnlyToolSucceeded: Number(row?.read_only_tool_succeeded) === 1,
    initialWelcomeSucceeded: Number(row?.initial_welcome_succeeded) === 1,
    // The live lane's activation and sideband are deterministic: both are
    // written before the client can say anything. A completed live response
    // and a completed live tool call are NOT — this lane never sends
    // `response.create`, so the model speaks when the client does. They are
    // reported for diagnosis; the activation proof does not wait on them.
    liveCallActivated: Number(row?.live_call_activated) === 1,
    liveSidebandConnected: Number(row?.live_sideband_connected) === 1,
    liveResponseCompleted: Number(row?.live_response_completed) === 1,
    liveToolSucceeded: Number(row?.live_tool_succeeded) === 1
  };
}

export async function markRealtimeProviderCostInFlight(env, entryId, sessionId, config) {
  const timestamp = nowIso();
  const updated = await db(env).prepare(`
    UPDATE consumer_provider_costs
    SET dispatched_at = ?
    WHERE id = ? AND session_id = ?
      AND status = 'reserved' AND dispatched_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM consumer_sessions AS sessions
        INNER JOIN consumer_realtime_consents AS consent
          ON consent.session_id = sessions.id
        INNER JOIN consumer_realtime_sessions AS realtime
          ON realtime.provider_cost_id = consumer_provider_costs.id
        WHERE sessions.id = consumer_provider_costs.session_id
          AND sessions.deleted_at IS NULL
          AND sessions.status IN ('active', 'completed')
          AND realtime.status = 'pending'
          AND consent.granted = 1
          AND consent.notice_id = ?
          AND consent.data_policy_id = ?
          AND consent.policy_version = ?
          AND consent.privacy_notice_url = ?
          AND consent.withdrawn_at IS NULL
      )
    RETURNING *
  `).bind(
    timestamp,
    entryId,
    sessionId,
    config.realtimeNoticeId,
    config.realtimeDataPolicyId,
    config.consentPolicyVersion,
    config.privacyNoticeUrl
  ).first();
  if (updated) return updated;
  const existing = await db(env).prepare(`
    SELECT * FROM consumer_provider_costs WHERE id = ? AND session_id = ? LIMIT 1
  `).bind(entryId, sessionId).first();
  if (existing?.status === 'reserved' && existing.dispatched_at) return existing;
  throw new ConsumerError(403, 'realtime_consent_required', 'Live voice consent changed before provider dispatch.');
}

export async function activateRealtimeLease(env, sessionId, leaseId, providerCallId) {
  const timestamp = nowIso();
  const [providerCallIdHash, providerCallEncrypted] = await Promise.all([
    sha256Base64Url(providerCallId),
    encryptJson(env, { providerCallId }, `consumer/realtime/session/${sessionId}/${leaseId}/provider-call`)
  ]);
  const row = await db(env).prepare(`
    UPDATE consumer_realtime_sessions
    SET provider_call_id_hash_b64u = ?, provider_call_id_encrypted = ?,
        status = 'active', activated_at = ?, last_active_at = ?
    WHERE id = ? AND session_id = ? AND status = 'pending'
      AND EXISTS (
        SELECT 1 FROM consumer_provider_costs
        WHERE id = consumer_realtime_sessions.provider_cost_id
          AND status = 'reserved' AND dispatched_at IS NOT NULL
      )
    RETURNING *
  `).bind(providerCallIdHash, providerCallEncrypted, timestamp, timestamp, leaseId, sessionId).first();
  if (!row) throw new ConsumerError(409, 'realtime_lease_conflict', 'The live voice lease is no longer available.');
  return row;
}

export async function closeRealtimeLease(env, sessionId, leaseId, status, reason, errorCode = null) {
  const terminal = new Set(['complete', 'failed', 'withdrawn', 'budget_exhausted', 'expired', 'deleted']);
  if (!terminal.has(status)) throw new Error('Invalid realtime terminal status.');
  const timestamp = nowIso();
  const row = await db(env).prepare(`
    UPDATE consumer_realtime_sessions
    SET status = ?, close_reason = ?, error_code = ?, last_active_at = ?, ended_at = ?
    WHERE id = ? AND session_id = ? AND status IN ('pending', 'active', 'closing')
    RETURNING *
  `).bind(status, reason, errorCode, timestamp, timestamp, leaseId, sessionId).first();
  await db(env).prepare(`
    UPDATE consumer_realtime_control_messages
    SET status = 'cancelled', consumed_at = ?, error_code = ?
    WHERE realtime_session_id = ? AND session_id = ?
      AND status IN ('pending', 'delivered', 'processing')
  `).bind(timestamp, errorCode || reason || 'realtime_lease_closed', leaseId, sessionId).run().catch(() => {});
  return row || getRealtimeLease(env, sessionId, leaseId);
}

export async function verifyRealtimeControlCapability(env, sessionId, leaseId, token, {
  requireActive = true,
  requireInviteActive = requireActive
} = {}) {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!/^rt_control_[A-Za-z0-9_-]{20,80}$/.test(value)) return null;
  const row = await getRealtimeLease(env, sessionId, leaseId);
  if (!row?.control_token_hash_b64u) return null;
  if (!row.invite_jti_hash_b64u) return null;
  if (requireActive && !['pending', 'active', 'closing'].includes(row.status)) return null;
  if (requireInviteActive) {
    const binding = await db(env).prepare(`
      SELECT 1 AS bound
      FROM consumer_invite_uses AS uses
      INNER JOIN consumer_invite_redemptions AS redemptions
        ON redemptions.jti_hash_b64u = uses.jti_hash_b64u
      WHERE uses.session_id = ? AND uses.jti_hash_b64u = ?
        AND redemptions.revoked_at IS NULL AND redemptions.expires_at > ?
      LIMIT 1
    `).bind(sessionId, row.invite_jti_hash_b64u, nowIso()).first();
    if (!binding) return null;
  }
  const actual = await sha256Base64Url(value);
  return constantTimeEqual(row.control_token_hash_b64u, actual) ? row : null;
}

function realtimeControlAad(sessionId, leaseId, messageId) {
  return `consumer/realtime/control/${sessionId}/${leaseId}/${messageId}`;
}

export async function enqueueRealtimeControlMessage(env, {
  sessionId,
  leaseId,
  authorization
}) {
  const timestamp = nowIso();
  const id = randomId('realtime_control_message');
  const payloadHash = await sha256Base64Url(stableStringify(authorization));
  const [payloadEncrypted, speechIdHash] = await Promise.all([
    encryptJson(env, authorization, realtimeControlAad(sessionId, leaseId, id)),
    sha256Base64Url(authorization.speechId)
  ]);
  const row = await db(env).prepare(`
    INSERT INTO consumer_realtime_control_messages (
      id, realtime_session_id, session_id, control_id, speech_id_hash_b64u,
      payload_encrypted, payload_hash_b64u, profile_revision, status,
      created_at, expires_at, first_delivered_at, last_delivered_at,
      delivery_count, consumed_at, error_code
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, 0, NULL, NULL
    WHERE EXISTS (
      SELECT 1 FROM consumer_realtime_sessions
      WHERE id = ? AND session_id = ? AND status = 'active'
        AND control_token_hash_b64u IS NOT NULL
        AND invite_jti_hash_b64u IS NOT NULL
        AND latest_profile_revision = ?
        AND hard_expires_at > ?
        AND EXISTS (
          SELECT 1
          FROM consumer_invite_uses AS uses
          INNER JOIN consumer_invite_redemptions AS redemptions
            ON redemptions.jti_hash_b64u = uses.jti_hash_b64u
          WHERE uses.session_id = consumer_realtime_sessions.session_id
            AND uses.jti_hash_b64u = consumer_realtime_sessions.invite_jti_hash_b64u
            AND redemptions.revoked_at IS NULL AND redemptions.expires_at > ?
        )
    )
    RETURNING *
  `).bind(
    id,
    leaseId,
    sessionId,
    authorization.controlId,
    speechIdHash,
    payloadEncrypted,
    payloadHash,
    authorization.profileRevision,
    timestamp,
    authorization.expiresAt,
    leaseId,
    sessionId,
    authorization.profileRevision,
    timestamp,
    timestamp
  ).first();
  if (!row) {
    throw new ConsumerError(409, 'realtime_lease_conflict', 'The live voice lease cannot accept an approved response.');
  }
  return row;
}

export async function getNextRealtimeControlMessage(env, sessionId, leaseId) {
  const timestamp = nowIso();
  await db(env).prepare(`
    UPDATE consumer_realtime_control_messages
    SET status = 'expired', consumed_at = ?, error_code = 'realtime_control_expired'
    WHERE realtime_session_id = ? AND session_id = ?
      AND status IN ('pending', 'delivered') AND expires_at <= ?
  `).bind(timestamp, leaseId, sessionId, timestamp).run();
  const row = await db(env).prepare(`
    SELECT messages.*
    FROM consumer_realtime_control_messages AS messages
    INNER JOIN consumer_realtime_sessions AS leases
      ON leases.id = messages.realtime_session_id
      AND leases.session_id = messages.session_id
    INNER JOIN consumer_invite_uses AS invite_uses
      ON invite_uses.session_id = leases.session_id
      AND invite_uses.jti_hash_b64u = leases.invite_jti_hash_b64u
    INNER JOIN consumer_invite_redemptions AS invite_redemptions
      ON invite_redemptions.jti_hash_b64u = invite_uses.jti_hash_b64u
    WHERE messages.realtime_session_id = ? AND messages.session_id = ?
      AND messages.status IN ('pending', 'delivered')
      AND messages.expires_at > ?
      AND leases.status = 'active'
      AND invite_redemptions.revoked_at IS NULL
      AND invite_redemptions.expires_at > ?
    ORDER BY messages.created_at ASC
    LIMIT 1
  `).bind(leaseId, sessionId, timestamp, timestamp).first();
  if (!row) return null;
  const authorization = await decryptJson(
    env,
    row.payload_encrypted,
    realtimeControlAad(sessionId, leaseId, row.id)
  );
  const actualHash = await sha256Base64Url(stableStringify(authorization));
  if (!constantTimeEqual(actualHash, row.payload_hash_b64u)
    || authorization.controlId !== row.control_id
    || authorization.expiresAt !== row.expires_at) {
    await finalizeRealtimeControlMessage(env, {
      sessionId,
      leaseId,
      controlId: row.control_id,
      status: 'failed',
      errorCode: 'realtime_control_payload_invalid'
    });
    throw new ConsumerError(500, 'realtime_control_payload_invalid', 'The approved voice command could not be verified.');
  }
  const delivered = await db(env).prepare(`
    UPDATE consumer_realtime_control_messages
    SET status = 'delivered',
        first_delivered_at = COALESCE(first_delivered_at, ?),
        last_delivered_at = ?, delivery_count = delivery_count + 1
    WHERE id = ? AND realtime_session_id = ? AND session_id = ?
      AND status IN ('pending', 'delivered') AND expires_at > ?
    RETURNING delivery_count
  `).bind(timestamp, timestamp, row.id, leaseId, sessionId, timestamp).first();
  if (!delivered) return null;
  return {
    type: 'authorized_speech',
    controlId: row.control_id,
    expiresAt: row.expires_at,
    deliveryAttempt: Number(delivered.delivery_count || 1),
    assistantSpeech: authorization
  };
}

export async function cancelPendingRealtimeControlMessages(env, {
  sessionId,
  leaseId,
  errorCode = 'consumer_barge_in'
}) {
  const timestamp = nowIso();
  const boundedErrorCode = String(errorCode || 'consumer_barge_in').slice(0, 120);
  const result = await db(env).prepare(`
    UPDATE consumer_realtime_control_messages
    SET status = 'cancelled', consumed_at = ?, error_code = ?
    WHERE realtime_session_id = ? AND session_id = ?
      AND status IN ('pending', 'delivered')
  `).bind(timestamp, boundedErrorCode, leaseId, sessionId).run();
  return Number(result?.meta?.changes || 0);
}

export async function assertRealtimeControlMessage(env, {
  sessionId,
  leaseId,
  authorization
}) {
  const timestamp = nowIso();
  const controlId = typeof authorization?.controlId === 'string' ? authorization.controlId : '';
  const row = await db(env).prepare(`
    SELECT * FROM consumer_realtime_control_messages
    WHERE realtime_session_id = ? AND session_id = ? AND control_id = ?
    LIMIT 1
  `).bind(leaseId, sessionId, controlId).first();
  if (!row) throw new ConsumerError(403, 'realtime_control_mismatch', 'The approved voice command is not bound to this call.');
  if (['processing', 'consumed', 'failed'].includes(row.status)) {
    throw new ConsumerError(409, 'realtime_control_replayed', 'That approved voice command was already processed.');
  }
  if (!['pending', 'delivered'].includes(row.status) || row.expires_at <= timestamp) {
    if (['pending', 'delivered'].includes(row.status)) {
      await finalizeRealtimeControlMessage(env, {
        sessionId,
        leaseId,
        controlId,
        status: 'expired',
        errorCode: 'realtime_control_expired'
      });
    }
    throw new ConsumerError(410, 'realtime_control_expired', 'That approved voice command has expired.');
  }
  const payloadHash = await sha256Base64Url(stableStringify(authorization));
  if (!constantTimeEqual(payloadHash, row.payload_hash_b64u)) {
    throw new ConsumerError(403, 'realtime_control_mismatch', 'The approved voice command does not match this call.');
  }
  return row;
}

export async function claimRealtimeControlMessage(env, {
  sessionId,
  leaseId,
  controlId
}) {
  const timestamp = nowIso();
  const row = await db(env).prepare(`
    UPDATE consumer_realtime_control_messages
    SET status = 'processing',
        first_delivered_at = COALESCE(first_delivered_at, ?),
        last_delivered_at = COALESCE(last_delivered_at, ?)
    WHERE realtime_session_id = ? AND session_id = ? AND control_id = ?
      AND status IN ('pending', 'delivered') AND expires_at > ?
      AND EXISTS (
        SELECT 1 FROM consumer_realtime_sessions
        WHERE id = ? AND session_id = ? AND status = 'active'
          AND EXISTS (
            SELECT 1
            FROM consumer_invite_uses AS uses
            INNER JOIN consumer_invite_redemptions AS redemptions
              ON redemptions.jti_hash_b64u = uses.jti_hash_b64u
            WHERE uses.session_id = consumer_realtime_sessions.session_id
              AND uses.jti_hash_b64u = consumer_realtime_sessions.invite_jti_hash_b64u
              AND redemptions.revoked_at IS NULL AND redemptions.expires_at > ?
          )
      )
    RETURNING *
  `).bind(
    timestamp,
    timestamp,
    leaseId,
    sessionId,
    controlId,
    timestamp,
    leaseId,
    sessionId,
    timestamp
  ).first();
  if (!row) {
    throw new ConsumerError(409, 'realtime_control_replayed', 'That approved voice command is already being processed.');
  }
  return row;
}

export async function finalizeRealtimeControlMessage(env, {
  sessionId,
  leaseId,
  controlId,
  status,
  errorCode = null
}) {
  if (!['consumed', 'expired', 'cancelled', 'failed'].includes(status)) {
    throw new Error('Invalid realtime control terminal status.');
  }
  const timestamp = nowIso();
  return db(env).prepare(`
    UPDATE consumer_realtime_control_messages
    SET status = ?, consumed_at = ?, error_code = ?
    WHERE realtime_session_id = ? AND session_id = ? AND control_id = ?
      AND status IN ('pending', 'delivered', 'processing')
    RETURNING *
  `).bind(status, timestamp, errorCode, leaseId, sessionId, controlId).first();
}

export async function touchRealtimeLease(env, sessionId, leaseId, idleTimeoutSeconds) {
  const timestamp = nowIso();
  const idleExpiresAt = new Date(Date.now() + idleTimeoutSeconds * 1_000).toISOString();
  return db(env).prepare(`
    UPDATE consumer_realtime_sessions
    SET last_active_at = ?, idle_expires_at = ?
    WHERE id = ? AND session_id = ? AND status = 'active'
    RETURNING *
  `).bind(timestamp, idleExpiresAt, leaseId, sessionId).first();
}

export async function appendRealtimeEvent(env, request) {
  const eventType = String(request.eventType || '').slice(0, 120);
  const payload = sanitizeRealtimeEventPayload(eventType, request.payload);
  if (payload === null) return null;
  const timestamp = nowIso();
  const sequenceRow = await db(env).prepare(`
    UPDATE consumer_realtime_sessions
    SET last_event_sequence = last_event_sequence + 1, last_active_at = ?
    WHERE id = ? AND session_id = ? AND status IN ('active', 'closing')
    RETURNING last_event_sequence
  `).bind(timestamp, request.leaseId, request.sessionId).first();
  if (!sequenceRow) return null;
  const sequence = safeInteger(sequenceRow.last_event_sequence);
  const providerEventIdHash = request.providerEventId
    ? await sha256Base64Url(String(request.providerEventId))
    : null;
  const hasPayload = Object.keys(payload).length > 0;
  const [payloadEncrypted, payloadHash] = !hasPayload
    ? [null, null]
    : await Promise.all([
        encryptJson(env, payload, `consumer/realtime/event/${request.sessionId}/${request.leaseId}/${sequence}`),
        sha256Base64Url(stableStringify(payload))
      ]);
  const id = randomId('realtime_event');
  try {
    await db(env).prepare(`
      INSERT INTO consumer_realtime_events (
        id, realtime_session_id, session_id, sequence,
        provider_event_id_hash_b64u, direction, event_type,
        payload_encrypted, payload_hash_b64u, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      request.leaseId,
      request.sessionId,
      sequence,
      providerEventIdHash,
      request.direction,
      eventType,
      payloadEncrypted,
      payloadHash,
      timestamp
    ).run();
  } catch (_error) {
    // Provider event identifiers are idempotency keys. A replay is not an
    // error and payloads must not be logged while resolving it.
    return null;
  }
  return { id, sequence };
}

function usageToken(value) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number >= 0 && number <= 100_000_000 ? number : 0;
}

export function estimateRealtimeUsageMicroEur(tokens, rates) {
  const priced = [
    ['inputTextTokens', 'textInput'],
    ['cachedTextTokens', 'textCachedInput'],
    ['outputTextTokens', 'textOutput'],
    ['inputAudioTokens', 'audioInput'],
    ['cachedAudioTokens', 'audioCachedInput'],
    ['outputAudioTokens', 'audioOutput'],
    ['transcriptionInputTokens', 'transcriptionInput'],
    ['transcriptionOutputTokens', 'transcriptionOutput']
  ];
  return priced.reduce((total, [tokenKey, rateKey]) => (
    total + Math.ceil((usageToken(tokens[tokenKey]) * safeInteger(rates[rateKey])) / 1_000_000)
  ), 0);
}

export function estimateRealtimeSpeechMicroEur(characterCount, rateMicroEurPerMillionCharacters) {
  const characters = safeInteger(characterCount);
  const rate = safeInteger(rateMicroEurPerMillionCharacters);
  if (characters < 1 || characters > 2_400 || rate < 1) {
    throw new ConsumerError(400, 'realtime_speech_cost_invalid', 'The approved spoken response could not be priced safely.');
  }
  return Math.ceil((characters * rate) / 1_000_000);
}

async function refreshRealtimeLeaseEstimatedCost(env, sessionId, leaseId) {
  const timestamp = nowIso();
  return db(env).prepare(`
    UPDATE consumer_realtime_sessions
    SET estimated_cost_eur_micros =
          COALESCE((
            SELECT SUM(estimated_cost_eur_micros)
            FROM consumer_realtime_usage
            WHERE realtime_session_id = ?
          ), 0)
          + COALESCE((
            SELECT SUM(estimated_cost_eur_micros)
            FROM consumer_realtime_speech_usage
            WHERE realtime_session_id = ? AND status <> 'not_sent'
          ), 0),
        last_active_at = ?
    WHERE id = ? AND session_id = ? AND status IN ('active', 'closing')
    RETURNING *
  `).bind(leaseId, leaseId, timestamp, leaseId, sessionId).first();
}

async function realtimeSpeechHashes(env, speechId, bindingId, text) {
  return Promise.all([
    hmacSha256Base64Url(
      env.CONSUMER_RATE_LIMIT_HASH_KEY,
      `consumer/realtime/speech/id/v1/${String(speechId)}`
    ),
    hmacSha256Base64Url(
      env.CONSUMER_RATE_LIMIT_HASH_KEY,
      `consumer/realtime/speech/binding/v1/${String(bindingId)}`
    ),
    sha256Base64Url(String(text))
  ]);
}

export async function reserveRealtimeSpeechUsage(env, request) {
  const [speechHash, bindingHash, contentHash] = await realtimeSpeechHashes(
    env,
    request.speechId,
    request.bindingId,
    request.text
  );
  const estimatedCost = estimateRealtimeSpeechMicroEur(
    String(request.text).length,
    request.rateMicroEurPerMillionCharacters
  );
  const id = randomId('realtime_speech_usage');
  const timestamp = nowIso();
  await db(env).prepare(`
    INSERT OR IGNORE INTO consumer_realtime_speech_usage (
      id, realtime_session_id, session_id, speech_id_hash_b64u,
      binding_id_hash_b64u, content_hash_b64u, speech_kind,
      profile_revision, character_count, estimated_cost_eur_micros,
      pricing_version, status, provider_request_id_hash_b64u,
      error_code, created_at, dispatched_at, completed_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, NULL, ?, NULL, NULL
    WHERE EXISTS (
      SELECT 1
      FROM consumer_realtime_sessions AS realtime
      INNER JOIN consumer_sessions AS sessions ON sessions.id = realtime.session_id
      INNER JOIN consumer_realtime_consents AS consent ON consent.session_id = sessions.id
      WHERE realtime.id = ? AND realtime.session_id = ? AND realtime.status = 'active'
        AND sessions.deleted_at IS NULL AND sessions.status IN ('active', 'completed')
        AND sessions.current_profile_revision = ?
        AND realtime.latest_profile_revision = ?
        AND consent.granted = 1 AND consent.notice_id = ?
        AND consent.data_policy_id = ? AND consent.policy_version = ?
        AND consent.privacy_notice_url = ? AND consent.withdrawn_at IS NULL
        AND (
          COALESCE((
            SELECT SUM(estimated_cost_eur_micros)
            FROM consumer_realtime_usage
            WHERE realtime_session_id = realtime.id
          ), 0)
          + COALESCE((
            SELECT SUM(estimated_cost_eur_micros)
            FROM consumer_realtime_speech_usage
            WHERE realtime_session_id = realtime.id AND status <> 'not_sent'
          ), 0)
          + ?
        ) <= realtime.dispatch_stop_eur_micros
    )
  `).bind(
    id,
    request.leaseId,
    request.sessionId,
    speechHash,
    bindingHash,
    contentHash,
    request.kind,
    request.profileRevision,
    String(request.text).length,
    estimatedCost,
    request.pricingVersion,
    timestamp,
    request.leaseId,
    request.sessionId,
    request.profileRevision,
    request.profileRevision,
    request.noticeId,
    request.dataPolicyId,
    request.policyVersion,
    request.privacyNoticeUrl,
    estimatedCost
  ).run();
  const row = await db(env).prepare(`
    SELECT * FROM consumer_realtime_speech_usage
    WHERE realtime_session_id = ? AND speech_id_hash_b64u = ?
    LIMIT 1
  `).bind(request.leaseId, speechHash).first();
  if (!row) return { row: null, existing: false, denied: true, estimatedCostMicroEur: estimatedCost };
  if (row.id !== id) {
    if (row.session_id !== request.sessionId
      || row.binding_id_hash_b64u !== bindingHash
      || row.content_hash_b64u !== contentHash
      || row.speech_kind !== request.kind
      || Number(row.profile_revision) !== Number(request.profileRevision)
      || Number(row.estimated_cost_eur_micros) !== estimatedCost
      || row.pricing_version !== request.pricingVersion) {
      throw new ConsumerError(409, 'realtime_speech_replay_conflict', 'The approved speech reference was reused with different content.');
    }
    return { row, existing: true, denied: false, estimatedCostMicroEur: estimatedCost };
  }
  await refreshRealtimeLeaseEstimatedCost(env, request.sessionId, request.leaseId);
  return { row, existing: false, denied: false, estimatedCostMicroEur: estimatedCost };
}

export async function markRealtimeSpeechDispatched(env, request) {
  const timestamp = nowIso();
  const row = await db(env).prepare(`
    UPDATE consumer_realtime_speech_usage
    SET status = 'dispatched', dispatched_at = ?
    WHERE id = ? AND realtime_session_id = ? AND session_id = ? AND status = 'reserved'
      AND EXISTS (
        SELECT 1
        FROM consumer_realtime_sessions AS realtime
        INNER JOIN consumer_sessions AS sessions ON sessions.id = realtime.session_id
        INNER JOIN consumer_realtime_consents AS consent ON consent.session_id = sessions.id
        WHERE realtime.id = consumer_realtime_speech_usage.realtime_session_id
          AND realtime.session_id = consumer_realtime_speech_usage.session_id
          AND realtime.status = 'active'
          AND sessions.deleted_at IS NULL AND sessions.status IN ('active', 'completed')
          AND sessions.current_profile_revision = consumer_realtime_speech_usage.profile_revision
          AND realtime.latest_profile_revision = consumer_realtime_speech_usage.profile_revision
          AND consent.granted = 1 AND consent.notice_id = ?
          AND consent.data_policy_id = ? AND consent.policy_version = ?
          AND consent.privacy_notice_url = ? AND consent.withdrawn_at IS NULL
          AND realtime.estimated_cost_eur_micros <= realtime.dispatch_stop_eur_micros
      )
    RETURNING *
  `).bind(
    timestamp,
    request.usageId,
    request.leaseId,
    request.sessionId,
    request.noticeId,
    request.dataPolicyId,
    request.policyVersion,
    request.privacyNoticeUrl
  ).first();
  if (!row) {
    throw new ConsumerError(409, 'realtime_speech_dispatch_denied', 'The live voice lease changed before approved speech could be generated.');
  }
  return row;
}

export async function finalizeRealtimeSpeechUsage(env, request) {
  const status = request.status === 'known'
    ? 'known'
    : request.status === 'not_sent'
      ? 'not_sent'
      : 'unknown';
  const timestamp = nowIso();
  const providerRequestHash = request.providerRequestId
    ? await sha256Base64Url(String(request.providerRequestId))
    : null;
  const errorCode = typeof request.errorCode === 'string'
    && /^[A-Za-z0-9._:-]{1,120}$/.test(request.errorCode)
    ? request.errorCode
    : null;
  const requiredPriorStatus = status === 'not_sent' ? 'reserved' : 'dispatched';
  const row = await db(env).prepare(`
    UPDATE consumer_realtime_speech_usage
    SET status = ?, provider_request_id_hash_b64u = ?, error_code = ?, completed_at = ?
    WHERE id = ? AND realtime_session_id = ? AND session_id = ?
      AND status IN (?, ?)
    RETURNING *
  `).bind(
    status,
    providerRequestHash,
    errorCode,
    timestamp,
    request.usageId,
    request.leaseId,
    request.sessionId,
    requiredPriorStatus,
    status
  ).first();
  await refreshRealtimeLeaseEstimatedCost(env, request.sessionId, request.leaseId);
  return row;
}

export async function hasUnsettledRealtimeSpeechUsage(env, sessionId, leaseId) {
  const row = await db(env).prepare(`
    SELECT 1 AS present
    FROM consumer_realtime_speech_usage
    WHERE session_id = ? AND realtime_session_id = ?
      AND status IN ('reserved', 'dispatched', 'unknown')
    LIMIT 1
  `).bind(sessionId, leaseId).first();
  return Number(row?.present || 0) === 1;
}

export async function recordRealtimeUsage(env, request) {
  const responseHash = await sha256Base64Url(String(request.providerResponseId));
  const tokens = {
    inputTextTokens: usageToken(request.tokens.inputTextTokens),
    inputAudioTokens: usageToken(request.tokens.inputAudioTokens),
    cachedTextTokens: usageToken(request.tokens.cachedTextTokens),
    cachedAudioTokens: usageToken(request.tokens.cachedAudioTokens),
    outputTextTokens: usageToken(request.tokens.outputTextTokens),
    outputAudioTokens: usageToken(request.tokens.outputAudioTokens),
    transcriptionInputTokens: usageToken(request.tokens.transcriptionInputTokens),
    transcriptionOutputTokens: usageToken(request.tokens.transcriptionOutputTokens)
  };
  const estimatedCost = estimateRealtimeUsageMicroEur(tokens, request.rates);
  const usageId = randomId('realtime_usage');
  const timestamp = nowIso();
  await db(env).batch([
    db(env).prepare(`
      INSERT OR IGNORE INTO consumer_realtime_usage (
        id, realtime_session_id, session_id, provider_response_id_hash_b64u, usage_kind,
        input_text_tokens, input_audio_tokens, cached_text_tokens,
        cached_audio_tokens, output_text_tokens, output_audio_tokens,
        transcription_input_tokens, transcription_output_tokens,
        estimated_cost_eur_micros, pricing_version, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      usageId,
      request.leaseId,
      request.sessionId,
      responseHash,
      request.usageKind === 'transcription'
        ? 'transcription'
        : request.usageKind === 'planner'
          ? 'planner'
          : 'response',
      tokens.inputTextTokens,
      tokens.inputAudioTokens,
      tokens.cachedTextTokens,
      tokens.cachedAudioTokens,
      tokens.outputTextTokens,
      tokens.outputAudioTokens,
      tokens.transcriptionInputTokens,
      tokens.transcriptionOutputTokens,
      estimatedCost,
      request.pricingVersion,
      timestamp
    ),
    db(env).prepare(`
      UPDATE consumer_realtime_sessions
      SET response_count = (
            SELECT COUNT(*) FROM consumer_realtime_usage
            WHERE realtime_session_id = ? AND usage_kind = 'response'
          ),
          estimated_cost_eur_micros = COALESCE((
            SELECT SUM(estimated_cost_eur_micros) FROM consumer_realtime_usage
            WHERE realtime_session_id = ?
          ), 0) + COALESCE((
            SELECT SUM(estimated_cost_eur_micros) FROM consumer_realtime_speech_usage
            WHERE realtime_session_id = ? AND status <> 'not_sent'
          ), 0),
          last_active_at = ?
      WHERE id = ? AND session_id = ? AND status IN ('active', 'closing')
    `).bind(request.leaseId, request.leaseId, request.leaseId, timestamp, request.leaseId, request.sessionId)
  ]);
  const row = await getRealtimeLease(env, request.sessionId, request.leaseId);
  return {
    responseCount: safeInteger(row?.response_count),
    estimatedCostMicroEur: safeInteger(row?.estimated_cost_eur_micros)
  };
}

export async function recordRealtimeFinalTurn(env, request) {
  const raw = typeof request.transcript === 'string' ? request.transcript.trim() : '';
  if (!raw || raw.length > 12_000 || !['user', 'assistant'].includes(request.role)) {
    throw new ConsumerError(400, 'realtime_final_turn_invalid', 'The finalized voice turn is invalid.');
  }
  const transcript = redactSensitiveIdentifiers(raw).slice(0, 4_000);
  if (!transcript) throw new ConsumerError(400, 'realtime_final_turn_empty', 'The finalized voice turn is empty.');
  const providerItemHash = await sha256Base64Url(String(request.providerItemId));
  const existing = await db(env).prepare(`
    SELECT id FROM consumer_realtime_final_turns
    WHERE realtime_session_id = ? AND provider_item_id_hash_b64u = ? AND role = ?
    LIMIT 1
  `).bind(request.leaseId, providerItemHash, request.role).first();
  if (existing) return { id: existing.id, idempotentReplay: true };
  const id = randomId('realtime_turn');
  const [encrypted, transcriptHash] = await Promise.all([
    encryptJson(
      env,
      { transcript },
      `consumer/realtime/final-turn/${request.sessionId}/${request.leaseId}/${id}`
    ),
    sha256Base64Url(transcript)
  ]);
  try {
    await db(env).prepare(`
      INSERT INTO consumer_realtime_final_turns (
        id, realtime_session_id, session_id, provider_item_id_hash_b64u,
        role, transcript_encrypted, transcript_hash_b64u,
        sensitive_details_removed, created_at, meeting_sequence
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?,
          COALESCE((
            SELECT MAX(meeting_sequence)
            FROM consumer_realtime_final_turns
            WHERE realtime_session_id = ?
          ), 0) + 1
    `).bind(
      id,
      request.leaseId,
      request.sessionId,
      providerItemHash,
      request.role,
      encrypted,
      transcriptHash,
      transcript !== raw ? 1 : 0,
      nowIso(),
      request.leaseId
    ).run();
  } catch (error) {
    const replay = await db(env).prepare(`
      SELECT id FROM consumer_realtime_final_turns
      WHERE realtime_session_id = ? AND provider_item_id_hash_b64u = ? AND role = ?
      LIMIT 1
    `).bind(request.leaseId, providerItemHash, request.role).first().catch(() => null);
    if (replay) return { id: replay.id, idempotentReplay: true };
    throw error;
  }
  return { id, transcript, sensitiveDetailsRemoved: transcript !== raw, idempotentReplay: false };
}

async function decryptRealtimeFinalTurnRows(env, sessionId, rows) {
  const turns = [];
  for (const row of rows || []) {
    const payload = await decryptJson(
      env,
      row.transcript_encrypted,
      `consumer/realtime/final-turn/${sessionId}/${row.realtime_session_id}/${row.id}`
    );
    turns.push({
      id: row.id,
      role: row.role,
      transcript: String(payload?.transcript || '').slice(0, 4_000),
      sensitiveDetailsRemoved: Number(row.sensitive_details_removed) === 1,
      sequence: safeInteger(row.meeting_sequence),
      createdAt: row.created_at
    });
  }
  return turns;
}

export async function listRealtimeFinalTurns(env, sessionId, leaseId, limit = 200) {
  const result = await db(env).prepare(`
    SELECT id, realtime_session_id, role, transcript_encrypted,
           sensitive_details_removed, created_at, meeting_sequence
    FROM consumer_realtime_final_turns
    WHERE session_id = ? AND realtime_session_id = ?
    ORDER BY meeting_sequence ASC, created_at ASC, id ASC
    LIMIT ?
  `).bind(sessionId, leaseId, Math.max(1, Math.min(200, limit))).all();
  return decryptRealtimeFinalTurnRows(env, sessionId, result.results);
}

export async function listRecentRealtimeFinalTurns(env, sessionId, leaseId, limit = 8) {
  // Apply the bound to the newest rows in SQL, then restore chronological
  // order before handing the context window to a conversational model.
  const result = await db(env).prepare(`
    SELECT id, realtime_session_id, role, transcript_encrypted,
           sensitive_details_removed, created_at, meeting_sequence
    FROM consumer_realtime_final_turns
    WHERE session_id = ? AND realtime_session_id = ?
    ORDER BY meeting_sequence DESC, created_at DESC, id DESC
    LIMIT ?
  `).bind(sessionId, leaseId, Math.max(1, Math.min(200, limit))).all();
  return decryptRealtimeFinalTurnRows(env, sessionId, [...(result.results || [])].reverse());
}

/**
 * Return a bounded transcript window ending at one exact finalized client
 * turn. This prevents a delayed turn-N audit from consuming turn N+1 while
 * still carrying N's watermark. The assistant turn immediately before the
 * earliest selected client turn is retained as non-evidence question context.
 */
export async function listReconciliationTranscriptWindow(env, sessionId, leaseId, throughTurnId, {
  maxClientTurns = 8,
  referencedTurnIds = []
} = {}) {
  const allTurns = await listRealtimeFinalTurns(env, sessionId, leaseId, 200);
  const watermarkIndex = allTurns.findIndex((turn) => turn.id === throughTurnId);
  if (watermarkIndex < 0 || allTurns[watermarkIndex].role !== 'user') {
    throw new ConsumerError(409, 'planner_reconciliation_turn_missing', 'The client turn is not available for reconciliation.');
  }
  const throughWatermark = allTurns.slice(0, watermarkIndex + 1);
  const clientIndexes = throughWatermark
    .map((turn, index) => turn.role === 'user' ? index : -1)
    .filter((index) => index >= 0)
    .slice(-Math.max(1, Math.min(8, Number(maxClientTurns) || 8)));
  let start = clientIndexes[0] ?? watermarkIndex;
  if (start > 0 && throughWatermark[start - 1].role === 'assistant') start -= 1;
  const selectedIds = new Set(throughWatermark.slice(start).map((turn) => turn.id));
  for (const turnId of [...new Set(referencedTurnIds)].slice(0, 24)) {
    const index = throughWatermark.findIndex((turn) => turn.id === turnId);
    if (index >= 0) selectedIds.add(turnId);
  }
  return throughWatermark.filter((turn) => selectedIds.has(turn.id));
}

/** Encrypted accepted/rejected T1 write detail bounded to one client turn. */
export async function listRealtimeWriteOutcomes(env, sessionId, leaseId, throughTurnId, limit = 24) {
  const result = await db(env).prepare(`
    SELECT id, tool_name, tool_version, status, arguments_encrypted,
           result_encrypted, error_code, expected_profile_revision,
           profile_revision_after, created_at, completed_at
    FROM consumer_realtime_tool_attempts
    WHERE session_id = ? AND realtime_session_id = ?
      AND tool_name IN ('save_facts', 'silent_planner', 'propose_facts')
      AND source_turn_id = ?
      AND result_encrypted IS NOT NULL
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).bind(
    sessionId,
    leaseId,
    throughTurnId,
    Math.max(1, Math.min(48, Number(limit) || 24))
  ).all();
  const outcomes = [];
  for (const row of result.results || []) {
    const [argumentsValue, resultValue] = await Promise.all([
      decryptJson(
        env,
        row.arguments_encrypted,
        `consumer/realtime/tool/${sessionId}/${leaseId}/${row.id}/arguments`
      ),
      decryptJson(
        env,
        row.result_encrypted,
        `consumer/realtime/tool/${sessionId}/${leaseId}/${row.id}/result`
      )
    ]);
    outcomes.push({
      toolAttemptId: row.id,
      toolName: row.tool_name,
      toolVersion: row.tool_version,
      status: row.status,
      errorCode: row.error_code || null,
      expectedProfileRevision: row.expected_profile_revision === null
        ? null
        : Number(row.expected_profile_revision),
      profileRevisionAfter: row.profile_revision_after === null
        ? null
        : Number(row.profile_revision_after),
      arguments: argumentsValue,
      result: resultValue,
      createdAt: row.created_at,
      completedAt: row.completed_at
    });
  }
  return outcomes;
}

/**
 * Encrypt a normalized PlanningNoteV1 for use in the same D1 batch as the
 * profile revision it projects into. Keeping preparation separate lets the
 * caller build a conditional INSERT without ever exposing financial values in
 * plaintext columns or logs.
 */
async function preparePlanningNoteRecord(env, request) {
  const noteId = request.note?.noteId || randomId('planning_note');
  const createdAt = request.note?.createdAt || nowIso();
  const note = normalizePlanningNoteV1({
    ...request.note,
    noteId,
    createdAt,
    reviewedAt: request.note?.reviewedAt || null
  }, { nowIso: createdAt });
  const serialized = stableStringify(note);
  const [encrypted, hash] = await Promise.all([
    encryptJson(
      env,
      note,
      planningNoteAad(request.sessionId, request.leaseId, noteId)
    ),
    sha256Base64Url(serialized)
  ]);
  return {
    note,
    row: {
      id: noteId,
      sessionId: request.sessionId,
      leaseId: request.leaseId,
      noteKind: note.noteKind,
      lifecycle: note.lifecycle,
      reviewStatus: note.reviewStatus,
      source: note.source,
      profileRevision: Number(request.profileRevision),
      encrypted,
      hash,
      createdAt,
      reviewedAt: note.reviewedAt || null
    }
  };
}

async function createPlanningNote(env, request) {
  const prepared = await preparePlanningNoteRecord(env, request);
  const row = prepared.row;
  await db(env).prepare(`
    INSERT INTO consumer_planning_notes (
      id, session_id, realtime_session_id, note_kind, lifecycle,
      review_status, source, profile_revision, note_encrypted,
      note_hash_b64u, created_at, reviewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    row.id,
    row.sessionId,
    row.leaseId,
    row.noteKind,
    row.lifecycle,
    row.reviewStatus,
    row.source,
    row.profileRevision,
    row.encrypted,
    row.hash,
    row.createdAt,
    row.reviewedAt
  ).run();
  return prepared.note;
}

async function listPlanningNoteRecords(env, sessionId, leaseId, {
  lifecycle = null,
  limit = 200
} = {}) {
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 200));
  const result = await db(env).prepare(`
    SELECT id, realtime_session_id, profile_revision, lifecycle, note_encrypted
    FROM consumer_planning_notes
    WHERE session_id = ? AND realtime_session_id = ?
      AND (? IS NULL OR lifecycle = ?)
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).bind(sessionId, leaseId, lifecycle, lifecycle, boundedLimit).all();
  const records = [];
  for (const row of [...(result.results || [])].reverse()) {
    const note = await decryptJson(
      env,
      row.note_encrypted,
      planningNoteAad(sessionId, row.realtime_session_id, row.id)
    );
    records.push({ row, note });
  }
  return records;
}

export async function listPlanningNotes(env, sessionId, leaseId, options = {}) {
  const records = await listPlanningNoteRecords(env, sessionId, leaseId, options);
  return records.map((item) => item.note);
}

/**
 * Lazily seed evidence-less legacy notes for canonical profile facts that
 * predate the ledger. The profile revision predicate makes this a snapshot
 * import; a concurrent edit aborts the reconciliation instead of mixing eras.
 */
export async function ensureLegacyPlanningNotes(env, request) {
  const existing = await listPlanningNoteRecords(env, request.sessionId, request.leaseId, {
    lifecycle: 'active',
    limit: 500
  });
  const knownInstances = new Set(existing.map((item) => item.note.factInstanceId).filter(Boolean));
  const missing = (request.notes || []).filter((note) => (
    note?.source === 'legacy_import'
    && note.factInstanceId
    && !knownInstances.has(note.factInstanceId)
  ));
  if (missing.length === 0) return existing.map((item) => item.note);
  const prepared = await Promise.all(missing.map((note) => preparePlanningNoteRecord(env, {
    sessionId: request.sessionId,
    leaseId: request.leaseId,
    profileRevision: request.profileRevision,
    note
  })));
  const statements = prepared.map(({ row }) => db(env).prepare(`
    INSERT OR IGNORE INTO consumer_planning_notes (
      id, session_id, realtime_session_id, note_kind, lifecycle,
      review_status, source, profile_revision, note_encrypted,
      note_hash_b64u, created_at, reviewed_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM consumer_sessions
      WHERE id = ? AND deleted_at IS NULL AND current_profile_revision = ?
    ) AND EXISTS (
      SELECT 1 FROM consumer_realtime_sessions
      WHERE id = ? AND session_id = ? AND latest_profile_revision = ?
    )
  `).bind(
    row.id,
    row.sessionId,
    row.leaseId,
    row.noteKind,
    row.lifecycle,
    row.reviewStatus,
    row.source,
    row.profileRevision,
    row.encrypted,
    row.hash,
    row.createdAt,
    row.reviewedAt,
    request.sessionId,
    request.profileRevision,
    request.leaseId,
    request.sessionId,
    request.profileRevision
  ));
  await db(env).batch(statements);
  const lease = await db(env).prepare(`
    SELECT latest_profile_revision FROM consumer_realtime_sessions
    WHERE id = ? AND session_id = ? LIMIT 1
  `).bind(request.leaseId, request.sessionId).first();
  if (Number(lease?.latest_profile_revision) !== Number(request.profileRevision)) {
    throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed during legacy note import.');
  }
  const imported = await listPlanningNoteRecords(env, request.sessionId, request.leaseId, {
    lifecycle: 'active',
    limit: 500
  });
  const importedInstances = new Set(imported.map((item) => item.note.factInstanceId).filter(Boolean));
  if (missing.some((note) => !importedInstances.has(note.factInstanceId))) {
    throw new ConsumerError(409, 'planning_note_import_conflict', 'The legacy note snapshot could not be completed.');
  }
  return retireStaleLegacyPlanningNotes(env, request, imported.map((item) => item.note));
}

/**
 * Drop legacy snapshots of entities the profile no longer holds.
 *
 * A legacy note is a pure snapshot of profile state with no evidence of its
 * own, imported once and never revisited. When an aggregate placeholder was
 * reclassified as a stated summary, its position left `/pensions` -- but the
 * snapshot stayed active, so the retired placeholder went on supplying an
 * entity to the reconciler's catalogue AND a required `contribution status`
 * need for a pension that no longer existed. The client would have been asked
 * about a holding they never had.
 *
 * Only evidence-free `legacy_import` notes are retired here, and only when
 * their entity has genuinely left the profile. A note the client's own words
 * back is never touched by this.
 */
async function retireStaleLegacyPlanningNotes(env, request, notes) {
  const live = new Set(
    (request.notes || [])
      .map((note) => note.entityId)
      .filter(Boolean)
  );
  const stale = notes.filter((note) => (
    note.source === 'legacy_import'
    && note.lifecycle === 'active'
    && note.entityId
    && !live.has(note.entityId)
    && (note.evidenceRefs || []).length === 0
  ));
  if (stale.length === 0) return notes;
  const staleIds = new Set(stale.map((note) => note.noteId));
  await db(env).batch(stale.map((note) => db(env).prepare(`
    UPDATE consumer_planning_notes
    SET lifecycle = 'superseded'
    WHERE id = ? AND session_id = ? AND realtime_session_id = ? AND lifecycle = 'active'
  `).bind(note.noteId, request.sessionId, request.leaseId)));
  return notes.filter((note) => !staleIds.has(note.noteId));
}

/**
 * Begin one revision-bound reconciliation attempt. The idempotency hash is
 * scoped to the realtime meeting, so a worker retry returns the existing row
 * instead of spending on or applying the same audit twice.
 */
export async function startPlannerReconciliation(env, request) {
  const lease = await db(env).prepare(`
    SELECT planner_reconciliation_revision, latest_profile_revision
    FROM consumer_realtime_sessions
    WHERE id = ? AND session_id = ? AND status IN ('active', 'closing')
    LIMIT 1
  `).bind(request.leaseId, request.sessionId).first();
  if (!lease) throw notFound('This planning meeting could not be found.');
  if (Number(lease.latest_profile_revision) !== Number(request.baseProfileRevision)) {
    throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed before reconciliation began.');
  }
  const idempotencyHash = await sha256Base64Url(String(request.idempotencyKey));
  const existing = await db(env).prepare(`
    SELECT * FROM consumer_planner_reconciliations
    WHERE realtime_session_id = ? AND idempotency_key_hash_b64u = ?
    LIMIT 1
  `).bind(request.leaseId, idempotencyHash).first();
  if (existing) return { row: existing, replayed: true };

  const id = randomId('planner_reconciliation');
  const revision = safeInteger(lease.planner_reconciliation_revision) + 1;
  const timestamp = nowIso();
  const serialized = stableStringify(request.input);
  const [inputEncrypted, inputHash] = await Promise.all([
    encryptJson(
      env,
      request.input,
      plannerReconciliationInputAad(request.sessionId, request.leaseId, id)
    ),
    sha256Base64Url(serialized)
  ]);
  try {
    const results = await db(env).batch([
      db(env).prepare(`
        INSERT INTO consumer_planner_reconciliations (
          id, session_id, realtime_session_id, reconciliation_revision,
          base_profile_revision, through_turn_id, trigger, mode, status,
          idempotency_key_hash_b64u, input_encrypted, input_hash_b64u,
          prompt_version, created_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM consumer_realtime_sessions
          WHERE id = ? AND session_id = ?
            AND planner_reconciliation_revision = ?
            AND latest_profile_revision = ?
            AND status IN ('active', 'closing')
        )
      `).bind(
        id,
        request.sessionId,
        request.leaseId,
        revision,
        request.baseProfileRevision,
        request.throughTurnId,
        request.trigger,
        request.mode,
        idempotencyHash,
        inputEncrypted,
        inputHash,
        request.promptVersion,
        timestamp,
        request.leaseId,
        request.sessionId,
        revision - 1,
        request.baseProfileRevision
      ),
      db(env).prepare(`
        UPDATE consumer_realtime_sessions
        SET planner_reconciliation_revision = ?,
            planner_pending_through_turn_id = ?,
            planner_reconciliation_status = 'pending',
            last_active_at = ?
        WHERE id = ? AND session_id = ?
          AND planner_reconciliation_revision = ?
          AND latest_profile_revision = ?
          AND EXISTS (
            SELECT 1 FROM consumer_planner_reconciliations
            WHERE id = ? AND status = 'pending'
          )
      `).bind(
        revision,
        request.throughTurnId,
        timestamp,
        request.leaseId,
        request.sessionId,
        revision - 1,
        request.baseProfileRevision,
        id
      )
    ]);
    if (results.some((result) => Number(result?.meta?.changes || 0) !== 1)) {
      throw new ConsumerError(409, 'planner_reconciliation_conflict', 'A newer reconciliation already began.');
    }
  } catch (error) {
    const replay = await db(env).prepare(`
      SELECT * FROM consumer_planner_reconciliations
      WHERE realtime_session_id = ? AND idempotency_key_hash_b64u = ?
      LIMIT 1
    `).bind(request.leaseId, idempotencyHash).first().catch(() => null);
    if (replay) return { row: replay, replayed: true };
    throw error;
  }
  const row = await db(env).prepare(`
    SELECT * FROM consumer_planner_reconciliations WHERE id = ? LIMIT 1
  `).bind(id).first();
  return { row, replayed: false };
}

/**
 * Encrypt the reconciled profile and work out the exact ledger transitions.
 *
 * The validator has already decided which notes end up active, superseded or
 * retracted, so this deliberately does NOT re-derive supersession from matching
 * fact instances the way a spoken confirmation does. That heuristic cannot see
 * a retraction, which produces no replacement note, or a merge, which moves
 * notes onto a different entity — and those are exactly the corrections this
 * path exists to make.
 */
async function preparePlannerReconciliationWrite(env, request) {
  const revision = request.baseRevision + 1;
  const nextProfile = {
    ...request.appliedProfile,
    revision,
    confirmedAt: undefined,
    updatedAt: request.timestamp
  };
  const payload = await encryptJson(
    env,
    nextProfile,
    `consumer/profile/${request.sessionId}/${revision}`
  );
  const priorRecords = await listPlanningNoteRecords(env, request.sessionId, request.leaseId, {
    limit: 500
  });
  const priorById = new Map(priorRecords.map((item) => [item.note.noteId, item]));
  const resulting = Array.isArray(request.appliedNotes) ? request.appliedNotes : [];
  const inserts = [];
  const transitions = [];
  for (const note of resulting) {
    const prior = priorById.get(note.noteId);
    if (!prior) {
      inserts.push(note);
    } else if (prior.note.lifecycle !== note.lifecycle || prior.note.reviewStatus !== note.reviewStatus) {
      transitions.push({ note, priorRow: prior.row });
    }
  }
  const [insertRecords, transitionRecords] = await Promise.all([
    Promise.all(inserts.map((note) => preparePlanningNoteRecord(env, {
      sessionId: request.sessionId,
      leaseId: request.leaseId,
      profileRevision: revision,
      note
    }))),
    Promise.all(transitions.map(async ({ note, priorRow }) => ({
      priorRow,
      prepared: await preparePlanningNoteRecord(env, {
        sessionId: request.sessionId,
        leaseId: request.leaseId,
        profileRevision: Number(priorRow.profile_revision),
        note: { ...note, reviewedAt: note.reviewedAt || request.timestamp }
      })
    })))
  ]);
  return { revision, nextProfile, payload, insertRecords, transitionRecords };
}

/**
 * The profile and ledger half of an applied reconciliation.
 *
 * Every statement is gated on the reconciliation row having just been marked
 * applied in the same batch, and on the session still sitting at the revision
 * the reconciliation was computed against, so a concurrent spoken confirmation
 * makes the whole thing a no-op rather than a partial write.
 */
function plannerReconciliationWriteStatements(env, {
  sessionId, leaseId, reconciliationId, baseRevision, timestamp, write
}) {
  const { revision, payload, insertRecords, transitionRecords } = write;
  const statements = [
    db(env).prepare(`
      INSERT INTO consumer_profile_revisions (
        session_id, revision, schema_version, payload_encrypted, confirmed_at, created_at
      )
      SELECT ?, ?, 1, ?, NULL, ?
      WHERE EXISTS (
        SELECT 1 FROM consumer_sessions
        WHERE id = ? AND deleted_at IS NULL AND current_profile_revision = ?
      ) AND EXISTS (
        SELECT 1 FROM consumer_planner_reconciliations
        WHERE id = ? AND session_id = ? AND realtime_session_id = ?
          AND status = 'applied' AND applied_profile_revision = ?
      )
    `).bind(
      sessionId, revision, payload, timestamp,
      sessionId, baseRevision,
      reconciliationId, sessionId, leaseId, revision
    ),
    db(env).prepare(`
      UPDATE consumer_sessions
      SET current_profile_revision = ?, confirmed_profile_revision = NULL, last_active_at = ?
      WHERE id = ? AND deleted_at IS NULL AND current_profile_revision = ?
        AND EXISTS (
          SELECT 1 FROM consumer_profile_revisions WHERE session_id = ? AND revision = ?
        )
    `).bind(revision, timestamp, sessionId, baseRevision, sessionId, revision),
    db(env).prepare(`
      UPDATE consumer_realtime_sessions
      SET latest_profile_revision = ?, last_active_at = ?
      WHERE id = ? AND session_id = ? AND status = 'active'
        AND latest_profile_revision = ?
    `).bind(revision, timestamp, leaseId, sessionId, baseRevision)
  ];
  // A REVISION NUMBER IS NOT PROOF THAT THIS BATCH WON.
  //
  // The two ledger statements below used to be gated on
  // `current_profile_revision = revision` alone, on the reasoning that the new
  // revision can only exist because the statement above it just created it.
  // That is false in the one case that matters most. `revision` is
  // `baseRevision + 1`, and the commonest concurrent event by far is exactly
  // ONE ordinary fact write landing while the planner was thinking — which
  // moves the session to `baseRevision + 1` as well. The numbers then coincide,
  // the profile half is correctly refused, and the ledger half commits anyway
  // against a revision this reconciliation never computed against.
  //
  // Measured: a conflicted reconciliation left the note ledger saying the
  // stated total was a summary while the profile still carried it as a third
  // pension. Nothing reported a fault — the row said `conflicted`, which is
  // supposed to mean nothing was written.
  //
  // The reconciliation row is the authority instead. Its own update is gated on
  // the lease CAS, so it reaches `applied` only when this batch genuinely won,
  // and `applied_profile_revision` pins that to this exact write. A concurrent
  // writer cannot coincide with it.
  const ledgerGuard = `
        AND EXISTS (
          SELECT 1 FROM consumer_planner_reconciliations
          WHERE id = ? AND session_id = ? AND realtime_session_id = ?
            AND status = 'applied' AND applied_profile_revision = ?
        )`;
  for (const { priorRow, prepared } of transitionRecords) {
    statements.push(db(env).prepare(`
      UPDATE consumer_planning_notes
      SET lifecycle = ?, review_status = ?, note_encrypted = ?, note_hash_b64u = ?, reviewed_at = ?
      WHERE id = ? AND session_id = ? AND realtime_session_id = ?
        AND EXISTS (
          SELECT 1 FROM consumer_sessions
          WHERE id = ? AND current_profile_revision = ? AND deleted_at IS NULL
        )${ledgerGuard}
    `).bind(
      prepared.row.lifecycle, prepared.row.reviewStatus, prepared.row.encrypted,
      prepared.row.hash, prepared.row.reviewedAt,
      priorRow.id, sessionId, leaseId,
      sessionId, revision,
      reconciliationId, sessionId, leaseId, revision
    ));
  }
  for (const record of insertRecords) {
    statements.push(db(env).prepare(`
      INSERT INTO consumer_planning_notes (
        id, session_id, realtime_session_id, note_kind, lifecycle,
        review_status, source, profile_revision, note_encrypted,
        note_hash_b64u, created_at, reviewed_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM consumer_sessions
        WHERE id = ? AND current_profile_revision = ? AND deleted_at IS NULL
      )${ledgerGuard}
    `).bind(
      record.row.id, sessionId, leaseId, record.row.noteKind, record.row.lifecycle,
      record.row.reviewStatus, record.row.source, record.row.profileRevision,
      record.row.encrypted, record.row.hash, record.row.createdAt, record.row.reviewedAt,
      sessionId, revision,
      reconciliationId, sessionId, leaseId, revision
    ));
  }
  return statements;
}

export async function completePlannerReconciliation(env, request) {
  const timestamp = nowIso();
  const attempt = await db(env).prepare(`
    SELECT status, base_profile_revision
    FROM consumer_planner_reconciliations
    WHERE id = ? AND session_id = ? AND realtime_session_id = ?
    LIMIT 1
  `).bind(request.reconciliationId, request.sessionId, request.leaseId).first();
  if (!attempt) throw notFound('This reconciliation attempt could not be found.');
  if (attempt.status !== 'pending') {
    return { status: attempt.status, throughTurnId: request.throughTurnId, replayed: true };
  }
  const output = request.output || {};
  const serialized = stableStringify(output);
  const [outputEncrypted, outputHash] = await Promise.all([
    encryptJson(
      env,
      output,
      plannerReconciliationOutputAad(request.sessionId, request.leaseId, request.reconciliationId)
    ),
    sha256Base64Url(serialized)
  ]);
  const terminalStatus = ['shadow', 'applied', 'rejected', 'conflicted', 'failed'].includes(request.status)
    ? request.status
    : 'failed';
  const advancesWatermark = terminalStatus === 'shadow' || terminalStatus === 'applied';
  const sessionStatus = terminalStatus === 'shadow' || terminalStatus === 'applied'
    ? terminalStatus
    : 'failed';
  // An applied reconciliation writes its profile and ledger in THIS batch. The
  // two statements below pin latest_profile_revision to the revision the
  // reconciliation started from, so the bump has to come after them or it would
  // invalidate its own guard. Anything a T1 write changed in the meantime moves
  // that revision and the whole batch fails closed as conflicted, which is the
  // behaviour the shadow path already relied on.
  const baseRevision = Number(attempt.base_profile_revision);
  const applyWrite = terminalStatus === 'applied'
    ? await preparePlannerReconciliationWrite(env, { ...request, baseRevision, timestamp })
    : null;
  const appliedProfileRevision = applyWrite ? applyWrite.revision : (request.appliedProfileRevision ?? null);
  const results = await db(env).batch([
    db(env).prepare(`
      UPDATE consumer_planner_reconciliations
      SET status = ?, output_encrypted = ?, output_hash_b64u = ?,
          applied_profile_revision = ?, model = ?, input_tokens = ?,
          output_tokens = ?, cached_input_tokens = ?, latency_ms = ?,
          operation_count = ?, accepted_operation_count = ?,
          rejected_operation_count = ?, error_code = ?, completed_at = ?
      WHERE id = ? AND session_id = ? AND realtime_session_id = ?
        AND status = 'pending'
        AND EXISTS (
          SELECT 1 FROM consumer_realtime_sessions
          WHERE id = ? AND session_id = ?
            AND planner_reconciliation_revision = ?
            AND latest_profile_revision = ?
        )
    `).bind(
      terminalStatus,
      outputEncrypted,
      outputHash,
      appliedProfileRevision,
      request.model || null,
      safeInteger(request.inputTokens),
      safeInteger(request.outputTokens),
      safeInteger(request.cachedInputTokens),
      safeInteger(request.latencyMs),
      safeInteger(request.operationCount),
      safeInteger(request.acceptedOperationCount),
      safeInteger(request.rejectedOperationCount),
      request.errorCode || null,
      timestamp,
      request.reconciliationId,
      request.sessionId,
      request.leaseId,
      request.leaseId,
      request.sessionId,
      request.reconciliationRevision,
      Number(attempt.base_profile_revision)
    ),
    db(env).prepare(`
      UPDATE consumer_realtime_sessions
      SET planner_reconciled_through_turn_id = CASE WHEN ? = 1 THEN ?
            ELSE planner_reconciled_through_turn_id END,
          planner_pending_through_turn_id = NULL,
          planner_reconciliation_status = ?,
          last_active_at = ?
      WHERE id = ? AND session_id = ?
        AND planner_reconciliation_revision = ?
        AND latest_profile_revision = ?
        AND EXISTS (
          SELECT 1 FROM consumer_planner_reconciliations
          WHERE id = ? AND status = ?
        )
    `).bind(
      advancesWatermark ? 1 : 0,
      request.throughTurnId,
      sessionStatus,
      timestamp,
      request.leaseId,
      request.sessionId,
      request.reconciliationRevision,
      Number(attempt.base_profile_revision),
      request.reconciliationId,
      terminalStatus
    ),
    ...(applyWrite ? plannerReconciliationWriteStatements(env, {
      sessionId: request.sessionId,
      leaseId: request.leaseId,
      reconciliationId: request.reconciliationId,
      baseRevision,
      timestamp,
      write: applyWrite
    }) : [])
  ]);
  if (results.some((result) => Number(result?.meta?.changes || 0) !== 1)) {
    await db(env).batch([
      db(env).prepare(`
        UPDATE consumer_planner_reconciliations
        SET status = 'conflicted', output_encrypted = ?, output_hash_b64u = ?,
            model = ?, input_tokens = ?, output_tokens = ?,
            cached_input_tokens = ?, latency_ms = ?, operation_count = ?,
            accepted_operation_count = 0, rejected_operation_count = ?,
            error_code = 'planner_reconciliation_stale', completed_at = ?
        WHERE id = ? AND session_id = ? AND realtime_session_id = ?
          AND status = 'pending'
      `).bind(
        outputEncrypted,
        outputHash,
        request.model || null,
        safeInteger(request.inputTokens),
        safeInteger(request.outputTokens),
        safeInteger(request.cachedInputTokens),
        safeInteger(request.latencyMs),
        safeInteger(request.operationCount),
        safeInteger(request.operationCount),
        timestamp,
        request.reconciliationId,
        request.sessionId,
        request.leaseId
      ),
      db(env).prepare(`
        UPDATE consumer_realtime_sessions
        SET planner_pending_through_turn_id = NULL,
            planner_reconciliation_status = 'failed',
            last_active_at = ?
        WHERE id = ? AND session_id = ?
          AND planner_reconciliation_revision = ?
          AND EXISTS (
            SELECT 1 FROM consumer_planner_reconciliations
            WHERE id = ? AND status = 'conflicted'
          )
      `).bind(
        timestamp,
        request.leaseId,
        request.sessionId,
        request.reconciliationRevision,
        request.reconciliationId
      )
    ]);
    return {
      status: 'conflicted',
      throughTurnId: request.throughTurnId,
      errorCode: 'planner_reconciliation_stale'
    };
  }
  return {
    status: terminalStatus,
    throughTurnId: request.throughTurnId,
    ...(applyWrite ? {
      appliedProfileRevision: applyWrite.revision,
      profile: applyWrite.nextProfile,
      insertedNoteCount: applyWrite.insertRecords.length,
      transitionedNoteCount: applyWrite.transitionRecords.length
    } : {})
  };
}

/**
 * Recover an attempt that was left pending when the worker/DO stopped after
 * reserving it but before recording a terminal result. Recovery is exact by
 * attempt id and age-bound: a currently-running model call is never cancelled
 * merely because another trigger observed its pending row.
 *
 * The attempt row is the durable source of truth. Clearing the lease cursor is
 * conditional on this still being the lease's latest reconciliation revision,
 * so recovering an older overlapping attempt cannot erase a newer job.
 */
export async function recoverStalePlannerReconciliation(env, request) {
  const staleBeforeMs = Date.parse(String(request.staleBefore || ''));
  if (!Number.isFinite(staleBeforeMs)) {
    throw new ConsumerError(
      400,
      'planner_reconciliation_recovery_invalid',
      'The reconciliation recovery boundary is invalid.'
    );
  }
  const attempt = await db(env).prepare(`
    SELECT id, status, reconciliation_revision, through_turn_id, created_at,
           completed_at, error_code
    FROM consumer_planner_reconciliations
    WHERE id = ? AND session_id = ? AND realtime_session_id = ?
    LIMIT 1
  `).bind(request.reconciliationId, request.sessionId, request.leaseId).first();
  if (!attempt) throw notFound('This reconciliation attempt could not be found.');
  if (attempt.status !== 'pending') {
    return {
      status: attempt.status,
      recovered: false,
      reconciliationId: attempt.id,
      throughTurnId: attempt.through_turn_id,
      completedAt: attempt.completed_at || null,
      errorCode: attempt.error_code || null
    };
  }
  const createdAtMs = Date.parse(String(attempt.created_at || ''));
  if (!Number.isFinite(createdAtMs) || createdAtMs > staleBeforeMs) {
    return {
      status: 'pending',
      recovered: false,
      reconciliationId: attempt.id,
      throughTurnId: attempt.through_turn_id,
      createdAt: attempt.created_at
    };
  }

  const timestamp = nowIso();
  const results = await db(env).batch([
    db(env).prepare(`
      UPDATE consumer_planner_reconciliations
      SET status = 'failed',
          error_code = 'planner_reconciliation_stale_pending',
          completed_at = ?
      WHERE id = ? AND session_id = ? AND realtime_session_id = ?
        AND status = 'pending' AND created_at <= ?
    `).bind(
      timestamp,
      attempt.id,
      request.sessionId,
      request.leaseId,
      new Date(staleBeforeMs).toISOString()
    ),
    db(env).prepare(`
      UPDATE consumer_realtime_sessions
      SET planner_pending_through_turn_id = NULL,
          planner_reconciliation_status = 'failed',
          last_active_at = ?
      WHERE id = ? AND session_id = ?
        AND planner_reconciliation_revision = ?
        AND planner_pending_through_turn_id = ?
        AND EXISTS (
          SELECT 1 FROM consumer_planner_reconciliations
          WHERE id = ? AND status = 'failed'
            AND error_code = 'planner_reconciliation_stale_pending'
        )
    `).bind(
      timestamp,
      request.leaseId,
      request.sessionId,
      safeInteger(attempt.reconciliation_revision),
      attempt.through_turn_id,
      attempt.id
    )
  ]);
  if (Number(results[0]?.meta?.changes || 0) === 1) {
    return {
      status: 'failed',
      recovered: true,
      reconciliationId: attempt.id,
      throughTurnId: attempt.through_turn_id,
      completedAt: timestamp,
      errorCode: 'planner_reconciliation_stale_pending'
    };
  }

  // A completion racing recovery won the compare-and-set. Report the actual
  // terminal state instead of pretending this caller recovered it.
  const current = await db(env).prepare(`
    SELECT status, through_turn_id, completed_at, error_code
    FROM consumer_planner_reconciliations
    WHERE id = ? AND session_id = ? AND realtime_session_id = ?
    LIMIT 1
  `).bind(attempt.id, request.sessionId, request.leaseId).first();
  return {
    status: current?.status || 'failed',
    recovered: false,
    reconciliationId: attempt.id,
    throughTurnId: current?.through_turn_id || attempt.through_turn_id,
    completedAt: current?.completed_at || null,
    errorCode: current?.error_code || null
  };
}

export async function loadPlannerReconciliation(env, sessionId, leaseId, reconciliationId) {
  const row = await db(env).prepare(`
    SELECT * FROM consumer_planner_reconciliations
    WHERE id = ? AND session_id = ? AND realtime_session_id = ?
    LIMIT 1
  `).bind(reconciliationId, sessionId, leaseId).first();
  if (!row) throw notFound('This planner reconciliation could not be found.');
  const [input, output] = await Promise.all([
    decryptJson(env, row.input_encrypted, plannerReconciliationInputAad(sessionId, leaseId, row.id)),
    row.output_encrypted
      ? decryptJson(env, row.output_encrypted, plannerReconciliationOutputAad(sessionId, leaseId, row.id))
      : null
  ]);
  return { row, input, output };
}

export async function listRealtimeMeetings(env, sessionId, limit = 50) {
  const result = await db(env).prepare(`
    SELECT leases.*,
           COUNT(turns.id) AS transcript_turn_count,
           plans.status AS analysis_plan_status
    FROM consumer_realtime_sessions AS leases
    LEFT JOIN consumer_realtime_final_turns AS turns
      ON turns.realtime_session_id = leases.id
    LEFT JOIN consumer_realtime_analysis_plans AS plans
      ON plans.id = leases.completion_analysis_plan_id
    WHERE leases.session_id = ?
    GROUP BY leases.id
    ORDER BY COALESCE(leases.activated_at, leases.created_at) DESC, leases.id DESC
    LIMIT ?
  `).bind(sessionId, Math.max(1, Math.min(100, limit))).all();
  return (result.results || []).map((row, index) => ({
    meetingId: row.id,
    status: row.status,
    meetingPhase: row.meeting_phase || 'discovery',
    startedAt: row.activated_at || row.created_at,
    endedAt: row.ended_at || null,
    turnCount: safeInteger(row.transcript_turn_count),
    analysisPlanId: row.completion_analysis_plan_id || null,
    analysisStatus: row.analysis_plan_status || null,
    navigationTarget: row.completion_navigation_target || null,
    isLatest: index === 0
  }));
}

export async function getRealtimeMeetingTranscript(env, sessionId, leaseId, { cursor = null, limit = 50 } = {}) {
  const lease = await db(env).prepare(`
    SELECT * FROM consumer_realtime_sessions WHERE id = ? AND session_id = ? LIMIT 1
  `).bind(leaseId, sessionId).first();
  if (!lease) throw notFound('This voice meeting could not be found.');
  let cursorRow = null;
  if (cursor) {
    cursorRow = await db(env).prepare(`
      SELECT id, created_at FROM consumer_realtime_final_turns
      WHERE id = ? AND realtime_session_id = ? AND session_id = ? LIMIT 1
    `).bind(cursor, leaseId, sessionId).first();
    if (!cursorRow) throw new ConsumerError(400, 'realtime_transcript_cursor_invalid', 'The transcript cursor is invalid.');
  }
  const pageSize = Math.max(1, Math.min(50, Number(limit) || 50));
  const result = await db(env).prepare(`
    SELECT id, realtime_session_id, role, transcript_encrypted,
           sensitive_details_removed, created_at
    FROM consumer_realtime_final_turns
    WHERE session_id = ? AND realtime_session_id = ?
      AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).bind(
    sessionId,
    leaseId,
    cursorRow?.id || null,
    cursorRow?.created_at || '',
    cursorRow?.created_at || '',
    cursorRow?.id || '',
    pageSize + 1
  ).all();
  const rows = result.results || [];
  const hasMore = rows.length > pageSize;
  const pageRows = rows.slice(0, pageSize);
  const turns = [];
  for (const row of pageRows) {
    const payload = await decryptJson(
      env,
      row.transcript_encrypted,
      `consumer/realtime/final-turn/${sessionId}/${row.realtime_session_id}/${row.id}`
    );
    turns.push({
      id: row.id,
      role: row.role,
      transcript: String(payload?.transcript || '').slice(0, 4_000),
      sensitiveDetailsRemoved: Number(row.sensitive_details_removed) === 1,
      createdAt: row.created_at
    });
  }
  return {
    meeting: {
      meetingId: lease.id,
      status: lease.status,
      meetingPhase: lease.meeting_phase || 'discovery',
      startedAt: lease.activated_at || lease.created_at,
      endedAt: lease.ended_at || null,
      analysisPlanId: lease.completion_analysis_plan_id || null,
      navigationTarget: lease.completion_navigation_target || null
    },
    turns,
    nextCursor: hasMore ? turns.at(-1)?.id || null : null
  };
}

export async function setRealtimeMeetingPhase(env, request) {
  const phase = String(request.phase || '');
  if (![
    'discovery', 'intake', 'awaiting_voice_confirmation',
    'generating_modules', 'closing', 'completed'
  ].includes(phase)) {
    throw new ConsumerError(400, 'realtime_meeting_phase_invalid', 'The voice meeting phase is invalid.');
  }
  const row = await db(env).prepare(`
    UPDATE consumer_realtime_sessions
    SET meeting_phase = ?,
        completion_analysis_plan_id = COALESCE(?, completion_analysis_plan_id),
        completion_profile_revision = COALESCE(?, completion_profile_revision),
        completion_confirmation_turn_id = COALESCE(?, completion_confirmation_turn_id),
        completion_navigation_target = COALESCE(?, completion_navigation_target),
        completion_outro_speech_id = COALESCE(?, completion_outro_speech_id),
        last_active_at = ?
    WHERE id = ? AND session_id = ?
    RETURNING *
  `).bind(
    phase,
    request.planId || null,
    Number.isSafeInteger(Number(request.profileRevision)) ? Number(request.profileRevision) : null,
    request.confirmationTurnId || null,
    request.navigationTarget || null,
    request.outroSpeechId || null,
    nowIso(),
    request.leaseId,
    request.sessionId
  ).first();
  if (!row) throw notFound('This voice meeting could not be found.');
  return row;
}

export async function recordRealtimeVoiceConfirmation(env, request) {
  const id = randomId('voice_confirmation');
  const confirmationTurn = await db(env).prepare(`
    SELECT turns.transcript_hash_b64u
    FROM consumer_realtime_final_turns AS turns
    WHERE turns.id = ? AND turns.session_id = ?
      AND turns.realtime_session_id = ? AND turns.role = 'user'
      AND EXISTS (
        SELECT 1 FROM consumer_realtime_analysis_plans AS plans
        WHERE plans.id = ? AND plans.session_id = ?
          AND plans.realtime_session_id = ? AND plans.profile_revision = ?
      )
    LIMIT 1
  `).bind(
    request.confirmationTurnId,
    request.sessionId,
    request.leaseId,
    request.planId,
    request.sessionId,
    request.leaseId,
    request.profileRevision
  ).first();
  if (!confirmationTurn) {
    throw new ConsumerError(409, 'spoken_confirmation_turn_invalid', 'The finalized confirmation turn is unavailable.');
  }
  const confirmationTurnHash = confirmationTurn.transcript_hash_b64u;
  const timestamp = nowIso();
  try {
    const row = await db(env).prepare(`
      INSERT INTO consumer_realtime_voice_confirmations (
        id, session_id, realtime_session_id, analysis_plan_id, profile_revision,
        confirmation_turn_id, confirmation_turn_hash_b64u, confirmation_mode, confirmed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'spoken_affirmative_v1', ?)
      RETURNING *
    `).bind(
      id,
      request.sessionId,
      request.leaseId,
      request.planId,
      request.profileRevision,
      request.confirmationTurnId,
      confirmationTurnHash,
      timestamp
    ).first();
    return { row, idempotentReplay: false };
  } catch (error) {
    const existing = await db(env).prepare(`
      SELECT * FROM consumer_realtime_voice_confirmations
      WHERE realtime_session_id = ? AND analysis_plan_id = ? AND confirmation_turn_id = ?
      LIMIT 1
    `).bind(request.leaseId, request.planId, request.confirmationTurnId).first().catch(() => null);
    if (!existing) throw error;
    return { row: existing, idempotentReplay: true };
  }
}

export async function saveRealtimeMeetingBrief(env, request) {
  const id = randomId('realtime_brief');
  const timestamp = nowIso();
  const aad = `consumer/realtime/meeting-brief/${request.sessionId}/${request.leaseId}/${request.sourceTurnId}`;
  const [encrypted, hash] = await Promise.all([
    encryptJson(env, request.brief, aad),
    sha256Base64Url(stableStringify(request.brief))
  ]);
  await db(env).prepare(`
    INSERT INTO consumer_realtime_meeting_briefs (
      id, realtime_session_id, session_id, source_turn_id, profile_revision,
      schema_version, planner_prompt_version, brief_encrypted,
      brief_hash_b64u, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(realtime_session_id, source_turn_id) DO UPDATE SET
      profile_revision = excluded.profile_revision,
      schema_version = excluded.schema_version,
      planner_prompt_version = excluded.planner_prompt_version,
      brief_encrypted = excluded.brief_encrypted,
      brief_hash_b64u = excluded.brief_hash_b64u,
      updated_at = excluded.updated_at
  `).bind(
    id,
    request.leaseId,
    request.sessionId,
    request.sourceTurnId,
    request.profileRevision,
    request.brief.schemaVersion === 'MeetingBriefV2' ? 'MeetingBriefV2' : 'MeetingBriefV1',
    request.plannerPromptVersion,
    encrypted,
    hash,
    timestamp,
    timestamp
  ).run();
  return { sourceTurnId: request.sourceTurnId, profileRevision: request.profileRevision, updatedAt: timestamp };
}

export async function getLatestRealtimeMeetingBrief(env, sessionId, leaseId) {
  const row = await db(env).prepare(`
    SELECT id, realtime_session_id, session_id, source_turn_id, profile_revision,
           schema_version, planner_prompt_version, brief_encrypted,
           brief_hash_b64u, created_at, updated_at
    FROM consumer_realtime_meeting_briefs
    WHERE session_id = ? AND realtime_session_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).bind(sessionId, leaseId).first();
  if (!row) return null;
  const brief = await decryptJson(
    env,
    row.brief_encrypted,
    `consumer/realtime/meeting-brief/${sessionId}/${leaseId}/${row.source_turn_id}`
  );
  const actualHash = await sha256Base64Url(stableStringify(brief));
  if (!constantTimeEqual(actualHash, row.brief_hash_b64u)) {
    throw new ConsumerError(409, 'realtime_meeting_brief_corrupt', 'The saved meeting brief could not be verified.');
  }
  return {
    row,
    brief,
    sourceTurnId: row.source_turn_id,
    profileRevision: Number(row.profile_revision)
  };
}

export async function beginRealtimeToolAttempt(env, request) {
  const callHash = await sha256Base64Url(String(request.providerToolCallId));
  const argsHash = await sha256Base64Url(stableStringify(request.arguments));
  const id = randomId('realtime_tool');
  const encryptedArgs = await encryptJson(
    env,
    request.arguments,
    `consumer/realtime/tool/${request.sessionId}/${request.leaseId}/${id}/arguments`
  );
  const timestamp = nowIso();
  await db(env).batch([
    db(env).prepare(`
      INSERT OR IGNORE INTO consumer_realtime_tool_attempts (
        id, realtime_session_id, session_id, provider_tool_call_id_hash_b64u,
        tool_name, tool_version, expected_profile_revision, status,
        arguments_encrypted, arguments_hash_b64u, result_encrypted,
        result_hash_b64u, analysis_run_id, profile_revision_after,
        error_code, latency_ms, created_at, completed_at, source_turn_id
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, NULL, NULL, NULL, NULL,
             NULL, 0, ?, NULL, ?
      WHERE EXISTS (
        SELECT 1 FROM consumer_realtime_sessions
        WHERE id = ? AND session_id = ? AND status = 'active'
          AND tool_call_count < ?
      )
    `).bind(
      id,
      request.leaseId,
      request.sessionId,
      callHash,
      request.toolName,
      request.toolVersion,
      Number.isSafeInteger(request.expectedProfileRevision) ? request.expectedProfileRevision : null,
      encryptedArgs,
      argsHash,
      timestamp,
      request.sourceTurnId || null,
      request.leaseId,
      request.sessionId,
      request.maxToolCalls
    ),
    db(env).prepare(`
      UPDATE consumer_realtime_sessions
      SET tool_call_count = (
        SELECT COUNT(*) FROM consumer_realtime_tool_attempts
        WHERE realtime_session_id = ?
      ), last_active_at = ?
      WHERE id = ? AND session_id = ? AND status = 'active'
    `).bind(request.leaseId, timestamp, request.leaseId, request.sessionId)
  ]);
  const row = await db(env).prepare(`
    SELECT * FROM consumer_realtime_tool_attempts
    WHERE realtime_session_id = ? AND provider_tool_call_id_hash_b64u = ?
    LIMIT 1
  `).bind(request.leaseId, callHash).first();
  if (!row) {
    throw new ConsumerError(429, 'realtime_tool_limit_reached', 'The live planning tool limit has been reached.');
  }
  const replayed = row.id !== id;
  let result = null;
  if (replayed && (
    row.tool_name !== request.toolName
    || row.tool_version !== request.toolVersion
    || row.arguments_hash_b64u !== argsHash
    || Number(row.expected_profile_revision ?? -1) !== Number(request.expectedProfileRevision ?? -1)
  )) {
    throw new ConsumerError(409, 'realtime_tool_replay_conflict', 'A provider tool call id was replayed with different arguments.');
  }
  if (replayed && (
    !row.result_encrypted
    || !row.completed_at
    || ['received', 'validated', 'executing'].includes(row.status)
  )) {
    throw new ConsumerError(409, 'realtime_tool_replay_incomplete', 'A provider tool call replay could not be resumed safely.');
  }
  if (replayed) {
    result = await decryptJson(
      env,
      row.result_encrypted,
      `consumer/realtime/tool/${request.sessionId}/${request.leaseId}/${row.id}/result`
    );
  }
  return { row, replayed, result };
}

export async function completeRealtimeToolAttempt(env, request) {
  const timestamp = nowIso();
  const resultHash = await sha256Base64Url(stableStringify(request.result));
  const resultEncrypted = await encryptJson(
    env,
    request.result,
    `consumer/realtime/tool/${request.sessionId}/${request.leaseId}/${request.toolAttemptId}/result`
  );
  return db(env).prepare(`
    UPDATE consumer_realtime_tool_attempts
    SET status = ?, result_encrypted = ?, result_hash_b64u = ?,
        error_code = ?, latency_ms = ?, completed_at = ?
    WHERE id = ? AND realtime_session_id = ? AND session_id = ?
      AND status IN ('received', 'validated', 'executing')
    RETURNING *
  `).bind(
    request.status,
    resultEncrypted,
    resultHash,
    request.errorCode || null,
    safeInteger(request.latencyMs),
    timestamp,
    request.toolAttemptId,
    request.leaseId,
    request.sessionId
  ).first();
}

export async function createRealtimeFactProposal(env, request) {
  const id = randomId('fact_proposal');
  const patchHash = await sha256Base64Url(stableStringify(request.patch));
  const [factStorageId, valueEncrypted, patchEncrypted] = await Promise.all([
    realtimeFactStorageId(env, request.factId),
    encryptJson(
      env,
      {
        factId: request.factId,
        value: request.value,
        readBackText: typeof request.readBackText === 'string' ? request.readBackText : null
      },
      `consumer/realtime/fact-proposal/${request.sessionId}/${request.leaseId}/${id}/value`
    ),
    encryptJson(
      env,
      request.patch,
      `consumer/realtime/fact-proposal/${request.sessionId}/${request.leaseId}/${id}/patch`
    )
  ]);
  const row = await db(env).prepare(`
    INSERT INTO consumer_realtime_fact_proposals (
      id, realtime_session_id, session_id, tool_attempt_id, fact_id,
      base_profile_revision, status, value_encrypted, patch_encrypted,
      patch_hash_b64u, evidence_item_id, confidence, certainty,
      created_at, reviewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, NULL)
    RETURNING *
  `).bind(
    id,
    request.leaseId,
    request.sessionId,
    request.toolAttemptId,
    factStorageId,
    request.baseProfileRevision,
    valueEncrypted,
    patchEncrypted,
    patchHash,
    request.evidenceItemId || null,
    request.confidence,
    request.certainty,
    nowIso()
  ).first();
  return { id: row.id, status: row.status, baseProfileRevision: Number(row.base_profile_revision) };
}

async function realtimeFactStorageId(env, factId) {
  const digest = await hmacSha256Base64Url(
    env.CONSUMER_RATE_LIMIT_HASH_KEY,
    `consumer/realtime/fact-id/v2/${String(factId || '')}`
  );
  return `fact_h_${digest}`;
}

function unpackRealtimeFactValue(row, decrypted) {
  if (decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)
    && typeof decrypted.factId === 'string' && Object.hasOwn(decrypted, 'value')) {
    return {
      factId: decrypted.factId,
      value: decrypted.value,
      readBackText: typeof decrypted.readBackText === 'string' ? decrypted.readBackText : null
    };
  }
  // Compatibility is limited to rows created before the encrypted semantic-ID
  // migration. The migration terminalizes pending legacy rows before scrubbing
  // their plaintext ID, so this branch is never used for a confirmable change.
  return { factId: row.fact_id, value: decrypted, readBackText: null };
}

export async function listRealtimeFactProposalSummaries(env, sessionId, leaseId) {
  const result = await db(env).prepare(`
    SELECT id, realtime_session_id, fact_id, value_encrypted, certainty,
           status, base_profile_revision, created_at
    FROM consumer_realtime_fact_proposals
    WHERE session_id = ? AND realtime_session_id = ?
      AND status = 'proposed'
    ORDER BY created_at ASC, id ASC
    LIMIT 12
  `).bind(sessionId, leaseId).all();
  const summaries = [];
  for (const row of result.results || []) {
    const decrypted = await decryptJson(
      env,
      row.value_encrypted,
      `consumer/realtime/fact-proposal/${sessionId}/${row.realtime_session_id}/${row.id}/value`
    );
    const fact = unpackRealtimeFactValue(row, decrypted);
    summaries.push({
      proposalId: row.id,
      factId: fact.factId,
      value: fact.value,
      readBackText: fact.readBackText,
      certainty: row.certainty,
      status: row.status,
      revision: Number(row.base_profile_revision)
    });
  }
  return summaries;
}

export async function getPendingRealtimeFactProposal(env, sessionId, leaseId, proposalId) {
  const row = await db(env).prepare(`
    SELECT proposals.*,
      (SELECT COUNT(*) FROM consumer_realtime_fact_proposals AS pending
       WHERE pending.realtime_session_id = proposals.realtime_session_id
         AND pending.session_id = proposals.session_id
         AND pending.status = 'proposed') AS pending_count,
      (SELECT pending.id FROM consumer_realtime_fact_proposals AS pending
       WHERE pending.realtime_session_id = proposals.realtime_session_id
         AND pending.session_id = proposals.session_id
         AND pending.status = 'proposed'
       ORDER BY pending.created_at ASC, pending.id ASC
       LIMIT 1) AS current_pending_id
    FROM consumer_realtime_fact_proposals AS proposals
    WHERE proposals.id = ? AND proposals.session_id = ?
      AND proposals.realtime_session_id = ? AND proposals.status = 'proposed'
    LIMIT 1
  `).bind(proposalId, sessionId, leaseId).first();
  if (!row) throw notFound('This proposed fact change could not be found.');
  const [decrypted, patch] = await Promise.all([
    decryptJson(env, row.value_encrypted, `consumer/realtime/fact-proposal/${sessionId}/${leaseId}/${row.id}/value`),
    decryptJson(env, row.patch_encrypted, `consumer/realtime/fact-proposal/${sessionId}/${leaseId}/${row.id}/patch`)
  ]);
  const fact = unpackRealtimeFactValue(row, decrypted);
  return {
    row,
    factId: fact.factId,
    value: fact.value,
    readBackText: fact.readBackText,
    patch,
    pendingCount: Number(row.pending_count || 0),
    currentPendingId: row.current_pending_id || null
  };
}

export async function rejectRealtimeFactProposal(env, sessionId, leaseId, proposalId, evidenceItemId) {
  const [primaryGoalStorageId, targetHomePriceStorageId] = await Promise.all([
    realtimeFactStorageId(env, 'primary_goal'),
    realtimeFactStorageId(env, 'target_home_price')
  ]);
  const row = await db(env).prepare(`
    UPDATE consumer_realtime_fact_proposals
    SET status = 'rejected', confirmation_evidence_item_id = ?, reviewed_at = ?
    WHERE id = ? AND session_id = ? AND realtime_session_id = ?
      AND status = 'proposed'
    RETURNING id, fact_id, status, base_profile_revision
  `).bind(evidenceItemId, nowIso(), proposalId, sessionId, leaseId).first();
  if (!row) throw notFound('This proposed fact change could not be found.');
  if (row.fact_id === primaryGoalStorageId) {
    await db(env).prepare(`
      UPDATE consumer_realtime_fact_proposals
      SET status = 'conflicted', confirmation_evidence_item_id = ?, reviewed_at = ?
      WHERE session_id = ? AND realtime_session_id = ?
        AND status = 'proposed' AND fact_id = ?
    `).bind(evidenceItemId, nowIso(), sessionId, leaseId, targetHomePriceStorageId).run();
  }
  return { id: row.id, status: row.status, baseProfileRevision: Number(row.base_profile_revision) };
}

export async function commitRealtimeFactConfirmation(env, request) {
  const currentRevision = Number(request.sessionRow.current_profile_revision || 1);
  const revision = currentRevision + 1;
  const timestamp = nowIso();
  const nextProfile = {
    ...request.profile,
    revision,
    confirmedAt: undefined,
    updatedAt: timestamp
  };
  const payload = await encryptJson(
    env,
    nextProfile,
    `consumer/profile/${request.sessionId}/${revision}`
  );
  const requestedPlanningNotes = Array.isArray(request.planningNotes)
    ? request.planningNotes
    : request.planningNote ? [request.planningNote] : [];
  const activePlanningNoteRecords = requestedPlanningNotes.length > 0
    ? await listPlanningNoteRecords(env, request.sessionId, request.leaseId, {
        lifecycle: 'active',
        limit: 500
      })
    : [];
  const requestedInstanceIds = requestedPlanningNotes.map((note) => note?.factInstanceId).filter(Boolean);
  if (new Set(requestedInstanceIds).size !== requestedInstanceIds.length) {
    throw new ConsumerError(
      409,
      'planning_note_instance_conflict',
      'One fact write produced duplicate planning-note identities.'
    );
  }
  const supersededById = new Map();
  const planningNotes = await Promise.all(requestedPlanningNotes.map((note) => {
    const prior = activePlanningNoteRecords.filter((item) => (
      note?.factInstanceId && item.note?.factInstanceId === note.factInstanceId
    ));
    prior.forEach((item) => supersededById.set(item.note.noteId, item));
    return preparePlanningNoteRecord(env, {
        sessionId: request.sessionId,
        leaseId: request.leaseId,
        profileRevision: revision,
        note: {
          ...note,
          replacesNoteIds: [...new Set([
            ...(Array.isArray(note?.replacesNoteIds) ? note.replacesNoteIds : []),
            ...prior.map((item) => item.note.noteId)
          ])]
        }
      });
  }));
  const supersededPlanningNotes = await Promise.all([...supersededById.values()].map((item) => (
    preparePlanningNoteRecord(env, {
      sessionId: request.sessionId,
      leaseId: request.leaseId,
      profileRevision: Number(item.row.profile_revision),
      note: {
        ...item.note,
        lifecycle: 'superseded',
        reviewedAt: timestamp
      }
    })
  )));
  const statements = [
    db(env).prepare(`
      INSERT INTO consumer_profile_revisions (
        session_id, revision, schema_version, payload_encrypted, confirmed_at, created_at
      )
      SELECT ?, ?, 1, ?, NULL, ?
      WHERE EXISTS (
        SELECT 1 FROM consumer_sessions
        WHERE id = ? AND deleted_at IS NULL AND current_profile_revision = ?
      ) AND EXISTS (
        SELECT 1 FROM consumer_realtime_fact_proposals
        WHERE id = ? AND session_id = ? AND realtime_session_id = ?
          AND status = 'proposed' AND base_profile_revision = ?
      )
    `).bind(
      request.sessionId,
      revision,
      payload,
      timestamp,
      request.sessionId,
      currentRevision,
      request.proposalId,
      request.sessionId,
      request.leaseId,
      currentRevision
    ),
    db(env).prepare(`
      UPDATE consumer_sessions
      SET current_profile_revision = ?, confirmed_profile_revision = NULL,
          stage = ?, last_active_at = ?
      WHERE id = ? AND deleted_at IS NULL AND current_profile_revision = ?
        AND EXISTS (
          SELECT 1 FROM consumer_profile_revisions
          WHERE session_id = ? AND revision = ?
        )
    `).bind(
      revision,
      request.stage || request.sessionRow.stage,
      timestamp,
      request.sessionId,
      currentRevision,
      request.sessionId,
      revision
    ),
    db(env).prepare(`
      UPDATE consumer_realtime_fact_proposals
      SET status = 'confirmed', confirmation_evidence_item_id = ?, reviewed_at = ?
      WHERE id = ? AND session_id = ? AND realtime_session_id = ?
        AND status = 'proposed' AND base_profile_revision = ?
        AND EXISTS (
          SELECT 1 FROM consumer_sessions
          WHERE id = ? AND current_profile_revision = ?
        )
    `).bind(
      request.confirmationEvidenceItemId,
      timestamp,
      request.proposalId,
      request.sessionId,
      request.leaseId,
      currentRevision,
      request.sessionId,
      revision
    ),
    db(env).prepare(`
      UPDATE consumer_realtime_fact_proposals
      SET base_profile_revision = ?
      WHERE session_id = ? AND realtime_session_id = ?
        AND status = 'proposed' AND base_profile_revision = ?
        AND id <> ?
        AND EXISTS (
          SELECT 1 FROM consumer_sessions
          WHERE id = ? AND current_profile_revision = ?
        )
    `).bind(
      revision,
      request.sessionId,
      request.leaseId,
      currentRevision,
      request.proposalId,
      request.sessionId,
      revision
    ),
    // Advance the live lease in lockstep with the session revision. Approved
    // speech and speech-usage settlement are pinned to the lease's
    // latest_profile_revision, so without this the acknowledgement for a
    // just-saved fact cannot be enqueued (realtime_lease_conflict).
    db(env).prepare(`
      UPDATE consumer_realtime_sessions
      SET latest_profile_revision = ?, last_active_at = ?
      WHERE id = ? AND session_id = ? AND status = 'active'
        AND latest_profile_revision = ?
    `).bind(
      revision,
      timestamp,
      request.leaseId,
      request.sessionId,
      currentRevision
    )
  ];
  for (const planningNote of supersededPlanningNotes) {
    const row = planningNote.row;
    statements.push(db(env).prepare(`
      UPDATE consumer_planning_notes
      SET lifecycle = 'superseded', note_encrypted = ?, note_hash_b64u = ?,
          reviewed_at = ?
      WHERE id = ? AND session_id = ? AND realtime_session_id = ?
        AND lifecycle = 'active'
        AND EXISTS (
          SELECT 1 FROM consumer_sessions
          WHERE id = ? AND current_profile_revision = ? AND deleted_at IS NULL
        )
        AND EXISTS (
          SELECT 1 FROM consumer_realtime_sessions
          WHERE id = ? AND session_id = ? AND latest_profile_revision = ?
        )
    `).bind(
      row.encrypted,
      row.hash,
      row.reviewedAt,
      row.id,
      row.sessionId,
      row.leaseId,
      request.sessionId,
      revision,
      request.leaseId,
      request.sessionId,
      revision
    ));
  }
  for (const planningNote of planningNotes) {
    const row = planningNote.row;
    statements.push(db(env).prepare(`
      INSERT INTO consumer_planning_notes (
        id, session_id, realtime_session_id, note_kind, lifecycle,
        review_status, source, profile_revision, note_encrypted,
        note_hash_b64u, created_at, reviewed_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM consumer_sessions
        WHERE id = ? AND current_profile_revision = ? AND deleted_at IS NULL
      ) AND EXISTS (
        SELECT 1 FROM consumer_realtime_sessions
        WHERE id = ? AND session_id = ? AND latest_profile_revision = ?
      )
    `).bind(
      row.id,
      row.sessionId,
      row.leaseId,
      row.noteKind,
      row.lifecycle,
      row.reviewStatus,
      row.source,
      row.profileRevision,
      row.encrypted,
      row.hash,
      row.createdAt,
      row.reviewedAt,
      request.sessionId,
      revision,
      request.leaseId,
      request.sessionId,
      revision
    ));
  }
  const results = await db(env).batch(statements);
  const supersedeStart = 5;
  const insertStart = supersedeStart + supersededPlanningNotes.length;
  const requiredIndexes = [
    0, 1, 2, 4,
    ...supersededPlanningNotes.map((_note, index) => supersedeStart + index),
    ...planningNotes.map((_note, index) => insertStart + index)
  ];
  if (requiredIndexes.some((index) => Number(results[index]?.meta?.changes || 0) !== 1)) {
    throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed before the spoken confirmation was saved. Review it again.');
  }
  const sessionRow = await db(env).prepare(`SELECT * FROM consumer_sessions WHERE id = ? LIMIT 1`)
    .bind(request.sessionId).first();
  return {
    profile: nextProfile,
    sessionRow,
    revision,
    planningNotes: planningNotes.map((item) => item.note),
    planningNote: planningNotes[0]?.note || null
  };
}

/**
 * Persist a client's decision about one offered module.
 *
 * A decision is not a fact about the client's finances, so it does not go
 * through the fact-proposal machinery. It is still a durable, revisioned change
 * to the profile: a decline has to survive the rest of the call, and a later
 * reversal has to be an explicit new decision rather than the offer quietly
 * coming back.
 */
/**
 * Persist the client's answer to the three-analysis capacity decision.
 *
 * Reuses the same revisioned profile write as an ordinary module decision, and
 * the same planning helpers the deterministic layer already uses, so there is no
 * second copy of the replacement or deferral rules. Goals and collected facts
 * are untouched; only the planning decision fields move.
 */
export async function recordRealtimeCapacityDecision(env, request) {
  const currentRevision = Number(request.sessionRow.current_profile_revision || 1);
  const revision = currentRevision + 1;
  const timestamp = nowIso();
  const planning = request.profile?.assumptions?.values?.planning || {};
  const nextPlanning = request.decision === 'replace'
    ? applyModuleReplacement(planning, {
        removeModuleId: request.removeModuleId,
        addModuleId: request.candidateModuleId
      })
    : applyModuleDeferral(planning, request.candidateModuleId);

  const nextProfile = {
    ...request.profile,
    revision,
    confirmedAt: undefined,
    updatedAt: timestamp,
    assumptions: {
      ...request.profile.assumptions,
      values: { ...request.profile.assumptions.values, planning: nextPlanning }
    }
  };
  const payload = await encryptJson(
    env,
    nextProfile,
    `consumer/profile/${request.sessionId}/${revision}`
  );
  await db(env).batch([
    db(env).prepare(`
      INSERT INTO consumer_profile_revisions (
        session_id, revision, schema_version, payload_encrypted, confirmed_at, created_at
      )
      SELECT ?, ?, 1, ?, NULL, ?
      WHERE EXISTS (
        SELECT 1 FROM consumer_sessions
        WHERE id = ? AND deleted_at IS NULL AND current_profile_revision = ?
      )
    `).bind(request.sessionId, revision, payload, timestamp, request.sessionId, currentRevision),
    db(env).prepare(`
      UPDATE consumer_sessions
      SET current_profile_revision = ?, confirmed_profile_revision = NULL, last_active_at = ?
      WHERE id = ? AND deleted_at IS NULL AND current_profile_revision = ?
        AND EXISTS (
          SELECT 1 FROM consumer_profile_revisions WHERE session_id = ? AND revision = ?
        )
    `).bind(revision, timestamp, request.sessionId, currentRevision, request.sessionId, revision)
  ]);
  const sessionRow = await db(env).prepare('SELECT * FROM consumer_sessions WHERE id = ? LIMIT 1')
    .bind(request.sessionId).first();
  if (Number(sessionRow?.current_profile_revision) !== revision) {
    throw new ConsumerError(409, 'realtime_capacity_decision_conflict', 'The profile changed while recording that decision.');
  }
  return { profile: nextProfile, sessionRow, revision };
}

export async function recordRealtimeModuleDecision(env, request) {
  const currentRevision = Number(request.sessionRow.current_profile_revision || 1);
  const revision = currentRevision + 1;
  const timestamp = nowIso();
  const planning = request.profile?.assumptions?.values?.planning || {};
  const accepted = new Set(Array.isArray(planning.acceptedModuleIds) ? planning.acceptedModuleIds : []);
  const declined = new Set(Array.isArray(planning.declinedModuleIds) ? planning.declinedModuleIds : []);

  // A decision always replaces the previous one for that module, so a reversal
  // is a clean state change rather than two contradictory records.
  accepted.delete(request.moduleId);
  declined.delete(request.moduleId);
  if (request.decision === 'accepted') accepted.add(request.moduleId);
  if (request.decision === 'declined') declined.add(request.moduleId);

  const nextProfile = {
    ...request.profile,
    revision,
    confirmedAt: undefined,
    updatedAt: timestamp,
    assumptions: {
      ...request.profile.assumptions,
      values: {
        ...request.profile.assumptions.values,
        planning: {
          ...planning,
          acceptedModuleIds: [...accepted],
          declinedModuleIds: [...declined]
        }
      }
    }
  };
  const payload = await encryptJson(
    env,
    nextProfile,
    `consumer/profile/${request.sessionId}/${revision}`
  );
  await db(env).batch([
    db(env).prepare(`
      INSERT INTO consumer_profile_revisions (
        session_id, revision, schema_version, payload_encrypted, confirmed_at, created_at
      )
      SELECT ?, ?, 1, ?, NULL, ?
      WHERE EXISTS (
        SELECT 1 FROM consumer_sessions
        WHERE id = ? AND deleted_at IS NULL AND current_profile_revision = ?
      )
    `).bind(request.sessionId, revision, payload, timestamp, request.sessionId, currentRevision),
    db(env).prepare(`
      UPDATE consumer_sessions
      SET current_profile_revision = ?, confirmed_profile_revision = NULL, last_active_at = ?
      WHERE id = ? AND deleted_at IS NULL AND current_profile_revision = ?
        AND EXISTS (
          SELECT 1 FROM consumer_profile_revisions WHERE session_id = ? AND revision = ?
        )
    `).bind(revision, timestamp, request.sessionId, currentRevision, request.sessionId, revision)
  ]);
  const sessionRow = await db(env).prepare('SELECT * FROM consumer_sessions WHERE id = ? LIMIT 1')
    .bind(request.sessionId).first();
  if (Number(sessionRow?.current_profile_revision) !== revision) {
    throw new ConsumerError(409, 'realtime_module_decision_conflict', 'The profile changed while recording that decision.');
  }
  return { profile: nextProfile, sessionRow, revision };
}

export async function prepareRealtimeAnalysisPlan(env, request) {
  const id = randomId('realtime_plan');
  const planNonce = `plan_nonce_${await hmacSha256Base64Url(
    env.CONSUMER_RATE_LIMIT_HASH_KEY,
    `consumer/realtime/analysis-plan-nonce/v1/${request.sessionId}/${id}`
  )}`;
  const [nonceHash, idempotencyHash] = await Promise.all([
    sha256Base64Url(planNonce),
    sha256Base64Url(String(request.idempotencyKey))
  ]);
  const input = {
    moduleIds: request.moduleIds || null,
    scenarioOverrides: request.scenarioOverrides || {},
    selectionPolicyVersion: request.selectionPolicyVersion || null,
    goalAssessment: request.goalAssessment || null,
    moduleSlots: request.moduleSlots || [],
    overrides: request.overrides || [],
    requiresGoalPriorityQuestion: request.requiresGoalPriorityQuestion === true,
    deferredGoalTypes: request.deferredGoalTypes || []
  };
  const inputHash = await sha256Base64Url(stableStringify(input));
  const inputEncrypted = await encryptJson(
    env,
    input,
    `consumer/realtime/analysis-plan/${request.sessionId}/${id}/input`
  );
  const timestamp = nowIso();
  let inserted = null;
  try {
    inserted = await db(env).prepare(`
      INSERT INTO consumer_realtime_analysis_plans (
        id, session_id, realtime_session_id, nonce_hash_b64u, idempotency_key_hash_b64u,
        profile_revision, status, module_ids_json, input_encrypted,
        input_snapshot_hash_b64u, result_encrypted, result_hash_b64u,
        analysis_run_id, error_code, created_at, confirmed_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, NULL)
      RETURNING *
    `).bind(
      id,
      request.sessionId,
      request.leaseId || null,
      nonceHash,
      idempotencyHash,
      request.profileRevision,
      // Keep the legacy NOT NULL column deliberately opaque. The authenticated
      // display contract and the execution contract are both reconstructed
      // from the same encrypted snapshot below, so there is no sensitive
      // plaintext index and no second source of truth to drift from execution.
      JSON.stringify({ schemaVersion: 2, encryptedInput: true }),
      inputEncrypted,
      inputHash,
      timestamp
    ).first();
  } catch (error) {
    const existing = await db(env).prepare(`
      SELECT * FROM consumer_realtime_analysis_plans
      WHERE session_id = ? AND idempotency_key_hash_b64u = ?
      LIMIT 1
    `).bind(request.sessionId, idempotencyHash).first().catch(() => null);
    if (!existing) throw error;
    if (existing.input_snapshot_hash_b64u !== inputHash
      || Number(existing.profile_revision) !== request.profileRevision
      || (existing.realtime_session_id || null) !== (request.leaseId || null)) {
      throw new ConsumerError(409, 'analysis_plan_nonce_conflict', 'This analysis-plan nonce was already used for a different request.');
    }
    let result = null;
    if (existing.result_encrypted) {
      result = await decryptJson(
        env,
        existing.result_encrypted,
        `consumer/realtime/analysis-plan/${request.sessionId}/${existing.id}/result`
      );
    }
    const replayNonce = `plan_nonce_${await hmacSha256Base64Url(
      env.CONSUMER_RATE_LIMIT_HASH_KEY,
      `consumer/realtime/analysis-plan-nonce/v1/${request.sessionId}/${existing.id}`
    )}`;
    return { row: existing, planNonce: replayNonce, idempotentReplay: true, result };
  }
  return { row: inserted, planNonce, idempotentReplay: false, result: null };
}

export async function confirmRealtimeAnalysisPlan(env, request) {
  const nonceHash = await sha256Base64Url(String(request.planNonce));
  let row = await db(env).prepare(`
    SELECT plans.*, sessions.current_profile_revision, sessions.confirmed_profile_revision
    FROM consumer_realtime_analysis_plans AS plans
    INNER JOIN consumer_sessions AS sessions ON sessions.id = plans.session_id
    WHERE plans.id = ? AND plans.session_id = ?
      AND plans.nonce_hash_b64u = ?
      AND sessions.deleted_at IS NULL
    LIMIT 1
  `).bind(request.planId, request.sessionId, nonceHash).first();
  if (!row) throw new ConsumerError(403, 'analysis_plan_confirmation_invalid', 'The analysis confirmation is invalid or expired.');
  const expectedRevision = Number(request.profileRevision);
  const currentRevision = Number(row.current_profile_revision);
  const confirmedRevision = row.confirmed_profile_revision === null
    ? null
    : Number(row.confirmed_profile_revision);
  if (Number(row.profile_revision) !== expectedRevision
    || currentRevision !== expectedRevision
    || confirmedRevision !== expectedRevision) {
    await db(env).prepare(`
      UPDATE consumer_realtime_analysis_plans
      SET status = 'conflicted', error_code = 'profile_revision_conflict', completed_at = ?
      WHERE id = ? AND session_id = ? AND status = 'prepared'
    `).bind(nowIso(), request.planId, request.sessionId).run();
    throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed before this analysis plan was confirmed. Prepare and review it again.');
  }
  if (['complete', 'needs_information'].includes(row.status)) {
    const result = row.result_encrypted
      ? await decryptJson(env, row.result_encrypted, `consumer/realtime/analysis-plan/${request.sessionId}/${row.id}/result`)
      : null;
    const input = await decryptJson(
      env,
      row.input_encrypted,
      `consumer/realtime/analysis-plan/${request.sessionId}/${row.id}/input`
    );
    return { row, input, result, idempotentReplay: true };
  }
  if (row.status !== 'prepared') {
    throw new ConsumerError(409, 'analysis_plan_state_conflict', 'The analysis plan is already being processed or is no longer current.');
  }
  const confirmedAt = nowIso();
  row = await db(env).prepare(`
    UPDATE consumer_realtime_analysis_plans
    SET status = 'confirmed', confirmed_at = ?
    WHERE id = ? AND session_id = ? AND status = 'prepared'
      AND nonce_hash_b64u = ? AND profile_revision = ?
    RETURNING *
  `).bind(confirmedAt, request.planId, request.sessionId, nonceHash, expectedRevision).first();
  if (!row) throw new ConsumerError(409, 'analysis_plan_state_conflict', 'The analysis plan changed before confirmation.');
  const input = await decryptJson(
    env,
    row.input_encrypted,
    `consumer/realtime/analysis-plan/${request.sessionId}/${row.id}/input`
  );
  return { row, input, result: null, idempotentReplay: false };
}

export async function markRealtimeAnalysisPlanRunning(env, sessionId, planId) {
  const row = await db(env).prepare(`
    UPDATE consumer_realtime_analysis_plans
    SET status = 'running'
    WHERE id = ? AND session_id = ? AND status = 'confirmed'
    RETURNING *
  `).bind(planId, sessionId).first();
  if (!row) throw new ConsumerError(409, 'analysis_plan_state_conflict', 'The analysis plan is not ready to run.');
  return row;
}

export async function completeRealtimeAnalysisPlan(env, request) {
  const resultHash = await sha256Base64Url(stableStringify(request.result));
  const resultEncrypted = await encryptJson(
    env,
    request.result,
    `consumer/realtime/analysis-plan/${request.sessionId}/${request.planId}/result`
  );
  const row = await db(env).prepare(`
    UPDATE consumer_realtime_analysis_plans
    SET status = ?, result_encrypted = ?, result_hash_b64u = ?,
        analysis_run_id = ?, error_code = ?, completed_at = ?
    WHERE id = ? AND session_id = ? AND status IN ('confirmed', 'running')
    RETURNING *
  `).bind(
    request.status,
    resultEncrypted,
    resultHash,
    request.analysisRunId || null,
    request.errorCode || null,
    nowIso(),
    request.planId,
    request.sessionId
  ).first();
  if (!row) throw new ConsumerError(409, 'analysis_plan_state_conflict', 'The analysis plan changed before it completed.');
  return row;
}

export async function getRealtimeAnalysisPlanResult(env, sessionId, planId = null) {
  const row = await db(env).prepare(`
    SELECT * FROM consumer_realtime_analysis_plans
    WHERE session_id = ?
      AND (? IS NULL OR id = ?)
      AND status IN ('complete', 'needs_information')
    ORDER BY completed_at DESC
    LIMIT 1
  `).bind(sessionId, planId, planId).first();
  if (!row?.result_encrypted) return null;
  const result = await decryptJson(
    env,
    row.result_encrypted,
    `consumer/realtime/analysis-plan/${sessionId}/${row.id}/result`
  );
  return { row, result };
}

function toPublicModuleSlot(slot) {
  if (!slot || typeof slot !== 'object') return null;
  const slotNumber = Number(slot.slot);
  if (
    ![1, 2, 3].includes(slotNumber)
    || typeof slot.moduleId !== 'string'
    || !consumerLanguageForModule(slot.moduleId)
  ) {
    return null;
  }
  return {
    slot: slotNumber,
    moduleId: slot.moduleId,
    source: typeof slot.source === 'string' ? slot.source : 'persona_default',
    availability: typeof slot.availability === 'string' ? slot.availability : 'unsupported',
    intakeStatus: typeof slot.intakeStatus === 'string' ? slot.intakeStatus : 'missing_information',
    relatedGoalTypes: Array.isArray(slot.relatedGoalTypes)
      ? slot.relatedGoalTypes.filter((value) => typeof value === 'string').slice(0, 8)
      : [],
    reasons: Array.isArray(slot.reasons)
      ? slot.reasons.filter((value) => typeof value === 'string').slice(0, 8)
      : [],
    missingFactIds: Array.isArray(slot.missingFactIds)
      ? slot.missingFactIds.filter((value) => typeof value === 'string').slice(0, 24)
      : []
  };
}

function toPublicPlanOverride(override) {
  if (!override || typeof override !== 'object') return null;
  const replacedModuleId = typeof override.replacedModuleId === 'string'
    ? override.replacedModuleId
    : null;
  const moduleId = typeof override.moduleId === 'string' ? override.moduleId : null;
  if (
    (replacedModuleId && !consumerLanguageForModule(replacedModuleId))
    || (moduleId && !consumerLanguageForModule(moduleId))
  ) {
    return null;
  }
  return {
    ruleId: typeof override.ruleId === 'string' ? override.ruleId : null,
    goalType: typeof override.goalType === 'string' ? override.goalType : null,
    replacedModuleId,
    moduleId
  };
}

export function toPublicRealtimeAnalysisPlan(row, decryptedInput = null) {
  if (!row) return null;
  const input = decryptedInput && typeof decryptedInput === 'object' ? decryptedInput : {};
  const moduleIds = Array.isArray(input.moduleIds)
    ? input.moduleIds.filter((item) => (
        typeof item === 'string' && consumerLanguageForModule(item)
      )).slice(0, 3)
    : [];
  const selectionPolicyVersion = typeof input.selectionPolicyVersion === 'string'
    ? input.selectionPolicyVersion.slice(0, 80)
    : null;
  const goalAssessment = toPublicGoalAssessment(input.goalAssessment);
  const moduleSlots = Array.isArray(input.moduleSlots)
    ? input.moduleSlots.map(toPublicModuleSlot).filter(Boolean).slice(0, 3)
    : [];
  const overrides = Array.isArray(input.overrides)
    ? input.overrides.map(toPublicPlanOverride).filter(Boolean).slice(0, 6)
    : [];
  const requiresGoalPriorityQuestion = input.requiresGoalPriorityQuestion === true;
  const deferredGoalTypes = Array.isArray(input.deferredGoalTypes)
    ? input.deferredGoalTypes.filter((item) => typeof item === 'string').slice(0, 8)
    : [];
  return {
    planId: row.id,
    leaseId: row.realtime_session_id || null,
    profileRevision: Number(row.profile_revision),
    status: row.status,
    moduleIds,
    selectionPolicyVersion,
    goalAssessment,
    moduleSlots,
    overrides,
    requiresGoalPriorityQuestion,
    deferredGoalTypes,
    analysisRunId: row.analysis_run_id || null,
    errorCode: row.error_code || null,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at || null,
    completedAt: row.completed_at || null
  };
}

export async function getPublicRealtimeAnalysisPlan(env, row) {
  if (!row) return null;
  const input = await decryptJson(
    env,
    row.input_encrypted,
    `consumer/realtime/analysis-plan/${row.session_id}/${row.id}/input`
  );
  return toPublicRealtimeAnalysisPlan(row, input);
}

export async function getCurrentRealtimeAnalysisPlan(env, sessionId) {
  return db(env).prepare(`
    SELECT * FROM consumer_realtime_analysis_plans
    WHERE session_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(sessionId).first();
}

export async function getRealtimeAnalysisPlanExecution(env, sessionId, planId, leaseId = null) {
  const row = await db(env).prepare(`
    SELECT * FROM consumer_realtime_analysis_plans
    WHERE id = ? AND session_id = ?
      AND (? IS NULL OR realtime_session_id = ?)
    LIMIT 1
  `).bind(planId, sessionId, leaseId, leaseId).first();
  if (!row) throw notFound('This analysis plan could not be found.');
  const input = await decryptJson(
    env,
    row.input_encrypted,
    `consumer/realtime/analysis-plan/${sessionId}/${row.id}/input`
  );
  const planNonce = `plan_nonce_${await hmacSha256Base64Url(
    env.CONSUMER_RATE_LIMIT_HASH_KEY,
    `consumer/realtime/analysis-plan-nonce/v1/${sessionId}/${row.id}`
  )}`;
  return { row, input, planNonce };
}

export async function getRealtimeProviderCallId(env, sessionId, leaseId) {
  const row = await getRealtimeLease(env, sessionId, leaseId);
  if (!row?.provider_call_id_encrypted) return null;
  const value = await decryptJson(
    env,
    row.provider_call_id_encrypted,
    `consumer/realtime/session/${sessionId}/${leaseId}/provider-call`
  );
  return typeof value?.providerCallId === 'string' ? value.providerCallId : null;
}

export async function recordRealtimeRunProvenance(env, request) {
  const id = randomId('realtime_run');
  await db(env).prepare(`
    INSERT INTO consumer_realtime_run_provenance (
      id, realtime_session_id, session_id, tool_attempt_id,
      analysis_run_id, module_run_id, profile_revision,
      fact_proposal_ids_hash_b64u, prompt_version, toolset_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    request.leaseId,
    request.sessionId,
    request.toolAttemptId || null,
    request.analysisRunId || null,
    request.moduleRunId || null,
    request.profileRevision,
    request.factProposalIdsHash || null,
    request.promptVersion,
    request.toolsetVersion,
    nowIso()
  ).run();
  return id;
}

export async function listExpiredRealtimeLeases(env, limit = 50) {
  const result = await db(env).prepare(`
    SELECT * FROM consumer_realtime_sessions
    WHERE channel = 'voice'
      AND status IN ('pending', 'active', 'closing')
      AND (hard_expires_at <= ? OR idle_expires_at <= ?)
    ORDER BY hard_expires_at ASC
    LIMIT ?
  `).bind(nowIso(), nowIso(), limit).all();
  return result.results || [];
}
