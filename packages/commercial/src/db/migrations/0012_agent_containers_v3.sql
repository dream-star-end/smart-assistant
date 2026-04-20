-- 0012 agent_containers v3 改造
--
-- 见 docs/v3/02-DEVELOPMENT-PLAN.md §3.2 容器身份 / §6 schema / 03-MVP-CHECKLIST.md Task 2B
--
-- 背景:
--   v2 agent_containers (0005) 是为 v2 "claude code agent" 设计的:每用户一个长生命周期
--   订阅容器,固定 docker_id/docker_name/workspace_volume/home_volume + status 5 态机。
--   v3 把它改造成"用户 chat 会话的运行时容器":
--     - 双因子身份 (bound_ip + secret_hash) — §3.2 R2 关键修订
--     - state 机器(MVP 只用 'active'/'vanished';warm/draining/pending_apply 推迟到 P1)
--     - subscription_id 改 NULLABLE — v3 ephemeral 容器不绑订阅(MVP 全用户按量计费)
--     - host_id NULLABLE — MVP 单 host,留字段为 P1 多 host 准备
--     - container_internal_id — docker container ID(替代 docker_id 字段语义,但保留 docker_id
--       v2 字段不删,避免破坏现有 admin 查询)
--
-- 为什么不直接 DROP TABLE 重建:
--   现有 v2 数据(若有)需要迁移过来(Phase 5C 数据迁移会处理),保留表 + ALTER COLUMN
--   是最小破坏路径。MVP 阶段 admin 后台还能查老 schema。
--
-- MVP 单轨 ephemeral:
--   不加 mode 字段(02-DEVELOPMENT-PLAN.md §13 双模式推迟到 P1);所有 v3 容器都是
--   ephemeral 按量计费,idle 30min 自动 stop+remove。
--
-- 索引取舍:
--   - bound_ip 唯一索引:docker bridge IP 在容器生命周期内全局唯一,身份验证因子 A 反查
--   - state 部分索引:tickIdleSweep / orphan reconcile 高频按 state 扫描
--   - host_id 索引:P1 multi-host 时按 host 聚合;MVP 单值无所谓但留着不浪费

ALTER TABLE agent_containers
  ADD COLUMN bound_ip              INET,
  ADD COLUMN secret_hash           TEXT,
  ADD COLUMN state                 TEXT NOT NULL DEFAULT 'active'
                                   CHECK (state IN ('active', 'vanished')),
  ADD COLUMN host_id               BIGINT,
  ADD COLUMN container_internal_id TEXT,
  ADD COLUMN port                  INTEGER,
  ADD COLUMN last_ws_activity      TIMESTAMPTZ;

-- subscription_id 改 NULLABLE(v3 ephemeral 容器不绑 v2 订阅)
ALTER TABLE agent_containers
  ALTER COLUMN subscription_id DROP NOT NULL;

-- bound_ip 在 'active' 状态下必须唯一(同 host 网段内不重叠)
CREATE UNIQUE INDEX uniq_ac_bound_ip_active
  ON agent_containers(bound_ip)
  WHERE state = 'active' AND bound_ip IS NOT NULL;

-- state 部分索引:tickIdleSweep 扫 active + last_ws_activity < cutoff
CREATE INDEX idx_ac_state_activity
  ON agent_containers(state, last_ws_activity)
  WHERE state = 'active';

-- host_id 聚合(P1 multi-host 用,MVP 单 host 索引几乎无用但留着不贵)
CREATE INDEX idx_ac_host
  ON agent_containers(host_id)
  WHERE state = 'active';

COMMENT ON COLUMN agent_containers.bound_ip IS
  'V3 §3.2: docker bridge IP assigned to container (identity factor A). '
  'Unique within active set; 401 unknown_container_ip_on_host if reverse-lookup misses.';

COMMENT ON COLUMN agent_containers.secret_hash IS
  'V3 §3.2: bcrypt/scrypt hash of the per-container long-lived secret (identity factor B). '
  'Plain secret only ever lives in container env (ANTHROPIC_AUTH_TOKEN=oc-v3.<cid>.<secret>) '
  'and is timing-safe-compared by edge proxy.';

COMMENT ON COLUMN agent_containers.state IS
  'V3 reader visibility set (MVP single-track): '
  'active = supervisor.ensureRunning may return host/port; '
  'vanished = container disappeared (docker inspect failed); cleanup pending. '
  'P1 will add: warm (pre-bind pool), draining (mid-shutdown), pending_apply (post-write ACK barrier).';

COMMENT ON COLUMN agent_containers.subscription_id IS
  'V2 legacy: agent_subscriptions FK. NULLABLE in v3 — ephemeral 按量 containers do not bind subscription. '
  'P1 persistent subscription rows will fill this back.';

COMMENT ON COLUMN agent_containers.host_id IS
  'V3 §14.2: compute_hosts FK (added in 0017). NULLABLE in MVP single-host (filled with main host id). '
  'Used by pickHost in P1 multi-host.';

COMMENT ON COLUMN agent_containers.container_internal_id IS
  'V3: docker container ID (full hex). Distinct from legacy docker_id which v2 used; '
  'MVP supervisor.provisionContainer fills both during transition, P1 will deprecate docker_id.';

COMMENT ON COLUMN agent_containers.port IS
  'V3: container internal WS port (3000 by default). Captured at provision time so ws bridge can dial directly.';

COMMENT ON COLUMN agent_containers.last_ws_activity IS
  'V3: timestamp of last ws frame seen on user↔container bridge. '
  'tickIdleSweep stops+removes containers idle > 30min (system_settings.idle_sweep_min).';
