ALTER TABLE health_alerts ADD COLUMN medical_check_note VARCHAR(1000),
  ADD COLUMN medical_check_dispatched BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE verified_match_results ADD COLUMN match_name VARCHAR(150) NOT NULL DEFAULT '',
  ADD COLUMN score_summary JSONB NOT NULL DEFAULT '{}';
CREATE TABLE tournament_vitals (
  id UUID PRIMARY KEY, tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  athlete_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, bracket_id UUID, match_id UUID,
  heart_rate DOUBLE PRECISION NOT NULL, spo2 DOUBLE PRECISION NOT NULL, skin_temperature DOUBLE PRECISION NOT NULL,
  severity "AlertSeverity" NOT NULL, source "TelemetrySource" NOT NULL, baseline_fields TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  observed_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX tournament_vitals_tournament_id_athlete_id_key ON tournament_vitals(tournament_id, athlete_id);
CREATE INDEX tournament_vitals_tournament_id_severity_idx ON tournament_vitals(tournament_id, severity);
ALTER TABLE tournament_vitals ENABLE ROW LEVEL SECURITY;
