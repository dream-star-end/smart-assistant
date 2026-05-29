-- 0076_account_groups_codex_official.sql
-- Allow Codex official OAuth subscription groups in addition to API relay groups.
-- Priority remains ascending; accounts may bind only to official_oauth groups.

DO $$
DECLARE
  c RECORD;
BEGIN
  -- 0075 created an unnamed table-level combo CHECK. Drop it by detected
  -- definition rather than relying solely on the generated name.
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'account_groups'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%official_oauth%'
       AND pg_get_constraintdef(oid) LIKE '%api_relay%'
       AND pg_get_constraintdef(oid) LIKE '%provider%'
  LOOP
    EXECUTE format('ALTER TABLE account_groups DROP CONSTRAINT %I', c.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'account_groups'::regclass
       AND conname = 'account_groups_supported_combo_check'
  ) THEN
    ALTER TABLE account_groups
      ADD CONSTRAINT account_groups_supported_combo_check CHECK (
        (kind = 'official_oauth' AND provider IN ('claude','codex')) OR
        (kind = 'api_relay'      AND provider = 'codex')
      );
  END IF;
END $$;

COMMENT ON TABLE account_groups IS
  'Commercial v3 account/API groups. Supports official_oauth+claude, official_oauth+codex, and api_relay+codex.';

INSERT INTO account_groups(label, kind, provider, enabled, priority)
SELECT '默认 GPT 官方 OAuth 订阅', 'official_oauth', 'codex', FALSE, 200
WHERE NOT EXISTS (
  SELECT 1 FROM account_groups WHERE kind = 'official_oauth' AND provider = 'codex'
);

INSERT INTO account_group_models(group_id, model_id)
SELECT g.id, mp.model_id
  FROM account_groups g
  JOIN model_pricing mp ON mp.model_id = 'gpt-5.5'
 WHERE g.kind = 'official_oauth' AND g.provider = 'codex'
ON CONFLICT DO NOTHING;

UPDATE claude_accounts
   SET group_id = (
     SELECT id FROM account_groups
      WHERE kind = 'official_oauth' AND provider = 'codex'
      ORDER BY id LIMIT 1
   )
 WHERE provider = 'codex' AND group_id IS NULL;
