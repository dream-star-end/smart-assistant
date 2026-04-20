import { z } from "zod";

/**
 * 商业化模块的环境变量 schema。
 *
 * 本文件按 task 增量扩展:T-01 阶段只声明 DB / Redis / COMMERCIAL_ENABLED。
 * 后续 task 加入的字段(JWT_SECRET, OPENCLAUDE_KMS_KEY, HUPIJIAO_* 等)
 * 在对应 task 中补入,测试同步增加。
 *
 * 参见 docs/commercial/02-ARCHITECTURE §6.
 */

/**
 * 构造一个带协议白名单的 URL 校验器。
 *
 * 仅 `.url()` 会放过 `http://` / `ftp://` / `file://` 等协议,对基础设施 URL
 * 是安全隐患(例如有人写错成 http://... 的 DATABASE_URL,错误延迟到运行期)。
 * 这里显式收紧,05-SECURITY §7 要求的"显式边界"。
 */
function urlStringWithProtocols(allowedProtocols: ReadonlyArray<string>, field: string) {
  return z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .url()
    .refine(
      (v) => {
        try {
          return allowedProtocols.includes(new URL(v).protocol);
        } catch {
          return false;
        }
      },
      `${field} must use one of: ${allowedProtocols.map((p) => `${p}//`).join(", ")}`,
    );
}

const databaseUrl = urlStringWithProtocols(["postgres:", "postgresql:"], "DATABASE_URL");
const redisUrl = urlStringWithProtocols(["redis:", "rediss:"], "REDIS_URL");

/**
 * 仅接受 `undefined | "0" | "1"`。
 * 任何其他值(包括 "true"、"yes"、"01"、空串等)直接视为非法,抛 ConfigError。
 * 故意从严:避免误开启商业化模块、也避免部署错误被静默掩盖。
 */
const enabledFlag = z
  .enum(["0", "1"])
  .optional()
  .transform((v) => v === "1");

/**
 * Turnstile secret(Cloudflare 的 server-side key)。
 * - 生产:必填,真实 secret
 * - 测试/开发:`TURNSTILE_TEST_BYPASS=1` 时允许该字段为空,跳过远程校验
 *
 * 这里只校验"如果给了,必须非空 trim 后";具体 bypass 逻辑由 turnstile 模块判断。
 */
const turnstileSecret = z.string().trim().min(1).optional();

const turnstileBypass = z.enum(["0", "1"]).optional().transform((v) => v === "1");

/**
 * 虎皮椒支付相关(T-24)。所有字段 **optional** —— 商业化可以先不开支付功能,
 * 路由层在 deps 缺失时返 503。生产上线前必须配好,否则 /api/payment/hupi/* 全报错。
 */
const hupiAppId = z.string().trim().min(1).max(128).optional();
const hupiAppSecret = z.string().trim().min(1).max(256).optional();
const hupiCallbackUrl = urlStringWithProtocols(["http:", "https:"], "HUPIJIAO_CALLBACK_URL").optional();
const hupiReturnUrl = urlStringWithProtocols(["http:", "https:"], "HUPIJIAO_RETURN_URL").optional();
const hupiEndpoint = urlStringWithProtocols(["http:", "https:"], "HUPIJIAO_ENDPOINT").optional();

/**
 * Agent 沙箱配置(T-50)。
 *
 * - `AGENT_IMAGE`:容器镜像名(T-51 构建 `openclaude/agent-runtime:latest`)
 * - `AGENT_NETWORK`:Gateway 会自动创建一个独立 bridge 网络,隔离 host,默认 `agent-net`
 * - `AGENT_DOCKER_SOCKET`:默认走 dockerode 的默认路径(`/var/run/docker.sock`),
 *   测试环境可以指向 rootless / DinD socket。
 * - `AGENT_MEMORY_MB` / `AGENT_CPUS` / `AGENT_PIDS_LIMIT`:资源上限,给小值避免
 *   一个异常容器压垮宿主。缺省对齐 05-SEC §13。
 *
 * 所有字段都 optional,只在真正 provision 容器的路径要求非空 —— chat 路径
 * 不需要 agent sandbox,也就不应该因为这些 env 没配而启动失败。
 */
const agentImage = z.string().trim().min(1).max(256).optional();
/**
 * AGENT_NETWORK:
 * - 必须是合法 docker network 名
 * - **禁止** `bridge` / `host` / `none` / `default` —— 这些是 docker 内建网络,
 *   挂上去就破坏了沙箱隔离(05-SEC §13)
 */
const AGENT_NETWORK_RESERVED = new Set(["bridge", "host", "none", "default"]);
const agentNetwork = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, "AGENT_NETWORK must be a valid docker network name")
  .refine(
    (v) => !AGENT_NETWORK_RESERVED.has(v),
    "AGENT_NETWORK cannot be a docker built-in network (bridge/host/none/default)",
  )
  .optional();
const agentDockerSocket = z.string().trim().min(1).max(512).optional();
/**
 * 资源上限字段。zod 解析 env 时先走 string,再 coerce 成 int,拒绝负数/0/非整数。
 * 上限故意设得保守(单机共跑 20 容器 × 512MB = 10GB,已经接近 38.55 的上限)。
 */
const positiveInt = (max: number) =>
  z
    .string()
    .regex(/^\d+$/, "must be a positive integer")
    .transform((v) => Number.parseInt(v, 10))
    .refine((n) => n > 0 && n <= max, `must be in (0, ${max}]`)
    .optional();
const agentMemoryMb = positiveInt(4096); // 最多 4GB/容器
const agentPidsLimit = positiveInt(4096);
const agentCpus = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "AGENT_CPUS must be a positive number")
  .transform((v) => Number.parseFloat(v))
  .refine((n) => n > 0 && n <= 8, "AGENT_CPUS must be in (0, 8]")
  .optional();

/**
 * `AGENT_PROXY_URL`:T-50 supervisor 要求 fail-closed 的透明代理 URL(05-SEC §13 /
 * 01-SPEC F-5.2)。配在 env 里由 T-53 lifecycle 读出来透传给 supervisor,
 * 本 schema 负责格式校验(必须是 http/https URL)。保持 optional:chat 路径不开 agent
 * 时不应因缺此项启动失败;但 T-53 `provision` 会在未配时返 503。
 */
const agentProxyUrl = urlStringWithProtocols(["http:", "https:"], "AGENT_PROXY_URL").optional();

/**
 * T-53:
 * - `AGENT_SECCOMP_PATH`:agent_seccomp.json 的绝对路径;启动时 readFile 拿 JSON 内容
 *   传给 supervisor。未配 → 无法 open agent(/api/agent/open 返 503)。
 * - `AGENT_RPC_SOCKET_DIR`:RPC unix socket 在 host 上的父目录(T-52 bind mount
 *   `${dir}/u{uid}/agent.sock`);启动时 mkdir 递归建;未配 → 503。
 * - `AGENT_PLAN_PRICE_CREDITS`:订阅价格(单位:分),默认 2900(¥29)。
 *   CHECK 白名单 [1, 1_000_000_000] —— 允许压测场景改便宜,不允许 0 或负
 *   (以及荒唐地大)。
 * - `AGENT_PLAN_DURATION_DAYS`:订阅周期,默认 30。范围 [1, 365]。
 * - `AGENT_VOLUME_GC_DAYS`:订阅到期后 volume 保留多少天,默认 30。范围 [1, 365]。
 * - `AGENT_LIFECYCLE_TICK_MS`:lifecycle 扫描间隔,默认 3_600_000(1 小时)。
 *   范围 [60_000, 86_400_000] — 至少 1 分钟,至多 1 天。
 */
const absolutePath = (field: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .refine((v) => v.startsWith("/"), `${field} must be absolute (start with /)`)
    .refine((v) => !v.split("/").some((seg) => seg === ".."), `${field} must not contain '..'`)
    .optional();

const agentSeccompPath = absolutePath("AGENT_SECCOMP_PATH");
const agentRpcSocketDir = absolutePath("AGENT_RPC_SOCKET_DIR");

const agentPlanPriceCredits = z
  .string()
  .regex(/^\d+$/, "AGENT_PLAN_PRICE_CREDITS must be a non-negative integer")
  .transform((v) => BigInt(v))
  .refine((n) => n > 0n && n <= 1_000_000_000n, "AGENT_PLAN_PRICE_CREDITS must be in (0, 1_000_000_000]")
  .optional();
const agentPlanDurationDays = positiveInt(365);
const agentVolumeGcDays = positiveInt(365);
const agentLifecycleTickMs = z
  .string()
  .regex(/^\d+$/, "AGENT_LIFECYCLE_TICK_MS must be a positive integer")
  .transform((v) => Number.parseInt(v, 10))
  .refine((n) => n >= 60_000 && n <= 86_400_000, "AGENT_LIFECYCLE_TICK_MS must be in [60_000, 86_400_000]")
  .optional();

/**
 * V3 Phase 2 Task 2H: Anthropic 中央代理(2D)的内部监听地址。
 *
 * 拓扑:容器内 OpenClaude → POST http://${INTERNAL_PROXY_BIND}:${INTERNAL_PROXY_PORT}/v1/messages
 *
 * 推荐生产值: `INTERNAL_PROXY_BIND=172.30.0.1` `INTERNAL_PROXY_PORT=18791`
 *   ↑ docker bridge `openclaude-v3-net` 的网关地址(2J-1 ufw 已兜底:仅 172.30.0.0/16 入向)
 *
 * **没有代码 default**(both fields `.optional()`)—— env 缺失则代理静默不启动,
 * 仅 `/api/admin/anthropic-proxy/*` 报状态。Ops/部署脚本必须显式注入。
 * 单机 dev 可换 `127.0.0.1` 端口探活,但绝不允许 wildcard。
 *
 * **绝不允许 0.0.0.0 / ::** —— 那等于把内部代理裸暴公网,配合 verifyContainerIdentity
 * 的 peerIp 因子被任意伪造。如果检测到 wildcard bind 直接抛 ConfigError。
 */
const INTERNAL_BIND_FORBIDDEN = new Set(["0.0.0.0", "::", "*"]);
const internalProxyBind = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (v) => !INTERNAL_BIND_FORBIDDEN.has(v),
    "INTERNAL_PROXY_BIND must not be 0.0.0.0/::; bind to docker bridge IP only",
  )
  .optional();
const internalProxyPort = z
  .string()
  .regex(/^\d+$/, "INTERNAL_PROXY_PORT must be a positive integer")
  .transform((v) => Number.parseInt(v, 10))
  .refine((n) => n > 0 && n < 65536, "INTERNAL_PROXY_PORT must be in (0, 65535]")
  .optional();

/**
 * V3 Phase 3D — per-user openclaude-runtime 镜像名(含 tag)。
 *
 * 例:`openclaude/openclaude-runtime:abc123def456`(由 build-image.sh 输出 git sha12)。
 *
 * **为什么独立字段、不复用 AGENT_IMAGE**:
 *   - AGENT_IMAGE 是 v2 路线的 claude-code agent 镜像(ReadonlyRootfs + tinyproxy 那套);
 *     v3 完全独立的 openclaude-runtime,字段语义不同,放一起会让运维误以为可以共用。
 *   - 两套镜像并行存在期间,allow 任意一个独立配 / 禁,互不影响。
 *
 * 缺失 / 空时:v3 supervisor 不装配,bridge 仍按 stub `supervisor_not_wired` 返 4503。
 * 部署清单(Phase 5)会显式注入这个 env 才能跑 v3 容器。
 */
const ocRuntimeImage = z.string().trim().min(1).max(256).optional();

export const commercialConfigSchema = z
  .object({
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    COMMERCIAL_ENABLED: enabledFlag,
    TURNSTILE_SECRET: turnstileSecret,
    TURNSTILE_TEST_BYPASS: turnstileBypass,
    /** 1 → 强制 email_verified=true 才能登录 */
    REQUIRE_EMAIL_VERIFIED: z.enum(["0", "1"]).optional().transform((v) => v === "1"),
    HUPIJIAO_APP_ID: hupiAppId,
    HUPIJIAO_APP_SECRET: hupiAppSecret,
    HUPIJIAO_CALLBACK_URL: hupiCallbackUrl,
    HUPIJIAO_RETURN_URL: hupiReturnUrl,
    HUPIJIAO_ENDPOINT: hupiEndpoint,
    AGENT_IMAGE: agentImage,
    AGENT_NETWORK: agentNetwork,
    AGENT_DOCKER_SOCKET: agentDockerSocket,
    AGENT_MEMORY_MB: agentMemoryMb,
    AGENT_CPUS: agentCpus,
    AGENT_PIDS_LIMIT: agentPidsLimit,
    AGENT_PROXY_URL: agentProxyUrl,
    AGENT_SECCOMP_PATH: agentSeccompPath,
    AGENT_RPC_SOCKET_DIR: agentRpcSocketDir,
    AGENT_PLAN_PRICE_CREDITS: agentPlanPriceCredits,
    AGENT_PLAN_DURATION_DAYS: agentPlanDurationDays,
    AGENT_VOLUME_GC_DAYS: agentVolumeGcDays,
    AGENT_LIFECYCLE_TICK_MS: agentLifecycleTickMs,
    INTERNAL_PROXY_BIND: internalProxyBind,
    INTERNAL_PROXY_PORT: internalProxyPort,
    OC_RUNTIME_IMAGE: ocRuntimeImage,
  })
  .superRefine((cfg, ctx) => {
    // "给了一个就都得给":APP_ID / APP_SECRET / CALLBACK_URL 三件套要么全空要么全有。
    // 避免 "半配置" 导致运维以为开了支付但实际不通。
    const hupiTriplet: ReadonlyArray<[string, unknown]> = [
      ["HUPIJIAO_APP_ID", cfg.HUPIJIAO_APP_ID],
      ["HUPIJIAO_APP_SECRET", cfg.HUPIJIAO_APP_SECRET],
      ["HUPIJIAO_CALLBACK_URL", cfg.HUPIJIAO_CALLBACK_URL],
    ];
    const set = hupiTriplet.filter(([, v]) => v !== undefined).length;
    if (set > 0 && set < hupiTriplet.length) {
      for (const [key, v] of hupiTriplet) {
        if (v === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} required when other HUPIJIAO_* fields are set`,
          });
        }
      }
    }
  });

export type CommercialConfig = z.infer<typeof commercialConfigSchema>;

/**
 * ConfigError — env 解析失败时抛出。
 *
 * 消息只包含字段名和约束类型,不回显任何原始值,避免 secrets 泄露(05-SECURITY §16)。
 */
export class ConfigError extends Error {
  readonly issues: ReadonlyArray<{ path: string; code: string; message: string }>;

  constructor(issues: ReadonlyArray<{ path: string; code: string; message: string }>) {
    const summary = issues
      .map((i) => `${i.path}: ${i.message}`)
      .join("; ");
    super(`Invalid commercial config: ${summary}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/**
 * 从给定的 env 对象解析配置。
 * 默认从 process.env 读;测试可显式传入。
 *
 * 注:不做单例缓存(各调用方若需要缓存自行处理),便于测试隔离。
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): CommercialConfig {
  const result = commercialConfigSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join("."),
      code: i.code,
      // i.message 由 zod 生成,不包含实际值,复用安全
      message: i.message,
    }));
    throw new ConfigError(issues);
  }
  return result.data;
}
