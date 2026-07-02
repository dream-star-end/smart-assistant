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
 *   - 单个 event 失败不阻塞后续(与原进程内 hook 的 fail-soft 一致:persist 失败
 *     只 log,broadcast 照发)。响应始终 200 {accepted} —— egress 不因个别失败重发
 *     整批(persist 幂等性依赖 requestId 去重,但 broadcast 重发会闪双帧,不值得)。
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
  ) => Promise<unknown>;
  broadcastToUser: (uid: bigint, payload: unknown) => void;
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

    let accepted = 0;
    for (const raw of events) {
      const ev = parseEvent(raw);
      if (!ev) continue;
      try {
        if (ev.kind === "persist") {
          await deps.appendCostCredits(ev.requestId, ev.uid, ev.costCredits, ev.sessionId ?? null);
        } else {
          deps.broadcastToUser(BigInt(ev.uid), ev.payload);
        }
        accepted += 1;
      } catch (err) {
        // fail-soft:与原进程内 hook 一致 —— persist 失败靠 pending_usage_patches
        // GC sweep 兜底可见,broadcast 失败只是气泡不实时。
        log.warn("cost_event_apply_failed", { kind: ev.kind, err: (err as Error).message });
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
    return {
      kind: "persist",
      requestId: raw.requestId,
      uid: raw.uid,
      costCredits: raw.costCredits,
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
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
