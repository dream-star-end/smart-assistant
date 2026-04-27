/**
 * Compute pool 共享类型。
 *
 * DB 行 ↔ 业务视图 ↔ 外发视图 mapping 集中在此。
 *
 *   ComputeHostRow       — pg snake_case,与 migration 0030 对齐
 *   ComputeHost          — camelCase 业务视图(无密码/psk/cert 私钥)
 *   ComputeHostAdminView — admin UI 返回视图(含统计但依然无密钥)
 *   DecryptedHostCreds   — 运行时解密后的凭据,绝不序列化
 */

export type ComputeHostStatus =
  | "bootstrapping"
  | "ready"
  | "quarantined"
  | "draining"
  | "broken";

export interface ComputeHostRow {
  id: string;
  name: string;
  host: string;
  ssh_port: number;
  ssh_user: string;
  agent_port: number;
  ssh_password_nonce: Buffer;
  ssh_password_ct: Buffer;
  ssh_fingerprint: string | null;
  agent_psk_nonce: Buffer;
  agent_psk_ct: Buffer;
  agent_cert_pem: string | null;
  agent_cert_fingerprint_sha256: string | null;
  agent_cert_not_before: Date | null;
  agent_cert_not_after: Date | null;
  status: ComputeHostStatus;
  last_bootstrap_at: Date | null;
  last_bootstrap_err: string | null;
  last_health_at: Date | null;
  last_health_ok: boolean | null;
  last_health_err: string | null;
  consecutive_health_fail: number;
  consecutive_health_ok: number;
  max_containers: number;
  /**
   * master 侧记录的 bridge 子网(例如 "172.30.2.0/24")。
   * 由 admin createHost 写入、nodeScheduler.pickBoundIp 优先读取。
   * 旧行可能为 null(迁移 0032 之前建的):scheduler 会 fallback 到公式。
   */
  bridge_cidr: string | null;
  /**
   * 0038:节点 :9444 mTLS forward proxy 探活成功后写入的 marker URI
   * (格式 `mtls://<host>:9444`)。NULL = 未探活通过 → 不参与 OAuth 账号 egress 自动分配。
   * 实际端口由 master 端 EgressTarget 构造,这里仅作存在性 + host 来源记录。
   */
  egress_proxy_endpoint: string | null;
  /**
   * 0041:VPS 租期到期时间(TIMESTAMPTZ,UTC 入库)。
   * NULL = self 或未填(永久/自有)。仅展示用,不参与调度,不触发自动化。
   */
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ComputeHost {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  agentPort: number;
  sshFingerprint: string | null;
  hasCert: boolean;
  certFingerprint: string | null;
  certNotBefore: string | null;
  certNotAfter: string | null;
  status: ComputeHostStatus;
  lastBootstrapAt: string | null;
  lastBootstrapErr: string | null;
  lastHealthAt: string | null;
  lastHealthOk: boolean | null;
  lastHealthErr: string | null;
  consecutiveHealthFail: number;
  consecutiveHealthOk: number;
  maxContainers: number;
  /** 0041:VPS 租期到期 ISO8601(UTC,toISOString())。NULL = 永久/未填。 */
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** admin 列表/详情视图,追加即时容器计数。 */
export interface ComputeHostAdminView extends ComputeHost {
  activeContainers: number;
}

/**
 * 运行时解密凭据 —— 只在 master 进程内存中,不序列化。
 * Buffer 成员在用完后调用方 .fill(0) 清零(由 crypto 层规范)。
 */
export interface DecryptedHostCreds {
  hostId: string;
  sshPassword: Buffer | null; // self host: null
  agentPsk: Buffer | null; // self host: null(启动懒生成)
}

/** SSH bootstrap 指令结果(Plan v2 §D 流程) */
export type BootstrapResult =
  | { kind: "ok"; fingerprint: string; certNotAfter: Date; psk: boolean }
  | { kind: "fail"; step: BootstrapStep; message: string };

export type BootstrapStep =
  | "ssh_connect"
  | "os_precheck"
  | "install_packages"
  | "docker_network"
  | "data_dir"
  | "local_keygen"
  | "sign_cert"
  | "deliver_psk"
  | "deliver_binary"
  | "systemd_start"
  | "agent_verify"
  | "firewall_apply"
  | "baseline_first_pull"
  | "image_pull"
  | "egress_endpoint_probe"
  | "final_verify";

/** node-agent /health 响应 — 与 Go daemon 定义保持一致。 */
export interface AgentHealthResponse {
  ok: boolean;
  cpuPercent: number;
  memPercent: number;
  diskFreeBytes: number;
  containerCount: number;
  dockerOk: boolean;
  agentVersion: string;
  uptimeSeconds: number;
}

/** agent /containers/run request (master → node-agent) */
export interface AgentRunContainerRequest {
  /** master 预分配的 agent_containers.id,用于 label 和 identity lookup。 */
  containerDbId: number;
  /** master 预分配的 bound_ip(例如 172.30.x.y) */
  boundIp: string;
  /** 容器镜像,带 tag */
  image: string;
  /** docker name(master 规划,agent 原样传) */
  name: string;
  /** 容器环境变量(master 全量构造,包含 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL 等) */
  env: Record<string, string>;
  /** labels — 必须包含 openclaude-v3=1 和 containerDbId */
  labels: Record<string, string>;
  /** bind mounts(baseline dir 等;master 下发绝对路径) */
  binds: Array<{ source: string; target: string; readonly: boolean }>;
  /** resource cap */
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  /** 容器内 HTTP/WS 端口,node-agent 记本地映射 */
  internalPort: number;
  /** cmd 覆盖(可选) */
  cmd?: string[];
}

export interface AgentRunContainerResponse {
  /** docker container id(full 64 hex) */
  containerInternalId: string;
}

/** /containers/:id/inspect 响应(简化,只回 master 关心的) */
export interface AgentContainerInspect {
  id: string;
  state: "created" | "running" | "exited" | "dead" | "paused" | "restarting" | "removing";
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  oomKilled: boolean;
  boundIp: string;
}

export const COMPUTE_POOL_ERR = {
  POOL_UNAVAILABLE: "NODE_POOL_UNAVAILABLE",
  POOL_BUSY: "NODE_POOL_BUSY",
  AGENT_UNREACHABLE: "AGENT_UNREACHABLE",
  AGENT_AUTH: "AGENT_AUTH_FAILED",
  BOOTSTRAP_FAILED: "BOOTSTRAP_FAILED",
  HOST_NOT_FOUND: "HOST_NOT_FOUND",
  HOST_CONFLICT: "HOST_NAME_CONFLICT",
  CERT_VERIFY: "CERT_VERIFY_FAILED",
} as const;

export type ComputePoolErrCode =
  (typeof COMPUTE_POOL_ERR)[keyof typeof COMPUTE_POOL_ERR];

export class NodePoolUnavailableError extends Error {
  readonly code = COMPUTE_POOL_ERR.POOL_UNAVAILABLE;
  constructor(message = "no ready host available") {
    super(message);
    this.name = "NodePoolUnavailableError";
  }
}

export class NodePoolBusyError extends Error {
  readonly code = COMPUTE_POOL_ERR.POOL_BUSY;
  constructor(message = "all ready hosts at capacity") {
    super(message);
    this.name = "NodePoolBusyError";
  }
}

export class AgentUnreachableError extends Error {
  readonly code = COMPUTE_POOL_ERR.AGENT_UNREACHABLE;
  constructor(
    readonly hostId: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentUnreachableError";
  }
}

export class CertVerifyError extends Error {
  readonly code = COMPUTE_POOL_ERR.CERT_VERIFY;
  constructor(message: string) {
    super(message);
    this.name = "CertVerifyError";
  }
}

/**
 * mapRowToHost — DB 行 → 业务视图。**不返密码/psk/cert 私钥**。
 */
export function mapRowToHost(row: ComputeHostRow): ComputeHost {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    sshPort: row.ssh_port,
    sshUser: row.ssh_user,
    agentPort: row.agent_port,
    sshFingerprint: row.ssh_fingerprint,
    hasCert: row.agent_cert_pem !== null && row.agent_cert_pem.length > 0,
    certFingerprint: row.agent_cert_fingerprint_sha256,
    certNotBefore: row.agent_cert_not_before?.toISOString() ?? null,
    certNotAfter: row.agent_cert_not_after?.toISOString() ?? null,
    status: row.status,
    lastBootstrapAt: row.last_bootstrap_at?.toISOString() ?? null,
    lastBootstrapErr: row.last_bootstrap_err,
    lastHealthAt: row.last_health_at?.toISOString() ?? null,
    lastHealthOk: row.last_health_ok,
    lastHealthErr: row.last_health_err,
    consecutiveHealthFail: row.consecutive_health_fail,
    consecutiveHealthOk: row.consecutive_health_ok,
    maxContainers: row.max_containers,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** 判定一个 host 是否可参与新容器调度 */
export function isSchedulable(status: ComputeHostStatus): boolean {
  return status === "ready";
}
