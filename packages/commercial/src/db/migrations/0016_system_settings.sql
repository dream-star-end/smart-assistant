-- 0017_system_settings.sql
-- 运维侧可调的运行时设置(distinct from user_preferences / model_pricing)。
--
-- 用法:
--   - 每个 key 由 src/admin/systemSettings.ts 里的 ALLOWED_KEYS 白名单 + zod schema 守门
--   - value 用 JSONB 存,给 boolean/number/enum/struct 都 polymorphic
--   - 不预 INSERT 默认行 → handler 在 GET 时 fallback 到 helper.DEFAULTS
--   - 任何 PUT 都同事务写 admin_audit('system_settings.set'),before/after 完整快照

CREATE TABLE system_settings (
  key          TEXT PRIMARY KEY,
  value        JSONB NOT NULL,
  description  TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   BIGINT REFERENCES users(id) ON DELETE SET NULL
);

COMMENT ON TABLE system_settings IS
  'Operational runtime settings tunable by admin without code change. ' ||
  'Distinct from user_preferences (per-user) and model_pricing (model price-list). ' ||
  'Allowed keys + value shapes enforced in src/admin/systemSettings.ts.';
COMMENT ON COLUMN system_settings.value IS
  'JSONB payload; shape validated by zod schema keyed on column key.';
COMMENT ON COLUMN system_settings.updated_by IS
  'Last admin user_id who PUT this row; NULL if migration-seeded or admin deleted.';
