-- order-dependency: 0308_pool_user_affinity
-- 0309 (selfhost) OCV5-424: Box Claude login quota windows for the admin 服务池 tab.
--
-- The Box CLI reports both rate-limit windows on every run (stream-json
-- rate_limit_event → unifiedWindows.five_hour / seven_day: utilization + resetsAt).
-- Until now only the highest utilization was kept (box_claude_profiles.utilization)
-- and no reset time. These columns keep each window and its reset so the admin can
-- see 5-hour / weekly use per login. Read passively from the run's own output: no
-- login or credential file is touched.
--
-- Additive only: four nullable columns. Rollback: db/rollbacks/0309_box_profile_quota_windows.sql.
--
-- BEGIN TESTED MANUAL ROLLBACK 0309
-- ALTER TABLE box_claude_profiles DROP COLUMN IF EXISTS quota_5h, DROP COLUMN IF EXISTS quota_5h_resets_at,
--   DROP COLUMN IF EXISTS quota_7d, DROP COLUMN IF EXISTS quota_7d_resets_at;
-- DELETE FROM schema_migrations WHERE version = '0309_box_profile_quota_windows';
-- END TESTED MANUAL ROLLBACK 0309

ALTER TABLE box_claude_profiles ADD COLUMN IF NOT EXISTS quota_5h REAL CHECK (quota_5h IS NULL OR quota_5h >= 0);
ALTER TABLE box_claude_profiles ADD COLUMN IF NOT EXISTS quota_5h_resets_at TIMESTAMPTZ;
ALTER TABLE box_claude_profiles ADD COLUMN IF NOT EXISTS quota_7d REAL CHECK (quota_7d IS NULL OR quota_7d >= 0);
ALTER TABLE box_claude_profiles ADD COLUMN IF NOT EXISTS quota_7d_resets_at TIMESTAMPTZ;
