-- 0238_long_context_price_15x.sql
-- Reprice the four user-selectable standard/1M context pairs so the 1M tier
-- uses 1.5x of its standard tier's persisted four-dimensional unit prices.
--
-- model_pricing dimensions are BIGINT credits/MTok. Exact .5 results round to
-- the nearest integer with .5 upward: ceil(standard * 3 / 2). multiplier stays
-- 1; historical usage_records snapshots and already-settled costs stay intact.
--
-- A four-row durable snapshot makes manual compensation exact. The staged
-- rename intentionally requires the selfhost breaking-migration approval gate.

CREATE TABLE model_pricing_0238_backup_staged (
  long_model_id                  TEXT PRIMARY KEY,
  standard_model_id              TEXT NOT NULL UNIQUE,
  display_name                   TEXT NOT NULL,
  input_per_mtok                 BIGINT NOT NULL,
  output_per_mtok                BIGINT NOT NULL,
  cache_read_per_mtok            BIGINT NOT NULL,
  cache_write_per_mtok           BIGINT NOT NULL,
  multiplier                     NUMERIC(6,3) NOT NULL,
  enabled                        BOOLEAN NOT NULL,
  sort_order                     INTEGER NOT NULL,
  updated_at                     TIMESTAMPTZ NOT NULL,
  updated_by                     BIGINT,
  visibility                     TEXT NOT NULL,
  extra_system_prompt            TEXT,
  default_effort                 TEXT,
  lock_version                   INTEGER NOT NULL,
  min_plan_code                  TEXT,
  standard_input_per_mtok        BIGINT NOT NULL,
  standard_output_per_mtok       BIGINT NOT NULL,
  standard_cache_read_per_mtok   BIGINT NOT NULL,
  standard_cache_write_per_mtok  BIGINT NOT NULL,
  standard_multiplier            NUMERIC(6,3) NOT NULL,
  captured_at                    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

LOCK TABLE model_pricing IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO model_pricing_0238_backup_staged (
  long_model_id, standard_model_id, display_name,
  input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
  multiplier, enabled, sort_order, updated_at, updated_by, visibility,
  extra_system_prompt, default_effort, lock_version, min_plan_code,
  standard_input_per_mtok, standard_output_per_mtok,
  standard_cache_read_per_mtok, standard_cache_write_per_mtok,
  standard_multiplier
)
SELECT
  pairs.long_model_id,
  pairs.standard_model_id,
  long.display_name,
  long.input_per_mtok,
  long.output_per_mtok,
  long.cache_read_per_mtok,
  long.cache_write_per_mtok,
  long.multiplier,
  long.enabled,
  long.sort_order,
  long.updated_at,
  long.updated_by,
  long.visibility,
  long.extra_system_prompt,
  long.default_effort,
  long.lock_version,
  long.min_plan_code,
  standard.input_per_mtok,
  standard.output_per_mtok,
  standard.cache_read_per_mtok,
  standard.cache_write_per_mtok,
  standard.multiplier
FROM (VALUES
  ('gpt-5.6-sol-1m',   'gpt-5.6-sol'),
  ('gpt-5.6-terra-1m', 'gpt-5.6-terra'),
  ('gpt-5.6-luna-1m',  'gpt-5.6-luna'),
  ('kimi-k3',           'k3-256k')
) AS pairs(long_model_id, standard_model_id)
JOIN model_pricing AS long
  ON long.model_id = pairs.long_model_id
JOIN model_pricing AS standard
  ON standard.model_id = pairs.standard_model_id;

ALTER TABLE model_pricing_0238_backup_staged
  RENAME TO model_pricing_0238_backup;

DO $$
DECLARE
  snapshot_count BIGINT;
  affected_count BIGINT;
BEGIN
  SELECT count(*) INTO snapshot_count FROM model_pricing_0238_backup;
  IF snapshot_count <> 4 THEN
    RAISE EXCEPTION '0238 expected exactly 4 standard/1M pairs, found %', snapshot_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing_0238_backup
     WHERE input_per_mtok < 0
        OR output_per_mtok < 0
        OR cache_read_per_mtok < 0
        OR cache_write_per_mtok < 0
        OR standard_input_per_mtok < 0
        OR standard_output_per_mtok < 0
        OR standard_cache_read_per_mtok < 0
        OR standard_cache_write_per_mtok < 0
  ) THEN
    RAISE EXCEPTION '0238 refuses negative model prices';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing_0238_backup
     WHERE multiplier <> 1
        OR standard_multiplier <> 1
  ) THEN
    RAISE EXCEPTION '0238 requires multiplier=1 for both context tiers';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing_0238_backup
     WHERE lock_version >= 2147483646
  ) THEN
    RAISE EXCEPTION '0238 refuses lock_version overflow';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing_0238_backup
     WHERE standard_input_per_mtok > 3074457345618258602
        OR standard_output_per_mtok > 3074457345618258602
        OR standard_cache_read_per_mtok > 3074457345618258602
        OR standard_cache_write_per_mtok > 3074457345618258602
  ) THEN
    RAISE EXCEPTION '0238 refuses BIGINT overflow while computing 1.5x';
  END IF;

  UPDATE model_pricing AS pricing
     SET input_per_mtok = (backup.standard_input_per_mtok * 3 + 1) / 2,
         output_per_mtok = (backup.standard_output_per_mtok * 3 + 1) / 2,
         cache_read_per_mtok = (backup.standard_cache_read_per_mtok * 3 + 1) / 2,
         cache_write_per_mtok = (backup.standard_cache_write_per_mtok * 3 + 1) / 2,
         updated_at = clock_timestamp(),
         lock_version = pricing.lock_version + 1
    FROM model_pricing_0238_backup AS backup
   WHERE pricing.model_id = backup.long_model_id;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 4 THEN
    RAISE EXCEPTION '0238 expected to update 4 long-context rows, updated %', affected_count;
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
    RAISE EXCEPTION '0238 long-context repricing postcondition mismatch';
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
    RAISE EXCEPTION '0238 standard-tier price drifted during migration';
  END IF;
END $$;
