-- order-dependency: 0255_cursor_fable_51
-- 0256_cursor_picker_plan_gate_half_price.sql
-- Cursor picker: strip the "Cursor " display prefix, retire Composer 2.5,
-- gate Opus 4.8 / Opus 5 / Fable 5 / Fable 5.1 behind the Lite plan, and
-- halve those families' four per-MTok fen fields (BIGINT floor). Fast
-- multiplier stays 2. Historical usage_records are never recomputed.
--
-- Catalog counts (fail-closed if they drift):
--   42 cursor-* pricing rows including cursor-auto
--   41 display-name strips (every cursor-* row except cursor-auto)
--   30 half-price / min_plan targets = opus-4.8(10)+opus-5(10)+fable-5(5)+fable-5.1(5)
-- The product brief said "40/43"; unique protocol CURSOR_ENGINE_MODELS plus the
-- 0255 catalog snapshot are 42/41/30. Replay is refused by the durable backup
-- table (re-halving would double-apply). Compensation keeps the
-- schema_migrations ledger row:
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
--     -f packages/commercial/src/db/rollbacks/0256_cursor_picker_plan_gate_half_price.sql
--
-- The staged-table rename requires OC_V5_ALLOW_BREAKING_MIGRATION=1.

-- BEGIN TESTED MANUAL COMPENSATION 0256
-- Keep the 0256 schema_migrations ledger row and model_pricing_0256_backup.
-- Replaying /2 would half again. Fail-closed on later migrations or any
-- catalog/price/admin drift after 0256.
--
-- BEGIN;
-- LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;
-- DO $compensation_guard$
-- BEGIN
--   IF to_regclass('public.model_pricing_0256_backup') IS NULL THEN
--     RAISE EXCEPTION '0256 rollback requires model_pricing_0256_backup';
--   END IF;
--   IF NOT EXISTS (
--     SELECT 1 FROM schema_migrations
--      WHERE version = '0256_cursor_picker_plan_gate_half_price'
--   ) THEN
--     RAISE EXCEPTION '0256 rollback requires its schema_migrations ledger row';
--   END IF;
--   IF EXISTS (
--     SELECT 1 FROM schema_migrations
--      WHERE version > '0256_cursor_picker_plan_gate_half_price'
--   ) THEN
--     RAISE EXCEPTION '0256 rollback refuses when later migrations are already applied';
--   END IF;
-- END
-- $compensation_guard$;
-- LOCK TABLE model_pricing, model_catalog, account_group_models,
--   model_pricing_0256_backup IN ACCESS EXCLUSIVE MODE;
-- DO $compensation$
-- DECLARE
--   snapshot_count BIGINT;
--   live_count BIGINT;
--   affected_count BIGINT;
--   rec RECORD;
-- BEGIN
--   SELECT count(*) INTO snapshot_count FROM model_pricing_0256_backup;
--   IF snapshot_count <> 30 THEN
--     RAISE EXCEPTION '0256 rollback expected 30 backup rows, found %', snapshot_count;
--   END IF;
--   SELECT count(*) INTO live_count
--     FROM model_pricing_0256_backup AS backup
--     JOIN model_pricing AS pricing ON pricing.model_id = backup.model_id;
--   IF live_count <> 30 THEN
--     RAISE EXCEPTION '0256 rollback expected 30 live target rows, found %', live_count;
--   END IF;
--   IF EXISTS (
--     SELECT 1
--       FROM model_pricing AS pricing
--       JOIN model_pricing_0256_backup AS backup
--         ON pricing.model_id = backup.model_id
--      WHERE pricing.input_per_mtok <> backup.input_per_mtok / 2
--         OR pricing.output_per_mtok <> backup.output_per_mtok / 2
--         OR pricing.cache_read_per_mtok <> backup.cache_read_per_mtok / 2
--         OR pricing.cache_write_per_mtok <> backup.cache_write_per_mtok / 2
--         OR pricing.multiplier IS DISTINCT FROM backup.multiplier
--         OR pricing.min_plan_code IS DISTINCT FROM 'lite'
--         OR pricing.promo_label IS DISTINCT FROM '限时半价'
--         OR pricing.display_name IS DISTINCT FROM regexp_replace(backup.display_name, '^Cursor ', '')
--         OR pricing.enabled IS DISTINCT FROM backup.enabled
--         OR pricing.visibility IS DISTINCT FROM backup.visibility
--   ) THEN
--     RAISE EXCEPTION '0256 rollback refuses post-migration drift';
--   END IF;
--   IF (SELECT count(*) FROM model_catalog
--        WHERE model_id IN ('cursor-composer-2.5','cursor-composer-2.5-fast')
--          AND state = 'disabled') <> 2
--      OR (SELECT count(*) FROM model_pricing
--           WHERE model_id IN ('cursor-composer-2.5','cursor-composer-2.5-fast')
--             AND enabled IS FALSE AND visibility = 'hidden') <> 2 THEN
--     RAISE EXCEPTION '0256 rollback refuses composer disable drift';
--   END IF;
--
--   UPDATE model_pricing AS pricing
--      SET input_per_mtok = backup.input_per_mtok,
--          output_per_mtok = backup.output_per_mtok,
--          cache_read_per_mtok = backup.cache_read_per_mtok,
--          cache_write_per_mtok = backup.cache_write_per_mtok,
--          min_plan_code = backup.min_plan_code,
--          promo_label = backup.promo_label,
--          display_name = backup.display_name,
--          updated_at = clock_timestamp(),
--          lock_version = pricing.lock_version + 1
--     FROM model_pricing_0256_backup AS backup
--    WHERE pricing.model_id = backup.model_id;
--   GET DIAGNOSTICS affected_count = ROW_COUNT;
--   IF affected_count <> 30 THEN
--     RAISE EXCEPTION '0256 rollback expected to restore 30 target rows, restored %', affected_count;
--   END IF;
--
--   UPDATE model_pricing
--      SET display_name = 'Cursor ' || display_name,
--          updated_at = clock_timestamp(),
--          lock_version = lock_version + 1
--    WHERE model_id LIKE 'cursor-%'
--      AND model_id <> 'cursor-auto'
--      AND display_name NOT LIKE 'Cursor %';
--
--   FOR rec IN
--     SELECT entry_id, lock_version
--       FROM model_catalog
--      WHERE model_id IN ('cursor-composer-2.5','cursor-composer-2.5-fast')
--        AND state = 'disabled'
--      ORDER BY model_id
--   LOOP
--     PERFORM fn_model_activate_entry(rec.entry_id, rec.lock_version, NULL);
--   END LOOP;
--
--   UPDATE model_pricing
--      SET enabled = TRUE,
--          visibility = 'public',
--          lock_version = lock_version + 1,
--          updated_at = clock_timestamp()
--    WHERE model_id IN ('cursor-composer-2.5','cursor-composer-2.5-fast');
--
--   INSERT INTO account_group_models(group_id, model_id)
--   SELECT g.id, m.model_id
--     FROM account_groups g
--     CROSS JOIN (VALUES
--       ('cursor-composer-2.5'),
--       ('cursor-composer-2.5-fast')
--     ) AS m(model_id)
--    WHERE g.kind = 'official_oauth' AND g.provider = 'cursor'
--   ON CONFLICT DO NOTHING;
-- END
-- $compensation$;
-- COMMIT;
-- END TESTED MANUAL COMPENSATION 0256

DO $$
BEGIN
  IF to_regclass('public.model_pricing_0256_backup') IS NOT NULL THEN
    RAISE EXCEPTION '0256 refuses replay because model_pricing_0256_backup already exists';
  END IF;
END $$;

ALTER TABLE model_pricing
  ADD COLUMN IF NOT EXISTS promo_label text NULL;

CREATE TABLE model_pricing_0256_backup_staged (
  model_id              TEXT PRIMARY KEY,
  family                TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  input_per_mtok        BIGINT NOT NULL,
  output_per_mtok       BIGINT NOT NULL,
  cache_read_per_mtok   BIGINT NOT NULL,
  cache_write_per_mtok  BIGINT NOT NULL,
  multiplier            NUMERIC(6,3) NOT NULL,
  enabled               BOOLEAN NOT NULL,
  sort_order            INTEGER NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL,
  updated_by            BIGINT,
  visibility            TEXT NOT NULL,
  extra_system_prompt   TEXT,
  default_effort        TEXT,
  lock_version          INTEGER NOT NULL,
  min_plan_code         TEXT,
  promo_label           TEXT,
  captured_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

LOCK TABLE model_catalog, model_pricing, account_group_models,
  user_preferences, client_sessions, model_visibility_grants,
  model_aliases, model_runtime_requirements
  IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO model_pricing_0256_backup_staged (
  model_id, family, display_name,
  input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
  multiplier, enabled, sort_order, updated_at, updated_by, visibility,
  extra_system_prompt, default_effort, lock_version, min_plan_code, promo_label
)
SELECT
  pricing.model_id,
  targets.family,
  pricing.display_name,
  pricing.input_per_mtok,
  pricing.output_per_mtok,
  pricing.cache_read_per_mtok,
  pricing.cache_write_per_mtok,
  pricing.multiplier,
  pricing.enabled,
  pricing.sort_order,
  pricing.updated_at,
  pricing.updated_by,
  pricing.visibility,
  pricing.extra_system_prompt,
  pricing.default_effort,
  pricing.lock_version,
  pricing.min_plan_code,
  pricing.promo_label
FROM (VALUES
  ('cursor-opus-4.8-low', 'opus'),
  ('cursor-opus-4.8-low-fast', 'opus'),
  ('cursor-opus-4.8-medium', 'opus'),
  ('cursor-opus-4.8-medium-fast', 'opus'),
  ('cursor-opus-4.8-high', 'opus'),
  ('cursor-opus-4.8-high-fast', 'opus'),
  ('cursor-opus-4.8-xhigh', 'opus'),
  ('cursor-opus-4.8-xhigh-fast', 'opus'),
  ('cursor-opus-4.8-max', 'opus'),
  ('cursor-opus-4.8-max-fast', 'opus'),
  ('cursor-opus-5-low', 'opus'),
  ('cursor-opus-5-low-fast', 'opus'),
  ('cursor-opus-5-medium', 'opus'),
  ('cursor-opus-5-medium-fast', 'opus'),
  ('cursor-opus-5-high', 'opus'),
  ('cursor-opus-5-high-fast', 'opus'),
  ('cursor-opus-5-xhigh', 'opus'),
  ('cursor-opus-5-xhigh-fast', 'opus'),
  ('cursor-opus-5-max', 'opus'),
  ('cursor-opus-5-max-fast', 'opus'),
  ('cursor-fable-5-low', 'fable'),
  ('cursor-fable-5-medium', 'fable'),
  ('cursor-fable-5-high', 'fable'),
  ('cursor-fable-5-xhigh', 'fable'),
  ('cursor-fable-5-max', 'fable'),
  ('cursor-fable-5.1-low', 'fable'),
  ('cursor-fable-5.1-medium', 'fable'),
  ('cursor-fable-5.1-high', 'fable'),
  ('cursor-fable-5.1-xhigh', 'fable'),
  ('cursor-fable-5.1-max', 'fable')
) AS targets(model_id, family)
JOIN model_pricing AS pricing ON pricing.model_id = targets.model_id
JOIN model_catalog AS catalog
  ON catalog.model_id = targets.model_id AND catalog.state = 'active';

ALTER TABLE model_pricing_0256_backup_staged
  RENAME TO model_pricing_0256_backup;

DO $$
DECLARE
  snapshot_count BIGINT;
  cursor_count BIGINT;
  strip_count BIGINT;
  group_count BIGINT;
  affected_count BIGINT;
  rec RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM subscription_plans
     WHERE code = 'lite' AND scope = 'user' AND enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0256 requires enabled user-scope lite plan';
  END IF;

  SELECT count(*) INTO cursor_count
    FROM model_pricing
   WHERE model_id LIKE 'cursor-%';
  IF cursor_count <> 42 THEN
    RAISE EXCEPTION '0256 expected 42 cursor-* pricing rows, found %', cursor_count;
  END IF;

  SELECT count(*) INTO snapshot_count FROM model_pricing_0256_backup;
  IF snapshot_count <> 30 THEN
    RAISE EXCEPTION '0256 expected exactly 30 Opus/Fable target rows, found %', snapshot_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_pricing_0256_backup
     WHERE (family = 'opus' AND (
              input_per_mtok <> 1523
           OR output_per_mtok <> 7617
           OR cache_read_per_mtok <> 152
           OR cache_write_per_mtok <> 0
           ))
        OR (family = 'fable' AND (
              input_per_mtok <> 3049
           OR output_per_mtok <> 15243
           OR cache_read_per_mtok <> 305
           OR cache_write_per_mtok <> 0
           ))
  ) THEN
    RAISE EXCEPTION '0256 refuses unexpected Opus/Fable before-image prices (prevents double-halving)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_pricing_0256_backup
     WHERE input_per_mtok < 0
        OR output_per_mtok < 0
        OR cache_read_per_mtok < 0
        OR cache_write_per_mtok < 0
        OR lock_version >= 2147483646
  ) THEN
    RAISE EXCEPTION '0256 refuses negative prices or lock_version overflow';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing
     WHERE model_id LIKE 'cursor-%'
       AND model_id <> 'cursor-auto'
       AND display_name NOT LIKE 'Cursor %'
  ) THEN
    RAISE EXCEPTION '0256 expected every non-auto cursor display_name to start with Cursor ';
  END IF;

  IF EXISTS (
    SELECT 1 FROM client_sessions
     WHERE deleted_at IS NULL
       AND model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
  ) OR EXISTS (
    SELECT 1 FROM user_preferences
     WHERE prefs->>'default_model' IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
  ) OR EXISTS (
    SELECT 1 FROM model_visibility_grants
     WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
  ) OR EXISTS (
    SELECT 1 FROM model_runtime_requirements
     WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
  ) OR EXISTS (
    SELECT 1
      FROM model_aliases a
      JOIN model_catalog c ON c.entry_id = a.entry_id
     WHERE c.model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
  ) THEN
    RAISE EXCEPTION '0256 refuses Composer 2.5 disable while persisted references remain';
  END IF;

  IF (SELECT count(*) FROM model_catalog
       WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
         AND state = 'active') <> 2
     OR (SELECT count(*) FROM model_pricing
          WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
            AND enabled IS TRUE) <> 2 THEN
    RAISE EXCEPTION '0256 requires two active enabled Composer 2.5 catalog/pricing rows';
  END IF;

  UPDATE model_pricing
     SET display_name = regexp_replace(display_name, '^Cursor ', ''),
         updated_at = clock_timestamp(),
         lock_version = lock_version + 1
   WHERE model_id LIKE 'cursor-%'
     AND model_id <> 'cursor-auto'
     AND display_name LIKE 'Cursor %';
  GET DIAGNOSTICS strip_count = ROW_COUNT;
  IF strip_count <> 41 THEN
    RAISE EXCEPTION '0256 expected to strip 41 Cursor display prefixes, updated %', strip_count;
  END IF;

  DELETE FROM account_group_models
   WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast');
  GET DIAGNOSTICS group_count = ROW_COUNT;
  IF group_count <> 2 THEN
    RAISE EXCEPTION '0256 expected to delete 2 Composer account_group_models rows, deleted %', group_count;
  END IF;

  FOR rec IN
    SELECT entry_id, lock_version
      FROM model_catalog
     WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
       AND state = 'active'
     ORDER BY model_id
  LOOP
    PERFORM fn_model_disable_entry(rec.entry_id, rec.lock_version, NULL);
  END LOOP;

  UPDATE model_pricing
     SET enabled = FALSE,
         visibility = 'hidden',
         lock_version = lock_version + 1,
         updated_at = clock_timestamp()
   WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
     AND (enabled IS DISTINCT FROM FALSE OR visibility IS DISTINCT FROM 'hidden');

  UPDATE model_pricing AS pricing
     SET input_per_mtok = backup.input_per_mtok / 2,
         output_per_mtok = backup.output_per_mtok / 2,
         cache_read_per_mtok = backup.cache_read_per_mtok / 2,
         cache_write_per_mtok = backup.cache_write_per_mtok / 2,
         min_plan_code = 'lite',
         promo_label = '限时半价',
         updated_at = clock_timestamp(),
         lock_version = pricing.lock_version + 1
    FROM model_pricing_0256_backup AS backup
   WHERE pricing.model_id = backup.model_id;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 30 THEN
    RAISE EXCEPTION '0256 expected to reprice 30 Opus/Fable rows, updated %', affected_count;
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
        OR pricing.sort_order IS DISTINCT FROM backup.sort_order
        OR pricing.updated_by IS DISTINCT FROM backup.updated_by
        OR pricing.extra_system_prompt IS DISTINCT FROM backup.extra_system_prompt
        OR pricing.default_effort IS DISTINCT FROM backup.default_effort
  ) THEN
    RAISE EXCEPTION '0256 Opus/Fable repricing postcondition mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing
     WHERE model_id LIKE 'cursor-%'
       AND model_id <> 'cursor-auto'
       AND display_name LIKE 'Cursor %'
  ) OR EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id = 'cursor-auto' AND display_name IS DISTINCT FROM 'Cursor Auto'
  ) THEN
    RAISE EXCEPTION '0256 display_name strip postcondition mismatch';
  END IF;

  IF (SELECT count(*) FROM model_catalog
       WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
         AND state = 'disabled') <> 2
     OR (SELECT count(*) FROM model_pricing
          WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
            AND enabled IS FALSE AND visibility = 'hidden') <> 2
     OR EXISTS (
       SELECT 1 FROM account_group_models
        WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
     ) THEN
    RAISE EXCEPTION '0256 Composer retirement postcondition mismatch';
  END IF;
END $$;

SELECT fn_model_security_epoch_bump();
