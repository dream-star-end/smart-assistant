/**
 * /api/admin/feedback — 用户反馈管理(P1-2)。
 *
 * S3 拆分自 http/admin.ts。constants/helpers/handler 函数体逐字节等价
 * (plan §1.2 + §4.5 mechanical byte-equal gate)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import { requireAdmin, requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import {
  listFeedback,
  ackFeedback,
  FeedbackAssigneeInvalidError,
  FeedbackNotFoundError,
  updateFeedbackWorkflow,
  type FeedbackPriority,
  type FeedbackRowView,
} from "../../admin/feedback.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import {
  parsePositiveInt,
  parseUserId,
  parseIsoTimestamp,
  parseBigintIdParam,
} from "./_shared.js";
import {
  isSignalTrafficFilter,
  signalTrafficFilterValue,
} from "../../analytics/signalTraffic.js";

// ─── /api/admin/feedback (P1-2 反馈管理) ──────────────────────────

const FEEDBACK_MAX_LIMIT = 200;
const FEEDBACK_STATUSES = ["open", "acked", "closed"] as const;
type FeedbackStatusFilter = (typeof FEEDBACK_STATUSES)[number];

function parseFeedbackStatus(raw: string | null): FeedbackStatusFilter | undefined {
  if (raw === null || raw === "") return undefined;
  if (!(FEEDBACK_STATUSES as readonly string[]).includes(raw)) {
    throw new HttpError(400, "VALIDATION", "invalid status", {
      issues: [{ path: "status", message: raw }],
    });
  }
  return raw as FeedbackStatusFilter;
}

function serializeFeedbackRow(row: FeedbackRowView): Record<string, unknown> {
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username,
    category: row.category,
    description: row.description,
    request_id: row.request_id,
    version: row.version,
    session_id: row.session_id,
    user_agent: row.user_agent,
    meta: row.meta,
    status: row.status,
    handled_by: row.handled_by,
    handled_at: row.handled_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    traffic_class: row.traffic_class,
    assigned_to: row.assigned_to,
    priority: row.priority,
    resolution: row.resolution,
  };
}

export async function handleAdminListFeedback(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const status = parseFeedbackStatus(url.searchParams.get("status"));
  const userId = parseUserId(url.searchParams.get("user_id"));
  const beforeCreatedAt = parseIsoTimestamp(url.searchParams.get("before_created_at"), "before_created_at");
  const beforeId = parseBigintIdParam(url.searchParams.get("before_id"), "before_id");
  const limit = parsePositiveInt(url.searchParams.get("limit"), "limit", FEEDBACK_MAX_LIMIT);
  const traffic = url.searchParams.get("traffic_class") ?? "production_user";
  if (traffic !== "anonymous" && traffic !== "legacy_unavailable" && !isSignalTrafficFilter(traffic)) {
    throw new HttpError(400, "VALIDATION", "invalid traffic_class");
  }
  const r = await listFeedback({
    status,
    user_id: userId,
    before_created_at: beforeCreatedAt,
    before_id: beforeId,
    limit,
    trafficClass: traffic === "anonymous" || traffic === "legacy_unavailable"
      ? traffic
      : signalTrafficFilterValue(traffic),
  });
  sendJson(res, 200, {
    rows: r.rows.map(serializeFeedbackRow),
    next_before_created_at: r.next_before_created_at,
    next_before_id: r.next_before_id,
    totals: r.totals,
  });
}

export async function handleAdminAckFeedback(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  // 写操作 + 改 status + 写 audit:用 DB double-check
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  // /api/admin/feedback/:id/ack → 抠 :id
  const m = url.pathname.match(/^\/api\/admin\/feedback\/([^/]+)\/ack$/);
  if (!m) {
    throw new HttpError(400, "VALIDATION", "invalid feedback id in URL", {
      issues: [{ path: "id", message: url.pathname }],
    });
  }
  // 走统一的 BIGINT 范围校验,超 9223372036854775807 直接 400 而非 DB 500
  const id = parseBigintIdParam(m[1], "id");
  if (!id) {
    throw new HttpError(400, "VALIDATION", "invalid feedback id in URL", {
      issues: [{ path: "id", message: m[1] }],
    });
  }
  try {
    const row = await ackFeedback(id, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { feedback: serializeFeedbackRow(row) });
  } catch (err) {
    if (err instanceof FeedbackNotFoundError) {
      throw new HttpError(404, "FEEDBACK_NOT_FOUND", err.message);
    }
    throw err;
  }
}

const WORKFLOW_RE = /^\/api\/admin\/feedback\/([^/]+)\/(assign|priority|resolution|close|reopen)$/;
const PRIORITIES = new Set<FeedbackPriority>(["low", "normal", "high", "urgent"]);

export async function handleAdminFeedbackWorkflow(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const match = WORKFLOW_RE.exec(url.pathname);
  if (!match) throw new HttpError(404, "NOT_FOUND", "endpoint not found");
  const id = parseBigintIdParam(match[1], "id");
  if (!id) throw new HttpError(400, "VALIDATION", "invalid feedback id in URL");
  const body = ((await readJsonBody(req, 8 * 1024)) ?? {}) as Record<string, unknown>;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "body must be a JSON object");
  }
  const kind = match[2]!;
  let action: Parameters<typeof updateFeedbackWorkflow>[1];
  if (kind === "assign") {
    const value = body.assigned_to;
    if (value !== null && (typeof value !== "string" || parseBigintIdParam(value, "assigned_to") === undefined)) {
      throw new HttpError(400, "VALIDATION", "assigned_to must be a bigint string or null");
    }
    action = { kind, assigned_to: value as string | null };
  } else if (kind === "priority") {
    const value = body.priority;
    if (value !== null && (typeof value !== "string" || !PRIORITIES.has(value as FeedbackPriority))) {
      throw new HttpError(400, "VALIDATION", "invalid priority");
    }
    action = { kind, priority: value as FeedbackPriority | null };
  } else if (kind === "resolution") {
    const value = body.resolution;
    if (value !== null && (typeof value !== "string" || value.length > 8_000)) {
      throw new HttpError(400, "VALIDATION", "resolution must be a string (max 8000) or null");
    }
    action = { kind, resolution: value as string | null };
  } else if (kind === "close") {
    const value = body.resolution;
    if (value !== undefined && (typeof value !== "string" || value.length > 8_000)) {
      throw new HttpError(400, "VALIDATION", "resolution must be a string (max 8000)");
    }
    action = { kind, ...(typeof value === "string" ? { resolution: value } : {}) };
  } else {
    action = { kind: "reopen" };
  }
  try {
    const row = await updateFeedbackWorkflow(id, action, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { feedback: serializeFeedbackRow(row) });
  } catch (err) {
    if (err instanceof FeedbackNotFoundError) {
      throw new HttpError(404, "FEEDBACK_NOT_FOUND", err.message);
    }
    if (err instanceof FeedbackAssigneeInvalidError) {
      throw new HttpError(400, "VALIDATION", err.message);
    }
    throw err;
  }
}
