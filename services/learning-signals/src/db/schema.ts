import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const defaultRetentionPolicyId = "00000000-0000-4000-8000-000000000001";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow();

export const retentionPolicies = pgTable(
  "retention_policies",
  {
    retentionPolicyId: uuid("retention_policy_id").defaultRandom().primaryKey(),
    policyKey: text("policy_key").notNull(),
    name: text("name").notNull(),
    sessionRetentionDays: integer("session_retention_days").notNull(),
    eventRetentionDays: integer("event_retention_days").notNull(),
    documentRetentionDays: integer("document_retention_days").notNull(),
    pseudonymousTelemetryDays: integer("pseudonymous_telemetry_days").notNull(),
    operationalPayloadDays: integer("operational_payload_days").notNull(),
    consentLedgerDays: integer("consent_ledger_days").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("retention_policies_policy_key_unique").on(table.policyKey),
    check(
      "retention_policies_session_days_check",
      sql`${table.sessionRetentionDays} between 1 and 3650`,
    ),
    check(
      "retention_policies_event_days_check",
      sql`${table.eventRetentionDays} between 1 and 3650`,
    ),
    check(
      "retention_policies_document_days_check",
      sql`${table.documentRetentionDays} between 1 and 3650`,
    ),
    check(
      "retention_policies_pseudonymous_telemetry_days_check",
      sql`${table.pseudonymousTelemetryDays} between 1 and 3650`,
    ),
    check(
      "retention_policies_operational_payload_days_check",
      sql`${table.operationalPayloadDays} between 1 and 3650`,
    ),
    check(
      "retention_policies_consent_ledger_days_check",
      sql`${table.consentLedgerDays} between 1 and 3650`,
    ),
  ],
);

export const tenants = pgTable(
  "tenants",
  {
    tenantId: uuid("tenant_id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    retentionPolicyId: uuid("retention_policy_id")
      .notNull()
      .default(sql`'${sql.raw(defaultRetentionPolicyId)}'::uuid`),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
  },
  (table) => [
    unique("tenants_slug_unique").on(table.slug),
    foreignKey({
      name: "tenants_retention_policy_fk",
      columns: [table.retentionPolicyId],
      foreignColumns: [retentionPolicies.retentionPolicyId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    check("tenants_slug_check", sql`length(btrim(${table.slug})) > 0`),
    check("tenants_display_name_check", sql`length(btrim(${table.displayName})) > 0`),
    check(
      "tenants_status_check",
      sql`${table.status} in ('active', 'suspended', 'closed')`,
    ),
    index("tenants_retention_policy_idx").on(table.retentionPolicyId),
  ],
);

export const moduleVersions = pgTable(
  "module_versions",
  {
    moduleVersionId: uuid("module_version_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    moduleId: uuid("module_id").notNull(),
    semanticVersion: text("semantic_version").notNull(),
    status: text("status").notNull().default("draft"),
    moduleBodyJsonb: jsonb("module_body_jsonb").notNull(),
    contentHash: text("content_hash").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => [
    unique("module_versions_tenant_version_id_unique").on(
      table.tenantId,
      table.moduleVersionId,
    ),
    unique("module_versions_tenant_module_semver_unique").on(
      table.tenantId,
      table.moduleId,
      table.semanticVersion,
    ),
    foreignKey({
      name: "module_versions_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [tenants.tenantId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    check(
      "module_versions_semantic_version_check",
      sql`length(btrim(${table.semanticVersion})) > 0`,
    ),
    check(
      "module_versions_status_check",
      sql`${table.status} in ('draft', 'published', 'retired')`,
    ),
    check(
      "module_versions_body_object_check",
      sql`jsonb_typeof(${table.moduleBodyJsonb}) = 'object'`,
    ),
    check(
      "module_versions_content_hash_check",
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "module_versions_published_at_check",
      sql`(${table.status} = 'draft' and ${table.publishedAt} is null) or (${table.status} in ('published', 'retired') and ${table.publishedAt} is not null)`,
    ),
    index("module_versions_tenant_module_status_idx").on(
      table.tenantId,
      table.moduleId,
      table.status,
    ),
  ],
);

export const factFindSessions = pgTable(
  "fact_find_sessions",
  {
    sessionId: uuid("session_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    moduleVersionId: uuid("module_version_id").notNull(),
    pseudonymousSubjectId: text("pseudonymous_subject_id").notNull(),
    keyVersion: smallint("key_version").notNull().default(1),
    status: text("status").notNull().default("started"),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => [
    unique("fact_find_sessions_tenant_session_unique").on(
      table.tenantId,
      table.sessionId,
    ),
    foreignKey({
      name: "fact_find_sessions_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [tenants.tenantId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    foreignKey({
      name: "fact_find_sessions_module_version_fk",
      columns: [table.tenantId, table.moduleVersionId],
      foreignColumns: [moduleVersions.tenantId, moduleVersions.moduleVersionId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    check(
      "fact_find_sessions_subject_hash_check",
      sql`${table.pseudonymousSubjectId} ~ '^[0-9a-f]{64}$'`,
    ),
    check("fact_find_sessions_key_version_check", sql`${table.keyVersion} > 0`),
    check(
      "fact_find_sessions_status_check",
      sql`${table.status} in ('started', 'completed', 'abandoned', 'failed')`,
    ),
    check(
      "fact_find_sessions_completed_at_check",
      sql`(${table.status} = 'started' and ${table.completedAt} is null) or (${table.status} <> 'started' and ${table.completedAt} is not null)`,
    ),
    index("fact_find_sessions_tenant_module_version_idx").on(
      table.tenantId,
      table.moduleVersionId,
    ),
    index("fact_find_sessions_tenant_subject_idx").on(
      table.tenantId,
      table.pseudonymousSubjectId,
    ),
    index("fact_find_sessions_tenant_created_at_idx").on(
      table.tenantId,
      table.createdAt,
    ),
  ],
);

export const sessionEvents = pgTable(
  "session_events",
  {
    tenantId: uuid("tenant_id").notNull(),
    eventId: uuid("event_id").defaultRandom().notNull(),
    sessionId: uuid("session_id").notNull(),
    eventType: text("event_type").notNull(),
    ingestionKey: text("ingestion_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    attrs: jsonb("attrs").notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
    turnIndex: integer("turn_index"),
    durationMs: integer("duration_ms"),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "session_events_pk",
      columns: [table.tenantId, table.eventId],
    }),
    unique("session_events_tenant_ingestion_key_unique").on(
      table.tenantId,
      table.ingestionKey,
    ),
    foreignKey({
      name: "session_events_session_fk",
      columns: [table.tenantId, table.sessionId],
      foreignColumns: [factFindSessions.tenantId, factFindSessions.sessionId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    check("session_events_event_type_check", sql`length(btrim(${table.eventType})) > 0`),
    check(
      "session_events_ingestion_key_check",
      sql`${table.ingestionKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "session_events_ingestion_key_derived_check",
      sql`${table.ingestionKey} = encode(sha256(convert_to(${table.tenantId}::text || ':' || ${table.eventId}::text, 'UTF8')), 'hex')`,
    ),
    check(
      "session_events_payload_hash_check",
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check("session_events_attrs_object_check", sql`jsonb_typeof(${table.attrs}) = 'object'`),
    check(
      "session_events_attrs_size_check",
      sql`octet_length(${table.attrs}::text) <= 4096`,
    ),
    check(
      "session_events_turn_index_check",
      sql`${table.turnIndex} is null or ${table.turnIndex} >= 0`,
    ),
    check(
      "session_events_duration_ms_check",
      sql`${table.durationMs} is null or ${table.durationMs} >= 0`,
    ),
    index("session_events_tenant_session_order_idx").on(
      table.tenantId,
      table.sessionId,
      table.occurredAt,
      table.turnIndex,
    ),
    index("session_events_tenant_type_received_idx").on(
      table.tenantId,
      table.eventType,
      table.receivedAt,
    ),
    index("session_events_received_at_idx").on(table.receivedAt),
    index("session_events_created_at_idx").on(table.createdAt),
  ],
);

export const telemetryOutbox = pgTable(
  "telemetry_outbox",
  {
    outboxId: uuid("outbox_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    eventId: uuid("event_id").notNull(),
    configVersion: text("config_version").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    posthogDeliveredAt: timestamp("posthog_delivered_at", {
      withTimezone: true,
      mode: "date",
    }),
    otelDeliveredAt: timestamp("otel_delivered_at", {
      withTimezone: true,
      mode: "date",
    }),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    suppressedAt: timestamp("suppressed_at", { withTimezone: true, mode: "date" }),
    suppressionReason: text("suppression_reason"),
    lastFailureCode: text("last_failure_code"),
    createdAt: createdAt(),
  },
  (table) => [
    unique("telemetry_outbox_tenant_event_unique").on(table.tenantId, table.eventId),
    foreignKey({
      name: "telemetry_outbox_event_fk",
      columns: [table.tenantId, table.eventId],
      foreignColumns: [sessionEvents.tenantId, sessionEvents.eventId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    check(
      "telemetry_outbox_config_version_check",
      sql`length(btrim(${table.configVersion})) > 0`,
    ),
    check("telemetry_outbox_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check(
      "telemetry_outbox_failure_code_check",
      sql`${table.lastFailureCode} is null or ${table.lastFailureCode} = 'sink_delivery_failed'`,
    ),
    check(
      "telemetry_outbox_processed_check",
      sql`(${table.processedAt} is null and ${table.suppressedAt} is null and (${table.posthogDeliveredAt} is null or ${table.otelDeliveredAt} is null)) or (${table.processedAt} is not null and (${table.suppressedAt} is not null or (${table.posthogDeliveredAt} is not null and ${table.otelDeliveredAt} is not null)))`,
    ),
    check(
      "telemetry_outbox_suppression_check",
      sql`(${table.suppressedAt} is null and ${table.suppressionReason} is null) or (${table.suppressedAt} is not null and ${table.suppressionReason} in ('consent_not_granted', 'withdrawn', 'unclassified_event', 'purpose_limited'))`,
    ),
    index("telemetry_outbox_pending_idx")
      .on(table.nextAttemptAt, table.createdAt, table.outboxId)
      .where(sql`${table.processedAt} is null`),
  ],
);

export const providerUsage = pgTable(
  "provider_usage",
  {
    usageId: uuid("usage_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    operation: text("operation").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    audioInputMs: integer("audio_input_ms").notNull().default(0),
    audioOutputMs: integer("audio_output_ms").notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    latencyMs: integer("latency_ms").notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "provider_usage_session_fk",
      columns: [table.tenantId, table.sessionId],
      foreignColumns: [factFindSessions.tenantId, factFindSessions.sessionId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    check("provider_usage_provider_check", sql`length(btrim(${table.provider})) > 0`),
    check("provider_usage_model_check", sql`length(btrim(${table.model})) > 0`),
    check("provider_usage_operation_check", sql`length(btrim(${table.operation})) > 0`),
    check(
      "provider_usage_nonnegative_check",
      sql`${table.inputTokens} >= 0 and ${table.outputTokens} >= 0 and ${table.cachedInputTokens} >= 0 and ${table.audioInputMs} >= 0 and ${table.audioOutputMs} >= 0 and ${table.costMicros} >= 0 and ${table.latencyMs} >= 0`,
    ),
    index("provider_usage_tenant_session_idx").on(table.tenantId, table.sessionId),
    index("provider_usage_tenant_provider_model_created_idx").on(
      table.tenantId,
      table.provider,
      table.model,
      table.createdAt,
    ),
  ],
);

export const fieldExtractions = pgTable(
  "field_extractions",
  {
    extractionId: uuid("extraction_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    sourceEventId: uuid("source_event_id"),
    fieldPath: text("field_path").notNull(),
    valueClass: text("value_class").notNull(),
    normalizedValueHash: text("normalized_value_hash").notNull(),
    normalizedValuePreview: text("normalized_value_preview"),
    keyVersion: smallint("key_version").notNull().default(1),
    extractionStatus: text("extraction_status").notNull().default("extracted"),
    fieldPolicyVersion: text("field_policy_version").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4, mode: "number" }),
    createdAt: createdAt(),
  },
  (table) => [
    unique("field_extractions_tenant_extraction_unique").on(
      table.tenantId,
      table.extractionId,
    ),
    unique("field_extractions_tenant_session_extraction_unique").on(
      table.tenantId,
      table.sessionId,
      table.extractionId,
    ),
    foreignKey({
      name: "field_extractions_session_fk",
      columns: [table.tenantId, table.sessionId],
      foreignColumns: [factFindSessions.tenantId, factFindSessions.sessionId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    foreignKey({
      name: "field_extractions_source_event_fk",
      columns: [table.tenantId, table.sourceEventId],
      foreignColumns: [sessionEvents.tenantId, sessionEvents.eventId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    check("field_extractions_field_path_check", sql`length(btrim(${table.fieldPath})) > 0`),
    check("field_extractions_value_class_check", sql`length(btrim(${table.valueClass})) > 0`),
    check(
      "field_extractions_value_hash_check",
      sql`${table.normalizedValueHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "field_extractions_normalized_value_preview_length_check",
      sql`${table.normalizedValuePreview} is null or char_length(${table.normalizedValuePreview}) between 1 and 64`,
    ),
    check("field_extractions_key_version_check", sql`${table.keyVersion} > 0`),
    check(
      "field_extractions_extraction_status_check",
      sql`${table.extractionStatus} in ('extracted', 'corrected')`,
    ),
    check(
      "field_extractions_field_policy_version_check",
      sql`length(btrim(${table.fieldPolicyVersion})) > 0`,
    ),
    check(
      "field_extractions_confidence_check",
      sql`${table.confidence} is null or (${table.confidence} >= 0 and ${table.confidence} <= 1)`,
    ),
    index("field_extractions_tenant_session_idx").on(table.tenantId, table.sessionId),
    index("field_extractions_tenant_source_event_idx").on(
      table.tenantId,
      table.sourceEventId,
    ),
    index("field_extractions_tenant_field_created_idx").on(
      table.tenantId,
      table.fieldPath,
      table.createdAt,
    ),
  ],
);

export const adviserCorrections = pgTable(
  "adviser_corrections",
  {
    correctionId: uuid("correction_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    extractionId: uuid("extraction_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    beforeHash: text("before_hash").notNull(),
    afterHash: text("after_hash").notNull(),
    beforePreview: text("before_preview"),
    afterPreview: text("after_preview"),
    actorIdPseudo: text("actor_id_pseudo").notNull(),
    keyVersion: smallint("key_version").notNull().default(1),
    fieldPolicyVersion: text("field_policy_version").notNull(),
    reviewerRole: text("reviewer_role").notNull(),
    reasonCode: text("reason_code"),
    createdAt: createdAt(),
  },
  (table) => [
    unique("adviser_corrections_tenant_idempotency_unique").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "adviser_corrections_session_fk",
      columns: [table.tenantId, table.sessionId],
      foreignColumns: [factFindSessions.tenantId, factFindSessions.sessionId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    foreignKey({
      name: "adviser_corrections_extraction_fk",
      columns: [table.tenantId, table.extractionId],
      foreignColumns: [fieldExtractions.tenantId, fieldExtractions.extractionId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    foreignKey({
      name: "adviser_corrections_session_extraction_fk",
      columns: [table.tenantId, table.sessionId, table.extractionId],
      foreignColumns: [
        fieldExtractions.tenantId,
        fieldExtractions.sessionId,
        fieldExtractions.extractionId,
      ],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    check(
      "adviser_corrections_idempotency_key_check",
      sql`length(btrim(${table.idempotencyKey})) > 0`,
    ),
    check(
      "adviser_corrections_payload_hash_check",
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "adviser_corrections_before_hash_check",
      sql`${table.beforeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "adviser_corrections_after_hash_check",
      sql`${table.afterHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "adviser_corrections_before_preview_length_check",
      sql`${table.beforePreview} is null or char_length(${table.beforePreview}) between 1 and 64`,
    ),
    check(
      "adviser_corrections_after_preview_length_check",
      sql`${table.afterPreview} is null or char_length(${table.afterPreview}) between 1 and 64`,
    ),
    check(
      "adviser_corrections_actor_hash_check",
      sql`${table.actorIdPseudo} ~ '^[0-9a-f]{64}$'`,
    ),
    check("adviser_corrections_key_version_check", sql`${table.keyVersion} > 0`),
    check(
      "adviser_corrections_field_policy_version_check",
      sql`length(btrim(${table.fieldPolicyVersion})) > 0`,
    ),
    check(
      "adviser_corrections_reviewer_role_check",
      sql`length(btrim(${table.reviewerRole})) > 0`,
    ),
    check(
      "adviser_corrections_reason_code_check",
      sql`${table.reasonCode} is null or ${table.reasonCode} in ('incorrect_value', 'missing_value', 'misclassified', 'formatting', 'other')`,
    ),
    index("adviser_corrections_tenant_extraction_idx").on(
      table.tenantId,
      table.extractionId,
    ),
    index("adviser_corrections_tenant_session_idx").on(
      table.tenantId,
      table.sessionId,
    ),
    index("adviser_corrections_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
    ),
  ],
);

export const consentLedger = pgTable(
  "consent_ledger",
  {
    consentId: uuid("consent_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    purpose: text("purpose").notNull(),
    action: text("action").notNull(),
    policyVersion: text("policy_version").notNull(),
    noticeId: text("notice_id").notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
    decisionTs: timestamp("decision_ts", { withTimezone: true, mode: "date" }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "consent_ledger_session_fk",
      columns: [table.tenantId, table.sessionId],
      foreignColumns: [factFindSessions.tenantId, factFindSessions.sessionId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    check("consent_ledger_purpose_check", sql`length(btrim(${table.purpose})) > 0`),
    check(
      "consent_ledger_purpose_allowlist_check",
      sql`${table.purpose} in ('service_improvement_telemetry', 'partner_benchmarking', 'optional_demographics', 'marketing_referral')`,
    ),
    check(
      "consent_ledger_action_check",
      sql`${table.action} in ('granted', 'withdrawn', 'denied')`,
    ),
    check(
      "consent_ledger_policy_version_check",
      sql`length(btrim(${table.policyVersion})) > 0`,
    ),
    check("consent_ledger_notice_id_check", sql`length(btrim(${table.noticeId})) > 0`),
    check(
      "consent_ledger_evidence_hash_check",
      sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`,
    ),
    index("consent_ledger_tenant_session_created_idx").on(
      table.tenantId,
      table.sessionId,
      table.createdAt,
    ),
    index("consent_ledger_tenant_purpose_created_idx").on(
      table.tenantId,
      table.purpose,
      table.createdAt,
    ),
    index("consent_ledger_current_state_idx").on(
      table.tenantId,
      table.sessionId,
      table.purpose,
      table.decisionTs,
      table.receivedAt,
      table.consentId,
    ),
    index("consent_ledger_tenant_created_at_idx").on(
      table.tenantId,
      table.createdAt,
    ),
  ],
);

export const documentEvents = pgTable(
  "document_events",
  {
    documentEventId: uuid("document_event_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    documentIdHash: text("document_id_hash").notNull(),
    documentType: text("document_type").notNull(),
    eventType: text("event_type").notNull(),
    attrs: jsonb("attrs").notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "document_events_session_fk",
      columns: [table.tenantId, table.sessionId],
      foreignColumns: [factFindSessions.tenantId, factFindSessions.sessionId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    check(
      "document_events_document_hash_check",
      sql`${table.documentIdHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "document_events_document_type_check",
      sql`length(btrim(${table.documentType})) > 0`,
    ),
    check("document_events_event_type_check", sql`length(btrim(${table.eventType})) > 0`),
    check("document_events_attrs_object_check", sql`jsonb_typeof(${table.attrs}) = 'object'`),
    check(
      "document_events_attrs_size_check",
      sql`octet_length(${table.attrs}::text) <= 4096`,
    ),
    index("document_events_tenant_session_created_idx").on(
      table.tenantId,
      table.sessionId,
      table.createdAt,
    ),
    index("document_events_tenant_document_created_idx").on(
      table.tenantId,
      table.documentIdHash,
      table.createdAt,
    ),
  ],
);

export const partnerExportBatches = pgTable(
  "partner_export_batches",
  {
    exportBatchId: uuid("export_batch_id").defaultRandom().primaryKey(),
    partnerCode: text("partner_code").notNull(),
    cohortKey: text("cohort_key").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true, mode: "date" }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true, mode: "date" }).notNull(),
    status: text("status").notNull().default("pending"),
    userCount: integer("user_count").notNull().default(0),
    tenantCount: integer("tenant_count").notNull().default(0),
    maxTenantShare: numeric("max_tenant_share", {
      precision: 5,
      scale: 4,
      mode: "number",
    })
      .notNull()
      .default(0),
    readyAt: timestamp("ready_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => [
    unique("partner_export_batches_window_unique").on(
      table.partnerCode,
      table.cohortKey,
      table.periodStart,
      table.periodEnd,
    ),
    check(
      "partner_export_batches_partner_code_check",
      sql`length(btrim(${table.partnerCode})) > 0`,
    ),
    check(
      "partner_export_batches_cohort_key_check",
      sql`length(btrim(${table.cohortKey})) > 0`,
    ),
    check(
      "partner_export_batches_period_check",
      sql`${table.periodEnd} > ${table.periodStart}`,
    ),
    check(
      "partner_export_batches_status_check",
      sql`${table.status} in ('pending', 'suppressed', 'ready', 'failed')`,
    ),
    check(
      "partner_export_batches_counts_check",
      sql`${table.userCount} >= 0 and ${table.tenantCount} >= 0`,
    ),
    check(
      "partner_export_batches_share_check",
      sql`${table.maxTenantShare} >= 0 and ${table.maxTenantShare} <= 1`,
    ),
    check(
      "partner_export_batches_release_gate_check",
      sql`${table.status} <> 'ready' or (${table.userCount} >= 30 and ${table.tenantCount} >= 3 and ${table.maxTenantShare} <= 0.8)`,
    ),
    check(
      "partner_export_batches_ready_at_check",
      sql`(${table.status} = 'ready' and ${table.readyAt} is not null) or (${table.status} <> 'ready' and ${table.readyAt} is null)`,
    ),
    index("partner_export_batches_status_period_idx").on(
      table.status,
      table.periodStart,
      table.periodEnd,
    ),
    index("partner_export_batches_partner_created_idx").on(
      table.partnerCode,
      table.createdAt,
    ),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    keyId: uuid("key_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: text("scopes").array().notNull(),
    actorLabel: text("actor_label"),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    unique("api_keys_key_hash_unique").on(table.keyHash),
    foreignKey({
      name: "api_keys_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [tenants.tenantId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    check("api_keys_key_hash_check", sql`${table.keyHash} ~ '^[0-9a-f]{64}$'`),
    check("api_keys_scopes_nonempty_check", sql`cardinality(${table.scopes}) > 0`),
    check(
      "api_keys_scopes_allowlist_check",
      sql`${table.scopes} <@ array['ingest', 'corrections', 'admin']::text[]`,
    ),
    check(
      "api_keys_revoked_at_check",
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
    index("api_keys_tenant_revoked_idx").on(table.tenantId, table.revokedAt),
  ],
);

export const privacyScrubAuthorizations = pgTable(
  "privacy_scrub_authorizations",
  {
    tenantId: uuid("tenant_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    operationType: text("operation_type").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "privacy_scrub_authorizations_pk",
      columns: [table.tenantId, table.operationId],
    }),
    foreignKey({
      name: "privacy_scrub_authorizations_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [tenants.tenantId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    check(
      "privacy_scrub_authorizations_operation_type_check",
      sql`${table.operationType} in ('erasure', 'retention', 'consent_withdrawal')`,
    ),
    index("privacy_scrub_authorizations_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
    ),
  ],
);

export const sessionEventScrubAudit = pgTable(
  "session_event_scrub_audit",
  {
    scrubAuditId: uuid("scrub_audit_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    eventId: uuid("event_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    operationType: text("operation_type").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("session_event_scrub_audit_operation_event_unique").on(
      table.tenantId,
      table.operationId,
      table.eventId,
    ),
    foreignKey({
      name: "session_event_scrub_audit_authorization_fk",
      columns: [table.tenantId, table.operationId],
      foreignColumns: [
        privacyScrubAuthorizations.tenantId,
        privacyScrubAuthorizations.operationId,
      ],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    check(
      "session_event_scrub_audit_operation_type_check",
      sql`${table.operationType} in ('erasure', 'retention', 'consent_withdrawal')`,
    ),
    index("session_event_scrub_audit_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
    ),
    index("session_event_scrub_audit_operation_idx").on(
      table.tenantId,
      table.operationId,
    ),
  ],
);

export const consentDeletionQueue = pgTable(
  "consent_deletion_queue",
  {
    queueId: uuid("queue_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    consentType: text("consent_type").notNull(),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    foreignKey({
      name: "consent_deletion_queue_session_fk",
      columns: [table.tenantId, table.sessionId],
      foreignColumns: [factFindSessions.tenantId, factFindSessions.sessionId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    check(
      "consent_deletion_queue_consent_type_check",
      sql`${table.consentType} in ('service_improvement_telemetry', 'partner_benchmarking', 'optional_demographics', 'marketing_referral')`,
    ),
    check(
      "consent_deletion_queue_reason_check",
      sql`${table.reason} = 'consent_withdrawal'`,
    ),
    check(
      "consent_deletion_queue_processed_at_check",
      sql`${table.processedAt} is null or ${table.processedAt} >= ${table.createdAt}`,
    ),
    uniqueIndex("consent_deletion_queue_pending_unique")
      .on(table.tenantId, table.sessionId, table.consentType)
      .where(sql`${table.processedAt} is null`),
    index("consent_deletion_queue_pending_idx")
      .on(table.createdAt, table.queueId)
      .where(sql`${table.processedAt} is null`),
    index("consent_deletion_queue_tenant_session_idx").on(
      table.tenantId,
      table.sessionId,
    ),
  ],
);

export const subjectMetricExclusions = pgTable(
  "subject_metric_exclusions",
  {
    tenantId: uuid("tenant_id").notNull(),
    pseudonymousSubjectId: text("pseudonymous_subject_id").notNull(),
    keyVersion: smallint("key_version").notNull(),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "subject_metric_exclusions_pk",
      columns: [
        table.tenantId,
        table.pseudonymousSubjectId,
        table.keyVersion,
        table.reason,
      ],
    }),
    foreignKey({
      name: "subject_metric_exclusions_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [tenants.tenantId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    check(
      "subject_metric_exclusions_subject_hash_check",
      sql`${table.pseudonymousSubjectId} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "subject_metric_exclusions_key_version_check",
      sql`${table.keyVersion} > 0`,
    ),
    check(
      "subject_metric_exclusions_reason_check",
      sql`${table.reason} = 'consent_withdrawal'`,
    ),
    index("subject_metric_exclusions_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
    ),
  ],
);

export const retentionPurgeAudit = pgTable(
  "retention_purge_audit",
  {
    auditId: uuid("audit_id").defaultRandom().primaryKey(),
    runId: uuid("run_id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    tableName: text("table_name").notNull(),
    cutoff: timestamp("cutoff", { withTimezone: true, mode: "date" }).notNull(),
    rowsDeleted: bigint("rows_deleted", { mode: "number" }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("retention_purge_audit_run_table_unique").on(
      table.runId,
      table.tenantId,
      table.tableName,
    ),
    foreignKey({
      name: "retention_purge_audit_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [tenants.tenantId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    foreignKey({
      name: "retention_purge_audit_authorization_fk",
      columns: [table.tenantId, table.runId],
      foreignColumns: [
        privacyScrubAuthorizations.tenantId,
        privacyScrubAuthorizations.operationId,
      ],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    check(
      "retention_purge_audit_table_name_check",
      sql`${table.tableName} in ('adviser_corrections', 'consent_deletion_queue', 'consent_ledger', 'document_events', 'fact_find_sessions', 'field_extractions', 'provider_usage', 'session_events', 'subject_metric_exclusions', 'telemetry_outbox')`,
    ),
    check(
      "retention_purge_audit_rows_deleted_check",
      sql`${table.rowsDeleted} >= 0`,
    ),
    index("retention_purge_audit_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
    ),
    index("retention_purge_audit_run_idx").on(table.runId),
  ],
);

export const erasureRequests = pgTable(
  "erasure_requests",
  {
    requestId: uuid("request_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    requestedByActorPseudo: text("requested_by_actor_pseudo").notNull(),
    keyVersion: smallint("key_version").notNull(),
    keyVersionsChecked: smallint("key_versions_checked").array().notNull(),
    matchedSessions: integer("matched_sessions").notNull().default(0),
    status: text("status").notNull().default("pending"),
    localCompletedAt: timestamp("local_completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => [
    unique("erasure_requests_tenant_request_unique").on(
      table.tenantId,
      table.requestId,
    ),
    foreignKey({
      name: "erasure_requests_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [tenants.tenantId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    foreignKey({
      name: "erasure_requests_authorization_fk",
      columns: [table.tenantId, table.requestId],
      foreignColumns: [
        privacyScrubAuthorizations.tenantId,
        privacyScrubAuthorizations.operationId,
      ],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    check(
      "erasure_requests_actor_hash_check",
      sql`${table.requestedByActorPseudo} ~ '^[0-9a-f]{64}$'`,
    ),
    check("erasure_requests_key_version_check", sql`${table.keyVersion} > 0`),
    check(
      "erasure_requests_key_versions_checked_check",
      sql`cardinality(${table.keyVersionsChecked}) > 0 and array_position(${table.keyVersionsChecked}, null) is null and 0 < all(${table.keyVersionsChecked})`,
    ),
    check(
      "erasure_requests_matched_sessions_check",
      sql`${table.matchedSessions} >= 0`,
    ),
    check(
      "erasure_requests_status_check",
      sql`${table.status} in ('pending', 'local_completed', 'completed', 'failed')`,
    ),
    check(
      "erasure_requests_completion_check",
      sql`(${table.status} = 'pending' and ${table.localCompletedAt} is null and ${table.completedAt} is null) or (${table.status} = 'local_completed' and ${table.localCompletedAt} is not null and ${table.completedAt} is null) or (${table.status} = 'completed' and ${table.localCompletedAt} is not null and ${table.completedAt} is not null) or (${table.status} = 'failed' and ${table.completedAt} is null)`,
    ),
    check(
      "erasure_requests_timestamps_check",
      sql`(${table.localCompletedAt} is null or ${table.localCompletedAt} >= ${table.createdAt}) and (${table.completedAt} is null or (${table.localCompletedAt} is not null and ${table.completedAt} >= ${table.localCompletedAt}))`,
    ),
    index("erasure_requests_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
    ),
    index("erasure_requests_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
  ],
);

export const privacyDeletionOutbox = pgTable(
  "privacy_deletion_outbox",
  {
    outboxId: uuid("outbox_id").defaultRandom().primaryKey(),
    requestId: uuid("request_id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    sink: text("sink").notNull(),
    externalSubjectIds: text("external_subject_ids").array().notNull(),
    externalSubjectKeyVersions: smallint("external_subject_key_versions")
      .array()
      .notNull(),
    sessionIds: uuid("session_ids").array().notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    lastFailureCode: text("last_failure_code"),
    createdAt: createdAt(),
  },
  (table) => [
    unique("privacy_deletion_outbox_request_sink_unique").on(
      table.requestId,
      table.sink,
    ),
    foreignKey({
      name: "privacy_deletion_outbox_request_fk",
      columns: [table.tenantId, table.requestId],
      foreignColumns: [erasureRequests.tenantId, erasureRequests.requestId],
    })
      .onUpdate("no action")
      .onDelete("no action"),
    check(
      "privacy_deletion_outbox_sink_check",
      sql`${table.sink} in ('analytics', 'traces')`,
    ),
    check(
      "privacy_deletion_outbox_subject_ids_check",
      sql`array_position(${table.externalSubjectIds}, null) is null and (cardinality(${table.externalSubjectIds}) = 0 or array_to_string(${table.externalSubjectIds}, ',') ~ '^([0-9a-f]{64})(,[0-9a-f]{64})*$')`,
    ),
    check(
      "privacy_deletion_outbox_subject_key_versions_check",
      sql`cardinality(${table.externalSubjectKeyVersions}) = cardinality(${table.externalSubjectIds}) and array_position(${table.externalSubjectKeyVersions}, null) is null and (cardinality(${table.externalSubjectKeyVersions}) = 0 or 0 < all(${table.externalSubjectKeyVersions}))`,
    ),
    check(
      "privacy_deletion_outbox_session_ids_check",
      sql`array_position(${table.sessionIds}, null) is null`,
    ),
    check(
      "privacy_deletion_outbox_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "privacy_deletion_outbox_failure_code_check",
      sql`${table.lastFailureCode} is null or ${table.lastFailureCode} = 'sink_delete_failed'`,
    ),
    check(
      "privacy_deletion_outbox_processed_check",
      sql`(${table.processedAt} is null) or (${table.processedAt} >= ${table.createdAt} and ${table.lastFailureCode} is null)`,
    ),
    index("privacy_deletion_outbox_pending_idx")
      .on(table.nextAttemptAt, table.createdAt, table.outboxId)
      .where(sql`${table.processedAt} is null`),
    index("privacy_deletion_outbox_tenant_request_idx").on(
      table.tenantId,
      table.requestId,
    ),
  ],
);
