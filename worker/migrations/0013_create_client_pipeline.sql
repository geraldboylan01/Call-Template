CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT,
  normalized_email TEXT,
  phone TEXT,
  pipeline_stage TEXT NOT NULL DEFAULT 'new_lead' CHECK (
    pipeline_stage IN (
      'new_lead',
      'reviewing',
      'awaiting_meeting',
      'meeting_booked',
      'session_in_progress',
      'session_published',
      'post_session_email_sent',
      'client_opened',
      'declined',
      'expired',
      'archived'
    )
  ),
  stage_updated_at TEXT NOT NULL,
  advisor_notes TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_normalized_email_unique
  ON clients(normalized_email)
  WHERE normalized_email IS NOT NULL AND normalized_email != '';

CREATE INDEX IF NOT EXISTS idx_clients_stage_updated
  ON clients(pipeline_stage, stage_updated_at);

CREATE INDEX IF NOT EXISTS idx_clients_updated
  ON clients(updated_at);

ALTER TABLE leads ADD COLUMN client_id INTEGER;

ALTER TABLE published_sessions ADD COLUMN client_id INTEGER;
ALTER TABLE published_sessions ADD COLUMN source_lead_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_leads_client_id
  ON leads(client_id);

CREATE INDEX IF NOT EXISTS idx_published_sessions_client_id
  ON published_sessions(client_id);

CREATE INDEX IF NOT EXISTS idx_published_sessions_source_lead_id
  ON published_sessions(source_lead_id);

INSERT OR IGNORE INTO clients (
  created_at,
  updated_at,
  full_name,
  email,
  normalized_email,
  phone,
  pipeline_stage,
  stage_updated_at,
  advisor_notes
)
SELECT
  MIN(created_at),
  MAX(COALESCE(updated_at, created_at)),
  COALESCE(NULLIF(MAX(full_name), ''), 'Client'),
  LOWER(TRIM(email)),
  LOWER(TRIM(email)),
  NULLIF(MAX(COALESCE(phone, '')), ''),
  CASE MAX(
    CASE status
      WHEN 'archived' THEN 10
      WHEN 'expired' THEN 9
      WHEN 'declined' THEN 8
      WHEN 'booked' THEN 3
      WHEN 'awaiting-client' THEN 2
      WHEN 'reviewing' THEN 1
      ELSE 0
    END
  )
    WHEN 10 THEN 'archived'
    WHEN 9 THEN 'expired'
    WHEN 8 THEN 'declined'
    WHEN 3 THEN 'meeting_booked'
    WHEN 2 THEN 'awaiting_meeting'
    WHEN 1 THEN 'reviewing'
    ELSE 'new_lead'
  END,
  MAX(COALESCE(updated_at, created_at)),
  NULLIF(MAX(COALESCE(advisor_notes, '')), '')
FROM leads
WHERE LOWER(TRIM(COALESCE(email, ''))) != ''
GROUP BY LOWER(TRIM(email));

INSERT OR IGNORE INTO clients (
  created_at,
  updated_at,
  full_name,
  email,
  normalized_email,
  phone,
  pipeline_stage,
  stage_updated_at,
  advisor_notes
)
SELECT
  MIN(created_at),
  MAX(COALESCE(updated_at, created_at)),
  COALESCE(NULLIF(MAX(client_name), ''), 'Client'),
  LOWER(TRIM(client_email)),
  LOWER(TRIM(client_email)),
  NULL,
  CASE MAX(
    CASE
      WHEN COALESCE(client_unlock_count, 0) > 0 OR last_client_unlocked_at IS NOT NULL THEN 7
      WHEN last_email_sent_at IS NOT NULL THEN 6
      WHEN status = 'active' THEN 5
      WHEN status = 'expired' THEN 9
      ELSE 5
    END
  )
    WHEN 9 THEN 'expired'
    WHEN 7 THEN 'client_opened'
    WHEN 6 THEN 'post_session_email_sent'
    ELSE 'session_published'
  END,
  MAX(COALESCE(updated_at, created_at)),
  NULL
FROM published_sessions
WHERE LOWER(TRIM(COALESCE(client_email, ''))) != ''
GROUP BY LOWER(TRIM(client_email));

INSERT INTO clients (
  created_at,
  updated_at,
  full_name,
  email,
  normalized_email,
  phone,
  pipeline_stage,
  stage_updated_at,
  advisor_notes
)
SELECT
  created_at,
  COALESCE(updated_at, created_at),
  COALESCE(NULLIF(full_name, ''), 'Client'),
  NULL,
  NULL,
  NULLIF(phone, ''),
  CASE status
    WHEN 'archived' THEN 'archived'
    WHEN 'expired' THEN 'expired'
    WHEN 'declined' THEN 'declined'
    WHEN 'booked' THEN 'meeting_booked'
    WHEN 'awaiting-client' THEN 'awaiting_meeting'
    WHEN 'reviewing' THEN 'reviewing'
    ELSE 'new_lead'
  END,
  COALESCE(updated_at, created_at),
  advisor_notes
FROM leads
WHERE LOWER(TRIM(COALESCE(email, ''))) = '';

INSERT INTO clients (
  created_at,
  updated_at,
  full_name,
  email,
  normalized_email,
  phone,
  pipeline_stage,
  stage_updated_at,
  advisor_notes
)
SELECT
  created_at,
  COALESCE(updated_at, created_at),
  COALESCE(NULLIF(client_name, ''), 'Client'),
  NULL,
  NULL,
  NULL,
  CASE
    WHEN COALESCE(client_unlock_count, 0) > 0 OR last_client_unlocked_at IS NOT NULL THEN 'client_opened'
    WHEN last_email_sent_at IS NOT NULL THEN 'post_session_email_sent'
    WHEN status = 'expired' THEN 'expired'
    ELSE 'session_published'
  END,
  COALESCE(updated_at, created_at),
  NULL
FROM published_sessions
WHERE LOWER(TRIM(COALESCE(client_email, ''))) = '';

UPDATE leads
SET client_id = (
  SELECT id
  FROM clients
  WHERE normalized_email = LOWER(TRIM(leads.email))
  LIMIT 1
)
WHERE LOWER(TRIM(COALESCE(email, ''))) != '';

UPDATE leads
SET client_id = (
  SELECT id
  FROM clients
  WHERE normalized_email IS NULL
    AND full_name = COALESCE(NULLIF(leads.full_name, ''), 'Client')
    AND created_at = leads.created_at
  ORDER BY id
  LIMIT 1
)
WHERE client_id IS NULL;

UPDATE published_sessions
SET client_id = (
  SELECT id
  FROM clients
  WHERE normalized_email = LOWER(TRIM(published_sessions.client_email))
  LIMIT 1
)
WHERE LOWER(TRIM(COALESCE(client_email, ''))) != '';

UPDATE published_sessions
SET client_id = (
  SELECT id
  FROM clients
  WHERE normalized_email IS NULL
    AND full_name = COALESCE(NULLIF(published_sessions.client_name, ''), 'Client')
    AND created_at = published_sessions.created_at
  ORDER BY id
  LIMIT 1
)
WHERE client_id IS NULL;

UPDATE clients
SET
  pipeline_stage = 'session_published',
  stage_updated_at = COALESCE((
    SELECT MAX(COALESCE(updated_at, created_at))
    FROM published_sessions
    WHERE client_id = clients.id
      AND status = 'active'
  ), stage_updated_at),
  updated_at = COALESCE((
    SELECT MAX(COALESCE(updated_at, created_at))
    FROM published_sessions
    WHERE client_id = clients.id
      AND status = 'active'
  ), updated_at)
WHERE pipeline_stage NOT IN ('post_session_email_sent', 'client_opened', 'declined', 'expired', 'archived')
  AND EXISTS (
    SELECT 1
    FROM published_sessions
    WHERE client_id = clients.id
      AND status = 'active'
  );

UPDATE clients
SET
  pipeline_stage = 'post_session_email_sent',
  stage_updated_at = COALESCE((
    SELECT MAX(last_email_sent_at)
    FROM published_sessions
    WHERE client_id = clients.id
      AND last_email_sent_at IS NOT NULL
  ), stage_updated_at),
  updated_at = COALESCE((
    SELECT MAX(last_email_sent_at)
    FROM published_sessions
    WHERE client_id = clients.id
      AND last_email_sent_at IS NOT NULL
  ), updated_at)
WHERE pipeline_stage NOT IN ('client_opened', 'declined', 'expired', 'archived')
  AND EXISTS (
    SELECT 1
    FROM published_sessions
    WHERE client_id = clients.id
      AND last_email_sent_at IS NOT NULL
  );

UPDATE clients
SET
  pipeline_stage = 'client_opened',
  stage_updated_at = COALESCE((
    SELECT MAX(last_client_unlocked_at)
    FROM published_sessions
    WHERE client_id = clients.id
      AND last_client_unlocked_at IS NOT NULL
  ), stage_updated_at),
  updated_at = COALESCE((
    SELECT MAX(last_client_unlocked_at)
    FROM published_sessions
    WHERE client_id = clients.id
      AND last_client_unlocked_at IS NOT NULL
  ), updated_at)
WHERE pipeline_stage NOT IN ('declined', 'expired', 'archived')
  AND EXISTS (
    SELECT 1
    FROM published_sessions
    WHERE client_id = clients.id
      AND (COALESCE(client_unlock_count, 0) > 0 OR last_client_unlocked_at IS NOT NULL)
  );
