-- Applications sent by AI assistants (POST /api/agent/applications).
--
-- An assistant cannot give consent for the person it is helping, so what it
-- sends is only a request. It waits here until the person opens the emailed
-- link and confirms; only then is a lead and client created, exactly as for
-- /apply/. Unconfirmed requests are deleted by the hourly cron when they
-- expire, 7 days after they arrive.
--
-- The confirmation link carries a random token; only its SHA-256 is stored.
-- The figures and the question are stored only as the same AES-GCM envelope
-- the leads table uses, bound to application_id, so confirming copies the
-- envelope across without decrypting and re-encrypting it.

CREATE TABLE IF NOT EXISTS agent_application_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  application_id TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  application_payload_encrypted TEXT NOT NULL,
  application_schema_version INTEGER,
  application_topics TEXT,
  application_answered_count INTEGER,
  assistant_name TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_application_requests_expires
  ON agent_application_requests(expires_at);

-- How an application arrived: 'page' (/apply/), 'assistant-link' (/apply/,
-- filled in from a link an assistant wrote) or 'agent-api' (sent by an
-- assistant and confirmed by the person). application_assistant is the name
-- the assistant gave, if any.
ALTER TABLE leads ADD COLUMN application_channel TEXT;
ALTER TABLE leads ADD COLUMN application_assistant TEXT;
