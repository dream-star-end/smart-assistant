-- order-dependency: 0317_commercial_muse_media
-- 0318_commercial_box_gpt_6_astra_pro.sql (commercial; OCV5-575)
-- Stages `box-gpt-6-astra-pro` (ChatGPT Web Pro on the shared Box) for commercial uid 1 and uid 4 only
-- (user decision 2026-10-22): visibility 'hidden' plus model_visibility_grants for those two uids, and
-- zero prices: the model is never billed (no Cursor audit row, so no settle). Selfhost 0314 is not carried:
-- it grants uid 3, who is a different person here. Runtime enforcement is OC_BOX_GPT_WEB_ALLOWED_UIDS
-- (master/egress) and OC_BOX_EXEC_TARGET_UIDS (Box exec endpoint); this row only makes the model listable.
-- Born staged/disabled; activated after release via activateEntry.
-- Rollback: db/rollbacks/0318_commercial_box_gpt_6_astra_pro.sql (only while still staged).

-- compat: additive staged catalog seed for a new model_id (born disabled); the DELETE only touches grants on this new model_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'box-claude-opus-5-5'
  ) THEN
    RAISE EXCEPTION '0318 requires the box-claude-opus-5-5 catalog row as the donor';
  END IF;

  IF EXISTS (SELECT 1 FROM model_catalog WHERE model_id = 'box-gpt-6-astra-pro')
     OR EXISTS (SELECT 1 FROM model_pricing WHERE model_id = 'box-gpt-6-astra-pro') THEN
    RAISE EXCEPTION '0318 refuses an existing box-gpt-6-astra-pro row';
  END IF;

  INSERT INTO model_catalog (
    model_id, engine, provider_id, upstream_model_id, context_window,
    capability_profile, capability_schema_version, state
  )
  SELECT 'box-gpt-6-astra-pro', 'cursor', 'cursor', 'gpt-6-astra-pro', 400000,
         capability_profile, capability_schema_version, 'staged'
    FROM model_catalog
   WHERE model_id = 'box-claude-opus-5-5'
   ORDER BY (engine = 'cursor' AND provider_id = 'cursor') DESC, entry_id DESC
   LIMIT 1;

  INSERT INTO model_pricing (
    model_id, display_name, input_per_mtok, output_per_mtok, cache_read_per_mtok,
    cache_write_per_mtok, multiplier, enabled, sort_order, visibility,
    extra_system_prompt, default_effort, min_plan_code, promo_label
  )
  SELECT 'box-gpt-6-astra-pro', 'GPT-6-Astra-Pro', 0, 0, 0, 0, multiplier, FALSE, 19, 'hidden',
         NULL, NULL, NULL, NULL
    FROM model_pricing
   WHERE model_id = 'box-claude-opus-5-5';

  DELETE FROM model_visibility_grants
   WHERE model_id = 'box-gpt-6-astra-pro'
     AND user_id NOT IN (1, 4);

  INSERT INTO model_visibility_grants (user_id, model_id, granted_by)
  SELECT u.id, 'box-gpt-6-astra-pro', NULL
    FROM users u
   WHERE u.id IN (1, 4)
  ON CONFLICT (user_id, model_id) DO NOTHING;

  IF (SELECT count(*) FROM model_catalog c JOIN model_pricing p USING (model_id)
       WHERE c.model_id = 'box-gpt-6-astra-pro' AND c.state = 'staged' AND p.enabled IS FALSE
         AND p.visibility = 'hidden' AND p.input_per_mtok = 0 AND p.output_per_mtok = 0
         AND p.cache_read_per_mtok = 0 AND p.cache_write_per_mtok = 0) <> 1 THEN
    RAISE EXCEPTION '0318 must leave box-gpt-6-astra-pro staged, disabled, hidden and free';
  END IF;
END $$;
