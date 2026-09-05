-- order-dependency: 0270_cursor_claude_200_others_100_grok_admin
-- 0271_cursor_retire_fable5_add_sonnet5.sql
-- Operator decision 2026-09-05:
--   1. Retire the Cursor Fable 5 family (cursor-fable-5-{low,medium,high,xhigh,max}):
--      catalog entries → disabled, pricing enabled=false + hidden, official_oauth
--      cursor group bindings removed. Live client_sessions still pinned to a
--      Fable 5 id are remapped to the same-effort Fable 5.1 id (identical
--      effort ladder, same 200 credits/USD family price) so no session lands on
--      an unroutable model. Historical usage_records are untouched.
--   2. Add the Cursor Sonnet 5 family, cloned from cursor-fable-5.1-high
--      (catalog: engine/provider/context_window 1M/capability; pricing:
--      visibility public, min_plan_code lite, sort_order). Upstream ids are the
--      pinned CLI thinking variants from `cursor-agent --list-models`
--      (2026-09-05): claude-sonnet-5-thinking-{low,medium,high,xhigh,max}.
--      No Fast rows (the CLI exposes none), matching the Claude-family policy.
--      Price: the pool usage snapshot has no Sonnet 5 rows yet, so the four
--      dims are provisionally Anthropic list (3 / 15 / 0.3 / 3.75 USD per
--      MTok) x 200 credits/USD = 600 / 3000 / 60 / 750. Refit from
--      claude_accounts.cursor_usage_snapshot once real Sonnet spend shows up.
--   3. Extend the cursor_external_usage_audit model_id CHECK with the five
--      Sonnet ids (Fable 5 ids stay so historical audit rows remain valid).
--
-- The CHECK swap (DROP + ADD CONSTRAINT) trips the selfhost breaking-DDL gate:
-- deploy with OC_V5_ALLOW_BREAKING_MIGRATION=1 (same as 0255 / 0259).
-- New rows are born staged then activated (catalog trigger contract).

DO $$
DECLARE
  rec RECORD;
  n INTEGER;
  remapped INTEGER;
  cursor_oauth_n INTEGER;
BEGIN
  -- ── preconditions ──────────────────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-fable-5.1-high' AND c.engine = 'cursor'
       AND c.state = 'active' AND p.enabled IS TRUE AND c.context_window = 1000000
  ) THEN
    RAISE EXCEPTION '0271 requires active enabled 1M cursor-fable-5.1-high as clone source';
  END IF;
  IF (SELECT count(*) FROM model_catalog WHERE model_id LIKE 'cursor-sonnet-5-%') <> 0
     OR (SELECT count(*) FROM model_pricing WHERE model_id LIKE 'cursor-sonnet-5-%') <> 0 THEN
    RAISE EXCEPTION '0271 refuses: cursor-sonnet-5-* rows already exist';
  END IF;
  IF (SELECT count(*) FROM model_catalog WHERE model_id LIKE 'cursor-fable-5-%' AND state = 'active') <> 5
     OR (SELECT count(*) FROM model_pricing WHERE model_id LIKE 'cursor-fable-5-%' AND enabled IS TRUE) <> 5 THEN
    RAISE EXCEPTION '0271 expected 5 active/enabled cursor-fable-5-* rows';
  END IF;
  IF EXISTS (
    SELECT 1 FROM client_sessions
     WHERE deleted_at IS NULL AND model_id LIKE 'cursor-fable-5-%'
       AND replace(model_id, 'cursor-fable-5-', 'cursor-fable-5.1-') NOT IN
           (SELECT model_id FROM model_pricing WHERE model_id LIKE 'cursor-fable-5.1-%')
  ) THEN
    RAISE EXCEPTION '0271 refuses: a pinned Fable 5 session has no Fable 5.1 twin';
  END IF;
  IF EXISTS (SELECT 1 FROM user_preferences WHERE prefs->>'default_model' LIKE 'cursor-fable-5-%')
     OR EXISTS (SELECT 1 FROM model_visibility_grants WHERE model_id LIKE 'cursor-fable-5-%')
     OR EXISTS (SELECT 1 FROM model_runtime_requirements WHERE model_id LIKE 'cursor-fable-5-%')
     OR EXISTS (SELECT 1 FROM model_aliases a JOIN model_catalog c ON c.entry_id = a.entry_id
                 WHERE c.model_id LIKE 'cursor-fable-5-%') THEN
    RAISE EXCEPTION '0271 refuses Fable 5 retirement while prefs/grants/requirements/aliases reference it';
  END IF;
  SELECT count(*) INTO cursor_oauth_n FROM account_groups WHERE kind = 'official_oauth' AND provider = 'cursor';
  IF cursor_oauth_n < 1 THEN
    RAISE EXCEPTION '0271 requires at least one official_oauth/cursor account group';
  END IF;

  -- ── 1. retire Fable 5 ─────────────────────────────────────────────────
  UPDATE client_sessions
     SET model_id = replace(model_id, 'cursor-fable-5-', 'cursor-fable-5.1-')
   WHERE deleted_at IS NULL AND model_id LIKE 'cursor-fable-5-%';
  GET DIAGNOSTICS remapped = ROW_COUNT;
  RAISE NOTICE '0271 remapped % live Fable 5 sessions to Fable 5.1', remapped;

  DELETE FROM account_group_models WHERE model_id LIKE 'cursor-fable-5-%';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 5 * cursor_oauth_n THEN
    RAISE EXCEPTION '0271 expected to delete % Fable 5 group bindings, deleted %', 5 * cursor_oauth_n, n;
  END IF;

  FOR rec IN
    SELECT entry_id, lock_version FROM model_catalog
     WHERE model_id LIKE 'cursor-fable-5-%' AND state = 'active' ORDER BY model_id
  LOOP
    PERFORM fn_model_disable_entry(rec.entry_id, rec.lock_version, NULL);
  END LOOP;

  UPDATE model_pricing
     SET enabled = FALSE, visibility = 'hidden', promo_label = NULL,
         lock_version = lock_version + 1, updated_at = clock_timestamp()
   WHERE model_id LIKE 'cursor-fable-5-%';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 5 THEN
    RAISE EXCEPTION '0271 expected to hide 5 Fable 5 pricing rows, updated %', n;
  END IF;

  -- ── 2. add Sonnet 5 ───────────────────────────────────────────────────
  FOR rec IN
    SELECT * FROM (VALUES
      ('cursor-sonnet-5-low',    'claude-sonnet-5-thinking-low',    'Sonnet 5 Low'),
      ('cursor-sonnet-5-medium', 'claude-sonnet-5-thinking-medium', 'Sonnet 5 Medium'),
      ('cursor-sonnet-5-high',   'claude-sonnet-5-thinking-high',   'Sonnet 5 High'),
      ('cursor-sonnet-5-xhigh',  'claude-sonnet-5-thinking-xhigh',  'Sonnet 5 Extra High'),
      ('cursor-sonnet-5-max',    'claude-sonnet-5-thinking-max',    'Sonnet 5 Max')
    ) AS t(model_id, upstream_model_id, display_name)
  LOOP
    INSERT INTO model_catalog (
      model_id, engine, provider_id, upstream_model_id, context_window,
      capability_profile, capability_schema_version, state
    )
    SELECT rec.model_id, engine, provider_id, rec.upstream_model_id, context_window,
           capability_profile, capability_schema_version, 'staged'
      FROM model_catalog WHERE model_id = 'cursor-fable-5.1-high' AND state = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0271 failed to clone catalog for %', rec.model_id;
    END IF;

    INSERT INTO model_pricing (
      model_id, display_name,
      input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
      multiplier, enabled, sort_order, visibility, extra_system_prompt,
      default_effort, lock_version, min_plan_code
    )
    SELECT rec.model_id, rec.display_name,
           600, 3000, 60, 750,
           1.000, FALSE, sort_order + 1, visibility, extra_system_prompt,
           default_effort, 0, min_plan_code
      FROM model_pricing WHERE model_id = 'cursor-fable-5.1-high';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0271 failed to clone pricing for %', rec.model_id;
    END IF;

    UPDATE model_catalog SET state = 'active' WHERE model_id = rec.model_id AND state = 'staged';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0271 failed to activate catalog %', rec.model_id;
    END IF;

    UPDATE model_pricing SET enabled = TRUE, lock_version = lock_version + 1
     WHERE model_id = rec.model_id;
  END LOOP;

  -- ── 3. audit CHECK ────────────────────────────────────────────────────
  ALTER TABLE cursor_external_usage_audit
    DROP CONSTRAINT IF EXISTS cursor_external_usage_audit_model_id_check;
  ALTER TABLE cursor_external_usage_audit
    ADD CONSTRAINT cursor_external_usage_audit_model_id_check CHECK (model_id IN (
      'cursor-auto',
      'cursor-grok-4.6-low', 'cursor-grok-4.6-low-fast',
      'cursor-grok-4.6-medium', 'cursor-grok-4.6-medium-fast',
      'cursor-grok-4.6-high', 'cursor-grok-4.6-high-fast',
      'cursor-grok-4.6-xhigh', 'cursor-grok-4.6-xhigh-fast',
      'cursor-composer-2.5', 'cursor-composer-2.5-fast',
      'cursor-opus-4.8-low', 'cursor-opus-4.8-low-fast',
      'cursor-opus-4.8-medium', 'cursor-opus-4.8-medium-fast',
      'cursor-opus-4.8-high', 'cursor-opus-4.8-high-fast',
      'cursor-opus-4.8-xhigh', 'cursor-opus-4.8-xhigh-fast',
      'cursor-opus-4.8-max', 'cursor-opus-4.8-max-fast',
      'cursor-opus-5-low', 'cursor-opus-5-low-fast',
      'cursor-opus-5-medium', 'cursor-opus-5-medium-fast',
      'cursor-opus-5-high', 'cursor-opus-5-high-fast',
      'cursor-opus-5-xhigh', 'cursor-opus-5-xhigh-fast',
      'cursor-opus-5-max', 'cursor-opus-5-max-fast',
      'cursor-fable-5-low', 'cursor-fable-5-medium', 'cursor-fable-5-high',
      'cursor-fable-5-xhigh', 'cursor-fable-5-max',
      'cursor-fable-5.1-low', 'cursor-fable-5.1-medium', 'cursor-fable-5.1-high',
      'cursor-fable-5.1-xhigh', 'cursor-fable-5.1-max',
      'cursor-sonnet-5-low', 'cursor-sonnet-5-medium', 'cursor-sonnet-5-high',
      'cursor-sonnet-5-xhigh', 'cursor-sonnet-5-max',
      'cursor-gemini-3.8-flash-low', 'cursor-gemini-3.8-flash-medium', 'cursor-gemini-3.8-flash-high',
      'cursor-grok-4.5-high'
    ));

  -- ── postconditions ────────────────────────────────────────────────────
  SELECT count(*) INTO n FROM model_catalog c JOIN model_pricing p USING (model_id)
   WHERE c.model_id LIKE 'cursor-sonnet-5-%' AND c.engine = 'cursor' AND c.state = 'active'
     AND c.context_window = 1000000 AND p.enabled IS TRUE AND p.visibility = 'public'
     AND p.min_plan_code = 'lite' AND p.multiplier = 1
     AND (p.input_per_mtok, p.output_per_mtok, p.cache_read_per_mtok, p.cache_write_per_mtok) = (600, 3000, 60, 750);
  IF n <> 5 THEN
    RAISE EXCEPTION '0271 expected 5 active public lite Sonnet 5 rows, got %', n;
  END IF;
  IF (SELECT count(*) FROM model_catalog WHERE model_id LIKE 'cursor-fable-5-%' AND state = 'active') <> 0
     OR (SELECT count(*) FROM model_pricing WHERE model_id LIKE 'cursor-fable-5-%' AND (enabled OR visibility <> 'hidden')) <> 0
     OR EXISTS (SELECT 1 FROM client_sessions WHERE deleted_at IS NULL AND model_id LIKE 'cursor-fable-5-%')
     OR EXISTS (SELECT 1 FROM account_group_models WHERE model_id LIKE 'cursor-fable-5-%') THEN
    RAISE EXCEPTION '0271 Fable 5 retirement postcondition mismatch';
  END IF;
  IF (SELECT count(*) FROM model_pricing WHERE model_id LIKE 'cursor-%') <> 50 THEN
    RAISE EXCEPTION '0271 expected 50 cursor-* pricing rows, found %',
      (SELECT count(*) FROM model_pricing WHERE model_id LIKE 'cursor-%');
  END IF;
END $$;

SELECT fn_model_security_epoch_bump();
