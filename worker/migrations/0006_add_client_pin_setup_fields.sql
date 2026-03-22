ALTER TABLE published_sessions
ADD COLUMN client_pin_state TEXT;

ALTER TABLE published_sessions
ADD COLUMN client_pin_initialized_at TEXT;

ALTER TABLE published_sessions
ADD COLUMN client_access_revision INTEGER NOT NULL DEFAULT 1;
