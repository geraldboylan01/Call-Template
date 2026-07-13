-- Adviser-test voice is an optional transport layer. It has its own explicit,
-- withdrawable consent so microphone processing can never be inferred from
-- analysis consent or the dormant AI-intake preference.

CREATE TABLE IF NOT EXISTS consumer_voice_consents (
  session_id TEXT PRIMARY KEY,
  granted INTEGER NOT NULL CHECK (granted IN (0, 1)),
  notice_id TEXT NOT NULL,
  data_policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  privacy_notice_url TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  withdrawn_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_voice_consents_updated
  ON consumer_voice_consents(updated_at, granted);
