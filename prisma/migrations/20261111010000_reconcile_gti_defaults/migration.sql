-- Task 2: Align AthleteProfile onboarding score defaults (0.00 across all
-- component and composite columns) and perform non-destructive reconciliation
-- where authoritative measured telemetry columns differ from stale defaults.

ALTER TABLE "athlete_profiles"
  ALTER COLUMN "current_gti" SET DEFAULT 0.00,
  ALTER COLUMN "wearable_score" SET DEFAULT 0.00,
  ALTER COLUMN "match_perf_score" SET DEFAULT 0.00;

-- 1. Sync mirror columns when authoritative measured component scores (> 0) exist.
UPDATE "athlete_profiles"
SET "wearable_score" = ROUND("training_consistency_score"::numeric, 2)
WHERE "training_consistency_score" > 0
  AND "wearable_score" IS DISTINCT FROM ROUND("training_consistency_score"::numeric, 2);

UPDATE "athlete_profiles"
SET "match_perf_score" = ROUND("match_performance_score"::numeric, 2)
WHERE "match_performance_score" > 0
  AND "match_perf_score" IS DISTINCT FROM ROUND("match_performance_score"::numeric, 2);

-- 2. Reset synthetic registration default (50.00) ONLY when zero wearable/health evidence exists.
UPDATE "athlete_profiles" ap
SET "wearable_score" = 0.00
WHERE ap."wearable_score" = 50.00
  AND ap."training_consistency_score" = 0
  AND NOT EXISTS (SELECT 1 FROM "wearable_sessions" ws WHERE ws."athlete_id" = ap."user_id")
  AND NOT EXISTS (SELECT 1 FROM "health_alerts" ha WHERE ha."athlete_id" = ap."user_id");

-- 3. Reset synthetic registration default (50.00) ONLY when zero verified/passport match evidence exists.
UPDATE "athlete_profiles" ap
SET "match_perf_score" = 0.00
WHERE ap."match_perf_score" = 50.00
  AND ap."match_performance_score" = 0
  AND NOT EXISTS (
    SELECT 1 FROM "verified_match_results" vmr WHERE ap."user_id" = ANY(vmr."participant_athlete_ids")
  )
  AND NOT EXISTS (
    SELECT 1 FROM "sport_passport_records" spr WHERE spr."athlete_id" = ap."id" AND spr."total_matches" > 0
  );

-- 4. Reconcile current_gti with authoritative measured gti (> 0) where divergent.
UPDATE "athlete_profiles"
SET "current_gti" = ROUND("gti"::numeric, 2)
WHERE "gti" > 0
  AND "current_gti" IS DISTINCT FROM ROUND("gti"::numeric, 2);

