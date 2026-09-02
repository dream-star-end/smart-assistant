-- Manual compensation for 0256_cursor_picker_plan_gate_half_price.
--
-- Keep both the 0256 schema_migrations ledger row and the durable backup table.
-- Replaying /2 would half again, so a release retry must not re-apply this
-- version after compensation. Fail-closed on later migrations or any
-- catalog/price/admin drift after 0256.

BEGIN;

LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF to_regclass('public.model_pricing_0256_backup') IS NULL THEN
    RAISE EXCEPTION '0256 rollback requires model_pricing_0256_backup';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version = '0256_cursor_picker_plan_gate_half_price'
  ) THEN
    RAISE EXCEPTION '0256 rollback requires its schema_migrations ledger row';
  END IF;
  IF EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version > '0256_cursor_picker_plan_gate_half_price'
  ) THEN
    RAISE EXCEPTION '0256 rollback refuses when later migrations are already applied';
  END IF;
END $$;

LOCK TABLE model_pricing, model_catalog, account_group_models,
  model_pricing_0256_backup IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  snapshot_count BIGINT;
  live_count BIGINT;
  affected_count BIGINT;
  cursor_oauth_n BIGINT;
  rec RECORD;
BEGIN
  SELECT count(*) INTO snapshot_count FROM model_pricing_0256_backup;
  IF snapshot_count <> 30 THEN
    RAISE EXCEPTION '0256 rollback expected 30 backup rows, found %', snapshot_count;
  END IF;

  SELECT count(*) INTO live_count
    FROM model_pricing_0256_backup AS backup
    JOIN model_pricing AS pricing
      ON pricing.model_id = backup.model_id;
  IF live_count <> 30 THEN
    RAISE EXCEPTION '0256 rollback expected 30 live target rows, found %', live_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing AS pricing
      JOIN model_pricing_0256_backup AS backup
        ON pricing.model_id = backup.model_id
     WHERE pricing.input_per_mtok <> backup.input_per_mtok / 2
        OR pricing.output_per_mtok <> backup.output_per_mtok / 2
        OR pricing.cache_read_per_mtok <> backup.cache_read_per_mtok / 2
        OR pricing.cache_write_per_mtok <> backup.cache_write_per_mtok / 2
        OR pricing.multiplier IS DISTINCT FROM backup.multiplier
        OR pricing.min_plan_code IS DISTINCT FROM 'lite'
        OR pricing.promo_label IS DISTINCT FROM '限时半价'
        OR pricing.display_name IS DISTINCT FROM regexp_replace(backup.display_name, '^Cursor ', '')
        OR pricing.enabled IS DISTINCT FROM backup.enabled
        OR pricing.visibility IS DISTINCT FROM backup.visibility
  ) THEN
    RAISE EXCEPTION '0256 rollback refuses post-migration drift';
  END IF;

  -- Mirror the forward Composer exact-shape precondition: restore is
  -- visibility='public' plus {(g, composer), (g, composer-fast)} for every
  -- official_oauth/cursor group g. Fail closed if post-0256 Composer image
  -- drifted or those groups disappeared (rollback would otherwise widen).
  SELECT count(*) INTO cursor_oauth_n
    FROM account_groups
   WHERE kind = 'official_oauth' AND provider = 'cursor';
  IF cursor_oauth_n < 1 THEN
    RAISE EXCEPTION '0256 rollback requires at least one official_oauth/cursor account group';
  END IF;

  IF (SELECT count(*) FROM model_catalog
       WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
         AND state = 'disabled') <> 2
     OR (SELECT count(*) FROM model_pricing
          WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
            AND enabled IS FALSE
            AND visibility = 'hidden') <> 2
     OR EXISTS (
       SELECT 1 FROM account_group_models
        WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
     ) THEN
    RAISE EXCEPTION '0256 rollback refuses composer disable drift';
  END IF;

  UPDATE model_pricing AS pricing
     SET input_per_mtok = backup.input_per_mtok,
         output_per_mtok = backup.output_per_mtok,
         cache_read_per_mtok = backup.cache_read_per_mtok,
         cache_write_per_mtok = backup.cache_write_per_mtok,
         min_plan_code = backup.min_plan_code,
         promo_label = backup.promo_label,
         display_name = backup.display_name,
         updated_at = clock_timestamp(),
         lock_version = pricing.lock_version + 1
    FROM model_pricing_0256_backup AS backup
   WHERE pricing.model_id = backup.model_id;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 30 THEN
    RAISE EXCEPTION '0256 rollback expected to restore 30 target rows, restored %', affected_count;
  END IF;

  UPDATE model_pricing
     SET display_name = 'Cursor ' || display_name,
         updated_at = clock_timestamp(),
         lock_version = lock_version + 1
   WHERE model_id LIKE 'cursor-%'
     AND model_id <> 'cursor-auto'
     AND display_name NOT LIKE 'Cursor %';

  FOR rec IN
    SELECT entry_id, lock_version
      FROM model_catalog
     WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
       AND state = 'disabled'
     ORDER BY model_id
  LOOP
    PERFORM fn_model_activate_entry(rec.entry_id, rec.lock_version, NULL);
  END LOOP;

  UPDATE model_pricing
     SET enabled = TRUE,
         visibility = 'public',
         lock_version = lock_version + 1,
         updated_at = clock_timestamp()
   WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast');

  INSERT INTO account_group_models(group_id, model_id)
  SELECT g.id, m.model_id
    FROM account_groups g
    CROSS JOIN (VALUES
      ('cursor-composer-2.5'),
      ('cursor-composer-2.5-fast')
    ) AS m(model_id)
   WHERE g.kind = 'official_oauth'
     AND g.provider = 'cursor'
  ON CONFLICT DO NOTHING;

  IF (SELECT count(*) FROM account_group_models
       WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast'))
       <> (2 * cursor_oauth_n)
     OR EXISTS (
       SELECT 1 FROM account_groups g
        WHERE g.kind = 'official_oauth'
          AND g.provider = 'cursor'
          AND (
            NOT EXISTS (
              SELECT 1 FROM account_group_models agm
               WHERE agm.group_id = g.id AND agm.model_id = 'cursor-composer-2.5'
            )
            OR NOT EXISTS (
              SELECT 1 FROM account_group_models agm
               WHERE agm.group_id = g.id AND agm.model_id = 'cursor-composer-2.5-fast'
            )
          )
     ) THEN
    RAISE EXCEPTION '0256 rollback failed to restore Composer 2.5 group bindings';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing AS pricing
      JOIN model_pricing_0256_backup AS backup
        ON pricing.model_id = backup.model_id
     WHERE pricing.input_per_mtok <> backup.input_per_mtok
        OR pricing.output_per_mtok <> backup.output_per_mtok
        OR pricing.cache_read_per_mtok <> backup.cache_read_per_mtok
        OR pricing.cache_write_per_mtok <> backup.cache_write_per_mtok
        OR pricing.min_plan_code IS DISTINCT FROM backup.min_plan_code
        OR pricing.promo_label IS DISTINCT FROM backup.promo_label
        OR pricing.display_name IS DISTINCT FROM backup.display_name
        OR pricing.multiplier IS DISTINCT FROM backup.multiplier
  ) THEN
    RAISE EXCEPTION '0256 rollback restore postcondition mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing
     WHERE model_id LIKE 'cursor-%'
       AND model_id <> 'cursor-auto'
       AND display_name NOT LIKE 'Cursor %'
  ) THEN
    RAISE EXCEPTION '0256 rollback failed to restore Cursor display prefixes';
  END IF;

  IF (SELECT count(*) FROM model_catalog
       WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
         AND state = 'active') <> 2
     OR (SELECT count(*) FROM model_pricing
          WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
            AND enabled IS TRUE
            AND visibility = 'public') <> 2 THEN
    RAISE EXCEPTION '0256 rollback failed to restore Composer 2.5';
  END IF;
END $$;

COMMIT;
