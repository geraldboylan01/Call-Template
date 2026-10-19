-- Consent-specific immutable report copies. Keys remain in encrypted published
-- recovery storage; this linkage contains no report content or access secrets.
ALTER TABLE published_sessions ADD COLUMN report_kind TEXT NOT NULL DEFAULT 'workspace';
CREATE TABLE education_call_reports (
  booking_id TEXT PRIMARY KEY,
  published_id TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL CHECK (source_type IN ('consumer', 'published')),
  source_id TEXT NOT NULL,
  analysis_run_id TEXT,
  profile_revision INTEGER,
  report_digest TEXT,
  consent_version TEXT NOT NULL,
  consent_captured_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'building' CHECK (state IN ('building', 'ready', 'purged')),
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX education_call_reports_expiry ON education_call_reports(expires_at);
