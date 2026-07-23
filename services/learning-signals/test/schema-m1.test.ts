import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  waitForPostgres,
} from "../src/db/client.js";

const TABLES = [
  "adviser_corrections",
  "api_keys",
  "consent_ledger",
  "document_events",
  "fact_find_sessions",
  "field_extractions",
  "module_versions",
  "partner_export_batches",
  "provider_usage",
  "retention_policies",
  "session_events",
  "tenants",
] as const;

const PRIMARY_KEYS: Record<string, readonly string[]> = {
  adviser_corrections_pkey: ["correction_id"],
  api_keys_pkey: ["key_id"],
  consent_ledger_pkey: ["consent_id"],
  document_events_pkey: ["document_event_id"],
  fact_find_sessions_pkey: ["session_id"],
  field_extractions_pkey: ["extraction_id"],
  module_versions_pkey: ["module_version_id"],
  partner_export_batches_pkey: ["export_batch_id"],
  provider_usage_pkey: ["usage_id"],
  retention_policies_pkey: ["retention_policy_id"],
  session_events_pk: ["tenant_id", "event_id"],
  tenants_pkey: ["tenant_id"],
};

const UNIQUE_CONSTRAINTS: Record<string, readonly string[]> = {
  adviser_corrections_tenant_idempotency_unique: ["tenant_id", "idempotency_key"],
  api_keys_key_hash_unique: ["key_hash"],
  fact_find_sessions_tenant_session_unique: ["tenant_id", "session_id"],
  field_extractions_tenant_extraction_unique: ["tenant_id", "extraction_id"],
  field_extractions_tenant_session_extraction_unique: [
    "tenant_id",
    "session_id",
    "extraction_id",
  ],
  module_versions_tenant_module_semver_unique: [
    "tenant_id",
    "module_id",
    "semantic_version",
  ],
  module_versions_tenant_version_id_unique: ["tenant_id", "module_version_id"],
  partner_export_batches_window_unique: [
    "partner_code",
    "cohort_key",
    "period_start",
    "period_end",
  ],
  retention_policies_policy_key_unique: ["policy_key"],
  session_events_tenant_ingestion_key_unique: ["tenant_id", "ingestion_key"],
  tenants_slug_unique: ["slug"],
};

const FOREIGN_KEYS = {
  adviser_corrections_extraction_fk: {
    sourceTable: "adviser_corrections",
    sourceColumns: ["tenant_id", "extraction_id"],
    targetTable: "field_extractions",
    targetColumns: ["tenant_id", "extraction_id"],
  },
  adviser_corrections_session_extraction_fk: {
    sourceTable: "adviser_corrections",
    sourceColumns: ["tenant_id", "session_id", "extraction_id"],
    targetTable: "field_extractions",
    targetColumns: ["tenant_id", "session_id", "extraction_id"],
  },
  adviser_corrections_session_fk: {
    sourceTable: "adviser_corrections",
    sourceColumns: ["tenant_id", "session_id"],
    targetTable: "fact_find_sessions",
    targetColumns: ["tenant_id", "session_id"],
  },
  api_keys_tenant_fk: {
    sourceTable: "api_keys",
    sourceColumns: ["tenant_id"],
    targetTable: "tenants",
    targetColumns: ["tenant_id"],
  },
  consent_ledger_session_fk: {
    sourceTable: "consent_ledger",
    sourceColumns: ["tenant_id", "session_id"],
    targetTable: "fact_find_sessions",
    targetColumns: ["tenant_id", "session_id"],
  },
  document_events_session_fk: {
    sourceTable: "document_events",
    sourceColumns: ["tenant_id", "session_id"],
    targetTable: "fact_find_sessions",
    targetColumns: ["tenant_id", "session_id"],
  },
  fact_find_sessions_module_version_fk: {
    sourceTable: "fact_find_sessions",
    sourceColumns: ["tenant_id", "module_version_id"],
    targetTable: "module_versions",
    targetColumns: ["tenant_id", "module_version_id"],
  },
  fact_find_sessions_tenant_fk: {
    sourceTable: "fact_find_sessions",
    sourceColumns: ["tenant_id"],
    targetTable: "tenants",
    targetColumns: ["tenant_id"],
  },
  field_extractions_session_fk: {
    sourceTable: "field_extractions",
    sourceColumns: ["tenant_id", "session_id"],
    targetTable: "fact_find_sessions",
    targetColumns: ["tenant_id", "session_id"],
  },
  field_extractions_source_event_fk: {
    sourceTable: "field_extractions",
    sourceColumns: ["tenant_id", "source_event_id"],
    targetTable: "session_events",
    targetColumns: ["tenant_id", "event_id"],
  },
  module_versions_tenant_fk: {
    sourceTable: "module_versions",
    sourceColumns: ["tenant_id"],
    targetTable: "tenants",
    targetColumns: ["tenant_id"],
  },
  provider_usage_session_fk: {
    sourceTable: "provider_usage",
    sourceColumns: ["tenant_id", "session_id"],
    targetTable: "fact_find_sessions",
    targetColumns: ["tenant_id", "session_id"],
  },
  session_events_session_fk: {
    sourceTable: "session_events",
    sourceColumns: ["tenant_id", "session_id"],
    targetTable: "fact_find_sessions",
    targetColumns: ["tenant_id", "session_id"],
  },
  tenants_retention_policy_fk: {
    sourceTable: "tenants",
    sourceColumns: ["retention_policy_id"],
    targetTable: "retention_policies",
    targetColumns: ["retention_policy_id"],
  },
} as const;

const CHECK_CONSTRAINTS = [
  "adviser_corrections_actor_hash_check",
  "adviser_corrections_after_hash_check",
  "adviser_corrections_after_preview_length_check",
  "adviser_corrections_before_hash_check",
  "adviser_corrections_before_preview_length_check",
  "adviser_corrections_field_policy_version_check",
  "adviser_corrections_idempotency_key_check",
  "adviser_corrections_key_version_check",
  "adviser_corrections_payload_hash_check",
  "adviser_corrections_reason_code_check",
  "adviser_corrections_reviewer_role_check",
  "api_keys_key_hash_check",
  "api_keys_revoked_at_check",
  "api_keys_scopes_allowlist_check",
  "api_keys_scopes_nonempty_check",
  "consent_ledger_action_check",
  "consent_ledger_evidence_hash_check",
  "consent_ledger_notice_id_check",
  "consent_ledger_policy_version_check",
  "consent_ledger_purpose_allowlist_check",
  "consent_ledger_purpose_check",
  "document_events_attrs_object_check",
  "document_events_attrs_size_check",
  "document_events_document_hash_check",
  "document_events_document_type_check",
  "document_events_event_type_check",
  "fact_find_sessions_completed_at_check",
  "fact_find_sessions_key_version_check",
  "fact_find_sessions_status_check",
  "fact_find_sessions_subject_hash_check",
  "field_extractions_confidence_check",
  "field_extractions_extraction_status_check",
  "field_extractions_field_path_check",
  "field_extractions_field_policy_version_check",
  "field_extractions_key_version_check",
  "field_extractions_normalized_value_preview_length_check",
  "field_extractions_value_class_check",
  "field_extractions_value_hash_check",
  "module_versions_body_object_check",
  "module_versions_content_hash_check",
  "module_versions_published_at_check",
  "module_versions_semantic_version_check",
  "module_versions_status_check",
  "partner_export_batches_cohort_key_check",
  "partner_export_batches_counts_check",
  "partner_export_batches_partner_code_check",
  "partner_export_batches_period_check",
  "partner_export_batches_ready_at_check",
  "partner_export_batches_release_gate_check",
  "partner_export_batches_share_check",
  "partner_export_batches_status_check",
  "provider_usage_model_check",
  "provider_usage_nonnegative_check",
  "provider_usage_operation_check",
  "provider_usage_provider_check",
  "retention_policies_consent_ledger_days_check",
  "retention_policies_document_days_check",
  "retention_policies_event_days_check",
  "retention_policies_operational_payload_days_check",
  "retention_policies_pseudonymous_telemetry_days_check",
  "retention_policies_session_days_check",
  "session_events_attrs_object_check",
  "session_events_attrs_size_check",
  "session_events_duration_ms_check",
  "session_events_event_type_check",
  "session_events_ingestion_key_check",
  "session_events_ingestion_key_derived_check",
  "session_events_payload_hash_check",
  "session_events_turn_index_check",
  "tenants_display_name_check",
  "tenants_slug_check",
  "tenants_status_check",
] as const;

const NON_CONSTRAINT_INDEXES = [
  "adviser_corrections_tenant_created_idx",
  "adviser_corrections_tenant_extraction_idx",
  "adviser_corrections_tenant_session_idx",
  "api_keys_tenant_revoked_idx",
  "consent_ledger_current_state_idx",
  "consent_ledger_tenant_created_at_idx",
  "consent_ledger_tenant_purpose_created_idx",
  "consent_ledger_tenant_session_created_idx",
  "document_events_tenant_document_created_idx",
  "document_events_tenant_session_created_idx",
  "fact_find_sessions_tenant_created_at_idx",
  "fact_find_sessions_tenant_module_version_idx",
  "fact_find_sessions_tenant_subject_idx",
  "field_extractions_tenant_field_created_idx",
  "field_extractions_tenant_session_idx",
  "field_extractions_tenant_source_event_idx",
  "module_versions_tenant_module_status_idx",
  "partner_export_batches_partner_created_idx",
  "partner_export_batches_status_period_idx",
  "provider_usage_tenant_provider_model_created_idx",
  "provider_usage_tenant_session_idx",
  "session_events_created_at_idx",
  "session_events_received_at_idx",
  "session_events_tenant_session_order_idx",
  "session_events_tenant_type_received_idx",
  "tenants_retention_policy_idx",
] as const;

type Query = { text: string; values?: unknown[] };

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ingestionKey(tenantId: string, eventId: string): string {
  return hash(`${tenantId}:${eventId}`);
}

function normalized(value: string): string {
  return value.toLowerCase().replaceAll('"', "").replace(/\s+/g, " ");
}

let savepointCounter = 0;

async function expectPostgresError(
  client: PoolClient,
  query: Query,
  expectedCode: string,
): Promise<void> {
  savepointCounter += 1;
  const savepoint = `expected_error_${savepointCounter}`;
  await client.query(`SAVEPOINT ${savepoint}`);

  let error: unknown;
  try {
    await client.query(query.text, query.values);
  } catch (caught) {
    error = caught;
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }

  expect(error).toMatchObject({ code: expectedCode });
}

async function withRollback(
  connection: DatabaseConnection,
  run: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await connection.pool.connect();
  try {
    await client.query("BEGIN");
    await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function insertTenant(client: PoolClient, label: string): Promise<string> {
  const tenantId = randomUUID();
  await client.query(
    `insert into tenants (tenant_id, slug, display_name)
     values ($1, $2, $3)`,
    [tenantId, `${label}-${tenantId}`, `Tenant ${label}`],
  );
  return tenantId;
}

async function insertModule(
  client: PoolClient,
  tenantId: string,
  status: "draft" | "published" = "published",
): Promise<string> {
  const moduleVersionId = randomUUID();
  await client.query(
    `insert into module_versions (
       module_version_id, tenant_id, module_id, semantic_version, status,
       module_body_jsonb, content_hash, published_at
     ) values ($1, $2, $3, $4, $5, $6::jsonb, $7,
       case when $5 = 'published' then now() else null end)`,
    [
      moduleVersionId,
      tenantId,
      randomUUID(),
      `1.0.0-${moduleVersionId}`,
      status,
      JSON.stringify({ sections: [] }),
      hash(`module:${moduleVersionId}`),
    ],
  );
  return moduleVersionId;
}

async function insertSession(
  client: PoolClient,
  tenantId: string,
  moduleVersionId: string,
): Promise<string> {
  const sessionId = randomUUID();
  await client.query(
    `insert into fact_find_sessions (
       session_id, tenant_id, module_version_id, pseudonymous_subject_id
     ) values ($1, $2, $3, $4)`,
    [sessionId, tenantId, moduleVersionId, hash(`subject:${sessionId}`)],
  );
  return sessionId;
}

async function insertEvent(
  client: PoolClient,
  tenantId: string,
  sessionId: string,
  durationMs: number | null = null,
): Promise<string> {
  const eventId = randomUUID();
  await client.query(
    `insert into session_events (
       tenant_id, event_id, session_id, event_type, payload_hash, attrs,
       occurred_at, duration_ms
     ) values ($1, $2, $3, 'turn.completed', $4, '{}'::jsonb, now(), $5)`,
    [
      tenantId,
      eventId,
      sessionId,
      hash(`payload:${eventId}`),
      durationMs,
    ],
  );
  return eventId;
}

describe.sequential("M1 PostgreSQL schema", () => {
  let connection: DatabaseConnection;

  beforeAll(async () => {
    const config = loadConfig();
    connection = createDatabaseConnection(config.databaseUrl);
    await waitForPostgres(connection.pool);
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  it("installs the exact M1 tables, critical columns, and default retention policy", async () => {
    const tableResult = await connection.pool.query<{ table_name: string }>(
      `select c.relname as table_name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')
       order by c.relname`,
    );
    const installedTables = new Set(tableResult.rows.map((row) => row.table_name));
    for (const table of TABLES) expect(installedTables.has(table), table).toBe(true);

    const columnResult = await connection.pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: "YES" | "NO";
      column_default: string | null;
    }>(
      `select table_name, column_name, data_type, udt_name, is_nullable, column_default
       from information_schema.columns
       where table_schema = 'public' and table_name = any($1::text[])`,
      [[...TABLES]],
    );
    const columns = new Map(
      columnResult.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]),
    );

    expect(columns.get("tenants.retention_policy_id")).toMatchObject({
      data_type: "uuid",
      is_nullable: "NO",
    });
    expect(columns.get("module_versions.module_body_jsonb")).toMatchObject({
      data_type: "jsonb",
      is_nullable: "NO",
    });
    expect(columns.get("session_events.payload_hash")).toMatchObject({
      data_type: "text",
      is_nullable: "NO",
    });
    expect(columns.get("session_events.received_at")).toMatchObject({
      data_type: "timestamp with time zone",
      is_nullable: "NO",
    });
    expect(columns.get("session_events.received_at")?.column_default).toContain("now()");
    expect(columns.get("field_extractions.extraction_status")).toMatchObject({
      data_type: "text",
      is_nullable: "NO",
    });
    expect(
      columns.get("field_extractions.extraction_status")?.column_default,
    ).toContain("extracted");
    for (const column of [
      "field_extractions.field_policy_version",
      "adviser_corrections.field_policy_version",
    ]) {
      expect(columns.get(column), column).toMatchObject({
        data_type: "text",
        is_nullable: "NO",
        column_default: null,
      });
    }
    expect(columns.get("adviser_corrections.payload_hash")).toMatchObject({
      data_type: "text",
      is_nullable: "NO",
    });
    for (const column of [
      "field_extractions.normalized_value_preview",
      "adviser_corrections.before_preview",
      "adviser_corrections.after_preview",
    ]) {
      expect(columns.get(column), column).toMatchObject({
        data_type: "text",
        is_nullable: "YES",
      });
    }
    expect(columns.get("api_keys.scopes")).toMatchObject({
      data_type: "ARRAY",
      udt_name: "_text",
      is_nullable: "NO",
    });
    for (const column of [
      "api_keys.key_id",
      "api_keys.tenant_id",
      "api_keys.key_hash",
      "api_keys.created_at",
      "adviser_corrections.idempotency_key",
      "adviser_corrections.actor_id_pseudo",
    ]) {
      expect(columns.get(column)?.is_nullable, column).toBe("NO");
    }
    for (const column of [
      "fact_find_sessions.key_version",
      "field_extractions.key_version",
      "adviser_corrections.key_version",
    ]) {
      expect(columns.get(column), column).toMatchObject({
        data_type: "smallint",
        is_nullable: "NO",
      });
      expect(columns.get(column)?.column_default, column).toContain("1");
    }
    for (const forbidden of [
      "transcript",
      "transcript_text",
      "raw_answer",
      "raw_value",
      "field_value",
    ]) {
      expect(
        columnResult.rows.some((row) => row.column_name === forbidden),
        forbidden,
      ).toBe(false);
    }

    const seedResult = await connection.pool.query<{
      retention_policy_id: string;
      policy_key: string;
      name: string;
      session_retention_days: number;
      event_retention_days: number;
      document_retention_days: number;
    }>(
      `select retention_policy_id, policy_key, name, session_retention_days,
              event_retention_days, document_retention_days
       from retention_policies
       where retention_policy_id = '00000000-0000-4000-8000-000000000001'`,
    );
    expect(seedResult.rows).toEqual([
      {
        retention_policy_id: "00000000-0000-4000-8000-000000000001",
        policy_key: "pilot-default-v1",
        name: "Pilot default - 30 days",
        session_retention_days: 30,
        event_retention_days: 30,
        document_retention_days: 30,
      },
    ]);
  });

  it("installs every primary key and unique constraint with the required column order", async () => {
    const result = await connection.pool.query<{
      constraint_name: string;
      constraint_type: "p" | "u";
      columns: string[];
    }>(
      `select c.conname as constraint_name,
              c.contype as constraint_type,
              array_agg(a.attname order by positions.position)::text[] as columns
       from pg_constraint c
       join pg_class source on source.oid = c.conrelid
       join pg_namespace n on n.oid = source.relnamespace
       cross join lateral generate_subscripts(c.conkey, 1) positions(position)
       join pg_attribute a
         on a.attrelid = source.oid and a.attnum = c.conkey[positions.position]
       where n.nspname = 'public'
         and source.relname = any($1::text[])
         and c.contype in ('p', 'u')
       group by c.conname, c.contype
       order by c.conname`,
      [[...TABLES]],
    );

    const primaryKeys = Object.fromEntries(
      result.rows
        .filter((row) => row.constraint_type === "p")
        .map((row) => [row.constraint_name, row.columns]),
    );
    const uniqueConstraints = Object.fromEntries(
      result.rows
        .filter((row) => row.constraint_type === "u")
        .map((row) => [row.constraint_name, row.columns]),
    );
    expect(primaryKeys).toEqual(PRIMARY_KEYS);
    expect(uniqueConstraints).toEqual(UNIQUE_CONSTRAINTS);
  });

  it("installs every tenant-carrying foreign key as validated NO ACTION", async () => {
    const result = await connection.pool.query<{
      constraint_name: string;
      source_table: string;
      source_columns: string[];
      target_table: string;
      target_columns: string[];
      update_action: string;
      delete_action: string;
      is_validated: boolean;
    }>(
      `select c.conname as constraint_name,
              source.relname as source_table,
              array_agg(source_attr.attname order by positions.position)::text[] as source_columns,
              target.relname as target_table,
              array_agg(target_attr.attname order by positions.position)::text[] as target_columns,
              c.confupdtype as update_action,
              c.confdeltype as delete_action,
              c.convalidated as is_validated
       from pg_constraint c
       join pg_class source on source.oid = c.conrelid
       join pg_namespace n on n.oid = source.relnamespace
       join pg_class target on target.oid = c.confrelid
       cross join lateral generate_subscripts(c.conkey, 1) positions(position)
       join pg_attribute source_attr
         on source_attr.attrelid = source.oid
        and source_attr.attnum = c.conkey[positions.position]
       join pg_attribute target_attr
         on target_attr.attrelid = target.oid
        and target_attr.attnum = c.confkey[positions.position]
       where n.nspname = 'public'
         and source.relname = any($1::text[])
         and c.contype = 'f'
       group by c.conname, source.relname, target.relname,
                c.confupdtype, c.confdeltype, c.convalidated
       order by c.conname`,
      [[...TABLES]],
    );

    const actual = Object.fromEntries(
      result.rows.map((row) => [
        row.constraint_name,
        {
          sourceTable: row.source_table,
          sourceColumns: row.source_columns,
          targetTable: row.target_table,
          targetColumns: row.target_columns,
        },
      ]),
    );
    expect(actual).toEqual(FOREIGN_KEYS);
    for (const row of result.rows) {
      expect(row.update_action, row.constraint_name).toBe("a");
      expect(row.delete_action, row.constraint_name).toBe("a");
      expect(row.is_validated, row.constraint_name).toBe(true);
    }
  });

  it("installs every named CHECK and enforces the privacy and pilot boundaries", async () => {
    const result = await connection.pool.query<{
      constraint_name: string;
      definition: string;
      is_validated: boolean;
    }>(
      `select c.conname as constraint_name,
              pg_get_constraintdef(c.oid, true) as definition,
              c.convalidated as is_validated
       from pg_constraint c
       join pg_class source on source.oid = c.conrelid
       join pg_namespace n on n.oid = source.relnamespace
       where n.nspname = 'public'
         and source.relname = any($1::text[])
         and c.contype = 'c'
       order by c.conname`,
      [[...TABLES]],
    );
    expect(result.rows.map((row) => row.constraint_name)).toEqual([...CHECK_CONSTRAINTS]);
    expect(result.rows.every((row) => row.is_validated)).toBe(true);

    const definitions = new Map(
      result.rows.map((row) => [row.constraint_name, normalized(row.definition)]),
    );
    expect(definitions.get("session_events_duration_ms_check")).toContain(
      "duration_ms >= 0",
    );
    expect(definitions.get("session_events_duration_ms_check")).toContain(
      "duration_ms is null",
    );
    expect(definitions.get("session_events_attrs_size_check")).toContain("4096");
    expect(definitions.get("session_events_attrs_object_check")).toContain(
      "jsonb_typeof(attrs) = 'object'",
    );
    expect(definitions.get("session_events_ingestion_key_derived_check")).toContain(
      "sha256",
    );
    expect(definitions.get("session_events_ingestion_key_derived_check")).toContain(
      "tenant_id",
    );
    expect(definitions.get("session_events_ingestion_key_derived_check")).toContain(
      "event_id",
    );
    expect(definitions.get("partner_export_batches_release_gate_check")).toContain(
      "user_count >= 30",
    );
    expect(definitions.get("partner_export_batches_release_gate_check")).toContain(
      "tenant_count >= 3",
    );
    expect(definitions.get("partner_export_batches_release_gate_check")).toContain(
      "max_tenant_share <= 0.8",
    );
    for (const name of [
      "field_extractions_normalized_value_preview_length_check",
      "adviser_corrections_before_preview_length_check",
      "adviser_corrections_after_preview_length_check",
    ]) {
      expect(definitions.get(name), name).toContain("char_length");
      expect(definitions.get(name), name).toContain("64");
    }
    expect(definitions.get("field_extractions_extraction_status_check")).toContain(
      "'extracted'",
    );
    expect(definitions.get("field_extractions_extraction_status_check")).toContain(
      "'corrected'",
    );
    expect(definitions.get("adviser_corrections_reason_code_check")).toContain(
      "'incorrect_value'",
    );
    expect(definitions.get("adviser_corrections_reason_code_check")).toContain(
      "'other'",
    );
    for (const name of [
      "fact_find_sessions_subject_hash_check",
      "field_extractions_value_hash_check",
      "adviser_corrections_payload_hash_check",
      "adviser_corrections_before_hash_check",
      "adviser_corrections_after_hash_check",
      "adviser_corrections_actor_hash_check",
    ]) {
      expect(definitions.get(name), name).toContain("^[0-9a-f]{64}$");
    }
  });

  it("installs every explicit join and reporting index in the declared order", async () => {
    const result = await connection.pool.query<{
      index_name: string;
      definition: string;
      is_valid: boolean;
      is_ready: boolean;
    }>(
      `select index_class.relname as index_name,
              pg_get_indexdef(index_class.oid) as definition,
              i.indisvalid as is_valid,
              i.indisready as is_ready
       from pg_index i
       join pg_class source on source.oid = i.indrelid
       join pg_namespace n on n.oid = source.relnamespace
       join pg_class index_class on index_class.oid = i.indexrelid
       left join pg_constraint c on c.conindid = i.indexrelid
       where n.nspname = 'public'
         and source.relname = any($1::text[])
         and c.oid is null
       order by index_class.relname`,
      [[...TABLES]],
    );
    expect(result.rows.map((row) => row.index_name)).toEqual([...NON_CONSTRAINT_INDEXES]);
    expect(result.rows.every((row) => row.is_valid && row.is_ready)).toBe(true);

    const definitions = new Map(
      result.rows.map((row) => [row.index_name, normalized(row.definition)]),
    );
    expect(definitions.get("provider_usage_tenant_session_idx")).toContain(
      "(tenant_id, session_id)",
    );
    expect(definitions.get("field_extractions_tenant_session_idx")).toContain(
      "(tenant_id, session_id)",
    );
    expect(definitions.get("adviser_corrections_tenant_extraction_idx")).toContain(
      "(tenant_id, extraction_id)",
    );
    expect(definitions.get("adviser_corrections_tenant_session_idx")).toContain(
      "(tenant_id, session_id)",
    );
  });

  it("installs enabled BEFORE triggers for module immutability and the append-only ledger", async () => {
    const result = await connection.pool.query<{
      trigger_name: string;
      table_name: string;
      definition: string;
      enabled: string;
    }>(
      `select t.tgname as trigger_name,
              source.relname as table_name,
              pg_get_triggerdef(t.oid, true) as definition,
              t.tgenabled as enabled
       from pg_trigger t
       join pg_class source on source.oid = t.tgrelid
       join pg_namespace n on n.oid = source.relnamespace
       where n.nspname = 'public'
         and source.relname = any($1::text[])
         and not t.tgisinternal
       order by t.tgname`,
      [[...TABLES]],
    );
    expect(result.rows.map((row) => row.trigger_name)).toEqual([
      "consent_ledger_append_only_row_trigger",
      "consent_ledger_append_only_truncate_trigger",
      "consent_ledger_withdrawal_lock_trigger",
      "consent_ledger_withdrawal_side_effects_trigger",
      "module_versions_immutability_trigger",
      "session_events_append_only_row_trigger",
      "session_events_append_only_truncate_trigger",
      "session_events_derive_ingestion_key_trigger",
    ]);
    expect(result.rows.every((row) => row.enabled === "A")).toBe(true);

    const definitions = new Map(
      result.rows.map((row) => [row.trigger_name, normalized(row.definition)]),
    );
    expect(definitions.get("module_versions_immutability_trigger")).toContain(
      "before update on module_versions for each row",
    );
    expect(definitions.get("session_events_append_only_row_trigger")).toContain(
      "before delete or update on session_events for each row",
    );
    expect(definitions.get("session_events_append_only_truncate_trigger")).toContain(
      "before truncate on session_events for each statement",
    );
    expect(definitions.get("session_events_derive_ingestion_key_trigger")).toContain(
      "before insert on session_events for each row",
    );
  });

  it("rejects published mutations, permits only published-to-retired, and blocks cross-tenant modules", async () => {
    await withRollback(connection, async (client) => {
      const tenantA = await insertTenant(client, "module-a");
      const tenantB = await insertTenant(client, "module-b");
      const moduleA = await insertModule(client, tenantA);
      const moduleForCombinedMutation = await insertModule(client, tenantA);
      const moduleB = await insertModule(client, tenantB);

      await expectPostgresError(
        client,
        {
          text: `update module_versions
                 set module_body_jsonb = '{"sections":[{"changed":true}]}'::jsonb
                 where module_version_id = $1`,
          values: [moduleA],
        },
        "55000",
      );
      await client.query("set local session_replication_role = replica");
      await expectPostgresError(
        client,
        {
          text: "update module_versions set content_hash = $1 where module_version_id = $2",
          values: [hash("replication-bypass"), moduleA],
        },
        "55000",
      );
      await client.query("set local session_replication_role = origin");
      await expectPostgresError(
        client,
        {
          text: `update module_versions
                 set status = 'retired', module_body_jsonb = '{"changed":true}'::jsonb
                 where module_version_id = $1`,
          values: [moduleForCombinedMutation],
        },
        "55000",
      );

      const retirement = await client.query<{ status: string }>(
        `update module_versions set status = 'retired'
         where module_version_id = $1 returning status`,
        [moduleA],
      );
      expect(retirement.rows[0]?.status).toBe("retired");
      await expectPostgresError(
        client,
        {
          text: "update module_versions set semantic_version = '2.0.0' where module_version_id = $1",
          values: [moduleA],
        },
        "55000",
      );
      await expectPostgresError(
        client,
        {
          text: `insert into fact_find_sessions (
                   tenant_id, module_version_id, pseudonymous_subject_id
                 ) values ($1, $2, $3)`,
          values: [tenantA, moduleB, hash("cross-tenant-module")],
        },
        "23503",
      );
    });
  });

  it("blocks cross-tenant ledger writes and keeps session events append-only", async () => {
    await withRollback(connection, async (client) => {
      const tenantA = await insertTenant(client, "ledger-a");
      const tenantB = await insertTenant(client, "ledger-b");
      const moduleA = await insertModule(client, tenantA);
      const moduleB = await insertModule(client, tenantB);
      const sessionA = await insertSession(client, tenantA, moduleA);
      const sessionB = await insertSession(client, tenantB, moduleB);

      const crossTenantEventId = randomUUID();
      await expectPostgresError(
        client,
        {
          text: `insert into session_events (
                   tenant_id, event_id, session_id, event_type, payload_hash,
                   attrs, occurred_at
                 ) values ($1, $2, $3, 'turn.completed', $4, '{}'::jsonb, now())`,
          values: [
            tenantA,
            crossTenantEventId,
            sessionB,
            hash("cross-tenant-event"),
          ],
        },
        "23503",
      );

      const eventA = await insertEvent(client, tenantA, sessionA, 0);
      await insertEvent(client, tenantA, sessionA, null);
      const derivedKeyResult = await client.query<{ ingestion_key: string }>(
        `select ingestion_key from session_events
         where tenant_id = $1 and event_id = $2`,
        [tenantA, eventA],
      );
      expect(derivedKeyResult.rows[0]?.ingestion_key).toBe(ingestionKey(tenantA, eventA));

      const callerChosenEvent = randomUUID();
      await client.query(
        `insert into session_events (
           tenant_id, event_id, session_id, event_type, ingestion_key,
           payload_hash, attrs, occurred_at
         ) values ($1, $2, $3, 'turn.completed', $4, $5, '{}'::jsonb, now())`,
        [
          tenantA,
          callerChosenEvent,
          sessionA,
          "f".repeat(64),
          hash("caller-chosen-ingestion-key"),
        ],
      );
      const overwrittenKeyResult = await client.query<{ ingestion_key: string }>(
        `select ingestion_key from session_events
         where tenant_id = $1 and event_id = $2`,
        [tenantA, callerChosenEvent],
      );
      expect(overwrittenKeyResult.rows[0]?.ingestion_key).toBe(
        ingestionKey(tenantA, callerChosenEvent),
      );
      expect(overwrittenKeyResult.rows[0]?.ingestion_key).not.toBe("f".repeat(64));
      await expectPostgresError(
        client,
        {
          text: "update session_events set duration_ms = 1 where tenant_id = $1 and event_id = $2",
          values: [tenantA, eventA],
        },
        "55000",
      );
      await expectPostgresError(
        client,
        {
          text: "delete from session_events where tenant_id = $1 and event_id = $2",
          values: [tenantA, eventA],
        },
        "55000",
      );
      await client.query("set local session_replication_role = replica");
      await expectPostgresError(
        client,
        {
          text: "delete from session_events where tenant_id = $1 and event_id = $2",
          values: [tenantA, eventA],
        },
        "55000",
      );
      await client.query("set local session_replication_role = origin");
      // CASCADE gets past PostgreSQL's ordinary FK truncation guard, so this
      // specifically proves the append-only statement trigger still blocks it.
      await expectPostgresError(
        client,
        { text: "truncate table session_events cascade" },
        "55000",
      );

      const negativeDurationEvent = randomUUID();
      await expectPostgresError(
        client,
        {
          text: `insert into session_events (
                   tenant_id, event_id, session_id, event_type, payload_hash,
                   attrs, occurred_at, duration_ms
                 ) values ($1, $2, $3, 'turn.completed', $4, '{}'::jsonb, now(), -1)`,
          values: [
            tenantA,
            negativeDurationEvent,
            sessionA,
            hash("negative-duration"),
          ],
        },
        "23514",
      );

      await expectPostgresError(
        client,
        {
          text: `insert into session_events (
                   tenant_id, event_id, session_id, event_type, ingestion_key,
                   payload_hash, attrs, occurred_at
                 ) values ($1, $2, $3, 'turn.completed', $4, $5, '{}'::jsonb, now())`,
          values: [
            tenantA,
            eventA,
            sessionA,
            "0".repeat(64),
            hash("different-payload"),
          ],
        },
        "23505",
      );

      const extractionId = randomUUID();
      await client.query(
        `insert into field_extractions (
           extraction_id, tenant_id, session_id, source_event_id, field_path,
           value_class, normalized_value_hash, field_policy_version
         ) values ($1, $2, $3, $4, 'income.band', 'band', $5, 'legacy-pre-policy')`,
        [extractionId, tenantA, sessionA, eventA, hash("normalized-value")],
      );
      await expectPostgresError(
        client,
        {
          text: `insert into adviser_corrections (
                   tenant_id, session_id, extraction_id, idempotency_key,
                   payload_hash, before_hash, after_hash, actor_id_pseudo,
                   reviewer_role, field_policy_version
                 ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'adviser', 'legacy-pre-policy')`,
          values: [
            tenantB,
            sessionB,
            extractionId,
            randomUUID(),
            hash("payload"),
            hash("before"),
            hash("after"),
            hash("actor"),
          ],
        },
        "23503",
      );
    });
  });

  it("enforces the partner release thresholds at their exact boundaries", async () => {
    await withRollback(connection, async (client) => {
      const insertReadyBatch = (overrides: {
        userCount: number;
        tenantCount: number;
        maxTenantShare: number;
      }): Query => ({
        text: `insert into partner_export_batches (
                 partner_code, cohort_key, period_start, period_end, status,
                 user_count, tenant_count, max_tenant_share, ready_at
               ) values ($1, $2, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z',
                         'ready', $3, $4, $5, now())
               returning export_batch_id`,
        values: [
          "partner-a",
          randomUUID(),
          overrides.userCount,
          overrides.tenantCount,
          overrides.maxTenantShare,
        ],
      });

      await expectPostgresError(
        client,
        insertReadyBatch({ userCount: 29, tenantCount: 3, maxTenantShare: 0.8 }),
        "23514",
      );
      await expectPostgresError(
        client,
        insertReadyBatch({ userCount: 30, tenantCount: 2, maxTenantShare: 0.8 }),
        "23514",
      );
      await expectPostgresError(
        client,
        insertReadyBatch({ userCount: 30, tenantCount: 3, maxTenantShare: 0.8001 }),
        "23514",
      );

      const accepted = await client.query<{ export_batch_id: string }>(
        insertReadyBatch({ userCount: 30, tenantCount: 3, maxTenantShare: 0.8 }),
      );
      expect(accepted.rows).toHaveLength(1);
    });
  });
});
