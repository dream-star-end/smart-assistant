-- 0071 v3_agent_migrations — R6.11 §14.2.4 / §14.2.6 / §13.3 ledger 表
--
-- supervisor crash 中间态恢复 ledger,**承载 R6.11 三条 invariant 的 schema 基座**:
--   - §13.3 reader 闸门:`ensureRunning` LEFT JOIN agent_migrations,见 open phase 即 503
--     'migration_in_progress'(Phase 2.B 实装)
--   - §14.2.4 writer 时机:`agent_migrations.INSERT phase='planned'` 在 ① pickHost 之后、
--     任何 IO 之前(future write-side patch)
--   - §14.2.6 reconciler 60s sweep:phase NOT IN closed AND updated_at < threshold 触发
--     phase-based recovery(Phase 2.C 实装 planned 路径,其余 phase 留 alert)
--
-- 8 phase 状态机(R6.9 拓扑):
--   planned        — pickHost 后 INSERT;new_cid NULL + paused_at NULL
--   created        — ⑤bis docker create 完成,补 new_container_internal_id
--   detached       — ⑥a 旧 host detach + UPDATE host_id=new commit 之后
--   attached_pre   — ⑥c 新 host attach pre-routing ACK 通过之后
--   attached_route — ⑥e UPDATE state='active' commit 之后(routing ACK 等 ⑥f)
--   started        — ⑦ 新 host docker start 完成
--   committed      — ⑨ 旧容器 force-rm + ledger DELETE 前 marker
--   rolled_back    — 失败回滚终态
--
-- NULLABLE 字段说明(R6.9 INSERT 前移):
--   - new_container_internal_id:planned 阶段尚未 docker create,无 cid;⑤bis 才填
--   - paused_at:planned 阶段尚未 pause;③ pause 同事务才填
--
-- host_id 类型(Codex Phase 2 plan review 修正):0030_compute_hosts.sql:9 给 compute_hosts.id
-- 是 UUID PRIMARY KEY,agent_containers.host_uuid 也是 UUID FK。本表 old_host_id / new_host_id
-- 沿用 dev plan §14.2.4 命名"host_id"但类型 UUID,不引入第三种命名(host_uuid_id)。
-- dev plan 0019 原文说 BIGINT 是 schema 错误;以本 migration 实装为准,02-DEVELOPMENT-PLAN.md:277
-- 有修正注脚。
--
-- 索引设计:
--   - agent_migrations_pending_idx (updated_at) WHERE phase NOT IN closed
--     → §14.2.6 reconciler 60s 周期点查 stale 行(`listStale(threshold)`):
--       `WHERE phase NOT IN closed AND updated_at < cutoff ORDER BY updated_at ASC`
--       已被 partial WHERE 过滤掉 closed 行,所以 leading 列直接是 updated_at,
--       可顺序扫描 + 直接服务 ORDER BY,无需 sort step。
--       (Codex Phase 2.A review SUGGESTION 1:原 (phase, updated_at) 列序对
--       listStale 这种"无 phase= 等值条件 + 按 updated_at range/sort"无法很好利用第二列)
--   - agent_migrations_one_open_by_container_idx UNIQUE (agent_container_id)
--     WHERE phase NOT IN closed
--     → 双 invariant:① §13.3 reader 高频点查(99% 0 行,partial index 保 sub-ms);
--       ② 数据库层强制单 container 最多一条 open migration,防 writer bug 制造多头状态机
--       (Codex plan review 第 2 点)
--
-- 不在本 migration 做:
--   - 接 reader / writer / reconciler — Phase 2.B / 2.C 单独 PR 落
--   - DELETE / archive 策略 — committed 行交 PR Phase 5 audit cleanup 决定
--   - phase 转移 CHECK trigger — 应用层 markPhase 单点写,trigger 增复杂度无明显收益

CREATE TABLE agent_migrations (
  id                          BIGSERIAL PRIMARY KEY,
  agent_container_id          BIGINT      NOT NULL REFERENCES agent_containers(id) ON DELETE CASCADE,

  old_host_id                 UUID        NOT NULL REFERENCES compute_hosts(id),
  old_container_internal_id   TEXT        NOT NULL,

  new_host_id                 UUID        NOT NULL REFERENCES compute_hosts(id),
  new_container_internal_id   TEXT        NULL,

  paused_at                   TIMESTAMPTZ NULL,

  phase                       TEXT        NOT NULL
    CHECK (phase IN ('planned','created','detached','attached_pre','attached_route','started','committed','rolled_back')),

  started_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at                TIMESTAMPTZ NULL
);

-- §14.2.6 reconciler:`listStale(thresholdSec)` 用本索引拿"phase 未结束 + 长时间未推进"行集。
-- 列序仅 (updated_at):partial WHERE 已过滤 closed,reconciler 查询无 phase 等值谓词,
-- 直接走 updated_at range scan + 服务 ORDER BY ASC,无 sort step。
CREATE INDEX agent_migrations_pending_idx
  ON agent_migrations (updated_at)
  WHERE phase NOT IN ('committed','rolled_back');

-- §13.3 reader + DB 层 single-open invariant:UNIQUE partial index 兼任两职
-- (Codex plan review 第 2 点:防 writer bug 制造同 container 多 open migration)
CREATE UNIQUE INDEX agent_migrations_one_open_by_container_idx
  ON agent_migrations (agent_container_id)
  WHERE phase NOT IN ('committed','rolled_back');

COMMENT ON TABLE agent_migrations IS
  'R6.11 §14.2.4 / §14.2.6 / §13.3 persistent-migration ledger; supervisor crash mid-flight 恢复用。'
  ' phase NOT IN (committed,rolled_back) 视为 open,单 container 最多一条(unique partial index)。';

COMMENT ON COLUMN agent_migrations.new_container_internal_id IS
  'NULL until ⑤bis docker create completes (R6.9: INSERT 前移到 ① pickHost 之后,planned 阶段无 cid)';

COMMENT ON COLUMN agent_migrations.paused_at IS
  'NULL until ③ pause 同事务 UPDATE 写入;reconciler 据此判断是否需要 unpause 旧容器';

COMMENT ON COLUMN agent_migrations.phase IS
  '8-state R6.9 拓扑: planned/created/detached/attached_pre/attached_route/started/committed/rolled_back';
