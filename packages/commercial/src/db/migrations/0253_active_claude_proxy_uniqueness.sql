-- order-dependency: 0252_grok_route_context_kind
-- 0253_active_claude_proxy_uniqueness.sql
--
-- 0250 initially shipped in selfhost with a provider-wide unique predicate.
-- Commercial has disabled historical Claude accounts that intentionally retain
-- their former proxy binding for audit. Runtime anti-ban needs uniqueness only
-- among active accounts; reactivation remains fail-closed until a unique proxy
-- is assigned.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM claude_accounts
     WHERE provider = 'claude'
       AND status = 'active'
       AND egress_proxy_id IS NOT NULL
     GROUP BY egress_proxy_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION '0253 refuses duplicate active Claude proxy bindings';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_claude_accounts_egress_proxy_uniq;

CREATE UNIQUE INDEX idx_claude_accounts_egress_proxy_uniq
  ON claude_accounts (egress_proxy_id)
  WHERE provider = 'claude' AND status = 'active' AND egress_proxy_id IS NOT NULL;
