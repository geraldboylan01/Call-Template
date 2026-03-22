ALTER TABLE published_sessions
ADD COLUMN client_unlock_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE published_sessions
ADD COLUMN advisor_unlock_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE published_sessions
ADD COLUMN last_client_unlocked_at TEXT;

ALTER TABLE published_sessions
ADD COLUMN last_advisor_unlocked_at TEXT;
