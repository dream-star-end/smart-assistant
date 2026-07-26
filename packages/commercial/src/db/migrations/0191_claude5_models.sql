-- 0191_claude5_models.sql
-- 接入 Claude 官方模型 claude-opus-5 与 claude-fable-5(engine=ccb / provider=anthropic)。
--
-- 定价换算沿用既有官方 Claude 行的规律(以 claude-opus-4-7 为锚点验证):
--   积分/Mtok = 官方美元价 × 100;cache_read = input × 0.1;cache_write = input × 1.25;
--   官方 Claude 统一 multiplier = 2.500(第三方 provider 为 1.000,codex 为 0.800)。
--
--   claude-opus-5   官方 $5 / $25   →  500 / 2500 / 50  / 625   ×2.500
--   claude-fable-5  官方 $10 / $50  → 1000 / 5000 / 100 / 1250  ×2.500
--
-- Fable 5 在每一个计费字段上都正好是 Opus 5 的 2 倍 —— 这同时满足官方成本比例与产品定价要求。
-- Opus 5 的四个 per_mtok 值与既有 claude-opus-4-7 完全一致(同价位),便于对账。
--
-- context_window = 200000:与既有官方 Claude 行(claude-opus-4-7 / claude-sonnet-4-6 /
-- claude-haiku-4-5)保持一致,而非官方规格的 1M。该值用于 auto-compact 阈值与 UI 显示;
-- 本批凭据走 claude_accounts 订阅账号池 OAuth,订阅侧的实际上下文上限未经活体验证,
-- 取低值只会更早触发压缩(不会失败),取高值则可能在真实长会话里撞上游限制。
-- 验证后若确认可用 1M,单条 UPDATE 提升即可(1048576,参见 kimi-k3-ark 先例)。
--
-- capability_profile 为 snake_case(铁律:camelCase 会让生产 catalog 快照重建 fail-closed →
-- 模型面 503,见 0160 事故与 migrationCapabilityProfiles.test.ts 契约)。
-- 与既有官方 Claude 行的唯一差异是 supports_vision = true —— 既有三行标 false 是数据错误,
-- Claude 官方模型均支持视觉输入,且 Opus 5 / Fable 5 属高分辨率视觉档。
-- reasoning.supported 覆盖五档:两个模型都支持完整 effort ladder(low..max)。这条声明是
-- CCB 侧 getAuthorityModelCapabilities 的权威来源,因此 effort 放行无需改动 CCB 硬编码白名单。
--
-- 已知限制(不在本迁移范围内,记录备查):Fable 5 的 thinking 永远开启,显式传
-- thinking:{type:'disabled'} 或 {type:'enabled',budget_tokens:N} 会被上游 400。若用户在
-- 前端关闭思考,该模型的 turn 会失败。彻底修复需在 CCB 侧对 fable/mythos 系跳过 thinking
-- 参数(走 runtime release 轴),留作独立批次。
--
-- Manual rollback(不要删除 0191 的 schema_migrations 账本行):在 V5_DEV_PLAYBOOK.md §4.5
-- 的 advisory lock + transaction + SET LOCAL ROLE openclaude 纪律下,仅当两行仍处于本迁移
-- 的 post-state 时执行:
--
--   DO $$
--   DECLARE affected INTEGER;
--   BEGIN
--     DELETE FROM model_pricing
--      WHERE model_id IN ('claude-opus-5', 'claude-fable-5')
--        AND multiplier = 2.500
--        AND visibility = 'public'
--        AND enabled IS TRUE;
--     GET DIAGNOSTICS affected = ROW_COUNT;
--     IF affected <> 2 THEN
--       RAISE EXCEPTION '0191 rollback expected exactly 2 unchanged pricing rows, got %', affected;
--     END IF;
--
--     DELETE FROM model_catalog
--      WHERE model_id IN ('claude-opus-5', 'claude-fable-5')
--        AND state = 'active'
--        AND provider_id = 'anthropic';
--     GET DIAGNOSTICS affected = ROW_COUNT;
--     IF affected <> 2 THEN
--       RAISE EXCEPTION '0191 rollback expected exactly 2 unchanged catalog rows, got %', affected;
--     END IF;
--   END $$;
--
-- 回滚后若要重新接入,需要新的迁移。
-- 紧急下线(保留行、仅停止对用户可见)优先走管理后台,或:
--   UPDATE model_pricing SET enabled = FALSE, visibility = 'hidden',
--          lock_version = lock_version + 1, updated_at = NOW()
--    WHERE model_id IN ('claude-opus-5', 'claude-fable-5');

DO $$
DECLARE
  affected INTEGER;
BEGIN
  -- ── catalog:两条 active 行 ────────────────────────────────────────────────
  -- uq_model_catalog_live 约束 model_id 在 state ∈ {staged, active} 内唯一;
  -- 这两个 model_id 此前不存在任何行,故直接 INSERT。
  INSERT INTO model_catalog (
    model_id, engine, provider_id, upstream_model_id, context_window,
    capability_profile, capability_schema_version, state, lock_version
  )
  VALUES
    (
      'claude-opus-5', 'ccb', 'anthropic', NULL, 200000,
      '{"ccb": {"capability_zero": false, "supports_thinking": true}, "reasoning": {"supported": ["low", "medium", "high", "xhigh", "max"], "codex_model_default": null}, "supports_vision": true}'::jsonb,
      1, 'active', 0
    ),
    (
      'claude-fable-5', 'ccb', 'anthropic', NULL, 200000,
      '{"ccb": {"capability_zero": false, "supports_thinking": true}, "reasoning": {"supported": ["low", "medium", "high", "xhigh", "max"], "codex_model_default": null}, "supports_vision": true}'::jsonb,
      1, 'active', 0
    );

  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 2 THEN
    RAISE EXCEPTION '0191 expected exactly 2 catalog inserts, got %', affected;
  END IF;

  -- ── pricing:两条 enabled/public 行 ───────────────────────────────────────
  INSERT INTO model_pricing (
    model_id, display_name,
    input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
    multiplier, enabled, sort_order, visibility, lock_version
  )
  VALUES
    ('claude-opus-5',  'Claude Opus 5',   500, 2500,  50,  625, 2.500, TRUE, 140, 'public', 0),
    ('claude-fable-5', 'Claude Fable 5', 1000, 5000, 100, 1250, 2.500, TRUE, 141, 'public', 0);

  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 2 THEN
    RAISE EXCEPTION '0191 expected exactly 2 pricing inserts, got %', affected;
  END IF;

  -- ── 计费可解析性自校验 ────────────────────────────────────────────────────
  -- 计费链路按 model_id JOIN catalog ↔ pricing;任一侧缺行都会让 turn 无法定价。
  -- 这里把两侧的 JOIN 与关键字段一起断言,避免只插了一半就放行。
  IF NOT EXISTS (
    SELECT 1
      FROM model_pricing p
      JOIN model_catalog c
        ON c.model_id = p.model_id
       AND c.state = 'active'
     WHERE p.model_id = 'claude-opus-5'
       AND p.input_per_mtok = 500
       AND p.output_per_mtok = 2500
       AND p.cache_read_per_mtok = 50
       AND p.cache_write_per_mtok = 625
       AND p.multiplier = 2.500
       AND p.enabled IS TRUE
       AND p.visibility = 'public'
       AND c.engine = 'ccb'
       AND c.provider_id = 'anthropic'
       AND c.context_window = 200000
       AND c.capability_profile -> 'ccb' ->> 'capability_zero' = 'false'
       AND c.capability_profile ->> 'supports_vision' = 'true'
       AND c.capability_profile -> 'reasoning' -> 'supported' ? 'max'
  ) THEN
    RAISE EXCEPTION '0191 claude-opus-5 catalog/pricing verification failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM model_pricing p
      JOIN model_catalog c
        ON c.model_id = p.model_id
       AND c.state = 'active'
     WHERE p.model_id = 'claude-fable-5'
       AND p.input_per_mtok = 1000
       AND p.output_per_mtok = 5000
       AND p.cache_read_per_mtok = 100
       AND p.cache_write_per_mtok = 1250
       AND p.multiplier = 2.500
       AND p.enabled IS TRUE
       AND p.visibility = 'public'
       AND c.engine = 'ccb'
       AND c.provider_id = 'anthropic'
       AND c.context_window = 200000
       AND c.capability_profile -> 'ccb' ->> 'capability_zero' = 'false'
       AND c.capability_profile ->> 'supports_vision' = 'true'
       AND c.capability_profile -> 'reasoning' -> 'supported' ? 'max'
  ) THEN
    RAISE EXCEPTION '0191 claude-fable-5 catalog/pricing verification failed';
  END IF;

  -- Fable 5 的每个计费字段必须正好是 Opus 5 的两倍(产品定价要求 + 官方成本比例)。
  IF NOT EXISTS (
    SELECT 1
      FROM model_pricing f, model_pricing o
     WHERE f.model_id = 'claude-fable-5'
       AND o.model_id = 'claude-opus-5'
       AND f.input_per_mtok       = o.input_per_mtok * 2
       AND f.output_per_mtok      = o.output_per_mtok * 2
       AND f.cache_read_per_mtok  = o.cache_read_per_mtok * 2
       AND f.cache_write_per_mtok = o.cache_write_per_mtok * 2
       AND f.multiplier           = o.multiplier
  ) THEN
    RAISE EXCEPTION '0191 fable-5 must be exactly 2x opus-5 on every billing field';
  END IF;
END $$;
