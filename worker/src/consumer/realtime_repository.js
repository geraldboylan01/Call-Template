import { ConsumerError, notFound } from './errors.js';
import { redactSensitiveIdentifiers } from './validators.js';
import {
  decryptJson,
  encryptJson,
  hmacSha256Base64Url,
  randomId,
  sha256Base64Url,
  stableStringify
} from './crypto.js';

const REALTIME_EVENT_FIELDS = Object.freeze({
  'realtime.call.activated': new Set(['model', 'promptVersion', 'toolsetVersion']),
  'realtime.call.closed': new Set(['reason', 'status']),
  'realtime.provider.connected': new Set([]),
  'realtime.provider.disconnected': new Set(['code']),
  'realtime.provider.error': new Set(['code']),
  'realtime.response.started': new Set([]),
  'realtime.response.first_output': new Set(['latencyMs']),
  'realtime.response.interrupted': new Set(['latencyMs']),
  'realtime.response.completed': new Set(['responseCount', 'estimatedCostMicroEur']),
  'realtime.tool.received': new Set(['toolName']),
  'realtime.tool.completed': new Set(['toolName', 'status', 'errorCode']),
  'realtime.analysis_plan.updated': new Set(['planId', 'status', 'profileRevision']),
  'realtime.reasoning.escalation': new Set(['requested', 'applied', 'reason'])
});
const FORBIDDEN_REALTIME_EVENT_TYPE = /(?:audio|delta|transcript)/i;

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
    endedAt: row.ended_at || null
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

export async function createRealtimeLease(env, sessionRow, config, providerCostEntry) {
  const timestamp = nowIso();
  const hardExpiresAt = new Date(Date.now() + config.realtimeMaxDurationSeconds * 1_000).toISOString();
  const idleExpiresAt = new Date(Date.now() + config.realtimeIdleTimeoutSeconds * 1_000).toISOString();
  const id = randomId('rt');
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
        last_active_at, ended_at
      )
      SELECT ?, ?, ?, 'openai', NULL, NULL, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, 0, 0, 0, 0, NULL, NULL, ?, NULL, ?, NULL
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
      providerCostEntry.id,
      sessionRow.id,
      config.realtimeNoticeId,
      config.realtimeDataPolicyId,
      config.consentPolicyVersion,
      config.privacyNoticeUrl
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

export async function getActiveRealtimeLease(env, sessionId) {
  return db(env).prepare(`
    SELECT * FROM consumer_realtime_sessions
    WHERE session_id = ? AND status IN ('pending', 'active', 'closing')
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(sessionId).first();
}

export async function getLatestRealtimeLease(env, sessionId) {
  return db(env).prepare(`
    SELECT * FROM consumer_realtime_sessions
    WHERE session_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(sessionId).first();
}

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
      ) AS read_only_tool_succeeded
  `).bind(sessionId, leaseId, sessionId, leaseId).first();
  return {
    sidebandConnected: Number(row?.sideband_connected) === 1,
    readOnlyToolSucceeded: Number(row?.read_only_tool_succeeded) === 1
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
  return row || getRealtimeLease(env, sessionId, leaseId);
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
  const allowedFields = REALTIME_EVENT_FIELDS[eventType];
  if (!allowedFields || FORBIDDEN_REALTIME_EVENT_TYPE.test(eventType)) return null;
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
  const rawPayload = request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload)
    ? request.payload
    : {};
  const payload = Object.fromEntries(
    Object.entries(rawPayload)
      .filter(([key, value]) => allowedFields.has(key) && (
        value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ))
      .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 160) : value])
  );
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
      request.usageKind === 'transcription' ? 'transcription' : 'response',
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
          ), 0),
          last_active_at = ?
      WHERE id = ? AND session_id = ? AND status IN ('active', 'closing')
    `).bind(request.leaseId, request.leaseId, timestamp, request.leaseId, request.sessionId)
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
        sensitive_details_removed, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      request.leaseId,
      request.sessionId,
      providerItemHash,
      request.role,
      encrypted,
      transcriptHash,
      transcript !== raw ? 1 : 0,
      nowIso()
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

export async function listRealtimeFinalTurns(env, sessionId, leaseId, limit = 40) {
  const result = await db(env).prepare(`
    SELECT id, realtime_session_id, role, transcript_encrypted,
           sensitive_details_removed, created_at
    FROM consumer_realtime_final_turns
    WHERE session_id = ? AND realtime_session_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).bind(sessionId, leaseId, Math.max(1, Math.min(40, limit))).all();
  const turns = [];
  for (const row of result.results || []) {
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
  return turns;
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
        error_code, latency_ms, created_at, completed_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, NULL, NULL, NULL, NULL,
             NULL, 0, ?, NULL
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
  const [valueEncrypted, patchEncrypted] = await Promise.all([
    encryptJson(
      env,
      request.value,
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
    request.factId,
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
    const value = await decryptJson(
      env,
      row.value_encrypted,
      `consumer/realtime/fact-proposal/${sessionId}/${row.realtime_session_id}/${row.id}/value`
    );
    summaries.push({
      proposalId: row.id,
      factId: row.fact_id,
      value,
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
  const [value, patch] = await Promise.all([
    decryptJson(env, row.value_encrypted, `consumer/realtime/fact-proposal/${sessionId}/${leaseId}/${row.id}/value`),
    decryptJson(env, row.patch_encrypted, `consumer/realtime/fact-proposal/${sessionId}/${leaseId}/${row.id}/patch`)
  ]);
  return {
    row,
    value,
    patch,
    pendingCount: Number(row.pending_count || 0),
    currentPendingId: row.current_pending_id || null
  };
}

export async function rejectRealtimeFactProposal(env, sessionId, leaseId, proposalId, evidenceItemId) {
  const row = await db(env).prepare(`
    UPDATE consumer_realtime_fact_proposals
    SET status = 'rejected', confirmation_evidence_item_id = ?, reviewed_at = ?
    WHERE id = ? AND session_id = ? AND realtime_session_id = ?
      AND status = 'proposed'
    RETURNING id, fact_id, status, base_profile_revision
  `).bind(evidenceItemId, nowIso(), proposalId, sessionId, leaseId).first();
  if (!row) throw notFound('This proposed fact change could not be found.');
  if (row.fact_id === 'primary_goal') {
    await db(env).prepare(`
      UPDATE consumer_realtime_fact_proposals
      SET status = 'conflicted', confirmation_evidence_item_id = ?, reviewed_at = ?
      WHERE session_id = ? AND realtime_session_id = ?
        AND status = 'proposed' AND fact_id = 'target_home_price'
    `).bind(evidenceItemId, nowIso(), sessionId, leaseId).run();
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
  const results = await db(env).batch([
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
    )
  ]);
  if (results.slice(0, 3).some((result) => Number(result?.meta?.changes || 0) !== 1)) {
    throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed before the spoken confirmation was saved. Review it again.');
  }
  const sessionRow = await db(env).prepare(`SELECT * FROM consumer_sessions WHERE id = ? LIMIT 1`)
    .bind(request.sessionId).first();
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
    scenarioOverrides: request.scenarioOverrides || {}
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
      JSON.stringify(request.moduleIds || []),
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
    return { row, input: null, result, idempotentReplay: true };
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

export function toPublicRealtimeAnalysisPlan(row) {
  if (!row) return null;
  let moduleIds = [];
  try {
    const parsed = JSON.parse(row.module_ids_json || '[]');
    if (Array.isArray(parsed)) moduleIds = parsed.filter((item) => typeof item === 'string').slice(0, 12);
  } catch (_error) {
    moduleIds = [];
  }
  return {
    planId: row.id,
    leaseId: row.realtime_session_id || null,
    profileRevision: Number(row.profile_revision),
    status: row.status,
    moduleIds,
    analysisRunId: row.analysis_run_id || null,
    errorCode: row.error_code || null,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at || null,
    completedAt: row.completed_at || null
  };
}

export async function getCurrentRealtimeAnalysisPlan(env, sessionId) {
  return db(env).prepare(`
    SELECT * FROM consumer_realtime_analysis_plans
    WHERE session_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(sessionId).first();
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
    WHERE status IN ('pending', 'active', 'closing')
      AND (hard_expires_at <= ? OR idle_expires_at <= ?)
    ORDER BY hard_expires_at ASC
    LIMIT ?
  `).bind(nowIso(), nowIso(), limit).all();
  return result.results || [];
}
