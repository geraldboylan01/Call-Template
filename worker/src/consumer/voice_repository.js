import { ConsumerError } from './errors.js';
import { randomId } from './crypto.js';

function db(env) {
  if (!env.CONSUMER_DB) {
    throw new ConsumerError(503, 'consumer_storage_unavailable', 'This planning journey is not available right now.');
  }
  return env.CONSUMER_DB;
}

function nowIso() {
  return new Date().toISOString();
}

export function toPublicVoiceConsent(row) {
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

export async function getVoiceConsent(env, sessionId) {
  return db(env).prepare(`
    SELECT session_id, granted, notice_id, data_policy_id, policy_version,
           privacy_notice_url, captured_at, withdrawn_at, updated_at,
           last_event_id
    FROM consumer_voice_consents
    WHERE session_id = ?
    LIMIT 1
  `).bind(sessionId).first();
}

export async function setVoiceConsent(env, sessionRow, config, granted) {
  const timestamp = nowIso();
  const eventId = randomId('voice_consent');
  if (!granted) {
    await db(env).batch([
      db(env).prepare(`
        UPDATE consumer_voice_consents
        SET granted = 0, withdrawn_at = ?, updated_at = ?, last_event_id = ?
        WHERE session_id = ? AND granted = 1
          AND EXISTS (
            SELECT 1 FROM consumer_sessions
            WHERE id = ? AND deleted_at IS NULL
              AND status IN ('active', 'completed')
          )
      `).bind(timestamp, timestamp, eventId, sessionRow.id, sessionRow.id),
      db(env).prepare(`
        INSERT INTO consumer_voice_consent_events (
          id, session_id, action, notice_id, data_policy_id, policy_version,
          privacy_notice_url, capture_method, occurred_at
        )
        SELECT ?, session_id, 'withdrawn', notice_id, data_policy_id,
               policy_version, privacy_notice_url,
               'consumer_explicit_control', ?
        FROM consumer_voice_consents
        WHERE session_id = ? AND last_event_id = ?
      `).bind(eventId, timestamp, sessionRow.id, eventId)
    ]);
    return getVoiceConsent(env, sessionRow.id);
  }
  await db(env).batch([
    db(env).prepare(`
      INSERT INTO consumer_voice_consents (
        session_id, granted, notice_id, data_policy_id, policy_version,
        privacy_notice_url, captured_at, withdrawn_at, updated_at,
        last_event_id
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM consumer_sessions
        WHERE id = ? AND deleted_at IS NULL
          AND status IN ('active', 'completed')
          AND provider_cost_limit_eur_micros > 0
      )
      ON CONFLICT(session_id) DO UPDATE SET
        granted = excluded.granted,
        notice_id = excluded.notice_id,
        data_policy_id = excluded.data_policy_id,
        policy_version = excluded.policy_version,
        privacy_notice_url = excluded.privacy_notice_url,
        captured_at = excluded.captured_at,
        withdrawn_at = excluded.withdrawn_at,
        updated_at = excluded.updated_at,
        last_event_id = excluded.last_event_id
      WHERE consumer_voice_consents.granted <> excluded.granted
        OR consumer_voice_consents.notice_id <> excluded.notice_id
        OR consumer_voice_consents.data_policy_id <> excluded.data_policy_id
        OR consumer_voice_consents.policy_version <> excluded.policy_version
        OR consumer_voice_consents.privacy_notice_url <> excluded.privacy_notice_url
        OR consumer_voice_consents.withdrawn_at IS NOT NULL
    `).bind(
      sessionRow.id,
      1,
      config.voiceNoticeId,
      config.voiceDataPolicyId,
      config.consentPolicyVersion,
      config.privacyNoticeUrl,
      timestamp,
      null,
      timestamp,
      eventId,
      sessionRow.id
    ),
    db(env).prepare(`
      INSERT INTO consumer_voice_consent_events (
        id, session_id, action, notice_id, data_policy_id, policy_version,
        privacy_notice_url, capture_method, occurred_at
      )
      SELECT ?, session_id, 'granted', notice_id, data_policy_id,
             policy_version, privacy_notice_url,
             'consumer_explicit_control', ?
      FROM consumer_voice_consents
      WHERE session_id = ? AND last_event_id = ?
    `).bind(eventId, timestamp, sessionRow.id, eventId)
  ]);
  const row = await getVoiceConsent(env, sessionRow.id);
  if (!row) {
    throw new ConsumerError(409, 'voice_budget_unavailable', 'Voice is not available for this saved session. Start a new adviser-test session.');
  }
  return row;
}

export function voiceConsentIsCurrent(row, config) {
  return Boolean(
    row
    && Number(row.granted) === 1
    && row.notice_id === config.voiceNoticeId
    && row.data_policy_id === config.voiceDataPolicyId
    && row.policy_version === config.consentPolicyVersion
    && row.privacy_notice_url === config.privacyNoticeUrl
    && !row.withdrawn_at
  );
}
