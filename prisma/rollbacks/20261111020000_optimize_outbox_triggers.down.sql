-- Rollback for 20261111020000_optimize_outbox_triggers
DROP INDEX IF EXISTS "outbox_events_delivered_cleanup_idx";
DROP INDEX IF EXISTS "outbox_events_pending_dispatch_idx";

DROP TRIGGER IF EXISTS profile_delivery_insert ON athlete_profiles;
DROP TRIGGER IF EXISTS profile_delivery_delete ON athlete_profiles;
DROP TRIGGER IF EXISTS profile_delivery_update ON athlete_profiles;
CREATE TRIGGER profile_delivery
  AFTER INSERT OR UPDATE OR DELETE ON athlete_profiles
  FOR EACH ROW EXECUTE FUNCTION capture_delivery_intent();

DROP TRIGGER IF EXISTS user_access_delivery ON users;
CREATE TRIGGER user_access_delivery
  AFTER UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION capture_delivery_intent();

DROP TRIGGER IF EXISTS identity_access_delivery ON identity_verifications;
CREATE TRIGGER identity_access_delivery
  AFTER UPDATE ON identity_verifications
  FOR EACH ROW EXECUTE FUNCTION capture_delivery_intent();

