-- The current baseline leads table already includes consent_education_only.
-- Keep this migration name as a no-op so fresh local databases can replay the
-- migration history without trying to add the column twice.
SELECT 1;
