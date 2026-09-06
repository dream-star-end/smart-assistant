-- 0277_api_key_usage_and_controls.sql
-- order-dependency: 0276_grok_account_usage_columns
-- CC 外接 API key(0068 user_api_keys)配套:
--   1. usage_records.api_key_id —— 每笔经 `oc-cc.*` key 进来的请求落库时打戳,让
--      「API 接入」分区能按 key / 按模型 / 按时间统计消耗。容器 / 网页聊天流量恒 NULL。
--      0068 明确划走了 "api_key_id 进 ctx",这里补上。ON DELETE SET NULL:key 行只软撤销
--      (revoked_at),硬删仅随 users CASCADE,此时 usage 行也一并被 users 级联清掉。
--   2. user_api_keys.disabled_at —— 临时禁用(可恢复)。strategy 在 secret 验对后检查,
--      非空 → 401(anti-enumeration 同型)。与 revoked_at(不可恢复)语义分开。
--   3. user_api_keys.credit_limit / spent_credits —— 单 key 名义积分上限与累计。
--      spent_credits 在 settleUsageAndLedger 同事务内累加(与 usage_records.cost_credits
--      同口径,只累加 status='success' 且实际 > 0 的名义积分),proxy 入口 O(1) 预检
--      `spent >= limit` → 402 API_KEY_LIMIT_EXCEEDED。统计报表仍以 usage_records 为权威;
--      spent_credits 只是预检缓存,允许与报表有事务粒度的瞬时差。
--
-- ADD COLUMN only;所有列 nullable 或带默认值,rollback-safe(旧代码忽略新列)。

ALTER TABLE usage_records
  ADD COLUMN IF NOT EXISTS api_key_id BIGINT REFERENCES user_api_keys(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ur_api_key_time
  ON usage_records(api_key_id, created_at DESC)
  WHERE api_key_id IS NOT NULL;

ALTER TABLE user_api_keys
  ADD COLUMN IF NOT EXISTS disabled_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS credit_limit  BIGINT,
  ADD COLUMN IF NOT EXISTS spent_credits BIGINT NOT NULL DEFAULT 0;

ALTER TABLE user_api_keys
  DROP CONSTRAINT IF EXISTS user_api_keys_credit_limit_positive;
ALTER TABLE user_api_keys
  ADD CONSTRAINT user_api_keys_credit_limit_positive
  CHECK (credit_limit IS NULL OR credit_limit > 0);

COMMENT ON COLUMN usage_records.api_key_id IS
  'user_api_keys.id when the request came through the external API-key endpoint (/api/anthropic); NULL for container / web chat traffic.';
COMMENT ON COLUMN user_api_keys.disabled_at IS
  'Temporarily disabled by the owner (reversible). Non-NULL → strategy rejects with 401. Distinct from revoked_at (permanent).';
COMMENT ON COLUMN user_api_keys.credit_limit IS
  'Optional per-key nominal credit cap. NULL = unlimited. Enforced as spent_credits >= credit_limit → 402 API_KEY_LIMIT_EXCEEDED.';
COMMENT ON COLUMN user_api_keys.spent_credits IS
  'Nominal credits settled through this key (same scale as usage_records.cost_credits). Pre-check cache; usage_records is the reporting authority.';
