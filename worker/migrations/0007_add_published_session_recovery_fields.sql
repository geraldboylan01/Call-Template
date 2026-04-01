ALTER TABLE published_sessions
ADD COLUMN recovery_payload_b64u TEXT;

ALTER TABLE published_sessions
ADD COLUMN recovery_iv_b64u TEXT;
