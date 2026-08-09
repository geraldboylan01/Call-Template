-- Evidence-backed transcript-to-notes reconciliation.
--
-- The realtime model remains the first note-taker. These tables retain the
-- encrypted semantic note ledger and each background reconciliation attempt;
-- the normalized HouseholdProfile remains the adapter/module input snapshot.
-- Runtime mode defaults to the legacy auditor in application code, so applying
-- this additive migration does not enable reconciliation or change production
-- behaviour by itself.

ALTER TABLE consumer_realtime_final_turns
  ADD COLUMN meeting_sequence INTEGER;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY realtime_session_id
           ORDER BY created_at ASC, id ASC
         ) AS sequence
  FROM consumer_realtime_final_turns
)
UPDATE consumer_realtime_final_turns
SET meeting_sequence = (
  SELECT sequence FROM ranked WHERE ranked.id = consumer_realtime_final_turns.id
)
WHERE meeting_sequence IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_consumer_realtime_turn_meeting_sequence
  ON consumer_realtime_final_turns(realtime_session_id, meeting_sequence);

ALTER TABLE consumer_realtime_tool_attempts
  ADD COLUMN source_turn_id TEXT;

CREATE INDEX IF NOT EXISTS idx_consumer_realtime_tool_source_turn
  ON consumer_realtime_tool_attempts(realtime_session_id, source_turn_id);

CREATE TABLE IF NOT EXISTS consumer_planning_notes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  realtime_session_id TEXT NOT NULL,
  note_kind TEXT NOT NULL CHECK (note_kind IN (
    'fact', 'position', 'summary', 'future_event',
    'scenario_option', 'completion'
  )),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN (
    'active', 'superseded', 'retracted', 'needs_clarification'
  )),
  review_status TEXT NOT NULL CHECK (review_status IN (
    'provisional', 'planner_verified', 'planner_corrected', 'user_confirmed'
  )),
  source TEXT NOT NULL CHECK (source IN (
    'realtime_note', 'planner_reconciliation', 'consumer_edit', 'legacy_import'
  )),
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  note_encrypted TEXT NOT NULL,
  note_hash_b64u TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id),
  FOREIGN KEY (realtime_session_id) REFERENCES consumer_realtime_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_planning_notes_active
  ON consumer_planning_notes(realtime_session_id, lifecycle, created_at, id);

CREATE INDEX IF NOT EXISTS idx_consumer_planning_notes_session
  ON consumer_planning_notes(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS consumer_planner_reconciliations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  realtime_session_id TEXT NOT NULL,
  reconciliation_revision INTEGER NOT NULL CHECK (reconciliation_revision >= 1),
  base_profile_revision INTEGER NOT NULL CHECK (base_profile_revision >= 1),
  through_turn_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN (
    'material_turn', 'rejected_note', 'answered_need', 'redundant_question',
    'periodic_checkpoint', 'readiness_transition', 'pre_confirmation',
    'agent_shadow_replay'
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
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (realtime_session_id, reconciliation_revision),
  UNIQUE (realtime_session_id, idempotency_key_hash_b64u),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id),
  FOREIGN KEY (realtime_session_id) REFERENCES consumer_realtime_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_planner_reconciliations_latest
  ON consumer_planner_reconciliations(realtime_session_id, reconciliation_revision DESC);

CREATE INDEX IF NOT EXISTS idx_consumer_planner_reconciliations_status
  ON consumer_planner_reconciliations(status, created_at);

ALTER TABLE consumer_realtime_sessions
  ADD COLUMN planner_reconciliation_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE consumer_realtime_sessions
  ADD COLUMN planner_reconciled_through_turn_id TEXT;

ALTER TABLE consumer_realtime_sessions
  ADD COLUMN planner_pending_through_turn_id TEXT;

ALTER TABLE consumer_realtime_sessions
  ADD COLUMN planner_reconciliation_status TEXT NOT NULL DEFAULT 'legacy'
  CHECK (planner_reconciliation_status IN (
    'legacy', 'pending', 'shadow', 'applied', 'failed'
  ));
