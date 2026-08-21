-- 0225_cursor_account_pool.sql
-- Lift Cursor API keys into the shared account-pool (same store / groups /
-- admin surface as CCB + Codex). The host auth directory remains the runtime
-- injection path; the pool is now the source of truth and is materialized
-- onto that directory.

-- Cursor accounts share claude_accounts encrypted token columns. They are
-- selected only inside the cursor provider partition and do not use egress.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'claude_accounts'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%provider%'
       AND pg_get_constraintdef(oid) LIKE '%claude%'
       AND pg_get_constraintdef(oid) LIKE '%codex%'
  LOOP
    EXECUTE format('ALTER TABLE claude_accounts DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE claude_accounts
    ADD CONSTRAINT claude_accounts_provider_check
    CHECK (provider IN ('claude', 'codex', 'grok', 'cursor'));
END $$;

-- Cursor CLI talks upstream from the container; it does not ride the
-- account-pool egress proxy. Relax the 0055 "every row has a pool proxy"
-- CHECK for provider='cursor' only.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'claude_accounts'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%egress_proxy%'
       AND pg_get_constraintdef(oid) LIKE '%egress_proxy_id%'
  LOOP
    EXECUTE format('ALTER TABLE claude_accounts DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE claude_accounts
    ADD CONSTRAINT claude_accounts_egress_proxy_check
    CHECK (
      egress_proxy IS NULL AND (
        provider = 'cursor' OR egress_proxy_id IS NOT NULL
      )
    );
END $$;

DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'account_groups'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%provider%'
       AND (
         pg_get_constraintdef(oid) LIKE '%claude%'
         OR pg_get_constraintdef(oid) LIKE '%codex%'
       )
  LOOP
    EXECUTE format('ALTER TABLE account_groups DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE account_groups
    ADD CONSTRAINT account_groups_provider_check
      CHECK (provider IN ('claude', 'codex', 'grok', 'cursor')),
    ADD CONSTRAINT account_groups_supported_combo_check CHECK (
      (kind = 'official_oauth' AND provider IN ('claude', 'codex', 'grok', 'cursor')) OR
      (kind = 'api_relay'      AND provider = 'codex')
    );
END $$;

INSERT INTO account_groups(label, kind, provider, enabled, priority)
SELECT '默认 Cursor 订阅', 'official_oauth', 'cursor', TRUE, 220
WHERE NOT EXISTS (
  SELECT 1 FROM account_groups WHERE kind = 'official_oauth' AND provider = 'cursor'
);

INSERT INTO account_group_models(group_id, model_id)
SELECT g.id, c.model_id
  FROM account_groups g
  JOIN model_catalog c
    ON c.engine = 'cursor'
   AND c.state = 'active'
 WHERE g.kind = 'official_oauth'
   AND g.provider = 'cursor'
ON CONFLICT DO NOTHING;

COMMENT ON COLUMN claude_accounts.provider IS
  'Account-pool provider: claude (CCB OAuth), codex, grok, or cursor (API key).';
