-- Manual compensation for 0245_gpt56_family_half_xn.
--
-- Keep both the 0245 schema_migrations ledger row and the durable backup table.
-- Replaying /2 would half again, so a release retry must not re-apply this
-- version after compensation. Fail-closed on later migrations or any
-- catalog/price/admin drift after 0245.

BEGIN;

LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF to_regclass('public.model_pricing_0245_backup') IS NULL THEN
    RAISE EXCEPTION '0245 rollback requires model_pricing_0245_backup';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version = '0245_gpt56_family_half_xn'
  ) THEN
    RAISE EXCEPTION '0245 rollback requires its schema_migrations ledger row';
  END IF;
  IF EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version > '0245_gpt56_family_half_xn'
  ) THEN
    RAISE EXCEPTION '0245 rollback refuses when later migrations are already applied';
  END IF;
END $$;

LOCK TABLE model_pricing, model_pricing_0245_backup IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  snapshot_count BIGINT;
  live_count BIGINT;
  affected_count BIGINT;
BEGIN
  SELECT count(*) INTO snapshot_count FROM model_pricing_0245_backup;
  IF snapshot_count <> 6 THEN
    RAISE EXCEPTION '0245 rollback expected 6 backup rows, found %', snapshot_count;
  END IF;

  SELECT count(*) INTO live_count
    FROM model_pricing_0245_backup AS backup
    JOIN model_pricing AS pricing
      ON pricing.model_id = backup.model_id;
  IF live_count <> 6 THEN
    RAISE EXCEPTION '0245 rollback expected 6 live GPT-5.6 rows, found %', live_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing AS pricing
      JOIN model_pricing_0245_backup AS backup
        ON pricing.model_id = backup.model_id
     WHERE (
            NOT backup.is_long
        AND (
              pricing.input_per_mtok <> backup.input_per_mtok / 2
           OR pricing.output_per_mtok <> backup.output_per_mtok / 2
           OR pricing.cache_read_per_mtok <> backup.cache_read_per_mtok / 2
           OR pricing.cache_write_per_mtok <> backup.cache_write_per_mtok / 2
        )
       ) OR (
            backup.is_long
        AND (
              pricing.input_per_mtok <> ((backup.standard_input_per_mtok / 2) * 3 + 1) / 2
           OR pricing.output_per_mtok <> ((backup.standard_output_per_mtok / 2) * 3 + 1) / 2
           OR pricing.cache_read_per_mtok <> ((backup.standard_cache_read_per_mtok / 2) * 3 + 1) / 2
           OR pricing.cache_write_per_mtok <> ((backup.standard_cache_write_per_mtok / 2) * 3 + 1) / 2
        )
       )
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
    RAISE EXCEPTION '0245 rollback refuses post-migration drift';
  END IF;

  UPDATE model_pricing AS pricing
     SET input_per_mtok = backup.input_per_mtok,
         output_per_mtok = backup.output_per_mtok,
         cache_read_per_mtok = backup.cache_read_per_mtok,
         cache_write_per_mtok = backup.cache_write_per_mtok,
         updated_at = clock_timestamp(),
         lock_version = pricing.lock_version + 1
    FROM model_pricing_0245_backup AS backup
   WHERE pricing.model_id = backup.model_id;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 6 THEN
    RAISE EXCEPTION '0245 rollback expected to restore 6 rows, restored %', affected_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing AS pricing
      JOIN model_pricing_0245_backup AS backup
        ON pricing.model_id = backup.model_id
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
    RAISE EXCEPTION '0245 rollback restore postcondition mismatch';
  END IF;
END $$;

COMMIT;
