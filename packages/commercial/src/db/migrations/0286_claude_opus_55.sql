-- 0286_claude_opus_55.sql
-- Onboard Claude Opus 5.5 into the CCB catalog.
--
-- Official (Claude Platform docs, released 2026-09-22):
--   API id claude-opus-5-5
--   $4 input / $20 output / $0.20 cache read / $5 cache write per MTok
--   1M context, 128K max output, adaptive thinking always on, default effort medium
--   https://platform.claude.com/docs/en/models/opus-5-5/overview
--
-- Pricing follows the live selfhost rule after 0234 (integer half, round down):
--   fen/MTok = floor(official_usd * 100 / 2)
--   200 / 1000 / 10 / 250, multiplier 2.500 (same surcharge as claude-opus-5).
--   0234 will not re-half this row; it already ran. Insert the post-half numbers.
--
-- Catalog is NOT inserted by hand. The pricing BEFORE INSERT guard derives
-- engine=ccb, provider=anthropic, context_window=200000, born staged then
-- activated. 200k matches claude-opus-5 (auto-compact). The official 1M window
-- stays unverified on the subscription pool, so this migration does not raise it.
--
-- Cursor family is intentionally absent. Pinned CLI 2026.08.25-3e8eec8 has no
-- opus 5.5 id, cursor.com/docs still lists Opus 5, and --list-models could not
-- be proven (active pool generation has no API key). Do not invent upstream ids.
--
-- Thinking cannot be disabled on Opus 5.5. Same class of limitation already
-- noted for Fable in 0191; this migration does not change the CCB thinking path.
--
-- Manual rollback (keep the schema_migrations ledger row):
--   DELETE FROM model_pricing WHERE model_id = 'claude-opus-5-5'
--     AND input_per_mtok = 200 AND output_per_mtok = 1000
--     AND cache_read_per_mtok = 10 AND cache_write_per_mtok = 250
--     AND multiplier = 2.500;
-- The pricing delete trigger retires the catalog row. account_group_models
-- cascades from model_pricing.

DO $$
DECLARE
  affected INTEGER;
  group_count INTEGER;
BEGIN
  -- Idempotent: a catalog hot-apply may land this row before the
  -- migration runner records schema_migrations. A later official apply
  -- must accept that row instead of failing the primary key.
  IF EXISTS (SELECT 1 FROM model_pricing WHERE model_id = 'claude-opus-5-5') THEN
    IF NOT EXISTS (
      SELECT 1 FROM model_pricing
       WHERE model_id = 'claude-opus-5-5'
         AND input_per_mtok = 200
         AND output_per_mtok = 1000
         AND cache_read_per_mtok = 10
         AND cache_write_per_mtok = 250
         AND multiplier = 2.500
         AND enabled IS TRUE
         AND visibility = 'public'
         AND min_plan_code IS NULL
    ) THEN
      RAISE EXCEPTION '0286 claude-opus-5-5 already exists with unexpected pricing';
    END IF;
  ELSE
    INSERT INTO model_pricing (
      model_id, display_name,
      input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
      multiplier, enabled, sort_order, visibility, lock_version
    )
    VALUES (
      'claude-opus-5-5', 'Claude Opus 5.5',
      200, 1000, 10, 250,
      2.500, TRUE, 139, 'public', 0
    );

    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION '0286 expected exactly 1 pricing insert, got %', affected;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM model_pricing p
      JOIN model_catalog c
        ON c.model_id = p.model_id
       AND c.state = 'active'
     WHERE p.model_id = 'claude-opus-5-5'
       AND p.input_per_mtok = 200
       AND p.output_per_mtok = 1000
       AND p.cache_read_per_mtok = 10
       AND p.cache_write_per_mtok = 250
       AND p.multiplier = 2.500
       AND p.enabled IS TRUE
       AND p.visibility = 'public'
       AND p.min_plan_code IS NULL
       AND c.engine = 'ccb'
       AND c.provider_id = 'anthropic'
       AND c.context_window = 200000
       AND c.capability_profile -> 'ccb' ->> 'capability_zero' = 'false'
       AND c.capability_profile -> 'ccb' ->> 'supports_thinking' = 'true'
       AND c.capability_profile -> 'reasoning' -> 'supported' ? 'medium'
       AND c.capability_profile -> 'reasoning' -> 'supported' ? 'max'
  ) THEN
    RAISE EXCEPTION '0286 claude-opus-5-5 catalog/pricing verification failed';
  END IF;

  INSERT INTO account_group_models(group_id, model_id)
  SELECT g.id, 'claude-opus-5-5'
    FROM account_groups g
   WHERE g.kind = 'official_oauth'
     AND g.provider = 'claude'
     AND g.enabled IS TRUE
  ON CONFLICT DO NOTHING;

  SELECT count(*) INTO group_count
    FROM account_group_models m
    JOIN account_groups g ON g.id = m.group_id
   WHERE m.model_id = 'claude-opus-5-5'
     AND g.kind = 'official_oauth'
     AND g.provider = 'claude'
     AND g.enabled IS TRUE;

  IF group_count < 1 THEN
    RAISE EXCEPTION '0286 claude-opus-5-5 was not bound to an enabled Claude OAuth group';
  END IF;
END $$;
