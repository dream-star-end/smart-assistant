import { DEFAULT_CODEX_ENGINE_MODEL } from "@openclaude/protocol";
import { DEFAULT_BRIDGE_MAX_FRAME_BYTES } from "../bridgeFrameBudget.js";

/** 桥接路径(只此一个,gateway upgrade 路由按 url.pathname 匹配)。 */
export const BRIDGE_WS_PATH = "/ws/user-chat-bridge";

/** 五枚举目标画面比例(与 protocol imageEdit.targetAspect / gateway OUTPAINT_ASPECT_RATIOS 同源)。 */
export const OUTPAINT_ASPECTS = new Set(["16:9", "4:3", "9:16", "3:4", "1:1"]);

export const CONTROL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function isControlId(value: unknown): value is string {
  return typeof value === "string" && CONTROL_ID_RE.test(value);
}

/** WebSocket close codes(自家私有码段:4000-4999)。 */
export const CLOSE_BRIDGE = {
  NORMAL: 1000,
  POLICY: 1008,
  TOO_BIG: 1009,
  INTERNAL: 1011,
  /** 容器未就绪 / 迁移中(对应 supervisor.ensureRunning 的 503)。前端按 retryAfter 重试。 */
  CONTAINER_UNREADY: 4503,
  /** V3 Phase 4H+ maintenance_mode=true 时非 admin 的 close code。 */
  MAINTENANCE: 4504,
  /** 同一用户连接数超限踢旧连接。不要用 1008,否则前端会误判为登录过期。 */
  TOO_MANY_CONNECTIONS: 4505,
  /** 计费/余额类策略拒绝。 */
  BILLING_POLICY: 4506,
  /** 用户可调整的产品策略(如模型未授权),不是 access token 失效。 */
  PRODUCT_POLICY: 4507,
  /** GPT/Codex 环境被回收/重建,提示刷新重试。 */
  ENV_RECYCLED: 4508,
  /** 服务重启/发版(shutdown → registry.closeAll)。瞬态自动重连码。 */
  SERVER_RESTART: 4509,
} as const;

/** 入站 / 出站 帧的最大字节数(单帧，OCV5-825 B1 与容器 gateway 16 MiB 上限对齐)。 */
export const DEFAULT_MAX_FRAME_BYTES = DEFAULT_BRIDGE_MAX_FRAME_BYTES;

/** 单条 hello 最多从 PG 补齐这么多会话的在飞 live frames。 */
export const HELLO_LIVE_CATCHUP_MAX_SESSIONS = 8;
/** 单会话 hello 补齐帧数封顶,与 GET live-frames 页大小对齐。 */
export const HELLO_LIVE_CATCHUP_MAX_FRAMES = 500;

/** 单方向 buffer 上限。超出 = 慢消费者 / 死循环 → close。 */
export const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** 连接到容器的超时 ms。 */
export const DEFAULT_CONTAINER_CONNECT_TIMEOUT_MS = 5_000;

/** HTTP origin-session injection receipt wait budget. */
export const CRON_ORIGIN_RECEIPT_WAIT_MS = 5_000;

/** ConnectionRegistry 默认 maxPerUser。 */
export const DEFAULT_MAX_PER_USER = 3;

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;
export const MAX_TURN_GRACE_MS = 10 * 60_000;
export const POST_FINAL_GRACE_MS = 90_000;

/** 等待容器 attestation 的默认上限。 */
export const DEFAULT_ATTEST_TIMEOUT_MS = 10_000;

export const ACTIVITY_REFRESH_INTERVAL_MS = 60_000;
export const ACTIVITY_KEEPALIVE_INTERVAL_MS = 5 * 60_000;
export const GRANTS_REFRESH_INTERVAL_MS = 30_000;
export const DEFAULT_CODEX_SESSION_MAX_MS = 600_000;

export const AGENT_AUTHZ_IMPLIED_MODEL: Record<string, string> = {
  codex: DEFAULT_CODEX_ENGINE_MODEL,
};

export const HIDDEN_REVIEWER_AGENT_ID = "hidden-reviewer";
export const CODEX_PRECHECK_TOKEN_ESTIMATE = 64_000;
export const DEFAULT_DRAIN_BILLING_MS = 5_000;
export const DEFAULT_DISPATCH_DRAIN_MS = 60_000;
export const MAX_DISPATCH_DRAIN_MS = 120_000;
export const RECOVERY_LEASE_MS = 120_000;

export const SESSION_DELETED_WIRE_MESSAGE =
  "This conversation was deleted. Start a new one; retrying here will not bring it back.";

/** 容器未就绪(provision 中 / 迁移中 / 临时不可达)。 */
export class ContainerUnreadyError extends Error {
  constructor(
    readonly retryAfterSec: number,
    readonly reason: string,
  ) {
    super(`container not ready: ${reason} (retry after ${retryAfterSec}s)`);
    this.name = "ContainerUnreadyError";
  }
}

/** 模型不可路由(catalog 无 active 行 / 无价 / capability schema 未来版本)。 */
export class ModelNotAvailableError extends Error {
  constructor(readonly modelId: string) {
    super(`model not available: ${modelId}`);
    this.name = "ModelNotAvailableError";
  }
}
