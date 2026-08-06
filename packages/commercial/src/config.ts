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
const modelCatalogAdminDatabaseUrl = urlStringWithProtocols(
  ["postgres:", "postgresql:"],
  "MODEL_CATALOG_ADMIN_DATABASE_URL",
).optional();
const modelAuthorityDeployDatabaseUrl = urlStringWithProtocols(
  ["postgres:", "postgresql:"],
  "MODEL_AUTHORITY_DEPLOY_DATABASE_URL",
).optional();
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
 * TURNSTILE_ENFORCE —— 人机验证**是否对真实用户强制**(默认 1 = 强制)。
 *
 * 为什么需要它、以及它和 TURNSTILE_TEST_BYPASS 的本质区别:
 * 后者自称"测试旁路、生产严禁开启",却在生产 env 里躺了很久 —— 名字撒谎、状态不可审计,
 * 所以被 loadConfig 的危险开关扫描 fail-closed 钉死。本键是**显式的产品配置**:
 * 语义诚实(就是"要不要强制")、默认强制、关闭时启动日志大声播报、并在
 * `/api/public/config` 如实下发给前端(前端据此决定渲染真 widget 还是占位 token),
 * 不存在"以为开着其实关着"的状态。
 *
 * 【当前为何在生产设为 0 —— 临时方案 + 已知债 + 偿还触发条件】
 * 2026-07-26 实测:线上 Turnstile widget 配的是 **Managed 交互模式**,
 * 有头浏览器 + 真实 Windows Chrome UA + 屏蔽 webdriver 标记,分别经机房 IP 与
 * 住宅 IP 两轮验证,**都不会自动通过**,而是弹出"请验证您是真人"复选框,
 * 且登录按钮在通过前硬禁用。即真实用户登录要多一次点击,环境受限者(国产内核 /
 * 网络受限)可能直接登不进去,而 product_friction_events 里 turnstile 相关记录为 0 条
 * —— 失败完全静默。同期滥用证据为零(4 个月内最高单日 12 注册、零限流事件)。
 * 依"任何优化不得降低用户体验"的产品红线,先关强制。
 *
 * **偿还触发条件(三条全满足才可翻回 1)**:
 *   1. Cloudflare 后台把该 widget 从 Managed 改为 Invisible / Non-Interactive;
 *   2. turnstile 结果遥测已上线(成功/失败/超时进 product_friction_events,失败率可见);
 *   3. 真机验证过鸿蒙 ArkWeb / Quark / iOS Safari 三个目标内核。
 * 在此之前注册/登录**没有人机验证**,这是明知代价的临时状态,不是遗忘。
 */
const turnstileEnforce = z
  .enum(["0", "1"])
  .optional()
  .transform((v) => v !== "0");

/**
 * TURNSTILE_BYPASS_ACCOUNTS —— 账号级人机验证白名单(2026-07-26 安全审计整改)。
 *
 * 背景:此前生产 env 挂着 `TURNSTILE_TEST_BYPASS=1`,注册/登录/找回密码三个公开
 * 入口的人机验证**全站**失效。之所以一直没敢摘,是因为 4 条生产自动化
 * (v5-e2e-journey-canary / v5-smoke-turn-canary / run-baseline-skill-evals /
 * v5-market-skill-eval)都在发 `turnstile_token:'x'` 的占位 token。
 * 根治办法不是留全局开关,而是把"旁路"从**环境级**降到**账号级**:
 * 只有白名单里的自动化账号能跳过,真实用户一律走真 widget。
 *
 * 格式:逗号分隔的邮箱,解析时 trim + 小写 + 去空。缺省 = 空表 = 谁也不能旁路。
 * 判定逻辑在 auth/turnstile.ts 的 resolveTurnstileBypass(单一权威),
 * 命中会打 `[turnstile-account-bypass]` 结构化日志留痕。
 */
const turnstileBypassAccounts = z
  .string()
  .max(4096)
  .optional()
  .transform((v): readonly string[] =>
    Object.freeze(
      (v ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    ),
  );

/**
 * Turnstile 公钥(Cloudflare 的 client-side site key)。
 * - 公开值,可被前端 `/api/public/config` 直接读出来嵌入 widget
 * - 缺失时前端 turnstile 走"占位 token"路径(配合 `TURNSTILE_TEST_BYPASS=1` 用)
 *
 * 与 TURNSTILE_SECRET 必须配套配置:secret 给了但 site_key 没给时前端无法装载 widget,
 * 走 bypass 也走不通(secret 校验真,site_key 测假)。生产部署清单(Phase 5)显式注入两侧。
 */
const turnstileSiteKey = z.string().trim().min(1).max(128).optional();

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
 * V3 Phase D — 多机容器池外部 mTLS 入口(remote node-agent L7 反代目标)。
 *
 * 拓扑:
 *   remote host 容器 → http://<bridge_gw>:18791 (plaintext)
 *     → node-agent L7 反代 → mTLS HTTPS POST https://${EXTERNAL_MTLS_BIND}:${EXTERNAL_MTLS_PORT}/v1/messages
 *     → master 读 client cert SAN URI 解出 host_uuid + fingerprint pin 查 DB
 *     → 读 `X-V3-Container-IP` 头取 bound_ip
 *     → 喂给同一个 anthropicProxy handler
 *
 * 推荐生产值:`EXTERNAL_MTLS_BIND=0.0.0.0` `EXTERNAL_MTLS_PORT=18443`
 *   — 绑公网 IP 是必需的(远程 host 要从外网拨过来),防线靠:
 *     (1) GCP firewall rule 白名单 only allow node-agent 公网 IP
 *     (2) mTLS server requestCert=true + rejectUnauthorized=true(自建 CA 私签)
 *     (3) SAN URI 匹配 spiffe://openclaude/host/<uuid>
 *     (4) compute_hosts.agent_cert_fingerprint_sha256 pin + state='ready' 每请求查
 *
 * 缺任一字段或 EXTERNAL_MTLS_ENABLED 未开 → 静默不启动,self-host 仍用 18791 plaintext。
 */
const externalMtlsBind = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .optional();
const externalMtlsPort = z
  .string()
  .regex(/^\d+$/, "EXTERNAL_MTLS_PORT must be a positive integer")
  .transform((v) => Number.parseInt(v, 10))
  .refine((n) => n > 0 && n < 65536, "EXTERNAL_MTLS_PORT must be in (0, 65535]")
  .optional();
const externalMtlsEnabled = z
  .string()
  .transform((v) => v === "1" || v.toLowerCase() === "true")
  .optional();

/**
 * V5 egress 进程解耦(2026-07-02)——根治"master 部署重启掐断在飞 LLM 生成流"。
 *
 * 拓扑(OC_EGRESS_SPLIT=1 时):
 *   容器 → http://${INTERNAL_PROXY_BIND}:${INTERNAL_PROXY_PORT}  ← **egress 进程**监听
 *     ├─ POST /v1/messages          → egress 本地 anthropicProxy(计费/账号池/上游流)
 *     └─ 其它 /internal/v3/* 等     → 透明转发 master 控制口
 *   master → 监听 ${INTERNAL_CONTROL_BIND}:${INTERNAL_CONTROL_PORT}(loopback-only)
 *   egress → master:POST /internal/v5/cost-event(cost 持久化+WS 广播回执,秘钥头)
 *
 * master 重启只断 WS/控制面(容器 ring 重放兜底),上游生成流由 egress 进程持有不受影响。
 * OC_EGRESS_SPLIT 未设 → 完全旧行为(master 进程内代理),零影响。
 */
const egressSplit = z
  .string()
  .transform((v) => v === "1" || v.toLowerCase() === "true")
  .optional();
/** master 控制口 bind(split 模式)。**只允许 loopback** —— 容器流量必须经 egress 转发
 *  (egress 会拒转 /internal/v5/* 控制专用路径),直连面越小越好。 */
const internalControlBind = z
  .string()
  .trim()
  .refine((v) => v === "127.0.0.1" || v === "::1", "INTERNAL_CONTROL_BIND must be loopback (127.0.0.1/::1)")
  .optional();
const internalControlPort = z
  .string()
  .regex(/^\d+$/, "INTERNAL_CONTROL_PORT must be a positive integer")
  .transform((v) => Number.parseInt(v, 10))
  .refine((n) => n > 0 && n < 65536, "INTERNAL_CONTROL_PORT must be in (0, 65535]")
  .optional();
/** egress → master 控制口调用的共享秘钥(两进程共用同一 env 文件,天然同值)。
 *  防"容器经 egress 转发面伪造控制调用"(egress 端也有 /internal/v5/* deny,双保险)。 */
const egressSecret = z.string().trim().min(16).optional();

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

/**
 * V5 runtime tuple 热生效改造(docs/V5_RUNTIME_HOTCFG_PLAN.md §1)。全 optional ——
 * v3 / 未开热生效时缺失,supervisor 走旧路径零行为变化;v5 生产由 deploy-v5.sh 激活 saga
 * 注入完整 tuple(env + current 翻转)。
 *
 *   - OC_RUNTIME_IMAGE_ID:部署验证过的 immutable image ID(sha256:...)。缺省 → runtimeStale
 *     回落 tag 比较(**部署后必填**,否则同 tag 重指新镜像漏判)。不强制 sha256: 前缀格式
 *     (docker daemon 版本文案有差异),仅非空。
 *   - OC_PLATFORM_BUNDLE:bundles/<bundleRev12> 绝对路径(内容 digest 命名,不可变)。
 *   - OC_RUNTIME_RELEASE:releases/rel-<digest12> 绝对路径(源码树 + node_modules + ccb dist)。
 *   - OC_PLATFORM_ROOT / OC_RUNTIME_RELEASES_ROOT:稳定根 / releases 根覆盖(默认见 platformBundle.ts
 *     DEFAULT_PLATFORM_ROOT / DEFAULT_RUNTIME_RELEASES_ROOT);一般不配,测试 / 非标准布局才覆盖。
 *   - OC_RUNTIME_EMERGENCY_TUPLE:一条完整 pinned tuple 的不透明快照(plan §1.1 R2-M6),
 *     由 deploy checklist 维护;master 不解析内容,仅透传 / 记录(GC 保护集 / 回滚锚点)。
 *   - OC_PLATFORM_BUNDLE_OPTIONAL:dev 逃生开关(0/1)。生产禁;缺 bundle 时 warn+跳过而非 fail-closed。
 *     实际 gate 由 supervisor readPlatformBundleOptionalFromEnv 直读 process.env(与 baseline OPTIONAL
 *     同范式);此处仅纳入 schema 做校验/文档化。
 */
const ocRuntimeImageId = z.string().trim().min(1).max(256).optional();
const ocPlatformBundle = absolutePath("OC_PLATFORM_BUNDLE");
const ocRuntimeRelease = z.preprocess(
  (v) => typeof v === "string" && v.trim() === "" ? undefined : v,
  absolutePath("OC_RUNTIME_RELEASE"),
);
const ocPlatformRoot = absolutePath("OC_PLATFORM_ROOT");
const ocRuntimeReleasesRoot = absolutePath("OC_RUNTIME_RELEASES_ROOT");
const ocRuntimeEmergencyTuple = z.string().trim().min(1).max(2048).optional();
const ocPlatformBundleOptional = z.enum(["0", "1"]).optional().transform((v) => v === "1");

/**
 * v3 file proxy feature flag —— 开启后 /api/file / /api/media/* 的 GET 会走
 * `containerFileProxy` 代理到用户容器。OFF(默认) = 继续走 `BLOCKED_FOR_USER_RULES`
 * 返 403,与上线前一致。
 *
 * 4 阶段部署节奏见 v3-file-return-spec-mvp.md §5,最后一步才翻 ON。
 */
const fileProxyEnabled = z.enum(["0", "1"]).optional().transform((v) => v === "1");

/**
 * 远程执行机(SSH)feature flag。OFF 时 `/api/remote-hosts/*` 全部 503 FEATURE_DISABLED,
 * 前端切换器也不渲染 "远程" 选项。灰度策略:先开给 boss 账户验证,再逐步放开。
 */
const featureRemoteSsh = z.enum(["0", "1"]).optional().transform((v) => v === "1");

/**
 * R7 — Docker volume GCS backup/restore (R7.1 broker + manual CLI 阶段)。
 *
 * 详见 `docs/v3/R7-volume-gcs-backup-plan.md`。R7.1 阶段:这些 env 仅被
 * `r7-backup/cli.ts` 直接读取,**不**接入 supervisor / scheduler — 那是 R7.3+。
 *
 * 字段全 optional,任一关键字段(bucket / creds / 任一 enabled flag)缺失或显式 "0"
 * 等价于 R7 disabled,broker 主动跳过所有路径,master 主路径无任何 GCS 调用。
 *
 * 字段:
 *   - R7_GCS_BUCKET            目标 bucket 名(GCS 命名规则:3-63 字符,小写 / 数字 / 点/横线/下划线,
 *                              不允许 IPv4-like、`..`、`goog`/`google` 前缀)。
 *   - GOOGLE_APPLICATION_CREDENTIALS  GCP 标准 env;指向 service account JSON 绝对路径。
 *                              这是 GCP 通用 env,R7 复用,不强行加 R7_ 前缀。
 *   - R7_BACKUP_ENABLED        master kill-switch;"1" → backup 路径开,其它视作 OFF。
 *   - R7_RESTORE_ENABLED       master kill-switch(独立控制);"1" → restore 路径开。
 *   - R7_BACKUP_TIMEOUT_SEC    helper 单次 backup hard timeout(R7.2 才用,R7.1 仅占位)。
 *   - R7_RESTORE_TIMEOUT_SEC   helper 单次 restore hard timeout(R7.2 才用)。
 *   - R7_HELPER_IMAGE          R7.2 helper 镜像 tag,R7.1 仅 schema 占位不读。
 *
 * Bucket regex 加固原因(R7.1 plan v2 Codex round-1 finding):
 *   - GCS bucket 名规则严苛(GCP doc),手抖配错会让 R7 静默失败。在 config 层尽早拒绝。
 *   - `..` 在 path 拼接时是危险 token;IPv4-like 是 GCS 保留;`goog`/`google` 也是保留前缀。
 */
const GCS_BUCKET_FORBIDDEN_IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const r7GcsBucket = z
  .string()
  .trim()
  .min(3, "R7_GCS_BUCKET min 3 chars")
  .max(63, "R7_GCS_BUCKET max 63 chars")
  .regex(
    /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/,
    "R7_GCS_BUCKET must be lowercase letters/digits/._-, start and end with letter or digit",
  )
  .refine((v) => !v.includes(".."), "R7_GCS_BUCKET cannot contain '..'")
  .refine((v) => !GCS_BUCKET_FORBIDDEN_IPV4.test(v), "R7_GCS_BUCKET cannot be IPv4-like")
  .refine(
    (v) => !v.startsWith("goog") && !v.includes("google"),
    "R7_GCS_BUCKET cannot start with 'goog' or contain 'google' (GCS reserved)",
  )
  .optional();

const r7GcsCredentialsPath = absolutePath("GOOGLE_APPLICATION_CREDENTIALS");
const r7BackupEnabled = z.enum(["0", "1"]).optional().transform((v) => v === "1");
const r7RestoreEnabled = z.enum(["0", "1"]).optional().transform((v) => v === "1");
const r7BackupTimeoutSec = positiveInt(3600);
const r7RestoreTimeoutSec = positiveInt(3600);
const r7HelperImage = z.string().trim().min(1).max(256).optional();

/**
 * WeChat broker feature flag(P1.7 slice 7c)。OFF(默认)→
 * commercial 不装配 `makeWechatBroker`,`/internal/v3/wechat-outbound` 路径走
 * `internalProxyHandler`(返 404,因为 anthropicProxy 只接受 `/v1/messages`),
 * 容器→master 出站静默失败。ON → broker 装配 + 路由生效。
 *
 * 不与 `channels.wechat.enabled`(per-instance openclaude.json,master gateway iLink
 * 长轮询开关)混淆 — 那是 master 侧 channel adapter 开关。本 flag 是 broker 这条
 * 跨层架构(manager → broker → dispatcher → container → outbox → iLink)的总
 * 开关,broker 失败不影响 master 长轮询正常工作。
 *
 * Codex slice 7c plan PASS:flag 当前实装等价启动期开关(zod parse 一次),broker.ts
 * 的 `brokerEnabled` callback 提供未来 ConfigService 热重载注入点 — P1 不接,记 TODO。
 */
const wechatBrokerEnabled = z.enum(["0", "1"]).optional().transform((v) => v === "1");

export const commercialConfigSchema = z
  .object({
    DATABASE_URL: databaseUrl,
    /** catalog admin API 专用低权角色；模型权威开启时由启动装配强制要求。 */
    MODEL_CATALOG_ADMIN_DATABASE_URL: modelCatalogAdminDatabaseUrl,
    /** 仅 deploy-v5.sh 观察/割接使用；运行时不会打开此连接。 */
    MODEL_AUTHORITY_DEPLOY_DATABASE_URL: modelAuthorityDeployDatabaseUrl,
    REDIS_URL: redisUrl,
    COMMERCIAL_ENABLED: enabledFlag,
    /**
     * §5 JWT 验签密钥长度收口。HS256 建议 secret ≥ 32 bytes;`auth/jwt.ts` 的 async
     * 路径(secretToKey)已在用到时校验字节长度,但 `auth/jwtSync.ts`(router deny-by-default
     * 拦截热路径)直接把 raw secret 喂进 HMAC,**不**校长度 —— 短 secret 两条路径行为漂移。
     * 在此启动期 zod schema 里 fail-closed:env 里给了 COMMERCIAL_JWT_SECRET / JWT_SECRET
     * 但 < 32 字符即拒绝启动(loadConfig 在 index.ts 启动早期调用),让"短 secret"结构上
     * 不可达运行态,两条验签路径共享同一长度保证。二者都 optional:生产至少配一个(空值/
     * 缺失由 index.ts 的非空校验兜底),这里只在"给了但太短"时拒。**不 trim**:与 index.ts
     * 实际使用的 raw env 值口径一致,避免"配置校验值 ≠ 运行时值"的漂移。
     */
    COMMERCIAL_JWT_SECRET: z.string().min(32, "COMMERCIAL_JWT_SECRET must be at least 32 chars").optional(),
    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars").optional(),
    TURNSTILE_SECRET: turnstileSecret,
    TURNSTILE_TEST_BYPASS: turnstileBypass,
    /** 0 → 不对真实用户强制人机验证(显式产品配置,默认 1;见常量处的债与偿还条件) */
    TURNSTILE_ENFORCE: turnstileEnforce,
    TURNSTILE_BYPASS_ACCOUNTS: turnstileBypassAccounts,
    TURNSTILE_SITE_KEY: turnstileSiteKey,
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
    EXTERNAL_MTLS_BIND: externalMtlsBind,
    EXTERNAL_MTLS_PORT: externalMtlsPort,
    EXTERNAL_MTLS_ENABLED: externalMtlsEnabled,
    OC_EGRESS_SPLIT: egressSplit,
    INTERNAL_CONTROL_BIND: internalControlBind,
    INTERNAL_CONTROL_PORT: internalControlPort,
    OC_EGRESS_SECRET: egressSecret,
    OC_RUNTIME_IMAGE: ocRuntimeImage,
    // V5 runtime tuple 热生效改造(见上方各字段定义)。
    OC_RUNTIME_IMAGE_ID: ocRuntimeImageId,
    OC_PLATFORM_BUNDLE: ocPlatformBundle,
    OC_RUNTIME_RELEASE: ocRuntimeRelease,
    OC_PLATFORM_ROOT: ocPlatformRoot,
    OC_RUNTIME_RELEASES_ROOT: ocRuntimeReleasesRoot,
    OC_RUNTIME_EMERGENCY_TUPLE: ocRuntimeEmergencyTuple,
    OC_PLATFORM_BUNDLE_OPTIONAL: ocPlatformBundleOptional,
    FILE_PROXY_ENABLED: fileProxyEnabled,
    FEATURE_REMOTE_SSH: featureRemoteSsh,
    R7_GCS_BUCKET: r7GcsBucket,
    GOOGLE_APPLICATION_CREDENTIALS: r7GcsCredentialsPath,
    R7_BACKUP_ENABLED: r7BackupEnabled,
    R7_RESTORE_ENABLED: r7RestoreEnabled,
    R7_BACKUP_TIMEOUT_SEC: r7BackupTimeoutSec,
    R7_RESTORE_TIMEOUT_SEC: r7RestoreTimeoutSec,
    R7_HELPER_IMAGE: r7HelperImage,
    /**
     * WeChat broker P1.7 slice 7c feature flag。详见上方 `wechatBrokerEnabled` 定义。
     */
    WECHAT_BROKER_ENABLED: wechatBrokerEnabled,
    /**
     * DeepSeek API key(2026-05-02 接入)。
     * - 配置时 anthropicProxy 收到 model.startsWith('deepseek-') 的请求 → forward
     *   到 https://api.deepseek.com/anthropic/v1/messages,Authorization: Bearer
     *   <DEEPSEEK_API_KEY>;不占 claude_accounts 池
     * - 未配置 → 返回 503 + reject reason 'deepseek_config'(独立指标,不混 claude
     *   account_pool)
     * - 不入 git;由 systemd EnvironmentFile 注入(commercial-v3 部署侧)
     */
    DEEPSEEK_API_KEY: z.string().trim().min(1).max(256).optional(),
    /**
     * OpenCode Zen「Go 计划」API key(2026-07-05 接入,qwen3.7-max/plus)。
     * - 配置时 anthropicProxy 收到 model 命中 opencodego(qwen3.7-max/plus)的请求 → forward
     *   到 https://opencode.ai/zen/go/v1/messages,鉴权 `x-api-key: <OPENCODE_GO_API_KEY>`
     *   (该端点不认 Authorization Bearer);不占 claude_accounts 池
     * - 未配置 → 503 OPENCODEGO_NOT_CONFIGURED + reject 'opencodego_config'
     * - **配额是个人订阅规格**(5h/$12、周/$30、月/$60,全 v5 用户共享)。打穿后上游 429/4xx,
     *   turn 零输出走免单兜底,不误扣用户积分;不适合作平台默认模型上游。
     * - key 只在 master/egress 进程 env 存在,**绝不注入用户容器**;不入 git,由 systemd
     *   EnvironmentFile 注入(v3 base commercial.env,v5 经 deploy-v5.sh 继承)。
     */
    OPENCODE_GO_API_KEY: z.string().trim().min(1).max(256).optional(),
    /**
     * Moonshot 官方「Kimi For Coding」订阅 key(2026-07-17 接入,kimi-k3,boss 的 Allegretto 档)。
     * - 配置时 anthropicProxy 收到 model 命中 moonshot(kimi-k3)的请求 → forward 到
     *   https://api.kimi.com/coding/v1/messages,鉴权 `x-api-key: <MOONSHOT_CODING_PLAN_KEY>`;
     *   不占 claude_accounts 池。**与火山转售的 'kimi'(ARK_AGENT_PLAN_KEY)是两家上游两把 key**。
     * - 未配置 → 503 MOONSHOT_NOT_CONFIGURED + reject 'moonshot_config'
     * - **配额是个人订阅规格**(Allegretto 档,全 v5 用户共享),打穿后上游 429,turn 零输出走
     *   免单兜底;不适合作平台默认模型上游。
     * - key 只在 master/egress 进程 env 存在,**绝不注入用户容器**;不入 git,由 systemd
     *   EnvironmentFile 注入(commercial-v5.env)。
     */
    MOONSHOT_CODING_PLAN_KEY: z.string().trim().min(1).max(512).optional(),
    /**
     * 阿里云百炼 Token Plan key(2026-08-04 接入正式 qwen3.8-max)。
     * - Anthropic Messages:https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages
     * - x-api-key 鉴权；只存在于 master/egress EnvironmentFile，绝不注入用户容器或写入 git
     * - 未配置 → 503 BAILIAN_NOT_CONFIGURED + reject 'bailian_config'
     * - Token Plan 仅用于 V5 Claude Code/CCB Agent；不开放通用后端 API
     * - 已在聊天出现的 key 上线前必须在阿里控制台旋转
     */
    BAILIAN_TOKEN_PLAN_KEY: z.string().trim().min(1).max(512).optional(),
    /**
     * Deepgram Nova-3 streaming ASR key for browser voice input.
     *
     * - 只在 master-side `/ws/voice-transcribe` 使用,前端永远不见 key。
     * - 连接 Deepgram 时通过 `Authorization: Token <DEEPGRAM_API_KEY>` header,
     *   绝不放 URL query,避免 access log / browser history 泄漏。
     * - 未配置时语音 WS 返回 VOICE_NOT_CONFIGURED,前端回退浏览器内置
     *   SpeechRecognition。
     */
    DEEPGRAM_API_KEY: z.string().trim().min(1).max(512).optional(),
    VOICE_ASR_MODEL: z.string().trim().min(1).max(64).optional(),
    VOICE_ASR_LANGUAGE: z.string().trim().min(2).max(16).optional(),
    VOICE_POLISH_MODEL: z.string().trim().min(1).max(64).optional(),
    VOICE_MAX_SECONDS: positiveInt(300),
    VOICE_MAX_PER_USER: positiveInt(10),
    VOICE_MAX_GLOBAL: positiveInt(500),
    /**
     * MiniMax Token Plan 订阅 key(2026-06-02 接入)。
     * **2026-06-30 起文本/识图(MiniMax-M3 面A)已迁火山方舟 Agent Plan(改走 ARK_AGENT_PLAN_KEY),
     * 本字段仅剩 master-side `/internal/v3/minimax` 媒体 proxy(图/视频/语音/音乐/歌词)暂用;
     * 待 P2/P3 媒体也切火山后即可整体下线本字段。**
     * - 媒体 proxy:forward 到 https://api.minimaxi.com/v1/*,Authorization: Bearer <MINIMAX_TOKEN_PLAN_KEY>;
     *   用户容器只拿 oc-v3 container bearer,**永远不注入 MiniMax key**
     * - 未配置 → 媒体 proxy 503(文本/识图路由已不依赖本字段,改依赖 ARK_AGENT_PLAN_KEY)
     * - 不入 git;由 systemd EnvironmentFile 注入。用户已在聊天里暴露过的 key
     *   上线前必须在 MiniMax 控制台旋转后再写入生产 env。
    */
    MINIMAX_TOKEN_PLAN_KEY: z.string().trim().min(1).max(512).optional(),
    /** Loopback endpoint, or explicitly opted-in HTTPS endpoint, of the SCNet H3 worker. */
    MEDIA_GENERATION_WORKER_URL: urlStringWithProtocols(
      ["http:", "https:"],
      "MEDIA_GENERATION_WORKER_URL",
    )
      .optional(),
    MEDIA_GENERATION_ALLOW_REMOTE_HTTPS: z
      .enum(["0", "1"])
      .optional()
      .transform((value) => value === "1"),
    MEDIA_GENERATION_WORKER_TOKEN: z.string().trim().min(32).max(512).optional(),
    MEDIA_GENERATION_STATE_ROOT: absolutePath("MEDIA_GENERATION_STATE_ROOT"),
    MEDIA_GENERATION_MAX_INPUT_BYTES: positiveInt(1_099_511_627_776),
    MEDIA_GENERATION_MAX_USER_STORED_INPUT_BYTES: positiveInt(1_099_511_627_776),
    MEDIA_GENERATION_ALLOW_USER_IDS: z
      .string()
      .max(8192)
      .optional()
      .transform((value) =>
        Object.freeze(
          (value ?? "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      )
      .refine((values) => values.every((value) => /^\d+$/.test(value)), "user ids must be decimal"),
    /**
     * 火山方舟 Ark Coding Plan key(2026-06-15 接入)。glm-5.1 当前是 **coder 默认模型**
     * (2026-06-16 起平台默认改为 MiniMax-M3,见 platformDefaults.ts / entrypoint COMMERCIAL_DEFAULT_MODEL;
     * ark 北京端点跨境抖动,故平台默认/队长改走新加坡 MiniMax-M3,coder 保留 glm-5.1)。
     * - 配置时 anthropicProxy 收到 model 命中 ark(glm-5.1) 的请求 → forward 到
     *   https://ark.cn-beijing.volces.com/api/coding/v1/messages,Authorization: Bearer
     *   <ARK_CODING_PLAN_KEY>;不占 claude_accounts 池
     * - key 只在 master 进程环境变量中存在,**绝不注入用户容器**(用户容器只拿 oc-v3 container bearer)
     * - 未配置 → 命中 glm-5.1 的文本路由 503 ARK_NOT_CONFIGURED + reject 'ark_config'
     * - **注意:glm-5.1 不再是平台默认**,故 assertPlatformDefaultModelConfigured guard 不再硬校验本 key
     *   (它现在守 MiniMax-M3/MINIMAX_TOKEN_PLAN_KEY)。但 coder 仍依赖 ark,**部署须确保本 key 存在**,
     *   否则 coder 请求运行时 503。
     * - 不入 git;由 systemd EnvironmentFile 注入。**用户已在聊天里暴露过的 key 上线前必须在火山方舟
     *   控制台旋转后再写入生产 env。**
     */
    ARK_CODING_PLAN_KEY: z.string().trim().min(1).max(512).optional(),
    /**
     * 火山方舟 Agent Plan key(2026-06-30 接入,替换即将过期的 MiniMax)。Agent Plan 是与
     * Coding Plan(/api/coding)并列的另一档套餐(/api/plan),**同一 key 覆盖全模态**:
     * - 文本/识图(P1):model=minimax-m3 → https://ark.cn-beijing.volces.com/api/plan/v1/messages
     *   (Anthropic 兼容,Authorization: Bearer <ARK_AGENT_PLAN_KEY>);不占 claude_accounts 池
     * - 媒体(P2/P3):图 doubao-seedream-5.0-lite / 视频 doubao-seedance-1.5-pro(/api/plan/v3),
     *   语音 seed-tts-2.0(openspeech.bytedance.com,鉴权头 X-Api-Key=<ARK_AGENT_PLAN_KEY>)
     * - key 只在 master 进程,**绝不注入用户容器**(用户容器只拿 oc-v3 container bearer)
     * - 未配 → 命中 minimax provider 的文本路由 503 MINIMAX_NOT_CONFIGURED
     * - 不入 git;由 systemd EnvironmentFile 注入。**已在聊天暴露的 key,上线前必须在火山方舟控制台旋转后再写入生产 env。**
     */
    ARK_AGENT_PLAN_KEY: z.string().trim().min(1).max(512).optional(),
    /**
     * Platform HMAC secret(Phase 5 envelope rewriter,2026-05-21)。
     *
     * 用途:HMAC-SHA256(secret, "fp3:"|userId)派生外接 ApiKey 路径 outbound envelope
     * 的 fp3(3 hex char,attribution header)+ account_uuid(UUID v4,metadata.user_id)。
     * 同一 secret 必须跨多个 master 节点一致 —— 否则同一 ApiKey 在不同 master 派生出
     * 不同指纹,Anthropic anti-abuse 看到漂移会整池 429。
     *
     * 长度 ≥ 32 字符,≤ 256;实际使用 sha256 摘要,字符 vs 字节差异对 HMAC 强度无影响。
     * 不入 git;systemd EnvironmentFile 注入。未配置时 external ApiKey proxy
     * 装配失败 → 端点 503(同 hupi / deepseek 已有的"缺配置降级"语义)。
     *
     * 注:仅派生公开标识符,非加密 token。泄露最多让攻击者算出某 userId 的
     * fp3 + account_uuid,不能解 v3 任何数据。
     */
    PLATFORM_HMAC_SECRET: z.string().trim().min(32).max(256).optional(),
    // v1.0.207:`PHASE6_ACCOUNT_UUID_ENFORCE` 和 `SESSION_PIN_MODE` 这两个灰度型
    // feature flag 已迁到 `system_settings` 表(admin UI 立即可改,无需 systemctl
    // restart),具体见 `admin/runtimeFlags.ts` 和 `admin/systemSettings.ts` 的
    // `phase6_account_uuid_enforce` / `session_pin_mode` key。commercial.env 中
    // 残留这两行环境变量不影响启动(z.object 默认 strip,未声明字段被丢弃),但
    // 建议清理避免误导。
    /**
     * GitHub OAuth App 配置(GitHub OAuth 关联功能)。
     * 全部 optional — 缺失时 /api/auth/github/* 返 503,启动不阻断。
     */
    GITHUB_OAUTH_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
    GITHUB_OAUTH_REDIRECT_URI: z.string().url().optional(),
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
    if (
      (cfg.MEDIA_GENERATION_WORKER_URL === undefined) !==
      (cfg.MEDIA_GENERATION_WORKER_TOKEN === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [
          cfg.MEDIA_GENERATION_WORKER_URL === undefined
            ? "MEDIA_GENERATION_WORKER_URL"
            : "MEDIA_GENERATION_WORKER_TOKEN",
        ],
        message:
          "MEDIA_GENERATION_WORKER_URL and MEDIA_GENERATION_WORKER_TOKEN must be configured together",
      });
    }
    if (cfg.MEDIA_GENERATION_WORKER_URL !== undefined) {
      const workerUrl = new URL(cfg.MEDIA_GENERATION_WORKER_URL);
      const loopback =
        workerUrl.hostname === "127.0.0.1" ||
        workerUrl.hostname === "localhost" ||
        workerUrl.hostname === "[::1]";
      if (!loopback && workerUrl.protocol !== "https:") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["MEDIA_GENERATION_WORKER_URL"],
          message: "remote media generation worker must use HTTPS",
        });
      }
      if (!loopback && !cfg.MEDIA_GENERATION_ALLOW_REMOTE_HTTPS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["MEDIA_GENERATION_ALLOW_REMOTE_HTTPS"],
          message: "must be 1 when MEDIA_GENERATION_WORKER_URL is remote",
        });
      }
      for (const [key, value] of [
        ["MEDIA_GENERATION_MAX_INPUT_BYTES", cfg.MEDIA_GENERATION_MAX_INPUT_BYTES],
        [
          "MEDIA_GENERATION_MAX_USER_STORED_INPUT_BYTES",
          cfg.MEDIA_GENERATION_MAX_USER_STORED_INPUT_BYTES,
        ],
      ] as const) {
        if (value === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} required when MEDIA_GENERATION_WORKER_URL is configured`,
          });
        }
      }
      if (
        cfg.MEDIA_GENERATION_MAX_INPUT_BYTES !== undefined &&
        cfg.MEDIA_GENERATION_MAX_USER_STORED_INPUT_BYTES !== undefined &&
        cfg.MEDIA_GENERATION_MAX_USER_STORED_INPUT_BYTES < cfg.MEDIA_GENERATION_MAX_INPUT_BYTES
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["MEDIA_GENERATION_MAX_USER_STORED_INPUT_BYTES"],
          message: "user media input quota must be at least the per-file quota",
        });
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
 * 生产环境危险开关识别正则(2026-07-26 安全审计整改)。
 *
 * 只认**整段**为 TEST / BYPASS / INSECURE / UNSAFE 的键(下划线或首尾为边界),
 * 外加 `DEV_` 前缀。边界要求是刻意的,避免误伤两类合法键:
 *   - `*_DISABLED` 系列(OC_IDLE_SWEEP_DISABLED 等)是正经运维开关,不含上述词根;
 *   - `LATEST` / `CONTEST` 这类含子串但不成段的键不会命中。
 * 注意 `REQUIRE_TEST_DB`、`OC_TEST_*` 这类会命中——这本来就是期望行为:
 * 生产上不该出现它们。
 */
const PRODUCTION_FORBIDDEN_ENV_RE = /(^|_)(TEST|BYPASS|INSECURE|UNSAFE)(_|$)|^DEV_/;

/** 被视为"开启"的值(大小写不敏感)。只有开启才拦,挂着 =0 的历史键不影响启动。 */
const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes"]);

/**
 * 生产 fail-closed:扫描原始 env,命中"危险开关且已开启"即拒绝启动。
 *
 * 为什么必须作用在**原始 env 对象**而不是 zod 输出:zod 会 strip 掉未声明的键,
 * 而这里要拦的恰恰是"任何"危险键——包括将来别人随手加的、schema 里根本没声明的。
 * 声明式白名单挡不住"没声明"的东西,只有扫原始 env 才闭合。
 *
 * 为什么 fail-closed 而不是打个 warning:与 COMMERCIAL_JWT_SECRET min(32) 同一条
 * 先例——安全约束一旦降级成"日志里喊一声",在长期运维里等于不存在。
 * 2026-07-26 审计实测:`TURNSTILE_TEST_BYPASS=1` 在生产 env 里挂了很久,
 * 注册/登录/找回密码三个入口的人机验证全部失效,没有任何人被提醒过。
 *
 * **不设逃生开关**(与 JWT_SECRET 先例一致):留个 `ALLOW_UNSAFE_ENV=1` 之类的
 * 后门,等于把这道门本身变成下一个 TURNSTILE_TEST_BYPASS。
 *
 * 正确的替代做法:需要在生产给自动化开特例时,走**账号级**白名单而不是环境级开关,
 * 例如本文件的 `TURNSTILE_BYPASS_ACCOUNTS` —— 作用域收敛到具体账号、命中留痕、
 * 对真实用户零影响。
 *
 * 消息里只列**键名**不回显值,遵守 ConfigError 的"不泄露 secrets"约定。
 */
function assertNoProductionDangerSwitches(env: Record<string, string | undefined>): void {
  if (env.NODE_ENV !== "production") return;
  const hits: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (!PRODUCTION_FORBIDDEN_ENV_RE.test(key)) continue;
    if (!TRUTHY_ENV_VALUES.has(value.trim().toLowerCase())) continue;
    hits.push(key);
  }
  if (hits.length === 0) return;
  hits.sort();
  throw new ConfigError(
    hits.map((key) => ({
      path: key,
      code: "production_danger_switch",
      message:
        "dangerous test/bypass switch is enabled under NODE_ENV=production; " +
        "remove it and use an account-scoped allowlist (e.g. TURNSTILE_BYPASS_ACCOUNTS) instead",
    })),
  );
}

/**
 * 从给定的 env 对象解析配置。
 * 默认从 process.env 读;测试可显式传入。
 *
 * 注:不做单例缓存(各调用方若需要缓存自行处理),便于测试隔离。
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): CommercialConfig {
  // 先于 schema 校验:危险开关是安全问题,必须先于"字段格式不对"暴露出来,
  // 否则一个无关的 schema 错误会把它挤出错误消息。
  assertNoProductionDangerSwitches(env);
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
  // 关掉人机验证强制是"明知代价的临时状态",绝不能静默 —— 每次启动都大声播报,
  // 让任何人看一眼日志就知道现在没有人机验证,以及翻回去的三个前置条件。
  // (与 TURNSTILE_TEST_BYPASS 的核心差别正在于此:那个键假装自己不在生产。)
  if (result.data.TURNSTILE_ENFORCE === false) {
    console.warn(
      "[turnstile-enforcement-off] 注册/登录/找回密码当前**不做人机验证**(TURNSTILE_ENFORCE=0)。" +
        "翻回 1 的前置条件:①CF widget 改 Invisible/Non-Interactive ②turnstile 结果遥测上线 " +
        "③鸿蒙 ArkWeb / Quark / iOS Safari 真机验证通过。详见 config.ts 的 turnstileEnforce 注释。",
    );
  }
  return result.data;
}

/**
 * R7 子集 schema — 只解析 R7 backup/restore 需要的字段。
 *
 * 用途:`scripts/r7-cli.ts` 这种独立的 manual 工具。CLI 不应被 master 主进程的
 * DATABASE_URL/REDIS_URL/JWT_SECRET 等无关项绑死,否则 ops 在 helper host 上验证
 * R7 行为时还得伪造一堆 dummy env,反过来掩盖真实配置错误。
 *
 * 字段语义跟 commercialConfigSchema 完全一致(同一 zod 校验器),不会出现两份
 * R7 schema 漂移的问题。
 */
export const r7ConfigSchema = z.object({
  R7_GCS_BUCKET: r7GcsBucket,
  GOOGLE_APPLICATION_CREDENTIALS: r7GcsCredentialsPath,
  R7_BACKUP_ENABLED: r7BackupEnabled,
  R7_RESTORE_ENABLED: r7RestoreEnabled,
  R7_BACKUP_TIMEOUT_SEC: r7BackupTimeoutSec,
  R7_RESTORE_TIMEOUT_SEC: r7RestoreTimeoutSec,
  R7_HELPER_IMAGE: r7HelperImage,
});
export type R7Config = z.infer<typeof r7ConfigSchema>;

export function loadR7Config(env: Record<string, string | undefined> = process.env): R7Config {
  const result = r7ConfigSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join("."),
      code: i.code,
      message: i.message,
    }));
    throw new ConfigError(issues);
  }
  return result.data;
}
