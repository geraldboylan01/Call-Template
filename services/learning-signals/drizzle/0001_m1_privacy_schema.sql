CREATE TABLE "adviser_corrections" (
	"correction_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"extraction_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"before_hash" text NOT NULL,
	"after_hash" text NOT NULL,
	"actor_id_pseudo" text NOT NULL,
	"key_version" smallint DEFAULT 1 NOT NULL,
	"reviewer_role" text NOT NULL,
	"reason_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adviser_corrections_tenant_idempotency_unique" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "adviser_corrections_idempotency_key_check" CHECK (length(btrim("adviser_corrections"."idempotency_key")) > 0),
	CONSTRAINT "adviser_corrections_before_hash_check" CHECK ("adviser_corrections"."before_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "adviser_corrections_after_hash_check" CHECK ("adviser_corrections"."after_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "adviser_corrections_actor_hash_check" CHECK ("adviser_corrections"."actor_id_pseudo" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "adviser_corrections_key_version_check" CHECK ("adviser_corrections"."key_version" > 0),
	CONSTRAINT "adviser_corrections_reviewer_role_check" CHECK (length(btrim("adviser_corrections"."reviewer_role")) > 0)
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"key_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"actor_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "api_keys_key_hash_check" CHECK ("api_keys"."key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_keys_scopes_nonempty_check" CHECK (cardinality("api_keys"."scopes") > 0),
	CONSTRAINT "api_keys_scopes_allowlist_check" CHECK ("api_keys"."scopes" <@ array['ingest', 'corrections', 'admin']::text[]),
	CONSTRAINT "api_keys_revoked_at_check" CHECK ("api_keys"."revoked_at" is null or "api_keys"."revoked_at" >= "api_keys"."created_at")
);
--> statement-breakpoint
CREATE TABLE "consent_ledger" (
	"consent_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"action" text NOT NULL,
	"policy_version" text NOT NULL,
	"notice_id" text NOT NULL,
	"evidence_hash" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_ledger_purpose_check" CHECK (length(btrim("consent_ledger"."purpose")) > 0),
	CONSTRAINT "consent_ledger_action_check" CHECK ("consent_ledger"."action" in ('granted', 'withdrawn', 'denied')),
	CONSTRAINT "consent_ledger_policy_version_check" CHECK (length(btrim("consent_ledger"."policy_version")) > 0),
	CONSTRAINT "consent_ledger_notice_id_check" CHECK (length(btrim("consent_ledger"."notice_id")) > 0),
	CONSTRAINT "consent_ledger_evidence_hash_check" CHECK ("consent_ledger"."evidence_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "document_events" (
	"document_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"document_id_hash" text NOT NULL,
	"document_type" text NOT NULL,
	"event_type" text NOT NULL,
	"attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_events_document_hash_check" CHECK ("document_events"."document_id_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "document_events_document_type_check" CHECK (length(btrim("document_events"."document_type")) > 0),
	CONSTRAINT "document_events_event_type_check" CHECK (length(btrim("document_events"."event_type")) > 0),
	CONSTRAINT "document_events_attrs_object_check" CHECK (jsonb_typeof("document_events"."attrs") = 'object'),
	CONSTRAINT "document_events_attrs_size_check" CHECK (octet_length("document_events"."attrs"::text) <= 4096)
);
--> statement-breakpoint
CREATE TABLE "fact_find_sessions" (
	"session_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"module_version_id" uuid NOT NULL,
	"pseudonymous_subject_id" text NOT NULL,
	"key_version" smallint DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_find_sessions_tenant_session_unique" UNIQUE("tenant_id","session_id"),
	CONSTRAINT "fact_find_sessions_subject_hash_check" CHECK ("fact_find_sessions"."pseudonymous_subject_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "fact_find_sessions_key_version_check" CHECK ("fact_find_sessions"."key_version" > 0),
	CONSTRAINT "fact_find_sessions_status_check" CHECK ("fact_find_sessions"."status" in ('started', 'completed', 'abandoned', 'failed')),
	CONSTRAINT "fact_find_sessions_completed_at_check" CHECK (("fact_find_sessions"."status" = 'started' and "fact_find_sessions"."completed_at" is null) or ("fact_find_sessions"."status" <> 'started' and "fact_find_sessions"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "field_extractions" (
	"extraction_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"source_event_id" uuid,
	"field_path" text NOT NULL,
	"value_class" text NOT NULL,
	"normalized_value_hash" text NOT NULL,
	"key_version" smallint DEFAULT 1 NOT NULL,
	"confidence" numeric(5, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_extractions_tenant_extraction_unique" UNIQUE("tenant_id","extraction_id"),
	CONSTRAINT "field_extractions_field_path_check" CHECK (length(btrim("field_extractions"."field_path")) > 0),
	CONSTRAINT "field_extractions_value_class_check" CHECK (length(btrim("field_extractions"."value_class")) > 0),
	CONSTRAINT "field_extractions_value_hash_check" CHECK ("field_extractions"."normalized_value_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "field_extractions_key_version_check" CHECK ("field_extractions"."key_version" > 0),
	CONSTRAINT "field_extractions_confidence_check" CHECK ("field_extractions"."confidence" is null or ("field_extractions"."confidence" >= 0 and "field_extractions"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "module_versions" (
	"module_version_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"module_id" uuid NOT NULL,
	"semantic_version" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"module_body_jsonb" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "module_versions_tenant_version_id_unique" UNIQUE("tenant_id","module_version_id"),
	CONSTRAINT "module_versions_tenant_module_semver_unique" UNIQUE("tenant_id","module_id","semantic_version"),
	CONSTRAINT "module_versions_semantic_version_check" CHECK (length(btrim("module_versions"."semantic_version")) > 0),
	CONSTRAINT "module_versions_status_check" CHECK ("module_versions"."status" in ('draft', 'published', 'retired')),
	CONSTRAINT "module_versions_body_object_check" CHECK (jsonb_typeof("module_versions"."module_body_jsonb") = 'object'),
	CONSTRAINT "module_versions_content_hash_check" CHECK ("module_versions"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "module_versions_published_at_check" CHECK (("module_versions"."status" = 'draft' and "module_versions"."published_at" is null) or ("module_versions"."status" in ('published', 'retired') and "module_versions"."published_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "partner_export_batches" (
	"export_batch_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_code" text NOT NULL,
	"cohort_key" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_count" integer DEFAULT 0 NOT NULL,
	"tenant_count" integer DEFAULT 0 NOT NULL,
	"max_tenant_share" numeric(5, 4) DEFAULT 0 NOT NULL,
	"ready_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_export_batches_window_unique" UNIQUE("partner_code","cohort_key","period_start","period_end"),
	CONSTRAINT "partner_export_batches_partner_code_check" CHECK (length(btrim("partner_export_batches"."partner_code")) > 0),
	CONSTRAINT "partner_export_batches_cohort_key_check" CHECK (length(btrim("partner_export_batches"."cohort_key")) > 0),
	CONSTRAINT "partner_export_batches_period_check" CHECK ("partner_export_batches"."period_end" > "partner_export_batches"."period_start"),
	CONSTRAINT "partner_export_batches_status_check" CHECK ("partner_export_batches"."status" in ('pending', 'suppressed', 'ready', 'failed')),
	CONSTRAINT "partner_export_batches_counts_check" CHECK ("partner_export_batches"."user_count" >= 0 and "partner_export_batches"."tenant_count" >= 0),
	CONSTRAINT "partner_export_batches_share_check" CHECK ("partner_export_batches"."max_tenant_share" >= 0 and "partner_export_batches"."max_tenant_share" <= 1),
	CONSTRAINT "partner_export_batches_release_gate_check" CHECK ("partner_export_batches"."status" <> 'ready' or ("partner_export_batches"."user_count" >= 30 and "partner_export_batches"."tenant_count" >= 3 and "partner_export_batches"."max_tenant_share" <= 0.8)),
	CONSTRAINT "partner_export_batches_ready_at_check" CHECK (("partner_export_batches"."status" = 'ready' and "partner_export_batches"."ready_at" is not null) or ("partner_export_batches"."status" <> 'ready' and "partner_export_batches"."ready_at" is null))
);
--> statement-breakpoint
CREATE TABLE "provider_usage" (
	"usage_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"operation" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"audio_input_ms" integer DEFAULT 0 NOT NULL,
	"audio_output_ms" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_usage_provider_check" CHECK (length(btrim("provider_usage"."provider")) > 0),
	CONSTRAINT "provider_usage_model_check" CHECK (length(btrim("provider_usage"."model")) > 0),
	CONSTRAINT "provider_usage_operation_check" CHECK (length(btrim("provider_usage"."operation")) > 0),
	CONSTRAINT "provider_usage_nonnegative_check" CHECK ("provider_usage"."input_tokens" >= 0 and "provider_usage"."output_tokens" >= 0 and "provider_usage"."cached_input_tokens" >= 0 and "provider_usage"."audio_input_ms" >= 0 and "provider_usage"."audio_output_ms" >= 0 and "provider_usage"."cost_micros" >= 0 and "provider_usage"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"retention_policy_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_key" text NOT NULL,
	"name" text NOT NULL,
	"session_retention_days" integer NOT NULL,
	"event_retention_days" integer NOT NULL,
	"document_retention_days" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policies_policy_key_unique" UNIQUE("policy_key"),
	CONSTRAINT "retention_policies_session_days_check" CHECK ("retention_policies"."session_retention_days" between 1 and 3650),
	CONSTRAINT "retention_policies_event_days_check" CHECK ("retention_policies"."event_retention_days" between 1 and 3650),
	CONSTRAINT "retention_policies_document_days_check" CHECK ("retention_policies"."document_retention_days" between 1 and 3650)
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"tenant_id" uuid NOT NULL,
	"event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"ingestion_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"turn_index" integer,
	"duration_ms" integer,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_events_pk" PRIMARY KEY("tenant_id","event_id"),
	CONSTRAINT "session_events_tenant_ingestion_key_unique" UNIQUE("tenant_id","ingestion_key"),
	CONSTRAINT "session_events_event_type_check" CHECK (length(btrim("session_events"."event_type")) > 0),
	CONSTRAINT "session_events_ingestion_key_check" CHECK ("session_events"."ingestion_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "session_events_payload_hash_check" CHECK ("session_events"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "session_events_attrs_object_check" CHECK (jsonb_typeof("session_events"."attrs") = 'object'),
	CONSTRAINT "session_events_attrs_size_check" CHECK (octet_length("session_events"."attrs"::text) <= 4096),
	CONSTRAINT "session_events_turn_index_check" CHECK ("session_events"."turn_index" is null or "session_events"."turn_index" >= 0),
	CONSTRAINT "session_events_duration_ms_check" CHECK ("session_events"."duration_ms" is null or "session_events"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"tenant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"retention_policy_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001'::uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_slug_check" CHECK (length(btrim("tenants"."slug")) > 0),
	CONSTRAINT "tenants_display_name_check" CHECK (length(btrim("tenants"."display_name")) > 0),
	CONSTRAINT "tenants_status_check" CHECK ("tenants"."status" in ('active', 'suspended', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "adviser_corrections" ADD CONSTRAINT "adviser_corrections_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."fact_find_sessions"("tenant_id","session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adviser_corrections" ADD CONSTRAINT "adviser_corrections_extraction_fk" FOREIGN KEY ("tenant_id","extraction_id") REFERENCES "public"."field_extractions"("tenant_id","extraction_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_ledger" ADD CONSTRAINT "consent_ledger_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."fact_find_sessions"("tenant_id","session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_events" ADD CONSTRAINT "document_events_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."fact_find_sessions"("tenant_id","session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_find_sessions" ADD CONSTRAINT "fact_find_sessions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_find_sessions" ADD CONSTRAINT "fact_find_sessions_module_version_fk" FOREIGN KEY ("tenant_id","module_version_id") REFERENCES "public"."module_versions"("tenant_id","module_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_extractions" ADD CONSTRAINT "field_extractions_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."fact_find_sessions"("tenant_id","session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_extractions" ADD CONSTRAINT "field_extractions_source_event_fk" FOREIGN KEY ("tenant_id","source_event_id") REFERENCES "public"."session_events"("tenant_id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_versions" ADD CONSTRAINT "module_versions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."fact_find_sessions"("tenant_id","session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."fact_find_sessions"("tenant_id","session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_retention_policy_fk" FOREIGN KEY ("retention_policy_id") REFERENCES "public"."retention_policies"("retention_policy_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adviser_corrections_tenant_extraction_idx" ON "adviser_corrections" USING btree ("tenant_id","extraction_id");--> statement-breakpoint
CREATE INDEX "adviser_corrections_tenant_session_idx" ON "adviser_corrections" USING btree ("tenant_id","session_id");--> statement-breakpoint
CREATE INDEX "adviser_corrections_tenant_created_idx" ON "adviser_corrections" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "api_keys_tenant_revoked_idx" ON "api_keys" USING btree ("tenant_id","revoked_at");--> statement-breakpoint
CREATE INDEX "consent_ledger_tenant_session_created_idx" ON "consent_ledger" USING btree ("tenant_id","session_id","created_at");--> statement-breakpoint
CREATE INDEX "consent_ledger_tenant_purpose_created_idx" ON "consent_ledger" USING btree ("tenant_id","purpose","created_at");--> statement-breakpoint
CREATE INDEX "document_events_tenant_session_created_idx" ON "document_events" USING btree ("tenant_id","session_id","created_at");--> statement-breakpoint
CREATE INDEX "document_events_tenant_document_created_idx" ON "document_events" USING btree ("tenant_id","document_id_hash","created_at");--> statement-breakpoint
CREATE INDEX "fact_find_sessions_tenant_module_version_idx" ON "fact_find_sessions" USING btree ("tenant_id","module_version_id");--> statement-breakpoint
CREATE INDEX "fact_find_sessions_tenant_subject_idx" ON "fact_find_sessions" USING btree ("tenant_id","pseudonymous_subject_id");--> statement-breakpoint
CREATE INDEX "fact_find_sessions_tenant_created_at_idx" ON "fact_find_sessions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "field_extractions_tenant_session_idx" ON "field_extractions" USING btree ("tenant_id","session_id");--> statement-breakpoint
CREATE INDEX "field_extractions_tenant_source_event_idx" ON "field_extractions" USING btree ("tenant_id","source_event_id");--> statement-breakpoint
CREATE INDEX "field_extractions_tenant_field_created_idx" ON "field_extractions" USING btree ("tenant_id","field_path","created_at");--> statement-breakpoint
CREATE INDEX "module_versions_tenant_module_status_idx" ON "module_versions" USING btree ("tenant_id","module_id","status");--> statement-breakpoint
CREATE INDEX "partner_export_batches_status_period_idx" ON "partner_export_batches" USING btree ("status","period_start","period_end");--> statement-breakpoint
CREATE INDEX "partner_export_batches_partner_created_idx" ON "partner_export_batches" USING btree ("partner_code","created_at");--> statement-breakpoint
CREATE INDEX "provider_usage_tenant_session_idx" ON "provider_usage" USING btree ("tenant_id","session_id");--> statement-breakpoint
CREATE INDEX "provider_usage_tenant_provider_model_created_idx" ON "provider_usage" USING btree ("tenant_id","provider","model","created_at");--> statement-breakpoint
CREATE INDEX "session_events_tenant_session_order_idx" ON "session_events" USING btree ("tenant_id","session_id","occurred_at","turn_index");--> statement-breakpoint
CREATE INDEX "session_events_tenant_type_received_idx" ON "session_events" USING btree ("tenant_id","event_type","received_at");--> statement-breakpoint
CREATE INDEX "session_events_received_at_idx" ON "session_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "session_events_created_at_idx" ON "session_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tenants_retention_policy_idx" ON "tenants" USING btree ("retention_policy_id");--> statement-breakpoint

-- Stable pilot default used by tenants.retention_policy_id. Retention and purge
-- workers key off created_at, never client-supplied occurred_at.
INSERT INTO "retention_policies" (
	"retention_policy_id",
	"policy_key",
	"name",
	"session_retention_days",
	"event_retention_days",
	"document_retention_days"
) VALUES (
	'00000000-0000-4000-8000-000000000001',
	'pilot-default-v1',
	'Pilot default - 30 days',
	30,
	30,
	30
);--> statement-breakpoint

-- Published module content is canonical. A published row may only move to
-- retired, and that transition may not alter any other column. Retired rows
-- remain immutable so retirement cannot become a content-mutation bypass.
CREATE FUNCTION "enforce_module_version_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD.status IN ('published', 'retired') THEN
		IF OLD.status = 'published'
			AND NEW.status = 'retired'
			AND (to_jsonb(NEW) - 'status') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status')
		THEN
			RETURN NEW;
		END IF;

		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'published and retired module versions are immutable';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "module_versions_immutability_trigger"
BEFORE UPDATE ON "module_versions"
FOR EACH ROW
EXECUTE FUNCTION "enforce_module_version_immutability"();--> statement-breakpoint

-- The event ledger is append-only in the pilot. M4 will replace this guard
-- with its narrowly scoped, audit-logged rights-scrubbing path.
CREATE FUNCTION "reject_session_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION USING
		ERRCODE = '55000',
		MESSAGE = 'session_events is append-only';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "session_events_append_only_row_trigger"
BEFORE UPDATE OR DELETE ON "session_events"
FOR EACH ROW
EXECUTE FUNCTION "reject_session_event_mutation"();--> statement-breakpoint

CREATE TRIGGER "session_events_append_only_truncate_trigger"
BEFORE TRUNCATE ON "session_events"
FOR EACH STATEMENT
EXECUTE FUNCTION "reject_session_event_mutation"();--> statement-breakpoint

-- Pilot volumes do not require partitioning. At scale, migrate session_events
-- to month-range partitions keyed by received_at while retaining the same
-- composite tenant key, constraints, and append-only protections.
COMMENT ON TABLE "session_events" IS
	'Append-only pilot ledger; scale path is month-range partitioning by received_at.';--> statement-breakpoint

COMMENT ON COLUMN "session_events"."occurred_at" IS
	'Client timestamp used only with turn_index for intra-session ordering.';--> statement-breakpoint

COMMENT ON COLUMN "session_events"."received_at" IS
	'Server receipt timestamp used for daily metric windows.';--> statement-breakpoint

COMMENT ON COLUMN "session_events"."created_at" IS
	'Server creation timestamp used for retention and purge windows.';
