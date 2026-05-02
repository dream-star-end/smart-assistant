-- 0057_seed_deepseek.sql
-- v3 阶段:接入 DeepSeek 系列(anthropic 兼容端点)。
--
-- 端点: https://api.deepseek.com/anthropic/v1/messages
-- 协议: anthropic /v1/messages 兼容(stream / tool_use / thinking blocks 全支持)
-- 鉴权: Bearer + DEEPSEEK_API_KEY(配置在 systemd EnvironmentFile,绝不入 git)
-- 1M context 默认开,output 最大 384K(本期 proxy max_tokens 仍 cap 200K)
--
-- 价格说明(boss 2026-05-02 拍:按美元折算 $1=¥7.2,multiplier=1.000):
--   flash: input  $0.14/Mtok = ¥1.008/Mtok = 101 cents (向上取整)
--          output $0.28/Mtok = ¥2.016/Mtok = 202 cents (向上取整)
--          cache_read  $0.0028/Mtok = ¥0.02016/Mtok = 3 cents (向上取整,Codex review 第二轮修正)
--          cache_write 0(DeepSeek 文档未列 cache write 单价,等账单证实再加 — Codex review IMPORTANT 修正)
--   pro:   input  $0.435/Mtok = ¥3.132/Mtok = 314 cents (向上取整,避免 sub-cent 计费 leakage)
--          output $0.87/Mtok  = ¥6.264/Mtok = 627 cents (向上取整)
--          cache_read  $0.003625/Mtok = ¥0.026/Mtok ≈ 3 cents (向上取整)
--          cache_write 0
--
-- visibility='admin':默认仅管理员可见;boss 通过 admin UI 添加 model_visibility_grants
-- 行后,被授权用户也能在 modelPicker 看到 + anthropicProxy 路由。
--
-- sort_order:flash=120 / pro=121,排在 gpt-5.5(110)之后,与 claude 系列拉开。
--
-- 配套代码改动:
--   - anthropicProxy.ts model.startsWith('deepseek-') → 跳过 scheduler.pick / dispatcher / quota,
--     forward 到 https://api.deepseek.com/anthropic/v1/messages 用 DEEPSEEK_API_KEY 鉴权
--   - canUseModel 在 proxy 路径强制校验,关闭"前端隐藏后端可绕"漏洞(Codex BLOCKER 修)

INSERT INTO model_pricing (
  model_id, display_name,
  input_per_mtok, output_per_mtok,
  cache_read_per_mtok, cache_write_per_mtok,
  multiplier, enabled, sort_order, visibility
) VALUES
  ('deepseek-v4-flash', 'DeepSeek V4 Flash (1M)', 101, 202, 3, 0, 1.000, TRUE, 120, 'admin'),
  ('deepseek-v4-pro',   'DeepSeek V4 Pro (1M)',   314, 627, 3, 0, 1.000, TRUE, 121, 'admin')
ON CONFLICT (model_id) DO NOTHING;
