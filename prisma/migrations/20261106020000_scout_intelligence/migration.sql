ALTER TABLE scout_dossiers ADD COLUMN organization_name VARCHAR(200),
  ADD COLUMN outreach_history JSONB NOT NULL DEFAULT '[]';
ALTER TABLE wearable_sessions ADD COLUMN readings_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN heart_rate_sum DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN spo2_sum DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN simulator_readings INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN baseline_spo2_readings INTEGER NOT NULL DEFAULT 0;

UPDATE scout_dossiers SET outreach_history = jsonb_build_array(jsonb_build_object(
  'actionType', CASE WHEN pipeline_status = 'SCHOLARSHIP_OUTREACH' THEN 'SPONSORSHIP_INQUIRY' ELSE 'OFFER_TRIAL' END,
  'notes', scout_notes, 'organizationName', NULL, 'recordedAt', updated_at, 'legacySnapshot', true
)) WHERE pipeline_status IN ('TRIAL_OUTREACH', 'SCHOLARSHIP_OUTREACH');
UPDATE scout_dossiers SET outreach_history = outreach_history || jsonb_build_array(jsonb_build_object(
  'actionType', 'SHORTLIST_BOOKMARK', 'notes', scout_notes, 'organizationName', NULL, 'recordedAt', updated_at, 'legacySnapshot', true
)) WHERE is_shortlisted;
