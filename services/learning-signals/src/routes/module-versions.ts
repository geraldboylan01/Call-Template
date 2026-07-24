import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { authenticationHook } from "../auth/tenant-context.js";
import type { DatabaseConnection } from "../db/client.js";
import { moduleVersions } from "../db/schema.js";
import {
  canonicalJson,
  sha256Hex,
  type JsonValue,
} from "../telemetry/canonical-json.js";
import type { Clock } from "../telemetry/clock.js";
import {
  carriesMismatchedTenant,
  hasOnlyOwnKeys,
} from "../telemetry/ingestion-core.js";

const WINDOW_DAYS = 28;
const MAX_CANONICAL_MODULE_BYTES = 256 * 1024;
const MAX_MODULE_JSON_DEPTH = 64;

// Strict semver core with an optional prerelease tag. The DB only requires a
// non-empty string; the API contract is narrower so version ordering stays
// meaningful to humans.
const semanticVersionSchema = z
  .string()
  .max(64)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,63})?$/);

const moduleJsonSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);

const publishBodySchema = z
  .object({
    tenant_id: z.string().uuid().optional(),
    module_id: z.string().uuid(),
    semantic_version: semanticVersionSchema,
    module_json: moduleJsonSchema,
  })
  .strict();

const publishBodyKeys = new Set([
  "tenant_id",
  "module_id",
  "semantic_version",
  "module_json",
]);

/**
 * canonicalJson recurses, so bound author-supplied nesting before
 * canonicalizing. Iterative on purpose: the guard itself must not be able to
 * overflow the stack.
 */
function exceedsJsonDepth(value: unknown, maxDepth: number): boolean {
  let frontier: unknown[] = [value];
  for (let depth = 0; frontier.length > 0; depth += 1) {
    if (depth >= maxDepth) return true;
    const next: unknown[] = [];
    for (const entry of frontier) {
      if (entry === null || typeof entry !== "object") continue;
      next.push(...(Array.isArray(entry) ? entry : Object.values(entry)));
    }
    frontier = next;
  }
  return false;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

type PerformanceRow = {
  sessions_entered: number;
  segment_count: number;
  completed_segment_count: number;
  median_module_duration_ms: number;
  correction_rate_by_field: Record<string, number>;
  critical_correction_count: number;
  booked_session_count: number;
  top_abandonment_questions: Array<{
    question_id: string;
    abandonment_count: number;
  }>;
  calibration: Array<{
    confidence_bucket: string;
    n: number;
    approval_rate: number;
  }>;
};

/**
 * All metric attribution runs per module segment. A segment is one persisted
 * `module.enter` event stamped with the target module_version_id; it spans
 * from that event's occurred_at until the session's next `module.enter` of
 * any module (or the end of the session). fact_find_sessions.
 * entry_module_version_id is deliberately never consulted.
 */
const PERFORMANCE_SQL = `
with target_enters as (
  select se.session_id, se.event_id, se.occurred_at, se.turn_index,
         se.attrs->>'module_id' as module_id
    from session_events se
   where se.tenant_id = $1
     and se.event_type = 'module.enter'
     and se.attrs->>'module_version_id' = $2::text
     and se.occurred_at >= $3
),
entered_sessions as (
  select distinct session_id from target_enters
),
session_enter_bounds as (
  select se.session_id, se.event_id,
         lead(se.occurred_at) over (
           partition by se.session_id
           order by se.occurred_at asc, se.turn_index asc nulls last, se.event_id asc
         ) as next_enter_at
    from session_events se
   where se.tenant_id = $1
     and se.event_type = 'module.enter'
     and se.session_id in (select session_id from entered_sessions)
),
segments as (
  select te.session_id, te.event_id as segment_id, te.module_id,
         te.occurred_at as started_at, b.next_enter_at
    from target_enters te
    join session_enter_bounds b
      on b.session_id = te.session_id and b.event_id = te.event_id
),
segment_events as (
  select seg.segment_id, seg.module_id as segment_module_id,
         ev.event_id, ev.event_type, ev.attrs, ev.occurred_at, ev.turn_index,
         ev.duration_ms
    from segments seg
    join session_events ev
      on ev.tenant_id = $1
     and ev.session_id = seg.session_id
     and ev.occurred_at >= seg.started_at
     and (seg.next_enter_at is null or ev.occurred_at < seg.next_enter_at)
),
segment_outcomes as (
  select seg.segment_id,
         coalesce(bool_or(
           sev.event_type = 'module.exit'
           and sev.attrs->>'module_id' = sev.segment_module_id
           and sev.attrs->>'outcome' = 'completed'
         ), false) as completed
    from segments seg
    left join segment_events sev on sev.segment_id = seg.segment_id
   group by seg.segment_id
),
segment_durations as (
  select distinct on (segment_id) segment_id, duration_ms
    from segment_events
   where event_type = 'module.exit'
     and attrs->>'module_id' = segment_module_id
     and duration_ms is not null
   order by segment_id, occurred_at asc, turn_index asc nulls last, event_id asc
),
abandoned_last_questions as (
  select distinct on (sev.segment_id) sev.segment_id,
         sev.attrs->>'question_id' as question_id
    from segment_events sev
    join segment_outcomes so
      on so.segment_id = sev.segment_id and not so.completed
   where sev.event_type = 'question.prompted'
     and sev.attrs ? 'question_id'
   order by sev.segment_id, sev.occurred_at desc,
            sev.turn_index desc nulls last, sev.event_id desc
),
top_abandonment as (
  select question_id, count(*)::int as abandonment_count
    from abandoned_last_questions
   group by question_id
   order by abandonment_count desc, question_id asc
   limit 5
),
attributed_extractions as (
  select fe.extraction_id, fe.field_path, fe.value_class, fe.confidence
    from segment_events sev
    join field_extractions fe
      on fe.tenant_id = $1
     and fe.source_event_id = sev.event_id
),
extraction_flags as (
  select ae.extraction_id, ae.field_path, ae.value_class, ae.confidence,
         coalesce(bool_or(ac.before_hash <> ac.after_hash), false) as changed
    from attributed_extractions ae
    left join adviser_corrections ac
      on ac.tenant_id = $1
     and ac.extraction_id = ae.extraction_id
   group by ae.extraction_id, ae.field_path, ae.value_class, ae.confidence
),
field_rates as (
  select field_path,
         round(count(*) filter (where changed)::numeric / count(*), 4)::float8
           as correction_rate
    from extraction_flags
   group by field_path
),
critical_corrections as (
  select count(*)::int as critical_correction_count
    from attributed_extractions ae
    join adviser_corrections ac
      on ac.tenant_id = $1
     and ac.extraction_id = ae.extraction_id
     and ac.before_hash <> ac.after_hash
   where ae.value_class in ('identifier', 'currency')
),
calibration_buckets as (
  select least(floor(confidence * 10)::int, 9) as bucket,
         count(*)::int as n,
         round(count(*) filter (where not changed)::numeric / count(*), 4)::float8
           as approval_rate
    from extraction_flags
   where confidence is not null
   group by 1
),
calibration as (
  select bucket,
         ('0.' || bucket::text || '-'
           || case when bucket = 9 then '1.0' else '0.' || (bucket + 1)::text end)
           as confidence_bucket,
         n, approval_rate
    from calibration_buckets
),
booked as (
  select count(distinct se.session_id)::int as booked_session_count
    from session_events se
   where se.tenant_id = $1
     and se.event_type = 'meeting.booked'
     and se.session_id in (select session_id from entered_sessions)
)
select
  (select count(*)::int from entered_sessions) as sessions_entered,
  (select count(*)::int from segments) as segment_count,
  (select count(*)::int from segment_outcomes where completed)
    as completed_segment_count,
  (select coalesce(round(percentile_cont(0.5) within group (order by duration_ms))::int, 0)
     from segment_durations) as median_module_duration_ms,
  (select coalesce(json_object_agg(field_path, correction_rate order by field_path), '{}'::json)
     from field_rates) as correction_rate_by_field,
  (select critical_correction_count from critical_corrections)
    as critical_correction_count,
  (select booked_session_count from booked) as booked_session_count,
  (select coalesce(json_agg(
            json_build_object('question_id', question_id,
                              'abandonment_count', abandonment_count)
            order by abandonment_count desc, question_id asc), '[]'::json)
     from top_abandonment) as top_abandonment_questions,
  (select coalesce(json_agg(
            json_build_object('confidence_bucket', confidence_bucket,
                              'n', n, 'approval_rate', approval_rate)
            order by bucket asc), '[]'::json)
     from calibration) as calibration
`;

export type ModuleVersionRouteDependencies = {
  connection: DatabaseConnection;
  clock: Clock;
};

export function registerModuleVersionRoutes(
  app: FastifyInstance,
  dependencies: ModuleVersionRouteDependencies,
): void {
  app.post(
    "/v1/module-versions/publish",
    {
      bodyLimit: 1024 * 1024,
      onRequest: authenticationHook(dependencies.connection, "admin"),
    },
    async (request, reply) => {
      const tenantContext = request.tenantContext;
      if (!tenantContext) return;

      if (!hasOnlyOwnKeys(request.body, publishBodyKeys)) {
        return reply.status(400).send({ error: "Invalid module version" });
      }
      if (carriesMismatchedTenant(request.body, tenantContext.tenantId)) {
        return reply.status(403).send({ error: "Forbidden" });
      }
      const parsed = publishBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid module version" });
      }
      const body = parsed.data;
      if (exceedsJsonDepth(body.module_json, MAX_MODULE_JSON_DEPTH)) {
        return reply.status(400).send({ error: "module_json is too deeply nested" });
      }

      const canonical = canonicalJson(body.module_json as JsonValue);
      if (Buffer.byteLength(canonical, "utf8") > MAX_CANONICAL_MODULE_BYTES) {
        return reply.status(400).send({ error: "module_json is too large" });
      }
      const contentHash = sha256Hex(canonical);
      const moduleId = body.module_id.toLowerCase();

      const outcome = await dependencies.connection.db.transaction(
        async (transaction) => {
          const inserted = await transaction
            .insert(moduleVersions)
            .values({
              tenantId: tenantContext.tenantId,
              moduleId,
              semanticVersion: body.semantic_version,
              status: "published",
              // jsonb has no key order; the row stores the same value the
              // canonical hash was computed over.
              moduleBodyJsonb: JSON.parse(canonical) as Record<string, unknown>,
              contentHash,
              publishedAt: dependencies.clock.now(),
            })
            .onConflictDoNothing({
              target: [
                moduleVersions.tenantId,
                moduleVersions.moduleId,
                moduleVersions.semanticVersion,
              ],
            })
            .returning({ moduleVersionId: moduleVersions.moduleVersionId });
          if (inserted[0]) {
            return {
              kind: "inserted" as const,
              moduleVersionId: inserted[0].moduleVersionId,
            };
          }

          const existingRows = await transaction
            .select({
              moduleVersionId: moduleVersions.moduleVersionId,
              contentHash: moduleVersions.contentHash,
              status: moduleVersions.status,
            })
            .from(moduleVersions)
            .where(
              and(
                eq(moduleVersions.tenantId, tenantContext.tenantId),
                eq(moduleVersions.moduleId, moduleId),
                eq(moduleVersions.semanticVersion, body.semantic_version),
              ),
            )
            .limit(1);
          const existing = existingRows[0];
          if (!existing) throw new Error("Module version insert lost its row.");
          if (existing.status === "published" && existing.contentHash === contentHash) {
            return {
              kind: "replay" as const,
              moduleVersionId: existing.moduleVersionId,
            };
          }
          return { kind: "conflict" as const };
        },
      );

      if (outcome.kind === "conflict") {
        return reply
          .status(409)
          .send({ error: "same module version, different content" });
      }
      return reply.status(outcome.kind === "inserted" ? 201 : 200).send({
        module_version_id: outcome.moduleVersionId,
        module_id: moduleId,
        semantic_version: body.semantic_version,
        content_hash: contentHash,
        status: "published",
        replayed: outcome.kind === "replay",
      });
    },
  );

  app.get(
    "/v1/module-versions/:moduleVersionId/performance",
    { onRequest: authenticationHook(dependencies.connection, "admin") },
    async (request, reply) => {
      const tenantContext = request.tenantContext;
      if (!tenantContext) return;
      const params = z
        .object({ moduleVersionId: z.string().uuid() })
        .safeParse(request.params);
      if (!params.success) return reply.status(404).send({ error: "Not found" });

      const versionRows = await dependencies.connection.db
        .select({
          moduleVersionId: moduleVersions.moduleVersionId,
          semanticVersion: moduleVersions.semanticVersion,
        })
        .from(moduleVersions)
        .where(
          and(
            eq(moduleVersions.tenantId, tenantContext.tenantId),
            eq(moduleVersions.moduleVersionId, params.data.moduleVersionId),
          ),
        )
        .limit(1);
      const version = versionRows[0];
      if (!version) return reply.status(404).send({ error: "Not found" });

      const windowStart = new Date(
        dependencies.clock.now().getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );
      const result = await dependencies.connection.pool.query<PerformanceRow>(
        PERFORMANCE_SQL,
        [tenantContext.tenantId, version.moduleVersionId, windowStart],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Performance aggregation returned no row.");

      const completionRate =
        row.segment_count === 0
          ? 0
          : round4(row.completed_segment_count / row.segment_count);
      const abandonmentRate =
        row.segment_count === 0
          ? 0
          : round4(
              (row.segment_count - row.completed_segment_count) / row.segment_count,
            );
      const bookedMeetingConversion =
        row.sessions_entered === 0
          ? 0
          : round4(row.booked_session_count / row.sessions_entered);

      return reply.send({
        module_version_id: version.moduleVersionId,
        semantic_version: version.semanticVersion,
        window_days: WINDOW_DAYS,
        sessions_entered: row.sessions_entered,
        completion_rate: completionRate,
        abandonment_rate: abandonmentRate,
        median_module_duration_ms: row.median_module_duration_ms,
        correction_rate_by_field: row.correction_rate_by_field,
        critical_correction_count: row.critical_correction_count,
        booked_meeting_conversion: bookedMeetingConversion,
        top_abandonment_questions: row.top_abandonment_questions,
        calibration: row.calibration,
      });
    },
  );
}
