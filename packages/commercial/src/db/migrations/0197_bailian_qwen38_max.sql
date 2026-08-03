-- 0197_bailian_qwen38_max.sql
-- 阿里云百炼 Token Plan 的正式 Qwen3.8 Max 管理员入口。
--
-- provider/CCB/runtime plumbing 已先独立发布并建立双 release 回退地板；本迁移只新增
-- catalog + pricing 数据。定价逐字段复制当前启用的 qwen3.7-max，按同一商业档位先做
-- 管理员验证，后续公开必须另走独立 migration。

DO $$
DECLARE
  source_count INTEGER;
BEGIN
  SELECT count(*) INTO source_count
    FROM model_pricing
   WHERE model_id = 'qwen3.7-max' AND enabled IS TRUE;

  IF source_count <> 1 THEN
    RAISE EXCEPTION
      '0197 requires exactly one enabled qwen3.7-max pricing source, found %',
      source_count;
  END IF;

  -- catalog 必须先于 pricing：provider/upstream/context/capability 都由模型权威描述符
  -- 下发给 CCB，不能让 pricing 兼容触发器先生成 anthropic fallback 行。
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id = 'qwen3.8-max' AND state IN ('staged', 'active', 'disabled')
  ) THEN
    PERFORM fn_model_stage_version(
      'qwen3.8-max',
      'ccb',
      'bailian',
      'qwen3.8-max',
      983616,
      '{
        "supports_vision": true,
        "reasoning": { "supported": [], "codex_model_default": null },
        "ccb": { "capability_zero": true, "supports_thinking": true }
      }'::jsonb,
      1,
      NULL
    );
    PERFORM fn_model_activate('qwen3.8-max', NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id = 'qwen3.8-max'
       AND state = 'active'
       AND engine = 'ccb'
       AND provider_id = 'bailian'
       AND upstream_model_id = 'qwen3.8-max'
       AND context_window = 983616
       AND capability_schema_version = 1
       AND capability_profile = '{
         "supports_vision": true,
         "reasoning": { "supported": [], "codex_model_default": null },
         "ccb": { "capability_zero": true, "supports_thinking": true }
       }'::jsonb
  ) THEN
    RAISE EXCEPTION '0197 qwen3.8-max catalog verification failed';
  END IF;

  INSERT INTO model_pricing (
    model_id, display_name,
    input_per_mtok, output_per_mtok,
    cache_read_per_mtok, cache_write_per_mtok,
    multiplier, enabled, sort_order, visibility
  )
  SELECT
    'qwen3.8-max', 'Qwen3.8 Max',
    input_per_mtok, output_per_mtok,
    cache_read_per_mtok, cache_write_per_mtok,
    multiplier, enabled, 88, 'admin'
  FROM model_pricing
  WHERE model_id = 'qwen3.7-max' AND enabled IS TRUE
  ON CONFLICT (model_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
      FROM model_pricing target
      JOIN model_pricing source ON source.model_id = 'qwen3.7-max'
     WHERE target.model_id = 'qwen3.8-max'
       AND source.enabled IS TRUE
       AND target.input_per_mtok = source.input_per_mtok
       AND target.output_per_mtok = source.output_per_mtok
       AND target.cache_read_per_mtok = source.cache_read_per_mtok
       AND target.cache_write_per_mtok = source.cache_write_per_mtok
       AND target.multiplier = source.multiplier
       AND target.enabled = source.enabled
       AND target.display_name = 'Qwen3.8 Max'
       AND target.sort_order = 88
       AND target.visibility = 'admin'
  ) THEN
    RAISE EXCEPTION '0197 qwen3.8-max pricing copy verification failed';
  END IF;
END $$;
