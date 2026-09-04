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
import { loadFieldPolicy } from "../src/privacy/field-policy.js";
import { RecordingSecretsProvider } from "../src/privacy/secrets.js";
import { sha256Hex } from "../src/telemetry/canonical-json.js";
import type { Clock } from "../src/telemetry/clock.js";
import {
  loadEventCatalogRegistry,
  type EventCatalogRegistry,
} from "../src/telemetry/event-catalog.js";

class MutableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

type Fixture = {
  tenantA: string;
  tenantB: string;
  moduleM: string;
  moduleUnpublished: string;
  sessionS1: string;
  sessionS2: string;
  sessionS3: string;
  sessionS4: string;
  sessionS5: string;
  sessionS6: string;
  adminSecretA: string;
  adminSecretB: string;
  ingestSecretA: string;
  correctionsSecretA: string;
};

type EventEnvelope = {
  event_id: string;
  session_id: string;
  event_type: string;
  attrs: Record<string, unknown>;
  occurred_at: string;
  turn_index?: number;
  duration_ms?: number;
};

type IngestionResultItem = {
  event_id: string;
  status: "inserted" | "duplicate" | "conflict" | "invalid";
  error?: string;
};

type PublishResponse = {
  module_version_id: string;
  module_id: string;
  semantic_version: string;
  content_hash: string;
  status: "published";
  replayed: boolean;
};

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

async function seedFixtures(connection: DatabaseConnection): Promise<Fixture> {
  const fixture: Fixture = {
    tenantA: randomUUID(),
    tenantB: randomUUID(),
    moduleM: randomUUID(),
    moduleUnpublished: randomUUID(),
    sessionS1: randomUUID(),
    sessionS2: randomUUID(),
    sessionS3: randomUUID(),
    sessionS4: randomUUID(),
    sessionS5: randomUUID(),
    sessionS6: randomUUID(),
    adminSecretA: `m5-admin-a-${randomUUID()}`,
    adminSecretB: `m5-admin-b-${randomUUID()}`,
    ingestSecretA: `m5-ingest-a-${randomUUID()}`,
    correctionsSecretA: `m5-corrections-a-${randomUUID()}`,
  };

  await connection.pool.query(
    `insert into tenants (tenant_id, slug, display_name)
     values ($1, $2, 'M5 Tenant A'), ($3, $4, 'M5 Tenant B')`,
    [
      fixture.tenantA,
      `m5-a-${fixture.tenantA}`,
      fixture.tenantB,
      `m5-b-${fixture.tenantB}`,
    ],
  );
  await connection.pool.query(
    `insert into api_keys (tenant_id, key_hash, scopes, actor_label)
     values
       ($1, $2, array['admin']::text[], 'module-admin-a'),
       ($3, $4, array['admin']::text[], 'module-admin-b'),
       ($1, $5, array['ingest']::text[], 'voice-orchestrator-a'),
       ($1, $6, array['corrections']::text[], 'adviser-ui-a')`,
    [
      fixture.tenantA,
      sha256Hex(fixture.adminSecretA),
      fixture.tenantB,
      sha256Hex(fixture.adminSecretB),
      sha256Hex(fixture.ingestSecretA),
      sha256Hex(fixture.correctionsSecretA),
    ],
  );
  return fixture;
}

describe.sequential("M5 module versioning and performance", () => {
  let config: ServiceConfig;
  let connection: DatabaseConnection;
  let catalogs: EventCatalogRegistry;
  let clock: MutableClock;
  let baseNow: Date;
  let fixture: Fixture;
  let app: FastifyInstance;

  // Shared M5 flow state: version ids pinned across sequential tests.
  let versionV1: string;
  let versionV2: string;
  // Source events for the seeded field extractions.
  let s1ExtractionEventId: string;
  let s4RiskEventId: string;
  let s4IncomeEventId: string;
  const extractionIncomeChanged = randomUUID();
  const extractionRiskChanged = randomUUID();
  const extractionIncomeApproved = randomUUID();

  // The hand-computed timeline anchors one day before the fixed test clock;
  // every offset below is minutes from that anchor.
  function occurred(minutes: number): Date {
    return new Date(baseNow.getTime() - 24 * 60 * 60 * 1000 + minutes * 60 * 1000);
  }

  function envelope(
    sessionId: string,
    eventType: string,
    attrs: Record<string, unknown>,
    occurredAt: Date,
    overrides: Partial<EventEnvelope> = {},
  ): EventEnvelope {
    return {
      event_id: randomUUID(),
      session_id: sessionId,
      event_type: eventType,
      attrs,
      occurred_at: occurredAt.toISOString(),
      ...overrides,
    };
  }

  async function ingest(events: EventEnvelope[]): Promise<IngestionResultItem[]> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/telemetry/events",
      headers: bearer(fixture.ingestSecretA),
      payload: { events },
    });
    expect(response.statusCode).toBe(207);
    return (response.json() as { results: IngestionResultItem[] }).results;
  }

  async function ingestInserted(events: EventEnvelope[]): Promise<void> {
    const results = await ingest(events);
    for (const result of results) {
      expect(result).toMatchObject({ status: "inserted" });
    }
  }

  async function publish(
    secret: string,
    payload: Record<string, unknown>,
  ): Promise<{ statusCode: number; body: PublishResponse }> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/module-versions/publish",
      headers: bearer(secret),
      payload,
    });
    return { statusCode: response.statusCode, body: response.json() as PublishResponse };
  }

  async function persistedAttrs(eventId: string): Promise<Record<string, unknown>> {
    const result = await connection.pool.query<{ attrs: Record<string, unknown> }>(
      `select attrs from session_events where tenant_id = $1 and event_id = $2`,
      [fixture.tenantA, eventId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0]!.attrs;
  }

  beforeAll(async () => {
    config = loadConfig();
    connection = createDatabaseConnection(config.databaseUrl);
    await waitForPostgres(connection.pool);
    catalogs = loadEventCatalogRegistry();
    expect(catalogs.current.version).toBe("telemetry-events-v8");
    baseNow = new Date();
    clock = new MutableClock(baseNow);
    const secretsProvider = new RecordingSecretsProvider();
    fixture = await seedFixtures(connection);
    secretsProvider.setTenantKey(fixture.tenantA, 1, randomBytes(32));
    app = buildApp(config, {
      connection,
      catalog: catalogs.current,
      clock,
      fieldPolicy: loadFieldPolicy(),
      secretsProvider,
    });
    await app.ready();

    const publishedV1 = await publish(fixture.adminSecretA, {
      module_id: fixture.moduleM,
      semantic_version: "1.0.0",
      module_json: {
        title: "Income and assets",
        sections: [{ id: "income", fields: ["finances.annual_income"] }],
      },
    });
    expect(publishedV1.statusCode).toBe(201);
    versionV1 = publishedV1.body.module_version_id;

    // Every session records versionV1 as its entry version on purpose. The
    // performance endpoint must ignore this column entirely: S5 will pin V2
    // at module.enter and must count only there.
    await connection.pool.query(
      `insert into fact_find_sessions (
         session_id, tenant_id, module_version_id, pseudonymous_subject_id
       ) values ($1, $7, $8, $9), ($2, $7, $8, $10), ($3, $7, $8, $11),
                ($4, $7, $8, $12), ($5, $7, $8, $13), ($6, $7, $8, $14)`,
      [
        fixture.sessionS1,
        fixture.sessionS2,
        fixture.sessionS3,
        fixture.sessionS4,
        fixture.sessionS5,
        fixture.sessionS6,
        fixture.tenantA,
        versionV1,
        sha256Hex(`subject:${fixture.sessionS1}`),
        sha256Hex(`subject:${fixture.sessionS2}`),
        sha256Hex(`subject:${fixture.sessionS3}`),
        sha256Hex(`subject:${fixture.sessionS4}`),
        sha256Hex(`subject:${fixture.sessionS5}`),
        sha256Hex(`subject:${fixture.sessionS6}`),
      ],
    );
  });

  afterAll(async () => {
    await app.close();
    await connection.pool.end();
  });

  it("canonicalizes module_json and replays identical publishes", async () => {
    const moduleId = randomUUID();
    const canonical =
      '{"sections":[{"fields":["finances.annual_income"],"id":"income"}],"title":"Fact find"}';

    const first = await publish(fixture.adminSecretA, {
      module_id: moduleId,
      semantic_version: "2.1.0",
      module_json: {
        title: "Fact find",
        sections: [{ id: "income", fields: ["finances.annual_income"] }],
      },
    });
    expect(first.statusCode).toBe(201);
    expect(first.body).toMatchObject({
      module_id: moduleId,
      semantic_version: "2.1.0",
      content_hash: sha256Hex(canonical),
      status: "published",
      replayed: false,
    });

    // Same content, different key order: canonicalization must make this a
    // byte-identical replay, not a conflict.
    const replay = await publish(fixture.adminSecretA, {
      module_id: moduleId,
      semantic_version: "2.1.0",
      module_json: {
        sections: [{ fields: ["finances.annual_income"], id: "income" }],
        title: "Fact find",
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toMatchObject({
      module_version_id: first.body.module_version_id,
      content_hash: sha256Hex(canonical),
      replayed: true,
    });

    const stored = await connection.pool.query<{ count: number }>(
      `select count(*)::integer as count from module_versions
       where tenant_id = $1 and module_id = $2 and semantic_version = '2.1.0'`,
      [fixture.tenantA, moduleId],
    );
    expect(stored.rows[0]?.count).toBe(1);

    const conflict = await publish(fixture.adminSecretA, {
      module_id: moduleId,
      semantic_version: "2.1.0",
      module_json: { title: "Fact find", sections: [] },
    });
    expect(conflict.statusCode).toBe(409);

    const nextVersion = await publish(fixture.adminSecretA, {
      module_id: moduleId,
      semantic_version: "2.2.0",
      module_json: { title: "Fact find", sections: [] },
    });
    expect(nextVersion.statusCode).toBe(201);
    expect(nextVersion.body.module_version_id).not.toBe(first.body.module_version_id);
  });

  it("derives publish tenancy from the credential and validates the body", async () => {
    const moduleId = randomUUID();
    const payload = {
      module_id: moduleId,
      semantic_version: "1.0.0",
      module_json: { sections: [] },
    };

    const unauthenticated = await app.inject({
      method: "POST",
      url: "/v1/module-versions/publish",
      payload,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const wrongScope = await publish(fixture.ingestSecretA, payload);
    expect(wrongScope.statusCode).toBe(403);

    const mismatchedTenant = await publish(fixture.adminSecretA, {
      ...payload,
      tenant_id: fixture.tenantB,
    });
    expect(mismatchedTenant.statusCode).toBe(403);

    const badSemver = await publish(fixture.adminSecretA, {
      ...payload,
      semantic_version: "not-a-version",
    });
    expect(badSemver.statusCode).toBe(400);

    const badBody = await publish(fixture.adminSecretA, {
      ...payload,
      module_json: ["not", "an", "object"],
    });
    expect(badBody.statusCode).toBe(400);

    const written = await connection.pool.query<{ count: number }>(
      `select count(*)::integer as count from module_versions where module_id = $1`,
      [moduleId],
    );
    expect(written.rows[0]?.count).toBe(0);
  });

  it("keeps published module versions immutable against update and delete", async () => {
    const published = await publish(fixture.adminSecretA, {
      module_id: randomUUID(),
      semantic_version: "9.9.9",
      module_json: { sections: ["immutable"] },
    });
    expect(published.statusCode).toBe(201);
    const versionId = published.body.module_version_id;

    await expect(
      connection.pool.query(
        `update module_versions set content_hash = $1 where module_version_id = $2`,
        [sha256Hex("tampered"), versionId],
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await expect(
      connection.pool.query(
        `delete from module_versions where module_version_id = $1`,
        [versionId],
      ),
    ).rejects.toMatchObject({ code: "55000" });

    // Plain TRUNCATE is already blocked by the fact_find_sessions foreign
    // key; CASCADE bypasses that guard, so it must run into the ledger's own
    // BEFORE TRUNCATE trigger instead.
    await expect(
      connection.pool.query(`truncate table module_versions cascade`),
    ).rejects.toMatchObject({ code: "55000" });

    const survivor = await connection.pool.query<{ content_hash: string }>(
      `select content_hash from module_versions where module_version_id = $1`,
      [versionId],
    );
    expect(survivor.rows[0]?.content_hash).toBe(published.body.content_hash);
  });

  it("stamps module.enter with the active published version", async () => {
    // S6 sits outside the 28-day metrics window and proves late events still
    // pin. Ingested before V2 exists, it must resolve V1.
    const s6Enter = envelope(
      fixture.sessionS6,
      "module.enter",
      { module_id: fixture.moduleM },
      new Date(baseNow.getTime() - 40 * 24 * 60 * 60 * 1000),
    );
    await ingestInserted([s6Enter]);
    expect(await persistedAttrs(s6Enter.event_id)).toStrictEqual({
      module_id: fixture.moduleM,
      module_version_id: versionV1,
      late: true,
    });

    const s1Enter = envelope(fixture.sessionS1, "module.enter", { module_id: fixture.moduleM }, occurred(0));
    const s1Question = envelope(
      fixture.sessionS1,
      "question.prompted",
      { question_kind: "income", sequence: 1, question_id: "q.income.total" },
      occurred(1),
    );
    const s1Extraction = envelope(
      fixture.sessionS1,
      "extraction.completed",
      { field_kind: "income", result: "extracted", confidence_band: "high" },
      occurred(2),
    );
    const s1Exit = envelope(
      fixture.sessionS1,
      "module.exit",
      { module_id: fixture.moduleM, outcome: "completed" },
      occurred(3),
      { duration_ms: 180_000 },
    );
    const s1Booked = envelope(fixture.sessionS1, "meeting.booked", {}, occurred(4));
    s1ExtractionEventId = s1Extraction.event_id;

    const s2Enter = envelope(fixture.sessionS2, "module.enter", { module_id: fixture.moduleM }, occurred(0));
    const s2QuestionIncome = envelope(
      fixture.sessionS2,
      "question.prompted",
      { question_kind: "income", sequence: 1, question_id: "q.income.total" },
      occurred(1),
    );
    const s2QuestionAssets = envelope(
      fixture.sessionS2,
      "question.prompted",
      { question_kind: "assets", sequence: 2, question_id: "q.assets.property" },
      occurred(2),
    );

    const s3Enter = envelope(fixture.sessionS3, "module.enter", { module_id: fixture.moduleM }, occurred(0));
    const s3Question = envelope(
      fixture.sessionS3,
      "question.prompted",
      { question_kind: "income", sequence: 1, question_id: "q.income.total" },
      occurred(1),
    );
    const s3Exit = envelope(
      fixture.sessionS3,
      "module.exit",
      { module_id: fixture.moduleM, outcome: "abandoned" },
      occurred(2),
      { duration_ms: 60_000 },
    );

    const s4Enter = envelope(fixture.sessionS4, "module.enter", { module_id: fixture.moduleM }, occurred(0));
    const s4Risk = envelope(
      fixture.sessionS4,
      "extraction.completed",
      { field_kind: "risk", result: "ambiguous", confidence_band: "low" },
      occurred(1),
    );
    const s4Income = envelope(
      fixture.sessionS4,
      "extraction.completed",
      { field_kind: "income", result: "extracted", confidence_band: "high" },
      occurred(2),
    );
    const s4Exit = envelope(
      fixture.sessionS4,
      "module.exit",
      { module_id: fixture.moduleM, outcome: "completed" },
      occurred(3),
      { duration_ms: 120_000 },
    );
    s4RiskEventId = s4Risk.event_id;
    s4IncomeEventId = s4Income.event_id;

    await ingestInserted([
      s1Enter, s1Question, s1Extraction, s1Exit, s1Booked,
      s2Enter, s2QuestionIncome, s2QuestionAssets,
      s3Enter, s3Question, s3Exit,
      s4Enter, s4Risk, s4Income, s4Exit,
    ]);

    expect(await persistedAttrs(s1Enter.event_id)).toStrictEqual({
      module_id: fixture.moduleM,
      module_version_id: versionV1,
    });

    const outbox = await connection.pool.query<{ config_version: string }>(
      `select config_version from telemetry_outbox where tenant_id = $1 and event_id = $2`,
      [fixture.tenantA, s1Enter.event_id],
    );
    expect(outbox.rows[0]?.config_version).toBe("telemetry-events-v8");
  });

  it("keeps a session's pin stable after a newer version publishes", async () => {
    clock.advance(60_000);
    const publishedV2 = await publish(fixture.adminSecretA, {
      module_id: fixture.moduleM,
      semantic_version: "1.1.0",
      module_json: {
        title: "Income and assets",
        sections: [{ id: "income", fields: ["finances.annual_income", "risk.profile"] }],
      },
    });
    expect(publishedV2.statusCode).toBe(201);
    versionV2 = publishedV2.body.module_version_id;

    // Re-entering the module in S6 must reuse the session's V1 pin even
    // though V2 is now the active published version.
    const s6ReEnter = envelope(
      fixture.sessionS6,
      "module.enter",
      { module_id: fixture.moduleM },
      new Date(baseNow.getTime() - 40 * 24 * 60 * 60 * 1000 + 5 * 60 * 1000),
    );
    await ingestInserted([s6ReEnter]);
    expect(await persistedAttrs(s6ReEnter.event_id)).toStrictEqual({
      module_id: fixture.moduleM,
      module_version_id: versionV1,
      late: true,
    });

    // A fresh session resolves the new active version.
    const s5Enter = envelope(fixture.sessionS5, "module.enter", { module_id: fixture.moduleM }, occurred(0));
    const s5Exit = envelope(
      fixture.sessionS5,
      "module.exit",
      { module_id: fixture.moduleM, outcome: "completed" },
      occurred(1),
      { duration_ms: 90_000 },
    );
    await ingestInserted([s5Enter, s5Exit]);
    expect(await persistedAttrs(s5Enter.event_id)).toStrictEqual({
      module_id: fixture.moduleM,
      module_version_id: versionV2,
    });
  });

  it("rejects client-supplied pins and unpublished modules per item", async () => {
    const clientPin = envelope(
      fixture.sessionS1,
      "module.enter",
      { module_id: fixture.moduleM, module_version_id: versionV2 },
      occurred(10),
    );
    const unpublished = envelope(
      fixture.sessionS1,
      "module.enter",
      { module_id: fixture.moduleUnpublished },
      occurred(11),
    );

    const results = await ingest([clientPin, unpublished]);
    expect(results[0]).toStrictEqual({
      event_id: clientPin.event_id,
      status: "invalid",
      error: "attrs.module_version_id is server-owned",
    });
    expect(results[1]).toStrictEqual({
      event_id: unpublished.event_id,
      status: "invalid",
      error: "module_id has no published version",
    });
  });

  it("computes module performance from hand-computed seed data", async () => {
    await connection.pool.query(
      `insert into field_extractions (
         extraction_id, tenant_id, session_id, source_event_id, field_path,
         value_class, normalized_value_hash, key_version, confidence,
         field_policy_version
       ) values
         ($1, $2, $3, $4, 'finances.annual_income', 'currency', $5, 1, 0.85, 'field-policy-v1'),
         ($6, $2, $7, $8, 'risk.profile', 'categorical', $9, 1, 0.42, 'field-policy-v1'),
         ($10, $2, $7, $11, 'finances.annual_income', 'currency', $12, 1, 0.91, 'field-policy-v1')`,
      [
        extractionIncomeChanged,
        fixture.tenantA,
        fixture.sessionS1,
        s1ExtractionEventId,
        sha256Hex(`extraction:${extractionIncomeChanged}`),
        extractionRiskChanged,
        fixture.sessionS4,
        s4RiskEventId,
        sha256Hex(`extraction:${extractionRiskChanged}`),
        extractionIncomeApproved,
        s4IncomeEventId,
        sha256Hex(`extraction:${extractionIncomeApproved}`),
      ],
    );

    const corrections = [
      {
        session_id: fixture.sessionS1,
        extraction_id: extractionIncomeChanged,
        idempotency_key: randomUUID(),
        before_raw: 50_000,
        after_raw: 55_000,
        reason_code: "incorrect_value",
      },
      {
        session_id: fixture.sessionS4,
        extraction_id: extractionRiskChanged,
        idempotency_key: randomUUID(),
        before_raw: "balanced",
        after_raw: "growth",
        reason_code: "misclassified",
      },
    ];
    for (const correction of corrections) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/adviser-corrections",
        headers: bearer(fixture.correctionsSecretA),
        payload: correction,
      });
      expect(response.statusCode).toBe(201);
    }

    const response = await app.inject({
      method: "GET",
      url: `/v1/module-versions/${versionV1}/performance`,
      headers: bearer(fixture.adminSecretA),
    });
    expect(response.statusCode).toBe(200);
    // Hand-computed from the seeded timeline:
    // - Segments (V1, in window): S1 completed 180000ms + booked, S2 no exit,
    //   S3 explicit abandon 60000ms, S4 completed 120000ms. S5 pinned V2 and
    //   S6 is outside the window, so neither may appear here.
    // - completion 2/4, abandonment 2/4, median of {60000,120000,180000}.
    // - Extractions: income changed (0.85), risk changed (0.42),
    //   income approved (0.91) -> income rate 1/2, risk rate 1/1; the only
    //   critical (currency/identifier) change is the income correction.
    // - Abandoned S2's last prompted question is q.assets.property (its
    //   earlier q.income.total must not count); abandoned S3's is
    //   q.income.total. Tie on count 1 orders by question_id ascending.
    // - booked 1/4 sessions.
    expect(response.json()).toStrictEqual({
      module_version_id: versionV1,
      semantic_version: "1.0.0",
      window_days: 28,
      sessions_entered: 4,
      completion_rate: 0.5,
      abandonment_rate: 0.5,
      median_module_duration_ms: 120_000,
      correction_rate_by_field: {
        "finances.annual_income": 0.5,
        "risk.profile": 1,
      },
      critical_correction_count: 1,
      booked_meeting_conversion: 0.25,
      top_abandonment_questions: [
        { question_id: "q.assets.property", abandonment_count: 1 },
        { question_id: "q.income.total", abandonment_count: 1 },
      ],
      calibration: [
        { confidence_bucket: "0.4-0.5", n: 1, approval_rate: 0 },
        { confidence_bucket: "0.8-0.9", n: 1, approval_rate: 0 },
        { confidence_bucket: "0.9-1.0", n: 1, approval_rate: 1 },
      ],
    });
  });

  it("attributes metrics to the pinned segment version, never the session entry version", async () => {
    // S5's fact_find_sessions row records V1 as its entry version, yet its
    // only module.enter pinned V2. The V2 report must contain exactly S5.
    const response = await app.inject({
      method: "GET",
      url: `/v1/module-versions/${versionV2}/performance`,
      headers: bearer(fixture.adminSecretA),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({
      module_version_id: versionV2,
      semantic_version: "1.1.0",
      window_days: 28,
      sessions_entered: 1,
      completion_rate: 1,
      abandonment_rate: 0,
      median_module_duration_ms: 90_000,
      correction_rate_by_field: {},
      critical_correction_count: 0,
      booked_meeting_conversion: 0,
      top_abandonment_questions: [],
      calibration: [],
    });
  });

  it("scopes performance reads to the tenant and the admin scope", async () => {
    const foreign = await app.inject({
      method: "GET",
      url: `/v1/module-versions/${versionV1}/performance`,
      headers: bearer(fixture.adminSecretB),
    });
    expect(foreign.statusCode).toBe(404);

    const unknown = await app.inject({
      method: "GET",
      url: `/v1/module-versions/${randomUUID()}/performance`,
      headers: bearer(fixture.adminSecretA),
    });
    expect(unknown.statusCode).toBe(404);

    const malformed = await app.inject({
      method: "GET",
      url: "/v1/module-versions/not-a-uuid/performance",
      headers: bearer(fixture.adminSecretA),
    });
    expect(malformed.statusCode).toBe(404);

    const wrongScope = await app.inject({
      method: "GET",
      url: `/v1/module-versions/${versionV1}/performance`,
      headers: bearer(fixture.ingestSecretA),
    });
    expect(wrongScope.statusCode).toBe(403);

    const unauthenticated = await app.inject({
      method: "GET",
      url: `/v1/module-versions/${versionV1}/performance`,
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("returns the exact zero shape for a version with no activity", async () => {
    const published = await publish(fixture.adminSecretB, {
      module_id: randomUUID(),
      semantic_version: "0.1.0",
      module_json: { sections: [] },
    });
    expect(published.statusCode).toBe(201);

    const response = await app.inject({
      method: "GET",
      url: `/v1/module-versions/${published.body.module_version_id}/performance`,
      headers: bearer(fixture.adminSecretB),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({
      module_version_id: published.body.module_version_id,
      semantic_version: "0.1.0",
      window_days: 28,
      sessions_entered: 0,
      completion_rate: 0,
      abandonment_rate: 0,
      median_module_duration_ms: 0,
      correction_rate_by_field: {},
      critical_correction_count: 0,
      booked_meeting_conversion: 0,
      top_abandonment_questions: [],
      calibration: [],
    });
  });
});
