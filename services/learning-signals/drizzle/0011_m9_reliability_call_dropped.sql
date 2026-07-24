-- The M6 reliability view predated the v7 `call.dropped` event (added in M8);
-- its mid_call_drop_rate only counted a technical `call.hung_up`, so the drops
-- the voice orchestrator actually emits (`call.dropped`) were invisible. Count
-- both technical drop signals. CREATE OR REPLACE keeps the uniform column shape
-- the runner depends on; only the `dropped` CTE changes.
CREATE OR REPLACE VIEW "metrics_reliability_daily" AS
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
   WHERE event_type IN ('call.dropped', 'call.hung_up')
     AND attrs->>'cause_class' = 'technical'
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
UNION ALL SELECT * FROM latency_metric;
