/**
 * POST /api/client-errors — 前端问题自动上报端点。
 *
 * 设计目标(2026-06-18):前台出现任何问题(全局 JS 异常 / unhandledrejection /
 * 接口失败 / 流式中断)时,浏览器 fire-and-forget 把上下文打到这里。后端**不入库**,
 * 而是用结构化 logger 落 journald —— 与上游 turn 日志同一条流,且把前端看到的
 * `traceId`(响应底部那串"请求ID")作为 top-level 字段打出来。这样运维 grep 一个
 * traceId 就能把"用户截图里的报错"与"master 这一轮的全链路日志"串起来,提升定位效率。
 *
 * 为什么不入库:
 *   - 错误上报天然高频/可突发,DB 表会被噪声淹没且需要 GC / admin 页面;
 *   - 真正的定位价值在"与现有 turn 日志同流、可按 traceId 关联",日志流已满足;
 *   - 若将来要做错误趋势统计,再单独加一张表 + admin tab(本期不做,见需求决策)。
 *
 * 安全:
 *   - 限流 clientErrors(30/min/IP):比 feedback(5/min)宽,因为一个坏页面会连发几条,
 *     但仍挡住脚本刷日志。前端侧另有签名节流(见 web/api.js reportClientError)。
 *   - 仅 Bearer 关联 uid(与 feedback 一致,cookie 关联会被 CSRF 误绑);匿名也接收。
 *   - 所有字段硬上限截断,绝不把超大 stack/meta 灌进日志。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "./util.js";
import {
  DEFAULT_RATE_LIMITS,
  enforceRateLimit,
  type CommercialHttpDeps,
  type RequestContext,
} from "./handlers.js";
import { verifyCommercialJwtSync } from "../auth/jwtSync.js";

/** 截断而不抛错:上报字段长度可能超限但语义无损,截断后照常落日志。 */
function clampStr(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length <= max ? t : t.slice(0, max);
}

function clampInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

/** traceId / requestId 形态守卫:只接受 alnum + - _,长度 ≤ 64,
 *  与 protocol/traceId.ts TRACE_ID_REGEX 及 commercial requestId 形态对齐。
 *  非法值丢弃(返回 null)而非截断,避免把垃圾当成关联键打进日志误导排查。 */
function safeCorrelationId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
}

export async function handleClientErrorReport(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const cfg = deps.rateLimits?.clientErrors ?? DEFAULT_RATE_LIMITS.clientErrors;
  await enforceRateLimit(deps, cfg, ctx.clientIp);

  // 仅 Bearer 关联 user_id;匿名上报也接收(报错时可能 token 已失效)。
  const authHeader = req.headers.authorization?.replace(/^Bearer\s+/, "") ?? "";
  let uid: string | null = null;
  if (authHeader) {
    const claims = verifyCommercialJwtSync(authHeader, deps.jwtSecret);
    if (claims) uid = claims.sub;
  }

  const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") {
    // 上报端点对脏 body 宽容:不抛 400(否则前端上报失败又触发新一轮上报),
    // 直接 200 吞掉。
    sendJson(res, 200, { ok: true });
    return;
  }

  // 前端看到的"请求ID" = master per-turn traceId;turn 无关的纯 JS 异常没有它。
  const traceId = safeCorrelationId(body.trace_id);
  // 接口失败时携带的 commercial proxy x-request-id(与 traceId 不同层,1:N)。
  const reqId = safeCorrelationId(body.request_id);
  const errType = clampStr(body.type, 48) ?? "unknown";
  const name = clampStr(body.name, 128);
  const message = clampStr(body.message, 2048) ?? "(no message)";
  const stackHead = clampStr(body.stack, 4096);
  const route = clampStr(body.route, 512);
  const filename = clampStr(body.filename, 512);
  const version = clampStr(body.version, 32);
  const sessionId = clampStr(body.session_id, 64);
  const userAgent =
    clampStr(body.user_agent, 512) ?? clampStr(req.headers["user-agent"], 512);
  const lineno = clampInt(body.lineno);
  const colno = clampInt(body.colno);

  // 结构化日志:traceId / requestId 作为 top-level 关联键。ctx.log 已 child-bind 了
  // 本次上报 HTTP 调用自己的 requestId(ensureRequestId),与用户侧 traceId 区分开。
  // 用 warn 级:是真实信号(前端确实出问题了)但不是服务端 error,不污染 error 率告警;
  // 运维按 msg tag "client_error_report" + traceId 过滤即可。
  ctx.log.warn("client_error_report", {
    uid,
    ...(traceId ? { traceId } : {}),
    ...(reqId ? { clientRequestId: reqId } : {}),
    errType,
    ...(name ? { errName: name } : {}),
    message,
    ...(route ? { route } : {}),
    ...(filename ? { filename } : {}),
    ...(lineno !== null ? { lineno } : {}),
    ...(colno !== null ? { colno } : {}),
    ...(version ? { clientVersion: version } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(stackHead ? { stackHead } : {}),
  });

  sendJson(res, 200, { ok: true });
}
