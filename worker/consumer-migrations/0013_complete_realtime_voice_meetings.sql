-- Server-owned spoken completion state and auditable authorization evidence.
-- Raw confirmation text remains only in the encrypted finalized-turn table.
ALTER TABLE consumer_realtime_sessions
  ADD COLUMN meeting_phase TEXT NOT NULL DEFAULT 'discovery'
  CHECK (meeting_phase IN (
    'discovery', 'intake', 'awaiting_voice_confirmation',
    'generating_modules', 'closing', 'completed'
  ));

ALTER TABLE consumer_realtime_sessions ADD COLUMN completion_analysis_plan_id TEXT;
ALTER TABLE consumer_realtime_sessions ADD COLUMN completion_profile_revision INTEGER;
ALTER TABLE consumer_realtime_sessions ADD COLUMN completion_confirmation_turn_id TEXT;
ALTER TABLE consumer_realtime_sessions ADD COLUMN completion_navigation_target TEXT;
ALTER TABLE consumer_realtime_sessions ADD COLUMN completion_outro_speech_id TEXT;

CREATE TABLE IF NOT EXISTS consumer_realtime_voice_confirmations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  realtime_session_id TEXT NOT NULL,
  analysis_plan_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  confirmation_turn_id TEXT NOT NULL,
  confirmation_turn_hash_b64u TEXT NOT NULL,
  confirmation_mode TEXT NOT NULL CHECK (confirmation_mode = 'spoken_affirmative_v1'),
  confirmed_at TEXT NOT NULL,
  UNIQUE (realtime_session_id, analysis_plan_id, confirmation_turn_id),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id),
  FOREIGN KEY (realtime_session_id) REFERENCES consumer_realtime_sessions(id),
  FOREIGN KEY (analysis_plan_id) REFERENCES consumer_realtime_analysis_plans(id),
  FOREIGN KEY (confirmation_turn_id) REFERENCES consumer_realtime_final_turns(id)
);

CREATE INDEX IF NOT EXISTS idx_realtime_voice_confirmations_session_time
  ON consumer_realtime_voice_confirmations(session_id, confirmed_at DESC);

-- MeetingBriefV2 adds the server-owned question batch, completion state,
-- jurisdiction and navigation target. Rebuild the table so existing V1 rows
-- remain readable while newly composed V2 briefs retain their real version.
ALTER TABLE consumer_realtime_meeting_briefs
  RENAME TO consumer_realtime_meeting_briefs_before_v2;

CREATE TABLE consumer_realtime_meeting_briefs (
  id TEXT PRIMARY KEY,
  realtime_session_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL CHECK (length(source_turn_id) BETWEEN 1 AND 160),
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  schema_version TEXT NOT NULL CHECK (schema_version IN ('MeetingBriefV1', 'MeetingBriefV2')),
  planner_prompt_version TEXT NOT NULL CHECK (length(planner_prompt_version) BETWEEN 1 AND 120),
  brief_encrypted TEXT NOT NULL,
  brief_hash_b64u TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (realtime_session_id, source_turn_id),
  FOREIGN KEY (realtime_session_id) REFERENCES consumer_realtime_sessions(id),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id)
);

INSERT INTO consumer_realtime_meeting_briefs (
  id, realtime_session_id, session_id, source_turn_id, profile_revision,
  schema_version, planner_prompt_version, brief_encrypted,
  brief_hash_b64u, created_at, updated_at
)
SELECT
  id, realtime_session_id, session_id, source_turn_id, profile_revision,
  schema_version, planner_prompt_version, brief_encrypted,
  brief_hash_b64u, created_at, updated_at
FROM consumer_realtime_meeting_briefs_before_v2;

DROP TABLE consumer_realtime_meeting_briefs_before_v2;

CREATE INDEX idx_consumer_realtime_briefs_latest
  ON consumer_realtime_meeting_briefs(realtime_session_id, updated_at DESC);
