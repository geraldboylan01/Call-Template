-- The protected adviser demo now allows a €10.00 per-session realtime
-- envelope (dispatch stop €9.70) so a 10–15 minute planning meeting is not
-- cut off. The lease table's defensive CHECK bounds still cap what any
-- deployment can reserve per session; they move from the original €2.00/€1.70
-- canary values to the new code-enforced maximums. SQLite cannot alter CHECK
-- constraints in place, so the table is rebuilt and existing rows copied.
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
  ended_at TEXT,
  control_token_hash_b64u TEXT,
  invite_jti_hash_b64u TEXT,
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

INSERT INTO consumer_realtime_sessions_v2 (
  id, session_id, provider_cost_id, provider, provider_call_id_hash_b64u,
  provider_call_id_encrypted, status, model, voice, reasoning_effort,
  prompt_version, toolset_version, pricing_version, reservation_eur_micros,
  dispatch_stop_eur_micros, starting_profile_revision, latest_profile_revision,
  hard_expires_at, idle_expires_at, last_event_sequence, response_count,
  tool_call_count, estimated_cost_eur_micros, close_reason, error_code,
  created_at, activated_at, last_active_at, ended_at,
  control_token_hash_b64u, invite_jti_hash_b64u
)
SELECT
  id, session_id, provider_cost_id, provider, provider_call_id_hash_b64u,
  provider_call_id_encrypted, status, model, voice, reasoning_effort,
  prompt_version, toolset_version, pricing_version, reservation_eur_micros,
  dispatch_stop_eur_micros, starting_profile_revision, latest_profile_revision,
  hard_expires_at, idle_expires_at, last_event_sequence, response_count,
  tool_call_count, estimated_cost_eur_micros, close_reason, error_code,
  created_at, activated_at, last_active_at, ended_at,
  control_token_hash_b64u, invite_jti_hash_b64u
FROM consumer_realtime_sessions;

DROP TABLE consumer_realtime_sessions;

ALTER TABLE consumer_realtime_sessions_v2 RENAME TO consumer_realtime_sessions;

CREATE UNIQUE INDEX IF NOT EXISTS idx_consumer_realtime_one_active_session
  ON consumer_realtime_sessions(session_id)
  WHERE status IN ('pending', 'active', 'closing');

CREATE INDEX IF NOT EXISTS idx_consumer_realtime_sessions_expiry
  ON consumer_realtime_sessions(status, hard_expires_at, idle_expires_at);
