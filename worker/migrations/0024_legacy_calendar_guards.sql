-- Every legacy administrator scheduling path participates in the same calendar.
-- Paid bookings have their own authoritative reservation and are mirrored to
-- leads for display only, so must not acquire a second reservation here.
CREATE TRIGGER legacy_calendar_after_update
AFTER UPDATE OF scheduled_start_at, scheduled_end_at, status, schedule_response_status, schedule_response_expires_at ON leads
WHEN NOT EXISTS (SELECT 1 FROM education_bookings WHERE lead_id = NEW.id)
BEGIN
  DELETE FROM education_calendar_reservations WHERE id = 'lead-' || NEW.id;
  INSERT INTO education_calendar_reservations (id,kind,lead_id,start_at,end_at,expires_at)
  SELECT 'lead-' || NEW.id,'lead',NEW.id,unixepoch(NEW.scheduled_start_at),unixepoch(NEW.scheduled_end_at),
    CASE WHEN NEW.schedule_response_status = 'accepted' OR NEW.status = 'booked' THEN NULL
      WHEN NEW.schedule_response_status = 'pending' THEN unixepoch(NEW.schedule_response_expires_at) ELSE NULL END
  WHERE unixepoch(NEW.scheduled_end_at) > unixepoch()
    AND unixepoch(NEW.scheduled_end_at) > unixepoch(NEW.scheduled_start_at)
    AND NEW.status NOT IN ('archived','declined','expired')
    AND (NEW.schedule_response_status IS NULL OR NEW.schedule_response_status NOT IN ('declined','expired'));
END;

CREATE TRIGGER legacy_calendar_after_insert
AFTER INSERT ON leads
WHEN unixepoch(NEW.scheduled_end_at) > unixepoch()
BEGIN
  INSERT INTO education_calendar_reservations (id,kind,lead_id,start_at,end_at,expires_at)
  SELECT 'lead-' || NEW.id,'lead',NEW.id,unixepoch(NEW.scheduled_start_at),unixepoch(NEW.scheduled_end_at),
    CASE WHEN NEW.schedule_response_status = 'accepted' OR NEW.status = 'booked' THEN NULL
      WHEN NEW.schedule_response_status = 'pending' THEN unixepoch(NEW.schedule_response_expires_at) ELSE NULL END
  WHERE unixepoch(NEW.scheduled_end_at) > unixepoch(NEW.scheduled_start_at)
    AND NEW.status NOT IN ('archived','declined','expired')
    AND (NEW.schedule_response_status IS NULL OR NEW.schedule_response_status NOT IN ('declined','expired'));
END;

CREATE TRIGGER legacy_calendar_after_delete AFTER DELETE ON leads
BEGIN DELETE FROM education_calendar_reservations WHERE id = 'lead-' || OLD.id; END;
