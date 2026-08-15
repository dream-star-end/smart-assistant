-- 0217_stage_zai_glm53.sql
-- Release A: establish a rollback-safe execution floor for Z.AI Coding Plan GLM-5.3.
--
-- The platform canonical id is glm-5.3-zai while the upstream request literal remains
-- glm-5.3.  This migration deliberately ends disabled + hidden: the Release A runtime and
-- ZAI_CODING_PLAN_KEY must be deployed and verified through a temporary audited grant before a
-- later, separately reviewed migration may activate/publicize the model.
--
-- The V5 migration runner supplies BEGIN/COMMIT and the schema_migrations ledger write.  In
-- production this file must be applied under the release queue, production mutation lease,
-- migration advisory lock, and SET LOCAL ROLE openclaude discipline from V5_DEV_PLAYBOOK §4.5.

LOCK TABLE model_catalog, model_pricing, model_aliases, model_runtime_requirements,
  model_visibility_grants, account_group_models, user_preferences, client_sessions
  IN SHARE ROW EXCLUSIVE MODE;

-- Keep legacy model_pricing INSERT compatibility helpers aligned with the protocol registry.
-- These helpers are a rollback floor only; the guarded authority state machine below is the
-- normal onboarding path.
CREATE OR REPLACE FUNCTION fn_model_catalog_provider(p_model_id TEXT) RETURNS TEXT AS $$
  SELECT CASE
    WHEN p_model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna') THEN 'codex'
    WHEN lower(p_model_id) IN ('deepseek-v4-flash', 'deepseek-v4-flash-opencode-go') THEN 'opencodego'
    WHEN p_model_id LIKE 'deepseek-%' THEN 'deepseek'
    WHEN lower(p_model_id) = 'minimax-m3' THEN 'minimax'
    WHEN lower(p_model_id) = 'glm-5.3-zai' THEN 'zai'
    WHEN lower(p_model_id) IN ('glm-5.1', 'glm-5.2', 'glm-5.3') THEN 'ark'
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
    WHEN lower(btrim(p_model_id)) IN ('glm-5.2', 'glm-5.3', 'glm-5.3-zai') THEN 1000000
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
    WHEN lower(p_model_id) IN ('glm-5.1', 'glm-5.2', 'glm-5.3', 'glm-5.3-zai') THEN
      '{"supports_vision": false, "reasoning": {"supported": ["high","max"], "codex_model_default": null}, "ccb": {"capability_zero": true, "supports_thinking": true}}'::jsonb
    WHEN lower(p_model_id) IN ('deepseek-v4-flash','deepseek-v4-flash-opencode-go','qwen3.7-max','qwen3.7-plus','kimi-k2.7-code') THEN
      '{"supports_vision": false, "reasoning": {"supported": [], "codex_model_default": null}, "ccb": {"capability_zero": true, "supports_thinking": true}}'::jsonb
    ELSE
      '{"supports_vision": false, "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": null}, "ccb": {"capability_zero": false, "supports_thinking": true}}'::jsonb
  END
$$ LANGUAGE sql IMMUTABLE;

DO $migration$
DECLARE
  v_source model_catalog%ROWTYPE;
  v_source_pricing model_pricing%ROWTYPE;
  v_target_entry BIGINT;
  v_profile JSONB := '{
    "supports_vision": false,
    "reasoning": { "supported": ["high", "max"], "codex_model_default": null },
    "ccb": { "capability_zero": true, "supports_thinking": true }
  }'::jsonb;
BEGIN
  IF (SELECT count(*) FROM model_catalog WHERE model_id='glm-5.3') <> 1 THEN
    RAISE EXCEPTION '0217 requires exactly one glm-5.3 catalog predecessor';
  END IF;
  SELECT * INTO STRICT v_source
    FROM model_catalog WHERE model_id='glm-5.3' FOR UPDATE;
  IF v_source.state <> 'active'
     OR v_source.engine <> 'ccb'
     OR v_source.provider_id <> 'ark'
     OR v_source.upstream_model_id <> 'glm-5.3'
     OR v_source.context_window <> 1000000
     OR v_source.capability_schema_version <> 1
     OR v_source.capability_profile IS DISTINCT FROM v_profile THEN
    RAISE EXCEPTION '0217 glm-5.3 catalog predecessor precondition failed';
  END IF;

  IF (SELECT count(*) FROM model_pricing WHERE model_id='glm-5.3') <> 1 THEN
    RAISE EXCEPTION '0217 requires exactly one glm-5.3 pricing predecessor';
  END IF;
  SELECT * INTO STRICT v_source_pricing
    FROM model_pricing WHERE model_id='glm-5.3' FOR UPDATE;
  IF v_source_pricing.enabled IS NOT TRUE OR v_source_pricing.visibility <> 'public' THEN
    RAISE EXCEPTION '0217 glm-5.3 pricing predecessor must be enabled and public';
  END IF;

  IF EXISTS (SELECT 1 FROM model_catalog WHERE model_id='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM model_pricing WHERE model_id='glm-5.3-zai')
     OR EXISTS (
       SELECT 1 FROM model_aliases a
       LEFT JOIN model_catalog c ON c.entry_id=a.entry_id
       WHERE a.alias='glm-5.3-zai' OR c.model_id='glm-5.3-zai'
     )
     OR EXISTS (SELECT 1 FROM model_runtime_requirements WHERE model_id='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM model_visibility_grants WHERE model_id='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM account_group_models WHERE model_id='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM user_preferences WHERE prefs->>'default_model'='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM client_sessions WHERE model_id='glm-5.3-zai') THEN
    RAISE EXCEPTION '0217 refuses pre-existing glm-5.3-zai catalog/pricing/binding references';
  END IF;

  SELECT fn_model_stage_version(
    'glm-5.3-zai', 'ccb', 'zai', 'glm-5.3', 1000000,
    v_profile, 1, NULL
  ) INTO v_target_entry;
  PERFORM fn_model_activate_entry(v_target_entry, 0, NULL);
  PERFORM fn_model_disable_entry(v_target_entry, 1, NULL);

  INSERT INTO model_pricing (
    model_id, display_name,
    input_per_mtok, output_per_mtok,
    cache_read_per_mtok, cache_write_per_mtok,
    multiplier, enabled, sort_order, visibility,
    extra_system_prompt, default_effort, lock_version, updated_by
  )
  SELECT
    'glm-5.3-zai', 'GLM-5.3 (Z.AI)',
    input_per_mtok, output_per_mtok,
    cache_read_per_mtok, cache_write_per_mtok,
    multiplier, FALSE, 84, 'hidden',
    extra_system_prompt, default_effort, 0, NULL
  FROM model_pricing
  WHERE model_id='glm-5.3' AND enabled IS TRUE AND visibility='public';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0217 failed to copy glm-5.3 pricing predecessor';
  END IF;
END
$migration$;

DO $postcondition$
DECLARE
  v_profile JSONB := '{
    "supports_vision": false,
    "reasoning": { "supported": ["high", "max"], "codex_model_default": null },
    "ccb": { "capability_zero": true, "supports_thinking": true }
  }'::jsonb;
BEGIN
  IF (SELECT count(*) FROM model_catalog WHERE model_id='glm-5.3-zai') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM model_catalog
       WHERE model_id='glm-5.3-zai'
         AND engine='ccb'
         AND provider_id='zai'
         AND upstream_model_id='glm-5.3'
         AND context_window=1000000
         AND capability_schema_version=1
         AND capability_profile=v_profile
         AND state='disabled'
         AND lock_version=2
         AND updated_by IS NULL
     ) THEN
    RAISE EXCEPTION '0217 hidden catalog floor postcondition failed';
  END IF;

  IF (SELECT count(*) FROM model_pricing WHERE model_id='glm-5.3-zai') <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM model_pricing target
       JOIN model_pricing source ON source.model_id='glm-5.3'
       WHERE target.model_id='glm-5.3-zai'
         AND target.display_name='GLM-5.3 (Z.AI)'
         AND target.input_per_mtok=source.input_per_mtok
         AND target.output_per_mtok=source.output_per_mtok
         AND target.cache_read_per_mtok=source.cache_read_per_mtok
         AND target.cache_write_per_mtok=source.cache_write_per_mtok
         AND target.multiplier=source.multiplier
         AND target.extra_system_prompt IS NOT DISTINCT FROM source.extra_system_prompt
         AND target.default_effort IS NOT DISTINCT FROM source.default_effort
         AND target.enabled IS FALSE
         AND target.sort_order=84
         AND target.visibility='hidden'
         AND target.lock_version=0
         AND target.updated_by IS NULL
     ) THEN
    RAISE EXCEPTION '0217 hidden pricing floor postcondition failed';
  END IF;

  IF EXISTS (
       SELECT 1 FROM model_aliases a
       LEFT JOIN model_catalog c ON c.entry_id=a.entry_id
       WHERE a.alias='glm-5.3-zai' OR c.model_id='glm-5.3-zai'
     )
     OR EXISTS (SELECT 1 FROM model_runtime_requirements WHERE model_id='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM model_visibility_grants WHERE model_id='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM account_group_models WHERE model_id='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM user_preferences WHERE prefs->>'default_model'='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM client_sessions WHERE model_id='glm-5.3-zai') THEN
    RAISE EXCEPTION '0217 hidden model must have zero bindings';
  END IF;

  IF fn_model_catalog_provider('GLM-5.3-ZAI') <> 'zai'
     OR fn_model_catalog_provider('GLM-5.3') <> 'ark'
     OR fn_model_catalog_context_window('glm-5.3-zai') <> 1000000
     OR fn_model_catalog_capability('glm-5.3-zai') IS DISTINCT FROM v_profile THEN
    RAISE EXCEPTION '0217 legacy compatibility helper postcondition failed';
  END IF;
END
$postcondition$;
