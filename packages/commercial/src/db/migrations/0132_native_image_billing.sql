-- Native imagegen per-image billing. Extends the fixed-price GPT Image billing
-- (0131) to the model-driven native imagegen data plane: the container's codex
-- calls POST /images/generations and /images/edits through the relay, metered
-- per output image at 50 credits each (n clamped [1,4]).
--
-- Changes vs 0131:
--   · operation gains 'native_image'.
--   · image_count relaxed from (= 1) to (BETWEEN 1 AND 4).
--   · cost_credits relaxed from (= 50) to (= unit_cost * image_count) so an
--     n-image request may charge 50×n; unit_cost stays fixed at 50.
-- annotated_edit / generation / edit rows (image_count=1, cost_credits=50) all
-- satisfy the relaxed checks, so the validating ADD scans clean. No new columns
-- and no new indexes, so ALTER ordering is a non-issue here. Idempotent.
--
-- credit_ledger.reason is unchanged: native_image debits still book under the
-- existing 'image_generation' reason (memo distinguishes the operation), so the
-- 0131 ledger reason constraint needs no touch.

ALTER TABLE image_generation_usage_records
  DROP CONSTRAINT IF EXISTS image_generation_usage_records_operation_check;
ALTER TABLE image_generation_usage_records
  ADD CONSTRAINT image_generation_usage_records_operation_check
  CHECK (operation IN ('generation','edit','annotated_edit','native_image'));

ALTER TABLE image_generation_usage_records
  DROP CONSTRAINT IF EXISTS image_generation_usage_records_image_count_check;
ALTER TABLE image_generation_usage_records
  ADD CONSTRAINT image_generation_usage_records_image_count_check
  CHECK (image_count BETWEEN 1 AND 4);

ALTER TABLE image_generation_usage_records
  DROP CONSTRAINT IF EXISTS image_generation_usage_records_cost_credits_check;
ALTER TABLE image_generation_usage_records
  ADD CONSTRAINT image_generation_usage_records_cost_credits_check
  CHECK (cost_credits = unit_cost * image_count);
