-- A browser-selected activation id lets the client recover a provider call
-- when the SDP answer was created but the HTTP 201 response was lost. Only a
-- SHA-256 hash is retained; the matching control capability is already stored
-- hash-only by migration 0007.
ALTER TABLE consumer_realtime_sessions
  ADD COLUMN activation_id_hash_b64u TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_consumer_realtime_activation_id
  ON consumer_realtime_sessions(session_id, activation_id_hash_b64u)
  WHERE activation_id_hash_b64u IS NOT NULL;
