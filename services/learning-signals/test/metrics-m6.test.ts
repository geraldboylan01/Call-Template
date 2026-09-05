import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, type ServiceConfig } from "../src/config.js";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  waitForPostgres,
} from "../src/db/client.js";
import { MetricsRunner, utcDateString } from "../src/jobs/metrics-runner.js";
import { loadThresholds } from "../src/jobs/thresholds.js";
import { sha256Hex } from "../src/telemetry/canonical-json.js";
import { loadEventCatalogRegistry } from "../src/telemetry/event-catalog.js";

// Fixed UTC metric day for the primary fixture; every offset below is relative.
const D = "2026-06-15";
function at(hour: number, minute = 0, second = 0): Date {
  return new Date(Date.UTC(2026, 5, 15, hour, minute, second));
}
function dayOffset(days: number, hour = 10): Date {
  return new Date(Date.UTC(2026, 5, 15 - days, hour, 0, 0));
}

type MetricRow = {
  metric_name: string;
  dimension: string;
  numerator: number | null;
  denominator: number | null;
  value: number | null;
  reviewed_denominator: number | null;
};

describe.sequential("M6 daily metrics", () => {
  let config: ServiceConfig;
  let connection: DatabaseConnection;
  let runner: MetricsRunner;

  // Primary tenant fixture identities.
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const tenantC = randomUUID();
  const moduleM = randomUUID();
  const moduleN = randomUUID();
  const versionV1 = randomUUID();
  const versionV2 = randomUUID();
  const sessions = {
    s1: randomUUID(),
    s2: randomUUID(),
    s3: randomUUID(),
    s4: randomUUID(),
    s5withdrawn: randomUUID(),
  };
  // Reconciliation outbox rows we can later break to inject a delivery gap.
  const reconciliationOutbox: string[] = [];

  async function seedTenant(tenantId: string, label: string): Promise<void> {
    await connection.pool.query(
      `insert into tenants (tenant_id, slug, display_name) values ($1, $2, $3)`,
      [tenantId, `m6-${label}-${tenantId}`, `M6 ${label}`],
    );
  }

  async function seedModuleVersion(
    tenantId: string,
    moduleId: string,
    versionId: string,
    semver: string,
  ): Promise<void> {
    await connection.pool.query(
      `insert into module_versions (
         module_version_id, tenant_id, module_id, semantic_version, status,
         module_body_jsonb, content_hash, published_at
       ) values ($1, $2, $3, $4, 'published', '{"sections":[]}'::jsonb, $5, now())`,
      [versionId, tenantId, moduleId, semver, sha256Hex(`module:${versionId}`)],
    );
  }

  async function seedSession(
    tenantId: string,
    sessionId: string,
    versionId: string,
  ): Promise<void> {
    await connection.pool.query(
      `insert into fact_find_sessions (
         session_id, tenant_id, module_version_id, pseudonymous_subject_id
       ) values ($1, $2, $3, $4)`,
      [sessionId, tenantId, versionId, sha256Hex(`subject:${sessionId}`)],
    );
  }

  async function seedEvent(opts: {
    tenantId: string;
    sessionId: string;
    eventType: string;
    attrs: Record<string, unknown>;
    occurredAt: Date;
    receivedAt: Date;
    turnIndex?: number | null;
    durationMs?: number | null;
  }): Promise<string> {
    const eventId = randomUUID();
    await connection.pool.query(
      `insert into session_events (
         tenant_id, event_id, session_id, event_type, ingestion_key,
         payload_hash, attrs, occurred_at, turn_index, duration_ms,
         received_at, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$11)`,
      [
        opts.tenantId,
        eventId,
        opts.sessionId,
        opts.eventType,
        sha256Hex(`${opts.tenantId}:${eventId}`),
        sha256Hex(`payload:${eventId}`),
        JSON.stringify(opts.attrs),
        opts.occurredAt.toISOString(),
        opts.turnIndex ?? null,
        opts.durationMs ?? null,
        opts.receivedAt.toISOString(),
      ],
    );
    return eventId;
  }

  async function seedProviderUsage(opts: {
    tenantId: string;
    sessionId: string;
    costMicros: number;
    latencyMs: number;
    createdAt: Date;
  }): Promise<void> {
    await connection.pool.query(
      `insert into provider_usage (
         tenant_id, session_id, provider, model, operation,
         cost_micros, latency_ms, created_at
       ) values ($1, $2, 'openai', 'gpt', 'turn', $3, $4, $5)`,
      [opts.tenantId, opts.sessionId, opts.costMicros, opts.latencyMs, opts.createdAt.toISOString()],
    );
  }

  async function seedExtraction(opts: {
    tenantId: string;
    sessionId: string;
    fieldPath: string;
    valueClass: string;
    confidence: number;
  }): Promise<string> {
    const extractionId = randomUUID();
    await connection.pool.query(
      `insert into field_extractions (
         extraction_id, tenant_id, session_id, field_path, value_class,
         normalized_value_hash, key_version, extraction_status,
         field_policy_version, confidence
       ) values ($1,$2,$3,$4,$5,$6,1,'extracted','field-policy-v1',$7)`,
      [
        extractionId,
        opts.tenantId,
        opts.sessionId,
        opts.fieldPath,
        opts.valueClass,
        sha256Hex(`extraction:${extractionId}`),
        opts.confidence,
      ],
    );
    return extractionId;
  }

  async function seedCorrection(opts: {
    tenantId: string;
    sessionId: string;
    extractionId: string;
    changed: boolean;
  }): Promise<void> {
    const beforeHash = sha256Hex(`before:${opts.extractionId}`);
    const afterHash = opts.changed
      ? sha256Hex(`after:${opts.extractionId}`)
      : beforeHash;
    await connection.pool.query(
      `insert into adviser_corrections (
         tenant_id, session_id, extraction_id, idempotency_key, payload_hash,
         before_hash, after_hash, actor_id_pseudo, key_version,
         field_policy_version, reviewer_role, reason_code
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,1,'field-policy-v1','adviser','incorrect_value')`,
      [
        opts.tenantId,
        opts.sessionId,
        opts.extractionId,
        randomUUID(),
        sha256Hex(`payload:${randomUUID()}`),
        beforeHash,
        afterHash,
        sha256Hex(`actor:${opts.tenantId}`),
      ],
    );
  }

  async function metricRows(
    view: string,
    tenantId: string,
    metricDate: string,
  ): Promise<Map<string, MetricRow>> {
    const result = await connection.pool.query<MetricRow>(
      `select metric_name, dimension, numerator, denominator, value,
              reviewed_denominator
         from ${view}
        where tenant_id = $1 and metric_date = $2`,
      [tenantId, metricDate],
    );
    return new Map(
      result.rows.map((row) => [`${row.metric_name}|${row.dimension}`, row]),
    );
  }

  beforeAll(async () => {
    config = loadConfig();
    connection = createDatabaseConnection(config.databaseUrl);
    await waitForPostgres(connection.pool);
    runner = new MetricsRunner({ pool: connection.pool });

    await seedTenant(tenantA, "a");
    await seedTenant(tenantB, "b");
    await seedTenant(tenantC, "c");
    await seedModuleVersion(tenantA, moduleM, versionV1, "1.0.0");
    await seedModuleVersion(tenantA, moduleN, versionV2, "1.0.0");
    for (const sessionId of Object.values(sessions)) {
      await seedSession(tenantA, sessionId, versionV1);
    }

    const recv = at(10);
    // --- session lifecycle: 4 active + 1 withdrawn ---------------------------
    // s1, s2 complete; s3 abandons (with cause, exercising conditional-required
    // shape); s4 vanishes with no session.completed; s5 is withdrawn.
    const startedIds: Record<string, string> = {};
    for (const key of ["s1", "s2", "s3", "s4"] as const) {
      startedIds[key] = await seedEvent({
        tenantId: tenantA,
        sessionId: sessions[key],
        eventType: "session.started",
        attrs: { channel: "voice", source: "orchestrator" },
        occurredAt: at(9, 59),
        receivedAt: recv,
      });
    }
    reconciliationOutbox.push(startedIds.s1!, startedIds.s2!, startedIds.s3!);

    await seedEvent({
      tenantId: tenantA, sessionId: sessions.s1, eventType: "session.completed",
      attrs: { outcome: "completed", turn_count: 5 }, occurredAt: at(10), receivedAt: recv,
    });
    await seedEvent({
      tenantId: tenantA, sessionId: sessions.s2, eventType: "session.completed",
      attrs: { outcome: "completed", turn_count: 4 }, occurredAt: at(10), receivedAt: recv,
    });
    await seedEvent({
      tenantId: tenantA, sessionId: sessions.s3, eventType: "session.completed",
      attrs: { outcome: "abandoned", turn_count: 2, abandonment_cause: "non_technical" },
      occurredAt: at(10), receivedAt: recv,
    });

    // --- module segments (pinned versions) for dropoff -----------------------
    await seedEvent({
      tenantId: tenantA, sessionId: sessions.s1, eventType: "module.enter",
      attrs: { module_id: moduleM, module_version_id: versionV1 },
      occurredAt: at(9, 59, 30), receivedAt: recv, turnIndex: 0,
    });
    await seedEvent({
      tenantId: tenantA, sessionId: sessions.s2, eventType: "module.enter",
      attrs: { module_id: moduleM, module_version_id: versionV1 },
      occurredAt: at(9, 59, 30), receivedAt: recv, turnIndex: 0,
    });
    // s3 enters M (v1) then N (v2) and abandons in N: the dropoff must land on
    // v2, never v1, and never the session entry version (also v1).
    await seedEvent({
      tenantId: tenantA, sessionId: sessions.s3, eventType: "module.enter",
      attrs: { module_id: moduleM, module_version_id: versionV1 },
      occurredAt: at(9, 59, 30), receivedAt: recv, turnIndex: 0,
    });
    await seedEvent({
      tenantId: tenantA, sessionId: sessions.s3, eventType: "module.enter",
      attrs: { module_id: moduleN, module_version_id: versionV2 },
      occurredAt: at(9, 59, 45), receivedAt: recv, turnIndex: 1,
    });
    await seedEvent({
      tenantId: tenantA, sessionId: sessions.s4, eventType: "module.enter",
      attrs: { module_id: moduleM, module_version_id: versionV1 },
      occurredAt: at(9, 59, 30), receivedAt: recv, turnIndex: 0,
    });

    // --- question timing pairs on s1 -----------------------------------------
    // Valid deltas 10s and 20s; a negative and an over-30-min pair are discarded.
    const qs: Array<[string, number, number]> = [
      ["q1", 1, 10],
      ["q2", 2, 20],
      ["q3", 3, -5],
      ["q4", 4, 2000],
    ];
    for (const [questionId, turn, deltaSeconds] of qs) {
      await seedEvent({
        tenantId: tenantA, sessionId: sessions.s1, eventType: "question.prompted",
        attrs: { question_kind: "income", sequence: turn, question_id: questionId },
        occurredAt: at(10, 0, 0), receivedAt: recv, turnIndex: turn,
      });
      await seedEvent({
        tenantId: tenantA, sessionId: sessions.s1, eventType: "question.completed",
        attrs: { outcome: "answered", value_class: "provided", question_id: questionId },
        occurredAt: new Date(at(10, 0, 0).getTime() + deltaSeconds * 1000),
        receivedAt: recv, turnIndex: turn,
      });
    }

    // --- reliability: connections, one technical drop, one non-technical -----
    for (const key of ["s1", "s2", "s3"] as const) {
      await seedEvent({
        tenantId: tenantA, sessionId: sessions[key], eventType: "call.connected",
        attrs: { channel: "voice" }, occurredAt: at(9, 59), receivedAt: recv,
      });
    }
    await seedEvent({
      tenantId: tenantA, sessionId: sessions.s3, eventType: "call.hung_up",
      attrs: { cause_class: "technical", cause_detail: "network_dropout" },
      occurredAt: at(10, 1), receivedAt: recv,
    });
    // Non-technical hang-up must NOT count as a mid-call drop.
    await seedEvent({
      tenantId: tenantA, sessionId: sessions.s1, eventType: "call.hung_up",
      attrs: { cause_class: "non_technical", cause_detail: "user_ended" },
      occurredAt: at(10, 2), receivedAt: recv,
    });

    // --- provider usage (latency + cost) -------------------------------------
    for (const latencyMs of [100, 200, 300, 400, 500]) {
      await seedProviderUsage({
        tenantId: tenantA, sessionId: sessions.s1,
        costMicros: 200000, latencyMs, createdAt: recv,
      });
    }
    await seedProviderUsage({
      tenantId: tenantA, sessionId: sessions.s2,
      costMicros: 600000, latencyMs: 600, createdAt: recv,
    });

    // --- meeting booked on s1 ------------------------------------------------
    await seedEvent({
      tenantId: tenantA, sessionId: sessions.s1, eventType: "meeting.booked",
      attrs: { channel: "voice" }, occurredAt: at(10, 5), receivedAt: recv,
    });

    // --- reviews + extractions/corrections (review-gated metrics) ------------
    const reviewRecv = at(14);
    for (const key of ["s1", "s2", "s3"] as const) {
      await seedEvent({
        tenantId: tenantA, sessionId: sessions[key], eventType: "review.started",
        attrs: { reviewer_role: "adviser" }, occurredAt: at(13), receivedAt: reviewRecv,
      });
    }
    for (const key of ["s1", "s2"] as const) {
      await seedEvent({
        tenantId: tenantA, sessionId: sessions[key], eventType: "review.completed",
        attrs: { reviewer_role: "adviser", corrections_made: "some" },
        occurredAt: at(14), receivedAt: reviewRecv,
      });
    }
    await seedEvent({
      tenantId: tenantA, sessionId: sessions.s3, eventType: "review.abandoned",
      attrs: { stage: "income" }, occurredAt: at(13, 30), receivedAt: reviewRecv,
    });

    const e1 = await seedExtraction({ tenantId: tenantA, sessionId: sessions.s1, fieldPath: "finances.annual_income", valueClass: "currency", confidence: 0.9 });
    const e2 = await seedExtraction({ tenantId: tenantA, sessionId: sessions.s1, fieldPath: "finances.annual_income", valueClass: "currency", confidence: 0.6 });
    const e3 = await seedExtraction({ tenantId: tenantA, sessionId: sessions.s1, fieldPath: "risk.profile", valueClass: "categorical", confidence: 0.8 });
    const e4 = await seedExtraction({ tenantId: tenantA, sessionId: sessions.s2, fieldPath: "finances.annual_income", valueClass: "currency", confidence: 0.97 });
    const e5 = await seedExtraction({ tenantId: tenantA, sessionId: sessions.s2, fieldPath: "risk.profile", valueClass: "categorical", confidence: 0.4 });
    await seedCorrection({ tenantId: tenantA, sessionId: sessions.s1, extractionId: e1, changed: true });
    await seedCorrection({ tenantId: tenantA, sessionId: sessions.s1, extractionId: e3, changed: true });
    // An unchanged "confirm" correction on e2 must NOT count as a correction.
    await seedCorrection({ tenantId: tenantA, sessionId: sessions.s1, extractionId: e2, changed: false });
    void e4; void e5;

    // --- withdrawn subject s5 (must be excluded everywhere) ------------------
    await seedEvent({
      tenantId: tenantA, sessionId: sessions.s5withdrawn, eventType: "session.started",
      attrs: { channel: "voice", source: "orchestrator" }, occurredAt: at(9, 59), receivedAt: recv,
    });
    await seedEvent({
      tenantId: tenantA, sessionId: sessions.s5withdrawn, eventType: "session.completed",
      attrs: { outcome: "completed", turn_count: 3 }, occurredAt: at(10), receivedAt: recv,
    });
    await connection.pool.query(
      `insert into subject_metric_exclusions (
         tenant_id, pseudonymous_subject_id, key_version, reason
       ) values ($1, $2, 1, 'consent_withdrawal')`,
      [tenantA, sha256Hex(`subject:${sessions.s5withdrawn}`)],
    );

    // --- reconciliation outbox rows (all delivered initially) ----------------
    for (const eventId of reconciliationOutbox) {
      const outboxId = randomUUID();
      await connection.pool.query(
        `insert into telemetry_outbox (
           outbox_id, tenant_id, event_id, config_version,
           posthog_delivered_at, otel_delivered_at, processed_at, next_attempt_at
         ) values ($1, $2, $3, 'telemetry-events-v5', $4, $4, $4, $4)`,
        [outboxId, tenantA, eventId, recv.toISOString()],
      );
    }

    // --- tenant B isolation control ------------------------------------------
    const bModule = randomUUID();
    const bVersion = randomUUID();
    const bSession = randomUUID();
    await seedModuleVersion(tenantB, bModule, bVersion, "1.0.0");
    await seedSession(tenantB, bSession, bVersion);
    await seedEvent({
      tenantId: tenantB, sessionId: bSession, eventType: "session.started",
      attrs: { channel: "voice", source: "orchestrator" }, occurredAt: at(9, 59), receivedAt: recv,
    });
    await seedEvent({
      tenantId: tenantB, sessionId: bSession, eventType: "session.completed",
      attrs: { outcome: "completed", turn_count: 6 }, occurredAt: at(10), receivedAt: recv,
    });

    // --- tenant C cost-drift baseline + spike --------------------------------
    const cModule = randomUUID();
    const cVersion = randomUUID();
    await seedModuleVersion(tenantC, cModule, cVersion, "1.0.0");
    for (const k of [1, 2, 3]) {
      const cSession = randomUUID();
      await seedSession(tenantC, cSession, cVersion);
      await seedEvent({
        tenantId: tenantC, sessionId: cSession, eventType: "session.completed",
        attrs: { outcome: "completed", turn_count: 5 },
        occurredAt: dayOffset(k), receivedAt: dayOffset(k),
      });
      await seedProviderUsage({
        tenantId: tenantC, sessionId: cSession, costMicros: 100000, latencyMs: 200, createdAt: dayOffset(k),
      });
    }
    const cSpike = randomUUID();
    await seedSession(tenantC, cSpike, cVersion);
    await seedEvent({
      tenantId: tenantC, sessionId: cSpike, eventType: "session.completed",
      attrs: { outcome: "completed", turn_count: 5 }, occurredAt: at(10), receivedAt: at(10),
    });
    await seedProviderUsage({
      tenantId: tenantC, sessionId: cSpike, costMicros: 200000, latencyMs: 200, createdAt: at(10),
    });
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  it("loads the pinned thresholds and the v5 catalog", () => {
    const thresholds = loadThresholds();
    expect(thresholds.version).toBe("thresholds-v1");
    expect(thresholds.reliability.connection_success_warn_below).toBe(0.98);
    expect(loadEventCatalogRegistry().current.version).toBe("telemetry-events-v8");
  });

  it("completion_rate counts sessions with a session.completed event over starts", async () => {
    // Starts s1..s4 (s5 withdrawn is excluded). session.completed present for
    // s1, s2, s3 (abandoned still emits the event); s4 vanished. => 3/4.
    const rows = await metricRows("metrics_completion_daily", tenantA, D);
    const completion = rows.get("completion_rate|");
    expect(completion).toMatchObject({ numerator: 3, denominator: 4, value: 0.75 });
  });

  it("dropoff_rate_by_module attributes the drop to the pinned segment version", async () => {
    const rows = await metricRows("metrics_dropoff_by_module_daily", tenantA, D);
    // v1: 4 segments entered (s1,s2,s3,s4 all enter M@v1); only s4's is the
    // session's last segment AND abandoned => 1/4.
    expect(rows.get(`dropoff_rate_by_module|${versionV1}`)).toMatchObject({
      numerator: 1, denominator: 4, value: 0.25,
    });
    // v2: s3's N segment is its last and the session abandoned => 1/1. The drop
    // lands on v2 even though every session's entry version is v1.
    expect(rows.get(`dropoff_rate_by_module|${versionV2}`)).toMatchObject({
      numerator: 1, denominator: 1, value: 1,
    });
  });

  it("median_question_time discards out-of-range pairs and counts them separately", async () => {
    const rows = await metricRows("metrics_question_time_daily", tenantA, D);
    // Valid deltas {10000, 20000} ms -> median 15000; -5s and +2000s discarded.
    expect(rows.get("median_question_time|")).toMatchObject({
      numerator: 2, denominator: 2, value: 15000,
    });
    expect(rows.get("question_time_discarded|")).toMatchObject({
      numerator: 2, denominator: 4, value: 2,
    });
  });

  it("correction_rate_by_field is review-gated and counts only value changes", async () => {
    const rows = await metricRows("metrics_correction_rate_by_field_daily", tenantA, D);
    // Reviewed sessions s1, s2. income extractions e1(changed), e2(unchanged),
    // e4 => 1/3. risk extractions e3(changed), e5 => 1/2.
    const income = rows.get("correction_rate_by_field|finances.annual_income");
    expect(income?.numerator).toBe(1);
    expect(income?.denominator).toBe(3);
    expect(income?.reviewed_denominator).toBe(3);
    expect(income?.value).toBeCloseTo(1 / 3, 10);
    expect(rows.get("correction_rate_by_field|risk.profile")).toMatchObject({
      numerator: 1, denominator: 2, value: 0.5, reviewed_denominator: 2,
    });
  });

  it("calibration buckets approvals on the fixed confidence edges", async () => {
    const rows = await metricRows("metrics_calibration_daily", tenantA, D);
    // e5=0.40 approved, e2=0.60 approved, e3=0.80 corrected, e1=0.90 corrected,
    // e4=0.97 approved.
    expect(rows.get("calibration_approval_rate|0.0-0.5")).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    expect(rows.get("calibration_approval_rate|0.5-0.7")).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    expect(rows.get("calibration_approval_rate|0.7-0.85")).toMatchObject({ numerator: 0, denominator: 1, value: 0 });
    expect(rows.get("calibration_approval_rate|0.85-0.95")).toMatchObject({ numerator: 0, denominator: 1, value: 0 });
    expect(rows.get("calibration_approval_rate|0.95-1.0")).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
  });

  it("reliability computes connection, technical drop, and p95 latency", async () => {
    const rows = await metricRows("metrics_reliability_daily", tenantA, D);
    // 3 of 4 started sessions connected.
    expect(rows.get("connection_success_rate|")).toMatchObject({ numerator: 3, denominator: 4, value: 0.75 });
    // 1 technical drop / 3 connected (the non-technical hang-up is excluded).
    const drop = rows.get("mid_call_drop_rate|");
    expect(drop?.numerator).toBe(1);
    expect(drop?.denominator).toBe(3);
    expect(drop?.value).toBeCloseTo(1 / 3, 10);
    // p95 over latencies [100,200,300,400,500,600] via percentile_cont.
    expect(rows.get("turn_latency_p95_ms|")).toMatchObject({ numerator: 6, value: 575 });
  });

  it("adviser adoption computes turnaround, % reviewed, and abandoned reviews", async () => {
    const rows = await metricRows("metrics_adviser_adoption_daily", tenantA, D);
    // s1, s2 reviewed 4h after completion => median 14,400,000 ms.
    expect(rows.get("review_turnaround_median_ms|")).toMatchObject({ numerator: 2, value: 14_400_000 });
    // Completed sessions s1,s2,s3; s1,s2 reviewed within 7 days => 2/3.
    const within7 = rows.get("pct_reviewed_within_7d|");
    expect(within7?.numerator).toBe(2);
    expect(within7?.denominator).toBe(3);
    expect(within7?.value).toBeCloseTo(2 / 3, 10);
    const reviewed = rows.get("pct_reviewed|");
    expect(reviewed?.numerator).toBe(2);
    expect(reviewed?.denominator).toBe(3);
    expect(reviewed?.value).toBeCloseTo(2 / 3, 10);
    // One review.abandoned (s3) over 3 review.started + 1 abandoned = 4.
    expect(rows.get("reviews_abandoned|")).toMatchObject({ numerator: 1, denominator: 4, value: 1 });
  });

  it("unit economics computes cost per completed fact-find, per booked meeting, per tenant-day", async () => {
    const rows = await metricRows("metrics_unit_economics_daily", tenantA, D);
    // Completed s1(1,000,000) + s2(600,000) = 1,600,000 over 2 => 800,000.
    expect(rows.get("cost_per_completed_factfind|")).toMatchObject({
      numerator: 1_600_000, denominator: 2, value: 800_000,
    });
    // Only s1 booked; its total cost 1,000,000 over 1 meeting.
    expect(rows.get("cost_per_booked_meeting|")).toMatchObject({
      numerator: 1_000_000, denominator: 1, value: 1_000_000,
    });
    // Whole-tenant provider spend for the day.
    expect(rows.get("tenant_daily_cost_micros|")).toMatchObject({ value: 1_600_000 });
  });

  it("excludes withdrawn subjects and isolates tenants", async () => {
    // s5 (withdrawn) started + completed but must not inflate tenant A's counts:
    // completion stayed 4 starts, not 5.
    const aRows = await metricRows("metrics_completion_daily", tenantA, D);
    expect(aRows.get("completion_rate|")?.denominator).toBe(4);
    // Tenant B sees only its own single completed session.
    const bRows = await metricRows("metrics_completion_daily", tenantB, D);
    expect(bRows.get("completion_rate|")).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
  });

  it("materializes every metric view and raises reliability alerts in one run", async () => {
    const summary = await runner.runDay(D, tenantA);
    expect(summary.snapshotCount).toBeGreaterThan(0);

    // The run wrote snapshots for every metric family.
    const names = await connection.pool.query<{ metric_name: string }>(
      `select distinct metric_name from metric_daily_snapshots
        where run_id = $1 order by metric_name`,
      [summary.runId],
    );
    expect(names.rows.map((row) => row.metric_name)).toEqual([
      "calibration_approval_rate",
      "completion_rate",
      "correction_rate_by_field",
      "cost_per_booked_meeting",
      "cost_per_completed_factfind",
      "dropoff_rate_by_module",
      "ledger_vs_posthog_divergence",
      "median_question_time",
      "mid_call_drop_rate",
      "pct_reviewed",
      "pct_reviewed_within_7d",
      "connection_success_rate",
      "question_time_discarded",
      "review_turnaround_median_ms",
      "reviews_abandoned",
      "tenant_daily_cost_micros",
      "turn_latency_p95_ms",
    ].sort());

    // connection_success_rate 0.75 < 0.98 and mid_call_drop_rate 0.33 > 0.05.
    const alerts = await connection.pool.query<{ alert_type: string; severity: string }>(
      `select alert_type, severity from metric_alerts
        where run_id = $1 order by alert_type`,
      [summary.runId],
    );
    expect(alerts.rows).toEqual([
      { alert_type: "connection_success_below_threshold", severity: "critical" },
      { alert_type: "drop_rate_above_threshold", severity: "critical" },
    ]);
  });

  it("re-runs a day idempotently without duplicating snapshots or alerts", async () => {
    const first = await runner.runDay(D, tenantA);
    const second = await runner.runDay(D, tenantA);
    expect(second.snapshotCount).toBe(first.snapshotCount);

    const snapshotCount = await connection.pool.query<{ count: number }>(
      `select count(*)::int as count from metric_daily_snapshots
        where tenant_id = $1 and metric_date = $2`,
      [tenantA, D],
    );
    expect(snapshotCount.rows[0]?.count).toBe(second.snapshotCount);
    // Only the latest run's rows survive the delete-and-rebuild.
    const owners = await connection.pool.query<{ count: number }>(
      `select count(distinct run_id)::int as count from metric_daily_snapshots
        where tenant_id = $1 and metric_date = $2`,
      [tenantA, D],
    );
    expect(owners.rows[0]?.count).toBe(1);
  });

  it("reconciliation detects an injected PostHog delivery gap", async () => {
    // All three forwardable events are delivered: divergence 0, no alert.
    const before = await metricRows("metrics_reconciliation_daily", tenantA, D);
    expect(before.get("ledger_vs_posthog_divergence|")).toMatchObject({
      numerator: 0, denominator: 3, value: 0,
    });
    const cleanRun = await runner.runDay(D, tenantA);
    const cleanAlert = await connection.pool.query<{ count: number }>(
      `select count(*)::int as count from metric_alerts
        where run_id = $1 and alert_type = 'reconciliation_divergence'`,
      [cleanRun.runId],
    );
    expect(cleanAlert.rows[0]?.count).toBe(0);

    // Inject a gap: one forwardable event never reached PostHog.
    await connection.pool.query(
      `update telemetry_outbox
          set posthog_delivered_at = null, processed_at = null
        where tenant_id = $1 and event_id = $2`,
      [tenantA, reconciliationOutbox[0]],
    );

    const after = await metricRows("metrics_reconciliation_daily", tenantA, D);
    const diverged = after.get("ledger_vs_posthog_divergence|");
    expect(diverged?.numerator).toBe(1);
    expect(diverged?.denominator).toBe(3);
    expect(diverged?.value).toBeCloseTo(1 / 3, 10);

    const gapRun = await runner.runDay(D, tenantA);
    const gapAlert = await connection.pool.query<{
      observed_value: number; threshold_value: number; severity: string;
    }>(
      `select observed_value, threshold_value, severity from metric_alerts
        where run_id = $1 and alert_type = 'reconciliation_divergence'`,
      [gapRun.runId],
    );
    expect(gapAlert.rows).toHaveLength(1);
    expect(gapAlert.rows[0]?.observed_value).toBeCloseTo(1 / 3, 10);
    expect(gapAlert.rows[0]?.threshold_value).toBe(0.02);
    expect(gapAlert.rows[0]?.severity).toBe("warning");
  });

  it("raises a cost-per-session drift alert against the trailing baseline", async () => {
    // Baseline days (D-1..D-3) each cost 100,000/completed; day D spikes to
    // 200,000 > 1.5 x 100,000. Baseline has >= 3 days so the guard fires.
    const summary = await runner.runDay(D, tenantC);
    const alert = await connection.pool.query<{
      observed_value: number; threshold_value: number; severity: string;
    }>(
      `select observed_value, threshold_value, severity from metric_alerts
        where run_id = $1 and alert_type = 'cost_per_session_drift'`,
      [summary.runId],
    );
    expect(alert.rows).toHaveLength(1);
    expect(alert.rows[0]?.observed_value).toBe(200_000);
    expect(alert.rows[0]?.threshold_value).toBe(150_000);
    expect(alert.rows[0]?.severity).toBe("warning");

    // A baseline day itself has too little history to fire.
    const baselineRun = await runner.runDay(utcDateString(dayOffset(1)), tenantC);
    const baselineAlert = await connection.pool.query<{ count: number }>(
      `select count(*)::int as count from metric_alerts
        where run_id = $1 and alert_type = 'cost_per_session_drift'`,
      [baselineRun.runId],
    );
    expect(baselineAlert.rows[0]?.count).toBe(0);
  });
});
