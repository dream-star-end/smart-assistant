/**
 * V3 Phase 2 Task 2E — 用户 WS ↔ 容器 WS 桥接。
 *
 * 见 docs/v3/02-DEVELOPMENT-PLAN.md §4 / 03-MVP-CHECKLIST.md Task 2E。
 *
 * 拓扑(MVP 单 host monolith):
 *   浏览器 ──TLS WS──▶ Gateway `/ws/user-chat-bridge?token=<jwt>`
 *                       │
 *                       ├─ verifyAccess(jwt) → uid
 *                       ├─ ConnectionRegistry.register({uid})  // 默认每人 3 条
 *                       ├─ const {host, port} = await resolveContainerEndpoint(uid)
 *                       │     ↑ 唯一入口(R6.11 reader 硬约束)。Phase 3 接入
 *                       │       supervisor.ensureRunning(uid);Phase 2 由调用方注入。
 *                       │       throw 503 → 关 ws + close code 4503 + retryAfter 给前端
 *                       └─ 内部 fetch ws://<host>:<port>/ws → 双向 pipe(text + binary)
 *
 * 协议透明:本模块**不解析也不修改**任何 chat / agent / tool 帧 — 只做 byte-exact
 * 帧透传。个人版 `/ws` 协议可演进而无需 commercial 配合。
 *
 * 失败语义:
 *   - JWT 失败  → ws 立刻 send {type:'error',code:'UNAUTHORIZED'} + close(1008)
 *   - 503 容器未就绪 → close(4503, 'migration_in_progress'),前端按 retryAfter 重连
 *   - 容器 WS 拒连(ECONNREFUSED / 4xx)→ close(1011, 'agent unavailable')
 *   - 任一侧 close → 另一侧立刻 close(对端 close code 透传到下游 best-effort)
 *   - buffer 超 maxBufferedBytes → close(1009, 'backpressure')— 防内存爆
 *
 * 不做的(P1+ / 别的 task):
 *   - 不做 ack 屏障 / migrate-aware 重连(R6.11):2E 只做"调一次 ensureRunning,
 *     成功就开桥;失败就 4503"。任何 redirect / 中途切 host 都不在 MVP 范畴
 *   - 不做 metrics 输出:`bufferedBytes` 通过 deps.onMetric 回调暴露,2I-2 接 prom-client
 *   - 不做 audit:个人版 chat 已经在容器内自审,gateway 侧不再额外抓 message body
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";

import { verifyAccess, JwtError, type AccessClaims } from "../auth/jwt.js";
import { ConnectionRegistry, type Conn } from "./connections.js";
import type { Logger } from "../logging/logger.js";

// ---------- 协议 / 常量 -----------------------------------------------------

/** 桥接路径(只此一个,gateway upgrade 路由按 url.pathname 匹配)。 */
export const BRIDGE_WS_PATH = "/ws/user-chat-bridge";

/** WebSocket close codes(自家私有码段:4000-4999)。 */
export const CLOSE_BRIDGE = {
  NORMAL: 1000,
  POLICY: 1008,
  TOO_BIG: 1009,
  INTERNAL: 1011,
  /** 容器未就绪 / 迁移中(对应 supervisor.ensureRunning 的 503)。前端按 retryAfter 重试。 */
  CONTAINER_UNREADY: 4503,
} as const;

/** 入站 / 出站 帧的最大字节数(单帧)。1MB 比 chat 单条消息上限大一截,够覆盖大型工具结果。 */
const DEFAULT_MAX_FRAME_BYTES = 1 * 1024 * 1024;

/** 单方向 buffer 上限。超出 = 慢消费者 / 死循环 → close。 */
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** 连接到容器的超时 ms。容器 WS 同机回环,1s 都嫌长。 */
const DEFAULT_CONTAINER_CONNECT_TIMEOUT_MS = 5_000;

/** ConnectionRegistry 默认 maxPerUser(沿用 connections.ts 的 3)。 */
const DEFAULT_MAX_PER_USER = 3;

// ---------- 公共类型 --------------------------------------------------------

/**
 * 容器端点解析器 — Phase 2 由测试或外层注入,Phase 3D 由 supervisor.ensureRunning 实现。
 *
 * 抛 `ContainerUnreadyError(retryAfterSec, reason)` → 桥接层 close(4503, reason)
 *   并把 retryAfter 写进 close reason JSON;前端按建议秒数重连
 *
 * 抛任何其他 error → close(1011, 'internal error');不暴露原始 error 到客户端
 */
export type ResolveContainerEndpoint = (
  uid: bigint,
) => Promise<{ host: string; port: number }>;

/**
 * 容器未就绪(provision 中 / 迁移中 / 临时不可达)。
 *
 * MVP 单 host 下,主要触发场景:
 *   - 首次连 ws 时容器还没 provision(冷启 5-10s)
 *   - persistent 容器 stop 后正在 startStoppedContainer
 *
 * Phase 3 supervisor.ensureRunning 内部将 throw 这个;Phase 2 测试桩可手 throw。
 */
export class ContainerUnreadyError extends Error {
  constructor(
    /** 前端建议下次尝试的秒数(2-30 之间合理)。 */
    readonly retryAfterSec: number,
    /** 短诊断字符串,例如 "provisioning" / "migration_in_progress" / "starting"。 */
    readonly reason: string,
  ) {
    super(`container not ready: ${reason} (retry after ${retryAfterSec}s)`);
    this.name = "ContainerUnreadyError";
  }
}

/** 测试 / 2I-2 metrics 回调:单事件钩子。 */
export interface BridgeMetricSink {
  /** 一条用户帧已转发到容器(bytes 是 raw 字节数,含 binary)。 */
  onUserFrame?(uid: bigint, bytes: number, isBinary: boolean): void;
  /** 一条容器帧已转发到用户。 */
  onContainerFrame?(uid: bigint, bytes: number, isBinary: boolean): void;
  /** 当前任意一侧 buffered bytes 取最大值上报(用于 prometheus gauge)。 */
  onBufferedBytes?(uid: bigint, side: "user_to_container" | "container_to_user", bytes: number): void;
  /** 桥关闭时单次,拿到本次会话总字节数 / 时长 / closeCode。 */
  onClose?(stats: {
    uid: bigint;
    connId: string;
    durationMs: number;
    closeCode: number;
    closeReason: string;
    bytesUserToContainer: number;
    bytesContainerToUser: number;
    cause: BridgeCloseCause;
  }): void;
}

/** 桥关闭的根因分类(供 metrics / 日志诊断)。 */
export type BridgeCloseCause =
  | "client_close"           // 用户主动 close
  | "container_close"        // 容器主动 close
  | "container_error"        // 容器 socket 错(ECONNREFUSED 等)
  | "container_unready"      // ensureRunning throw ContainerUnreadyError
  | "auth_failed"            // JWT 验证失败
  | "frame_too_big"          // 单帧超过 maxFrameBytes
  | "binary_unsupported"     // (保留,默认放行 binary)
  | "backpressure"           // buffer 超 maxBufferedBytes
  | "internal_error"         // 兜底
  | "shutdown";              // server.shutdown()

// ---------- Deps + Handler --------------------------------------------------

export interface UserChatBridgeDeps {
  jwtSecret: string | Uint8Array;
  /** 解析 uid → 容器 host/port。Phase 3D 接 supervisor.ensureRunning;Phase 2 单测自行 mock。 */
  resolveContainerEndpoint: ResolveContainerEndpoint;
  /** 可选:每用户最大并发(默认 3)。 */
  maxPerUser?: number;
  /** 可选:单帧上限(双向,默认 1MB)。 */
  maxFrameBytes?: number;
  /** 可选:单方向 buffer 上限(默认 4MB)。 */
  maxBufferedBytes?: number;
  /** 可选:连接到容器的超时(默认 5s)。 */
  containerConnectTimeoutMs?: number;
  /** 可选:metrics 钩子(2I-2 接 prom-client)。 */
  metrics?: BridgeMetricSink;
  /** 可选:logger(2I-1)。不传则静默(降到 noop)。 */
  logger?: Logger;
  /**
   * 可选:覆盖容器 WS 客户端构造,主要给单测注入 ws.Server 双向 mock。
   * 默认实现:`new WebSocket(\`ws://${host}:${port}/ws\`)`
   */
  createContainerSocket?: (host: string, port: number, signal: AbortSignal) => WebSocket;
}

export interface UserChatBridgeHandler {
  /** Gateway HTTP server 的 'upgrade' 事件入口。返 false → 路径不匹配,gateway 路由别处。 */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** 优雅关停:踢所有连接 + close ws server。 */
  shutdown(reason?: string): Promise<void>;
  /** 测试 / metrics:获取 ConnectionRegistry。 */
  registry: ConnectionRegistry;
}

// ---------- 内部工具 --------------------------------------------------------

function parseWsUrl(req: IncomingMessage): URL | null {
  const raw = req.url ?? "/";
  try { return new URL(raw, "http://placeholder"); } catch { return null; }
}

function rejectHttp(socket: Duplex, status: number, body: string): void {
  if (socket.destroyed) return;
  const headers = [
    `HTTP/1.1 ${status} ${status === 400 ? "Bad Request" : status === 401 ? "Unauthorized" : "Error"}`,
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
  ];
  try { socket.end(headers.join("\r\n") + "\r\n\r\n" + body); }
  catch { try { socket.destroy(); } catch { /* */ } }
}

function uidFromClaims(claims: AccessClaims): bigint {
  if (!/^[1-9][0-9]{0,19}$/.test(claims.sub)) {
    throw new TypeError(`bad uid in claims.sub: ${claims.sub}`);
  }
  return BigInt(claims.sub);
}

function rawDataLen(data: RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((acc, b) => acc + b.length, 0);
  return 0;
}

function sendErrorFrame(ws: WebSocket, code: string, message: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({ type: "error", code, message })); }
  catch { /* client gone */ }
}

/**
 * 将 4503 close reason 编码为 JSON 字符串(retryAfterSec + reason),前端 parse 即可拿建议。
 * 注意 close reason 字段有 123 字节上限(WebSocket spec),保持紧凑。
 */
function encode4503Reason(retryAfterSec: number, reason: string): string {
  const safeReason = reason.slice(0, 64);
  return JSON.stringify({ retryAfterSec, reason: safeReason });
}

/**
 * 把对端 close code 净化成"可在 wire 上发送"的值。
 *
 * RFC 6455:1005 / 1006 / 1015 是 reserved,**不能** send;ws lib 会 throw
 * "First argument must be a valid error code number"。其它合法范围:
 *   - 1000-1003, 1007-1011, 1012-1014  (但 1004/1016+ 未使用)
 *   - 3000-4999  (registered + private)
 *
 * 简化策略:落在三个 reserved 码 → 改 1000;否则 1000-4999 内放行,其它一律 1000。
 */
function sanitizeCloseCode(code: number): number {
  if (code === 1005 || code === 1006 || code === 1015) return CLOSE_BRIDGE.NORMAL;
  if (code >= 1000 && code <= 4999) return code;
  return CLOSE_BRIDGE.NORMAL;
}

// ---------- 主入口 ----------------------------------------------------------

export function createUserChatBridge(deps: UserChatBridgeDeps): UserChatBridgeHandler {
  const maxPerUser = deps.maxPerUser ?? DEFAULT_MAX_PER_USER;
  const maxFrameBytes = deps.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxBufferedBytes = deps.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const connectTimeoutMs = deps.containerConnectTimeoutMs ?? DEFAULT_CONTAINER_CONNECT_TIMEOUT_MS;
  const log = deps.logger;
  const metrics = deps.metrics ?? {};
  const createContainerSocket = deps.createContainerSocket
    ?? ((host, port, _signal) =>
        new WebSocket(`ws://${host}:${port}/ws`, { perMessageDeflate: false }));

  const registry = new ConnectionRegistry({ maxPerUser });
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes });

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = parseWsUrl(req);
    if (!url) {
      rejectHttp(
        socket, 400,
        JSON.stringify({ error: { code: "BAD_URL", message: "cannot parse URL" } }),
      );
      return true;
    }
    if (url.pathname !== BRIDGE_WS_PATH) return false;

    // 同 agent.ts:先 upgrade,认证错也走 ws frame 报告,前端体验比 HTTP 401 直接关好。
    wss.handleUpgrade(req, socket, head, (ws) => {
      // 早到帧暂存(auth + ensureRunning 是 async)
      const pendingMessages: Array<{ data: RawData; isBinary: boolean }> = [];
      let earlyClose: { code: number; reason: Buffer } | null = null;
      const onEarlyMessage = (data: RawData, isBinary: boolean): void => {
        pendingMessages.push({ data, isBinary });
      };
      const onEarlyClose = (code: number, reason: Buffer): void => {
        earlyClose = { code, reason };
      };
      ws.on("message", onEarlyMessage);
      ws.on("close", onEarlyClose);

      void (async () => {
        // 1) JWT 验证
        const token = url.searchParams.get("token") ?? "";
        if (!token) {
          sendErrorFrame(ws, "UNAUTHORIZED", "missing token query param");
          try { ws.close(CLOSE_BRIDGE.POLICY, "unauthorized"); } catch { /* */ }
          return;
        }
        let claims: AccessClaims;
        try {
          claims = await verifyAccess(token, deps.jwtSecret);
        } catch (err) {
          if (err instanceof JwtError) {
            sendErrorFrame(ws, "UNAUTHORIZED", "invalid or expired token");
          } else {
            sendErrorFrame(ws, "ERR_INTERNAL", "auth failure");
            log?.error("user-chat-bridge: verifyAccess threw", { err });
          }
          try { ws.close(CLOSE_BRIDGE.POLICY, "unauthorized"); } catch { /* */ }
          return;
        }
        let uid: bigint;
        try { uid = uidFromClaims(claims); }
        catch (err) {
          log?.error("user-chat-bridge: bad sub claim", { err });
          sendErrorFrame(ws, "UNAUTHORIZED", "bad uid in token");
          try { ws.close(CLOSE_BRIDGE.POLICY, "unauthorized"); } catch { /* */ }
          return;
        }

        // 2) 解析容器端点(ensureRunning)
        let endpoint: { host: string; port: number };
        try {
          endpoint = await deps.resolveContainerEndpoint(uid);
        } catch (err) {
          if (err instanceof ContainerUnreadyError) {
            log?.info("user-chat-bridge: container not ready", {
              uid: uid.toString(), reason: err.reason, retryAfterSec: err.retryAfterSec,
            });
            try {
              ws.close(
                CLOSE_BRIDGE.CONTAINER_UNREADY,
                encode4503Reason(err.retryAfterSec, err.reason),
              );
            } catch { /* */ }
            return;
          }
          log?.error("user-chat-bridge: resolveContainerEndpoint threw", {
            uid: uid.toString(), err,
          });
          sendErrorFrame(ws, "ERR_INTERNAL", "agent unavailable");
          try { ws.close(CLOSE_BRIDGE.INTERNAL, "agent unavailable"); } catch { /* */ }
          return;
        }

        // 3) 把"早到帧"还回来 + 解绑 early handlers,然后开始正式桥接
        ws.off("message", onEarlyMessage);
        ws.off("close", onEarlyClose);
        if (earlyClose !== null) {
          // 客户端在 await 期间已经撤了
          log?.info("user-chat-bridge: client closed during ensure", {
            uid: uid.toString(),
          });
          return;
        }

        startBridge(ws, uid, endpoint, pendingMessages);
      })().catch((err: unknown) => {
        log?.error("user-chat-bridge: upgrade pipeline threw", { err });
        try { ws.close(CLOSE_BRIDGE.INTERNAL, "internal error"); } catch { /* */ }
      });
    });
    return true;
  }

  function startBridge(
    userWs: WebSocket,
    uid: bigint,
    endpoint: { host: string; port: number },
    earlyMessages: Array<{ data: RawData; isBinary: boolean }>,
  ): void {
    const connId = randomUUID();
    const startedAt = Date.now();
    let bytesUC = 0;
    let bytesCU = 0;
    let bufferedUC = 0; // user → container 待发字节
    let bufferedCU = 0; // container → user 待发字节
    let cause: BridgeCloseCause = "internal_error";
    let cleaned = false;

    // 注册到 registry,超额会踢老的
    const conn: Conn = {
      id: connId,
      user_id: uid.toString(),
      opened_at: startedAt,
      close: (reason) => {
        sendErrorFrame(userWs, "ERR_CONN_KICKED", reason);
        try { userWs.close(CLOSE_BRIDGE.POLICY, "kicked"); } catch { /* */ }
      },
    };
    const { unregister } = registry.register(conn);

    // 容器侧 WS。abort signal 给 createContainerSocket 在 connect 阶段中断。
    const connectAbort = new AbortController();
    let containerWs: WebSocket;
    try {
      containerWs = createContainerSocket(endpoint.host, endpoint.port, connectAbort.signal);
    } catch (err) {
      log?.error("user-chat-bridge: createContainerSocket threw", {
        uid: uid.toString(), connId, err,
      });
      cause = "container_error";
      sendErrorFrame(userWs, "ERR_CONTAINER", "cannot connect");
      try { userWs.close(CLOSE_BRIDGE.INTERNAL, "agent unavailable"); } catch { /* */ }
      unregister();
      return;
    }

    // 连接超时:N ms 内 containerWs 没 OPEN → 取消 + 关 user
    const connectTimer = setTimeout(() => {
      if (containerWs.readyState !== WebSocket.OPEN) {
        log?.warn("user-chat-bridge: container connect timeout", {
          uid: uid.toString(), connId, host: endpoint.host, port: endpoint.port,
        });
        cause = "container_error";
        try { connectAbort.abort(); } catch { /* */ }
        try { containerWs.terminate(); } catch { /* */ }
        sendErrorFrame(userWs, "ERR_CONTAINER_TIMEOUT", "agent connect timeout");
        try { userWs.close(CLOSE_BRIDGE.INTERNAL, "agent timeout"); } catch { /* */ }
        cleanup();
      }
    }, connectTimeoutMs);

    // ---------- 双向 pipe handlers ----------

    const onUserMessage = (data: RawData, isBinary: boolean): void => {
      const len = rawDataLen(data);
      if (len > maxFrameBytes) {
        cause = "frame_too_big";
        sendErrorFrame(userWs, "ERR_FRAME_TOO_BIG",
          `user frame ${len} > max ${maxFrameBytes}`);
        try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "frame too big"); } catch { /* */ }
        cleanup();
        return;
      }
      if (containerWs.readyState !== WebSocket.OPEN) {
        // 容器还没 OPEN(早到帧场景);ws.send 在 CONNECTING 状态下抛
        // → 暂存到 ws lib 的 send buffer 里 = 不可控。这里直接 buffer 起来,
        // OPEN 后冲刷;若超 buffer 上限 → backpressure
        if (bufferedUC + len > maxBufferedBytes) {
          cause = "backpressure";
          sendErrorFrame(userWs, "ERR_BACKPRESSURE", "agent slow");
          try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "backpressure"); } catch { /* */ }
          cleanup();
          return;
        }
        bufferedUC += len;
        metrics.onBufferedBytes?.(uid, "user_to_container", bufferedUC);
        preopenQueue.push({ data, isBinary, len });
        return;
      }
      sendToContainer(data, isBinary, len);
    };

    const sendToContainer = (data: RawData, isBinary: boolean, len: number): void => {
      try {
        containerWs.send(data, { binary: isBinary }, (err) => {
          if (err) {
            log?.warn("user-chat-bridge: container send error", {
              uid: uid.toString(), connId, err,
            });
          }
        });
        bytesUC += len;
        metrics.onUserFrame?.(uid, len, isBinary);
      } catch (err) {
        log?.warn("user-chat-bridge: container send threw", {
          uid: uid.toString(), connId, err,
        });
        cause = "container_error";
        try { userWs.close(CLOSE_BRIDGE.INTERNAL, "agent send failed"); } catch { /* */ }
        cleanup();
      }
    };

    const preopenQueue: Array<{ data: RawData; isBinary: boolean; len: number }> = [];

    const onContainerMessage = (data: RawData, isBinary: boolean): void => {
      const len = rawDataLen(data);
      if (len > maxFrameBytes) {
        cause = "frame_too_big";
        log?.warn("user-chat-bridge: container frame too big", {
          uid: uid.toString(), connId, len, max: maxFrameBytes,
        });
        sendErrorFrame(userWs, "ERR_FRAME_TOO_BIG",
          `container frame ${len} > max ${maxFrameBytes}`);
        try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "frame too big"); } catch { /* */ }
        cleanup();
        return;
      }
      if (userWs.readyState !== WebSocket.OPEN) {
        // user 已经走了,丢
        return;
      }
      // 简单 backpressure:看 userWs.bufferedAmount(ws lib 维护的 socket 待发量)
      if (userWs.bufferedAmount + len > maxBufferedBytes) {
        cause = "backpressure";
        log?.warn("user-chat-bridge: user-side backpressure", {
          uid: uid.toString(), connId,
          buffered: userWs.bufferedAmount, len,
        });
        sendErrorFrame(userWs, "ERR_BACKPRESSURE", "client slow");
        try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "backpressure"); } catch { /* */ }
        cleanup();
        return;
      }
      try {
        userWs.send(data, { binary: isBinary }, (err) => {
          if (err) {
            log?.warn("user-chat-bridge: user send error", {
              uid: uid.toString(), connId, err,
            });
          }
        });
        bytesCU += len;
        bufferedCU = userWs.bufferedAmount;
        metrics.onContainerFrame?.(uid, len, isBinary);
        metrics.onBufferedBytes?.(uid, "container_to_user", bufferedCU);
      } catch (err) {
        log?.warn("user-chat-bridge: user send threw", {
          uid: uid.toString(), connId, err,
        });
        try { userWs.close(CLOSE_BRIDGE.INTERNAL, "user send failed"); } catch { /* */ }
        cleanup();
      }
    };

    // ---------- container WS 生命周期 ----------

    containerWs.on("open", () => {
      clearTimeout(connectTimer);
      log?.debug("user-chat-bridge: container connected", {
        uid: uid.toString(), connId, host: endpoint.host, port: endpoint.port,
      });
      // 冲刷 preopen queue
      for (const m of preopenQueue) sendToContainer(m.data, m.isBinary, m.len);
      preopenQueue.length = 0;
      bufferedUC = 0;
      metrics.onBufferedBytes?.(uid, "user_to_container", 0);
    });

    containerWs.on("message", onContainerMessage);

    containerWs.on("error", (err: Error) => {
      log?.warn("user-chat-bridge: container ws error", {
        uid: uid.toString(), connId, err,
      });
      cause = "container_error";
      sendErrorFrame(userWs, "ERR_CONTAINER", err.message);
      try { userWs.close(CLOSE_BRIDGE.INTERNAL, "agent error"); } catch { /* */ }
      cleanup();
    });

    containerWs.on("close", (code, reason) => {
      // 容器主动关 → 透传给用户 close,但 reserved code (1005/1006/1015) 不能 send
      const passCode = sanitizeCloseCode(code);
      const passReason = reason && reason.length > 0 && reason.length < 120
        ? reason.toString("utf8")
        : "agent closed";
      if (cause === "internal_error") cause = "container_close";
      try { userWs.close(passCode, passReason); } catch { /* */ }
      cleanup();
    });

    // ---------- user WS 生命周期 ----------

    userWs.on("message", onUserMessage);
    userWs.on("error", (err) => {
      log?.warn("user-chat-bridge: user ws error", {
        uid: uid.toString(), connId, err,
      });
    });
    userWs.on("close", (code, reason) => {
      if (cause === "internal_error") cause = "client_close";
      // 把客户端关闭原因转给容器(透传 code/reason,容器侧也会触发 cleanup)
      const passCode = sanitizeCloseCode(code);
      const passReason = reason && reason.length > 0 && reason.length < 120
        ? reason.toString("utf8")
        : "client closed";
      try {
        if (containerWs.readyState === WebSocket.OPEN
          || containerWs.readyState === WebSocket.CONNECTING) {
          containerWs.close(passCode, passReason);
        }
      } catch { /* */ }
      cleanup();
    });

    // 把"upgrade 期间早到的帧"先 emit 一遍 → 走正常 onUserMessage 流程
    for (const m of earlyMessages) {
      onUserMessage(m.data, m.isBinary);
    }

    // ---------- cleanup(幂等) ----------
    function cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(connectTimer);
      try { connectAbort.abort(); } catch { /* */ }
      try {
        // 注意:CLOSING 状态也强 terminate(),不依赖对端 echo,
        // 否则有可能 close 帧丢失或 send 异常导致连接卡死
        if (containerWs.readyState !== WebSocket.CLOSED) {
          containerWs.terminate();
        }
      } catch { /* */ }
      unregister();

      const closeCode = userWs.readyState === WebSocket.CLOSED
        ? (userWs as unknown as { _closeCode?: number })._closeCode ?? CLOSE_BRIDGE.NORMAL
        : CLOSE_BRIDGE.NORMAL;
      const closeReason = userWs.readyState === WebSocket.CLOSED
        ? String((userWs as unknown as { _closeMessage?: string })._closeMessage ?? "")
        : "";

      metrics.onClose?.({
        uid,
        connId,
        durationMs: Date.now() - startedAt,
        closeCode,
        closeReason,
        bytesUserToContainer: bytesUC,
        bytesContainerToUser: bytesCU,
        cause,
      });
      log?.info("user-chat-bridge: closed", {
        uid: uid.toString(), connId,
        durationMs: Date.now() - startedAt,
        bytesUC, bytesCU, cause,
      });
    }
  }

  async function shutdown(reason = "server shutting down"): Promise<void> {
    registry.closeAll(reason);
    await new Promise<void>((resolve) => {
      try { wss.close(() => resolve()); } catch { resolve(); }
    });
  }

  return { handleUpgrade, shutdown, registry };
}

// ---------- 测试 re-exports ------------------------------------------------
// 供单测直接拿到内部 helpers,不走 ws upgrade 全链路就能验逻辑

export { rawDataLen as _rawDataLen, encode4503Reason as _encode4503Reason };
