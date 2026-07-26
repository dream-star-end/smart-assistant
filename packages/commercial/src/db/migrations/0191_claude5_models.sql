-- 0191_claude5_models.sql
-- 接入 Claude 官方模型 claude-opus-5 与 claude-fable-5。
--
-- ⚠️ 接入范式(第一版写错过,记在这里):**只 INSERT model_pricing,不要手写 model_catalog**。
-- model_pricing 上有 BEFORE INSERT 守卫 trg_model_pricing_enabled_route →
-- fn_model_pricing_enabled_route() → fn_model_catalog_ensure_for_pricing(),它会:
--   ① catalog 已有该 model_id 的 staged/active/disabled 行 → 走 fn_model_catalog_apply_enabled;
--   ② 否则自动 INSERT catalog 行(engine/provider/context_window/capability 全部由
--      fn_model_catalog_{engine,provider,context_window,capability}(model_id) 派生,先 staged,
--      再按 p_enabled 激活),最后把 NEW.enabled 覆写成「catalog 是否 active」。
-- 手动先插一条 active catalog 行,守卫再 ensure 时会撞 uq_model_catalog_live
-- (model_id UNIQUE WHERE state IN ('staged','active')) → 整条迁移失败 → test DB schema
-- 初始化挂 → 大片 DB 用例 cancelledByParent(CI 实测 cancelled 202 vs base 0)。
-- 0179_ark_plan_kimi_k3 / 0186_ark_k3_public 同范式:全仓模型接入迁移都只碰 model_pricing。
--
-- 派生结果对这两个模型恰好全部正确(命中各函数的 ELSE 分支):
--   engine='ccb' / provider_id='anthropic' / context_window=200000
--   capability_profile={"supports_vision": false,
--                       "reasoning": {"supported": ["low".."max"], "codex_model_default": null},
--                       "ccb": {"capability_zero": false, "supports_thinking": true}}
-- 其中 supports_vision 被派生成 false,与实际能力不符(Claude 官方模型均支持视觉,Opus 5 /
-- Fable 5 更属高分辨率视觉档),但**本迁移不改它** —— capability_profile 是执行字段,active
-- 条目不可原地改(详见下方 supports_vision 段的实测报错)。既有三个 disabled 的官方 Claude
-- 行同样被 ELSE 派生成 false,是同一处历史残留,不是本批新引入的不一致。
--
-- 本迁移已在生产库事务内试跑并 ROLLBACK 验证通过:pricing 两行插入 → 守卫派生出
-- active/ccb/anthropic/200000 的 catalog 行 → 三道断言全过 → 零副作用回滚。
--
-- context_window=200000(派生值)而非官方规格的 1M:该值 driving auto-compact 阈值,而本批
-- 凭据走 claude_accounts 订阅账号池 OAuth,订阅侧的实际上下文上限未经活体验证 —— 取低只会
-- 更早触发压缩(不会失败),取高则可能在真实长会话里撞上游限制。验证后若确认可用 1M,
-- 单条 UPDATE 提升即可(1048576,参见 kimi-k3-ark 先例)。
--
-- 定价换算以既有 claude-opus-4-7 为锚点验证(官方 $5/$25 → 500/2500/50/625 ×2.500):
--   积分/Mtok = 官方美元 × 100;cache_read = input × 0.1;cache_write = input × 1.25;
--   官方 Claude 统一 multiplier = 2.500(第三方 provider 1.000,codex 0.800)。
--
--   claude-opus-5   官方 $5 / $25   →  500 / 2500 /  50 /  625  ×2.500
--   claude-fable-5  官方 $10 / $50  → 1000 / 5000 / 100 / 1250  ×2.500
--
-- Fable 5 在每个计费字段上都正好是 Opus 5 的 2 倍 —— 同时满足官方成本比例与产品定价要求。
-- Opus 5 的四个 per_mtok 与既有 claude-opus-4-7 完全一致(同价位),便于对账。
--
-- 已知限制(不在本迁移范围内,记录备查):Fable 5 的 thinking 永远开启,显式传
-- thinking:{type:'disabled'} 或 {type:'enabled',budget_tokens:N} 会被上游 400。若用户在前端
-- 关闭思考,该模型的 turn 会失败。彻底修复需在 CCB 侧对 fable/mythos 系跳过 thinking 参数
-- (走 runtime release 轴),留作独立批次。Opus 5 无此问题(仅 disabled + effort>high 才 400)。
--
-- Manual rollback(不要删除 0191 的 schema_migrations 账本行):在 V5_DEV_PLAYBOOK.md §4.5 的
-- advisory lock + transaction + SET LOCAL ROLE openclaude 纪律下,仅当两行仍处于本迁移的
-- post-state 时执行。注意删 pricing 会触发 BEFORE DELETE 守卫
-- trg_model_pricing_delete_cascade → fn_model_pricing_delete_cascade(),catalog 侧由它级联处理,
-- 不要再手工删 catalog 行:
--
--   DO $$
--   DECLARE affected INTEGER;
--   BEGIN
--     DELETE FROM model_pricing
--      WHERE model_id IN ('claude-opus-5', 'claude-fable-5')
--        AND multiplier = 2.500
--        AND visibility = 'public';
--     GET DIAGNOSTICS affected = ROW_COUNT;
--     IF affected <> 2 THEN
--       RAISE EXCEPTION '0191 rollback expected exactly 2 unchanged pricing rows, got %', affected;
--     END IF;
--   END $$;
--
-- 回滚后若要重新接入,需要新的迁移。
-- 紧急下线(保留行、仅停止对用户可见)优先走管理后台,或:
--   UPDATE model_pricing SET enabled = FALSE, visibility = 'hidden',
--          lock_version = lock_version + 1, updated_at = NOW()
--    WHERE model_id IN ('claude-opus-5', 'claude-fable-5');
-- (enabled=FALSE 会经 fn_model_catalog_apply_enabled 把 catalog 一并转为 disabled。)

DO $$
DECLARE
  affected INTEGER;
BEGIN
  -- ── pricing:唯一入口。catalog 行由 BEFORE 守卫派生并激活(见文件头说明)──────────
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

  -- ── 关于 supports_vision:本迁移**不**改它 ───────────────────────────────────────
  -- fn_model_catalog_capability 的 ELSE 分支把 supports_vision 派生成 false,而 Claude 官方
  -- 模型实际都支持视觉输入(Opus 5 / Fable 5 更属高分辨率视觉档)。第一版迁移尝试用
  --   UPDATE model_catalog SET capability_profile = jsonb_set(..., '{supports_vision}', 'true')
  -- 补正,被 fn_model_catalog_guard() 拒绝(生产事务内试跑实测):
  --   ERROR: model_catalog: execution fields of a active entry are immutable
  --          (entry 34, model claude-fable-5); use fn_model_switch_version()
  -- capability_profile 属于**执行字段**,active 条目不可原地改 —— 这是模型权威机制的核心
  -- 保护(执行字段不可变才能让签名 descriptor 稳定,避免 master 按 A 计费而容器跑 B)。
  -- 正确改法是走 fn_model_switch_version() 切一个新版本,属于独立的执行面变更,不该塞进
  -- 本批(本批只做接入 + 定价)。故这里保持派生值,与既有三个 disabled 的官方 Claude 行
  -- 一致 —— 不是本批新引入的不一致。
  -- 影响面:仅识图能力标记,**不影响计费**;需要时另开一批用 fn_model_switch_version 处理。

  -- ── 计费可解析性自校验 ──────────────────────────────────────────────────────────
  -- 计费链路按 model_id JOIN catalog ↔ pricing;任一侧缺行或字段不符都会让 turn 无法定价。
  -- 这里把守卫派生的结果与 pricing 一起断言,确保「守卫真的建出了预期的 active 行」。
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
       AND c.capability_profile -> 'ccb' ->> 'supports_thinking' = 'true'
       AND c.capability_profile -> 'reasoning' -> 'supported' ? 'max'
       AND c.capability_profile -> 'reasoning' -> 'supported' ? 'xhigh'
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
       AND c.capability_profile -> 'ccb' ->> 'supports_thinking' = 'true'
       AND c.capability_profile -> 'reasoning' -> 'supported' ? 'max'
       AND c.capability_profile -> 'reasoning' -> 'supported' ? 'xhigh'
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
