/**
 * V3/V5 commercial — 容器 gateway → master 的 turn 级免单上报。
 *
 * 触发方:容器 gateway 在 idle-timeout 杀 turn(用户视角 = "本轮模型无响应/超时")
 * 后,把 (ccb sessionId, turn 起始 ms, reason) POST 过来;master 按窗口冲正该 turn
 * 已扣的费用(billing/refund.ts refundSessionWindow),并向该用户 WS 广播
 * `outbound.cost_waived`(前端把该轮已显示的积分消耗改成免单态 + 刷余额气泡)。
 *
 * Trust boundary(与 anthropicProxy / serverAuthored 同款):
 *   - verifyContainerIdentity 双因子(bearer + bound_ip),userId 从已验证身份取,
 *     wire 上不收 userId —— 容器只可能免掉"自己这个用户"的账。
 *   - sessionId 只用作该用户名下 usage_records 的过滤键;跨租户记录 WHERE user_id
 *     恒不命中,伪造别人的 sessionId 退不到别人的钱。
 *   - 滥用面评估:容器内 AI 理论上可拿容器 token 伪造本 endpoint 请求,把"自己
 *     真实消费"的 turn 报成超时 → 只损平台不损他人,且 refund ledger 全量留痕
 *     (reason='refund' + memo waive:*)可审计、可回收;另设 per-user 节流兜底。
 *
 * 幂等:refundSessionWindow 内 advisory lock + 已退记录跳过;同一 turn 重复上报
 * 第二次 refunded=0,响应仍 200。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { rootLogger, type Logger } from "../logging/logger.js";
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders, isObj } from "./util.js";
import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from "../auth/containerIdentity.js";
import { refundSessionWindow } from "../billing/refund.js";
import type { Pool } from "pg";

export const TURN_WAIVE_PATH = "/internal/v3/turn-waive";

const MAX_BODY_BYTES = 2 * 1024;
/** sinceTs 合法窗口:太老(>24h)拒 —— 防陈旧/重放的超宽退款;允许 60s 未来时钟偏移。 */
const MAX_WINDOW_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;
/** per-user 节流:一轮 turn 只会产生一次上报,正常频率极低;5s 内重复直接 429。 */
const MIN_GAP_MS = 5 * 1000;

const WAIVE_REASONS = new Set(["idle_timeout", "no_response"]);
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface TurnWaiveHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  pgPool: Pool;
  /** 推 outbound.cost_waived 给该 uid 的所有 WS 连接(bridge broadcast ref)。 */
  broadcastToUser?: (uid: bigint, payload: Record<string, unknown>) => void;
  logger?: Logger;
}

export interface TurnWaiveHandlerCtx {
  hostUuid: string;
  boundIp: string;
}

export type TurnWaiveHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TurnWaiveHandlerCtx,
) => Promise<void>;

export function makeTurnWaiveHandler(deps: TurnWaiveHandlerDeps): TurnWaiveHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "internalTurnWaive" });
  const lastCallByUser = new Map<string, number>();

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const reqLog = log.child({ requestId, hostUuid: ctx.hostUuid, boundIp: ctx.boundIp });

    if (req.method !== "POST") {
      sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } });
      return;
    }

    let userId: bigint;
    try {
      const identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization);
      userId = BigInt(identity.userId);
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        reqLog.warn("identity_failed", { errcode: err.code });
        sendJson(res, 401, {
          error: { code: "UNAUTHORIZED", message: "container identity verification failed" },
        });
        return;
      }
      throw err;
    }

    let body: unknown;
    try {
      body = await readBoundedJson(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, 400, { error: { code: "INVALID_BODY", message: (err as Error).message } });
      return;
    }
    if (!isObj(body)) {
      sendJson(res, 400, { error: { code: "INVALID_BODY", message: "object body required" } });
      return;
    }
    const sessionId = body.sessionId;
    const sinceTs = body.sinceTs;
    const reason = body.reason;
    if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
      sendJson(res, 400, { error: { code: "INVALID_BODY", message: "sessionId malformed" } });
      return;
    }
    if (typeof sinceTs !== "number" || !Number.isFinite(sinceTs)) {
      sendJson(res, 400, { error: { code: "INVALID_BODY", message: "sinceTs must be ms epoch number" } });
      return;
    }
    if (typeof reason !== "string" || !WAIVE_REASONS.has(reason)) {
      sendJson(res, 400, { error: { code: "INVALID_BODY", message: "reason not allowed" } });
      return;
    }
    const now = Date.now();
    if (sinceTs < now - MAX_WINDOW_AGE_MS || sinceTs > now + MAX_CLOCK_SKEW_MS) {
      sendJson(res, 400, { error: { code: "WINDOW_OUT_OF_RANGE", message: "sinceTs outside allowed window" } });
      return;
    }

    const uidKey = userId.toString();
    const last = lastCallByUser.get(uidKey) ?? 0;
    if (now - last < MIN_GAP_MS) {
      sendJson(res, 429, { error: { code: "RATE_LIMITED", message: "too many waive reports" } });
      return;
    }
    lastCallByUser.set(uidKey, now);
    // Map 无界增长防护:超 1w 用户条目时全清(节流是软保护,清空只影响限速不影响正确性)。
    if (lastCallByUser.size > 10_000) lastCallByUser.clear();

    try {
      const result = await refundSessionWindow(deps.pgPool, {
        userId,
        sessionId,
        sinceMs: sinceTs,
        memo: `waive:${reason}`,
        logger: reqLog,
      });
      if (result.refundedCredits > 0n && deps.broadcastToUser) {
        try {
          deps.broadcastToUser(userId, {
            type: "outbound.cost_waived",
            sessionId,
            refundedCredits: result.refundedCredits.toString(),
            balanceAfter: result.totalAfter === null ? null : result.totalAfter.toString(),
            reason,
          });
        } catch (err) {
          reqLog.warn("waive_broadcast_failed", { err: (err as Error).message });
        }
      }
      reqLog.info("turn_waive_handled", {
        userId: uidKey,
        sessionId,
        reason,
        refundedCredits: result.refundedCredits.toString(),
        recordCount: result.recordCount,
      });
      sendJson(res, 200, {
        ok: true,
        refundedCredits: result.refundedCredits.toString(),
        recordCount: result.recordCount,
      });
    } catch (err) {
      reqLog.error("turn_waive_failed", { err: (err as Error).message, sessionId });
      sendJson(res, 500, { error: { code: "INTERNAL", message: "refund failed" } });
    }
  };
}

// ─── private helpers ────────────────────────────────────────────────────────

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
