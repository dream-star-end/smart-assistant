-- 0186_ark_k3_public.sql
-- Rename the Ark-backed Kimi K3 entry and make it available to all users.
--
-- This is a visibility/display-only rollout.  Provider routing, pricing, sort order,
-- context window, capability profile, and the enabled kill switch stay unchanged.
--
-- Manual rollback (do not delete the 0186 schema_migrations ledger row): under the
-- same advisory lock + transaction + SET LOCAL ROLE openclaude discipline used by
-- V5_DEV_PLAYBOOK.md §4.5, restore the exact pre-rollout values only when the row is
-- still in this migration's post-state:
--
--   DO $$
--   DECLARE affected INTEGER;
--   BEGIN
--     UPDATE model_pricing
--        SET display_name = 'Kimi K3（火山 Agent Plan）',
--            visibility = 'admin',
--            lock_version = lock_version + 1,
--            updated_at = NOW()
--      WHERE model_id = 'kimi-k3-ark'
--        AND display_name = 'Kimi K3（ark）'
--        AND visibility = 'public';
--     GET DIAGNOSTICS affected = ROW_COUNT;
--     IF affected <> 1 THEN
--       RAISE EXCEPTION '0186 rollback expected exactly one unchanged post-state row, got %', affected;
--     END IF;
--   END $$;
--
-- Re-publishing after such a rollback requires a new migration.

DO $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE model_pricing
     SET display_name = 'Kimi K3（ark）',
         visibility = 'public',
         lock_version = lock_version + 1,
         updated_at = NOW()
   WHERE model_id = 'kimi-k3-ark';

  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0186 expected exactly one kimi-k3-ark pricing row, got %', affected;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM model_pricing p
      JOIN model_catalog c
        ON c.model_id = p.model_id
       AND c.state = 'active'
     WHERE p.model_id = 'kimi-k3-ark'
       AND p.display_name = 'Kimi K3（ark）'
       AND p.visibility = 'public'
       AND p.enabled IS TRUE
       AND c.engine = 'ccb'
       AND c.provider_id = 'ark-k3'
       AND c.upstream_model_id = 'kimi-k3'
       AND c.context_window = 1048576
  ) THEN
    RAISE EXCEPTION '0186 kimi-k3-ark public activation verification failed';
  END IF;
END $$;
