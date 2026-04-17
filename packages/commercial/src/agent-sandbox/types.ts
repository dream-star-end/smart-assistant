/**
 * Agent sandbox 类型定义。
 *
 * 独立出来是为了让 supervisor / volumes / network / lifecycle 等文件
 * 都共享同一套类型,避免循环 import。
 */

/**
 * 容器运行时选项。由 T-53 的 lifecycle 层根据订阅信息决定,
 * supervisor 只负责照着落到 docker。
 *
 * 对齐 05-SEC §13:
 * - memoryMb / cpus / pidsLimit / tmpfsTmpMb 都有默认,但可以按 plan 覆盖
 * - extraEnv 不覆盖 supervisor 自己设置的 `OC_UID` / 代理 env,避免容器
 *   伪造自己的身份
 */
export type ProvisionOptions = {
  /** 镜像 tag,默认取 config.AGENT_IMAGE */
  image?: string;
  /** 网络名,默认取 config.AGENT_NETWORK */
  network?: string;
  /** 单容器内存上限(MB),默认 384(01-SPEC F-5.2 / 05-SEC §13) */
  memoryMb?: number;
  /** CPU 份额(docker --cpus),默认 0.2(01-SPEC F-5.2 / 05-SEC §13) */
  cpus?: number;
  /** PID 上限,默认 200 */
  pidsLimit?: number;
  /** /tmp tmpfs 大小(MB),默认 64 */
  tmpfsTmpMb?: number;
  /** 注入给容器的环境变量(**不能**以 `OC_` 开头 —— 留给 supervisor 管理) */
  extraEnv?: Record<string, string>;
  /**
   * 透明代理 URL(05-SEC §13,01-SPEC F-5.2)。**必填**。
   *
   * 注入 `HTTP(S)_PROXY` env 给容器内 Node/curl/git;真正的出口白名单和流量
   * 拦截由 T-51 镜像里的 supervisor.sh / tinyproxy 负责落地(env 只是 hint,
   * 容器内恶意进程可以忽略 env 直接连 raw socket)。
   *
   * 之所以在 supervisor 层强制必填:fail closed。没配代理就拒绝开容器,
   * 避免出现"以为走了代理、实际 NAT 直连"的灰区。
   */
  proxyUrl: string;
  /**
   * 自定义 seccomp profile(JSON 字符串,不是路径;dockerode 会原样发给 daemon)。
   * **必填** —— 05-SEC §13 明确要求容器带 `seccomp=<agent_seccomp.json>`。
   * supervisor 层 fail closed:没传就直接拒绝,避免默认 profile 被误当成 OK。
   * 传 `"unconfined"` 会被拒绝 —— 不允许显式关闭 seccomp。
   * T-51 会在 deploy/commercial/agent-runtime/agent_seccomp.json 提供 profile;
   * T-53 的 lifecycle.provision 负责读取并传入。
   */
  seccompProfileJson: string;
};

/**
 * 容器运行状态快照。故意不把 docker inspect 原始对象透出去 ——
 * 1. 避免上层依赖 dockerode 的类型;
 * 2. 让我们有机会裁掉 inspect 里的敏感字段(env、mount 源路径等)。
 */
export type ContainerStatus = {
  /** 容器名,形如 `agent-u{uid}` */
  name: string;
  /** 容器 ID,42 位 hex */
  id: string;
  /**
   * 标准化状态:
   * - `running`:容器在跑
   * - `stopped`:退出 / 未启动 / paused(对上层都一样:不可达)
   * - `missing`:容器不存在
   */
  state: "running" | "stopped" | "missing";
  /** docker 原始 State.Status(missing 时为 null),debug 用 */
  dockerStatus: string | null;
  /** 退出码(若有) */
  exitCode: number | null;
  /** 启动时间(ISO),missing/未启动时为 null */
  startedAt: string | null;
};

/**
 * createContainer 的返回。主要是让上层拿到容器 ID 写 agent_containers 表。
 */
export type ProvisionResult = {
  name: string;
  id: string;
  /** 实际应用的资源限制(方便审计) */
  limits: {
    memoryBytes: number;
    nanoCpus: number;
    pidsLimit: number;
    tmpfsTmpBytes: number;
  };
};

/**
 * Supervisor 错误类型 —— 上层可以按需处理。
 *
 * 比如 lifecycle 收到 `ImageNotFound`,可以选择 pull 后重试;
 * 收到 `NameConflict`,可以决定是 remove-then-create 还是返回 409。
 */
export class SupervisorError extends Error {
  readonly code: SupervisorErrorCode;
  /** dockerode 原错误,仅保留 message/statusCode,不透传 stack */
  readonly cause?: { statusCode?: number; message: string };

  constructor(code: SupervisorErrorCode, message: string, cause?: { statusCode?: number; message: string }) {
    super(message);
    this.name = "SupervisorError";
    this.code = code;
    this.cause = cause;
  }
}

export type SupervisorErrorCode =
  | "ImageNotFound"
  | "NameConflict"
  | "NotFound"
  | "DockerUnavailable"
  | "InvalidArgument"
  | "Unknown";
