CREATE TABLE IF NOT EXISTS published_sessions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  client_name TEXT NOT NULL,
  client_email TEXT,
  pin_required INTEGER NOT NULL DEFAULT 0,
  client_auth_hash_b64u TEXT NOT NULL,
  advisor_auth_hash_b64u TEXT NOT NULL,
  client_r2_key TEXT NOT NULL,
  advisor_r2_key TEXT NOT NULL,
  client_open_count INTEGER NOT NULL DEFAULT 0,
  advisor_open_count INTEGER NOT NULL DEFAULT 0,
  last_client_opened_at TEXT,
  last_advisor_opened_at TEXT,
  last_email_sent_at TEXT,
  email_send_count INTEGER NOT NULL DEFAULT 0,
  qr_asset_token TEXT,
  qr_asset_r2_key TEXT,
  qr_asset_content_type TEXT
);

CREATE INDEX IF NOT EXISTS idx_published_sessions_status_expires
  ON published_sessions(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_published_sessions_client_email
  ON published_sessions(client_email);

CREATE TABLE IF NOT EXISTS published_session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  published_session_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_published_session_events_session_created
  ON published_session_events(published_session_id, created_at);
