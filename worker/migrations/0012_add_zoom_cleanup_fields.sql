ALTER TABLE leads ADD COLUMN zoom_deleted_at TEXT;
ALTER TABLE leads ADD COLUMN schedule_cleanup_attempted_at TEXT;
ALTER TABLE leads ADD COLUMN schedule_cleanup_error TEXT;

CREATE INDEX IF NOT EXISTS idx_leads_schedule_cleanup
  ON leads(schedule_response_status, schedule_response_expires_at, zoom_deleted_at);
