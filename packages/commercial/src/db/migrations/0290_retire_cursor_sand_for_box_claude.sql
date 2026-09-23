-- order-dependency: 0289_luna_x04_opus55_match_retire_opus5
-- 0290_retire_cursor_sand_for_box_claude.sql
-- The Grok Bot box now runs official Claude Code, which does not accept
-- Cursor Sand slugs (cursor-opus-5-high, cursor-fable-*, composer, luna, ...).
-- Disable those catalog rows. Keep cursor-auto and cursor-grok-4.7-*.
-- Add three Cursor-engine rows whose upstream ids are the box CLI ids.
-- Live sessions on a retired Claude-family row move to the matching box row.
-- Other retired Sand rows move to cursor-grok-4.7-high.

DO $$
DECLARE
  rec RECORD;
  n INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id = 'cursor-opus-5-high' AND engine = 'cursor' AND state = 'active'
  ) OR NOT EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id = 'cursor-haiku-4.5' AND engine = 'cursor' AND state = 'active'
  ) OR NOT EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id = 'cursor-grok-4.7-high' AND engine = 'cursor' AND state = 'active'
  ) THEN
    RAISE EXCEPTION '0290 requires active cursor-opus-5-high, cursor-haiku-4.5, cursor-grok-4.7-high';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM model_catalog WHERE model_id = 'box-claude-opus-5-5') THEN
    INSERT INTO model_catalog (
      model_id, engine, provider_id, upstream_model_id, context_window,
      capability_profile, capability_schema_version, state
    )
    SELECT 'box-claude-opus-5-5', engine, provider_id, 'claude-opus-5-5', context_window,
           capability_profile, capability_schema_version, 'staged'
      FROM model_catalog WHERE model_id = 'cursor-opus-5-high' AND state = 'active';
    INSERT INTO model_pricing (
      model_id, display_name, input_per_mtok, output_per_mtok, cache_read_per_mtok,
      cache_write_per_mtok, multiplier, enabled, sort_order, visibility,
      extra_system_prompt, default_effort, min_plan_code, promo_label
    )
    SELECT 'box-claude-opus-5-5', 'Claude Opus 5.5', input_per_mtok, output_per_mtok,
           cache_read_per_mtok, cache_write_per_mtok, multiplier, TRUE, 15, 'public',
           extra_system_prompt, default_effort, min_plan_code, NULL
      FROM model_pricing WHERE model_id = 'cursor-opus-5-high';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM model_catalog WHERE model_id = 'box-claude-sonnet-5') THEN
    INSERT INTO model_catalog (
      model_id, engine, provider_id, upstream_model_id, context_window,
      capability_profile, capability_schema_version, state
    )
    SELECT 'box-claude-sonnet-5', engine, provider_id, 'claude-sonnet-5', context_window,
           capability_profile, capability_schema_version, 'staged'
      FROM model_catalog WHERE model_id = 'cursor-sonnet-5-high' AND state = 'active';
    INSERT INTO model_pricing (
      model_id, display_name, input_per_mtok, output_per_mtok, cache_read_per_mtok,
      cache_write_per_mtok, multiplier, enabled, sort_order, visibility,
      extra_system_prompt, default_effort, min_plan_code, promo_label
    )
    SELECT 'box-claude-sonnet-5', 'Claude Sonnet 5', input_per_mtok, output_per_mtok,
           cache_read_per_mtok, cache_write_per_mtok, multiplier, TRUE, 16, 'public',
           extra_system_prompt, default_effort, min_plan_code, NULL
      FROM model_pricing WHERE model_id = 'cursor-sonnet-5-high';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM model_catalog WHERE model_id = 'box-claude-haiku-4-5') THEN
    INSERT INTO model_catalog (
      model_id, engine, provider_id, upstream_model_id, context_window,
      capability_profile, capability_schema_version, state
    )
    SELECT 'box-claude-haiku-4-5', engine, provider_id, 'claude-haiku-4-5', context_window,
           capability_profile, capability_schema_version, 'staged'
      FROM model_catalog WHERE model_id = 'cursor-haiku-4.5' AND state = 'active';
    INSERT INTO model_pricing (
      model_id, display_name, input_per_mtok, output_per_mtok, cache_read_per_mtok,
      cache_write_per_mtok, multiplier, enabled, sort_order, visibility,
      extra_system_prompt, default_effort, min_plan_code, promo_label
    )
    SELECT 'box-claude-haiku-4-5', 'Claude Haiku 4.5', input_per_mtok, output_per_mtok,
           cache_read_per_mtok, cache_write_per_mtok, multiplier, TRUE, 17, 'public',
           extra_system_prompt, default_effort, min_plan_code, NULL
      FROM model_pricing WHERE model_id = 'cursor-haiku-4.5';
  END IF;

  INSERT INTO account_group_models(group_id, model_id)
  SELECT group_id, 'box-claude-opus-5-5' FROM account_group_models WHERE model_id = 'cursor-opus-5-high'
  ON CONFLICT DO NOTHING;
  INSERT INTO account_group_models(group_id, model_id)
  SELECT group_id, 'box-claude-sonnet-5' FROM account_group_models WHERE model_id = 'cursor-sonnet-5-high'
  ON CONFLICT DO NOTHING;
  INSERT INTO account_group_models(group_id, model_id)
  SELECT group_id, 'box-claude-haiku-4-5' FROM account_group_models WHERE model_id = 'cursor-haiku-4.5'
  ON CONFLICT DO NOTHING;

  FOR rec IN
    SELECT entry_id, lock_version FROM model_catalog
     WHERE model_id IN ('box-claude-opus-5-5', 'box-claude-sonnet-5', 'box-claude-haiku-4-5')
       AND state = 'staged'
     ORDER BY entry_id
  LOOP
    PERFORM fn_model_activate_entry(rec.entry_id, rec.lock_version, NULL);
  END LOOP;

  UPDATE client_sessions
     SET model_id = 'box-claude-opus-5-5'
   WHERE deleted_at IS NULL
     AND (model_id LIKE 'cursor-opus-%' OR model_id LIKE 'cursor-fable-%');
  UPDATE client_sessions
     SET model_id = 'box-claude-sonnet-5'
   WHERE deleted_at IS NULL
     AND model_id LIKE 'cursor-sonnet-%';
  UPDATE client_sessions
     SET model_id = 'box-claude-haiku-4-5'
   WHERE deleted_at IS NULL
     AND model_id LIKE 'cursor-haiku-%';
  UPDATE client_sessions
     SET model_id = 'cursor-grok-4.7-high'
   WHERE deleted_at IS NULL
     AND model_id IN (
       SELECT model_id FROM model_catalog
        WHERE engine = 'cursor' AND state = 'active'
          AND model_id <> 'cursor-auto'
          AND model_id NOT LIKE 'cursor-grok-4.7-%'
          AND model_id NOT LIKE 'box-claude-%'
          AND model_id NOT LIKE 'cursor-opus-%'
          AND model_id NOT LIKE 'cursor-sonnet-%'
          AND model_id NOT LIKE 'cursor-haiku-%'
          AND model_id NOT LIKE 'cursor-fable-%'
     );

  CREATE TEMP TABLE retired_sand(model_id TEXT PRIMARY KEY) ON COMMIT DROP;
  INSERT INTO retired_sand(model_id)
  SELECT model_id FROM model_catalog
   WHERE engine = 'cursor' AND state = 'active'
     AND model_id <> 'cursor-auto'
     AND model_id NOT LIKE 'cursor-grok-4.7-%'
     AND model_id NOT LIKE 'box-claude-%';

  DELETE FROM account_group_models WHERE model_id IN (SELECT model_id FROM retired_sand);

  FOR rec IN
    SELECT c.entry_id, c.lock_version
      FROM model_catalog c
      JOIN retired_sand r ON r.model_id = c.model_id
     WHERE c.state = 'active'
     ORDER BY c.entry_id
  LOOP
    PERFORM fn_model_disable_entry(rec.entry_id, rec.lock_version, NULL);
  END LOOP;

  UPDATE model_pricing
     SET enabled = FALSE,
         visibility = 'hidden',
         promo_label = NULL,
         lock_version = lock_version + 1,
         updated_at = clock_timestamp()
   WHERE model_id IN (SELECT model_id FROM retired_sand);

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n < 1 THEN
    RAISE EXCEPTION '0290 hid no retired Sand pricing rows';
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_catalog
     WHERE engine = 'cursor' AND state = 'active'
       AND model_id <> 'cursor-auto'
       AND model_id NOT LIKE 'cursor-grok-4.7-%'
       AND model_id NOT LIKE 'box-claude-%'
  ) OR (
    SELECT count(*) FROM model_catalog
     WHERE model_id IN ('box-claude-opus-5-5', 'box-claude-sonnet-5', 'box-claude-haiku-4-5')
       AND state = 'active' AND upstream_model_id IN ('claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5')
  ) <> 3 THEN
    RAISE EXCEPTION '0290 cursor sand retirement postcondition failed';
  END IF;
END $$;
