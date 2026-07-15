import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deleteSessionData,
  getConsumerProviderBudget,
  markConsumerProviderCostInFlight,
  releaseConsumerProviderCostNotSent,
  reserveConsumerProviderCost,
  settleConsumerProviderCostUnknown
} from '../worker/src/consumer/repository.js';
import {
  getVoiceConsent,
  setVoiceConsent,
  toPublicVoiceConsent,
  voiceConsentIsCurrent
} from '../worker/src/consumer/voice_repository.js';
import {
  speakConsumerQuestion,
  transcribeConsumerVoice
} from '../worker/src/consumer/voice_provider.js';

const PYTHON_SQLITE = String.raw`
import json
import sqlite3
import sys

database_path, mode = sys.argv[1], sys.argv[2]
payload = json.load(sys.stdin)
connection = sqlite3.connect(database_path)
connection.row_factory = sqlite3.Row
connection.execute('PRAGMA foreign_keys = ON')
try:
    if mode == 'script':
        connection.executescript(payload['sql'])
        connection.commit()
        result = {}
    elif mode == 'batch':
        connection.execute('BEGIN IMMEDIATE')
        result = []
        for item in payload['statements']:
            cursor = connection.execute(item['sql'], item['values'])
            result.append({'meta': {'changes': max(0, cursor.rowcount)}})
        connection.commit()
    else:
        cursor = connection.execute(payload['sql'], payload.get('values', []))
        if mode == 'first':
            row = cursor.fetchone()
            result = dict(row) if row is not None else None
        elif mode == 'all':
            result = {'results': [dict(row) for row in cursor.fetchall()]}
        elif mode == 'run':
            result = {'meta': {'changes': max(0, cursor.rowcount)}}
        else:
            raise ValueError('Unsupported sqlite test mode')
        connection.commit()
    print(json.dumps(result, separators=(',', ':')))
except Exception:
    connection.rollback()
    raise
finally:
    connection.close()
`;

function sqliteCommand(databasePath, mode, payload) {
  const result = spawnSync('python3', ['-c', PYTHON_SQLITE, databasePath, mode], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `Python sqlite test command failed with ${result.status}.`);
  }
  return JSON.parse(result.stdout || 'null');
}

class TestD1Statement {
  constructor(databasePath, sql, values = []) {
    this.databasePath = databasePath;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new TestD1Statement(this.databasePath, this.sql, values);
  }

  async first() {
    return sqliteCommand(this.databasePath, 'first', { sql: this.sql, values: this.values });
  }

  async all() {
    return sqliteCommand(this.databasePath, 'all', { sql: this.sql, values: this.values });
  }

  async run() {
    return sqliteCommand(this.databasePath, 'run', { sql: this.sql, values: this.values });
  }
}

class TestD1 {
  constructor(databasePath) {
    this.databasePath = databasePath;
  }

  prepare(sql) {
    return new TestD1Statement(this.databasePath, sql);
  }

  async batch(statements) {
    return sqliteCommand(this.databasePath, 'batch', {
      statements: statements.map((statement) => ({ sql: statement.sql, values: statement.values }))
    });
  }
}

const root = fileURLToPath(new URL('..', import.meta.url));
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'consumer-voice-'));
const databasePath = join(temporaryDirectory, 'consumer.sqlite');
process.once('exit', () => rmSync(temporaryDirectory, { recursive: true, force: true }));
const migrationSql = [
  'worker/consumer-migrations/0001_create_consumer_journey.sql',
  'worker/consumer-migrations/0002_add_consumer_provider_budget.sql',
  'worker/consumer-migrations/0003_add_consumer_voice_consent.sql',
  'worker/consumer-migrations/0004_add_consumer_voice_dispatch_and_events.sql',
  'worker/consumer-migrations/0005_add_consumer_realtime_voice.sql',
  'worker/consumer-migrations/0006_encrypt_realtime_plan_display.sql',
  'worker/consumer-migrations/0007_add_realtime_control_inbox.sql'
].map((migration) => readFileSync(`${root}/${migration}`, 'utf8')).join('\n');
sqliteCommand(databasePath, 'script', { sql: `PRAGMA foreign_keys = ON;\n${migrationSql}` });

const env = {
  CONSUMER_DB: new TestD1(databasePath),
  OPENAI_API_KEY: 'server-test-key-never-exposed'
};
const config = Object.freeze({
  voiceNoticeId: 'voice-adviser-test-v1',
  voiceDataPolicyId: 'openai-audio-adviser-test-v1',
  consentPolicyVersion: 'consumer-adviser-test-v1',
  privacyNoticeUrl: 'https://planeir.ie/plan/privacy.html',
  voiceTranscriptionModel: 'gpt-4o-mini-transcribe',
  voiceSpeechModel: 'tts-1-hd',
  voiceName: 'nova',
  voicePricingVersion: 'openai-audio-eur-safety-2026-07-13-v2',
  voiceSessionBudgetMicroEur: 2_000_000,
  voiceDailyBudgetMicroEur: 20_000_000,
  voiceTranscriptionReservationMicroEur: 100_000,
  voiceSpeechReservationMicroEur: 100_000,
  voiceTimeoutMs: 2_000,
  voiceMaxAudioBytes: 1_000_000,
  voiceMaxDurationSeconds: 45,
  voiceMaxSpeechCharacters: 1_200,
  maxMessageLength: 4_000
});

function insertSession(id, limitMicroEur = 2_000_000) {
  sqliteCommand(databasePath, 'run', {
    sql: `
      INSERT INTO consumer_sessions (
        id, credential_hash_b64u, consent_analysis, consent_ai_processing,
        consent_adult_confirmed, consent_education_only, consent_manifest_id,
        consent_policy_version, consent_analysis_notice_id, consent_ai_notice_id,
        consent_privacy_notice_url, consent_captured_at, created_at, last_active_at,
        expires_at, provider_cost_limit_eur_micros
      ) VALUES (?, ?, 1, 0, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    values: [
      id,
      `hash_${id}`,
      'consumer-adviser-test-manifest-v1',
      config.consentPolicyVersion,
      'analysis-adviser-test-v1',
      'ai-adviser-test-v1',
      config.privacyNoticeUrl,
      '2026-07-13T12:00:00.000Z',
      '2026-07-13T12:00:00.000Z',
      '2026-07-13T12:00:00.000Z',
      '2026-07-20T12:00:00.000Z',
      limitMicroEur
    ]
  });
  return { id };
}

function transcriptionRequest(idempotencyKey, transcriptBytes = 'test-audio', options = {}) {
  const type = options.type || 'audio/webm;codecs=opus';
  const headers = new Headers({
    'Content-Type': type,
    'X-Voice-Duration-Ms': String(options.durationMs ?? 1200),
    'X-Voice-Request-Id': idempotencyKey
  });
  if (options.omitDuration) headers.delete('X-Voice-Duration-Ms');
  if (options.omitRequestId) headers.delete('X-Voice-Request-Id');
  if (options.declaredLength !== undefined) {
    headers.set('Content-Length', String(options.declaredLength));
  }
  const chunks = Array.isArray(options.streamChunks) ? options.streamChunks : null;
  const body = chunks
    ? new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        }
      })
    : new Blob([transcriptBytes], { type });
  return new Request('https://worker.test/api/consumer/voice/transcriptions', {
    method: 'POST',
    headers,
    body,
    ...(chunks ? { duplex: 'half' } : {})
  });
}

const sessionRow = insertSession('cs_voice_provider_contract');
const granted = await setVoiceConsent(env, sessionRow, config, true);
assert.equal(voiceConsentIsCurrent(granted, config), true);
assert.equal(toPublicVoiceConsent(granted).granted, true);
const withdrawn = await setVoiceConsent(env, sessionRow, {}, false);
assert.equal(toPublicVoiceConsent(withdrawn).granted, false);
assert.equal(voiceConsentIsCurrent(withdrawn, config), false);
await setVoiceConsent(env, sessionRow, config, true);
assert.equal(voiceConsentIsCurrent(await getVoiceConsent(env, sessionRow.id), config), true);
await setVoiceConsent(env, sessionRow, config, true);
const consentEvents = sqliteCommand(databasePath, 'all', {
  sql: `
    SELECT action, notice_id, data_policy_id, policy_version, privacy_notice_url
    FROM consumer_voice_consent_events
    WHERE session_id = ?
    ORDER BY rowid
  `,
  values: [sessionRow.id]
}).results;
assert.deepEqual(consentEvents.map((event) => event.action), ['granted', 'withdrawn', 'granted']);
assert.ok(consentEvents.every((event) => event.notice_id === config.voiceNoticeId));
assert.ok(consentEvents.every((event) => event.data_policy_id === config.voiceDataPolicyId));
assert.ok(consentEvents.every((event) => event.policy_version === config.consentPolicyVersion));
assert.ok(consentEvents.every((event) => event.privacy_notice_url === config.privacyNoticeUrl));

const invalidUploadSession = insertSession('cs_voice_upload_bounds');
await assert.rejects(() => transcribeConsumerVoice({
  env,
  config,
  sessionRow: invalidUploadSession,
  request: transcriptionRequest('voice-length-missing-0001')
}), (error) => error.status === 403 && error.code === 'voice_consent_required');
await assert.rejects(() => transcribeConsumerVoice({
  env,
  config,
  sessionRow: invalidUploadSession,
  request: transcriptionRequest('voice-length-large-0001', 'test', {
    declaredLength: config.voiceMaxAudioBytes + 1
  })
}), (error) => error.status === 413 && error.code === 'voice_audio_too_large');
await assert.rejects(() => transcribeConsumerVoice({
  env,
  config,
  sessionRow: invalidUploadSession,
  request: transcriptionRequest('voice-stream-large-0001', 'ignored', {
    streamChunks: [new Uint8Array(600_000), new Uint8Array(400_001)]
  })
}), (error) => error.status === 413 && error.code === 'voice_audio_too_large');
await assert.rejects(() => transcribeConsumerVoice({
  env,
  config,
  sessionRow: invalidUploadSession,
  request: transcriptionRequest('voice-type-invalid-0001', 'test', { type: 'application/octet-stream' })
}), (error) => error.status === 400 && error.code === 'voice_audio_type_unsupported');
await assert.rejects(() => transcribeConsumerVoice({
  env,
  config,
  sessionRow: invalidUploadSession,
  request: transcriptionRequest('voice-duration-missing-0001', 'test', { omitDuration: true })
}), (error) => error.status === 400 && error.code === 'voice_duration_invalid');
assert.equal((await getConsumerProviderBudget(env, invalidUploadSession.id)).spentEurMicros, 0);

const raceSession = insertSession('cs_voice_consent_race');
await setVoiceConsent(env, raceSession, config, true);
const reservedBeforeWithdrawal = await reserveConsumerProviderCost(env, {
  sessionId: raceSession.id,
  operation: 'voice_transcription',
  idempotencyKey: 'voice-consent-race-0001',
  provider: 'openai',
  model: config.voiceTranscriptionModel,
  pricingVersion: config.voicePricingVersion,
  reservedCostEurMicros: config.voiceTranscriptionReservationMicroEur,
  dailyCostLimitEurMicros: config.voiceDailyBudgetMicroEur
});
await setVoiceConsent(env, raceSession, config, false);
const deniedTransition = await markConsumerProviderCostInFlight(
  env,
  reservedBeforeWithdrawal.entry.id,
  {
    sessionId: raceSession.id,
    noticeId: config.voiceNoticeId,
    dataPolicyId: config.voiceDataPolicyId,
    policyVersion: config.consentPolicyVersion,
    privacyNoticeUrl: config.privacyNoticeUrl
  }
);
assert.equal(deniedTransition.outcome, 'voice_consent_required');
const releasedBeforeDispatch = await releaseConsumerProviderCostNotSent(
  env,
  reservedBeforeWithdrawal.entry.id,
  { errorCode: 'voice_consent_required' }
);
assert.equal(releasedBeforeDispatch.entry.status, 'not_sent');

await setVoiceConsent(env, raceSession, config, true);
const reservedInFlight = await reserveConsumerProviderCost(env, {
  sessionId: raceSession.id,
  operation: 'voice_speech',
  idempotencyKey: 'voice-consent-race-0002',
  provider: 'openai',
  model: config.voiceSpeechModel,
  pricingVersion: config.voicePricingVersion,
  reservedCostEurMicros: config.voiceSpeechReservationMicroEur,
  dailyCostLimitEurMicros: config.voiceDailyBudgetMicroEur
});
const inFlightTransition = await markConsumerProviderCostInFlight(
  env,
  reservedInFlight.entry.id,
  {
    sessionId: raceSession.id,
    noticeId: config.voiceNoticeId,
    dataPolicyId: config.voiceDataPolicyId,
    policyVersion: config.consentPolicyVersion,
    privacyNoticeUrl: config.privacyNoticeUrl
  }
);
assert.equal(inFlightTransition.outcome, 'in_flight');
assert.equal(inFlightTransition.entry.inFlight, true);
await setVoiceConsent(env, raceSession, config, false);
await assert.rejects(
  releaseConsumerProviderCostNotSent(env, reservedInFlight.entry.id),
  (error) => error.code === 'provider_cost_settlement_conflict'
);
await settleConsumerProviderCostUnknown(env, reservedInFlight.entry.id, {
  errorCode: 'provider_outcome_unknown'
});

const originalFetch = globalThis.fetch;
let providerCallCount = 0;
let capturedSpeechPayload = null;
try {
  globalThis.fetch = async (url, init) => {
    providerCallCount += 1;
    const target = String(url);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${env.OPENAI_API_KEY}`);
    assert.doesNotMatch(JSON.stringify(Object.fromEntries(headers.entries())), /cs_voice_provider_contract/);
    if (target.endsWith('/audio/transcriptions')) {
      assert.equal(init.method, 'POST');
      assert.ok(init.body instanceof FormData);
      assert.equal(init.body.get('model'), config.voiceTranscriptionModel);
      assert.match(String(init.body.get('prompt')), /Do not calculate or answer/);
      assert.equal(init.body.has('sessionId'), false);
      const providerAudio = init.body.get('file');
      assert.ok(providerAudio instanceof Blob);
      assert.equal(providerAudio.type, 'audio/webm');
      assert.equal(providerAudio.size, new TextEncoder().encode('test-audio').byteLength);
      return new Response(JSON.stringify({
        text: 'My PPS is 1234567A and our savings are €50,000.'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'x-request-id': 'req_voice_transcribe_1' }
      });
    }
    if (target.endsWith('/audio/speech')) {
      capturedSpeechPayload = JSON.parse(String(init.body || ''));
      return new Response(new Uint8Array([73, 68, 51, 4, 5, 6]), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg', 'x-request-id': 'req_voice_speech_1' }
      });
    }
    throw new Error(`Unexpected provider URL: ${target}`);
  };

  const transcriptionRequestWithoutLength = transcriptionRequest('voice-transcribe-0001');
  assert.equal(transcriptionRequestWithoutLength.headers.get('content-length'), null);
  const transcription = await transcribeConsumerVoice({
    env,
    config,
    sessionRow,
    request: transcriptionRequestWithoutLength
  });
  assert.match(transcription.transcript, /€50,000/);
  assert.doesNotMatch(transcription.transcript, /1234567A/);
  assert.equal(transcription.sensitiveDetailsRemoved, true);
  assert.deepEqual(transcription.voiceBudget, {
    limitMicroEur: 2_000_000,
    spentMicroEur: 100_000,
    remainingMicroEur: 1_900_000
  });
  const callsAfterTranscription = providerCallCount;
  await assert.rejects(() => transcribeConsumerVoice({
    env,
    config,
    sessionRow,
    request: transcriptionRequest('voice-transcribe-0001')
  }), (error) => error.status === 409 && error.code === 'voice_request_already_used');
  assert.equal(providerCallCount, callsAfterTranscription, 'An idempotent replay must not call the provider twice.');

  const exactQuestion = 'What is your approximate gross annual household income?';
  const speech = await speakConsumerQuestion({
    env,
    config,
    sessionRow,
    idempotencyKey: 'voice-speech-0001',
    text: exactQuestion
  });
  assert.equal(speech.text, exactQuestion);
  assert.equal(speech.audio.byteLength, 6);
  assert.deepEqual(capturedSpeechPayload, {
    model: 'tts-1-hd',
    voice: 'nova',
    input: exactQuestion,
    response_format: 'mp3'
  });
  assert.equal(capturedSpeechPayload.instructions, undefined);
  assert.equal(speech.voiceBudget.spentMicroEur, 200_000);

  globalThis.fetch = async () => {
    providerCallCount += 1;
    return new Response(JSON.stringify({ error: { message: 'not surfaced' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'x-request-id': 'req_voice_failure_1' }
    });
  };
  await assert.rejects(() => transcribeConsumerVoice({
    env,
    config,
    sessionRow,
    request: transcriptionRequest('voice-transcribe-failure-0002')
  }), (error) => error.status === 502 && error.code === 'voice_transcription_failed');
  assert.equal((await getConsumerProviderBudget(env, sessionRow.id)).spentEurMicros, 300_000);

  const boundedResponseSession = insertSession('cs_voice_response_bounds');
  await setVoiceConsent(env, boundedResponseSession, config, true);
  globalThis.fetch = async () => {
    providerCallCount += 1;
    return new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' }
    });
  };
  await assert.rejects(() => speakConsumerQuestion({
    env,
    config,
    sessionRow: boundedResponseSession,
    idempotencyKey: 'voice-response-type-0001',
    text: 'Unknown provider response media types must fail closed.'
  }), (error) => error.status === 502 && error.code === 'voice_speech_invalid');

  globalThis.fetch = async () => {
    providerCallCount += 1;
    return new Response(new Uint8Array([1]), {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': '5000001'
      }
    });
  };
  await assert.rejects(() => speakConsumerQuestion({
    env,
    config,
    sessionRow: boundedResponseSession,
    idempotencyKey: 'voice-response-large-0001',
    text: 'This response declares more bytes than the bounded reader accepts.'
  }), (error) => error.status === 502 && error.code === 'voice_speech_invalid');

  globalThis.fetch = async () => {
    providerCallCount += 1;
    return new Response(new ReadableStream({
      pull() {
        return new Promise(() => {});
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' }
    });
  };
  await assert.rejects(() => speakConsumerQuestion({
    env,
    config: { ...config, voiceTimeoutMs: 25 },
    sessionRow: boundedResponseSession,
    idempotencyKey: 'voice-response-timeout-0002',
    text: 'The timeout must remain active while the provider body is pending.'
  }), (error) => error.status === 504 && error.code === 'voice_provider_timeout');
  assert.equal((await getConsumerProviderBudget(env, boundedResponseSession.id)).spentEurMicros, 300_000);

  const missingKeySession = insertSession('cs_voice_missing_key');
  await assert.rejects(() => transcribeConsumerVoice({
    env: { ...env, OPENAI_API_KEY: '' },
    config,
    sessionRow: missingKeySession,
    request: transcriptionRequest('voice-no-key-0001')
  }), (error) => error.status === 503 && error.code === 'voice_provider_unconfigured');
  assert.equal((await getConsumerProviderBudget(env, missingKeySession.id)).spentEurMicros, 0);

  const cappedSession = insertSession('cs_voice_allowance', 100_000);
  await setVoiceConsent(env, cappedSession, config, true);
  globalThis.fetch = async () => {
    providerCallCount += 1;
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' }
    });
  };
  await speakConsumerQuestion({
    env,
    config,
    sessionRow: cappedSession,
    idempotencyKey: 'voice-cap-speech-0001',
    text: 'First bounded question.'
  });
  const callsAtCap = providerCallCount;
  await assert.rejects(() => speakConsumerQuestion({
    env,
    config,
    sessionRow: cappedSession,
    idempotencyKey: 'voice-cap-speech-0002',
    text: 'This request must be stopped before provider dispatch.'
  }), (error) => error.status === 402 && error.code === 'voice_budget_exceeded');
  assert.equal(providerCallCount, callsAtCap, 'The application allowance must stop provider dispatch.');

  await deleteSessionData(env, raceSession.id);
  assert.equal(sqliteCommand(databasePath, 'first', {
    sql: 'SELECT COUNT(*) AS count FROM consumer_voice_consent_events WHERE session_id = ?',
    values: [raceSession.id]
  }).count, 0);
  assert.equal(sqliteCommand(databasePath, 'first', {
    sql: 'SELECT COUNT(*) AS count FROM consumer_voice_consents WHERE session_id = ?',
    values: [raceSession.id]
  }).count, 0);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Consumer voice consent, provider-boundary, and application-allowance checks passed.');
