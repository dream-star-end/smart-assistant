-- 0003_init_payment.sql
-- orders / topup_plans
-- 依赖:0001(users), 0002(credit_ledger)

CREATE TABLE orders (
  id                 BIGSERIAL PRIMARY KEY,
  order_no           TEXT NOT NULL UNIQUE,
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider           TEXT NOT NULL CHECK (provider IN ('hupijiao')),
  provider_order     TEXT,
  amount_cents       BIGINT NOT NULL,
  credits            BIGINT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','paid','expired','refunded','canceled')),
  paid_at            TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ NOT NULL,
  callback_payload   JSONB,
  ledger_id          BIGINT REFERENCES credit_ledger(id) ON DELETE RESTRICT,
  refunded_ledger_id BIGINT REFERENCES credit_ledger(id) ON DELETE RESTRICT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_status ON orders(status, expires_at) WHERE status = 'pending';

CREATE TABLE topup_plans (
  id           BIGSERIAL PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  credits      BIGINT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 100,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
