-- 0245_gpt56_family_half_xn.sql
-- Halve GPT-5.6 Sol/Terra/Luna standard-tier fen so product xN becomes
-- x2.0 / x1.0 / x0.5 vs DeepSeek V4 Pro. Recompute the three 1M twins as
-- 1.5x of the *new* standard tier, preserving the 0238 long-context contract.
--
-- Other catalog rows are untouched. BIGINT /2 rounds down (same direction as
-- 0234). multiplier, visibility, enabled, and min_plan_code stay unchanged.
-- Historical usage_records snapshots and settled costs are intentionally
-- untouched.
--
-- A six-row durable snapshot makes manual compensation exact. The staged
-- rename requires OC_V5_ALLOW_BREAKING_MIGRATION=1. Compensation keeps the
-- schema_migrations ledger row: replaying /2 would half again.
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
--     -f packages/commercial/src/db/rollbacks/0245_gpt56_family_half_xn.sql

CREATE TABLE model_pricing_0245_backup_staged (
  model_id                       TEXT PRIMARY KEY,
  paired_standard_id             TEXT NOT NULL,
  is_long                        BOOLEAN NOT NULL,
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

INSERT INTO model_pricing_0245_backup_staged (
  model_id, paired_standard_id, is_long, display_name,
  input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
  multiplier, enabled, sort_order, updated_at, updated_by, visibility,
  extra_system_prompt, default_effort, lock_version, min_plan_code,
  standard_input_per_mtok, standard_output_per_mtok,
  standard_cache_read_per_mtok, standard_cache_write_per_mtok,
  standard_multiplier
)
SELECT
  pairs.model_id,
  pairs.paired_standard_id,
  pairs.is_long,
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
  standard.input_per_mtok,
  standard.output_per_mtok,
  standard.cache_read_per_mtok,
  standard.cache_write_per_mtok,
  standard.multiplier
FROM (VALUES
  ('gpt-5.6-sol',      'gpt-5.6-sol',      FALSE),
  ('gpt-5.6-sol-1m',   'gpt-5.6-sol',      TRUE),
  ('gpt-5.6-terra',    'gpt-5.6-terra',    FALSE),
  ('gpt-5.6-terra-1m', 'gpt-5.6-terra',    TRUE),
  ('gpt-5.6-luna',     'gpt-5.6-luna',     FALSE),
  ('gpt-5.6-luna-1m',  'gpt-5.6-luna',     TRUE)
) AS pairs(model_id, paired_standard_id, is_long)
JOIN model_pricing AS pricing
  ON pricing.model_id = pairs.model_id
JOIN model_pricing AS standard
  ON standard.model_id = pairs.paired_standard_id;

ALTER TABLE model_pricing_0245_backup_staged
  RENAME TO model_pricing_0245_backup;

DO $$
DECLARE
  snapshot_count BIGINT;
  standard_count BIGINT;
  long_count BIGINT;
  affected_count BIGINT;
BEGIN
  SELECT count(*) INTO snapshot_count FROM model_pricing_0245_backup;
  IF snapshot_count <> 6 THEN
    RAISE EXCEPTION '0245 expected exactly 6 GPT-5.6 rows, found %', snapshot_count;
  END IF;

  SELECT count(*) FILTER (WHERE NOT is_long),
         count(*) FILTER (WHERE is_long)
    INTO standard_count, long_count
    FROM model_pricing_0245_backup;
  IF standard_count <> 3 OR long_count <> 3 THEN
    RAISE EXCEPTION '0245 expected 3 standard + 3 long rows, found % / %',
      standard_count, long_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing_0245_backup
     WHERE input_per_mtok < 0
        OR output_per_mtok < 0
        OR cache_read_per_mtok < 0
        OR cache_write_per_mtok < 0
        OR standard_input_per_mtok < 0
        OR standard_output_per_mtok < 0
        OR standard_cache_read_per_mtok < 0
        OR standard_cache_write_per_mtok < 0
  ) THEN
    RAISE EXCEPTION '0245 refuses negative model prices';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing_0245_backup
     WHERE multiplier <> 1
        OR standard_multiplier <> 1
  ) THEN
    RAISE EXCEPTION '0245 requires multiplier=1 for GPT-5.6 standard and 1M tiers';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing_0245_backup
     WHERE NOT is_long
       AND (
         input_per_mtok <> standard_input_per_mtok
         OR output_per_mtok <> standard_output_per_mtok
         OR cache_read_per_mtok <> standard_cache_read_per_mtok
         OR cache_write_per_mtok <> standard_cache_write_per_mtok
         OR model_id <> paired_standard_id
       )
  ) THEN
    RAISE EXCEPTION '0245 standard-tier snapshot is inconsistent with its pair key';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing_0245_backup
     WHERE lock_version >= 2147483646
  ) THEN
    RAISE EXCEPTION '0245 refuses lock_version overflow';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing_0245_backup
     WHERE standard_input_per_mtok / 2 > 3074457345618258602
        OR standard_output_per_mtok / 2 > 3074457345618258602
        OR standard_cache_read_per_mtok / 2 > 3074457345618258602
        OR standard_cache_write_per_mtok / 2 > 3074457345618258602
  ) THEN
    RAISE EXCEPTION '0245 refuses BIGINT overflow while computing 1.5x of halved standard';
  END IF;

  UPDATE model_pricing AS pricing
     SET input_per_mtok = backup.input_per_mtok / 2,
         output_per_mtok = backup.output_per_mtok / 2,
         cache_read_per_mtok = backup.cache_read_per_mtok / 2,
         cache_write_per_mtok = backup.cache_write_per_mtok / 2,
         updated_at = clock_timestamp(),
         lock_version = pricing.lock_version + 1
    FROM model_pricing_0245_backup AS backup
   WHERE pricing.model_id = backup.model_id
     AND NOT backup.is_long;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 3 THEN
    RAISE EXCEPTION '0245 expected to update 3 standard rows, updated %', affected_count;
  END IF;

  UPDATE model_pricing AS pricing
     SET input_per_mtok = ((backup.standard_input_per_mtok / 2) * 3 + 1) / 2,
         output_per_mtok = ((backup.standard_output_per_mtok / 2) * 3 + 1) / 2,
         cache_read_per_mtok = ((backup.standard_cache_read_per_mtok / 2) * 3 + 1) / 2,
         cache_write_per_mtok = ((backup.standard_cache_write_per_mtok / 2) * 3 + 1) / 2,
         updated_at = clock_timestamp(),
         lock_version = pricing.lock_version + 1
    FROM model_pricing_0245_backup AS backup
   WHERE pricing.model_id = backup.model_id
     AND backup.is_long;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 3 THEN
    RAISE EXCEPTION '0245 expected to update 3 long-context rows, updated %', affected_count;
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
    RAISE EXCEPTION '0245 GPT-5.6 repricing postcondition mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing AS pricing
      FULL JOIN model_pricing_0245_backup AS backup USING (model_id)
     WHERE backup.model_id IS NOT NULL
       AND pricing.model_id IS NULL
  ) THEN
    RAISE EXCEPTION '0245 target model_id set drifted during repricing';
  END IF;
END $$;
