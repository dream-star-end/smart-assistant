-- 0190 — production-user signal quality, Auto-Dream raw/theme separation,
-- inbox semantics, and marketplace uninstall attribution.
--
-- Additive and rolling-compatible: old masters ignore the new columns/tables;
-- new code keeps every pre-0190 write valid through defaults.

ALTER TABLE users
  ADD COLUMN signal_traffic_class TEXT NOT NULL DEFAULT 'production_user'
  CHECK (signal_traffic_class IN (
    'production_user', 'internal_admin', 'synthetic_canary', 'e2e'
  ));

UPDATE users
   SET signal_traffic_class = CASE
     WHEN lower(email) = 'v5-canary@claudeai.chat' THEN 'synthetic_canary'
     WHEN lower(email) = 'v5-evals@claudeai.chat' THEN 'e2e'
     WHEN role = 'admin' THEN 'internal_admin'
     ELSE 'production_user'
   END;

CREATE FUNCTION assign_user_signal_traffic_class()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF lower(NEW.email) = 'v5-canary@claudeai.chat' THEN
    NEW.signal_traffic_class := 'synthetic_canary';
  ELSIF lower(NEW.email) = 'v5-evals@claudeai.chat' THEN
    NEW.signal_traffic_class := 'e2e';
  ELSIF NEW.role = 'admin'
        AND NEW.signal_traffic_class NOT IN ('synthetic_canary', 'e2e') THEN
    NEW.signal_traffic_class := 'internal_admin';
  ELSIF TG_OP = 'UPDATE'
        AND OLD.role = 'admin'
        AND NEW.role <> 'admin'
        AND NEW.signal_traffic_class = 'internal_admin' THEN
    NEW.signal_traffic_class := 'production_user';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_signal_traffic_class_trg
BEFORE INSERT OR UPDATE OF email, role ON users
FOR EACH ROW EXECUTE FUNCTION assign_user_signal_traffic_class();

CREATE INDEX idx_users_signal_traffic_class
  ON users(signal_traffic_class, id);

ALTER TABLE auto_dream_platform_finding_occurrences
  ADD COLUMN model TEXT,
  ADD COLUMN traffic_class TEXT NOT NULL DEFAULT 'production_user'
    CHECK (traffic_class IN (
      'production_user', 'internal_admin', 'synthetic_canary', 'e2e'
    ));

UPDATE auto_dream_platform_finding_occurrences o
   SET model = f.last_model
  FROM auto_dream_platform_findings f
 WHERE f.id = o.finding_id AND o.model IS NULL;

ALTER TABLE auto_dream_platform_finding_occurrences
  ALTER COLUMN model SET DEFAULT 'unknown',
  ALTER COLUMN model SET NOT NULL;

CREATE INDEX idx_auto_dream_occurrences_traffic_model
  ON auto_dream_platform_finding_occurrences(traffic_class, model, finding_id);

CREATE TABLE auto_dream_platform_raw_signals (
  subject_hash CHAR(64) NOT NULL,
  run_id UUID NOT NULL,
  agent_hash CHAR(64) NOT NULL,
  evidence_hash CHAR(64) NOT NULL,
  taxonomy TEXT NOT NULL CHECK (taxonomy IN (
    'capability_gap', 'usability_friction', 'reliability', 'performance',
    'privacy', 'billing', 'documentation', 'skill_quality', 'plugin_ecosystem'
  )),
  capability_id TEXT NOT NULL CHECK (capability_id ~ '^[a-z0-9][a-z0-9._-]{0,95}$'),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  signal_count INTEGER NOT NULL CHECK (signal_count BETWEEN 1 AND 1000000),
  model TEXT NOT NULL,
  traffic_class TEXT NOT NULL CHECK (traffic_class IN (
    'production_user', 'internal_admin', 'synthetic_canary', 'e2e'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (subject_hash, run_id, agent_hash, evidence_hash)
);

CREATE INDEX idx_auto_dream_raw_traffic_model_created
  ON auto_dream_platform_raw_signals(traffic_class, model, created_at DESC);

COMMENT ON TABLE auto_dream_platform_raw_signals IS
  'Lossless sanitized Auto-Dream map signals. Contains closed taxonomy fields and anonymous HMAC membership only; never conversation/log/tool text or direct user identifiers.';

ALTER TABLE inbox_messages
  ADD COLUMN category TEXT NOT NULL DEFAULT 'user'
    CHECK (category IN ('user', 'automation', 'billing', 'operations', 'marketing')),
  ADD COLUMN thread_key TEXT;

UPDATE inbox_messages
   SET category = CASE
     WHEN source_type = 'cron_delivery' THEN 'automation'
     WHEN source_type = 'turn_waive' THEN 'billing'
     WHEN source_type IN ('incident', 'selfheal', 'alert') THEN 'operations'
     WHEN level = 'promo' THEN 'marketing'
     ELSE 'user'
   END,
       thread_key = CASE
         WHEN source_type = 'cron_delivery' AND user_id IS NOT NULL
           THEN 'cron:user:' || user_id::text
         WHEN source_type = 'turn_waive' AND user_id IS NOT NULL
           THEN 'billing:user:' || user_id::text
         ELSE NULL
       END;

ALTER TABLE inbox_messages
  ADD CONSTRAINT inbox_messages_thread_key_check
  CHECK (thread_key IS NULL OR thread_key ~ '^[a-z0-9:_-]{1,160}$');

CREATE INDEX idx_inbox_messages_category_created
  ON inbox_messages(category, created_at DESC, id DESC);
CREATE INDEX idx_inbox_messages_thread_created
  ON inbox_messages(thread_key, created_at DESC, id DESC)
  WHERE thread_key IS NOT NULL;

ALTER TABLE marketplace_installs
  ADD COLUMN uninstall_reason TEXT
  CHECK (uninstall_reason IS NULL OR uninstall_reason IN (
    'not_needed', 'poor_quality', 'missing_capability', 'install_error',
    'other', 'prefer_not_say'
  ));

CREATE INDEX idx_marketplace_installs_uninstall_reason
  ON marketplace_installs(uninstalled_at DESC, uninstall_reason)
  WHERE uninstalled_at IS NOT NULL;
