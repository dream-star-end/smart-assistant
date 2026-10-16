-- order-dependency: 0307_antigravity_engine
-- 0308 (selfhost) OCV5-424: user-level account affinity for every service pool.
--
-- One row per (service, user): the pool member (subscription account or API key)
-- that user's sessions are bound to. New bindings are spread by load; a binding
-- moves only when its member is persistently unavailable, and the new member
-- becomes the target (docs/ocv5-424-user-affinity.md). No credentials are stored;
-- member_id is the pool member's id in its own table (no FK: members live in
-- several tables, same identifiers as pool_events).
--
-- Additive only: one new table. Rollback: db/rollbacks/0308_pool_user_affinity.sql.
--
-- BEGIN TESTED MANUAL ROLLBACK 0308
-- DROP TABLE IF EXISTS pool_user_affinity;
-- DELETE FROM schema_migrations WHERE version = '0308_pool_user_affinity';
-- END TESTED MANUAL ROLLBACK 0308

CREATE TABLE IF NOT EXISTS pool_user_affinity (
  service                  TEXT NOT NULL CHECK (char_length(service) BETWEEN 1 AND 64),
  user_id                  BIGINT NOT NULL,
  member_kind              TEXT NOT NULL CHECK (member_kind IN ('account', 'relay_key', 'api_key', 'box_profile')),
  member_id                TEXT NOT NULL CHECK (char_length(member_id) BETWEEN 1 AND 128),
  bound_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at               TIMESTAMPTZ NOT NULL,
  prev_member_id           TEXT,
  migrated_at              TIMESTAMPTZ,
  migrate_reason           TEXT,
  migrations_recent        SMALLINT NOT NULL DEFAULT 0 CHECK (migrations_recent >= 0),
  migrations_window_start  TIMESTAMPTZ,
  PRIMARY KEY (service, user_id)
);
-- Load counting: active bindings per member.
CREATE INDEX IF NOT EXISTS pool_user_affinity_member_idx
  ON pool_user_affinity (service, member_kind, member_id, expires_at);

COMMENT ON TABLE pool_user_affinity IS
  'OCV5-424 user-level affinity: (service, user) -> pool member. Moves only when the member is persistently unavailable; expires after 7 days without use.';
