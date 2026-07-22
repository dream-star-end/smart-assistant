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

const SAFE_LOWER = /^[a-z0-9_]{1,48}$/;
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
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
  const code = typeof body.code === "string" && SAFE_CODE.test(body.code)
    ? body.code : "CLIENT_UNKNOWN";
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
  }).catch(() => {
    // Telemetry must never affect the user path; emit only the stable class.
    ctx.log.warn("client_friction_persist_failed", {
      surface: report.surface, stage: report.stage, code: report.code,
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
