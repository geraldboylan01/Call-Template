import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { Clock } from "../telemetry/clock.js";

const millisecondsPerDay = 24 * 60 * 60 * 1_000;

type TenantRetentionPolicy = {
  tenant_id: string;
  retention_policy_id: string;
  pseudonymous_telemetry_days: number;
  operational_payload_days: number;
  consent_ledger_days: number;
};

export type RetentionPurgeAuditEntry = {
  tenantId: string;
  tableName: string;
  cutoff: Date;
  rowsDeleted: number;
};

export type RetentionPurgeResult = {
  runId: string;
  entries: readonly RetentionPurgeAuditEntry[];
};

export type RetentionPurgeJobOptions = {
  pool: Pool;
  clock: Clock;
};

function cutoff(runAt: Date, retentionDays: number): Date {
  return new Date(runAt.getTime() - retentionDays * millisecondsPerDay);
}

async function recordAudit(
  client: PoolClient,
  input: {
    runId: string;
    tenantId: string;
    tableName: string;
    cutoff: Date;
    rowsDeleted: number;
    createdAt: Date;
  },
): Promise<RetentionPurgeAuditEntry> {
  await client.query(
    `insert into retention_purge_audit (
       audit_id, run_id, tenant_id, table_name, cutoff, rows_deleted,
       created_at
     ) values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      input.runId,
      input.tenantId,
      input.tableName,
      input.cutoff,
      input.rowsDeleted,
      input.createdAt,
    ],
  );
  return {
    tenantId: input.tenantId,
    tableName: input.tableName,
    cutoff: input.cutoff,
    rowsDeleted: input.rowsDeleted,
  };
}

function deletedRows(result: { rowCount: number | null }): number {
  return result.rowCount ?? 0;
}

/**
 * Executes one deterministic retention run. Every tenant is processed in its
 * own transaction: its deletions and per-table audit rows either all commit or
 * all roll back together.
 */
export class RetentionPurgeJob {
  constructor(private readonly options: RetentionPurgeJobOptions) {}

  async runOnce(): Promise<RetentionPurgeResult> {
    const runId = randomUUID();
    const runAt = this.options.clock.now();
    const policies = await this.options.pool.query<TenantRetentionPolicy>(
      `select tenant.tenant_id, policy.retention_policy_id,
              policy.pseudonymous_telemetry_days,
              policy.operational_payload_days,
              policy.consent_ledger_days
       from tenants tenant
       join retention_policies policy
         on policy.retention_policy_id = tenant.retention_policy_id
       order by tenant.tenant_id`,
    );
    const entries: RetentionPurgeAuditEntry[] = [];

    for (const policy of policies.rows) {
      const client = await this.options.pool.connect();
      try {
        await client.query("begin");
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`retention:${policy.tenant_id}`],
        );
        const telemetryCutoff = cutoff(
          runAt,
          policy.pseudonymous_telemetry_days,
        );
        const operationalCutoff = cutoff(
          runAt,
          policy.operational_payload_days,
        );
        const consentCutoff = cutoff(runAt, policy.consent_ledger_days);

        await client.query(
          `insert into privacy_scrub_authorizations (
             tenant_id, operation_id, operation_type
           ) values ($1, $2, 'retention')`,
          [policy.tenant_id, runId],
        );
        await client.query(
          `select set_config('planeir.scrub_tenant_id', $1, true),
                  set_config('planeir.scrub_operation_id', $2, true),
                  set_config('planeir.scrub_operation_type', 'retention', true)`,
          [policy.tenant_id, runId],
        );

        const consent = await client.query(
          `delete from consent_ledger
           where tenant_id = $1 and created_at < $2`,
          [policy.tenant_id, consentCutoff],
        );
        entries.push(
          await recordAudit(client, {
            runId,
            tenantId: policy.tenant_id,
            tableName: "consent_ledger",
            cutoff: consentCutoff,
            rowsDeleted: deletedRows(consent),
            createdAt: runAt,
          }),
        );

        // Completed withdrawal clean-up work may be retired with the consent
        // ledger. Pending work is never discarded by retention.
        const consentQueue = await client.query(
          `delete from consent_deletion_queue
           where tenant_id = $1
             and created_at < $2
             and processed_at is not null`,
          [policy.tenant_id, consentCutoff],
        );
        entries.push(
          await recordAudit(client, {
            runId,
            tenantId: policy.tenant_id,
            tableName: "consent_deletion_queue",
            cutoff: consentCutoff,
            rowsDeleted: deletedRows(consentQueue),
            createdAt: runAt,
          }),
        );

        // Pending delivery cannot outlive the event's retention window.
        const outbox = await client.query(
          `delete from telemetry_outbox outbox
           using session_events event
           where outbox.tenant_id = $1
             and event.tenant_id = outbox.tenant_id
             and event.event_id = outbox.event_id
             and event.created_at < $2`,
          [policy.tenant_id, telemetryCutoff],
        );
        entries.push(
          await recordAudit(client, {
            runId,
            tenantId: policy.tenant_id,
            tableName: "telemetry_outbox",
            cutoff: telemetryCutoff,
            rowsDeleted: deletedRows(outbox),
            createdAt: runAt,
          }),
        );

        const corrections = await client.query(
          `delete from adviser_corrections
           where tenant_id = $1 and created_at < $2`,
          [policy.tenant_id, telemetryCutoff],
        );
        entries.push(
          await recordAudit(client, {
            runId,
            tenantId: policy.tenant_id,
            tableName: "adviser_corrections",
            cutoff: telemetryCutoff,
            rowsDeleted: deletedRows(corrections),
            createdAt: runAt,
          }),
        );

        // A younger correction retains its extraction parent. This is the
        // conservative FK-safe behavior and never deletes a row before its own
        // retention window has elapsed.
        const extractions = await client.query(
          `delete from field_extractions extraction
           where extraction.tenant_id = $1
             and extraction.created_at < $2
             and not exists (
               select 1 from adviser_corrections correction
               where correction.tenant_id = extraction.tenant_id
                 and correction.extraction_id = extraction.extraction_id
             )`,
          [policy.tenant_id, telemetryCutoff],
        );
        entries.push(
          await recordAudit(client, {
            runId,
            tenantId: policy.tenant_id,
            tableName: "field_extractions",
            cutoff: telemetryCutoff,
            rowsDeleted: deletedRows(extractions),
            createdAt: runAt,
          }),
        );

        const events = await client.query(
          `delete from session_events event
           where event.tenant_id = $1
             and event.created_at < $2
             and not exists (
               select 1 from field_extractions extraction
               where extraction.tenant_id = event.tenant_id
                 and extraction.source_event_id = event.event_id
             )`,
          [policy.tenant_id, telemetryCutoff],
        );
        entries.push(
          await recordAudit(client, {
            runId,
            tenantId: policy.tenant_id,
            tableName: "session_events",
            cutoff: telemetryCutoff,
            rowsDeleted: deletedRows(events),
            createdAt: runAt,
          }),
        );

        const usage = await client.query(
          `delete from provider_usage
           where tenant_id = $1 and created_at < $2`,
          [policy.tenant_id, telemetryCutoff],
        );
        entries.push(
          await recordAudit(client, {
            runId,
            tenantId: policy.tenant_id,
            tableName: "provider_usage",
            cutoff: telemetryCutoff,
            rowsDeleted: deletedRows(usage),
            createdAt: runAt,
          }),
        );

        // document_events contains only minimised compliance metadata. It is
        // the sole in-service row family governed by the operational window;
        // transcripts/audio remain in the separate tenant-owned store.
        const documents = await client.query(
          `delete from document_events
           where tenant_id = $1 and created_at < $2`,
          [policy.tenant_id, operationalCutoff],
        );
        entries.push(
          await recordAudit(client, {
            runId,
            tenantId: policy.tenant_id,
            tableName: "document_events",
            cutoff: operationalCutoff,
            rowsDeleted: deletedRows(documents),
            createdAt: runAt,
          }),
        );

        // A session parent is removed only after every retained child is gone.
        const sessions = await client.query(
          `delete from fact_find_sessions session
           where session.tenant_id = $1
             and session.created_at < $2
             and not exists (
               select 1 from session_events event
               where event.tenant_id = session.tenant_id
                 and event.session_id = session.session_id
             )
             and not exists (
               select 1 from provider_usage usage
               where usage.tenant_id = session.tenant_id
                 and usage.session_id = session.session_id
             )
             and not exists (
               select 1 from field_extractions extraction
               where extraction.tenant_id = session.tenant_id
                 and extraction.session_id = session.session_id
             )
             and not exists (
               select 1 from adviser_corrections correction
               where correction.tenant_id = session.tenant_id
                 and correction.session_id = session.session_id
             )
             and not exists (
               select 1 from consent_ledger consent
               where consent.tenant_id = session.tenant_id
                 and consent.session_id = session.session_id
             )
             and not exists (
               select 1 from document_events document
               where document.tenant_id = session.tenant_id
                 and document.session_id = session.session_id
             )
             and not exists (
               select 1 from consent_deletion_queue deletion
               where deletion.tenant_id = session.tenant_id
                 and deletion.session_id = session.session_id
             )`,
          [policy.tenant_id, telemetryCutoff],
        );
        entries.push(
          await recordAudit(client, {
            runId,
            tenantId: policy.tenant_id,
            tableName: "fact_find_sessions",
            cutoff: telemetryCutoff,
            rowsDeleted: deletedRows(sessions),
            createdAt: runAt,
          }),
        );

        // A withdrawal exclusion must outlive every session carrying that
        // pseudonym; otherwise a younger retained session could re-enter the
        // next daily metric run.
        const exclusions = await client.query(
          `delete from subject_metric_exclusions exclusion
           where exclusion.tenant_id = $1
             and exclusion.created_at < $2
             and not exists (
               select 1 from fact_find_sessions session
               where session.tenant_id = exclusion.tenant_id
                 and session.key_version = exclusion.key_version
                 and session.pseudonymous_subject_id =
                     exclusion.pseudonymous_subject_id
             )`,
          [policy.tenant_id, telemetryCutoff],
        );
        entries.push(
          await recordAudit(client, {
            runId,
            tenantId: policy.tenant_id,
            tableName: "subject_metric_exclusions",
            cutoff: telemetryCutoff,
            rowsDeleted: deletedRows(exclusions),
            createdAt: runAt,
          }),
        );

        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }

    return { runId, entries };
  }
}

export const DAILY_RETENTION_INTERVAL_MILLISECONDS = 24 * 60 * 60 * 1_000;

export function startDailyRetention(
  job: RetentionPurgeJob,
  onError: () => void,
): { stop(): Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = job
        .runOnce()
        .then(() => undefined)
        .catch(() => onError())
        .finally(schedule);
    }, DAILY_RETENTION_INTERVAL_MILLISECONDS);
    timer.unref();
  };
  schedule();

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
