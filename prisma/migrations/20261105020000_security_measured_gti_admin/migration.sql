-- CreateEnum
CREATE TYPE "DrillSignatureVersion" AS ENUM ('LEGACY', 'FULL', 'FULL_V2');

-- CreateEnum
CREATE TYPE "TelemetrySource" AS ENUM ('DEVICE_HMAC', 'ATHLETE_JWT');

-- AlterEnum
ALTER TYPE "TournamentStatus" ADD VALUE 'SUSPENDED';

-- DropForeignKey
ALTER TABLE "security_audit_logs" DROP CONSTRAINT "security_audit_logs_user_id_fkey";

-- AlterTable
ALTER TABLE "tournaments" ADD COLUMN     "is_featured" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "drill_submissions" ADD COLUMN     "metadata_verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "signature_version" "DrillSignatureVersion" NOT NULL DEFAULT 'LEGACY';

-- AlterTable
ALTER TABLE "health_alerts" ADD COLUMN     "acknowledged_at" TIMESTAMPTZ,
ADD COLUMN     "acknowledged_by_id" UUID,
ADD COLUMN     "match_id" UUID,
ADD COLUMN     "source" "TelemetrySource" NOT NULL DEFAULT 'DEVICE_HMAC';

-- CreateTable
CREATE TABLE "wearable_sessions" (
    "id" UUID NOT NULL,
    "athlete_id" UUID NOT NULL,
    "session_date" DATE NOT NULL,
    "source" "TelemetrySource" NOT NULL,
    "observed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wearable_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verified_match_results" (
    "id" UUID NOT NULL,
    "bracket_id" UUID NOT NULL,
    "match_id" UUID,
    "reported_by_id" UUID NOT NULL,
    "request_key" VARCHAR(64) NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "participant_athlete_ids" UUID[],
    "winner_athlete_ids" UUID[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verified_match_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wearable_sessions_athlete_id_session_date_key" ON "wearable_sessions"("athlete_id", "session_date");

-- CreateIndex
CREATE UNIQUE INDEX "verified_match_results_match_id_key" ON "verified_match_results"("match_id");

-- CreateIndex
CREATE UNIQUE INDEX "verified_match_results_request_key_key" ON "verified_match_results"("request_key");

-- CreateIndex
CREATE INDEX "verified_match_results_bracket_id_created_at_idx" ON "verified_match_results"("bracket_id", "created_at" DESC);

CREATE INDEX "verified_match_results_participant_athlete_ids_idx" ON "verified_match_results" USING GIN ("participant_athlete_ids");

-- AddForeignKey
ALTER TABLE "health_alerts" ADD CONSTRAINT "health_alerts_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_alerts" ADD CONSTRAINT "health_alerts_acknowledged_by_id_fkey" FOREIGN KEY ("acknowledged_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wearable_sessions" ADD CONSTRAINT "wearable_sessions_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verified_match_results" ADD CONSTRAINT "verified_match_results_bracket_id_fkey" FOREIGN KEY ("bracket_id") REFERENCES "brackets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verified_match_results" ADD CONSTRAINT "verified_match_results_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verified_match_results" ADD CONSTRAINT "verified_match_results_reported_by_id_fkey" FOREIGN KEY ("reported_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Snapshot historical evidence before enabling append-only enforcement. Actor IDs are
-- historical identifiers and deliberately have no mutable/cascading foreign key.
INSERT INTO security_audit_logs (id,user_id,action,resource,resource_id,metadata,created_at)
SELECT gen_random_uuid(),user_id,'GOV_ID_RELINK_HISTORY','identity_verification',id::text,
  jsonb_build_object('attemptCount',re_linked_count,'status',status),verified_at
FROM identity_verifications WHERE re_linked_count > 0;
INSERT INTO security_audit_logs (id,user_id,action,resource,resource_id,metadata,created_at)
SELECT gen_random_uuid(),athlete_id,'DRILL_SUBMITTED','drill_submission',id::text,
  jsonb_build_object('sport',sport,'drillType',drill_type,'formScore',form_score,'signatureVersion',signature_version,'metadataVerified',metadata_verified),created_at
FROM drill_submissions;
INSERT INTO security_audit_logs (id,user_id,action,resource,resource_id,metadata,created_at)
SELECT gen_random_uuid(),athlete_id,'SAFETY_MATCH_PAUSED','health_alert',id::text,
  jsonb_build_object('tournamentId',tournament_id,'bracketId',bracket_id,'matchId',match_id,'historicalUnconfirmedContext',match_id IS NULL),created_at
FROM health_alerts WHERE match_paused AND severity='CRITICAL';
INSERT INTO security_audit_logs (id,user_id,action,resource,resource_id,metadata,created_at)
SELECT gen_random_uuid(),user_id,'TOURNAMENT_REGISTRATION','registration',id::text,
  jsonb_build_object('bracketId',bracket_id,'teamId',team_id,'status',status),registered_at FROM registrations;

CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Security audit logs are append-only'; END;
$$;
CREATE TRIGGER security_audit_immutable BEFORE UPDATE OR DELETE ON security_audit_logs
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER security_audit_no_truncate BEFORE TRUNCATE ON security_audit_logs
FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();

CREATE FUNCTION capture_integrity_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid; event_action text; event_resource text; details jsonb;
BEGIN
  IF TG_TABLE_NAME='drill_submissions' THEN
    actor:=NEW.athlete_id; event_action:='DRILL_SUBMITTED'; event_resource:='drill_submission';
    details:=jsonb_build_object('sport',NEW.sport,'drillType',NEW.drill_type,'formScore',NEW.form_score,'signatureVersion',NEW.signature_version,'metadataVerified',NEW.metadata_verified);
  ELSIF TG_TABLE_NAME='health_alerts' THEN
    IF NOT NEW.match_paused OR NEW.match_id IS NULL OR NEW.severity<>'CRITICAL' THEN RETURN NEW; END IF;
    actor:=NEW.athlete_id; event_action:='SAFETY_MATCH_PAUSED'; event_resource:='health_alert';
    details:=jsonb_build_object('tournamentId',NEW.tournament_id,'bracketId',NEW.bracket_id,'matchId',NEW.match_id);
  ELSIF TG_TABLE_NAME='identity_verifications' THEN
    IF NEW.re_linked_count<=OLD.re_linked_count THEN RETURN NEW; END IF;
    actor:=NEW.user_id; event_action:='GOV_ID_RELINK_ATTEMPT'; event_resource:='identity_verification';
    details:=jsonb_build_object('attemptCount',NEW.re_linked_count,'status',NEW.status);
  ELSIF TG_TABLE_NAME='registrations' THEN
    IF TG_OP='UPDATE' AND NEW.status=OLD.status THEN RETURN NEW; END IF;
    actor:=NEW.user_id; event_action:='TOURNAMENT_REGISTRATION'; event_resource:='registration';
    details:=jsonb_build_object('bracketId',NEW.bracket_id,'teamId',NEW.team_id,'status',NEW.status);
  ELSIF TG_TABLE_NAME='verified_match_results' THEN
    actor:=NEW.reported_by_id; event_action:='VERIFIED_MATCH_RESULT'; event_resource:='verified_match_result';
    details:=jsonb_build_object('bracketId',NEW.bracket_id,'matchId',NEW.match_id,'participants',NEW.participant_athlete_ids,'winners',NEW.winner_athlete_ids);
  END IF;
  INSERT INTO security_audit_logs (id,user_id,action,resource,resource_id,metadata)
    VALUES (gen_random_uuid(),actor,event_action,event_resource,NEW.id::text,details);
  RETURN NEW;
END;
$$;
CREATE TRIGGER drill_integrity_audit AFTER INSERT ON drill_submissions FOR EACH ROW EXECUTE FUNCTION capture_integrity_event();
CREATE TRIGGER safety_integrity_audit AFTER INSERT ON health_alerts FOR EACH ROW EXECUTE FUNCTION capture_integrity_event();
CREATE TRIGGER identity_integrity_audit AFTER UPDATE ON identity_verifications FOR EACH ROW EXECUTE FUNCTION capture_integrity_event();
CREATE TRIGGER registration_integrity_audit AFTER INSERT OR UPDATE ON registrations FOR EACH ROW EXECUTE FUNCTION capture_integrity_event();
CREATE TRIGGER match_result_integrity_audit AFTER INSERT ON verified_match_results FOR EACH ROW EXECUTE FUNCTION capture_integrity_event();

CREATE FUNCTION normalize_drill_signature() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.signature_hash:=lower(trim(NEW.signature_hash)); RETURN NEW; END;
$$;
CREATE TRIGGER drill_signature_normalization BEFORE INSERT OR UPDATE OF signature_hash ON drill_submissions
FOR EACH ROW EXECUTE FUNCTION normalize_drill_signature();
