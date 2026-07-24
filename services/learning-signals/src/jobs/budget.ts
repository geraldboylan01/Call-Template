import type { Pool } from "pg";

import type { ObservabilityConfig } from "../sinks/observability-config.js";
import { loadObservabilityConfig } from "../sinks/observability-config.js";
import {
  NoopObservabilitySpanSink,
  type ObservabilitySpanSink,
} from "../sinks/observability-spans.js";
import type { Clock } from "../telemetry/clock.js";
import { SystemClock } from "../telemetry/clock.js";
import { utcDateString } from "./metrics-runner.js";

export type BudgetGuardrailOptions = {
  pool: Pool;
  observability?: ObservabilityConfig;
  clock?: Clock;
  spans?: ObservabilitySpanSink;
};

export type BudgetEvaluation = {
  spendDate: string;
  alertCount: number;
};

/**
 * Per-tenant daily provider-spend guardrail (M7). Sums the day's real
 * provider_usage cost (NOT consent-filtered — this is a money guardrail that
 * must see actual spend, unlike the reportable M6 cost metric) and records a
 * provider_budget_alerts row for any tenant over its cap. The pilot never
 * hard-stops sessions; crossing the cap only raises this alert. Idempotent: a
 * date's alerts are rebuilt on each run.
 */
export class BudgetGuardrail {
  private readonly pool: Pool;
  private readonly defaultCapMicros: number;
  private readonly clock: Clock;
  private readonly spans: ObservabilitySpanSink;

  constructor(options: BudgetGuardrailOptions) {
    this.pool = options.pool;
    this.defaultCapMicros = (
      options.observability ?? loadObservabilityConfig()
    ).budgetDefaultDailyCapMicros;
    this.clock = options.clock ?? new SystemClock();
    this.spans = options.spans ?? new NoopObservabilitySpanSink();
  }

  async runOnce(tenantScope?: string): Promise<BudgetEvaluation> {
    const yesterday = new Date(this.clock.now().getTime() - 24 * 60 * 60 * 1000);
    return this.evaluateDay(utcDateString(yesterday), tenantScope);
  }

  async evaluateDay(spendDate: string, tenantScope?: string): Promise<BudgetEvaluation> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(spendDate)) {
      throw new Error("spendDate must be an ISO calendar date (YYYY-MM-DD).");
    }
    const scope = tenantScope?.toLowerCase() ?? null;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `delete from provider_budget_alerts
          where spend_date = $1 and ($2::uuid is null or tenant_id = $2)`,
        [spendDate, scope],
      );
      const inserted = await client.query(
        `with spend as (
           select pu.tenant_id, sum(pu.cost_micros)::bigint as spend_micros
             from provider_usage pu
            where (pu.created_at at time zone 'UTC')::date = $1
              and ($2::uuid is null or pu.tenant_id = $2)
            group by pu.tenant_id
         ),
         over_cap as (
           select s.tenant_id, s.spend_micros,
                  coalesce(b.daily_cap_micros, $3::bigint) as cap_micros
             from spend s
             left join tenant_provider_budgets b on b.tenant_id = s.tenant_id
            where s.spend_micros > coalesce(b.daily_cap_micros, $3::bigint)
         )
         insert into provider_budget_alerts
           (tenant_id, spend_date, spend_micros, cap_micros)
         select tenant_id, $1, spend_micros, cap_micros from over_cap
         returning alert_id`,
        [spendDate, scope, this.defaultCapMicros],
      );
      await client.query("commit");
      const alertCount = inserted.rowCount ?? 0;
      // Operational span: ids/counts/dates only, never spend detail beyond the
      // aggregate alert count.
      this.spans.record({
        name: "learning_signals.budget_guardrail",
        attributes: { metric_date: spendDate, alert_count: alertCount },
      });
      return { spendDate, alertCount };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

const DAILY_BUDGET_INTERVAL_MILLISECONDS = 60 * 60 * 1000;

export function startDailyBudget(
  guardrail: BudgetGuardrail,
  onError: () => void,
): { stop(): Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = guardrail
        .runOnce()
        .then(() => undefined)
        .catch(() => onError())
        .finally(schedule);
    }, DAILY_BUDGET_INTERVAL_MILLISECONDS);
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
