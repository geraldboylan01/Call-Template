-- Planner Responses calls share the protected live-session allowance but do
-- not consume the Realtime conversational response-count limit.
ALTER TABLE consumer_realtime_usage RENAME TO consumer_realtime_usage__v2;

CREATE TABLE consumer_realtime_usage (
  id TEXT PRIMARY KEY,
  realtime_session_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  provider_response_id_hash_b64u TEXT NOT NULL,
  usage_kind TEXT NOT NULL DEFAULT 'response' CHECK (
    usage_kind IN ('response', 'transcription', 'planner')
  ),
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

INSERT INTO consumer_realtime_usage SELECT * FROM consumer_realtime_usage__v2;
DROP TABLE consumer_realtime_usage__v2;

CREATE INDEX IF NOT EXISTS idx_consumer_realtime_usage_session_time
  ON consumer_realtime_usage(realtime_session_id, recorded_at);
