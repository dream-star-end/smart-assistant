-- 0063_gpt_official_pricing_and_public_visibility.sql
-- gpt-5.5: 占位价 → OpenAI 官方实价,同时 visibility='admin' → 'public' 放开给所有登录用户。
-- Boss 2026-05-11 决策(沿 0062 DeepSeek 同形,一次完成定价 + 放开)。
--
-- 价格来源(权威):OpenAI 官方 API 定价页 https://openai.com/api/pricing/
--   - input  $5/Mtok     → 500
--   - output $30/Mtok    → 3000
--   - cached input $0.5/Mtok → 50(列名 cache_read_per_mtok)
--   - cache_write: OpenAI 不收 explicit write fee → 0
--     (codex 容器经 Anthropic-shape conversion 仍 emit cache_creation_input_tokens
--      并被 userChatBridge 映射到 cache_write_tokens,× 0 = 0 即不冤枉用户;
--      若日后 OpenAI 引入 write fee,单独 migration 调整。)
--
-- 单位约定(沿 0007 / 0020):*_per_mtok = 分(人民币)/ 1M tokens,1¥ = $1 对齐。
-- multiplier 不动(2.000,渠道加价策略由 admin UI 单独决策)。
--
-- 已知留白(本 migration 不处理,留 TODO):
--   长 context (>270K) OpenAI 实价翻倍($10 input / $45 output),v3 model_pricing
--   schema 单档无法表达分档。短期影响小,后续若需精确化需扩 schema 加
--   long_ctx_threshold + long_ctx_*_per_mtok 列,或 calculator 内 by-context 分支。
--
-- visibility='public' 行为(同 0062 / pricing.ts listForUser / authzModels.canUseModel):
--   - 登录用户 modelPicker 列出 gpt-5.5
--   - canUseModel 直接 return true(不查 grants)
--   - /api/public/models 给匿名访客也列出(无登录则无 chat 路径,接受此副作用)
--
-- pricing_changed NOTIFY(0008 trigger,table-level)在 UPDATE 时自动触发
-- master gateway 进程的 PricingCache 失效重载;重启后 cache 也从 DB 重装,无需额外
-- invalidate。
--
-- 断言 ROW_COUNT = 1:0050 历史 seed gpt-5.5 行后理论永久存在;若环境 drift 致
-- UPDATE 0 行,DO block 抛错使 deploy 早失败,胜过静默"看似成功"。

DO $$
DECLARE
  affected INT;
BEGIN
  UPDATE model_pricing
     SET input_per_mtok       = 500,
         output_per_mtok      = 3000,
         cache_read_per_mtok  = 50,
         cache_write_per_mtok = 0,
         visibility           = 'public'
   WHERE model_id = 'gpt-5.5';

  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0063: expected exactly 1 row updated for gpt-5.5 (seeded by 0050), got %', affected;
  END IF;
END $$;
