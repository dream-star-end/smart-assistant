-- 0004_init_account_pool.sql
-- claude_accounts + 补齐 usage_records.account_id 的外键(在 0002 建表时故意没加 FK,
-- 因为 claude_accounts 在本迁移才创建,避免跨迁移依赖)
-- 依赖:0002(usage_records)

CREATE TABLE claude_accounts (
  id                  BIGSERIAL PRIMARY KEY,
  label               TEXT NOT NULL,
  plan                TEXT NOT NULL CHECK (plan IN ('pro','max','team')),
  oauth_token_enc     BYTEA NOT NULL,
  oauth_nonce         BYTEA NOT NULL,
  oauth_refresh_enc   BYTEA,
  oauth_refresh_nonce BYTEA,
  oauth_expires_at    TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','cooldown','disabled','banned')),
  health_score        INTEGER NOT NULL DEFAULT 100
                      CHECK (health_score >= 0 AND health_score <= 100),
  cooldown_until      TIMESTAMPTZ,
  last_used_at        TIMESTAMPTZ,
  last_error          TEXT,
  success_count       BIGINT NOT NULL DEFAULT 0,
  fail_count          BIGINT NOT NULL DEFAULT 0,
  quota_remaining     INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ca_schedulable
  ON claude_accounts(health_score DESC)
  WHERE status = 'active';

-- 补齐 usage_records.account_id → claude_accounts.id 的 FK。
-- ON DELETE RESTRICT 按全局约定,不允许删除还有 usage 引用的账号。
ALTER TABLE usage_records
  ADD CONSTRAINT fk_usage_records_account
  FOREIGN KEY (account_id) REFERENCES claude_accounts(id) ON DELETE RESTRICT;
