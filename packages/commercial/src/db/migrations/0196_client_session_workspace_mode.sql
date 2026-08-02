-- Stage A of per-session workspace isolation.
--
-- Keep the database default on `legacy` while old and new runtime containers
-- may coexist. A later, independent migration flips only the default after
-- every runtime has converged on code that understands `isolated_v1`.
ALTER TABLE client_sessions
  ADD COLUMN IF NOT EXISTS workspace_mode TEXT NOT NULL DEFAULT 'legacy'
  CHECK (workspace_mode IN ('legacy', 'isolated_v1'));

COMMENT ON COLUMN client_sessions.workspace_mode IS
  'Server-authoritative default cwd policy: legacy shared root or isolated_v1 per-session directory';
