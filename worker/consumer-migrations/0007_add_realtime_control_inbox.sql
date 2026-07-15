-- Worker-authorized speech must reach the browser through an authenticated,
-- call-bound channel. The browser receives the opaque capability once with
-- the SDP answer; only its hash is retained. Commands are encrypted at rest
-- and remain replayable through lease polling until consumed or expired.
ALTER TABLE consumer_realtime_sessions
  ADD COLUMN control_token_hash_b64u TEXT;

ALTER TABLE consumer_realtime_sessions
  ADD COLUMN invite_jti_hash_b64u TEXT;

CREATE TABLE IF NOT EXISTS consumer_realtime_control_messages (
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

CREATE INDEX IF NOT EXISTS idx_consumer_realtime_control_delivery
  ON consumer_realtime_control_messages(realtime_session_id, status, expires_at, created_at);
