-- Task 3: Outbox optimization, trigger narrowing, PG NOTIFY wakeup signal,
-- and partial pending/delivered outbox indexes.

CREATE OR REPLACE FUNCTION capture_delivery_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p jsonb;
  target record;
  roster jsonb;
  item uuid;
  emitted boolean := false;
  resolved_gti double precision;
BEGIN
  CASE TG_TABLE_NAME
  WHEN 'drill_submissions' THEN
    p := jsonb_build_object('athleteId', NEW.athlete_id, 'trigger', 'DRILL_SUBMISSION', 'deliveryId', 'drill-' || NEW.id);
    INSERT INTO outbox_events(id, kind, payload) VALUES (gen_random_uuid(), 'GTI', p);
    emitted := true;

  WHEN 'wearable_sessions' THEN
    INSERT INTO outbox_events(id, kind, payload)
    VALUES (
      gen_random_uuid(),
      'GTI',
      jsonb_build_object('athleteId', NEW.athlete_id, 'trigger', 'WEARABLE_SYNC', 'deliveryId', 'wearable-' || NEW.id)
    );
    emitted := true;

  WHEN 'verified_match_results' THEN
    FOREACH item IN ARRAY NEW.participant_athlete_ids LOOP
      INSERT INTO outbox_events(id, kind, payload)
      VALUES (
        gen_random_uuid(),
        'GTI',
        jsonb_build_object('athleteId', item, 'trigger', 'MATCH_COMPLETED', 'deliveryId', 'result-' || NEW.id || '-' || item)
      );
      emitted := true;
    END LOOP;

  WHEN 'free_agent_registrations' THEN
    IF NEW.status = 'QUEUED' THEN
      INSERT INTO outbox_events(id, kind, payload)
      VALUES (
        gen_random_uuid(),
        'MATCHMAKING',
        jsonb_build_object('tournamentId', NEW.tournament_id, 'bracketId', NEW.bracket_id, 'deliveryId', 'pool-' || NEW.id)
      );
      emitted := true;
    END IF;

  WHEN 'scout_alerts' THEN
    SELECT * INTO target FROM athlete_profiles WHERE user_id = NEW.athlete_id;
    INSERT INTO outbox_events(id, kind, payload)
    VALUES (
      gen_random_uuid(),
      'SCOUT',
      jsonb_build_object(
        'alertId', NEW.id,
        'athleteId', NEW.athlete_id,
        'newGti', NEW.gti_score,
        'sport', NEW.sport,
        'district', COALESCE(target.district, ''),
        'state', COALESCE(target.state, ''),
        'tierClassification', COALESCE(target.tier_classification::text, 'TIER_3')
      )
    );
    emitted := true;

  WHEN 'registrations' THEN
    IF NEW.team_id IS NOT NULL AND NEW.metadata->>'isFreeAgentFormedTeam' = 'true' THEN
      SELECT * INTO target FROM teams WHERE id = NEW.team_id;
      SELECT jsonb_agg(
        jsonb_build_object(
          'user_id', COALESCE(m.user_id, p.user_id),
          'name', COALESCE(u.email, u.phone, 'Athlete'),
          'assigned_role', m.assigned_role,
          'gti', COALESCE(NULLIF(p.gti, 0), p.current_gti, 0)
        )
        ORDER BY m.id
      )
      INTO roster
      FROM team_members m
      LEFT JOIN athlete_profiles p ON p.id = m.athlete_id
      LEFT JOIN users u ON u.id = COALESCE(m.user_id, p.user_id)
      WHERE m.team_id = NEW.team_id;
      INSERT INTO outbox_events(id, kind, payload)
      VALUES (
        gen_random_uuid(),
        'ROSTER',
        jsonb_build_object(
          'team_id', NEW.team_id,
          'team_name', COALESCE(target.name, 'Team'),
          'bracket_id', NEW.bracket_id,
          'roster', COALESCE(roster, '[]'::jsonb)
        )
      );
      emitted := true;
    END IF;

  WHEN 'health_alerts' THEN
    IF NEW.match_paused AND NEW.match_id IS NOT NULL THEN
      SELECT * INTO target FROM users WHERE id = NEW.athlete_id;
      INSERT INTO outbox_events(id, kind, payload)
      VALUES (
        gen_random_uuid(),
        'PAUSE',
        jsonb_build_object(
          'alert_id', NEW.id,
          'source', NEW.source,
          'baseline_fields', to_jsonb(NEW.baseline_fields),
          'athlete_id', NEW.athlete_id,
          'athlete_name', COALESCE(target.email, target.phone, 'Athlete'),
          'vitals', jsonb_build_object('heart_rate', NEW.heart_rate, 'spo2', NEW.spo2, 'skin_temperature', NEW.skin_temperature),
          'directive', CASE WHEN NEW.source = 'SIMULATOR' THEN 'SIMULATOR STRESS TEST: MANDATORY REST' ELSE 'MANDATORY REST: PAUSE TOURNAMENT MATCH IMMEDIATELY' END,
          'tournament_id', NEW.tournament_id,
          'bracket_id', NEW.bracket_id,
          'match_id', NEW.match_id
        )
      );
      emitted := true;
    END IF;

  WHEN 'athlete_profiles' THEN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO outbox_events(id, kind, payload)
      VALUES (
        gen_random_uuid(),
        'LEADERBOARD',
        jsonb_build_object('athleteId', NEW.user_id, 'previous', NULL)
      );
      emitted := true;
    ELSIF TG_OP = 'DELETE' THEN
      INSERT INTO outbox_events(id, kind, payload)
      VALUES (
        gen_random_uuid(),
        'LEADERBOARD',
        jsonb_build_object(
          'athleteId', OLD.user_id,
          'previous', jsonb_build_object('primarySport', OLD.primary_sport, 'state', OLD.state, 'district', OLD.district)
        )
      );
      emitted := true;
    ELSE
      IF OLD.primary_sport IS DISTINCT FROM NEW.primary_sport
         OR OLD.state IS DISTINCT FROM NEW.state
         OR OLD.district IS DISTINCT FROM NEW.district
         OR OLD.is_scout_searchable IS DISTINCT FROM NEW.is_scout_searchable
         OR OLD.gti IS DISTINCT FROM NEW.gti
         OR OLD.current_gti IS DISTINCT FROM NEW.current_gti
      THEN
        INSERT INTO outbox_events(id, kind, payload)
        VALUES (
          gen_random_uuid(),
          'LEADERBOARD',
          jsonb_build_object(
            'athleteId', NEW.user_id,
            'previous', jsonb_build_object('primarySport', OLD.primary_sport, 'state', OLD.state, 'district', OLD.district)
          )
        );
        emitted := true;
      END IF;

      IF NEW.gti IS DISTINCT FROM OLD.gti OR NEW.current_gti IS DISTINCT FROM OLD.current_gti THEN
        resolved_gti := COALESCE(NULLIF(NEW.gti, 0), NEW.current_gti, 0);
        INSERT INTO outbox_events(id, kind, payload)
        VALUES (
          gen_random_uuid(),
          'GTI_UPDATED',
          jsonb_build_object(
            'athleteId', NEW.user_id,
            'previousGti', COALESCE(NULLIF(OLD.gti, 0), OLD.current_gti, 0),
            'newGti', resolved_gti,
            'eliteBreached', resolved_gti >= 85
          )
        );
        emitted := true;
      END IF;
    END IF;

  WHEN 'users' THEN
    IF NEW.is_active IS DISTINCT FROM OLD.is_active OR NEW.role IS DISTINCT FROM OLD.role THEN
      INSERT INTO outbox_events(id, kind, payload) VALUES (gen_random_uuid(), 'LEADERBOARD', jsonb_build_object('athleteId', NEW.id));
      INSERT INTO outbox_events(id, kind, payload) VALUES (gen_random_uuid(), 'REVOKE_SOCKETS', jsonb_build_object('athleteId', NEW.id));
      emitted := true;
    END IF;

  WHEN 'identity_verifications' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      INSERT INTO outbox_events(id, kind, payload) VALUES (gen_random_uuid(), 'LEADERBOARD', jsonb_build_object('athleteId', NEW.user_id));
      INSERT INTO outbox_events(id, kind, payload) VALUES (gen_random_uuid(), 'REVOKE_SOCKETS', jsonb_build_object('athleteId', NEW.user_id));
      emitted := true;
    END IF;
  END CASE;

  IF emitted THEN
    PERFORM pg_notify('kheleo_outbox_wakeup', TG_TABLE_NAME);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Narrow noisy triggers so non-ranking profile edits and unrelated user updates never enqueue outbox work
DROP TRIGGER IF EXISTS profile_delivery ON athlete_profiles;
DROP TRIGGER IF EXISTS profile_delivery_insert ON athlete_profiles;
DROP TRIGGER IF EXISTS profile_delivery_delete ON athlete_profiles;
DROP TRIGGER IF EXISTS profile_delivery_update ON athlete_profiles;

CREATE TRIGGER profile_delivery_insert
  AFTER INSERT ON athlete_profiles
  FOR EACH ROW EXECUTE FUNCTION capture_delivery_intent();

CREATE TRIGGER profile_delivery_delete
  AFTER DELETE ON athlete_profiles
  FOR EACH ROW EXECUTE FUNCTION capture_delivery_intent();

CREATE TRIGGER profile_delivery_update
  AFTER UPDATE OF primary_sport, state, district, is_scout_searchable, gti, current_gti
  ON athlete_profiles
  FOR EACH ROW
  WHEN (
    OLD.primary_sport IS DISTINCT FROM NEW.primary_sport
    OR OLD.state IS DISTINCT FROM NEW.state
    OR OLD.district IS DISTINCT FROM NEW.district
    OR OLD.is_scout_searchable IS DISTINCT FROM NEW.is_scout_searchable
    OR OLD.gti IS DISTINCT FROM NEW.gti
    OR OLD.current_gti IS DISTINCT FROM NEW.current_gti
  )
  EXECUTE FUNCTION capture_delivery_intent();

DROP TRIGGER IF EXISTS user_access_delivery ON users;
CREATE TRIGGER user_access_delivery
  AFTER UPDATE OF is_active, role ON users
  FOR EACH ROW
  WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active OR OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION capture_delivery_intent();

DROP TRIGGER IF EXISTS identity_access_delivery ON identity_verifications;
CREATE TRIGGER identity_access_delivery
  AFTER UPDATE OF status ON identity_verifications
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION capture_delivery_intent();

-- Partial indexes keep pending poll queries O(log(pending)) and cleanup queries fast
CREATE INDEX IF NOT EXISTS "outbox_events_pending_dispatch_idx"
  ON "outbox_events" ("available_at", "created_at", "id")
  WHERE "delivered_at" IS NULL;

CREATE INDEX IF NOT EXISTS "outbox_events_delivered_cleanup_idx"
  ON "outbox_events" ("delivered_at")
  WHERE "delivered_at" IS NOT NULL;
