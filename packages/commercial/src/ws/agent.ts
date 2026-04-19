/**
 * T-52 — `/ws/agent` WebSocket handler。
 *
 * 职责(07-TASKS T-52 Acceptance):
 *   - 浏览器 / CLI 经 WS 连到 gateway,gateway 打开容器内 `agent.sock` 做双向 pipe
 *   - 每个"工具调用"帧(`type:"tool"`)都由 gateway 截获 → 写 `agent_audit`
 *
 * 流程:
 *   1. upgrade `/ws/agent?token=<access_jwt>` → verifyAccess → user_id
 *   2. ConnectionRegistry 注册(agent 一般每人 1 条,比 chat 严)
 *   3. 根据 user_id resolveSocketPath(uid) 拿到 host 上的 agent.sock
 *   4. `net.createConnection({path})` 连容器内 RPC server。ENOENT/ECONNREFUSED
 *      → 发 `ERR_AGENT_UNAVAILABLE` + close(1011)
 *   5. 发 `{type:"open", session_id}`
 *   6. 双向 pipe:
 *      - 容器 → gateway:按 `\n` 切行,每行 parse 成 JSON 再封成 `{type:"frame", data}`
 *        发给客户端。若是 tool_result + id 匹配 pending tool,写 agent_audit。
 *      - 客户端 → gateway:单个 WS 帧 = 一条 JSON。若 `type:"tool"` 记入 pending map,
 *        原样(加 `\n`)写入容器 socket。
 *   7. 任一侧关闭 → 另一侧也关。pending 未完成 tool 记一行 success=false(connection closed)。
 *
 * 设计取舍:
 *   - **每个工具调用必须经 gateway 代理** —— 不允许客户端直接连容器,是为了:
 *     (a) 记账/审计统一落库;(b) 认证与用户身份绑定;(c) 防客户端伪造其他用户 uid。
 *   - audit row 的 input_meta 截断到 4KB —— 防大 arg(比如一个几 MB 的 base64)把
 *     agent_audit 表撑爆;hash 全量算,可用来复原"同一输入"。
 *   - **默认 maxPerUser=1** —— agent 是重资源(docker 容器),同一用户开第二个没意义。
 *
 * 鉴权:同 ws/chat.ts —— token 放 URL query(浏览器 WS 不支持 header)。
 *
 * Binary frames / payload too big:同 chat 的语义(close 1003 / 1009)。
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import * as net from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Pool } from "pg";

import { verifyAccess, JwtError, type AccessClaims } from "../auth/jwt.js";
import { ConnectionRegistry, type Conn } from "./connections.js";

/** 出站帧(gateway → client)。 */
export type AgentServerFrame =
  | { type: "open"; session_id: string }
  | { type: "frame"; data: unknown }
  | { type: "error"; code: string; message: string }
  | { type: "close"; reason: string };

/** 入站帧(client → gateway)。 `type:"tool"` 会被截获写审计,其它透传。 */
export type AgentClientFrame = Record<string, unknown>;

/** audit 行的最小形状 —— 不强行 bigint,方便 unit mock 对比。 */
export interface AgentAuditRow {
  user_id: string | bigint;
  session_id: string;
  tool: string;
  input_meta: unknown;
  input_hash: string | null;
  output_hash: string | null;
  duration_ms: number | null;
  success: boolean;
  error_msg: string | null;
}

export interface AgentWsLogger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

/**
 * T-52 连接前 DB 校验 hook。
 * 返 `{ok:true}` 放行;返 `{ok:false, code, message}` → WS 立刻发 error 帧并 close(1008),
 * 不建容器 socket。产线接 `checkAgentAccess`(订阅 + 容器双校验);测试下可省略。
 */
export interface AgentWsPreCheckResult {
  ok: boolean;
  code?: string;
  message?: string;
}

export interface AgentWsDeps {
  jwtSecret: string | Uint8Array;
  /** 产线注入真正的 pg Pool;unit 测试下可用 writeAudit 拦截,pool 可给 undefined。 */
  pool?: Pool;
  /** uid → host 上的 agent.sock 完整路径。产线:`path.join(config.RPC_SOCKET_DIR, 'u'+uid, 'agent.sock')`。 */
  resolveSocketPath: (uid: bigint | number) => string;
  /** 可选:连接前的 DB 校验(订阅 + 容器存在性)。产线必传;测试可省 → 直接放行。 */
  preCheck?: (uid: bigint | number) => Promise<AgentWsPreCheckResult>;
  /** 可选:覆盖 audit 写入。默认走 pool + writeAgentAudit。 */
  writeAudit?: (row: AgentAuditRow) => Promise<void>;
  /** 可选:最大并发 per user(默认 1)。 */
  maxPerUser?: number;
  /** 可选:最大入站 WS 帧字节数(默认 1MB)。 */
  maxFrameBytes?: number;
  /** 可选:从容器 socket 读一行的上限(默认 4MB,对齐 agent-rpc.ts)。 */
  maxContainerLineBytes?: number;
  logger?: AgentWsLogger;
}

export interface AgentWsHandler {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  shutdown(reason?: string): Promise<void>;
  registry: ConnectionRegistry;
}

const DEFAULT_MAX_FRAME_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_CONTAINER_LINE_BYTES = 4 * 1024 * 1024;
const INPUT_META_TRUNCATE_BYTES = 4 * 1024;

const CLOSE_NORMAL = 1000;
const CLOSE_UNSUPPORTED = 1003;
const CLOSE_POLICY = 1008;
const CLOSE_TOO_BIG = 1009;
const CLOSE_INTERNAL = 1011;

const noopLogger: AgentWsLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * 通用的 agent_audit INSERT。factor 出来是为了 unit test 能绕过 pool,
 * production 注入真 pool 时调这个函数。
 */
export async function writeAgentAudit(pool: Pool, row: AgentAuditRow): Promise<void> {
  await pool.query(
    `INSERT INTO agent_audit
       (user_id, session_id, tool, input_meta, input_hash, output_hash, duration_ms, success, error_msg)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)`,
    [
      typeof row.user_id === "bigint" ? row.user_id.toString() : String(row.user_id),
      row.session_id,
      row.tool,
      JSON.stringify(row.input_meta),
      row.input_hash,
      row.output_hash,
      row.duration_ms,
      row.success,
      row.error_msg,
    ],
  );
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** 把任意 JSON 序列化并截到 INPUT_META_TRUNCATE_BYTES(粗暴 byte 级截断,保留一个 marker)。 */
function truncateMeta(obj: unknown): unknown {
  const s = JSON.stringify(obj ?? null);
  if (Buffer.byteLength(s) <= INPUT_META_TRUNCATE_BYTES) return obj;
  return {
    __truncated: true,
    __orig_bytes: Buffer.byteLength(s),
    preview: s.slice(0, INPUT_META_TRUNCATE_BYTES),
  };
}

function parseWsUrl(req: IncomingMessage): URL | null {
  const raw = req.url ?? "/";
  try { return new URL(raw, "http://placeholder"); } catch { return null; }
}

function rejectHttp(socket: Duplex, status: number, body: string): void {
  if (socket.destroyed) return;
  const headers = [
    `HTTP/1.1 ${status} ${status === 400 ? "Bad Request" : "Error"}`,
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
  ];
  try { socket.end(headers.join("\r\n") + "\r\n\r\n" + body); }
  catch { try { socket.destroy(); } catch { /* */ } }
}

function sendJson(ws: WebSocket, obj: AgentServerFrame): void {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch { /* client gone */ }
}

export function createAgentWsHandler(deps: AgentWsDeps): AgentWsHandler {
  const log = deps.logger ?? noopLogger;
  const maxFrameBytes = deps.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxContainerLineBytes = deps.maxContainerLineBytes ?? DEFAULT_MAX_CONTAINER_LINE_BYTES;
  const maxPerUser = deps.maxPerUser ?? 1;

  // audit 落地策略:优先 deps.writeAudit(测试 hook);否则必须有 pool。
  const auditWriter = deps.writeAudit
    ?? (deps.pool
      ? (row: AgentAuditRow) => writeAgentAudit(deps.pool!, row)
      : async (_row: AgentAuditRow) => {
          log.warn("agent ws: no audit writer configured (writeAudit/pool both missing); dropping row");
        });

  const registry = new ConnectionRegistry({ maxPerUser });
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes });

  async function authFromQuery(url: URL): Promise<AccessClaims | { error: string }> {
    const token = url.searchParams.get("token") ?? "";
    if (!token) return { error: "missing token query param" };
    try { return await verifyAccess(token, deps.jwtSecret); }
    catch (err) {
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
    if (url.pathname !== "/ws/agent") return false;

    // 与 chat.ts 同一套"先 upgrade 再在帧里报错"策略。
    wss.handleUpgrade(req, socket, head, (ws) => {
      // 早到帧暂存 —— 避免 auth 的 await 期间丢 message
      const pendingMessages: Array<{ data: Buffer | string | ArrayBuffer | Buffer[]; isBinary: boolean }> = [];
      let closedEarly: { code: number; reason: Buffer } | null = null;
      const earlyMessage = (data: Buffer | string | ArrayBuffer | Buffer[], isBinary: boolean): void => {
        pendingMessages.push({ data, isBinary });
      };
      const earlyClose = (code: number, reason: Buffer): void => { closedEarly = { code, reason }; };
      ws.on("message", earlyMessage);
      ws.on("close", earlyClose);

      (async () => {
        const r = await authFromQuery(url);
        if ("error" in r) {
          sendJson(ws, { type: "error", code: "UNAUTHORIZED", message: r.error });
          try { ws.close(CLOSE_POLICY, "unauthorized"); } catch { /* */ }
          return;
        }
        // T-52 Codex F2:鉴权成功后,DB 校验订阅 + 容器存在。
        // 未传 preCheck 视为放行(单测场景)。
        if (deps.preCheck) {
          try {
            const check = await deps.preCheck(uidFromClaims(r));
            if (!check.ok) {
              const code = check.code ?? "ERR_AGENT_FORBIDDEN";
              sendJson(ws, { type: "error", code, message: check.message ?? "forbidden" });
              try { ws.close(CLOSE_POLICY, "forbidden"); } catch { /* */ }
              return;
            }
          } catch (err) {
            log.error("ws agent: preCheck threw", { err: String(err) });
            sendJson(ws, { type: "error", code: "ERR_INTERNAL", message: "pre-check failed" });
            try { ws.close(CLOSE_INTERNAL, "precheck error"); } catch { /* */ }
            return;
          }
        }
        return r;
      })().then((r) => {
        ws.off("message", earlyMessage);
        ws.off("close", earlyClose);
        if (!r) return; // 失败路径已自己 close
        if (closedEarly !== null) return;
        onConnection(ws, r);
        for (const m of pendingMessages) ws.emit("message", m.data, m.isBinary);
      }, (err: unknown) => {
        ws.off("message", earlyMessage);
        ws.off("close", earlyClose);
        log.error("ws agent auth threw", { err: String(err) });
        sendJson(ws, { type: "error", code: "ERR_INTERNAL", message: "auth failure" });
        try { ws.close(CLOSE_INTERNAL, "auth error"); } catch { /* */ }
      });
    });

    return true;
  }

  /** 把 jwt claims.sub 转成 resolveSocketPath / preCheck 能接受的数值 uid。 */
  function uidFromClaims(claims: AccessClaims): bigint {
    // claims.sub 是字符串;signAccess 里强制数字,但防御性再检一遍
    if (!/^[1-9][0-9]{0,19}$/.test(claims.sub)) {
      throw new TypeError(`bad uid in claims.sub: ${claims.sub}`);
    }
    return BigInt(claims.sub);
  }

  function onConnection(ws: WebSocket, claims: AccessClaims): void {
    const connId = randomUUID();
    const sessionId = randomUUID();
    const userId = claims.sub;

    // pending tool calls。key=tool frame 的 id(stringified);value 用来还原 duration + input 补救审计。
    interface PendingTool {
      id: string;
      tool: string;
      args: unknown;
      inputJson: string; // 原始 client 发来的那一行,用来 hash
      started_at: number;
    }
    const pending = new Map<string, PendingTool>();

    const conn: Conn = {
      id: connId,
      user_id: userId,
      opened_at: Date.now(),
      close: (reason) => {
        try { sendJson(ws, { type: "error", code: "ERR_CONN_KICKED", message: reason }); }
        finally { try { ws.close(CLOSE_POLICY, "kicked"); } catch { /* */ } }
      },
    };
    const { unregister } = registry.register(conn);

    let sock: net.Socket | null = null;
    let closed = false;
    let sockBuf = Buffer.alloc(0);

    const flushPendingAsFailed = async (reason: string): Promise<void> => {
      // 把所有未回结果的 tool 写 audit.success=false。并发写即可,不走 tx。
      const rows = Array.from(pending.values());
      pending.clear();
      for (const p of rows) {
        try {
          await auditWriter({
            user_id: userId,
            session_id: sessionId,
            tool: p.tool,
            input_meta: truncateMeta(p.args),
            input_hash: sha256Hex(p.inputJson),
            output_hash: null,
            duration_ms: Date.now() - p.started_at,
            success: false,
            error_msg: reason,
          });
        } catch (err) {
          log.error("ws agent: audit write failed", { err: String(err) });
        }
      }
    };

    const cleanup = (reason: string): void => {
      if (closed) return;
      closed = true;
      unregister();
      if (sock) {
        try { sock.destroy(); } catch { /* */ }
        sock = null;
      }
      // 未完成的 tool 写失败行(异步,不 await —— cleanup 必须同步返回避免卡 close 回调)
      void flushPendingAsFailed(reason);
    };

    ws.on("error", (err) => log.warn("ws agent: ws error", { userId, connId, err: String(err) }));
    ws.on("close", () => cleanup("connection closed"));

    // -----------------------------
    // 1) 打开容器 socket
    // -----------------------------
    let socketPath: string;
    try {
      socketPath = deps.resolveSocketPath(userId as unknown as bigint);
    } catch (err) {
      sendJson(ws, { type: "error", code: "ERR_AGENT_UNAVAILABLE",
        message: `cannot resolve agent socket path: ${(err as Error).message}` });
      try { ws.close(CLOSE_INTERNAL, "resolve failed"); } catch { /* */ }
      return;
    }

    sock = net.createConnection({ path: socketPath });
    sock.on("connect", () => {
      // 连上了 → 告诉 client
      sendJson(ws, { type: "open", session_id: sessionId });
    });

    sock.on("error", (err: NodeJS.ErrnoException) => {
      // ENOENT(socket 文件不存在) / ECONNREFUSED(容器死了) → 视为 agent 不可用
      const code = err.code === "ENOENT" || err.code === "ECONNREFUSED"
        ? "ERR_AGENT_UNAVAILABLE"
        : "ERR_AGENT_SOCKET";
      log.warn("ws agent: container socket error", { userId, connId, err: err.message, code: err.code });
      sendJson(ws, { type: "error", code, message: err.message });
      try { ws.close(CLOSE_INTERNAL, "agent socket error"); } catch { /* */ }
      cleanup("agent socket error");
    });

    sock.on("close", () => {
      // 容器先挂,通知 client
      sendJson(ws, { type: "close", reason: "container socket closed" });
      try { ws.close(CLOSE_NORMAL, "agent closed"); } catch { /* */ }
      cleanup("container socket closed");
    });

    sock.on("data", (chunk: Buffer) => {
      sockBuf = Buffer.concat([sockBuf, chunk]);
      if (sockBuf.length > maxContainerLineBytes) {
        log.error("ws agent: container line too big, killing connection", { userId, connId });
        sendJson(ws, { type: "error", code: "ERR_LINE_TOO_BIG",
          message: `container frame exceeds ${maxContainerLineBytes} bytes` });
        try { ws.close(CLOSE_TOO_BIG, "line too big"); } catch { /* */ }
        cleanup("line too big");
        return;
      }
      let idx: number;
      while ((idx = sockBuf.indexOf(0x0a)) >= 0) {
        const line = sockBuf.subarray(0, idx).toString("utf8").trimEnd();
        sockBuf = sockBuf.subarray(idx + 1);
        if (line.length === 0) continue;
        let data: unknown;
        try { data = JSON.parse(line); }
        catch (err) {
          log.warn("ws agent: bad JSON from container", { userId, connId, err: String(err) });
          // 坏 JSON 不往 client 发,但记一条 error 帧让前端知道一下
          sendJson(ws, { type: "error", code: "ERR_BAD_CONTAINER_FRAME", message: "non-JSON line from container" });
          continue;
        }
        sendJson(ws, { type: "frame", data });
        // 拦截 tool_result → 写 audit
        if (data && typeof data === "object") {
          const rec = data as Record<string, unknown>;
          if (rec.type === "tool_result" && rec.id !== undefined) {
            const key = String(rec.id);
            const p = pending.get(key);
            if (p) {
              pending.delete(key);
              const success = rec.success === true;
              const errMsg = success
                ? null
                : typeof rec.stderr === "string" && rec.stderr.length > 0
                  ? rec.stderr.slice(0, 2048)
                  : "tool returned non-success";
              void auditWriter({
                user_id: userId,
                session_id: sessionId,
                tool: p.tool,
                input_meta: truncateMeta(p.args),
                input_hash: sha256Hex(p.inputJson),
                output_hash: sha256Hex(line),
                duration_ms: typeof rec.duration_ms === "number" ? rec.duration_ms : (Date.now() - p.started_at),
                success,
                error_msg: errMsg,
              }).catch((err) => {
                log.error("ws agent: audit write failed", { userId, connId, err: String(err) });
              });
            }
          }
        }
      }
    });

    // -----------------------------
    // 2) client → container
    // -----------------------------
    ws.on("message", (data, isBinary) => {
      if (closed) return;
      if (isBinary) {
        sendJson(ws, { type: "error", code: "ERR_BINARY", message: "binary frames not supported" });
        try { ws.close(CLOSE_UNSUPPORTED, "binary not supported"); } catch { /* */ }
        return;
      }
      const text = typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : String(data);
      if (Buffer.byteLength(text) > maxFrameBytes) {
        sendJson(ws, { type: "error", code: "ERR_FRAME_TOO_BIG", message: "frame exceeds max size" });
        try { ws.close(CLOSE_TOO_BIG, "frame too big"); } catch { /* */ }
        return;
      }

      let obj: unknown;
      try { obj = JSON.parse(text); }
      catch (err) {
        sendJson(ws, { type: "error", code: "ERR_BAD_JSON",
          message: err instanceof Error ? err.message : "bad JSON" });
        return;
      }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        sendJson(ws, { type: "error", code: "ERR_BAD_JSON", message: "frame must be a JSON object" });
        return;
      }
      const rec = obj as Record<string, unknown>;

      // tool 帧:记 pending(匹配 id)。如果没有 id,还是转发,但不 audit(无法对齐回包)。
      if (rec.type === "tool" && rec.id !== undefined) {
        const id = String(rec.id);
        const tool = typeof rec.tool === "string" ? rec.tool : "unknown";
        pending.set(id, {
          id,
          tool,
          args: rec.args ?? null,
          inputJson: text,
          started_at: Date.now(),
        });
      }

      // 转发到容器:加 `\n` 终止符(JSON-lines)
      if (sock && !sock.destroyed) {
        try { sock.write(text + "\n"); }
        catch (err) {
          log.error("ws agent: write to container failed", { userId, connId, err: String(err) });
          sendJson(ws, { type: "error", code: "ERR_AGENT_SOCKET", message: "write failed" });
          try { ws.close(CLOSE_INTERNAL, "write failed"); } catch { /* */ }
          cleanup("write failed");
        }
      }
    });
  }

  async function shutdown(reason = "server shutting down"): Promise<void> {
    registry.closeAll(reason);
    await new Promise<void>((resolve) => {
      try { wss.close(() => resolve()); } catch { resolve(); }
    });
  }

  return { handleUpgrade, shutdown, registry };
}
