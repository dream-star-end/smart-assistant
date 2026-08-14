-- 0211_stage_glm53_opencode_flash.sql
-- Release A: establish the rollback-safe execution floor for GLM-5.3 on Ark Coding Plan
-- and DeepSeek V4 Flash on OpenCode Go without exposing either model to users yet.
--
-- Both catalog rows deliberately traverse staged -> active -> disabled through the guarded
-- model authority state machine. Pricing is inserted only after catalog creation and remains
-- disabled/hidden. A later migration may activate/publicize the models after production E2E.

-- Keep the legacy model_pricing INSERT compatibility helpers aligned with the protocol registry.
-- These helpers are a rollback floor, not the normal onboarding path below.
CREATE OR REPLACE FUNCTION fn_model_catalog_provider(p_model_id TEXT) RETURNS TEXT AS $$
  SELECT CASE
    WHEN p_model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')   THEN 'codex'
    WHEN lower(p_model_id) = 'deepseek-v4-flash-opencode-go'             THEN 'opencodego'
    WHEN p_model_id LIKE 'deepseek-%'                                     THEN 'deepseek'
    WHEN lower(p_model_id) = 'minimax-m3'                                 THEN 'minimax'
    WHEN lower(p_model_id) IN ('glm-5.1', 'glm-5.2', 'glm-5.3')          THEN 'ark'
    WHEN lower(p_model_id) IN ('qwen3.7-max', 'qwen3.7-plus')             THEN 'opencodego'
    WHEN lower(p_model_id) = 'kimi-k2.7-code'                             THEN 'kimi'
    ELSE 'anthropic'
  END
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION fn_model_catalog_context_window(p_model_id TEXT) RETURNS INTEGER AS $$
  SELECT CASE
    WHEN p_model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')   THEN NULL
    WHEN lower(btrim(p_model_id)) = 'minimax-m3'                          THEN 512000
    WHEN lower(btrim(p_model_id)) IN (
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash-opencode-go'
    )                                                                     THEN 1000000
    WHEN lower(btrim(p_model_id)) IN ('glm-5.2', 'glm-5.3')              THEN 1000000
    WHEN lower(btrim(p_model_id)) = 'glm-5.1'                             THEN 200000
    WHEN lower(btrim(p_model_id)) IN ('qwen3.7-max', 'qwen3.7-plus')      THEN 1000000
    WHEN lower(btrim(p_model_id)) = 'kimi-k2.7-code'                      THEN 256000
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
    WHEN lower(p_model_id) IN ('glm-5.1', 'glm-5.2', 'glm-5.3') THEN
      '{"supports_vision": false, "reasoning": {"supported": ["high","max"], "codex_model_default": null}, "ccb": {"capability_zero": true, "supports_thinking": true}}'::jsonb
    WHEN lower(p_model_id) IN (
      'deepseek-v4-flash-opencode-go',
      'qwen3.7-max',
      'qwen3.7-plus',
      'kimi-k2.7-code'
    ) THEN
      '{"supports_vision": false, "reasoning": {"supported": [], "codex_model_default": null}, "ccb": {"capability_zero": true, "supports_thinking": true}}'::jsonb
    ELSE
      '{"supports_vision": false, "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": null}, "ccb": {"capability_zero": false, "supports_thinking": true}}'::jsonb
  END
$$ LANGUAGE sql IMMUTABLE;

DO $migration$
DECLARE
  v_glm_source_count INTEGER;
  v_flash_source_count INTEGER;
  v_existing_targets INTEGER;
  v_qwen_floor_count INTEGER;
BEGIN
  SELECT count(*) INTO v_glm_source_count
    FROM model_pricing
   WHERE model_id = 'glm-5.2' AND enabled IS TRUE;
  IF v_glm_source_count <> 1 THEN
    RAISE EXCEPTION
      '0211 requires exactly one enabled glm-5.2 pricing source, found %',
      v_glm_source_count;
  END IF;

  SELECT count(*) INTO v_flash_source_count
    FROM model_pricing
   WHERE model_id = 'deepseek-v4-flash' AND enabled IS TRUE;
  IF v_flash_source_count <> 1 THEN
    RAISE EXCEPTION
      '0211 requires exactly one enabled deepseek-v4-flash pricing source, found %',
      v_flash_source_count;
  END IF;

  SELECT
    (SELECT count(*) FROM model_catalog
      WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go'))
    +
    (SELECT count(*) FROM model_pricing
      WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go'))
    INTO v_existing_targets;
  IF v_existing_targets <> 0 THEN
    RAISE EXCEPTION '0211 refuses pre-existing target catalog/pricing rows, found %', v_existing_targets;
  END IF;

  SELECT count(*) INTO v_qwen_floor_count
    FROM model_catalog c
    JOIN model_pricing p USING (model_id)
   WHERE c.model_id IN ('qwen3.7-max', 'qwen3.7-plus')
     AND c.state IN ('staged', 'active', 'disabled')
     AND p.enabled = (c.state = 'active');
  IF v_qwen_floor_count <> 2 THEN
    RAISE EXCEPTION
      '0211 requires both legacy Qwen3.7 live rows with catalog/pricing parity, found %',
      v_qwen_floor_count;
  END IF;

  PERFORM fn_model_stage_version(
    'glm-5.3',
    'ccb',
    'ark',
    'glm-5.3',
    1000000,
    '{
      "supports_vision": false,
      "reasoning": { "supported": ["high", "max"], "codex_model_default": null },
      "ccb": { "capability_zero": true, "supports_thinking": true }
    }'::jsonb,
    1,
    NULL
  );
  PERFORM fn_model_activate('glm-5.3', NULL);
  PERFORM fn_model_disable('glm-5.3', NULL);

  PERFORM fn_model_stage_version(
    'deepseek-v4-flash-opencode-go',
    'ccb',
    'opencodego',
    'deepseek-v4-flash',
    1000000,
    '{
      "supports_vision": false,
      "reasoning": { "supported": [], "codex_model_default": null },
      "ccb": { "capability_zero": true, "supports_thinking": true }
    }'::jsonb,
    1,
    NULL
  );
  PERFORM fn_model_activate('deepseek-v4-flash-opencode-go', NULL);
  PERFORM fn_model_disable('deepseek-v4-flash-opencode-go', NULL);

  INSERT INTO model_pricing (
    model_id, display_name,
    input_per_mtok, output_per_mtok,
    cache_read_per_mtok, cache_write_per_mtok,
    multiplier, enabled, sort_order, visibility,
    extra_system_prompt, default_effort, lock_version
  )
  SELECT
    'glm-5.3', 'GLM-5.3',
    input_per_mtok, output_per_mtok,
    cache_read_per_mtok, cache_write_per_mtok,
    multiplier, FALSE, 83, 'hidden',
    extra_system_prompt, default_effort, 0
  FROM model_pricing
  WHERE model_id = 'glm-5.2' AND enabled IS TRUE;

  INSERT INTO model_pricing (
    model_id, display_name,
    input_per_mtok, output_per_mtok,
    cache_read_per_mtok, cache_write_per_mtok,
    multiplier, enabled, sort_order, visibility,
    extra_system_prompt, default_effort, lock_version
  )
  SELECT
    'deepseek-v4-flash-opencode-go', 'DeepSeek V4 Flash (OpenCode Go)',
    input_per_mtok, output_per_mtok,
    cache_read_per_mtok, cache_write_per_mtok,
    multiplier, FALSE, 121, 'hidden',
    extra_system_prompt, default_effort, 0
  FROM model_pricing
  WHERE model_id = 'deepseek-v4-flash' AND enabled IS TRUE;

  -- Production already has these models disabled, while a clean historical migration replay
  -- still leaves them active. Preserve either execution state and only fix stale public visibility.
  UPDATE model_pricing
     SET visibility = 'hidden',
         lock_version = lock_version + 1,
         updated_at = now()
   WHERE model_id IN ('qwen3.7-max', 'qwen3.7-plus')
     AND visibility IS DISTINCT FROM 'hidden';

  IF (
    SELECT count(*)
      FROM model_catalog
     WHERE (
       model_id = 'glm-5.3'
       AND engine = 'ccb'
       AND provider_id = 'ark'
       AND upstream_model_id = 'glm-5.3'
       AND context_window = 1000000
       AND capability_schema_version = 1
       AND capability_profile = '{
         "supports_vision": false,
         "reasoning": { "supported": ["high", "max"], "codex_model_default": null },
         "ccb": { "capability_zero": true, "supports_thinking": true }
       }'::jsonb
       AND state = 'disabled'
     ) OR (
       model_id = 'deepseek-v4-flash-opencode-go'
       AND engine = 'ccb'
       AND provider_id = 'opencodego'
       AND upstream_model_id = 'deepseek-v4-flash'
       AND context_window = 1000000
       AND capability_schema_version = 1
       AND capability_profile = '{
         "supports_vision": false,
         "reasoning": { "supported": [], "codex_model_default": null },
         "ccb": { "capability_zero": true, "supports_thinking": true }
       }'::jsonb
       AND state = 'disabled'
     )
  ) <> 2 THEN
    RAISE EXCEPTION '0211 target catalog verification failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM model_pricing target
      JOIN model_pricing source ON source.model_id = 'glm-5.2'
     WHERE target.model_id = 'glm-5.3'
       AND source.enabled IS TRUE
       AND target.input_per_mtok = source.input_per_mtok
       AND target.output_per_mtok = source.output_per_mtok
       AND target.cache_read_per_mtok = source.cache_read_per_mtok
       AND target.cache_write_per_mtok = source.cache_write_per_mtok
       AND target.multiplier = source.multiplier
       AND target.enabled IS FALSE
       AND target.display_name = 'GLM-5.3'
       AND target.sort_order = 83
       AND target.visibility = 'hidden'
       AND target.extra_system_prompt IS NOT DISTINCT FROM source.extra_system_prompt
       AND target.default_effort IS NOT DISTINCT FROM source.default_effort
       AND target.lock_version = 0
  ) THEN
    RAISE EXCEPTION '0211 glm-5.3 pricing copy verification failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM model_pricing target
      JOIN model_pricing source ON source.model_id = 'deepseek-v4-flash'
     WHERE target.model_id = 'deepseek-v4-flash-opencode-go'
       AND source.enabled IS TRUE
       AND target.input_per_mtok = source.input_per_mtok
       AND target.output_per_mtok = source.output_per_mtok
       AND target.cache_read_per_mtok = source.cache_read_per_mtok
       AND target.cache_write_per_mtok = source.cache_write_per_mtok
       AND target.multiplier = source.multiplier
       AND target.enabled IS FALSE
       AND target.display_name = 'DeepSeek V4 Flash (OpenCode Go)'
       AND target.sort_order = 121
       AND target.visibility = 'hidden'
       AND target.extra_system_prompt IS NOT DISTINCT FROM source.extra_system_prompt
       AND target.default_effort IS NOT DISTINCT FROM source.default_effort
       AND target.lock_version = 0
  ) THEN
    RAISE EXCEPTION '0211 OpenCode Go Flash pricing copy verification failed';
  END IF;

  IF (
    SELECT count(*)
      FROM model_catalog c
      JOIN model_pricing p USING (model_id)
     WHERE c.model_id IN ('qwen3.7-max', 'qwen3.7-plus')
       AND c.state IN ('staged', 'active', 'disabled')
       AND p.enabled = (c.state = 'active')
       AND p.visibility = 'hidden'
  ) <> 2 THEN
    RAISE EXCEPTION '0211 legacy Qwen visibility verification failed';
  END IF;

  IF fn_model_catalog_provider('GLM-5.3') <> 'ark'
     OR fn_model_catalog_provider('DeepSeek-V4-Flash-OpenCode-Go') <> 'opencodego'
     OR fn_model_catalog_context_window('glm-5.3') <> 1000000
     OR fn_model_catalog_context_window('deepseek-v4-flash-opencode-go') <> 1000000
     OR fn_model_catalog_capability('glm-5.3') IS DISTINCT FROM '{
       "supports_vision": false,
       "reasoning": { "supported": ["high", "max"], "codex_model_default": null },
       "ccb": { "capability_zero": true, "supports_thinking": true }
     }'::jsonb
     OR fn_model_catalog_capability('deepseek-v4-flash-opencode-go') IS DISTINCT FROM '{
       "supports_vision": false,
       "reasoning": { "supported": [], "codex_model_default": null },
       "ccb": { "capability_zero": true, "supports_thinking": true }
     }'::jsonb
  THEN
    RAISE EXCEPTION '0211 legacy compatibility helper verification failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_visibility_grants
     WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')
  ) THEN
    RAISE EXCEPTION '0211 must not grant hidden staged models';
  END IF;
END
$migration$;
