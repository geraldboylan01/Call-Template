-- Where a client record came from.
--
-- Three routes now create clients and they are not the same kind of
-- relationship. A person who registered, was scheduled and sat through a Zoom
-- session is a client in the ordinary sense. A session published straight from
-- the app is a piece of work with a name on it. Someone who completed an
-- online self-service call has never spoken to anyone. Mixing all three in one
-- list makes the list useless for deciding who to follow up with.
--
-- Existing rows predate consumer calls and self-service publishing, so
-- 'adviser_meeting' is the correct backfill for every one of them.
ALTER TABLE clients ADD COLUMN source TEXT NOT NULL DEFAULT 'adviser_meeting';

CREATE INDEX IF NOT EXISTS idx_clients_source_updated
  ON clients(source, updated_at);
