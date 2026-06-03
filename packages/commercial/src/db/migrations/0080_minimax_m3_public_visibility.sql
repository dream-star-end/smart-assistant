-- 0080_minimax_m3_public_visibility.sql
-- Full rollout: MiniMax-M3 is now available to all users.
--
-- 0077 seeded MiniMax-M3 with visibility='admin' for initial controlled
-- rollout. This migration flips only visibility. It intentionally does not
-- force enabled=TRUE: if ops disabled the row as a kill switch, fail visibly
-- instead of silently re-enabling it.

DO $$
DECLARE
  row_enabled BOOLEAN;
  row_visibility TEXT;
BEGIN
  UPDATE model_pricing
     SET visibility = 'public',
         updated_at = NOW()
   WHERE model_id = 'MiniMax-M3'
     AND visibility <> 'public';

  SELECT enabled, visibility
    INTO row_enabled, row_visibility
    FROM model_pricing
   WHERE model_id = 'MiniMax-M3';

  IF NOT FOUND THEN
    RAISE EXCEPTION '0080: expected MiniMax-M3 row seeded by 0077, got none';
  END IF;

  IF row_visibility <> 'public' THEN
    RAISE EXCEPTION '0080: expected MiniMax-M3 visibility public, got %', row_visibility;
  END IF;

  IF row_enabled IS NOT TRUE THEN
    RAISE EXCEPTION '0080: expected MiniMax-M3 enabled true, got %', row_enabled;
  END IF;
END $$;
