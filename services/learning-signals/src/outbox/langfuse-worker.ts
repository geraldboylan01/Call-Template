import type { Pool } from "pg";

import type { ObservabilityConfig } from "../sinks/observability-config.js";
import { loadObservabilityConfig } from "../sinks/observability-config.js";
import {
  maskLangfuseGeneration,
  type LangfuseSink,
} from "../sinks/telemetry-sinks.js";
import type { Clock } from "../telemetry/clock.js";
import { SystemClock } from "../telemetry/clock.js";

type ProviderUsageOutboxRow = {
  outbox_id: string;
  tenant_id: string;
  usage_id: string;
  session_id: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  latency_ms: number;
  cost_micros: string;
  attempt_count: number;
};

export type LangfuseForwardWorkerOptions = {
  pool: Pool;
  langfuse: LangfuseSink;
  clock?: Clock;
  observability?: ObservabilityConfig;
  retryBaseMilliseconds: number;
  retryMaxMilliseconds: number;
};

/**
 * Drains provider_usage_outbox to Langfuse. Each provider_usage row is turned
 * into a raw generation object and then MASKED to metadata-only fields before
 * it leaves the process, so no prompt/completion content can reach Langfuse
 * even if the source table ever grew a content column. Retries with capped
 * exponential backoff; no third-party call happens in a request path.
 */
export class LangfuseForwardWorker {
  private readonly pool: Pool;
  private readonly langfuse: LangfuseSink;
  private readonly clock: Clock;
  private readonly fieldAllowlist: ReadonlySet<string>;
  private readonly retryBaseMilliseconds: number;
  private readonly retryMaxMilliseconds: number;

  constructor(options: LangfuseForwardWorkerOptions) {
    this.pool = options.pool;
    this.langfuse = options.langfuse;
    this.clock = options.clock ?? new SystemClock();
    this.fieldAllowlist = (
      options.observability ?? loadObservabilityConfig()
    ).langfuseGenerationFieldAllowlist;
    this.retryBaseMilliseconds = options.retryBaseMilliseconds;
    this.retryMaxMilliseconds = options.retryMaxMilliseconds;
  }

  async runOnce(outboxId?: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const now = this.clock.now();
      const claim = await client.query<ProviderUsageOutboxRow>(
        `select outbox.outbox_id, outbox.tenant_id, outbox.usage_id,
                outbox.attempt_count,
                usage.session_id, usage.provider, usage.model,
                usage.input_tokens, usage.output_tokens,
                usage.cached_input_tokens, usage.latency_ms, usage.cost_micros
           from provider_usage_outbox outbox
           join provider_usage usage on usage.usage_id = outbox.usage_id
          where outbox.processed_at is null
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

      // The raw object deliberately includes only operational fields; the mask
      // is the belt-and-braces guarantee that nothing else could ever ship.
      const rawGeneration: Record<string, unknown> = {
        generation_id: row.usage_id,
        request_id: row.usage_id,
        tenant_id: row.tenant_id,
        session_id: row.session_id,
        provider: row.provider,
        model: row.model,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cached_input_tokens: row.cached_input_tokens,
        latency_ms: row.latency_ms,
        cost_micros: Number(row.cost_micros),
      };
      const masked = maskLangfuseGeneration(rawGeneration, this.fieldAllowlist);

      let succeeded = false;
      try {
        await this.langfuse.captureGeneration(masked);
        succeeded = true;
      } catch {
        // Categorical failure only; sink exceptions never enter the ledger.
      }

      const finishedAt = this.clock.now();
      const attemptCount = row.attempt_count + 1;
      const backoffMilliseconds = Math.min(
        this.retryMaxMilliseconds,
        this.retryBaseMilliseconds * 2 ** Math.min(attemptCount - 1, 30),
      );
      const nextAttemptAt = succeeded
        ? finishedAt
        : new Date(finishedAt.getTime() + backoffMilliseconds);
      await client.query(
        `update provider_usage_outbox
            set attempt_count = $2,
                next_attempt_at = $3,
                langfuse_delivered_at = case
                  when $4::boolean then coalesce(langfuse_delivered_at, $1::timestamptz)
                  else null end,
                processed_at = case when $4::boolean then $1::timestamptz else null end,
                last_failure_code = case
                  when $4::boolean then null else 'langfuse_delivery_failed' end
          where outbox_id = $5`,
        [finishedAt, attemptCount, nextAttemptAt, succeeded, row.outbox_id],
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

export function startLangfuseForwardPolling(
  worker: LangfuseForwardWorker,
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
