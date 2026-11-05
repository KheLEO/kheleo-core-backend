ALTER TYPE "TelemetrySource" ADD VALUE IF NOT EXISTS 'BLE';
ALTER TYPE "TelemetrySource" ADD VALUE IF NOT EXISTS 'SIMULATOR';
ALTER TABLE "wearable_sessions" ADD COLUMN "baseline_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "health_alerts" ADD COLUMN "baseline_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "drill_submissions" ADD COLUMN "client_pose_digest" VARCHAR(64);
CREATE UNIQUE INDEX "drill_submissions_athlete_id_client_pose_digest_key"
  ON "drill_submissions"("athlete_id", "client_pose_digest");
