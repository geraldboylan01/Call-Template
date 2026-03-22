CREATE TABLE IF NOT EXISTS security_rate_limits (
  scope TEXT NOT NULL,
  bucket_key TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, bucket_key)
);

CREATE INDEX IF NOT EXISTS idx_security_rate_limits_updated_at
  ON security_rate_limits(updated_at);
