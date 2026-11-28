import type { IncomingMessage, ServerResponse } from "node:http";
import { insertFeedback } from "../../admin/feedback.js";
import { verifyCommercialJwtSync } from "../../auth/jwtSync.js";
import { query } from "../../db/queries.js";
import { HttpError, readJsonBody, sendJson } from "../util.js";
import {
  DEFAULT_RATE_LIMITS,
  enforceRateLimit,
  type AuthenticatedHttpUser,
  type CommercialHttpDeps,
  type RequestContext,
} from "./shared.js";

function strField(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length <= max ? t : t.slice(0, max);
}

function parseFeedbackMeta(rawMeta: unknown): Record<string, unknown> {
  if (rawMeta === undefined) return {};
  if (typeof rawMeta !== "object" || rawMeta === null || Array.isArray(rawMeta)) {
    throw new HttpError(400, "VALIDATION", "meta must be an object", {
      issues: [{ path: "meta", message: "must be object" }],
    });
  }
  const serialized = JSON.stringify(rawMeta);
  if (serialized.length > 8192) {
    throw new HttpError(400, "VALIDATION", "meta too large (max 8KB)", {
      issues: [{ path: "meta", message: `${serialized.length} bytes` }],
    });
  }
  return rawMeta as Record<string, unknown>;
}

function resolveFeedbackUserId(req: IncomingMessage, jwtSecret: string | Uint8Array): string | null {
  const authorization = req.headers.authorization;
  if (!authorization) return null;
  const authHeader = authorization.replace(/^Bearer\s+/, "");
  const claims = verifyCommercialJwtSync(authHeader, jwtSecret);
  if (!claims) {
    throw new HttpError(401, "UNAUTHORIZED", "invalid or expired access token");
  }
  return claims.sub;
}

async function resolveOwnedTraceRequestId(
  userId: string | null,
  requestId: string | null,
  sessionId: string | null,
): Promise<string | null> {
  if (!userId || !requestId) return null;
  const owned = await query<{ trace_id: string }>(
    `SELECT trace_id
       FROM turn_traces
      WHERE trace_id=$1
        AND user_id=$2::bigint
        AND (
          $3::text IS NULL
          OR session_key LIKE '%:webchat:dm:' || regexp_replace($3, '[^a-zA-Z0-9_-]', '_', 'g')
        )
      LIMIT 1`,
    [requestId, userId, sessionId],
  );
  return owned.rows[0]?.trace_id ?? null;
}

export async function handleSubmitFeedback(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const cfg = deps.rateLimits?.feedback ?? DEFAULT_RATE_LIMITS.feedback;
  await enforceRateLimit(deps, cfg, ctx.clientIp);

  const userId = resolveFeedbackUserId(req, deps.jwtSecret);
  const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "VALIDATION", "invalid body");
  }

  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (description.length === 0) {
    throw new HttpError(400, "VALIDATION", "请填写反馈内容", {
      issues: [{ path: "description", message: "required" }],
    });
  }
  if (description.length > 10_000) {
    throw new HttpError(400, "VALIDATION", "description too long (max 10000)", {
      issues: [{ path: "description", message: "max 10000" }],
    });
  }

  const category = strField(body.category, 32) ?? "general";
  const sessionId = strField(body.session_id, 64);
  const requestId = await resolveOwnedTraceRequestId(
    userId,
    strField(body.request_id, 128),
    sessionId,
  );
  const version = strField(body.version, 32);
  const userAgent = strField(body.user_agent, 512) ?? strField(req.headers["user-agent"], 512);
  const meta = parseFeedbackMeta(body.meta);

  const r = await insertFeedback({
    user_id: userId,
    category,
    description,
    request_id: requestId,
    version,
    session_id: sessionId,
    user_agent: userAgent,
    meta,
  });

  ctx.log.info("feedback_submitted", { id: r.id, user_id: userId, category });
  sendJson(res, 200, { ok: true, id: r.id });
}

function parseInboxLimit(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new HttpError(400, "VALIDATION", "limit must be integer in [1,100]", {
      issues: [{ path: "limit", message: raw }],
    });
  }
  return n;
}

function parseInboxOffset(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
    throw new HttpError(400, "VALIDATION", "offset must be non-negative integer", {
      issues: [{ path: "offset", message: raw }],
    });
  }
  return n;
}

export async function serveListMyInbox(
  req: IncomingMessage,
  res: ServerResponse,
  user: AuthenticatedHttpUser,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;
  const unreadOnlyRaw = sp.get("unread_only");
  const unreadOnly = unreadOnlyRaw === "1" || unreadOnlyRaw === "true";
  const limit = parseInboxLimit(sp.get("limit"));
  const offset = parseInboxOffset(sp.get("offset"));

  const { listMyInbox } = await import("../../inbox/inbox.js");
  const r = await listMyInbox({ userId: user.id, unreadOnly, limit, offset });
  sendJson(res, 200, r);
}

export async function serveCountMyInboxUnread(
  res: ServerResponse,
  user: AuthenticatedHttpUser,
): Promise<void> {
  const { countMyUnread } = await import("../../inbox/inbox.js");
  const n = await countMyUnread(user.id);
  sendJson(res, 200, { unread_count: n });
}

export async function serveMarkInboxRead(
  req: IncomingMessage,
  res: ServerResponse,
  user: AuthenticatedHttpUser,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const m = url.pathname.match(/^\/api\/me\/messages\/([1-9][0-9]{0,19})\/read$/);
  if (!m) {
    throw new HttpError(404, "NOT_FOUND", "expected /api/me/messages/:id/read");
  }
  const id = m[1]!;
  const { markRead, InboxError } = await import("../../inbox/inbox.js");
  try {
    const r = await markRead(user.id, id);
    sendJson(res, 200, { ok: true, already: r.already });
  } catch (err) {
    if (err instanceof InboxError && err.code === "NOT_FOUND") {
      throw new HttpError(404, "NOT_FOUND", err.message);
    }
    throw err;
  }
}

export async function serveReadAllInbox(
  res: ServerResponse,
  user: AuthenticatedHttpUser,
): Promise<void> {
  const { readAll } = await import("../../inbox/inbox.js");
  const r = await readAll(user.id);
  sendJson(res, 200, { ok: true, inserted: r.inserted });
}
