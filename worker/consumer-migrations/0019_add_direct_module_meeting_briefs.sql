-- MeetingBriefV3 carries the AI-authored native module-input snapshot and its
-- semantic verification certificate. The encrypted payload remains the source
-- of truth; widening this discriminator lets storage and diagnostics name it
-- honestly while preserving all V1/V2 rows.
ALTER TABLE consumer_realtime_meeting_briefs
  RENAME TO consumer_realtime_meeting_briefs_before_v3;

CREATE TABLE consumer_realtime_meeting_briefs (
  id TEXT PRIMARY KEY,
  realtime_session_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL CHECK (length(source_turn_id) BETWEEN 1 AND 160),
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  schema_version TEXT NOT NULL CHECK (schema_version IN ('MeetingBriefV1', 'MeetingBriefV2', 'MeetingBriefV3')),
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
FROM consumer_realtime_meeting_briefs_before_v3;

DROP TABLE consumer_realtime_meeting_briefs_before_v3;

CREATE INDEX idx_consumer_realtime_briefs_latest
  ON consumer_realtime_meeting_briefs(realtime_session_id, updated_at DESC);
