import type { Pool } from "pg";

import type { PostHogSink, OtelSpanSink, ForwardedTelemetryEvent } from "../sinks/telemetry-sinks.js";
import type { Clock } from "../telemetry/clock.js";
import {
  consentGate,
  PostgresConsentStateResolver,
  type ConsentStateResolver,
} from "../telemetry/consent.js";
import type { EventCatalogRegistry } from "../telemetry/event-catalog.js";

type OutboxRow = {
  outbox_id: string;
  tenant_id: string;
  event_id: string;
  session_id: string;
  event_type: string;
  attrs: unknown;
  occurred_at: Date;
  received_at: Date;
  turn_index: number | null;
  duration_ms: number | null;
  config_version: string;
  attempt_count: number;
  posthog_delivered_at: Date | null;
  otel_delivered_at: Date | null;
};

export type OutboxWorkerOptions = {
  pool: Pool;
  catalogs: Pick<EventCatalogRegistry, "current" | "get">;
  clock: Clock;
  posthog: PostHogSink;
  otel: OtelSpanSink;
  consentResolver?: ConsentStateResolver;
  retryBaseMilliseconds: number;
  retryMaxMilliseconds: number;
};

export class OutboxWorker {
  private readonly consentResolver: ConsentStateResolver;

  constructor(private readonly options: OutboxWorkerOptions) {
    this.consentResolver =
      options.consentResolver ?? new PostgresConsentStateResolver();
  }

  async runOnce(outboxId?: string): Promise<boolean> {
    const client = await this.options.pool.connect();
    try {
      await client.query("begin");
      const now = this.options.clock.now();
      const claim = await client.query<OutboxRow>(
        `select outbox.outbox_id, outbox.tenant_id, outbox.event_id,
                outbox.config_version,
                outbox.attempt_count, outbox.posthog_delivered_at,
                outbox.otel_delivered_at, event.session_id,
                event.event_type, event.attrs,
                event.occurred_at, event.received_at, event.turn_index,
                event.duration_ms
         from telemetry_outbox outbox
         join session_events event
           on event.tenant_id = outbox.tenant_id
          and event.event_id = outbox.event_id
         where outbox.processed_at is null
           and outbox.suppressed_at is null
           and outbox.next_attempt_at <= $1
           and ($2::uuid is null or outbox.outbox_id = $2)
         order by outbox.next_attempt_at, outbox.created_at, outbox.outbox_id
         for update of outbox skip locked
         limit 1`,
        [now, outboxId ?? null],
      );
      const row = claim.rows[0];
      if (!row) {
        await client.query("commit");
        return false;
      }

      // Consent writers acquire this same tenant/session row lock before
      // appending a decision. This gives withdrawal a clear linearization
      // point: a delivery either finishes before withdrawal commits, or sees
      // the withdrawn current state and never calls a sink.
      await client.query(
        `select 1
           from fact_find_sessions
          where tenant_id = $1::uuid and session_id = $2::uuid
          for update`,
        [row.tenant_id, row.session_id],
      );
      const consentState = await this.consentResolver.resolveCurrentWithClient(
        client,
        { tenantId: row.tenant_id, sessionId: row.session_id },
      );
      const gate = consentGate(
        {
          eventType: row.event_type,
          // Projection remains pinned to the catalog stored on the outbox
          // row, while the current legal classification is intentionally
          // read from the latest installed catalog.
          classification:
            this.options.catalogs.current.consentClassification(row.event_type),
        },
        consentState,
      );
      if (!gate.forwardPosthog && !gate.forwardOtel) {
        const suppressedAt = this.options.clock.now();
        await client.query(
          `update telemetry_outbox
              set suppressed_at = $1,
                  suppression_reason = $2,
                  processed_at = $1,
                  last_failure_code = null
            where outbox_id = $3`,
          [suppressedAt, gate.reason, row.outbox_id],
        );
        await client.query("commit");
        return true;
      }

      let posthogDelivered = row.posthog_delivered_at !== null;
      let otelDelivered = row.otel_delivered_at !== null;
      let payload: ForwardedTelemetryEvent | undefined;
      try {
        const catalog = this.options.catalogs.get(row.config_version);
        if (!catalog) {
          throw new Error("Outbox event catalog version is unavailable.");
        }
        payload = {
          deliveryId: row.outbox_id,
          eventId: row.event_id,
          eventType: row.event_type,
          occurredAt: row.occurred_at.toISOString(),
          receivedAt: row.received_at.toISOString(),
          properties: catalog.projectProperties(
            row.event_type,
            row.attrs,
            { durationMs: row.duration_ms, turnIndex: row.turn_index },
          ),
        };
      } catch {
        payload = undefined;
      }

      if (payload && gate.forwardPosthog && !posthogDelivered) {
        try {
          await this.options.posthog.capture(payload);
          posthogDelivered = true;
        } catch {
          // The persisted failure code is deliberately categorical.
        }
      }
      if (payload && gate.forwardOtel && !otelDelivered) {
        try {
          await this.options.otel.exportSpan(payload);
          otelDelivered = true;
        } catch {
          // The persisted failure code is deliberately categorical.
        }
      }

      const attemptFinishedAt = this.options.clock.now();
      const attemptCount = row.attempt_count + 1;
      const processed = posthogDelivered && otelDelivered;
      const backoffMilliseconds = Math.min(
        this.options.retryMaxMilliseconds,
        this.options.retryBaseMilliseconds * 2 ** Math.min(attemptCount - 1, 30),
      );
      const nextAttemptAt = processed
        ? attemptFinishedAt
        : new Date(attemptFinishedAt.getTime() + backoffMilliseconds);
      await client.query(
        `update telemetry_outbox
         set attempt_count = $2,
             next_attempt_at = $3,
             posthog_delivered_at = case
               when $4::boolean then coalesce(posthog_delivered_at, $1) else null end,
             otel_delivered_at = case
               when $5::boolean then coalesce(otel_delivered_at, $1) else null end,
             processed_at = case when $6::boolean then $1 else null end,
             last_failure_code = case
               when $6::boolean then null else 'sink_delivery_failed' end
         where outbox_id = $7`,
        [
          attemptFinishedAt,
          attemptCount,
          nextAttemptAt,
          posthogDelivered,
          otelDelivered,
          processed,
          row.outbox_id,
        ],
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

export function startOutboxPolling(
  worker: OutboxWorker,
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
