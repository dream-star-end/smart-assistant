-- OCV5-575: only while box-gpt-6-astra-pro is still staged; after activation disable it with disableEntry first.
BEGIN;
LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0318_commercial_box_gpt_6_astra_pro') THEN
    RAISE EXCEPTION '0318_commercial_box_gpt_6_astra_pro is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > '0318_commercial_box_gpt_6_astra_pro') THEN
    RAISE EXCEPTION 'a later migration is applied; roll that back first';
  END IF;
  IF EXISTS (SELECT 1 FROM model_catalog WHERE model_id = 'box-gpt-6-astra-pro' AND state <> 'staged') THEN
    RAISE EXCEPTION 'box-gpt-6-astra-pro is no longer staged; disable it with disableEntry instead';
  END IF;
END $$;
DELETE FROM model_visibility_grants WHERE model_id = 'box-gpt-6-astra-pro';
DELETE FROM model_pricing WHERE model_id = 'box-gpt-6-astra-pro' AND enabled = FALSE;
DELETE FROM model_catalog WHERE model_id = 'box-gpt-6-astra-pro' AND state = 'staged';
DELETE FROM schema_migrations WHERE version = '0318_commercial_box_gpt_6_astra_pro';
COMMIT;
