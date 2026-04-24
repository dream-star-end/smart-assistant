-- 0030 — compute_hosts 多机容器池
--
-- 见 Plan v2(对话记忆 2026-04-24)/ docs/v3/02-DEVELOPMENT-PLAN.md §14.2 multi-host 骨架
--
-- 目的:
--   M1 从单 host monolith 横向扩展到多 host worker 池。admin 新增"虚机" tab,填
--   SSH 凭据 → 平台自动 bootstrap(SSH 上机装 docker / 建 bridge / 部署 node-agent /
--   签 mTLS cert / 原子切防火墙)→ ready 后自动参与调度。新容器按 least-loaded
--   落到 ready host。
--
-- 0012 已经为 agent_containers.host_id 留了 NULLABLE 字段,本 migration:
--   1. 建 compute_hosts 表(SSH 凭据 AEAD / mTLS cert / psk / status 状态机)
--   2. 插入 name='self' 代表 master 自身的 host row(host=127.0.0.1, status='ready';
--      SSH 凭据留空 — self 不走 bootstrap 路径,psk/cert 由 master 启动时懒生成回写)
--   3. backfill 所有现存 active container 的 host_id = self.id
--   4. 新增 (host_id, bound_ip) WHERE state='active' AND host_id IS NOT NULL
--      的 per-host 唯一索引;**保留**旧的全局 uniq_ac_bound_ip_active(共存期,
--      读路径切换 + 一周观察后 0031 drop 旧索引)
--   5. agent_containers.host_id 维持 NULLABLE(老代码路径仍可写不带 host_id);
--      新代码路径 assert 必填。迁移一周稳定后 0031 再 SET NOT NULL
--
-- Additive 节奏(Plan v2 §C 共识):M1 期间 bound_ip 实际仍全局唯一(旧索引还在)
-- → 多 host 必须切分不相交 /24 子网(self = 172.30.0.0/24, host-B = 172.30.1.0/24,
-- ...)。0031 drop 旧索引后才允许各 host 复用完整网段。
--
-- 状态机:bootstrapping → ready → quarantined(自愈可回 ready)/ broken(人工干预)/
--        draining(不分配新容器,存量走完)
--
-- 凭据:
--   - ssh_password AEAD(AES-256-GCM),AAD = "compute-host-ssh:" || host_id,
--     防跨记录重放(与 user_remote_hosts 同范式,0028 AAD 是 user+host,本表单 host)
--   - agent_psk AEAD,AAD = "compute-host-psk:" || host_id
--   - agent_cert_pem 存公开部分(证书),私钥在 worker 本地 /etc/openclaude/
--     node-agent.key 由 agent 本地 openssl 生成 CSR,master 签后回写 cert_pem;
--     master 不存 worker 私钥
--   - 证书指纹绑定:agent_cert_fingerprint_sha256 作为 mTLS 身份校验因子(SAN URI
--     验完 node_id 后,再校验 leaf 指纹 == 库里当前指纹,防吊销/替换)

CREATE TABLE IF NOT EXISTS compute_hosts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL UNIQUE,

  -- 连接信息(admin 可见)
  host            TEXT NOT NULL,
  ssh_port        INT  NOT NULL DEFAULT 22
                     CHECK (ssh_port BETWEEN 1 AND 65535),
  ssh_user        TEXT NOT NULL,
  agent_port      INT  NOT NULL DEFAULT 9443
                     CHECK (agent_port BETWEEN 1 AND 65535),

  -- SSH 凭据(AEAD — 仅 bootstrap/重装用;AAD 绑 host_id)
  -- self host 以空 bytea 占位(不走 bootstrap 路径)
  ssh_password_nonce BYTEA NOT NULL,
  ssh_password_ct    BYTEA NOT NULL,

  -- SSH host key TOFU(首次 bootstrap 抓写;后续 strict compare)
  ssh_fingerprint    TEXT,

  -- node-agent psk(AEAD — Authorization: Bearer <psk>;AAD 绑 host_id)
  agent_psk_nonce    BYTEA NOT NULL,
  agent_psk_ct       BYTEA NOT NULL,

  -- mTLS:master 签的 leaf cert 公开部分,私钥在 worker 本地
  agent_cert_pem              TEXT,
  agent_cert_fingerprint_sha256 TEXT,   -- hex lowercase,64 chars;mTLS 身份绑定
  agent_cert_not_before        TIMESTAMPTZ,
  agent_cert_not_after         TIMESTAMPTZ,

  -- 状态
  status              TEXT NOT NULL DEFAULT 'bootstrapping'
                       CHECK (status IN ('bootstrapping','ready','quarantined','draining','broken')),
  last_bootstrap_at   TIMESTAMPTZ,
  last_bootstrap_err  TEXT,
  last_health_at      TIMESTAMPTZ,
  last_health_ok      BOOLEAN,
  last_health_err     TEXT,
  consecutive_health_fail    INT NOT NULL DEFAULT 0,
  consecutive_health_ok      INT NOT NULL DEFAULT 0,

  -- 容量
  max_containers      INT NOT NULL DEFAULT 50 CHECK (max_containers > 0),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 双保险:非 self 行必须有真实 AEAD 凭据,不允许空 bytea 占位。
  -- 防止应用层未来某段代码忘了 isSelfPlaceholder 检查直接解密导致 AEAD 崩。
  -- self 行由 migration 初始化时就带空 bytea(不走 SSH bootstrap),唯一豁免。
  CONSTRAINT compute_hosts_aead_nonempty CHECK (
    name = 'self'
    OR (
      octet_length(ssh_password_nonce) > 0
      AND octet_length(ssh_password_ct) > 0
      AND octet_length(agent_psk_nonce) > 0
      AND octet_length(agent_psk_ct) > 0
    )
  )
);

CREATE INDEX idx_compute_hosts_status ON compute_hosts(status);

-- self host — master 自己。不走 SSH bootstrap,psk/cert 由 master 启动时懒生成回写
-- (见 compute-pool/service.ts ensureSelfHost)
INSERT INTO compute_hosts(
  name, host, ssh_port, ssh_user,
  ssh_password_nonce, ssh_password_ct,
  agent_psk_nonce, agent_psk_ct,
  status
)
VALUES (
  'self', '127.0.0.1', 22, 'root',
  ''::bytea, ''::bytea,       -- self 不 SSH bootstrap
  ''::bytea, ''::bytea,       -- psk 启动时懒生成
  'ready'                     -- 直接可调度(master 进程内的 node-agent 会 bind loopback)
)
ON CONFLICT (name) DO NOTHING;

-- agent_containers.host_id 是 BIGINT(0012 加的),但 compute_hosts.id 是 UUID。
-- 为了对齐类型且不影响老代码,保留 0012 的 BIGINT host_id 不动(legacy P1 预留字段),
-- 本次新增独立 host_uuid 列作为新 schema 的 FK。旧 host_id 留着作向后兼容占位,
-- 不再写新值;所有新代码路径读写 host_uuid。
ALTER TABLE agent_containers
  ADD COLUMN host_uuid UUID REFERENCES compute_hosts(id) ON DELETE RESTRICT;

-- backfill 所有 active 行到 self
UPDATE agent_containers
   SET host_uuid = (SELECT id FROM compute_hosts WHERE name='self')
 WHERE host_uuid IS NULL;

-- 新 per-host 唯一索引,与 uniq_ac_bound_ip_active(0012)共存
CREATE UNIQUE INDEX idx_ac_host_bound_ip_active
  ON agent_containers(host_uuid, bound_ip)
  WHERE state='active' AND bound_ip IS NOT NULL AND host_uuid IS NOT NULL;

CREATE INDEX idx_ac_host_uuid_active
  ON agent_containers(host_uuid)
  WHERE state='active' AND host_uuid IS NOT NULL;

COMMENT ON TABLE compute_hosts IS
  'V3 M1 multi-host: platform-owned worker VMs. Admin adds host with SSH creds → '
  'platform auto-bootstraps (docker / bridge / node-agent / mTLS / iptables) → '
  'ready hosts participate in least-loaded container scheduling. '
  '"self" row represents master; its SSH creds are empty (not bootstrapped via SSH), '
  'psk/cert lazily generated by master at startup.';

COMMENT ON COLUMN compute_hosts.agent_cert_fingerprint_sha256 IS
  'V3 M1: sha256 hex of leaf cert DER. mTLS request verifies: (1) chain to master CA, '
  '(2) SAN URI spiffe://openclaude/host/<uuid> resolves host_uuid, '
  '(3) leaf fingerprint == this column. Cert rotation updates this column atomically.';

COMMENT ON COLUMN compute_hosts.consecutive_health_fail IS
  'V3 M1 health state machine: 3 consecutive fails → status quarantined; '
  'consecutive_health_ok 3 → back to ready. Reset on state transition.';

COMMENT ON COLUMN agent_containers.host_uuid IS
  'V3 M1: compute_hosts.id FK. NULLABLE during 0030 rollout (old code paths may write null); '
  '0031 will SET NOT NULL after all read/write paths are host-aware. Scheduler places new '
  'containers based on this; identity verification joins agent_containers on (host_uuid, bound_ip) '
  'instead of global bound_ip (see containerIdentity refactor).';
