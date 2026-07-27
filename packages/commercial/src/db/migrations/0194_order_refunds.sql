-- 0194_order_refunds.sql
-- P2-A: durable, auditable Hupijiao full-refund state for safely reversible
-- wallet top-ups. Subscription/pack/provision orders deliberately remain
-- manual-review-only until their pre-fulfilment entitlement state is persisted.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS refund_state TEXT
    CHECK (refund_state IN ('requested', 'channel_pending', 'failed_review', 'completed')),
  ADD COLUMN IF NOT EXISTS refund_reason TEXT,
  ADD COLUMN IF NOT EXISTS refund_requested_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS refund_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refund_hold_ledger_id BIGINT REFERENCES credit_ledger(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS provider_refund_no TEXT,
  ADD COLUMN IF NOT EXISTS refund_payload JSONB,
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS ck_orders_refund_request_complete;
ALTER TABLE orders ADD CONSTRAINT ck_orders_refund_request_complete CHECK (
  (refund_state IS NULL
    AND refund_reason IS NULL
    AND refund_requested_by IS NULL
    AND refund_requested_at IS NULL
    AND refund_hold_ledger_id IS NULL
    AND provider_refund_no IS NULL
    AND refund_payload IS NULL
    AND refunded_at IS NULL)
  OR
  (refund_state IS NOT NULL
    AND refund_reason IS NOT NULL
    AND refund_requested_by IS NOT NULL
    AND refund_requested_at IS NOT NULL
    AND refund_hold_ledger_id IS NOT NULL)
);

ALTER TABLE orders DROP CONSTRAINT IF EXISTS ck_orders_refund_completed;
ALTER TABLE orders ADD CONSTRAINT ck_orders_refund_completed CHECK (
  refund_state <> 'completed'
  OR (
    status = 'refunded'
    AND refunded_ledger_id IS NOT NULL
    AND refunded_ledger_id = refund_hold_ledger_id
    AND refunded_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_orders_refund_attention
  ON orders(refund_state, refund_requested_at)
  WHERE refund_state IN ('requested', 'channel_pending', 'failed_review');

COMMENT ON COLUMN orders.refund_state IS
  'Hupijiao full-refund state. completed is absorbing; non-CD outcomes retain the entitlement hold for manual channel review.';
COMMENT ON COLUMN orders.refund_hold_ledger_id IS
  'Negative refund ledger that freezes the original top-up entitlement before the one-shot provider request.';
COMMENT ON COLUMN orders.refund_payload IS
  'Allowlisted provider refund response/callback fields only; hash and secrets are never persisted.';
