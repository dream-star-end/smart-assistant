-- 0282_scnet_glm53_flash.sql
-- order-dependency: none
-- 0278-0281 仅在 selfhost 线(OCV5-225 等),不进商业 aurora apply 链;本号跳过以免反合撞号。
-- Release B 预留 0283_disable_glm53_zai(等本支上线后再 disable catalog)。
--
-- Release A: glm-5.3 执行面从 ark 切到超算互联网 Token Plan(scnet),
-- 新增 glm-5.3-flash,归一 glm-5.3-zai 引用并隐藏选择器。不 disable zai catalog。
--
-- Manual rollback keeps the 0282 schema_migrations row.

LOCK TABLE model_catalog, model_pricing, model_aliases, model_runtime_requirements,
  model_visibility_grants, account_group_models, user_preferences, client_sessions
  IN SHARE ROW EXCLUSIVE MODE;

-- BEGIN TESTED MANUAL ROLLBACK 0282
-- LOCK TABLE model_catalog, model_pricing, model_aliases, model_runtime_requirements,
--   model_visibility_grants, account_group_models, user_preferences, client_sessions
--   IN SHARE ROW EXCLUSIVE MODE;
-- DO $rollback$
-- DECLARE
--   v_lock INTEGER;
--   v_profile JSONB := '{
--     "supports_vision": false,
--     "reasoning": { "supported": ["high", "max"], "codex_model_default": null },
--     "ccb": { "capability_zero": true, "supports_thinking": true }
--   }'::jsonb;
-- BEGIN
--   UPDATE model_pricing
--      SET visibility='public', lock_version=lock_version+1, updated_at=now()
--    WHERE model_id='glm-5.3-zai' AND visibility IS DISTINCT FROM 'public';
--   UPDATE model_pricing
--      SET enabled=FALSE, visibility='hidden', lock_version=lock_version+1, updated_at=now()
--    WHERE model_id='glm-5.3-flash';
--   IF EXISTS (
--     SELECT 1 FROM model_catalog
--      WHERE model_id='glm-5.3' AND state='active' AND provider_id='scnet'
--   ) THEN
--     SELECT lock_version INTO v_lock
--       FROM model_catalog WHERE model_id='glm-5.3' AND state='active' FOR UPDATE;
--     PERFORM fn_model_switch_version(
--       'glm-5.3','ccb','ark','glm-5.3',1000000,v_profile,1,NULL,v_lock);
--   END IF;
--   PERFORM fn_model_security_epoch_bump();
-- END
-- $rollback$;
-- END TESTED MANUAL ROLLBACK 0282

CREATE OR REPLACE FUNCTION fn_model_catalog_provider(p_model_id TEXT) RETURNS TEXT AS $$
  SELECT CASE
    WHEN p_model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna') THEN 'codex'
    WHEN lower(p_model_id) IN ('deepseek-v4-flash', 'deepseek-v4-flash-opencode-go') THEN 'opencodego'
    WHEN p_model_id LIKE 'deepseek-%' THEN 'deepseek'
    WHEN lower(p_model_id) = 'minimax-m3' THEN 'minimax'
    WHEN lower(p_model_id) = 'glm-5.3-zai' THEN 'zai'
    WHEN lower(p_model_id) IN ('glm-5.3', 'glm-5.3-flash') THEN 'scnet'
    WHEN lower(p_model_id) IN ('glm-5.1', 'glm-5.2') THEN 'ark'
    WHEN lower(p_model_id) IN ('qwen3.7-max', 'qwen3.7-plus') THEN 'opencodego'
    WHEN lower(p_model_id) = 'kimi-k2.7-code' THEN 'kimi'
    ELSE 'anthropic'
  END
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION fn_model_catalog_context_window(p_model_id TEXT) RETURNS INTEGER AS $$
  SELECT CASE
    WHEN p_model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna') THEN NULL
    WHEN lower(btrim(p_model_id)) = 'minimax-m3' THEN 512000
    WHEN lower(btrim(p_model_id)) IN (
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash-opencode-go'
    ) THEN 1000000
    WHEN lower(btrim(p_model_id)) IN ('glm-5.2', 'glm-5.3', 'glm-5.3-zai', 'glm-5.3-flash') THEN 1000000
    WHEN lower(btrim(p_model_id)) = 'glm-5.1' THEN 200000
    WHEN lower(btrim(p_model_id)) IN ('qwen3.7-max', 'qwen3.7-plus') THEN 1000000
    WHEN lower(btrim(p_model_id)) = 'kimi-k2.7-code' THEN 256000
    ELSE 200000
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
    WHEN lower(p_model_id) IN ('glm-5.1', 'glm-5.2', 'glm-5.3', 'glm-5.3-zai', 'glm-5.3-flash') THEN
      '{"supports_vision": false, "reasoning": {"supported": ["high", "max"], "codex_model_default": null}, "ccb": {"capability_zero": true, "supports_thinking": true}}'::jsonb
    WHEN lower(p_model_id) IN ('deepseek-v4-flash','deepseek-v4-flash-opencode-go','qwen3.7-max','qwen3.7-plus','kimi-k2.7-code') THEN
      '{"supports_vision": false, "reasoning": {"supported": [], "codex_model_default": null}, "ccb": {"capability_zero": true, "supports_thinking": true}}'::jsonb
    ELSE
      '{"supports_vision": false, "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": null}, "ccb": {"capability_zero": false, "supports_thinking": true}}'::jsonb
  END
$$ LANGUAGE sql IMMUTABLE;

DO $migration$
DECLARE
  v_lock INTEGER;
  v_new_entry BIGINT;
  v_profile JSONB := '{
    "supports_vision": false,
    "reasoning": { "supported": ["high", "max"], "codex_model_default": null },
    "ccb": { "capability_zero": true, "supports_thinking": true }
  }'::jsonb;
  v_glm53 model_catalog%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_glm53
    FROM model_catalog
   WHERE model_id='glm-5.3' AND state='active'
     FOR UPDATE;

  IF v_glm53.engine <> 'ccb' OR v_glm53.context_window <> 1000000 THEN
    RAISE EXCEPTION '0282 glm-5.3 active row is not the expected CCB 1M predecessor';
  END IF;

  IF v_glm53.provider_id IS DISTINCT FROM 'scnet'
     OR v_glm53.upstream_model_id IS DISTINCT FROM 'GLM-5.3' THEN
    v_lock := v_glm53.lock_version;
    v_new_entry := fn_model_switch_version(
      'glm-5.3',
      'ccb',
      'scnet',
      'GLM-5.3',
      1000000,
      v_profile,
      1,
      NULL,
      v_lock
    );
    IF v_new_entry IS NULL THEN
      RAISE EXCEPTION '0282 glm-5.3 switch_version returned null';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id='glm-5.3' AND state='active'
       AND engine='ccb' AND provider_id='scnet'
       AND upstream_model_id='GLM-5.3' AND context_window=1000000
  ) THEN
    RAISE EXCEPTION '0282 glm-5.3 scnet switch verification failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id='glm-5.3-flash' AND state IN ('staged', 'active', 'disabled')
  ) THEN
    PERFORM fn_model_stage_version(
      'glm-5.3-flash',
      'ccb',
      'scnet',
      'GLM-5.3-Flash',
      1000000,
      v_profile,
      1,
      NULL
    );
    PERFORM fn_model_activate('glm-5.3-flash', NULL);
  ELSIF EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id='glm-5.3-flash' AND state='staged'
  ) THEN
    PERFORM fn_model_activate('glm-5.3-flash', NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id='glm-5.3-flash' AND state='active'
       AND engine='ccb' AND provider_id='scnet'
       AND upstream_model_id='GLM-5.3-Flash' AND context_window=1000000
  ) THEN
    RAISE EXCEPTION '0282 glm-5.3-flash catalog verification failed';
  END IF;

  INSERT INTO model_pricing (
    model_id, display_name,
    input_per_mtok, output_per_mtok,
    cache_read_per_mtok, cache_write_per_mtok,
    multiplier, enabled, sort_order, visibility
  )
  SELECT
    'glm-5.3-flash',
    'GLM-5.3-Flash',
    GREATEST(1, (src.input_per_mtok * 15 + 70) / 140),
    GREATEST(1, (src.output_per_mtok * 50 + 220) / 440),
    GREATEST(0, (src.cache_read_per_mtok * 3 + 13) / 26),
    src.cache_write_per_mtok,
    src.multiplier,
    TRUE,
    COALESCE(src.sort_order, 20) + 1,
    'public'
  FROM model_pricing src
  WHERE src.model_id = 'glm-5.3' AND src.enabled IS TRUE
  ON CONFLICT (model_id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        input_per_mtok = EXCLUDED.input_per_mtok,
        output_per_mtok = EXCLUDED.output_per_mtok,
        cache_read_per_mtok = EXCLUDED.cache_read_per_mtok,
        cache_write_per_mtok = EXCLUDED.cache_write_per_mtok,
        multiplier = EXCLUDED.multiplier,
        enabled = TRUE,
        visibility = 'public',
        lock_version = model_pricing.lock_version + 1,
        updated_at = now();

  UPDATE user_preferences
     SET prefs = jsonb_set(prefs, '{default_model}', '"glm-5.3"')
   WHERE prefs->>'default_model' = 'glm-5.3-zai';

  UPDATE client_sessions
     SET model_id = 'glm-5.3'
   WHERE deleted_at IS NULL AND model_id = 'glm-5.3-zai';

  INSERT INTO model_visibility_grants(user_id, model_id, granted_at, granted_by)
  SELECT user_id, 'glm-5.3', granted_at, granted_by
    FROM model_visibility_grants WHERE model_id='glm-5.3-zai'
  ON CONFLICT (user_id, model_id) DO NOTHING;
  DELETE FROM model_visibility_grants WHERE model_id='glm-5.3-zai';

  INSERT INTO account_group_models(group_id, model_id, created_at)
  SELECT group_id, 'glm-5.3', created_at
    FROM account_group_models WHERE model_id='glm-5.3-zai'
  ON CONFLICT (group_id, model_id) DO NOTHING;
  DELETE FROM account_group_models WHERE model_id='glm-5.3-zai';

  UPDATE model_pricing
     SET visibility='hidden', lock_version=lock_version+1, updated_at=now()
   WHERE model_id='glm-5.3-zai' AND visibility IS DISTINCT FROM 'hidden';

  IF EXISTS (SELECT 1 FROM user_preferences WHERE prefs->>'default_model'='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM client_sessions WHERE deleted_at IS NULL AND model_id='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM model_visibility_grants WHERE model_id='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM account_group_models WHERE model_id='glm-5.3-zai') THEN
    RAISE EXCEPTION '0282 left a live glm-5.3-zai reference';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id='glm-5.3-flash' AND enabled IS TRUE AND visibility='public'
       AND display_name='GLM-5.3-Flash'
  ) THEN
    RAISE EXCEPTION '0282 glm-5.3-flash pricing verification failed';
  END IF;

  IF fn_model_catalog_provider('glm-5.3') <> 'scnet'
     OR fn_model_catalog_provider('glm-5.3-flash') <> 'scnet'
     OR fn_model_catalog_provider('glm-5.3-zai') <> 'zai' THEN
    RAISE EXCEPTION '0282 catalog provider helper mismatch';
  END IF;

  PERFORM fn_model_security_epoch_bump();
END
$migration$;
