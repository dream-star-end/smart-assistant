/**
 * ContainerService — 多机容器编排门面。
 *
 * 角色:
 *   - 把"容器/卷的 CRUD"从具体执行后端(本机 dockerode vs 远端 node-agent)里抽出,
 *     调用方只按 hostId 说"我要什么",实际调哪个 backend 由 router 决定。
 *   - master 的 PG 事务 / advisory lock / cap admission / IP 分配 / baseline 校验
 *     **完全不动**,只是"docker 真正动作"那几下换成本接口。
 *
 * 三个实现:
 *   - LocalDockerBackend     — hostId 对应 `compute_hosts.name='self'` 时走本机 dockerode
 *   - RemoteNodeAgentBackend — 其它 host 走 nodeAgentClient(mTLS + PSK)
 *   - HostAwareContainerService — 按 hostId → ComputeHostRow.name 路由,带 60s host 行缓存
 *
 * 合同:
 *   - ContainerSpec 只携带"因容器而异"的字段;所有 v3 容器必须的硬化选项
 *     (CapDrop NET_RAW+NET_ADMIN、no-new-privileges、User=1000:1000、Tmpfs
 *     /run/oc/claude-config、MemorySwap=Memory、Swappiness=0、NetworkMode=
 *     openclaude-v3-net、IPAMConfig.IPv4Address=boundIp、UsernsMode=""、
 *     ShmSize=64MB、RestartPolicy=no)由 backend 内部固定
 *     —— node-agent /containers/run 已按同约定实现,两端必须一致。
 *   - 失败类型:保留 SupervisorError(本机路径)/ AgentAppError / AgentUnreachableError
 *     / CertVerifyError(远端路径)。caller 的既有 catch 逻辑不变。
 *   - 超时、重试、日志由 backend 内部决定;facade 不加额外包装。
 */

import type Docker from "dockerode";
import { rootLogger } from "../logging/logger.js";
import * as queries from "./queries.js";
import { SupervisorError } from "../agent-sandbox/types.js";
import {
  createVolume as agentCreateVolume,
  removeVolume as agentRemoveVolume,
  inspectVolume as agentInspectVolume,
  runContainer as agentRunContainer,
  stopContainer as agentStopContainer,
  removeContainer as agentRemoveContainer,
  inspectContainer as agentInspectContainer,
  hostRowToTarget,
  type NodeAgentTarget,
} from "./nodeAgentClient.js";
import type {
  AgentContainerInspect,
  AgentRunContainerRequest,
  ComputeHostRow,
} from "./types.js";

const log = rootLogger.child({ subsys: "container-service" });

// ─── 共享常量(与 v3supervisor.ts / node-agent 严格一致)──────────────

/** docker bridge 网络名 —— setup-host-net.sh 创建,本服务只引用。 */
export const V3_NETWORK_NAME = "openclaude-v3-net";

/** 容器内 CLAUDE_CONFIG_DIR tmpfs 挂载点。 */
export const V3_CONFIG_TMPFS_PATH = "/run/oc/claude-config";

/** 容器内 agent 用户 uid:gid,与 Dockerfile USER 一致。 */
const V3_AGENT_USER = "1000:1000";

/** managed label(docker 层识别 v3 容器)与 v3supervisor 共享同一 key 名。 */
const V3_MANAGED_LABEL_KEY = "com.openclaude.v3.managed";

/** host-local baseline 固定路径(self-host 用 repo 内目录)。 */
export const SELF_HOST_CCB_BASELINE_DIR =
  "/opt/openclaude/openclaude/packages/commercial/agent-sandbox/ccb-baseline";

/** remote host baseline 固定路径(由 Batch A baseline pull 到这个目录)。 */
export const REMOTE_HOST_CCB_BASELINE_DIR = "/var/lib/openclaude/baseline";

// ─── 公共类型 ────────────────────────────────────────────────────────

/**
 * 跨后端 portable 容器规格。
 *
 * 设计:只写"因容器而异"的字段。硬化选项(cap-drop、security-opt、network-mode、
 * tmpfs、user、ipam IPv4Address)由具体 backend 代为注入 —— 本机 LocalDockerBackend
 * 组装 Docker HostConfig 时补齐;远端 node-agent 在 /containers/run handler 里补齐。
 */
export interface ContainerSpec {
  /** 对应 agent_containers.id;供 node-agent label 与 identity lookup。 */
  containerDbId: number;
  /** 容器在 docker bridge 上被 --ip 强制绑定的 IP。 */
  boundIp: string;
  /** 镜像(含 tag),如 openclaude/openclaude-runtime:latest。 */
  image: string;
  /** docker 容器名。 */
  name: string;
  /** 容器环境变量。 */
  env: Record<string, string>;
  /** 容器 label;backend 会合并 V3_MANAGED_LABEL_KEY=1 与 uid。 */
  labels: Record<string, string>;
  /** bind mount(含 ro)。tmpfs 由 backend 固定注入,不走这里。 */
  binds: Array<{ source: string; target: string; readonly: boolean }>;
  /** 容器资源硬限额。 */
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  /** 容器内 HTTP/WS 监听端口(V3_CONTAINER_PORT=18789)。 */
  internalPort: number;
  /** cmd 覆盖(可选;默认走镜像 entrypoint/cmd)。 */
  cmd?: string[];
}

/**
 * 容器 inspect 结果。与 node-agent /containers/:id/inspect 的响应结构一致;
 * 本机 backend 会把 dockerode 的结构映射成这个形状。
 */
export type ContainerInspect = AgentContainerInspect;

/** 基线挂载源路径(host 上的绝对路径)。 */
export interface BaselineSourcePaths {
  claudeMdHostPath: string;
  skillsDirHostPath: string;
}

export interface ContainerService {
  /** 幂等创建卷(labels 由 backend 注入)。 */
  ensureVolume(hostId: string, name: string): Promise<void>;
  /** 删除卷;missing 视作成功。 */
  removeVolume(hostId: string, name: string): Promise<void>;
  /** inspect 卷。 */
  inspectVolume(hostId: string, name: string): Promise<{ exists: boolean }>;
  /** 创建并启动容器;返回 docker container 完整 ID。 */
  createAndStart(
    hostId: string,
    spec: ContainerSpec,
  ): Promise<{ containerInternalId: string }>;
  /** 优雅停止容器;missing 视作成功。 */
  stop(
    hostId: string,
    containerInternalId: string,
    opts?: { timeoutSec?: number },
  ): Promise<void>;
  /** 删除容器;missing 视作成功。默认 force=true。 */
  remove(
    hostId: string,
    containerInternalId: string,
    opts?: { force?: boolean },
  ): Promise<void>;
  /** inspect 容器;missing 抛 statusCode=404。 */
  inspect(hostId: string, containerInternalId: string): Promise<ContainerInspect>;
  /** host 是否远端(非 self)。路由/baseline 路径选取用。 */
  isRemote(hostId: string): Promise<boolean>;
  /** host 上 baseline 挂载源路径;self=repo,remote=/var/lib/openclaude/baseline。 */
  resolveBaselinePaths(hostId: string): Promise<BaselineSourcePaths>;
}

// ─── LocalDockerBackend ───────────────────────────────────────────────

/**
 * 本机 dockerode backend —— 只服务于 `compute_hosts.name='self'`。
 *
 * 代码镜像于 v3supervisor.ts 里的硬编码 HostConfig 组合;v3supervisor 重构
 * (B.3)完成后,原位置代码会改为调本 backend 的 createAndStart。两者必须
 * 完全一致(否则 B.3 会改变行为),因此硬化选项全部就地写死,不暴露参数。
 */
export class LocalDockerBackend {
  constructor(private readonly docker: Docker) {}

  async ensureVolume(name: string, extraLabels: Record<string, string>): Promise<void> {
    await this.docker.createVolume({
      Name: name,
      Driver: "local",
      Labels: { [V3_MANAGED_LABEL_KEY]: "1", ...extraLabels },
    });
  }

  async removeVolume(name: string): Promise<void> {
    try {
      await this.docker.getVolume(name).remove();
    } catch (err) {
      if (isDockerNotFound(err)) return;
      throw err;
    }
  }

  async inspectVolume(name: string): Promise<{ exists: boolean }> {
    try {
      await this.docker.getVolume(name).inspect();
      return { exists: true };
    } catch (err) {
      if (isDockerNotFound(err)) return { exists: false };
      throw err;
    }
  }

  async createAndStart(spec: ContainerSpec): Promise<{ containerInternalId: string }> {
    const envArr = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`);
    const binds = spec.binds.map(
      (b) => `${b.source}:${b.target}:${b.readonly ? "ro" : "rw"}`,
    );
    let container;
    try {
      container = await this.docker.createContainer({
        name: spec.name,
        Image: spec.image,
        Env: envArr,
        Cmd: spec.cmd,
        User: V3_AGENT_USER,
        Labels: { [V3_MANAGED_LABEL_KEY]: "1", ...spec.labels },
        AttachStdin: false,
        AttachStdout: false,
        AttachStderr: false,
        Tty: false,
        OpenStdin: false,
        NetworkingConfig: {
          EndpointsConfig: {
            [V3_NETWORK_NAME]: {
              IPAMConfig: { IPv4Address: spec.boundIp },
            },
          },
        },
        HostConfig: {
          NetworkMode: V3_NETWORK_NAME,
          Memory: spec.memoryBytes,
          MemorySwap: spec.memoryBytes,
          MemorySwappiness: 0,
          NanoCpus: spec.nanoCpus,
          PidsLimit: spec.pidsLimit,
          CapDrop: ["NET_RAW", "NET_ADMIN"],
          CapAdd: [],
          Privileged: false,
          SecurityOpt: ["no-new-privileges"],
          Tmpfs: {
            [V3_CONFIG_TMPFS_PATH]:
              "rw,nosuid,nodev,size=4m,mode=0700,uid=1000,gid=1000",
          },
          Binds: binds,
          RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
          ShmSize: 64 * 1024 * 1024,
          UsernsMode: "",
        },
      });
    } catch (createErr) {
      throw createErr;
    }
    try {
      await container.start();
    } catch (startErr) {
      try {
        await container.remove({ force: true });
      } catch {
        /* swallow */
      }
      throw startErr;
    }
    return { containerInternalId: container.id };
  }

  async stop(cid: string, opts?: { timeoutSec?: number }): Promise<void> {
    const handle = this.docker.getContainer(cid);
    try {
      await handle.stop({ t: opts?.timeoutSec ?? 5 });
    } catch (err) {
      if (isDockerNotFound(err) || isDockerNotModified(err)) return;
      throw err;
    }
  }

  async remove(cid: string, opts?: { force?: boolean }): Promise<void> {
    const handle = this.docker.getContainer(cid);
    try {
      await handle.remove({ force: opts?.force ?? true });
    } catch (err) {
      if (isDockerNotFound(err)) return;
      throw err;
    }
  }

  async inspect(cid: string): Promise<ContainerInspect> {
    const info = await this.docker.getContainer(cid).inspect();
    const state = (info.State ?? {}) as {
      Status?: string;
      Running?: boolean;
      StartedAt?: string;
      FinishedAt?: string;
      ExitCode?: number;
      OOMKilled?: boolean;
    };
    const rawStatus = typeof state.Status === "string" ? state.Status : "exited";
    const normalized = normalizeLocalState(rawStatus, Boolean(state.Running));
    // 取 docker bridge 上的 v3 网络 endpoint IP;缺失则回传空字符串。
    const endpoints =
      (info.NetworkSettings &&
        (info.NetworkSettings.Networks as Record<string, { IPAddress?: string }> | undefined)) ||
      undefined;
    const boundIp = endpoints?.[V3_NETWORK_NAME]?.IPAddress ?? "";
    return {
      id: info.Id ?? cid,
      state: normalized,
      startedAt: state.StartedAt ?? null,
      finishedAt: state.FinishedAt ?? null,
      exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
      oomKilled: Boolean(state.OOMKilled),
      boundIp,
    };
  }
}

function normalizeLocalState(
  status: string,
  running: boolean,
): ContainerInspect["state"] {
  if (running) return "running";
  switch (status) {
    case "created":
    case "running":
    case "exited":
    case "dead":
    case "paused":
    case "restarting":
    case "removing":
      return status;
    default:
      return "exited";
  }
}

function isDockerNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    (err as { statusCode: number }).statusCode === 404
  );
}

function isDockerNotModified(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    (err as { statusCode: number }).statusCode === 304
  );
}

// ─── RemoteNodeAgentBackend ───────────────────────────────────────────

/**
 * 远端 node-agent backend —— 走 mTLS + PSK HTTPS。
 *
 * ComputeHostRow 被加密存储,每次调用都经过 `hostRowToTarget` 解密 PSK;
 * 调用完成后必须 `.fill(0)` 清零以免明文驻留 Node 堆。
 */
export class RemoteNodeAgentBackend {
  constructor(private readonly getRow: (hostId: string) => Promise<ComputeHostRow>) {}

  private async withTarget<T>(
    hostId: string,
    fn: (target: NodeAgentTarget) => Promise<T>,
  ): Promise<T> {
    const row = await this.getRow(hostId);
    const target = hostRowToTarget(row);
    try {
      return await fn(target);
    } finally {
      if (target.psk) target.psk.fill(0);
    }
  }

  async ensureVolume(hostId: string, name: string): Promise<void> {
    await this.withTarget(hostId, (t) => agentCreateVolume(t, name));
  }

  async removeVolume(hostId: string, name: string): Promise<void> {
    await this.withTarget(hostId, (t) => agentRemoveVolume(t, name));
  }

  async inspectVolume(hostId: string, name: string): Promise<{ exists: boolean }> {
    return this.withTarget(hostId, async (t) => {
      const r = await agentInspectVolume(t, name);
      return { exists: r.exists };
    });
  }

  async createAndStart(
    hostId: string,
    spec: ContainerSpec,
  ): Promise<{ containerInternalId: string }> {
    return this.withTarget(hostId, async (t) => {
      const req: AgentRunContainerRequest = {
        containerDbId: spec.containerDbId,
        boundIp: spec.boundIp,
        image: spec.image,
        name: spec.name,
        env: spec.env,
        labels: { [V3_MANAGED_LABEL_KEY]: "1", ...spec.labels },
        binds: spec.binds,
        memoryBytes: spec.memoryBytes,
        nanoCpus: spec.nanoCpus,
        pidsLimit: spec.pidsLimit,
        internalPort: spec.internalPort,
        cmd: spec.cmd,
      };
      const r = await agentRunContainer(t, req);
      return { containerInternalId: r.containerInternalId };
    });
  }

  async stop(
    hostId: string,
    cid: string,
    _opts?: { timeoutSec?: number },
  ): Promise<void> {
    // node-agent /containers/:id/stop 内部自定 timeout;M1 不暴露参数。
    await this.withTarget(hostId, (t) => agentStopContainer(t, cid));
  }

  async remove(
    hostId: string,
    cid: string,
    opts?: { force?: boolean },
  ): Promise<void> {
    await this.withTarget(hostId, (t) =>
      agentRemoveContainer(t, cid, opts?.force ?? true),
    );
  }

  async inspect(hostId: string, cid: string): Promise<ContainerInspect> {
    return this.withTarget(hostId, (t) => agentInspectContainer(t, cid));
  }
}

// ─── HostAwareContainerService(router) ───────────────────────────────

const HOST_ROW_CACHE_MS = 60_000;

interface HostRowCacheEntry {
  row: ComputeHostRow;
  loadedAt: number;
}

/**
 * 按 hostId 路由的 ContainerService 实现。
 *
 * 缓存策略:compute_hosts 行 60s TTL。短期内重复 provision / stop 不重复查 DB;
 * host name/host/agent_port/psk 字段在 bootstrap 之外基本不变,60s 陈旧可接受。
 * name 改名(admin 重命名 self→...)被 migration 0030 的 CHECK 约束拦住,不会发生。
 *
 * hostId 查不到:抛 `SupervisorError("InvalidArgument", ...)`,caller 按既有错处理。
 */
export class HostAwareContainerService implements ContainerService {
  private readonly cache = new Map<string, HostRowCacheEntry>();

  constructor(
    private readonly local: LocalDockerBackend,
    private readonly remote: RemoteNodeAgentBackend,
  ) {}

  /** 测试钩子 / admin 重命名后清缓存。 */
  invalidate(hostId?: string): void {
    if (hostId) this.cache.delete(hostId);
    else this.cache.clear();
  }

  private async getRow(hostId: string): Promise<ComputeHostRow> {
    const now = Date.now();
    const hit = this.cache.get(hostId);
    if (hit && now - hit.loadedAt < HOST_ROW_CACHE_MS) return hit.row;
    const row = await queries.getHostById(hostId);
    if (!row) {
      throw new SupervisorError("InvalidArgument", `unknown hostId: ${hostId}`);
    }
    this.cache.set(hostId, { row, loadedAt: now });
    return row;
  }

  async isRemote(hostId: string): Promise<boolean> {
    const row = await this.getRow(hostId);
    return row.name !== "self";
  }

  async resolveBaselinePaths(hostId: string): Promise<BaselineSourcePaths> {
    const remote = await this.isRemote(hostId);
    if (!remote) {
      return {
        claudeMdHostPath: `${SELF_HOST_CCB_BASELINE_DIR}/CLAUDE.md`,
        skillsDirHostPath: `${SELF_HOST_CCB_BASELINE_DIR}/skills`,
      };
    }
    return {
      claudeMdHostPath: `${REMOTE_HOST_CCB_BASELINE_DIR}/CLAUDE.md`,
      skillsDirHostPath: `${REMOTE_HOST_CCB_BASELINE_DIR}/skills`,
    };
  }

  async ensureVolume(hostId: string, name: string): Promise<void> {
    if (await this.isRemote(hostId)) {
      return this.remote.ensureVolume(hostId, name);
    }
    return this.local.ensureVolume(name, {});
  }

  async removeVolume(hostId: string, name: string): Promise<void> {
    if (await this.isRemote(hostId)) {
      return this.remote.removeVolume(hostId, name);
    }
    return this.local.removeVolume(name);
  }

  async inspectVolume(
    hostId: string,
    name: string,
  ): Promise<{ exists: boolean }> {
    if (await this.isRemote(hostId)) {
      return this.remote.inspectVolume(hostId, name);
    }
    return this.local.inspectVolume(name);
  }

  async createAndStart(
    hostId: string,
    spec: ContainerSpec,
  ): Promise<{ containerInternalId: string }> {
    if (await this.isRemote(hostId)) {
      return this.remote.createAndStart(hostId, spec);
    }
    return this.local.createAndStart(spec);
  }

  async stop(
    hostId: string,
    cid: string,
    opts?: { timeoutSec?: number },
  ): Promise<void> {
    if (await this.isRemote(hostId)) {
      return this.remote.stop(hostId, cid, opts);
    }
    return this.local.stop(cid, opts);
  }

  async remove(
    hostId: string,
    cid: string,
    opts?: { force?: boolean },
  ): Promise<void> {
    if (await this.isRemote(hostId)) {
      return this.remote.remove(hostId, cid, opts);
    }
    return this.local.remove(cid, opts);
  }

  async inspect(hostId: string, cid: string): Promise<ContainerInspect> {
    if (await this.isRemote(hostId)) {
      return this.remote.inspect(hostId, cid);
    }
    return this.local.inspect(cid);
  }
}

// ─── 工厂 ─────────────────────────────────────────────────────────────

/**
 * 构造 production HostAwareContainerService。调用方持单例。
 *
 * 参数 `docker` 是 dockerode 本机 client(同 v3supervisor index.ts 持的那个单例)。
 * remote backend 行读取走 `queries.getHostById`,caller 无需额外注入 DB。
 */
export function createContainerService(docker: Docker): HostAwareContainerService {
  const local = new LocalDockerBackend(docker);
  const remote = new RemoteNodeAgentBackend(async (hostId) => {
    const row = await queries.getHostById(hostId);
    if (!row) {
      throw new SupervisorError("InvalidArgument", `unknown hostId: ${hostId}`);
    }
    return row;
  });
  log.info("ContainerService initialized");
  return new HostAwareContainerService(local, remote);
}
