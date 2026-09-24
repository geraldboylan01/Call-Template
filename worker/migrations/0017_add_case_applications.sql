-- Case applications from /apply/.
--
-- An application is a lead: the name, email and question sit in the existing
-- columns so every current admin view still shows them. The figures are stored
-- only as an AES-GCM envelope bound to application_id (see
-- worker/src/index.js, encryptApplicationPayload). Topics and the answered
-- count stay readable so the pipeline can list and filter without decrypting.
--
-- application_deleted_at is set when the figures are erased, on request or by
-- the 12 month retention cleanup. The lead row and its question remain.

ALTER TABLE leads ADD COLUMN application_id TEXT;
ALTER TABLE leads ADD COLUMN application_payload_encrypted TEXT;
ALTER TABLE leads ADD COLUMN application_schema_version INTEGER;
ALTER TABLE leads ADD COLUMN application_topics TEXT;
ALTER TABLE leads ADD COLUMN application_answered_count INTEGER;
ALTER TABLE leads ADD COLUMN application_deleted_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_application_id
  ON leads(application_id)
  WHERE application_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_application_retention
  ON leads(created_at)
  WHERE application_payload_encrypted IS NOT NULL;
