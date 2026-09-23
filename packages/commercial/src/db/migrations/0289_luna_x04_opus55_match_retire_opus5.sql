-- order-dependency: 0288_gpt6_sol_luna_retire_gpt56
-- 0289_luna_x04_opus55_match_retire_opus5.sql
-- Picker prices are model_pricing.multiplier on top of the fen schedule
-- (credits/ktok = fen * multiplier). GPT-6 Sol stays x1.0. GPT-6 Luna and its
-- 1M twin move from x1.0 to x0.4. Fen amounts stay on the 0288 schedule.
-- Claude Opus 5.5 copies Claude Opus 5's fen schedule and multiplier, then
-- the active claude-opus-5 catalog row is disabled. Live sessions and route
-- contexts move to claude-opus-5-5 only while that replacement is active.
-- If Opus 5.5 is already disabled (commercial Claude offline), prices are
-- still aligned and Opus 5 is disabled without pointing sessions at it.
-- Cursor claude-opus-5-thinking-* / cursor-opus-5-* are a different engine
-- and are not touched. Deleted sessions keep their historical model id.

DO $$
DECLARE
  rec RECORD;
  n INTEGER;
  opus55_active BOOLEAN;
BEGIN
  IF (
    SELECT count(*) FROM model_catalog c
    JOIN model_pricing p USING (model_id)
    WHERE c.model_id IN ('gpt-6-sol', 'gpt-6-sol-1m', 'gpt-6-luna', 'gpt-6-luna-1m')
      AND c.state = 'active' AND p.enabled IS TRUE AND p.visibility = 'public'
  ) <> 4 THEN
    RAISE EXCEPTION '0289 requires 4 active public GPT-6 Sol/Luna rows';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM model_pricing WHERE model_id = 'claude-opus-5')
     OR NOT EXISTS (SELECT 1 FROM model_pricing WHERE model_id = 'claude-opus-5-5') THEN
    RAISE EXCEPTION '0289 requires both claude-opus-5 and claude-opus-5-5 pricing rows';
  END IF;

  UPDATE model_pricing
     SET multiplier = 1.000,
         lock_version = lock_version + 1,
         updated_at = clock_timestamp()
   WHERE model_id IN ('gpt-6-sol', 'gpt-6-sol-1m')
     AND multiplier IS DISTINCT FROM 1.000;

  UPDATE model_pricing
     SET multiplier = 0.400,
         lock_version = lock_version + 1,
         updated_at = clock_timestamp()
   WHERE model_id IN ('gpt-6-luna', 'gpt-6-luna-1m')
     AND multiplier IS DISTINCT FROM 0.400;

  UPDATE model_pricing AS dst
     SET input_per_mtok = src.input_per_mtok,
         output_per_mtok = src.output_per_mtok,
         cache_read_per_mtok = src.cache_read_per_mtok,
         cache_write_per_mtok = src.cache_write_per_mtok,
         multiplier = src.multiplier,
         lock_version = dst.lock_version + 1,
         updated_at = clock_timestamp()
    FROM model_pricing AS src
   WHERE dst.model_id = 'claude-opus-5-5'
     AND src.model_id = 'claude-opus-5'
     AND (
       dst.input_per_mtok IS DISTINCT FROM src.input_per_mtok
       OR dst.output_per_mtok IS DISTINCT FROM src.output_per_mtok
       OR dst.cache_read_per_mtok IS DISTINCT FROM src.cache_read_per_mtok
       OR dst.cache_write_per_mtok IS DISTINCT FROM src.cache_write_per_mtok
       OR dst.multiplier IS DISTINCT FROM src.multiplier
     );

  SELECT EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id = 'claude-opus-5-5' AND state = 'active'
  ) INTO opus55_active;

  IF opus55_active THEN
    UPDATE client_sessions
       SET model_id = 'claude-opus-5-5'
     WHERE deleted_at IS NULL
       AND model_id = 'claude-opus-5';
    UPDATE codex_route_contexts
       SET model_id = 'claude-opus-5-5'
     WHERE model_id = 'claude-opus-5';
    UPDATE grok_route_contexts
       SET model_id = 'claude-opus-5-5'
     WHERE model_id = 'claude-opus-5';
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_catalog WHERE model_id = 'claude-opus-5' AND state = 'active'
  ) THEN
    DELETE FROM account_group_models WHERE model_id = 'claude-opus-5';
    FOR rec IN
      SELECT entry_id, lock_version FROM model_catalog
       WHERE model_id = 'claude-opus-5' AND state = 'active'
       ORDER BY entry_id
    LOOP
      PERFORM fn_model_disable_entry(rec.entry_id, rec.lock_version, NULL);
    END LOOP;
    UPDATE model_pricing
       SET enabled = FALSE,
           visibility = 'hidden',
           promo_label = NULL,
           lock_version = lock_version + 1,
           updated_at = clock_timestamp()
     WHERE model_id = 'claude-opus-5';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN
      RAISE EXCEPTION '0289 expected to hide 1 Opus 5 pricing row, updated %', n;
    END IF;
  END IF;

  IF (
    SELECT count(*) FROM model_pricing
     WHERE model_id IN ('gpt-6-sol', 'gpt-6-sol-1m')
       AND multiplier = 1.000
       AND enabled IS TRUE
       AND visibility = 'public'
  ) <> 2
  OR (
    SELECT count(*) FROM model_pricing
     WHERE model_id = 'gpt-6-luna'
       AND multiplier = 0.400
       AND input_per_mtok = 5 AND output_per_mtok = 25
       AND cache_read_per_mtok = 1 AND cache_write_per_mtok = 6
       AND enabled IS TRUE AND visibility = 'public'
  ) <> 1
  OR (
    SELECT count(*) FROM model_pricing
     WHERE model_id = 'gpt-6-luna-1m'
       AND multiplier = 0.400
       AND input_per_mtok = 8 AND output_per_mtok = 38
       AND cache_read_per_mtok = 2 AND cache_write_per_mtok = 9
       AND enabled IS TRUE AND visibility = 'public'
  ) <> 1
  OR NOT EXISTS (
    SELECT 1
      FROM model_pricing dst
      JOIN model_pricing src ON src.model_id = 'claude-opus-5'
     WHERE dst.model_id = 'claude-opus-5-5'
       AND dst.multiplier = src.multiplier
       AND dst.input_per_mtok = src.input_per_mtok
       AND dst.output_per_mtok = src.output_per_mtok
       AND dst.cache_read_per_mtok = src.cache_read_per_mtok
       AND dst.cache_write_per_mtok = src.cache_write_per_mtok
  )
  OR EXISTS (
    SELECT 1 FROM model_catalog WHERE model_id = 'claude-opus-5' AND state = 'active'
  )
  OR EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id = 'claude-opus-5' AND (enabled IS TRUE OR visibility <> 'hidden')
  )
  OR EXISTS (
    SELECT 1 FROM account_group_models WHERE model_id = 'claude-opus-5'
  ) THEN
    RAISE EXCEPTION '0289 price / Opus 5 retirement postcondition failed';
  END IF;

  IF opus55_active AND (
    EXISTS (
      SELECT 1 FROM client_sessions
       WHERE deleted_at IS NULL AND model_id = 'claude-opus-5'
    )
    OR EXISTS (SELECT 1 FROM codex_route_contexts WHERE model_id = 'claude-opus-5')
    OR EXISTS (SELECT 1 FROM grok_route_contexts WHERE model_id = 'claude-opus-5')
    OR NOT EXISTS (
      SELECT 1 FROM model_catalog c
      JOIN model_pricing p USING (model_id)
      WHERE c.model_id = 'claude-opus-5-5'
        AND c.state = 'active'
        AND p.enabled IS TRUE
        AND p.visibility = 'public'
    )
  ) THEN
    RAISE EXCEPTION '0289 live Opus 5 pointers remain while Opus 5.5 is active';
  END IF;
END $$;

SELECT fn_model_security_epoch_bump();
