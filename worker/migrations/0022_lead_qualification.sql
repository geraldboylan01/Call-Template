-- Internal, immutable qualification snapshots. No billing or lead distribution.
CREATE TABLE IF NOT EXISTS lead_qualification_assessments (
  id TEXT PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  rules_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  payload_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_qualification_latest
  ON lead_qualification_assessments(lead_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS lead_qualification_outcomes (
  id TEXT PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  assessment_id TEXT NOT NULL REFERENCES lead_qualification_assessments(id) ON DELETE CASCADE,
  input_hash TEXT NOT NULL,
  payload_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_qualification_outcomes
  ON lead_qualification_outcomes(lead_id, created_at DESC, id DESC);

-- Rollback: disable the qualification route. Preserve these encrypted tables for
-- audit; no existing lead table or behaviour is changed by this migration.
