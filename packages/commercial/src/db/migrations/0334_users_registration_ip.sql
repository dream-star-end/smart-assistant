-- order-dependency: none  (0330-0333 are selfhost-only, not in the commercial tree; a later selfhost sync must renumber them above 0334)
-- 0334_users_registration_ip.sql (commercial; same-IP account cap, user decision 2026-11-06)
-- Records the client IP an account was created from, so registration can cap accounts per IP.
-- Existing rows stay NULL: they are not backfilled and never count against a cap.
-- Rollback: db/rollbacks/0334_users_registration_ip.sql.

-- compat: additive nullable column; old binaries never name it, so their inserts leave it NULL
SET LOCAL lock_timeout = '5s';
ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_ip INET;
CREATE INDEX IF NOT EXISTS idx_users_registration_ip
  ON users (registration_ip) WHERE registration_ip IS NOT NULL;
