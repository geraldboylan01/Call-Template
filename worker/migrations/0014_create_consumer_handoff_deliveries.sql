-- Idempotent, minimal outbox receipt for consumer-to-adviser lead delivery.
-- This table contains no consumer profile or analysis payload.
CREATE TABLE IF NOT EXISTS consumer_handoff_deliveries (
  handoff_id TEXT PRIMARY KEY,
  lead_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);

CREATE INDEX IF NOT EXISTS idx_consumer_handoff_deliveries_lead
  ON consumer_handoff_deliveries(lead_id);

