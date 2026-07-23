import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { pseudonymizeActor, pseudonymizeIdentifier } from "./field-values.js";
import {
  type SecretsProvider,
  type TenantSecret,
} from "./secrets.js";
import {
  type AnalyticsSink,
  type SubjectDeletionRequest,
  type TraceSink,
} from "../sinks/telemetry-sinks.js";
import { sha256Hex } from "../telemetry/canonical-json.js";
import type { Clock } from "../telemetry/clock.js";

type SubjectPseudonym = {
  keyVersion: number;
  pseudonymousSubjectId: string;
  externalSubjectId: string;
};

export type SubjectErasureResult = {
  requestId: string;
  status: "local_completed";
};

export type SubjectErasureServiceOptions = {
  pool: Pool;
  secretsProvider: SecretsProvider;
  clock: Clock;
};

function validateRetainedSecrets(
  secrets: readonly TenantSecret[],
): readonly TenantSecret[] {
  if (secrets.length === 0) throw new Error("Tenant keyring is empty.");
  const versions = new Set<number>();
  for (const secret of secrets) {
    if (
      !Number.isInteger(secret.keyVersion) ||
      secret.keyVersion < 1 ||
      secret.keyVersion > 32_767 ||
      secret.key.byteLength < 32 ||
      versions.has(secret.keyVersion)
    ) {
      throw new Error("Tenant keyring is invalid.");
    }
    versions.add(secret.keyVersion);
  }
  return [...secrets].toSorted(
    (left, right) => left.keyVersion - right.keyVersion,
  );
}

function subjectPseudonyms(
  tenantId: string,
  rawSubjectIdentifier: string,
  secrets: readonly TenantSecret[],
): readonly SubjectPseudonym[] {
  return secrets.map((secret) => {
    const pseudonymousSubjectId = pseudonymizeIdentifier(
      rawSubjectIdentifier,
      secret.key,
    );
    return {
      keyVersion: secret.keyVersion,
      pseudonymousSubjectId,
      externalSubjectId: sha256Hex(
        [
          "planeir:external-subject:v1",
          tenantId.toLowerCase(),
          String(secret.keyVersion),
          pseudonymousSubjectId,
        ].join(":"),
      ),
    };
  });
}

/**
 * Performs the local part of a subject erasure before returning. Third-party
 * deletion is represented by two durable outbox rows and therefore never runs
 * in the HTTP request path.
 *
 * The M4 migration's session_events trigger requires both an authorization row
 * and matching transaction-local operation metadata. Production must
 * additionally protect writes to that authorization table with a
 * SECURITY DEFINER routine or a least-privilege runtime role; GUCs by
 * themselves are not an authorization boundary.
 */
export class SubjectErasureService {
  constructor(private readonly options: SubjectErasureServiceOptions) {}

  async requestErasure(input: {
    tenantId: string;
    actorLabel: string;
    rawSubjectIdentifier: string;
  }): Promise<SubjectErasureResult> {
    const tenantId = input.tenantId.toLowerCase();
    const retainedSecrets = validateRetainedSecrets(
      await this.options.secretsProvider.getRetainedSecrets(tenantId),
    );
    const currentSecret =
      await this.options.secretsProvider.getCurrentSecret(tenantId);
    if (
      !retainedSecrets.some(
        (secret) => secret.keyVersion === currentSecret.keyVersion,
      )
    ) {
      throw new Error("Current tenant key is not retained.");
    }

    const pseudonyms = subjectPseudonyms(
      tenantId,
      input.rawSubjectIdentifier,
      retainedSecrets,
    );
    const actorIdPseudo = pseudonymizeActor(
      input.actorLabel,
      currentSecret.key,
    );
    const requestId = randomUUID();
    const requestedAt = this.options.clock.now();
    const lockIdentity = sha256Hex(
      `${tenantId}:${pseudonyms
        .map((entry) => `${entry.keyVersion}:${entry.pseudonymousSubjectId}`)
        .join(",")}`,
    );

    const client = await this.options.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [lockIdentity],
      );

      const sessions = await client.query<{ session_id: string }>(
        `select session.session_id
         from fact_find_sessions session
         join unnest($2::smallint[], $3::text[])
           as subject_key(key_version, pseudonymous_subject_id)
           on subject_key.key_version = session.key_version
          and subject_key.pseudonymous_subject_id =
              session.pseudonymous_subject_id
         where session.tenant_id = $1
         order by session.session_id
         for update of session`,
        [
          tenantId,
          pseudonyms.map((entry) => entry.keyVersion),
          pseudonyms.map((entry) => entry.pseudonymousSubjectId),
        ],
      );
      const sessionIds = sessions.rows.map((row) => row.session_id);

      await client.query(
        `insert into privacy_scrub_authorizations (
           tenant_id, operation_id, operation_type
         ) values ($1, $2, 'erasure')`,
        [tenantId, requestId],
      );
      await client.query(
        `insert into erasure_requests (
           request_id, tenant_id, requested_by_actor_pseudo,
           key_version, key_versions_checked, matched_sessions, status,
           created_at
         ) values (
           $1, $2, $3, $4, $5::smallint[], $6, 'pending', $7
         )`,
        [
          requestId,
          tenantId,
          actorIdPseudo,
          currentSecret.keyVersion,
          pseudonyms.map((entry) => entry.keyVersion),
          sessionIds.length,
          requestedAt,
        ],
      );
      await client.query(
        `select set_config('planeir.scrub_tenant_id', $1, true),
                set_config('planeir.scrub_operation_id', $2, true),
                set_config('planeir.scrub_operation_type', 'erasure', true)`,
        [tenantId, requestId],
      );

      // Delete in child-first order. Aggregate partner-export rows are not
      // subject-addressable and are deliberately outside this local scrub.
      await client.query(
        `delete from telemetry_outbox outbox
         using session_events event
         where outbox.tenant_id = $1
           and event.tenant_id = outbox.tenant_id
           and event.event_id = outbox.event_id
           and event.session_id = any($2::uuid[])`,
        [tenantId, sessionIds],
      );
      await client.query(
        `delete from adviser_corrections
         where tenant_id = $1 and session_id = any($2::uuid[])`,
        [tenantId, sessionIds],
      );
      await client.query(
        `delete from field_extractions
         where tenant_id = $1 and session_id = any($2::uuid[])`,
        [tenantId, sessionIds],
      );
      await client.query(
        `delete from provider_usage
         where tenant_id = $1 and session_id = any($2::uuid[])`,
        [tenantId, sessionIds],
      );
      await client.query(
        `delete from document_events
         where tenant_id = $1 and session_id = any($2::uuid[])`,
        [tenantId, sessionIds],
      );
      await client.query(
        `delete from consent_ledger
         where tenant_id = $1 and session_id = any($2::uuid[])`,
        [tenantId, sessionIds],
      );
      await client.query(
        `delete from consent_deletion_queue
         where tenant_id = $1 and session_id = any($2::uuid[])`,
        [tenantId, sessionIds],
      );
      await client.query(
        `delete from subject_metric_exclusions exclusion
         using unnest($2::smallint[], $3::text[])
           as subject_key(key_version, pseudonymous_subject_id)
         where exclusion.tenant_id = $1
           and exclusion.key_version = subject_key.key_version
           and exclusion.pseudonymous_subject_id =
               subject_key.pseudonymous_subject_id`,
        [
          tenantId,
          pseudonyms.map((entry) => entry.keyVersion),
          pseudonyms.map((entry) => entry.pseudonymousSubjectId),
        ],
      );
      await client.query(
        `delete from session_events
         where tenant_id = $1 and session_id = any($2::uuid[])`,
        [tenantId, sessionIds],
      );
      await client.query(
        `delete from fact_find_sessions
         where tenant_id = $1 and session_id = any($2::uuid[])`,
        [tenantId, sessionIds],
      );

      const externalSubjectIds = pseudonyms.map(
        (entry) => entry.externalSubjectId,
      );
      await client.query(
        `insert into privacy_deletion_outbox (
           outbox_id, request_id, tenant_id, sink, external_subject_ids,
           external_subject_key_versions, session_ids, attempt_count,
           next_attempt_at, created_at
         ) values
           ($1, $2, $3, 'analytics', $4::text[], $5::smallint[],
            $6::uuid[], 0, $7, $7),
           ($8, $2, $3, 'traces', $4::text[], $5::smallint[],
            $6::uuid[], 0, $7, $7)`,
        [
          randomUUID(),
          requestId,
          tenantId,
          externalSubjectIds,
          pseudonyms.map((entry) => entry.keyVersion),
          sessionIds,
          requestedAt,
          randomUUID(),
        ],
      );
      await client.query(
        `update erasure_requests
         set status = 'local_completed', local_completed_at = $2
         where request_id = $1`,
        [requestId, this.options.clock.now()],
      );
      await client.query("commit");
      return { requestId, status: "local_completed" };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

type PrivacyDeletionOutboxRow = {
  outbox_id: string;
  request_id: string;
  tenant_id: string;
  sink: "analytics" | "traces";
  external_subject_ids: string[];
  external_subject_key_versions: number[];
  session_ids: string[];
  attempt_count: number;
};

export type PrivacyDeletionWorkerOptions = {
  pool: Pool;
  clock: Clock;
  analytics: AnalyticsSink;
  traces: TraceSink;
  retryBaseMilliseconds: number;
  retryMaxMilliseconds: number;
};

/**
 * Drains persisted rights-deletion work. A request becomes `completed` only
 * after both sink rows have succeeded; local completion alone is intentionally
 * represented as `local_completed`.
 */
export class PrivacyDeletionWorker {
  constructor(private readonly options: PrivacyDeletionWorkerOptions) {}

  async runOnce(outboxId?: string): Promise<boolean> {
    const client = await this.options.pool.connect();
    try {
      await client.query("begin");
      const now = this.options.clock.now();
      const claim = await client.query<PrivacyDeletionOutboxRow>(
        `select outbox_id, request_id, tenant_id, sink,
                external_subject_ids, external_subject_key_versions,
                session_ids, attempt_count
         from privacy_deletion_outbox
         where processed_at is null
           and next_attempt_at <= $1
           and ($2::uuid is null or outbox_id = $2)
         order by next_attempt_at, created_at, outbox_id
         for update skip locked
         limit 1`,
        [now, outboxId ?? null],
      );
      const row = claim.rows[0];
      if (!row) {
        await client.query("commit");
        return false;
      }

      const deletion: SubjectDeletionRequest = {
        deletionId: row.outbox_id,
        tenantId: row.tenant_id,
        externalSubjectIds: row.external_subject_ids,
        externalSubjectKeyVersions: row.external_subject_key_versions,
        sessionIds: row.session_ids,
      };
      let succeeded = false;
      try {
        if (row.sink === "analytics") {
          await this.options.analytics.deletePerson(deletion);
        } else {
          await this.options.traces.deleteTraces(deletion);
        }
        succeeded = true;
      } catch {
        // Persist only a categorical failure; sink exceptions may contain
        // backend details and never belong in the privacy ledger.
      }

      const finishedAt = this.options.clock.now();
      const attemptCount = row.attempt_count + 1;
      const backoffMilliseconds = Math.min(
        this.options.retryMaxMilliseconds,
        this.options.retryBaseMilliseconds *
          2 ** Math.min(attemptCount - 1, 30),
      );
      const nextAttemptAt = succeeded
        ? finishedAt
        : new Date(finishedAt.getTime() + backoffMilliseconds);
      await client.query(
        `update privacy_deletion_outbox
         set attempt_count = $2,
             next_attempt_at = $3,
             processed_at = case when $4::boolean then $1 else null end,
             last_failure_code = case
               when $4::boolean then null else 'sink_delete_failed' end,
             external_subject_ids = case
               when $4::boolean then array[]::text[]
               else external_subject_ids end,
             external_subject_key_versions = case
               when $4::boolean then array[]::smallint[]
               else external_subject_key_versions end,
             session_ids = case
               when $4::boolean then array[]::uuid[]
               else session_ids end
         where outbox_id = $5`,
        [
          finishedAt,
          attemptCount,
          nextAttemptAt,
          succeeded,
          row.outbox_id,
        ],
      );

      if (succeeded) {
        const pending = await client.query<{ count: number }>(
          `select count(*)::integer as count
           from privacy_deletion_outbox
           where request_id = $1 and processed_at is null`,
          [row.request_id],
        );
        if ((pending.rows[0]?.count ?? 0) === 0) {
          await client.query(
            `update erasure_requests
             set status = 'completed', completed_at = $2
             where request_id = $1
               and status = 'local_completed'
               and completed_at is null`,
            [row.request_id, finishedAt],
          );
        }
      }

      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async drainAvailable(limit = 100): Promise<number> {
    let drained = 0;
    while (drained < limit && (await this.runOnce())) drained += 1;
    return drained;
  }
}

export function startPrivacyDeletionPolling(
  worker: PrivacyDeletionWorker,
  pollIntervalMilliseconds: number,
  onError: () => void,
): { stop(): Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = worker
        .drainAvailable()
        .then(() => undefined)
        .catch(() => onError())
        .finally(schedule);
    }, pollIntervalMilliseconds);
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
