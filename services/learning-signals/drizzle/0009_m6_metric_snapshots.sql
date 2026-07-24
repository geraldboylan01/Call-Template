CREATE TABLE "metric_alerts" (
	"alert_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"alert_type" text NOT NULL,
	"dimension" text DEFAULT '' NOT NULL,
	"severity" text NOT NULL,
	"observed_value" double precision,
	"threshold_value" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_alerts_natural_unique" UNIQUE("tenant_id","metric_date","alert_type","dimension"),
	CONSTRAINT "metric_alerts_alert_type_check" CHECK ("metric_alerts"."alert_type" in (
        'completion_rate_below_threshold',
        'connection_success_below_threshold',
        'drop_rate_above_threshold',
        'cost_per_session_drift',
        'reconciliation_divergence'
      )),
	CONSTRAINT "metric_alerts_severity_check" CHECK ("metric_alerts"."severity" in ('warning', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "metric_daily_runs" (
	"run_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metric_date" date NOT NULL,
	"tenant_scope" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"snapshot_count" integer DEFAULT 0 NOT NULL,
	"alert_count" integer DEFAULT 0 NOT NULL,
	"thresholds_version" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_daily_runs_status_check" CHECK ("metric_daily_runs"."status" in ('running', 'completed', 'failed')),
	CONSTRAINT "metric_daily_runs_snapshot_count_check" CHECK ("metric_daily_runs"."snapshot_count" >= 0),
	CONSTRAINT "metric_daily_runs_alert_count_check" CHECK ("metric_daily_runs"."alert_count" >= 0),
	CONSTRAINT "metric_daily_runs_thresholds_version_check" CHECK (length(btrim("metric_daily_runs"."thresholds_version")) > 0),
	CONSTRAINT "metric_daily_runs_completed_at_check" CHECK (("metric_daily_runs"."status" = 'running' and "metric_daily_runs"."completed_at" is null) or ("metric_daily_runs"."status" <> 'running' and "metric_daily_runs"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "metric_daily_snapshots" (
	"snapshot_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"metric_name" text NOT NULL,
	"dimension" text DEFAULT '' NOT NULL,
	"numerator" double precision,
	"denominator" double precision,
	"value" double precision,
	"reviewed_denominator" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_daily_snapshots_natural_unique" UNIQUE("tenant_id","metric_date","metric_name","dimension"),
	CONSTRAINT "metric_daily_snapshots_metric_name_check" CHECK (length(btrim("metric_daily_snapshots"."metric_name")) > 0),
	CONSTRAINT "metric_daily_snapshots_denominator_check" CHECK ("metric_daily_snapshots"."denominator" is null or "metric_daily_snapshots"."denominator" >= 0),
	CONSTRAINT "metric_daily_snapshots_reviewed_denominator_check" CHECK ("metric_daily_snapshots"."reviewed_denominator" is null or "metric_daily_snapshots"."reviewed_denominator" >= 0)
);
--> statement-breakpoint
ALTER TABLE "metric_alerts" ADD CONSTRAINT "metric_alerts_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."metric_daily_runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_alerts" ADD CONSTRAINT "metric_alerts_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_daily_runs" ADD CONSTRAINT "metric_daily_runs_tenant_fk" FOREIGN KEY ("tenant_scope") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_daily_snapshots" ADD CONSTRAINT "metric_daily_snapshots_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."metric_daily_runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_daily_snapshots" ADD CONSTRAINT "metric_daily_snapshots_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "metric_alerts_tenant_date_idx" ON "metric_alerts" USING btree ("tenant_id","metric_date");--> statement-breakpoint
CREATE INDEX "metric_daily_runs_date_idx" ON "metric_daily_runs" USING btree ("metric_date","started_at");--> statement-breakpoint
CREATE INDEX "metric_daily_snapshots_tenant_metric_date_idx" ON "metric_daily_snapshots" USING btree ("tenant_id","metric_name","metric_date");--> statement-breakpoint

-- ===========================================================================
-- M6 daily metric views. Every view emits the SAME uniform shape so the runner
-- can materialize any of them generically:
--   (tenant_id uuid, metric_date date, metric_name text, dimension text,
--    numerator float8, denominator float8, value float8,
--    reviewed_denominator float8)
-- value is the headline number: a ratio (numerator/denominator, NULL when the
-- denominator is 0), a median/p95, a cost, or a raw count. metric_date is the
-- UTC calendar date of the driving server received_at (never client
-- occurred_at, which is used only for intra-session ordering). Definitions are
-- pinned in the comment above each view and MUST match the v1/v2 KPI spec.
-- The Postgres ledger is the single source of truth; these views are pure
-- derivations and never write.
-- ===========================================================================

-- Withdrawal enforcement, shared by every metric: a session is included only
-- when its pseudonymous subject is not present in subject_metric_exclusions
-- (the same rule the M4 DailyMetricsJob applies). Metrics therefore never
-- count a withdrawn subject in either numerator or denominator.
CREATE VIEW "metrics_included_sessions" AS
SELECT s.tenant_id, s.session_id, s.module_version_id,
       s.pseudonymous_subject_id, s.key_version
  FROM fact_find_sessions s
 WHERE NOT EXISTS (
   SELECT 1 FROM subject_metric_exclusions ex
    WHERE ex.tenant_id = s.tenant_id
      AND ex.key_version = s.key_version
      AND ex.pseudonymous_subject_id = s.pseudonymous_subject_id
 );--> statement-breakpoint

-- First review.completed per session defines "review time"; correction and
-- calibration metrics are snapshotted at that date and gated to reviewed
-- sessions only (the "% reviewed" denominator guard).
CREATE VIEW "metrics_reviewed_sessions" AS
SELECT DISTINCT ON (rc.tenant_id, rc.session_id)
       rc.tenant_id, rc.session_id,
       (rc.received_at AT TIME ZONE 'UTC')::date AS reviewed_date
  FROM session_events rc
  JOIN metrics_included_sessions mis
    ON mis.tenant_id = rc.tenant_id AND mis.session_id = rc.session_id
 WHERE rc.event_type = 'review.completed'
 ORDER BY rc.tenant_id, rc.session_id, rc.received_at ASC, rc.event_id ASC;--> statement-breakpoint

-- completion_rate = (# sessions with a session.completed event)
--                 / (# sessions with a session.started event),
-- attributed to the UTC date of the session.started event's received_at. A
-- session that completes on a later day still counts toward its start day, so
-- a day's ratio is stable once its starts are in.
CREATE VIEW "metrics_completion_daily" AS
WITH started AS (
  SELECT se.tenant_id, se.session_id,
         (se.received_at AT TIME ZONE 'UTC')::date AS metric_date
    FROM session_events se
    JOIN metrics_included_sessions mis
      ON mis.tenant_id = se.tenant_id AND mis.session_id = se.session_id
   WHERE se.event_type = 'session.started'
),
completed AS (
  SELECT DISTINCT tenant_id, session_id
    FROM session_events
   WHERE event_type = 'session.completed'
)
SELECT s.tenant_id, s.metric_date,
       'completion_rate'::text AS metric_name, ''::text AS dimension,
       count(DISTINCT s.session_id) FILTER (WHERE c.session_id IS NOT NULL)::float8
         AS numerator,
       count(DISTINCT s.session_id)::float8 AS denominator,
       CASE WHEN count(DISTINCT s.session_id) > 0
            THEN count(DISTINCT s.session_id) FILTER (WHERE c.session_id IS NOT NULL)::float8
                 / count(DISTINCT s.session_id)
            ELSE NULL END AS value,
       NULL::float8 AS reviewed_denominator
  FROM started s
  LEFT JOIN completed c
    ON c.tenant_id = s.tenant_id AND c.session_id = s.session_id
 GROUP BY s.tenant_id, s.metric_date;--> statement-breakpoint

-- dropoff_rate_by_module (dimension = pinned module_version_id from M5):
--   numerator   = module.enter segments that are the session's LAST entered
--                 segment AND whose session was abandoned (session.completed
--                 outcome in (abandoned, failed), OR no session.completed at
--                 all), i.e. the segment the user dropped in;
--   denominator = all module.enter segments of that version entered that day.
-- Attributed to the UTC date of the module.enter received_at, and to the
-- pinned version stamped on that enter event (never the session entry version).
CREATE VIEW "metrics_dropoff_by_module_daily" AS
WITH enters AS (
  SELECT se.tenant_id, se.session_id, se.event_id,
         (se.received_at AT TIME ZONE 'UTC')::date AS metric_date,
         se.attrs->>'module_version_id' AS module_version_id,
         se.occurred_at, se.turn_index
    FROM session_events se
    JOIN metrics_included_sessions mis
      ON mis.tenant_id = se.tenant_id AND mis.session_id = se.session_id
   WHERE se.event_type = 'module.enter'
     AND se.attrs ? 'module_version_id'
),
last_enter AS (
  SELECT DISTINCT ON (tenant_id, session_id) tenant_id, session_id, event_id
    FROM enters
   ORDER BY tenant_id, session_id,
            occurred_at DESC, turn_index DESC NULLS LAST, event_id DESC
),
abandoned_sessions AS (
  SELECT mis.tenant_id, mis.session_id
    FROM metrics_included_sessions mis
    LEFT JOIN LATERAL (
      SELECT sc.attrs->>'outcome' AS outcome
        FROM session_events sc
       WHERE sc.tenant_id = mis.tenant_id
         AND sc.session_id = mis.session_id
         AND sc.event_type = 'session.completed'
       ORDER BY sc.received_at DESC, sc.event_id DESC
       LIMIT 1
    ) comp ON true
    JOIN session_events anyenter
      ON anyenter.tenant_id = mis.tenant_id
     AND anyenter.session_id = mis.session_id
     AND anyenter.event_type = 'module.enter'
   WHERE comp.outcome IS NULL OR comp.outcome IN ('abandoned', 'failed')
   GROUP BY mis.tenant_id, mis.session_id
)
SELECT e.tenant_id, e.metric_date,
       'dropoff_rate_by_module'::text AS metric_name,
       e.module_version_id AS dimension,
       count(*) FILTER (
         WHERE le.event_id IS NOT NULL AND ab.session_id IS NOT NULL
       )::float8 AS numerator,
       count(*)::float8 AS denominator,
       CASE WHEN count(*) > 0
            THEN count(*) FILTER (
                   WHERE le.event_id IS NOT NULL AND ab.session_id IS NOT NULL
                 )::float8 / count(*)
            ELSE NULL END AS value,
       NULL::float8 AS reviewed_denominator
  FROM enters e
  LEFT JOIN last_enter le
    ON le.tenant_id = e.tenant_id AND le.event_id = e.event_id
  LEFT JOIN abandoned_sessions ab
    ON ab.tenant_id = e.tenant_id AND ab.session_id = e.session_id
 GROUP BY e.tenant_id, e.metric_date, e.module_version_id;--> statement-breakpoint

-- median_question_time: pair question.completed (answer) with question.prompted
-- on (session_id, question_id, turn_index); pair delay = completed.occurred_at
-- - prompted.occurred_at. Pairs with delay < 0 or > 30 min are data errors,
-- discarded from the median and counted separately as a data-quality metric.
-- Emits two metric rows: 'median_question_time' (value = median ms over valid
-- pairs) and 'question_time_discarded' (value = discarded pair count).
-- Bucketed by the answer event's received_at UTC date.
CREATE VIEW "metrics_question_time_daily" AS
WITH prompted AS (
  SELECT se.tenant_id, se.session_id, se.attrs->>'question_id' AS question_id,
         se.turn_index, se.occurred_at
    FROM session_events se
    JOIN metrics_included_sessions mis
      ON mis.tenant_id = se.tenant_id AND mis.session_id = se.session_id
   WHERE se.event_type = 'question.prompted'
     AND se.attrs ? 'question_id' AND se.turn_index IS NOT NULL
),
answered AS (
  SELECT se.tenant_id, se.session_id, se.attrs->>'question_id' AS question_id,
         se.turn_index, se.occurred_at,
         (se.received_at AT TIME ZONE 'UTC')::date AS metric_date
    FROM session_events se
    JOIN metrics_included_sessions mis
      ON mis.tenant_id = se.tenant_id AND mis.session_id = se.session_id
   WHERE se.event_type = 'question.completed'
     AND se.attrs ? 'question_id' AND se.turn_index IS NOT NULL
),
pairs AS (
  SELECT a.tenant_id, a.metric_date,
         EXTRACT(EPOCH FROM (a.occurred_at - p.occurred_at)) * 1000 AS delta_ms
    FROM answered a
    JOIN prompted p
      ON p.tenant_id = a.tenant_id AND p.session_id = a.session_id
     AND p.question_id = a.question_id AND p.turn_index = a.turn_index
),
agg AS (
  SELECT tenant_id, metric_date,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY delta_ms)
           FILTER (WHERE delta_ms >= 0 AND delta_ms <= 1800000) AS median_ms,
         count(*) FILTER (WHERE delta_ms >= 0 AND delta_ms <= 1800000) AS valid_pairs,
         count(*) FILTER (WHERE delta_ms < 0 OR delta_ms > 1800000) AS discarded_pairs
    FROM pairs
   GROUP BY tenant_id, metric_date
)
SELECT tenant_id, metric_date,
       'median_question_time'::text AS metric_name, ''::text AS dimension,
       valid_pairs::float8 AS numerator, valid_pairs::float8 AS denominator,
       median_ms::float8 AS value, NULL::float8 AS reviewed_denominator
  FROM agg
UNION ALL
SELECT tenant_id, metric_date,
       'question_time_discarded'::text AS metric_name, ''::text AS dimension,
       discarded_pairs::float8 AS numerator,
       (valid_pairs + discarded_pairs)::float8 AS denominator,
       discarded_pairs::float8 AS value, NULL::float8 AS reviewed_denominator
  FROM agg;--> statement-breakpoint

-- correction_rate_by_field (dimension = field_key), snapshotted at review time:
--   denominator = proposed extractions whose session has a completed review
--                 (the "% reviewed" guard; reviewed_denominator restates it);
--   numerator   = those with >= 1 value-changing correction
--                 (before_hash <> after_hash = corrected or rejected).
-- Bucketed by the session's review.completed UTC date.
CREATE VIEW "metrics_correction_rate_by_field_daily" AS
WITH proposed AS (
  SELECT fe.tenant_id, rs.reviewed_date AS metric_date, fe.field_path,
         EXISTS (
           SELECT 1 FROM adviser_corrections ac
            WHERE ac.tenant_id = fe.tenant_id
              AND ac.extraction_id = fe.extraction_id
              AND ac.before_hash <> ac.after_hash
         ) AS corrected
    FROM field_extractions fe
    JOIN metrics_reviewed_sessions rs
      ON rs.tenant_id = fe.tenant_id AND rs.session_id = fe.session_id
)
SELECT tenant_id, metric_date,
       'correction_rate_by_field'::text AS metric_name, field_path AS dimension,
       count(*) FILTER (WHERE corrected)::float8 AS numerator,
       count(*)::float8 AS denominator,
       CASE WHEN count(*) > 0
            THEN count(*) FILTER (WHERE corrected)::float8 / count(*)
            ELSE NULL END AS value,
       count(*)::float8 AS reviewed_denominator
  FROM proposed
 GROUP BY tenant_id, metric_date, field_path;--> statement-breakpoint

-- calibration_approval_rate (dimension = fixed confidence bucket). Edges
-- [0,0.5,0.7,0.85,0.95,1.0]; the top bucket is closed on the right so
-- confidence exactly 1.0 lands in 0.95-1.0. approval_rate = fraction of
-- proposed extractions in the bucket NOT changed by review. Review-gated like
-- correction_rate (the "% reviewed" guard).
CREATE VIEW "metrics_calibration_daily" AS
WITH proposed AS (
  SELECT fe.tenant_id, rs.reviewed_date AS metric_date,
         NOT EXISTS (
           SELECT 1 FROM adviser_corrections ac
            WHERE ac.tenant_id = fe.tenant_id
              AND ac.extraction_id = fe.extraction_id
              AND ac.before_hash <> ac.after_hash
         ) AS approved,
         CASE
           WHEN fe.confidence >= 0    AND fe.confidence < 0.5  THEN '0.0-0.5'
           WHEN fe.confidence >= 0.5  AND fe.confidence < 0.7  THEN '0.5-0.7'
           WHEN fe.confidence >= 0.7  AND fe.confidence < 0.85 THEN '0.7-0.85'
           WHEN fe.confidence >= 0.85 AND fe.confidence < 0.95 THEN '0.85-0.95'
           WHEN fe.confidence >= 0.95 AND fe.confidence <= 1.0 THEN '0.95-1.0'
         END AS bucket
    FROM field_extractions fe
    JOIN metrics_reviewed_sessions rs
      ON rs.tenant_id = fe.tenant_id AND rs.session_id = fe.session_id
   WHERE fe.confidence IS NOT NULL
)
SELECT tenant_id, metric_date,
       'calibration_approval_rate'::text AS metric_name, bucket AS dimension,
       count(*) FILTER (WHERE approved)::float8 AS numerator,
       count(*)::float8 AS denominator,
       count(*) FILTER (WHERE approved)::float8 / count(*) AS value,
       count(*)::float8 AS reviewed_denominator
  FROM proposed
 WHERE bucket IS NOT NULL
 GROUP BY tenant_id, metric_date, bucket;--> statement-breakpoint

-- Reliability KPIs, attributed to the session.started UTC date (latency to the
-- provider_usage created_at date). Emits three metric rows:
--   connection_success_rate = sessions with call.connected / sessions started;
--   mid_call_drop_rate      = sessions with a technical call.hung_up
--                             (cause_class = 'technical') / connected sessions;
--   turn_latency_p95_ms     = p95 of provider_usage.latency_ms.
-- Alerts (runner): connection_success_rate < 0.98 or mid_call_drop_rate > 0.05.
CREATE VIEW "metrics_reliability_daily" AS
WITH started AS (
  SELECT se.tenant_id, se.session_id,
         (se.received_at AT TIME ZONE 'UTC')::date AS metric_date
    FROM session_events se
    JOIN metrics_included_sessions mis
      ON mis.tenant_id = se.tenant_id AND mis.session_id = se.session_id
   WHERE se.event_type = 'session.started'
),
connected AS (
  SELECT DISTINCT tenant_id, session_id FROM session_events
   WHERE event_type = 'call.connected'
),
dropped AS (
  SELECT DISTINCT tenant_id, session_id FROM session_events
   WHERE event_type = 'call.hung_up' AND attrs->>'cause_class' = 'technical'
),
conn_metric AS (
  SELECT s.tenant_id, s.metric_date,
         'connection_success_rate'::text AS metric_name, ''::text AS dimension,
         count(DISTINCT s.session_id) FILTER (WHERE c.session_id IS NOT NULL)::float8
           AS numerator,
         count(DISTINCT s.session_id)::float8 AS denominator,
         CASE WHEN count(DISTINCT s.session_id) > 0
              THEN count(DISTINCT s.session_id) FILTER (WHERE c.session_id IS NOT NULL)::float8
                   / count(DISTINCT s.session_id)
              ELSE NULL END AS value,
         NULL::float8 AS reviewed_denominator
    FROM started s
    LEFT JOIN connected c
      ON c.tenant_id = s.tenant_id AND c.session_id = s.session_id
   GROUP BY s.tenant_id, s.metric_date
),
drop_metric AS (
  SELECT s.tenant_id, s.metric_date,
         'mid_call_drop_rate'::text AS metric_name, ''::text AS dimension,
         count(DISTINCT s.session_id) FILTER (WHERE d.session_id IS NOT NULL)::float8
           AS numerator,
         count(DISTINCT s.session_id) FILTER (WHERE c.session_id IS NOT NULL)::float8
           AS denominator,
         CASE WHEN count(DISTINCT s.session_id) FILTER (WHERE c.session_id IS NOT NULL) > 0
              THEN count(DISTINCT s.session_id) FILTER (WHERE d.session_id IS NOT NULL)::float8
                   / count(DISTINCT s.session_id) FILTER (WHERE c.session_id IS NOT NULL)
              ELSE NULL END AS value,
         NULL::float8 AS reviewed_denominator
    FROM started s
    LEFT JOIN connected c
      ON c.tenant_id = s.tenant_id AND c.session_id = s.session_id
    LEFT JOIN dropped d
      ON d.tenant_id = s.tenant_id AND d.session_id = s.session_id
   GROUP BY s.tenant_id, s.metric_date
),
latency_metric AS (
  SELECT pu.tenant_id, (pu.created_at AT TIME ZONE 'UTC')::date AS metric_date,
         'turn_latency_p95_ms'::text AS metric_name, ''::text AS dimension,
         count(*)::float8 AS numerator, count(*)::float8 AS denominator,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY pu.latency_ms)::float8 AS value,
         NULL::float8 AS reviewed_denominator
    FROM provider_usage pu
    JOIN metrics_included_sessions mis
      ON mis.tenant_id = pu.tenant_id AND mis.session_id = pu.session_id
   GROUP BY pu.tenant_id, (pu.created_at AT TIME ZONE 'UTC')::date
)
SELECT * FROM conn_metric
UNION ALL SELECT * FROM drop_metric
UNION ALL SELECT * FROM latency_metric;--> statement-breakpoint

-- Adviser adoption KPIs. Emits four metric rows:
--   review_turnaround_median_ms = median(review.completed.received_at
--                                 - session.completed.received_at) per session,
--                                 bucketed by the review's UTC date;
--   pct_reviewed_within_7d      = completed sessions reviewed within 7 days
--                                 / completed sessions (by completion date);
--   pct_reviewed                = completed sessions ever reviewed / completed
--                                 (the "% reviewed" guard headline);
--   reviews_abandoned           = review.abandoned count (value) over
--                                 review.started + review.abandoned starts.
CREATE VIEW "metrics_adviser_adoption_daily" AS
WITH completed AS (
  SELECT DISTINCT ON (se.tenant_id, se.session_id)
         se.tenant_id, se.session_id, se.received_at AS completed_at,
         (se.received_at AT TIME ZONE 'UTC')::date AS completed_date
    FROM session_events se
    JOIN metrics_included_sessions mis
      ON mis.tenant_id = se.tenant_id AND mis.session_id = se.session_id
   WHERE se.event_type = 'session.completed'
   ORDER BY se.tenant_id, se.session_id, se.received_at ASC, se.event_id ASC
),
reviewed AS (
  SELECT DISTINCT ON (se.tenant_id, se.session_id)
         se.tenant_id, se.session_id, se.received_at AS reviewed_at
    FROM session_events se
    JOIN metrics_included_sessions mis
      ON mis.tenant_id = se.tenant_id AND mis.session_id = se.session_id
   WHERE se.event_type = 'review.completed'
   ORDER BY se.tenant_id, se.session_id, se.received_at ASC, se.event_id ASC
),
turnaround AS (
  SELECT r.tenant_id, (r.reviewed_at AT TIME ZONE 'UTC')::date AS metric_date,
         EXTRACT(EPOCH FROM (r.reviewed_at - c.completed_at)) * 1000 AS delta_ms
    FROM reviewed r
    JOIN completed c
      ON c.tenant_id = r.tenant_id AND c.session_id = r.session_id
   WHERE r.reviewed_at >= c.completed_at
),
turnaround_metric AS (
  SELECT tenant_id, metric_date,
         'review_turnaround_median_ms'::text AS metric_name, ''::text AS dimension,
         count(*)::float8 AS numerator, count(*)::float8 AS denominator,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY delta_ms)::float8 AS value,
         NULL::float8 AS reviewed_denominator
    FROM turnaround GROUP BY tenant_id, metric_date
),
within7_metric AS (
  SELECT c.tenant_id, c.completed_date AS metric_date,
         'pct_reviewed_within_7d'::text AS metric_name, ''::text AS dimension,
         count(DISTINCT c.session_id) FILTER (
           WHERE r.reviewed_at IS NOT NULL
             AND r.reviewed_at <= c.completed_at + interval '7 days'
         )::float8 AS numerator,
         count(DISTINCT c.session_id)::float8 AS denominator,
         CASE WHEN count(DISTINCT c.session_id) > 0
              THEN count(DISTINCT c.session_id) FILTER (
                     WHERE r.reviewed_at IS NOT NULL
                       AND r.reviewed_at <= c.completed_at + interval '7 days'
                   )::float8 / count(DISTINCT c.session_id)
              ELSE NULL END AS value,
         NULL::float8 AS reviewed_denominator
    FROM completed c
    LEFT JOIN reviewed r
      ON r.tenant_id = c.tenant_id AND r.session_id = c.session_id
   GROUP BY c.tenant_id, c.completed_date
),
pct_reviewed_metric AS (
  SELECT c.tenant_id, c.completed_date AS metric_date,
         'pct_reviewed'::text AS metric_name, ''::text AS dimension,
         count(DISTINCT c.session_id) FILTER (WHERE r.reviewed_at IS NOT NULL)::float8
           AS numerator,
         count(DISTINCT c.session_id)::float8 AS denominator,
         CASE WHEN count(DISTINCT c.session_id) > 0
              THEN count(DISTINCT c.session_id) FILTER (WHERE r.reviewed_at IS NOT NULL)::float8
                   / count(DISTINCT c.session_id)
              ELSE NULL END AS value,
         NULL::float8 AS reviewed_denominator
    FROM completed c
    LEFT JOIN reviewed r
      ON r.tenant_id = c.tenant_id AND r.session_id = c.session_id
   GROUP BY c.tenant_id, c.completed_date
),
abandoned_metric AS (
  SELECT se.tenant_id, (se.received_at AT TIME ZONE 'UTC')::date AS metric_date,
         'reviews_abandoned'::text AS metric_name, ''::text AS dimension,
         count(*) FILTER (WHERE se.event_type = 'review.abandoned')::float8 AS numerator,
         count(*)::float8 AS denominator,
         count(*) FILTER (WHERE se.event_type = 'review.abandoned')::float8 AS value,
         NULL::float8 AS reviewed_denominator
    FROM session_events se
    JOIN metrics_included_sessions mis
      ON mis.tenant_id = se.tenant_id AND mis.session_id = se.session_id
   WHERE se.event_type IN ('review.started', 'review.abandoned')
   GROUP BY se.tenant_id, (se.received_at AT TIME ZONE 'UTC')::date
)
SELECT * FROM turnaround_metric
UNION ALL SELECT * FROM within7_metric
UNION ALL SELECT * FROM pct_reviewed_metric
UNION ALL SELECT * FROM abandoned_metric;--> statement-breakpoint

-- Unit economics. provider_usage.cost_micros is the estimated provider cost in
-- millionths of a currency unit (the M1 schema's column; the spec's
-- "estimated_cost_minor" maps to it). Emits three metric rows:
--   cost_per_completed_factfind = total session cost / sessions completed
--                                 (outcome = 'completed'), by completion date;
--   cost_per_booked_meeting     = total session cost / booked meetings, by
--                                 meeting.booked date;
--   tenant_daily_cost_micros    = total provider cost per tenant per day (by
--                                 provider_usage created_at) -> sum over a month
--                                 gives cost per tenant-month.
-- Cost-drift alert (runner): cost_per_completed_factfind > 1.5x its trailing
-- 28-day baseline.
CREATE VIEW "metrics_unit_economics_daily" AS
WITH session_cost AS (
  SELECT pu.tenant_id, pu.session_id, sum(pu.cost_micros)::numeric AS cost_micros
    FROM provider_usage pu
    JOIN metrics_included_sessions mis
      ON mis.tenant_id = pu.tenant_id AND mis.session_id = pu.session_id
   GROUP BY pu.tenant_id, pu.session_id
),
completed AS (
  SELECT DISTINCT ON (se.tenant_id, se.session_id)
         se.tenant_id, se.session_id,
         (se.received_at AT TIME ZONE 'UTC')::date AS metric_date
    FROM session_events se
    JOIN metrics_included_sessions mis
      ON mis.tenant_id = se.tenant_id AND mis.session_id = se.session_id
   WHERE se.event_type = 'session.completed' AND se.attrs->>'outcome' = 'completed'
   ORDER BY se.tenant_id, se.session_id, se.received_at ASC, se.event_id ASC
),
booked AS (
  SELECT DISTINCT ON (se.tenant_id, se.session_id)
         se.tenant_id, se.session_id,
         (se.received_at AT TIME ZONE 'UTC')::date AS metric_date
    FROM session_events se
    JOIN metrics_included_sessions mis
      ON mis.tenant_id = se.tenant_id AND mis.session_id = se.session_id
   WHERE se.event_type = 'meeting.booked'
   ORDER BY se.tenant_id, se.session_id, se.received_at ASC, se.event_id ASC
),
per_completed AS (
  SELECT c.tenant_id, c.metric_date,
         'cost_per_completed_factfind'::text AS metric_name, ''::text AS dimension,
         coalesce(sum(sc.cost_micros), 0)::float8 AS numerator,
         count(*)::float8 AS denominator,
         CASE WHEN count(*) > 0
              THEN coalesce(sum(sc.cost_micros), 0)::float8 / count(*)
              ELSE NULL END AS value,
         NULL::float8 AS reviewed_denominator
    FROM completed c
    LEFT JOIN session_cost sc
      ON sc.tenant_id = c.tenant_id AND sc.session_id = c.session_id
   GROUP BY c.tenant_id, c.metric_date
),
per_booked AS (
  SELECT b.tenant_id, b.metric_date,
         'cost_per_booked_meeting'::text AS metric_name, ''::text AS dimension,
         coalesce(sum(sc.cost_micros), 0)::float8 AS numerator,
         count(*)::float8 AS denominator,
         CASE WHEN count(*) > 0
              THEN coalesce(sum(sc.cost_micros), 0)::float8 / count(*)
              ELSE NULL END AS value,
         NULL::float8 AS reviewed_denominator
    FROM booked b
    LEFT JOIN session_cost sc
      ON sc.tenant_id = b.tenant_id AND sc.session_id = b.session_id
   GROUP BY b.tenant_id, b.metric_date
),
per_tenant_day AS (
  SELECT pu.tenant_id, (pu.created_at AT TIME ZONE 'UTC')::date AS metric_date,
         'tenant_daily_cost_micros'::text AS metric_name, ''::text AS dimension,
         sum(pu.cost_micros)::float8 AS numerator, 1::float8 AS denominator,
         sum(pu.cost_micros)::float8 AS value, NULL::float8 AS reviewed_denominator
    FROM provider_usage pu
    JOIN metrics_included_sessions mis
      ON mis.tenant_id = pu.tenant_id AND mis.session_id = pu.session_id
   GROUP BY pu.tenant_id, (pu.created_at AT TIME ZONE 'UTC')::date
)
SELECT * FROM per_completed
UNION ALL SELECT * FROM per_booked
UNION ALL SELECT * FROM per_tenant_day;--> statement-breakpoint

-- Daily reconciliation: the Postgres ledger is the single source of truth;
-- PostHog is a disposable lens. Per received_at UTC date, over events the
-- consent gate marked forwardable (a non-suppressed telemetry_outbox row):
--   denominator = expected-forwarded events;
--   numerator   = expected events NOT yet delivered to PostHog (the gap);
--   value       = divergence = gap / expected.
-- Alert (runner) when divergence exceeds the configured ratio (> 2%).
CREATE VIEW "metrics_reconciliation_daily" AS
WITH expected AS (
  SELECT se.tenant_id,
         (se.received_at AT TIME ZONE 'UTC')::date AS metric_date,
         ob.posthog_delivered_at
    FROM telemetry_outbox ob
    JOIN session_events se
      ON se.tenant_id = ob.tenant_id AND se.event_id = ob.event_id
    JOIN metrics_included_sessions mis
      ON mis.tenant_id = se.tenant_id AND mis.session_id = se.session_id
   WHERE ob.suppressed_at IS NULL
)
SELECT tenant_id, metric_date,
       'ledger_vs_posthog_divergence'::text AS metric_name, ''::text AS dimension,
       count(*) FILTER (WHERE posthog_delivered_at IS NULL)::float8 AS numerator,
       count(*)::float8 AS denominator,
       CASE WHEN count(*) > 0
            THEN count(*) FILTER (WHERE posthog_delivered_at IS NULL)::float8 / count(*)
            ELSE NULL END AS value,
       NULL::float8 AS reviewed_denominator
  FROM expected
 GROUP BY tenant_id, metric_date;