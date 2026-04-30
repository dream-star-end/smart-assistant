-- 0050_seed_gpt55.sql
-- v3 阶段 1 接入 codex / GPT 系列:仅上线 gpt-5.5(对应个人版已 spike 流式 OK 的模型)。
--
-- 价格说明(占位):
--   boss 尚未给定 GPT 系列定价,这里临时复用 claude-opus-4-7 同档(分/Mtok),
--   admin UI 应当对 gpt-5.5 显眼标注"未定价"提示,boss 拍板后再走 admin 改价
--   流水线(同时触发 pricing_changed NOTIFY)。
--
-- TODO(boss): 给 gpt-5.5 设置真实定价后删除本注释 / 替换该值。
--
-- visibility='admin':默认仅管理员可见;boss 通过 admin UI 添加
-- model_visibility_grants 行后,被授权用户也能在 modelPicker 看到。
--
-- sort_order=110:大于现有 claude-opus-4-7=90 / claude-sonnet-4-6=100,
-- 让 GPT 排在 modelPicker 列表底部(避免抢占 claude 的视觉权重)。

INSERT INTO model_pricing (
  model_id, display_name,
  input_per_mtok, output_per_mtok,
  cache_read_per_mtok, cache_write_per_mtok,
  multiplier, enabled, sort_order, visibility
)
SELECT
  'gpt-5.5', 'GPT 5.5 (Codex)',
  input_per_mtok, output_per_mtok,
  cache_read_per_mtok, cache_write_per_mtok,
  multiplier, TRUE, 110, 'admin'
FROM model_pricing WHERE model_id = 'claude-opus-4-7'
ON CONFLICT (model_id) DO NOTHING;
