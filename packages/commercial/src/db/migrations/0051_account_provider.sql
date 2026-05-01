-- 0051_account_provider.sql
-- 给 claude_accounts 加 provider 列,区分 claude / codex 账号。
--
-- 背景:
--   v3 admin 账号池历来纯 claude;Phase 2 接入 codex(GPT)多账号运行,
--   两类账号共享同一张表 + scheduler 基础设施,通过 provider 列分流:
--     - claude → 走 claude OAuth(claude.ai),scheduler.pick(provider='claude')
--     - codex  → 走 codex OAuth(auth.openai.com),scheduler.pick(provider='codex')
--
-- 默认 'claude':
--   存量数据 backfill 一次性写满。所有现有 scheduler.pick / store 调用方
--   不传 provider 时也默认 'claude',零行为变化。
--
-- 索引 idx_ca_provider_status:
--   scheduler.pick / pickCodexAccountForBinding / refresh actor 都按
--   (provider, status) 过滤;现有 idx_ca_schedulable 只覆盖 status='active'
--   不带 provider,新索引专用于 codex 路径(WHERE provider='codex' AND
--   status='active'),也利于按 provider 列展 admin UI。

ALTER TABLE claude_accounts
  ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'
  CHECK (provider IN ('claude', 'codex'));

CREATE INDEX idx_ca_provider_status ON claude_accounts(provider, status);

COMMENT ON COLUMN claude_accounts.provider IS
  'V3 account provider: claude (claude.ai OAuth) or codex (auth.openai.com OAuth). '
  'Determines OAuth flow + scheduler partition + container mount path. Immutable post-create.';
