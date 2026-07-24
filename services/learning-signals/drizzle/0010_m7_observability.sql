CREATE TABLE "provider_budget_alerts" (
	"alert_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"spend_date" date NOT NULL,
	"spend_micros" bigint NOT NULL,
	"cap_micros" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_budget_alerts_natural_unique" UNIQUE("tenant_id","spend_date"),
	CONSTRAINT "provider_budget_alerts_spend_check" CHECK ("provider_budget_alerts"."spend_micros" >= 0),
	CONSTRAINT "provider_budget_alerts_cap_check" CHECK ("provider_budget_alerts"."cap_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "provider_usage_outbox" (
	"outbox_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"usage_id" uuid NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"langfuse_delivered_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"last_failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_usage_outbox_usage_unique" UNIQUE("usage_id"),
	CONSTRAINT "provider_usage_outbox_attempt_count_check" CHECK ("provider_usage_outbox"."attempt_count" >= 0),
	CONSTRAINT "provider_usage_outbox_failure_code_check" CHECK ("provider_usage_outbox"."last_failure_code" is null or "provider_usage_outbox"."last_failure_code" = 'langfuse_delivery_failed'),
	CONSTRAINT "provider_usage_outbox_processed_check" CHECK (("provider_usage_outbox"."processed_at" is null) or ("provider_usage_outbox"."processed_at" is not null and "provider_usage_outbox"."langfuse_delivered_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "tenant_provider_budgets" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"daily_cap_micros" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_provider_budgets_cap_check" CHECK ("tenant_provider_budgets"."daily_cap_micros" >= 0)
);
--> statement-breakpoint
ALTER TABLE "provider_budget_alerts" ADD CONSTRAINT "provider_budget_alerts_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_usage_outbox" ADD CONSTRAINT "provider_usage_outbox_usage_fk" FOREIGN KEY ("usage_id") REFERENCES "public"."provider_usage"("usage_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_usage_outbox" ADD CONSTRAINT "provider_usage_outbox_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_provider_budgets" ADD CONSTRAINT "tenant_provider_budgets_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_budget_alerts_tenant_date_idx" ON "provider_budget_alerts" USING btree ("tenant_id","spend_date");--> statement-breakpoint
CREATE INDEX "provider_usage_outbox_pending_idx" ON "provider_usage_outbox" USING btree ("next_attempt_at","created_at","outbox_id") WHERE "provider_usage_outbox"."processed_at" is null;--> statement-breakpoint

-- Persist-first, forward-async for Langfuse: whatever writes a provider_usage
-- row (orchestrator, pipeline) also enqueues its Langfuse forward in the SAME
-- transaction via this AFTER INSERT trigger. No writer needs to know about
-- Langfuse, and no third-party call happens in the request path. The
-- LangfuseForwardWorker drains the outbox and masks each row to metadata-only
-- before export. ENABLE ALWAYS so the enqueue fires regardless of
-- session_replication_role.
CREATE FUNCTION "enqueue_provider_usage_langfuse"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	INSERT INTO provider_usage_outbox (tenant_id, usage_id)
	VALUES (NEW.tenant_id, NEW.usage_id)
	ON CONFLICT (usage_id) DO NOTHING;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "provider_usage_langfuse_outbox_trigger"
AFTER INSERT ON "provider_usage"
FOR EACH ROW
EXECUTE FUNCTION "enqueue_provider_usage_langfuse"();--> statement-breakpoint

ALTER TABLE "provider_usage"
	ENABLE ALWAYS TRIGGER "provider_usage_langfuse_outbox_trigger";