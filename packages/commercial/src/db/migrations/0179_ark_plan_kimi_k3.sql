-- 0179_ark_plan_kimi_k3.sql
-- 火山方舟 Agent Plan 的 Kimi K3 管理员专用入口。
--
-- kimi-k3-ark 是平台 canonical model id；发往火山的 upstream model 固定为
-- kimi-k3。定价逐字段复制已经上线的 Moonshot 官方 kimi-k3，避免两条 K3
-- 入口出现人工抄价漂移。visibility='admin' 让管理员默认可见，普通用户仅在
-- 显式 grant 后可见。

DO $$
DECLARE
  source_count INTEGER;
BEGIN
  SELECT count(*) INTO source_count
    FROM model_pricing
   WHERE model_id = 'kimi-k3' AND enabled IS TRUE;

  IF source_count <> 1 THEN
    RAISE EXCEPTION
      '0179 requires exactly one enabled kimi-k3 pricing source, found %',
      source_count;
  END IF;

  -- catalog 必须先于 pricing：0143 的 pricing 兼容触发器不认识新 alias，若先写
  -- pricing 会错误兜底成 anthropic/200k。
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id = 'kimi-k3-ark' AND state IN ('staged', 'active', 'disabled')
  ) THEN
    PERFORM fn_model_stage_version(
      'kimi-k3-ark',
      'ccb',
      'ark-k3',
      'kimi-k3',
      1048576,
      '{
        "supports_vision": true,
        "reasoning": { "supported": [], "codex_model_default": null },
        "ccb": { "capability_zero": true, "supports_thinking": true }
      }'::jsonb,
      1,
      NULL
    );
    PERFORM fn_model_activate('kimi-k3-ark', NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id = 'kimi-k3-ark'
       AND state = 'active'
       AND engine = 'ccb'
       AND provider_id = 'ark-k3'
       AND upstream_model_id = 'kimi-k3'
       AND context_window = 1048576
       AND capability_schema_version = 1
       AND capability_profile = '{
         "supports_vision": true,
         "reasoning": { "supported": [], "codex_model_default": null },
         "ccb": { "capability_zero": true, "supports_thinking": true }
       }'::jsonb
  ) THEN
    RAISE EXCEPTION '0179 kimi-k3-ark catalog verification failed';
  END IF;

  INSERT INTO model_pricing (
    model_id, display_name,
    input_per_mtok, output_per_mtok,
    cache_read_per_mtok, cache_write_per_mtok,
    multiplier, enabled, sort_order, visibility
  )
  SELECT
    'kimi-k3-ark', 'Kimi K3（火山 Agent Plan）',
    input_per_mtok, output_per_mtok,
    cache_read_per_mtok, cache_write_per_mtok,
    multiplier, enabled, 89, 'admin'
  FROM model_pricing
  WHERE model_id = 'kimi-k3'
  ON CONFLICT (model_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
      FROM model_pricing target
      JOIN model_pricing source ON source.model_id = 'kimi-k3'
     WHERE target.model_id = 'kimi-k3-ark'
       AND target.input_per_mtok = source.input_per_mtok
       AND target.output_per_mtok = source.output_per_mtok
       AND target.cache_read_per_mtok = source.cache_read_per_mtok
       AND target.cache_write_per_mtok = source.cache_write_per_mtok
       AND target.multiplier = source.multiplier
       AND target.enabled = source.enabled
       AND target.display_name = 'Kimi K3（火山 Agent Plan）'
       AND target.sort_order = 89
       AND target.visibility = 'admin'
  ) THEN
    RAISE EXCEPTION '0179 kimi-k3-ark pricing copy verification failed';
  END IF;
END $$;
