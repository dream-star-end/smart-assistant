-- order-dependency: 0345_user_sites
-- compat: purely additive columns on user_sites and new tables user_site_env_vars / user_site_slug_claims; pre-0347 binaries ignore new columns/tables and rollback leaves them inert.

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
    SELECT 1 FROM pg_constraint WHERE conname = 'user_sites_custom_domain_format_chk'
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
    SELECT 1 FROM pg_constraint WHERE conname = 'user_sites_op_kind_chk'
  ) THEN
    ALTER TABLE user_sites
      ADD CONSTRAINT user_sites_op_kind_chk CHECK (
        op_kind IS NULL OR op_kind IN ('publish', 'meta', 'env', 'rename', 'delete')
      );
  END IF;
END $$;

DROP INDEX IF EXISTS idx_user_sites_custom_domain_unique;
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
