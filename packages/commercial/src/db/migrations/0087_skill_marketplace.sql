-- 0087_skill_marketplace.sql
-- Station-internal curated skill marketplace (B2). Three tables, per the
-- security-hardened design:
--   * listings  — one row per published skill slug (owner-locked = anti-squat)
--   * versions  — IMMUTABLE per (slug, version) artifact + review state. An
--                 update publishes a NEW version that is re-reviewed; old
--                 installs stay pinned to their version (no silent drift).
--   * installs  — per-user install, PINNED to version_id + artifact_hash,
--                 soft-deleted (uninstalled_at) for audit / incident traceback.
--
-- Only `approved` versions of `active` listings are searchable / installable.
-- `revoked` listing state is the kill-switch (removed from search+install,
-- existing installs flagged). install_count is derived from active installs,
-- never a naked counter.

CREATE TABLE IF NOT EXISTS marketplace_skill_listings (
  slug                       TEXT        PRIMARY KEY,                  -- globally unique, owner-locked
  owner_user_id              BIGINT      NOT NULL,
  current_approved_version_id BIGINT,                                  -- FK added after versions exists
  state                      TEXT        NOT NULL DEFAULT 'active'
                               CHECK (state IN ('active', 'unlisted', 'revoked')),
  revoked_reason             TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS marketplace_skill_versions (
  id             BIGSERIAL   PRIMARY KEY,
  slug           TEXT        NOT NULL REFERENCES marketplace_skill_listings(slug) ON DELETE CASCADE,
  version        TEXT        NOT NULL,                                 -- semver-ish, e.g. 1.0.0
  name           TEXT        NOT NULL,
  description    TEXT        NOT NULL,                                 -- plain text only (enters agent context)
  tags           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  raw_skill_md   TEXT        NOT NULL,                                 -- full reviewed SKILL.md (the artifact)
  artifact_hash  TEXT        NOT NULL,                                 -- sha256(normalized full SKILL.md) — security identity
  embedding_hash TEXT        NOT NULL,                                 -- skillContentHash(metadata) — for embedding cache reuse
  status         TEXT        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected')),
  risk_flags     JSONB       NOT NULL DEFAULT '[]'::jsonb,             -- static scanner findings
  policy_version INTEGER     NOT NULL DEFAULT 1,                       -- scanner policy version at submit time
  submitted_by   BIGINT      NOT NULL,
  reviewed_by    BIGINT,                                              -- must differ from submitted_by (enforced in app)
  reviewed_at    TIMESTAMPTZ,
  review_note    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (slug, version)
);

ALTER TABLE marketplace_skill_listings
  ADD CONSTRAINT fk_listing_current_version
  FOREIGN KEY (current_approved_version_id) REFERENCES marketplace_skill_versions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS marketplace_installs (
  id             BIGSERIAL   PRIMARY KEY,
  user_id        BIGINT      NOT NULL,
  slug           TEXT        NOT NULL,
  version_id     BIGINT      NOT NULL REFERENCES marketplace_skill_versions(id),
  artifact_hash  TEXT        NOT NULL,                                 -- pinned at install time
  install_source TEXT        NOT NULL DEFAULT 'web',
  installed_by   BIGINT      NOT NULL,
  installed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uninstalled_at TIMESTAMPTZ                                           -- soft delete; NULL = active
);

-- one ACTIVE install per (user, slug); re-install after uninstall is allowed
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_active_install
  ON marketplace_installs (user_id, slug) WHERE uninstalled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mkt_versions_slug_status ON marketplace_skill_versions (slug, status);
CREATE INDEX IF NOT EXISTS idx_mkt_versions_status      ON marketplace_skill_versions (status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_mkt_installs_slug_active ON marketplace_installs (slug) WHERE uninstalled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mkt_listings_state       ON marketplace_skill_listings (state);
