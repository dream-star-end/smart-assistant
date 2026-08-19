-- Experimental community ZCode CLI engine (bundled zcode.cjs 0.16.3).
-- NOT an official standalone CLI. The real Coding Plan key never enters
-- catalog tables, user containers, or yolo-inheritable env.
-- This migration only expands the engine CHECK, creates the canary audit
-- table, and inserts hidden staged zcode-experimental (fn_model_catalog_guard
-- requires new catalog rows to be born staged; pricing stays enabled=false
-- visibility=hidden so the canary is not publicly routable).
-- Do NOT switch public glm-5.3-zai here. Post-deploy cutover is the audited
-- admin path POST /api/admin/model-catalog/zcode-glm53-cutover.
DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='model_catalog'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%engine%' AND pg_get_constraintdef(oid) LIKE '%ccb%' LOOP
    EXECUTE format('ALTER TABLE model_catalog DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE model_catalog ADD CONSTRAINT model_catalog_engine_check
    CHECK (engine IN ('ccb','codex','grok','cursor','zcode'));
END $$;

INSERT INTO model_catalog(
  model_id, engine, provider_id, upstream_model_id, context_window,
  capability_profile, capability_schema_version, state
) VALUES (
  'zcode-experimental',
  'zcode',
  'zcode',
  'glm-5.3',
  1000000,
  '{"supports_vision":false,"reasoning":{"supported":[],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":false}}'::jsonb,
  1,
  'staged'
);

INSERT INTO model_pricing(
  model_id, display_name,
  input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
  multiplier, enabled, sort_order, visibility, extra_system_prompt, default_effort, lock_version
) VALUES (
  'zcode-experimental',
  'ZCode Experimental (community CLI)',
  0, 0, 0, 0,
  '1',
  FALSE,
  (SELECT COALESCE(MAX(sort_order),100)+1 FROM model_pricing),
  'hidden',
  NULL,
  NULL,
  0
);

CREATE TABLE zcode_external_usage_audit (
  request_id TEXT PRIMARY KEY CHECK (request_id ~ '^[0-9a-f]{32}$'),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  container_id BIGINT NOT NULL REFERENCES agent_containers(id) ON DELETE RESTRICT,
  session_id TEXT,
  model_id TEXT NOT NULL CHECK (model_id = 'zcode-experimental'),
  billing_disposition TEXT NOT NULL DEFAULT 'external' CHECK (billing_disposition = 'external'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','error','unavailable')),
  terminal_code TEXT CHECK (terminal_code IS NULL OR terminal_code IN ('USER_CANCELLED','AUTH_UNAVAILABLE','QUOTA_UNAVAILABLE','ENGINE_ERROR')),
  duration_ms BIGINT CHECK (duration_ms IS NULL OR duration_ms >= 0),
  reported_usage JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX idx_zcode_external_usage_user_created ON zcode_external_usage_audit(user_id, created_at DESC);

COMMENT ON TABLE zcode_external_usage_audit IS
  'Audit-only token observations for the experimental community ZCode CLI canary. Public glm-5.3-zai settles via catalog prices after an audited engine switch; this table stays canary-only.';
