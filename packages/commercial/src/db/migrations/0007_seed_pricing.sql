-- 0007_seed_pricing.sql
-- 初始种子:model_pricing 2 条 + topup_plans 4 条
-- 依赖:0002(model_pricing), 0003(topup_plans)
--
-- 单位约定(见 03-DATA-MODEL §4/§8/§9):
--   - *_per_mtok:每 1M token,单位 = 分(人民币)
--   - amount_cents:人民币分
--   - credits:积分(1 积分 = 100 分)
-- 价格按 03-DATA-MODEL §4 表格填入,部署前 boss 可通过 admin UI 调整。
-- 为了迁移幂等(允许重跑不炸),使用 ON CONFLICT DO NOTHING。

INSERT INTO model_pricing(
  model_id, display_name,
  input_per_mtok, output_per_mtok,
  cache_read_per_mtok, cache_write_per_mtok,
  multiplier, enabled, sort_order
) VALUES
  ('claude-sonnet-4-6', 'Claude Sonnet 4.6',  300, 1500,  30,  375, 2.0, TRUE, 100),
  ('claude-opus-4-7',   'Claude Opus 4.7',   1500, 7500, 150, 1875, 2.0, TRUE,  90)
ON CONFLICT (model_id) DO NOTHING;

INSERT INTO topup_plans(code, label, amount_cents, credits, sort_order, enabled) VALUES
  ('plan-10',    '¥10 → 10 积分',              1000,   1000, 100, TRUE),
  ('plan-50',    '¥50 → 55 积分(赠 10%)',      5000,   5500,  90, TRUE),
  ('plan-200',   '¥200 → 240 积分(赠 20%)',   20000,  24000,  80, TRUE),
  ('plan-1000',  '¥1000 → 1300 积分(赠 30%)',100000, 130000,  70, TRUE)
ON CONFLICT (code) DO NOTHING;
