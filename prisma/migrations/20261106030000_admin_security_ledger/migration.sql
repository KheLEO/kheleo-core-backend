BEGIN;
CREATE TYPE "AuditCategory" AS ENUM ('GOV_ID_RESET','DRILL_HMAC_TAMPER','SANDBAGGING_BLOCKED','SAFETY_MATCH_PAUSE','ROLE_GOVERNANCE','TOURNAMENT_MODERATION','SYSTEM_EVENT');
CREATE TYPE "AuditSeverity" AS ENUM ('INFO','WARNING','CRITICAL');
ALTER TABLE security_audit_logs ADD COLUMN category "AuditCategory" NOT NULL DEFAULT 'SYSTEM_EVENT',
  ADD COLUMN severity "AuditSeverity" NOT NULL DEFAULT 'INFO',
  ADD COLUMN actor_user_id UUID, ADD COLUMN target_id VARCHAR(255),
  ADD COLUMN summary VARCHAR(500) NOT NULL DEFAULT '', ADD COLUMN ip_hash VARCHAR(64);

CREATE FUNCTION audit_category_for_action(event_action text) RETURNS "AuditCategory" LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN event_action IN ('GOV_ID_DUPLICATE_ATTEMPT','GOV_ID_RELINK_ATTEMPT') THEN 'GOV_ID_RESET'
    WHEN event_action='DRILL_SIGNATURE_REJECTED' THEN 'DRILL_HMAC_TAMPER'
    WHEN event_action='SANDBAGGING_DETECTED' THEN 'SANDBAGGING_BLOCKED'
    WHEN event_action='SAFETY_MATCH_PAUSED' THEN 'SAFETY_MATCH_PAUSE'
    WHEN event_action='ADMIN_USER_STATUS_CHANGED' THEN 'ROLE_GOVERNANCE'
    WHEN event_action LIKE 'ADMIN_TOURNAMENT_%' THEN 'TOURNAMENT_MODERATION'
    ELSE 'SYSTEM_EVENT'
  END::"AuditCategory";
$$;
CREATE FUNCTION normalize_security_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.category='SYSTEM_EVENT' THEN NEW.category:=audit_category_for_action(NEW.action); END IF;
  IF NEW.actor_user_id IS NULL AND NEW.action NOT IN ('GOV_ID_DUPLICATE_ATTEMPT','GOV_ID_RELINK_ATTEMPT') THEN NEW.actor_user_id:=NEW.user_id; END IF;
  NEW.target_id:=COALESCE(NEW.target_id,NEW.resource_id);
  IF NEW.summary='' THEN NEW.summary:=replace(NEW.action,'_',' '); END IF;
  IF NEW.severity='INFO' THEN
    IF NEW.category='SAFETY_MATCH_PAUSE' THEN NEW.severity:='CRITICAL';
    ELSIF NEW.category IN ('GOV_ID_RESET','DRILL_HMAC_TAMPER','SANDBAGGING_BLOCKED') THEN NEW.severity:='WARNING'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE security_audit_logs DISABLE TRIGGER security_audit_immutable;
UPDATE security_audit_logs SET category=audit_category_for_action(action),
  severity=CASE WHEN action='SAFETY_MATCH_PAUSED' THEN 'CRITICAL' WHEN action IN ('GOV_ID_DUPLICATE_ATTEMPT','GOV_ID_RELINK_ATTEMPT','DRILL_SIGNATURE_REJECTED','SANDBAGGING_DETECTED') THEN 'WARNING' ELSE 'INFO' END::"AuditSeverity",
  actor_user_id=CASE WHEN action IN ('GOV_ID_DUPLICATE_ATTEMPT','GOV_ID_RELINK_ATTEMPT') THEN NULL ELSE user_id END,target_id=resource_id,summary=replace(action,'_',' ');
ALTER TABLE security_audit_logs ENABLE TRIGGER security_audit_immutable;
CREATE TRIGGER security_audit_normalize BEFORE INSERT ON security_audit_logs FOR EACH ROW EXECUTE FUNCTION normalize_security_audit();
CREATE INDEX security_audit_logs_category_severity_created_at_id_idx ON security_audit_logs(category,severity,created_at DESC,id DESC);
COMMIT;
