-- 0273_restore_ccb_provider_check.sql
-- order-dependency: none 0269-0272 are claimed on selfhost/other lines, not on aurora 0268 tip
--
-- Restore model_catalog_ccb_needs_provider. 0143 created
--   CHECK (engine <> 'ccb' OR provider_id IS NOT NULL)
-- 0208 and 0227 expand the engine enum with
--   LIKE '%engine%' AND LIKE '%ccb%'
-- which also matches this CHECK and drop it without recreating. The 0143
-- invariant still holds: a ccb row without provider_id cannot be routed.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'model_catalog'::regclass
       AND conname = 'model_catalog_ccb_needs_provider'
  ) THEN
    ALTER TABLE model_catalog
      ADD CONSTRAINT model_catalog_ccb_needs_provider
      CHECK (engine <> 'ccb' OR provider_id IS NOT NULL);
  END IF;
END $$;

COMMENT ON CONSTRAINT model_catalog_ccb_needs_provider ON model_catalog IS
  'ccb rows must carry provider_id; restored after 0208/0227 engine-enum expansion dropped it.';
