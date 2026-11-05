-- DropForeignKey
ALTER TABLE "identity_verifications" DROP CONSTRAINT "identity_verifications_user_id_fkey";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_recovery_blocked" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ,
    "locked_by" UUID,
    "delivered_at" TIMESTAMPTZ,
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_events_delivered_at_available_at_idx" ON "outbox_events"("delivered_at", "available_at");

-- AddForeignKey
ALTER TABLE "identity_verifications" ADD CONSTRAINT "identity_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Durable delivery intents share the source transaction; consumers may deliver at least once.
CREATE FUNCTION capture_delivery_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p jsonb; target record; roster jsonb; item uuid;
BEGIN
  CASE TG_TABLE_NAME
  WHEN 'drill_submissions' THEN
    p:=jsonb_build_object('athleteId',NEW.athlete_id,'trigger','DRILL_SUBMISSION','deliveryId','drill-'||NEW.id);
    INSERT INTO outbox_events(id,kind,payload) VALUES(gen_random_uuid(),'GTI',p);
  WHEN 'wearable_sessions' THEN
    INSERT INTO outbox_events(id,kind,payload) VALUES(gen_random_uuid(),'GTI',jsonb_build_object('athleteId',NEW.athlete_id,'trigger','WEARABLE_SYNC','deliveryId','wearable-'||NEW.id));
  WHEN 'verified_match_results' THEN
    FOREACH item IN ARRAY NEW.participant_athlete_ids LOOP
      INSERT INTO outbox_events(id,kind,payload) VALUES(gen_random_uuid(),'GTI',jsonb_build_object('athleteId',item,'trigger','MATCH_COMPLETED','deliveryId','result-'||NEW.id||'-'||item));
    END LOOP;
  WHEN 'free_agent_registrations' THEN
    IF NEW.status='QUEUED' THEN
      INSERT INTO outbox_events(id,kind,payload) VALUES(gen_random_uuid(),'MATCHMAKING',jsonb_build_object('tournamentId',NEW.tournament_id,'bracketId',NEW.bracket_id,'deliveryId','pool-'||NEW.id));
    END IF;
  WHEN 'scout_alerts' THEN
    SELECT * INTO target FROM athlete_profiles WHERE user_id=NEW.athlete_id;
    INSERT INTO outbox_events(id,kind,payload) VALUES(gen_random_uuid(),'SCOUT',jsonb_build_object('alertId',NEW.id,'athleteId',NEW.athlete_id,'newGti',NEW.gti_score,'sport',NEW.sport,'district',target.district,'state',target.state,'tierClassification',target.tier_classification));
  WHEN 'registrations' THEN
    IF NEW.team_id IS NOT NULL AND NEW.metadata->>'isFreeAgentFormedTeam'='true' THEN
      SELECT * INTO target FROM teams WHERE id=NEW.team_id;
      SELECT jsonb_agg(jsonb_build_object('user_id',COALESCE(m.user_id,p.user_id),'name',COALESCE(u.email,u.phone,'Athlete'),'assigned_role',m.assigned_role,'gti',COALESCE(NULLIF(p.gti,0),p.current_gti,0)) ORDER BY m.id)
      INTO roster FROM team_members m LEFT JOIN athlete_profiles p ON p.id=m.athlete_id LEFT JOIN users u ON u.id=COALESCE(m.user_id,p.user_id) WHERE m.team_id=NEW.team_id;
      INSERT INTO outbox_events(id,kind,payload) VALUES(gen_random_uuid(),'ROSTER',jsonb_build_object('team_id',NEW.team_id,'team_name',target.name,'bracket_id',NEW.bracket_id,'roster',COALESCE(roster,'[]'::jsonb)));
    END IF;
  WHEN 'health_alerts' THEN
    IF NEW.match_paused AND NEW.match_id IS NOT NULL THEN
      SELECT * INTO target FROM users WHERE id=NEW.athlete_id;
      INSERT INTO outbox_events(id,kind,payload) VALUES(gen_random_uuid(),'PAUSE',jsonb_build_object('athlete_id',NEW.athlete_id,'athlete_name',COALESCE(target.email,target.phone,'Athlete'),'vitals',jsonb_build_object('heart_rate',NEW.heart_rate,'spo2',NEW.spo2,'skin_temperature',NEW.skin_temperature),'directive','MANDATORY REST: PAUSE TOURNAMENT MATCH IMMEDIATELY','tournament_id',NEW.tournament_id,'bracket_id',NEW.bracket_id,'match_id',NEW.match_id));
    END IF;
  WHEN 'athlete_profiles' THEN
    INSERT INTO outbox_events(id,kind,payload) VALUES(gen_random_uuid(),'LEADERBOARD',jsonb_build_object('athleteId',COALESCE(NEW.user_id,OLD.user_id),'previous',jsonb_build_object('primarySport',OLD.primary_sport,'state',OLD.state,'district',OLD.district)));
    IF TG_OP='UPDATE' AND (NEW.gti IS DISTINCT FROM OLD.gti OR NEW.current_gti IS DISTINCT FROM OLD.current_gti) THEN
      INSERT INTO outbox_events(id,kind,payload) VALUES(gen_random_uuid(),'GTI_UPDATED',jsonb_build_object('athleteId',NEW.user_id,'previousGti',COALESCE(NULLIF(OLD.gti,0),OLD.current_gti),'newGti',NEW.gti,'eliteBreached',NEW.gti>=85));
    END IF;
  WHEN 'users' THEN
    IF NEW.is_active IS DISTINCT FROM OLD.is_active OR NEW.role IS DISTINCT FROM OLD.role THEN
      INSERT INTO outbox_events(id,kind,payload) VALUES(gen_random_uuid(),'LEADERBOARD',jsonb_build_object('athleteId',NEW.id));
      INSERT INTO outbox_events(id,kind,payload) VALUES(gen_random_uuid(),'REVOKE_SOCKETS',jsonb_build_object('athleteId',NEW.id));
    END IF;
  WHEN 'identity_verifications' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      INSERT INTO outbox_events(id,kind,payload) VALUES(gen_random_uuid(),'LEADERBOARD',jsonb_build_object('athleteId',NEW.user_id));
      INSERT INTO outbox_events(id,kind,payload) VALUES(gen_random_uuid(),'REVOKE_SOCKETS',jsonb_build_object('athleteId',NEW.user_id));
    END IF;
  END CASE;
  RETURN COALESCE(NEW,OLD);
END;
$$;
CREATE TRIGGER drill_delivery AFTER INSERT ON drill_submissions FOR EACH ROW EXECUTE FUNCTION capture_delivery_intent();
CREATE TRIGGER wearable_delivery AFTER INSERT ON wearable_sessions FOR EACH ROW EXECUTE FUNCTION capture_delivery_intent();
CREATE TRIGGER result_delivery AFTER INSERT ON verified_match_results FOR EACH ROW EXECUTE FUNCTION capture_delivery_intent();
CREATE TRIGGER pool_delivery AFTER INSERT ON free_agent_registrations FOR EACH ROW EXECUTE FUNCTION capture_delivery_intent();
CREATE TRIGGER scout_delivery AFTER INSERT ON scout_alerts FOR EACH ROW EXECUTE FUNCTION capture_delivery_intent();
CREATE TRIGGER roster_delivery AFTER INSERT ON registrations FOR EACH ROW EXECUTE FUNCTION capture_delivery_intent();
CREATE TRIGGER pause_delivery AFTER INSERT ON health_alerts FOR EACH ROW EXECUTE FUNCTION capture_delivery_intent();
CREATE TRIGGER profile_delivery AFTER INSERT OR UPDATE OR DELETE ON athlete_profiles FOR EACH ROW EXECUTE FUNCTION capture_delivery_intent();
CREATE TRIGGER user_access_delivery AFTER UPDATE ON users FOR EACH ROW EXECUTE FUNCTION capture_delivery_intent();
CREATE TRIGGER identity_access_delivery AFTER UPDATE ON identity_verifications FOR EACH ROW EXECUTE FUNCTION capture_delivery_intent();

-- Supabase browser roles must not bypass the backend's authorization via the Data API.
DO $$ DECLARE target text; actor text; BEGIN
  FOR target IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=ANY(ARRAY['users','refresh_tokens','identity_verifications','athlete_profiles','sport_passport_records','tournaments','brackets','registrations','teams','team_members','free_agent_registrations','free_agent_pools','matches','drill_submissions','health_alerts','scout_alerts','gti_histories','scout_dossiers','idempotency_records','security_audit_logs','wearable_sessions','verified_match_results','outbox_events']) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',target);
    FOREACH actor IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=actor) THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I',target,actor); END IF;
    END LOOP;
  END LOOP;
END $$;
