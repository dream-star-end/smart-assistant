/**
 * V3/V5 per-user container supervisor shared constants and public/internal types.
 *
 * Layer: app-container (L4). Zero `process.env`, zero `syncIo`, zero `interface-http` imports.
 */
import type Docker from "dockerode"
import type { Pool } from "pg"
import type { RemoteLaneRuntimePort } from "@openclaude/gateway/cc5-container-runtime"
import { OPENCLAUDE_CONTAINER_GATEWAY_PORT } from "@openclaude/protocol"
import type { RuntimeInspection } from "../../compute-pool/dockerInspection.js"
import type { ContainerService } from "../../compute-pool/containerService.js"
import type { ComputeHostRow } from "../../compute-pool/types.js"
import { rootLogger } from "../../logging/logger.js"
import type { RuntimeChannel } from "../../runtimeChannel.js"
import type { SyntheticEvalOverlayRuntime } from "../syntheticEvalOverlayRuntime.js"
import type { V3RuntimeTuple } from "../v3RuntimeTupleTypes.js"

export const supervisorLog = rootLogger.child({ subsys: "v3-supervisor" })

/** docker bridge 网络名 — setup-host-net.sh 创建,本模块只引用 */
export const V3_NETWORK_NAME = "openclaude-v3-net";

/** docker bridge 子网 / 网关 — self host 一侧,与 setup-host-net.sh 严格一致。 */
export const V3_SUBNET_CIDR = "172.30.0.0/16";
export const V3_GATEWAY_IP = "172.30.0.1";
export const V3_INTERNAL_PROXY_URL = "http://172.30.0.1:18791";

/** 容器内 OpenClaude gateway 监听端口(默认 18789) */
export const V3_CONTAINER_PORT = OPENCLAUDE_CONTAINER_GATEWAY_PORT;

/** active + container_internal_id IS NULL 的 grace 窗口(ms)—— young/old 二分唯一权威 */
export const PROVISION_INFLIGHT_GRACE_MS = 15_000;

/** CLAUDE_CONFIG_DIR tmpfs 挂载点(防 settings.json 残留) */
export const V3_CONFIG_TMPFS_PATH = "/run/oc/claude-config";

/** 容器内 CCB session JSONL 文件的持久化挂载点 */
export const V3_PROJECTS_MOUNT = "/run/oc/claude-config/projects";

/** 容器内单个 named volume 的挂载点(对应个人版 ~/.openclaude) */
export const V3_VOLUME_MOUNT = "/home/agent/.openclaude";

/** 容器内 codex CLI HOME 持久化挂载点(D2 方案) */
export const V3_CODEX_HOME_MOUNT = "/home/agent/.codex";

/** 容器内 ~/.local 持久化挂载点(pip --user / npm prefix / pipx / uv tool) */
export const V3_USER_LOCAL_MOUNT = "/home/agent/.local";

/** 容器内 ~/.config 持久化挂载点(XDG configs) */
export const V3_USER_CONFIG_MOUNT = "/home/agent/.config";

/** 容器内 entrypoint 跑的非 root 用户(uid:gid),与 Dockerfile USER 一致 */
export const V3_AGENT_USER = "1000:1000";

/** Codex CLI 容器侧只读 auth 源挂载点 */
export const V3_CODEX_AUTH_RO_MOUNT = "/run/oc/codex-auth";

/** Owner-scoped Cursor API key directory. Never expose it through Docker Env. */
export const V5_CURSOR_AUTH_RO_MOUNT = "/run/oc/cursor-auth";

/** Loopback base for the container-local gateway relay. */
export const V3_CODEX_LOCAL_RELAY_ORIGIN = `http://127.0.0.1:${V3_CONTAINER_PORT}`;

/** Master→container passthrough of numeric gateway knobs and feature flags. */
export const DELEGATE_KNOB_CONTAINER_ENV_KEYS = [
  "OPENCLAUDE_DELEGATE_MAX_CONCURRENT", "OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS",
  "OPENCLAUDE_DELEGATE_MAX_PER_PARENT", "OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN",
  "OPENCLAUDE_HIDDEN_DELEGATIONS_PER_TURN", "OPENCLAUDE_DELEGATE_QUEUE_WAIT_MS",
  "OC_DELEGATE_SM", "OC_DELEGATE_DURABLE", "OC_DELEGATE_NOTIFIER", "OC_DELEGATE_CUTOVER",
  "OC_DELEGATE_INFLIGHT_SURFACE", "OC_DELEGATE_INLINE_PUSH_CCB", "OC_DELEGATE_INLINE_PUSH_CODEX",
  "OC_DELEGATE_CURSOR_MCP_WAIT", "OC_CURSOR_SAND_OFFICIAL_CC", "OC_CURSOR_SAND_BOX_CC",
  "OC_BOX_INTERACTIVE_MASTER", "OC_CCB_OFFICIAL_CC",
] as const;

/** 宿主侧远程执行 mux 目录 per-user 分片根与容器挂载点 */
export const V3_SSH_RUN_ROOT_HOST = "/run/ccb-ssh";
export const V3_SSH_RUN_CONTAINER_MOUNT = "/run/ccb-ssh";

/** CCB 平台基线目录的默认宿主路径 */
export const DEFAULT_V3_CCB_BASELINE_DIR =
  "/opt/openclaude/openclaude/packages/commercial/agent-sandbox/ccb-baseline";

/** baseline 内部结构 —— 用 POSIX 绝对路径拼 docker Bind */
export const V3_CCB_BASELINE_AGENTS_MD_REL = "AGENTS.md";
export const V3_CCB_BASELINE_CLAUDE_MD_REL = "CLAUDE.md";
export const V3_CCB_BASELINE_AGENTS_ADMIN_MD_REL = "AGENTS.admin.md";
export const V3_CCB_BASELINE_CLAUDE_ADMIN_MD_REL = "CLAUDE.admin.md";
export const V3_CCB_BASELINE_SKILLS_DIR_REL = "skills";

/** managed label,GC / orphan reconcile 用 */
export const V3_MANAGED_LABEL_KEY = "com.openclaude.v3.managed";
export const V3_UID_LABEL_KEY = "com.openclaude.v3.uid";

/** IP 池范围与重试上限 */
export const V3_IP_OCTET_MIN = 10;
export const V3_IP_OCTET_MAX = 250;
export const V3_IP_ALLOC_MAX_ATTEMPTS = 30;

/** v3 容器资源硬限额默认值 */
export const DEFAULT_V3_MEMORY_MB = 4096;
export const DEFAULT_V3_CPUS = 1.0;
export const DEFAULT_V3_PIDS_LIMIT = 4096;
export const V3_ADMIN_PIDS_LIMIT = 16384;

/** 二元 advisory lock 命名空间 */
export const USER_LIFECYCLE_LOCK_NS = 0x0c_b3_d0_01;
export const HOST_CAP_LOCK_NS = 0x0c_b3_ca_70;

/** Postgres canonical UUID 文本形式(36 字符 lowercase + 4 个连字符) */
export const HOST_UUID_CANONICAL_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 全部 5 个 per-user 卷的 role 键(= 卷名中缀);顺序即 ensureV3Volumes 建卷顺序。 */
export const V3_VOLUME_ROLES = [
  "data",
  "proj",
  "codex",
  "userlocal",
  "userconfig",
] as const;
export type V3VolumeRole = (typeof V3_VOLUME_ROLES)[number];

export interface V5LocalCcbTransportEnvInput {
  runtimeChannel: RuntimeChannel;
  useRemote: boolean;
  hostGatewayIp: string;
  proxyUrl?: string;
  noProxy?: string;
}

export interface V5CursorAuthMountOptions {
  uid: number;
  runtimeChannel: RuntimeChannel;
  useRemote: boolean;
  credentialUids?: string;
  /** Rollback compatibility for releases before shared credential membership. */
  ownerUid?: string;
  authDir?: string;
}

export type CcbBaselineMountOpts = {
  /** role=admin 时挂不含租户限制守则的 *.admin.md；缺省/非 admin 仍挂完整守则。 */
  admin?: boolean;
};

export interface ResolvedCcbBaselineMounts {
  agentsMdHostPath: string;
  claudeMdHostPath: string;
  skillsDirHostPath: string;
}

export interface V3SupervisorDeps {
  /** Personal test-only fresh container lane; omitted entirely while OFF. */
  cc5?: RemoteLaneRuntimePort;
  docker: Docker;
  pool: Pool;
  image: string;
  randomIp?: () => string;
  randomSecret?: () => string;
  ccbBaselineDir?: string;
  bridgeSecret?: string;
  adminRuntimeRecycleDrain?: (
    status: V3ContainerStatus,
  ) => Promise<"accepted" | "busy" | "failed">;
  modelAuthority?: {
    keyringEnvAssignment: string | (() => string);
    required: boolean;
    auxModels?: readonly string[];
  };
  containerService?: ContainerService;
  selfHostId?: string;
  putRemoteCodexAuth?(
    hostUuid: string,
    containerId: string,
    accessToken: string,
    lastRefreshIso: string,
  ): Promise<void>;
  deleteRemoteCodexAuth?(hostUuid: string, containerId: string): Promise<void>;
  listAllHosts?: () => Promise<ComputeHostRow[]>;
  runtimeTuple?: V3RuntimeTuple;
  syntheticEvalOverlay?: SyntheticEvalOverlayRuntime;
}

export interface ProvisionedV3Container {
  containerId: number;
  userId: number;
  boundIp: string;
  port: number;
  dockerContainerId: string;
  token: string;
  hostId: string | null;
  bundleRev?: string;
}

export interface V3ContainerStatus {
  runtimeInspection?: RuntimeInspection;
  containerId: number;
  userId: number;
  boundIp: string;
  port: number;
  dockerContainerId: string;
  state: "running" | "provisioning" | "stopped" | "missing";
  hostId: string | null;
  lastWsActivity: Date | null;
  image?: string;
  imageId?: string;
  labels?: Record<string, string>;
}

export interface V3VolumeBundle {
  data: string;
  projects: string;
  codex: string;
  userLocal: string;
  userConfig: string;
}

export interface V3ImagePreheatResult {
  image: string;
  outcome: "already" | "pulled" | "error";
  error?: string;
  durationMs: number;
}

/** Injected synchronous FS operations port so new submodules remain `syncIo = 0`. */
export interface SyncHostFsStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  mode: number;
  size: number;
}

export interface SyncHostFsPort {
  lstat(targetPath: string): SyncHostFsStat;
  readdir(dirPath: string): string[];
  realpath(targetPath: string): string;
  readUtf8(filePath: string): string;
}
