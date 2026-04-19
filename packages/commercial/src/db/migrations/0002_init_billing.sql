-- 0002 billing 初始建表
-- 参见 docs/commercial/03-DATA-MODEL.md §4 §5 §6
--
-- 包含:
--   model_pricing   — 模型单价 + 倍率
--   credit_ledger   — 积分流水(append-only,带 RULE 拦 UPDATE/DELETE)
--   usage_records   — LLM 用量明细
--
-- 注意:usage_records 的 account_id 外键指向 claude_accounts,但 claude_accounts
-- 在 0004 才创建。此处先把列以 BIGINT NULL 建出来,不加 FK;0004 会 ALTER TABLE
-- 追加 FK 约束。这样每个迁移文件仍然自洽,不会在 0002 时卡住。

-- ─── model_pricing ────────────────────────────────────────────────────
CREATE TABLE model_pricing (
  model_id              TEXT PRIMARY KEY,
  display_name          TEXT NOT NULL,
  input_per_mtok        BIGINT NOT NULL,
  output_per_mtok       BIGINT NOT NULL,
  cache_read_per_mtok   BIGINT NOT NULL,
  cache_write_per_mtok  BIGINT NOT NULL,
  multiplier            NUMERIC(6,3) NOT NULL DEFAULT 2.0,
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order            INTEGER NOT NULL DEFAULT 100,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by            BIGINT REFERENCES users(id)
);

-- ─── credit_ledger ────────────────────────────────────────────────────
CREATE TABLE credit_ledger (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  delta          BIGINT NOT NULL,
  balance_after  BIGINT NOT NULL,
  reason         TEXT NOT NULL
                 CHECK (reason IN (
                   'topup','chat','agent_chat','agent_subscription',
                   'refund','admin_adjust','promotion'
                 )),
  ref_type       TEXT,
  ref_id         TEXT,
  memo           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cl_user_time ON credit_ledger(user_id, created_at DESC);
CREATE INDEX idx_cl_reason    ON credit_ledger(reason, created_at DESC);

-- append-only: 禁止 UPDATE / DELETE
CREATE RULE cl_no_update AS ON UPDATE TO credit_ledger DO INSTEAD NOTHING;
CREATE RULE cl_no_delete AS ON DELETE TO credit_ledger DO INSTEAD NOTHING;

-- ─── usage_records ────────────────────────────────────────────────────
-- account_id 的 FK 在 0004 随 claude_accounts 一起补上
CREATE TABLE usage_records (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             BIGINT NOT NULL REFERENCES users(id),
  session_id          TEXT,
  mode                TEXT NOT NULL CHECK (mode IN ('chat','agent')),
  account_id          BIGINT,
  model               TEXT NOT NULL,
  input_tokens        BIGINT NOT NULL DEFAULT 0,
  output_tokens       BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens   BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens  BIGINT NOT NULL DEFAULT 0,
  price_snapshot      JSONB NOT NULL,
  cost_credits        BIGINT NOT NULL,
  ledger_id           BIGINT REFERENCES credit_ledger(id),
  request_id          TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('success','billing_failed','error')),
  error_msg           TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ur_user_time ON usage_records(user_id, created_at DESC);
CREATE INDEX idx_ur_account   ON usage_records(account_id, created_at DESC);
CREATE INDEX idx_ur_req       ON usage_records(request_id);
