-- 0040 users.pinned_host_uuid — admin-set host pin for QA/testing.
--
-- 当 set 且 host 状态为 ready、未满容量、不在进程内 cooldown 时,scheduler
-- 把该用户所有新容器固定落到这台 host。NULL = 默认 sticky+least-loaded 调度,
-- 即原有行为不变。
--
-- 设计:
--   - additive only;无 default(NULL),对存量 user 透明
--   - FK ON DELETE SET NULL:host 删除后用户自动退回默认调度
--   - partial index:供 admin "按 host 反查 pinned users" 维护查询使用,
--     scheduler 自身按 user.id 主键查不会走它
--
-- 参见 nodeScheduler.pickHost (compute-pool/nodeScheduler.ts)。

ALTER TABLE users
  ADD COLUMN pinned_host_uuid UUID
    REFERENCES compute_hosts(id)
    ON DELETE SET NULL;

CREATE INDEX idx_users_pinned_host_uuid
  ON users(pinned_host_uuid)
  WHERE pinned_host_uuid IS NOT NULL;

COMMENT ON COLUMN users.pinned_host_uuid IS
  'Admin-set host pin for QA/testing. When set and host is ready+not full+not in cooldown, scheduler places all new containers on this host. NULL = default sticky+least-loaded scheduling.';
