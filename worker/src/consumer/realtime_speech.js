import {
  constantTimeEqual,
  hmacSha256Base64Url,
  randomId,
  sha256Base64Url,
  stableStringify
} from './crypto.js';
import { ConsumerError, badRequest } from './errors.js';
import {
  finalizeRealtimeSpeechUsage,
  enqueueRealtimeControlMessage,
  getRealtimeConsent,
  getRealtimeLease,
  markRealtimeSpeechDispatched,
  realtimeConsentIsCurrent,
  reserveRealtimeSpeechUsage
} from './realtime_repository.js';
import { synthesizeRealtimeControlledSpeech } from './voice_provider.js';

const SPEECH_KINDS = new Set([
  'greeting',
  'acknowledgement',
  'question',
  'read_back',
  'plan',
  'result',
  'status'
]);
const SPEECH_ID = /^speech_[A-Za-z0-9_-]{20,80}$/;
const BINDING_ID = /^speech_binding_[A-Za-z0-9_-]{20,80}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function assertExactText(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text || text !== text.trim() || text.length > 2_400 || FORBIDDEN_TEXT.test(text)) {
    throw badRequest('The approved spoken response is invalid.', 'realtime_speech_text_invalid');
  }
  return text;
}

async function contentBinding({
  sessionId,
  leaseId,
  speechId,
  kind,
  profileRevision,
  bindingId,
  text,
  controlId,
  expiresAt
}) {
  return stableStringify({
    version: 'consumer-realtime-speech-v2',
    sessionId,
    leaseId,
    speechId,
    kind,
    profileRevision,
    bindingId,
    textHashB64u: await sha256Base64Url(text),
    controlId,
    expiresAt
  });
}

export async function issueRealtimeSpeechAuthorization({
  env,
  sessionId,
  leaseId,
  kind,
  profileRevision,
  text
}) {
  const approvedText = assertExactText(text);
  if (!/^cs_[A-Za-z0-9_-]{20,80}$/.test(String(sessionId || ''))
    || !/^rt_[A-Za-z0-9_-]{20,80}$/.test(String(leaseId || ''))
    || !SPEECH_KINDS.has(kind)
    || !Number.isSafeInteger(profileRevision)
    || profileRevision < 1) {
    throw new ConsumerError(500, 'realtime_speech_authorization_invalid', 'Approved speech could not be authorized.');
  }
  const speechId = randomId('speech');
  const bindingId = randomId('speech_binding');
  const controlId = randomId('realtime_control');
  const lease = await getRealtimeLease(env, sessionId, leaseId);
  const expiresAt = new Date(Math.min(
    Date.now() + 75_000,
    Date.parse(lease?.hard_expires_at || '') || Date.now() + 75_000
  )).toISOString();
  const binding = await contentBinding({
    sessionId,
    leaseId,
    speechId,
    kind,
    profileRevision,
    bindingId,
    text: approvedText,
    controlId,
    expiresAt
  });
  const token = await hmacSha256Base64Url(
    env.CONSUMER_RATE_LIMIT_HASH_KEY,
    `consumer/realtime/speech/authorization/v1/${binding}`
  );
  const authorization = {
    speechId,
    kind,
    profileRevision,
    bindingId,
    text: approvedText,
    token,
    controlId,
    expiresAt
  };
  await enqueueRealtimeControlMessage(env, { sessionId, leaseId, authorization });
  return authorization;
}

export function validateRealtimeSpeechBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('An approved speech authorization is required.', 'realtime_speech_authorization_invalid');
  }
  const allowed = new Set(['speechId', 'kind', 'profileRevision', 'bindingId', 'text', 'token', 'controlId', 'expiresAt']);
  if (Object.keys(body).some((key) => !allowed.has(key))
    || !SPEECH_ID.test(String(body.speechId || ''))
    || !SPEECH_KINDS.has(body.kind)
    || !Number.isSafeInteger(body.profileRevision)
    || body.profileRevision < 1
    || !BINDING_ID.test(String(body.bindingId || ''))
    || !TOKEN.test(String(body.token || ''))
    || !/^realtime_control_[A-Za-z0-9_-]{20,80}$/.test(String(body.controlId || ''))
    || !Number.isFinite(Date.parse(String(body.expiresAt || '')))) {
    throw badRequest('The approved speech authorization is invalid.', 'realtime_speech_authorization_invalid');
  }
  return {
    speechId: body.speechId,
    kind: body.kind,
    profileRevision: body.profileRevision,
    bindingId: body.bindingId,
    text: assertExactText(body.text),
    token: body.token,
    controlId: body.controlId,
    expiresAt: body.expiresAt
  };
}

async function verifyAuthorization(env, sessionId, leaseId, authorization) {
  const binding = await contentBinding({ sessionId, leaseId, ...authorization });
  const expected = await hmacSha256Base64Url(
    env.CONSUMER_RATE_LIMIT_HASH_KEY,
    `consumer/realtime/speech/authorization/v1/${binding}`
  );
  if (!constantTimeEqual(expected, authorization.token)) {
    throw new ConsumerError(403, 'realtime_speech_authorization_invalid', 'The approved speech authorization could not be verified.');
  }
}

function streamWithRealtimeUsageFinalization({
  env,
  sessionId,
  leaseId,
  usageId,
  providerRequestId,
  stream
}) {
  const reader = stream.getReader();
  let finalized = false;
  let finalizationPromise = null;
  let clientCancelled = false;
  const finalize = async (status, errorCode = null) => {
    if (finalized) return true;
    if (finalizationPromise) return finalizationPromise;
    finalizationPromise = (async () => {
      let lastError = null;
      for (const delayMs of [0, 25, 100]) {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        try {
          const row = await finalizeRealtimeSpeechUsage(env, {
            usageId,
            sessionId,
            leaseId,
            status,
            providerRequestId,
            errorCode
          });
          if (row) {
            finalized = true;
            return true;
          }
          lastError = new Error('speech_usage_transition_missing');
        } catch (error) {
          lastError = error;
        }
      }
      console.error('Consumer Realtime speech stream finalization failed', {
        usageId,
        status,
        error: lastError instanceof Error ? lastError.message : String(lastError)
      });
      return false;
    })();
    try {
      return await finalizationPromise;
    } finally {
      if (!finalized) finalizationPromise = null;
    }
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          if (!await finalize('known')) throw new Error('realtime_speech_usage_finalize_failed');
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        if (!finalized) {
          await finalize(
            clientCancelled ? 'known' : 'unknown',
            clientCancelled
              ? 'realtime_speech_playback_cancelled'
              : 'realtime_speech_stream_failed'
          );
        }
        controller.error(error);
      }
    },
    async cancel(reason) {
      clientCancelled = true;
      await reader.cancel(reason).catch(() => {});
      // The provider accepted the complete, character-priced TTS request
      // before this stream was exposed. Barge-in changes delivery, not the
      // known provider charge, so it must not poison the whole lease ledger.
      if (!await finalize('known', 'realtime_speech_playback_cancelled')) {
        throw new Error('realtime_speech_usage_finalize_failed');
      }
    }
  });
}

export async function renderAuthorizedRealtimeSpeech({
  env,
  config,
  sessionRow,
  leaseId,
  body,
  synthesize = synthesizeRealtimeControlledSpeech
}) {
  const authorization = validateRealtimeSpeechBody(body);
  if (Date.parse(authorization.expiresAt) <= Date.now()) {
    throw new ConsumerError(410, 'realtime_control_expired', 'That approved voice command has expired.');
  }
  await verifyAuthorization(env, sessionRow.id, leaseId, authorization);
  if (Number(sessionRow.current_profile_revision) !== authorization.profileRevision) {
    throw new ConsumerError(409, 'profile_revision_conflict', 'The planning profile changed before this approved speech could be played.');
  }
  const [lease, consent] = await Promise.all([
    getRealtimeLease(env, sessionRow.id, leaseId),
    getRealtimeConsent(env, sessionRow.id)
  ]);
  if (!lease || lease.status !== 'active' || lease.session_id !== sessionRow.id) {
    throw new ConsumerError(409, 'realtime_lease_conflict', 'The live voice lease is no longer active.');
  }
  if (Number(lease.latest_profile_revision) !== authorization.profileRevision) {
    throw new ConsumerError(409, 'profile_revision_conflict', 'The live voice lease is not bound to this planning revision.');
  }
  if (!realtimeConsentIsCurrent(consent, config)) {
    throw new ConsumerError(403, 'realtime_consent_required', 'Live voice consent changed before approved speech playback.');
  }
  const reservation = await reserveRealtimeSpeechUsage(env, {
    sessionId: sessionRow.id,
    leaseId,
    speechId: authorization.speechId,
    bindingId: authorization.bindingId,
    text: authorization.text,
    kind: authorization.kind,
    profileRevision: authorization.profileRevision,
    rateMicroEurPerMillionCharacters: config.realtimeSpeechRateMicroEurPerMillionCharacters,
    pricingVersion: config.realtimeSpeechPricingVersion,
    noticeId: config.realtimeNoticeId,
    dataPolicyId: config.realtimeDataPolicyId,
    policyVersion: config.consentPolicyVersion,
    privacyNoticeUrl: config.privacyNoticeUrl
  });
  if (reservation.existing) {
    throw new ConsumerError(409, 'realtime_speech_already_dispatched', 'That approved spoken response was already processed.');
  }
  if (reservation.denied || !reservation.row) {
    throw new ConsumerError(402, 'realtime_budget_exceeded', 'The protected live voice dispatch limit has been reached. Continue with the visible caption or typing.');
  }

  let dispatched = false;
  let providerRequestId = null;
  try {
    await markRealtimeSpeechDispatched(env, {
      usageId: reservation.row.id,
      sessionId: sessionRow.id,
      leaseId,
      noticeId: config.realtimeNoticeId,
      dataPolicyId: config.realtimeDataPolicyId,
      policyVersion: config.consentPolicyVersion,
      privacyNoticeUrl: config.privacyNoticeUrl
    });
    dispatched = true;
    const result = await synthesize({ env, config, text: authorization.text });
    providerRequestId = result.providerRequestId || null;
    const streaming = result.audioStream instanceof ReadableStream;
    if (!streaming) {
      await finalizeRealtimeSpeechUsage(env, {
        usageId: reservation.row.id,
        sessionId: sessionRow.id,
        leaseId,
        status: 'known',
        providerRequestId
      });
    }
    const currentLease = await getRealtimeLease(env, sessionRow.id, leaseId);
    return {
      audio: streaming
        ? streamWithRealtimeUsageFinalization({
          env,
          sessionId: sessionRow.id,
          leaseId,
          usageId: reservation.row.id,
          providerRequestId,
          stream: result.audioStream
        })
        : result.audio,
      streaming,
      contentLength: streaming ? result.contentLength : result.audio?.byteLength,
      contentType: result.contentType || 'audio/mpeg',
      speechId: authorization.speechId,
      kind: authorization.kind,
      text: authorization.text,
      budget: {
        limitMicroEur: Number(currentLease?.reservation_eur_micros || 0),
        spentMicroEur: Number(currentLease?.estimated_cost_eur_micros || 0),
        remainingMicroEur: Math.max(
          0,
          Number(currentLease?.reservation_eur_micros || 0)
            - Number(currentLease?.estimated_cost_eur_micros || 0)
        )
      }
    };
  } catch (error) {
    providerRequestId = providerRequestId || error?.providerRequestId || null;
    await finalizeRealtimeSpeechUsage(env, {
      usageId: reservation.row.id,
      sessionId: sessionRow.id,
      leaseId,
      status: dispatched ? 'unknown' : 'not_sent',
      providerRequestId,
      errorCode: error instanceof ConsumerError ? error.code : 'realtime_speech_failed'
    }).catch(() => {});
    throw error;
  }
}
