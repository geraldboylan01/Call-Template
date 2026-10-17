-- Demo intake is independent of historical video applications and consumer calls.
CREATE TABLE demo_invitations (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 10000),
  uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= max_uses),
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE demo_requests (
  id TEXT PRIMARY KEY,
  submission_hash TEXT NOT NULL UNIQUE,
  initial_payload_hash TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  payload_encrypted TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  confirmed_revision INTEGER,
  confirmed_payload_encrypted TEXT,
  confirmed_at TEXT,
  access_status TEXT NOT NULL DEFAULT 'pending' CHECK (access_status IN ('pending','approved','revoked')),
  invitation_id TEXT REFERENCES demo_invitations(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX demo_requests_email ON demo_requests(email_hash);
CREATE INDEX demo_requests_created ON demo_requests(created_at);
-- Consuming a place is part of inserting/upgrading the record. The trigger
-- aborts the whole transaction if an invitation has expired or filled up.
CREATE TRIGGER demo_request_invitation_insert BEFORE INSERT ON demo_requests
WHEN NEW.invitation_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM demo_invitations WHERE id = NEW.invitation_id
      AND revoked_at IS NULL AND expires_at > NEW.created_at AND uses < max_uses
  ) THEN RAISE(ABORT, 'demo_invitation_unavailable') END;
  UPDATE demo_invitations SET uses = uses + 1 WHERE id = NEW.invitation_id;
END;
CREATE TRIGGER demo_request_invitation_upgrade BEFORE UPDATE OF invitation_id ON demo_requests
WHEN NEW.invitation_id IS NOT NULL AND OLD.invitation_id IS NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM demo_invitations WHERE id = NEW.invitation_id
      AND revoked_at IS NULL AND expires_at > NEW.updated_at AND uses < max_uses
  ) THEN RAISE(ABORT, 'demo_invitation_unavailable') END;
  UPDATE demo_invitations SET uses = uses + 1 WHERE id = NEW.invitation_id;
END;
CREATE TABLE demo_access_tokens (
  token_hash TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES demo_requests(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by TEXT
);
CREATE TABLE demo_sessions (
  token_hash TEXT PRIMARY KEY,
  request_id TEXT REFERENCES demo_requests(id) ON DELETE CASCADE,
  invitation_id TEXT REFERENCES demo_invitations(id),
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (request_id IS NOT NULL OR invitation_id IS NOT NULL)
);
CREATE TABLE demo_email_outbox (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES demo_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  provider_id TEXT,
  sent_at TEXT
);
CREATE INDEX demo_outbox_due ON demo_email_outbox(status, next_attempt_at);
