/**
 * T-40b — `/ws/chat` WebSocket handler。
 *
 * 规约:04-API §5,01-SPEC F-6.5。
 *
 * 流程:
 *   1. upgrade 到来 → 从 URL query 取 `token=<access_jwt>` → verifyAccess → 拿 user_id/role
 *   2. 通过 ConnectionRegistry 注册,必要时踢掉同用户最老的一条
 *   3. 等待客户端第一条 `{type:'start', model, messages, max_tokens}` 帧
 *   4. preCheck(和 POST /api/chat 一样的预扣逻辑)
 *   5. runClaudeChat 编排器跑 SSE,把 `delta`/`error`/`done` 转发为 WS 帧
 *   6. 成功收尾 → 事务内 debit + INSERT usage_records,发 `debit` 帧 + `done` 帧,close 1000
 *   7. 失败收尾 → 只写 error usage_record,发 `error` 帧,close 1011(protocol vs app 区分:
 *      鉴权/协议错 close 1008;上游/内部错 close 1011)
 *   8. finally:释放 preCheck 锁,unregister。无论哪条路径,client 都会看到至少一条
 *      `error` 或 `done` 帧。
 *
 * 鉴权:JWT 只能放 URL query —— 浏览器 WebSocket API 不支持自定义 header。
 * WS 不走 Authorization header 只能如此(STUB Sec-WebSocket-Protocol 被后端忽略)。
 *
 * 连接数限制:每 user_id 最多 3 条并发 WS。第 4 条打开时把最老的那条踢掉(04-API 规约)。
 *
 * 帧大小:入站帧 > 10MB 直接断开(防 DoS)。出站帧无上限(理论上 SSE 不会超,客户端断开后
 * ws 会把 buffered data 丢掉)。
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

import { verifyAccess, JwtError, type AccessClaims } from "../auth/jwt.js";
import type { PricingCache } from "../billing/pricing.js";
import { computeCost } from "../billing/calculator.js";
import {
  preCheck,
  releasePreCheck,
  InsufficientCreditsError as PreCheckInsufficientError,
  type PreCheckRedis,
} from "../billing/preCheck.js";
import { tx } from "../db/queries.js";
import {
  runClaudeChat,
  type RunChatDeps,
  type RunChatInput,
  type ChatEvent,
} from "../chat/orchestrator.js";
import {
  debitChatSuccess,
  recordChatError,
  InsufficientCreditsAfterPreCheckError,
  UserGoneError,
} from "../chat/debit.js";
import { ConnectionRegistry, DEFAULT_MAX_PER_USER, type Conn } from "./connections.js";

/** 客户端 → 服务器 `start` 帧的最低必填字段。 */
export interface ChatStartFrame {
  type: "start";
  model: string;
  messages: unknown[];
  max_tokens: number;
  system?: string;
  /** 其他 Anthropic API 参数(temperature 等)原样透传 */
  extra?: Record<string, unknown>;
}

/** 服务器 → 客户端 WS 帧类型(04-API §5)。 */
export type ChatServerFrame =
  | { type: "delta"; text: string }
  | {
      type: "usage";
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      stop_reason: string | null;
    }
  | {
      type: "debit";
      cost_credits: string;
      balance_after: string;
      ledger_id: string;
      usage_record_id: string;
    }
  | { type: "done" }
  | { type: "error"; code: string; message: string };

/** 入站帧大小上限,超出直接断开。05-SEC §x 规约 10MB。 */
export const DEFAULT_MAX_FRAME_BYTES = 10 * 1024 * 1024;

/** 客户端建连后多久不发 `start` 就断开 */
export const DEFAULT_START_TIMEOUT_MS = 30_000;

/** WS close codes(统一一下避免各处散乱) */
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL = 1002;
const CLOSE_UNSUPPORTED = 1003;
const CLOSE_POLICY = 1008; // 鉴权失败 / 连接数上限 / 协议滥用
const CLOSE_TOO_BIG = 1009;
const CLOSE_INTERNAL = 1011;

export interface ChatWsLogger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export interface ChatWsDeps {
  jwtSecret: string | Uint8Array;
  pricing: PricingCache;
  preCheckRedis: PreCheckRedis;
  /** runClaudeChat 的所有依赖(scheduler + proxy/refresh fn + deps) */
  chatDeps: RunChatDeps;
  /** 可选:起始帧超时(默认 30s) */
  startTimeoutMs?: number;
  /** 可选:最大入站帧字节数(默认 10MB) */
  maxFrameBytes?: number;
  /** 可选:每用户最大并发(默认 3) */
  maxPerUser?: number;
  logger?: ChatWsLogger;
}

export interface ChatWsHandler {
  /**
   * 在 HTTP server 的 `upgrade` 事件中调用。若 URL pathname 不是 `/ws/chat` 返回 false,
   * 让上层继续路由(例如 gateway 自己的 `/ws`)。其他情况下本方法返回 true,
   * 并自行处理 socket(鉴权失败 / 接受连接 等)。
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** 服务关闭时:发 close 给所有连接并清空 registry */
  shutdown(reason?: string): Promise<void>;
  /** 测试 / 监控用 */
  registry: ConnectionRegistry;
}

const noopLogger: ChatWsLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** URL.parse 路径(没有 host 也要能 parse)。 */
function parseWsUrl(req: IncomingMessage): URL | null {
  const raw = req.url ?? "/";
  try {
    // 用 http://placeholder 保证相对 URL 能走 URL 构造
    return new URL(raw, "http://placeholder");
  } catch {
    return null;
  }
}

/**
 * 抢在 handshake 前拒绝:写 HTTP 响应后 `socket.end()` 触发 FIN。
 *
 * 用 `end()` 而不是 `destroy()`:destroy 发 RST 会让客户端(fetch / 浏览器 WS client)
 * 把这看成 "连接异常断开" 而不是 "收到 401",行为差异影响前端错误展示。
 */
function rejectHttp(
  socket: Duplex,
  status: number,
  body: string,
  extraHeaders: Record<string, string> = {},
): void {
  if (socket.destroyed) return;
  const headers = [
    `HTTP/1.1 ${status} ${httpReason(status)}`,
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
  ];
  for (const [k, v] of Object.entries(extraHeaders)) {
    headers.push(`${k}: ${v}`);
  }
  try {
    socket.end(headers.join("\r\n") + "\r\n\r\n" + body);
  } catch {
    // socket 已坏:destroy 兜底
    try { socket.destroy(); } catch { /* */ }
  }
}

function httpReason(status: number): string {
  switch (status) {
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 413: return "Payload Too Large";
    default: return "Error";
  }
}

function sendJson(ws: WebSocket, obj: ChatServerFrame): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    // send 失败(客户端已断)— 忽略
  }
}

/**
 * 校验客户端第一条 `start` 帧的形状。类型错直接报错,交调用方发 error+close。
 * 这里不检查 model 是否定价里存在(那是 preCheck/pricing 的事),只做结构层面。
 */
function parseStartFrame(raw: string): ChatStartFrame {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("first frame is not valid JSON");
  }
  if (!obj || typeof obj !== "object") throw new Error("first frame must be JSON object");
  const rec = obj as Record<string, unknown>;
  if (rec.type !== "start") throw new Error(`first frame type must be 'start' (got ${String(rec.type)})`);
  const model = typeof rec.model === "string" ? rec.model : "";
  const maxTokens = typeof rec.max_tokens === "number" ? rec.max_tokens : 0;
  const messages = Array.isArray(rec.messages) ? rec.messages : null;
  if (model.length === 0) throw new Error("start frame missing model");
  if (!Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > 1_000_000) {
    throw new Error("start frame max_tokens must be integer in (0, 1_000_000]");
  }
  if (!messages || messages.length === 0) throw new Error("start frame missing/empty messages");
  const system = typeof rec.system === "string" ? rec.system : undefined;
  const extra =
    rec.extra && typeof rec.extra === "object" && !Array.isArray(rec.extra)
      ? (rec.extra as Record<string, unknown>)
      : undefined;
  return {
    type: "start",
    model,
    messages,
    max_tokens: maxTokens,
    system,
    extra,
  };
}

export function createChatWsHandler(deps: ChatWsDeps): ChatWsHandler {
  const log = deps.logger ?? noopLogger;
  const maxFrameBytes = deps.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const startTimeoutMs = deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const maxPerUser = deps.maxPerUser ?? DEFAULT_MAX_PER_USER;

  const registry = new ConnectionRegistry({ maxPerUser });
  // noServer:我们完全掌控 upgrade 流程(决定哪些路径进 WS)
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes });

  async function authFromQuery(url: URL): Promise<AccessClaims | { error: string }> {
    const token = url.searchParams.get("token") ?? "";
    if (!token) return { error: "missing token query param" };
    try {
      return await verifyAccess(token, deps.jwtSecret);
    } catch (err) {
      if (err instanceof JwtError) return { error: "invalid or expired token" };
      throw err;
    }
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = parseWsUrl(req);
    if (!url) {
      rejectHttp(socket, 400, JSON.stringify({ error: { code: "BAD_URL", message: "cannot parse URL" } }));
      return true;
    }
    if (url.pathname !== "/ws/chat") return false; // 让上层路由继续处理 /ws 等

    // 为什么不用 HTTP 401 拒绝:
    //   - 浏览器 WebSocket API 在握手失败时不暴露响应 body,前端拿不到错误细节
    //   - 跨运行时(Bun/Node)对 upgrade socket 的裸 write 行为不一致(Bun 有 bug 会丢弃)
    //   - 04-API 规定所有错误都是 `{type:'error', code, message}` 帧
    // 因此:统一先接受 upgrade,再在 WS 帧里发 error,然后 close(1008/1011)。
    // 鉴权失败对应 close code 1008(policy violation)。
    wss.handleUpgrade(req, socket, head, (ws) => {
      authFromQuery(url).then((r) => {
        if ("error" in r) {
          sendJson(ws, { type: "error", code: "UNAUTHORIZED", message: r.error });
          try { ws.close(CLOSE_POLICY, "unauthorized"); } catch { /* */ }
          return;
        }
        onConnection(ws, req, r);
      }, (err: unknown) => {
        log.error("ws auth threw", { err: String(err) });
        sendJson(ws, { type: "error", code: "ERR_INTERNAL", message: "auth failure" });
        try { ws.close(CLOSE_INTERNAL, "auth error"); } catch { /* */ }
      });
    });

    return true;
  }

  function onConnection(ws: WebSocket, req: IncomingMessage, claims: AccessClaims): void {
    const connId = randomUUID();
    const userId = claims.sub;
    const remote = req.socket.remoteAddress ?? "?";
    const requestId = `ws-${connId}`;

    // Conn 对象给 registry —— close() 发 error frame + close(1008)
    const conn: Conn = {
      id: connId,
      user_id: userId,
      opened_at: Date.now(),
      close: (reason) => {
        try {
          sendJson(ws, { type: "error", code: "ERR_CONN_KICKED", message: reason });
        } finally {
          try { ws.close(CLOSE_POLICY, "kicked"); } catch { /* */ }
        }
      },
    };
    const { unregister } = registry.register(conn);

    // 业务状态机。一个连接只跑一轮 chat —— 开第二轮要求新建连接。
    let started = false;
    let closed = false;
    let lockKey: string | null = null;
    const abort = new AbortController();

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      try { abort.abort(); } catch { /* */ }
      unregister();
      if (lockKey) {
        const k = lockKey;
        lockKey = null;
        // best-effort,不阻塞
        void releasePreCheck(deps.preCheckRedis, k).catch(() => { /* ignore */ });
      }
    };

    const startTimer = setTimeout(() => {
      if (started) return;
      log.warn("ws chat: start frame timeout", { userId, connId });
      sendJson(ws, { type: "error", code: "ERR_START_TIMEOUT", message: "no start frame received" });
      try { ws.close(CLOSE_POLICY, "start timeout"); } catch { /* */ }
    }, startTimeoutMs);

    ws.on("close", () => {
      clearTimeout(startTimer);
      cleanup();
    });
    ws.on("error", (err) => {
      log.warn("ws chat: socket error", { userId, connId, err: String(err) });
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        sendJson(ws, { type: "error", code: "ERR_BINARY", message: "binary frames not supported" });
        try { ws.close(CLOSE_UNSUPPORTED, "binary not supported"); } catch { /* */ }
        return;
      }
      if (started) {
        // 第一轮 chat 进行中收到额外的帧 —— 暂不支持 cancel,忽略。
        // 未来可加 {type:'cancel'} 走 AbortController。
        return;
      }

      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      if (Buffer.byteLength(text) > maxFrameBytes) {
        sendJson(ws, { type: "error", code: "ERR_FRAME_TOO_BIG", message: "frame exceeds max size" });
        try { ws.close(CLOSE_TOO_BIG, "frame too big"); } catch { /* */ }
        return;
      }

      let frame: ChatStartFrame;
      try {
        frame = parseStartFrame(text);
      } catch (err) {
        sendJson(ws, {
          type: "error",
          code: "ERR_BAD_START",
          message: err instanceof Error ? err.message : "bad start frame",
        });
        try { ws.close(CLOSE_PROTOCOL, "bad start"); } catch { /* */ }
        return;
      }

      started = true;
      clearTimeout(startTimer);
      // 单轮 chat 用 IIFE 启动 —— ws event 本身是 sync 的
      void runSession(ws, userId, requestId, frame, abort.signal, (key) => { lockKey = key; });
    });
  }

  async function runSession(
    ws: WebSocket,
    userId: string,
    requestId: string,
    frame: ChatStartFrame,
    signal: AbortSignal,
    setLockKey: (k: string) => void,
  ): Promise<void> {
    const modelPricing = deps.pricing.get(frame.model);
    if (!modelPricing || !modelPricing.enabled) {
      sendJson(ws, { type: "error", code: "UNKNOWN_MODEL", message: `model not available: ${frame.model}` });
      try { ws.close(CLOSE_POLICY, "unknown model"); } catch { /* */ }
      return;
    }

    // 1) preCheck
    let lockKeyLocal: string;
    try {
      const pc = await preCheck(deps.preCheckRedis, {
        userId,
        requestId,
        model: frame.model,
        maxTokens: frame.max_tokens,
        pricing: deps.pricing,
      });
      lockKeyLocal = pc.lockKey;
      setLockKey(lockKeyLocal);
    } catch (err) {
      if (err instanceof PreCheckInsufficientError) {
        sendJson(ws, { type: "error", code: "ERR_INSUFFICIENT_CREDITS",
          message: `insufficient credits: balance=${err.balance} required=${err.required}` });
      } else {
        sendJson(ws, { type: "error", code: "ERR_PRECHECK",
          message: err instanceof Error ? err.message : String(err) });
      }
      try { ws.close(CLOSE_POLICY, "precheck failed"); } catch { /* */ }
      return;
    }

    // 2) runClaudeChat —— 消费事件流
    const chatInput: RunChatInput = {
      userId,
      mode: "chat",
      model: frame.model,
      messages: frame.messages,
      max_tokens: frame.max_tokens,
      system: frame.system,
      extra: frame.extra,
      signal,
    };

    let accountId: bigint | null = null;
    let usageCaptured: {
      input_tokens: bigint;
      output_tokens: bigint;
      cache_read_tokens: bigint;
      cache_write_tokens: bigint;
    } | null = null;
    let stopReason: string | null = null;
    let hadError = false;

    try {
      for await (const ev of runClaudeChat(chatInput, deps.chatDeps)) {
        if (signal.aborted) break;
        switch (ev.type) {
          case "meta": {
            accountId = ev.account_id;
            break;
          }
          case "delta": {
            sendJson(ws, { type: "delta", text: ev.text });
            break;
          }
          case "usage": {
            usageCaptured = {
              input_tokens: BigInt(ev.usage.input_tokens),
              output_tokens: BigInt(ev.usage.output_tokens),
              cache_read_tokens: BigInt(ev.usage.cache_read_tokens),
              cache_write_tokens: BigInt(ev.usage.cache_write_tokens),
            };
            stopReason = ev.stop_reason;
            sendJson(ws, {
              type: "usage",
              input_tokens: Number(ev.usage.input_tokens),
              output_tokens: Number(ev.usage.output_tokens),
              cache_read_tokens: Number(ev.usage.cache_read_tokens),
              cache_write_tokens: Number(ev.usage.cache_write_tokens),
              stop_reason: ev.stop_reason,
            });
            break;
          }
          case "error": {
            hadError = true;
            sendJson(ws, { type: "error", code: ev.code, message: ev.message });
            break;
          }
          case "done": {
            // runClaudeChat 已保证 usage 在 done 之前;若 usage 缺失是内部错
            break;
          }
        }
      }
    } catch (err) {
      hadError = true;
      log.error("ws chat: runClaudeChat threw", { userId, requestId, err: String(err) });
      sendJson(ws, { type: "error", code: "ERR_INTERNAL", message: "internal error" });
    } finally {
      // 3) 释放预扣(不论成败)
      try { await releasePreCheck(deps.preCheckRedis, lockKeyLocal); }
      catch { /* best-effort */ }
    }

    // 4) 事务结算(只有 hadError=false 且 usageCaptured 存在)
    if (!hadError && usageCaptured) {
      try {
        const cost = computeCost(usageCaptured, modelPricing);
        const result = await tx(async (client) =>
          debitChatSuccess(client, {
            userId,
            requestId,
            mode: "chat",
            accountId,
            model: frame.model,
            usage: usageCaptured,
            cost,
          }),
        );
        sendJson(ws, {
          type: "debit",
          cost_credits: cost.cost_credits.toString(),
          balance_after: result.balance_after.toString(),
          ledger_id: result.ledger_id,
          usage_record_id: result.usage_record_id,
        });
        sendJson(ws, { type: "done" });
        try { ws.close(CLOSE_NORMAL, "done"); } catch { /* */ }
      } catch (err) {
        log.error("ws chat: debit threw", { userId, requestId, err: String(err) });
        if (err instanceof InsufficientCreditsAfterPreCheckError) {
          sendJson(ws, { type: "error", code: "ERR_INSUFFICIENT_CREDITS", message: err.message });
        } else if (err instanceof UserGoneError) {
          sendJson(ws, { type: "error", code: "UNAUTHORIZED", message: "user not found" });
        } else {
          sendJson(ws, { type: "error", code: "ERR_DEBIT", message: "debit failed" });
        }
        try { ws.close(CLOSE_INTERNAL, "debit failed"); } catch { /* */ }
      }
      return;
    }

    // 5) 错误路径:只写 error usage_record(审计),发 error+done(done 是信号,告诉客户端 server 不再发)
    // 注意:orchestrator 已经 yield 过 error frame,这里只补 usage_record
    try {
      await recordChatError({
        userId,
        requestId,
        mode: "chat",
        accountId,
        model: frame.model,
        priceSnapshot: {
          model_id: modelPricing.model_id,
          display_name: modelPricing.display_name,
          input_per_mtok: modelPricing.input_per_mtok.toString(),
          output_per_mtok: modelPricing.output_per_mtok.toString(),
          cache_read_per_mtok: modelPricing.cache_read_per_mtok.toString(),
          cache_write_per_mtok: modelPricing.cache_write_per_mtok.toString(),
          multiplier: modelPricing.multiplier,
          captured_at: new Date().toISOString(),
        },
        errorMessage: "upstream or internal error during ws chat",
      });
    } catch (err) {
      log.error("ws chat: recordChatError threw", { userId, requestId, err: String(err) });
    }
    try { ws.close(CLOSE_INTERNAL, "upstream error"); } catch { /* */ }
    void stopReason; // stopReason 暂时只做日志/未来挂 debit 扩展
  }

  async function shutdown(reason = "server shutting down"): Promise<void> {
    registry.closeAll(reason);
    await new Promise<void>((resolve) => {
      try { wss.close(() => resolve()); } catch { resolve(); }
    });
  }

  return { handleUpgrade, shutdown, registry };
}
