-- The protected adviser demo now allows a €10.00 per-session realtime
-- envelope (dispatch stop €9.70) so a 10-15 minute planning meeting is not
-- cut off. SQLite cannot alter CHECK constraints in place, and this table is
-- the foreign-key parent of every realtime ledger table, so dropping it with
-- child rows present trips SQLite's deferred foreign-key counter even when
-- the rebuilt table is valid (this is exactly how the first version of this
-- migration failed against remote D1 while passing on empty local replicas).
-- The rebuild therefore stages every child table through a keyless temporary
-- copy, recreates the parent with the widened bounds, then restores each
-- child table (in original creation order, preserving child-to-child
-- references) so no statement ever violates a foreign key under either
-- single-transaction or per-statement execution.
PRAGMA defer_foreign_keys = true;


CREATE TABLE consumer_realtime_sessions_v2 (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  provider_cost_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'openai'),
  provider_call_id_hash_b64u TEXT,
  provider_call_id_encrypted TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'pending', 'active', 'closing', 'complete', 'failed', 'withdrawn',
      'budget_exhausted', 'expired', 'deleted'
    )
  ),
  model TEXT NOT NULL,
  voice TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  toolset_version TEXT NOT NULL,
  pricing_version TEXT NOT NULL,
  reservation_eur_micros INTEGER NOT NULL CHECK (
    reservation_eur_micros BETWEEN 1 AND 10000000
  ),
  dispatch_stop_eur_micros INTEGER NOT NULL CHECK (
    dispatch_stop_eur_micros BETWEEN 0 AND 9700000
  ),
  starting_profile_revision INTEGER NOT NULL,
  latest_profile_revision INTEGER NOT NULL,
  hard_expires_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  last_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),
  response_count INTEGER NOT NULL DEFAULT 0 CHECK (response_count >= 0),
  tool_call_count INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_count >= 0),
  estimated_cost_eur_micros INTEGER NOT NULL DEFAULT 0 CHECK (
    estimated_cost_eur_micros BETWEEN 0 AND 9007199254740991
  ),
  close_reason TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  last_active_at TEXT NOT NULL,
  ended_at TEXT, control_token_hash_b64u TEXT, invite_jti_hash_b64u TEXT,
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

INSERT INTO consumer_realtime_sessions_v2 (
  id,
  session_id,
  provider_cost_id,
  provider,
  provider_call_id_hash_b64u,
  provider_call_id_encrypted,
  status,
  model,
  voice,
  reasoning_effort,
  prompt_version,
  toolset_version,
  pricing_version,
  reservation_eur_micros,
  dispatch_stop_eur_micros,
  starting_profile_revision,
  latest_profile_revision,
  hard_expires_at,
  idle_expires_at,
  last_event_sequence,
  response_count,
  tool_call_count,
  estimated_cost_eur_micros,
  close_reason,
  error_code,
  created_at,
  activated_at,
  last_active_at,
  ended_at,
  control_token_hash_b64u,
  invite_jti_hash_b64u
)
SELECT
  id,
  session_id,
  provider_cost_id,
  provider,
  provider_call_id_hash_b64u,
  provider_call_id_encrypted,
  status,
  model,
  voice,
  reasoning_effort,
  prompt_version,
  toolset_version,
  pricing_version,
  reservation_eur_micros,
  dispatch_stop_eur_micros,
  starting_profile_revision,
  latest_profile_revision,
  hard_expires_at,
  idle_expires_at,
  last_event_sequence,
  response_count,
  tool_call_count,
  estimated_cost_eur_micros,
  close_reason,
  error_code,
  created_at,
  activated_at,
  last_active_at,
  ended_at,
  control_token_hash_b64u,
  invite_jti_hash_b64u
FROM consumer_realtime_sessions;

CREATE TABLE consumer_realtime_events__rebuild AS SELECT * FROM consumer_realtime_events;

CREATE TABLE consumer_realtime_tool_attempts__rebuild AS SELECT * FROM consumer_realtime_tool_attempts;

CREATE TABLE consumer_realtime_usage__rebuild AS SELECT * FROM consumer_realtime_usage;

CREATE TABLE consumer_realtime_final_turns__rebuild AS SELECT * FROM consumer_realtime_final_turns;

CREATE TABLE consumer_realtime_fact_proposals__rebuild AS SELECT * FROM consumer_realtime_fact_proposals;

CREATE TABLE consumer_realtime_analysis_plans__rebuild AS SELECT * FROM consumer_realtime_analysis_plans;

CREATE TABLE consumer_realtime_run_provenance__rebuild AS SELECT * FROM consumer_realtime_run_provenance;

CREATE TABLE consumer_realtime_speech_usage__rebuild AS SELECT * FROM consumer_realtime_speech_usage;

CREATE TABLE consumer_realtime_control_messages__rebuild AS SELECT * FROM consumer_realtime_control_messages;

DROP TABLE consumer_realtime_control_messages;

DROP TABLE consumer_realtime_speech_usage;

DROP TABLE consumer_realtime_run_provenance;

DROP TABLE consumer_realtime_analysis_plans;

DROP TABLE consumer_realtime_fact_proposals;

DROP TABLE consumer_realtime_final_turns;

DROP TABLE consumer_realtime_usage;

DROP TABLE consumer_realtime_tool_attempts;

DROP TABLE consumer_realtime_events;

DROP TABLE consumer_realtime_sessions;

ALTER TABLE consumer_realtime_sessions_v2 RENAME TO consumer_realtime_sessions;

CREATE UNIQUE INDEX IF NOT EXISTS idx_consumer_realtime_one_active_session
  ON consumer_realtime_sessions(session_id)
  WHERE status IN ('pending', 'active', 'closing');

CREATE INDEX IF NOT EXISTS idx_consumer_realtime_sessions_expiry
  ON consumer_realtime_sessions(status, hard_expires_at, idle_expires_at);

CREATE TABLE consumer_realtime_events (
  id TEXT PRIMARY KEY,
  realtime_session_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  provider_event_id_hash_b64u TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('provider_in', 'provider_out', 'server')),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 120),
  payload_encrypted TEXT,
  payload_hash_b64u TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (realtime_session_id, sequence),
  FOREIGN KEY (realtime_session_id) REFERENCES consumer_realtime_sessions(id),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

INSERT INTO consumer_realtime_events SELECT * FROM consumer_realtime_events__rebuild;

DROP TABLE consumer_realtime_events__rebuild;

CREATE TABLE consumer_realtime_tool_attempts (
  id TEXT PRIMARY KEY,
  realtime_session_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  provider_tool_call_id_hash_b64u TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  expected_profile_revision INTEGER,
  status TEXT NOT NULL CHECK (
    status IN ('received', 'validated', 'executing', 'succeeded', 'failed', 'replayed', 'rejected')
  ),
  arguments_encrypted TEXT,
  arguments_hash_b64u TEXT NOT NULL,
  result_encrypted TEXT,
  result_hash_b64u TEXT,
  analysis_run_id TEXT,
  profile_revision_after INTEGER,
  error_code TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (realtime_session_id, provider_tool_call_id_hash_b64u),
  FOREIGN KEY (realtime_session_id) REFERENCES consumer_realtime_sessions(id),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

INSERT INTO consumer_realtime_tool_attempts SELECT * FROM consumer_realtime_tool_attempts__rebuild;

DROP TABLE consumer_realtime_tool_attempts__rebuild;

CREATE TABLE consumer_realtime_usage (
  id TEXT PRIMARY KEY,
  realtime_session_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  provider_response_id_hash_b64u TEXT NOT NULL,
  usage_kind TEXT NOT NULL DEFAULT 'response' CHECK (usage_kind IN ('response', 'transcription')),
  input_text_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_text_tokens >= 0),
  input_audio_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_audio_tokens >= 0),
  cached_text_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_text_tokens >= 0),
  cached_audio_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_audio_tokens >= 0),
  output_text_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_text_tokens >= 0),
  output_audio_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_audio_tokens >= 0),
  transcription_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (transcription_input_tokens >= 0),
  transcription_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (transcription_output_tokens >= 0),
  estimated_cost_eur_micros INTEGER NOT NULL CHECK (
    estimated_cost_eur_micros BETWEEN 0 AND 9007199254740991
  ),
  pricing_version TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (realtime_session_id, provider_response_id_hash_b64u, usage_kind),
  FOREIGN KEY (realtime_session_id) REFERENCES consumer_realtime_sessions(id),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

INSERT INTO consumer_realtime_usage SELECT * FROM consumer_realtime_usage__rebuild;

DROP TABLE consumer_realtime_usage__rebuild;

CREATE TABLE consumer_realtime_final_turns (
  id TEXT PRIMARY KEY,
  realtime_session_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  provider_item_id_hash_b64u TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  transcript_encrypted TEXT NOT NULL,
  transcript_hash_b64u TEXT NOT NULL,
  sensitive_details_removed INTEGER NOT NULL CHECK (sensitive_details_removed IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (realtime_session_id, provider_item_id_hash_b64u, role),
  FOREIGN KEY (realtime_session_id) REFERENCES consumer_realtime_sessions(id),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

INSERT INTO consumer_realtime_final_turns SELECT * FROM consumer_realtime_final_turns__rebuild;

DROP TABLE consumer_realtime_final_turns__rebuild;

CREATE TABLE consumer_realtime_fact_proposals (
  id TEXT PRIMARY KEY,
  realtime_session_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_attempt_id TEXT NOT NULL,
  fact_id TEXT NOT NULL CHECK (length(fact_id) BETWEEN 1 AND 240),
  base_profile_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('proposed', 'confirmed', 'rejected', 'conflicted')
  ),
  value_encrypted TEXT NOT NULL,
  patch_encrypted TEXT NOT NULL,
  patch_hash_b64u TEXT NOT NULL,
  evidence_item_id TEXT NOT NULL CHECK (length(evidence_item_id) BETWEEN 1 AND 160),
  confirmation_evidence_item_id TEXT,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  certainty TEXT NOT NULL CHECK (certainty IN ('exact', 'approximate', 'range', 'unknown')),
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  FOREIGN KEY (realtime_session_id) REFERENCES consumer_realtime_sessions(id),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id),
  FOREIGN KEY (tool_attempt_id) REFERENCES consumer_realtime_tool_attempts(id),
  CHECK (
    (status = 'proposed' AND confirmation_evidence_item_id IS NULL AND reviewed_at IS NULL)
    OR (status IN ('confirmed', 'rejected', 'conflicted')
      AND confirmation_evidence_item_id IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

INSERT INTO consumer_realtime_fact_proposals SELECT * FROM consumer_realtime_fact_proposals__rebuild;

DROP TABLE consumer_realtime_fact_proposals__rebuild;

CREATE TABLE consumer_realtime_analysis_plans (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  realtime_session_id TEXT,
  nonce_hash_b64u TEXT NOT NULL,
  idempotency_key_hash_b64u TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('prepared', 'confirmed', 'running', 'complete', 'needs_information', 'failed', 'conflicted')
  ),
  module_ids_json TEXT NOT NULL,
  input_encrypted TEXT NOT NULL,
  input_snapshot_hash_b64u TEXT NOT NULL,
  result_encrypted TEXT,
  result_hash_b64u TEXT,
  analysis_run_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  completed_at TEXT,
  UNIQUE (session_id, nonce_hash_b64u),
  UNIQUE (session_id, idempotency_key_hash_b64u),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id),
  FOREIGN KEY (realtime_session_id) REFERENCES consumer_realtime_sessions(id)
);

INSERT INTO consumer_realtime_analysis_plans SELECT * FROM consumer_realtime_analysis_plans__rebuild;

DROP TABLE consumer_realtime_analysis_plans__rebuild;

CREATE TABLE consumer_realtime_run_provenance (
  id TEXT PRIMARY KEY,
  realtime_session_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_attempt_id TEXT,
  analysis_run_id TEXT,
  module_run_id TEXT,
  profile_revision INTEGER NOT NULL,
  fact_proposal_ids_hash_b64u TEXT,
  prompt_version TEXT NOT NULL,
  toolset_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (realtime_session_id) REFERENCES consumer_realtime_sessions(id),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

INSERT INTO consumer_realtime_run_provenance SELECT * FROM consumer_realtime_run_provenance__rebuild;

DROP TABLE consumer_realtime_run_provenance__rebuild;

CREATE TABLE consumer_realtime_speech_usage (
  id TEXT PRIMARY KEY,
  realtime_session_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  speech_id_hash_b64u TEXT NOT NULL,
  binding_id_hash_b64u TEXT NOT NULL,
  content_hash_b64u TEXT NOT NULL,
  speech_kind TEXT NOT NULL CHECK (
    speech_kind IN ('greeting', 'acknowledgement', 'question', 'read_back', 'plan', 'result', 'status')
  ),
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  character_count INTEGER NOT NULL CHECK (character_count BETWEEN 1 AND 2400),
  estimated_cost_eur_micros INTEGER NOT NULL CHECK (
    estimated_cost_eur_micros BETWEEN 1 AND 9007199254740991
  ),
  pricing_version TEXT NOT NULL CHECK (length(pricing_version) BETWEEN 1 AND 160),
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'dispatched', 'known', 'unknown', 'not_sent')
  ),
  provider_request_id_hash_b64u TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  completed_at TEXT,
  UNIQUE (realtime_session_id, speech_id_hash_b64u),
  FOREIGN KEY (realtime_session_id) REFERENCES consumer_realtime_sessions(id),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id),
  CHECK (
    (status = 'reserved' AND dispatched_at IS NULL AND completed_at IS NULL)
    OR (status = 'dispatched' AND dispatched_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('known', 'unknown') AND dispatched_at IS NOT NULL AND completed_at IS NOT NULL)
    OR (status = 'not_sent' AND dispatched_at IS NULL AND completed_at IS NOT NULL)
  )
);

INSERT INTO consumer_realtime_speech_usage SELECT * FROM consumer_realtime_speech_usage__rebuild;

DROP TABLE consumer_realtime_speech_usage__rebuild;

CREATE TABLE consumer_realtime_control_messages (
  id TEXT PRIMARY KEY,
  realtime_session_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  control_id TEXT NOT NULL CHECK (length(control_id) BETWEEN 20 AND 120),
  speech_id_hash_b64u TEXT NOT NULL,
  payload_encrypted TEXT NOT NULL,
  payload_hash_b64u TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'delivered', 'processing', 'consumed', 'expired', 'cancelled', 'failed')
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  first_delivered_at TEXT,
  last_delivered_at TEXT,
  delivery_count INTEGER NOT NULL DEFAULT 0 CHECK (delivery_count >= 0),
  consumed_at TEXT,
  error_code TEXT,
  UNIQUE (realtime_session_id, control_id),
  UNIQUE (realtime_session_id, speech_id_hash_b64u),
  FOREIGN KEY (realtime_session_id) REFERENCES consumer_realtime_sessions(id),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id),
  CHECK (
    (status = 'pending' AND first_delivered_at IS NULL AND consumed_at IS NULL)
    OR (status = 'delivered' AND first_delivered_at IS NOT NULL AND consumed_at IS NULL)
    OR (status = 'processing' AND first_delivered_at IS NOT NULL AND consumed_at IS NULL)
    OR (status IN ('consumed', 'expired', 'cancelled', 'failed') AND consumed_at IS NOT NULL)
  )
);

INSERT INTO consumer_realtime_control_messages SELECT * FROM consumer_realtime_control_messages__rebuild;

DROP TABLE consumer_realtime_control_messages__rebuild;

CREATE UNIQUE INDEX idx_consumer_realtime_events_provider_id
  ON consumer_realtime_events(realtime_session_id, provider_event_id_hash_b64u)
  WHERE provider_event_id_hash_b64u IS NOT NULL;

CREATE INDEX idx_consumer_realtime_final_turns_session_time
  ON consumer_realtime_final_turns(realtime_session_id, created_at);

CREATE INDEX idx_consumer_realtime_analysis_plans_session_time
  ON consumer_realtime_analysis_plans(session_id, created_at);

CREATE INDEX idx_consumer_realtime_usage_session_time
  ON consumer_realtime_usage(realtime_session_id, recorded_at);

CREATE INDEX idx_consumer_realtime_tools_session_time
  ON consumer_realtime_tool_attempts(realtime_session_id, created_at);

CREATE INDEX idx_consumer_realtime_proposals_session_status
  ON consumer_realtime_fact_proposals(session_id, status, created_at);

CREATE INDEX idx_consumer_realtime_speech_lease_time
  ON consumer_realtime_speech_usage(realtime_session_id, created_at);

CREATE INDEX idx_consumer_realtime_control_delivery
  ON consumer_realtime_control_messages(realtime_session_id, status, expires_at, created_at);
