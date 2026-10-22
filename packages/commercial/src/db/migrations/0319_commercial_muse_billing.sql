-- order-dependency: 0318_commercial_box_gpt_6_astra_pro
-- 0319_commercial_muse_billing.sql (commercial; OCV5-574)
-- Muse image/video jobs open to every commercial account and charged per successful job (user
-- decision 2026-10-22: video 50, image 10 credits). The charge is written by muse/billing.ts in the
-- same transaction that marks the job succeeded: cost_credits / price_snapshot / debited_credits /
-- ledger_id are set together or not at all. credit_ledger gains the reason 'muse_media'.
-- Rollback: db/rollbacks/0319_commercial_muse_billing.sql.

-- compat: additive nullable columns, one index and a widened CHECK; old binaries never read or write them
ALTER TABLE muse_media_jobs
  ADD COLUMN IF NOT EXISTS cost_credits BIGINT CHECK (cost_credits IS NULL OR cost_credits >= 0),
  ADD COLUMN IF NOT EXISTS debited_credits BIGINT CHECK (debited_credits IS NULL OR debited_credits >= 0),
  ADD COLUMN IF NOT EXISTS price_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS ledger_id BIGINT REFERENCES credit_ledger(id) ON DELETE SET NULL;

-- Only a succeeded job is ever charged.
ALTER TABLE muse_media_jobs DROP CONSTRAINT IF EXISTS muse_media_jobs_charge_only_succeeded;
ALTER TABLE muse_media_jobs ADD CONSTRAINT muse_media_jobs_charge_only_succeeded
  CHECK (cost_credits IS NULL OR status = 'succeeded');

-- Site-wide daily counts (OC_MUSE_GLOBAL_*_PER_DAY).
CREATE INDEX IF NOT EXISTS muse_media_jobs_kind_queued_idx ON muse_media_jobs (kind, queued_at DESC);

ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_reason_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_reason_check CHECK (reason IN (
  'topup','chat','agent_chat','agent_subscription','refund','admin_adjust','promotion',
  'minimax_media','image_generation','subscription','subscription_expire','pack','muse_media'
)) NOT VALID;
ALTER TABLE credit_ledger VALIDATE CONSTRAINT credit_ledger_reason_check;
