-- 0060 model_pricing.extra_system_prompt
-- Per-model extra_system_prompt — 在 CCB/codex spawn 时拼到 extra-prompt.md 末尾,
-- 用于纠正特定模型的默认行为(例:DeepSeek V4 Pro 看到 "explicit success signals"
-- 后会过早 yield)。
--
-- 上限 4096 字符(JS code unit / TEXT char_length 一致):足够装一段中等纠偏文案,
-- 又能挡住"误把整本 docs 灌进来"的事故。NULL 与纯空白等价于"不注入"。
--
-- NOTIFY pricing_changed:0008 的 trg_model_pricing_notify 是 AFTER INSERT/UPDATE/DELETE
-- ON model_pricing FOR EACH STATEMENT,任何列变更都触发。所以本 migration 不动 trigger,
-- 改 extra_system_prompt 也会触发 PricingCache reload。

ALTER TABLE model_pricing
  ADD COLUMN IF NOT EXISTS extra_system_prompt TEXT
    CHECK (extra_system_prompt IS NULL OR char_length(extra_system_prompt) <= 4096);
