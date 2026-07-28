-- 0193 — signal_traffic_class is now an input to model authorization.
--
-- Test-account classification changes must invalidate every epoch-fenced authz
-- cache immediately, exactly like users.role changes already do.

CREATE OR REPLACE FUNCTION fn_users_model_role_security_after() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.signal_traffic_class IS DISTINCT FROM OLD.signal_traffic_class THEN
    PERFORM fn_model_security_epoch_bump();
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_users_model_role_security_after ON users;
CREATE TRIGGER trg_users_model_role_security_after
  AFTER UPDATE OF role, signal_traffic_class ON users
  FOR EACH ROW
  WHEN (
    OLD.role IS DISTINCT FROM NEW.role
    OR OLD.signal_traffic_class IS DISTINCT FROM NEW.signal_traffic_class
  )
  EXECUTE FUNCTION fn_users_model_role_security_after();

COMMENT ON COLUMN users.signal_traffic_class IS
  'Traffic-quality class and model-authz input. Changes bump model_security_epoch (0193).';
