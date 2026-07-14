-- Realtime voice is a separate, opt-in transport from the bounded recording
-- feature. All rows remain dormant until CONSUMER_REALTIME_VOICE_ENABLED is
-- explicitly enabled with the reviewed policy, model and budget contract.

CREATE TABLE IF NOT EXISTS consumer_realtime_consents (
  session_id TEXT PRIMARY KEY,
  granted INTEGER NOT NULL CHECK (granted IN (0, 1)),
  notice_id TEXT NOT NULL,
  data_policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  privacy_notice_url TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  withdrawn_at TEXT,
  updated_at TEXT NOT NULL,
  last_event_id TEXT,
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

CREATE TABLE IF NOT EXISTS consumer_realtime_consent_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('granted', 'withdrawn')),
  notice_id TEXT NOT NULL,
  data_policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  privacy_notice_url TEXT NOT NULL,
  capture_method TEXT NOT NULL CHECK (
    capture_method IN ('consumer_explicit_realtime_control')
  ),
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_realtime_consent_events_session_time
  ON consumer_realtime_consent_events(session_id, occurred_at);

CREATE TABLE IF NOT EXISTS consumer_realtime_sessions (
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
    reservation_eur_micros BETWEEN 1 AND 2000000
  ),
  dispatch_stop_eur_micros INTEGER NOT NULL CHECK (
    dispatch_stop_eur_micros BETWEEN 0 AND 1700000
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
  ended_at TEXT,
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_consumer_realtime_one_active_session
  ON consumer_realtime_sessions(session_id)
  WHERE status IN ('pending', 'active', 'closing');

CREATE INDEX IF NOT EXISTS idx_consumer_realtime_sessions_expiry
  ON consumer_realtime_sessions(status, hard_expires_at, idle_expires_at);

CREATE TABLE IF NOT EXISTS consumer_realtime_events (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_consumer_realtime_events_provider_id
  ON consumer_realtime_events(realtime_session_id, provider_event_id_hash_b64u)
  WHERE provider_event_id_hash_b64u IS NOT NULL;

CREATE TABLE IF NOT EXISTS consumer_realtime_tool_attempts (
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

CREATE TABLE IF NOT EXISTS consumer_realtime_usage (
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

CREATE TABLE IF NOT EXISTS consumer_realtime_final_turns (
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

CREATE INDEX IF NOT EXISTS idx_consumer_realtime_final_turns_session_time
  ON consumer_realtime_final_turns(realtime_session_id, created_at);

CREATE TABLE IF NOT EXISTS consumer_realtime_fact_proposals (
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

CREATE TABLE IF NOT EXISTS consumer_realtime_analysis_plans (
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

CREATE INDEX IF NOT EXISTS idx_consumer_realtime_analysis_plans_session_time
  ON consumer_realtime_analysis_plans(session_id, created_at);

CREATE TABLE IF NOT EXISTS consumer_realtime_run_provenance (
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

CREATE INDEX IF NOT EXISTS idx_consumer_realtime_usage_session_time
  ON consumer_realtime_usage(realtime_session_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_consumer_realtime_tools_session_time
  ON consumer_realtime_tool_attempts(realtime_session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_consumer_realtime_proposals_session_status
  ON consumer_realtime_fact_proposals(session_id, status, created_at);
