-- order-dependency: none (0335_codex_remote_native is selfhost-only, on feat/v5-selfhost-ocv5-746-codex-remote; not part of the commercial chain)
-- compat: additive nullable journal/lease/outbox columns; old binaries insert NULL and retain old behavior.
-- t1657u: same Muse job/bill, synchronous retries then durable background delivery.
-- Apply before new master code; no live apply is authorized by this draft PR.
ALTER TABLE muse_media_jobs
  ADD COLUMN durable JSONB,
  ADD COLUMN durable_payload JSONB,
  ADD COLUMN lease_owner TEXT,
  ADD COLUMN lease_until TIMESTAMPTZ,
  ADD COLUMN delivered_at TIMESTAMPTZ,
  ADD COLUMN delivery_next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT muse_durable_lease CHECK (
    durable IS NULL OR (kind='video' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
  );
CREATE INDEX muse_durable_recovery_idx ON muse_media_jobs(lease_until)
  WHERE durable IS NOT NULL AND status IN ('queued','running');
CREATE INDEX muse_durable_delivery_idx ON muse_media_jobs(delivery_next_at)
  WHERE durable IS NOT NULL AND delivered_at IS NULL AND status IN ('succeeded','failed','cancelled');
-- An old A/B binary may still run its legacy orphan sweep during rollout/rollback.
-- It cannot own a durable job. Do not let its unfenced restart sweep terminalize new work.
-- compat: the function only skips legacy orphan termination of new durable jobs; old jobs have durable NULL and keep identical writes.
CREATE FUNCTION fn_0336_muse_legacy_orphan_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.durable IS NOT NULL AND NEW.error_code = 'MUSE_MASTER_RESTARTED' THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;
-- compat: this trigger preserves old-row updates; it prevents only an unfenced legacy restart sweep from terminating new durable work.
CREATE TRIGGER trg_0336_muse_legacy_orphan_guard BEFORE UPDATE ON muse_media_jobs
  FOR EACH ROW EXECUTE FUNCTION fn_0336_muse_legacy_orphan_guard();
