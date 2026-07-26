import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  estimateProviderUsageCostEurMicros,
  failClosedEurMicros,
  summarizeProviderBudget
} from '../worker/src/consumer/cost_budget.js';
import {
  createSessionRecord,
  deleteSessionData,
  getConsumerProviderBudget,
  getConsumerProviderDailyBudget,
  markConsumerProviderCostInFlight,
  releaseConsumerProviderCostNotSent,
  reserveConsumerProviderCost,
  settleConsumerProviderCostKnown,
  settleConsumerProviderCostUnknown
} from '../worker/src/consumer/repository.js';

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
      statements: statements.map((statement) => ({
        sql: statement.sql,
        values: statement.values
      }))
    });
  }
}

const root = fileURLToPath(new URL('..', import.meta.url));
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'consumer-cost-budget-'));
const databasePath = join(temporaryDirectory, 'consumer.sqlite');
process.once('exit', () => rmSync(temporaryDirectory, { recursive: true, force: true }));
const migrationSql = [
  'worker/consumer-migrations/0001_create_consumer_journey.sql',
  'worker/consumer-migrations/0002_add_consumer_provider_budget.sql',
  'worker/consumer-migrations/0003_add_consumer_voice_consent.sql',
  'worker/consumer-migrations/0004_add_consumer_voice_dispatch_and_events.sql',
  'worker/consumer-migrations/0005_add_consumer_realtime_voice.sql',
  'worker/consumer-migrations/0006_encrypt_realtime_plan_display.sql',
  'worker/consumer-migrations/0007_add_realtime_control_inbox.sql',
  'worker/consumer-migrations/0009_add_realtime_consent_purposes.sql',
  'worker/consumer-migrations/0011_add_realtime_meeting_briefs.sql',
  'worker/consumer-migrations/0012_add_realtime_planner_usage.sql',
  'worker/consumer-migrations/0013_complete_realtime_voice_meetings.sql',
  'worker/consumer-migrations/0014_add_agent_test_meetings.sql'
].map((migration) => readFileSync(`${root}/${migration}`, 'utf8')).join('\n');
sqliteCommand(databasePath, 'script', { sql: `PRAGMA foreign_keys = ON;\n${migrationSql}` });
const env = {
  CONSUMER_DB: new TestD1(databasePath),
  CONSUMER_DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url')
};
const voiceConsentContract = Object.freeze({
  noticeId: 'voice-cost-test-v1',
  dataPolicyId: 'voice-cost-policy-v1',
  policyVersion: 'voice-cost-consent-v1',
  privacyNoticeUrl: 'https://example.test/privacy'
});

function insertSession(id, providerCostLimitEurMicros = undefined) {
  const columns = [
    'id', 'credential_hash_b64u', 'consent_analysis', 'consent_ai_processing',
    'consent_adult_confirmed', 'consent_education_only', 'consent_manifest_id',
    'consent_policy_version', 'consent_analysis_notice_id', 'consent_ai_notice_id',
    'consent_privacy_notice_url', 'consent_captured_at', 'created_at',
    'last_active_at', 'expires_at'
  ];
  const values = [
    id, `hash_${id}`, 1, 0, 1, 1, 'manifest_v1', 'policy_v1', 'analysis_v1',
    'ai_v1', 'https://example.test/privacy', '2026-07-13T10:00:00.000Z',
    '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z',
    '2026-07-20T10:00:00.000Z'
  ];
  if (providerCostLimitEurMicros !== undefined) {
    columns.push('provider_cost_limit_eur_micros');
    values.push(providerCostLimitEurMicros);
  }
  const placeholders = values.map(() => '?').join(', ');
  sqliteCommand(databasePath, 'run', {
    sql: `INSERT INTO consumer_sessions (${columns.join(', ')}) VALUES (${placeholders})`,
    values
  });
}

function reservation(sessionId, idempotencyKey, reservedCostEurMicros, dailyCostLimitEurMicros) {
  return reserveConsumerProviderCost(env, {
    sessionId,
    operation: 'voice.transcribe',
    idempotencyKey,
    provider: 'openai',
    model: 'gpt-4o-mini-transcribe',
    pricingVersion: 'test-v1',
    reservedCostEurMicros,
    dailyCostLimitEurMicros
  });
}

assert.equal(failClosedEurMicros(undefined), 0);
assert.equal(failClosedEurMicros(2_000_000), 2_000_000);
assert.equal(failClosedEurMicros(1.5), 0);
assert.equal(estimateProviderUsageCostEurMicros([
  { quantity: 1_000_000, rateEurMicrosPerMillionUnits: 10_000 }
]), 10_000);
assert.equal(estimateProviderUsageCostEurMicros([
  { quantity: 1_000_000, rateEurMicrosPerMillionUnits: 10_000 }
], { safetyMarginBps: 1_000 }), 11_000);
assert.deepEqual(
  summarizeProviderBudget(1_000_000, [
    { status: 'reserved', reservedCostEurMicros: 100_000 },
    { status: 'unknown', reservedCostEurMicros: 200_000 },
    { status: 'not_sent', reservedCostEurMicros: 300_000 },
    { status: 'known', reservedCostEurMicros: 100_000, actualCostEurMicros: 50_000 }
  ]),
  {
    currency: 'EUR',
    unit: 'micro-euro',
    limitEurMicros: 1_000_000,
    spentEurMicros: 350_000,
    knownActualEurMicros: 50_000,
    reservedOrUnknownEurMicros: 300_000,
    releasedEurMicros: 300_000,
    remainingEurMicros: 650_000,
    overLimitEurMicros: 0,
    exhausted: false,
    failClosed: false
  }
);

await createSessionRecord(
  env,
  {
    id: 'cs_created_session_for_budget',
    credentialHashB64u: 'credential_hash'
  },
  {
    aiProcessing: false,
    manifestId: 'manifest_v1',
    policyVersion: 'policy_v1',
    analysisNoticeId: 'analysis_v1',
    aiNoticeId: 'ai_v1',
    privacyNoticeUrl: 'https://example.test/privacy'
  },
  {
    cohort: 'adviser_test',
    sessionTtlDays: 7,
    providerCostLimitEurMicros: 2_000_000
  }
);
assert.equal(
  sqliteCommand(databasePath, 'first', {
    sql: 'SELECT provider_cost_limit_eur_micros AS value FROM consumer_sessions WHERE id = ?',
    values: ['cs_created_session_for_budget']
  }).value,
  2_000_000
);
await createSessionRecord(
  env,
  {
    id: 'cs_created_session_failclosed',
    credentialHashB64u: 'credential_hash_failclosed'
  },
  {
    aiProcessing: false,
    manifestId: 'manifest_v1',
    policyVersion: 'policy_v1',
    analysisNoticeId: 'analysis_v1',
    aiNoticeId: 'ai_v1',
    privacyNoticeUrl: 'https://example.test/privacy'
  },
  { cohort: 'adviser_test', sessionTtlDays: 7 }
);
assert.equal(
  sqliteCommand(databasePath, 'first', {
    sql: 'SELECT provider_cost_limit_eur_micros AS value FROM consumer_sessions WHERE id = ?',
    values: ['cs_created_session_failclosed']
  }).value,
  0
);
assert.equal(
  (await reservation('cs_created_session_for_budget', 'daily-closed-key-0001', 1, undefined)).reason,
  'daily_budget_unavailable'
);

insertSession('cs_legacy');
const legacyBudget = await getConsumerProviderBudget(env, 'cs_legacy');
assert.equal(legacyBudget.limitEurMicros, 0);
assert.equal(legacyBudget.failClosed, true);
assert.equal((await reservation('cs_legacy', 'legacy-key-0001', 1, 5_000_000)).outcome, 'denied');

insertSession('cs_unique_tuple', 1_000_000);
const uniqueFirst = await reservation('cs_unique_tuple', 'shared-operation-key', 10_000, 3_000_000);
const uniqueSecond = await reserveConsumerProviderCost(env, {
  sessionId: 'cs_unique_tuple',
  operation: 'voice.speech',
  idempotencyKey: 'shared-operation-key',
  provider: 'openai',
  model: 'tts-1-hd',
  pricingVersion: 'test-v1',
  reservedCostEurMicros: 10_000,
  dailyCostLimitEurMicros: 3_000_000
});
assert.equal(uniqueFirst.outcome, 'reserved');
assert.equal(uniqueSecond.outcome, 'reserved');
assert.notEqual(uniqueFirst.entry.id, uniqueSecond.entry.id);
await releaseConsumerProviderCostNotSent(env, uniqueFirst.entry.id);
await releaseConsumerProviderCostNotSent(env, uniqueSecond.entry.id);

insertSession('cs_primary', 2_000_000);
const first = await reservation('cs_primary', 'primary-key-0001', 1_200_000, 3_000_000);
assert.equal(first.outcome, 'reserved');
assert.equal(first.status, 'reserved');
assert.equal(first.sessionBudget.remainingEurMicros, 800_000);
const duplicate = await reservation('cs_primary', 'primary-key-0001', 1_200_000, 3_000_000);
assert.equal(duplicate.outcome, 'existing');
assert.equal(duplicate.existing, true);
assert.equal(duplicate.entry.id, first.entry.id);
await assert.rejects(
  reservation('cs_primary', 'primary-key-0001', 1_100_000, 3_000_000),
  (error) => error?.code === 'provider_cost_idempotency_conflict'
);
const sessionDenied = await reservation('cs_primary', 'primary-key-0002', 900_000, 3_000_000);
assert.equal(sessionDenied.reason, 'session_budget_exceeded');
assert.equal(sessionDenied.denied, true);

insertSession('cs_daily', 2_000_000);
const dailyDenied = await reservation('cs_daily', 'daily-key-0001', 400_000, 1_500_000);
assert.equal(dailyDenied.reason, 'daily_budget_exceeded');

const released = await releaseConsumerProviderCostNotSent(env, first.entry.id, {
  errorCode: 'request_not_sent'
});
assert.equal(released.entry.status, 'not_sent');
assert.equal(released.sessionBudget.spentEurMicros, 0);
assert.equal((await releaseConsumerProviderCostNotSent(env, first.entry.id)).changed, false);

const unknownReservation = await reservation('cs_primary', 'primary-key-0003', 1_500_000, 3_000_000);
sqliteCommand(databasePath, 'run', {
  sql: `
    INSERT INTO consumer_voice_consents (
      session_id, granted, notice_id, data_policy_id, policy_version,
      privacy_notice_url, captured_at, withdrawn_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, NULL, ?)
  `,
  values: [
    'cs_primary',
    voiceConsentContract.noticeId,
    voiceConsentContract.dataPolicyId,
    voiceConsentContract.policyVersion,
    voiceConsentContract.privacyNoticeUrl,
    '2026-07-13T10:00:00.000Z',
    '2026-07-13T10:00:00.000Z'
  ]
});
const inFlight = await markConsumerProviderCostInFlight(
  env,
  unknownReservation.entry.id,
  { sessionId: 'cs_primary', ...voiceConsentContract }
);
assert.equal(inFlight.outcome, 'in_flight');
assert.equal(inFlight.entry.inFlight, true);
await assert.rejects(
  releaseConsumerProviderCostNotSent(env, unknownReservation.entry.id),
  (error) => error?.code === 'provider_cost_settlement_conflict'
);
const unknown = await settleConsumerProviderCostUnknown(env, unknownReservation.entry.id, {
  errorCode: 'provider_outcome_unknown'
});
assert.equal(unknown.entry.status, 'unknown');
assert.equal(unknown.sessionBudget.spentEurMicros, 1_500_000);

const known = await settleConsumerProviderCostKnown(env, unknown.entry.id, 1_600_000);
assert.equal(known.entry.status, 'known');
assert.equal(known.entry.chargedCostEurMicros, 1_600_000);
assert.equal(known.overReservationEurMicros, 100_000);
assert.equal(known.sessionBudget.remainingEurMicros, 400_000);
await assert.rejects(
  releaseConsumerProviderCostNotSent(env, known.entry.id),
  (error) => error?.code === 'provider_cost_settlement_conflict'
);

await deleteSessionData(env, 'cs_primary');
assert.equal(sqliteCommand(databasePath, 'first', {
  sql: 'SELECT COUNT(*) AS count FROM consumer_provider_costs WHERE session_id = ?',
  values: ['cs_primary']
}).count, 0);
assert.equal(sqliteCommand(databasePath, 'first', {
  sql: 'SELECT COUNT(*) AS count FROM consumer_sessions WHERE id = ?',
  values: ['cs_primary']
}).count, 0);
const archivedDaily = await getConsumerProviderDailyBudget(env, 2_000_000);
assert.equal(archivedDaily.spentEurMicros, 1_600_000);
insertSession('cs_after_delete', 2_000_000);
const deleteCannotReopenDailyBudget = await reservation(
  'cs_after_delete',
  'after-delete-key-0001',
  500_000,
  2_000_000
);
assert.equal(deleteCannotReopenDailyBudget.reason, 'daily_budget_exceeded');

// An uncertain settlement bounded by the provider-metered estimate no longer
// forfeits the whole reservation: the charge becomes the estimate plus a 50%
// margin with a €0.50 floor, capped at the original reservation.
insertSession('cs_estimate_settlement', 4_000_000);
sqliteCommand(databasePath, 'run', {
  sql: `
    INSERT INTO consumer_voice_consents (
      session_id, granted, notice_id, data_policy_id, policy_version,
      privacy_notice_url, captured_at, withdrawn_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, NULL, ?)
  `,
  values: [
    'cs_estimate_settlement',
    voiceConsentContract.noticeId,
    voiceConsentContract.dataPolicyId,
    voiceConsentContract.policyVersion,
    voiceConsentContract.privacyNoticeUrl,
    '2026-07-13T10:00:00.000Z',
    '2026-07-13T10:00:00.000Z'
  ]
});
const flooredReservation = await reservation('cs_estimate_settlement', 'estimate-key-0001', 1_500_000, 10_000_000);
await markConsumerProviderCostInFlight(
  env,
  flooredReservation.entry.id,
  { sessionId: 'cs_estimate_settlement', ...voiceConsentContract }
);
const floored = await settleConsumerProviderCostUnknown(env, flooredReservation.entry.id, {
  errorCode: 'provider_outcome_unknown',
  estimatedCostEurMicros: 100_000
});
assert.equal(floored.entry.status, 'unknown');
assert.equal(floored.entry.reservedCostEurMicros, 500_000);
assert.equal(floored.entry.chargedCostEurMicros, 500_000);
assert.equal(floored.sessionBudget.spentEurMicros, 500_000);

const marginedReservation = await reservation('cs_estimate_settlement', 'estimate-key-0002', 1_500_000, 10_000_000);
await markConsumerProviderCostInFlight(
  env,
  marginedReservation.entry.id,
  { sessionId: 'cs_estimate_settlement', ...voiceConsentContract }
);
const margined = await settleConsumerProviderCostUnknown(env, marginedReservation.entry.id, {
  errorCode: 'provider_outcome_unknown',
  estimatedCostEurMicros: 900_000
});
assert.equal(margined.entry.status, 'unknown');
assert.equal(margined.entry.chargedCostEurMicros, 1_350_000);
assert.equal(margined.sessionBudget.spentEurMicros, 1_850_000);

console.log('Consumer provider-cost budget checks passed.');
