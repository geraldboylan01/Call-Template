-- Widen the reconciliation trigger vocabulary.
--
-- WHY THIS EXISTS. The background reconciler gained two new causes and neither
-- could be written down. `trigger` carries a closed CHECK constraint, so a
-- checkpoint scheduled because deterministic coverage found an unaccounted
-- value failed at the database with `CHECK constraint failed`, before the
-- model was ever called. The mechanism built to recover missed client figures
-- could therefore never run on the signal it was built for; recovery only
-- happened when an unrelated cause — note activity, or the every-third-turn
-- checkpoint — happened to fire on the same turn.
--
-- The two names:
--   value_coverage_gap  the fast lane finished a turn with an explicit value
--                       unaccounted for. This is the omission-recovery signal.
--   material_backlog    outstanding reviewed-work remains from an earlier turn
--                       and nothing else scheduled a checkpoint. This is what
--                       guarantees the confirmation barrier eventually opens.
--
-- THE SAME REBUILD ALSO ADDS THE OUTCOME COUNTERS, deliberately, so the table
-- is rebuilt once rather than twice. Before real-user testing begins there is
-- no history worth protecting (19 rows, 4 synthetic meetings); afterwards
-- there will be, and a second rebuild would be paid for with real data.
--
-- The counters answer, in SQL, the questions the old vocabulary collapsed:
--   covered / uncovered      did the fast lane get it, or was it missed?
--   recovered / clarified    did the bounded review put it right?
--   not_current_fact         was it reviewed and correctly NOT a fact?
--   unresolved               was it reviewed and refused by validation?
--   deferred                 was it bounded out of this pass?
-- They are COUNTS ONLY. No amount, no currency, no label, no transcript span
-- reaches a plaintext column: occurrence detail stays inside the existing
-- encrypted output blob, exactly where it already is.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt with every
-- row copied. The rebuild is additive in both dimensions: no existing trigger
-- value is removed, and every new column carries a zero default, so every
-- historical row satisfies the new constraints and no past state has to be
-- reinterpreted or invented.
--
-- `defer_foreign_keys`, not `foreign_keys = OFF`: D1 does not honour the
-- latter, and migration 0008 records what that costs — a rebuild that passes
-- on an empty local replica and fails against remote D1. This table is a
-- foreign-key CHILD only; nothing references it, so dropping it cannot strand
-- a dependent row, which is why no child staging is needed here.
-- IF THIS FAILS MID-FLIGHT. Migrations run BEFORE the Worker deploy, so a
-- failure stops the release: the old code keeps running against the old
-- schema, and the new code that writes the new columns never ships. The one
-- dangerous window is between DROP and RENAME. D1 Time Travel covers it —
-- `wrangler d1 time-travel info planeir-consumer` for the bookmark, then
-- `... restore planeir-consumer --bookmark=<id>` — and the table held 19 rows
-- of pre-pilot synthetic traffic when this was written, so the worst case is
-- recreatable test data rather than client history.
PRAGMA defer_foreign_keys = true;

CREATE TABLE consumer_planner_reconciliations_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  realtime_session_id TEXT NOT NULL,
  reconciliation_revision INTEGER NOT NULL CHECK (reconciliation_revision >= 1),
  base_profile_revision INTEGER NOT NULL CHECK (base_profile_revision >= 1),
  through_turn_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN (
    'material_turn', 'rejected_note', 'answered_need', 'redundant_question',
    'periodic_checkpoint', 'readiness_transition', 'pre_confirmation',
    'agent_shadow_replay', 'value_coverage_gap', 'material_backlog'
  )),
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'apply')),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'shadow', 'applied', 'rejected', 'conflicted', 'failed'
  )),
  idempotency_key_hash_b64u TEXT NOT NULL,
  input_encrypted TEXT NOT NULL,
  input_hash_b64u TEXT NOT NULL,
  output_encrypted TEXT,
  output_hash_b64u TEXT,
  applied_profile_revision INTEGER,
  model TEXT,
  prompt_version TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  operation_count INTEGER NOT NULL DEFAULT 0 CHECK (operation_count >= 0),
  accepted_operation_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_operation_count >= 0),
  rejected_operation_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_operation_count >= 0),
  error_code TEXT,
  -- Occurrence-level outcome counters. One row per reconciliation pass.
  covered_value_count INTEGER NOT NULL DEFAULT 0 CHECK (covered_value_count >= 0),
  uncovered_value_count INTEGER NOT NULL DEFAULT 0 CHECK (uncovered_value_count >= 0),
  recovered_value_count INTEGER NOT NULL DEFAULT 0 CHECK (recovered_value_count >= 0),
  clarified_value_count INTEGER NOT NULL DEFAULT 0 CHECK (clarified_value_count >= 0),
  not_current_fact_count INTEGER NOT NULL DEFAULT 0 CHECK (not_current_fact_count >= 0),
  unresolved_value_count INTEGER NOT NULL DEFAULT 0 CHECK (unresolved_value_count >= 0),
  deferred_value_count INTEGER NOT NULL DEFAULT 0 CHECK (deferred_value_count >= 0),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (realtime_session_id, reconciliation_revision),
  UNIQUE (realtime_session_id, idempotency_key_hash_b64u),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id),
  FOREIGN KEY (realtime_session_id) REFERENCES consumer_realtime_sessions(id)
);

-- Columns are named on both sides. A positional copy would silently shift
-- every value one place the moment a column is inserted mid-table, which is
-- exactly what this migration does.
INSERT INTO consumer_planner_reconciliations_new (
  id, session_id, realtime_session_id, reconciliation_revision,
  base_profile_revision, through_turn_id, trigger, mode, status,
  idempotency_key_hash_b64u, input_encrypted, input_hash_b64u,
  output_encrypted, output_hash_b64u, applied_profile_revision, model,
  prompt_version, input_tokens, output_tokens, cached_input_tokens,
  latency_ms, operation_count, accepted_operation_count,
  rejected_operation_count, error_code, created_at, completed_at
)
SELECT
  id, session_id, realtime_session_id, reconciliation_revision,
  base_profile_revision, through_turn_id, trigger, mode, status,
  idempotency_key_hash_b64u, input_encrypted, input_hash_b64u,
  output_encrypted, output_hash_b64u, applied_profile_revision, model,
  prompt_version, input_tokens, output_tokens, cached_input_tokens,
  latency_ms, operation_count, accepted_operation_count,
  rejected_operation_count, error_code, created_at, completed_at
FROM consumer_planner_reconciliations;

DROP TABLE consumer_planner_reconciliations;

ALTER TABLE consumer_planner_reconciliations_new
  RENAME TO consumer_planner_reconciliations;

CREATE INDEX IF NOT EXISTS idx_consumer_planner_reconciliations_latest
  ON consumer_planner_reconciliations(realtime_session_id, reconciliation_revision DESC);

CREATE INDEX IF NOT EXISTS idx_consumer_planner_reconciliations_status
  ON consumer_planner_reconciliations(status, created_at);

-- The analysis index: "which checkpoints were driven by a coverage gap, and
-- how did those occurrences end up". Kept narrow so it costs nothing on write.
CREATE INDEX IF NOT EXISTS idx_consumer_planner_reconciliations_value_outcomes
  ON consumer_planner_reconciliations(trigger, status, created_at)
  WHERE uncovered_value_count > 0;
