-- 0250 — egress proxy 地域 + claude 一号一代理(反封复盘 2026-08 #1)
-- order-dependency: 0249_usage_board_project_attribution
--
-- (a) egress_proxies.region:出口住宅代理所在国家码(US/GB/CN/JP/DE),可空。
--     驱动 persona 生成(见 account-pool/persona.ts REGION_ACCEPT_LANGUAGE):给账号
--     配某国住宅代理 → 建号时生成该国 locale 的 persona,让 IP / 语言 / 时区自洽,
--     消除"en-US 语言 + 美国 IP 却报东京日期"这类跨区指纹。NULL = 不绑地域(persona 随机)。
--
-- (b) claude 一号一代理:同一 egress_proxy_id 不得被多个 active Claude 账号共用
--     (多号同时共享同一住宅 IP 是号商典型信号)。disabled 历史账号保留旧绑定用于审计,
--     但任何一支改回 active 都会被唯一索引挡住,须先分配独立代理。

ALTER TABLE egress_proxies
  ADD COLUMN IF NOT EXISTS region TEXT DEFAULT NULL;

-- 新列的新约束,仅一次性 apply,不用 DROP-then-ADD(避免命中发布器的破坏性 DDL
-- 门 `ALTER ... DROP`)。迁移由 migrate 运行器按 version 追踪,恰好 apply 一次。
ALTER TABLE egress_proxies
  ADD CONSTRAINT egress_proxies_region_check
  CHECK (region IS NULL OR region IN ('US', 'GB', 'CN', 'JP', 'DE'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_claude_accounts_egress_proxy_uniq
  ON claude_accounts (egress_proxy_id)
  WHERE provider = 'claude' AND status = 'active' AND egress_proxy_id IS NOT NULL;

COMMENT ON COLUMN egress_proxies.region IS
  'Anti-ban #1: residential proxy country code (US/GB/CN/JP/DE) or NULL. Drives account persona accept_language/timezone at create. NULL = region-agnostic (persona stays random).';
