-- Manual compensation for 0234_all_model_prices_half.
--
-- Keep both the 0234 schema_migrations ledger row and the durable backup table.
-- The script is fail-closed: any catalog/price/admin drift after 0234 requires a
-- new reviewed recovery plan rather than overwriting newer state.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.model_pricing_0234_backup') IS NULL THEN
    RAISE EXCEPTION '0234 rollback requires model_pricing_0234_backup';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version = '0234_all_model_prices_half'
  ) THEN
    RAISE EXCEPTION '0234 rollback requires its schema_migrations ledger row';
  END IF;
END $$;

LOCK TABLE model_pricing, model_pricing_0234_backup IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  snapshot_count BIGINT;
  affected_count BIGINT;
BEGIN
  SELECT count(*) INTO snapshot_count FROM model_pricing_0234_backup;
  IF snapshot_count <= 0 OR snapshot_count <> (SELECT count(*) FROM model_pricing) THEN
    RAISE EXCEPTION '0234 rollback model row count drift: backup %, live %',
      snapshot_count, (SELECT count(*) FROM model_pricing);
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing AS pricing
      FULL JOIN model_pricing_0234_backup AS backup USING (model_id)
     WHERE pricing.model_id IS NULL OR backup.model_id IS NULL
  ) THEN
    RAISE EXCEPTION '0234 rollback refuses model_id set drift';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing AS pricing
      JOIN model_pricing_0234_backup AS backup USING (model_id)
     WHERE pricing.input_per_mtok <> backup.input_per_mtok / 2
        OR pricing.output_per_mtok <> backup.output_per_mtok / 2
        OR pricing.cache_read_per_mtok <> backup.cache_read_per_mtok / 2
        OR pricing.cache_write_per_mtok <> backup.cache_write_per_mtok / 2
        OR pricing.display_name IS DISTINCT FROM backup.display_name
        OR pricing.multiplier IS DISTINCT FROM backup.multiplier
        OR pricing.enabled IS DISTINCT FROM backup.enabled
        OR pricing.sort_order IS DISTINCT FROM backup.sort_order
        OR pricing.updated_by IS DISTINCT FROM backup.updated_by
        OR pricing.visibility IS DISTINCT FROM backup.visibility
        OR pricing.extra_system_prompt IS DISTINCT FROM backup.extra_system_prompt
        OR pricing.default_effort IS DISTINCT FROM backup.default_effort
        OR pricing.min_plan_code IS DISTINCT FROM backup.min_plan_code
        OR pricing.lock_version <> backup.lock_version + 1
        OR pricing.updated_at < backup.captured_at
  ) THEN
    RAISE EXCEPTION '0234 rollback refuses post-migration drift';
  END IF;

  UPDATE model_pricing AS pricing
     SET input_per_mtok = backup.input_per_mtok,
         output_per_mtok = backup.output_per_mtok,
         cache_read_per_mtok = backup.cache_read_per_mtok,
         cache_write_per_mtok = backup.cache_write_per_mtok,
         updated_at = clock_timestamp(),
         lock_version = pricing.lock_version + 1
    FROM model_pricing_0234_backup AS backup
   WHERE pricing.model_id = backup.model_id;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> snapshot_count THEN
    RAISE EXCEPTION '0234 rollback expected to restore % rows, restored %',
      snapshot_count, affected_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing AS pricing
      JOIN model_pricing_0234_backup AS backup USING (model_id)
     WHERE pricing.input_per_mtok <> backup.input_per_mtok
        OR pricing.output_per_mtok <> backup.output_per_mtok
        OR pricing.cache_read_per_mtok <> backup.cache_read_per_mtok
        OR pricing.cache_write_per_mtok <> backup.cache_write_per_mtok
        OR pricing.display_name IS DISTINCT FROM backup.display_name
        OR pricing.multiplier IS DISTINCT FROM backup.multiplier
        OR pricing.enabled IS DISTINCT FROM backup.enabled
        OR pricing.sort_order IS DISTINCT FROM backup.sort_order
        OR pricing.updated_by IS DISTINCT FROM backup.updated_by
        OR pricing.visibility IS DISTINCT FROM backup.visibility
        OR pricing.extra_system_prompt IS DISTINCT FROM backup.extra_system_prompt
        OR pricing.default_effort IS DISTINCT FROM backup.default_effort
        OR pricing.min_plan_code IS DISTINCT FROM backup.min_plan_code
        OR pricing.lock_version <> backup.lock_version + 2
  ) THEN
    RAISE EXCEPTION '0234 rollback restore postcondition mismatch';
  END IF;
END $$;

COMMIT;
