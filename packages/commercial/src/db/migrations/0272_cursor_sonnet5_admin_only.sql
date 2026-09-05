-- order-dependency: 0271_cursor_retire_fable5_add_sonnet5
-- 0272_cursor_sonnet5_admin_only.sql
-- Operator decision 2026-09-05: Cursor Sonnet 5 is admin-only for now.
-- visibility='admin' → picker shows it to role=admin or explicitly granted
-- users only; pricing/routing unchanged so a granted user works end-to-end.
-- Idempotent absolute target; no DDL.

DO $$
DECLARE n INTEGER;
BEGIN
  UPDATE model_pricing
     SET visibility = 'admin',
         lock_version = lock_version + 1,
         updated_at = clock_timestamp()
   WHERE model_id LIKE 'cursor-sonnet-5-%'
     AND visibility IS DISTINCT FROM 'admin';
  IF (SELECT count(*) FROM model_pricing WHERE model_id LIKE 'cursor-sonnet-5-%' AND visibility = 'admin' AND enabled IS TRUE) <> 5 THEN
    RAISE EXCEPTION '0272 expected 5 enabled admin-only cursor-sonnet-5 rows';
  END IF;
END $$;

SELECT fn_model_security_epoch_bump();
