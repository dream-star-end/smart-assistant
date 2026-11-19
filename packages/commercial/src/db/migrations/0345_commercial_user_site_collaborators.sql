-- order-dependency: 0342_commercial_user_sites
-- order-dependency: 0344_commercial_antigravity_gemini_4_neon
-- compat: purely additive columns on user_sites and new tables user_site_collaborators / user_site_invites with openclaude_app DML grants; pre-0345 binaries ignore them and rollback leaves them inert.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE user_sites
  ADD COLUMN IF NOT EXISTS server_api_sha256 TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS op_server_api_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS preview_acl_version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS preview_acl_target_version BIGINT NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_sites_preview_acl_version_chk'
       AND conrelid = 'user_sites'::regclass
  ) THEN
    ALTER TABLE user_sites
      ADD CONSTRAINT user_sites_preview_acl_version_chk CHECK (preview_acl_version >= 1);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_sites_preview_acl_target_version_chk'
       AND conrelid = 'user_sites'::regclass
  ) THEN
    ALTER TABLE user_sites
      ADD CONSTRAINT user_sites_preview_acl_target_version_chk CHECK (preview_acl_target_version >= 1);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS user_site_collaborators (
  site_id UUID NOT NULL REFERENCES user_sites(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_site_collaborators_user_id
  ON user_site_collaborators (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS user_site_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES user_sites(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_site_invites_site_active
  ON user_site_invites (site_id, created_at DESC)
  WHERE revoked_at IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openclaude_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE user_site_collaborators, user_site_invites
      TO openclaude_app;
  END IF;
END $$;
