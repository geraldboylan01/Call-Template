ALTER TABLE leads ADD COLUMN application_submission_hash TEXT;

CREATE TABLE application_audio_access (
  lead_id INTEGER PRIMARY KEY REFERENCES leads(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT
);

CREATE TABLE application_voice_notes (
  id TEXT PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  object_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('pending', 'uploading', 'ready', 'deleting')),
  bytes INTEGER NOT NULL CHECK(bytes > 0 AND bytes <= 10485760),
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  extension TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK(duration_ms > 0 AND duration_ms <= 120000),
  consent_version TEXT NOT NULL CHECK(consent_version = 'case-voice-publication-v1'),
  consent_text TEXT NOT NULL,
  consent_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  uploaded_at TEXT,
  deleted_at TEXT
);
CREATE UNIQUE INDEX application_voice_pending ON application_voice_notes(lead_id)
  WHERE state IN ('pending', 'uploading');
CREATE INDEX application_voice_lead_state ON application_voice_notes(lead_id, state);
CREATE INDEX application_voice_cleanup ON application_voice_notes(state, expires_at);
