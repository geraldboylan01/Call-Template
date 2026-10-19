-- A purchase exists before an appointment. Preserve existing reserved-first
-- Stripe orders while making the appointment relationship optional.
PRAGMA defer_foreign_keys = ON;
DROP TRIGGER education_stripe_payment_operation_guard;
DROP TRIGGER education_stripe_mark_provider;
DROP TRIGGER education_stripe_order_guard;
DROP TRIGGER education_stripe_no_manual_link;
DROP TRIGGER education_stripe_no_manual_verification;
CREATE TABLE education_stripe_orders_paid_first (
  id TEXT PRIMARY KEY,
  booking_id TEXT UNIQUE REFERENCES education_bookings(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  livemode INTEGER NOT NULL CHECK (livemode IN (0,1)),
  parameters_json TEXT NOT NULL,
  session_id TEXT UNIQUE,
  payment_intent_id TEXT UNIQUE,
  state TEXT NOT NULL DEFAULT 'creating' CHECK (state IN ('creating','open','processing','paid','review','expired')),
  review_reason TEXT,
  refund_status TEXT,
  source_type TEXT CHECK (source_type IN ('consumer','published')),
  source_id TEXT,
  analysis_run_id TEXT,
  source_key TEXT,
  customer_id TEXT,
  access_token TEXT,
  idempotency_key TEXT,
  request_digest TEXT,
  full_name TEXT,
  email TEXT,
  phone TEXT,
  amount_cents INTEGER,
  currency TEXT,
  offer_version TEXT,
  offer_json TEXT,
  consent_json TEXT,
  lead_id INTEGER,
  report_snapshot_id TEXT,
  setup_state TEXT NOT NULL DEFAULT 'ready' CHECK (setup_state IN ('pending','ready','failed')),
  setup_token TEXT,
  setup_claimed_at INTEGER,
  paid_at INTEGER,
  updated_at INTEGER,
  lifecycle TEXT NOT NULL DEFAULT 'pending' CHECK (lifecycle IN ('pending','awaiting_scheduling','scheduled','completed','cancelled')),
  completed_at INTEGER,
  discussion_topics_ciphertext TEXT,
  schedule_request_digest TEXT
);
INSERT INTO education_stripe_orders_paid_first
  (id,booking_id,created_at,expires_at,livemode,parameters_json,session_id,payment_intent_id,state,review_reason)
SELECT id,booking_id,created_at,expires_at,livemode,parameters_json,session_id,payment_intent_id,state,review_reason
FROM education_stripe_orders;
-- Rebuild the child table as well: merely deferring its foreign key while
-- replacing a parent leaves SQLite's deferred violation counter unresolved.
CREATE TABLE education_stripe_events_backup AS SELECT * FROM education_stripe_events;
DROP TABLE education_stripe_events;
DROP TABLE education_stripe_orders;
ALTER TABLE education_stripe_orders_paid_first RENAME TO education_stripe_orders;
CREATE TABLE education_stripe_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES education_stripe_orders(id),
  type TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
INSERT INTO education_stripe_events SELECT * FROM education_stripe_events_backup;
DROP TABLE education_stripe_events_backup;
CREATE UNIQUE INDEX education_stripe_active_source ON education_stripe_orders(source_key)
  WHERE source_key IS NOT NULL AND state != 'expired' AND lifecycle NOT IN ('completed','cancelled');
CREATE UNIQUE INDEX education_stripe_purchase_request ON education_stripe_orders(source_type,source_id,idempotency_key)
  WHERE source_type IS NOT NULL;
CREATE TRIGGER education_stripe_payment_operation_guard
BEFORE INSERT ON education_stripe_payment_operations
WHEN NOT EXISTS (SELECT 1 FROM education_stripe_orders WHERE id = NEW.order_id
  AND payment_intent_id IS NULL AND state != 'review')
BEGIN SELECT RAISE(ABORT, 'stripe_payment_changed'); END;
CREATE TRIGGER education_stripe_mark_provider
AFTER INSERT ON education_stripe_orders WHEN NEW.booking_id IS NOT NULL
BEGIN UPDATE education_bookings SET payment_provider = 'stripe', revision = revision + 1 WHERE id = NEW.booking_id; END;
CREATE TRIGGER education_stripe_order_guard
BEFORE INSERT ON education_stripe_orders WHEN NEW.source_type IS NULL AND NOT EXISTS (
  SELECT 1 FROM education_bookings b WHERE b.id = NEW.booking_id
  AND b.status = 'awaiting_payment' AND b.payment_status = 'pending' AND b.setup_state = 'ready'
  AND (b.payment_link IS NULL OR b.payment_link = '')
  AND b.hold_expires_at >= NEW.expires_at AND b.start_at > unixepoch() AND NEW.expires_at > unixepoch() + 1800)
BEGIN SELECT RAISE(ABORT, 'stripe_booking_unavailable'); END;
CREATE TRIGGER education_stripe_no_manual_link
BEFORE UPDATE OF payment_link ON education_bookings
WHEN NEW.payment_link IS NOT NULL AND NEW.payment_link != '' AND EXISTS (
  SELECT 1 FROM education_stripe_orders WHERE booking_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'stripe_collection_already_started'); END;
CREATE TRIGGER education_stripe_no_manual_verification
BEFORE UPDATE OF payment_reference ON education_bookings
WHEN NEW.payment_reference IS NOT NULL AND NEW.payment_reference NOT LIKE 'stripe:%' AND EXISTS (
  SELECT 1 FROM education_stripe_orders WHERE booking_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'stripe_collection_already_started'); END;
ALTER TABLE education_bookings ADD COLUMN stripe_purchase_id TEXT;
ALTER TABLE education_bookings ADD COLUMN discussion_topics_ciphertext TEXT;
ALTER TABLE education_bookings ADD COLUMN completed_at INTEGER;
ALTER TABLE education_booking_jobs ADD COLUMN first_attempt_at INTEGER;
CREATE UNIQUE INDEX education_booking_purchase ON education_bookings(stripe_purchase_id)
  WHERE stripe_purchase_id IS NOT NULL;
CREATE TRIGGER education_stripe_booking_notice
BEFORE INSERT ON education_bookings
WHEN NEW.stripe_purchase_id IS NOT NULL AND NEW.start_at < unixepoch() + 86400
BEGIN SELECT RAISE(ABORT, 'education_booking_minimum_notice'); END;
CREATE TRIGGER education_reschedule_notice
BEFORE UPDATE OF start_at ON education_bookings
WHEN NEW.start_at != OLD.start_at AND NEW.start_at < unixepoch() + 86400
BEGIN SELECT RAISE(ABORT, 'education_booking_minimum_notice'); END;
CREATE TABLE education_stripe_jobs (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES education_stripe_orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('purchase_paid_customer','purchase_paid_admin')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','sent','failed','uncertain','superseded')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claim_token TEXT,
  claimed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at INTEGER,
  last_error TEXT,
  UNIQUE (order_id,kind)
);
CREATE INDEX education_stripe_jobs_pending ON education_stripe_jobs(state,created_at);
CREATE TABLE education_stripe_schedule_operations (id TEXT PRIMARY KEY,order_id TEXT NOT NULL);
CREATE TRIGGER education_stripe_schedule_guard
BEFORE INSERT ON education_stripe_schedule_operations
WHEN NOT EXISTS (SELECT 1 FROM education_stripe_orders WHERE id = NEW.order_id
  AND source_type IS NOT NULL AND state = 'paid' AND setup_state = 'ready'
  AND lifecycle = 'awaiting_scheduling' AND booking_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'stripe_purchase_not_schedulable'); END;
