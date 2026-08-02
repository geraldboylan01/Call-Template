-- Reclassify the mandatory onboarding privacy control as an acknowledgement,
-- not consent to the processing needed to provide the requested journey.
-- Legacy columns remain during the cached-client compatibility window.
ALTER TABLE consumer_sessions ADD COLUMN privacy_notice_acknowledged INTEGER NOT NULL DEFAULT 0
  CHECK (privacy_notice_acknowledged IN (0, 1));
ALTER TABLE consumer_sessions ADD COLUMN privacy_notice_id TEXT;
ALTER TABLE consumer_sessions ADD COLUMN privacy_notice_version TEXT;
ALTER TABLE consumer_sessions ADD COLUMN privacy_notice_url TEXT;
ALTER TABLE consumer_sessions ADD COLUMN privacy_notice_acknowledged_at TEXT;

UPDATE consumer_sessions
SET privacy_notice_acknowledged = consent_analysis,
    privacy_notice_id = consent_analysis_notice_id,
    privacy_notice_version = consent_policy_version,
    privacy_notice_url = consent_privacy_notice_url,
    privacy_notice_acknowledged_at = consent_captured_at
WHERE privacy_notice_id IS NULL;

CREATE TRIGGER IF NOT EXISTS consumer_session_privacy_notice_acknowledgement_insert
AFTER INSERT ON consumer_sessions
BEGIN
  UPDATE consumer_sessions
  SET privacy_notice_acknowledged = NEW.consent_analysis,
      privacy_notice_id = NEW.consent_analysis_notice_id,
      privacy_notice_version = NEW.consent_policy_version,
      privacy_notice_url = NEW.consent_privacy_notice_url,
      privacy_notice_acknowledged_at = NEW.consent_captured_at
  WHERE id = NEW.id;
END;
