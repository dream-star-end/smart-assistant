-- Deploy a release without the same-IP account cap first: new code writes this column.
-- Destructive: drops the recorded registration IPs, and with them the cap's history.
BEGIN;
LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0334_users_registration_ip') THEN
    RAISE EXCEPTION '0334_users_registration_ip is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > '0334_users_registration_ip') THEN
    RAISE EXCEPTION 'a later migration is applied; roll that back first';
  END IF;
END $$;
DROP INDEX idx_users_registration_ip;
ALTER TABLE users DROP COLUMN registration_ip;
DELETE FROM schema_migrations WHERE version = '0334_users_registration_ip';
COMMIT;
