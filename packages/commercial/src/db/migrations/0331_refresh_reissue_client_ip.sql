-- order-dependency: 0019_refresh_token_rotation
-- 0331_refresh_reissue_client_ip.sql
--
-- Personal ingress is cloudflared to 127.0.0.1, so refresh_tokens.ip
-- (authBoundIp) is loopback for every visitor and cannot decide a lost-cookie
-- reissue. client_ip stores the real client address. Reissue requires it to
-- match and be non-empty. The 45s race grace still uses ip.
--
-- A successor replaced by reissue is revoked_reason 'reissued', not 'rotated'.
-- Presenting that ticket outside the grace window is theft; inside it is a race.
--
-- Numbering: origin/feat/v5-selfhost already has 0330_turn_lease_binding.sql.
-- 0331 sorts after it. This branch's previous file is 0328; 0331 still sorts
-- after that, so applying this tree does not go backwards.
--
-- compat: additive nullable column. Old binaries never read client_ip. The
-- CHECK gains 'reissued'; old binaries do not write that reason.
-- Rollback: db/rollbacks/0331_refresh_reissue_client_ip.sql.
-- 含迁移，上车前需管家批准。

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS client_ip INET NULL;

ALTER TABLE refresh_tokens
  DROP CONSTRAINT IF EXISTS refresh_tokens_revoked_reason_check;

ALTER TABLE refresh_tokens
  ADD CONSTRAINT refresh_tokens_revoked_reason_check
  CHECK (
    revoked_reason IS NULL
    OR revoked_reason IN ('logout', 'rotated', 'theft', 'password_reset', 'admin', 'reissued')
  );
