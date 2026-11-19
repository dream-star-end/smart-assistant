-- OCV5-802: fold selfhost user_sites + fullstack site hosting tables (0345_user_sites + 0347_user_sites_fullstack)
-- into commercial history as purely additive DDL.
-- order-dependency: 0341_commercial_antigravity_gemini_4_models
-- compat: purely additive tables user_sites_rev_counter, user_sites, user_site_slug_claims, and user_site_env_vars; pre-0342 binaries ignore them and rollback leaves them inert. Cross-instance slug/tombstone ownership on shared edge storage is enforced by siteId UUIDs; last_rev=100000 is an initial diagnostic offset only.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- sync-section: 0345_user_sites
CREATE TABLE IF NOT EXISTS user_sites_rev_counter (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_rev BIGINT NOT NULL DEFAULT 0 CHECK (last_rev >= 0)
);

INSERT INTO user_sites_rev_counter (id, last_rev) VALUES (1, 100000) ON CONFLICT (id) DO NOTHING;

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
-- end-sync-section: 0345_user_sites

-- sync-section: 0347_user_sites_fullstack
ALTER TABLE user_sites
  ADD COLUMN IF NOT EXISTS custom_domain TEXT,
  ADD COLUMN IF NOT EXISTS custom_domain_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS custom_domain_token TEXT,
  ADD COLUMN IF NOT EXISTS origin_session_id TEXT,
  ADD COLUMN IF NOT EXISTS has_server_api BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS env_digest TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS op_kind TEXT,
  ADD COLUMN IF NOT EXISTS op_rename_to_slug TEXT,
  ADD COLUMN IF NOT EXISTS op_env_digest TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_sites_custom_domain_format_chk'
       AND conrelid = 'user_sites'::regclass
  ) THEN
    ALTER TABLE user_sites
      ADD CONSTRAINT user_sites_custom_domain_format_chk CHECK (
        custom_domain IS NULL OR (
          length(custom_domain) <= 253
          AND custom_domain ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_sites_op_kind_chk'
       AND conrelid = 'user_sites'::regclass
  ) THEN
    ALTER TABLE user_sites
      ADD CONSTRAINT user_sites_op_kind_chk CHECK (
        op_kind IS NULL OR op_kind IN ('publish', 'meta', 'env', 'rename', 'delete')
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sites_custom_domain_verified_unique
  ON user_sites (custom_domain)
  WHERE custom_domain IS NOT NULL AND custom_domain_verified = TRUE;

CREATE TABLE IF NOT EXISTS user_site_slug_claims (
  slug TEXT PRIMARY KEY,
  site_id UUID NOT NULL REFERENCES user_sites(id) ON DELETE CASCADE,
  claim_kind TEXT NOT NULL CHECK (claim_kind IN ('active', 'rename_target')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_site_slug_claims_site_id
  ON user_site_slug_claims (site_id);

INSERT INTO user_site_slug_claims (slug, site_id, claim_kind)
SELECT slug, id, 'active' FROM user_sites
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_site_env_vars (
  site_id UUID NOT NULL REFERENCES user_sites(id) ON DELETE CASCADE,
  env_key TEXT NOT NULL CHECK (env_key ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  is_secret BOOLEAN NOT NULL DEFAULT FALSE,
  plain_value TEXT,
  ciphertext BYTEA,
  nonce BYTEA,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, env_key),
  CONSTRAINT user_site_env_vars_secret_shape_chk CHECK (
    (is_secret = FALSE AND plain_value IS NOT NULL AND ciphertext IS NULL AND nonce IS NULL)
    OR (is_secret = TRUE AND plain_value IS NULL AND ciphertext IS NOT NULL AND nonce IS NOT NULL)
  )
);
-- end-sync-section: 0347_user_sites_fullstack

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openclaude_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE user_sites_rev_counter, user_sites, user_site_slug_claims, user_site_env_vars
      TO openclaude_app;
  END IF;
END $$;
