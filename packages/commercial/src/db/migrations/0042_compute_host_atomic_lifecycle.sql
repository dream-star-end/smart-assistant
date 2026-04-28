-- 0042 — compute host 原子化生命周期重构
--
-- 背景:
--   1. test3 容器创建失败根因:host=ready 但 image 未推送过去 → 调度命中
--      → docker run image_missing → "vanished"。"ready" 只代表 daemon 心跳过,
--      不代表 image 就位、出口可达、反向通道(uplink)就位。
--   2. 相关失败步骤散落各处(bootstrap egress probe 不阻塞 ready / image_pull
--      仅在新建瞬刻发生 / distribute 失败仅 log / image-tag 漂移无对账)。
--   3. ready 字段实际语义被多处覆盖,缺乏集中真理源。
--
-- 目标:
--   - 把 ready 改为"完整可调度"的唯一标识,任意维度不就位即非 ready。
--   - quarantine 引入语义化 reason 分类(soft = 自愈待重测;hard = 必须人工
--     或自动分发动作恢复)。
--   - master 集中维护一个 compute_pool_state 单例,记录"当前期望的 runtime
--     image config ID + tag",所有 host 与之对账。
--   - 所有状态切换附 audit row,可追溯。
--
-- 不做:
--   - 不动 last_health_ok 字段语义(仍按旧 ready/quarantined 自愈逻辑写),
--     新增 last_health_endpoint_ok 跟踪"上次 GET /health 200"。两者并存,
--     placement gate 用新字段;rollback 路径仍可读 last_health_ok。
--   - 不改 status enum 文本('bootstrapping','ready','quarantined','draining','broken'),
--     reason 单独字段。

BEGIN;

-- ─── compute_hosts 增列 ────────────────────────────────────────────────

-- runtime image 真实就位标识。bootstrap.image_pull / image distribute 成功后
-- 写;markBootstrapResult / quarantine 不动它。表达"该 host 上次 docker pull/load
-- 完整结束后看到的 image config ID(sha256:....)"。
-- 与 compute_pool_state.desired_image_id 对账。
ALTER TABLE compute_hosts ADD COLUMN loaded_image_id TEXT NULL;
ALTER TABLE compute_hosts ADD COLUMN loaded_image_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN compute_hosts.loaded_image_id IS
  '0042: 该 host 上 OC 运行时镜像的 docker config ID(sha256:...形式)。'
  '由 image_pull / distribute 成功后写,与 compute_pool_state.desired_image_id 对账。'
  'NULL = 从未推送/拉取过完整 image,host 不可调度。';

COMMENT ON COLUMN compute_hosts.loaded_image_at IS
  '0042: loaded_image_id 上次写入时间(UTC)。';

-- 隔离原因细分 — 按 plan v4 reason taxonomy。
-- soft codes (host 内部状态可自愈,等下一轮 probe 恢复):
--   egress-probe-failed       — :9444 mTLS forward proxy 回环 probe 失败
--   health-poll-fail          — master → host:9443 GET /health 连续失败
--   uplink-probe-failed       — host → master:18443 反向通道 probe 失败(新)
-- hard codes (必须分发或运维介入):
--   image-mismatch            — host loaded_image_id ≠ desired_image_id 且 promote 后仍未对齐
--   image-distribute-failed   — 主动 distribute 流式失败
--   runtime-image-missing     — 调度时 docker run 抛 ImageNotFound
ALTER TABLE compute_hosts ADD COLUMN quarantine_reason_code TEXT NULL;
ALTER TABLE compute_hosts ADD COLUMN quarantine_reason_detail TEXT NULL;
ALTER TABLE compute_hosts ADD COLUMN quarantine_at TIMESTAMPTZ NULL;

ALTER TABLE compute_hosts ADD CONSTRAINT compute_hosts_quarantine_reason_check
  CHECK (
    quarantine_reason_code IS NULL OR quarantine_reason_code IN (
      'egress-probe-failed',
      'health-poll-fail',
      'uplink-probe-failed',
      'image-mismatch',
      'image-distribute-failed',
      'runtime-image-missing'
    )
  );

COMMENT ON COLUMN compute_hosts.quarantine_reason_code IS
  '0042: 当前 quarantine 原因(NULL = 非隔离 / 历史记录已清)。'
  'soft 类(egress-probe-failed/health-poll-fail/uplink-probe-failed)由 health 通过自愈;'
  'hard 类(image-*)需要 imagePromote / 运维 distribute / clearQuarantine 介入。';

COMMENT ON COLUMN compute_hosts.quarantine_reason_detail IS
  '0042: 自由文本细节,辅助诊断(例如 "config ID mismatch: a≠b" / "EPIPE on stream")。';

COMMENT ON COLUMN compute_hosts.quarantine_at IS
  '0042: 上次进入 quarantine 的时间(UTC),clearQuarantine 时不清。';

-- 各维度 last-* 字段 — placement gate 严格要求所有维度同时 OK 且 fresh。
ALTER TABLE compute_hosts ADD COLUMN last_health_endpoint_ok BOOLEAN NULL;
ALTER TABLE compute_hosts ADD COLUMN last_health_poll_at TIMESTAMPTZ NULL;
ALTER TABLE compute_hosts ADD COLUMN last_uplink_ok BOOLEAN NULL;
ALTER TABLE compute_hosts ADD COLUMN last_uplink_at TIMESTAMPTZ NULL;
ALTER TABLE compute_hosts ADD COLUMN last_egress_probe_ok BOOLEAN NULL;
ALTER TABLE compute_hosts ADD COLUMN last_egress_probe_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN compute_hosts.last_health_endpoint_ok IS
  '0042: 上次 master → host:9443 GET /health 是否 200(布尔)。'
  'placement gate 必读字段。与历史 last_health_ok 并存,后者保留兼容。';

COMMENT ON COLUMN compute_hosts.last_health_poll_at IS
  '0042: 上次 health poll 完成时间(成功/失败都写,用于 staleness 判定)。';

COMMENT ON COLUMN compute_hosts.last_uplink_ok IS
  '0042: 上次 host → master:18443 反向通道 probe 是否成功。'
  'node-agent /health 内含字段反映,master 拉到后写到 master 侧。';

COMMENT ON COLUMN compute_hosts.last_uplink_at IS
  '0042: last_uplink_ok 写入时间(UTC,成功/失败都写)。';

COMMENT ON COLUMN compute_hosts.last_egress_probe_ok IS
  '0042: 上次 host 内 :9444 mTLS forward proxy 探活是否通过。';

COMMENT ON COLUMN compute_hosts.last_egress_probe_at IS
  '0042: last_egress_probe_ok 写入时间(UTC)。';

-- ─── compute_pool_state 单例表 ─────────────────────────────────────────

-- 集中管理整个 master 的"期望状态",当前只放 image 相关。
-- 用 CHECK 锁定 singleton row,避免业务上多写。
CREATE TABLE compute_pool_state (
  singleton TEXT PRIMARY KEY DEFAULT 'singleton' CHECK (singleton = 'singleton'),
  desired_image_id  TEXT NULL,
  desired_image_tag TEXT NULL,
  master_epoch BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE compute_pool_state IS
  '0042: master 全局期望状态单例。任何时刻只有一行,key=singleton。'
  'desired_image_id/tag 由 master 本机 docker image inspect OC_RUNTIME_IMAGE 写入,'
  '所有 host 与此对账,不一致 → imagePromote 拉,持续不一致 → quarantine。';

INSERT INTO compute_pool_state (singleton, master_epoch)
VALUES ('singleton', 0)
ON CONFLICT (singleton) DO NOTHING;

-- ─── compute_host_audit ────────────────────────────────────────────────

CREATE TABLE compute_host_audit (
  id BIGSERIAL PRIMARY KEY,
  host_id UUID NULL REFERENCES compute_hosts(id) ON DELETE SET NULL,
  operation TEXT NOT NULL,
  operation_id TEXT NULL,
  reason_code TEXT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE compute_host_audit IS
  '0042: compute host lifecycle 审计流水。每次状态切换 / image 操作 / probe 失败都追加。'
  'host_id ON DELETE SET NULL — host 被删后审计行保留(便于历史追查)。'
  'operation_id 用于把"一次 distribute"或"一次 promote"产生的多条记录串起来。';

CREATE INDEX idx_compute_host_audit_host_ts
  ON compute_host_audit (host_id, ts DESC);

CREATE INDEX idx_compute_host_audit_operation_id
  ON compute_host_audit (operation_id)
  WHERE operation_id IS NOT NULL;

CREATE INDEX idx_compute_host_audit_ts
  ON compute_host_audit (ts DESC);

-- ─── 索引补强 ──────────────────────────────────────────────────────────

-- placement gate 查询会按 status + 多 last_* 字段过滤,status 已有 idx_compute_hosts_status,
-- 不另加 multi-col 索引(<10 host 规模顺序扫即可)。

COMMIT;
