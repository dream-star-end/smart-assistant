-- 0102_seed_opencode_go_qwen.sql
-- v5 阶段:接入 OpenCode Zen「Go 计划」网关(https://opencode.ai/zen/go/v1/messages)。
--
-- 端点: Anthropic /v1/messages 兼容(stream / tool_use / tool_result 回环 / thinking /
--       cache_control / stop_sequences 2026-07-05 直连实测全通)
-- 鉴权: x-api-key + OPENCODE_GO_API_KEY(该端点不认 Authorization Bearer;key 配置在
--       systemd EnvironmentFile,绝不入 git / 用户容器)
-- 模型: qwen3.7-max / qwen3.7-plus(v5 缺口的 Qwen 旗舰,均 1M 窗口/65.5k max output)。
--       Go 档还有 kimi/mimo 家族,其网关 Anthropic 兼容层实测故障(整族 400),修好后加行即可。
-- 配额: Go 是个人订阅规格(5h/$12、周/$30、月/$60,全 v5 用户共享一把 key)。打穿后上游
--       429/4xx,turn 零输出走免单兜底,不误扣积分。**不作平台默认模型**。
--
-- 价格(沿用 0057 deepseek 口径:Zen 挂牌美元价 ×7.2 折 RMB,向上取整,multiplier=1.000):
--   qwen3.7-max:  input  $2.50/Mtok = ¥18.00/Mtok = 1800 cents
--                 output $7.50/Mtok = ¥54.00/Mtok = 5400 cents
--                 cache_read $0.50/Mtok = ¥3.60/Mtok = 360 cents
--                 cache_write 0(Zen 未挂牌,等账单证实再加)
--   qwen3.7-plus: input  $0.40/Mtok = ¥2.88/Mtok = 288 cents
--                 output $1.60/Mtok = ¥11.52/Mtok = 1152 cents
--                 cache_read $0.04/Mtok = ¥0.288/Mtok = 29 cents(向上取整)
--                 cache_write 0
--
-- visibility='public'(boss 2026-07-05 拍板直接放开;v5 灰度期用户面小)。
-- sort_order: 紧随 glm-5.2(84)之后 = 86/87。
--
-- 配套代码改动(同批):protocol staticKeyProviders OPENCODE_GO spec(authScheme='x-api-key')
-- + staticProviderMeta opencodego(egress=direct)+ CCB isOpencodeQwenModel(capabilityZero
-- + thinking 例外 + 1M 窗口)+ mcpVisionServer/promptSlots 纯文本识图兜底登记。

INSERT INTO model_pricing (
  model_id, display_name,
  input_per_mtok, output_per_mtok,
  cache_read_per_mtok, cache_write_per_mtok,
  multiplier, enabled, sort_order, visibility
) VALUES
  ('qwen3.7-max',  'Qwen3.7 Max (1M)',  1800, 5400, 360, 0, 1.000, TRUE, 86, 'public'),
  ('qwen3.7-plus', 'Qwen3.7 Plus (1M)',  288, 1152,  29, 0, 1.000, TRUE, 87, 'public')
ON CONFLICT (model_id) DO NOTHING;
