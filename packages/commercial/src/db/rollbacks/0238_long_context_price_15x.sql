-- Manual compensation for 0238_long_context_price_15x.
--
-- Compensation is fail-closed: any price/metadata drift or any later migration
-- refuses the rollback. After an exact restore it removes the 0238 ledger row
-- and backup table in the same transaction, so the normal migrator can safely
-- reapply 0238 on a release retry instead of skipping a compensated price state.

BEGIN;

-- Block concurrent migrator ledger writes until the compensation commits, so
-- the later-migration guard and removal of 0238 remain one atomic decision.
LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF to_regclass('public.model_pricing_0238_backup') IS NULL THEN
    RAISE EXCEPTION '0238 rollback requires model_pricing_0238_backup';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version = '0238_long_context_price_15x'
  ) THEN
    RAISE EXCEPTION '0238 rollback requires its schema_migrations ledger row';
  END IF;
  IF EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version > '0238_long_context_price_15x'
  ) THEN
    RAISE EXCEPTION '0238 rollback refuses when later migrations are already applied';
  END IF;
END $$;

LOCK TABLE model_pricing, model_pricing_0238_backup IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  snapshot_count BIGINT;
  standard_count BIGINT;
  affected_count BIGINT;
BEGIN
  SELECT count(*) INTO snapshot_count FROM model_pricing_0238_backup;
  IF snapshot_count <> 4 THEN
    RAISE EXCEPTION '0238 rollback expected 4 backup rows, found %', snapshot_count;
  END IF;

  SELECT count(*) INTO standard_count
    FROM model_pricing_0238_backup AS backup
    JOIN model_pricing AS standard
      ON standard.model_id = backup.standard_model_id;
  IF standard_count <> 4 THEN
    RAISE EXCEPTION
      '0238 rollback expected 4 standard-tier rows, found %',
      standard_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing AS standard
      JOIN model_pricing_0238_backup AS backup
        ON standard.model_id = backup.standard_model_id
     WHERE standard.input_per_mtok <> backup.standard_input_per_mtok
        OR standard.output_per_mtok <> backup.standard_output_per_mtok
        OR standard.cache_read_per_mtok <> backup.standard_cache_read_per_mtok
        OR standard.cache_write_per_mtok <> backup.standard_cache_write_per_mtok
        OR standard.multiplier IS DISTINCT FROM backup.standard_multiplier
  ) THEN
    RAISE EXCEPTION '0238 rollback refuses standard-tier price drift';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing AS pricing
      JOIN model_pricing_0238_backup AS backup
        ON pricing.model_id = backup.long_model_id
     WHERE pricing.input_per_mtok <> (backup.standard_input_per_mtok * 3 + 1) / 2
        OR pricing.output_per_mtok <> (backup.standard_output_per_mtok * 3 + 1) / 2
        OR pricing.cache_read_per_mtok <> (backup.standard_cache_read_per_mtok * 3 + 1) / 2
        OR pricing.cache_write_per_mtok <> (backup.standard_cache_write_per_mtok * 3 + 1) / 2
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
    RAISE EXCEPTION '0238 rollback refuses post-migration drift';
  END IF;

  UPDATE model_pricing AS pricing
     SET input_per_mtok = backup.input_per_mtok,
         output_per_mtok = backup.output_per_mtok,
         cache_read_per_mtok = backup.cache_read_per_mtok,
         cache_write_per_mtok = backup.cache_write_per_mtok,
         updated_at = clock_timestamp(),
         lock_version = pricing.lock_version + 1
    FROM model_pricing_0238_backup AS backup
   WHERE pricing.model_id = backup.long_model_id;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 4 THEN
    RAISE EXCEPTION '0238 rollback expected to restore 4 rows, restored %', affected_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing AS pricing
      JOIN model_pricing_0238_backup AS backup
        ON pricing.model_id = backup.long_model_id
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
    RAISE EXCEPTION '0238 rollback restore postcondition mismatch';
  END IF;

  DELETE FROM schema_migrations
   WHERE version = '0238_long_context_price_15x';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 1 THEN
    RAISE EXCEPTION '0238 rollback expected to remove one ledger row, removed %', affected_count;
  END IF;
END $$;

DROP TABLE model_pricing_0238_backup;

COMMIT;
