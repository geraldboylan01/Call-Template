-- M0-M2 exposed no correction/extraction write API. Rows present before the
-- M3 deployment therefore have no field-policy provenance and must not be
-- attributed to field-policy-v1 merely because 0005 needed a safe NOT NULL
-- backfill value.
UPDATE "adviser_corrections"
SET "field_policy_version" = 'legacy-pre-policy'
WHERE "field_policy_version" = 'field-policy-v1';--> statement-breakpoint
UPDATE "field_extractions"
SET "field_policy_version" = 'legacy-pre-policy'
WHERE "field_policy_version" = 'field-policy-v1';--> statement-breakpoint
-- Every M3+ writer must record the policy version it actually used. Keeping a
-- database default would silently mislabel rows after a policy rotation.
ALTER TABLE "adviser_corrections" ALTER COLUMN "field_policy_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "field_extractions" ALTER COLUMN "field_policy_version" DROP DEFAULT;
