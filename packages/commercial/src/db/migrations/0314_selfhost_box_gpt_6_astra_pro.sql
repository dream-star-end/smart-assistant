-- order-dependency: 0313_selfhost_go_beam_minimax31
-- 0314_selfhost_box_gpt_6_astra_pro.sql (selfhost only; OCV5-551)
-- Stages `box-gpt-6-astra-pro` (upstream `gpt-6-astra-pro`) for the personal edition
-- Box ChatGPT Web Pro interactive runner, restricted exclusively to owner `user_id=3`
-- (`visibility='hidden'` + `model_visibility_grants` for `user_id=3` when `users.id=3` exists).
--
-- Born staged/disabled; activated after release via `activateEntry`.
--
-- BEGIN MANUAL ROLLBACK 0314 (only while the row is still staged; after activation disable with disableEntry first)
-- DELETE FROM model_visibility_grants WHERE model_id = 'box-gpt-6-astra-pro';
-- DELETE FROM model_pricing WHERE model_id = 'box-gpt-6-astra-pro' AND enabled = FALSE;
-- DELETE FROM model_catalog WHERE model_id = 'box-gpt-6-astra-pro' AND state = 'staged';
-- END MANUAL ROLLBACK 0314

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id = 'box-claude-opus-5-5' AND engine = 'cursor' AND provider_id = 'cursor'
       AND state IN ('active', 'disabled', 'staged')
  ) THEN
    RAISE EXCEPTION '0314 requires the box-claude-opus-5-5 catalog row as the donor';
  END IF;

  IF EXISTS (SELECT 1 FROM model_catalog WHERE model_id = 'box-gpt-6-astra-pro')
     OR EXISTS (SELECT 1 FROM model_pricing WHERE model_id = 'box-gpt-6-astra-pro') THEN
    IF NOT EXISTS (
      SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
       WHERE c.model_id = 'box-gpt-6-astra-pro' AND c.engine = 'cursor' AND c.provider_id = 'cursor'
         AND c.upstream_model_id = 'gpt-6-astra-pro' AND c.context_window = 400000
         AND c.state IN ('staged', 'active', 'disabled')
         AND p.display_name = 'GPT-6-Astra-Pro' AND p.visibility = 'hidden'
         AND p.sort_order = 19
    ) THEN
      RAISE EXCEPTION '0314 refuses a drifted box-gpt-6-astra-pro row';
    END IF;
  ELSE
    INSERT INTO model_catalog (
      model_id, engine, provider_id, upstream_model_id, context_window,
      capability_profile, capability_schema_version, state
    )
    SELECT 'box-gpt-6-astra-pro', engine, provider_id, 'gpt-6-astra-pro', 400000,
           capability_profile, capability_schema_version, 'staged'
      FROM model_catalog
     WHERE model_id = 'box-claude-opus-5-5' AND state IN ('active', 'disabled', 'staged')
     ORDER BY (state = 'active') DESC, entry_id DESC
     LIMIT 1;

    INSERT INTO model_pricing (
      model_id, display_name, input_per_mtok, output_per_mtok, cache_read_per_mtok,
      cache_write_per_mtok, multiplier, enabled, sort_order, visibility,
      extra_system_prompt, default_effort, min_plan_code, promo_label
    )
    SELECT 'box-gpt-6-astra-pro', 'GPT-6-Astra-Pro', input_per_mtok, output_per_mtok,
           cache_read_per_mtok, cache_write_per_mtok, multiplier, FALSE, 19, 'hidden',
           NULL, NULL, NULL, NULL
      FROM model_pricing
     WHERE model_id = 'box-claude-opus-5-5';
  END IF;

  DELETE FROM model_visibility_grants
   WHERE model_id = 'box-gpt-6-astra-pro'
     AND user_id <> 3;

  INSERT INTO model_visibility_grants (user_id, model_id, granted_by)
  SELECT 3, 'box-gpt-6-astra-pro', 3
   WHERE EXISTS (SELECT 1 FROM users WHERE id = 3)
  ON CONFLICT (user_id, model_id) DO NOTHING;

  IF (SELECT count(*) FROM model_catalog c JOIN model_pricing p USING (model_id)
       WHERE c.model_id = 'box-gpt-6-astra-pro' AND c.state = 'staged' AND p.enabled IS FALSE) <> 1
     AND NOT EXISTS (SELECT 1 FROM model_catalog
                      WHERE model_id = 'box-gpt-6-astra-pro' AND state IN ('active', 'disabled')) THEN
    RAISE EXCEPTION '0314 must leave box-gpt-6-astra-pro staged/disabled';
  END IF;
END $$;
