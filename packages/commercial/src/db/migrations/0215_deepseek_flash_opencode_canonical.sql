-- 0215 — make the provider-neutral DeepSeek V4 Flash id the sole public entry.
--
-- Product identity remains `deepseek-v4-flash`; only its immutable execution version changes
-- from direct DeepSeek to OpenCode Go. The provider-branded id becomes a disabled catalog row
-- plus a compatibility alias, so old clients and historical session hints still resolve without
-- exposing two indistinguishable choices.
--
-- Manual compensation keeps the 0215 schema_migrations ledger row. Run the tested block below
-- under V5_DEV_PLAYBOOK.md section 4.5's production mutation lease/advisory lock/transaction.

-- BEGIN TESTED MANUAL COMPENSATION 0215
-- LOCK TABLE model_catalog, model_pricing, model_aliases, model_runtime_requirements,
--   user_preferences, client_sessions, model_visibility_grants, account_group_models,
--   model_flash_opencode_transition, model_flash_opencode_subject_snapshots
--   IN SHARE ROW EXCLUSIVE MODE;
--
-- DO $compensation$
-- DECLARE
--   v_transition model_flash_opencode_transition%ROWTYPE;
--   v_current model_catalog%ROWTYPE;
--   v_branded model_catalog%ROWTYPE;
-- BEGIN
--   SELECT * INTO STRICT v_transition FROM model_flash_opencode_transition WHERE id;
--   IF v_transition.compensated_at IS NOT NULL THEN
--     RAISE EXCEPTION '0215 compensation already completed';
--   END IF;
--
--   SELECT * INTO STRICT v_current
--     FROM model_catalog WHERE model_id='deepseek-v4-flash' AND state='active' FOR UPDATE;
--   SELECT * INTO STRICT v_branded
--     FROM model_catalog WHERE entry_id=v_transition.branded_entry_id FOR UPDATE;
--   IF v_current.entry_id <> v_transition.canonical_after_entry_id
--      OR v_current.provider_id <> 'opencodego'
--      OR v_current.upstream_model_id <> 'deepseek-v4-flash'
--      OR v_branded.state <> 'disabled'
--      OR NOT EXISTS (
--        SELECT 1 FROM model_aliases
--         WHERE alias='deepseek-v4-flash-opencode-go'
--           AND entry_id=v_current.entry_id
--      ) THEN
--     RAISE EXCEPTION '0215 compensation refuses catalog/alias drift';
--   END IF;
--   IF NOT EXISTS (
--     SELECT 1 FROM model_pricing
--      WHERE model_id='deepseek-v4-flash' AND enabled IS TRUE
--        AND visibility='public' AND display_name='DeepSeek V4 Flash (1M)'
--   ) OR NOT EXISTS (
--     SELECT 1 FROM model_pricing
--      WHERE model_id='deepseek-v4-flash-opencode-go' AND enabled IS FALSE
--        AND visibility='hidden'
--   ) THEN
--     RAISE EXCEPTION '0215 compensation refuses pricing drift';
--   END IF;
--
--   PERFORM fn_model_alias_remove('deepseek-v4-flash-opencode-go');
--   PERFORM fn_model_activate_entry(v_branded.entry_id, v_branded.lock_version, NULL);
--   UPDATE model_pricing
--      SET visibility=v_transition.branded_pricing_before->>'visibility',
--          lock_version=lock_version+1,
--          updated_at=now()
--    WHERE model_id='deepseek-v4-flash-opencode-go';
--
--   PERFORM fn_model_switch_version(
--     'deepseek-v4-flash',
--     v_transition.canonical_catalog_before->>'engine',
--     v_transition.canonical_catalog_before->>'provider_id',
--     v_transition.canonical_catalog_before->>'upstream_model_id',
--     (v_transition.canonical_catalog_before->>'context_window')::integer,
--     v_transition.canonical_catalog_before->'capability_profile',
--     (v_transition.canonical_catalog_before->>'capability_schema_version')::integer,
--     NULL,
--     v_current.lock_version
--   );
--
--   -- Restore only preference/session rows whose exact post-migration marker still matches.
--   UPDATE user_preferences p
--      SET prefs=s.source_before->'prefs',
--          updated_at=(s.source_before->>'updated_at')::timestamptz
--     FROM model_flash_opencode_subject_snapshots s
--    WHERE s.subject_kind='user_preferences'
--      AND p.user_id::text=s.subject_key
--      AND to_jsonb(p)=s.after_row;
--   UPDATE client_sessions c
--      SET model_id=s.source_before->>'model_id',
--          updated_at=(s.source_before->>'updated_at')::bigint
--     FROM model_flash_opencode_subject_snapshots s
--    WHERE s.subject_kind='client_sessions'
--      AND c.id=s.subject_key
--      AND to_jsonb(c)=s.after_row;
--
--   -- Restore old branded bindings. Delete a canonical binding only when 0215 created it and
--   -- it has not changed since; pre-existing canonical bindings are never removed.
--   INSERT INTO model_visibility_grants(user_id,model_id,granted_at,granted_by)
--   SELECT (source_before->>'user_id')::bigint,
--          source_before->>'model_id',
--          (source_before->>'granted_at')::timestamptz,
--          (source_before->>'granted_by')::bigint
--     FROM model_flash_opencode_subject_snapshots
--    WHERE subject_kind='model_visibility_grants'
--   ON CONFLICT (user_id,model_id) DO NOTHING;
--   DELETE FROM model_visibility_grants g
--    USING model_flash_opencode_subject_snapshots s
--    WHERE s.subject_kind='model_visibility_grants'
--      AND s.target_before IS NULL
--      AND g.user_id::text=s.subject_key
--      AND g.model_id='deepseek-v4-flash'
--      AND to_jsonb(g)=s.after_row;
--
--   INSERT INTO account_group_models(group_id,model_id,created_at)
--   SELECT (source_before->>'group_id')::bigint,
--          source_before->>'model_id',
--          (source_before->>'created_at')::timestamptz
--     FROM model_flash_opencode_subject_snapshots
--    WHERE subject_kind='account_group_models'
--   ON CONFLICT (group_id,model_id) DO NOTHING;
--   DELETE FROM account_group_models g
--    USING model_flash_opencode_subject_snapshots s
--    WHERE s.subject_kind='account_group_models'
--      AND s.target_before IS NULL
--      AND g.group_id::text=s.subject_key
--      AND g.model_id='deepseek-v4-flash'
--      AND to_jsonb(g)=s.after_row;
--
--   UPDATE model_flash_opencode_transition SET compensated_at=clock_timestamp() WHERE id;
-- END
-- $compensation$;
--
-- CREATE OR REPLACE FUNCTION fn_model_catalog_provider(p_model_id TEXT) RETURNS TEXT AS $$
--   SELECT CASE
--     WHEN p_model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna') THEN 'codex'
--     WHEN lower(p_model_id) = 'deepseek-v4-flash-opencode-go' THEN 'opencodego'
--     WHEN p_model_id LIKE 'deepseek-%' THEN 'deepseek'
--     WHEN lower(p_model_id) = 'minimax-m3' THEN 'minimax'
--     WHEN lower(p_model_id) IN ('glm-5.1', 'glm-5.2', 'glm-5.3') THEN 'ark'
--     WHEN lower(p_model_id) IN ('qwen3.7-max', 'qwen3.7-plus') THEN 'opencodego'
--     WHEN lower(p_model_id) = 'kimi-k2.7-code' THEN 'kimi'
--     ELSE 'anthropic'
--   END
-- $$ LANGUAGE sql IMMUTABLE;
--
-- CREATE OR REPLACE FUNCTION fn_model_catalog_capability(p_model_id TEXT) RETURNS JSONB AS $$
--   SELECT CASE
--     WHEN p_model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra') THEN
--       '{"supports_vision": false, "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": "xhigh"}, "ccb": {"capability_zero": false, "supports_thinking": false}}'::jsonb
--     WHEN p_model_id = 'gpt-5.6-luna' THEN
--       '{"supports_vision": false, "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": "medium"}, "ccb": {"capability_zero": false, "supports_thinking": false}}'::jsonb
--     WHEN lower(p_model_id) = 'minimax-m3' THEN
--       '{"supports_vision": true, "reasoning": {"supported": [], "codex_model_default": null}, "ccb": {"capability_zero": true, "supports_thinking": true}}'::jsonb
--     WHEN lower(p_model_id) IN ('glm-5.1', 'glm-5.2', 'glm-5.3') THEN
--       '{"supports_vision": false, "reasoning": {"supported": ["high","max"], "codex_model_default": null}, "ccb": {"capability_zero": true, "supports_thinking": true}}'::jsonb
--     WHEN lower(p_model_id) IN ('deepseek-v4-flash-opencode-go','qwen3.7-max','qwen3.7-plus','kimi-k2.7-code') THEN
--       '{"supports_vision": false, "reasoning": {"supported": [], "codex_model_default": null}, "ccb": {"capability_zero": true, "supports_thinking": true}}'::jsonb
--     ELSE
--       '{"supports_vision": false, "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": null}, "ccb": {"capability_zero": false, "supports_thinking": true}}'::jsonb
--   END
-- $$ LANGUAGE sql IMMUTABLE;
-- END TESTED MANUAL COMPENSATION 0215

LOCK TABLE model_catalog, model_pricing, model_aliases, model_runtime_requirements,
  user_preferences, client_sessions, model_visibility_grants, account_group_models
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE model_flash_opencode_transition (
  id                       BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  canonical_catalog_before JSONB NOT NULL,
  branded_catalog_before   JSONB NOT NULL,
  canonical_pricing_before JSONB NOT NULL,
  branded_pricing_before   JSONB NOT NULL,
  canonical_after_entry_id BIGINT NOT NULL UNIQUE,
  branded_entry_id         BIGINT NOT NULL UNIQUE,
  migrated_at              TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  compensated_at           TIMESTAMPTZ
);

CREATE TABLE model_flash_opencode_subject_snapshots (
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN (
                  'user_preferences','client_sessions',
                  'model_visibility_grants','account_group_models'
                )),
  subject_key   TEXT NOT NULL,
  source_before JSONB NOT NULL,
  target_before JSONB,
  after_row     JSONB,
  PRIMARY KEY (subject_kind, subject_key)
);

COMMENT ON TABLE model_flash_opencode_transition IS
  '0215 permanent model/provider transition ledger and compensation fence.';
COMMENT ON TABLE model_flash_opencode_subject_snapshots IS
  '0215 exact before/after rows for branded Flash references migrated to the provider-neutral id.';

CREATE OR REPLACE FUNCTION fn_model_catalog_provider(p_model_id TEXT) RETURNS TEXT AS $$
  SELECT CASE
    WHEN p_model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna') THEN 'codex'
    WHEN lower(p_model_id) IN ('deepseek-v4-flash', 'deepseek-v4-flash-opencode-go') THEN 'opencodego'
    WHEN p_model_id LIKE 'deepseek-%' THEN 'deepseek'
    WHEN lower(p_model_id) = 'minimax-m3' THEN 'minimax'
    WHEN lower(p_model_id) IN ('glm-5.1', 'glm-5.2', 'glm-5.3') THEN 'ark'
    WHEN lower(p_model_id) IN ('qwen3.7-max', 'qwen3.7-plus') THEN 'opencodego'
    WHEN lower(p_model_id) = 'kimi-k2.7-code' THEN 'kimi'
    ELSE 'anthropic'
  END
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION fn_model_catalog_capability(p_model_id TEXT) RETURNS JSONB AS $$
  SELECT CASE
    WHEN p_model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra') THEN
      '{"supports_vision": false, "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": "xhigh"}, "ccb": {"capability_zero": false, "supports_thinking": false}}'::jsonb
    WHEN p_model_id = 'gpt-5.6-luna' THEN
      '{"supports_vision": false, "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": "medium"}, "ccb": {"capability_zero": false, "supports_thinking": false}}'::jsonb
    WHEN lower(p_model_id) = 'minimax-m3' THEN
      '{"supports_vision": true, "reasoning": {"supported": [], "codex_model_default": null}, "ccb": {"capability_zero": true, "supports_thinking": true}}'::jsonb
    WHEN lower(p_model_id) IN ('glm-5.1', 'glm-5.2', 'glm-5.3') THEN
      '{"supports_vision": false, "reasoning": {"supported": ["high","max"], "codex_model_default": null}, "ccb": {"capability_zero": true, "supports_thinking": true}}'::jsonb
    WHEN lower(p_model_id) IN ('deepseek-v4-flash','deepseek-v4-flash-opencode-go','qwen3.7-max','qwen3.7-plus','kimi-k2.7-code') THEN
      '{"supports_vision": false, "reasoning": {"supported": [], "codex_model_default": null}, "ccb": {"capability_zero": true, "supports_thinking": true}}'::jsonb
    ELSE
      '{"supports_vision": false, "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": null}, "ccb": {"capability_zero": false, "supports_thinking": true}}'::jsonb
  END
$$ LANGUAGE sql IMMUTABLE;

DO $migration$
DECLARE
  v_canonical model_catalog%ROWTYPE;
  v_branded model_catalog%ROWTYPE;
  v_canonical_pricing model_pricing%ROWTYPE;
  v_branded_pricing model_pricing%ROWTYPE;
  v_new_entry BIGINT;
  v_open_code_profile JSONB := '{"supports_vision": false, "reasoning": {"supported": [], "codex_model_default": null}, "ccb": {"capability_zero": true, "supports_thinking": true}}'::jsonb;
BEGIN
  SELECT * INTO STRICT v_canonical
    FROM model_catalog WHERE model_id='deepseek-v4-flash' AND state='active' FOR UPDATE;
  SELECT * INTO STRICT v_branded
    FROM model_catalog WHERE model_id='deepseek-v4-flash-opencode-go' AND state='active' FOR UPDATE;
  SELECT * INTO STRICT v_canonical_pricing
    FROM model_pricing WHERE model_id='deepseek-v4-flash' FOR UPDATE;
  SELECT * INTO STRICT v_branded_pricing
    FROM model_pricing WHERE model_id='deepseek-v4-flash-opencode-go' FOR UPDATE;

  IF v_canonical.engine <> 'ccb' OR v_canonical.provider_id <> 'deepseek'
     OR v_canonical.upstream_model_id IS NOT NULL OR v_canonical.context_window <> 1000000
     OR v_canonical.capability_schema_version <> 1
     OR v_branded.engine <> 'ccb' OR v_branded.provider_id <> 'opencodego'
     OR v_branded.upstream_model_id <> 'deepseek-v4-flash'
     OR v_branded.context_window <> 1000000
     OR v_branded.capability_profile IS DISTINCT FROM v_open_code_profile
     OR v_branded.capability_schema_version <> 1 THEN
    RAISE EXCEPTION '0215 execution descriptor precondition failed';
  END IF;
  IF NOT (v_canonical_pricing.enabled AND v_canonical_pricing.visibility='public'
          AND v_canonical_pricing.display_name='DeepSeek V4 Flash (1M)')
     OR NOT (v_branded_pricing.enabled AND v_branded_pricing.visibility='public'
          AND v_branded_pricing.display_name='DeepSeek V4 Flash (OpenCode Go)') THEN
    RAISE EXCEPTION '0215 pricing precondition failed';
  END IF;
  IF EXISTS (SELECT 1 FROM model_aliases WHERE alias='deepseek-v4-flash-opencode-go') THEN
    RAISE EXCEPTION '0215 refuses a pre-existing branded Flash alias';
  END IF;
  IF (SELECT count(*) FROM model_runtime_requirements
       WHERE model_id='deepseek-v4-flash' AND requirement='ccb_secondary_utility') <> 1 THEN
    RAISE EXCEPTION '0215 requires the canonical Flash runtime requirement';
  END IF;

  INSERT INTO model_flash_opencode_subject_snapshots(subject_kind,subject_key,source_before)
  SELECT 'user_preferences',user_id::text,to_jsonb(p)
    FROM user_preferences p WHERE prefs->>'default_model'='deepseek-v4-flash-opencode-go';
  INSERT INTO model_flash_opencode_subject_snapshots(subject_kind,subject_key,source_before)
  SELECT 'client_sessions',id,to_jsonb(s)
    FROM client_sessions s
   WHERE deleted_at IS NULL AND model_id='deepseek-v4-flash-opencode-go';
  INSERT INTO model_flash_opencode_subject_snapshots(
    subject_kind,subject_key,source_before,target_before
  )
  SELECT 'model_visibility_grants',g.user_id::text,to_jsonb(g),to_jsonb(target)
    FROM model_visibility_grants g
    LEFT JOIN model_visibility_grants target
      ON target.user_id=g.user_id AND target.model_id='deepseek-v4-flash'
   WHERE g.model_id='deepseek-v4-flash-opencode-go';
  INSERT INTO model_flash_opencode_subject_snapshots(
    subject_kind,subject_key,source_before,target_before
  )
  SELECT 'account_group_models',g.group_id::text,to_jsonb(g),to_jsonb(target)
    FROM account_group_models g
    LEFT JOIN account_group_models target
      ON target.group_id=g.group_id AND target.model_id='deepseek-v4-flash'
   WHERE g.model_id='deepseek-v4-flash-opencode-go';

  SELECT fn_model_switch_version(
    'deepseek-v4-flash','ccb','opencodego','deepseek-v4-flash',1000000,
    v_open_code_profile,1,NULL,v_canonical.lock_version
  ) INTO v_new_entry;

  UPDATE user_preferences
     SET prefs=jsonb_set(prefs,'{default_model}',to_jsonb('deepseek-v4-flash'::text),true),
         updated_at=clock_timestamp()
   WHERE prefs->>'default_model'='deepseek-v4-flash-opencode-go';
  UPDATE client_sessions
     SET model_id='deepseek-v4-flash',
         updated_at=GREATEST(updated_at+1,floor(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint)
   WHERE deleted_at IS NULL AND model_id='deepseek-v4-flash-opencode-go';

  INSERT INTO model_visibility_grants(user_id,model_id,granted_at,granted_by)
  SELECT user_id,'deepseek-v4-flash',granted_at,granted_by
    FROM model_visibility_grants WHERE model_id='deepseek-v4-flash-opencode-go'
  ON CONFLICT (user_id,model_id) DO NOTHING;
  DELETE FROM model_visibility_grants WHERE model_id='deepseek-v4-flash-opencode-go';
  INSERT INTO account_group_models(group_id,model_id,created_at)
  SELECT group_id,'deepseek-v4-flash',created_at
    FROM account_group_models WHERE model_id='deepseek-v4-flash-opencode-go'
  ON CONFLICT (group_id,model_id) DO NOTHING;
  DELETE FROM account_group_models WHERE model_id='deepseek-v4-flash-opencode-go';

  PERFORM fn_model_disable_entry(v_branded.entry_id,v_branded.lock_version,NULL);
  UPDATE model_pricing
     SET visibility='hidden',lock_version=lock_version+1,updated_at=now()
   WHERE model_id='deepseek-v4-flash-opencode-go' AND visibility IS DISTINCT FROM 'hidden';
  PERFORM fn_model_alias_set('deepseek-v4-flash-opencode-go','deepseek-v4-flash',NULL);

  UPDATE model_flash_opencode_subject_snapshots s
     SET after_row=to_jsonb(p)
    FROM user_preferences p
   WHERE s.subject_kind='user_preferences' AND p.user_id::text=s.subject_key;
  UPDATE model_flash_opencode_subject_snapshots s
     SET after_row=to_jsonb(c)
    FROM client_sessions c
   WHERE s.subject_kind='client_sessions' AND c.id=s.subject_key;
  UPDATE model_flash_opencode_subject_snapshots s
     SET after_row=to_jsonb(g)
    FROM model_visibility_grants g
   WHERE s.subject_kind='model_visibility_grants'
     AND g.user_id::text=s.subject_key AND g.model_id='deepseek-v4-flash';
  UPDATE model_flash_opencode_subject_snapshots s
     SET after_row=to_jsonb(g)
    FROM account_group_models g
   WHERE s.subject_kind='account_group_models'
     AND g.group_id::text=s.subject_key AND g.model_id='deepseek-v4-flash';

  INSERT INTO model_flash_opencode_transition(
    canonical_catalog_before,branded_catalog_before,
    canonical_pricing_before,branded_pricing_before,
    canonical_after_entry_id,branded_entry_id
  ) VALUES (
    to_jsonb(v_canonical),to_jsonb(v_branded),
    to_jsonb(v_canonical_pricing),to_jsonb(v_branded_pricing),
    v_new_entry,v_branded.entry_id
  );
END
$migration$;

DO $postcondition$
DECLARE
  v_expected_profile JSONB := '{"supports_vision": false, "reasoning": {"supported": [], "codex_model_default": null}, "ccb": {"capability_zero": true, "supports_thinking": true}}'::jsonb;
BEGIN
  IF (SELECT count(*) FROM model_catalog
       WHERE model_id='deepseek-v4-flash' AND state='active'
         AND engine='ccb' AND provider_id='opencodego'
         AND upstream_model_id='deepseek-v4-flash' AND context_window=1000000
         AND capability_profile=v_expected_profile AND capability_schema_version=1) <> 1 THEN
    RAISE EXCEPTION '0215 canonical Flash execution switch failed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM model_pricing
       WHERE model_id='deepseek-v4-flash' AND enabled IS TRUE AND visibility='public'
         AND display_name='DeepSeek V4 Flash (1M)')
     OR NOT EXISTS (SELECT 1 FROM model_catalog
       WHERE model_id='deepseek-v4-flash-opencode-go' AND state='disabled')
     OR NOT EXISTS (SELECT 1 FROM model_pricing
       WHERE model_id='deepseek-v4-flash-opencode-go' AND enabled IS FALSE AND visibility='hidden') THEN
    RAISE EXCEPTION '0215 single-public-entry state failed';
  END IF;
  IF (SELECT count(*) FROM model_aliases a
       JOIN model_catalog c ON c.entry_id=a.entry_id
       WHERE a.alias='deepseek-v4-flash-opencode-go'
         AND c.model_id='deepseek-v4-flash' AND c.state='active') <> 1 THEN
    RAISE EXCEPTION '0215 branded compatibility alias failed';
  END IF;
  IF EXISTS (SELECT 1 FROM user_preferences
       WHERE prefs->>'default_model'='deepseek-v4-flash-opencode-go')
     OR EXISTS (SELECT 1 FROM client_sessions
       WHERE deleted_at IS NULL AND model_id='deepseek-v4-flash-opencode-go')
     OR EXISTS (SELECT 1 FROM model_visibility_grants
       WHERE model_id='deepseek-v4-flash-opencode-go')
     OR EXISTS (SELECT 1 FROM account_group_models
       WHERE model_id='deepseek-v4-flash-opencode-go') THEN
    RAISE EXCEPTION '0215 left a live branded Flash reference';
  END IF;
  IF fn_model_catalog_provider('deepseek-v4-flash') <> 'opencodego'
     OR fn_model_catalog_provider('deepseek-v4-pro') <> 'deepseek'
     OR fn_model_catalog_capability('deepseek-v4-flash') IS DISTINCT FROM v_expected_profile THEN
    RAISE EXCEPTION '0215 compatibility helper transition failed';
  END IF;
  IF (SELECT count(*) FROM model_flash_opencode_transition) <> 1
     OR EXISTS (SELECT 1 FROM model_flash_opencode_subject_snapshots WHERE after_row IS NULL) THEN
    RAISE EXCEPTION '0215 transition ledger incomplete';
  END IF;
END
$postcondition$;
