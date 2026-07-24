import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { authenticationHook } from "../auth/tenant-context.js";
import type { DatabaseConnection } from "../db/client.js";

// Read-only analytics surface for the advisor dashboard. Everything here is
// scoped to the authenticated key's tenant, requires the least-privilege `read`
// scope, and returns ONLY derived aggregates and allowlisted categorical facts
// — never raw attrs blobs, subject pseudonyms, hashes, or secrets. The advisor
// BFF (Cloudflare Worker) is the only intended caller; the browser never holds
// the read key and never reaches this service directly (blocked by the site
// CSP). Metrics mirror the daily metric views: sessions are attributed to the
// UTC calendar date of their `session.started` server received_at, and every
// query excludes subjects that have withdrawn telemetry consent (the same
// `subject_metric_exclusions` rule the metric snapshots apply), so the
// dashboard is consistent with the snapshot layer.

const MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const rangeQuerySchema = z
  .object({
    from: z.string().regex(DATE_RE).optional(),
    to: z.string().regex(DATE_RE).optional(),
  })
  .strict();

type ResolvedRange = {
  from: string;
  to: string;
  windowStart: Date;
  windowEnd: Date;
  includesPartialToday: boolean;
};

/** Today's UTC calendar date (YYYY-MM-DD). */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A calendar date is valid only if it round-trips (rejects 2026-02-30 etc.). */
function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Resolves an inclusive [from, to] calendar range into a half-open UTC instant
 * window [from 00:00Z, to+1day 00:00Z). Defaults to the last 30 UTC days.
 * Returns a validation error string instead of throwing.
 */
function resolveRange(query: {
  from?: string | undefined;
  to?: string | undefined;
}): ResolvedRange | { error: string } {
  const today = utcToday();
  const to = query.to ?? today;
  const from =
    query.from ??
    new Date(new Date(`${to}T00:00:00.000Z`).getTime() - 29 * DAY_MS)
      .toISOString()
      .slice(0, 10);

  if (!isRealDate(from) || !isRealDate(to)) {
    return { error: "Invalid date in range." };
  }
  const startMs = new Date(`${from}T00:00:00.000Z`).getTime();
  const endExclusiveMs = new Date(`${to}T00:00:00.000Z`).getTime() + DAY_MS;
  if (endExclusiveMs <= startMs) {
    return { error: "Range end must be on or after range start." };
  }
  if (endExclusiveMs - startMs > (MAX_RANGE_DAYS + 1) * DAY_MS) {
    return { error: `Range must not exceed ${MAX_RANGE_DAYS} days.` };
  }

  return {
    from,
    to,
    windowStart: new Date(startMs),
    windowEnd: new Date(endExclusiveMs),
    includesPartialToday: to >= today,
  };
}

/** Ratio that is null (not 0) when the denominator is 0, matching the views. */
function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// The shared cohort of in-range, consent-included sessions and their terminal
// facts. Reused verbatim by the overview and timeseries queries so both agree.
const COHORT_FACTS_CTE = `
  WITH included AS (
    SELECT s.session_id, s.pseudonymous_subject_id, s.key_version, s.module_version_id
      FROM fact_find_sessions s
     WHERE s.tenant_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM subject_metric_exclusions ex
          WHERE ex.tenant_id = s.tenant_id
            AND ex.key_version = s.key_version
            AND ex.pseudonymous_subject_id = s.pseudonymous_subject_id
       )
  ),
  cohort AS (
    SELECT se.session_id, min(se.received_at) AS started_at
      FROM session_events se
      JOIN included i ON i.session_id = se.session_id
     WHERE se.tenant_id = $1
       AND se.event_type = 'session.started'
       AND se.received_at >= $2 AND se.received_at < $3
     GROUP BY se.session_id
  ),
  facts AS (
    SELECT
      c.session_id,
      (c.started_at AT TIME ZONE 'UTC')::date AS started_date,
      i.pseudonymous_subject_id, i.key_version,
      EXISTS (SELECT 1 FROM session_events e WHERE e.tenant_id = $1 AND e.session_id = c.session_id AND e.event_type = 'call.connected') AS connected,
      EXISTS (SELECT 1 FROM session_events e WHERE e.tenant_id = $1 AND e.session_id = c.session_id AND e.event_type = 'call.connect_failed') AS connect_failed,
      EXISTS (SELECT 1 FROM session_events e WHERE e.tenant_id = $1 AND e.session_id = c.session_id AND e.event_type IN ('call.dropped', 'call.hung_up') AND e.attrs->>'cause_class' = 'technical') AS dropped_technical,
      comp.outcome, comp.turn_count, comp.duration_ms, comp.abandonment_cause,
      (comp.session_id IS NOT NULL) AS completed
    FROM cohort c
    JOIN included i ON i.session_id = c.session_id
    LEFT JOIN LATERAL (
      SELECT e.session_id,
             e.attrs->>'outcome' AS outcome,
             NULLIF(e.attrs->>'turn_count', '')::int AS turn_count,
             e.duration_ms,
             e.attrs->>'abandonment_cause' AS abandonment_cause
        FROM session_events e
       WHERE e.tenant_id = $1 AND e.session_id = c.session_id AND e.event_type = 'session.completed'
       ORDER BY e.received_at DESC, e.event_id DESC
       LIMIT 1
    ) comp ON true
  )`;

type CauseRow = { cause: string; n: number };

export type AnalyticsRouteDependencies = {
  connection: DatabaseConnection;
};

export function registerAnalyticsRoutes(
  app: FastifyInstance,
  dependencies: AnalyticsRouteDependencies,
): void {
  const { pool } = dependencies.connection;

  // Headline KPIs for the range: volume, funnel, outcome mix, engagement, and
  // the derived rates an operator reads first.
  app.get(
    "/v1/analytics/overview",
    { onRequest: authenticationHook(dependencies.connection, "read") },
    async (request, reply) => {
      const tenantContext = request.tenantContext;
      if (!tenantContext) return;

      const parsed = rangeQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid query" });
      }
      const range = resolveRange(parsed.data);
      if ("error" in range) {
        return reply.status(400).send({ error: range.error });
      }

      const tenantId = tenantContext.tenantId;
      const rollup = await pool.query<{
        started: number;
        connected: number;
        connect_failed: number;
        dropped_technical: number;
        completed: number;
        connected_completed: number;
        outcome_completed: number;
        outcome_abandoned: number;
        outcome_failed: number;
        abandoned_technical: number;
        abandoned_non_technical: number;
        distinct_subjects: number;
        median_duration_ms: number | null;
        avg_duration_ms: number | null;
        median_turn_count: number | null;
      }>(
        `${COHORT_FACTS_CTE}
         SELECT
           count(*)::int AS started,
           count(*) FILTER (WHERE connected)::int AS connected,
           count(*) FILTER (WHERE connect_failed)::int AS connect_failed,
           count(*) FILTER (WHERE dropped_technical)::int AS dropped_technical,
           count(*) FILTER (WHERE completed)::int AS completed,
           count(*) FILTER (WHERE connected AND outcome = 'completed')::int AS connected_completed,
           count(*) FILTER (WHERE outcome = 'completed')::int AS outcome_completed,
           count(*) FILTER (WHERE outcome = 'abandoned')::int AS outcome_abandoned,
           count(*) FILTER (WHERE outcome = 'failed')::int AS outcome_failed,
           count(*) FILTER (WHERE outcome IN ('abandoned', 'failed') AND abandonment_cause = 'technical')::int AS abandoned_technical,
           count(*) FILTER (WHERE outcome IN ('abandoned', 'failed') AND abandonment_cause = 'non_technical')::int AS abandoned_non_technical,
           count(DISTINCT (pseudonymous_subject_id, key_version))::int AS distinct_subjects,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS median_duration_ms,
           avg(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS avg_duration_ms,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY turn_count) FILTER (WHERE turn_count IS NOT NULL) AS median_turn_count
         FROM facts`,
        [tenantId, range.windowStart, range.windowEnd],
      );

      const connectFailedCauses = await pool.query<CauseRow>(
        `SELECT coalesce(e.attrs->>'cause_detail', 'other') AS cause, count(*)::int AS n
           FROM session_events e
           JOIN fact_find_sessions s ON s.tenant_id = e.tenant_id AND s.session_id = e.session_id
          WHERE e.tenant_id = $1
            AND e.event_type = 'call.connect_failed'
            AND e.received_at >= $2 AND e.received_at < $3
            AND NOT EXISTS (
              SELECT 1 FROM subject_metric_exclusions ex
               WHERE ex.tenant_id = s.tenant_id AND ex.key_version = s.key_version
                 AND ex.pseudonymous_subject_id = s.pseudonymous_subject_id
            )
          GROUP BY 1 ORDER BY n DESC, cause ASC`,
        [tenantId, range.windowStart, range.windowEnd],
      );

      const droppedCauses = await pool.query<CauseRow>(
        `SELECT coalesce(e.attrs->>'cause_detail', 'other') AS cause, count(*)::int AS n
           FROM session_events e
           JOIN fact_find_sessions s ON s.tenant_id = e.tenant_id AND s.session_id = e.session_id
          WHERE e.tenant_id = $1
            AND e.event_type IN ('call.dropped', 'call.hung_up')
            AND e.attrs->>'cause_class' = 'technical'
            AND e.received_at >= $2 AND e.received_at < $3
            AND NOT EXISTS (
              SELECT 1 FROM subject_metric_exclusions ex
               WHERE ex.tenant_id = s.tenant_id AND ex.key_version = s.key_version
                 AND ex.pseudonymous_subject_id = s.pseudonymous_subject_id
            )
          GROUP BY 1 ORDER BY n DESC, cause ASC`,
        [tenantId, range.windowStart, range.windowEnd],
      );

      const r = rollup.rows[0];
      const started = r?.started ?? 0;
      const connected = r?.connected ?? 0;

      return reply.send({
        range: { from: range.from, to: range.to, includes_partial_today: range.includesPartialToday },
        totals: {
          started,
          connected,
          connect_failed: r?.connect_failed ?? 0,
          completed: r?.completed ?? 0,
          dropped_technical: r?.dropped_technical ?? 0,
          distinct_subjects: r?.distinct_subjects ?? 0,
          outcome: {
            completed: r?.outcome_completed ?? 0,
            abandoned: r?.outcome_abandoned ?? 0,
            failed: r?.outcome_failed ?? 0,
          },
          abandonment: {
            technical: r?.abandoned_technical ?? 0,
            non_technical: r?.abandoned_non_technical ?? 0,
          },
        },
        rates: {
          // How reliably calls reach the client.
          connection_success: ratio(connected, started),
          // Any completion over all starts.
          completion: ratio(r?.completed ?? 0, started),
          // End-to-end success: a clean, useful headline for scaling/investors.
          clean_completion: ratio(r?.outcome_completed ?? 0, started),
          // Technical drops among calls that actually connected.
          technical_drop: ratio(r?.dropped_technical ?? 0, connected),
          // Of calls that connected, the share that reached a successful
          // outcome — isolates conversation quality from connection issues.
          post_connect_completion: ratio(r?.connected_completed ?? 0, connected),
        },
        engagement: {
          median_duration_ms: toNumberOrNull(r?.median_duration_ms),
          avg_duration_ms: toNumberOrNull(r?.avg_duration_ms),
          median_turn_count: toNumberOrNull(r?.median_turn_count),
        },
        causes: {
          connect_failed: connectFailedCauses.rows,
          dropped_technical: droppedCauses.rows,
        },
      });
    },
  );

  // Daily series for trend charts. Sparse: only days with at least one start
  // appear; the client fills gaps. Rates are left to the client to derive from
  // the counts so a zero-denominator day is never a misleading 0%.
  app.get(
    "/v1/analytics/timeseries",
    { onRequest: authenticationHook(dependencies.connection, "read") },
    async (request, reply) => {
      const tenantContext = request.tenantContext;
      if (!tenantContext) return;

      const parsed = rangeQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid query" });
      }
      const range = resolveRange(parsed.data);
      if ("error" in range) {
        return reply.status(400).send({ error: range.error });
      }

      const rows = await pool.query<{
        date: string;
        started: number;
        connected: number;
        completed: number;
        abandoned: number;
        failed: number;
        connect_failed: number;
        dropped_technical: number;
        distinct_subjects: number;
      }>(
        `${COHORT_FACTS_CTE}
         SELECT started_date::text AS date,
           count(*)::int AS started,
           count(*) FILTER (WHERE connected)::int AS connected,
           count(*) FILTER (WHERE completed)::int AS completed,
           count(*) FILTER (WHERE outcome = 'abandoned')::int AS abandoned,
           count(*) FILTER (WHERE outcome = 'failed')::int AS failed,
           count(*) FILTER (WHERE connect_failed)::int AS connect_failed,
           count(*) FILTER (WHERE dropped_technical)::int AS dropped_technical,
           count(DISTINCT (pseudonymous_subject_id, key_version))::int AS distinct_subjects
         FROM facts
         GROUP BY started_date
         ORDER BY started_date`,
        [tenantContext.tenantId, range.windowStart, range.windowEnd],
      );

      return reply.send({
        range: { from: range.from, to: range.to, includes_partial_today: range.includesPartialToday },
        interval: "day",
        series: rows.rows,
      });
    },
  );

  // Threshold alerts the metrics runner recorded in the range. metric_date is a
  // calendar date, so the range is compared inclusively on the date itself.
  app.get(
    "/v1/analytics/alerts",
    { onRequest: authenticationHook(dependencies.connection, "read") },
    async (request, reply) => {
      const tenantContext = request.tenantContext;
      if (!tenantContext) return;

      const parsed = rangeQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid query" });
      }
      const range = resolveRange(parsed.data);
      if ("error" in range) {
        return reply.status(400).send({ error: range.error });
      }

      const rows = await pool.query<{
        metric_date: string;
        alert_type: string;
        dimension: string;
        severity: string;
        observed_value: number | null;
        threshold_value: number | null;
      }>(
        `SELECT metric_date::text AS metric_date, alert_type, dimension, severity,
                observed_value, threshold_value
           FROM metric_alerts
          WHERE tenant_id = $1 AND metric_date >= $2 AND metric_date <= $3
          ORDER BY metric_date DESC, (severity = 'critical') DESC, alert_type ASC`,
        [tenantContext.tenantId, range.from, range.to],
      );

      return reply.send({
        range: { from: range.from, to: range.to, includes_partial_today: range.includesPartialToday },
        alerts: rows.rows.map((row) => ({
          metric_date: row.metric_date,
          alert_type: row.alert_type,
          dimension: row.dimension,
          severity: row.severity,
          observed_value: toNumberOrNull(row.observed_value),
          threshold_value: toNumberOrNull(row.threshold_value),
        })),
      });
    },
  );
}
