CREATE TABLE IF NOT EXISTS education_bookings (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('consumer', 'published')),
  source_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  access_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('awaiting_payment', 'confirmed', 'cancelled', 'expired')),
  setup_state TEXT NOT NULL DEFAULT 'pending' CHECK (setup_state IN ('pending', 'ready', 'failed')),
  setup_token TEXT,
  setup_claimed_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  schedule_revision INTEGER NOT NULL DEFAULT 1,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL CHECK (end_at > start_at),
  hold_expires_at INTEGER,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  offer_version TEXT NOT NULL,
  offer_json TEXT NOT NULL,
  consent_json TEXT NOT NULL,
  lead_id INTEGER,
  report_snapshot_id TEXT,
  payment_link TEXT,
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'verified', 'late_review', 'refund_required', 'refunded')),
  payment_reference TEXT,
  payment_verified_at INTEGER,
  proposal_start_at INTEGER,
  proposal_end_at INTEGER,
  proposal_expires_at INTEGER,
  proposal_revision INTEGER,
  zoom_meeting_id TEXT,
  zoom_join_url TEXT,
  zoom_meeting_password TEXT,
  zoom_state TEXT NOT NULL DEFAULT 'none',
  cancellation_reason TEXT,
  UNIQUE (source_type, source_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_education_bookings_status ON education_bookings(status, start_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_education_payment_reference ON education_bookings(payment_reference)
  WHERE payment_reference IS NOT NULL AND payment_reference != '';

CREATE TRIGGER IF NOT EXISTS education_one_active_booking_per_source
BEFORE INSERT ON education_bookings
WHEN EXISTS (SELECT 1 FROM education_bookings b WHERE b.source_type = NEW.source_type AND b.source_id = NEW.source_id
  AND (b.status = 'confirmed' AND b.end_at > unixepoch() OR b.status = 'awaiting_payment' AND b.hold_expires_at > unixepoch()))
BEGIN SELECT RAISE(ABORT, 'education_source_already_booked'); END;

-- Optimistic revisions are asserted inside the same transaction as calendar
-- changes. A JS read followed by an UPDATE affecting zero rows is insufficient.
CREATE TABLE IF NOT EXISTS education_booking_operations (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  expected_setup_token TEXT
);
CREATE TRIGGER IF NOT EXISTS education_booking_revision_guard
BEFORE INSERT ON education_booking_operations
WHEN NOT EXISTS (SELECT 1 FROM education_bookings WHERE id = NEW.booking_id AND revision = NEW.expected_revision
  AND (NEW.expected_setup_token IS NULL OR setup_token = NEW.expected_setup_token))
BEGIN SELECT RAISE(ABORT, 'education_booking_revision_conflict'); END;

-- One row represents the union of the committed interval and at most one
-- proposed interval. A proposal may overlap its own original without allowing
-- overlaps with any other booking, existing lead, or manual block.
CREATE TABLE IF NOT EXISTS education_calendar_reservations (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL DEFAULT 'gerry',
  booking_id TEXT UNIQUE,
  lead_id INTEGER UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('booking', 'lead', 'block')),
  reason TEXT,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL CHECK (end_at > start_at),
  expires_at INTEGER,
  proposal_start_at INTEGER,
  proposal_end_at INTEGER,
  proposal_expires_at INTEGER,
  CHECK ((proposal_start_at IS NULL AND proposal_end_at IS NULL AND proposal_expires_at IS NULL)
    OR (proposal_start_at IS NOT NULL AND proposal_end_at > proposal_start_at AND proposal_expires_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_education_calendar_host_time ON education_calendar_reservations(host_id, start_at, end_at);

CREATE TRIGGER IF NOT EXISTS education_calendar_no_overlap_insert
BEFORE INSERT ON education_calendar_reservations
WHEN EXISTS (
  SELECT 1 FROM education_calendar_reservations r WHERE r.id != NEW.id AND r.host_id = NEW.host_id AND (
    ((NEW.expires_at IS NULL OR NEW.expires_at > unixepoch()) AND (r.expires_at IS NULL OR r.expires_at > unixepoch()) AND NEW.start_at < r.end_at AND r.start_at < NEW.end_at)
    OR ((NEW.expires_at IS NULL OR NEW.expires_at > unixepoch()) AND r.proposal_expires_at > unixepoch() AND NEW.start_at < r.proposal_end_at AND r.proposal_start_at < NEW.end_at)
    OR (NEW.proposal_expires_at > unixepoch() AND (r.expires_at IS NULL OR r.expires_at > unixepoch()) AND NEW.proposal_start_at < r.end_at AND r.start_at < NEW.proposal_end_at)
    OR (NEW.proposal_expires_at > unixepoch() AND r.proposal_expires_at > unixepoch() AND NEW.proposal_start_at < r.proposal_end_at AND r.proposal_start_at < NEW.proposal_end_at)
  )
)
BEGIN SELECT RAISE(ABORT, 'education_calendar_conflict'); END;

CREATE TRIGGER IF NOT EXISTS education_calendar_no_overlap_update
BEFORE UPDATE ON education_calendar_reservations
WHEN EXISTS (
  SELECT 1 FROM education_calendar_reservations r WHERE r.id != OLD.id AND r.host_id = NEW.host_id AND (
    ((NEW.expires_at IS NULL OR NEW.expires_at > unixepoch()) AND (r.expires_at IS NULL OR r.expires_at > unixepoch()) AND NEW.start_at < r.end_at AND r.start_at < NEW.end_at)
    OR ((NEW.expires_at IS NULL OR NEW.expires_at > unixepoch()) AND r.proposal_expires_at > unixepoch() AND NEW.start_at < r.proposal_end_at AND r.proposal_start_at < NEW.end_at)
    OR (NEW.proposal_expires_at > unixepoch() AND (r.expires_at IS NULL OR r.expires_at > unixepoch()) AND NEW.proposal_start_at < r.end_at AND r.start_at < NEW.proposal_end_at)
    OR (NEW.proposal_expires_at > unixepoch() AND r.proposal_expires_at > unixepoch() AND NEW.proposal_start_at < r.proposal_end_at AND r.proposal_start_at < NEW.proposal_end_at)
  )
)
BEGIN SELECT RAISE(ABORT, 'education_calendar_conflict'); END;

CREATE TABLE IF NOT EXISTS education_booking_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS education_booking_jobs (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'sent', 'failed', 'uncertain', 'superseded')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claim_token TEXT,
  claimed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (booking_id, revision, kind)
);

CREATE INDEX IF NOT EXISTS idx_education_booking_jobs_state ON education_booking_jobs(state, created_at);
-- Serialise all remote mutations for one booking, including updates and
-- cancellations, so an older PATCH cannot arrive after a newer one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_education_booking_zoom_mutation
  ON education_booking_jobs(booking_id)
  WHERE state = 'processing' AND kind IN ('zoom_create', 'zoom_update', 'zoom_cancel');

CREATE TABLE IF NOT EXISTS education_job_operations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  claim_token TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS education_job_claim_guard
BEFORE INSERT ON education_job_operations
WHEN NOT EXISTS (SELECT 1 FROM education_booking_jobs WHERE id = NEW.job_id AND claim_token = NEW.claim_token AND state = 'processing')
BEGIN SELECT RAISE(ABORT, 'education_job_claim_lost'); END;

-- Do not launch booking on a calendar which silently omits existing calls.
-- The trigger intentionally fails this migration if existing future calls
-- overlap; an operator must resolve that calendar before enabling booking.
INSERT OR IGNORE INTO education_calendar_reservations (id, kind, lead_id, start_at, end_at, expires_at)
SELECT 'lead-' || id, 'lead', id, unixepoch(scheduled_start_at), unixepoch(scheduled_end_at),
  CASE WHEN schedule_response_status = 'accepted' OR status = 'booked' THEN NULL ELSE unixepoch(schedule_response_expires_at) END
FROM leads
WHERE unixepoch(scheduled_end_at) > unixepoch()
  AND scheduled_start_at IS NOT NULL AND scheduled_end_at IS NOT NULL
  AND (schedule_response_status = 'accepted' OR status = 'booked'
    OR (schedule_response_status = 'pending' AND unixepoch(schedule_response_expires_at) > unixepoch()));
