-- 0280_cursor_haiku_45.sql
-- order-dependency: 0279_api_key_message_audit
-- Add Claude Haiku 4.5 as a Cursor Sand catalog row (`cursor-haiku-4.5`).
--
-- Why: the external API-key surface (/api/anthropic) needs a cheap "haiku slot"
-- model for Claude Code's ANTHROPIC_DEFAULT_HAIKU_MODEL (title generation,
-- background classifiers). This deployment has no Anthropic-direct account, so
-- the only path is Cursor Sand. Probed live 2026-09-08 against
-- InferenceService/Stream with a session credential: `claude-haiku-4-5` streams
-- normally; `claude-haiku-4-5-thinking-{low,high}`, `claude-haiku-4.5` and
-- `claude-3-5-haiku` return ERROR_BAD_MODEL_NAME. Single tier, no thinking
-- axis (same shape as composer-2.5), so the public id is just `haiku-4.5`.
--
-- Pricing: Anthropic list for Haiku 4.5 is 1 / 5 / 0.1 / 1.25 USD per MTok;
-- at the 200 credits/USD convention used by 0271 (Sonnet 5 = 600/3000/60/750)
-- that is 200 / 1000 / 20 / 250. multiplier 1, public, ungated, enabled.
-- sort_order 160 places it after the Gemini Flash rows in the picker.
--
-- Catalog row clones cursor-gemini-3.8-flash-low (engine/provider/capability
-- profile) with upstream_model_id = claude-haiku-4-5; context_window 200000
-- (Haiku 4.5 published window). Born staged, then activated (catalog trigger
-- contract).
--
-- NOT touched: cursor_external_usage_audit's model_id CHECK. That table is only
-- written by the *web chat* cursor path (userChatBridge); the external API-key
-- path settles into usage_records. Extending the CHECK needs DROP+ADD (breaking
-- DDL gate); leave it for the batch that opens Haiku 4.5 to web chat.
--
-- Additive only; rollback-safe (older code ignores the unknown row).

DO $$
DECLARE
  existing INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-gemini-3.8-flash-low' AND c.engine = 'cursor' AND c.state = 'active'
  ) THEN
    RAISE EXCEPTION '0280 requires active cursor-gemini-3.8-flash-low catalog row to clone';
  END IF;

  SELECT COUNT(*) INTO existing FROM model_catalog WHERE model_id = 'cursor-haiku-4.5';

  IF existing = 0 THEN
    INSERT INTO model_catalog (
      model_id, engine, provider_id, upstream_model_id, context_window,
      capability_profile, capability_schema_version, state
    )
    SELECT
      'cursor-haiku-4.5',
      engine,
      provider_id,
      'claude-haiku-4-5',
      200000,
      capability_profile,
      capability_schema_version,
      'staged'
    FROM model_catalog
    WHERE model_id = 'cursor-gemini-3.8-flash-low' AND state = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0280 failed to clone catalog from cursor-gemini-3.8-flash-low';
    END IF;

    INSERT INTO model_pricing (
      model_id, display_name,
      input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
      multiplier, enabled, sort_order, visibility, extra_system_prompt,
      default_effort, lock_version, min_plan_code
    )
    VALUES (
      'cursor-haiku-4.5', 'Haiku 4.5',
      200, 1000, 20, 250,
      1, FALSE, 160, 'public', NULL,
      NULL, 0, NULL
    )
    ON CONFLICT (model_id) DO NOTHING;

    UPDATE model_catalog SET state = 'active'
     WHERE model_id = 'cursor-haiku-4.5' AND state = 'staged';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0280 failed to activate catalog cursor-haiku-4.5';
    END IF;

    UPDATE model_pricing
       SET enabled = TRUE, lock_version = lock_version + 1
     WHERE model_id = 'cursor-haiku-4.5';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0280 failed to enable pricing cursor-haiku-4.5';
    END IF;
  ELSE
    -- Fork convergence: accept an identical pre-existing row, refuse drift.
    IF EXISTS (
      SELECT 1
        FROM model_catalog c
        LEFT JOIN model_pricing p USING (model_id)
       WHERE c.model_id = 'cursor-haiku-4.5'
         AND (c.engine IS DISTINCT FROM 'cursor'
           OR c.upstream_model_id IS DISTINCT FROM 'claude-haiku-4-5'
           OR c.state IS DISTINCT FROM 'active'
           OR p.enabled IS DISTINCT FROM TRUE)
    ) THEN
      RAISE EXCEPTION '0280 refuses drifted pre-existing cursor-haiku-4.5 row';
    END IF;
  END IF;
END
$$;
