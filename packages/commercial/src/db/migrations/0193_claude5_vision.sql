-- 0193_claude5_vision.sql
-- 把 claude-opus-5 / claude-fable-5 的 capability_profile.supports_vision 由 false 修正为 true。
--
-- 背景:0191 接入这两个模型时只插 model_pricing,catalog 行由 BEFORE 守卫
-- fn_model_catalog_ensure_for_pricing() 派生。派生函数 fn_model_catalog_capability 的 ELSE 分支
-- 给出 supports_vision=false,而 Claude 官方模型均支持原生视觉输入(Opus 5 / Fable 5 更属
-- 高分辨率视觉档)—— 机制正确、数据不符实,与 0154 时代 gpt-5.6 的同型问题一致。
--
-- ⚠️ 为什么不能 UPDATE:capability_profile 是**执行字段**,fn_model_catalog_guard() 对 active
-- 条目一律拒绝原地改(0191 实测报错:
--   ERROR: model_catalog: execution fields of a active entry are immutable
--          (entry 34, model claude-fable-5); use fn_model_switch_version()）。
-- 执行字段不可变是模型权威机制的核心保护:签名 descriptor 才能稳定,避免 master 按 A 计费
-- 而容器跑 B。唯一合法通道 = fn_model_switch_version()(单事务内 旧行→disabled→retired、
-- 新行 staged→active、model_aliases 重指),先例见 0183_luna_verification_runs.sql。
--
-- 上线影响面(动执行面前已核对):
--   · switch 全程在单事务内完成,对其他会话不存在"无 active 行"的中间态;
--   · epoch 是**容器侧单调水位**(server.ts:1834 验签消费器 = keyring + 容器身份 + epoch 水位
--     + replay cache)。turn 开始时已完成验签,执行期间不再重验 → 不打断 in-flight turn;
--     新 turn 拿到更高 epoch 的 descriptor,正常放行。
--   · profile 仅翻一个布尔、schema 形状与键名不变(全 snake_case),不会重演 0160 那次
--     camelCase 导致 catalog 快照 fail-closed 重建失败 → 模型面 503 的事故。
--
-- ⚠️ lock_version 必须**动态读**,不得硬编码:生产当前是 1(boss 07-26 14:26 在管理后台下调
-- multiplier,经 pricing enabled 路由 bump 过),而 CI fresh DB 走完 0191 后是 0。fn_model_switch_version
-- 的 p_expected_lock_version 是乐观锁,写死任一值都会在另一侧 serialization_failure。
--
-- 幂等 + fail-closed:已是 desired 形态则跳过(可重复 apply);既非 desired 也非 0191 派生的
-- legacy 形态 → RAISE(说明 catalog 被别的批次改过,宁可挡住也不盲切)。
--
-- 本迁移**不碰定价**:结尾有一道自校验,比对四个 per_mtok + multiplier + enabled + visibility
-- 在 switch 前后逐字节相同。特别是 multiplier —— 生产的 1.500 是 boss 的运营决策(0191 迁移
-- 里写的是 2.500),任何执行面变更都不得把它带回去。
--
-- Manual rollback:再走一次 fn_model_switch_version 把 profile 切回 legacy 形态即可(同样在
-- §4.5 的 advisory lock + transaction + SET LOCAL ROLE openclaude 纪律下),ledger 行保留:
--
--   DO $$
--   DECLARE m TEXT; v_lock INTEGER; v_state TEXT;
--     legacy JSONB := '{"supports_vision": false, "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": null}, "ccb": {"capability_zero": false, "supports_thinking": true}}'::jsonb;
--   BEGIN
--     FOREACH m IN ARRAY ARRAY['claude-opus-5','claude-fable-5'] LOOP
--       SELECT lock_version INTO v_lock FROM model_catalog
--        WHERE model_id = m AND state = 'active';
--       PERFORM fn_model_switch_version(m,'ccb','anthropic',NULL,200000,legacy,1,NULL,v_lock);
--       SELECT state INTO v_state FROM model_catalog
--        WHERE model_id = m AND state IN ('staged','active');
--       IF v_state = 'staged' THEN PERFORM fn_model_activate(m, NULL); END IF;
--     END LOOP;
--   END $$;

DO $$
DECLARE
  -- 0191 派生出的形态(reasoning.supported 是 JSONB 数组 → 比较对顺序敏感,按派生函数的实际
  -- 产出顺序书写,已与生产 jsonb_pretty 输出逐项核对)。
  legacy_profile JSONB := '{
    "supports_vision": false,
    "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": null},
    "ccb": {"capability_zero": false, "supports_thinking": true}
  }'::jsonb;
  desired_profile JSONB := '{
    "supports_vision": true,
    "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": null},
    "ccb": {"capability_zero": false, "supports_thinking": true}
  }'::jsonb;
  targets TEXT[] := ARRAY['claude-opus-5', 'claude-fable-5'];
  m TEXT;
  v_entry BIGINT;
  v_state TEXT;
  v_lock INTEGER;
  switched INTEGER := 0;
  pricing_before JSONB;
  pricing_after JSONB;
BEGIN
  -- 计费面基线快照(结尾比对,证明本迁移零定价副作用)。
  SELECT jsonb_agg(jsonb_build_object(
           'model', model_id, 'in', input_per_mtok, 'out', output_per_mtok,
           'cr', cache_read_per_mtok, 'cw', cache_write_per_mtok,
           'mult', multiplier, 'enabled', enabled, 'visibility', visibility
         ) ORDER BY model_id)
    INTO pricing_before
    FROM model_pricing WHERE model_id = ANY(targets);

  IF pricing_before IS NULL OR jsonb_array_length(pricing_before) <> 2 THEN
    RAISE EXCEPTION '0193 requires both Claude 5 pricing rows to exist (0191 must be applied first)';
  END IF;

  FOREACH m IN ARRAY targets LOOP
    -- 幂等:已经是目标形态就跳过(允许重复 apply)。
    IF EXISTS (
      SELECT 1 FROM model_catalog
       WHERE model_id = m AND state IN ('staged','active')
         AND capability_profile = desired_profile
    ) THEN
      CONTINUE;
    END IF;

    -- fail-closed:只接受 0191 派生的那一种 predecessor 形态,其余一律挡住。
    SELECT entry_id, state, lock_version INTO v_entry, v_state, v_lock
      FROM model_catalog
     WHERE model_id = m
       AND state IN ('staged','active')
       AND engine = 'ccb'
       AND provider_id = 'anthropic'
       AND upstream_model_id IS NULL
       AND context_window = 200000
       AND capability_schema_version = 1
       AND capability_profile = legacy_profile
     ORDER BY (state = 'active') DESC, entry_id DESC
     LIMIT 1;

    IF v_entry IS NULL THEN
      RAISE EXCEPTION '0193: model % has neither the target profile nor the exact 0191-derived predecessor; catalog drifted, refusing to switch', m;
    END IF;

    -- 执行字段整版替换:除 capability_profile 外全部按原值回传(engine/provider/upstream/ctx/schema_v)。
    PERFORM fn_model_switch_version(
      m, 'ccb', 'anthropic', NULL, 200000, desired_profile, 1, NULL, v_lock
    );
    switched := switched + 1;

    -- predecessor 若是 disabled/staged 血统,新行会停在 staged → 显式激活(同 0183)。
    SELECT state INTO v_state
      FROM model_catalog
     WHERE model_id = m AND state IN ('staged','active')
       AND capability_profile = desired_profile;
    IF v_state = 'staged' THEN
      PERFORM fn_model_activate(m, NULL);
    END IF;
  END LOOP;

  -- ── 终态断言 ────────────────────────────────────────────────────────────────────
  -- ① 两个模型都必须有 active 行、profile 为 desired、且执行字段与切换前一致。
  IF (
    SELECT count(*) FROM model_catalog c
     WHERE c.model_id = ANY(targets)
       AND c.state = 'active'
       AND c.capability_profile = desired_profile
       AND c.engine = 'ccb'
       AND c.provider_id = 'anthropic'
       AND c.upstream_model_id IS NULL
       AND c.context_window = 200000
       AND c.capability_schema_version = 1
  ) <> 2 THEN
    RAISE EXCEPTION '0193 post-state verification failed: expected 2 active vision-capable Claude 5 entries';
  END IF;

  -- ② 每个 model_id 只能有一条 live 行(uq_model_catalog_live 的语义,顺带证明旧行已 retired)。
  IF EXISTS (
    SELECT 1 FROM model_catalog WHERE model_id = ANY(targets)
       AND state IN ('staged','active')
     GROUP BY model_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0193 left more than one live catalog entry for a Claude 5 model';
  END IF;

  -- ③ 计费链路仍可解析(pricing ↔ active catalog JOIN 是定价的必要条件)。
  IF (
    SELECT count(*) FROM model_pricing p
      JOIN model_catalog c ON c.model_id = p.model_id AND c.state = 'active'
     WHERE p.model_id = ANY(targets)
  ) <> 2 THEN
    RAISE EXCEPTION '0193 broke the pricing↔catalog join for Claude 5 models';
  END IF;

  -- ④ 零定价副作用:四个 per_mtok + multiplier + enabled + visibility 必须逐字节未变。
  --    生产的 multiplier=1.500 是 boss 的运营决策,执行面变更绝不能把它带回 0191 的 2.500。
  SELECT jsonb_agg(jsonb_build_object(
           'model', model_id, 'in', input_per_mtok, 'out', output_per_mtok,
           'cr', cache_read_per_mtok, 'cw', cache_write_per_mtok,
           'mult', multiplier, 'enabled', enabled, 'visibility', visibility
         ) ORDER BY model_id)
    INTO pricing_after
    FROM model_pricing WHERE model_id = ANY(targets);

  IF pricing_before IS DISTINCT FROM pricing_after THEN
    RAISE EXCEPTION '0193 must not touch pricing; before=% after=%', pricing_before, pricing_after;
  END IF;

  RAISE NOTICE '0193: switched % Claude 5 catalog entry/entries to supports_vision=true', switched;
END $$;
