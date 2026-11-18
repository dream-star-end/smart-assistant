-- order-dependency: none
-- compat: purely additive tables user_sites and user_sites_rev_counter; pre-0345 binaries ignore them and rollback leaves them inert.

CREATE TABLE IF NOT EXISTS user_sites_rev_counter (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_rev BIGINT NOT NULL DEFAULT 0 CHECK (last_rev >= 0)
);

INSERT INTO user_sites_rev_counter (id, last_rev) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'password', 'disabled')),
  password_salt TEXT,
  password_hash TEXT,
  spa_mode BOOLEAN NOT NULL DEFAULT TRUE,
  file_count INTEGER NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  content_sha256 TEXT NOT NULL DEFAULT '',
  edge_revision BIGINT NOT NULL DEFAULT 0 CHECK (edge_revision >= 0),
  op_lease_id UUID,
  op_lease_until TIMESTAMPTZ,
  op_expected_rev BIGINT NOT NULL DEFAULT 0 CHECK (op_expected_rev >= 0),
  op_target_rev BIGINT NOT NULL DEFAULT 0 CHECK (op_target_rev >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_sites_slug_format_chk CHECK (
    slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'
  ),
  CONSTRAINT user_sites_password_consistency_chk CHECK (
    (visibility = 'password' AND password_salt IS NOT NULL AND password_hash IS NOT NULL)
    OR (visibility <> 'password')
  )
);

CREATE INDEX IF NOT EXISTS idx_user_sites_user_updated
  ON user_sites (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_sites_user_pending
  ON user_sites (user_id)
  WHERE edge_revision = 0 OR op_target_rev > edge_revision;
