-- Keep original measurements intact. Apply the watch cap at calculation/read time,
-- including existing accounts and hardware evidence that has expired.
ALTER TABLE wearable_sessions ADD COLUMN hardware_observed_at timestamptz;
UPDATE wearable_sessions SET hardware_observed_at=observed_at
  WHERE source IN ('BLE','DEVICE_HMAC') AND readings_count>simulator_readings;
CREATE INDEX IF NOT EXISTS wearable_sessions_watch_evidence_idx
  ON wearable_sessions (athlete_id, hardware_observed_at DESC)
  WHERE hardware_observed_at IS NOT NULL;

CREATE VIEW athlete_score_policy AS
WITH evidence AS (
  SELECT p.*,
    (SELECT MAX(w.hardware_observed_at) FROM wearable_sessions w
      WHERE w.athlete_id=p.user_id AND w.hardware_observed_at<=CURRENT_TIMESTAMP) AS latest_hardware_at,
    EXISTS (SELECT 1 FROM wearable_sessions w WHERE w.athlete_id=p.user_id
      AND w.hardware_observed_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
      AND w.hardware_observed_at <= CURRENT_TIMESTAMP) AS watch_qualified,
    EXISTS (SELECT 1 FROM drill_submissions d WHERE d.athlete_id=p.user_id)
      OR COALESCE(p.biomechanical_score,0)>0 AS has_drill,
    EXISTS (SELECT 1 FROM wearable_sessions w WHERE w.athlete_id=p.user_id AND w.readings_count>0)
      OR COALESCE(p.training_consistency_score,0)>0 AS has_wearable,
    EXISTS (SELECT 1 FROM verified_match_results v
      JOIN brackets b ON b.id=v.bracket_id JOIN tournaments t ON t.id=b.tournament_id
      WHERE p.user_id=ANY(v.participant_athlete_ids) AND (p.primary_sport IS NULL OR t.sport=p.primary_sport))
      OR EXISTS (SELECT 1 FROM sport_passport_records r WHERE r.athlete_id=p.id
        AND r.total_matches>0 AND (p.primary_sport IS NULL OR r.sport=p.primary_sport))
      OR (COALESCE(p.match_performance_score,0)>0 AND p.match_performance_score<>50) AS has_match
  FROM athlete_profiles p
), weighted AS (
  SELECT e.*,
    LEAST(GREATEST(COALESCE(biomechanical_score,0),0),CASE WHEN watch_qualified THEN 100 ELSE 35 END)::float8 AS effective_biomechanical_score,
    (CASE WHEN has_drill THEN 0.35 ELSE 0 END + CASE WHEN has_wearable THEN 0.25 ELSE 0 END
      + CASE WHEN has_match THEN 0.40 ELSE 0 END)::numeric AS active_weight,
    CASE WHEN NOT has_drill AND NOT has_wearable AND NOT has_match
      THEN 'ONBOARDING_BASELINE' ELSE 'WEIGHTED' END AS calculation_mode
  FROM evidence e
)
SELECT w.*,
  CASE WHEN calculation_mode='ONBOARDING_BASELINE' THEN
    CASE WHEN current_gti>0 THEN current_gti::float8 ELSE 30::float8 END
  WHEN biomechanical_score>35 THEN
    LEAST(100,GREATEST(0,ROUND((
      effective_biomechanical_score * CASE WHEN has_drill THEN ROUND(0.35/active_weight,4) ELSE 0 END
      + COALESCE(training_consistency_score,0) * CASE WHEN has_wearable THEN ROUND(0.25/active_weight,4) ELSE 0 END
      + COALESCE(match_performance_score,0) * CASE WHEN has_match THEN ROUND(0.40/active_weight,4) ELSE 0 END
    )::numeric,2)))::float8
  ELSE COALESCE(NULLIF(gti,0),current_gti,0)::float8 END AS effective_gti
FROM weighted w;

-- Recalculate stored composites through the existing durable worker after deploy.
-- No historical measurements or match results are overwritten by this migration.
INSERT INTO outbox_events(id,kind,payload)
SELECT gen_random_uuid(),'GTI',jsonb_build_object('athleteId',p.user_id,'trigger','MANUAL',
  'deliveryId','watch-policy-v1-' || p.id::text)
FROM athlete_profiles p JOIN users u ON u.id=p.user_id
LEFT JOIN identity_verifications i ON i.user_id=p.user_id
WHERE u.is_active AND u.role='ATHLETE'
  AND COALESCE(i.status::text,'UNVERIFIED') NOT IN ('REVOKED','FLAGGED_DUPLICATE');
