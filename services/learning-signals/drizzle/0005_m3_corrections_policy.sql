ALTER TABLE "adviser_corrections" ADD COLUMN "payload_hash" text;--> statement-breakpoint
ALTER TABLE "adviser_corrections" ADD COLUMN "before_preview" text;--> statement-breakpoint
ALTER TABLE "adviser_corrections" ADD COLUMN "after_preview" text;--> statement-breakpoint
ALTER TABLE "adviser_corrections" ADD COLUMN "field_policy_version" text DEFAULT 'field-policy-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "field_extractions" ADD COLUMN "normalized_value_preview" text;--> statement-breakpoint
ALTER TABLE "field_extractions" ADD COLUMN "extraction_status" text DEFAULT 'extracted' NOT NULL;--> statement-breakpoint
ALTER TABLE "field_extractions" ADD COLUMN "field_policy_version" text DEFAULT 'field-policy-v1' NOT NULL;--> statement-breakpoint
UPDATE "adviser_corrections"
SET "payload_hash" = encode(
	sha256(
		convert_to(
			'planeir:m3:legacy-correction:' ||
			"correction_id"::text || ':' ||
			"tenant_id"::text || ':' ||
			"session_id"::text || ':' ||
			"extraction_id"::text || ':' ||
			"idempotency_key" || ':' ||
			"before_hash" || ':' ||
			"after_hash" || ':' ||
			"actor_id_pseudo" || ':' ||
			"key_version"::text || ':' ||
			"reviewer_role" || ':' ||
			coalesce("reason_code", ''),
			'UTF8'
		)
	),
	'hex'
);--> statement-breakpoint
UPDATE "adviser_corrections"
SET "reason_code" = 'other'
WHERE "reason_code" IS NOT NULL
	AND "reason_code" NOT IN (
		'incorrect_value',
		'missing_value',
		'misclassified',
		'formatting',
		'other'
	);--> statement-breakpoint
ALTER TABLE "adviser_corrections" ALTER COLUMN "payload_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "field_extractions" ADD CONSTRAINT "field_extractions_tenant_session_extraction_unique" UNIQUE("tenant_id","session_id","extraction_id");--> statement-breakpoint
ALTER TABLE "adviser_corrections" ADD CONSTRAINT "adviser_corrections_session_extraction_fk" FOREIGN KEY ("tenant_id","session_id","extraction_id") REFERENCES "public"."field_extractions"("tenant_id","session_id","extraction_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adviser_corrections" ADD CONSTRAINT "adviser_corrections_payload_hash_check" CHECK ("adviser_corrections"."payload_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "adviser_corrections" ADD CONSTRAINT "adviser_corrections_before_preview_length_check" CHECK ("adviser_corrections"."before_preview" is null or char_length("adviser_corrections"."before_preview") between 1 and 64);--> statement-breakpoint
ALTER TABLE "adviser_corrections" ADD CONSTRAINT "adviser_corrections_after_preview_length_check" CHECK ("adviser_corrections"."after_preview" is null or char_length("adviser_corrections"."after_preview") between 1 and 64);--> statement-breakpoint
ALTER TABLE "adviser_corrections" ADD CONSTRAINT "adviser_corrections_field_policy_version_check" CHECK (length(btrim("adviser_corrections"."field_policy_version")) > 0);--> statement-breakpoint
ALTER TABLE "adviser_corrections" ADD CONSTRAINT "adviser_corrections_reason_code_check" CHECK ("adviser_corrections"."reason_code" is null or "adviser_corrections"."reason_code" in ('incorrect_value', 'missing_value', 'misclassified', 'formatting', 'other'));--> statement-breakpoint
ALTER TABLE "field_extractions" ADD CONSTRAINT "field_extractions_normalized_value_preview_length_check" CHECK ("field_extractions"."normalized_value_preview" is null or char_length("field_extractions"."normalized_value_preview") between 1 and 64);--> statement-breakpoint
ALTER TABLE "field_extractions" ADD CONSTRAINT "field_extractions_extraction_status_check" CHECK ("field_extractions"."extraction_status" in ('extracted', 'corrected'));--> statement-breakpoint
ALTER TABLE "field_extractions" ADD CONSTRAINT "field_extractions_field_policy_version_check" CHECK (length(btrim("field_extractions"."field_policy_version")) > 0);
