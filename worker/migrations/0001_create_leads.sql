CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  help_reason TEXT NOT NULL,
  stage TEXT,
  consent_free_call INTEGER NOT NULL DEFAULT 0,
  consent_recording INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'landing-page'
);

CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
