-- Rollback for 20261111010000_reconcile_gti_defaults
-- Restores original schema column defaults. Data updates made during verified
-- reconciliation should only be reverted from a point-in-time snapshot/audit log.
ALTER TABLE "athlete_profiles"
  ALTER COLUMN "current_gti" SET DEFAULT 30.00,
  ALTER COLUMN "wearable_score" SET DEFAULT 50.00,
  ALTER COLUMN "match_perf_score" SET DEFAULT 50.00;

