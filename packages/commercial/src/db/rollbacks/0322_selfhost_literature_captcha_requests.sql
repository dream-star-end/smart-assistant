-- OCV5-524: stop the CAPTCHA service before rollback. Old code ignores the additive table.
-- This destructive rollback refuses retained usage; export/retain audit history before any separate approved cleanup.
BEGIN;
LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE literature_captcha_requests IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0322_selfhost_literature_captcha_requests') THEN
    RAISE EXCEPTION '0322_selfhost_literature_captcha_requests is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > '0322_selfhost_literature_captcha_requests') THEN
    RAISE EXCEPTION 'a later migration is applied; roll that back first';
  END IF;
  IF EXISTS (SELECT 1 FROM literature_captcha_requests) THEN
    RAISE EXCEPTION 'retained platform usage prevents destructive rollback';
  END IF;
END $$;
DROP TABLE literature_captcha_requests;
DELETE FROM schema_migrations WHERE version = '0322_selfhost_literature_captcha_requests';
COMMIT;
