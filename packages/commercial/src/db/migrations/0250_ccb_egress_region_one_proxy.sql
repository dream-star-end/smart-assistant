-- 0250 — egress proxy 地域 + claude 一号一代理(反封复盘 2026-08 #1)
-- order-dependency: 0249_usage_board_project_attribution
--
-- (a) egress_proxies.region:出口住宅代理所在国家码(US/GB/CN/JP/DE),可空。
--     驱动 persona 生成(见 account-pool/persona.ts REGION_ACCEPT_LANGUAGE):给账号
--     配某国住宅代理 → 建号时生成该国 locale 的 persona,让 IP / 语言 / 时区自洽,
--     消除"en-US 语言 + 美国 IP 却报东京日期"这类跨区指纹。NULL = 不绑地域(persona 随机)。
--
-- (b) claude 一号一代理:同一 egress_proxy_id 不得被多个 provider='claude' 账号共用
--     (多号共享同一住宅 IP 是号商典型信号)。partial unique index 只约束
--     provider='claude' 且 egress_proxy_id NOT NULL 的行;codex/grok/cursor 或未绑代理
--     的行不受影响。当前 claude 账号数为 0,加索引不会与存量数据冲突。

ALTER TABLE egress_proxies
  ADD COLUMN IF NOT EXISTS region TEXT DEFAULT NULL;

ALTER TABLE egress_proxies
  DROP CONSTRAINT IF EXISTS egress_proxies_region_check;
ALTER TABLE egress_proxies
  ADD CONSTRAINT egress_proxies_region_check
  CHECK (region IS NULL OR region IN ('US', 'GB', 'CN', 'JP', 'DE'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_claude_accounts_egress_proxy_uniq
  ON claude_accounts (egress_proxy_id)
  WHERE provider = 'claude' AND egress_proxy_id IS NOT NULL;

COMMENT ON COLUMN egress_proxies.region IS
  'Anti-ban #1: residential proxy country code (US/GB/CN/JP/DE) or NULL. Drives account persona accept_language/timezone at create. NULL = region-agnostic (persona stays random).';
