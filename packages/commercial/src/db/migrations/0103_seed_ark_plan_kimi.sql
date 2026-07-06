-- 0103_seed_ark_plan_kimi.sql
-- v5 阶段:火山方舟 Agent Plan 加接 Kimi K2.7 Code(2026-07-06)。
--
-- 端点: https://ark.cn-beijing.volces.com/api/plan/v1/messages(与 MiniMax-M3 同 lane 同 key,
--       ARK_AGENT_PLAN_KEY 订阅制;独立 provider spec 'kimi',因 supportsVision/thinking 语义与 M3 不同)
-- 实测: 非流式/SSE/tool_use/tool_result 回环(含 thinking 块回放)/cache_control 全通;
--       thinking disabled → 火山 400(恒思考模型,master stripDisabledThinking 删参兜底);
--       image block → 400(纯文本,understand_image 兜底);max output 上游硬顶 32768。
-- 窗口: 256K(CCB STATIC_MODEL_CONTEXT_WINDOW 已登记)
--
-- 价格(沿用 0057 口径:官方挂牌美元价 ×7.2 折 RMB,向上取整,multiplier=1.000):
--   kimi-k2.7-code: input(cache miss) $0.95/Mtok = ¥6.84 = 684 cents
--                   output            $4.00/Mtok = ¥28.80 = 2880 cents
--                   cache_read        $0.19/Mtok = ¥1.368 → 137 cents(向上取整)
--                   cache_write 0(官方未单列,等账单证实再加)
--
-- visibility='public';sort_order 88(紧随 qwen 86/87 之后)。

INSERT INTO model_pricing (
  model_id, display_name,
  input_per_mtok, output_per_mtok,
  cache_read_per_mtok, cache_write_per_mtok,
  multiplier, enabled, sort_order, visibility
) VALUES
  ('kimi-k2.7-code', 'Kimi K2.7 Code (256k)', 684, 2880, 137, 0, 1.000, TRUE, 88, 'public')
ON CONFLICT (model_id) DO NOTHING;
