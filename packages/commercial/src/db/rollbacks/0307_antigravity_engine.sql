-- Rollback for 0307_antigravity_engine (OCV5-415 P2).
-- Re-release code older than 0307 first. Refuses if any Antigravity model was
-- activated (retire it through the admin catalog path instead) or if relay
-- usage was recorded (that is billing evidence; keep it).
-- The widened engine CHECK stays: older code never writes 'antigravity'.
BEGIN;
LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0307_antigravity_engine') THEN
    RAISE EXCEPTION '0307_antigravity_engine is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > '0307_antigravity_engine') THEN
    RAISE EXCEPTION 'a later migration is applied; roll that back first';
  END IF;
  IF EXISTS (SELECT 1 FROM model_catalog WHERE engine = 'antigravity' AND state <> 'staged') THEN
    RAISE EXCEPTION 'an antigravity catalog row left staged; retire it via the admin catalog path first';
  END IF;
  IF EXISTS (SELECT 1 FROM antigravity_relay_usage) THEN
    RAISE EXCEPTION 'antigravity_relay_usage has rows; keep them (billing evidence)';
  END IF;
END $$;
DELETE FROM model_pricing WHERE model_id IN (
  'antigravity-gemini-3.8-flash', 'antigravity-claude-sonnet-4.6',
  'antigravity-claude-opus-4.6', 'antigravity-gpt-oss-120b');
DELETE FROM model_catalog WHERE engine = 'antigravity' AND state = 'staged';
DROP TABLE antigravity_turns;
DROP TABLE antigravity_relay_usage;
DROP TABLE gemini_oauth_accounts;
DELETE FROM schema_migrations WHERE version = '0307_antigravity_engine';
COMMIT;
