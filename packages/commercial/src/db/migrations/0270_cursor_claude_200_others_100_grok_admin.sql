-- order-dependency: 0269_cursor_usd_150_credits
-- 0270_cursor_claude_200_others_100_grok_admin.sql
-- Operator decision 2026-09-05 (follow-up to 0269):
--   * Cursor Claude families (opus-4.8 / opus-5 / fable-5 / fable-5.1):
--     1 USD of real Cursor spend = 200 credits  (0269 was 150 → x4/3)
--   * every other Cursor family (grok-4.6, gemini-3.8-flash):
--     1 USD of real Cursor spend = 100 credits  (0269 was 150 → x2/3)
--   * cursor-grok-4.6-* become visibility='admin': admins (and explicitly
--     granted users) still see them in the picker; everyone else uses the
--     Grok-Build engine's `grok-build` instead. Sessions already pinned to a
--     cursor-grok model are untouched (visibility is picker-only).
--
-- Fitted Cursor USD/MTok (see 0269 header) x credits-per-USD:
--   fable-5.1  10 / 50   / 0.25  / 12.5   x200 → 2000 / 10000 /  50 / 2500
--   fable-5    10 / 52   / 0.82  / 12.5   x200 → 2000 / 10400 / 164 / 2500
--   opus        7 / 25   / 0.18  /  8.75  x200 → 1400 /  5000 /  36 / 1750
--   grok-4.6   1.9/  9.5 / 0.475 /  2.375 x100 →  190 /   950 /  48 /  238 (Fast x2)
--   gemini-3.8 1.2/  1.5 / 0.05  /  1.5   x100 →  120 /   150 /   5 /  150
-- Absolute targets (idempotent UPDATE); before-image guard pins the 0269
-- state so a drifted catalog fails closed. Backup table for exact manual
-- compensation, no RENAME/DROP. Historical usage_records never recomputed.

CREATE TABLE model_pricing_0270_backup (
  model_id              TEXT PRIMARY KEY,
  family                TEXT NOT NULL,
  input_per_mtok        BIGINT NOT NULL,
  output_per_mtok       BIGINT NOT NULL,
  cache_read_per_mtok   BIGINT NOT NULL,
  cache_write_per_mtok  BIGINT NOT NULL,
  multiplier            NUMERIC(6,3) NOT NULL,
  visibility            TEXT NOT NULL,
  lock_version          INTEGER NOT NULL,
  captured_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

LOCK TABLE model_pricing IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE cursor_0270_targets (
  model_id             TEXT PRIMARY KEY,
  family               TEXT NOT NULL,
  input_per_mtok       BIGINT NOT NULL,
  output_per_mtok      BIGINT NOT NULL,
  cache_read_per_mtok  BIGINT NOT NULL,
  cache_write_per_mtok BIGINT NOT NULL,
  multiplier           NUMERIC(6,3) NOT NULL,
  visibility           TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO cursor_0270_targets VALUES
  ('cursor-fable-5.1-low',        'fable51', 2000, 10000,  50, 2500, 1.000, 'public'),
  ('cursor-fable-5.1-medium',     'fable51', 2000, 10000,  50, 2500, 1.000, 'public'),
  ('cursor-fable-5.1-high',       'fable51', 2000, 10000,  50, 2500, 1.000, 'public'),
  ('cursor-fable-5.1-xhigh',      'fable51', 2000, 10000,  50, 2500, 1.000, 'public'),
  ('cursor-fable-5.1-max',        'fable51', 2000, 10000,  50, 2500, 1.000, 'public'),
  ('cursor-fable-5-low',          'fable5',  2000, 10400, 164, 2500, 1.000, 'public'),
  ('cursor-fable-5-medium',       'fable5',  2000, 10400, 164, 2500, 1.000, 'public'),
  ('cursor-fable-5-high',         'fable5',  2000, 10400, 164, 2500, 1.000, 'public'),
  ('cursor-fable-5-xhigh',        'fable5',  2000, 10400, 164, 2500, 1.000, 'public'),
  ('cursor-fable-5-max',          'fable5',  2000, 10400, 164, 2500, 1.000, 'public'),
  ('cursor-opus-4.8-low',         'opus',    1400,  5000,  36, 1750, 1.000, 'public'),
  ('cursor-opus-4.8-low-fast',    'opus',    1400,  5000,  36, 1750, 2.000, 'public'),
  ('cursor-opus-4.8-medium',      'opus',    1400,  5000,  36, 1750, 1.000, 'public'),
  ('cursor-opus-4.8-medium-fast', 'opus',    1400,  5000,  36, 1750, 2.000, 'public'),
  ('cursor-opus-4.8-high',        'opus',    1400,  5000,  36, 1750, 1.000, 'public'),
  ('cursor-opus-4.8-high-fast',   'opus',    1400,  5000,  36, 1750, 2.000, 'public'),
  ('cursor-opus-4.8-xhigh',       'opus',    1400,  5000,  36, 1750, 1.000, 'public'),
  ('cursor-opus-4.8-xhigh-fast',  'opus',    1400,  5000,  36, 1750, 2.000, 'public'),
  ('cursor-opus-4.8-max',         'opus',    1400,  5000,  36, 1750, 1.000, 'public'),
  ('cursor-opus-4.8-max-fast',    'opus',    1400,  5000,  36, 1750, 2.000, 'public'),
  ('cursor-opus-5-low',           'opus',    1400,  5000,  36, 1750, 1.000, 'public'),
  ('cursor-opus-5-low-fast',      'opus',    1400,  5000,  36, 1750, 2.000, 'public'),
  ('cursor-opus-5-medium',        'opus',    1400,  5000,  36, 1750, 1.000, 'public'),
  ('cursor-opus-5-medium-fast',   'opus',    1400,  5000,  36, 1750, 2.000, 'public'),
  ('cursor-opus-5-high',          'opus',    1400,  5000,  36, 1750, 1.000, 'public'),
  ('cursor-opus-5-high-fast',     'opus',    1400,  5000,  36, 1750, 2.000, 'public'),
  ('cursor-opus-5-xhigh',         'opus',    1400,  5000,  36, 1750, 1.000, 'public'),
  ('cursor-opus-5-xhigh-fast',    'opus',    1400,  5000,  36, 1750, 2.000, 'public'),
  ('cursor-opus-5-max',           'opus',    1400,  5000,  36, 1750, 1.000, 'public'),
  ('cursor-opus-5-max-fast',      'opus',    1400,  5000,  36, 1750, 2.000, 'public'),
  ('cursor-grok-4.6-low',         'grok',     190,   950,  48,  238, 1.000, 'admin'),
  ('cursor-grok-4.6-low-fast',    'grok',     190,   950,  48,  238, 2.000, 'admin'),
  ('cursor-grok-4.6-medium',      'grok',     190,   950,  48,  238, 1.000, 'admin'),
  ('cursor-grok-4.6-medium-fast', 'grok',     190,   950,  48,  238, 2.000, 'admin'),
  ('cursor-grok-4.6-high',        'grok',     190,   950,  48,  238, 1.000, 'admin'),
  ('cursor-grok-4.6-high-fast',   'grok',     190,   950,  48,  238, 2.000, 'admin'),
  ('cursor-grok-4.6-xhigh',       'grok',     190,   950,  48,  238, 1.000, 'admin'),
  ('cursor-grok-4.6-xhigh-fast',  'grok',     190,   950,  48,  238, 2.000, 'admin'),
  ('cursor-gemini-3.8-flash-low',    'gemini', 120,  150,   5,  150, 1.000, 'public'),
  ('cursor-gemini-3.8-flash-medium', 'gemini', 120,  150,   5,  150, 1.000, 'public'),
  ('cursor-gemini-3.8-flash-high',   'gemini', 120,  150,   5,  150, 1.000, 'public');

INSERT INTO model_pricing_0270_backup (
  model_id, family, input_per_mtok, output_per_mtok, cache_read_per_mtok,
  cache_write_per_mtok, multiplier, visibility, lock_version
)
SELECT p.model_id, t.family, p.input_per_mtok, p.output_per_mtok,
       p.cache_read_per_mtok, p.cache_write_per_mtok, p.multiplier,
       p.visibility, p.lock_version
  FROM cursor_0270_targets t
  JOIN model_pricing p ON p.model_id = t.model_id;

DO $$
DECLARE
  target_count BIGINT;
  backup_count BIGINT;
  affected_count BIGINT;
BEGIN
  SELECT count(*) INTO target_count FROM cursor_0270_targets;
  SELECT count(*) INTO backup_count FROM model_pricing_0270_backup;
  IF target_count <> 41 OR backup_count <> 41 THEN
    RAISE EXCEPTION '0270 expected 41 Cursor target rows present in model_pricing, targets=% matched=%',
      target_count, backup_count;
  END IF;

  -- Before-image guard: must be the 0269 catalog.
  IF EXISTS (
    SELECT 1 FROM model_pricing_0270_backup
     WHERE (family = 'fable51' AND (input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok) <> (1500, 7500,  38, 1875))
        OR (family = 'fable5'  AND (input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok) <> (1500, 7800, 123, 1875))
        OR (family = 'opus'    AND (input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok) <> (1050, 3750,  27, 1313))
        OR (family = 'grok'    AND (input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok) <> ( 285, 1425,  71,  356))
        OR (family = 'gemini'  AND (input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok) <> ( 180,  225,   8,  225))
  ) THEN
    RAISE EXCEPTION '0270 refuses unexpected Cursor before-image prices (expects 0269 state)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM model_pricing_0270_backup b
     WHERE b.multiplier IS DISTINCT FROM (CASE WHEN b.model_id LIKE '%-fast' THEN 2.000 ELSE 1.000 END)
        OR b.visibility <> 'public'
  ) THEN
    RAISE EXCEPTION '0270 refuses unexpected Cursor before-image multiplier/visibility';
  END IF;
  IF EXISTS (SELECT 1 FROM model_pricing_0270_backup WHERE lock_version >= 2147483646) THEN
    RAISE EXCEPTION '0270 refuses lock_version overflow';
  END IF;

  UPDATE model_pricing AS p
     SET input_per_mtok       = t.input_per_mtok,
         output_per_mtok      = t.output_per_mtok,
         cache_read_per_mtok  = t.cache_read_per_mtok,
         cache_write_per_mtok = t.cache_write_per_mtok,
         multiplier           = t.multiplier,
         visibility           = t.visibility,
         updated_at           = clock_timestamp(),
         lock_version         = p.lock_version + 1
    FROM cursor_0270_targets AS t
   WHERE p.model_id = t.model_id;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 41 THEN
    RAISE EXCEPTION '0270 expected to reprice 41 rows, updated %', affected_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing p
      JOIN cursor_0270_targets t ON t.model_id = p.model_id
      JOIN model_pricing_0270_backup b ON b.model_id = p.model_id
     WHERE p.input_per_mtok <> t.input_per_mtok
        OR p.output_per_mtok <> t.output_per_mtok
        OR p.cache_read_per_mtok <> t.cache_read_per_mtok
        OR p.cache_write_per_mtok <> t.cache_write_per_mtok
        OR p.multiplier <> t.multiplier
        OR p.visibility <> t.visibility
        OR p.lock_version <> b.lock_version + 1
  ) THEN
    RAISE EXCEPTION '0270 Cursor repricing postcondition mismatch';
  END IF;

  IF (SELECT count(*) FROM model_pricing WHERE model_id LIKE 'cursor-grok-4.6-%' AND visibility = 'admin') <> 8 THEN
    RAISE EXCEPTION '0270 expected 8 admin-only cursor-grok-4.6 rows';
  END IF;
  IF (SELECT count(*) FROM model_pricing WHERE model_id LIKE 'cursor-%') <> 45 THEN
    RAISE EXCEPTION '0270 expected 45 cursor-* pricing rows in total, found %',
      (SELECT count(*) FROM model_pricing WHERE model_id LIKE 'cursor-%');
  END IF;
END $$;

SELECT fn_model_security_epoch_bump();
