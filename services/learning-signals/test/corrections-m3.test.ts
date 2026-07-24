import { randomBytes, randomUUID } from "node:crypto";

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
import { loadFieldPolicy, type FieldPolicy } from "../src/privacy/field-policy.js";
import { RecordingSecretsProvider } from "../src/privacy/secrets.js";
import {
  RecordingDlpSink,
  RecordingKmsSink,
  RecordingLangfuseSink,
  RecordingOtelSpanSink,
  RecordingPostHogSink,
} from "../src/sinks/telemetry-sinks.js";
import { sha256Hex } from "../src/telemetry/canonical-json.js";
import type { Clock } from "../src/telemetry/clock.js";
import {
  loadEventCatalogRegistry,
  type EventCatalogRegistry,
} from "../src/telemetry/event-catalog.js";

type Fixture = {
  tenantA: string;
  tenantB: string;
  moduleA: string;
  moduleB: string;
  sessionA: string;
  sessionA2: string;
  sessionB: string;
  extractionA: string;
  extractionB: string;
  correctionsSecretA: string;
  correctionsSecretA2: string;
  correctionsSecretB: string;
  ingestSecretA: string;
  noActorSecretA: string;
  revokedSecretA: string;
};

type CorrectionBody = {
  tenant_id?: string;
  session_id: string;
  extraction_id: string;
  idempotency_key: string;
  before_raw: string | number | boolean | null;
  after_raw: string | number | boolean | null;
  reason_code?: string;
  note?: string;
};

type CorrectionResponse = {
  correction_id: string;
  extraction_id: string;
  status: "corrected";
  replayed: boolean;
};

class FixedClock implements Clock {
  constructor(private readonly value: Date) {}

  now(): Date {
    return new Date(this.value);
  }
}

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

function correctionFor(
  fixture: Fixture,
  extractionId: string,
  overrides: Partial<CorrectionBody> = {},
): CorrectionBody {
  return {
    session_id: fixture.sessionA,
    extraction_id: extractionId,
    idempotency_key: randomUUID(),
    before_raw: "€430,000",
    after_raw: "€425,000",
    reason_code: "incorrect_value",
    ...overrides,
  };
}

async function seedFixtures(connection: DatabaseConnection): Promise<Fixture> {
  const fixture: Fixture = {
    tenantA: randomUUID(),
    tenantB: randomUUID(),
    moduleA: randomUUID(),
    moduleB: randomUUID(),
    sessionA: randomUUID(),
    sessionA2: randomUUID(),
    sessionB: randomUUID(),
    extractionA: randomUUID(),
    extractionB: randomUUID(),
    correctionsSecretA: `m3-corrections-a-${randomUUID()}`,
    correctionsSecretA2: `m3-corrections-a2-${randomUUID()}`,
    correctionsSecretB: `m3-corrections-b-${randomUUID()}`,
    ingestSecretA: `m3-ingest-a-${randomUUID()}`,
    noActorSecretA: `m3-no-actor-a-${randomUUID()}`,
    revokedSecretA: `m3-revoked-a-${randomUUID()}`,
  };

  await connection.pool.query(
    `insert into tenants (tenant_id, slug, display_name)
     values ($1, $2, 'M3 Tenant A'), ($3, $4, 'M3 Tenant B')`,
    [
      fixture.tenantA,
      `m3-a-${fixture.tenantA}`,
      fixture.tenantB,
      `m3-b-${fixture.tenantB}`,
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
     ) values
       ($1, $2, $3, $4),
       ($5, $2, $3, $6),
       ($7, $8, $9, $10)`,
    [
      fixture.sessionA,
      fixture.tenantA,
      fixture.moduleA,
      sha256Hex(`subject:${fixture.sessionA}`),
      fixture.sessionA2,
      sha256Hex(`subject:${fixture.sessionA2}`),
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
        'm3-test-v1', 'm3-test-notice', $3, now(), now()),
       ($1, $4, 'service_improvement_telemetry', 'granted',
        'm3-test-v1', 'm3-test-notice', $5, now(), now()),
       ($6, $7, 'service_improvement_telemetry', 'granted',
        'm3-test-v1', 'm3-test-notice', $8, now(), now())`,
    [
      fixture.tenantA,
      fixture.sessionA,
      sha256Hex(`consent:${fixture.sessionA}`),
      fixture.sessionA2,
      sha256Hex(`consent:${fixture.sessionA2}`),
      fixture.tenantB,
      fixture.sessionB,
      sha256Hex(`consent:${fixture.sessionB}`),
    ],
  );
  await connection.pool.query(
    `insert into field_extractions (
       extraction_id, tenant_id, session_id, field_path, value_class,
       normalized_value_hash, key_version, confidence, field_policy_version
     ) values
       ($1, $2, $3, 'finances.total_assets', 'currency', $4, 1, 0.91, 'field-policy-v1'),
       ($5, $6, $7, 'finances.total_assets', 'currency', $8, 1, 0.92, 'field-policy-v1')`,
    [
      fixture.extractionA,
      fixture.tenantA,
      fixture.sessionA,
      sha256Hex(`original:${fixture.extractionA}`),
      fixture.extractionB,
      fixture.tenantB,
      fixture.sessionB,
      sha256Hex(`original:${fixture.extractionB}`),
    ],
  );
  await connection.pool.query(
    `insert into api_keys (tenant_id, key_hash, scopes, actor_label, revoked_at)
     values
       ($1, $2, array['corrections']::text[], 'adviser-ui-a', null),
       ($1, $3, array['corrections']::text[], 'adviser-ui-a2', null),
       ($4, $5, array['corrections']::text[], 'adviser-ui-b', null),
       ($1, $6, array['ingest']::text[], 'voice-orchestrator-a', null),
       ($1, $7, array['corrections']::text[], null, null),
       ($1, $8, array['corrections']::text[], 'revoked-adviser-a', now())`,
    [
      fixture.tenantA,
      sha256Hex(fixture.correctionsSecretA),
      sha256Hex(fixture.correctionsSecretA2),
      fixture.tenantB,
      sha256Hex(fixture.correctionsSecretB),
      sha256Hex(fixture.ingestSecretA),
      sha256Hex(fixture.noActorSecretA),
      sha256Hex(fixture.revokedSecretA),
    ],
  );

  return fixture;
}

async function seedExtraction(
  connection: DatabaseConnection,
  fixture: Fixture,
  fieldPath = "finances.total_assets",
): Promise<string> {
  const extractionId = randomUUID();
  const valueClass =
    fieldPath === "client.age"
      ? "age"
      : fieldPath === "risk.profile"
        ? "categorical"
        : "currency";
  await connection.pool.query(
    `insert into field_extractions (
       extraction_id, tenant_id, session_id, field_path, value_class,
       normalized_value_hash, key_version, confidence, field_policy_version
     ) values ($1, $2, $3, $4, $5, $6, 1, 0.90, 'field-policy-v1')`,
    [
      extractionId,
      fixture.tenantA,
      fixture.sessionA,
      fieldPath,
      valueClass,
      sha256Hex(`original:${extractionId}`),
    ],
  );
  return extractionId;
}

async function correctionCount(
  connection: DatabaseConnection,
  tenantId: string,
  idempotencyKey: string,
): Promise<number> {
  const result = await connection.pool.query<{ count: number }>(
    `select count(*)::integer as count
     from adviser_corrections
     where tenant_id = $1 and idempotency_key = $2`,
    [tenantId, idempotencyKey],
  );
  return result.rows[0]?.count ?? 0;
}

async function eventAndOutboxCounts(
  connection: DatabaseConnection,
  tenantId: string,
  correctionId: string,
): Promise<{ events: number; outbox: number }> {
  const result = await connection.pool.query<{
    events: number;
    outbox: number;
  }>(
    `select
       (select count(*)::integer from session_events
        where tenant_id = $1 and event_id = $2) as events,
       (select count(*)::integer from telemetry_outbox
        where tenant_id = $1 and event_id = $2) as outbox`,
    [tenantId, correctionId],
  );
  return result.rows[0] ?? { events: 0, outbox: 0 };
}

async function expectPostgresCode(
  operation: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: expectedCode });
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function fullDatabaseDump(connection: DatabaseConnection): Promise<string> {
  const tables = await connection.pool.query<{
    schemaname: string;
    tablename: string;
  }>(
    `select schemaname, tablename
     from pg_tables
     where schemaname not in ('pg_catalog', 'information_schema')
     order by schemaname, tablename`,
  );
  const chunks: string[] = [];
  for (const table of tables.rows) {
    const qualified =
      `${quoteIdentifier(table.schemaname)}.${quoteIdentifier(table.tablename)}`;
    const rows = await connection.pool.query<{ dump: string }>(
      `select coalesce(jsonb_agg(to_jsonb(row_data))::text, '[]') as dump
       from ${qualified} as row_data`,
    );
    chunks.push(`${table.schemaname}.${table.tablename}:${rows.rows[0]?.dump ?? "[]"}`);
  }
  return chunks.join("\n");
}

describe.sequential("M3 adviser corrections", () => {
  let config: ServiceConfig;
  let connection: DatabaseConnection;
  let fixture: Fixture;
  let fieldPolicy: FieldPolicy;
  let secretsProvider: RecordingSecretsProvider;
  let catalogs: EventCatalogRegistry;
  let app: FastifyInstance;

  beforeAll(async () => {
    config = loadConfig();
    connection = createDatabaseConnection(config.databaseUrl);
    await waitForPostgres(connection.pool);
    fixture = await seedFixtures(connection);
    fieldPolicy = loadFieldPolicy();
    secretsProvider = new RecordingSecretsProvider();
    secretsProvider.setTenantKey(fixture.tenantA, 1, randomBytes(32));
    secretsProvider.setTenantKey(fixture.tenantB, 1, randomBytes(32));
    catalogs = loadEventCatalogRegistry();
    app = buildApp(config, {
      connection,
      catalog: catalogs.current,
      fieldPolicy,
      secretsProvider,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await connection.pool.end();
  });

  it("requires a live corrections credential with an authenticated actor", async () => {
    const body = correctionFor(fixture, fixture.extractionA);
    const missing = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      payload: body,
    });
    const wrongScope = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.ingestSecretA),
      payload: body,
    });
    const noActor = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.noActorSecretA),
      payload: body,
    });
    const revoked = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.revokedSecretA),
      payload: body,
    });

    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toContain("Bearer");
    expect(wrongScope.statusCode).toBe(403);
    expect(noActor.statusCode).toBe(403);
    expect(revoked.statusCode).toBe(401);
    expect(missing.body).not.toContain(body.before_raw);
    expect(revoked.body).not.toContain(fixture.revokedSecretA);
    expect(
      await correctionCount(connection, fixture.tenantA, body.idempotency_key),
    ).toBe(0);
  });

  it("derives tenancy and actor identity exclusively from the key", async () => {
    const mismatchedTenant = correctionFor(fixture, fixture.extractionA, {
      tenant_id: fixture.tenantB,
    });
    const mismatch = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.correctionsSecretA),
      payload: mismatchedTenant,
    });
    expect(mismatch.statusCode).toBe(403);

    const reviewerRoleBody = {
      ...correctionFor(fixture, fixture.extractionA),
      reviewer_role: "admin",
    };
    const reviewerRole = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.correctionsSecretA),
      payload: reviewerRoleBody,
    });
    expect(reviewerRole.statusCode).toBe(400);

    const tenantAIntoB = correctionFor(fixture, fixture.extractionB, {
      session_id: fixture.sessionB,
    });
    const crossA = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.correctionsSecretA),
      payload: tenantAIntoB,
    });
    const tenantBIntoA = correctionFor(fixture, fixture.extractionA, {
      session_id: fixture.sessionA,
    });
    const crossB = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.correctionsSecretB),
      payload: tenantBIntoA,
    });
    const nonexistent = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.correctionsSecretA),
      payload: correctionFor(fixture, randomUUID()),
    });
    const wrongOwnSession = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.correctionsSecretA),
      payload: correctionFor(fixture, fixture.extractionA, {
        session_id: fixture.sessionA2,
      }),
    });

    for (const response of [crossA, crossB, nonexistent, wrongOwnSession]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Not found" });
    }
    expect(crossA.body).toBe(nonexistent.body);
    expect(
      await correctionCount(
        connection,
        fixture.tenantA,
        tenantAIntoB.idempotency_key,
      ),
    ).toBe(0);
    expect(
      await correctionCount(
        connection,
        fixture.tenantB,
        tenantBIntoA.idempotency_key,
      ),
    ).toBe(0);
  });

  it("keeps extraction.corrected server-owned on the shared ingestion pipeline", async () => {
    const forgedEventId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: {
        events: [
          {
            event_id: forgedEventId,
            session_id: fixture.sessionA,
            event_type: "extraction.corrected",
            attrs: {
              value_class: "currency",
              change_kind: "changed",
              reason_code: "incorrect_value",
            },
            occurred_at: new Date().toISOString(),
          },
        ],
      },
    });

    expect(response.statusCode).toBe(207);
    expect(response.json()).toEqual({
      results: [
        {
          event_id: forgedEventId,
          status: "invalid",
          error: "event_type not allowed",
        },
      ],
    });
    expect(
      await eventAndOutboxCounts(
        connection,
        fixture.tenantA,
        forgedEventId,
      ),
    ).toEqual({ events: 0, outbox: 0 });
  });

  it("rejects prototype-poisoning properties before correction validation", async () => {
    const body = correctionFor(fixture, fixture.extractionA);
    const serialized = JSON.stringify(body);
    const poisoned =
      `${serialized.slice(0, -1)},` +
      `"__proto__":{"note":"M3_PROTO_SENTINEL"}}`;
    const response = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: {
        ...bearer(fixture.correctionsSecretA),
        "content-type": "application/json",
      },
      payload: poisoned,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("M3_PROTO_SENTINEL");
    expect(
      await correctionCount(connection, fixture.tenantA, body.idempotency_key),
    ).toBe(0);
    expect((Object.prototype as Record<string, unknown>).note).toBeUndefined();
  });

  it("boots without a tenant key and fails correction writes closed", async () => {
    const noSecretsApp = buildApp(config, {
      connection,
      catalog: catalogs.current,
      fieldPolicy,
      secretsProvider: new RecordingSecretsProvider(),
    });
    await noSecretsApp.ready();
    const body = correctionFor(fixture, fixture.extractionA, {
      before_raw: "UNPROVISIONED_RAW_SENTINEL",
    });
    try {
      const response = await noSecretsApp.inject({
        method: "POST",
        url: "/v1/adviser-corrections",
        headers: bearer(fixture.correctionsSecretA),
        payload: body,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "Tenant secret unavailable" });
      expect(response.body).not.toContain("UNPROVISIONED_RAW_SENTINEL");
      expect(
        await correctionCount(connection, fixture.tenantA, body.idempotency_key),
      ).toBe(0);
    } finally {
      await noSecretsApp.close();
    }
  });

  it("rejects caller-controlled plaintext in the operational idempotency key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.correctionsSecretA),
      payload: correctionFor(fixture, fixture.extractionA, {
        idempotency_key: "SENTINEL_XYZ",
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("SENTINEL_XYZ");
    const dump = await fullDatabaseDump(connection);
    expect(dump).not.toContain("SENTINEL_XYZ");
  });

  it("normalizes, hashes, persists the correction, and emits one safe outbox event", async () => {
    const extractionId = await seedExtraction(connection, fixture);
    const originalHash = sha256Hex(`original:${extractionId}`);
    const body = correctionFor(fixture, extractionId);
    const response = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.correctionsSecretA),
      payload: body,
    });

    expect(response.statusCode).toBe(201);
    const result = response.json<CorrectionResponse>();
    expect(result).toEqual({
      correction_id: expect.any(String),
      extraction_id: extractionId,
      status: "corrected",
      replayed: false,
    });
    expect(result.correction_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const persisted = await connection.pool.query<{
      before_hash: string;
      after_hash: string;
      before_preview: string | null;
      after_preview: string | null;
      actor_id_pseudo: string;
      key_version: number;
      reviewer_role: string;
      reason_code: string | null;
      payload_hash: string;
      field_policy_version: string;
    }>(
      `select before_hash, after_hash, before_preview, after_preview,
              actor_id_pseudo, key_version, reviewer_role, reason_code,
              payload_hash, field_policy_version
       from adviser_corrections
       where tenant_id = $1 and correction_id = $2`,
      [fixture.tenantA, result.correction_id],
    );
    expect(persisted.rows[0]).toMatchObject({
      before_preview: "250k_499k",
      after_preview: "250k_499k",
      key_version: 1,
      reviewer_role: "corrections",
      reason_code: "incorrect_value",
      field_policy_version: "field-policy-v1",
    });
    for (const hash of [
      persisted.rows[0]?.before_hash,
      persisted.rows[0]?.after_hash,
      persisted.rows[0]?.actor_id_pseudo,
      persisted.rows[0]?.payload_hash,
    ]) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(persisted.rows[0]?.before_hash).not.toBe(
      persisted.rows[0]?.after_hash,
    );

    const extraction = await connection.pool.query<{
      normalized_value_hash: string;
      normalized_value_preview: string | null;
      extraction_status: string;
    }>(
      `select normalized_value_hash, normalized_value_preview, extraction_status
       from field_extractions
       where tenant_id = $1 and extraction_id = $2`,
      [fixture.tenantA, extractionId],
    );
    expect(extraction.rows[0]).toEqual({
      normalized_value_hash: originalHash,
      normalized_value_preview: null,
      extraction_status: "corrected",
    });

    const derived = await connection.pool.query<{
      event_type: string;
      attrs: Record<string, unknown>;
      config_version: string;
    }>(
      `select event.event_type, event.attrs, outbox.config_version
       from session_events event
       join telemetry_outbox outbox
         on outbox.tenant_id = event.tenant_id
        and outbox.event_id = event.event_id
       where event.tenant_id = $1 and event.event_id = $2`,
      [fixture.tenantA, result.correction_id],
    );
    expect(derived.rows).toEqual([
      {
        event_type: "extraction.corrected",
        attrs: {
          value_class: "currency",
          change_kind: "changed",
          reason_code: "incorrect_value",
        },
        // The outbox row records the catalog revision that validated the
        // derived event: the app under test ingests with catalogs.current.
        config_version: catalogs.current.version,
      },
    ]);
  });

  it("replays identical payloads and conflicts on any changed payload", async () => {
    const extractionId = await seedExtraction(connection, fixture);
    const body = correctionFor(fixture, extractionId, {
      note: "Formatting checked; no central note storage.",
    });
    const inserted = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.correctionsSecretA),
      payload: body,
    });
    const replay = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.correctionsSecretA),
      payload: {
        ...body,
        session_id: body.session_id.toUpperCase(),
        extraction_id: body.extraction_id.toUpperCase(),
        idempotency_key: body.idempotency_key.toUpperCase(),
      },
    });
    const changedValue = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.correctionsSecretA),
      payload: { ...body, after_raw: "€424,999" },
    });
    const changedNote = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.correctionsSecretA),
      payload: { ...body, note: "A different discarded note" },
    });
    const changedResource = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.correctionsSecretA),
      payload: { ...body, extraction_id: randomUUID() },
    });
    const changedActor = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.correctionsSecretA2),
      payload: body,
    });

    expect(inserted.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({
      ...inserted.json<CorrectionResponse>(),
      replayed: true,
    });
    for (const conflict of [
      changedValue,
      changedNote,
      changedResource,
      changedActor,
    ]) {
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({
        error: "same idempotency_key, different payload",
      });
    }

    const correctionId =
      inserted.json<CorrectionResponse>().correction_id;
    expect(
      await correctionCount(connection, fixture.tenantA, body.idempotency_key),
    ).toBe(1);
    expect(
      await eventAndOutboxCounts(
        connection,
        fixture.tenantA,
        correctionId,
      ),
    ).toEqual({ events: 1, outbox: 1 });
  });

  it("serializes concurrent submissions into exactly one correction, event, and outbox row", async () => {
    const extractionId = await seedExtraction(connection, fixture);
    const body = correctionFor(fixture, extractionId);
    const submit = () =>
      app.inject({
        method: "POST",
        url: "/v1/adviser-corrections",
        headers: bearer(fixture.correctionsSecretA),
        payload: body,
      });
    const responses = await Promise.all([submit(), submit()]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 201,
    ]);
    const results = responses.map((response) =>
      response.json<CorrectionResponse>(),
    );
    expect(results.map((result) => result.replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(new Set(results.map((result) => result.correction_id)).size).toBe(1);
    expect(
      await correctionCount(connection, fixture.tenantA, body.idempotency_key),
    ).toBe(1);
    expect(
      await eventAndOutboxCounts(
        connection,
        fixture.tenantA,
        results[0]?.correction_id ?? "",
      ),
    ).toEqual({ events: 1, outbox: 1 });
  });

  it("serializes concurrent conflicting payloads with one winner and no extra writes", async () => {
    const extractionId = await seedExtraction(connection, fixture);
    const body = correctionFor(fixture, extractionId);
    const submit = (afterRaw: string) =>
      app.inject({
        method: "POST",
        url: "/v1/adviser-corrections",
        headers: bearer(fixture.correctionsSecretA),
        payload: { ...body, after_raw: afterRaw },
      });
    const responses = await Promise.all([
      submit("€425,000"),
      submit("€424,000"),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      201, 409,
    ]);
    const winner = responses.find((response) => response.statusCode === 201);
    const conflict = responses.find((response) => response.statusCode === 409);
    expect(conflict?.json()).toEqual({
      error: "same idempotency_key, different payload",
    });
    const correctionId = winner?.json<CorrectionResponse>().correction_id ?? "";
    expect(
      await correctionCount(connection, fixture.tenantA, body.idempotency_key),
    ).toBe(1);
    expect(
      await eventAndOutboxCounts(
        connection,
        fixture.tenantA,
        correctionId,
      ),
    ).toEqual({ events: 1, outbox: 1 });
  });

  it("rejects fields outside the versioned field policy before persistence", async () => {
    const extractionId = await seedExtraction(
      connection,
      fixture,
      "unlisted.raw_field",
    );
    const body = correctionFor(fixture, extractionId, {
      before_raw: "POLICY_RAW_SENTINEL",
      after_raw: "another raw value",
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.correctionsSecretA),
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("POLICY_RAW_SENTINEL");
    expect(
      await correctionCount(connection, fixture.tenantA, body.idempotency_key),
    ).toBe(0);
    const extraction = await connection.pool.query<{
      extraction_status: string;
    }>(
      `select extraction_status from field_extractions
       where tenant_id = $1 and extraction_id = $2`,
      [fixture.tenantA, extractionId],
    );
    expect(extraction.rows[0]?.extraction_status).toBe("extracted");
  });

  it("enforces preview, status, reason, and session-extraction policy in PostgreSQL", async () => {
    const extractionId = await seedExtraction(connection, fixture);
    await connection.pool.query(
      `update field_extractions
       set normalized_value_preview = $3
       where tenant_id = $1 and extraction_id = $2`,
      [fixture.tenantA, extractionId, "x".repeat(64)],
    );
    await expectPostgresCode(
      connection.pool.query(
        `update field_extractions
         set normalized_value_preview = $3
         where tenant_id = $1 and extraction_id = $2`,
        [fixture.tenantA, extractionId, "x".repeat(65)],
      ),
      "23514",
    );
    await expectPostgresCode(
      connection.pool.query(
        `update field_extractions
         set extraction_status = 'invalid'
         where tenant_id = $1 and extraction_id = $2`,
        [fixture.tenantA, extractionId],
      ),
      "23514",
    );
    await expectPostgresCode(
      connection.pool.query(
        `update field_extractions
         set field_policy_version = ' '
         where tenant_id = $1 and extraction_id = $2`,
        [fixture.tenantA, extractionId],
      ),
      "23514",
    );

    const correctionValues = [
      fixture.tenantA,
      fixture.sessionA,
      extractionId,
      `m3-db-check-${randomUUID()}`,
      sha256Hex("payload"),
      sha256Hex("before"),
      sha256Hex("after"),
      sha256Hex("actor"),
    ];
    await expectPostgresCode(
      connection.pool.query(
        `insert into adviser_corrections (
           tenant_id, session_id, extraction_id, idempotency_key,
           payload_hash, before_hash, after_hash, actor_id_pseudo,
           reviewer_role, before_preview, field_policy_version
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'corrections', $9, 'field-policy-v1')`,
        [...correctionValues, "x".repeat(65)],
      ),
      "23514",
    );
    await expectPostgresCode(
      connection.pool.query(
        `insert into adviser_corrections (
           tenant_id, session_id, extraction_id, idempotency_key,
           payload_hash, before_hash, after_hash, actor_id_pseudo,
           reviewer_role, field_policy_version
         ) values ($1, $2, $3, $4, 'not-a-hash', $5, $6, $7, 'corrections', 'field-policy-v1')`,
        [
          fixture.tenantA,
          fixture.sessionA,
          extractionId,
          randomUUID(),
          sha256Hex("before"),
          sha256Hex("after"),
          sha256Hex("actor"),
        ],
      ),
      "23514",
    );
    await expectPostgresCode(
      connection.pool.query(
        `insert into adviser_corrections (
           tenant_id, session_id, extraction_id, idempotency_key,
           payload_hash, before_hash, after_hash, actor_id_pseudo,
           reviewer_role, reason_code, field_policy_version
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'corrections', 'free_text', 'field-policy-v1')`,
        [
          ...correctionValues.slice(0, 3),
          `m3-db-reason-${randomUUID()}`,
          ...correctionValues.slice(4),
        ],
      ),
      "23514",
    );
    await expectPostgresCode(
      connection.pool.query(
        `insert into adviser_corrections (
           tenant_id, session_id, extraction_id, idempotency_key,
           payload_hash, before_hash, after_hash, actor_id_pseudo,
           reviewer_role, field_policy_version
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'corrections', 'field-policy-v1')`,
        [
          fixture.tenantA,
          fixture.sessionA2,
          extractionId,
          `m3-db-fk-${randomUUID()}`,
          ...correctionValues.slice(4),
        ],
      ),
      "23503",
    );
  });

  it("stores no raw sentinel or adversarial note in any table, log, or recording sink", async () => {
    const extractionId = await seedExtraction(connection, fixture);
    const rawSentinel = "€430,000 SENTINEL_XYZ";
    const noteSentinel = `NOTE_SENTINEL_${randomUUID().replaceAll("-", "")}`;
    const note =
      `Name: Aoife Secretname. I work at EmployerSentinel Ltd. ` +
      `IBAN IE29 AIBK 9311 5212 3456 78, postcode D02 X285, ` +
      `born 1985-07-23, account number ACCT778899, ` +
      `diagnosed with diabetes. ${noteSentinel}`;
    let logText = "";
    const loggedApp = buildApp(
      { ...config, nodeEnv: "production", logLevel: "error" },
      {
        connection,
        catalog: catalogs.current,
        fieldPolicy,
        secretsProvider,
        logStream: {
          write(message) {
            logText += message;
          },
        },
      },
    );
    await loggedApp.ready();

    try {
      const body = correctionFor(fixture, extractionId, {
        before_raw: rawSentinel,
        after_raw: "€420,000",
        note,
      });
      const response = await loggedApp.inject({
        method: "POST",
        url: "/v1/adviser-corrections",
        headers: bearer(fixture.correctionsSecretA),
        payload: body,
      });
      expect(response.statusCode).toBe(201);
      const correctionId =
        response.json<CorrectionResponse>().correction_id;

      const correction = await connection.pool.query<{
        before_preview: string | null;
      }>(
        `select before_preview from adviser_corrections
         where tenant_id = $1 and correction_id = $2`,
        [fixture.tenantA, correctionId],
      );
      expect(correction.rows[0]?.before_preview).toBeNull();

      const outbox = await connection.pool.query<{
        outbox_id: string;
        next_attempt_at: Date;
      }>(
        `select outbox_id, next_attempt_at
         from telemetry_outbox
         where tenant_id = $1 and event_id = $2`,
        [fixture.tenantA, correctionId],
      );
      const posthog = new RecordingPostHogSink();
      const otel = new RecordingOtelSpanSink();
      const langfuse = new RecordingLangfuseSink();
      const dlp = new RecordingDlpSink();
      const kms = new RecordingKmsSink();
      const worker = new OutboxWorker({
        pool: connection.pool,
        catalogs,
        clock: new FixedClock(
          new Date(
            (outbox.rows[0]?.next_attempt_at.getTime() ?? Date.now()) + 1,
          ),
        ),
        posthog,
        otel,
        retryBaseMilliseconds: 1,
        retryMaxMilliseconds: 10,
      });
      expect(await worker.runOnce(outbox.rows[0]?.outbox_id)).toBe(true);
      expect(posthog.successes).toHaveLength(1);
      expect(otel.successes).toHaveLength(1);
      expect(langfuse.attempts).toHaveLength(0);
      expect(dlp.attempts).toHaveLength(0);
      expect(kms.requests).toHaveLength(0);

      const dump = await fullDatabaseDump(connection);
      const captured = JSON.stringify({
        response: response.json(),
        posthog: posthog.attempts,
        otel: otel.attempts,
        langfuse: langfuse.attempts,
        dlp: dlp.attempts,
        kms: kms.requests,
        secrets: secretsProvider.requests,
      });
      const persistedOrCaptured = `${dump}\n${captured}\n${logText}`;
      for (const forbidden of [
        "SENTINEL_XYZ",
        "M3_PROTO_SENTINEL",
        "UNPROVISIONED_RAW_SENTINEL",
        noteSentinel,
        "Aoife Secretname",
        "EmployerSentinel",
        "IE29 AIBK 9311 5212 3456 78",
        "D02 X285",
        "1985-07-23",
        "ACCT778899",
        "diabetes",
        fixture.correctionsSecretA,
      ]) {
        expect(persistedOrCaptured.toLowerCase()).not.toContain(
          forbidden.toLowerCase(),
        );
      }
      expect(logText).not.toContain("before_raw");
      expect(logText).not.toContain("after_raw");
      expect(logText).not.toContain('"body"');
    } finally {
      await loggedApp.close();
    }
  });

  it("uses the current key for new writes while historical keys preserve replay", async () => {
    const extractionV1 = await seedExtraction(connection, fixture);
    const firstBody = correctionFor(fixture, extractionV1, {
      before_raw: "€100,000",
      after_raw: "€110,000",
    });
    const first = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.correctionsSecretA),
      payload: firstBody,
    });
    expect(first.statusCode).toBe(201);
    const firstId = first.json<CorrectionResponse>().correction_id;

    secretsProvider.setTenantKey(fixture.tenantA, 2, randomBytes(32));

    const historicalReplay = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.correctionsSecretA),
      payload: firstBody,
    });
    expect(historicalReplay.statusCode).toBe(200);
    expect(historicalReplay.json<CorrectionResponse>()).toMatchObject({
      correction_id: firstId,
      replayed: true,
    });

    const extractionV2 = await seedExtraction(connection, fixture);
    const secondBody = correctionFor(fixture, extractionV2, {
      before_raw: firstBody.before_raw,
      after_raw: firstBody.after_raw,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/adviser-corrections",
      headers: bearer(fixture.correctionsSecretA),
      payload: secondBody,
    });
    expect(second.statusCode).toBe(201);
    const secondId = second.json<CorrectionResponse>().correction_id;

    const rows = await connection.pool.query<{
      correction_id: string;
      before_hash: string;
      actor_id_pseudo: string;
      key_version: number;
    }>(
      `select correction_id, before_hash, actor_id_pseudo, key_version
       from adviser_corrections
       where tenant_id = $1 and correction_id = any($2::uuid[])
       order by key_version`,
      [fixture.tenantA, [firstId, secondId]],
    );
    expect(rows.rows.map((row) => row.key_version)).toEqual([1, 2]);
    expect(rows.rows[0]?.before_hash).not.toBe(rows.rows[1]?.before_hash);
    expect(rows.rows[0]?.actor_id_pseudo).not.toBe(
      rows.rows[1]?.actor_id_pseudo,
    );
    expect(secretsProvider.requests).toContainEqual({
      tenantId: fixture.tenantA,
      keyVersion: 1,
    });
  });

  it("rolls back correction, extraction status, event, and outbox atomically", async () => {
    const extractionId = await seedExtraction(connection, fixture);
    const body = correctionFor(fixture, extractionId);
    const before = await connection.pool.query<{
      events: number;
      outbox: number;
    }>(
      `select
         (select count(*)::integer from session_events
          where tenant_id = $1 and session_id = $2
            and event_type = 'extraction.corrected') as events,
         (select count(*)::integer
          from telemetry_outbox outbox
          join session_events event
            on event.tenant_id = outbox.tenant_id
           and event.event_id = outbox.event_id
          where event.tenant_id = $1 and event.session_id = $2
            and event.event_type = 'extraction.corrected') as outbox`,
      [fixture.tenantA, fixture.sessionA],
    );
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `m3_fail_outbox_${suffix}`;
    const triggerName = `m3_fail_outbox_trigger_${suffix}`;
    await connection.pool.query(
      `create function ${functionName}() returns trigger language plpgsql as $$
       begin raise exception using errcode = 'P0001', message = 'forced m3 outbox failure'; end;
       $$`,
    );
    await connection.pool.query(
      `create trigger ${triggerName} before insert on telemetry_outbox
       for each row execute function ${functionName}()`,
    );

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/adviser-corrections",
        headers: bearer(fixture.correctionsSecretA),
        payload: body,
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "Internal server error" });
      expect(response.body).not.toContain("forced m3 outbox failure");
      expect(
        await correctionCount(
          connection,
          fixture.tenantA,
          body.idempotency_key,
        ),
      ).toBe(0);

      const extraction = await connection.pool.query<{
        extraction_status: string;
      }>(
        `select extraction_status
         from field_extractions
         where tenant_id = $1 and extraction_id = $2`,
        [fixture.tenantA, extractionId],
      );
      expect(extraction.rows[0]?.extraction_status).toBe("extracted");
      const after = await connection.pool.query<{
        events: number;
        outbox: number;
      }>(
        `select
           (select count(*)::integer from session_events
            where tenant_id = $1 and session_id = $2
              and event_type = 'extraction.corrected') as events,
           (select count(*)::integer
            from telemetry_outbox outbox
            join session_events event
              on event.tenant_id = outbox.tenant_id
             and event.event_id = outbox.event_id
            where event.tenant_id = $1 and event.session_id = $2
              and event.event_type = 'extraction.corrected') as outbox`,
        [fixture.tenantA, fixture.sessionA],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    } finally {
      await connection.pool.query(
        `drop trigger ${triggerName} on telemetry_outbox`,
      );
      await connection.pool.query(`drop function ${functionName}()`);
    }
  });
});
