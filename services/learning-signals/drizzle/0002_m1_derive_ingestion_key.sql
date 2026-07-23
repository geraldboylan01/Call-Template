ALTER TABLE "session_events" ADD CONSTRAINT "session_events_ingestion_key_derived_check" CHECK ("session_events"."ingestion_key" = encode(sha256(convert_to("session_events"."tenant_id"::text || ':' || "session_events"."event_id"::text, 'UTF8')), 'hex'));--> statement-breakpoint

-- Idempotency identity is a server-owned invariant. Ignore any supplied value
-- and derive the key from the authenticated tenant and event UUID before
-- PostgreSQL evaluates NOT NULL, CHECK, and UNIQUE constraints.
CREATE FUNCTION "derive_session_event_ingestion_key"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	NEW.ingestion_key := encode(
		sha256(convert_to(NEW.tenant_id::text || ':' || NEW.event_id::text, 'UTF8')),
		'hex'
	);
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "session_events_derive_ingestion_key_trigger"
BEFORE INSERT ON "session_events"
FOR EACH ROW
EXECUTE FUNCTION "derive_session_event_ingestion_key"();
