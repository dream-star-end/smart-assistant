-- 0278_friction_problem_card_dims.sql
-- order-dependency: 0277_api_key_usage_and_controls
--
-- Problem-card loop Phase 1: bounded presentation/path/reason dimensions on
-- product_friction_events so a visible card can be fingerprinted and closed
-- (pending → recovered/failed/cancelled) without storing raw text.
--
-- 0151 privacy invariant is unchanged: still no message/stack/path-as-URL/UA
-- column. The new columns are bounded enumerations / charset tokens only.
-- Rolling compatible: old writers omit the columns → NULL.

ALTER TABLE product_friction_events
  ADD COLUMN IF NOT EXISTS presentation VARCHAR(16)
    CHECK (presentation IS NULL OR presentation IN ('red','yellow','soft','banner','placeholder')),
  ADD COLUMN IF NOT EXISTS path VARCHAR(32)
    CHECK (path IS NULL OR path ~ '^[a-z0-9_]{1,32}$'),
  ADD COLUMN IF NOT EXISTS reason VARCHAR(48)
    CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,48}$');

CREATE INDEX IF NOT EXISTS idx_product_friction_problem_card_time
  ON product_friction_events (stage, code, created_at DESC)
  WHERE stage IN ('problem_card','recovery_decision','recovery_job','visible_fallback');

COMMENT ON COLUMN product_friction_events.presentation IS
  'Bounded card tone: red/yellow/soft/banner/placeholder. Never free text.';
COMMENT ON COLUMN product_friction_events.path IS
  'Bounded snake token for how the card was reached (immediate, decision_timeout, job_terminal, …). Charset ^[a-z0-9_]{1,32}$.';
COMMENT ON COLUMN product_friction_events.reason IS
  'Bounded snake token for master/reconciler reason (not_recoverable, silent_no_progress, …). Charset ^[a-z0-9_]{1,48}$. Never message/stack.';
