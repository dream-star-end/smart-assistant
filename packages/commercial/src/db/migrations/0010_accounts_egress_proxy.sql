-- 0010_accounts_egress_proxy.sql
-- 给 claude_accounts 加 egress_proxy 列。
--
-- 背景: Anthropic 风控按 IP/TLS 指纹判断账号是否异常。同一台公网出口
-- 多账号长期跑 → 被判定为共享/批量账号 → 限频或封号。每个账号挂自己
-- 的住宅/静态 IP 代理可彻底解决。
--
-- 字段语义:
--   NULL  → 走本机出口 (默认/旧账号兼容)
--   非 NULL → 形如 "http://user:pass@host:port",由 chat orchestrator
--           构造 undici ProxyAgent 注入到 fetch dispatcher。
--
-- 不加索引: 仅在 admin 后台编辑/scheduler 拿到具体账号时读取,无 WHERE 查询。

ALTER TABLE claude_accounts ADD COLUMN egress_proxy TEXT;

COMMENT ON COLUMN claude_accounts.egress_proxy IS
  'Optional outbound proxy URL (http://user:pass@host:port). NULL = use server local egress.';
