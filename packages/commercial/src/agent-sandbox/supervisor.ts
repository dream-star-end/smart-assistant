import type Docker from "dockerode";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureAgentNetwork } from "./network.js";
import { ensureUserVolumes, volumeNamesFor } from "./volumes.js";
import {
  type ContainerStatus,
  type ProvisionOptions,
  type ProvisionResult,
  SupervisorError,
} from "./types.js";

/**
 * Agent 沙箱 supervisor。
 *
 * 职责:把 05-SEC §13 的容器安全约束落成 docker create 参数,隔离每个用户的
 * agent 环境。所有对 dockerode 的调用都收敛到这里,便于统一错误分类。
 *
 * **不在本文件管**:
 *   - 用户订阅 / 扣费(T-53)
 *   - 容器内 RPC 协议(T-52)
 *   - volume GC 调度(T-53 lifecycle.ts)
 */

// ------------------------------------------------------------
//  默认资源限制(严格对齐 05-SEC §13 / 01-SPEC F-5.2)
// ------------------------------------------------------------
const DEFAULT_MEMORY_MB = 384; // 01-SPEC F-5.2 + 05-SEC §13
const DEFAULT_CPUS = 0.2; // 01-SPEC F-5.2 + 05-SEC §13
const DEFAULT_PIDS_LIMIT = 200;
const DEFAULT_TMPFS_TMP_MB = 64;

/**
 * 容器内非 root 运行账户(05-SEC §13)。这里 supervisor 在 create 时直接
 * `User: "1000:1000"`,不再"相信镜像的 USER 指令" —— 双重保险:即使
 * T-51 的 Dockerfile 被误回滚掉 `USER agent` 一行,supervisor 这一层也会
 * 强制非 root。镜像镜像方面,/workspace 和 /root 的 ownership 应 chown 到 1000。
 */
const AGENT_USER = "1000:1000";

/**
 * 保留的 docker 内建网络名,禁止 AGENT_NETWORK 配成这些。
 * - `bridge`:docker 默认 bridge,所有容器互通(而且别人也可以挂上来)
 * - `host`:共享 host 网络栈 —— 直接破坏沙箱
 * - `none`:无网络,但也没有代理白名单;不是 §13 的要求
 * - `default`:某些 compose 场景的默认占位,保留规避
 */
const RESERVED_NETWORK_NAMES = new Set(["bridge", "host", "none", "default"]);

const MIB = 1024 * 1024;
const NANO_CPU_PER_CPU = 1_000_000_000;

/**
 * 我们自己管理的 bridge 上会打的 label,用来区分 "凑巧同名但不是我们创建的网络"
 * —— 例如运维手工建了一个叫 agent-net 的 overlay。
 */
const MANAGED_LABEL_KEY = "com.openclaude.managed";

/** uid → container name 映射。保证只用正整数 uid,避免注入任意容器名。 */
export function containerNameFor(uid: number): string {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  return `agent-u${uid}`;
}

/** 数值范围校验(避免 memoryMb=0 / -1 / Infinity 之类绕过默认值) */
function sanitizePositiveInt(v: number | undefined, def: number, max: number, field: string): number {
  if (v === undefined) return def;
  if (!Number.isInteger(v) || v <= 0 || v > max) {
    throw new SupervisorError("InvalidArgument", `${field} must be a positive integer <= ${max}, got ${v}`);
  }
  return v;
}
function sanitizePositiveFloat(v: number | undefined, def: number, max: number, field: string): number {
  if (v === undefined) return def;
  if (!Number.isFinite(v) || v <= 0 || v > max) {
    throw new SupervisorError("InvalidArgument", `${field} must be in (0, ${max}], got ${v}`);
  }
  return v;
}

/**
 * 构造 docker SecurityOpt 里的 seccomp 参数。
 *
 * 强约束(fail closed,05-SEC §13 要求):
 * - 必填,空 / undefined / 非 JSON object 一律 InvalidArgument
 * - 显式 "unconfined" 串 → 拒绝,防运维随手关掉 seccomp
 * - 合法 → 返回 `seccomp=<json>` 让 caller 拼到 SecurityOpt
 *
 * 注:docker daemon 要求 seccomp 值是完整 JSON 字符串,不是文件路径。
 */
/**
 * defaultAction 白名单:只允许"拒绝为默认"的动作。
 * docker 官方 default.json 用的是 SCMP_ACT_ERRNO,我们这里至少保证:
 * - 不能 default=ALLOW 且 syscalls 为空(等于 unconfined)
 * - 不能 default=LOG / NOTIFY / ALLOW (前两者观察模式,不是强制)
 *
 * 允许 default=ALLOW 但 **必须** 有非空 syscalls(典型用法:allow-by-default
 * + 对高危 syscall 显式 ERRNO/KILL)。这比硬禁 ALLOW 更实用,又能挡住
 * "SCMP_ACT_ALLOW + syscalls:[]" 这种等价 unconfined 的配置。
 */
const SECCOMP_DENY_DEFAULTS = new Set([
  "SCMP_ACT_ERRNO",
  "SCMP_ACT_KILL",
  "SCMP_ACT_KILL_PROCESS",
  "SCMP_ACT_KILL_THREAD",
  "SCMP_ACT_TRAP",
]);

function normalizeSeccompOption(json: string | undefined): string {
  if (json === undefined) {
    throw new SupervisorError(
      "InvalidArgument",
      "seccompProfileJson is required (05-SEC §13 mandates custom seccomp profile)",
    );
  }
  if (typeof json !== "string" || json.trim() === "") {
    throw new SupervisorError("InvalidArgument", "seccompProfileJson must be a non-empty JSON string");
  }
  const trimmed = json.trim();
  if (/^\s*unconfined\s*$/i.test(trimmed)) {
    throw new SupervisorError(
      "InvalidArgument",
      "seccompProfileJson=unconfined is refused (would disable seccomp)",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new SupervisorError(
      "InvalidArgument",
      `seccompProfileJson is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SupervisorError(
      "InvalidArgument",
      "seccompProfileJson must be a JSON object",
    );
  }
  const obj = parsed as { defaultAction?: unknown; syscalls?: unknown };
  if (typeof obj.defaultAction !== "string" || obj.defaultAction.trim() === "") {
    throw new SupervisorError(
      "InvalidArgument",
      "seccompProfileJson.defaultAction is required",
    );
  }
  // 硬约束:profile 必须"真的在拒绝某些东西"。
  //   - defaultAction ∈ deny 集合 → 自动满足("默认拒绝"本身就是收紧)
  //   - defaultAction 为 allow/log/notify 这类非收敛动作 → syscalls 必须存在
  //     且至少有一条规则使用 deny 动作(典型用法:allow-by-default + 显式 deny
  //     高危 syscall)。只要没有任何 deny 规则,profile 等价于 unconfined。
  if (!SECCOMP_DENY_DEFAULTS.has(obj.defaultAction)) {
    const syscalls = Array.isArray(obj.syscalls) ? (obj.syscalls as unknown[]) : [];
    const hasDenyRule = syscalls.some((rule) => {
      if (!rule || typeof rule !== "object") return false;
      const action = (rule as { action?: unknown }).action;
      return typeof action === "string" && SECCOMP_DENY_DEFAULTS.has(action);
    });
    if (!hasDenyRule) {
      throw new SupervisorError(
        "InvalidArgument",
        `seccompProfileJson.defaultAction=${obj.defaultAction} and no syscall rule uses a deny action (${[...SECCOMP_DENY_DEFAULTS].join("/")}); profile is effectively unconfined`,
      );
    }
  }
  return `seccomp=${trimmed}`;
}

/** extraEnv 注入前的合法性检查:key 合法 / 不覆盖 supervisor 的保留前缀 */
// env key 允许 A-Z/0-9/_,也允许全小写(proxy env 标准格式是小写 http_proxy)。
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * supervisor 自己注入的 proxy env 禁止被 extraEnv 覆盖或清空。
 * 包括大小写两种标准变量(Node/curl/git 各自认不同大小写),以及 NO_PROXY
 * —— 否则调用方传 `NO_PROXY=*` 就能绕过代理(fail open)。
 */
const RESERVED_PROXY_ENV_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "FTP_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "ftp_proxy",
  "no_proxy",
]);
function sanitizeExtraEnv(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(k)) {
      throw new SupervisorError("InvalidArgument", `invalid env key: ${JSON.stringify(k)}`);
    }
    if (k.startsWith("OC_")) {
      // 留给 supervisor 注入身份信息,禁止上层覆盖
      throw new SupervisorError(
        "InvalidArgument",
        `env key ${k} is reserved (prefix OC_ is managed by supervisor)`,
      );
    }
    if (RESERVED_PROXY_ENV_KEYS.has(k)) {
      throw new SupervisorError(
        "InvalidArgument",
        `env key ${k} is reserved (proxy env is managed by supervisor per 05-SEC §13; cannot be overridden or cleared by caller)`,
      );
    }
    if (typeof v !== "string") {
      throw new SupervisorError("InvalidArgument", `env value for ${k} must be string`);
    }
    out.push(`${k}=${v}`);
  }
  return out;
}

/**
 * T-52 —— RPC socket host 目录校验 + 每用户子目录准备。
 *
 * fail closed:非绝对路径 / 空 / `/` / 含 `..` 一律拒绝。不是为了防攻击者(这个值
 * 来自 Gateway 配置,非用户输入),而是防 lifecycle 层一个粗心就把整个 `/` bind
 * 进容器。
 *
 * 返回容器内 bind mount 的 host 路径 `${rpcSocketHostDir}/u{uid}`,以及 socket 文件
 * 的完整路径(caller 用来 createConnection)。
 *
 * 目录创建失败(EACCES 等) → InvalidArgument,把错误往上抛;chown 失败只 warn
 * 不拒,允许测试在非 root 下跑(tmp 目录已被当前进程拥有)。
 */
function prepareRpcSocketDir(rpcSocketHostDir: string, uid: number): {
  hostPath: string;
  socketFile: string;
} {
  if (typeof rpcSocketHostDir !== "string" || rpcSocketHostDir.trim() === "") {
    throw new SupervisorError(
      "InvalidArgument",
      "rpcSocketHostDir is required (non-empty string)",
    );
  }
  if (!path.isAbsolute(rpcSocketHostDir)) {
    throw new SupervisorError(
      "InvalidArgument",
      `rpcSocketHostDir must be absolute path, got ${rpcSocketHostDir}`,
    );
  }
  if (rpcSocketHostDir === "/") {
    throw new SupervisorError(
      "InvalidArgument",
      "rpcSocketHostDir='/' is refused (would mount entire filesystem root)",
    );
  }
  // 防御:路径中含 `..` 容易造成父目录逃逸
  if (rpcSocketHostDir.split(path.sep).some((seg) => seg === "..")) {
    throw new SupervisorError(
      "InvalidArgument",
      `rpcSocketHostDir must not contain '..' segments, got ${rpcSocketHostDir}`,
    );
  }

  const hostPath = path.join(rpcSocketHostDir, `u${uid}`);
  try {
    fs.mkdirSync(hostPath, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new SupervisorError(
      "InvalidArgument",
      `failed to mkdir ${hostPath}: ${(err as Error).message}`,
    );
  }
  // 容器内 agent 以 1000:1000 跑,需要写该目录才能创建 agent.sock。
  // chown 可能失败(非 root;或 tmpfs 拒绝),失败只吞掉 —— 落地环境下 gateway
  // 进程以 root 运行,这里一定能 chown。
  try {
    fs.chownSync(hostPath, 1000, 1000);
  } catch {
    /* best-effort;测试场景下 caller 通常已经拥有此目录 */
  }

  return {
    hostPath,
    socketFile: path.join(hostPath, "agent.sock"),
  };
}

// ------------------------------------------------------------
//  核心 API
// ------------------------------------------------------------

/**
 * 创建并启动一个用户 agent 容器。
 *
 * 步骤:
 *   1. 确保 agent bridge 网络存在(幂等)
 *   2. 确保用户的两个 volume 存在(幂等)
 *   3. docker create (按 05-SEC §13 加硬约束) → start
 *
 * 语义:若同名容器已存在 → 抛 `NameConflict`,由上层决定是先 remove 还是返回 409。
 *       **不**自动 remove-then-create,因为那会丢用户状态。
 */
export async function createContainer(
  docker: Docker,
  uid: number,
  opts: ProvisionOptions & { image: string; network: string },
): Promise<ProvisionResult> {
  const name = containerNameFor(uid);

  if (RESERVED_NETWORK_NAMES.has(opts.network)) {
    throw new SupervisorError(
      "InvalidArgument",
      `network name ${opts.network} is reserved (docker built-in), must use a dedicated bridge`,
    );
  }

  if (typeof opts.proxyUrl !== "string" || opts.proxyUrl.trim() === "") {
    throw new SupervisorError(
      "InvalidArgument",
      "proxyUrl is required (05-SEC §13 mandates egress through transparent proxy)",
    );
  }

  const memoryMb = sanitizePositiveInt(opts.memoryMb, DEFAULT_MEMORY_MB, 4096, "memoryMb");
  const cpus = sanitizePositiveFloat(opts.cpus, DEFAULT_CPUS, 8, "cpus");
  const pidsLimit = sanitizePositiveInt(opts.pidsLimit, DEFAULT_PIDS_LIMIT, 4096, "pidsLimit");
  const tmpfsTmpMb = sanitizePositiveInt(opts.tmpfsTmpMb, DEFAULT_TMPFS_TMP_MB, 1024, "tmpfsTmpMb");
  const extraEnv = sanitizeExtraEnv(opts.extraEnv);
  const seccompOpt = normalizeSeccompOption(opts.seccompProfileJson);
  // T-52:校验 rpcSocketHostDir + 建立 host 子目录 + chown 到 agent uid
  const rpcSocket = prepareRpcSocketDir(opts.rpcSocketHostDir, uid);

  const memoryBytes = memoryMb * MIB;
  const nanoCpus = Math.floor(cpus * NANO_CPU_PER_CPU);
  const tmpfsTmpBytes = tmpfsTmpMb * MIB;

  const volNames = volumeNamesFor(uid);

  // Env 注入顺序:
  //   - 先放用户 extraEnv(已被 sanitizeExtraEnv 拒绝了 OC_* 和 *PROXY* 保留键)
  //   - 再放 supervisor 的身份/代理/网络变量 —— 放在最后,是"万一 sanitize 漏掉
  //     某个大小写/别名"也能赢的 defense-in-depth:docker 取 Env 数组里同名键
  //     的最后一项
  //
  // 注:HTTP_PROXY env 只是"合作式"约束,容器内 malicious code 可以忽略
  // 并直接开 raw socket。真正的出口控制由 T-51 镜像中的透明代理 + iptables
  // 负责,T-50 supervisor 层的契约是:必须接到合法 proxyUrl 才开容器(fail closed)。
  const env: string[] = [...extraEnv];
  env.push(`OC_UID=${uid}`);
  // 大写 + 小写都塞,Node / curl / git 各自约定不同
  env.push(`HTTP_PROXY=${opts.proxyUrl}`);
  env.push(`HTTPS_PROXY=${opts.proxyUrl}`);
  env.push(`http_proxy=${opts.proxyUrl}`);
  env.push(`https_proxy=${opts.proxyUrl}`);
  // 不走代理的目标:localhost(容器内)
  env.push("NO_PROXY=localhost,127.0.0.1");
  // 商用版容器:跳过 personal-version 默认 cron jobs(daily-reflection /
  // weekly-curation / skill-check / heartbeat)的首次 seed,避免没人交互时也
  // 自动烧 credits。处理逻辑见 packages/gateway/src/cron.ts::ensureCronFile。
  env.push("OC_SEED_DEFAULT_CRON=0");

  try {
    // 网络 / volume 预创建放到 try 里,socket 级错误(ENOENT/ECONNREFUSED)
    // 才能被 wrapDockerError 归类成 DockerUnavailable。
    await ensureAgentNetwork(docker, opts.network);
    await ensureUserVolumes(docker, uid);

    // 05-SEC §13 硬约束:
    //   - ReadonlyRootfs + tmpfs /tmp + 两个 volume 可写
    //   - CapDrop=ALL(base image 是 node:22-slim,不需要任何 cap)
    //   - SecurityOpt=no-new-privileges + seccomp 自定义白名单(若调用方提供 JSON)
    //   - PidsLimit / Memory / NanoCpus 限额
    //   - NetworkMode=指定 bridge,不给 host / default bridge / none
    //   - User: supervisor 强制 1000:1000(不再信镜像的 USER 指令,防回归)
    const container = await docker.createContainer({
      name,
      Image: opts.image,
      Env: env,
      // 容器内非 root 运行(05-SEC §13)。
      // 即使 T-51 的 Dockerfile 里 USER 被误删,supervisor 层也不会把进程跑成 root。
      User: AGENT_USER,
      Labels: {
        [MANAGED_LABEL_KEY]: "1",
        "com.openclaude.uid": String(uid),
      },
      // 不给 stdin,不给 tty —— RPC 走 unix socket,不需要终端
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
      OpenStdin: false,
      NetworkingConfig: {
        EndpointsConfig: {
          [opts.network]: {},
        },
      },
      HostConfig: {
        // 资源
        Memory: memoryBytes,
        // MemorySwap == Memory → 禁 swap;若 < 0 或省略,可能被 docker 配成 2×Memory
        MemorySwap: memoryBytes,
        MemorySwappiness: 0,
        NanoCpus: nanoCpus,
        PidsLimit: pidsLimit,
        // 安全
        CapDrop: ["ALL"],
        CapAdd: [],
        // no-new-privileges + 自定义 seccomp 白名单(必填,上面 normalizeSeccompOption 已校验)
        SecurityOpt: ["no-new-privileges", seccompOpt],
        ReadonlyRootfs: true,
        // 挂载 —— 01-SPEC F-5.4 + 05-SEC §13:只 /workspace 和 /root 可写
        Tmpfs: {
          "/tmp": `rw,nosuid,nodev,noexec,size=${tmpfsTmpBytes}`,
        },
        Binds: [
          `${volNames.workspace}:/workspace:rw`,
          `${volNames.home}:/root:rw`,
          // T-52:把 host 上的 per-user 子目录挂进容器,里边的 agent.sock
          // 是 Gateway /ws/agent 与容器内 RPC server 的桥梁。
          `${rpcSocket.hostPath}:/var/run/agent-rpc:rw`,
        ],
        // 网络 —— 强制走 agent-net,不继承 host,不用默认 bridge
        NetworkMode: opts.network,
        // 重启策略:supervisor 进程退出就别自动起了,让 gateway 显式接管
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
        // 禁止写 /dev/shm 变大导致 OOM 绕过
        ShmSize: 64 * MIB,
        // 禁止 privileged(docker 默认 false,显式写出来是为了 grep 时能看到)
        Privileged: false,
        // UsernsMode:不启用 userns remap,采用 daemon 默认。
        // 这不是安全控制(那是 daemon daemon.json 的全局配置),显式写出来只是
        // 避免 dockerode 类型声明漂移时默认值变化。
        UsernsMode: "",
        // 不允许挂 /var/run/docker.sock —— 容器不能操作 docker
        // (Binds 里也没有,这里是提醒;docker daemon 本身也不会让非 privileged 访问)
      },
    });

    try {
      await container.start();
    } catch (startErr) {
      // start 失败要回滚 create,否则下次 create 会撞 NameConflict
      try {
        await container.remove({ force: true });
      } catch {
        // 清理失败就吞,留给 lifecycle GC
      }
      throw wrapDockerError(startErr);
    }

    return {
      name,
      id: container.id,
      limits: {
        memoryBytes,
        nanoCpus,
        pidsLimit,
        tmpfsTmpBytes,
      },
      rpcSocketPath: rpcSocket.socketFile,
    };
  } catch (err) {
    if (err instanceof SupervisorError) throw err;
    throw wrapDockerError(err);
  }
}

/**
 * 优雅停止一个容器。不存在则 noop(幂等)。
 * docker stop 默认 SIGTERM → 10s 后 SIGKILL,这里给 5s 就够了:
 * agent 进程应该是 stateless 的(状态在 volume 里),快速终止即可。
 */
export async function stopContainer(docker: Docker, uid: number, timeoutSec = 5): Promise<void> {
  const name = containerNameFor(uid);
  try {
    await docker.getContainer(name).stop({ t: timeoutSec });
  } catch (err) {
    if (isNotFound(err)) return;
    if (isNotModified(err)) return; // 304:已经停了
    throw wrapDockerError(err);
  }
}

/**
 * 删除一个容器。force=true 是安全的:lifecycle 调 remove 之前已经调过 stop,
 * 这里 force 只是为了处理 stop 成功但 remove 慢一步时 container 又 auto-start
 * 的极端情况(虽然我们禁了 RestartPolicy,防御性处理一下)。
 */
export async function removeContainer(docker: Docker, uid: number): Promise<void> {
  const name = containerNameFor(uid);
  try {
    await docker.getContainer(name).remove({ force: true });
  } catch (err) {
    if (isNotFound(err)) return;
    throw wrapDockerError(err);
  }
}

/**
 * 查询容器状态。missing 不是错误。
 */
export async function getContainerStatus(docker: Docker, uid: number): Promise<ContainerStatus> {
  const name = containerNameFor(uid);
  let info: Awaited<ReturnType<ReturnType<Docker["getContainer"]>["inspect"]>>;
  try {
    info = await docker.getContainer(name).inspect();
  } catch (err) {
    if (isNotFound(err)) {
      return {
        name,
        id: "",
        state: "missing",
        dockerStatus: null,
        exitCode: null,
        startedAt: null,
      };
    }
    throw wrapDockerError(err);
  }
  const s = info.State;
  const running = Boolean(s && s.Running);
  return {
    name,
    id: info.Id,
    state: running ? "running" : "stopped",
    dockerStatus: s?.Status ?? null,
    exitCode: typeof s?.ExitCode === "number" ? s.ExitCode : null,
    startedAt: s?.StartedAt && s.StartedAt !== "0001-01-01T00:00:00Z" ? s.StartedAt : null,
  };
}

// ------------------------------------------------------------
//  错误分类
// ------------------------------------------------------------

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "statusCode" in err && (err as { statusCode: number }).statusCode === 404;
}
function isNotModified(err: unknown): boolean {
  return typeof err === "object" && err !== null && "statusCode" in err && (err as { statusCode: number }).statusCode === 304;
}

/**
 * 把 dockerode / node http 错误归类成 SupervisorError。
 * 上层可以按 code 分支处理。
 */
function wrapDockerError(err: unknown): SupervisorError {
  if (err instanceof SupervisorError) return err;

  // dockerode 的 statusCode 在 err.statusCode / err.json.message
  const e = err as { statusCode?: number; message?: string; code?: string; errno?: string };
  const statusCode = typeof e.statusCode === "number" ? e.statusCode : undefined;
  const message = typeof e.message === "string" ? e.message : String(err);

  // Node socket 级错误:docker 没启 / socket 权限不够
  if (e.code === "ENOENT" || e.code === "EACCES" || e.code === "ECONNREFUSED") {
    return new SupervisorError("DockerUnavailable", `docker daemon unreachable: ${message}`, { message });
  }

  if (statusCode === 404) {
    // 区分是镜像 404 还是容器 404;dockerode 两种都抛 statusCode=404。
    // 用关键字粗筛:仅在 createContainer 路径里才看 "No such image"。
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
