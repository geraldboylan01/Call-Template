-- M5: module version publish ledger hardening and module.enter pin lookups.
--
-- Published module versions already reject content mutation (M1 trigger).
-- Publishing is now an API surface, so close the remaining gap: published and
-- retired rows must survive DELETE and TRUNCATE too, otherwise a delete +
-- re-publish of the same (module_id, semantic_version) would silently swap
-- the content behind an already-pinned version id. Draft rows stay deletable;
-- the publish endpoint never creates them.
CREATE FUNCTION "reject_module_version_removal"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'TRUNCATE' THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'published and retired module versions are immutable';
	END IF;

	IF OLD.status IN ('published', 'retired') THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'published and retired module versions are immutable';
	END IF;

	RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "module_versions_no_delete_row_trigger"
BEFORE DELETE ON "module_versions"
FOR EACH ROW
EXECUTE FUNCTION "reject_module_version_removal"();--> statement-breakpoint

CREATE TRIGGER "module_versions_no_truncate_trigger"
BEFORE TRUNCATE ON "module_versions"
FOR EACH STATEMENT
EXECUTE FUNCTION "reject_module_version_removal"();--> statement-breakpoint

ALTER TABLE "module_versions"
	ENABLE ALWAYS TRIGGER "module_versions_no_delete_row_trigger";--> statement-breakpoint

ALTER TABLE "module_versions"
	ENABLE ALWAYS TRIGGER "module_versions_no_truncate_trigger";--> statement-breakpoint

-- Performance reads scan module.enter events by their stamped pin, and
-- ingestion re-reads a session's earlier pins on every module re-entry. Both
-- are partial expression indexes so the append-only ledger pays for them only
-- on module.enter rows. Pilot volume needs nothing further; the scale path
-- for session_events remains month-range partitioning by received_at as noted
-- on the table comment.
CREATE INDEX "session_events_module_enter_version_idx"
	ON "session_events" ("tenant_id", ("attrs"->>'module_version_id'), "occurred_at")
	WHERE "event_type" = 'module.enter';--> statement-breakpoint

CREATE INDEX "session_events_module_enter_session_module_idx"
	ON "session_events" ("tenant_id", "session_id", ("attrs"->>'module_id'))
	WHERE "event_type" = 'module.enter';
