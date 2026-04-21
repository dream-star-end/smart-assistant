-- 0020_fix_opus_pricing.sql
-- 修复 Opus 4.7 定价:0007 种子残留了 Opus 4.0 的老价 ($15/$75),
-- 但官网 Opus 4.7 实际是 $5 input / $25 output(2026-04 platform.claude.com 确认)。
-- 按 1¥ = $1 对齐策略:
--   input_per_mtok:  1500 → 500   (¥5/Mtok)
--   output_per_mtok: 7500 → 2500  (¥25/Mtok)
-- cache 价按 Anthropic 标准比例(input × 0.1 read, input × 1.25 write/5min):
--   cache_read_per_mtok:  150  → 50
--   cache_write_per_mtok: 1875 → 625
--
-- multiplier 不动(2.0,业务策略保留),trigger 会自动 NOTIFY pricing_changed
-- 让运行中进程的 PricingCache 失效重载。
--
-- 安全:UPDATE 是幂等的,重跑无副作用。

UPDATE model_pricing
SET
  input_per_mtok       = 500,
  output_per_mtok      = 2500,
  cache_read_per_mtok  = 50,
  cache_write_per_mtok = 625
WHERE model_id = 'claude-opus-4-7';
