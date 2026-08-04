-- 0199_qwen38_codex_responses.sql
-- qwen3.8-max 从 Claude Code/Anthropic 兼容路径切换到 Codex/OpenAI Responses。
--
-- 0197 已建立管理员可见定价与唯一 CCB/Bailian active 版本。本迁移只做一次
-- catalog 状态机版本切换并设置该模型的 Codex 默认 effort；价格、可见性与启用态
-- 全部保持不变。迁移可在准确终态重跑，其它历史/当前形状一律 fail-loud。

LOCK TABLE model_catalog IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE model_pricing IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  v_total_count INTEGER;
  v_old_active_count INTEGER;
  v_old_retired_count INTEGER;
  v_new_active_count INTEGER;
  v_old_lock_version INTEGER;
  v_new_entry BIGINT;
  v_pricing_before model_pricing%ROWTYPE;
  v_pricing_after model_pricing%ROWTYPE;
  v_effort_changed BOOLEAN;
BEGIN
  SELECT count(*) INTO v_total_count
    FROM model_catalog
   WHERE model_id = 'qwen3.8-max';

  SELECT count(*) INTO v_old_active_count
    FROM model_catalog
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
     }'::jsonb;

  SELECT count(*) INTO v_old_retired_count
    FROM model_catalog
   WHERE model_id = 'qwen3.8-max'
     AND state = 'retired'
     AND engine = 'ccb'
     AND provider_id = 'bailian'
     AND upstream_model_id = 'qwen3.8-max'
     AND context_window = 983616
     AND capability_schema_version = 1
     AND capability_profile = '{
       "supports_vision": true,
       "reasoning": { "supported": [], "codex_model_default": null },
       "ccb": { "capability_zero": true, "supports_thinking": true }
     }'::jsonb;

  SELECT count(*) INTO v_new_active_count
    FROM model_catalog
   WHERE model_id = 'qwen3.8-max'
     AND state = 'active'
     AND engine = 'codex'
     AND provider_id = 'codex'
     AND upstream_model_id = 'qwen3.8-max'
     AND context_window = 983616
     AND capability_schema_version = 1
     AND capability_profile = '{
       "supports_vision": true,
       "reasoning": {
         "supported": ["low", "medium", "xhigh"],
         "codex_model_default": "xhigh"
       },
       "ccb": { "capability_zero": false, "supports_thinking": false }
     }'::jsonb;

  IF v_total_count = 1 AND v_old_active_count = 1
     AND v_old_retired_count = 0 AND v_new_active_count = 0 THEN
    SELECT lock_version INTO v_old_lock_version
      FROM model_catalog
     WHERE model_id = 'qwen3.8-max' AND state = 'active'
       FOR UPDATE;

    SELECT fn_model_switch_version(
      'qwen3.8-max',
      'codex',
      'codex',
      'qwen3.8-max',
      983616,
      '{
        "supports_vision": true,
        "reasoning": {
          "supported": ["low", "medium", "xhigh"],
          "codex_model_default": "xhigh"
        },
        "ccb": { "capability_zero": false, "supports_thinking": false }
      }'::jsonb,
      1,
      NULL,
      v_old_lock_version
    ) INTO v_new_entry;
  ELSIF NOT (
    v_total_count = 2 AND v_old_active_count = 0
    AND v_old_retired_count = 1 AND v_new_active_count = 1
  ) THEN
    RAISE EXCEPTION
      '0199 qwen3.8-max catalog predecessor/terminal verification failed (total %, old_active %, old_retired %, new_active %)',
      v_total_count, v_old_active_count, v_old_retired_count, v_new_active_count;
  END IF;

  IF (SELECT count(*) FROM model_catalog WHERE model_id = 'qwen3.8-max') <> 2
     OR (SELECT count(*) FROM model_catalog
          WHERE model_id = 'qwen3.8-max' AND state = 'retired'
            AND engine = 'ccb' AND provider_id = 'bailian'
            AND upstream_model_id = 'qwen3.8-max') <> 1
     OR (SELECT count(*) FROM model_catalog
          WHERE model_id = 'qwen3.8-max' AND state = 'active'
            AND engine = 'codex' AND provider_id = 'codex'
            AND upstream_model_id = 'qwen3.8-max'
            AND context_window = 983616
            AND capability_schema_version = 1
            AND capability_profile = '{
              "supports_vision": true,
              "reasoning": {
                "supported": ["low", "medium", "xhigh"],
                "codex_model_default": "xhigh"
              },
              "ccb": { "capability_zero": false, "supports_thinking": false }
            }'::jsonb) <> 1 THEN
    RAISE EXCEPTION '0199 qwen3.8-max catalog terminal verification failed';
  END IF;

  SELECT * INTO v_pricing_before
    FROM model_pricing
   WHERE model_id = 'qwen3.8-max'
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '0199 requires the qwen3.8-max pricing row from 0197';
  END IF;

  v_effort_changed := v_pricing_before.default_effort IS DISTINCT FROM 'xhigh';
  IF v_effort_changed THEN
    UPDATE model_pricing
       SET default_effort = 'xhigh',
           lock_version = lock_version + 1,
           updated_at = NOW()
     WHERE model_id = 'qwen3.8-max';
  END IF;

  SELECT * INTO v_pricing_after
    FROM model_pricing
   WHERE model_id = 'qwen3.8-max';

  IF v_pricing_after.default_effort IS DISTINCT FROM 'xhigh'
     OR v_pricing_after.display_name IS DISTINCT FROM v_pricing_before.display_name
     OR v_pricing_after.input_per_mtok IS DISTINCT FROM v_pricing_before.input_per_mtok
     OR v_pricing_after.output_per_mtok IS DISTINCT FROM v_pricing_before.output_per_mtok
     OR v_pricing_after.cache_read_per_mtok IS DISTINCT FROM v_pricing_before.cache_read_per_mtok
     OR v_pricing_after.cache_write_per_mtok IS DISTINCT FROM v_pricing_before.cache_write_per_mtok
     OR v_pricing_after.multiplier IS DISTINCT FROM v_pricing_before.multiplier
     OR v_pricing_after.enabled IS DISTINCT FROM v_pricing_before.enabled
     OR v_pricing_after.sort_order IS DISTINCT FROM v_pricing_before.sort_order
     OR v_pricing_after.visibility IS DISTINCT FROM v_pricing_before.visibility
     OR v_pricing_after.extra_system_prompt IS DISTINCT FROM v_pricing_before.extra_system_prompt
     OR v_pricing_after.updated_by IS DISTINCT FROM v_pricing_before.updated_by
     OR v_pricing_after.lock_version IS DISTINCT FROM (
       v_pricing_before.lock_version + CASE WHEN v_effort_changed THEN 1 ELSE 0 END
     ) THEN
    RAISE EXCEPTION '0199 qwen3.8-max pricing/default effort verification failed';
  END IF;
END $$;
