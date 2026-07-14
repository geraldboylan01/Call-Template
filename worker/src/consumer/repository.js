import { ConsumerError, notFound } from './errors.js';
import {
  decryptJson,
  encryptJson,
  getCurrentEncryptionKeyId,
  getEncryptedPayloadKeyId,
  hmacSha256Base64Url,
  randomId,
  sha256Base64Url,
  stableStringify
} from './crypto.js';
import {
  confirmHouseholdProfile,
  createHouseholdProfile,
  normalizeHouseholdProfile
} from '../../../js/planning/profile.js';
import {
  chargedProviderCostEurMicros,
  failClosedEurMicros,
  requireEurMicros
} from './cost_budget.js';

const ALLOWED_EVENT_NAMES = new Set([
  'consumer_journey_started', 'goal_identified', 'profile_section_completed',
  'profile_updated', 'profile_confirmed', 'turn_completed', 'module_recommended',
  'module_removed', 'module_run', 'analysis_started', 'analysis_completed',
  'analysis_needs_information', 'analysis_failed', 'scenario_run', 'handoff_requested', 'handoff_linked',
  'handoff_revoked',
  'handoff_viewed', 'consultation_booked', 'consultation_paid',
  'ai_consent_withdrawn', 'handoff_package_purged',
  'journey_abandoned', 'journey_deleted', 'journey_expired'
]);

const EVENT_METADATA_FIELDS = Object.freeze({
  consumer_journey_started: new Set(['cohort']),
  profile_updated: new Set(['revision']),
  profile_confirmed: new Set(['revision']),
  turn_completed: new Set(['mode', 'modelTier']),
  module_recommended: new Set(['moduleId', 'priority', 'status']),
  module_run: new Set(['moduleId', 'status']),
  scenario_run: new Set(['moduleIds']),
  analysis_started: new Set(['analysisRunId', 'moduleIds']),
  analysis_completed: new Set(['analysisRunId', 'status']),
  analysis_failed: new Set(['analysisRunId']),
  analysis_needs_information: new Set(['analysisRunId', 'requiredQuestionCount']),
  handoff_requested: new Set(['handoffId', 'recipient']),
  handoff_linked: new Set(['handoffId']),
  handoff_revoked: new Set(['handoffId', 'downstreamShared']),
  handoff_package_purged: new Set(['handoffId'])
});

const SAFE_PROVIDER_COST_TOKEN = /^[A-Za-z0-9._:-]+$/;

function providerCostChargeSql(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return `CASE
    WHEN ${prefix}status = 'known'
      THEN COALESCE(${prefix}actual_cost_eur_micros, ${prefix}reserved_cost_eur_micros)
    WHEN ${prefix}status = 'not_sent' THEN 0
    ELSE ${prefix}reserved_cost_eur_micros
  END`;
}

function db(env) {
  if (!env.CONSUMER_DB) {
    throw new ConsumerError(503, 'consumer_storage_unavailable', 'This planning journey is not available right now.');
  }
  return env.CONSUMER_DB;
}

function nowIso() {
  return new Date().toISOString();
}

const ENCRYPTED_PAYLOAD_SPECS = Object.freeze([
  {
    table: 'consumer_sessions',
    column: 'rolling_summary_encrypted',
    keys: ['id'],
    select: 'id',
    aad: (row) => `consumer/summary/${row.id}`
  },
  {
    table: 'consumer_profile_revisions',
    column: 'payload_encrypted',
    keys: ['session_id', 'revision'],
    select: 'session_id, revision',
    aad: (row) => `consumer/profile/${row.session_id}/${row.revision}`
  },
  {
    table: 'consumer_conversation_turns',
    column: 'payload_encrypted',
    keys: ['id'],
    select: 'id, session_id',
    aad: (row) => `consumer/turn/${row.session_id}/${row.id}`
  },
  {
    table: 'consumer_analysis_runs',
    column: 'payload_encrypted',
    keys: ['id'],
    select: 'id, session_id',
    aad: (row) => `consumer/analysis/${row.session_id}/${row.id}`
  },
  {
    table: 'consumer_module_runs',
    column: 'payload_encrypted',
    keys: ['id'],
    select: 'id, session_id',
    aad: (row) => `consumer/module/${row.session_id}/${row.id}`
  },
  {
    table: 'consumer_handoffs',
    column: 'package_encrypted',
    keys: ['id'],
    select: 'id, session_id',
    aad: (row) => `consumer/handoff/${row.session_id}/${row.id}`
  },
  {
    table: 'consumer_realtime_sessions',
    column: 'provider_call_id_encrypted',
    keys: ['id'],
    select: 'id, session_id',
    aad: (row) => `consumer/realtime/session/${row.session_id}/${row.id}/provider-call`
  },
  {
    table: 'consumer_realtime_events',
    column: 'payload_encrypted',
    keys: ['id'],
    select: 'id, session_id, realtime_session_id, sequence',
    aad: (row) => `consumer/realtime/event/${row.session_id}/${row.realtime_session_id}/${row.sequence}`
  },
  {
    table: 'consumer_realtime_tool_attempts',
    column: 'arguments_encrypted',
    keys: ['id'],
    select: 'id, session_id, realtime_session_id',
    aad: (row) => `consumer/realtime/tool/${row.session_id}/${row.realtime_session_id}/${row.id}/arguments`
  },
  {
    table: 'consumer_realtime_tool_attempts',
    column: 'result_encrypted',
    keys: ['id'],
    select: 'id, session_id, realtime_session_id',
    aad: (row) => `consumer/realtime/tool/${row.session_id}/${row.realtime_session_id}/${row.id}/result`
  },
  {
    table: 'consumer_realtime_final_turns',
    column: 'transcript_encrypted',
    keys: ['id'],
    select: 'id, session_id, realtime_session_id',
    aad: (row) => `consumer/realtime/final-turn/${row.session_id}/${row.realtime_session_id}/${row.id}`
  },
  {
    table: 'consumer_realtime_fact_proposals',
    column: 'value_encrypted',
    keys: ['id'],
    select: 'id, session_id, realtime_session_id',
    aad: (row) => `consumer/realtime/fact-proposal/${row.session_id}/${row.realtime_session_id}/${row.id}/value`
  },
  {
    table: 'consumer_realtime_fact_proposals',
    column: 'patch_encrypted',
    keys: ['id'],
    select: 'id, session_id, realtime_session_id',
    aad: (row) => `consumer/realtime/fact-proposal/${row.session_id}/${row.realtime_session_id}/${row.id}/patch`
  },
  {
    table: 'consumer_realtime_analysis_plans',
    column: 'input_encrypted',
    keys: ['id'],
    select: 'id, session_id',
    aad: (row) => `consumer/realtime/analysis-plan/${row.session_id}/${row.id}/input`
  },
  {
    table: 'consumer_realtime_analysis_plans',
    column: 'result_encrypted',
    keys: ['id'],
    select: 'id, session_id',
    aad: (row) => `consumer/realtime/analysis-plan/${row.session_id}/${row.id}/result`
  }
]);

function nonCurrentKeyPredicate(column) {
  return `CASE WHEN json_valid(${column})
    THEN COALESCE(json_extract(${column}, '$.kid'), '')
    ELSE '' END <> ?`;
}

function asBoolean(value) {
  return Number(value) === 1;
}

export function toConsumerSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.id,
    schemaVersion: Number(row.schema_version || 1),
    status: row.status,
    stage: row.stage,
    profileRevision: Number(row.current_profile_revision || 1),
    currentProfileRevision: Number(row.current_profile_revision || 1),
    confirmedProfileRevision: row.confirmed_profile_revision === null || row.confirmed_profile_revision === undefined
      ? null
      : Number(row.confirmed_profile_revision),
    featureCohort: row.feature_cohort,
    aiProcessingConsented: asBoolean(row.consent_ai_processing),
    consent: {
      analysis: asBoolean(row.consent_analysis),
      aiProcessing: asBoolean(row.consent_ai_processing),
      adultConfirmed: asBoolean(row.consent_adult_confirmed),
      educationOnlyAcknowledged: asBoolean(row.consent_education_only),
      manifestId: row.consent_manifest_id,
      policyVersion: row.consent_policy_version,
      analysisNoticeId: row.consent_analysis_notice_id,
      aiNoticeId: row.consent_ai_notice_id,
      privacyNoticeUrl: row.consent_privacy_notice_url,
      capturedAt: row.consent_captured_at
    },
    consentPolicyVersion: row.consent_policy_version,
    aiConsentWithdrawnAt: row.ai_consent_withdrawn_at || null,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_profile_revision ? row.last_active_at : null
  };
}

function requiredProviderCostToken(value, label, maximumLength) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > maximumLength || !SAFE_PROVIDER_COST_TOKEN.test(result)) {
    throw new ConsumerError(400, 'invalid_provider_cost_request', `${label} is invalid.`);
  }
  return result;
}

function optionalProviderCostToken(value, label, maximumLength) {
  if (value === null || value === undefined || value === '') return null;
  return requiredProviderCostToken(value, label, maximumLength);
}

function requiredProviderCostHttpsUrl(value, label, maximumLength = 2048) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > maximumLength) {
    throw new ConsumerError(400, 'invalid_provider_cost_request', `${label} is invalid.`);
  }
  try {
    const parsed = new URL(result);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('invalid');
    return parsed.toString();
  } catch (_error) {
    throw new ConsumerError(400, 'invalid_provider_cost_request', `${label} is invalid.`);
  }
}

function providerCostAmount(value, label, { allowZero = true } = {}) {
  try {
    return requireEurMicros(value, label, { allowZero });
  } catch (_error) {
    throw new ConsumerError(
      400,
      'invalid_provider_cost_request',
      `${label} must be ${allowZero ? 'a non-negative' : 'a positive'} integer in micro-euros.`
    );
  }
}

function providerCostAggregate(value, label) {
  const result = Number(value || 0);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new ConsumerError(503, 'provider_budget_unavailable', `${label} could not be read safely.`);
  }
  return result;
}

function utcDayBounds(timestamp = nowIso()) {
  const current = new Date(timestamp);
  if (Number.isNaN(current.getTime())) {
    throw new ConsumerError(500, 'provider_budget_clock_invalid', 'The provider budget clock is unavailable.');
  }
  const start = new Date(current);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function toProviderBudget(limitEurMicros, row, period = {}) {
  const limit = failClosedEurMicros(limitEurMicros);
  const spent = providerCostAggregate(row?.spent_eur_micros, 'Provider budget spend');
  const knownActual = providerCostAggregate(row?.known_actual_eur_micros, 'Known provider spend');
  const reservedOrUnknown = providerCostAggregate(
    row?.reserved_or_unknown_eur_micros,
    'Reserved provider spend'
  );
  const released = providerCostAggregate(row?.released_eur_micros, 'Released provider spend');
  return Object.freeze({
    currency: 'EUR',
    unit: 'micro-euro',
    limitEurMicros: limit,
    // "spent" is deliberately conservative: active reservations and unknown
    // outcomes count until provider billing is known or non-delivery is proven.
    spentEurMicros: spent,
    knownActualEurMicros: knownActual,
    reservedOrUnknownEurMicros: reservedOrUnknown,
    releasedEurMicros: released,
    remainingEurMicros: Math.max(0, limit - spent),
    overLimitEurMicros: Math.max(0, spent - limit),
    exhausted: limit === 0 || spent >= limit,
    failClosed: limit === 0,
    ...period
  });
}

export function toConsumerProviderCost(row) {
  if (!row) return null;
  const entry = {
    id: row.id,
    sessionId: row.session_id,
    operation: row.operation,
    idempotencyKey: row.idempotency_key,
    provider: row.provider,
    model: row.model || null,
    pricingVersion: row.pricing_version,
    status: row.status,
    reservedCostEurMicros: providerCostAggregate(
      row.reserved_cost_eur_micros,
      'Provider cost reservation'
    ),
    actualCostEurMicros: row.actual_cost_eur_micros === null || row.actual_cost_eur_micros === undefined
      ? null
      : providerCostAggregate(row.actual_cost_eur_micros, 'Actual provider cost'),
    errorCode: row.error_code || null,
    dispatchedAt: row.dispatched_at || null,
    createdAt: row.created_at,
    completedAt: row.completed_at || null
  };
  return Object.freeze({
    ...entry,
    inFlight: entry.status === 'reserved' && Boolean(entry.dispatchedAt),
    chargedCostEurMicros: chargedProviderCostEurMicros(entry)
  });
}

export function createInitialProfile(sessionId, consent, timestamp) {
  const profile = createHouseholdProfile({
    profileId: `profile_${sessionId.slice(3)}`,
    primaryPersonId: 'primary',
    nowIso: timestamp,
    calculationDateIso: timestamp.slice(0, 10)
  });
  return normalizeHouseholdProfile({
    ...profile,
    revision: 1,
    consent: [
      {
        consentId: randomId('consent'),
        purpose: 'analysis',
        granted: true,
        policyVersion: consent.policyVersion,
        capturedAt: timestamp
      },
      {
        consentId: randomId('consent'),
        purpose: 'ai_processing',
        granted: consent.aiProcessing,
        policyVersion: consent.policyVersion,
        capturedAt: timestamp
      }
    ]
  });
}

export async function createSessionRecord(env, credential, consent, config, inviteClaims = null) {
  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000).toISOString();
  const providerCostLimitEurMicros = failClosedEurMicros(config.providerCostLimitEurMicros);
  const profile = createInitialProfile(credential.id, consent, timestamp);
  const [encryptedProfile, encryptedSummary] = await Promise.all([
    encryptJson(env, profile, `consumer/profile/${credential.id}/1`),
    encryptJson(env, { summary: '' }, `consumer/summary/${credential.id}`)
  ]);

  const inviteJtiHash = inviteClaims
    ? await sha256Base64Url(`consumer-invite/${inviteClaims.jti}`)
    : '';
  const statements = [];
  if (inviteClaims) {
    statements.push(
      db(env).prepare(`
        INSERT INTO consumer_invite_redemptions (
          jti_hash_b64u, cohort, expires_at, max_uses, use_count,
          revoked_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, NULL, ?, ?)
        ON CONFLICT(jti_hash_b64u) DO UPDATE SET
          updated_at = excluded.updated_at
        WHERE consumer_invite_redemptions.revoked_at IS NULL
          AND consumer_invite_redemptions.cohort = excluded.cohort
          AND consumer_invite_redemptions.expires_at = excluded.expires_at
          AND consumer_invite_redemptions.max_uses = excluded.max_uses
      `).bind(
        inviteJtiHash,
        inviteClaims.cohort,
        inviteClaims.expiresAt,
        inviteClaims.maxUses,
        timestamp,
        timestamp
      ),
      db(env).prepare(`
        INSERT INTO consumer_invite_uses (jti_hash_b64u, session_id, used_at)
        SELECT ?, ?, ?
        WHERE EXISTS (
          SELECT 1
          FROM consumer_invite_redemptions
          WHERE jti_hash_b64u = ? AND revoked_at IS NULL
            AND cohort = ? AND expires_at = ? AND max_uses = ?
            AND expires_at > ? AND use_count < max_uses
        )
      `).bind(
        inviteJtiHash,
        credential.id,
        timestamp,
        inviteJtiHash,
        inviteClaims.cohort,
        inviteClaims.expiresAt,
        inviteClaims.maxUses,
        timestamp
      ),
      db(env).prepare(`
        UPDATE consumer_invite_redemptions
        SET use_count = use_count + 1, updated_at = ?
        WHERE jti_hash_b64u = ?
          AND EXISTS (
            SELECT 1 FROM consumer_invite_uses
            WHERE jti_hash_b64u = ? AND session_id = ?
          )
          AND use_count < max_uses
      `).bind(timestamp, inviteJtiHash, inviteJtiHash, credential.id)
    );
  }
  statements.push(
    db(env).prepare(`
      INSERT INTO consumer_sessions (
        id, credential_hash_b64u, schema_version, status, stage,
        current_profile_revision, confirmed_profile_revision, feature_cohort, provider_cost_limit_eur_micros,
        consent_analysis, consent_ai_processing, consent_adult_confirmed, consent_education_only,
        consent_manifest_id, consent_policy_version, consent_analysis_notice_id, consent_ai_notice_id,
        consent_privacy_notice_url, consent_captured_at, ai_consent_withdrawn_at, rolling_summary_encrypted,
        created_at, last_active_at, expires_at, deleted_at
      )
      SELECT ?, ?, 1, 'active', 'goal_discovery', 1, NULL, ?, ?, 1, ?, 1, 1, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL
      WHERE ? = 1 OR EXISTS (
        SELECT 1 FROM consumer_invite_uses
        WHERE jti_hash_b64u = ? AND session_id = ?
      )
    `).bind(
      credential.id,
      credential.credentialHashB64u,
      config.cohort,
      providerCostLimitEurMicros,
      consent.aiProcessing ? 1 : 0,
      consent.manifestId,
      consent.policyVersion,
      consent.analysisNoticeId,
      consent.aiNoticeId,
      consent.privacyNoticeUrl,
      timestamp,
      encryptedSummary,
      timestamp,
      timestamp,
      expiresAt,
      inviteClaims ? 0 : 1,
      inviteJtiHash,
      credential.id
    ),
    db(env).prepare(`
      INSERT INTO consumer_profile_revisions (
        session_id, revision, schema_version, payload_encrypted, confirmed_at, created_at
      )
      SELECT ?, 1, 1, ?, NULL, ?
      WHERE EXISTS (SELECT 1 FROM consumer_sessions WHERE id = ?)
    `).bind(credential.id, encryptedProfile, timestamp, credential.id),
    db(env).prepare(`
      INSERT INTO consumer_consent_events (
        id, session_id, purpose, action, manifest_id, policy_version, notice_id,
        privacy_notice_url, capture_method, created_at
      )
      SELECT ?, ?, 'analysis', 'granted', ?, ?, ?, ?, 'consumer_web', ?
      WHERE EXISTS (SELECT 1 FROM consumer_sessions WHERE id = ?)
    `).bind(
      randomId('consent_event'),
      credential.id,
      consent.manifestId,
      consent.policyVersion,
      consent.analysisNoticeId,
      consent.privacyNoticeUrl,
      timestamp,
      credential.id
    ),
    db(env).prepare(`
      INSERT INTO consumer_consent_events (
        id, session_id, purpose, action, manifest_id, policy_version, notice_id,
        privacy_notice_url, capture_method, created_at
      )
      SELECT ?, ?, 'ai_processing', ?, ?, ?, ?, ?, 'consumer_web', ?
      WHERE EXISTS (SELECT 1 FROM consumer_sessions WHERE id = ?)
    `).bind(
      randomId('consent_event'),
      credential.id,
      consent.aiProcessing ? 'granted' : 'declined',
      consent.manifestId,
      consent.policyVersion,
      consent.aiNoticeId,
      consent.privacyNoticeUrl,
      timestamp,
      credential.id
    )
  );

  await db(env).batch(statements);
  const persistedSession = await getSessionRow(env, credential.id);
  if (!persistedSession) {
    throw new ConsumerError(403, 'consumer_invite_used', 'This planning invitation has already been used or revoked.');
  }

  await recordEvent(env, credential.id, 'consumer_journey_started', { cohort: config.cohort }).catch(() => {});
  return {
    session: toConsumerSession(persistedSession),
    profile
  };
}

export async function getSessionRow(env, sessionId) {
  return db(env).prepare(`
    SELECT *
    FROM consumer_sessions
    WHERE id = ?
    LIMIT 1
  `).bind(sessionId).first();
}

export async function getCurrentProfile(env, sessionRow) {
  const revision = Number(sessionRow.current_profile_revision || 1);
  const row = await db(env).prepare(`
    SELECT payload_encrypted
    FROM consumer_profile_revisions
    WHERE session_id = ? AND revision = ?
    LIMIT 1
  `).bind(sessionRow.id, revision).first();
  if (!row?.payload_encrypted) throw new ConsumerError(500, 'consumer_profile_missing', 'Saved profile data is unavailable.');
  return decryptJson(env, row.payload_encrypted, `consumer/profile/${sessionRow.id}/${revision}`);
}

export async function withdrawAiConsent(env, sessionRow, config = {}) {
  const timestamp = nowIso();
  if (Number(sessionRow.consent_ai_processing) !== 1) {
    return { session: toConsumerSession(sessionRow), changed: false };
  }

  // The session column is the enforcement source of truth. Update it first so
  // withdrawal remains available even during an encryption-key incident.
  const updated = await db(env).prepare(`
    UPDATE consumer_sessions
    SET consent_ai_processing = 0, ai_consent_withdrawn_at = ?, last_active_at = ?
    WHERE id = ? AND deleted_at IS NULL AND consent_ai_processing = 1
    RETURNING *
  `).bind(timestamp, timestamp, sessionRow.id).first();
  const effectiveRow = updated || await getSessionRow(env, sessionRow.id);
  if (updated) {
    try {
      const prior = await db(env).prepare(`
        SELECT notice_id, privacy_notice_url
        FROM consumer_consent_events
        WHERE session_id = ? AND purpose = 'ai_processing'
        ORDER BY created_at DESC
        LIMIT 1
      `).bind(sessionRow.id).first();
      await db(env).prepare(`
        INSERT INTO consumer_consent_events (
          id, session_id, purpose, action, manifest_id, policy_version, notice_id,
          privacy_notice_url, capture_method, created_at
        ) VALUES (?, ?, 'ai_processing', 'withdrawn', ?, ?, ?, ?, 'consumer_web', ?)
      `).bind(
        randomId('consent_event'),
        sessionRow.id,
        sessionRow.consent_manifest_id,
        sessionRow.consent_policy_version,
        prior?.notice_id || config.aiNoticeId || 'legacy-notice-unavailable',
        prior?.privacy_notice_url || config.privacyNoticeUrl || 'legacy-notice-unavailable',
        timestamp
      ).run();
    } catch (error) {
      // Enforcement above is authoritative; an audit-write incident must never
      // undo or prevent withdrawal.
      console.error('Consumer AI consent audit append failed', {
        sessionId: sessionRow.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // Keep the encrypted canonical profile's consent history aligned when the
  // key is available. Failure here must never re-enable AI processing.
  try {
    const revision = Number(effectiveRow.current_profile_revision || 1);
    const profile = await getCurrentProfile(env, effectiveRow);
    const consent = (profile.consent || []).map((record) => (
      record.purpose === 'ai_processing' && record.granted === true
        ? { ...record, granted: false, withdrawnAt: timestamp }
        : record
    ));
    const nextProfile = normalizeHouseholdProfile({
      ...profile,
      consent,
      updatedAt: timestamp
    });
    const encrypted = await encryptJson(env, nextProfile, `consumer/profile/${sessionRow.id}/${revision}`);
    await db(env).prepare(`
      UPDATE consumer_profile_revisions
      SET payload_encrypted = ?
      WHERE session_id = ? AND revision = ?
    `).bind(encrypted, sessionRow.id, revision).run();
  } catch (error) {
    console.error('Consumer AI consent profile sync failed', {
      sessionId: sessionRow.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  await recordEvent(env, sessionRow.id, 'ai_consent_withdrawn', {}).catch(() => {});
  return { session: toConsumerSession(effectiveRow), changed: Boolean(updated) };
}

export async function saveProfileRevision(env, sessionRow, profile, stage) {
  const revision = Number(sessionRow.current_profile_revision || 1) + 1;
  const timestamp = nowIso();
  const nextProfile = {
    ...profile,
    revision,
    confirmedAt: undefined,
    updatedAt: timestamp
  };
  const payload = await encryptJson(env, nextProfile, `consumer/profile/${sessionRow.id}/${revision}`);
  try {
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
      `).bind(
        sessionRow.id,
        revision,
        payload,
        timestamp,
        sessionRow.id,
        Number(sessionRow.current_profile_revision || 1)
      ),
      db(env).prepare(`
        UPDATE consumer_sessions
        SET current_profile_revision = ?, confirmed_profile_revision = NULL,
            stage = ?, last_active_at = ?
        WHERE id = ? AND deleted_at IS NULL AND current_profile_revision = ?
      `).bind(revision, stage || sessionRow.stage, timestamp, sessionRow.id, Number(sessionRow.current_profile_revision || 1))
    ]);
  } catch (_error) {
    throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed in another request. Refresh and try again.');
  }
  const persistedRow = await getSessionRow(env, sessionRow.id);
  if (Number(persistedRow?.current_profile_revision) !== revision) {
    throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed in another request. Refresh and try again.');
  }
  await recordEvent(env, sessionRow.id, 'profile_updated', { revision }).catch(() => {});
  return {
    profile: nextProfile,
    session: toConsumerSession(persistedRow)
  };
}

export async function confirmProfileRevision(env, sessionRow, profile) {
  const revision = Number(sessionRow.current_profile_revision || 1);
  const timestamp = nowIso();
  const confirmedProfile = confirmHouseholdProfile(profile, { confirmedAt: timestamp });
  const encrypted = await encryptJson(env, confirmedProfile, `consumer/profile/${sessionRow.id}/${revision}`);
  await db(env).batch([
    db(env).prepare(`
      UPDATE consumer_profile_revisions
      SET payload_encrypted = ?, confirmed_at = ?
      WHERE session_id = ? AND revision = ?
    `).bind(encrypted, timestamp, sessionRow.id, revision),
    db(env).prepare(`
      UPDATE consumer_sessions
      SET confirmed_profile_revision = ?, stage = 'module_recommendation', last_active_at = ?
      WHERE id = ? AND deleted_at IS NULL AND current_profile_revision = ?
    `).bind(revision, timestamp, sessionRow.id, revision)
  ]);
  const persistedRow = await getSessionRow(env, sessionRow.id);
  if (Number(persistedRow?.confirmed_profile_revision) !== revision
    || Number(persistedRow?.current_profile_revision) !== revision) {
    throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed before it could be confirmed. Refresh and try again.');
  }
  await recordEvent(env, sessionRow.id, 'profile_confirmed', { revision }).catch(() => {});
  return {
    profile: confirmedProfile,
    session: toConsumerSession(persistedRow)
  };
}

export async function getRollingSummary(env, sessionRow) {
  if (!sessionRow.rolling_summary_encrypted) return '';
  const value = await decryptJson(env, sessionRow.rolling_summary_encrypted, `consumer/summary/${sessionRow.id}`);
  return typeof value?.summary === 'string' ? value.summary.slice(-4_000) : '';
}

export async function getTurnByIdempotencyKey(env, sessionId, idempotencyKey) {
  const row = await db(env).prepare(`
    SELECT *
    FROM consumer_conversation_turns
    WHERE session_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(sessionId, idempotencyKey).first();
  if (!row) return null;
  return {
    row,
    payload: await decryptJson(env, row.payload_encrypted, `consumer/turn/${sessionId}/${row.id}`)
  };
}

export async function countSessionTurns(env, sessionId) {
  const row = await db(env).prepare(`
    SELECT COUNT(*) AS count
    FROM consumer_conversation_turns
    WHERE session_id = ?
  `).bind(sessionId).first();
  return Number(row?.count || 0);
}

export async function commitTurnExchange(env, {
  sessionRow,
  profile,
  profileChanged,
  stage,
  idempotencyKey,
  userMessage,
  metadata = {},
  rollingSummary,
  timestamp = nowIso(),
  buildPayload
}) {
  const sessionId = sessionRow.id;
  const revision = profileChanged
    ? Number(sessionRow.current_profile_revision || 1) + 1
    : Number(sessionRow.current_profile_revision || 1);
  const storedProfile = profileChanged
    ? { ...profile, revision, updatedAt: timestamp }
    : profile;
  if (profileChanged) delete storedProfile.confirmedAt;
  const effectiveRow = {
    ...sessionRow,
    current_profile_revision: revision,
    confirmed_profile_revision: profileChanged ? null : sessionRow.confirmed_profile_revision,
    stage,
    last_active_at: timestamp
  };
  const session = toConsumerSession(effectiveRow);
  const responsePayload = buildPayload(session, storedProfile);
  const turnId = randomId('turn');
  const [encryptedTurn, encryptedSummary, encryptedProfile] = await Promise.all([
    encryptJson(env, { userMessage, ...responsePayload }, `consumer/turn/${sessionId}/${turnId}`),
    encryptJson(env, { summary: String(rollingSummary || '').slice(-4_000) }, `consumer/summary/${sessionId}`),
    profileChanged
      ? encryptJson(env, storedProfile, `consumer/profile/${sessionId}/${revision}`)
      : Promise.resolve(null)
  ]);
  const statements = [
    db(env).prepare(`
      INSERT INTO consumer_conversation_turns (
        id, session_id, role, idempotency_key, payload_encrypted,
        model, model_tier, prompt_version, input_tokens, output_tokens,
        cached_input_tokens, latency_ms, created_at
      )
      SELECT ?, ?, 'exchange', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM consumer_sessions
        WHERE id = ? AND deleted_at IS NULL AND current_profile_revision = ?
      )
    `).bind(
      turnId,
      sessionId,
      idempotencyKey,
      encryptedTurn,
      metadata.model || null,
      metadata.modelTier || null,
      metadata.promptVersion || null,
      Number(metadata.inputTokens || 0),
      Number(metadata.outputTokens || 0),
      Number(metadata.cachedInputTokens || 0),
      Number(metadata.latencyMs || 0),
      timestamp,
      sessionId,
      Number(sessionRow.current_profile_revision || 1)
    )
  ];
  if (profileChanged) {
    statements.push(
      db(env).prepare(`
        INSERT INTO consumer_profile_revisions (
          session_id, revision, schema_version, payload_encrypted, confirmed_at, created_at
        )
        SELECT ?, ?, 1, ?, NULL, ?
        WHERE EXISTS (
          SELECT 1 FROM consumer_sessions
          WHERE id = ? AND deleted_at IS NULL AND current_profile_revision = ?
        )
      `).bind(
        sessionId,
        revision,
        encryptedProfile,
        timestamp,
        sessionId,
        Number(sessionRow.current_profile_revision || 1)
      ),
      db(env).prepare(`
        UPDATE consumer_sessions
        SET current_profile_revision = ?, confirmed_profile_revision = NULL,
            stage = ?, rolling_summary_encrypted = ?, last_active_at = ?
        WHERE id = ? AND deleted_at IS NULL AND current_profile_revision = ?
      `).bind(revision, stage, encryptedSummary, timestamp, sessionId, Number(sessionRow.current_profile_revision || 1))
    );
  } else {
    statements.push(db(env).prepare(`
      UPDATE consumer_sessions
      SET stage = ?, rolling_summary_encrypted = ?, last_active_at = ?
      WHERE id = ? AND deleted_at IS NULL AND current_profile_revision = ?
    `).bind(stage, encryptedSummary, timestamp, sessionId, Number(sessionRow.current_profile_revision || 1)));
  }

  try {
    await db(env).batch(statements);
  } catch (error) {
    const existing = await getTurnByIdempotencyKey(env, sessionId, idempotencyKey).catch(() => null);
    if (existing) return { duplicate: true, turnId: existing.row.id, storedPayload: existing.payload };
    throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed while this message was being processed. Refresh and try again.');
  }
  const persistedTurn = await getTurnByIdempotencyKey(env, sessionId, idempotencyKey).catch(() => null);
  if (!persistedTurn || persistedTurn.row.id !== turnId) {
    throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed while this message was being processed. Refresh and try again.');
  }
  await recordEvent(env, sessionId, 'turn_completed', {
    mode: metadata.model ? 'ai' : 'rules',
    modelTier: metadata.modelTier || null
  }).catch(() => {});
  if (profileChanged) {
    await recordEvent(env, sessionId, 'profile_updated', { revision }).catch(() => {});
  }
  return {
    duplicate: false,
    turnId,
    responsePayload,
    session,
    profile: storedProfile
  };
}

export async function listTurns(env, sessionId, limit = 50) {
  const result = await db(env).prepare(`
    SELECT id, payload_encrypted, created_at
    FROM consumer_conversation_turns
    WHERE session_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(sessionId, Math.max(1, Math.min(100, limit))).all();
  const rows = [...(result.results || [])].reverse();
  const exchanges = await Promise.all(rows.map(async (row) => ({
    id: row.id,
    createdAt: row.created_at,
    ...(await decryptJson(env, row.payload_encrypted, `consumer/turn/${sessionId}/${row.id}`))
  })));
  return exchanges.flatMap((exchange) => [
    {
      id: `${exchange.id}-user`,
      role: 'user',
      text: exchange.userMessage,
      createdAt: exchange.createdAt
    },
    {
      id: `${exchange.id}-assistant`,
      role: 'assistant',
      text: exchange.assistantMessage,
      createdAt: exchange.createdAt
    }
  ]);
}

export async function reserveAiAttempt(env, sessionId, idempotencyKey, config, requestPolicy = {}) {
  const timestamp = nowIso();
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const id = randomId('ai');
  try {
    const row = await db(env).prepare(`
      INSERT INTO consumer_ai_attempts (
        id, session_id, idempotency_key, status, model, model_tier,
        reasoning_effort, prompt_version, reserved_tokens,
        data_policy_id, created_at, completed_at
      )
      SELECT ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, NULL
      WHERE (
        SELECT COUNT(*) FROM consumer_ai_attempts WHERE session_id = ?
      ) < ?
      AND (
        SELECT COUNT(*) FROM consumer_ai_attempts WHERE created_at >= ?
      ) < ?
      AND (
        ? != 'complex' OR (
          SELECT COUNT(*) FROM consumer_ai_attempts
          WHERE session_id = ? AND model_tier = 'complex'
        ) < ?
      )
      AND (
        ? != 'complex' OR (
          SELECT COUNT(*) FROM consumer_ai_attempts
          WHERE created_at >= ? AND model_tier = 'complex'
        ) < ?
      )
      AND COALESCE((
        SELECT SUM(
          CASE
            WHEN status = 'reserved' OR (status = 'failed' AND error_code = 'worker_interrupted')
              THEN reserved_tokens
            ELSE input_tokens + output_tokens
          END
        ) FROM consumer_ai_attempts WHERE session_id = ?
      ), 0) + ? <= ?
      AND COALESCE((
        SELECT SUM(
          CASE
            WHEN status = 'reserved' OR (status = 'failed' AND error_code = 'worker_interrupted')
              THEN reserved_tokens
            ELSE input_tokens + output_tokens
          END
        ) FROM consumer_ai_attempts WHERE created_at >= ?
      ), 0) + ? <= ?
      AND EXISTS (
        SELECT 1 FROM consumer_sessions
        WHERE id = ? AND consent_ai_processing = 1
          AND consent_ai_notice_id = ? AND deleted_at IS NULL
      )
      RETURNING id, status, created_at
    `).bind(
      id,
      sessionId,
      idempotencyKey,
      requestPolicy.model || null,
      requestPolicy.modelTier || 'default',
      requestPolicy.reasoningEffort || null,
      config.aiPromptVersion,
      config.aiRequestTokenReservation,
      config.aiDataPolicyId,
      timestamp,
      sessionId,
      config.aiSessionRequestBudget,
      dayStart.toISOString(),
      config.aiDailyRequestBudget,
      requestPolicy.modelTier || 'default',
      sessionId,
      config.aiComplexSessionRequestBudget,
      requestPolicy.modelTier || 'default',
      dayStart.toISOString(),
      config.aiComplexDailyRequestBudget,
      sessionId,
      config.aiRequestTokenReservation,
      config.aiSessionTokenBudget,
      dayStart.toISOString(),
      config.aiRequestTokenReservation,
      config.aiDailyTokenBudget,
      sessionId,
      config.aiNoticeId
    ).first();
    return row || null;
  } catch (error) {
    const existing = await db(env).prepare(`
      SELECT id, status, created_at
      FROM consumer_ai_attempts
      WHERE session_id = ? AND idempotency_key = ? AND status = 'reserved'
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(sessionId, idempotencyKey).first().catch(() => null);
    if (existing) {
      throw new ConsumerError(409, 'ai_attempt_in_progress', 'This message is already being processed.');
    }
    throw error;
  }
}

export async function finalizeAiAttempt(env, attemptId, metadata = {}, errorCode = null) {
  const timestamp = nowIso();
  const status = errorCode ? 'failed' : 'complete';
  await db(env).prepare(`
    UPDATE consumer_ai_attempts
    SET status = ?, model = ?, model_tier = ?, reasoning_effort = ?,
        prompt_version = ?, input_tokens = ?, output_tokens = ?,
        cached_input_tokens = ?, latency_ms = ?, error_code = ?, completed_at = ?
    WHERE id = ? AND status = 'reserved'
  `).bind(
    status,
    metadata.model || null,
    metadata.modelTier || null,
    metadata.reasoningEffort || null,
    metadata.promptVersion || null,
    Number(metadata.inputTokens || 0),
    Number(metadata.outputTokens || 0),
    Number(metadata.cachedInputTokens || 0),
    Number(metadata.latencyMs || 0),
    errorCode || null,
    timestamp,
    attemptId
  ).run();
}

export async function getConsumerProviderCost(env, entryId) {
  const safeEntryId = requiredProviderCostToken(entryId, 'Provider cost entry id', 160);
  const row = await db(env).prepare(`
    SELECT *
    FROM consumer_provider_costs
    WHERE id = ?
    LIMIT 1
  `).bind(safeEntryId).first();
  return toConsumerProviderCost(row);
}

export async function getConsumerProviderBudget(env, sessionId) {
  const safeSessionId = requiredProviderCostToken(sessionId, 'Session id', 160);
  const row = await db(env).prepare(`
    SELECT
      sessions.provider_cost_limit_eur_micros,
      COALESCE(SUM(${providerCostChargeSql('costs')}), 0) AS spent_eur_micros,
      COALESCE(SUM(CASE
        WHEN costs.status = 'known' THEN costs.actual_cost_eur_micros
        ELSE 0
      END), 0) AS known_actual_eur_micros,
      COALESCE(SUM(CASE
        WHEN costs.status IN ('reserved', 'unknown') THEN costs.reserved_cost_eur_micros
        ELSE 0
      END), 0) AS reserved_or_unknown_eur_micros,
      COALESCE(SUM(CASE
        WHEN costs.status = 'not_sent' THEN costs.reserved_cost_eur_micros
        ELSE 0
      END), 0) AS released_eur_micros
    FROM consumer_sessions AS sessions
    LEFT JOIN consumer_provider_costs AS costs ON costs.session_id = sessions.id
    WHERE sessions.id = ? AND sessions.deleted_at IS NULL
    GROUP BY sessions.id, sessions.provider_cost_limit_eur_micros
  `).bind(safeSessionId).first();
  if (!row) throw notFound('This planning session could not be found.');
  const limit = providerCostAggregate(
    row.provider_cost_limit_eur_micros,
    'Provider cost limit'
  );
  return toProviderBudget(limit, row);
}

export async function getConsumerProviderDailyBudget(env, dailyCostLimitEurMicros) {
  const limit = failClosedEurMicros(dailyCostLimitEurMicros);
  const period = utcDayBounds();
  const dayUtc = period.start.slice(0, 10);
  const row = await db(env).prepare(`
    SELECT
      COALESCE(SUM(${providerCostChargeSql('costs')}), 0) + COALESCE((
        SELECT archived.spent_eur_micros
        FROM consumer_provider_daily_cost_totals AS archived
        WHERE archived.day_utc = ?
      ), 0) AS spent_eur_micros,
      COALESCE(SUM(CASE
        WHEN costs.status = 'known' THEN costs.actual_cost_eur_micros
        ELSE 0
      END), 0) + COALESCE((
        SELECT archived.known_actual_eur_micros
        FROM consumer_provider_daily_cost_totals AS archived
        WHERE archived.day_utc = ?
      ), 0) AS known_actual_eur_micros,
      COALESCE(SUM(CASE
        WHEN costs.status IN ('reserved', 'unknown') THEN costs.reserved_cost_eur_micros
        ELSE 0
      END), 0) + COALESCE((
        SELECT archived.reserved_or_unknown_eur_micros
        FROM consumer_provider_daily_cost_totals AS archived
        WHERE archived.day_utc = ?
      ), 0) AS reserved_or_unknown_eur_micros,
      COALESCE(SUM(CASE
        WHEN costs.status = 'not_sent' THEN costs.reserved_cost_eur_micros
        ELSE 0
      END), 0) + COALESCE((
        SELECT archived.released_eur_micros
        FROM consumer_provider_daily_cost_totals AS archived
        WHERE archived.day_utc = ?
      ), 0) AS released_eur_micros
    FROM consumer_provider_costs AS costs
    WHERE costs.created_at >= ? AND costs.created_at < ?
  `).bind(dayUtc, dayUtc, dayUtc, dayUtc, period.start, period.end).first();
  return toProviderBudget(limit, row, {
    periodStart: period.start,
    periodEnd: period.end
  });
}

async function providerCostBudgets(env, sessionId, dailyCostLimitEurMicros) {
  const [sessionBudget, dailyBudget] = await Promise.all([
    getConsumerProviderBudget(env, sessionId),
    getConsumerProviderDailyBudget(env, dailyCostLimitEurMicros)
  ]);
  return { sessionBudget, dailyBudget };
}

function providerCostReservationMatches(row, expected) {
  return row.session_id === expected.sessionId
    && row.operation === expected.operation
    && row.idempotency_key === expected.idempotencyKey
    && row.provider === expected.provider
    && (row.model || null) === expected.model
    && row.pricing_version === expected.pricingVersion
    && Number(row.reserved_cost_eur_micros) === expected.reservedCostEurMicros;
}

export async function reserveConsumerProviderCost(env, request = {}) {
  const sessionId = requiredProviderCostToken(request.sessionId, 'Session id', 160);
  const operation = requiredProviderCostToken(request.operation, 'Provider operation', 80);
  const idempotencyKey = requiredProviderCostToken(request.idempotencyKey, 'Idempotency key', 160);
  const provider = requiredProviderCostToken(request.provider, 'Provider', 80);
  const model = optionalProviderCostToken(request.model, 'Provider model', 120);
  const pricingVersion = requiredProviderCostToken(request.pricingVersion, 'Pricing version', 120);
  const reservedCostEurMicros = providerCostAmount(
    request.reservedCostEurMicros,
    'Provider cost reservation',
    { allowZero: false }
  );
  // Invalid or omitted daily configuration resolves to zero. The INSERT then
  // denies the reservation, preserving fail-closed behavior.
  const dailyCostLimitEurMicros = failClosedEurMicros(request.dailyCostLimitEurMicros);
  const timestamp = nowIso();
  const period = utcDayBounds(timestamp);
  const id = randomId('cost');
  const expected = {
    sessionId,
    operation,
    idempotencyKey,
    provider,
    model,
    pricingVersion,
    reservedCostEurMicros
  };

  let inserted = null;
  let existing = null;
  try {
    inserted = await db(env).prepare(`
      INSERT INTO consumer_provider_costs (
        id, session_id, operation, idempotency_key, provider, model,
        pricing_version, status, reserved_cost_eur_micros,
        actual_cost_eur_micros, error_code, created_at, completed_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, NULL, NULL, ?, NULL
      FROM consumer_sessions AS sessions
      WHERE sessions.id = ? AND sessions.deleted_at IS NULL
        AND sessions.provider_cost_limit_eur_micros > 0
        AND ? > 0
        AND COALESCE((
          SELECT SUM(${providerCostChargeSql('session_costs')})
          FROM consumer_provider_costs AS session_costs
          WHERE session_costs.session_id = sessions.id
        ), 0) + ? <= sessions.provider_cost_limit_eur_micros
        AND COALESCE((
          SELECT SUM(${providerCostChargeSql('daily_costs')})
          FROM consumer_provider_costs AS daily_costs
          WHERE daily_costs.created_at >= ? AND daily_costs.created_at < ?
        ), 0) + COALESCE((
          SELECT archived.spent_eur_micros
          FROM consumer_provider_daily_cost_totals AS archived
          WHERE archived.day_utc = ?
        ), 0) + ? <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM consumer_provider_costs AS duplicate_costs
          WHERE duplicate_costs.session_id = ?
            AND duplicate_costs.operation = ?
            AND duplicate_costs.idempotency_key = ?
        )
      RETURNING *
    `).bind(
      id,
      sessionId,
      operation,
      idempotencyKey,
      provider,
      model,
      pricingVersion,
      reservedCostEurMicros,
      timestamp,
      sessionId,
      dailyCostLimitEurMicros,
      reservedCostEurMicros,
      period.start,
      period.end,
      period.start.slice(0, 10),
      reservedCostEurMicros,
      dailyCostLimitEurMicros,
      sessionId,
      operation,
      idempotencyKey
    ).first();
  } catch (error) {
    // A racing reservation can still reach the UNIQUE constraint after the
    // NOT EXISTS check. Treat the matching immutable tuple idempotently.
    existing = await db(env).prepare(`
      SELECT *
      FROM consumer_provider_costs
      WHERE session_id = ? AND operation = ? AND idempotency_key = ?
      LIMIT 1
    `).bind(sessionId, operation, idempotencyKey).first().catch(() => null);
    if (!existing) throw error;
  }

  if (!inserted && !existing) {
    existing = await db(env).prepare(`
      SELECT *
      FROM consumer_provider_costs
      WHERE session_id = ? AND operation = ? AND idempotency_key = ?
      LIMIT 1
    `).bind(sessionId, operation, idempotencyKey).first();
  }

  if (existing) {
    if (!providerCostReservationMatches(existing, expected)) {
      throw new ConsumerError(
        409,
        'provider_cost_idempotency_conflict',
        'This idempotency key was already used for a different provider operation.'
      );
    }
    const budgets = await providerCostBudgets(env, sessionId, dailyCostLimitEurMicros);
    return Object.freeze({
      outcome: 'existing',
      status: 'existing',
      reserved: false,
      existing: true,
      denied: false,
      reason: null,
      entry: toConsumerProviderCost(existing),
      ...budgets
    });
  }

  const budgets = await providerCostBudgets(env, sessionId, dailyCostLimitEurMicros);
  if (inserted) {
    return Object.freeze({
      outcome: 'reserved',
      status: 'reserved',
      reserved: true,
      existing: false,
      denied: false,
      reason: null,
      entry: toConsumerProviderCost(inserted),
      ...budgets
    });
  }

  let reason = 'provider_budget_denied';
  if (budgets.sessionBudget.failClosed) reason = 'session_budget_unavailable';
  else if (budgets.dailyBudget.failClosed) reason = 'daily_budget_unavailable';
  else if (budgets.sessionBudget.remainingEurMicros < reservedCostEurMicros) reason = 'session_budget_exceeded';
  else if (budgets.dailyBudget.remainingEurMicros < reservedCostEurMicros) reason = 'daily_budget_exceeded';
  return Object.freeze({
    outcome: 'denied',
    status: 'denied',
    reserved: false,
    existing: false,
    denied: true,
    reason,
    entry: null,
    ...budgets
  });
}

export async function markConsumerProviderCostInFlight(env, entryId, request = {}) {
  const safeEntryId = requiredProviderCostToken(entryId, 'Provider cost entry id', 160);
  const sessionId = requiredProviderCostToken(request.sessionId, 'Session id', 160);
  const noticeId = requiredProviderCostToken(request.noticeId, 'Voice notice id', 120);
  const dataPolicyId = requiredProviderCostToken(request.dataPolicyId, 'Voice data policy id', 120);
  const policyVersion = requiredProviderCostToken(request.policyVersion, 'Voice policy version', 120);
  const privacyNoticeUrl = requiredProviderCostHttpsUrl(
    request.privacyNoticeUrl,
    'Voice privacy notice URL'
  );
  const timestamp = nowIso();

  const updated = await db(env).prepare(`
    UPDATE consumer_provider_costs
    SET dispatched_at = ?
    WHERE id = ? AND session_id = ?
      AND status = 'reserved' AND dispatched_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM consumer_sessions AS sessions
        INNER JOIN consumer_voice_consents AS voice_consent
          ON voice_consent.session_id = sessions.id
        WHERE sessions.id = consumer_provider_costs.session_id
          AND sessions.deleted_at IS NULL
          AND sessions.status IN ('active', 'completed')
          AND voice_consent.granted = 1
          AND voice_consent.notice_id = ?
          AND voice_consent.data_policy_id = ?
          AND voice_consent.policy_version = ?
          AND voice_consent.privacy_notice_url = ?
          AND voice_consent.withdrawn_at IS NULL
      )
    RETURNING *
  `).bind(
    timestamp,
    safeEntryId,
    sessionId,
    noticeId,
    dataPolicyId,
    policyVersion,
    privacyNoticeUrl
  ).first();

  if (updated) {
    return Object.freeze({
      outcome: 'in_flight',
      changed: true,
      entry: toConsumerProviderCost(updated)
    });
  }

  const row = await db(env).prepare(`
    SELECT *
    FROM consumer_provider_costs
    WHERE id = ?
    LIMIT 1
  `).bind(safeEntryId).first();
  if (!row) throw notFound('This provider cost reservation could not be found.');
  if (row.session_id !== sessionId) {
    throw new ConsumerError(
      409,
      'provider_cost_dispatch_conflict',
      'This provider cost reservation belongs to a different session.'
    );
  }
  if (row.status === 'reserved' && row.dispatched_at) {
    return Object.freeze({
      outcome: 'already_in_flight',
      changed: false,
      entry: toConsumerProviderCost(row)
    });
  }
  if (row.status === 'reserved') {
    return Object.freeze({
      outcome: 'voice_consent_required',
      changed: false,
      entry: toConsumerProviderCost(row)
    });
  }
  throw new ConsumerError(
    409,
    'provider_cost_dispatch_conflict',
    'This provider cost reservation has already been settled.'
  );
}

async function settleConsumerProviderCost(env, entryId, targetStatus, options = {}) {
  const safeEntryId = requiredProviderCostToken(entryId, 'Provider cost entry id', 160);
  const errorCode = optionalProviderCostToken(options.errorCode, 'Provider error code', 120);
  const actualCostEurMicros = targetStatus === 'known'
    ? providerCostAmount(options.actualCostEurMicros, 'Actual provider cost')
    : null;
  const timestamp = nowIso();
  const sourcePredicate = targetStatus === 'unknown'
    ? "status = 'reserved' AND dispatched_at IS NOT NULL"
    : targetStatus === 'not_sent'
      ? "status = 'reserved' AND dispatched_at IS NULL"
      : "(status = 'unknown' OR (status = 'reserved' AND dispatched_at IS NOT NULL))";

  const updated = await db(env).prepare(`
    UPDATE consumer_provider_costs
    SET status = ?, actual_cost_eur_micros = ?, error_code = ?, completed_at = ?
    WHERE id = ? AND ${sourcePredicate}
    RETURNING *
  `).bind(
    targetStatus,
    actualCostEurMicros,
    errorCode,
    timestamp,
    safeEntryId
  ).first();

  let row = updated;
  if (!row) {
    row = await db(env).prepare(`
      SELECT *
      FROM consumer_provider_costs
      WHERE id = ?
      LIMIT 1
    `).bind(safeEntryId).first();
    if (!row) throw notFound('This provider cost reservation could not be found.');
    const idempotent = row.status === targetStatus
      && (targetStatus !== 'known' || Number(row.actual_cost_eur_micros) === actualCostEurMicros);
    if (!idempotent) {
      throw new ConsumerError(
        409,
        'provider_cost_settlement_conflict',
        'This provider cost reservation already has a conflicting settlement.'
      );
    }
  }

  const entry = toConsumerProviderCost(row);
  const sessionBudget = await getConsumerProviderBudget(env, entry.sessionId);
  return Object.freeze({
    changed: Boolean(updated),
    entry,
    sessionBudget,
    overReservationEurMicros: Math.max(
      0,
      entry.chargedCostEurMicros - entry.reservedCostEurMicros
    )
  });
}

export async function settleConsumerProviderCostKnown(
  env,
  entryId,
  actualCostEurMicros,
  options = {}
) {
  return settleConsumerProviderCost(env, entryId, 'known', {
    ...options,
    actualCostEurMicros
  });
}

export async function settleConsumerProviderCostUnknown(env, entryId, options = {}) {
  return settleConsumerProviderCost(env, entryId, 'unknown', options);
}

export async function releaseConsumerProviderCostNotSent(env, entryId, options = {}) {
  return settleConsumerProviderCost(env, entryId, 'not_sent', options);
}

const MODULE_CACHE_PAYLOAD_SCHEMA_VERSION = 1;

function normalizeConsumerModuleCacheIdentity(identity) {
  const normalized = {
    schemaVersion: MODULE_CACHE_PAYLOAD_SCHEMA_VERSION,
    moduleId: String(identity?.moduleId || ''),
    moduleVersion: String(identity?.moduleVersion || ''),
    calculationVersion: String(identity?.calculationVersion || ''),
    calculationDateIso: String(identity?.calculationDateIso || ''),
    dependencySnapshotHash: String(identity?.dependencySnapshotHash || ''),
    inputSnapshotHash: String(identity?.inputSnapshotHash || ''),
    scenarioSnapshotHash: String(identity?.scenarioSnapshotHash || ''),
    readinessSnapshotHash: String(identity?.readinessSnapshotHash || '')
  };
  if (!normalized.moduleId
    || !normalized.moduleVersion
    || !normalized.calculationVersion
    || !/^\d{4}-\d{2}-\d{2}$/.test(normalized.calculationDateIso)
    || !normalized.dependencySnapshotHash
    || !normalized.inputSnapshotHash
    || !normalized.scenarioSnapshotHash
    || !normalized.readinessSnapshotHash) {
    throw new ConsumerError(500, 'module_cache_identity_invalid', 'The deterministic module cache identity is incomplete.');
  }
  return normalized;
}

export async function buildConsumerModuleCacheKey(identity) {
  return sha256Base64Url(stableStringify(normalizeConsumerModuleCacheIdentity(identity)));
}

export function createConsumerModuleCachePayload(identity, result) {
  return {
    schemaVersion: MODULE_CACHE_PAYLOAD_SCHEMA_VERSION,
    cacheIdentity: normalizeConsumerModuleCacheIdentity(identity),
    result
  };
}

export function readConsumerModuleCachePayload(payload, expectedIdentity) {
  const expected = normalizeConsumerModuleCacheIdentity(expectedIdentity);
  if (!payload
    || payload.schemaVersion !== MODULE_CACHE_PAYLOAD_SCHEMA_VERSION
    || stableStringify(payload.cacheIdentity) !== stableStringify(expected)) {
    return null;
  }
  const result = payload.result;
  if (!result
    || result.moduleId !== expected.moduleId
    || result.moduleVersion !== expected.moduleVersion
    || result.calculationVersion !== expected.calculationVersion
    || result.inputSnapshotHash !== expected.inputSnapshotHash) {
    return null;
  }
  return result;
}

export async function findReusableConsumerModuleRun(env, sessionId, identity) {
  const expected = normalizeConsumerModuleCacheIdentity(identity);
  const cacheKey = await buildConsumerModuleCacheKey(expected);
  const query = await db(env).prepare(`
    SELECT mr.id, mr.session_id, mr.module_id, mr.module_version,
      mr.calculation_version, mr.input_snapshot_hash_b64u,
      mr.payload_encrypted, mr.created_at
    FROM consumer_module_runs mr
    INNER JOIN consumer_analysis_runs ar
      ON ar.id = mr.analysis_run_id AND ar.session_id = mr.session_id
    WHERE mr.session_id = ?
      AND mr.module_id = ?
      AND mr.module_version = ?
      AND mr.calculation_version = ?
      AND mr.input_snapshot_hash_b64u = ?
      AND mr.status = 'complete'
      AND mr.payload_encrypted IS NOT NULL
      AND ar.status IN ('complete', 'partial')
      AND EXISTS (
        SELECT 1 FROM consumer_sessions session
        WHERE session.id = mr.session_id AND session.deleted_at IS NULL
      )
    ORDER BY mr.created_at DESC
    LIMIT 5
  `).bind(
    String(sessionId || ''),
    expected.moduleId,
    expected.moduleVersion,
    expected.calculationVersion,
    cacheKey
  ).all();
  for (const row of query?.results || []) {
    if (row.session_id !== sessionId
      || row.module_id !== expected.moduleId
      || row.module_version !== expected.moduleVersion
      || row.calculation_version !== expected.calculationVersion
      || row.input_snapshot_hash_b64u !== cacheKey) {
      continue;
    }
    try {
      const payload = await decryptJson(env, row.payload_encrypted, `consumer/module/${sessionId}/${row.id}`);
      const result = readConsumerModuleCachePayload(payload, expected);
      if (result) return result;
    } catch {
      // Corrupt, stale-key, or metadata-tampered rows are never reused. A fresh
      // deterministic run is safer than failing the consumer's whole analysis.
    }
  }
  return null;
}

export async function createAnalysisRun(env, sessionRow, profile, moduleIds) {
  const id = randomId('analysis');
  const timestamp = nowIso();
  const profileRevision = Number(sessionRow.current_profile_revision);
  const inputSnapshotHashB64u = await sha256Base64Url(stableStringify(profile));
  const created = await db(env).prepare(`
    INSERT INTO consumer_analysis_runs (
      id, session_id, profile_revision, input_snapshot_hash_b64u,
      module_ids_json, status, payload_encrypted, created_at, completed_at
    )
    SELECT ?, ?, ?, ?, ?, 'running', NULL, ?, NULL
    WHERE EXISTS (
      SELECT 1
      FROM consumer_sessions
      WHERE id = ? AND deleted_at IS NULL
        AND current_profile_revision = ?
        AND confirmed_profile_revision = ?
    )
    RETURNING id
  `).bind(
    id,
    sessionRow.id,
    profileRevision,
    inputSnapshotHashB64u,
    JSON.stringify(moduleIds || []),
    timestamp,
    sessionRow.id,
    profileRevision,
    profileRevision
  ).first();
  if (!created) {
    throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed before the analysis started. Refresh and try again.');
  }
  await recordEvent(env, sessionRow.id, 'analysis_started', { analysisRunId: id, moduleIds: moduleIds || [] }).catch(() => {});
  return { id, profileRevision, inputSnapshotHashB64u, createdAt: timestamp };
}

export async function completeAnalysisRun(env, run, sessionId, result, moduleIds, moduleExecutions = []) {
  const timestamp = nowIso();
  const status = Array.isArray(result?.errors) && result.errors.length ? 'partial' : 'complete';
  const encrypted = await encryptJson(env, result, `consumer/analysis/${sessionId}/${run.id}`);
  const statements = [
    db(env).prepare(`
      UPDATE consumer_analysis_runs
      SET status = ?, payload_encrypted = ?, completed_at = ?
      WHERE id = ? AND session_id = ? AND status = 'running'
    `).bind(status, encrypted, timestamp, run.id, sessionId)
  ];
  const executionByModuleId = new Map(
    (moduleExecutions || []).map((execution) => [execution?.moduleId, execution])
  );
  for (const moduleId of moduleIds || []) {
    const moduleResult = (result?.results || []).find((item) => item?.moduleId === moduleId);
    const execution = executionByModuleId.get(moduleId);
    const moduleRunId = randomId('module');
    const cacheIdentity = moduleResult && execution?.cacheIdentity
      ? normalizeConsumerModuleCacheIdentity(execution.cacheIdentity)
      : null;
    const cacheKey = cacheIdentity
      ? await buildConsumerModuleCacheKey(cacheIdentity)
      : run.inputSnapshotHashB64u;
    const modulePayload = await encryptJson(
      env,
      moduleResult && cacheIdentity
        ? createConsumerModuleCachePayload(cacheIdentity, moduleResult)
        : (moduleResult || { moduleId, status: 'not_ready' }),
      `consumer/module/${sessionId}/${moduleRunId}`
    );
    statements.push(db(env).prepare(`
      INSERT INTO consumer_module_runs (
        id, analysis_run_id, session_id, module_id, module_version,
        calculation_version, input_snapshot_hash_b64u, status,
        payload_encrypted, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      moduleRunId,
      run.id,
      sessionId,
      moduleId,
      cacheIdentity?.moduleVersion || moduleResult?.moduleVersion || null,
      cacheIdentity?.calculationVersion || moduleResult?.calculationVersion || null,
      cacheKey,
      moduleResult ? 'complete' : 'not_ready',
      modulePayload,
      Number(moduleResult?.durationMs || 0),
      timestamp
    ));
  }
  statements.push(db(env).prepare(`
    UPDATE consumer_sessions
    SET stage = 'results', last_active_at = ?
    WHERE id = ? AND deleted_at IS NULL
      AND current_profile_revision = ?
      AND confirmed_profile_revision = ?
  `).bind(timestamp, sessionId, run.profileRevision, run.profileRevision));
  await db(env).batch(statements);
  const persistedSession = await getSessionRow(env, sessionId);
  if (Number(persistedSession?.current_profile_revision) !== run.profileRevision
    || Number(persistedSession?.confirmed_profile_revision) !== run.profileRevision) {
    throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed while the analysis was running. Review and run it again.');
  }
  await recordEvent(env, sessionId, 'analysis_completed', { analysisRunId: run.id, status }).catch(() => {});
  return {
    id: run.id,
    profileRevision: run.profileRevision,
    status,
    createdAt: run.createdAt,
    completedAt: timestamp,
    ...result
  };
}

export async function failAnalysisRun(env, run, sessionId) {
  const timestamp = nowIso();
  await db(env).prepare(`
    UPDATE consumer_analysis_runs
    SET status = 'failed', completed_at = ?
    WHERE id = ? AND session_id = ? AND status = 'running'
  `).bind(timestamp, run.id, sessionId).run();
  await recordEvent(env, sessionId, 'analysis_failed', { analysisRunId: run.id }).catch(() => {});
}

export async function saveAnalysisNeedsInformation(env, run, sessionId, result) {
  const timestamp = nowIso();
  const encrypted = await encryptJson(env, result, `consumer/analysis/${sessionId}/${run.id}`);
  await db(env).batch([
    db(env).prepare(`
      UPDATE consumer_analysis_runs
      SET status = 'needs_information', payload_encrypted = ?, completed_at = ?
      WHERE id = ? AND session_id = ? AND status = 'running'
    `).bind(encrypted, timestamp, run.id, sessionId),
    db(env).prepare(`
      UPDATE consumer_sessions
      SET stage = 'missing_information', last_active_at = ?
      WHERE id = ? AND deleted_at IS NULL
        AND current_profile_revision = ?
        AND confirmed_profile_revision = ?
    `).bind(timestamp, sessionId, run.profileRevision, run.profileRevision)
  ]);
  const persistedSession = await getSessionRow(env, sessionId);
  if (Number(persistedSession?.current_profile_revision) !== run.profileRevision
    || Number(persistedSession?.confirmed_profile_revision) !== run.profileRevision) {
    throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed while the analysis was running. Review and run it again.');
  }
  await recordEvent(env, sessionId, 'analysis_needs_information', {
    analysisRunId: run.id,
    requiredQuestionCount: result?.analysisPlan?.requiredQuestions?.length || 0
  }).catch(() => {});
  return {
    id: run.id,
    profileRevision: run.profileRevision,
    status: 'needs_information',
    createdAt: run.createdAt,
    completedAt: timestamp,
    ...result
  };
}

export async function getLatestAnalysis(env, sessionId, profileRevision = null, {
  completedOnly = false
} = {}) {
  const revision = profileRevision === null || profileRevision === undefined
    ? null
    : Number(profileRevision);
  const row = await db(env).prepare(`
    SELECT id, profile_revision, status, payload_encrypted, created_at, completed_at
    FROM consumer_analysis_runs
    WHERE session_id = ?
      AND (? IS NULL OR profile_revision = ?)
      AND (? = 0 OR status IN ('complete', 'partial'))
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(sessionId, revision, revision, completedOnly ? 1 : 0).first();
  if (!row) return null;
  const payload = row.payload_encrypted
    ? await decryptJson(env, row.payload_encrypted, `consumer/analysis/${sessionId}/${row.id}`)
    : null;
  return {
    id: row.id,
    profileRevision: Number(row.profile_revision),
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    ...payload
  };
}

export async function getHandoff(env, sessionId) {
  return db(env).prepare(`
    SELECT * FROM consumer_handoffs WHERE session_id = ? LIMIT 1
  `).bind(sessionId).first();
}

export async function readHandoffPackage(env, row) {
  if (!row?.package_encrypted || !row?.id || !row?.session_id) {
    throw new ConsumerError(500, 'handoff_package_missing', 'The saved handoff package is unavailable.');
  }
  return decryptJson(env, row.package_encrypted, `consumer/handoff/${row.session_id}/${row.id}`);
}

export async function createHandoff(env, sessionRow, handoff, profile, context = {}, config = {}) {
  const existing = await getHandoff(env, sessionRow.id);
  if (existing) return existing;
  const id = randomId('handoff');
  const timestamp = nowIso();
  const retentionExpiresAt = new Date(
    Date.now() + Number(config.handoffRetentionDays || 0) * 24 * 60 * 60 * 1000
  ).toISOString();
  if (!config.handoffRetentionDays || !handoff.policyVersion || !handoff.policyUrl) {
    throw new ConsumerError(503, 'handoff_policy_unavailable', 'Adviser handoff is not available.');
  }
  const contact = { fullName: handoff.fullName, email: handoff.email, phone: handoff.phone };
  const selectedModuleIds = context.analysis?.analysisPlan?.selectedModules?.map((item) => item.moduleId) || [];
  const sharedDataDigestB64u = await sha256Base64Url(stableStringify({
    recipient: 'gerry',
    purpose: 'adviser_handoff',
    confirmedProfileRevision: Number(sessionRow.confirmed_profile_revision),
    contact,
    requestedHelp: handoff.requestedHelp,
    policyVersion: handoff.policyVersion,
    policyUrl: handoff.policyUrl,
    retentionPolicyId: config.handoffRetentionPolicyId
  }));
  const packageValue = {
    handoffId: id,
    consumerSessionId: sessionRow.id,
    confirmedProfileRevision: Number(sessionRow.confirmed_profile_revision),
    contact,
    requestedHelp: handoff.requestedHelp,
    sharedDataCategories: ['full_name', 'email', ...(handoff.phone ? ['phone'] : []), 'requested_help'],
    analysisReceipt: {
      analysisRunId: context.analysis?.id || null,
      profileRevision: context.analysis?.profileRevision || null,
      selectedModuleIds
    },
    versions: {
      profileRevision: Number(sessionRow.confirmed_profile_revision),
      analysisRulesVersion: context.analysis?.analysisPlan?.rulesVersion || null,
      consumerHandoffPackageVersion: 2
    },
    recipient: { id: 'gerry', type: 'adviser' },
    consent: {
      purpose: 'adviser_handoff',
      granted: true,
      policyVersion: handoff.policyVersion,
      policyUrl: handoff.policyUrl,
      capturedAt: timestamp,
      sharedDataDigestB64u
    },
    retention: {
      consumerPackageExpiresAt: retentionExpiresAt,
      retentionDays: Number(config.handoffRetentionDays),
      policyId: config.handoffRetentionPolicyId
    }
  };
  const encrypted = await encryptJson(env, packageValue, `consumer/handoff/${sessionRow.id}/${id}`);
  try {
    await db(env).prepare(`
      INSERT INTO consumer_handoffs (
        id, session_id, profile_revision, consent_policy_version, policy_url,
        consent_captured_at, package_encrypted, status, recipient,
        client_id, lead_id, retention_expires_at, linking_started_at,
        retention_policy_id, package_purged_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'gerry', NULL, NULL, ?, NULL, ?, NULL, ?, ?)
    `).bind(
      id,
      sessionRow.id,
      Number(sessionRow.confirmed_profile_revision),
      handoff.policyVersion,
      handoff.policyUrl,
      timestamp,
      encrypted,
      retentionExpiresAt,
      config.handoffRetentionPolicyId,
      timestamp,
      timestamp
    ).run();
  } catch (error) {
    const concurrent = await getHandoff(env, sessionRow.id).catch(() => null);
    if (concurrent) return concurrent;
    throw error;
  }
  await recordEvent(env, sessionRow.id, 'handoff_requested', { handoffId: id, recipient: 'gerry' }).catch(() => {});
  return getHandoff(env, sessionRow.id);
}

export async function claimHandoffForLink(env, sessionId, handoffId, staleAfterMs = 120_000) {
  const timestamp = nowIso();
  const staleBefore = new Date(Date.now() - staleAfterMs).toISOString();
  return db(env).prepare(`
    UPDATE consumer_handoffs
    SET status = 'linking', linking_started_at = ?, updated_at = ?
    WHERE id = ? AND session_id = ? AND package_encrypted IS NOT NULL
      AND retention_expires_at > ?
      AND EXISTS (
        SELECT 1 FROM consumer_sessions
        WHERE id = ? AND deleted_at IS NULL AND status IN ('active', 'completed')
      )
      AND (
        status IN ('pending', 'failed')
        OR (status = 'linking' AND linking_started_at < ?)
      )
    RETURNING *
  `).bind(timestamp, timestamp, handoffId, sessionId, timestamp, sessionId, staleBefore).first();
}

export async function linkHandoff(env, sessionId, handoffId, linkingStartedAt, clientId, leadId) {
  const timestamp = nowIso();
  const linked = await db(env).prepare(`
    UPDATE consumer_handoffs
    SET client_id = ?, lead_id = ?, status = 'linked', linking_started_at = NULL, updated_at = ?
    WHERE id = ? AND session_id = ? AND status = 'linking'
      AND linking_started_at = ?
    RETURNING *
  `).bind(
    clientId || null,
    leadId || null,
    timestamp,
    handoffId,
    sessionId,
    linkingStartedAt
  ).first();
  if (!linked) {
    const current = await getHandoff(env, sessionId);
    if (current && ['linked', 'delivered'].includes(current.status)) return current;
    throw new ConsumerError(409, 'handoff_state_conflict', 'The adviser handoff state changed during delivery. Refresh its status.');
  }
  await db(env).prepare(`
    UPDATE consumer_sessions
    SET stage = 'human_handoff', status = 'completed', last_active_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `).bind(timestamp, sessionId).run();
  await recordEvent(env, sessionId, 'handoff_linked', { handoffId }).catch(() => {});
  return linked;
}

export async function markHandoffFailed(env, sessionId, handoffId, linkingStartedAt) {
  await db(env).prepare(`
    UPDATE consumer_handoffs
    SET status = 'failed', linking_started_at = NULL, updated_at = ?
    WHERE id = ? AND session_id = ? AND status = 'linking'
      AND linking_started_at = ?
  `).bind(nowIso(), handoffId, sessionId, linkingStartedAt).run();
}

export async function revokeHandoff(env, sessionId) {
  const existing = await getHandoff(env, sessionId);
  if (!existing) return { row: null, downstreamShared: false, changed: false };
  if (existing.status === 'linking') {
    throw new ConsumerError(
      409,
      'handoff_delivery_in_progress',
      'Secure delivery has already started. Refresh the status before changing this request.'
    );
  }
  if (['revoked', 'purged'].includes(existing.status)) {
    return {
      row: existing,
      downstreamShared: existing.status === 'revoked' && Boolean(existing.lead_id),
      changed: false
    };
  }
  const downstreamShared = ['linked', 'delivered'].includes(existing.status) || Boolean(existing.lead_id);
  const timestamp = nowIso();
  const updated = await db(env).prepare(`
    UPDATE consumer_handoffs
    SET status = 'revoked', package_encrypted = NULL, package_purged_at = ?,
        linking_started_at = NULL, updated_at = ?
    WHERE id = ? AND session_id = ?
      AND status IN ('pending', 'failed', 'linked', 'delivered')
    RETURNING *
  `).bind(timestamp, timestamp, existing.id, sessionId).first();
  if (!updated) {
    const current = await getHandoff(env, sessionId);
    if (current?.status === 'linking') {
      throw new ConsumerError(
        409,
        'handoff_delivery_in_progress',
        'Secure delivery has already started. Refresh the status before changing this request.'
      );
    }
    return { row: current || existing, downstreamShared, changed: false };
  }
  await recordEvent(env, sessionId, 'handoff_revoked', {
    handoffId: updated.id,
    downstreamShared
  }).catch(() => {});
  return { row: updated, downstreamShared, changed: true };
}

export async function recordEvent(env, sessionId, eventName, metadata = {}) {
  if (!ALLOWED_EVENT_NAMES.has(eventName)) return;
  const safeMetadata = {};
  const allowedFields = EVENT_METADATA_FIELDS[eventName] || new Set();
  for (const [key, value] of Object.entries(metadata)) {
    if (!allowedFields.has(key)) continue;
    if (value === null || typeof value === 'boolean' || typeof value === 'number') safeMetadata[key] = value;
    else if (typeof value === 'string' && value.length <= 160) safeMetadata[key] = value;
    else if (Array.isArray(value) && value.length <= 20 && value.every((item) => typeof item === 'string' && item.length <= 80)) safeMetadata[key] = value;
  }
  await db(env).prepare(`
    INSERT INTO consumer_events (id, session_id, event_name, metadata_json, created_at)
    SELECT ?, ?, ?, ?, ?
    WHERE ? IS NULL OR EXISTS (
      SELECT 1 FROM consumer_sessions
      WHERE id = ? AND deleted_at IS NULL
    )
  `).bind(
    randomId('event'),
    sessionId || null,
    eventName,
    JSON.stringify(safeMetadata),
    nowIso(),
    sessionId || null,
    sessionId || null
  ).run();
}

export async function checkConsumerRateLimit(env, scope, bucketKey, windowMs, maximum) {
  const bucketHash = await hmacSha256Base64Url(
    env.CONSUMER_RATE_LIMIT_HASH_KEY,
    `consumer-rate/${scope}/${bucketKey || 'unknown'}`
  );
  const now = Date.now();
  const windowStartedAt = Math.floor(now / windowMs) * windowMs;
  const row = await db(env).prepare(`
    INSERT INTO consumer_rate_limits (
      scope, bucket_key_hash_b64u, window_started_at, count, updated_at
    ) VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(scope, bucket_key_hash_b64u) DO UPDATE SET
      window_started_at = excluded.window_started_at,
      count = CASE
        WHEN consumer_rate_limits.window_started_at = excluded.window_started_at
          THEN consumer_rate_limits.count + 1
        ELSE 1
      END,
      updated_at = excluded.updated_at
    RETURNING count
  `).bind(scope, bucketHash, windowStartedAt, nowIso()).first();
  return Number(row?.count || 0) <= maximum;
}

export async function rotateConsumerEncryptionBatch(env, requestedLimit) {
  if (!env.CONSUMER_DB) {
    return { currentKeyId: null, scanned: 0, rotated: 0, failed: 0, remaining: 0, complete: true };
  }
  const configuredLimit = Number.parseInt(String(requestedLimit || env.CONSUMER_REKEY_BATCH_SIZE || '25'), 10);
  const limit = Number.isInteger(configuredLimit)
    ? Math.min(100, Math.max(1, configuredLimit))
    : 25;
  const currentKeyId = getCurrentEncryptionKeyId(env);
  let scanned = 0;
  let rotated = 0;
  let failed = 0;

  for (const spec of ENCRYPTED_PAYLOAD_SPECS) {
    const remainingCapacity = limit - scanned;
    if (remainingCapacity <= 0) break;
    const rows = await db(env).prepare(`
      SELECT ${spec.select}, ${spec.column} AS encrypted_payload
      FROM ${spec.table}
      WHERE ${spec.column} IS NOT NULL
        AND ${nonCurrentKeyPredicate(spec.column)}
      LIMIT ?
    `).bind(currentKeyId, remainingCapacity).all();
    for (const row of rows.results || []) {
      scanned += 1;
      try {
        const sourceKeyId = getEncryptedPayloadKeyId(row.encrypted_payload);
        if (!sourceKeyId || sourceKeyId === currentKeyId) {
          if (!sourceKeyId) failed += 1;
          continue;
        }
        const plaintext = await decryptJson(env, row.encrypted_payload, spec.aad(row));
        const replacement = await encryptJson(env, plaintext, spec.aad(row));
        const keyWhere = spec.keys.map((key) => `${key} = ?`).join(' AND ');
        const update = await db(env).prepare(`
          UPDATE ${spec.table}
          SET ${spec.column} = ?
          WHERE ${keyWhere} AND ${spec.column} = ?
        `).bind(
          replacement,
          ...spec.keys.map((key) => row[key]),
          row.encrypted_payload
        ).run();
        if (Number(update.meta?.changes || 0) === 1) rotated += 1;
      } catch (_error) {
        // Aggregate only. Record identifiers, ciphertext and decrypted payloads
        // must never enter rotation logs.
        failed += 1;
      }
    }
  }

  let remaining = 0;
  for (const spec of ENCRYPTED_PAYLOAD_SPECS) {
    const row = await db(env).prepare(`
      SELECT COUNT(*) AS count
      FROM ${spec.table}
      WHERE ${spec.column} IS NOT NULL
        AND ${nonCurrentKeyPredicate(spec.column)}
    `).bind(currentKeyId).first();
    remaining += Number(row?.count || 0);
  }
  const result = {
    currentKeyId,
    scanned,
    rotated,
    failed,
    remaining,
    complete: remaining === 0 && failed === 0
  };
  await db(env).prepare(`
    INSERT INTO consumer_rekey_runs (
      id, current_key_id, scanned, rotated, failed, remaining, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    randomId('rekey'),
    currentKeyId,
    scanned,
    rotated,
    failed,
    remaining,
    nowIso()
  ).run();
  return result;
}

export async function deleteSessionData(env, sessionId, reason = 'deleted') {
  const timestamp = nowIso();
  const revokedCredentialHash = randomId('revoked');
  const lockedSessionExists = `
    EXISTS (
      SELECT 1 FROM consumer_sessions
      WHERE id = ? AND deleted_at = ? AND credential_hash_b64u = ?
    )
  `;
  const statements = [
    // The lock and every purge statement commit as one D1 batch. This preserves
    // mutual exclusion with delivery claims without a crash window that could
    // revoke the only credential before personal data is purged.
    db(env).prepare(`
      UPDATE consumer_sessions
      SET status = ?, deleted_at = ?, credential_hash_b64u = ?,
          rolling_summary_encrypted = NULL, last_active_at = ?
      WHERE id = ? AND deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM consumer_realtime_sessions
          WHERE session_id = consumer_sessions.id
            AND status IN ('pending', 'active', 'closing')
        )
    `).bind(
      reason === 'expired' ? 'expired' : 'deleted',
      timestamp,
      revokedCredentialHash,
      timestamp,
      sessionId
    ),
    // Preserve only the invitation's aggregate anti-abuse use count. Remove
    // the join back to this consumer session during deletion.
    db(env).prepare(`
      UPDATE consumer_invite_uses
      SET session_id = ?
      WHERE session_id = ? AND ${lockedSessionExists}
    `).bind(randomId('deleted_invite_use'), sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_module_runs WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_analysis_runs WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_voice_consent_events WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_voice_consents WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    // Realtime rows are purged in strict child-before-parent order. Active
    // leases are excluded by the session lock above and must be terminated by
    // the lifecycle coordinator before deletion can begin.
    db(env).prepare(`DELETE FROM consumer_realtime_run_provenance WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_realtime_fact_proposals WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_realtime_final_turns WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_realtime_usage WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_realtime_events WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_realtime_tool_attempts WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_realtime_analysis_plans WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_realtime_consent_events WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_realtime_consents WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_realtime_sessions WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    // Move only date-level cost totals out of the linkable ledger before it is
    // deleted. This prevents delete-and-recreate from reopening the daily cap.
    db(env).prepare(`
      INSERT INTO consumer_provider_daily_cost_totals (
        day_utc, spent_eur_micros, known_actual_eur_micros,
        reserved_or_unknown_eur_micros, released_eur_micros, updated_at
      )
      SELECT
        substr(costs.created_at, 1, 10),
        COALESCE(SUM(${providerCostChargeSql('costs')}), 0),
        COALESCE(SUM(CASE
          WHEN costs.status = 'known' THEN costs.actual_cost_eur_micros
          ELSE 0
        END), 0),
        COALESCE(SUM(CASE
          WHEN costs.status IN ('reserved', 'unknown') THEN costs.reserved_cost_eur_micros
          ELSE 0
        END), 0),
        COALESCE(SUM(CASE
          WHEN costs.status = 'not_sent' THEN costs.reserved_cost_eur_micros
          ELSE 0
        END), 0),
        ?
      FROM consumer_provider_costs AS costs
      WHERE costs.session_id = ? AND ${lockedSessionExists}
      GROUP BY substr(costs.created_at, 1, 10)
      ON CONFLICT(day_utc) DO UPDATE SET
        spent_eur_micros = consumer_provider_daily_cost_totals.spent_eur_micros
          + excluded.spent_eur_micros,
        known_actual_eur_micros = consumer_provider_daily_cost_totals.known_actual_eur_micros
          + excluded.known_actual_eur_micros,
        reserved_or_unknown_eur_micros = consumer_provider_daily_cost_totals.reserved_or_unknown_eur_micros
          + excluded.reserved_or_unknown_eur_micros,
        released_eur_micros = consumer_provider_daily_cost_totals.released_eur_micros
          + excluded.released_eur_micros,
        updated_at = excluded.updated_at
    `).bind(timestamp, sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_provider_costs WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_ai_attempts WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_conversation_turns WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_consent_events WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_profile_revisions WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`DELETE FROM consumer_events WHERE session_id = ? AND ${lockedSessionExists}`)
      .bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`
      DELETE FROM consumer_handoffs
      WHERE session_id = ?
        AND status NOT IN ('linking', 'linked', 'delivered')
        AND ${lockedSessionExists}
    `).bind(sessionId, sessionId, timestamp, revokedCredentialHash),
    db(env).prepare(`
      DELETE FROM consumer_sessions
      WHERE id = ? AND deleted_at = ? AND credential_hash_b64u = ?
        AND NOT EXISTS (
          SELECT 1 FROM consumer_handoffs
          WHERE session_id = ? AND status IN ('linking', 'linked', 'delivered')
        )
    `).bind(sessionId, timestamp, revokedCredentialHash, sessionId)
  ];
  try {
    const results = await db(env).batch(statements);
    if (Number(results[0]?.meta?.changes || 0) !== 1) throw notFound();
  } catch (error) {
    if (error instanceof ConsumerError) throw error;
    throw new ConsumerError(500, 'consumer_deletion_failed', 'This session could not be deleted just now. Please try again.');
  }
  const retainedHandoff = await getHandoff(env, sessionId);
  return {
    retainedHandoff: Boolean(
      retainedHandoff && ['linking', 'linked', 'delivered'].includes(retainedHandoff.status)
    )
  };
}

export async function cleanupExpiredConsumerSessions(env, dependencies = {}) {
  if (!env.CONSUMER_DB) {
    return {
      checked: 0,
      deleted: 0,
      closedRealtime: 0,
      reconciledHandoffs: 0,
      releasedHandoffs: 0,
      purgedHandoffs: 0,
      deletedHandoffTombstones: 0,
      failed: 0
    };
  }
  let closedRealtime = 0;
  let failed = 0;
  const realtimeExpiry = await db(env).prepare(`
    SELECT * FROM consumer_realtime_sessions
    WHERE status IN ('pending', 'active', 'closing')
      AND (hard_expires_at <= ? OR idle_expires_at <= ?)
    ORDER BY hard_expires_at ASC
    LIMIT 50
  `).bind(nowIso(), nowIso()).all();
  for (const lease of realtimeExpiry.results || []) {
    try {
      if (typeof dependencies.terminateRealtimeLease !== 'function') {
        throw new Error('realtime_termination_dependency_missing');
      }
      await dependencies.terminateRealtimeLease(lease);
      closedRealtime += 1;
    } catch (error) {
      failed += 1;
      console.error('Consumer realtime lease expiry cleanup failed', {
        sessionId: lease.session_id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const result = await db(env).prepare(`
    SELECT id
    FROM consumer_sessions
    WHERE status IN ('active', 'completed', 'abandoned')
      AND expires_at <= ?
    ORDER BY expires_at ASC
    LIMIT 100
  `).bind(nowIso()).all();
  let deleted = 0;
  for (const row of result.results || []) {
    try {
      const activeRealtime = await db(env).prepare(`
        SELECT id FROM consumer_realtime_sessions
        WHERE session_id = ? AND status IN ('pending', 'active', 'closing')
        LIMIT 1
      `).bind(row.id).first();
      if (activeRealtime) {
        if (typeof dependencies.terminateRealtimeSession !== 'function') {
          throw new Error('realtime_termination_dependency_missing');
        }
        await dependencies.terminateRealtimeSession(row.id);
        const stillActive = await db(env).prepare(`
          SELECT id FROM consumer_realtime_sessions
          WHERE session_id = ? AND status IN ('pending', 'active', 'closing')
          LIMIT 1
        `).bind(row.id).first();
        if (stillActive) throw new Error('realtime_termination_unconfirmed');
      }
      await recordEvent(env, row.id, 'journey_expired', {}).catch(() => {});
      await deleteSessionData(env, row.id, 'expired');
      deleted += 1;
    } catch (error) {
      failed += 1;
      console.error('Consumer session expiry cleanup failed', {
        sessionId: row.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const rateLimitCutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  await db(env).prepare(`
    DELETE FROM consumer_rate_limits
    WHERE updated_at < ?
  `).bind(rateLimitCutoff).run().catch((error) => {
    console.error('Consumer rate-limit cleanup failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  });
  const staleReservationCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  await db(env).prepare(`
    UPDATE consumer_ai_attempts
    SET status = 'failed', error_code = 'worker_interrupted', completed_at = ?
    WHERE status = 'reserved' AND created_at < ?
  `).bind(nowIso(), staleReservationCutoff).run().catch((error) => {
    console.error('Consumer AI reservation cleanup failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  });

  let reconciledHandoffs = 0;
  let releasedHandoffs = 0;
  let purgedHandoffs = 0;
  let deletedHandoffTombstones = 0;
  const staleLinkingBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  try {
    const staleLinking = await db(env).prepare(`
      SELECT id, session_id, retention_expires_at, linking_started_at
      FROM consumer_handoffs
      WHERE status = 'linking' AND linking_started_at <= ?
      ORDER BY linking_started_at ASC
      LIMIT 50
    `).bind(staleLinkingBefore).all();
    for (const row of staleLinking.results || []) {
      let receipt = null;
      let receiptChecked = false;
      if (typeof dependencies.lookupHandoffDelivery === 'function') {
        try {
          receipt = await dependencies.lookupHandoffDelivery(row.id);
          receiptChecked = true;
        } catch (_error) {
          // A transient adviser-database error leaves an unexpired lease for the
          // next cleanup. The hard retention branch below still purges expired
          // encrypted data.
        }
      }
      if (receipt?.leadId) {
        const timestamp = nowIso();
        const updates = await db(env).batch([
          db(env).prepare(`
            UPDATE consumer_handoffs
            SET lead_id = ?, client_id = ?, status = 'linked',
                linking_started_at = NULL, updated_at = ?
            WHERE id = ? AND session_id = ? AND status = 'linking'
              AND linking_started_at = ?
          `).bind(
            receipt.leadId,
            receipt.clientId || null,
            timestamp,
            row.id,
            row.session_id,
            row.linking_started_at
          ),
          db(env).prepare(`
            UPDATE consumer_sessions
            SET stage = 'human_handoff', status = 'completed', last_active_at = ?
            WHERE id = ? AND deleted_at IS NULL
              AND EXISTS (
                SELECT 1 FROM consumer_handoffs
                WHERE id = ? AND session_id = ? AND status = 'linked'
                  AND lead_id = ?
              )
          `).bind(timestamp, row.session_id, row.id, row.session_id, receipt.leadId)
        ]);
        if (Number(updates[0]?.meta?.changes || 0) === 1) reconciledHandoffs += 1;
        continue;
      }
      if (receiptChecked && row.retention_expires_at > nowIso()) {
        const released = await db(env).prepare(`
          UPDATE consumer_handoffs
          SET status = 'failed', linking_started_at = NULL, updated_at = ?
          WHERE id = ? AND session_id = ? AND status = 'linking'
            AND linking_started_at = ?
        `).bind(nowIso(), row.id, row.session_id, row.linking_started_at).run();
        if (Number(released.meta?.changes || 0) === 1) releasedHandoffs += 1;
      }
    }
  } catch (error) {
    failed += 1;
    console.error('Consumer linking-handoff reconciliation failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
  try {
    const terminalPurged = await db(env).prepare(`
      UPDATE consumer_handoffs
      SET package_encrypted = NULL, status = 'purged', package_purged_at = ?,
          linking_started_at = NULL, updated_at = ?
      WHERE package_encrypted IS NOT NULL AND retention_expires_at <= ?
        AND (
          status IN ('pending', 'failed')
          OR (status = 'linking' AND linking_started_at <= ?)
        )
      RETURNING id, session_id
    `).bind(nowIso(), nowIso(), nowIso(), staleLinkingBefore).all();
    const deliveredPurged = await db(env).prepare(`
      UPDATE consumer_handoffs
      SET package_encrypted = NULL, package_purged_at = ?, updated_at = ?
      WHERE package_encrypted IS NOT NULL AND retention_expires_at <= ?
        AND status IN ('linked', 'delivered')
      RETURNING id, session_id
    `).bind(nowIso(), nowIso(), nowIso()).all();
    const purged = [
      ...(terminalPurged.results || []),
      ...(deliveredPurged.results || [])
    ];
    purgedHandoffs = purged.length;
    for (const row of purged) {
      await recordEvent(env, row.session_id, 'handoff_package_purged', { handoffId: row.id }).catch(() => {});
    }
  } catch (error) {
    failed += 1;
    console.error('Consumer handoff retention cleanup failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    const tombstoneResults = await db(env).batch([
      db(env).prepare(`
        DELETE FROM consumer_handoffs
        WHERE package_encrypted IS NULL
          AND session_id IN (
            SELECT id FROM consumer_sessions WHERE deleted_at IS NOT NULL
          )
      `),
      db(env).prepare(`
        DELETE FROM consumer_sessions
        WHERE deleted_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM consumer_handoffs
            WHERE consumer_handoffs.session_id = consumer_sessions.id
          )
      `)
    ]);
    deletedHandoffTombstones = Number(tombstoneResults[0]?.meta?.changes || 0);
  } catch (error) {
    failed += 1;
    console.error('Consumer handoff tombstone cleanup failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  const inviteCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await db(env).prepare(`
    DELETE FROM consumer_invite_uses
    WHERE jti_hash_b64u IN (
      SELECT jti_hash_b64u FROM consumer_invite_redemptions WHERE expires_at < ?
    )
  `).bind(inviteCutoff).run().catch((error) => {
    console.error('Consumer invite-use cleanup failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  });
  await db(env).prepare(`
    DELETE FROM consumer_invite_redemptions
    WHERE expires_at < ?
  `).bind(inviteCutoff).run().catch((error) => {
    console.error('Consumer invite cleanup failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  });
  const rekeyAuditCutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  await db(env).prepare(`
    DELETE FROM consumer_rekey_runs
    WHERE created_at < ?
  `).bind(rekeyAuditCutoff).run().catch((error) => {
    console.error('Consumer rekey-audit cleanup failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  });
  return {
    checked: (result.results || []).length,
    deleted,
    closedRealtime,
    reconciledHandoffs,
    releasedHandoffs,
    purgedHandoffs,
    deletedHandoffTombstones,
    failed
  };
}
