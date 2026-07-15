-- The realtime plan execution snapshot has always been encrypted. Remove the
-- legacy plaintext display/index copy so authenticated display and execution
-- are reconstructed from the same encrypted source of truth.
UPDATE consumer_realtime_analysis_plans
SET module_ids_json = '{"schemaVersion":2,"encryptedInput":true}';

-- Earlier canary builds duplicated semantic fact IDs in plaintext. Pending
-- rows cannot be safely reconstructed after redaction, so fail them closed and
-- ask again; confirmed/rejected history keeps its encrypted value and patch.
UPDATE consumer_realtime_fact_proposals
SET status = 'conflicted',
    confirmation_evidence_item_id = 'migration_sensitive_index_v2',
    reviewed_at = CURRENT_TIMESTAMP
WHERE status = 'proposed';

UPDATE consumer_realtime_fact_proposals
SET fact_id = 'fact_legacy_redacted_v2';

-- Realtime is used only as a private capture, transcription and tool-
-- interpretation channel. Audible assistant copy is selected by the Worker and
-- rendered by the separately authenticated speech endpoint. This ledger keeps
-- that character-priced usage inside the already-reserved Realtime allowance.
-- It deliberately stores only opaque bindings and content hashes: approved
-- speech text and generated audio are never persisted here.
CREATE TABLE IF NOT EXISTS consumer_realtime_speech_usage (
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

CREATE INDEX IF NOT EXISTS idx_consumer_realtime_speech_lease_time
  ON consumer_realtime_speech_usage(realtime_session_id, created_at);
