-- Rollback for 20261111030000_optimize_indexes
DROP INDEX IF EXISTS "refresh_tokens_active_expires_at_idx";
DROP INDEX IF EXISTS "health_alerts_match_id_idx";
DROP INDEX IF EXISTS "health_alerts_tournament_id_created_at_idx";
DROP INDEX IF EXISTS "matches_team_b_id_idx";
DROP INDEX IF EXISTS "matches_umpire_id_idx";
DROP INDEX IF EXISTS "team_members_team_id_idx";
DROP INDEX IF EXISTS "registrations_team_id_idx";
DROP INDEX IF EXISTS "tournaments_organizer_id_idx";
DROP INDEX IF EXISTS "free_agent_pool_fifo_idx";
DROP INDEX IF EXISTS "drill_submissions_dossier_verified_idx";
DROP INDEX IF EXISTS "athlete_profiles_scout_searchable_gti_id_idx";
DROP INDEX IF EXISTS "athlete_profiles_geo_leaderboard_idx";
DROP INDEX IF EXISTS "athlete_profiles_leaderboard_active_idx";

CREATE INDEX IF NOT EXISTS "identity_verifications_id_hash_idx"
  ON "identity_verifications"("id_hash");

