-- 0207_grok_build_admin_pool.sql
-- Add the official xAI Grok Build engine, its subscription-account pool, and
-- a database-enforced admin-only visibility boundary.

-- Extend the model execution engine enum without weakening the remaining
-- catalog invariants.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'model_catalog'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%engine%'
       AND pg_get_constraintdef(oid) LIKE '%ccb%'
       AND pg_get_constraintdef(oid) LIKE '%codex%'
  LOOP
    EXECUTE format('ALTER TABLE model_catalog DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE model_catalog
    ADD CONSTRAINT model_catalog_engine_check
    CHECK (engine IN ('ccb', 'codex', 'grok'));
END $$;

-- Grok accounts share the encrypted account-pool storage, but are selected,
-- refreshed, and egress-routed only inside their own provider partition.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'claude_accounts'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%provider%'
       AND pg_get_constraintdef(oid) LIKE '%claude%'
       AND pg_get_constraintdef(oid) LIKE '%codex%'
  LOOP
    EXECUTE format('ALTER TABLE claude_accounts DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE claude_accounts
    ADD CONSTRAINT claude_accounts_provider_check
    CHECK (provider IN ('claude', 'codex', 'grok'));
END $$;

-- xAI team/organization OAuth refreshes carry the selected principal back to
-- the token endpoint. Preserve that official contract with the encrypted
-- refresh token instead of silently falling back to an arbitrary principal.
ALTER TABLE claude_accounts
  ADD COLUMN oauth_principal_type TEXT,
  ADD COLUMN oauth_principal_id TEXT,
  ADD CONSTRAINT claude_accounts_oauth_principal_pair_check CHECK (
    (oauth_principal_type IS NULL AND oauth_principal_id IS NULL) OR
    (provider = 'grok' AND oauth_principal_type <> '' AND oauth_principal_id <> '')
  );

DO $$
DECLARE c RECORD;
BEGIN
  -- Drop both the provider enum CHECK and the supported kind/provider combo
  -- CHECK by definition; their original generated names are not an API.
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'account_groups'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%provider%'
       AND pg_get_constraintdef(oid) LIKE '%claude%'
       AND pg_get_constraintdef(oid) LIKE '%codex%'
  LOOP
    EXECUTE format('ALTER TABLE account_groups DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE account_groups
    ADD CONSTRAINT account_groups_provider_check
      CHECK (provider IN ('claude', 'codex', 'grok')),
    ADD CONSTRAINT account_groups_supported_combo_check CHECK (
      (kind = 'official_oauth' AND provider IN ('claude', 'codex', 'grok')) OR
      (kind = 'api_relay'      AND provider = 'codex')
    );
END $$;

CREATE TABLE grok_route_contexts (
  token_hash    TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  container_id  BIGINT NOT NULL REFERENCES agent_containers(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id    BIGINT NOT NULL REFERENCES claude_accounts(id) ON DELETE CASCADE,
  slot_id       TEXT NOT NULL,
  model_id      TEXT NOT NULL REFERENCES model_pricing(model_id) ON DELETE RESTRICT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  last_used_at  TIMESTAMPTZ
);

CREATE INDEX idx_grok_route_contexts_lookup
  ON grok_route_contexts(container_id, user_id, expires_at)
  WHERE status = 'active';

CREATE INDEX idx_grok_route_contexts_account_active
  ON grok_route_contexts(account_id, expires_at)
  WHERE status = 'active';

-- Stage the exact execution descriptor first. The model_pricing compatibility
-- trigger below sees this staged row. Pricing remains disabled in this
-- groundwork migration so the current rollback release never observes an
-- engine it cannot execute; activation is a separate release after the
-- Grok-capable runtime is itself the proven rollback floor.
INSERT INTO model_catalog (
  model_id, engine, provider_id, upstream_model_id, context_window,
  capability_profile, capability_schema_version, state
)
VALUES (
  'grok-build', 'grok', 'grok', 'grok-build', 500000,
  '{"supports_vision":false,"reasoning":{"supported":["low","medium","high"],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":false}}'::jsonb,
  1, 'staged'
);

-- Grok subscription billing starts from the existing Sol commercial tariff.
-- This is an explicit product price snapshot, not a claim about xAI token API
-- pricing; admin can revise it through the normal pricing workflow later.
DO $$
DECLARE affected INTEGER;
BEGIN
  INSERT INTO model_pricing (
    model_id, display_name,
    input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
    multiplier, enabled, sort_order, visibility, extra_system_prompt,
    default_effort, lock_version
  )
  SELECT
    'grok-build', 'Grok Build',
    input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
    multiplier, FALSE, (SELECT COALESCE(MAX(sort_order), 100) + 1 FROM model_pricing),
    'admin', NULL, 'high', 0
  FROM model_pricing
  WHERE model_id = 'gpt-5.6-sol';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0207 expected exactly one gpt-5.6-sol pricing source, got %', affected;
  END IF;
END $$;

INSERT INTO account_groups(label, kind, provider, enabled, priority)
SELECT '默认 Grok 官方 OAuth 订阅', 'official_oauth', 'grok', TRUE, 210
WHERE NOT EXISTS (
  SELECT 1 FROM account_groups WHERE kind = 'official_oauth' AND provider = 'grok'
);

INSERT INTO account_group_models(group_id, model_id)
SELECT id, 'grok-build'
  FROM account_groups
 WHERE kind = 'official_oauth' AND provider = 'grok'
ON CONFLICT DO NOTHING;

-- Application filtering remains the primary projection, but this trigger is
-- the hard backstop against direct SQL or a future admin API accidentally
-- granting any Grok-engine model to a non-admin user.
CREATE OR REPLACE FUNCTION fn_grok_model_grants_admin_only() RETURNS trigger AS $$
DECLARE v_engine TEXT;
DECLARE v_role TEXT;
BEGIN
  SELECT c.engine INTO v_engine
   FROM model_catalog c
   WHERE c.model_id = NEW.model_id
     AND c.state IN ('staged', 'active')
   LIMIT 1;
  IF v_engine IS DISTINCT FROM 'grok' THEN
    RETURN NEW;
  END IF;
  SELECT role INTO v_role FROM users WHERE id = NEW.user_id;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'grok models are admin-only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_grok_model_grants_admin_only
  BEFORE INSERT OR UPDATE OF user_id, model_id ON model_visibility_grants
  FOR EACH ROW EXECUTE FUNCTION fn_grok_model_grants_admin_only();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM model_pricing p
      JOIN model_catalog c ON c.model_id = p.model_id AND c.state = 'staged'
     WHERE p.model_id = 'grok-build'
       AND p.enabled IS FALSE
       AND p.visibility = 'admin'
       AND p.default_effort = 'high'
       AND c.engine = 'grok'
       AND c.provider_id = 'grok'
       AND c.upstream_model_id = 'grok-build'
       AND c.context_window = 500000
  ) THEN
    RAISE EXCEPTION '0207 Grok groundwork catalog/pricing verification failed';
  END IF;
END $$;
