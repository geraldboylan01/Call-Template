CREATE TABLE "telemetry_outbox" (
	"outbox_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"config_version" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posthog_delivered_at" timestamp with time zone,
	"otel_delivered_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"last_failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telemetry_outbox_tenant_event_unique" UNIQUE("tenant_id","event_id"),
	CONSTRAINT "telemetry_outbox_config_version_check" CHECK (length(btrim("telemetry_outbox"."config_version")) > 0),
	CONSTRAINT "telemetry_outbox_attempt_count_check" CHECK ("telemetry_outbox"."attempt_count" >= 0),
	CONSTRAINT "telemetry_outbox_failure_code_check" CHECK ("telemetry_outbox"."last_failure_code" is null or "telemetry_outbox"."last_failure_code" = 'sink_delivery_failed'),
	CONSTRAINT "telemetry_outbox_processed_check" CHECK (("telemetry_outbox"."processed_at" is null and ("telemetry_outbox"."posthog_delivered_at" is null or "telemetry_outbox"."otel_delivered_at" is null)) or ("telemetry_outbox"."processed_at" is not null and "telemetry_outbox"."posthog_delivered_at" is not null and "telemetry_outbox"."otel_delivered_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "telemetry_outbox" ADD CONSTRAINT "telemetry_outbox_event_fk" FOREIGN KEY ("tenant_id","event_id") REFERENCES "public"."session_events"("tenant_id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telemetry_outbox_pending_idx" ON "telemetry_outbox" USING btree ("next_attempt_at","created_at","outbox_id") WHERE "telemetry_outbox"."processed_at" is null;