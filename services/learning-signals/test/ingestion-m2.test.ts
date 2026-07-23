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
import { OutboxWorker } from "../src/outbox/worker.js";
import {
  createTelemetrySinks,
  NoopDlpSink,
  NoopKmsSink,
  NoopLangfuseSink,
  NoopOtelSpanSink,
  NoopPostHogSink,
  otelSpanTimestamps,
  type PostHogSink,
  RecordingDlpSink,
  RecordingKmsSink,
  RecordingLangfuseSink,
  RecordingOtelSpanSink,
  RecordingPostHogSink,
} from "../src/sinks/telemetry-sinks.js";
import { sha256Hex } from "../src/telemetry/canonical-json.js";
import type { Clock } from "../src/telemetry/clock.js";
import {
  EventCatalogRegistry,
  loadEventCatalog,
  type EventCatalog,
} from "../src/telemetry/event-catalog.js";
import { RecordingIngestionMetrics } from "../src/telemetry/metrics.js";

class MutableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  set(value: Date): void {
    this.current = new Date(value);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

type Fixture = {
  tenantA: string;
  tenantB: string;
  moduleA: string;
  moduleB: string;
  sessionA: string;
  sessionB: string;
  ingestSecretA: string;
  ingestSecretB: string;
  adminSecretA: string;
  adminSecretB: string;
  correctionsSecret: string;
  revokedSecret: string;
};

type EventInput = {
  tenant_id?: string;
  event_id: string;
  session_id: string;
  event_type: string;
  attrs: Record<string, unknown>;
  occurred_at: string;
  turn_index?: number | null;
  duration_ms?: number | null;
};

async function seedFixtures(connection: DatabaseConnection): Promise<Fixture> {
  const fixture: Fixture = {
    tenantA: randomUUID(),
    tenantB: randomUUID(),
    moduleA: randomUUID(),
    moduleB: randomUUID(),
    sessionA: randomUUID(),
    sessionB: randomUUID(),
    ingestSecretA: `m2-ingest-a-${randomUUID()}`,
    ingestSecretB: `m2-ingest-b-${randomUUID()}`,
    adminSecretA: `m2-admin-a-${randomUUID()}`,
    adminSecretB: `m2-admin-b-${randomUUID()}`,
    correctionsSecret: `m2-corrections-${randomUUID()}`,
    revokedSecret: `m2-revoked-${randomUUID()}`,
  };

  await connection.pool.query(
    `insert into tenants (tenant_id, slug, display_name)
     values ($1, $2, 'M2 Tenant A'), ($3, $4, 'M2 Tenant B')`,
    [
      fixture.tenantA,
      `m2-a-${fixture.tenantA}`,
      fixture.tenantB,
      `m2-b-${fixture.tenantB}`,
    ],
  );
  await connection.pool.query(
    `insert into module_versions (
       module_version_id, tenant_id, module_id, semantic_version, status,
       module_body_jsonb, content_hash, published_at
     ) values
       ($1, $2, $3, '1.0.0', 'published', '{"sections":[]}'::jsonb, $4, now()),
       ($5, $6, $7, '1.0.0', 'published', '{"sections":[]}'::jsonb, $8, now())`,
    [
      fixture.moduleA,
      fixture.tenantA,
      randomUUID(),
      sha256Hex(`module:${fixture.moduleA}`),
      fixture.moduleB,
      fixture.tenantB,
      randomUUID(),
      sha256Hex(`module:${fixture.moduleB}`),
    ],
  );
  await connection.pool.query(
    `insert into fact_find_sessions (
       session_id, tenant_id, module_version_id, pseudonymous_subject_id
     ) values ($1, $2, $3, $4), ($5, $6, $7, $8)`,
    [
      fixture.sessionA,
      fixture.tenantA,
      fixture.moduleA,
      sha256Hex(`subject:${fixture.sessionA}`),
      fixture.sessionB,
      fixture.tenantB,
      fixture.moduleB,
      sha256Hex(`subject:${fixture.sessionB}`),
    ],
  );
  await connection.pool.query(
    `insert into consent_ledger (
       tenant_id, session_id, purpose, action, policy_version, notice_id,
       evidence_hash, occurred_at, decision_ts
     ) values
       ($1, $2, 'service_improvement_telemetry', 'granted',
        'm2-test-v1', 'm2-test-notice', $3, now(), now()),
       ($4, $5, 'service_improvement_telemetry', 'granted',
        'm2-test-v1', 'm2-test-notice', $6, now(), now())`,
    [
      fixture.tenantA,
      fixture.sessionA,
      sha256Hex(`consent:${fixture.sessionA}`),
      fixture.tenantB,
      fixture.sessionB,
      sha256Hex(`consent:${fixture.sessionB}`),
    ],
  );
  await connection.pool.query(
    `insert into api_keys (tenant_id, key_hash, scopes, actor_label, revoked_at)
     values
       ($1, $2, array['ingest']::text[], 'voice-orchestrator-a', null),
       ($3, $4, array['ingest']::text[], 'voice-orchestrator-b', null),
       ($1, $5, array['corrections']::text[], 'adviser-ui-a', null),
       ($1, $6, array['ingest']::text[], 'revoked-worker', now()),
       ($1, $7, array['admin']::text[], 'metrics-scraper-a', null),
       ($3, $8, array['admin']::text[], 'metrics-scraper-b', null)`,
    [
      fixture.tenantA,
      sha256Hex(fixture.ingestSecretA),
      fixture.tenantB,
      sha256Hex(fixture.ingestSecretB),
      sha256Hex(fixture.correctionsSecret),
      sha256Hex(fixture.revokedSecret),
      sha256Hex(fixture.adminSecretA),
      sha256Hex(fixture.adminSecretB),
    ],
  );
  return fixture;
}

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

function eventFor(
  fixture: Fixture,
  now: Date,
  overrides: Partial<EventInput> = {},
): EventInput {
  return {
    event_id: randomUUID(),
    session_id: fixture.sessionA,
    event_type: "question.prompted",
    attrs: { question_kind: "income", sequence: 1, retry: false },
    occurred_at: now.toISOString(),
    turn_index: 1,
    ...overrides,
  };
}

async function eventCount(
  connection: DatabaseConnection,
  tenantId: string,
  eventId: string,
): Promise<number> {
  const result = await connection.pool.query<{ count: number }>(
    `select count(*)::integer as count from session_events
     where tenant_id = $1 and event_id = $2`,
    [tenantId, eventId],
  );
  return result.rows[0]?.count ?? 0;
}

async function outboxCount(
  connection: DatabaseConnection,
  tenantId: string,
  eventId: string,
): Promise<number> {
  const result = await connection.pool.query<{ count: number }>(
    `select count(*)::integer as count from telemetry_outbox
     where tenant_id = $1 and event_id = $2`,
    [tenantId, eventId],
  );
  return result.rows[0]?.count ?? 0;
}

describe.sequential("M2 authenticated batch ingestion", () => {
  let config: ServiceConfig;
  let connection: DatabaseConnection;
  let catalog: EventCatalog;
  let catalogs: EventCatalogRegistry;
  let clock: MutableClock;
  let baseNow: Date;
  let metrics: RecordingIngestionMetrics;
  let fixture: Fixture;
  let app: FastifyInstance;

  beforeAll(async () => {
    config = loadConfig();
    connection = createDatabaseConnection(config.databaseUrl);
    await waitForPostgres(connection.pool);
    catalog = loadEventCatalog();
    catalogs = new EventCatalogRegistry([catalog]);
    baseNow = new Date();
    clock = new MutableClock(baseNow);
    metrics = new RecordingIngestionMetrics();
    fixture = await seedFixtures(connection);
    app = buildApp(config, { connection, catalog, clock, metrics });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await connection.pool.end();
  });

  it("installs the reference-only transactional outbox contract", async () => {
    const columns = await connection.pool.query<{
      column_name: string;
      is_nullable: string;
    }>(
      `select column_name, is_nullable
       from information_schema.columns
       where table_schema = 'public' and table_name = 'telemetry_outbox'
       order by ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "outbox_id",
      "tenant_id",
      "event_id",
      "config_version",
      "attempt_count",
      "next_attempt_at",
      "posthog_delivered_at",
      "otel_delivered_at",
      "processed_at",
      "last_failure_code",
      "created_at",
      "suppressed_at",
      "suppression_reason",
    ]);
    expect(columns.rows.some((row) => row.column_name === "payload")).toBe(false);

    const constraints = await connection.pool.query<{
      conname: string;
      definition: string;
    }>(
      `select c.conname, pg_get_constraintdef(c.oid, true) as definition
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = 'public' and t.relname = 'telemetry_outbox'
       order by c.conname`,
    );
    expect(constraints.rows.map((row) => row.conname)).toEqual([
      "telemetry_outbox_attempt_count_check",
      "telemetry_outbox_config_version_check",
      "telemetry_outbox_event_fk",
      "telemetry_outbox_failure_code_check",
      "telemetry_outbox_pkey",
      "telemetry_outbox_processed_check",
      "telemetry_outbox_suppression_check",
      "telemetry_outbox_tenant_event_unique",
    ]);
    expect(
      constraints.rows.find((row) => row.conname === "telemetry_outbox_event_fk")
        ?.definition,
    ).toContain("FOREIGN KEY (tenant_id, event_id)");

    const indexResult = await connection.pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where schemaname = 'public' and indexname = 'telemetry_outbox_pending_idx'`,
    );
    expect(indexResult.rows[0]?.indexdef).toContain("next_attempt_at");
    expect(indexResult.rows[0]?.indexdef).toContain("WHERE (processed_at IS NULL)");
  });

  it("validates and projects every configured event type from the catalog", () => {
    const cases = [
      {
        eventType: "session.started",
        attrs: { channel: "voice", source: "orchestrator" },
        envelope: { turnIndex: 1, durationMs: 200 },
        projected: { channel: "voice", source: "orchestrator" },
      },
      {
        eventType: "question.prompted",
        attrs: { question_kind: "income", sequence: 2, retry: false },
        envelope: { turnIndex: 2, durationMs: 300 },
        projected: {
          question_kind: "income",
          sequence: 2,
          retry: false,
          turn_index: 2,
        },
      },
      {
        eventType: "question.completed",
        attrs: {
          outcome: "answered",
          value_class: "banded",
          duration_bucket: "5_to_15s",
        },
        envelope: { turnIndex: 3, durationMs: 8_000 },
        projected: {
          outcome: "answered",
          value_class: "banded",
          duration_bucket: "5_to_15s",
          turn_index: 3,
          duration_ms: 8_000,
        },
      },
      {
        eventType: "extraction.completed",
        attrs: {
          field_kind: "asset",
          result: "extracted",
          confidence_band: "high",
        },
        envelope: { turnIndex: 4, durationMs: 500 },
        projected: {
          field_kind: "asset",
          result: "extracted",
          confidence_band: "high",
          turn_index: 4,
          duration_ms: 500,
        },
      },
      {
        eventType: "session.completed",
        attrs: { outcome: "completed", turn_count: 4 },
        envelope: { turnIndex: 4, durationMs: 20_000 },
        projected: {
          outcome: "completed",
          turn_count: 4,
          duration_ms: 20_000,
        },
      },
    ] as const;

    for (const testCase of cases) {
      const validation = catalog.validateIncoming(
        testCase.eventType,
        testCase.attrs,
        false,
      );
      expect(validation.ok).toBe(true);
      if (!validation.ok) throw new Error(validation.error);
      expect(
        catalog.projectProperties(
          testCase.eventType,
          validation.value.persistedAttrs,
          testCase.envelope,
        ),
      ).toEqual(testCase.projected);
    }
  });

  it("authenticates hashed active keys without exposing credentials", async () => {
    const event = eventFor(fixture, baseNow);
    const missing = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      payload: { events: [event] },
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toContain("Bearer");

    const malformed = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: { authorization: "Basic not-a-bearer-key" },
      payload: { events: [event] },
    });
    expect(malformed.statusCode).toBe(401);

    const unknownSecret = `unknown-${randomUUID()}`;
    const unknown = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(unknownSecret),
      payload: { events: [event] },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.body).not.toContain(unknownSecret);

    const revoked = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.revokedSecret),
      payload: { events: [event] },
    });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.body).not.toContain(fixture.revokedSecret);

    const wrongScope = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.correctionsSecret),
      payload: { events: [event] },
    });
    expect(wrongScope.statusCode).toBe(403);
    expect(await eventCount(connection, fixture.tenantA, event.event_id)).toBe(0);
  });

  it("derives tenancy from the key and returns 404 for another tenant's module", async () => {
    const rootMismatchEvent = eventFor(fixture, baseNow);
    const rootMismatch = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: { tenant_id: fixture.tenantB, events: [rootMismatchEvent] },
    });
    expect(rootMismatch.statusCode).toBe(403);

    const itemMismatchEvent = eventFor(fixture, baseNow, {
      tenant_id: fixture.tenantB,
    });
    const itemMismatch = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: { events: [itemMismatchEvent] },
    });
    expect(itemMismatch.statusCode).toBe(403);

    const crossTenantEvent = eventFor(fixture, baseNow, {
      session_id: fixture.sessionB,
    });
    const crossTenant = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: { events: [crossTenantEvent] },
    });
    expect(crossTenant.statusCode).toBe(207);
    expect(crossTenant.json()).toEqual({
      results: [
        {
          event_id: crossTenantEvent.event_id,
          status: "invalid",
          error: "session_id not found",
        },
      ],
    });
    expect(await eventCount(connection, fixture.tenantA, crossTenantEvent.event_id)).toBe(0);
    expect(await eventCount(connection, fixture.tenantB, crossTenantEvent.event_id)).toBe(0);

    const ownModule = await app.inject({
      method: "GET",
      url: `/v1/module-versions/${fixture.moduleA}`,
      headers: bearer(fixture.ingestSecretA),
    });
    expect(ownModule.statusCode).toBe(200);
    expect(ownModule.json().module_version_id).toBe(fixture.moduleA);

    const foreignModule = await app.inject({
      method: "GET",
      url: `/v1/module-versions/${fixture.moduleB}`,
      headers: bearer(fixture.ingestSecretA),
    });
    const nonexistentModule = await app.inject({
      method: "GET",
      url: `/v1/module-versions/${randomUUID()}`,
      headers: bearer(fixture.ingestSecretA),
    });
    expect(foreignModule.statusCode).toBe(404);
    expect(nonexistentModule.statusCode).toBe(404);
    expect(foreignModule.body).toBe(nonexistentModule.body);
  });

  it("rejects structurally invalid batch sizes before processing items", async () => {
    const empty = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: { events: [] },
    });
    expect(empty.statusCode).toBe(400);

    const sample = eventFor(fixture, baseNow);
    const oversized = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: { events: Array.from({ length: 501 }, () => sample) },
    });
    expect(oversized.statusCode).toBe(400);
    expect(await eventCount(connection, fixture.tenantA, sample.event_id)).toBe(0);
  });

  it("returns inserted, duplicate, and conflict with exactly one event and outbox row", async () => {
    const event = eventFor(fixture, baseNow, { tenant_id: fixture.tenantA });
    const inserted = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: { events: [event] },
    });
    expect(inserted.statusCode).toBe(207);
    expect(inserted.json()).toEqual({
      results: [{ event_id: event.event_id, status: "inserted" }],
    });
    expect(await eventCount(connection, fixture.tenantA, event.event_id)).toBe(1);
    expect(await outboxCount(connection, fixture.tenantA, event.event_id)).toBe(1);

    const reorderedReplay: EventInput = {
      event_id: event.event_id,
      session_id: event.session_id,
      event_type: event.event_type,
      occurred_at: new Date(event.occurred_at).toISOString().replace("Z", "+00:00"),
      turn_index: event.turn_index ?? null,
      attrs: { retry: false, sequence: 1, question_kind: "income" },
    };
    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: { events: [reorderedReplay] },
    });
    expect(duplicate.json()).toEqual({
      results: [{ event_id: event.event_id, status: "duplicate" }],
    });

    const conflictBaseline = metrics.idempotencyConflictCount;
    const conflicting = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: {
        events: [
          {
            ...reorderedReplay,
            attrs: { question_kind: "income", sequence: 2, retry: false },
          },
        ],
      },
    });
    expect(conflicting.json()).toEqual({
      results: [
        {
          event_id: event.event_id,
          status: "conflict",
          error: "same event_id, different payload",
        },
      ],
    });
    expect(metrics.idempotencyConflictCount).toBe(conflictBaseline + 1);
    expect(await eventCount(connection, fixture.tenantA, event.event_id)).toBe(1);
    expect(await outboxCount(connection, fixture.tenantA, event.event_id)).toBe(1);

    const tenantAMetrics = await app.inject({
      method: "GET",
      url: "/internal/metrics",
      headers: bearer(fixture.adminSecretA),
    });
    const tenantBMetrics = await app.inject({
      method: "GET",
      url: "/internal/metrics",
      headers: bearer(fixture.adminSecretB),
    });
    const missingMetricsKey = await app.inject({
      method: "GET",
      url: "/internal/metrics",
    });
    const wrongMetricsScope = await app.inject({
      method: "GET",
      url: "/internal/metrics",
      headers: bearer(fixture.ingestSecretA),
    });
    expect(tenantAMetrics.statusCode).toBe(200);
    expect(tenantAMetrics.body).toContain(
      `planeir_telemetry_idempotency_conflicts_total ${metrics.getIdempotencyConflictCount(fixture.tenantA)}`,
    );
    expect(tenantBMetrics.statusCode).toBe(200);
    expect(tenantBMetrics.body).toContain(
      "planeir_telemetry_idempotency_conflicts_total 0",
    );
    expect(missingMetricsKey.statusCode).toBe(401);
    expect(wrongMetricsScope.statusCode).toBe(403);
  });

  it("canonicalizes UUID identity for idempotent replays", async () => {
    const lowercaseEventId = randomUUID();
    const uppercaseEvent = eventFor(fixture, baseNow, {
      tenant_id: fixture.tenantA.toUpperCase(),
      event_id: lowercaseEventId.toUpperCase(),
      session_id: fixture.sessionA.toUpperCase(),
    });
    const inserted = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: {
        tenant_id: fixture.tenantA.toUpperCase(),
        events: [uppercaseEvent],
      },
    });
    expect(inserted.statusCode).toBe(207);
    expect(inserted.json().results[0].status).toBe("inserted");

    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: {
        events: [
          {
            ...uppercaseEvent,
            tenant_id: fixture.tenantA,
            event_id: lowercaseEventId,
            session_id: fixture.sessionA,
          },
        ],
      },
    });
    expect(duplicate.statusCode).toBe(207);
    expect(duplicate.json()).toEqual({
      results: [{ event_id: lowercaseEventId, status: "duplicate" }],
    });
    expect(await eventCount(connection, fixture.tenantA, lowercaseEventId)).toBe(1);
    expect(await outboxCount(connection, fixture.tenantA, lowercaseEventId)).toBe(1);
  });

  it("rejects every unknown, free-text, nested, overlong, and oversize attrs case", async () => {
    const sentinel = `RAW-CONVERSATION-${randomUUID()}`;
    const cases: Array<{ event: EventInput; error: string; forbiddenEcho?: string }> = [
      {
        event: eventFor(fixture, baseNow, {
          event_type: "unknown.event",
          attrs: {},
        }),
        error: "event_type not allowed",
      },
      {
        event: eventFor(fixture, baseNow, {
          attrs: { question_kind: "income", sequence: 1, foo: "bar" },
        }),
        error: "attrs.foo not allowed for question.prompted",
      },
      {
        event: eventFor(fixture, baseNow, {
          attrs: { question_kind: "not-a-category", sequence: 1 },
        }),
        error: "attrs.question_kind invalid for question.prompted",
      },
      {
        event: eventFor(fixture, baseNow, {
          attrs: { question_kind: "income", sequence: "one" },
        }),
        error: "attrs.sequence invalid for question.prompted",
      },
      {
        event: eventFor(fixture, baseNow, {
          attrs: { question_kind: "income", sequence: 1, retry: { raw: sentinel } },
        }),
        error: "nested attrs not allowed for question.prompted",
        forbiddenEcho: sentinel,
      },
      {
        event: eventFor(fixture, baseNow, {
          attrs: { question_kind: "x".repeat(257), sequence: 1 },
        }),
        error: "attrs string exceeds 256 characters for question.prompted",
      },
      {
        event: eventFor(fixture, baseNow, {
          attrs: { transcript_text: sentinel },
        }),
        error: "attrs.transcript_text not allowed for question.prompted",
        forbiddenEcho: sentinel,
      },
      {
        event: eventFor(fixture, baseNow, {
          attrs: { blob: "x".repeat(4_100) },
        }),
        error: "attrs exceeds 4096 bytes",
      },
    ];

    for (const testCase of cases) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/telemetry/events",
        headers: bearer(fixture.ingestSecretA),
        payload: { events: [testCase.event] },
      });
      expect(response.statusCode).toBe(207);
      expect(response.json()).toEqual({
        results: [
          {
            event_id: testCase.event.event_id,
            status: "invalid",
            error: testCase.error,
          },
        ],
      });
      if (testCase.forbiddenEcho) expect(response.body).not.toContain(testCase.forbiddenEcho);
      expect(await eventCount(connection, fixture.tenantA, testCase.event.event_id)).toBe(0);
      expect(await outboxCount(connection, fixture.tenantA, testCase.event.event_id)).toBe(0);
    }
  });

  it("keeps prototype-poisoning keys visible to per-item validation", async () => {
    const valid = eventFor(fixture, baseNow);
    const attrsPoisoned = eventFor(fixture, baseNow, { attrs: {} });
    const envelopePoisoned = eventFor(fixture, baseNow);
    const attrsPoisonedJson = JSON.stringify(attrsPoisoned).replace(
      '"attrs":{}',
      '"attrs":{"__proto__":{"m2_polluted":true}}',
    );
    const envelopePoisonedJson = JSON.stringify(envelopePoisoned).replace(
      /}$/,
      ',"__proto__":{"m2_polluted":true}}',
    );
    expect(Object.hasOwn(Object.prototype, "m2_polluted")).toBe(false);

    const response = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: {
        ...bearer(fixture.ingestSecretA),
        "content-type": "application/json",
      },
      payload: `{"events":[${JSON.stringify(valid)},${attrsPoisonedJson},${envelopePoisonedJson}]}`,
    });
    expect(response.statusCode).toBe(207);
    expect(response.json()).toEqual({
      results: [
        { event_id: valid.event_id, status: "inserted" },
        {
          event_id: attrsPoisoned.event_id,
          status: "invalid",
          error: "attrs contains a disallowed key for question.prompted",
        },
        {
          event_id: envelopePoisoned.event_id,
          status: "invalid",
          error: "event envelope invalid",
        },
      ],
    });
    expect(Object.hasOwn(Object.prototype, "m2_polluted")).toBe(false);
    expect(await eventCount(connection, fixture.tenantA, valid.event_id)).toBe(1);
    expect(await eventCount(connection, fixture.tenantA, attrsPoisoned.event_id)).toBe(0);
    expect(await eventCount(connection, fixture.tenantA, envelopePoisoned.event_id)).toBe(
      0,
    );

    const rootPoisoned = eventFor(fixture, baseNow);
    const rootResponse = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: {
        ...bearer(fixture.ingestSecretA),
        "content-type": "application/json",
      },
      payload: `{"events":[${JSON.stringify(rootPoisoned)}],"__proto__":{"m2_polluted":true}}`,
    });
    expect(rootResponse.statusCode).toBe(400);
    expect(await eventCount(connection, fixture.tenantA, rootPoisoned.event_id)).toBe(0);
    expect(Object.hasOwn(Object.prototype, "m2_polluted")).toBe(false);
  });

  it("isolates inherited-name event types and PostgreSQL integer overflows", async () => {
    const valid = eventFor(fixture, baseNow);
    const inheritedName = eventFor(fixture, baseNow, {
      event_type: "constructor",
    });
    const turnOverflow = eventFor(fixture, baseNow, {
      turn_index: 2_147_483_648,
    });
    const durationOverflow = eventFor(fixture, baseNow, {
      duration_ms: 2_147_483_648,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: { events: [valid, inheritedName, turnOverflow, durationOverflow] },
    });
    expect(response.statusCode).toBe(207);
    expect(response.json()).toEqual({
      results: [
        { event_id: valid.event_id, status: "inserted" },
        {
          event_id: inheritedName.event_id,
          status: "invalid",
          error: "event_type not allowed",
        },
        {
          event_id: turnOverflow.event_id,
          status: "invalid",
          error: "event envelope invalid",
        },
        {
          event_id: durationOverflow.event_id,
          status: "invalid",
          error: "event envelope invalid",
        },
      ],
    });
    expect(await eventCount(connection, fixture.tenantA, valid.event_id)).toBe(1);
    for (const invalid of [inheritedName, turnOverflow, durationOverflow]) {
      expect(await eventCount(connection, fixture.tenantA, invalid.event_id)).toBe(0);
    }
  });

  it("persists catalog-essential events even when consent resolution rejects", async () => {
    let consentCalls = 0;
    const rejectingConsentApp = buildApp(config, {
      connection,
      catalog,
      clock,
      metrics,
      consentResolver: {
        async canPersist() {
          consentCalls += 1;
          return false;
        },
      },
    });
    await rejectingConsentApp.ready();
    const event = eventFor(fixture, baseNow);
    try {
      const response = await rejectingConsentApp.inject({
        method: "POST",
        url: "/v1/telemetry/events",
        headers: bearer(fixture.ingestSecretA),
        payload: { events: [event] },
      });
      expect(response.statusCode).toBe(207);
      expect(response.json().results[0].status).toBe("inserted");
      expect(consentCalls).toBe(0);
      expect(await eventCount(connection, fixture.tenantA, event.event_id)).toBe(1);
      expect(await outboxCount(connection, fixture.tenantA, event.event_id)).toBe(1);
    } finally {
      await rejectingConsentApp.close();
    }
  });

  it("applies the exact future and late boundaries without changing replay identity", async () => {
    clock.set(baseNow);
    const tooFuture = eventFor(fixture, baseNow, {
      occurred_at: new Date(baseNow.getTime() + 5 * 60 * 1000 + 1).toISOString(),
    });
    const futureBoundary = eventFor(fixture, baseNow, {
      occurred_at: new Date(baseNow.getTime() + 5 * 60 * 1000).toISOString(),
    });
    const lateBoundary = eventFor(fixture, baseNow, {
      occurred_at: new Date(baseNow.getTime() - 48 * 60 * 60 * 1000).toISOString(),
    });
    const late = eventFor(fixture, baseNow, {
      occurred_at: new Date(baseNow.getTime() - 48 * 60 * 60 * 1000 - 1).toISOString(),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: { events: [tooFuture, futureBoundary, lateBoundary, late] },
    });
    expect(response.statusCode).toBe(207);
    expect(response.json().results.map((result: { status: string }) => result.status)).toEqual([
      "invalid",
      "inserted",
      "inserted",
      "inserted",
    ]);

    const attrs = await connection.pool.query<{ event_id: string; attrs: Record<string, unknown> }>(
      `select event_id, attrs from session_events
       where tenant_id = $1 and event_id = any($2::uuid[])
       order by event_id`,
      [fixture.tenantA, [lateBoundary.event_id, late.event_id]],
    );
    const attrsByEvent = new Map(attrs.rows.map((row) => [row.event_id, row.attrs]));
    expect(attrsByEvent.get(lateBoundary.event_id)).not.toHaveProperty("late");
    expect(attrsByEvent.get(late.event_id)).toMatchObject({ late: true });

    const crossingReplay = eventFor(fixture, baseNow, {
      occurred_at: new Date(baseNow.getTime() - 47 * 60 * 60 * 1000).toISOString(),
    });
    const first = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: { events: [crossingReplay] },
    });
    expect(first.json().results[0].status).toBe("inserted");
    clock.set(new Date(baseNow.getTime() + 2 * 60 * 60 * 1000));
    const replay = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: { events: [crossingReplay] },
    });
    expect(replay.json().results[0].status).toBe("duplicate");
    clock.set(baseNow);
  });

  it("exports accepted pre-epoch events with valid unsigned OTLP timestamps", async () => {
    const event = eventFor(fixture, baseNow, {
      occurred_at: "1960-01-01T00:00:00.000Z",
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: { events: [event] },
    });
    expect(response.statusCode).toBe(207);
    expect(response.json().results[0].status).toBe("inserted");

    const outbox = await connection.pool.query<{
      outbox_id: string;
      next_attempt_at: Date;
    }>(
      `select outbox_id, next_attempt_at from telemetry_outbox
       where tenant_id = $1 and event_id = $2`,
      [fixture.tenantA, event.event_id],
    );
    const posthog = new RecordingPostHogSink();
    const otel = new RecordingOtelSpanSink();
    const worker = new OutboxWorker({
      pool: connection.pool,
      catalogs,
      clock: new MutableClock(
        new Date((outbox.rows[0]?.next_attempt_at.getTime() ?? Date.now()) + 1),
      ),
      posthog,
      otel,
      retryBaseMilliseconds: 1_000,
      retryMaxMilliseconds: 10_000,
    });
    expect(await worker.runOnce(outbox.rows[0]?.outbox_id)).toBe(true);
    expect(otel.successes).toHaveLength(1);
    const payload = otel.successes[0];
    expect(payload).toBeDefined();
    const timestamps = otelSpanTimestamps(
      payload ?? {
        occurredAt: "1970-01-01T00:00:00.000Z",
        receivedAt: "1970-01-01T00:00:00.000Z",
      },
    );
    expect(timestamps.startTimeUnixNano).toBe("0");
    expect(BigInt(timestamps.endTimeUnixNano)).toBeGreaterThanOrEqual(
      BigInt(timestamps.startTimeUnixNano),
    );
  });

  it("commits valid items when another batch item is invalid", async () => {
    const valid = eventFor(fixture, baseNow);
    const invalid = eventFor(fixture, baseNow, {
      attrs: { question_kind: "income", sequence: 1, raw_answer: "forbidden" },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: { events: [valid, invalid] },
    });
    expect(response.statusCode).toBe(207);
    expect(response.json()).toEqual({
      results: [
        { event_id: valid.event_id, status: "inserted" },
        {
          event_id: invalid.event_id,
          status: "invalid",
          error: "attrs.raw_answer not allowed for question.prompted",
        },
      ],
    });
    expect(await eventCount(connection, fixture.tenantA, valid.event_id)).toBe(1);
    expect(await outboxCount(connection, fixture.tenantA, valid.event_id)).toBe(1);
    expect(await eventCount(connection, fixture.tenantA, invalid.event_id)).toBe(0);
  });

  it("uses the unique key to make two concurrent submissions exactly-once", async () => {
    const event = eventFor(fixture, baseNow);
    const submit = () =>
      app.inject({
        method: "POST",
        url: "/v1/telemetry/events",
        headers: bearer(fixture.ingestSecretA),
        payload: { events: [event] },
      });
    const responses = await Promise.all([submit(), submit()]);
    const statuses = responses
      .map((response) => response.json().results[0].status as string)
      .sort();
    expect(statuses).toEqual(["duplicate", "inserted"]);
    expect(await eventCount(connection, fixture.tenantA, event.event_id)).toBe(1);
    expect(await outboxCount(connection, fixture.tenantA, event.event_id)).toBe(1);
  });

  it("orders overlapping concurrent batches to avoid unique-index deadlocks", async () => {
    const firstEvent = eventFor(fixture, baseNow);
    const secondEvent = eventFor(fixture, baseNow);
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `m2_delay_events_${suffix}`;
    const triggerName = `m2_delay_events_trigger_${suffix}`;
    await connection.pool.query(
      `create function ${functionName}() returns trigger language plpgsql as $$
       begin
         if new.event_id = any(array['${firstEvent.event_id}'::uuid, '${secondEvent.event_id}'::uuid])
         then perform pg_sleep(0.15);
         end if;
         return new;
       end;
       $$`,
    );
    await connection.pool.query(
      `create trigger ${triggerName} before insert on session_events
       for each row execute function ${functionName}()`,
    );

    try {
      const submit = (events: EventInput[]) =>
        app.inject({
          method: "POST",
          url: "/v1/telemetry/events",
          headers: bearer(fixture.ingestSecretA),
          payload: { events },
        });
      const [forward, reverse] = await Promise.all([
        submit([firstEvent, secondEvent]),
        submit([secondEvent, firstEvent]),
      ]);
      expect(forward.statusCode).toBe(207);
      expect(reverse.statusCode).toBe(207);

      for (const event of [firstEvent, secondEvent]) {
        const statuses = [forward, reverse]
          .flatMap(
            (response) =>
              response.json().results as Array<{ event_id: string; status: string }>,
          )
          .filter((result) => result.event_id === event.event_id)
          .map((result) => result.status)
          .sort();
        expect(statuses).toEqual(["duplicate", "inserted"]);
        expect(await eventCount(connection, fixture.tenantA, event.event_id)).toBe(1);
        expect(await outboxCount(connection, fixture.tenantA, event.event_id)).toBe(1);
      }
    } finally {
      await connection.pool.query(`drop trigger ${triggerName} on session_events`);
      await connection.pool.query(`drop function ${functionName}()`);
    }
  });

  it("rolls back the event if its outbox insert cannot commit", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `m2_fail_outbox_${suffix}`;
    const triggerName = `m2_fail_outbox_trigger_${suffix}`;
    await connection.pool.query(
      `create function ${functionName}() returns trigger language plpgsql as $$
       begin raise exception using errcode = 'P0001', message = 'forced outbox failure'; end;
       $$`,
    );
    await connection.pool.query(
      `create trigger ${triggerName} before insert on telemetry_outbox
       for each row execute function ${functionName}()`,
    );

    const event = eventFor(fixture, baseNow);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/telemetry/events",
        headers: bearer(fixture.ingestSecretA),
        payload: { events: [event] },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "Internal server error" });
      expect(response.body).not.toContain("forced outbox failure");
      expect(await eventCount(connection, fixture.tenantA, event.event_id)).toBe(0);
      expect(await outboxCount(connection, fixture.tenantA, event.event_id)).toBe(0);
    } finally {
      await connection.pool.query(`drop trigger ${triggerName} on telemetry_outbox`);
      await connection.pool.query(`drop function ${functionName}()`);
    }
  });

  it("scrubs credentials and telemetry bodies from enabled error logs", async () => {
    let logText = "";
    const loggedApp = buildApp(
      { ...config, nodeEnv: "production", logLevel: "error" },
      {
        connection,
        catalog,
        clock,
        metrics,
        logStream: {
          write(message) {
            logText += message;
          },
        },
      },
    );
    await loggedApp.ready();

    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `m2_log_failure_${suffix}`;
    const triggerName = `m2_log_failure_trigger_${suffix}`;
    await connection.pool.query(
      `create function ${functionName}() returns trigger language plpgsql as $$
       begin raise exception using errcode = 'P0001', message = 'DB-SECRET-${suffix}'; end;
       $$`,
    );
    await connection.pool.query(
      `create trigger ${triggerName} before insert on telemetry_outbox
       for each row execute function ${functionName}()`,
    );

    const valid = eventFor(fixture, baseNow);
    const bodySentinel = `RAW-BODY-${randomUUID()}`;
    const invalid = eventFor(fixture, baseNow, {
      attrs: { raw_answer: bodySentinel },
    });
    try {
      const response = await loggedApp.inject({
        method: "POST",
        url: "/v1/telemetry/events",
        headers: bearer(fixture.ingestSecretA),
        payload: { events: [valid, invalid] },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "Internal server error" });
      expect(logText).toContain("request failed");
      expect(logText).toContain("/v1/telemetry/events");
      expect(logText).not.toContain(fixture.ingestSecretA);
      expect(logText).not.toContain(bodySentinel);
      expect(logText).not.toContain(`DB-SECRET-${suffix}`);
      expect(logText.toLowerCase()).not.toContain("authorization");
      expect(logText).not.toContain("raw_answer");
      expect(logText).not.toContain('"body"');
      expect(await eventCount(connection, fixture.tenantA, valid.event_id)).toBe(0);
    } finally {
      await connection.pool.query(`drop trigger ${triggerName} on telemetry_outbox`);
      await connection.pool.query(`drop function ${functionName}()`);
      await loggedApp.close();
    }
  });

  it("does no inline forwarding and retries a failing sink with exponential backoff", async () => {
    const event = eventFor(fixture, baseNow, {
      attrs: { question_kind: "risk", sequence: 7, retry: true },
      turn_index: 7,
    });
    const posthog = new RecordingPostHogSink(2);
    const otel = new RecordingOtelSpanSink();
    const response = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: { events: [event] },
    });
    expect(response.json().results[0].status).toBe("inserted");
    expect(posthog.attempts).toHaveLength(0);
    expect(otel.attempts).toHaveLength(0);

    const outboxBefore = await connection.pool.query<{
      outbox_id: string;
      next_attempt_at: Date;
    }>(
      `select outbox_id, next_attempt_at from telemetry_outbox
       where tenant_id = $1 and event_id = $2`,
      [fixture.tenantA, event.event_id],
    );
    const workerClock = new MutableClock(
      new Date((outboxBefore.rows[0]?.next_attempt_at.getTime() ?? Date.now()) + 1),
    );
    const delayedPosthog: PostHogSink = {
      async capture(payload) {
        workerClock.advance(5_000);
        await posthog.capture(payload);
      },
    };
    const worker = new OutboxWorker({
      pool: connection.pool,
      catalogs,
      clock: workerClock,
      posthog: delayedPosthog,
      otel,
      retryBaseMilliseconds: 1_000,
      retryMaxMilliseconds: 10_000,
    });
    const outboxId = outboxBefore.rows[0]?.outbox_id;
    expect(outboxId).toBeDefined();

    const firstAttemptAt = workerClock.now();
    expect(await worker.runOnce(outboxId)).toBe(true);
    const firstFinishedAt = workerClock.now();
    expect(firstFinishedAt.getTime() - firstAttemptAt.getTime()).toBe(5_000);
    expect(posthog.attempts).toHaveLength(1);
    expect(otel.attempts).toHaveLength(1);
    let state = await connection.pool.query<{
      attempt_count: number;
      next_attempt_at: Date;
      posthog_delivered_at: Date | null;
      otel_delivered_at: Date | null;
      processed_at: Date | null;
      last_failure_code: string | null;
    }>(
      `select attempt_count, next_attempt_at, posthog_delivered_at,
              otel_delivered_at, processed_at, last_failure_code
       from telemetry_outbox where tenant_id = $1 and event_id = $2`,
      [fixture.tenantA, event.event_id],
    );
    expect(state.rows[0]).toMatchObject({
      attempt_count: 1,
      posthog_delivered_at: null,
      processed_at: null,
      last_failure_code: "sink_delivery_failed",
    });
    expect(state.rows[0]?.otel_delivered_at).toBeInstanceOf(Date);
    const firstNextAttemptAt = state.rows[0]?.next_attempt_at;
    expect(firstNextAttemptAt).toBeInstanceOf(Date);
    expect(
      (firstNextAttemptAt?.getTime() ?? 0) - firstFinishedAt.getTime(),
    ).toBe(1_000);

    workerClock.set(new Date((state.rows[0]?.next_attempt_at.getTime() ?? 0) - 1));
    expect(await worker.runOnce(outboxId)).toBe(false);
    workerClock.set(state.rows[0]?.next_attempt_at ?? workerClock.now());
    const secondAttemptAt = workerClock.now();
    expect(await worker.runOnce(outboxId)).toBe(true);
    const secondFinishedAt = workerClock.now();
    expect(secondFinishedAt.getTime() - secondAttemptAt.getTime()).toBe(5_000);
    expect(posthog.attempts).toHaveLength(2);
    expect(otel.attempts).toHaveLength(1);

    state = await connection.pool.query<{
      attempt_count: number;
      next_attempt_at: Date;
      posthog_delivered_at: Date | null;
      otel_delivered_at: Date | null;
      processed_at: Date | null;
      last_failure_code: string | null;
    }>(
      `select attempt_count, next_attempt_at, posthog_delivered_at,
              otel_delivered_at, processed_at, last_failure_code
       from telemetry_outbox where tenant_id = $1 and event_id = $2`,
      [fixture.tenantA, event.event_id],
    );
    const secondNextAttemptAt = state.rows[0]?.next_attempt_at;
    expect(secondNextAttemptAt).toBeInstanceOf(Date);
    expect(
      (secondNextAttemptAt?.getTime() ?? 0) - secondFinishedAt.getTime(),
    ).toBe(2_000);
    workerClock.set(state.rows[0]?.next_attempt_at ?? workerClock.now());
    expect(await worker.runOnce(outboxId)).toBe(true);
    expect(posthog.attempts).toHaveLength(3);
    expect(posthog.successes).toHaveLength(1);
    expect(otel.attempts).toHaveLength(1);

    const finalState = await connection.pool.query<{
      attempt_count: number;
      posthog_delivered_at: Date | null;
      otel_delivered_at: Date | null;
      processed_at: Date | null;
      last_failure_code: string | null;
    }>(
      `select attempt_count, posthog_delivered_at, otel_delivered_at,
              processed_at, last_failure_code
       from telemetry_outbox where tenant_id = $1 and event_id = $2`,
      [fixture.tenantA, event.event_id],
    );
    expect(finalState.rows[0]?.attempt_count).toBe(3);
    expect(finalState.rows[0]?.posthog_delivered_at).toBeInstanceOf(Date);
    expect(finalState.rows[0]?.otel_delivered_at).toBeInstanceOf(Date);
    expect(finalState.rows[0]?.processed_at).toBeInstanceOf(Date);
    expect(finalState.rows[0]?.last_failure_code).toBeNull();

    expect(posthog.attempts[0]).toEqual(posthog.attempts[1]);
    expect(posthog.attempts[1]).toEqual(posthog.attempts[2]);
    expect(posthog.attempts[0]?.properties).toEqual({
      question_kind: "risk",
      sequence: 7,
      retry: true,
      turn_index: 7,
    });
    const serialized = JSON.stringify(posthog.attempts[0]);
    expect(serialized).not.toContain(fixture.tenantA);
    expect(serialized).not.toContain(fixture.sessionA);
    expect(serialized).not.toContain("payload_hash");
    expect(serialized).not.toContain("raw_answer");
  });

  it("provides isolated Recording fakes for every dormant third-party port", async () => {
    const forwarded = {
      deliveryId: randomUUID(),
      eventId: randomUUID(),
      eventType: "question.prompted",
      occurredAt: baseNow.toISOString(),
      receivedAt: baseNow.toISOString(),
      properties: {
        question_kind: "income",
        sequence: 1,
      },
    };
    const langfuse = new RecordingLangfuseSink();
    const keyMaterial = new Uint8Array([1, 2, 3]);
    const kms = new RecordingKmsSink(keyMaterial);
    const dlpResult = { allowed: false, categories: ["possible_identifier"] };
    const dlp = new RecordingDlpSink(dlpResult);
    const keyRequest = { tenantId: fixture.tenantA, keyVersion: 1 };

    await langfuse.capture(forwarded);
    const resolvedKey = await kms.resolveTenantKey(keyRequest);
    const inspected = await dlp.inspect(forwarded);
    forwarded.properties.sequence = 99;
    keyRequest.tenantId = fixture.tenantB;
    keyMaterial[0] = 99;
    dlpResult.categories[0] = "mutated";

    expect(langfuse.attempts[0]?.properties).toEqual({
      question_kind: "income",
      sequence: 1,
    });
    expect(kms.requests).toEqual([{ tenantId: fixture.tenantA, keyVersion: 1 }]);
    expect([...((resolvedKey ?? new Uint8Array()))]).toEqual([1, 2, 3]);
    expect(dlp.attempts[0]?.properties).toEqual({
      question_kind: "income",
      sequence: 1,
    });
    expect(inspected).toEqual({
      allowed: false,
      categories: ["possible_identifier"],
    });
  });

  it("selects and drains through zero-network no-op sinks when credentials are absent", async () => {
    const sinks = createTelemetrySinks({
      ...config,
      posthogApiKey: undefined,
      otelExporterOtlpEndpoint: undefined,
    });
    expect(sinks.posthog).toBeInstanceOf(NoopPostHogSink);
    expect(sinks.otel).toBeInstanceOf(NoopOtelSpanSink);
    expect(sinks.langfuse).toBeInstanceOf(NoopLangfuseSink);
    expect(sinks.kms).toBeInstanceOf(NoopKmsSink);
    expect(sinks.dlp).toBeInstanceOf(NoopDlpSink);

    const event = eventFor(fixture, baseNow);
    const response = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: { events: [event] },
    });
    expect(response.json().results[0].status).toBe("inserted");
    const outbox = await connection.pool.query<{
      outbox_id: string;
      next_attempt_at: Date;
    }>(
      `select outbox_id, next_attempt_at from telemetry_outbox
       where tenant_id = $1 and event_id = $2`,
      [fixture.tenantA, event.event_id],
    );
    const noopWorker = new OutboxWorker({
      pool: connection.pool,
      catalogs,
      clock: new MutableClock(
        new Date((outbox.rows[0]?.next_attempt_at.getTime() ?? Date.now()) + 1),
      ),
      posthog: sinks.posthog,
      otel: sinks.otel,
      retryBaseMilliseconds: 1_000,
      retryMaxMilliseconds: 10_000,
    });
    expect(await noopWorker.runOnce(outbox.rows[0]?.outbox_id)).toBe(true);
    const processed = await connection.pool.query<{ processed_at: Date | null }>(
      `select processed_at from telemetry_outbox
       where tenant_id = $1 and event_id = $2`,
      [fixture.tenantA, event.event_id],
    );
    expect(processed.rows[0]?.processed_at).toBeInstanceOf(Date);
  });
});
