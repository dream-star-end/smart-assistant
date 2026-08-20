-- 0234_all_model_prices_half.sql
-- One-shot selfhost repricing: halve every persisted model unit-price dimension.
--
-- model_pricing prices are BIGINT fen/MTok, so odd values round down. That is the
-- user-favouring direction and differs from an exact half by at most 0.5 fen/MTok.
-- Multipliers stay unchanged, preserving Fast = 2x its family baseline.
-- Historical usage_records price snapshots and settled costs are intentionally untouched.
--
-- This migration first persists a complete, keyed snapshot. Manual compensation keeps
-- the schema_migrations ledger row and runs:
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \\
--     -f packages/commercial/src/db/rollbacks/0234_all_model_prices_half.sql
--
-- The staged-table rename intentionally makes the selfhost breaking-migration gate require
-- OC_V5_ALLOW_BREAKING_MIGRATION=1: integer division is lossy without the durable snapshot.

CREATE TABLE model_pricing_0234_backup_staged (
  model_id              TEXT PRIMARY KEY,
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
  captured_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO model_pricing_0234_backup_staged (
  model_id, display_name,
  input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
  multiplier, enabled, sort_order, updated_at, updated_by, visibility,
  extra_system_prompt, default_effort, lock_version, min_plan_code
)
SELECT
  model_id, display_name,
  input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
  multiplier, enabled, sort_order, updated_at, updated_by, visibility,
  extra_system_prompt, default_effort, lock_version, min_plan_code
FROM model_pricing;

ALTER TABLE model_pricing_0234_backup_staged
  RENAME TO model_pricing_0234_backup;

DO $$
DECLARE
  snapshot_count BIGINT;
  affected_count BIGINT;
BEGIN
  SELECT count(*) INTO snapshot_count FROM model_pricing_0234_backup;
  IF snapshot_count <= 0 THEN
    RAISE EXCEPTION '0234 refuses an empty model_pricing snapshot';
  END IF;

  IF snapshot_count <> (SELECT count(*) FROM model_pricing) THEN
    RAISE EXCEPTION '0234 snapshot row count drift: backup %, live %',
      snapshot_count, (SELECT count(*) FROM model_pricing);
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing_0234_backup
     WHERE input_per_mtok < 0
        OR output_per_mtok < 0
        OR cache_read_per_mtok < 0
        OR cache_write_per_mtok < 0
  ) THEN
    RAISE EXCEPTION '0234 refuses negative model prices';
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_pricing_0234_backup
     WHERE lock_version >= 2147483646
  ) THEN
    RAISE EXCEPTION '0234 refuses lock_version overflow';
  END IF;

  UPDATE model_pricing AS pricing
     SET input_per_mtok = backup.input_per_mtok / 2,
         output_per_mtok = backup.output_per_mtok / 2,
         cache_read_per_mtok = backup.cache_read_per_mtok / 2,
         cache_write_per_mtok = backup.cache_write_per_mtok / 2,
         updated_at = clock_timestamp(),
         lock_version = pricing.lock_version + 1
    FROM model_pricing_0234_backup AS backup
   WHERE pricing.model_id = backup.model_id;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> snapshot_count THEN
    RAISE EXCEPTION '0234 expected to update % rows, updated %',
      snapshot_count, affected_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing AS pricing
      FULL JOIN model_pricing_0234_backup AS backup USING (model_id)
     WHERE pricing.model_id IS NULL OR backup.model_id IS NULL
  ) THEN
    RAISE EXCEPTION '0234 model_id set drifted during repricing';
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
    RAISE EXCEPTION '0234 repricing postcondition mismatch';
  END IF;
END $$;
