-- Only opaque identifiers and metering live here. Household data, model
-- context, cases, results and logs are application-encrypted in private R2.
CREATE TABLE analyst_runs (
  run_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, confirmed_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', snapshot_key TEXT NOT NULL
);
CREATE INDEX analyst_runs_recent ON analyst_runs(created_at DESC);
CREATE TABLE analyst_provider_costs (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES analyst_runs(run_id),
  day_utc TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('reserved','known','unknown','not_sent')),
  reserved_cost_eur_micros INTEGER NOT NULL CHECK(reserved_cost_eur_micros > 0),
  actual_cost_eur_micros INTEGER CHECK(actual_cost_eur_micros >= 0),
  run_limit INTEGER NOT NULL, daily_limit INTEGER NOT NULL,
  input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
  pricing_version TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX analyst_cost_day ON analyst_provider_costs(day_utc);
-- Atomic across simultaneous runs: a read followed by an insert would race.
CREATE TRIGGER analyst_reserve_budget BEFORE INSERT ON analyst_provider_costs BEGIN
  SELECT CASE WHEN COALESCE((SELECT SUM(CASE status WHEN 'known' THEN actual_cost_eur_micros WHEN 'not_sent' THEN 0 ELSE reserved_cost_eur_micros END)
    FROM analyst_provider_costs WHERE run_id=NEW.run_id),0)+NEW.reserved_cost_eur_micros > NEW.run_limit
    THEN RAISE(ABORT,'analyst_run_budget') END;
  SELECT CASE WHEN COALESCE((SELECT SUM(CASE status WHEN 'known' THEN actual_cost_eur_micros WHEN 'not_sent' THEN 0 ELSE reserved_cost_eur_micros END)
    FROM analyst_provider_costs WHERE day_utc=NEW.day_utc),0)+NEW.reserved_cost_eur_micros > NEW.daily_limit
    THEN RAISE(ABORT,'analyst_daily_budget') END;
END;
