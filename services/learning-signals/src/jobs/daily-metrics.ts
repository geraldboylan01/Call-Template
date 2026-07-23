import type { Pool } from "pg";

export type DailyMetricWindow = {
  start: Date;
  end: Date;
  tenantId?: string;
};

export type EligibleMetricSession = {
  tenantId: string;
  sessionId: string;
};

export type DailyEventMetric = {
  tenantId: string;
  eventType: string;
  eventCount: number;
  subjectCount: number;
};

function validateWindow(window: DailyMetricWindow): void {
  if (
    !Number.isFinite(window.start.getTime()) ||
    !Number.isFinite(window.end.getTime()) ||
    window.end.getTime() <= window.start.getTime()
  ) {
    throw new Error("Invalid daily metric window.");
  }
}

/**
 * PostgreSQL-backed pilot metric input. Withdrawal is enforced by excluding
 * every session carrying a subject pseudonym present in
 * subject_metric_exclusions; the job never needs a raw identifier.
 */
export class DailyMetricsJob {
  constructor(private readonly pool: Pool) {}

  async eligibleSessions(
    window: DailyMetricWindow,
  ): Promise<readonly EligibleMetricSession[]> {
    validateWindow(window);
    const result = await this.pool.query<{
      tenant_id: string;
      session_id: string;
    }>(
      `select distinct event.tenant_id, event.session_id
       from session_events event
       join fact_find_sessions session
         on session.tenant_id = event.tenant_id
        and session.session_id = event.session_id
       where event.received_at >= $1
         and event.received_at < $2
         and ($3::uuid is null or event.tenant_id = $3)
         and not exists (
           select 1
           from subject_metric_exclusions exclusion
           where exclusion.tenant_id = session.tenant_id
             and exclusion.key_version = session.key_version
             and exclusion.pseudonymous_subject_id =
                 session.pseudonymous_subject_id
         )
       order by event.tenant_id, event.session_id`,
      [window.start, window.end, window.tenantId?.toLowerCase() ?? null],
    );
    return result.rows.map((row) => ({
      tenantId: row.tenant_id,
      sessionId: row.session_id,
    }));
  }

  async runWindow(
    window: DailyMetricWindow,
  ): Promise<readonly DailyEventMetric[]> {
    validateWindow(window);
    const result = await this.pool.query<{
      tenant_id: string;
      event_type: string;
      event_count: number;
      subject_count: number;
    }>(
      `select event.tenant_id,
              event.event_type,
              count(*)::integer as event_count,
              count(distinct (
                session.pseudonymous_subject_id,
                session.key_version
              ))::integer as subject_count
       from session_events event
       join fact_find_sessions session
         on session.tenant_id = event.tenant_id
        and session.session_id = event.session_id
       where event.received_at >= $1
         and event.received_at < $2
         and ($3::uuid is null or event.tenant_id = $3)
         and not exists (
           select 1
           from subject_metric_exclusions exclusion
           where exclusion.tenant_id = session.tenant_id
             and exclusion.key_version = session.key_version
             and exclusion.pseudonymous_subject_id =
                 session.pseudonymous_subject_id
         )
       group by event.tenant_id, event.event_type
       order by event.tenant_id, event.event_type`,
      [window.start, window.end, window.tenantId?.toLowerCase() ?? null],
    );
    return result.rows.map((row) => ({
      tenantId: row.tenant_id,
      eventType: row.event_type,
      eventCount: row.event_count,
      subjectCount: row.subject_count,
    }));
  }
}
