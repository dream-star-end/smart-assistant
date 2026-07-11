/**
 * /api/admin/audit — admin_audit 操作日志只读列表。
 *
 * S3 拆分自 http/admin.ts。审计体系整改批扩展:
 *   - GET /api/admin/audit 增加 target / created_from / created_to 过滤;
 *   - GET /api/admin/security-events 安全事件流(语义三分层第二层,0129);
 *   - GET /api/admin/host-audit 主机审计全量浏览(此前只在 host 弹窗露 20 条);
 *   - GET /api/admin/trace/:traceId 请求ID反查(turn_traces,此前只能 psql 手查)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../util.js";
import { HttpError } from "../util.js";
import { requireAdmin } from "../../admin/requireAdmin.js";
import {
  listAdminAudit,
  ADMIN_AUDIT_MAX_LIMIT,
  type AdminAuditRowView,
} from "../../admin/audit.js";
import {
  listSecurityEvents,
  SECURITY_EVENTS_MAX_LIMIT,
} from "../../admin/securityEvents.js";
import { listAuditEvents as listHostAuditEvents } from "../../compute-pool/audit.js";
import { getPool } from "../../db/index.js";
import { query } from "../../db/queries.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { parsePositiveInt, translateRangeError } from "./_shared.js";

function serializeAudit(r: AdminAuditRowView): Record<string, unknown> {
  return {
    id: r.id,
    admin_id: r.admin_id,
    action: r.action,
    target: r.target,
    before: r.before,
    after: r.after,
    ip: r.ip,
    user_agent: r.user_agent,
    created_at: r.created_at.toISOString(),
  };
}

function sp(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`).searchParams;
}

function optional(v: string | null): string | undefined {
  return v === null || v === "" ? undefined : v;
}

// ─── GET /api/admin/audit?admin_id=&action=&target=&created_from=&created_to=&limit=&before= ─────────

export async function handleAdminListAudit(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const p = sp(req);
  const limit = parsePositiveInt(p.get("limit"), "limit", ADMIN_AUDIT_MAX_LIMIT);

  try {
    const r = await listAdminAudit({
      adminId: optional(p.get("admin_id")),
      action: optional(p.get("action")),
      target: optional(p.get("target")),
      createdFrom: optional(p.get("created_from")),
      createdTo: optional(p.get("created_to")),
      before: optional(p.get("before")),
      limit,
    });
    sendJson(res, 200, {
      rows: r.rows.map(serializeAudit),
      next_before: r.next_before,
    });
  } catch (err) { translateRangeError(err); }
}

// ─── GET /api/admin/security-events?type=&limit=&before= ───────────

export async function handleAdminListSecurityEvents(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const p = sp(req);
  const limit = parsePositiveInt(p.get("limit"), "limit", SECURITY_EVENTS_MAX_LIMIT);
  try {
    const r = await listSecurityEvents({
      type: optional(p.get("type")),
      before: optional(p.get("before")),
      limit,
    });
    sendJson(res, 200, {
      rows: r.rows.map((row) => ({
        id: row.id,
        type: row.type,
        actor_user_id: row.actor_user_id,
        target: row.target,
        detail: row.detail,
        ip: row.ip,
        user_agent: row.user_agent,
        created_at: row.created_at.toISOString(),
      })),
      next_before: r.next_before,
    });
  } catch (err) { translateRangeError(err); }
}

// ─── GET /api/admin/host-audit?host_id=&limit=&before= ─────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleAdminListHostAudit(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const p = sp(req);
  const limit = parsePositiveInt(p.get("limit"), "limit", 200);
  const hostId = optional(p.get("host_id"));
  if (hostId !== undefined && !UUID_RE.test(hostId)) {
    throw new HttpError(400, "VALIDATION", "invalid host_id (uuid expected)");
  }
  try {
    const r = await listHostAuditEvents(getPool(), {
      hostId,
      before: optional(p.get("before")),
      limit,
    });
    sendJson(res, 200, { rows: r.rows, next_before: r.next_before });
  } catch (err) { translateRangeError(err); }
}

// ─── GET /api/admin/trace/:traceId — 请求ID反查 ─────────────────────
// UI 底部"请求ID"= turn_traces.trace_id(0126 唯一持久落点)。此前运维只能
// ssh + psql 手查;本端点给审计页一键反查:trace → user/session/agent/model/时间。

const TRACE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export async function handleAdminTraceLookup(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  let traceId: string;
  try {
    // Codex R1 MINOR#1:畸形编码(如 /trace/%)会让 decodeURIComponent 抛 URIError
    // → 500;收敛为输入校验 400。
    traceId = decodeURIComponent(url.pathname.slice("/api/admin/trace/".length));
  } catch {
    throw new HttpError(400, "VALIDATION", "invalid trace id");
  }
  if (!TRACE_ID_RE.test(traceId)) {
    throw new HttpError(400, "VALIDATION", "invalid trace id");
  }
  const r = await query<{
    trace_id: string;
    user_id: string;
    session_key: string;
    agent_id: string | null;
    model: string | null;
    created_at: Date;
    username: string | null;
  }>(
    `SELECT t.trace_id,
            t.user_id::text AS user_id,
            t.session_key,
            t.agent_id,
            t.model,
            t.created_at,
            u.username
       FROM turn_traces t
       LEFT JOIN users u ON u.id = t.user_id
      WHERE t.trace_id = $1`,
    [traceId],
  );
  if (r.rows.length === 0) {
    throw new HttpError(404, "NOT_FOUND", "trace not found");
  }
  const row = r.rows[0];
  sendJson(res, 200, {
    trace: {
      trace_id: row.trace_id,
      user_id: row.user_id,
      username: row.username,
      session_key: row.session_key,
      agent_id: row.agent_id,
      model: row.model,
      created_at: row.created_at.toISOString(),
    },
  });
}
