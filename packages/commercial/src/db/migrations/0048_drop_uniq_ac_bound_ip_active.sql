-- 0048 — drop legacy global partial UNIQUE uniq_ac_bound_ip_active
--
-- 背景:
--   0012 建表时加了 partial UNIQUE INDEX uniq_ac_bound_ip_active
--     ON agent_containers (bound_ip) WHERE state='active' AND bound_ip IS NOT NULL
--   是 M1 单 host monolith 期的 IP 仲裁器(全局唯一)。
--
--   0030 multi-host 引入 composite UNIQUE INDEX idx_ac_host_bound_ip_active
--     ON (host_uuid, bound_ip) WHERE state='active' AND bound_ip IS NOT NULL AND host_uuid IS NOT NULL
--   作为新 per-host 仲裁器。0030 注释 §17-24 写明:共存期保留旧索引 + 一周观察后
--   后续 migration drop 旧索引,届时各 host 才允许复用完整网段。
--
--   "drop-old-index" migration 一直未落地,导致 multi-host pool 在两个不同物理
--   host 共用相同 /24 时(各自 docker bridge 物理隔离,DB 上两 host 各自有
--   bound_ip=X.X.X.10 的合法诉求)被全局 unique 拦死,表现为
--   `NameConflict: bound_ip X already taken (scheduler race)` 死循环重连
--   (2026-04-30 test03 现象,fly-01 + oc-compute-tk1 都使用 172.30.2.0/24)。
--
-- 副作用:
--   M1 期间"多 host 必须切分不相交 /24"硬约束被解除。host 之间 bridge_cidr
--   可重叠(物理 docker bridge 在不同 VM 上各自独立,DB 唯一性由 composite
--   按 host 分区仲裁)。
--
-- 兼容性 / 风险控制:
--   - guard #1 校验 composite 仲裁器存在;不存在直接 RAISE,防止 schema drift
--     环境删掉旧索引后丢失 IP 唯一性兜底。
--   - guard #2 校验当前不存在 state='active' AND host_uuid IS NULL 的活跃行;
--     该形态被 composite partial WHERE 排除在仲裁外,旧索引 drop 后会失去保护。
--   - SET LOCAL lock_timeout = '3s' 防止 DDL 拿不到 ACCESS EXCLUSIVE 时无限挂在
--     一个写流量阻塞点上;DDL 失败 deploy 中止,比卡住线上写流量好。
--   - DROP INDEX (普通,非 CONCURRENTLY) — migrate.ts 把每个 .sql 包在 BEGIN/COMMIT,
--     CONCURRENTLY 不能在事务内跑。partial 索引 drop 是元数据操作 + sub-100ms 量级。
--
-- prod hot-fix(2026-04-30 已经手动 DROP):本 migration 用 IF EXISTS 自动幂等,
-- 不会因为索引已不在而报错;schema_migrations 入账后 drift 修复完成。

SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  -- guard #1: composite per-host UNIQUE 必须存在,否则 drop 旧索引会留下"无 IP
  -- 唯一仲裁器"的危险状态。
  IF to_regclass('public.idx_ac_host_bound_ip_active') IS NULL THEN
    RAISE EXCEPTION 'composite UNIQUE idx_ac_host_bound_ip_active is missing; refusing to drop uniq_ac_bound_ip_active without successor index';
  END IF;

  -- guard #2: composite partial WHERE 排除 host_uuid IS NULL,旧索引若仍是
  -- 这类行的唯一仲裁,drop 之后会丢失 host-scoped 之外的兜底。检测期内不允许
  -- 存在此形态行 — 实际生产路径(provisionV3Container)总是写 selfHostId 兜底,
  -- 应当为空。一旦非空,提示运维先迁移 host_uuid 再重试。
  IF EXISTS (
    SELECT 1 FROM agent_containers
    WHERE state = 'active' AND host_uuid IS NULL
  ) THEN
    RAISE EXCEPTION 'agent_containers has active rows with host_uuid IS NULL; backfill host_uuid before dropping uniq_ac_bound_ip_active';
  END IF;
END
$$;

DROP INDEX IF EXISTS uniq_ac_bound_ip_active;
