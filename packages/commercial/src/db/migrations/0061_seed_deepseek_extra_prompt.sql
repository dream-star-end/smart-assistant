-- 0061_seed_deepseek_extra_prompt.sql
-- DeepSeek V4 Flash/Pro 接入后(0057),boss 实测发现:模型在看到"明确的成功信号"
-- (如"已写好"/"完成了 X")后会过早 yield,而不是继续推进多步任务。这跟它的训练
-- 倾向有关。通过 0060 引入的 model_pricing.extra_system_prompt 注入一段守则纠偏。
--
-- 文案:精炼到一句,避免与 SOUL/AGENTS slot 冲突。仅在 extra_system_prompt 当前为
-- NULL 或纯空白时填(WHERE 子句),允许 admin 后续手动改写覆盖,migration 不会回卷。
--
-- 触发 NOTIFY pricing_changed → PricingCache 自动 reload(0008 trigger)。

UPDATE model_pricing
SET extra_system_prompt = '完成一个步骤后,不要 yield,继续推进至全部目标完成,除非遇到必须用户决策的事'
WHERE model_id IN ('deepseek-v4-pro', 'deepseek-v4-flash')
  AND (extra_system_prompt IS NULL OR btrim(extra_system_prompt) = '');
