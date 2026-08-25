-- 0246_ungate_cursor_opus_fable_picker.sql
-- Drop the 0224 Max-plan floor on Cursor Opus 5 / Fable 5 so the picker
-- lists them like Grok 4.6 / Composer. Prices, visibility, enabled, grants,
-- and the Cursor credential UID gate stay unchanged. Hidden models still
-- need an explicit grant; admin role still does not bypass hidden.
--
-- 0144's pricing security trigger did not watch min_plan_code, so a bare
-- UPDATE would not bump model_security_epoch and ModelCatalogCache would
-- keep the Max gate. Teach the trigger, then bump once so the live picker
-- reloads without a master restart.

CREATE OR REPLACE FUNCTION fn_model_pricing_security_after() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_setting('openclaude.catalog_sync', true) IS NOT DISTINCT FROM '1' THEN
    RETURN NULL;
  END IF;

  IF TG_OP IN ('INSERT', 'DELETE') THEN
    PERFORM fn_model_security_epoch_bump();
    RETURN NULL;
  END IF;

  IF NEW.input_per_mtok       IS DISTINCT FROM OLD.input_per_mtok
  OR NEW.output_per_mtok      IS DISTINCT FROM OLD.output_per_mtok
  OR NEW.cache_read_per_mtok  IS DISTINCT FROM OLD.cache_read_per_mtok
  OR NEW.cache_write_per_mtok IS DISTINCT FROM OLD.cache_write_per_mtok
  OR NEW.multiplier           IS DISTINCT FROM OLD.multiplier
  OR NEW.visibility           IS DISTINCT FROM OLD.visibility
  OR NEW.default_effort       IS DISTINCT FROM OLD.default_effort
  OR NEW.min_plan_code        IS DISTINCT FROM OLD.min_plan_code THEN
    PERFORM fn_model_security_epoch_bump();
  END IF;
  RETURN NULL;
END $$;

DO $$
DECLARE
  affected INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c
    JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-opus-5-high'
       AND c.engine = 'cursor'
       AND c.state = 'active'
       AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0246 requires active enabled cursor-opus-5-high floor';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c
    JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-fable-5-high'
       AND c.engine = 'cursor'
       AND c.state = 'active'
       AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0246 requires active enabled cursor-fable-5-high floor';
  END IF;

  UPDATE model_pricing
     SET min_plan_code = NULL
   WHERE (model_id LIKE 'cursor-opus-5-%' OR model_id LIKE 'cursor-fable-5-%')
     AND min_plan_code IS NOT DISTINCT FROM 'max';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 15 THEN
    RAISE EXCEPTION '0246: expected 15 Opus/Fable min_plan clears, got %', affected;
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_pricing
     WHERE min_plan_code IS NOT NULL
       AND (model_id LIKE 'cursor-opus-5-%' OR model_id LIKE 'cursor-fable-5-%')
  ) THEN
    RAISE EXCEPTION '0246: leftover min_plan_code on Opus/Fable';
  END IF;
END $$;

SELECT fn_model_security_epoch_bump();
