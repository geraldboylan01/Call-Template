ALTER TABLE leads ADD COLUMN status TEXT NOT NULL DEFAULT 'new';
ALTER TABLE leads ADD COLUMN advisor_notes TEXT;
ALTER TABLE leads ADD COLUMN availability_notes TEXT;
ALTER TABLE leads ADD COLUMN scheduled_start_at TEXT;
ALTER TABLE leads ADD COLUMN scheduled_end_at TEXT;
ALTER TABLE leads ADD COLUMN scheduled_timezone TEXT;
ALTER TABLE leads ADD COLUMN scheduled_location TEXT;
ALTER TABLE leads ADD COLUMN scheduled_message TEXT;
ALTER TABLE leads ADD COLUMN schedule_invite_uid TEXT;
ALTER TABLE leads ADD COLUMN last_schedule_email_sent_at TEXT;
ALTER TABLE leads ADD COLUMN schedule_email_send_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN updated_at TEXT;

UPDATE leads
SET updated_at = created_at
WHERE updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_leads_status_updated_at
  ON leads(status, updated_at);

CREATE TABLE IF NOT EXISTS lead_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  actor_type TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_lead_events_lead_created
  ON lead_events(lead_id, created_at);
