-- order-dependency: 0292_gpt61_sol_retire_gpt6_sol
-- 0300_box_claude_haiku_5_5.sql (selfhost only; OCV5-338)
-- Claude Haiku 5.5 (released 2026-10-07) as a fourth box Claude row, beside
-- box-claude-opus-5-5 / box-claude-sonnet-5 / box-claude-haiku-4-5 (0290).
-- It runs on official Claude Code in the account Box like the other three.
--
-- Upstream id: claude-haiku-5-5. It is a fixed id with no date suffix and no
-- alias (platform.claude.com/docs/en/models/haiku-5-5/overview). Box CLI
-- 2.1.294 accepts it and reports the same id in init, message.model and
-- modelUsage, with contextWindow 1000000 and maxOutputTokens 128000.
-- Context window 1000000 accordingly (Haiku 4.5 stays at 200000).
-- Capability profile is the box-claude-haiku-4-5 row's (route B rows carry
-- no effort axis; the Box CLI applies the model default).
--
-- Price, credits per 1M tokens, multiplier 1.0: box-claude-haiku-4-5 is
-- exactly 200x the official Haiku 4.5 list price ($1 / $5 / $0.10 / $1.25 ->
-- 200 / 1000 / 20 / 250). Haiku 5.5 takes the same factor on its official
-- price for prompts up to 100,000 tokens ($0.10 input / $0.50 output /
-- $0.01 cache read / $0.125 5m cache write, platform.claude.com pricing,
-- 2026-10-08): 20 / 100 / 2 / 25. The catalog has one price per model; the
-- official >100k-token tier ($0.50 / $2.50 / $0.05 / $0.625) is not
-- representable and is not applied.
--
-- Born unavailable: catalog staged, pricing disabled. Activation is a
-- separate step through the catalog admin path (activateEntry) after the
-- release that carries the code is live. No account group binding, same as
-- box-claude-haiku-4-5. No session is repointed.
--
-- The cursor_external_usage_audit CHECK (0291) gains the new id, so the chat
-- bridge can record a turn on it once it is active.
--
-- Idempotent: a replay accepts the exact rows this file creates.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id = 'box-claude-haiku-4-5' AND engine = 'cursor' AND provider_id = 'cursor'
       AND state IN ('active', 'disabled', 'staged')
  ) THEN
    RAISE EXCEPTION '0300 requires the box-claude-haiku-4-5 catalog row as the donor';
  END IF;

  IF EXISTS (SELECT 1 FROM model_catalog WHERE model_id = 'box-claude-haiku-5-5')
     OR EXISTS (SELECT 1 FROM model_pricing WHERE model_id = 'box-claude-haiku-5-5') THEN
    IF NOT EXISTS (
      SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
       WHERE c.model_id = 'box-claude-haiku-5-5' AND c.engine = 'cursor' AND c.provider_id = 'cursor'
         AND c.upstream_model_id = 'claude-haiku-5-5' AND c.context_window = 1000000
         AND c.state IN ('staged', 'active', 'disabled')
         AND p.display_name = 'Claude Haiku 5.5' AND p.multiplier = 1 AND p.visibility = 'public'
         AND p.sort_order = 18
         AND p.input_per_mtok = 20 AND p.output_per_mtok = 100
         AND p.cache_read_per_mtok = 2 AND p.cache_write_per_mtok = 25
    ) THEN
      RAISE EXCEPTION '0300 refuses a drifted box-claude-haiku-5-5 row';
    END IF;
  ELSE
    INSERT INTO model_catalog (
      model_id, engine, provider_id, upstream_model_id, context_window,
      capability_profile, capability_schema_version, state
    )
    SELECT 'box-claude-haiku-5-5', engine, provider_id, 'claude-haiku-5-5', 1000000,
           capability_profile, capability_schema_version, 'staged'
      FROM model_catalog
     WHERE model_id = 'box-claude-haiku-4-5' AND state IN ('active', 'disabled', 'staged')
     ORDER BY (state = 'active') DESC, entry_id DESC
     LIMIT 1;
    INSERT INTO model_pricing (
      model_id, display_name, input_per_mtok, output_per_mtok, cache_read_per_mtok,
      cache_write_per_mtok, multiplier, enabled, sort_order, visibility,
      extra_system_prompt, default_effort, min_plan_code, promo_label
    )
    VALUES ('box-claude-haiku-5-5', 'Claude Haiku 5.5', 20, 100, 2, 25, 1.0, FALSE, 18, 'public',
            NULL, NULL, NULL, NULL);
  END IF;

  IF (SELECT count(*) FROM model_catalog c JOIN model_pricing p USING (model_id)
       WHERE c.model_id = 'box-claude-haiku-5-5' AND c.state = 'staged' AND p.enabled IS FALSE) <> 1
     AND NOT EXISTS (SELECT 1 FROM model_catalog
                      WHERE model_id = 'box-claude-haiku-5-5' AND state IN ('active', 'disabled')) THEN
    RAISE EXCEPTION '0300 must leave box-claude-haiku-5-5 staged/disabled';
  END IF;
END $$;

ALTER TABLE cursor_external_usage_audit
  DROP CONSTRAINT IF EXISTS cursor_external_usage_audit_model_id_check;
ALTER TABLE cursor_external_usage_audit
  ADD CONSTRAINT cursor_external_usage_audit_model_id_check CHECK (model_id IN (
      'cursor-auto',
      'cursor-grok-4.6-low',
      'cursor-grok-4.6-low-fast',
      'cursor-grok-4.6-medium',
      'cursor-grok-4.6-medium-fast',
      'cursor-grok-4.6-high',
      'cursor-grok-4.6-high-fast',
      'cursor-grok-4.6-xhigh',
      'cursor-grok-4.6-xhigh-fast',
      'cursor-grok-4.7-low',
      'cursor-grok-4.7-low-fast',
      'cursor-grok-4.7-medium',
      'cursor-grok-4.7-medium-fast',
      'cursor-grok-4.7-high',
      'cursor-grok-4.7-high-fast',
      'cursor-grok-4.7-xhigh',
      'cursor-grok-4.7-xhigh-fast',
      'cursor-composer-2.5',
      'cursor-composer-2.5-fast',
      'cursor-opus-4.8-low',
      'cursor-opus-4.8-low-fast',
      'cursor-opus-4.8-medium',
      'cursor-opus-4.8-medium-fast',
      'cursor-opus-4.8-high',
      'cursor-opus-4.8-high-fast',
      'cursor-opus-4.8-xhigh',
      'cursor-opus-4.8-xhigh-fast',
      'cursor-opus-4.8-max',
      'cursor-opus-4.8-max-fast',
      'cursor-opus-5-low',
      'cursor-opus-5-low-fast',
      'cursor-opus-5-medium',
      'cursor-opus-5-medium-fast',
      'cursor-opus-5-high',
      'cursor-opus-5-high-fast',
      'cursor-opus-5-xhigh',
      'cursor-opus-5-xhigh-fast',
      'cursor-opus-5-max',
      'cursor-opus-5-max-fast',
      'cursor-fable-5-low',
      'cursor-fable-5-medium',
      'cursor-fable-5-high',
      'cursor-fable-5-xhigh',
      'cursor-fable-5-max',
      'cursor-fable-5.1-low',
      'cursor-fable-5.1-medium',
      'cursor-fable-5.1-high',
      'cursor-fable-5.1-xhigh',
      'cursor-fable-5.1-max',
      'cursor-sonnet-5-low',
      'cursor-sonnet-5-medium',
      'cursor-sonnet-5-high',
      'cursor-sonnet-5-xhigh',
      'cursor-sonnet-5-max',
      'cursor-gemini-3.8-flash-low',
      'cursor-gemini-3.8-flash-medium',
      'cursor-gemini-3.8-flash-high',
      'cursor-gemini-3.1-pro',
      'cursor-grok-4.5-high',
      'cursor-haiku-4.5',
      'cursor-gpt-5.6-luna-low',
      'cursor-gpt-5.6-luna-low-fast',
      'cursor-gpt-5.6-luna-medium',
      'cursor-gpt-5.6-luna-medium-fast',
      'cursor-gpt-5.6-luna-high',
      'cursor-gpt-5.6-luna-high-fast',
      'cursor-gpt-5.6-luna-xhigh',
      'cursor-gpt-5.6-luna-xhigh-fast',
      'cursor-gpt-5.6-luna-max',
      'cursor-gpt-5.6-luna-max-fast',
      'box-claude-opus-5-5',
      'box-claude-sonnet-5',
      'box-claude-haiku-4-5',
      'box-claude-haiku-5-5'
  ));
