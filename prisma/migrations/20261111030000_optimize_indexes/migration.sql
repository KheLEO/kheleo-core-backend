-- Task 6: Drop duplicate B-tree index on unique identity_verifications.id_hash
-- and add targeted partial/expression/FK indexes for hot queries.

DROP INDEX IF EXISTS "identity_verifications_id_hash_idx";

-- Leaderboard & scout feed expression/partial covering indexes
CREATE INDEX IF NOT EXISTS "athlete_profiles_leaderboard_active_idx"
  ON "athlete_profiles" (
    "primary_sport",
    (COALESCE(NULLIF("gti", 0), "current_gti", 0)) DESC,
    "user_id" DESC
  )
  WHERE "primary_sport" IS NOT NULL AND "is_scout_searchable" = true;

CREATE INDEX IF NOT EXISTS "athlete_profiles_geo_leaderboard_idx"
  ON "athlete_profiles" (
    lower("state"),
    lower("district"),
    "primary_sport",
    (COALESCE(NULLIF("gti", 0), "current_gti", 0)) DESC
  )
  WHERE "primary_sport" IS NOT NULL AND "is_scout_searchable" = true;

CREATE INDEX IF NOT EXISTS "athlete_profiles_scout_searchable_gti_id_idx"
  ON "athlete_profiles" ("primary_sport", "current_gti" DESC, "id" ASC)
  WHERE "is_scout_searchable" = true;

-- Verified drill lookup inside scout dossiers
CREATE INDEX IF NOT EXISTS "drill_submissions_dossier_verified_idx"
  ON "drill_submissions" ("athlete_id", "created_at" DESC, "id" DESC)
  WHERE "metadata_verified" = true;

-- FIFO matchmaking pool claim
CREATE INDEX IF NOT EXISTS "free_agent_pool_fifo_idx"
  ON "free_agent_registrations" ("bracket_id", "joined_at" ASC, "id" ASC)
  WHERE "status" = 'QUEUED';

-- Missing FK & lookup indexes
CREATE INDEX IF NOT EXISTS "tournaments_organizer_id_idx"
  ON "tournaments" ("organizer_id", "id");

CREATE INDEX IF NOT EXISTS "registrations_team_id_idx"
  ON "registrations" ("team_id")
  WHERE "team_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "team_members_team_id_idx"
  ON "team_members" ("team_id", "id");

CREATE INDEX IF NOT EXISTS "matches_umpire_id_idx"
  ON "matches" ("umpire_id")
  WHERE "umpire_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "matches_team_b_id_idx"
  ON "matches" ("team_b_id")
  WHERE "team_b_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "health_alerts_tournament_id_created_at_idx"
  ON "health_alerts" ("tournament_id", "created_at" DESC)
  WHERE "tournament_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "health_alerts_match_id_idx"
  ON "health_alerts" ("match_id")
  WHERE "match_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "refresh_tokens_active_expires_at_idx"
  ON "refresh_tokens" ("expires_at")
  WHERE "revoked" = false;

