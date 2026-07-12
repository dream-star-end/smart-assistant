-- 0135: 同机双 master 蓝绿交接 + cohort 分批切流的部署状态机(P3/RFC-v5-dual-master-cohort)
-- 纯建表 + seed,backward-compatible:旧 release 不读这些表,可提前 apply(基建版先行)。
--
-- 【基建版零行为变化的关键】seed 一行即"现状":phase=stable / active_slot='A' /
-- desired_leader_slot='A' / desired_control_slot='A' / percent=0。现有 v5 unit 就是 A slot,
-- env leader=1 → 资格(env)∧ desired_leader_slot=='A'==本 slot 满足 → 启动后数秒内竞得 lease
-- 并 start LeaderBundle;desired_control_slot=='A' → bind VIP 18894。与今日单实例行为等价。
--
-- 并发权威=lock_version(一切转移 CAS WHERE lock_version=$n)+generation(cookie/salt 编码);
-- updated_at 仅展示用(R2 MINOR)。CHECK 只锁枚举/范围,不锁 phase↔candidate 一致性——
-- 恢复矩阵(§8)存在合法的 transient 组合(finalizing/aborting 各 step),过约束会挡住幂等续作。

-- ── 部署状态机主表(singleton;四个角色面全部由它派生)──────────────────────────
CREATE TABLE IF NOT EXISTS deploy_state (
  singleton            BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  generation           BIGINT NOT NULL CHECK (generation >= 1),
  phase                TEXT   NOT NULL CHECK (phase IN ('stable','canary','finalizing','aborting')),
  active_slot          TEXT   NOT NULL CHECK (active_slot IN ('A','B')),
  candidate_slot       TEXT            CHECK (candidate_slot IS NULL OR candidate_slot IN ('A','B')),
  active_release       TEXT,
  candidate_release    TEXT,
  -- BLOCKER 4:rollback 权威目标(state 权威;每次 activate/rollback 提交时 previous←旧 active_release)。
  -- 蓝绿 slot 翻转后(A→B finalize)传统 rollback 靠此定位上一 active release,不再依赖 A-slot 专属
  -- .prev-release 文件(该文件降级为 A-slot 传统 lane 的兼容兜底)。0135 尚未生产 apply → 直接加列。
  previous_active_release TEXT,
  -- leader lease 竞争资格(唯一授权 slot)/ VIP 控制口 18894 bind 资格(唯一授权 slot)
  desired_leader_slot  TEXT   NOT NULL CHECK (desired_leader_slot IN ('A','B')),
  desired_control_slot TEXT   NOT NULL CHECK (desired_control_slot IN ('A','B')),
  cohort_percent       SMALLINT NOT NULL DEFAULT 0 CHECK (cohort_percent BETWEEN 0 AND 100),
  cohort_salt          TEXT   NOT NULL DEFAULT '',   -- per-rollout 固定;新 rollout 才换(R1 m1)
  cohort_allowlist     BIGINT[] NOT NULL DEFAULT '{}',
  lock_version         BIGINT NOT NULL DEFAULT 1 CHECK (lock_version >= 1),
  transition_step      SMALLINT NOT NULL DEFAULT 0,  -- 当前 phase 内已完成的最后一步(每个外部效果后 CAS 推进)
  operation_id         TEXT,                         -- 本次操作唯一 id(journal 关联;无操作时 NULL)
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- seed 即现状(基建版零行为变化)。ON CONFLICT DO NOTHING 保证迁移幂等 + 不覆盖已有运行态。
-- active_release=NULL(不是占位 'bootstrap'):迁移只建表,尚不知真实 rel-* 目录名;基建版跑一次
-- 传统 deploy(activate_release 成功后)会把 deploy_state.active_release 校准成真实 release 路径。
-- canary 起手断言 active_release 非 NULL 且目录存在——防"迁移刚 apply、从未传统 deploy、active_release
-- 是假占位"时误起 canary(candidate 的 capability preflight 会拿假 active release 做兼容比较,BLOCKER 6)。
INSERT INTO deploy_state (
  singleton, generation, phase, active_slot, candidate_slot,
  active_release, candidate_release, previous_active_release, desired_leader_slot, desired_control_slot,
  cohort_percent, cohort_salt, cohort_allowlist, lock_version, transition_step, operation_id
) VALUES (
  true, 1, 'stable', 'A', NULL,
  NULL, NULL, NULL, 'A', 'A',
  0, '', '{}', 1, 0, NULL
)
ON CONFLICT (singleton) DO NOTHING;

-- ── 转移 journal(审计 + 崩溃诊断:每步外部效果落一行)──────────────────────────
CREATE TABLE IF NOT EXISTS deploy_state_journal (
  id           BIGSERIAL PRIMARY KEY,
  operation_id TEXT   NOT NULL,
  step         SMALLINT NOT NULL,
  action       TEXT   NOT NULL,
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deploy_journal_op ON deploy_state_journal(operation_id, id);

-- ── leader lease 状态行(epoch 化,消 ABA/陈旧 ACK;RFC D4 R3/R4)────────────────
-- 协议见 deploy/leaderLease.ts。holder_pid_start_ticks=/proc/<pid>/stat 第 22 字段(starttime),
-- 防同 boot 内 PID 复用误判存活。seed:epoch=0 + 无 holder(instance_id NULL)→ 首个竞得者
-- 视 predecessor 已死(IS NULL),直接安装 epoch=1(install CAS 用 IS NOT DISTINCT FROM 处理 NULL)。
CREATE TABLE IF NOT EXISTS leader_lease (
  singleton              BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  lease_epoch            BIGINT NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  holder_slot            TEXT            CHECK (holder_slot IS NULL OR holder_slot IN ('A','B')),
  holder_instance_id     UUID,
  holder_pid             INTEGER,
  holder_pid_start_ticks BIGINT,
  fence_requested_epoch  BIGINT,
  fenced_ack_epoch       BIGINT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO leader_lease (singleton, lease_epoch)
  VALUES (true, 0)
ON CONFLICT (singleton) DO NOTHING;

-- ── OAuth pending state(P3 D7;跨 slot callback 天然成立)——表给 Agent B 用,本批只建表 ──
-- state_hash 存 hash(不存可直接使用的 bearer);消费 = DELETE ... WHERE state_hash=$1 AND
-- expires_at>now() RETURNING payload(原子单次);payload 含 verifier 等敏感字段应加密。
CREATE TABLE IF NOT EXISTS oauth_pending_states (
  state_hash TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
-- GC / 过期清理索引(consume 谓词与 sweeper 均按 expires_at 过滤)
CREATE INDEX IF NOT EXISTS idx_oauth_pending_expires ON oauth_pending_states(expires_at);
