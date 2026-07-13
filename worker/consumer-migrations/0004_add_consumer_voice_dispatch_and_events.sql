-- Make the provider-dispatch boundary auditable without weakening the
-- conservative reservation accounting introduced in migration 0002.
-- `dispatched_at` is written once, immediately before the external request,
-- under the exact current voice-consent contract.

ALTER TABLE consumer_provider_costs
  ADD COLUMN dispatched_at TEXT;

-- The current consent row remains the fast authorization check. Each actual
-- state transition also receives a unique event id so the insert into the
-- append-only history can be tied to the same D1 batch.
ALTER TABLE consumer_voice_consents
  ADD COLUMN last_event_id TEXT;

CREATE TABLE IF NOT EXISTS consumer_voice_consent_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('granted', 'withdrawn')),
  notice_id TEXT NOT NULL,
  data_policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  privacy_notice_url TEXT NOT NULL,
  capture_method TEXT NOT NULL CHECK (
    capture_method IN ('consumer_explicit_control')
  ),
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_voice_consent_events_session_time
  ON consumer_voice_consent_events(session_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_consumer_provider_costs_dispatch
  ON consumer_provider_costs(session_id, dispatched_at, status);
