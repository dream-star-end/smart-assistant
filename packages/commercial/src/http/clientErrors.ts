/**
 * POST /api/client-errors — bounded browser product-friction signals.
 *
 * The legacy endpoint accepted message/stack/path/URL/UA and copied them to
 * journald.  It now accepts stable classifications only and persists them in
 * the recovery-aware table. Unknown/raw fields are ignored, so telemetry can
 * never become a second copy of conversation or browser data.
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
import { recordProductFrictionEvent, type FrictionOutcome } from "../productFriction/events.js";
import { isKnownTurnErrorCode } from "@openclaude/protocol/turnErrorTaxonomy";

const SAFE_LOWER = /^[a-z0-9_]{1,48}$/;
const SAFE_CODE = /^[A-Za-z0-9_]{1,64}$/;
const OUTCOMES = new Set<FrictionOutcome>([
  "pending", "failed", "recovered", "succeeded", "abandoned", "cancelled",
]);

function safeToken(value: unknown, max: number, pattern: RegExp): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return null;
  return pattern.test(value) ? value : null;
}

function safeId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(value) ? value : null;
}

export type NormalizedClientFrictionReport = Omit<
  Parameters<typeof recordProductFrictionEvent>[0],
  "userId"
>;

/** Reduce an untrusted browser body to the exact bounded telemetry schema.
 * Raw message/stack/path/URL/UA and every unknown field are deliberately
 * absent from the returned value. */
export function normalizeClientFrictionReport(
  body: Record<string, unknown>,
  fallbackEventId: string,
): NormalizedClientFrictionReport {
  const surface = typeof body.surface === "string" && SAFE_LOWER.test(body.surface)
    ? body.surface : "client";
  const stageRaw = typeof body.stage === "string" ? body.stage : body.type;
  const stage = typeof stageRaw === "string" && SAFE_LOWER.test(stageRaw)
    ? stageRaw : "runtime";
  // code 口径:**protocol 的 turnErrorTaxonomy 是单一权威**,其码全为小写
  // (insufficient_credits / model_capacity / upstream_failed …)。已知码原样保留 ——
  // 0192 之前 DB 的 `^[A-Z0-9_]$` CHECK 会把它们整批拒掉、再被下面的 .catch() 吞掉,
  // 导致"凡是被正确分类的错误 100% 落不了库"(线上实测 30 天零条小写)。
  // 未登记的码仍走字符集兜底,防任意串写库;都不满足才回退 CLIENT_UNKNOWN。
  const rawCode = typeof body.code === "string" ? body.code : null;
  const code = rawCode && (isKnownTurnErrorCode(rawCode) || SAFE_CODE.test(rawCode))
    ? rawCode : "CLIENT_UNKNOWN";
  const outcome = typeof body.outcome === "string" && OUTCOMES.has(body.outcome as FrictionOutcome)
    ? body.outcome as FrictionOutcome : "failed";
  const traceId = safeId(body.trace_id);
  const sessionId = safeId(body.session_id);
  return {
    correlation: safeId(body.event_id) ?? traceId ?? safeId(body.request_id) ?? fallbackEventId,
    surface,
    stage,
    code,
    outcome,
    attempts: typeof body.attempts === "number" ? body.attempts : 1,
    latencyMs: typeof body.latency_ms === "number" ? body.latency_ms : null,
    model: safeToken(body.model, 128, /^[A-Za-z0-9_.:+/-]+$/),
    provider: safeToken(body.provider, 32, /^[a-z0-9_-]+$/),
    clientBuild: safeToken(body.client_build, 64, /^[A-Za-z0-9._-]+$/),
    browserFamily: safeToken(body.browser_family, 24, /^[a-z0-9_]+$/),
    deviceClass: ["desktop", "mobile", "tablet", "unknown"].includes(String(body.device_class))
      ? body.device_class as "desktop" | "mobile" | "tablet" | "unknown"
      : "unknown",
    traceId,
    sessionId,
  };
}

export async function handleClientErrorReport(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const cfg = deps.rateLimits?.clientErrors ?? DEFAULT_RATE_LIMITS.clientErrors;
  await enforceRateLimit(deps, cfg, ctx.clientIp);

  const authHeader = req.headers.authorization?.replace(/^Bearer\s+/, "") ?? "";
  const claims = authHeader ? verifyCommercialJwtSync(authHeader, deps.jwtSecret) : null;
  let userId: bigint | null = null;
  if (claims && /^\d+$/.test(claims.sub)) userId = BigInt(claims.sub);

  const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") {
    sendJson(res, 200, { ok: true });
    return;
  }

  const report = normalizeClientFrictionReport(body, ctx.requestId);

  await recordProductFrictionEvent({
    ...report,
    userId,
  }).catch((err: unknown) => {
    // 遥测绝不影响用户路径,所以这里只记不抛。但**必须带上错误类** ——
    // 旧实现只记 surface/stage/code,于是 2026-07-26 之前 DB CHECK 把全部小写码
    // 拒了一个月,日志里只有一句无信息量的 persist_failed,没人能从中看出根因
    // (最后是靠人工比对 migrations 与 taxonomy 才发现)。errorClass + 截断 detail
    // 足以区分"约束违反 / 连接失败 / 序列化错误",且不含任何用户内容。
    ctx.log.warn("client_friction_persist_failed", {
      surface: report.surface, stage: report.stage, code: report.code,
      errorClass: err instanceof Error ? err.constructor.name : typeof err,
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    });
  });

  const logFields = {
    uid: claims?.sub ?? null,
    surface: report.surface,
    stage: report.stage,
    code: report.code,
    outcome: report.outcome,
  };
  if (report.outcome === "failed") {
    ctx.log.warn("client_friction_report", logFields);
  } else {
    ctx.log.info("client_friction_report", logFields);
  }
  sendJson(res, 200, { ok: true });
}
