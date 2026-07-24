import type { Pool, PoolClient } from "pg";

import {
  NoopObservabilitySpanSink,
  type ObservabilitySpanSink,
} from "../sinks/observability-spans.js";
import type { Clock } from "../telemetry/clock.js";
import { SystemClock } from "../telemetry/clock.js";
import { loadThresholds, type Thresholds } from "./thresholds.js";

// Whitelisted metric view names. These are internal constants, never client
// input, and every view emits the identical uniform snapshot shape so the
// runner materializes any of them with the same statement.
const METRIC_VIEWS = [
  "metrics_completion_daily",
  "metrics_dropoff_by_module_daily",
  "metrics_question_time_daily",
  "metrics_correction_rate_by_field_daily",
  "metrics_calibration_daily",
  "metrics_reliability_daily",
  "metrics_adviser_adoption_daily",
  "metrics_unit_economics_daily",
  "metrics_reconciliation_daily",
] as const;

export type MetricsRunSummary = {
  runId: string;
  metricDate: string;
  snapshotCount: number;
  alertCount: number;
};

export type MetricsRunnerOptions = {
  pool: Pool;
  thresholds?: Thresholds;
  clock?: Clock;
  spans?: ObservabilitySpanSink;
};

type AlertRow = {
  tenantId: string;
  alertType: string;
  dimension: string;
  severity: "warning" | "critical";
  observedValue: number | null;
  thresholdValue: number | null;
};

/** Formats an instant as its UTC calendar date (YYYY-MM-DD). */
export function utcDateString(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

export class MetricsRunner {
  private readonly pool: Pool;
  private readonly thresholds: Thresholds;
  private readonly clock: Clock;
  private readonly spans: ObservabilitySpanSink;

  constructor(options: MetricsRunnerOptions) {
    this.pool = options.pool;
    this.thresholds = options.thresholds ?? loadThresholds();
    this.clock = options.clock ?? new SystemClock();
    this.spans = options.spans ?? new NoopObservabilitySpanSink();
  }

  /** Runs every metric job for the previous complete UTC day. */
  async runOnce(tenantScope?: string): Promise<MetricsRunSummary> {
    const yesterday = new Date(this.clock.now().getTime() - 24 * 60 * 60 * 1000);
    return this.runDay(utcDateString(yesterday), tenantScope);
  }

  /**
   * Materializes all metric views for one UTC date into metric_daily_snapshots
   * and evaluates thresholds into metric_alerts. Idempotent: the date's
   * snapshot and alert rows (for the given tenant scope) are deleted and
   * rebuilt inside one transaction, so re-running a date converges to the same
   * derived state and never touches the append-only event ledger.
   */
  async runDay(metricDate: string, tenantScope?: string): Promise<MetricsRunSummary> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(metricDate)) {
      throw new Error("metricDate must be an ISO calendar date (YYYY-MM-DD).");
    }
    const scope = tenantScope?.toLowerCase() ?? null;

    const runInsert = await this.pool.query<{ run_id: string }>(
      `insert into metric_daily_runs
         (metric_date, tenant_scope, status, thresholds_version)
       values ($1, $2, 'running', $3)
       returning run_id`,
      [metricDate, scope, this.thresholds.version],
    );
    const runId = runInsert.rows[0]?.run_id;
    if (!runId) throw new Error("Failed to open a metric run.");

    const client = await this.pool.connect();
    try {
      await client.query("begin");

      await client.query(
        `delete from metric_daily_snapshots
          where metric_date = $1 and ($2::uuid is null or tenant_id = $2)`,
        [metricDate, scope],
      );
      let snapshotCount = 0;
      for (const view of METRIC_VIEWS) {
        const inserted = await client.query(
          `insert into metric_daily_snapshots
             (run_id, tenant_id, metric_date, metric_name, dimension,
              numerator, denominator, value, reviewed_denominator)
           select $1, tenant_id, metric_date, metric_name, dimension,
                  numerator, denominator, value, reviewed_denominator
           from ${view}
           where metric_date = $2 and ($3::uuid is null or tenant_id = $3)`,
          [runId, metricDate, scope],
        );
        snapshotCount += inserted.rowCount ?? 0;
      }

      await client.query(
        `delete from metric_alerts
          where metric_date = $1 and ($2::uuid is null or tenant_id = $2)`,
        [metricDate, scope],
      );
      const alerts = await this.evaluateAlerts(client, metricDate, scope);
      for (const alert of alerts) {
        await client.query(
          `insert into metric_alerts
             (run_id, tenant_id, metric_date, alert_type, dimension, severity,
              observed_value, threshold_value)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            runId,
            alert.tenantId,
            metricDate,
            alert.alertType,
            alert.dimension,
            alert.severity,
            alert.observedValue,
            alert.thresholdValue,
          ],
        );
      }

      await client.query(
        `update metric_daily_runs
            set status = 'completed', completed_at = now(),
                snapshot_count = $2, alert_count = $3
          where run_id = $1`,
        [runId, snapshotCount, alerts.length],
      );
      await client.query("commit");
      // Operational span: ids/counts/dates only, never event content.
      this.spans.record({
        name: "learning_signals.metrics_run",
        attributes: {
          run_id: runId,
          metric_date: metricDate,
          snapshot_count: snapshotCount,
          alert_count: alerts.length,
        },
      });
      return { runId, metricDate, snapshotCount, alertCount: alerts.length };
    } catch (error) {
      await client.query("rollback");
      await this.pool.query(
        `update metric_daily_runs
            set status = 'failed', completed_at = now()
          where run_id = $1`,
        [runId],
      );
      throw error;
    } finally {
      client.release();
    }
  }

  private async evaluateAlerts(
    client: PoolClient,
    metricDate: string,
    scope: string | null,
  ): Promise<AlertRow[]> {
    const alerts: AlertRow[] = [];

    // completion_rate below target.
    const completion = await client.query<{ tenant_id: string; value: number }>(
      `select tenant_id, value
         from metrics_completion_daily
        where metric_date = $1 and ($2::uuid is null or tenant_id = $2)
          and denominator > 0 and value < $3`,
      [metricDate, scope, this.thresholds.completion_rate.warn_below],
    );
    for (const row of completion.rows) {
      alerts.push({
        tenantId: row.tenant_id,
        alertType: "completion_rate_below_threshold",
        dimension: "",
        severity: "warning",
        observedValue: row.value,
        thresholdValue: this.thresholds.completion_rate.warn_below,
      });
    }

    // Reliability SLOs: connection success and technical drop rate.
    const connection = await client.query<{ tenant_id: string; value: number }>(
      `select tenant_id, value
         from metrics_reliability_daily
        where metric_date = $1 and ($2::uuid is null or tenant_id = $2)
          and metric_name = 'connection_success_rate'
          and denominator > 0 and value < $3`,
      [metricDate, scope, this.thresholds.reliability.connection_success_warn_below],
    );
    for (const row of connection.rows) {
      alerts.push({
        tenantId: row.tenant_id,
        alertType: "connection_success_below_threshold",
        dimension: "",
        severity: "critical",
        observedValue: row.value,
        thresholdValue: this.thresholds.reliability.connection_success_warn_below,
      });
    }

    const drop = await client.query<{ tenant_id: string; value: number }>(
      `select tenant_id, value
         from metrics_reliability_daily
        where metric_date = $1 and ($2::uuid is null or tenant_id = $2)
          and metric_name = 'mid_call_drop_rate'
          and denominator > 0 and value > $3`,
      [metricDate, scope, this.thresholds.reliability.drop_rate_warn_above],
    );
    for (const row of drop.rows) {
      alerts.push({
        tenantId: row.tenant_id,
        alertType: "drop_rate_above_threshold",
        dimension: "",
        severity: "critical",
        observedValue: row.value,
        thresholdValue: this.thresholds.reliability.drop_rate_warn_above,
      });
    }

    // Unit-economics cost drift vs the trailing baseline. Only alerts when the
    // baseline has enough history, so a cold start cannot fire spuriously.
    const economics = this.thresholds.unit_economics;
    const drift = await client.query<{
      tenant_id: string;
      today_value: number;
      baseline_avg: number | null;
      baseline_n: number;
    }>(
      `with today as (
         select tenant_id, value
           from metrics_unit_economics_daily
          where metric_name = 'cost_per_completed_factfind'
            and metric_date = $1 and value is not null
            and ($2::uuid is null or tenant_id = $2)
       ),
       baseline as (
         select tenant_id, avg(value) as baseline_avg, count(*)::int as baseline_n
           from metrics_unit_economics_daily
          where metric_name = 'cost_per_completed_factfind'
            and metric_date >= ($1::date - $3::int) and metric_date < $1::date
            and value is not null
            and ($2::uuid is null or tenant_id = $2)
          group by tenant_id
       )
       select t.tenant_id, t.value as today_value,
              b.baseline_avg, coalesce(b.baseline_n, 0) as baseline_n
         from today t
         left join baseline b on b.tenant_id = t.tenant_id`,
      [metricDate, scope, economics.baseline_days],
    );
    for (const row of drift.rows) {
      if (
        row.baseline_avg === null ||
        row.baseline_n < economics.baseline_min_days ||
        row.baseline_avg <= 0
      ) {
        continue;
      }
      const limit = economics.cost_per_session_warn_ratio * row.baseline_avg;
      if (row.today_value > limit) {
        alerts.push({
          tenantId: row.tenant_id,
          alertType: "cost_per_session_drift",
          dimension: "",
          severity: "warning",
          observedValue: row.today_value,
          thresholdValue: limit,
        });
      }
    }

    // Reconciliation divergence: ledger vs PostHog-forwarded.
    const reconciliation = await client.query<{ tenant_id: string; value: number }>(
      `select tenant_id, value
         from metrics_reconciliation_daily
        where metric_date = $1 and ($2::uuid is null or tenant_id = $2)
          and denominator > 0 and value > $3`,
      [metricDate, scope, this.thresholds.reconciliation.divergence_warn_above],
    );
    for (const row of reconciliation.rows) {
      alerts.push({
        tenantId: row.tenant_id,
        alertType: "reconciliation_divergence",
        dimension: "",
        severity: "warning",
        observedValue: row.value,
        thresholdValue: this.thresholds.reconciliation.divergence_warn_above,
      });
    }

    return alerts;
  }
}

const DAILY_METRICS_INTERVAL_MILLISECONDS = 60 * 60 * 1000;

/**
 * In-app daily metrics scheduler. Mirrors the retention scheduler: a self-
 * rescheduling unref'd timer that runs the previous UTC day's jobs. Cheap and
 * idempotent, so an hourly cadence simply keeps the latest complete day fresh;
 * operators who prefer cron can invoke src/jobs/metrics-cli.ts instead.
 */
export function startDailyMetrics(
  runner: MetricsRunner,
  onError: () => void,
): { stop(): Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = runner
        .runOnce()
        .then(() => undefined)
        .catch(() => onError())
        .finally(schedule);
    }, DAILY_METRICS_INTERVAL_MILLISECONDS);
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
