-- Additive, isolated storage for the feature-flagged consumer planning journey.
-- Rollback: disable all CONSUMER_* flags and deploy the previous Worker. If a
-- physical rollback is later required, use a reviewed compensating migration;
-- never rewrite or delete existing adviser/client tables as part of rollback.

CREATE TABLE IF NOT EXISTS consumer_sessions (
  id TEXT PRIMARY KEY,
  credential_hash_b64u TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'completed', 'abandoned', 'deleted', 'expired')
  ),
  stage TEXT NOT NULL DEFAULT 'goal_discovery',
  current_profile_revision INTEGER NOT NULL DEFAULT 1,
  confirmed_profile_revision INTEGER,
  feature_cohort TEXT NOT NULL DEFAULT 'internal',
  consent_analysis INTEGER NOT NULL CHECK (consent_analysis IN (0, 1)),
  consent_ai_processing INTEGER NOT NULL CHECK (consent_ai_processing IN (0, 1)),
  consent_adult_confirmed INTEGER NOT NULL CHECK (consent_adult_confirmed IN (0, 1)),
  consent_education_only INTEGER NOT NULL CHECK (consent_education_only IN (0, 1)),
  consent_manifest_id TEXT NOT NULL,
  consent_policy_version TEXT NOT NULL,
  consent_analysis_notice_id TEXT NOT NULL,
  consent_ai_notice_id TEXT NOT NULL,
  consent_privacy_notice_url TEXT NOT NULL,
  consent_captured_at TEXT NOT NULL,
  ai_consent_withdrawn_at TEXT,
  rolling_summary_encrypted TEXT,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_consumer_sessions_expiry
  ON consumer_sessions(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_consumer_sessions_last_active
  ON consumer_sessions(last_active_at);

CREATE TABLE IF NOT EXISTS consumer_consent_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('analysis', 'ai_processing')),
  action TEXT NOT NULL CHECK (action IN ('granted', 'declined', 'withdrawn')),
  manifest_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  notice_id TEXT NOT NULL,
  privacy_notice_url TEXT NOT NULL,
  capture_method TEXT NOT NULL DEFAULT 'consumer_web' CHECK (capture_method IN ('consumer_web')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_consent_events_session_created
  ON consumer_consent_events(session_id, created_at);

CREATE TABLE IF NOT EXISTS consumer_profile_revisions (
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  payload_encrypted TEXT NOT NULL,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, revision),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_profile_revisions_created
  ON consumer_profile_revisions(session_id, created_at);

CREATE TABLE IF NOT EXISTS consumer_conversation_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'exchange' CHECK (role IN ('user', 'assistant', 'exchange')),
  idempotency_key TEXT NOT NULL,
  payload_encrypted TEXT NOT NULL,
  model TEXT,
  model_tier TEXT,
  prompt_version TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, idempotency_key),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_turns_session_created
  ON consumer_conversation_turns(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_consumer_turns_usage_created
  ON consumer_conversation_turns(created_at, model);

CREATE TABLE IF NOT EXISTS consumer_ai_attempts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (
    status IN ('reserved', 'complete', 'failed')
  ),
  model TEXT,
  model_tier TEXT,
  reasoning_effort TEXT,
  prompt_version TEXT,
  data_policy_id TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_consumer_ai_attempts_active_key
  ON consumer_ai_attempts(session_id, idempotency_key)
  WHERE status = 'reserved';

CREATE INDEX IF NOT EXISTS idx_consumer_ai_attempts_session_created
  ON consumer_ai_attempts(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_consumer_ai_attempts_daily_usage
  ON consumer_ai_attempts(created_at, status);

CREATE TABLE IF NOT EXISTS consumer_analysis_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  input_snapshot_hash_b64u TEXT NOT NULL,
  module_ids_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'needs_information', 'complete', 'partial', 'failed')),
  payload_encrypted TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_analysis_session_created
  ON consumer_analysis_runs(session_id, created_at);

CREATE TABLE IF NOT EXISTS consumer_module_runs (
  id TEXT PRIMARY KEY,
  analysis_run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  module_version TEXT,
  calculation_version TEXT,
  input_snapshot_hash_b64u TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'not_ready', 'failed')),
  payload_encrypted TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (analysis_run_id) REFERENCES consumer_analysis_runs(id),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_module_runs_analysis
  ON consumer_module_runs(analysis_run_id, module_id);

CREATE TABLE IF NOT EXISTS consumer_handoffs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  profile_revision INTEGER NOT NULL,
  consent_policy_version TEXT NOT NULL,
  policy_url TEXT NOT NULL,
  consent_captured_at TEXT NOT NULL,
  package_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'linking', 'linked', 'delivered', 'purged', 'revoked', 'failed')
  ),
  recipient TEXT NOT NULL DEFAULT 'gerry',
  client_id INTEGER,
  lead_id INTEGER,
  retention_policy_id TEXT NOT NULL,
  retention_expires_at TEXT NOT NULL,
  linking_started_at TEXT,
  package_purged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_handoffs_status_updated
  ON consumer_handoffs(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_consumer_handoffs_retention
  ON consumer_handoffs(retention_expires_at, status);

CREATE TABLE IF NOT EXISTS consumer_invite_redemptions (
  jti_hash_b64u TEXT PRIMARY KEY,
  cohort TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 50),
  use_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consumer_invite_redemptions_expiry
  ON consumer_invite_redemptions(expires_at);

CREATE TABLE IF NOT EXISTS consumer_invite_uses (
  jti_hash_b64u TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  used_at TEXT NOT NULL,
  PRIMARY KEY (jti_hash_b64u, session_id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_invite_uses_token
  ON consumer_invite_uses(jti_hash_b64u, used_at);

CREATE TABLE IF NOT EXISTS consumer_events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  event_name TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_events_session_created
  ON consumer_events(session_id, created_at);

CREATE TABLE IF NOT EXISTS consumer_rate_limits (
  scope TEXT NOT NULL,
  bucket_key_hash_b64u TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, bucket_key_hash_b64u)
);

CREATE TABLE IF NOT EXISTS consumer_rekey_runs (
  id TEXT PRIMARY KEY,
  current_key_id TEXT NOT NULL,
  scanned INTEGER NOT NULL CHECK (scanned >= 0),
  rotated INTEGER NOT NULL CHECK (rotated >= 0),
  failed INTEGER NOT NULL CHECK (failed >= 0),
  remaining INTEGER NOT NULL CHECK (remaining >= 0),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consumer_rekey_runs_created
  ON consumer_rekey_runs(created_at);
