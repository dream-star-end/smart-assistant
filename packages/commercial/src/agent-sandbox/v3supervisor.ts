/**
 * V3 Phase 3C — per-user openclaude-runtime container supervisor.
 *
 * 见 docs/v3/02-DEVELOPMENT-PLAN.md §9.3 Task 3C / §3.2 容器身份
 *
 * 拓扑(MVP 单 host monolith):
 *   每个商用版用户 → 一个本镜像 openclaude/openclaude-runtime 启动的容器,
 *   挂在 docker bridge `openclaude-v3-net` (172.30.0.0/16) 上,容器内跑完整
 *   个人版 OpenClaude gateway,所有 anthropic 调用被 ANTHROPIC_BASE_URL 重定向
 *   到本机 commercial gateway 的内部代理 (172.30.0.1:18791)。
 *
 * 与 v2 supervisor 的关系:
 *   - v2 (`./supervisor.ts`) 是为"claude code agent" 设计的;ReadOnly rootfs +
 *     双 volume + tinyproxy + RPC unix socket + custom seccomp,适配那条独立路线。
 *   - v3 supervisor 完全独立,**不复用** v2 的 createContainer —— 字段差异巨大
 *     (单 volume / tmpfs config / cap-drop NET_RAW NET_ADMIN / 强制 --ip /
 *     ANTHROPIC_AUTH_TOKEN 双因子 / 不要 seccomp / 不要 readonly rootfs)。
 *   - v2/v3 共用 dockerode + SupervisorError 类型,其它互不影响。
 *
 * 双因子身份(§3.2 R2):
 *   - 因子 A:bound_ip — supervisor 用 docker `--ip` 在 provision 时强制分配,
 *     INSERT agent_containers 行落 bound_ip,uniq partial index 保证 active 集合
 *     里全局唯一。
 *   - 因子 B:secret — 32-byte 随机 → SHA256 → BYTEA 入库;明文塞进容器 env
 *     `ANTHROPIC_AUTH_TOKEN=oc-v3.<row_id>.<secret_hex>`,容器内 OpenClaude
 *     调 anthropic 时 Authorization Bearer 带回来,2D 内部代理 timing-safe 校验。
 *
 * 不在本文件管:
 *   - WS bridge endpoint 解析(3D 的 ensureRunning 包装本文件 + DB 查询)
 *   - idle sweep / orphan reconcile(3F / 3H 单独的 lifecycle scheduler)
 *   - volume GC(3G,banned 7d / no-login 90d)
 *   - 内部代理 listener(2H 已在 index.ts 启好)
 *   - docker network 创建(setup-host-net.sh 一次性脚本搞定,不要 inspect/create)
 */

import type Docker from "dockerode";
import { randomBytes, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { SupervisorError } from "./types.js";

// ───────────────────────────────────────────────────────────────────────
// 常量(硬编码,设计有意为之)
// ───────────────────────────────────────────────────────────────────────

/** docker bridge 网络名 — setup-host-net.sh 创建,本模块只引用 */
export const V3_NETWORK_NAME = "openclaude-v3-net";

/** docker bridge 子网 / 网关 — 与 setup-host-net.sh 严格一致 */
export const V3_SUBNET_CIDR = "172.30.0.0/16";
export const V3_GATEWAY_IP = "172.30.0.1";

/**
 * 容器内 ANTHROPIC_BASE_URL 必须指向的内部代理地址。
 * gateway 是 docker bridge 网关 IP,内部代理(2H)绑在这个 IP:18791 上。
 */
export const V3_INTERNAL_PROXY_URL = "http://172.30.0.1:18791";

/**
 * 容器内 OpenClaude gateway 监听端口(默认 18789,见 personal-version
 * `packages/storage/src/config.ts`,容器侧 entrypoint.ts bootstrap config 也是这个值)。
 */
export const V3_CONTAINER_PORT = 18789;

/** CLAUDE_CONFIG_DIR tmpfs 挂载点(防 settings.json 残留) */
export const V3_CONFIG_TMPFS_PATH = "/run/oc/claude-config";

/** 容器内单个 named volume 的挂载点(对应个人版 ~/.openclaude) */
export const V3_VOLUME_MOUNT = "/home/agent/.openclaude";

/** 容器内 entrypoint 跑的非 root 用户(uid:gid),与 Dockerfile USER 一致 */
const V3_AGENT_USER = "1000:1000";

/** managed label,GC / orphan reconcile 用 */
const V3_MANAGED_LABEL_KEY = "com.openclaude.v3.managed";
const V3_UID_LABEL_KEY = "com.openclaude.v3.uid";

/** IP 池 — 排除 .0 (network) / .1 (gateway) / .2-.9 (运维预留) / .255 (broadcast) */
const V3_IP_OCTET_MIN = 10;
const V3_IP_OCTET_MAX = 250;
/** 在 172.30.0/16 内随机选,失败重试上限(uniq 冲突时 INSERT 重试) */
const V3_IP_ALLOC_MAX_ATTEMPTS = 30;

/**
 * V3 Phase 3I — 实例级 active 容器硬限。
 *
 * 默认 50,经验值(单 host 32GB / 50 容器 ≈ 每容器 600MB working set 余量)。
 * env `OC_MAX_RUNNING_CONTAINERS` 整数覆盖;V3SupervisorDeps.maxRunningContainers
 * 优先级更高(测试 / 多机分配)。打到 cap → SupervisorError("HostFull"),
 * v3ensureRunning 翻成 ContainerUnreadyError(10, "host_full"),前端按 retryAfter
 * 长重试(冷启等其他用户 idle sweep / GC 释放)。
 *
 * 算空位时只数 state='active'(不数 vanished;3F idle sweep / 3H reconcile
 * 会及时把死容器翻 vanished)。
 */
export const DEFAULT_MAX_RUNNING_CONTAINERS = 50;

/** 读 env `OC_MAX_RUNNING_CONTAINERS`;非法值 → 落回默认 50 */
function readMaxRunningContainersFromEnv(): number {
  const raw = process.env.OC_MAX_RUNNING_CONTAINERS;
  if (raw == null || raw.trim() === "") return DEFAULT_MAX_RUNNING_CONTAINERS;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return DEFAULT_MAX_RUNNING_CONTAINERS;
  }
  return n;
}

// ───────────────────────────────────────────────────────────────────────
// 公共类型
// ───────────────────────────────────────────────────────────────────────

/**
 * provisionV3Container 的依赖注入。
 *
 * - `docker`:dockerode client(index.ts 单例)
 * - `pool`:pg Pool(用于 INSERT/UPDATE agent_containers,IP 唯一约束在 PG 层)
 * - `image`:openclaude/openclaude-runtime:<tag>(由 OC_RUNTIME_IMAGE env 注入)
 *
 * `randomIp` / `randomSecret` 为可选注入,生产用 crypto 默认实现;
 * 测试可以注入确定值便于断言。
 */
export interface V3SupervisorDeps {
  docker: Docker;
  pool: Pool;
  image: string;
  /** 测试钩子:覆盖 IP 分配。生产留空走默认。 */
  randomIp?: () => string;
  /** 测试钩子:覆盖 secret 生成。生产留空走默认。 */
  randomSecret?: () => string;
  /**
   * V3 Phase 3I — 实例级 active 容器硬限。覆盖 env `OC_MAX_RUNNING_CONTAINERS`,
   * env 不设则走 `DEFAULT_MAX_RUNNING_CONTAINERS=50`。≤0 / 非整数 / 非数字
   * 都会被忽略走默认。
   */
  maxRunningContainers?: number;
}

/** provision 成功后返回。3D ensureRunning 拿来注入到 userChatBridge */
export interface ProvisionedV3Container {
  /** agent_containers.id(INSERT RETURNING) */
  containerId: number;
  /** agent_containers.user_id(传入即返回,方便 caller 不重查) */
  userId: number;
  /** docker bridge 上分配给容器的 IP */
  boundIp: string;
  /** 容器内 OpenClaude gateway 监听端口 */
  port: number;
  /** docker container ID(full hex 64) */
  dockerContainerId: string;
  /** 用户态 token —— 仅用于 caller 测试 / debug;生产路径不应该回看 */
  token: string;
}

/** getV3ContainerStatus 返回 */
export interface V3ContainerStatus {
  containerId: number;
  userId: number;
  boundIp: string;
  port: number;
  dockerContainerId: string;
  /** docker inspect 后的标准化态。docker missing 也归 stopped(由 caller 决定 vanish) */
  state: "running" | "stopped" | "missing";
}

// ───────────────────────────────────────────────────────────────────────
// 名字 / 校验工具
// ───────────────────────────────────────────────────────────────────────

/** uid → docker 容器名。`oc-v3-u<uid>`,uid 必须正整数 */
export function v3ContainerNameFor(uid: number): string {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  return `oc-v3-u${uid}`;
}

/** uid → 单个 named volume 名。`oc-v3-data-u<uid>` */
export function v3VolumeNameFor(uid: number): string {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  return `oc-v3-data-u${uid}`;
}

/** 在 172.30.0.0/16 内挑一个 IP(默认实现) */
function defaultPickRandomIp(): string {
  // 172.30.0.0/16 → 第三 + 第四 octet 任意
  // 排除 .0.0 (network), .0.1 (gateway), .255.255 (broadcast),其它都可
  // 简化:第三 octet 取 [0,255],第四取 [V3_IP_OCTET_MIN, V3_IP_OCTET_MAX]
  // 这样不撞 .0 / .255,也避开 .1 网关
  const third = Math.floor(Math.random() * 256);
  const fourth = V3_IP_OCTET_MIN + Math.floor(Math.random() * (V3_IP_OCTET_MAX - V3_IP_OCTET_MIN + 1));
  // 极小概率撞到 .0.1 网关:third=0 && fourth=1。fourth 起点 >= 10,绝不会
  return `172.30.${third}.${fourth}`;
}

/** 32-byte random → 64 hex(默认实现) */
function defaultRandomSecret(): string {
  return randomBytes(32).toString("hex");
}

/** SHA-256(secret_bytes) → 32-byte Buffer(与 containerIdentity.hashSecret 同算) */
function hashSecretToBuffer(secretHex: string): Buffer {
  return createHash("sha256").update(Buffer.from(secretHex, "hex")).digest();
}

/** 把 supervisor 内部错误归到 SupervisorError,便于上层按 code 处理 */
function wrapDockerError(err: unknown): SupervisorError {
  if (err instanceof SupervisorError) return err;
  const e = err as { statusCode?: number; message?: string; code?: string };
  const message = typeof e.message === "string" ? e.message : String(err);
  if (e.code === "ENOENT" || e.code === "EACCES" || e.code === "ECONNREFUSED") {
    return new SupervisorError("DockerUnavailable", `docker daemon unreachable: ${message}`, { message });
  }
  const statusCode = typeof e.statusCode === "number" ? e.statusCode : undefined;
  if (statusCode === 404) {
    if (/No such image/i.test(message) || /image.*not found/i.test(message)) {
      return new SupervisorError("ImageNotFound", message, { statusCode, message });
    }
    return new SupervisorError("NotFound", message, { statusCode, message });
  }
  if (statusCode === 409) {
    return new SupervisorError("NameConflict", message, { statusCode, message });
  }
  if (statusCode === 400) {
    return new SupervisorError("InvalidArgument", message, { statusCode, message });
  }
  return new SupervisorError("Unknown", message, { statusCode, message });
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "statusCode" in err
    && (err as { statusCode: number }).statusCode === 404;
}

function isNotModified(err: unknown): boolean {
  return typeof err === "object" && err !== null && "statusCode" in err
    && (err as { statusCode: number }).statusCode === 304;
}

// ───────────────────────────────────────────────────────────────────────
// Volume:幂等创建 + label 校验(防同名被运维劫持)
// ───────────────────────────────────────────────────────────────────────

/**
 * 幂等创建用户 volume(v3 单个,不像 v2 双 volume)。
 *
 * 复用 v2 volumes.ts 的 label 守护模式:create 之后 inspect,断言 managed +
 * uid 对得上,Driver=local 且 Options 为空。任何不符 → 拒绝接管。
 */
async function ensureV3Volume(docker: Docker, uid: number): Promise<string> {
  const name = v3VolumeNameFor(uid);
  await docker.createVolume({
    Name: name,
    Driver: "local",
    Labels: {
      [V3_MANAGED_LABEL_KEY]: "1",
      [V3_UID_LABEL_KEY]: String(uid),
    },
  });
  const info = await docker.getVolume(name).inspect();
  if (info.Driver && info.Driver !== "local") {
    throw new SupervisorError(
      "InvalidArgument",
      `volume ${name} exists with driver=${info.Driver}, expected local`,
    );
  }
  const labels = (info.Labels ?? {}) as Record<string, string>;
  if (labels[V3_MANAGED_LABEL_KEY] !== "1") {
    throw new SupervisorError(
      "InvalidArgument",
      `volume ${name} exists but is not managed by openclaude v3 (missing ${V3_MANAGED_LABEL_KEY})`,
    );
  }
  if (labels[V3_UID_LABEL_KEY] !== String(uid)) {
    throw new SupervisorError(
      "InvalidArgument",
      `volume ${name} exists but belongs to uid=${labels[V3_UID_LABEL_KEY]}, expected ${uid}`,
    );
  }
  // bind / nfs / 其它带 Options 的 volume 拒绝接管(防同名 + label 伪造)
  const opts = (info as { Options?: Record<string, string> | null }).Options;
  if (opts && typeof opts === "object" && Object.keys(opts).length > 0) {
    throw new SupervisorError(
      "InvalidArgument",
      `volume ${name} exists with custom Options=${JSON.stringify(opts)}; refuse to adopt`,
    );
  }
  return name;
}

/** 删 user volume(stop+remove 容器后才能删,否则 docker 409)。missing → noop */
export async function removeV3Volume(docker: Docker, uid: number): Promise<void> {
  const name = v3VolumeNameFor(uid);
  try {
    await docker.getVolume(name).remove();
  } catch (err) {
    if (isNotFound(err)) return;
    throw wrapDockerError(err);
  }
}

// ───────────────────────────────────────────────────────────────────────
// IP 分配:INSERT-and-retry,unique partial index 兜底
// ───────────────────────────────────────────────────────────────────────

/**
 * 在事务内 INSERT 一行 active container 占住 bound_ip,撞 uniq 冲突就 ROLLBACK
 * 重试。成功返回 row id(用于拼 token,然后再 UPDATE container_internal_id)。
 *
 * 为什么用"先 INSERT 占位、后 docker create"的顺序:
 *   - 占位的 row 决定 row id,row id 进 token,token 进容器 env。
 *     如果先 docker create 再 INSERT,docker --ip 撞了同 IP 才发现要换 IP,
 *     然后撤销 docker → 比 INSERT 重试代价大很多。
 *   - 唯一约束 `uniq_ac_bound_ip_active` 在 PG 层做仲裁,业务层只 INSERT,
 *     避免 N 个进程同时 SELECT 后撞 IP 的 race(2I-1 调度 N=1 也不能放 race)。
 *
 * 失败模式:
 *   - 唯一冲突(23505) → 换 IP 重试,V3_IP_ALLOC_MAX_ATTEMPTS 次后放弃 → InvalidArgument
 *   - 其他 DB 错 → 直接抛(caller 翻译)
 */
async function allocateBoundIpAndInsertRow(
  client: PoolClient,
  uid: number,
  secretHash: Buffer,
  pickIp: () => string,
): Promise<{ id: number; boundIp: string }> {
  for (let attempt = 0; attempt < V3_IP_ALLOC_MAX_ATTEMPTS; attempt++) {
    const candidate = pickIp();
    try {
      const r = await client.query<{ id: string }>(
        `INSERT INTO agent_containers
           (user_id, bound_ip, secret_hash, state, port, last_ws_activity, created_at, updated_at)
         VALUES
           ($1::bigint, $2::inet, $3::bytea, 'active', $4::int, NOW(), NOW(), NOW())
         RETURNING id`,
        [String(uid), candidate, secretHash, V3_CONTAINER_PORT],
      );
      const id = Number.parseInt(r.rows[0]!.id, 10);
      return { id, boundIp: candidate };
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      // 23505 = unique_violation
      if (e.code === "23505" && (e.constraint === "uniq_ac_bound_ip_active" || /uniq_ac_bound_ip_active/i.test(String((err as Error).message)))) {
        // IP 撞了,换一个继续
        continue;
      }
      throw err;
    }
  }
  throw new SupervisorError(
    "InvalidArgument",
    `failed to allocate bound_ip after ${V3_IP_ALLOC_MAX_ATTEMPTS} attempts; subnet ${V3_SUBNET_CIDR} likely exhausted`,
  );
}

// ───────────────────────────────────────────────────────────────────────
// 主接口:provision / stop+remove / status
// ───────────────────────────────────────────────────────────────────────

/**
 * Provision 一个 v3 容器并启动。同 uid 已有 active 行 → 抛 NameConflict
 * (caller 自己决定要不要先 stopAndRemove,本函数不替你做)。
 *
 * 流程:
 *   1. 确保 named volume(幂等;label 守护)
 *   2. 在事务内 INSERT agent_containers 占 bound_ip(uniq 冲突重试换 IP)
 *      → 拿到 row id + bound_ip
 *   3. 用 row id + secret 拼 token,用 bound_ip 走 docker create --ip
 *      注入 4 个 anthropic env + cap-drop NET_RAW NET_ADMIN + tmpfs
 *      /run/oc/claude-config + 单 volume + label
 *   4. start 容器 → UPDATE agent_containers SET container_internal_id = <id>
 *      → COMMIT
 *   5. 若任何 docker 步骤失败 → ROLLBACK + 尝试 docker rm -f(best-effort);
 *      不抛 wrapped 错(让 caller 看到根因)
 */
export async function provisionV3Container(
  deps: V3SupervisorDeps,
  uid: number,
): Promise<ProvisionedV3Container> {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  if (typeof deps.image !== "string" || deps.image.trim() === "") {
    throw new SupervisorError("InvalidArgument", "deps.image (OC_RUNTIME_IMAGE) is required");
  }

  const containerName = v3ContainerNameFor(uid);
  const pickIp = deps.randomIp ?? defaultPickRandomIp;
  const mintSecret = deps.randomSecret ?? defaultRandomSecret;

  // V3 Phase 3I — 实例级 active 容器硬限。在 volume / IP 分配之前先卡。
  // 优先 deps 注入(测试 / 多机),回落 env / 默认。
  const cap =
    typeof deps.maxRunningContainers === "number"
      && Number.isInteger(deps.maxRunningContainers)
      && deps.maxRunningContainers > 0
      ? deps.maxRunningContainers
      : readMaxRunningContainersFromEnv();
  // R6.7 reader 显式 state filter — 只数 active(vanished 不占容量)。
  // 单机 monolith MVP,不带 host_id;P1 多机加 `AND host_id=$current_host`。
  const capQ = await deps.pool.query<{ active: string }>(
    `SELECT COUNT(*)::text AS active
       FROM agent_containers
      WHERE state = 'active'`,
  );
  const active = Number.parseInt(capQ.rows[0]?.active ?? "0", 10);
  if (active >= cap) {
    throw new SupervisorError(
      "HostFull",
      `host at MAX_RUNNING_CONTAINERS cap (${active}/${cap})`,
      { message: `active=${active} cap=${cap}` },
    );
  }

  // 1) volume(幂等)
  let volumeName: string;
  try {
    volumeName = await ensureV3Volume(deps.docker, uid);
  } catch (err) {
    throw wrapDockerError(err);
  }

  // 2) 事务里 INSERT 占 IP
  const client = await deps.pool.connect();
  let row: { id: number; boundIp: string };
  let secret: string;
  let secretHash: Buffer;
  let createdDockerId = "";
  try {
    await client.query("BEGIN");

    secret = mintSecret();
    if (!/^[0-9a-f]{64}$/.test(secret)) {
      throw new SupervisorError(
        "InvalidArgument",
        "secret generator must return 64 lowercase hex chars (32 bytes)",
      );
    }
    secretHash = hashSecretToBuffer(secret);

    row = await allocateBoundIpAndInsertRow(client, uid, secretHash, pickIp);

    // 3) docker create with --ip + 4 个 anthropic env + cap-drop + tmpfs + 单 volume
    const token = `oc-v3.${row.id}.${secret}`;

    const env: string[] = [
      `ANTHROPIC_BASE_URL=${V3_INTERNAL_PROXY_URL}`,
      `ANTHROPIC_AUTH_TOKEN=${token}`,
      "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1",
      `CLAUDE_CONFIG_DIR=${V3_CONFIG_TMPFS_PATH}`,
    ];

    let container;
    try {
      container = await deps.docker.createContainer({
        name: containerName,
        Image: deps.image,
        Env: env,
        // 镜像本身 USER agent (uid=1000),supervisor 这层再强制一遍防镜像被改回 root
        User: V3_AGENT_USER,
        Labels: {
          [V3_MANAGED_LABEL_KEY]: "1",
          [V3_UID_LABEL_KEY]: String(uid),
        },
        AttachStdin: false,
        AttachStdout: false,
        AttachStderr: false,
        Tty: false,
        OpenStdin: false,
        // 强制 --ip:在 EndpointsConfig 上设 IPAMConfig.IPv4Address
        // (docker create 接受 NetworkingConfig.EndpointsConfig.<net>.IPAMConfig)
        NetworkingConfig: {
          EndpointsConfig: {
            [V3_NETWORK_NAME]: {
              IPAMConfig: { IPv4Address: row.boundIp },
            },
          },
        },
        HostConfig: {
          NetworkMode: V3_NETWORK_NAME,
          // §9.3 cap-drop NET_RAW + NET_ADMIN(防 raw socket 伪造源 IP / 改路由)
          CapDrop: ["NET_RAW", "NET_ADMIN"],
          CapAdd: [],
          // 禁 privileged + 禁 setuid/setgid 提权
          Privileged: false,
          SecurityOpt: ["no-new-privileges"],
          // CLAUDE_CONFIG_DIR tmpfs(防 ~/.claude/settings.json 残留)
          Tmpfs: {
            [V3_CONFIG_TMPFS_PATH]: "rw,nosuid,nodev,size=4m,mode=0700",
          },
          // 单 volume → /home/agent/.openclaude(个人版状态目录)
          Binds: [`${volumeName}:${V3_VOLUME_MOUNT}:rw`],
          RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
          // 给容器分一些 shm,但限到 64MB 防 OOM 绕过
          ShmSize: 64 * 1024 * 1024,
          UsernsMode: "",
        },
      });
      createdDockerId = container.id;
    } catch (createErr) {
      throw wrapDockerError(createErr);
    }

    try {
      await container.start();
    } catch (startErr) {
      // start 失败,回收 container 后让 PG 事务回滚
      try {
        await container.remove({ force: true });
      } catch {
        /* swallow */
      }
      throw wrapDockerError(startErr);
    }

    // 4) UPDATE container_internal_id
    await client.query(
      `UPDATE agent_containers
          SET container_internal_id = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [String(row.id), createdDockerId],
    );

    await client.query("COMMIT");

    return {
      containerId: row.id,
      userId: uid,
      boundIp: row.boundIp,
      port: V3_CONTAINER_PORT,
      dockerContainerId: createdDockerId,
      token,
    };
  } catch (err) {
    // 回滚 PG;尽力清理 docker(若 createContainer 之后失败)
    try {
      await client.query("ROLLBACK");
    } catch {
      /* swallow */
    }
    if (createdDockerId) {
      try {
        await deps.docker.getContainer(createdDockerId).remove({ force: true });
      } catch {
        /* swallow */
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 优雅停止并删除一个 active 容器,把 row 标 vanished。
 *
 * 顺序:
 *   1. docker stop(t=5,SIGTERM 给 npm 5 秒)→ remove --force
 *      missing → noop(可能 supervisor 重启过,容器先死了)
 *   2. UPDATE agent_containers SET state='vanished' WHERE id = $1
 *
 * 不删 volume(GC 走 3G,banned 7d / no-login 90d 才动)。
 */
export async function stopAndRemoveV3Container(
  deps: V3SupervisorDeps,
  containerRow: { id: number; container_internal_id?: string | null },
  timeoutSec = 5,
): Promise<void> {
  // 优先用 container_internal_id 找;没有就用 name(老路径,不 fail-fast)
  const handle = containerRow.container_internal_id
    ? deps.docker.getContainer(containerRow.container_internal_id)
    : null;
  if (handle) {
    try {
      await handle.stop({ t: timeoutSec });
    } catch (err) {
      if (!isNotFound(err) && !isNotModified(err)) throw wrapDockerError(err);
    }
    try {
      await handle.remove({ force: true });
    } catch (err) {
      if (!isNotFound(err)) throw wrapDockerError(err);
    }
  }
  await deps.pool.query(
    `UPDATE agent_containers
        SET state='vanished',
            updated_at=NOW()
      WHERE id = $1`,
    [String(containerRow.id)],
  );
}

/**
 * 把 active 行的 last_ws_activity 刷成 NOW()。
 *
 * 用法:
 *   - ensureRunning 命中 'running' 分支(用户重连)调一次 → idle sweep 计时重置
 *   - provision 时 INSERT 已经写 NOW(),不需要再调
 *   - vanished 行不刷(WHERE state='active' 兜住)
 *
 * 不抛 — caller 拿不到错也无所谓,bridge 不会因为这个 break;最坏情况下
 * 30min idle sweep 误杀 active 容器,用户重连即重 provision,数据全在 volume。
 */
export async function markV3ContainerActivity(
  deps: V3SupervisorDeps,
  agentContainerId: number,
): Promise<void> {
  if (!Number.isInteger(agentContainerId) || agentContainerId <= 0) return;
  try {
    await deps.pool.query(
      `UPDATE agent_containers
          SET last_ws_activity = NOW(),
              updated_at = NOW()
        WHERE id = $1::bigint AND state = 'active'`,
      [String(agentContainerId)],
    );
  } catch {
    // 不冒泡 — 见上方注释
  }
}

/**
 * 查 active row + docker inspect 求标准化态。
 * 用户没 active row → null。docker inspect 404 → state='missing'。
 */
export async function getV3ContainerStatus(
  deps: V3SupervisorDeps,
  uid: number,
): Promise<V3ContainerStatus | null> {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  const r = await deps.pool.query<{
    id: string;
    user_id: string;
    bound_ip: string;
    port: number;
    container_internal_id: string | null;
  }>(
    `SELECT id, user_id, bound_ip::text AS bound_ip, port, container_internal_id
       FROM agent_containers
      WHERE user_id = $1::bigint AND state='active'
      LIMIT 1`,
    [String(uid)],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0]!;
  if (!row.container_internal_id) {
    // 行存在但 supervisor 还没填 container_internal_id —— 极短窗口,视作 stopped
    return {
      containerId: Number.parseInt(row.id, 10),
      userId: Number.parseInt(row.user_id, 10),
      boundIp: row.bound_ip,
      port: row.port ?? V3_CONTAINER_PORT,
      dockerContainerId: "",
      state: "stopped",
    };
  }

  let state: V3ContainerStatus["state"];
  try {
    const info = await deps.docker.getContainer(row.container_internal_id).inspect();
    const running = Boolean(info.State && info.State.Running);
    state = running ? "running" : "stopped";
  } catch (err) {
    if (isNotFound(err)) {
      state = "missing";
    } else {
      throw wrapDockerError(err);
    }
  }

  return {
    containerId: Number.parseInt(row.id, 10),
    userId: Number.parseInt(row.user_id, 10),
    boundIp: row.bound_ip,
    port: row.port ?? V3_CONTAINER_PORT,
    dockerContainerId: row.container_internal_id,
    state,
  };
}

// ───────────────────────────────────────────────────────────────────────
// V3 Phase 3I — 镜像预热(gateway 启动时 fire-and-forget)
// ───────────────────────────────────────────────────────────────────────

/** preheatV3Image 单次结果 — 主要给测试 / log 用,生产路径不需要看 */
export interface V3ImagePreheatResult {
  /** 镜像 tag(传入即返回,方便日志) */
  image: string;
  /** "already" = 本地已有,docker pull 仍然跑过(NO-OP);"pulled" = 真拉了 */
  outcome: "already" | "pulled" | "error";
  /** error 文案(outcome='error' 才有) */
  error?: string;
  /** 全过程毫秒 */
  durationMs: number;
}

/**
 * 异步预热 v3 镜像(gateway 启动时 fire-and-forget 调用)。
 *
 * 为什么需要:Phase 3B 用 `docker save / docker load` 一次性载入镜像后,
 * 一般本地都已存在,首次 provision 不需要拉。但部署节奏不可控(运维忘了 load /
 * 升级途中老镜像被 GC),首次用户冷启会因为 docker pull 卡 30-60s,体验崩。
 * 启动时主动 pull 一次(本地已有 → noop),把这次延迟摊到启动时。
 *
 * 设计取舍:
 *   - **不阻塞启动** —— gateway 不能等镜像 pull 才接 ws,callsite 必须 .catch(...)
 *   - **不抛错** —— 镜像不可达(私有 registry 网络抖动 / 删了)只是首次 provision
 *     变慢,gateway 仍然能跑,3I 这里 best-effort
 *   - 测试可注入 `image()` 调度返回(ReadableStream from dockerode pull)便于断言
 *     调用次数;实际生产不需要 mock
 *   - 默认在 inspect 走通后跳过 pull(镜像已在本地,90% 路径秒返回)。这条路径
 *     比裸 docker.pull 快得多(避开 manifest 拉取)
 */
export async function preheatV3Image(
  docker: Docker,
  image: string,
  logger?: { info?: (m: string, meta?: unknown) => void; warn?: (m: string, meta?: unknown) => void },
): Promise<V3ImagePreheatResult> {
  const startedAt = Date.now();
  if (typeof image !== "string" || image.trim() === "") {
    return { image, outcome: "error", error: "image is empty", durationMs: 0 };
  }
  // 路径 A:inspect 命中(本地已有)→ 直接 noop 返回
  try {
    await docker.getImage(image).inspect();
    const durationMs = Date.now() - startedAt;
    logger?.info?.("[v3 preheat] image already present locally", { image, durationMs });
    return { image, outcome: "already", durationMs };
  } catch (err) {
    if (!isNotFound(err)) {
      // inspect 抛非 404(daemon 不可达 / 权限)→ 不强行 pull,返回 error
      const durationMs = Date.now() - startedAt;
      const message = (err as Error)?.message ?? String(err);
      logger?.warn?.("[v3 preheat] image inspect failed; skipping pull", { image, error: message });
      return { image, outcome: "error", error: message, durationMs };
    }
  }
  // 路径 B:本地没有 → docker pull(stream API,followProgress 直到结束)
  try {
    await new Promise<void>((resolve, reject) => {
      // dockerode v3 typings 把 callback 标得严,unknown 兜
      const dAny = docker as unknown as {
        pull: (img: string, cb: (err: Error | null, stream: NodeJS.ReadableStream) => void) => void;
        modem: { followProgress: (s: NodeJS.ReadableStream, cb: (err: Error | null) => void) => void };
      };
      dAny.pull(image, (err, stream) => {
        if (err) return reject(err);
        dAny.modem.followProgress(stream, (err2) => (err2 ? reject(err2) : resolve()));
      });
    });
    const durationMs = Date.now() - startedAt;
    logger?.info?.("[v3 preheat] image pulled", { image, durationMs });
    return { image, outcome: "pulled", durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = (err as Error)?.message ?? String(err);
    logger?.warn?.("[v3 preheat] image pull failed; first provision will pay latency", { image, error: message });
    return { image, outcome: "error", error: message, durationMs };
  }
}
