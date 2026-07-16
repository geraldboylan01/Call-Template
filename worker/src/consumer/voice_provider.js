import { ConsumerError, badRequest } from './errors.js';
import {
  getConsumerProviderBudget,
  markConsumerProviderCostInFlight,
  releaseConsumerProviderCostNotSent,
  reserveConsumerProviderCost,
  settleConsumerProviderCostUnknown
} from './repository.js';
import { redactSensitiveIdentifiers } from './validators.js';

const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,120}$/;
const ALLOWED_AUDIO_TYPES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/m4a',
  'audio/x-m4a'
]);
const SAFE_PROVIDER_REQUEST_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const MAX_TRANSCRIPTION_RESPONSE_BYTES = 256 * 1024;
const MAX_SPEECH_RESPONSE_BYTES = 5_000_000;

function cleanIdempotencyKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!IDEMPOTENCY_PATTERN.test(key)) {
    throw badRequest('Voice request id is invalid.', 'voice_idempotency_key_invalid');
  }
  return key;
}

function safeProviderRequestId(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return SAFE_PROVIDER_REQUEST_ID.test(candidate) ? candidate : null;
}

function audioExtension(type) {
  if (type.includes('webm')) return 'webm';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('mp4') || type.includes('m4a')) return 'm4a';
  if (type.includes('wav')) return 'wav';
  return 'mp3';
}

function asVoiceBudget(budget, fallbackLimit = 0) {
  const limitMicroEur = Number(budget?.limitMicroEur ?? budget?.limitEurMicros ?? fallbackLimit) || 0;
  const spentMicroEur = Number(budget?.spentMicroEur ?? budget?.spentEurMicros ?? 0) || 0;
  const remainingMicroEur = Number(
    budget?.remainingMicroEur
      ?? budget?.remainingEurMicros
      ?? Math.max(0, limitMicroEur - spentMicroEur)
  ) || 0;
  return { limitMicroEur, spentMicroEur, remainingMicroEur };
}

function reservationEntry(result) {
  return result?.entry || result?.row || (result?.id ? result : null);
}

function reservationDenied(result) {
  return result === null
    || result?.denied === true
    || result?.outcome === 'denied'
    || result?.status === 'denied'
    || (!reservationEntry(result) && result?.reserved !== true);
}

function reservationIsReplay(result) {
  return result?.existing === true
    || result?.outcome === 'existing'
    || result?.idempotentReplay === true
    || result?.status === 'existing';
}

async function reserveVoiceCost(env, config, sessionId, operation, idempotencyKey, model, amount) {
  const result = await reserveConsumerProviderCost(env, {
    sessionId,
    operation,
    idempotencyKey,
    provider: 'openai',
    model,
    pricingVersion: config.voicePricingVersion,
    reservedCostEurMicros: amount,
    dailyCostLimitEurMicros: config.voiceDailyBudgetMicroEur
  });
  if (reservationIsReplay(result)) {
    throw new ConsumerError(
      409,
      'voice_request_already_used',
      'That voice operation was already processed. Record or play it again to create a new request.'
    );
  }
  if (reservationDenied(result)) {
    throw new ConsumerError(
      402,
      'voice_budget_exceeded',
      'The protected €2 voice allowance for this session has been reached. You can continue by typing.'
    );
  }
  const entry = reservationEntry(result);
  if (!entry?.id) {
    throw new ConsumerError(503, 'voice_budget_unavailable', 'Voice cost protection is not available right now. You can continue by typing.');
  }
  return entry;
}

async function finalizeInFlightProviderCost(env, entry, metadata = {}) {
  await settleConsumerProviderCostUnknown(env, entry.id, metadata).catch((error) => {
    console.error('Consumer voice cost finalization failed', {
      operationId: entry.id,
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

async function releaseUndispatchedProviderCost(env, entry, errorCode) {
  await releaseConsumerProviderCostNotSent(env, entry.id, { errorCode }).catch((error) => {
    console.error('Consumer voice cost release failed', {
      operationId: entry.id,
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

async function requireCurrentConsentForDispatch(env, config, sessionRow, entry) {
  const transition = await markConsumerProviderCostInFlight(env, entry.id, {
    sessionId: sessionRow.id,
    noticeId: config.voiceNoticeId,
    dataPolicyId: config.voiceDataPolicyId,
    policyVersion: config.consentPolicyVersion,
    privacyNoticeUrl: config.privacyNoticeUrl
  });
  if (transition.outcome === 'in_flight') return transition.entry;
  if (transition.outcome === 'voice_consent_required') {
    throw new ConsumerError(
      403,
      'voice_consent_required',
      'Review and accept the current microphone disclosure before using voice.'
    );
  }
  throw new ConsumerError(
    409,
    'voice_request_already_used',
    'That voice operation was already processed. Record or play it again to create a new request.'
  );
}

function providerAbortError() {
  const error = new Error('Provider response aborted.');
  error.name = 'AbortError';
  return error;
}

function readProviderChunk(reader, signal) {
  if (signal.aborted) return Promise.reject(providerAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reader.cancel().catch(() => {});
      reject(providerAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

async function readBoundedProviderBody(response, controller, maximumBytes, invalidResponse) {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const normalized = declaredLength.trim();
    if (!/^(?:0|[1-9]\d*)$/.test(normalized)) throw invalidResponse();
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed) || parsed > maximumBytes) {
      controller.abort();
      throw invalidResponse();
    }
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw invalidResponse();

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readProviderChunk(reader, controller.signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw invalidResponse();
      total += value.byteLength;
      if (total > maximumBytes) {
        controller.abort();
        throw invalidResponse();
      }
      chunks.push(value);
    }
  } finally {
    if (!controller.signal.aborted) reader.releaseLock();
  }
  if (total < 1) throw invalidResponse();

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function providerFetch(config, url, init, responseOptions) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.voiceTimeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      return { response, body: null };
    }
    if (!responseOptions.acceptsContentType(response.headers.get('content-type'))) {
      controller.abort();
      throw responseOptions.invalidResponse();
    }
    const body = await readBoundedProviderBody(
      response,
      controller,
      responseOptions.maximumBytes,
      responseOptions.invalidResponse
    );
    return { response, body };
  } catch (error) {
    if (error instanceof ConsumerError) throw error;
    if (error?.name === 'AbortError') {
      throw new ConsumerError(504, 'voice_provider_timeout', 'Voice processing took too long. You can retry with a new recording or continue by typing.');
    }
    throw new ConsumerError(502, 'voice_provider_unavailable', 'Voice processing is temporarily unavailable. You can continue by typing.');
  } finally {
    clearTimeout(timeout);
  }
}

async function providerFetchStream(config, url, init, responseOptions) {
  const abortController = new AbortController();
  let timeout = null;
  const refreshTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => abortController.abort(), config.voiceTimeoutMs);
  };
  const finish = () => clearTimeout(timeout);
  refreshTimeout();
  try {
    const response = await fetch(url, { ...init, signal: abortController.signal });
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      finish();
      return { response, body: null, contentLength: null };
    }
    if (!responseOptions.acceptsContentType(response.headers.get('content-type'))) {
      abortController.abort();
      finish();
      throw responseOptions.invalidResponse();
    }

    let contentLength = null;
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) {
      const normalized = declaredLength.trim();
      if (!/^(?:0|[1-9]\d*)$/.test(normalized)) {
        abortController.abort();
        finish();
        throw responseOptions.invalidResponse();
      }
      contentLength = Number(normalized);
      if (!Number.isSafeInteger(contentLength)
        || contentLength < 1
        || contentLength > responseOptions.maximumBytes) {
        abortController.abort();
        finish();
        throw responseOptions.invalidResponse();
      }
    }
    if (!response.body || typeof response.body.getReader !== 'function') {
      abortController.abort();
      finish();
      throw responseOptions.invalidResponse();
    }

    const reader = response.body.getReader();
    const first = await readProviderChunk(reader, abortController.signal);
    if (first.done || !(first.value instanceof Uint8Array) || first.value.byteLength < 1) {
      abortController.abort();
      finish();
      throw responseOptions.invalidResponse();
    }
    if (first.value.byteLength > responseOptions.maximumBytes) {
      abortController.abort();
      finish();
      throw responseOptions.invalidResponse();
    }

    let initial = first.value;
    let total = first.value.byteLength;
    refreshTimeout();
    let closed = false;
    const closeProvider = () => {
      if (closed) return;
      closed = true;
      finish();
      try { reader.releaseLock(); } catch (_error) { /* best effort */ }
    };
    const body = new ReadableStream({
      async pull(streamController) {
        try {
          if (initial) {
            const value = initial;
            initial = null;
            streamController.enqueue(value);
            return;
          }
          const chunk = await readProviderChunk(reader, abortController.signal);
          if (chunk.done) {
            if (contentLength !== null && total !== contentLength) {
              throw responseOptions.invalidResponse();
            }
            closeProvider();
            streamController.close();
            return;
          }
          if (!(chunk.value instanceof Uint8Array)) throw responseOptions.invalidResponse();
          refreshTimeout();
          total += chunk.value.byteLength;
          if (total > responseOptions.maximumBytes) throw responseOptions.invalidResponse();
          streamController.enqueue(chunk.value);
        } catch (error) {
          abortController.abort();
          closeProvider();
          streamController.error(error instanceof ConsumerError
            ? error
            : responseOptions.invalidResponse());
        }
      },
      async cancel(reason) {
        abortController.abort(reason);
        await reader.cancel(reason).catch(() => {});
        closeProvider();
      }
    });
    return { response, body, contentLength };
  } catch (error) {
    finish();
    if (error instanceof ConsumerError) throw error;
    if (error?.name === 'AbortError') {
      throw new ConsumerError(504, 'voice_provider_timeout', 'Voice processing took too long. You can retry or continue by typing.');
    }
    throw new ConsumerError(502, 'voice_provider_unavailable', 'Voice processing is temporarily unavailable. You can continue by typing.');
  }
}

function rejectOversizedDeclaredAudio(request, maximumBytes) {
  const raw = request.headers.get('Content-Length');
  if (raw === null) return;
  const normalized = raw.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(normalized)) {
    throw badRequest('The recording size header is invalid. Record again or continue by typing.', 'voice_audio_invalid');
  }
  const contentLength = Number(normalized);
  if (!Number.isSafeInteger(contentLength) || contentLength > maximumBytes) {
    throw new ConsumerError(413, 'voice_audio_too_large', 'That recording is too large. Record a shorter answer.');
  }
  if (contentLength === 0) {
    throw badRequest('A voice recording is required.', 'voice_audio_required');
  }
}

async function readBoundedAudioBody(request, maximumBytes) {
  if (!request.body || typeof request.body.getReader !== 'function') {
    throw badRequest('A voice recording is required.', 'voice_audio_required');
  }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw badRequest('The voice recording could not be read.', 'voice_audio_invalid');
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new ConsumerError(413, 'voice_audio_too_large', 'That recording is too large. Record a shorter answer.');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ConsumerError) throw error;
    throw badRequest('The voice recording could not be read.', 'voice_audio_invalid');
  } finally {
    try {
      reader.releaseLock();
    } catch (_error) {
      // Best effort after cancellation or a failed incoming stream.
    }
  }
  if (total < 1) {
    throw badRequest('A voice recording is required.', 'voice_audio_required');
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function requireProviderKey(env) {
  const key = typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY.trim() : '';
  if (!key) {
    throw new ConsumerError(503, 'voice_provider_unconfigured', 'Voice processing is not configured. You can continue by typing.');
  }
  return key;
}

export async function transcribeConsumerVoice({ env, config, sessionRow, request }) {
  const contentType = String(request.headers.get('Content-Type') || '').toLowerCase();
  const normalizedType = contentType.split(';')[0].trim();
  if (!ALLOWED_AUDIO_TYPES.has(normalizedType)) {
    throw badRequest('That audio format is not supported. Try recording again in this browser.', 'voice_audio_type_unsupported');
  }
  const durationValue = String(request.headers.get('X-Voice-Duration-Ms') || '').trim();
  if (!/^[1-9]\d*$/.test(durationValue)) {
    throw badRequest(`Record between one and ${config.voiceMaxDurationSeconds} seconds.`, 'voice_duration_invalid');
  }
  const durationMs = Number(durationValue);
  if (!Number.isSafeInteger(durationMs) || durationMs < 250 || durationMs > config.voiceMaxDurationSeconds * 1_000 + 500) {
    throw badRequest(`Record between one and ${config.voiceMaxDurationSeconds} seconds.`, 'voice_duration_invalid');
  }
  const idempotencyKey = cleanIdempotencyKey(request.headers.get('X-Voice-Request-Id'));
  rejectOversizedDeclaredAudio(request, config.voiceMaxAudioBytes);
  const audioBytes = await readBoundedAudioBody(request, config.voiceMaxAudioBytes);
  const audio = new Blob([audioBytes], { type: normalizedType });

  const providerKey = requireProviderKey(env);
  const entry = await reserveVoiceCost(
    env,
    config,
    sessionRow.id,
    'voice_transcription',
    idempotencyKey,
    config.voiceTranscriptionModel,
    config.voiceTranscriptionReservationMicroEur
  );
  const startedAt = Date.now();
  let providerRequestId = null;
  let inFlight = false;
  try {
    const providerBody = new FormData();
    providerBody.set('model', config.voiceTranscriptionModel);
    providerBody.set('language', 'en');
    providerBody.set('response_format', 'json');
    providerBody.set(
      'prompt',
      'Irish English personal-finance vocabulary. Transcribe spoken euro amounts, dates, percentages and numbers exactly. Do not calculate or answer.'
    );
    providerBody.set('file', audio, `planeir-voice.${audioExtension(normalizedType)}`);
    await requireCurrentConsentForDispatch(env, config, sessionRow, entry);
    inFlight = true;
    const { response, body } = await providerFetch(config, 'https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${providerKey}`,
        'X-Client-Request-Id': crypto.randomUUID()
      },
      body: providerBody
    }, {
      maximumBytes: MAX_TRANSCRIPTION_RESPONSE_BYTES,
      acceptsContentType: (value) => String(value || '').toLowerCase().startsWith('application/json'),
      invalidResponse: () => new ConsumerError(
        502,
        'voice_transcription_invalid',
        'The transcription response was incomplete. You can retry or continue by typing.'
      )
    });
    providerRequestId = safeProviderRequestId(response.headers.get('x-request-id'));
    if (!response.ok) {
      console.error('Consumer voice transcription provider request failed', {
        status: response.status,
        providerRequestId
      });
      throw new ConsumerError(502, 'voice_transcription_failed', 'The recording could not be transcribed. You can retry or continue by typing.');
    }
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch (_error) {
      throw new ConsumerError(502, 'voice_transcription_invalid', 'The transcription response was incomplete. You can retry or continue by typing.');
    }
    const rawTranscript = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (!rawTranscript) {
      throw new ConsumerError(422, 'voice_transcription_empty', 'No clear speech was detected. Try again or type your answer.');
    }
    const transcript = redactSensitiveIdentifiers(rawTranscript).slice(0, config.maxMessageLength);
    await finalizeInFlightProviderCost(env, entry, {
      providerRequestId,
      latencyMs: Date.now() - startedAt,
      errorCode: null
    });
    const budget = asVoiceBudget(await getConsumerProviderBudget(env, sessionRow.id), config.voiceSessionBudgetMicroEur);
    return {
      transcript,
      sensitiveDetailsRemoved: transcript !== rawTranscript,
      voiceBudget: budget
    };
  } catch (error) {
    const errorCode = error instanceof ConsumerError ? error.code : 'voice_provider_failed';
    if (inFlight) {
      await finalizeInFlightProviderCost(env, entry, {
        providerRequestId,
        latencyMs: Date.now() - startedAt,
        errorCode
      });
    } else {
      await releaseUndispatchedProviderCost(env, entry, errorCode);
    }
    throw error;
  }
}

export async function speakConsumerQuestion({ env, config, sessionRow, idempotencyKey, text }) {
  const requestKey = cleanIdempotencyKey(idempotencyKey);
  const input = String(text || '').trim().slice(0, config.voiceMaxSpeechCharacters);
  if (!input) {
    throw new ConsumerError(409, 'voice_question_unavailable', 'There is no current planning question to read aloud.');
  }
  const providerKey = requireProviderKey(env);
  const entry = await reserveVoiceCost(
    env,
    config,
    sessionRow.id,
    'voice_speech',
    requestKey,
    config.voiceSpeechModel,
    config.voiceSpeechReservationMicroEur
  );
  const startedAt = Date.now();
  let providerRequestId = null;
  let inFlight = false;
  try {
    const providerBody = JSON.stringify({
      model: config.voiceSpeechModel,
      voice: config.voiceName,
      input,
      response_format: 'mp3'
    });
    await requireCurrentConsentForDispatch(env, config, sessionRow, entry);
    inFlight = true;
    const { response, body } = await providerFetch(config, 'https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${providerKey}`,
        'Content-Type': 'application/json',
        'X-Client-Request-Id': crypto.randomUUID()
      },
      body: providerBody
    }, {
      maximumBytes: MAX_SPEECH_RESPONSE_BYTES,
      acceptsContentType: (value) => String(value || '').toLowerCase().startsWith('audio/'),
      invalidResponse: () => new ConsumerError(
        502,
        'voice_speech_invalid',
        'The spoken response was incomplete. You can continue by reading it on screen.'
      )
    });
    providerRequestId = safeProviderRequestId(response.headers.get('x-request-id'));
    if (!response.ok) {
      console.error('Consumer voice speech provider request failed', {
        status: response.status,
        providerRequestId
      });
      throw new ConsumerError(502, 'voice_speech_failed', 'The question could not be read aloud. You can continue by reading it on screen.');
    }
    const audio = body.buffer;
    await finalizeInFlightProviderCost(env, entry, {
      providerRequestId,
      latencyMs: Date.now() - startedAt,
      errorCode: null
    });
    const budget = asVoiceBudget(await getConsumerProviderBudget(env, sessionRow.id), config.voiceSessionBudgetMicroEur);
    return { audio, text: input, voiceBudget: budget };
  } catch (error) {
    const errorCode = error instanceof ConsumerError ? error.code : 'voice_provider_failed';
    if (inFlight) {
      await finalizeInFlightProviderCost(env, entry, {
        providerRequestId,
        latencyMs: Date.now() - startedAt,
        errorCode
      });
    } else {
      await releaseUndispatchedProviderCost(env, entry, errorCode);
    }
    throw error;
  }
}

// Realtime speech is deliberately provider-only here. Its authorization,
// idempotency, consent checks and character-priced accounting live in the
// Realtime lease ledger so this call cannot create a second cost reservation.
export async function synthesizeRealtimeControlledSpeech({ env, config, text }) {
  const input = String(text || '');
  if (!input || input !== input.trim() || input.length > 2_400) {
    throw new ConsumerError(400, 'realtime_speech_text_invalid', 'The approved spoken response is invalid.');
  }
  const providerKey = requireProviderKey(env);
  const { response, body, contentLength } = await providerFetchStream(config, 'https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${providerKey}`,
      'Content-Type': 'application/json',
      'X-Client-Request-Id': crypto.randomUUID()
    },
    body: JSON.stringify({
      model: config.realtimeSpeechModel,
      voice: config.realtimeSpeechVoice,
      input,
      response_format: 'mp3'
    })
  }, {
    maximumBytes: MAX_SPEECH_RESPONSE_BYTES,
    acceptsContentType: (value) => String(value || '').toLowerCase().startsWith('audio/'),
    invalidResponse: () => new ConsumerError(
      502,
      'realtime_speech_invalid',
      'The approved spoken response was incomplete. Continue with the visible caption.'
    )
  });
  const providerRequestId = safeProviderRequestId(response.headers.get('x-request-id'));
  if (!response.ok) {
    console.error('Consumer controlled Realtime speech provider request failed', {
      status: response.status,
      providerRequestId
    });
    const error = new ConsumerError(
      502,
      'realtime_speech_failed',
      'The approved spoken response could not be played. Continue with the visible caption.'
    );
    error.providerRequestId = providerRequestId;
    throw error;
  }
  return {
    audioStream: body,
    contentLength,
    contentType: String(response.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim(),
    providerRequestId
  };
}
