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
import { query, type QueryRunner } from "../db/queries.js";

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

export function isBrowserFirstTextPaintNamespace(report: NormalizedClientFrictionReport): boolean {
  return report.surface === "webchat" && report.stage === "first_text_paint";
}

export function isBrowserFirstTextPaintReport(report: NormalizedClientFrictionReport): boolean {
  return isBrowserFirstTextPaintNamespace(report) &&
    report.outcome === "succeeded" &&
    (report.code === "FIRST_TEXT_PAINT" || report.code === "FIRST_TEXT_PAINT_AFTER_BACKGROUND");
}

export async function resolveOwnedFirstTextPaintAttribution(
  report: NormalizedClientFrictionReport,
  userId: bigint,
  runner?: QueryRunner,
): Promise<{ model: string | null; provider: string | null } | null> {
  if (
    !isBrowserFirstTextPaintReport(report) ||
    !report.traceId ||
    !report.sessionId ||
    report.latencyMs == null
  ) return null;
  const attribution = await query<{
    model: string | null;
    provider: string | null;
  }>(
    `SELECT t.model,mc.provider_id AS provider
       FROM turn_traces t
       JOIN turn_dispatches d
         ON d.dispatch_id=t.dispatch_id
        AND d.user_id=t.user_id
        AND d.session_id=$3
       LEFT JOIN LATERAL (
         SELECT provider_id FROM model_catalog
          WHERE model_id=t.model ORDER BY created_at DESC LIMIT 1
       ) mc ON TRUE
      WHERE t.trace_id=$1 AND t.user_id=$2::bigint
      LIMIT 1`,
    [report.traceId,userId.toString(),report.sessionId],
    runner,
  ).catch(() => ({ rows: [], rowCount: 0 }));
  return attribution.rows[0] ?? null;
}

export function classifyClientFrictionPersistError(err: unknown): {
  errorClass: string;
  errorCode: string | null;
  errorConstraint: string | null;
} {
  const fields = err && typeof err === "object" ? err as Record<string, unknown> : {};
  return {
    errorClass: err instanceof Error ? err.constructor.name : typeof err,
    errorCode: safeToken(fields.code, 32, /^[A-Za-z0-9_.:-]+$/),
    errorConstraint: safeToken(fields.constraint, 128, /^[A-Za-z0-9_.:-]+$/),
  };
}

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
    entitySlug: safeToken(body.entity_slug, 128, /^[a-z0-9][a-z0-9._-]*$/),
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
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendJson(res, 200, { ok: true });
    return;
  }

  const persist = async (report: NormalizedClientFrictionReport): Promise<boolean> => {
    let enriched = report;
    if (isBrowserFirstTextPaintNamespace(report)) {
      // The entire namespace is reserved. Malformed code/outcome and anonymous
      // requests must not fall through into generic product-friction storage.
      if (
        !isBrowserFirstTextPaintReport(report) ||
        userId === null ||
        !report.traceId ||
        !report.sessionId ||
        report.latencyMs == null
      ) {
        return false;
      }
      // This latency is accepted only when trace + session + authenticated user
      // resolve to the same durable turn. Independent hints must never be joined.
      const row = await resolveOwnedFirstTextPaintAttribution(report, userId);
      if (!row) return false;
      enriched = {
        ...report,
        model: row.model,
        provider: row.provider,
      };
    } else if (
      userId !== null &&
      report.traceId &&
      (!report.model || !report.provider || report.latencyMs == null)
    ) {
      const attribution = await query<{
        model: string | null;
        provider: string | null;
        latency_ms: number | null;
      }>(
        `SELECT t.model,mc.provider_id AS provider,
                CASE WHEN d.admitted_at IS NULL THEN NULL
                     ELSE LEAST(86400000,GREATEST(0,EXTRACT(EPOCH FROM (NOW()-d.admitted_at))*1000))::int END AS latency_ms
           FROM turn_traces t
           LEFT JOIN turn_dispatches d ON d.dispatch_id=t.dispatch_id
           LEFT JOIN LATERAL (
             SELECT provider_id FROM model_catalog
              WHERE model_id=t.model ORDER BY created_at DESC LIMIT 1
           ) mc ON TRUE
          WHERE t.trace_id=$1 AND t.user_id=$2::bigint
          LIMIT 1`,
        [report.traceId,userId.toString()],
      ).catch(() => ({ rows: [], rowCount: 0 }));
      const row = attribution.rows[0];
      enriched = {
        ...report,
        model: report.model ?? row?.model ?? null,
        provider: report.provider ?? row?.provider ?? null,
        latencyMs: report.latencyMs ?? row?.latency_ms ?? null,
      };
    }
    await recordProductFrictionEvent({ ...enriched, userId }).catch((err: unknown) => {
    // Telemetry must never affect the user path. Keep only structural database
    // diagnostics: PostgreSQL messages can include rejected row values, so raw
    // message/detail/stack must not become a second telemetry payload.
      ctx.log.warn("client_friction_persist_failed", {
        surface: report.surface, stage: report.stage, code: report.code,
        ...classifyClientFrictionPersistError(err),
      });
    });
    return true;
  };

  const events = body.events;
  if (Array.isArray(events)) {
    // Marketplace pages expose at most one 50-card page per request. Batch only
    // authenticated signals so the existing 30 req/min anti-spam boundary is not
    // multiplied for anonymous callers.
    if (!claims || events.length < 1 || events.length > 50) {
      sendJson(res, 200, { ok: true });
      return;
    }
    const reports = events
      .filter((event): event is Record<string, unknown> =>
        !!event && typeof event === "object" && !Array.isArray(event))
      .map((event, index) => normalizeClientFrictionReport(event, `${ctx.requestId}-${index}`));
    for (const report of reports) await persist(report);
    ctx.log.info("client_friction_batch_report", { uid: claims.sub, count: reports.length });
    sendJson(res, 200, { ok: true });
    return;
  }

  const report = normalizeClientFrictionReport(body, ctx.requestId);
  const persisted = await persist(report);
  if (!persisted) {
    sendJson(res, 200, { ok: true });
    return;
  }

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
