BEGIN;
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS postgis;

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ATHLETE', 'SCOUT', 'UMPIRE', 'ORGANIZER', 'FEDERATION_ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "GovIdType" AS ENUM ('AADHAAR', 'VOTER_ID', 'PASSPORT', 'DRIVING_LICENSE', 'BIRTH_CERTIFICATE');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'FLAGGED_DUPLICATE', 'REVOKED');

-- CreateEnum
CREATE TYPE "SportType" AS ENUM ('CRICKET', 'FOOTBALL', 'BADMINTON', 'ATHLETICS', 'BASKETBALL', 'KABADDI');

-- CreateEnum
CREATE TYPE "TierClassification" AS ENUM ('RURAL', 'TIER_3', 'TIER_2', 'TIER_1', 'METRO');

-- CreateEnum
CREATE TYPE "TournamentStatus" AS ENUM ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BracketType" AS ENUM ('SINGLE_ELIMINATION', 'DOUBLE_ELIMINATION', 'ROUND_ROBIN', 'SWISS');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('SCHEDULED', 'WARMUP', 'LIVE', 'PAUSED_SAFETY', 'COMPLETED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "FreeAgentStatus" AS ENUM ('QUEUED', 'MATCHING', 'MATCHED', 'CANCELLED', 'EVALUATING', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "DrillVerificationStatus" AS ENUM ('VALID', 'INVALID_SIGNATURE', 'ANOMALOUS_METRICS', 'REJECTED_OUT_OF_BOUNDS');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('NORMAL', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'REJECTED_SANDBAGGING');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(20),
    "email" VARCHAR(255),
    "role" "UserRole" NOT NULL DEFAULT 'ATHLETE',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "family" VARCHAR(64) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_verifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "id_hash" VARCHAR(64) NOT NULL,
    "id_type" "GovIdType" NOT NULL,
    "salt_version" INTEGER NOT NULL DEFAULT 1,
    "status" "VerificationStatus" NOT NULL DEFAULT 'VERIFIED',
    "re_linked_count" INTEGER NOT NULL DEFAULT 0,
    "historical_user_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "verified_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "identity_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "athlete_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "gender" VARCHAR(16) NOT NULL,
    "primary_sport" "SportType" NOT NULL,
    "secondary_sports" "SportType"[] DEFAULT ARRAY[]::"SportType"[],
    "district" VARCHAR(100) NOT NULL,
    "state" VARCHAR(100) NOT NULL,
    "tier_classification" "TierClassification" NOT NULL DEFAULT 'RURAL',
    "height_cm" DECIMAL(5,2),
    "weight_kg" DECIMAL(5,2),
    "dominant_side" VARCHAR(16),
    "location" geometry(Point, 4326),
    "location_lat" DOUBLE PRECISION,
    "location_lng" DOUBLE PRECISION,
    "current_gti" DECIMAL(5,2) NOT NULL DEFAULT 30.00,
    "gti" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "biomechanical_score" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "training_consistency_score" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "match_performance_score" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "is_rural_or_underrepresented" BOOLEAN NOT NULL DEFAULT false,
    "posture_points" INTEGER NOT NULL DEFAULT 0,
    "wearable_score" DECIMAL(5,2) NOT NULL DEFAULT 50.00,
    "match_perf_score" DECIMAL(5,2) NOT NULL DEFAULT 50.00,
    "is_scout_searchable" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "athlete_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sport_passport_records" (
    "id" UUID NOT NULL,
    "athlete_id" UUID NOT NULL,
    "sport" "SportType" NOT NULL,
    "primary_role" VARCHAR(50) NOT NULL,
    "secondary_roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "total_matches" INTEGER NOT NULL DEFAULT 0,
    "win_count" INTEGER NOT NULL DEFAULT 0,
    "win_streak" INTEGER NOT NULL DEFAULT 0,
    "verified_metrics" JSONB NOT NULL DEFAULT '{}',
    "earned_badges" JSONB NOT NULL DEFAULT '[]',
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sport_passport_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournaments" (
    "id" UUID NOT NULL,
    "organizer_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL DEFAULT '',
    "title" VARCHAR(255) NOT NULL,
    "sport" "SportType" NOT NULL,
    "status" "TournamentStatus" NOT NULL DEFAULT 'DRAFT',
    "min_gti" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    "max_gti" DECIMAL(5,2) NOT NULL DEFAULT 100.00,
    "max_teams" INTEGER NOT NULL,
    "team_size" INTEGER NOT NULL,
    "prize_pool" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "venue_name" VARCHAR(255) NOT NULL,
    "venue_lat" DOUBLE PRECISION NOT NULL,
    "venue_lng" DOUBLE PRECISION NOT NULL,
    "location" geometry(Point, 4326),
    "registration_deadline" TIMESTAMPTZ NOT NULL,
    "start_date" TIMESTAMPTZ NOT NULL,
    "end_date" TIMESTAMPTZ NOT NULL,
    "rules_config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tournaments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brackets" (
    "id" UUID NOT NULL,
    "tournament_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "tier_name" VARCHAR(100) NOT NULL DEFAULT 'OPEN',
    "min_gti" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    "max_gti" DECIMAL(5,2) NOT NULL DEFAULT 100.00,
    "entry_fee" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "max_teams" INTEGER NOT NULL DEFAULT 16,
    "bracket_type" "BracketType" NOT NULL DEFAULT 'SINGLE_ELIMINATION',
    "round_order" INTEGER NOT NULL DEFAULT 1,
    "config" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "brackets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registrations" (
    "id" UUID NOT NULL,
    "bracket_id" UUID NOT NULL,
    "user_id" UUID,
    "team_id" UUID,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'CONFIRMED',
    "fee_paid" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "registered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "tournament_id" UUID NOT NULL,
    "bracket_id" UUID,
    "name" VARCHAR(100) NOT NULL,
    "captain_id" UUID,
    "is_free_agent_team" BOOLEAN NOT NULL DEFAULT false,
    "is_free_agent_formed" BOOLEAN NOT NULL DEFAULT false,
    "composite_gti" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    "average_gti" DOUBLE PRECISION NOT NULL DEFAULT 0.00,
    "registration_date" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "athlete_id" UUID,
    "user_id" UUID,
    "role" VARCHAR(50),
    "assigned_role" VARCHAR(50) NOT NULL DEFAULT 'MEMBER',
    "is_captain" BOOLEAN NOT NULL DEFAULT false,
    "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "free_agent_registrations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tournament_id" UUID NOT NULL,
    "bracket_id" UUID NOT NULL,
    "sport" VARCHAR(50) NOT NULL,
    "primary_role" VARCHAR(50) NOT NULL,
    "secondary_role" VARCHAR(50),
    "status" "FreeAgentStatus" NOT NULL DEFAULT 'QUEUED',
    "matched_team_id" UUID,
    "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "free_agent_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "free_agent_pools" (
    "id" UUID NOT NULL,
    "tournament_id" UUID NOT NULL,
    "athlete_id" UUID NOT NULL,
    "sport" "SportType" NOT NULL,
    "preferred_role" VARCHAR(50) NOT NULL,
    "secondary_roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "athlete_gti" DECIMAL(5,2) NOT NULL,
    "status" "FreeAgentStatus" NOT NULL DEFAULT 'QUEUED',
    "queued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "matched_at" TIMESTAMPTZ,
    "matched_team_id" UUID,

    CONSTRAINT "free_agent_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" UUID NOT NULL,
    "bracket_id" UUID NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "match_number" INTEGER NOT NULL,
    "team_a_id" UUID NOT NULL,
    "team_b_id" UUID NOT NULL,
    "umpire_id" UUID,
    "scheduled_start" TIMESTAMPTZ NOT NULL,
    "status" "MatchStatus" NOT NULL DEFAULT 'SCHEDULED',
    "winner_team_id" UUID,
    "score_summary" JSONB NOT NULL DEFAULT '{}',
    "pause_reason" VARCHAR(255),
    "paused_at" TIMESTAMPTZ,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drill_submissions" (
    "id" UUID NOT NULL,
    "athlete_id" UUID NOT NULL,
    "sport" VARCHAR(50) NOT NULL,
    "drill_type" VARCHAR(64) NOT NULL,
    "form_score" DOUBLE PRECISION NOT NULL,
    "frames_analyzed" INTEGER NOT NULL,
    "flaw_flags" JSONB NOT NULL,
    "joint_angles_summary" JSONB NOT NULL,
    "signature_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drill_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_alerts" (
    "id" UUID NOT NULL,
    "athlete_id" UUID NOT NULL,
    "tournament_id" UUID,
    "bracket_id" UUID,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'NORMAL',
    "heart_rate" DOUBLE PRECISION NOT NULL,
    "spo2" DOUBLE PRECISION NOT NULL,
    "skin_temperature" DOUBLE PRECISION NOT NULL,
    "trigger_reason" TEXT NOT NULL,
    "match_paused" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scout_alerts" (
    "id" UUID NOT NULL,
    "athlete_id" UUID NOT NULL,
    "gti_score" DOUBLE PRECISION NOT NULL,
    "district" VARCHAR(100) NOT NULL,
    "sport" VARCHAR(50) NOT NULL,
    "is_acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scout_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gti_histories" (
    "id" UUID NOT NULL,
    "athlete_id" UUID NOT NULL,
    "biomechanical_score" DECIMAL(5,2) NOT NULL,
    "wearable_score" DECIMAL(5,2) NOT NULL,
    "match_score" DECIMAL(5,2) NOT NULL,
    "composite_gti" DECIMAL(5,2) NOT NULL,
    "calculation_factors" JSONB NOT NULL,
    "calculated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gti_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scout_dossiers" (
    "id" UUID NOT NULL,
    "athlete_id" UUID NOT NULL,
    "scout_id" UUID NOT NULL,
    "scout_notes" TEXT NOT NULL,
    "federation_tag" VARCHAR(100),
    "is_shortlisted" BOOLEAN NOT NULL DEFAULT false,
    "pipeline_status" VARCHAR(50) NOT NULL DEFAULT 'DISCOVERED',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "scout_dossiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "user_id" UUID,
    "route" VARCHAR(255) NOT NULL,
    "response_code" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "resource" VARCHAR(100),
    "resource_id" VARCHAR(255),
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_is_active_idx" ON "users"("role", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens"("family");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_revoked_idx" ON "refresh_tokens"("user_id", "revoked");

-- CreateIndex
CREATE UNIQUE INDEX "identity_verifications_user_id_key" ON "identity_verifications"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "identity_verifications_id_hash_key" ON "identity_verifications"("id_hash");

-- CreateIndex
CREATE INDEX "identity_verifications_id_hash_idx" ON "identity_verifications"("id_hash");

-- CreateIndex
CREATE INDEX "identity_verifications_status_idx" ON "identity_verifications"("status");

-- CreateIndex
CREATE UNIQUE INDEX "athlete_profiles_user_id_key" ON "athlete_profiles"("user_id");

-- CreateIndex
CREATE INDEX "athlete_profiles_current_gti_idx" ON "athlete_profiles"("current_gti" DESC);

-- CreateIndex
CREATE INDEX "athlete_profiles_primary_sport_current_gti_idx" ON "athlete_profiles"("primary_sport", "current_gti" DESC);

-- CreateIndex
CREATE INDEX "athlete_profiles_district_state_idx" ON "athlete_profiles"("district", "state");

-- CreateIndex
CREATE INDEX "athlete_profiles_tier_classification_current_gti_idx" ON "athlete_profiles"("tier_classification", "current_gti" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS idx_athlete_profiles_location_gist ON athlete_profiles USING GIST (location);

-- CreateIndex
CREATE INDEX "sport_passport_records_sport_primary_role_idx" ON "sport_passport_records"("sport", "primary_role");

-- CreateIndex
CREATE UNIQUE INDEX "sport_passport_records_athlete_id_sport_key" ON "sport_passport_records"("athlete_id", "sport");

-- CreateIndex
CREATE INDEX "tournaments_sport_status_idx" ON "tournaments"("sport", "status");

-- CreateIndex
CREATE INDEX "tournaments_min_gti_max_gti_idx" ON "tournaments"("min_gti", "max_gti");

-- CreateIndex
CREATE INDEX "tournaments_registration_deadline_idx" ON "tournaments"("registration_deadline");

-- CreateIndex
CREATE INDEX IF NOT EXISTS idx_tournaments_location_gist ON tournaments USING GIST (location);

-- CreateIndex
CREATE INDEX "brackets_tournament_id_round_order_idx" ON "brackets"("tournament_id", "round_order");

-- CreateIndex
CREATE INDEX "registrations_bracket_id_status_idx" ON "registrations"("bracket_id", "status");

-- CreateIndex
CREATE INDEX "registrations_user_id_idx" ON "registrations"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_bracket_id_user_id_key" ON "registrations"("bracket_id", "user_id");

-- CreateIndex
CREATE INDEX "teams_tournament_id_is_free_agent_team_idx" ON "teams"("tournament_id", "is_free_agent_team");

-- CreateIndex
CREATE INDEX "teams_bracket_id_idx" ON "teams"("bracket_id");

-- CreateIndex
CREATE INDEX "team_members_athlete_id_idx" ON "team_members"("athlete_id");

-- CreateIndex
CREATE INDEX "team_members_user_id_idx" ON "team_members"("user_id");

-- CreateIndex
CREATE INDEX "free_agent_registrations_bracket_id_status_primary_role_idx" ON "free_agent_registrations"("bracket_id", "status", "primary_role");

-- CreateIndex
CREATE INDEX "free_agent_registrations_tournament_id_status_idx" ON "free_agent_registrations"("tournament_id", "status");

-- CreateIndex
CREATE INDEX "free_agent_registrations_user_id_status_idx" ON "free_agent_registrations"("user_id", "status");

-- CreateIndex
CREATE INDEX "free_agent_pools_tournament_id_status_preferred_role_idx" ON "free_agent_pools"("tournament_id", "status", "preferred_role");

-- CreateIndex
CREATE UNIQUE INDEX "free_agent_pools_tournament_id_athlete_id_key" ON "free_agent_pools"("tournament_id", "athlete_id");

-- CreateIndex
CREATE INDEX "matches_bracket_id_status_idx" ON "matches"("bracket_id", "status");

-- CreateIndex
CREATE INDEX "matches_team_a_id_team_b_id_idx" ON "matches"("team_a_id", "team_b_id");

-- CreateIndex
CREATE UNIQUE INDEX "drill_submissions_signature_hash_key" ON "drill_submissions"("signature_hash");

-- CreateIndex
CREATE INDEX "drill_submissions_athlete_id_created_at_idx" ON "drill_submissions"("athlete_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "drill_submissions_sport_drill_type_form_score_idx" ON "drill_submissions"("sport", "drill_type", "form_score" DESC);

-- CreateIndex
CREATE INDEX "health_alerts_athlete_id_created_at_idx" ON "health_alerts"("athlete_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "health_alerts_severity_match_paused_idx" ON "health_alerts"("severity", "match_paused");

-- CreateIndex
CREATE INDEX "scout_alerts_athlete_id_is_acknowledged_idx" ON "scout_alerts"("athlete_id", "is_acknowledged");

-- CreateIndex
CREATE INDEX "scout_alerts_sport_district_idx" ON "scout_alerts"("sport", "district");

-- CreateIndex
CREATE INDEX "gti_histories_athlete_id_calculated_at_idx" ON "gti_histories"("athlete_id", "calculated_at" DESC);

-- CreateIndex
CREATE INDEX "scout_dossiers_scout_id_pipeline_status_idx" ON "scout_dossiers"("scout_id", "pipeline_status");

-- CreateIndex
CREATE UNIQUE INDEX "scout_dossiers_athlete_id_scout_id_key" ON "scout_dossiers"("athlete_id", "scout_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_key_key" ON "idempotency_records"("key");

-- CreateIndex
CREATE INDEX "idempotency_records_key_expires_at_idx" ON "idempotency_records"("key", "expires_at");

-- CreateIndex
CREATE INDEX "security_audit_logs_user_id_created_at_idx" ON "security_audit_logs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "security_audit_logs_action_created_at_idx" ON "security_audit_logs"("action", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_verifications" ADD CONSTRAINT "identity_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "athlete_profiles" ADD CONSTRAINT "athlete_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sport_passport_records" ADD CONSTRAINT "sport_passport_records_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "athlete_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_organizer_id_fkey" FOREIGN KEY ("organizer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brackets" ADD CONSTRAINT "brackets_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_bracket_id_fkey" FOREIGN KEY ("bracket_id") REFERENCES "brackets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_bracket_id_fkey" FOREIGN KEY ("bracket_id") REFERENCES "brackets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_captain_id_fkey" FOREIGN KEY ("captain_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "athlete_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "free_agent_registrations" ADD CONSTRAINT "free_agent_registrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "free_agent_registrations" ADD CONSTRAINT "free_agent_registrations_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "free_agent_registrations" ADD CONSTRAINT "free_agent_registrations_bracket_id_fkey" FOREIGN KEY ("bracket_id") REFERENCES "brackets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "free_agent_registrations" ADD CONSTRAINT "free_agent_registrations_matched_team_id_fkey" FOREIGN KEY ("matched_team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "free_agent_pools" ADD CONSTRAINT "free_agent_pools_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "free_agent_pools" ADD CONSTRAINT "free_agent_pools_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "athlete_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "free_agent_pools" ADD CONSTRAINT "free_agent_pools_matched_team_id_fkey" FOREIGN KEY ("matched_team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_bracket_id_fkey" FOREIGN KEY ("bracket_id") REFERENCES "brackets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_team_a_id_fkey" FOREIGN KEY ("team_a_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_team_b_id_fkey" FOREIGN KEY ("team_b_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_umpire_id_fkey" FOREIGN KEY ("umpire_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_winner_team_id_fkey" FOREIGN KEY ("winner_team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drill_submissions" ADD CONSTRAINT "drill_submissions_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_alerts" ADD CONSTRAINT "health_alerts_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_alerts" ADD CONSTRAINT "health_alerts_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_alerts" ADD CONSTRAINT "health_alerts_bracket_id_fkey" FOREIGN KEY ("bracket_id") REFERENCES "brackets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scout_alerts" ADD CONSTRAINT "scout_alerts_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gti_histories" ADD CONSTRAINT "gti_histories_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "athlete_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scout_dossiers" ADD CONSTRAINT "scout_dossiers_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "athlete_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scout_dossiers" ADD CONSTRAINT "scout_dossiers_scout_id_fkey" FOREIGN KEY ("scout_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_audit_logs" ADD CONSTRAINT "security_audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Meter-based tournament searches cast geometry to geography.
CREATE INDEX IF NOT EXISTS idx_tournaments_location_geography_gist
ON tournaments USING GIST ((location::geography));

CREATE FUNCTION sync_tournament_location_geom() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.venue_lat IS NOT NULL AND NEW.venue_lng IS NOT NULL THEN
        NEW.location := ST_SetSRID(ST_MakePoint(NEW.venue_lng, NEW.venue_lat), 4326);
    ELSE
        NEW.location := NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tournaments_sync_location_geom
BEFORE INSERT OR UPDATE OF venue_lat, venue_lng ON tournaments
FOR EACH ROW EXECUTE FUNCTION sync_tournament_location_geom();

CREATE FUNCTION sync_athlete_location_geom() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.location_lat IS NOT NULL AND NEW.location_lng IS NOT NULL THEN
        NEW.location := ST_SetSRID(ST_MakePoint(NEW.location_lng, NEW.location_lat), 4326);
    ELSE
        NEW.location := NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER athlete_profiles_sync_location_geom
BEFORE INSERT OR UPDATE OF location_lat, location_lng ON athlete_profiles
FOR EACH ROW EXECUTE FUNCTION sync_athlete_location_geom();

COMMIT;
