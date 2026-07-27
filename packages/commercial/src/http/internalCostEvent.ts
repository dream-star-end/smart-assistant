/**
 * V5 egress 进程解耦 — master 控制口的 cost 回执接收端。
 *
 * 背景:anthropicProxy 拆进独立 egress 进程后,finalize.commit 之后的两个
 * post-commit hook 跨进程了:
 *   1. appendCostCredits — 写 master SQLite session 存储(pending_usage_patches /
 *      server_authored_request_map),消息 usage.costCredits 徽章的持久来源;
 *   2. broadcastToUser(outbound.cost_charged)— 经 userChatBridge 推给用户 WS。
 * 两者都只有 master 进程能做(SQLite 单写者 + WS 连接都在 master),egress 把它们
 * 打包成 cost-event POST 到本 endpoint。
 *
 * Trust boundary:
 *   - 监听在 master 控制口(loopback-only),容器无法直连;但容器流量会经 egress
 *     的转发面到达控制口,egress 端已 deny /internal/v5/*,本端再验共享秘钥头
 *     `x-oc-egress-secret`(timing-safe)双保险。秘钥来自两进程共用的 env 文件。
 *   - uid 由 egress 从容器身份验证结果注入,master 不再二验(egress 是平台进程,
 *     与 master 同信任级;这条链等价于原先进程内闭包传参)。
 *
 * 语义:
 *   - events 数组按序处理(persist 先于 broadcast 的顺序由 egress 入队顺序保证)。
 *   - 任一 event 非法或 apply 失败即返回非 2xx,egress 保留 fsync'd persist receipt
 *     重试。生产 egress 每请求只发一个 event,所以不会因批内部分成功重放广播。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { rootLogger, type Logger } from "../logging/logger.js";
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders, isObj } from "./util.js";

export const COST_EVENT_PATH = "/internal/v5/cost-event";
export const EGRESS_SECRET_HEADER = "x-oc-egress-secret";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_EVENTS_PER_BATCH = 64;

export interface CostEventPersist {
  kind: "persist";
  requestId: string;
  /** 裸 uid(十进制字符串)。master 侧 appendCostCredits 自己加 c: 前缀。 */
  uid: string;
  costCredits: string;
  sessionId?: string | null;
  /** delegate 子会话的父客户端会话 id(web-*);普通 chat / codex 自费为 null。
   *  egress→master 必须透传,否则委派成本 durable 归并(Fix A)在 split 模式失效。 */
  parentSessionId?: string | null;
  delegateAgentId?: string | null;
  turnKey?: string | null;
  parentTurnKey?: string | null;
}

export interface CostEventBroadcast {
  kind: "broadcast";
  uid: string;
  /** 完整 outbound.cost_charged 帧(egress 侧已组好,master 不改写)。 */
  payload: Record<string, unknown>;
}

export type CostEvent = CostEventPersist | CostEventBroadcast;

export interface CostEventHandlerDeps {
  /** env OC_EGRESS_SECRET;未配 → handler 一律 503(split 模式漏配秘钥要 loud)。 */
  secret: string | undefined;
  appendCostCredits: (
    requestId: string,
    rawUserId: string,
    costCredits: string,
    sessionId?: string | null,
    parentSessionId?: string | null,
    delegateAgentId?: string | null,
    turnKey?: string | null,
    parentTurnKey?: string | null,
  ) => Promise<unknown>;
  broadcastToUser: (uid: bigint, payload: unknown) => void | Promise<void>;
  logger?: Logger;
}

export type CostEventHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function makeCostEventHandler(deps: CostEventHandlerDeps): CostEventHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "internalCostEvent" });

  return async function handle(req, res) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    if (req.method !== "POST") {
      sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } });
      return;
    }
    if (!deps.secret) {
      sendJson(res, 503, { error: { code: "EGRESS_SECRET_UNSET", message: "OC_EGRESS_SECRET not configured" } });
      return;
    }
    const presented = req.headers[EGRESS_SECRET_HEADER];
    if (typeof presented !== "string" || !safeEqual(presented, deps.secret)) {
      log.warn("egress_secret_mismatch", {});
      sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "bad egress secret" } });
      return;
    }

    let body: unknown;
    try {
      body = await readBoundedJson(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, 400, { error: { code: "INVALID_BODY", message: (err as Error).message } });
      return;
    }
    const events = isObj(body) && Array.isArray(body.events) ? body.events : null;
    if (!events || events.length === 0 || events.length > MAX_EVENTS_PER_BATCH) {
      sendJson(res, 400, { error: { code: "INVALID_BODY", message: "events[] required (1..64)" } });
      return;
    }

    const parsedEvents: CostEvent[] = [];
    for (const raw of events) {
      const ev = parseEvent(raw);
      if (!ev) {
        sendJson(res, 400, { error: { code: "INVALID_EVENT", message: "cost event schema rejected" } });
        return;
      }
      parsedEvents.push(ev);
    }

    let accepted = 0;
    for (const ev of parsedEvents) {
      try {
        if (ev.kind === "persist") {
          await deps.appendCostCredits(
            ev.requestId,
            ev.uid,
            ev.costCredits,
            ev.sessionId ?? null,
            ev.parentSessionId ?? null,
            ev.delegateAgentId ?? null,
            ev.turnKey ?? null,
            ev.parentTurnKey ?? null,
          );
        } else {
          await deps.broadcastToUser(BigInt(ev.uid), ev.payload);
        }
        accepted += 1;
      } catch (err) {
        log.warn("cost_event_apply_failed", { kind: ev.kind, err: (err as Error).message });
        sendJson(res, 503, {
          error: { code: "COST_EVENT_APPLY_FAILED", message: "cost event was not acknowledged" },
          accepted,
        });
        return;
      }
    }
    sendJson(res, 200, { ok: true, accepted });
  };
}

function parseEvent(raw: unknown): CostEvent | null {
  if (!isObj(raw)) return null;
  if (raw.kind === "persist") {
    if (
      typeof raw.requestId !== "string" ||
      typeof raw.uid !== "string" ||
      !/^\d+$/.test(raw.uid) ||
      typeof raw.costCredits !== "string"
    ) {
      return null;
    }
    const nullableStrings = [raw.sessionId, raw.parentSessionId, raw.delegateAgentId];
    if (nullableStrings.some((value) => value !== undefined && value !== null && typeof value !== "string")) {
      return null;
    }
    if (
      (raw.turnKey !== undefined && raw.turnKey !== null &&
        (typeof raw.turnKey !== "string" || !/^[0-9a-f]{64}$/.test(raw.turnKey))) ||
      (raw.parentTurnKey !== undefined && raw.parentTurnKey !== null &&
        (typeof raw.parentTurnKey !== "string" || !/^[0-9a-f]{64}$/.test(raw.parentTurnKey)))
    ) {
      // Never ACK a persist event after silently erasing its exact join key.
      return null;
    }
    return {
      kind: "persist",
      requestId: raw.requestId,
      uid: raw.uid,
      costCredits: raw.costCredits,
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
      parentSessionId: typeof raw.parentSessionId === "string" ? raw.parentSessionId : null,
      delegateAgentId: typeof raw.delegateAgentId === "string" ? raw.delegateAgentId : null,
      turnKey: typeof raw.turnKey === "string" ? raw.turnKey : null,
      parentTurnKey: typeof raw.parentTurnKey === "string" ? raw.parentTurnKey : null,
    };
  }
  if (raw.kind === "broadcast") {
    if (typeof raw.uid !== "string" || !/^\d+$/.test(raw.uid) || !isObj(raw.payload)) return null;
    return { kind: "broadcast", uid: raw.uid, payload: raw.payload };
  }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readBoundedJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string);
    total += b.length;
    if (total > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes`);
    chunks.push(b);
  }
  if (total === 0) throw new Error("empty body");
  return JSON.parse(Buffer.concat(chunks, total).toString("utf-8"));
}
