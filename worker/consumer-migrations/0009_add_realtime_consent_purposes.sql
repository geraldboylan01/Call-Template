-- Purpose-level Realtime consent is additive to the existing bundled receipt.
-- The current client continues to use the bundled receipt until it offers the
-- three controls independently; these tables provide the audited domain layer
-- without weakening the existing fail-closed consent checks.

CREATE TABLE IF NOT EXISTS consumer_realtime_consent_purposes (
  session_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (
    purpose IN (
      'live_voice_processing',
      'automated_planning_analysis',
      'redacted_turn_retention'
    )
  ),
  granted INTEGER NOT NULL CHECK (granted IN (0, 1)),
  notice_id TEXT NOT NULL,
  data_policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  privacy_notice_url TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  withdrawn_at TEXT,
  updated_at TEXT NOT NULL,
  last_event_id TEXT,
  PRIMARY KEY (session_id, purpose),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_realtime_consent_purposes_updated
  ON consumer_realtime_consent_purposes(updated_at, purpose, granted);

CREATE TABLE IF NOT EXISTS consumer_realtime_consent_purpose_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (
    purpose IN (
      'live_voice_processing',
      'automated_planning_analysis',
      'redacted_turn_retention'
    )
  ),
  action TEXT NOT NULL CHECK (action IN ('granted', 'withdrawn')),
  notice_id TEXT NOT NULL,
  data_policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  privacy_notice_url TEXT NOT NULL,
  capture_method TEXT NOT NULL CHECK (
    capture_method = 'consumer_explicit_realtime_purpose_control'
  ),
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_realtime_consent_purpose_events_session_time
  ON consumer_realtime_consent_purpose_events(session_id, occurred_at, purpose);
