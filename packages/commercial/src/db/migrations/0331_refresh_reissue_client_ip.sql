-- order-dependency: none (0331 is next after base 0330. PR #1289 also holds 0331 as 0331_box_agent_api_scopes; whichever lands second must renumber, and check-migration-order R2 turns that PR red until it does.)
-- 0331_refresh_reissue_client_ip.sql
--
-- INC-20261030-REFRESH-UNDELIVERED-SETCOOKIE. A refresh whose Set-Cookie never
-- reached the browser is reissued instead of treated as theft, but only when the
-- real client matches. Personal ingress is cloudflared to 127.0.0.1, so
-- refresh_tokens.ip (authBoundIp) is loopback for every visitor and cannot tell
-- clients apart. client_ip stores the real client address (CF-Connecting-IP on
-- the loopback socket). Reissue requires it to be non-empty and equal. The 45s
-- race grace still uses ip.
--
-- The successor a reissue replaces gets revoked_reason 'reissued' instead of
-- 'rotated', so reissue stays distinguishable from rotation and a later
-- presentation of that successor outside the grace window is theft.
--
-- Rollback: db/rollbacks/0331_refresh_reissue_client_ip.sql.
-- 含迁移，上车前需管家批准。

-- compat: New nullable column with no default. Existing rows read NULL, which the new reissue path treats as an incomplete fingerprint (no reissue, old theft behaviour). Old binaries never read or write it; their INSERTs omit it and get NULL.
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS client_ip INET NULL;

-- compat: Replaced in the same migration transaction by a strict superset of the 0019 CHECK (below). Every existing row and every value old binaries write ('logout','rotated','theft','password_reset','admin') stays valid.
ALTER TABLE refresh_tokens
  DROP CONSTRAINT IF EXISTS refresh_tokens_revoked_reason_check;

-- compat: Superset of the 0019 enum plus 'reissued', so existing rows validate. Only the new binary writes 'reissued'; an old binary reading such a row sees an unknown reason, and its refresh path rejects that ticket as plain INVALID_REFRESH without a family revoke.
ALTER TABLE refresh_tokens
  ADD CONSTRAINT refresh_tokens_revoked_reason_check
  CHECK (
    revoked_reason IS NULL
    OR revoked_reason IN ('logout', 'rotated', 'theft', 'password_reset', 'admin', 'reissued')
  );
