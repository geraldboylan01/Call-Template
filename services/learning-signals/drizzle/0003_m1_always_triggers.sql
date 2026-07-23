-- Keep the privacy invariants active even when a privileged maintenance
-- session uses session_replication_role = replica. Production must still use a
-- least-privilege, non-owner runtime role; ALWAYS closes the replication-mode
-- bypass at the database layer.
ALTER TABLE "module_versions"
	ENABLE ALWAYS TRIGGER "module_versions_immutability_trigger";--> statement-breakpoint

ALTER TABLE "session_events"
	ENABLE ALWAYS TRIGGER "session_events_append_only_row_trigger";--> statement-breakpoint

ALTER TABLE "session_events"
	ENABLE ALWAYS TRIGGER "session_events_append_only_truncate_trigger";--> statement-breakpoint

ALTER TABLE "session_events"
	ENABLE ALWAYS TRIGGER "session_events_derive_ingestion_key_trigger";
