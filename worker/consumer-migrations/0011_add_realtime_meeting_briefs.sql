-- Conversational Realtime v2 persists only the compact server-composed brief,
-- never planner reasoning or raw prompts. The payload is encrypted with the
-- same consumer keyring as profiles, transcripts and analysis snapshots.
CREATE TABLE IF NOT EXISTS consumer_realtime_meeting_briefs (
  id TEXT PRIMARY KEY,
  realtime_session_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL CHECK (length(source_turn_id) BETWEEN 1 AND 160),
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  schema_version TEXT NOT NULL CHECK (schema_version = 'MeetingBriefV1'),
  planner_prompt_version TEXT NOT NULL CHECK (length(planner_prompt_version) BETWEEN 1 AND 120),
  brief_encrypted TEXT NOT NULL,
  brief_hash_b64u TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (realtime_session_id, source_turn_id),
  FOREIGN KEY (realtime_session_id) REFERENCES consumer_realtime_sessions(id),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_realtime_briefs_latest
  ON consumer_realtime_meeting_briefs(realtime_session_id, updated_at DESC);
