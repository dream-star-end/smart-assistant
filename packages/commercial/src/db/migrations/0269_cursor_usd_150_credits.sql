-- order-dependency: 0268_desktop_session_secret_generation
-- 0269_cursor_usd_150_credits.sql
-- Reprice every Cursor Sand family so 1 USD of *real* upstream spend debits
-- ~150 credits (usage_records.cost_credits / credit_ledger units, shown 1:1 as
-- 积分 in the UI), replacing the Anthropic-list-price guesses.
--
-- Source of truth: the hourly cursorUsageSweeper snapshot
-- (claude_accounts.cursor_usage_snapshot.cycle_usage.models) exposes Cursor's
-- own per-model cents + four-dim tokens for each pool account. Fitting those
-- 17 rows (~3_990 USD, 2026-08-21..09-05) gives Cursor's effective USD/MTok:
--   fable-5.1  in 10 / out 50  / cache-read 0.25 / cache-write 12.5
--   fable-5    in 10 / out 52  / cache-read 0.82 / cache-write 12.5
--   opus-4.8/5 in  7 / out 25  / cache-read 0.18 / cache-write  8.75
--   grok-4.6   in 1.9/ out 9.5 / cache-read 0.475 (Fast = 2x, no cache-write)
--   gemini-3.8 in 1.2/ out 1.5 / cache-read 0.05
-- Target *_per_mtok = USD/MTok * 150 (credits per USD); every snapshot row
-- lands within 148..154 credits per USD, total 150.1.
--
-- Under the old table Fable billed ~383 credits/USD, Opus ~313, Grok ~94,
-- Gemini ~460 (Grok was under-priced, everything else 2-3x over).
--
-- The Sand settle surcharge (planCursorExternalSettle, 2x on opus/fable) is
-- disabled on selfhost via COMMERCIAL_CURSOR_SETTLE_SURCHARGE_MULTIPLIER=1.000
-- in the same release, so the catalog price below *is* the debited price.
-- Fast rows keep multiplier=2 (fitted: Cursor's Fast really is 2x).
-- Opus/Fable lose the stale "限时半价" promo_label; min_plan_code=lite stays.
--
-- Targets are absolute values (not ratios), so the UPDATE is idempotent; the
-- durable backup table exists only for exact manual compensation:
--   UPDATE model_pricing p SET input_per_mtok=b.input_per_mtok, ... FROM
--   model_pricing_0269_backup b WHERE p.model_id=b.model_id;
-- No RENAME / DROP: this does not trip the selfhost breaking-DDL gate.
-- Historical usage_records.price_snapshot / cost_credits are never recomputed.

CREATE TABLE model_pricing_0269_backup (
  model_id              TEXT PRIMARY KEY,
  family                TEXT NOT NULL,
  input_per_mtok        BIGINT NOT NULL,
  output_per_mtok       BIGINT NOT NULL,
  cache_read_per_mtok   BIGINT NOT NULL,
  cache_write_per_mtok  BIGINT NOT NULL,
  multiplier            NUMERIC(6,3) NOT NULL,
  promo_label           TEXT,
  min_plan_code         TEXT,
  lock_version          INTEGER NOT NULL,
  captured_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

LOCK TABLE model_pricing IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE cursor_0269_targets (
  model_id             TEXT PRIMARY KEY,
  family               TEXT NOT NULL,
  input_per_mtok       BIGINT NOT NULL,
  output_per_mtok      BIGINT NOT NULL,
  cache_read_per_mtok  BIGINT NOT NULL,
  cache_write_per_mtok BIGINT NOT NULL,
  multiplier           NUMERIC(6,3) NOT NULL
) ON COMMIT DROP;

INSERT INTO cursor_0269_targets VALUES
  -- Fable 5.1: 10 / 50 / 0.25 / 12.5 USD per MTok
  ('cursor-fable-5.1-low',        'fable51', 1500, 7500,  38, 1875, 1.000),
  ('cursor-fable-5.1-medium',     'fable51', 1500, 7500,  38, 1875, 1.000),
  ('cursor-fable-5.1-high',       'fable51', 1500, 7500,  38, 1875, 1.000),
  ('cursor-fable-5.1-xhigh',      'fable51', 1500, 7500,  38, 1875, 1.000),
  ('cursor-fable-5.1-max',        'fable51', 1500, 7500,  38, 1875, 1.000),
  -- Fable 5: 10 / 52 / 0.82 / 12.5
  ('cursor-fable-5-low',          'fable5',  1500, 7800, 123, 1875, 1.000),
  ('cursor-fable-5-medium',       'fable5',  1500, 7800, 123, 1875, 1.000),
  ('cursor-fable-5-high',         'fable5',  1500, 7800, 123, 1875, 1.000),
  ('cursor-fable-5-xhigh',        'fable5',  1500, 7800, 123, 1875, 1.000),
  ('cursor-fable-5-max',          'fable5',  1500, 7800, 123, 1875, 1.000),
  -- Opus 4.8 / 5: 7 / 25 / 0.18 / 8.75 ; Fast = 2x
  ('cursor-opus-4.8-low',         'opus',    1050, 3750,  27, 1313, 1.000),
  ('cursor-opus-4.8-low-fast',    'opus',    1050, 3750,  27, 1313, 2.000),
  ('cursor-opus-4.8-medium',      'opus',    1050, 3750,  27, 1313, 1.000),
  ('cursor-opus-4.8-medium-fast', 'opus',    1050, 3750,  27, 1313, 2.000),
  ('cursor-opus-4.8-high',        'opus',    1050, 3750,  27, 1313, 1.000),
  ('cursor-opus-4.8-high-fast',   'opus',    1050, 3750,  27, 1313, 2.000),
  ('cursor-opus-4.8-xhigh',       'opus',    1050, 3750,  27, 1313, 1.000),
  ('cursor-opus-4.8-xhigh-fast',  'opus',    1050, 3750,  27, 1313, 2.000),
  ('cursor-opus-4.8-max',         'opus',    1050, 3750,  27, 1313, 1.000),
  ('cursor-opus-4.8-max-fast',    'opus',    1050, 3750,  27, 1313, 2.000),
  ('cursor-opus-5-low',           'opus',    1050, 3750,  27, 1313, 1.000),
  ('cursor-opus-5-low-fast',      'opus',    1050, 3750,  27, 1313, 2.000),
  ('cursor-opus-5-medium',        'opus',    1050, 3750,  27, 1313, 1.000),
  ('cursor-opus-5-medium-fast',   'opus',    1050, 3750,  27, 1313, 2.000),
  ('cursor-opus-5-high',          'opus',    1050, 3750,  27, 1313, 1.000),
  ('cursor-opus-5-high-fast',     'opus',    1050, 3750,  27, 1313, 2.000),
  ('cursor-opus-5-xhigh',         'opus',    1050, 3750,  27, 1313, 1.000),
  ('cursor-opus-5-xhigh-fast',    'opus',    1050, 3750,  27, 1313, 2.000),
  ('cursor-opus-5-max',           'opus',    1050, 3750,  27, 1313, 1.000),
  ('cursor-opus-5-max-fast',      'opus',    1050, 3750,  27, 1313, 2.000),
  -- Grok 4.6: 1.9 / 9.5 / 0.475 / (cw 2.375) ; Fast = 2x
  ('cursor-grok-4.6-low',         'grok',     285, 1425,  71,  356, 1.000),
  ('cursor-grok-4.6-low-fast',    'grok',     285, 1425,  71,  356, 2.000),
  ('cursor-grok-4.6-medium',      'grok',     285, 1425,  71,  356, 1.000),
  ('cursor-grok-4.6-medium-fast', 'grok',     285, 1425,  71,  356, 2.000),
  ('cursor-grok-4.6-high',        'grok',     285, 1425,  71,  356, 1.000),
  ('cursor-grok-4.6-high-fast',   'grok',     285, 1425,  71,  356, 2.000),
  ('cursor-grok-4.6-xhigh',       'grok',     285, 1425,  71,  356, 1.000),
  ('cursor-grok-4.6-xhigh-fast',  'grok',     285, 1425,  71,  356, 2.000),
  -- Gemini 3.8 Flash: 1.2 / 1.5 / 0.05 / (cw 1.5)
  ('cursor-gemini-3.8-flash-low',    'gemini', 180,  225,   8,  225, 1.000),
  ('cursor-gemini-3.8-flash-medium', 'gemini', 180,  225,   8,  225, 1.000),
  ('cursor-gemini-3.8-flash-high',   'gemini', 180,  225,   8,  225, 1.000);

INSERT INTO model_pricing_0269_backup (
  model_id, family, input_per_mtok, output_per_mtok, cache_read_per_mtok,
  cache_write_per_mtok, multiplier, promo_label, min_plan_code, lock_version
)
SELECT p.model_id, t.family, p.input_per_mtok, p.output_per_mtok,
       p.cache_read_per_mtok, p.cache_write_per_mtok, p.multiplier,
       p.promo_label, p.min_plan_code, p.lock_version
  FROM cursor_0269_targets t
  JOIN model_pricing p ON p.model_id = t.model_id;

DO $$
DECLARE
  target_count BIGINT;
  backup_count BIGINT;
  affected_count BIGINT;
BEGIN
  SELECT count(*) INTO target_count FROM cursor_0269_targets;
  SELECT count(*) INTO backup_count FROM model_pricing_0269_backup;
  IF target_count <> 41 OR backup_count <> 41 THEN
    RAISE EXCEPTION '0269 expected 41 Cursor target rows present in model_pricing, targets=% matched=%',
      target_count, backup_count;
  END IF;

  -- Before-image guard: refuse if the catalog is not the 0256/0259 + 09-03
  -- cache_write DB-edit state this repricing was derived from.
  IF EXISTS (
    SELECT 1 FROM model_pricing_0269_backup
     WHERE (family IN ('fable51','fable5') AND (input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok) <> (1524, 7621, 152, 1905))
        OR (family = 'opus'   AND (input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok) <> (761, 3808, 76, 951))
        OR (family = 'grok'   AND (input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok) <> (188, 563, 47, 235))
        OR (family = 'gemini' AND (input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok) <> (188, 563, 47, 235))
  ) THEN
    RAISE EXCEPTION '0269 refuses unexpected Cursor before-image prices';
  END IF;
  IF EXISTS (
    SELECT 1 FROM model_pricing_0269_backup b
     WHERE b.multiplier IS DISTINCT FROM (CASE WHEN b.model_id LIKE '%-fast' THEN 2.000 ELSE 1.000 END)
  ) THEN
    RAISE EXCEPTION '0269 refuses unexpected Cursor before-image multipliers';
  END IF;
  IF EXISTS (SELECT 1 FROM model_pricing_0269_backup WHERE lock_version >= 2147483646) THEN
    RAISE EXCEPTION '0269 refuses lock_version overflow';
  END IF;

  UPDATE model_pricing AS p
     SET input_per_mtok       = t.input_per_mtok,
         output_per_mtok      = t.output_per_mtok,
         cache_read_per_mtok  = t.cache_read_per_mtok,
         cache_write_per_mtok = t.cache_write_per_mtok,
         multiplier           = t.multiplier,
         promo_label          = CASE WHEN t.family IN ('fable51','fable5','opus') THEN NULL ELSE p.promo_label END,
         updated_at           = clock_timestamp(),
         lock_version         = p.lock_version + 1
    FROM cursor_0269_targets AS t
   WHERE p.model_id = t.model_id;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 41 THEN
    RAISE EXCEPTION '0269 expected to reprice 41 rows, updated %', affected_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing p
      JOIN cursor_0269_targets t ON t.model_id = p.model_id
      JOIN model_pricing_0269_backup b ON b.model_id = p.model_id
     WHERE p.input_per_mtok <> t.input_per_mtok
        OR p.output_per_mtok <> t.output_per_mtok
        OR p.cache_read_per_mtok <> t.cache_read_per_mtok
        OR p.cache_write_per_mtok <> t.cache_write_per_mtok
        OR p.multiplier <> t.multiplier
        OR (t.family IN ('fable51','fable5','opus') AND p.promo_label IS NOT NULL)
        OR p.min_plan_code IS DISTINCT FROM b.min_plan_code
        OR p.lock_version <> b.lock_version + 1
  ) THEN
    RAISE EXCEPTION '0269 Cursor repricing postcondition mismatch';
  END IF;

  -- Non-target cursor rows (cursor-auto, composer, grok-4.5) must be untouched.
  IF (SELECT count(*) FROM model_pricing WHERE model_id LIKE 'cursor-%') <> 45 THEN
    RAISE EXCEPTION '0269 expected 45 cursor-* pricing rows in total, found %',
      (SELECT count(*) FROM model_pricing WHERE model_id LIKE 'cursor-%');
  END IF;
END $$;
