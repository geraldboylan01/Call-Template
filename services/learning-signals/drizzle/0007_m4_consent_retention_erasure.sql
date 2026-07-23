CREATE TABLE "consent_deletion_queue" (
	"queue_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"consent_type" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "consent_deletion_queue_consent_type_check" CHECK ("consent_deletion_queue"."consent_type" in ('service_improvement_telemetry', 'partner_benchmarking', 'optional_demographics', 'marketing_referral')),
	CONSTRAINT "consent_deletion_queue_reason_check" CHECK ("consent_deletion_queue"."reason" = 'consent_withdrawal'),
	CONSTRAINT "consent_deletion_queue_processed_at_check" CHECK ("consent_deletion_queue"."processed_at" is null or "consent_deletion_queue"."processed_at" >= "consent_deletion_queue"."created_at")
);
--> statement-breakpoint
CREATE TABLE "erasure_requests" (
	"request_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requested_by_actor_pseudo" text NOT NULL,
	"key_version" smallint NOT NULL,
	"key_versions_checked" smallint[] NOT NULL,
	"matched_sessions" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"local_completed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "erasure_requests_tenant_request_unique" UNIQUE("tenant_id","request_id"),
	CONSTRAINT "erasure_requests_actor_hash_check" CHECK ("erasure_requests"."requested_by_actor_pseudo" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "erasure_requests_key_version_check" CHECK ("erasure_requests"."key_version" > 0),
	CONSTRAINT "erasure_requests_key_versions_checked_check" CHECK (cardinality("erasure_requests"."key_versions_checked") > 0 and array_position("erasure_requests"."key_versions_checked", null) is null and 0 < all("erasure_requests"."key_versions_checked")),
	CONSTRAINT "erasure_requests_matched_sessions_check" CHECK ("erasure_requests"."matched_sessions" >= 0),
	CONSTRAINT "erasure_requests_status_check" CHECK ("erasure_requests"."status" in ('pending', 'local_completed', 'completed', 'failed')),
	CONSTRAINT "erasure_requests_completion_check" CHECK (("erasure_requests"."status" = 'pending' and "erasure_requests"."local_completed_at" is null and "erasure_requests"."completed_at" is null) or ("erasure_requests"."status" = 'local_completed' and "erasure_requests"."local_completed_at" is not null and "erasure_requests"."completed_at" is null) or ("erasure_requests"."status" = 'completed' and "erasure_requests"."local_completed_at" is not null and "erasure_requests"."completed_at" is not null) or ("erasure_requests"."status" = 'failed' and "erasure_requests"."completed_at" is null)),
	CONSTRAINT "erasure_requests_timestamps_check" CHECK (("erasure_requests"."local_completed_at" is null or "erasure_requests"."local_completed_at" >= "erasure_requests"."created_at") and ("erasure_requests"."completed_at" is null or ("erasure_requests"."local_completed_at" is not null and "erasure_requests"."completed_at" >= "erasure_requests"."local_completed_at")))
);
--> statement-breakpoint
CREATE TABLE "privacy_deletion_outbox" (
	"outbox_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sink" text NOT NULL,
	"external_subject_ids" text[] NOT NULL,
	"external_subject_key_versions" smallint[] NOT NULL,
	"session_ids" uuid[] NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"last_failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_deletion_outbox_request_sink_unique" UNIQUE("request_id","sink"),
	CONSTRAINT "privacy_deletion_outbox_sink_check" CHECK ("privacy_deletion_outbox"."sink" in ('analytics', 'traces')),
	CONSTRAINT "privacy_deletion_outbox_subject_ids_check" CHECK (array_position("privacy_deletion_outbox"."external_subject_ids", null) is null and (cardinality("privacy_deletion_outbox"."external_subject_ids") = 0 or array_to_string("privacy_deletion_outbox"."external_subject_ids", ',') ~ '^([0-9a-f]{64})(,[0-9a-f]{64})*$')),
	CONSTRAINT "privacy_deletion_outbox_subject_key_versions_check" CHECK (cardinality("privacy_deletion_outbox"."external_subject_key_versions") = cardinality("privacy_deletion_outbox"."external_subject_ids") and array_position("privacy_deletion_outbox"."external_subject_key_versions", null) is null and (cardinality("privacy_deletion_outbox"."external_subject_key_versions") = 0 or 0 < all("privacy_deletion_outbox"."external_subject_key_versions"))),
	CONSTRAINT "privacy_deletion_outbox_session_ids_check" CHECK (array_position("privacy_deletion_outbox"."session_ids", null) is null),
	CONSTRAINT "privacy_deletion_outbox_attempt_count_check" CHECK ("privacy_deletion_outbox"."attempt_count" >= 0),
	CONSTRAINT "privacy_deletion_outbox_failure_code_check" CHECK ("privacy_deletion_outbox"."last_failure_code" is null or "privacy_deletion_outbox"."last_failure_code" = 'sink_delete_failed'),
	CONSTRAINT "privacy_deletion_outbox_processed_check" CHECK (("privacy_deletion_outbox"."processed_at" is null) or ("privacy_deletion_outbox"."processed_at" >= "privacy_deletion_outbox"."created_at" and "privacy_deletion_outbox"."last_failure_code" is null))
);
--> statement-breakpoint
CREATE TABLE "privacy_scrub_authorizations" (
	"tenant_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"operation_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_scrub_authorizations_pk" PRIMARY KEY("tenant_id","operation_id"),
	CONSTRAINT "privacy_scrub_authorizations_operation_type_check" CHECK ("privacy_scrub_authorizations"."operation_type" in ('erasure', 'retention', 'consent_withdrawal'))
);
--> statement-breakpoint
CREATE TABLE "retention_purge_audit" (
	"audit_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"cutoff" timestamp with time zone NOT NULL,
	"rows_deleted" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_purge_audit_run_table_unique" UNIQUE("run_id","tenant_id","table_name"),
	CONSTRAINT "retention_purge_audit_table_name_check" CHECK ("retention_purge_audit"."table_name" in ('adviser_corrections', 'consent_deletion_queue', 'consent_ledger', 'document_events', 'fact_find_sessions', 'field_extractions', 'provider_usage', 'session_events', 'subject_metric_exclusions', 'telemetry_outbox')),
	CONSTRAINT "retention_purge_audit_rows_deleted_check" CHECK ("retention_purge_audit"."rows_deleted" >= 0)
);
--> statement-breakpoint
CREATE TABLE "session_event_scrub_audit" (
	"scrub_audit_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"operation_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_event_scrub_audit_operation_event_unique" UNIQUE("tenant_id","operation_id","event_id"),
	CONSTRAINT "session_event_scrub_audit_operation_type_check" CHECK ("session_event_scrub_audit"."operation_type" in ('erasure', 'retention', 'consent_withdrawal'))
);
--> statement-breakpoint
CREATE TABLE "subject_metric_exclusions" (
	"tenant_id" uuid NOT NULL,
	"pseudonymous_subject_id" text NOT NULL,
	"key_version" smallint NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subject_metric_exclusions_pk" PRIMARY KEY("tenant_id","pseudonymous_subject_id","key_version","reason"),
	CONSTRAINT "subject_metric_exclusions_subject_hash_check" CHECK ("subject_metric_exclusions"."pseudonymous_subject_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "subject_metric_exclusions_key_version_check" CHECK ("subject_metric_exclusions"."key_version" > 0),
	CONSTRAINT "subject_metric_exclusions_reason_check" CHECK ("subject_metric_exclusions"."reason" = 'consent_withdrawal')
);
--> statement-breakpoint
ALTER TABLE "telemetry_outbox" DROP CONSTRAINT "telemetry_outbox_processed_check";--> statement-breakpoint
ALTER TABLE "consent_ledger" ADD COLUMN "decision_ts" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consent_ledger" ADD COLUMN "received_at" timestamp with time zone;--> statement-breakpoint
UPDATE "consent_ledger"
SET "decision_ts" = "occurred_at",
	"received_at" = "created_at";--> statement-breakpoint
ALTER TABLE "consent_ledger" ALTER COLUMN "decision_ts" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_ledger" ALTER COLUMN "received_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "consent_ledger" ALTER COLUMN "received_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD COLUMN "pseudonymous_telemetry_days" integer;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD COLUMN "operational_payload_days" integer;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD COLUMN "consent_ledger_days" integer;--> statement-breakpoint
UPDATE "retention_policies"
SET "pseudonymous_telemetry_days" = "event_retention_days",
	"operational_payload_days" = "document_retention_days",
	"consent_ledger_days" = "session_retention_days";--> statement-breakpoint
ALTER TABLE "retention_policies" ALTER COLUMN "pseudonymous_telemetry_days" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "retention_policies" ALTER COLUMN "operational_payload_days" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "retention_policies" ALTER COLUMN "consent_ledger_days" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "telemetry_outbox" ADD COLUMN "suppressed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telemetry_outbox" ADD COLUMN "suppression_reason" text;--> statement-breakpoint
ALTER TABLE "consent_deletion_queue" ADD CONSTRAINT "consent_deletion_queue_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."fact_find_sessions"("tenant_id","session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_authorization_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."privacy_scrub_authorizations"("tenant_id","operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_deletion_outbox" ADD CONSTRAINT "privacy_deletion_outbox_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."erasure_requests"("tenant_id","request_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_scrub_authorizations" ADD CONSTRAINT "privacy_scrub_authorizations_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_purge_audit" ADD CONSTRAINT "retention_purge_audit_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_purge_audit" ADD CONSTRAINT "retention_purge_audit_authorization_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."privacy_scrub_authorizations"("tenant_id","operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_event_scrub_audit" ADD CONSTRAINT "session_event_scrub_audit_authorization_fk" FOREIGN KEY ("tenant_id","operation_id") REFERENCES "public"."privacy_scrub_authorizations"("tenant_id","operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_metric_exclusions" ADD CONSTRAINT "subject_metric_exclusions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consent_deletion_queue_pending_unique" ON "consent_deletion_queue" USING btree ("tenant_id","session_id","consent_type") WHERE "consent_deletion_queue"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "consent_deletion_queue_pending_idx" ON "consent_deletion_queue" USING btree ("created_at","queue_id") WHERE "consent_deletion_queue"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "consent_deletion_queue_tenant_session_idx" ON "consent_deletion_queue" USING btree ("tenant_id","session_id");--> statement-breakpoint
CREATE INDEX "erasure_requests_tenant_created_idx" ON "erasure_requests" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "erasure_requests_status_created_idx" ON "erasure_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "privacy_deletion_outbox_pending_idx" ON "privacy_deletion_outbox" USING btree ("next_attempt_at","created_at","outbox_id") WHERE "privacy_deletion_outbox"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "privacy_deletion_outbox_tenant_request_idx" ON "privacy_deletion_outbox" USING btree ("tenant_id","request_id");--> statement-breakpoint
CREATE INDEX "privacy_scrub_authorizations_tenant_created_idx" ON "privacy_scrub_authorizations" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "retention_purge_audit_tenant_created_idx" ON "retention_purge_audit" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "retention_purge_audit_run_idx" ON "retention_purge_audit" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "session_event_scrub_audit_tenant_created_idx" ON "session_event_scrub_audit" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "session_event_scrub_audit_operation_idx" ON "session_event_scrub_audit" USING btree ("tenant_id","operation_id");--> statement-breakpoint
CREATE INDEX "subject_metric_exclusions_tenant_created_idx" ON "subject_metric_exclusions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "consent_ledger_current_state_idx" ON "consent_ledger" USING btree ("tenant_id","session_id","purpose","decision_ts","received_at","consent_id");--> statement-breakpoint
CREATE INDEX "consent_ledger_tenant_created_at_idx" ON "consent_ledger" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_pseudonymous_telemetry_days_check" CHECK ("retention_policies"."pseudonymous_telemetry_days" between 1 and 3650);--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_operational_payload_days_check" CHECK ("retention_policies"."operational_payload_days" between 1 and 3650);--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_consent_ledger_days_check" CHECK ("retention_policies"."consent_ledger_days" between 1 and 3650);--> statement-breakpoint
ALTER TABLE "consent_ledger" ADD CONSTRAINT "consent_ledger_purpose_allowlist_check" CHECK ("consent_ledger"."purpose" in ('service_improvement_telemetry', 'partner_benchmarking', 'optional_demographics', 'marketing_referral'));--> statement-breakpoint
ALTER TABLE "telemetry_outbox" ADD CONSTRAINT "telemetry_outbox_suppression_check" CHECK (("telemetry_outbox"."suppressed_at" is null and "telemetry_outbox"."suppression_reason" is null) or ("telemetry_outbox"."suppressed_at" is not null and "telemetry_outbox"."suppression_reason" in ('consent_not_granted', 'withdrawn', 'unclassified_event', 'purpose_limited')));--> statement-breakpoint
ALTER TABLE "telemetry_outbox" ADD CONSTRAINT "telemetry_outbox_processed_check" CHECK (("telemetry_outbox"."processed_at" is null and "telemetry_outbox"."suppressed_at" is null and ("telemetry_outbox"."posthog_delivered_at" is null or "telemetry_outbox"."otel_delivered_at" is null)) or ("telemetry_outbox"."processed_at" is not null and ("telemetry_outbox"."suppressed_at" is not null or ("telemetry_outbox"."posthog_delivered_at" is not null and "telemetry_outbox"."otel_delivered_at" is not null))));
--> statement-breakpoint

-- Consent is an append-only decision ledger. A withdrawal locks its session
-- before insertion so ingestion/outbox consent checks can take the same lock
-- and cannot race past the withdrawal. The side effects are database-owned:
-- every writer gets the deletion queue and next-metrics exclusion atomically.
CREATE FUNCTION "lock_withdrawn_consent_session"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.action = 'withdrawn' THEN
		PERFORM 1
		FROM fact_find_sessions
		WHERE tenant_id = NEW.tenant_id
			AND session_id = NEW.session_id
		FOR UPDATE;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "apply_withdrawn_consent_side_effects"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.action = 'withdrawn'
		AND NEW.consent_id = (
			SELECT current_decision.consent_id
			FROM consent_ledger current_decision
			WHERE current_decision.tenant_id = NEW.tenant_id
				AND current_decision.session_id = NEW.session_id
				AND current_decision.purpose = NEW.purpose
			ORDER BY
				current_decision.decision_ts DESC,
				current_decision.received_at DESC,
				CASE current_decision.action
					WHEN 'withdrawn' THEN 3
					WHEN 'denied' THEN 2
					ELSE 1
				END DESC,
				current_decision.consent_id DESC
			LIMIT 1
		)
	THEN
		INSERT INTO consent_deletion_queue (
			tenant_id,
			session_id,
			consent_type,
			reason
		) VALUES (
			NEW.tenant_id,
			NEW.session_id,
			NEW.purpose,
			'consent_withdrawal'
		)
		ON CONFLICT (tenant_id, session_id, consent_type)
			WHERE processed_at IS NULL
		DO NOTHING;

		INSERT INTO subject_metric_exclusions (
			tenant_id,
			pseudonymous_subject_id,
			key_version,
			reason
		)
		SELECT
			session.tenant_id,
			session.pseudonymous_subject_id,
			session.key_version,
			'consent_withdrawal'
		FROM fact_find_sessions session
		WHERE session.tenant_id = NEW.tenant_id
			AND session.session_id = NEW.session_id
		ON CONFLICT DO NOTHING;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "consent_ledger_withdrawal_lock_trigger"
BEFORE INSERT ON "consent_ledger"
FOR EACH ROW
EXECUTE FUNCTION "lock_withdrawn_consent_session"();--> statement-breakpoint

CREATE TRIGGER "consent_ledger_withdrawal_side_effects_trigger"
AFTER INSERT ON "consent_ledger"
FOR EACH ROW
EXECUTE FUNCTION "apply_withdrawn_consent_side_effects"();--> statement-breakpoint

ALTER TABLE "consent_ledger"
	ENABLE ALWAYS TRIGGER "consent_ledger_withdrawal_lock_trigger";--> statement-breakpoint

ALTER TABLE "consent_ledger"
	ENABLE ALWAYS TRIGGER "consent_ledger_withdrawal_side_effects_trigger";--> statement-breakpoint

-- The transaction performing a narrowly scoped privacy deletion first inserts
-- a privacy_scrub_authorizations row, then sets all three settings with
-- set_config(..., true). Authorizations are valid only in the transaction in
-- which they were created, so an old operation id cannot become a reusable
-- append-only bypass. The trigger itself writes one immutable audit row for
-- every deleted session event.
CREATE OR REPLACE FUNCTION "reject_session_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	scrub_tenant_id uuid;
	scrub_operation_id uuid;
	scrub_operation_type text;
	authorized boolean := false;
BEGIN
	IF TG_OP = 'DELETE' THEN
		BEGIN
			scrub_tenant_id :=
				nullif(current_setting('planeir.scrub_tenant_id', true), '')::uuid;
			scrub_operation_id :=
				nullif(current_setting('planeir.scrub_operation_id', true), '')::uuid;
			scrub_operation_type :=
				nullif(current_setting('planeir.scrub_operation_type', true), '');
		EXCEPTION
			WHEN invalid_text_representation THEN
				scrub_tenant_id := NULL;
				scrub_operation_id := NULL;
				scrub_operation_type := NULL;
		END;

		SELECT EXISTS (
			SELECT 1
			FROM privacy_scrub_authorizations authorization
			WHERE authorization.tenant_id = scrub_tenant_id
				AND authorization.operation_id = scrub_operation_id
				AND authorization.operation_type = scrub_operation_type
				AND authorization.created_at = transaction_timestamp()
		)
		INTO authorized;

		IF authorized
			AND scrub_tenant_id = OLD.tenant_id
			AND scrub_operation_type IN (
				'erasure',
				'retention',
				'consent_withdrawal'
			)
		THEN
			INSERT INTO session_event_scrub_audit (
				tenant_id,
				event_id,
				operation_id,
				operation_type
			) VALUES (
				OLD.tenant_id,
				OLD.event_id,
				scrub_operation_id,
				scrub_operation_type
			);
			RETURN OLD;
		END IF;
	END IF;

	RAISE EXCEPTION USING
		ERRCODE = '55000',
		MESSAGE = 'session_events is append-only';
END;
$$;--> statement-breakpoint

-- Consent decisions cannot be rewritten. Erasure and retention may delete a
-- held decision only under the same transaction-scoped authorization used for
-- session-event scrubbing; UPDATE and TRUNCATE remain impossible.
CREATE FUNCTION "reject_consent_ledger_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	scrub_tenant_id uuid;
	scrub_operation_id uuid;
	scrub_operation_type text;
	authorized boolean := false;
BEGIN
	IF TG_OP = 'DELETE' THEN
		BEGIN
			scrub_tenant_id :=
				nullif(current_setting('planeir.scrub_tenant_id', true), '')::uuid;
			scrub_operation_id :=
				nullif(current_setting('planeir.scrub_operation_id', true), '')::uuid;
			scrub_operation_type :=
				nullif(current_setting('planeir.scrub_operation_type', true), '');
		EXCEPTION
			WHEN invalid_text_representation THEN
				scrub_tenant_id := NULL;
				scrub_operation_id := NULL;
				scrub_operation_type := NULL;
		END;

		SELECT EXISTS (
			SELECT 1
			FROM privacy_scrub_authorizations authorization
			WHERE authorization.tenant_id = scrub_tenant_id
				AND authorization.operation_id = scrub_operation_id
				AND authorization.operation_type = scrub_operation_type
				AND authorization.created_at = transaction_timestamp()
		)
		INTO authorized;

		IF authorized
			AND scrub_tenant_id = OLD.tenant_id
			AND scrub_operation_type IN ('erasure', 'retention')
		THEN
			RETURN OLD;
		END IF;
	END IF;

	RAISE EXCEPTION USING
		ERRCODE = '55000',
		MESSAGE = 'consent_ledger is append-only';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "consent_ledger_append_only_row_trigger"
BEFORE UPDATE OR DELETE ON "consent_ledger"
FOR EACH ROW
EXECUTE FUNCTION "reject_consent_ledger_mutation"();--> statement-breakpoint

CREATE TRIGGER "consent_ledger_append_only_truncate_trigger"
BEFORE TRUNCATE ON "consent_ledger"
FOR EACH STATEMENT
EXECUTE FUNCTION "reject_consent_ledger_mutation"();--> statement-breakpoint

ALTER TABLE "consent_ledger"
	ENABLE ALWAYS TRIGGER "consent_ledger_append_only_row_trigger";--> statement-breakpoint

ALTER TABLE "consent_ledger"
	ENABLE ALWAYS TRIGGER "consent_ledger_append_only_truncate_trigger";--> statement-breakpoint

-- Authorization and audit evidence are themselves append-only. Mutable queue
-- and erasure-request state remain outside this guard because workers must mark
-- attempts and completion.
CREATE FUNCTION "reject_privacy_audit_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION USING
		ERRCODE = '55000',
		MESSAGE = 'privacy audit records are append-only';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "privacy_scrub_authorizations_append_only_row_trigger"
BEFORE UPDATE OR DELETE ON "privacy_scrub_authorizations"
FOR EACH ROW
EXECUTE FUNCTION "reject_privacy_audit_mutation"();--> statement-breakpoint

CREATE TRIGGER "privacy_scrub_authorizations_append_only_truncate_trigger"
BEFORE TRUNCATE ON "privacy_scrub_authorizations"
FOR EACH STATEMENT
EXECUTE FUNCTION "reject_privacy_audit_mutation"();--> statement-breakpoint

CREATE TRIGGER "session_event_scrub_audit_append_only_row_trigger"
BEFORE UPDATE OR DELETE ON "session_event_scrub_audit"
FOR EACH ROW
EXECUTE FUNCTION "reject_privacy_audit_mutation"();--> statement-breakpoint

CREATE TRIGGER "session_event_scrub_audit_append_only_truncate_trigger"
BEFORE TRUNCATE ON "session_event_scrub_audit"
FOR EACH STATEMENT
EXECUTE FUNCTION "reject_privacy_audit_mutation"();--> statement-breakpoint

CREATE TRIGGER "retention_purge_audit_append_only_row_trigger"
BEFORE UPDATE OR DELETE ON "retention_purge_audit"
FOR EACH ROW
EXECUTE FUNCTION "reject_privacy_audit_mutation"();--> statement-breakpoint

CREATE TRIGGER "retention_purge_audit_append_only_truncate_trigger"
BEFORE TRUNCATE ON "retention_purge_audit"
FOR EACH STATEMENT
EXECUTE FUNCTION "reject_privacy_audit_mutation"();--> statement-breakpoint

ALTER TABLE "privacy_scrub_authorizations"
	ENABLE ALWAYS TRIGGER "privacy_scrub_authorizations_append_only_row_trigger";--> statement-breakpoint

ALTER TABLE "privacy_scrub_authorizations"
	ENABLE ALWAYS TRIGGER "privacy_scrub_authorizations_append_only_truncate_trigger";--> statement-breakpoint

ALTER TABLE "session_event_scrub_audit"
	ENABLE ALWAYS TRIGGER "session_event_scrub_audit_append_only_row_trigger";--> statement-breakpoint

ALTER TABLE "session_event_scrub_audit"
	ENABLE ALWAYS TRIGGER "session_event_scrub_audit_append_only_truncate_trigger";--> statement-breakpoint

ALTER TABLE "retention_purge_audit"
	ENABLE ALWAYS TRIGGER "retention_purge_audit_append_only_row_trigger";--> statement-breakpoint

ALTER TABLE "retention_purge_audit"
	ENABLE ALWAYS TRIGGER "retention_purge_audit_append_only_truncate_trigger";
