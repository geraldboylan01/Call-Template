-- Minimal payment identifiers only: never persist raw Stripe payloads or report data.
ALTER TABLE education_bookings ADD COLUMN payment_provider TEXT;
CREATE TABLE education_stripe_orders (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL UNIQUE REFERENCES education_bookings(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  livemode INTEGER NOT NULL CHECK (livemode IN (0,1)),
  parameters_json TEXT NOT NULL,
  session_id TEXT UNIQUE,
  payment_intent_id TEXT UNIQUE,
  state TEXT NOT NULL DEFAULT 'creating' CHECK (state IN ('creating','open','processing','paid','review','expired')),
  review_reason TEXT
);
CREATE TABLE education_stripe_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES education_stripe_orders(id),
  type TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
CREATE TABLE education_stripe_payment_operations (id TEXT PRIMARY KEY, order_id TEXT NOT NULL);
CREATE TRIGGER education_stripe_payment_operation_guard
BEFORE INSERT ON education_stripe_payment_operations
WHEN NOT EXISTS (SELECT 1 FROM education_stripe_orders WHERE id = NEW.order_id
  AND payment_intent_id IS NULL AND state != 'review')
BEGIN SELECT RAISE(ABORT, 'stripe_payment_changed'); END;
CREATE TRIGGER education_stripe_mark_provider
AFTER INSERT ON education_stripe_orders
BEGIN UPDATE education_bookings SET payment_provider = 'stripe', revision = revision + 1 WHERE id = NEW.booking_id; END;
-- Serialise manual collection against checkout creation, including competing requests.
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
CREATE TRIGGER education_stripe_order_guard
BEFORE INSERT ON education_stripe_orders
WHEN NOT EXISTS (SELECT 1 FROM education_bookings b WHERE b.id = NEW.booking_id
  AND b.status = 'awaiting_payment' AND b.payment_status = 'pending' AND b.setup_state = 'ready'
  AND (b.payment_link IS NULL OR b.payment_link = '')
  AND b.hold_expires_at >= NEW.expires_at AND b.start_at > unixepoch()
  AND NEW.expires_at > unixepoch() + 1800)
BEGIN SELECT RAISE(ABORT, 'stripe_booking_unavailable'); END;
