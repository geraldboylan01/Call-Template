ALTER TABLE leads ADD COLUMN schedule_response_token TEXT;
ALTER TABLE leads ADD COLUMN schedule_response_status TEXT;
ALTER TABLE leads ADD COLUMN schedule_response_at TEXT;
ALTER TABLE leads ADD COLUMN schedule_response_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_leads_schedule_response_token
  ON leads(schedule_response_token);
