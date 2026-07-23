import type { Pool } from "pg";

import type { Clock } from "../telemetry/clock.js";
import type { EventCatalog } from "../telemetry/event-catalog.js";

type ConsentDeletionRow = {
  queue_id: string;
  tenant_id: string;
  session_id: string;
  consent_type:
    | "service_improvement_telemetry"
    | "partner_benchmarking"
    | "optional_demographics"
    | "marketing_referral";
};

export type ConsentDeletionWorkerOptions = {
  pool: Pool;
  catalog: EventCatalog;
  clock: Clock;
};

function eventTypesForQueue(
  catalog: EventCatalog,
  consentType: ConsentDeletionRow["consent_type"],
): readonly string[] {
  if (consentType === "optional_demographics") {
    return catalog.eventTypesForConsentClassification(
      "optional_demographics",
    );
  }
  if (consentType === "marketing_referral") {
    return catalog.eventTypesForConsentClassification("marketing_referral");
  }
  // Contract and minimised improvement signals remain under their documented
  // legal bases. Service/partner withdrawal suppresses delivery/cohort use,
  // but does not rewrite those append-only signals.
  return [];
}

/**
 * Drains purpose-dependent local deletion work created atomically by the
 * consent-ledger withdrawal trigger.
 */
export class ConsentDeletionWorker {
  constructor(private readonly options: ConsentDeletionWorkerOptions) {}

  async runOnce(queueId?: string): Promise<boolean> {
    const client = await this.options.pool.connect();
    try {
      await client.query("begin");
      const claim = await client.query<ConsentDeletionRow>(
        `select queue_id, tenant_id, session_id, consent_type
         from consent_deletion_queue
         where processed_at is null
           and ($1::uuid is null or queue_id = $1)
         order by created_at, queue_id
         for update skip locked
         limit 1`,
        [queueId ?? null],
      );
      const row = claim.rows[0];
      if (!row) {
        await client.query("commit");
        return false;
      }

      await client.query(
        `select 1
         from fact_find_sessions
         where tenant_id = $1 and session_id = $2
         for update`,
        [row.tenant_id, row.session_id],
      );
      await client.query(
        `insert into privacy_scrub_authorizations (
           tenant_id, operation_id, operation_type
         ) values ($1, $2, 'consent_withdrawal')`,
        [row.tenant_id, row.queue_id],
      );
      await client.query(
        `select set_config('planeir.scrub_tenant_id', $1, true),
                set_config('planeir.scrub_operation_id', $2, true),
                set_config(
                  'planeir.scrub_operation_type',
                  'consent_withdrawal',
                  true
                )`,
        [row.tenant_id, row.queue_id],
      );

      const eventTypes = eventTypesForQueue(
        this.options.catalog,
        row.consent_type,
      );
      if (eventTypes.length > 0) {
        const candidates = await client.query<{ event_id: string }>(
          `select event_id
           from session_events
           where tenant_id = $1
             and session_id = $2
             and event_type = any($3::text[])
           order by event_id`,
          [row.tenant_id, row.session_id, [...eventTypes]],
        );
        const eventIds = candidates.rows.map((candidate) => candidate.event_id);
        if (eventIds.length > 0) {
          await client.query(
            `delete from telemetry_outbox
             where tenant_id = $1 and event_id = any($2::uuid[])`,
            [row.tenant_id, eventIds],
          );
          await client.query(
            `delete from adviser_corrections correction
             using field_extractions extraction
             where correction.tenant_id = $1
               and extraction.tenant_id = correction.tenant_id
               and extraction.extraction_id = correction.extraction_id
               and extraction.source_event_id = any($2::uuid[])`,
            [row.tenant_id, eventIds],
          );
          await client.query(
            `delete from field_extractions
             where tenant_id = $1
               and source_event_id = any($2::uuid[])`,
            [row.tenant_id, eventIds],
          );
          await client.query(
            `delete from session_events
             where tenant_id = $1 and event_id = any($2::uuid[])`,
            [row.tenant_id, eventIds],
          );
        }
      }

      await client.query(
        `update consent_deletion_queue
         set processed_at = $2
         where queue_id = $1`,
        [row.queue_id, this.options.clock.now()],
      );
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

export function startConsentDeletionPolling(
  worker: ConsentDeletionWorker,
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
