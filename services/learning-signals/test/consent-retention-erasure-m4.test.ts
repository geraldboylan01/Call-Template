import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig, type ServiceConfig } from "../src/config.js";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  waitForPostgres,
} from "../src/db/client.js";
import { DailyMetricsJob } from "../src/jobs/daily-metrics.js";
import { RetentionPurgeJob } from "../src/jobs/retention.js";
import { OutboxWorker } from "../src/outbox/worker.js";
import {
  PrivacyDeletionWorker,
} from "../src/privacy/erasure.js";
import { pseudonymizeIdentifier } from "../src/privacy/field-values.js";
import { RecordingSecretsProvider } from "../src/privacy/secrets.js";
import {
  RecordingOtelSpanSink,
  RecordingPostHogSink,
} from "../src/sinks/telemetry-sinks.js";
import { sha256Hex } from "../src/telemetry/canonical-json.js";
import type { Clock } from "../src/telemetry/clock.js";
import {
  consentGate,
  PostgresConsentStateResolver,
  type ConsentAction,
  type ConsentState,
  type ConsentType,
  type EventConsentClassification,
  type ResolvedConsentDecision,
} from "../src/telemetry/consent.js";
import {
  loadEventCatalogRegistry,
  type EventCatalogRegistry,
} from "../src/telemetry/event-catalog.js";

const dayMilliseconds = 24 * 60 * 60 * 1_000;

class FixedClock implements Clock {
  constructor(private readonly value: Date) {}

  now(): Date {
    return new Date(this.value);
  }
}

type SessionSeed = {
  sessionId?: string;
  pseudonymousSubjectId?: string;
  keyVersion?: number;
  createdAt?: Date;
};

type TenantFixture = {
  tenantId: string;
  moduleVersionId: string;
  sessionIds: string[];
  ingestSecret: string;
  adminSecret: string;
};

type ConsentInsert = {
  tenantId: string;
  sessionId: string;
  purpose: ConsentType;
  action: ConsentAction;
  decisionTs: Date;
  receivedAt: Date;
  createdAt?: Date;
};

type SeededEvent = {
  eventId: string;
  outboxId: string | undefined;
};

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

function actionsToConsentState(
  actions: Partial<Record<ConsentType, ConsentAction>>,
): ConsentState {
  const state: Partial<Record<ConsentType, ResolvedConsentDecision>> = {};
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  for (const [consentType, action] of Object.entries(actions) as Array<
    [ConsentType, ConsentAction]
  >) {
    state[consentType] = {
      action,
      decisionTs: timestamp,
      receivedAt: timestamp,
      consentId: randomUUID(),
    };
  }
  return state;
}

async function seedTenant(
  connection: DatabaseConnection,
  options: {
    tenantId?: string;
    sessions?: readonly SessionSeed[];
    retentionDays?: number;
  } = {},
): Promise<TenantFixture> {
  const tenantId = options.tenantId ?? randomUUID();
  const moduleVersionId = randomUUID();
  const ingestSecret = `m4-ingest-${randomUUID()}`;
  const adminSecret = `m4-admin-${randomUUID()}`;
  let retentionPolicyId: string | undefined;

  if (options.retentionDays !== undefined) {
    retentionPolicyId = randomUUID();
    await connection.pool.query(
      `insert into retention_policies (
         retention_policy_id, policy_key, name, session_retention_days,
         event_retention_days, document_retention_days,
         pseudonymous_telemetry_days, operational_payload_days,
         consent_ledger_days
       ) values ($1, $2, 'M4 test retention', $3, $3, $3, $3, $3, $3)`,
      [
        retentionPolicyId,
        `m4-retention-${retentionPolicyId}`,
        options.retentionDays,
      ],
    );
  }

  await connection.pool.query(
    `insert into tenants (
       tenant_id, slug, display_name, retention_policy_id
     ) values (
       $1, $2, 'M4 Tenant',
       coalesce($3::uuid, '00000000-0000-4000-8000-000000000001'::uuid)
     )`,
    [tenantId, `m4-${tenantId}`, retentionPolicyId ?? null],
  );
  await connection.pool.query(
    `insert into module_versions (
       module_version_id, tenant_id, module_id, semantic_version, status,
       module_body_jsonb, content_hash, published_at
     ) values (
       $1, $2, $3, '1.0.0', 'published', '{"sections":[]}'::jsonb, $4, now()
     )`,
    [
      moduleVersionId,
      tenantId,
      randomUUID(),
      sha256Hex(`m4-module:${moduleVersionId}`),
    ],
  );

  const sessionSeeds = options.sessions ?? [{}];
  const sessionIds: string[] = [];
  for (const sessionSeed of sessionSeeds) {
    const sessionId = sessionSeed.sessionId ?? randomUUID();
    sessionIds.push(sessionId);
    await connection.pool.query(
      `insert into fact_find_sessions (
         session_id, tenant_id, module_version_id,
         pseudonymous_subject_id, key_version, created_at
       ) values ($1, $2, $3, $4, $5, coalesce($6, now()))`,
      [
        sessionId,
        tenantId,
        moduleVersionId,
        sessionSeed.pseudonymousSubjectId ??
          sha256Hex(`m4-subject:${sessionId}`),
        sessionSeed.keyVersion ?? 1,
        sessionSeed.createdAt ?? null,
      ],
    );
  }

  await connection.pool.query(
    `insert into api_keys (
       tenant_id, key_hash, scopes, actor_label
     ) values
       ($1, $2, array['ingest']::text[], 'm4-voice-orchestrator'),
       ($1, $3, array['admin']::text[], 'm4-privacy-admin')`,
    [tenantId, sha256Hex(ingestSecret), sha256Hex(adminSecret)],
  );

  return {
    tenantId,
    moduleVersionId,
    sessionIds,
    ingestSecret,
    adminSecret,
  };
}

async function insertConsent(
  connection: DatabaseConnection,
  input: ConsentInsert,
): Promise<string> {
  const consentId = randomUUID();
  await connection.pool.query(
    `insert into consent_ledger (
       consent_id, tenant_id, session_id, purpose, action, policy_version,
       notice_id, evidence_hash, occurred_at, decision_ts, received_at,
       created_at
     ) values (
       $1, $2, $3, $4, $5, 'm4-policy-v1', 'm4-notice-v1', $6,
       $7, $7, $8, coalesce($9, now())
     )`,
    [
      consentId,
      input.tenantId,
      input.sessionId,
      input.purpose,
      input.action,
      sha256Hex(`m4-consent:${consentId}`),
      input.decisionTs,
      input.receivedAt,
      input.createdAt ?? null,
    ],
  );
  return consentId;
}

async function seedSessionEvent(
  connection: DatabaseConnection,
  input: {
    tenantId: string;
    sessionId: string;
    createdAt?: Date;
    occurredAt?: Date;
    receivedAt?: Date;
    withOutbox?: boolean;
  },
): Promise<SeededEvent> {
  const eventId = randomUUID();
  const occurredAt = input.occurredAt ?? new Date();
  await connection.pool.query(
    `insert into session_events (
       tenant_id, event_id, session_id, event_type, ingestion_key,
       payload_hash, attrs, occurred_at, turn_index, received_at, created_at
     ) values (
       $1, $2, $3, 'question.prompted', $4, $5,
       '{"question_kind":"income","sequence":1,"retry":false}'::jsonb,
       $6, 1, coalesce($7, now()), coalesce($8, now())
     )`,
    [
      input.tenantId,
      eventId,
      input.sessionId,
      sha256Hex(`${input.tenantId}:${eventId}`),
      sha256Hex(`m4-payload:${eventId}`),
      occurredAt,
      input.receivedAt ?? null,
      input.createdAt ?? null,
    ],
  );

  if (input.withOutbox !== true) {
    return { eventId, outboxId: undefined };
  }
  const outboxId = randomUUID();
  await connection.pool.query(
    `insert into telemetry_outbox (
       outbox_id, tenant_id, event_id, config_version, created_at
     ) values ($1, $2, $3, 'telemetry-events-v3', coalesce($4, now()))`,
    [outboxId, input.tenantId, eventId, input.createdAt ?? null],
  );
  return { eventId, outboxId };
}

function eventEnvelope(
  sessionId: string,
  eventType: string,
  attrs: Record<string, unknown>,
  occurredAt: Date,
): Record<string, unknown> {
  return {
    event_id: randomUUID(),
    session_id: sessionId,
    event_type: eventType,
    attrs,
    occurred_at: occurredAt.toISOString(),
  };
}

describe.sequential("M4 consent, retention, and erasure", () => {
  let config: ServiceConfig;
  let connection: DatabaseConnection;
  let catalogs: EventCatalogRegistry;

  beforeAll(async () => {
    config = loadConfig();
    connection = createDatabaseConnection(config.databaseUrl);
    await waitForPostgres(connection.pool);
    catalogs = loadEventCatalogRegistry();
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  it("enforces the complete consent matrix through one pure gate", () => {
    const noConsent = actionsToConsentState({});
    const service = actionsToConsentState({
      service_improvement_telemetry: "granted",
    });
    const serviceAndPartner = actionsToConsentState({
      service_improvement_telemetry: "granted",
      partner_benchmarking: "granted",
    });
    const demographicsAndPartner = actionsToConsentState({
      optional_demographics: "granted",
      partner_benchmarking: "granted",
    });
    const marketing = actionsToConsentState({
      marketing_referral: "granted",
    });
    const withdrawn = actionsToConsentState({
      service_improvement_telemetry: "withdrawn",
      partner_benchmarking: "granted",
      optional_demographics: "granted",
      marketing_referral: "granted",
    });

    const cases: Array<{
      classification: EventConsentClassification | undefined;
      state: ConsentState;
      expected: {
        persist: boolean;
        forwardPosthog: boolean;
        forwardOtel: boolean;
        includeMetrics: boolean;
        includePartner: boolean;
      };
    }> = [
      {
        classification: "contract_necessity",
        state: noConsent,
        expected: {
          persist: true,
          forwardPosthog: false,
          forwardOtel: false,
          includeMetrics: true,
          includePartner: false,
        },
      },
      {
        classification: "contract_necessity",
        state: service,
        expected: {
          persist: true,
          forwardPosthog: true,
          forwardOtel: true,
          includeMetrics: true,
          includePartner: false,
        },
      },
      {
        classification: "improvement_signal",
        state: noConsent,
        expected: {
          persist: true,
          forwardPosthog: false,
          forwardOtel: false,
          includeMetrics: true,
          includePartner: false,
        },
      },
      {
        classification: "improvement_signal",
        state: serviceAndPartner,
        expected: {
          persist: true,
          forwardPosthog: true,
          forwardOtel: true,
          includeMetrics: true,
          includePartner: true,
        },
      },
      {
        classification: "optional_demographics",
        state: noConsent,
        expected: {
          persist: false,
          forwardPosthog: false,
          forwardOtel: false,
          includeMetrics: false,
          includePartner: false,
        },
      },
      {
        classification: "optional_demographics",
        state: demographicsAndPartner,
        expected: {
          persist: true,
          forwardPosthog: false,
          forwardOtel: false,
          includeMetrics: true,
          includePartner: true,
        },
      },
      {
        classification: "marketing_referral",
        state: noConsent,
        expected: {
          persist: false,
          forwardPosthog: false,
          forwardOtel: false,
          includeMetrics: false,
          includePartner: false,
        },
      },
      {
        classification: "marketing_referral",
        state: marketing,
        expected: {
          persist: true,
          forwardPosthog: false,
          forwardOtel: false,
          includeMetrics: false,
          includePartner: false,
        },
      },
      {
        classification: "consent_control",
        state: noConsent,
        expected: {
          persist: true,
          forwardPosthog: false,
          forwardOtel: false,
          includeMetrics: false,
          includePartner: false,
        },
      },
      {
        classification: "improvement_signal",
        state: withdrawn,
        expected: {
          persist: true,
          forwardPosthog: false,
          forwardOtel: false,
          includeMetrics: false,
          includePartner: false,
        },
      },
      {
        classification: "optional_demographics",
        state: withdrawn,
        expected: {
          persist: false,
          forwardPosthog: false,
          forwardOtel: false,
          includeMetrics: false,
          includePartner: false,
        },
      },
      {
        classification: undefined,
        state: serviceAndPartner,
        expected: {
          persist: false,
          forwardPosthog: false,
          forwardOtel: false,
          includeMetrics: false,
          includePartner: false,
        },
      },
    ];

    for (const testCase of cases) {
      expect(
        consentGate(
          {
            eventType: "m4.matrix.test",
            classification: testCase.classification,
          },
          testCase.state,
        ),
      ).toMatchObject(testCase.expected);
    }
  });

  it("resolves current consent by decision_ts then server received_at", async () => {
    const fixture = await seedTenant(connection);
    const sessionId = fixture.sessionIds[0]!;
    const base = new Date("2026-02-01T12:00:00.000Z");

    await insertConsent(connection, {
      tenantId: fixture.tenantId,
      sessionId,
      purpose: "service_improvement_telemetry",
      action: "granted",
      decisionTs: new Date(base.getTime()),
      receivedAt: new Date(base.getTime() + 30_000),
    });
    const laterDecisionId = await insertConsent(connection, {
      tenantId: fixture.tenantId,
      sessionId,
      purpose: "service_improvement_telemetry",
      action: "denied",
      decisionTs: new Date(base.getTime() + 10_000),
      receivedAt: new Date(base.getTime() + 20_000),
    });
    await insertConsent(connection, {
      tenantId: fixture.tenantId,
      sessionId,
      purpose: "partner_benchmarking",
      action: "denied",
      decisionTs: new Date(base.getTime() + 40_000),
      receivedAt: new Date(base.getTime() + 41_000),
    });
    const laterReceivedId = await insertConsent(connection, {
      tenantId: fixture.tenantId,
      sessionId,
      purpose: "partner_benchmarking",
      action: "granted",
      decisionTs: new Date(base.getTime() + 40_000),
      receivedAt: new Date(base.getTime() + 42_000),
    });

    const client = await connection.pool.connect();
    try {
      const state = await new PostgresConsentStateResolver()
        .resolveCurrentWithClient(client, {
          tenantId: fixture.tenantId,
          sessionId,
        });
      expect(state.service_improvement_telemetry).toMatchObject({
        action: "denied",
        consentId: laterDecisionId,
        decisionTs: new Date(base.getTime() + 10_000),
        receivedAt: new Date(base.getTime() + 20_000),
      });
      expect(state.partner_benchmarking).toMatchObject({
        action: "granted",
        consentId: laterReceivedId,
        decisionTs: new Date(base.getTime() + 40_000),
        receivedAt: new Date(base.getTime() + 42_000),
      });
    } finally {
      client.release();
    }
  });

  it("does not enqueue or exclude for a backdated withdrawal that is not current", async () => {
    const fixture = await seedTenant(connection);
    const sessionId = fixture.sessionIds[0]!;
    const currentDecisionTs = new Date();
    const currentConsentId = await insertConsent(connection, {
      tenantId: fixture.tenantId,
      sessionId,
      purpose: "service_improvement_telemetry",
      action: "granted",
      decisionTs: currentDecisionTs,
      receivedAt: currentDecisionTs,
    });
    await insertConsent(connection, {
      tenantId: fixture.tenantId,
      sessionId,
      purpose: "service_improvement_telemetry",
      action: "withdrawn",
      decisionTs: new Date(currentDecisionTs.getTime() - dayMilliseconds),
      receivedAt: new Date(currentDecisionTs.getTime() + 1_000),
    });

    const client = await connection.pool.connect();
    try {
      const state = await new PostgresConsentStateResolver()
        .resolveCurrentWithClient(client, {
          tenantId: fixture.tenantId,
          sessionId,
        });
      expect(state.service_improvement_telemetry).toMatchObject({
        action: "granted",
        consentId: currentConsentId,
      });
    } finally {
      client.release();
    }

    const sideEffects = await connection.pool.query<{
      queue_count: number;
      exclusion_count: number;
    }>(
      `select
         (select count(*)::integer
          from consent_deletion_queue
          where tenant_id = $1 and session_id = $2) as queue_count,
         (select count(*)::integer
          from subject_metric_exclusions
          where tenant_id = $1) as exclusion_count`,
      [fixture.tenantId, sessionId],
    );
    expect(sideEffects.rows[0]).toEqual({
      queue_count: 0,
      exclusion_count: 0,
    });
  });

  it("persists a contract event under declined service consent but suppresses every sink", async () => {
    const fixture = await seedTenant(connection);
    const sessionId = fixture.sessionIds[0]!;
    const now = new Date();
    const clock = new FixedClock(now);
    await insertConsent(connection, {
      tenantId: fixture.tenantId,
      sessionId,
      purpose: "service_improvement_telemetry",
      action: "denied",
      decisionTs: new Date(now.getTime() - 1_000),
      receivedAt: now,
    });

    const app = buildApp(config, {
      connection,
      catalog: catalogs.current,
      clock,
    });
    await app.ready();
    const event = eventEnvelope(
      sessionId,
      "question.prompted",
      { question_kind: "income", sequence: 1, retry: false },
      now,
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/telemetry/events",
        headers: bearer(fixture.ingestSecret),
        payload: { events: [event] },
      });
      expect(response.statusCode).toBe(207);
      expect(response.json()).toEqual({
        results: [{ event_id: event.event_id, status: "inserted" }],
      });
    } finally {
      await app.close();
    }

    const persisted = await connection.pool.query<{
      outbox_id: string;
      event_count: number;
    }>(
      `select outbox.outbox_id,
              (select count(*)::integer
               from session_events event
               where event.tenant_id = $1 and event.event_id = $2) as event_count
       from telemetry_outbox outbox
       where outbox.tenant_id = $1 and outbox.event_id = $2`,
      [fixture.tenantId, event.event_id],
    );
    expect(persisted.rows[0]?.event_count).toBe(1);

    const posthog = new RecordingPostHogSink();
    const otel = new RecordingOtelSpanSink();
    const worker = new OutboxWorker({
      pool: connection.pool,
      catalogs,
      clock,
      posthog,
      otel,
      retryBaseMilliseconds: 1,
      retryMaxMilliseconds: 10,
    });
    expect(await worker.runOnce(persisted.rows[0]!.outbox_id)).toBe(true);
    expect(posthog.attempts).toEqual([]);
    expect(otel.attempts).toEqual([]);

    const suppressed = await connection.pool.query<{
      suppression_reason: string | null;
      suppressed_at: Date | null;
      processed_at: Date | null;
    }>(
      `select suppression_reason, suppressed_at, processed_at
       from telemetry_outbox where outbox_id = $1`,
      [persisted.rows[0]!.outbox_id],
    );
    expect(suppressed.rows[0]).toMatchObject({
      suppression_reason: "consent_not_granted",
    });
    expect(suppressed.rows[0]?.suppressed_at).toBeInstanceOf(Date);
    expect(suppressed.rows[0]?.processed_at).toBeInstanceOf(Date);
  });

  it("does not persist optional-purpose events without the exact accepted consent", async () => {
    const fixture = await seedTenant(connection, { sessions: [{}, {}] });
    const demographicsSession = fixture.sessionIds[0]!;
    const marketingSession = fixture.sessionIds[1]!;
    const now = new Date();
    const clock = new FixedClock(now);
    await insertConsent(connection, {
      tenantId: fixture.tenantId,
      sessionId: demographicsSession,
      purpose: "marketing_referral",
      action: "granted",
      decisionTs: now,
      receivedAt: now,
    });
    await insertConsent(connection, {
      tenantId: fixture.tenantId,
      sessionId: marketingSession,
      purpose: "optional_demographics",
      action: "granted",
      decisionTs: now,
      receivedAt: now,
    });

    const demographicsWithoutExactConsent = eventEnvelope(
      demographicsSession,
      "demographics.band.recorded",
      { dimension: "age", band: "35_to_44" },
      now,
    );
    const marketingWithoutExactConsent = eventEnvelope(
      marketingSession,
      "marketing.referral.recorded",
      { channel: "adviser", campaign_category: "branded" },
      now,
    );
    const app = buildApp(config, {
      connection,
      catalog: catalogs.current,
      clock,
    });
    await app.ready();
    try {
      const rejected = await app.inject({
        method: "POST",
        url: "/v1/telemetry/events",
        headers: bearer(fixture.ingestSecret),
        payload: {
          events: [
            demographicsWithoutExactConsent,
            marketingWithoutExactConsent,
          ],
        },
      });
      expect(rejected.statusCode).toBe(207);
      expect(
        rejected
          .json()
          .results.map((result: { status: string }) => result.status),
      ).toEqual(["invalid", "invalid"]);

      const persisted = await connection.pool.query<{ count: number }>(
        `select count(*)::integer as count
         from session_events
         where tenant_id = $1 and event_id = any($2::uuid[])`,
        [
          fixture.tenantId,
          [
            demographicsWithoutExactConsent.event_id,
            marketingWithoutExactConsent.event_id,
          ],
        ],
      );
      expect(persisted.rows[0]?.count).toBe(0);

      const exactDemographics = eventEnvelope(
        marketingSession,
        "demographics.band.recorded",
        { dimension: "age", band: "35_to_44" },
        now,
      );
      const exactMarketing = eventEnvelope(
        demographicsSession,
        "marketing.referral.recorded",
        { channel: "adviser", campaign_category: "branded" },
        now,
      );
      const accepted = await app.inject({
        method: "POST",
        url: "/v1/telemetry/events",
        headers: bearer(fixture.ingestSecret),
        payload: { events: [exactDemographics, exactMarketing] },
      });
      expect(
        accepted
          .json()
          .results.map((result: { status: string }) => result.status),
      ).toEqual(["inserted", "inserted"]);
    } finally {
      await app.close();
    }
  });

  it("ingests consent.withdrawn, queues purpose deletion, and excludes the subject from the next metrics run", async () => {
    const fixture = await seedTenant(connection);
    const sessionId = fixture.sessionIds[0]!;
    const now = new Date();
    const clock = new FixedClock(now);
    const metrics = new DailyMetricsJob(connection.pool);
    const window = {
      start: new Date(now.getTime() - 60 * 60 * 1_000),
      end: new Date(now.getTime() + 60 * 60 * 1_000),
      tenantId: fixture.tenantId,
    };
    const app = buildApp(config, {
      connection,
      catalog: catalogs.current,
      clock,
    });
    await app.ready();
    try {
      const signal = eventEnvelope(
        sessionId,
        "question.completed",
        {
          outcome: "answered",
          value_class: "provided",
          duration_bucket: "5_to_15s",
        },
        now,
      );
      const signalResponse = await app.inject({
        method: "POST",
        url: "/v1/telemetry/events",
        headers: bearer(fixture.ingestSecret),
        payload: { events: [signal] },
      });
      expect(signalResponse.json().results[0].status).toBe("inserted");
      expect(await metrics.eligibleSessions(window)).toEqual([
        { tenantId: fixture.tenantId, sessionId },
      ]);

      const withdrawal = eventEnvelope(
        sessionId,
        "consent.withdrawn",
        { consent_type: "service_improvement_telemetry" },
        now,
      );
      const withdrawalResponse = await app.inject({
        method: "POST",
        url: "/v1/telemetry/events",
        headers: bearer(fixture.ingestSecret),
        payload: { events: [withdrawal] },
      });
      expect(withdrawalResponse.statusCode).toBe(207);
      expect(withdrawalResponse.json()).toEqual({
        results: [{ event_id: withdrawal.event_id, status: "inserted" }],
      });
    } finally {
      await app.close();
    }

    const effects = await connection.pool.query<{
      ledger_count: number;
      queue_count: number;
      exclusion_count: number;
      withdrawal_event_count: number;
    }>(
      `select
         (select count(*)::integer from consent_ledger
          where tenant_id = $1 and session_id = $2
            and purpose = 'service_improvement_telemetry'
            and action = 'withdrawn') as ledger_count,
         (select count(*)::integer from consent_deletion_queue
          where tenant_id = $1 and session_id = $2
            and consent_type = 'service_improvement_telemetry'
            and processed_at is null) as queue_count,
         (select count(*)::integer
          from subject_metric_exclusions exclusion
          join fact_find_sessions session
            on session.tenant_id = exclusion.tenant_id
           and session.pseudonymous_subject_id =
               exclusion.pseudonymous_subject_id
           and session.key_version = exclusion.key_version
          where session.tenant_id = $1 and session.session_id = $2) as exclusion_count,
         (select count(*)::integer from session_events
          where tenant_id = $1 and session_id = $2
            and event_type = 'consent.withdrawn') as withdrawal_event_count`,
      [fixture.tenantId, sessionId],
    );
    expect(effects.rows[0]).toEqual({
      ledger_count: 1,
      queue_count: 1,
      exclusion_count: 1,
      withdrawal_event_count: 1,
    });
    expect(await metrics.eligibleSessions(window)).toEqual([]);
    expect(await metrics.runWindow(window)).toEqual([]);
  });

  it("purges over-age rows by created_at and writes per-table and append-only scrub audit evidence", async () => {
    const now = new Date();
    const clock = new FixedClock(now);
    const old = new Date(now.getTime() - 2 * dayMilliseconds);
    const fixture = await seedTenant(connection, {
      retentionDays: 1,
      sessions: [{ createdAt: old }],
    });
    const sessionId = fixture.sessionIds[0]!;
    const event = await seedSessionEvent(connection, {
      tenantId: fixture.tenantId,
      sessionId,
      createdAt: old,
      occurredAt: now,
      receivedAt: now,
      withOutbox: true,
    });
    await insertConsent(connection, {
      tenantId: fixture.tenantId,
      sessionId,
      purpose: "service_improvement_telemetry",
      action: "granted",
      decisionTs: now,
      receivedAt: now,
      createdAt: old,
    });
    await connection.pool.query(
      `insert into provider_usage (
         tenant_id, session_id, provider, model, operation, created_at
       ) values ($1, $2, 'test-provider', 'test-model', 'extract', $3)`,
      [fixture.tenantId, sessionId, old],
    );
    await connection.pool.query(
      `insert into document_events (
         tenant_id, session_id, document_id_hash, document_type, event_type,
         attrs, occurred_at, created_at
       ) values (
         $1, $2, $3, 'fact_find', 'generated', '{}'::jsonb, $4, $5
       )`,
      [
        fixture.tenantId,
        sessionId,
        sha256Hex(`m4-document:${sessionId}`),
        now,
        old,
      ],
    );

    const purge = await new RetentionPurgeJob({
      pool: connection.pool,
      clock,
    }).runOnce();
    const counts = await connection.pool.query<{
      sessions: number;
      events: number;
      outbox: number;
      usage: number;
      consents: number;
      documents: number;
    }>(
      `select
         (select count(*)::integer from fact_find_sessions
          where tenant_id = $1 and session_id = $2) as sessions,
         (select count(*)::integer from session_events
          where tenant_id = $1 and event_id = $3) as events,
         (select count(*)::integer from telemetry_outbox
          where tenant_id = $1 and event_id = $3) as outbox,
         (select count(*)::integer from provider_usage
          where tenant_id = $1 and session_id = $2) as usage,
         (select count(*)::integer from consent_ledger
          where tenant_id = $1 and session_id = $2) as consents,
         (select count(*)::integer from document_events
          where tenant_id = $1 and session_id = $2) as documents`,
      [fixture.tenantId, sessionId, event.eventId],
    );
    expect(counts.rows[0]).toEqual({
      sessions: 0,
      events: 0,
      outbox: 0,
      usage: 0,
      consents: 0,
      documents: 0,
    });

    const audits = await connection.pool.query<{
      table_name: string;
      rows_deleted: number;
      cutoff: Date;
    }>(
      `select table_name, rows_deleted::integer as rows_deleted, cutoff
       from retention_purge_audit
       where tenant_id = $1 and run_id = $2`,
      [fixture.tenantId, purge.runId],
    );
    const rowsByTable = Object.fromEntries(
      audits.rows.map((row) => [row.table_name, row.rows_deleted]),
    );
    expect(rowsByTable).toMatchObject({
      telemetry_outbox: 1,
      session_events: 1,
      provider_usage: 1,
      consent_ledger: 1,
      document_events: 1,
      fact_find_sessions: 1,
    });
    expect(audits.rows).toHaveLength(10);
    expect(
      audits.rows.every(
        (row) =>
          row.cutoff.toISOString() ===
          new Date(now.getTime() - dayMilliseconds).toISOString(),
      ),
    ).toBe(true);

    const scrubAudit = await connection.pool.query<{
      event_id: string;
      operation_type: string;
    }>(
      `select event_id, operation_type
       from session_event_scrub_audit
       where tenant_id = $1 and operation_id = $2`,
      [fixture.tenantId, purge.runId],
    );
    expect(scrubAudit.rows).toEqual([
      { event_id: event.eventId, operation_type: "retention" },
    ]);
  });

  it("erases matches across two key versions, audits local scrubbing, and completes asynchronous sink deletion", async () => {
    const rawSubjectIdentifier = `M4-subject-${randomUUID()}@example.test`;
    const tenantId = randomUUID();
    const keyV1 = new Uint8Array(32).fill(17);
    const keyV2 = new Uint8Array(32).fill(29);
    const sessionV1 = randomUUID();
    const sessionV2 = randomUUID();
    const fixture = await seedTenant(connection, {
      tenantId,
      sessions: [
        {
          sessionId: sessionV1,
          pseudonymousSubjectId: pseudonymizeIdentifier(
            rawSubjectIdentifier,
            keyV1,
          ),
          keyVersion: 1,
        },
        {
          sessionId: sessionV2,
          pseudonymousSubjectId: pseudonymizeIdentifier(
            rawSubjectIdentifier,
            keyV2,
          ),
          keyVersion: 2,
        },
      ],
    });
    const now = new Date();
    const clock = new FixedClock(now);
    const secrets = new RecordingSecretsProvider();
    secrets.setTenantKey(tenantId, 1, keyV1, false);
    secrets.setTenantKey(tenantId, 2, keyV2, true);
    const eventIds: string[] = [];

    for (const [index, sessionId] of fixture.sessionIds.entries()) {
      const keyVersion = index + 1;
      const seededEvent = await seedSessionEvent(connection, {
        tenantId,
        sessionId,
        withOutbox: true,
      });
      eventIds.push(seededEvent.eventId);
      await connection.pool.query(
        `insert into provider_usage (
           tenant_id, session_id, provider, model, operation
         ) values ($1, $2, 'test-provider', 'test-model', 'extract')`,
        [tenantId, sessionId],
      );
      const extractionId = randomUUID();
      await connection.pool.query(
        `insert into field_extractions (
           extraction_id, tenant_id, session_id, field_path, value_class,
           normalized_value_hash, key_version, extraction_status,
           field_policy_version
         ) values (
           $1, $2, $3, 'client.identifier', 'identifier', $4, $5,
           'extracted', 'field-policy-v1'
         )`,
        [
          extractionId,
          tenantId,
          sessionId,
          sha256Hex(`m4-extraction:${extractionId}`),
          keyVersion,
        ],
      );
      await connection.pool.query(
        `insert into adviser_corrections (
           tenant_id, session_id, extraction_id, idempotency_key,
           payload_hash, before_hash, after_hash, actor_id_pseudo,
           key_version, field_policy_version, reviewer_role, reason_code
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           'field-policy-v1', 'corrections', 'incorrect_value'
         )`,
        [
          tenantId,
          sessionId,
          extractionId,
          `m4-erasure-${randomUUID()}`,
          sha256Hex(`m4-correction-payload:${extractionId}`),
          sha256Hex(`m4-before:${extractionId}`),
          sha256Hex(`m4-after:${extractionId}`),
          sha256Hex(`m4-actor:${extractionId}`),
          keyVersion,
        ],
      );
      await connection.pool.query(
        `insert into document_events (
           tenant_id, session_id, document_id_hash, document_type,
           event_type, occurred_at
         ) values ($1, $2, $3, 'fact_find', 'generated', $4)`,
        [
          tenantId,
          sessionId,
          sha256Hex(`m4-document:${sessionId}`),
          now,
        ],
      );
      await insertConsent(connection, {
        tenantId,
        sessionId,
        purpose:
          index === 0
            ? "service_improvement_telemetry"
            : "partner_benchmarking",
        action: index === 0 ? "withdrawn" : "granted",
        decisionTs: now,
        receivedAt: now,
      });
    }

    const app: FastifyInstance = buildApp(config, {
      connection,
      catalog: catalogs.current,
      clock,
      secretsProvider: secrets,
    });
    await app.ready();
    let requestId: string;
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/subjects/erasure-requests",
        headers: bearer(fixture.adminSecret),
        payload: { subject_identifier: rawSubjectIdentifier },
      });
      expect(response.statusCode).toBe(202);
      const responseBody = response.json() as {
        erasure_request_id: string;
        status: string;
      };
      expect(responseBody.status).toBe("local_completed");
      requestId = responseBody.erasure_request_id;
    } finally {
      await app.close();
    }

    expect(secrets.requests).toEqual([
      { tenantId, keyVersion: "retained" },
      { tenantId, keyVersion: "current" },
    ]);
    const localCounts = await connection.pool.query<{
      sessions: number;
      events: number;
      telemetry_outbox: number;
      usage: number;
      extractions: number;
      corrections: number;
      consents: number;
      documents: number;
      consent_deletions: number;
      metric_exclusions: number;
    }>(
      `select
         (select count(*)::integer from fact_find_sessions
          where tenant_id = $1 and session_id = any($2::uuid[])) as sessions,
         (select count(*)::integer from session_events
          where tenant_id = $1 and session_id = any($2::uuid[])) as events,
         (select count(*)::integer from telemetry_outbox outbox
          where outbox.tenant_id = $1
            and outbox.event_id = any($3::uuid[])) as telemetry_outbox,
         (select count(*)::integer from provider_usage
          where tenant_id = $1 and session_id = any($2::uuid[])) as usage,
         (select count(*)::integer from field_extractions
          where tenant_id = $1 and session_id = any($2::uuid[])) as extractions,
         (select count(*)::integer from adviser_corrections
          where tenant_id = $1 and session_id = any($2::uuid[])) as corrections,
         (select count(*)::integer from consent_ledger
          where tenant_id = $1 and session_id = any($2::uuid[])) as consents,
         (select count(*)::integer from document_events
          where tenant_id = $1 and session_id = any($2::uuid[])) as documents,
         (select count(*)::integer from consent_deletion_queue
          where tenant_id = $1 and session_id = any($2::uuid[])) as consent_deletions,
         (select count(*)::integer from subject_metric_exclusions
          where tenant_id = $1) as metric_exclusions`,
      [tenantId, fixture.sessionIds, eventIds],
    );
    expect(localCounts.rows[0]).toEqual({
      sessions: 0,
      events: 0,
      telemetry_outbox: 0,
      usage: 0,
      extractions: 0,
      corrections: 0,
      consents: 0,
      documents: 0,
      consent_deletions: 0,
      metric_exclusions: 0,
    });

    const erasureAudit = await connection.pool.query<{
      key_version: number;
      key_versions_checked: number[];
      matched_sessions: number;
      status: string;
      requested_by_actor_pseudo: string;
      local_completed_at: Date | null;
      completed_at: Date | null;
    }>(
      `select key_version, key_versions_checked, matched_sessions, status,
              requested_by_actor_pseudo, local_completed_at, completed_at
       from erasure_requests
       where tenant_id = $1 and request_id = $2`,
      [tenantId, requestId],
    );
    expect(erasureAudit.rows[0]).toMatchObject({
      key_version: 2,
      key_versions_checked: [1, 2],
      matched_sessions: 2,
      status: "local_completed",
      completed_at: null,
    });
    expect(erasureAudit.rows[0]?.requested_by_actor_pseudo).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(erasureAudit.rows[0]?.local_completed_at).toBeInstanceOf(Date);

    const scrubAudit = await connection.pool.query<{
      event_id: string;
      operation_type: string;
    }>(
      `select event_id, operation_type
       from session_event_scrub_audit
       where tenant_id = $1 and operation_id = $2
       order by event_id`,
      [tenantId, requestId],
    );
    expect(scrubAudit.rows).toEqual(
      eventIds
        .toSorted()
        .map((eventId) => ({ event_id: eventId, operation_type: "erasure" })),
    );

    const deletionOutbox = await connection.pool.query<{
      outbox_id: string;
      sink: "analytics" | "traces";
      external_subject_ids: string[];
      external_subject_key_versions: number[];
      session_ids: string[];
    }>(
      `select outbox_id, sink, external_subject_ids,
              external_subject_key_versions, session_ids
       from privacy_deletion_outbox
       where tenant_id = $1 and request_id = $2
       order by sink`,
      [tenantId, requestId],
    );
    expect(deletionOutbox.rows.map((row) => row.sink)).toEqual([
      "analytics",
      "traces",
    ]);
    for (const row of deletionOutbox.rows) {
      expect(row.external_subject_ids).toHaveLength(2);
      expect(row.external_subject_ids.every((value) => /^[0-9a-f]{64}$/.test(value)))
        .toBe(true);
      expect(row.external_subject_key_versions).toEqual([1, 2]);
      expect(row.session_ids.toSorted()).toEqual(fixture.sessionIds.toSorted());
      expect(JSON.stringify(row)).not.toContain(rawSubjectIdentifier);
    }

    const analytics = new RecordingPostHogSink();
    const traces = new RecordingOtelSpanSink();
    const deletionWorker = new PrivacyDeletionWorker({
      pool: connection.pool,
      clock,
      analytics,
      traces,
      retryBaseMilliseconds: 1,
      retryMaxMilliseconds: 10,
    });
    for (const row of deletionOutbox.rows) {
      expect(await deletionWorker.runOnce(row.outbox_id)).toBe(true);
    }
    expect(analytics.deletionSuccesses).toHaveLength(1);
    expect(traces.deletionSuccesses).toHaveLength(1);
    for (const deletion of [
      analytics.deletionSuccesses[0]!,
      traces.deletionSuccesses[0]!,
    ]) {
      expect(deletion.tenantId).toBe(tenantId);
      expect(deletion.externalSubjectIds).toHaveLength(2);
      expect(deletion.externalSubjectKeyVersions).toEqual([1, 2]);
      expect(deletion.sessionIds.toSorted()).toEqual(fixture.sessionIds.toSorted());
      expect(JSON.stringify(deletion)).not.toContain(rawSubjectIdentifier);
    }

    const completion = await connection.pool.query<{
      status: string;
      completed_at: Date | null;
      pending_deletions: number;
      retained_identifiers: number;
    }>(
      `select request.status, request.completed_at,
              (select count(*)::integer
               from privacy_deletion_outbox deletion
               where deletion.request_id = request.request_id
                 and deletion.processed_at is null) as pending_deletions,
              (select coalesce(sum(
                 cardinality(deletion.external_subject_ids) +
                 cardinality(deletion.session_ids)
               ), 0)::integer
               from privacy_deletion_outbox deletion
               where deletion.request_id = request.request_id) as retained_identifiers
       from erasure_requests request
       where request.tenant_id = $1 and request.request_id = $2`,
      [tenantId, requestId],
    );
    expect(completion.rows[0]).toMatchObject({
      status: "completed",
      pending_deletions: 0,
      retained_identifiers: 0,
    });
    expect(completion.rows[0]?.completed_at).toBeInstanceOf(Date);
  });
});
