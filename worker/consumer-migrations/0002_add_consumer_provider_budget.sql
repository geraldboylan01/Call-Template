-- Shared provider-cost budget ledger for consumer AI and voice operations.
--
-- Amounts are integer micro-euros (EUR 1 = 1,000,000) so reservations and
-- settlements never depend on floating-point arithmetic. Existing sessions
-- receive a zero limit and therefore remain fail-closed until a new session is
-- created with an explicitly configured provider budget.

ALTER TABLE consumer_sessions
  ADD COLUMN provider_cost_limit_eur_micros INTEGER NOT NULL DEFAULT 0
  CHECK (provider_cost_limit_eur_micros BETWEEN 0 AND 9007199254740991);

CREATE TABLE IF NOT EXISTS consumer_provider_costs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 80),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 80),
  model TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 120),
  pricing_version TEXT NOT NULL CHECK (length(pricing_version) BETWEEN 1 AND 120),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (
    status IN ('reserved', 'known', 'unknown', 'not_sent')
  ),
  reserved_cost_eur_micros INTEGER NOT NULL CHECK (
    reserved_cost_eur_micros BETWEEN 1 AND 9007199254740991
  ),
  actual_cost_eur_micros INTEGER CHECK (
    actual_cost_eur_micros BETWEEN 0 AND 9007199254740991
  ),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (session_id, operation, idempotency_key),
  FOREIGN KEY (session_id) REFERENCES consumer_sessions(id),
  CHECK (
    (status = 'reserved' AND actual_cost_eur_micros IS NULL AND completed_at IS NULL)
    OR (status = 'known' AND actual_cost_eur_micros IS NOT NULL AND completed_at IS NOT NULL)
    OR (status IN ('unknown', 'not_sent') AND actual_cost_eur_micros IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_consumer_provider_costs_session_created
  ON consumer_provider_costs(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_consumer_provider_costs_daily_created
  ON consumer_provider_costs(created_at, status);

-- Session deletion removes the linkable ledger rows. These date-only totals
-- preserve the global daily circuit breaker without retaining a session,
-- operation, provider, model, or idempotency key.
CREATE TABLE IF NOT EXISTS consumer_provider_daily_cost_totals (
  day_utc TEXT PRIMARY KEY CHECK (
    length(day_utc) = 10
    AND day_utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  spent_eur_micros INTEGER NOT NULL DEFAULT 0 CHECK (
    spent_eur_micros BETWEEN 0 AND 9007199254740991
  ),
  known_actual_eur_micros INTEGER NOT NULL DEFAULT 0 CHECK (
    known_actual_eur_micros BETWEEN 0 AND 9007199254740991
  ),
  reserved_or_unknown_eur_micros INTEGER NOT NULL DEFAULT 0 CHECK (
    reserved_or_unknown_eur_micros BETWEEN 0 AND 9007199254740991
  ),
  released_eur_micros INTEGER NOT NULL DEFAULT 0 CHECK (
    released_eur_micros BETWEEN 0 AND 9007199254740991
  ),
  updated_at TEXT NOT NULL
);
