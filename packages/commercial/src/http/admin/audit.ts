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
import { classifyClientSessions } from "@openclaude/storage";
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

// ─── GET /api/admin/product-friction — recovery-aware product signals ─────

type GithubFrictionRow = {
  status: string;
  code: string;
  selections: string;
  affected_users: string;
  stale: string;
  deleted_session: string;
  missing_session: string;
};

async function listGithubFriction(): Promise<GithubFrictionRow[]> {
  const [base, refs] = await Promise.all([
    query<Omit<GithubFrictionRow, "deleted_session" | "missing_session">>(
      `SELECT status, COALESCE(error_code,'NONE') AS code,
              COUNT(*)::text selections, COUNT(DISTINCT user_id)::text affected_users,
              COUNT(*) FILTER (WHERE status IN ('pending','cloning')
                                AND updated_at < NOW()-interval '30 minutes')::text stale
         FROM github_session_workspaces
        GROUP BY status,COALESCE(error_code,'NONE') ORDER BY status,code`,
    ),
    query<{ status: string; code: string; session_id: string; user_id: string }>(
      `SELECT status,COALESCE(error_code,'NONE') AS code,session_id,user_id::text AS user_id
         FROM github_session_workspaces`,
    ),
  ]);
  const lifecycle = await classifyClientSessions(refs.rows.map((row) => ({
    sessionId: row.session_id,
    userId: `c:${row.user_id}`,
  })));
  const deleted = new Map<string, number>();
  const missing = new Map<string, number>();
  for (let i = 0; i < refs.rows.length; i++) {
    const key = `${refs.rows[i]!.status}:${refs.rows[i]!.code}`;
    const state = lifecycle[i]?.state;
    if (state === "deleted") deleted.set(key, (deleted.get(key) ?? 0) + 1);
    if (state === "missing") missing.set(key, (missing.get(key) ?? 0) + 1);
  }
  return base.rows.map((row) => ({
    ...row,
    deleted_session: String(deleted.get(`${row.status}:${row.code}`) ?? 0),
    missing_session: String(missing.get(`${row.status}:${row.code}`) ?? 0),
  }));
}

export async function handleAdminProductFriction(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const [events, models, modelFailures, images, imageAttempts, orders, github, ratings] = await Promise.all([
    query<{
      surface: string; stage: string; code: string; journeys_1d: string; journeys_7d: string;
      attempts_1d: string; attempts_7d: string; failed_7d: string; recovered_7d: string;
      pending_7d: string; affected_users_7d: string;
    }>(
      `SELECT surface, stage, code,
              COUNT(*) FILTER (WHERE created_at > NOW()-interval '24 hours')::text journeys_1d,
              COUNT(*)::text journeys_7d,
              COALESCE(SUM(attempts) FILTER (WHERE created_at > NOW()-interval '24 hours'),0)::text attempts_1d,
              COALESCE(SUM(attempts),0)::text attempts_7d,
              COUNT(*) FILTER (WHERE outcome IN ('failed','abandoned'))::text failed_7d,
              COUNT(*) FILTER (WHERE outcome IN ('recovered','succeeded'))::text recovered_7d,
              COUNT(*) FILTER (WHERE outcome='pending')::text pending_7d,
              COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)::text affected_users_7d
         FROM product_friction_events
        WHERE created_at > NOW()-interval '7 days'
        GROUP BY surface, stage, code
        ORDER BY COUNT(*) FILTER (WHERE outcome IN ('failed','abandoned')) DESC, COUNT(*) DESC
        LIMIT 100`,
    ),
    query<{
      model: string; attempts_1d: string; success_1d: string; failures_1d: string; cancellations_1d: string;
      attempts_7d: string; success_7d: string; failures_7d: string; cancellations_7d: string;
    }>(
      `WITH classified AS (
         SELECT rfj.created_at,
                COALESCE(rfj.ctx->>'model',ur.model,'unknown') AS model,
                CASE
                  WHEN (rfj.state='aborted'
                         AND rfj.failure_code IN ('CLIENT_ABORT','USER_CANCELLED'))
                    OR (rfj.state='committed'
                         AND ur.price_snapshot->>'codex_terminal_code'='USER_CANCELLED')
                    THEN 'cancelled'
                  WHEN rfj.state='committed'
                    AND ur.id IS NOT NULL
                    AND ur.status='success'
                    AND COALESCE(ur.output_tokens,0)>0
                    AND COALESCE(ur.price_snapshot->>'codex_status','success')<>'error'
                    AND COALESCE(ur.price_snapshot->>'waived','')<>'no_output' THEN 'success'
                  ELSE 'failure'
                END AS terminal_outcome
           FROM request_finalize_journal rfj
           LEFT JOIN usage_records ur ON ur.id=rfj.usage_id
          WHERE rfj.created_at > NOW()-interval '7 days'
            AND rfj.state IN ('committed','aborted')
       )
       SELECT model,
              COUNT(*) FILTER (WHERE created_at > NOW()-interval '24 hours')::text attempts_1d,
              COUNT(*) FILTER (WHERE created_at > NOW()-interval '24 hours' AND terminal_outcome='success')::text success_1d,
              COUNT(*) FILTER (WHERE created_at > NOW()-interval '24 hours' AND terminal_outcome='failure')::text failures_1d,
              COUNT(*) FILTER (WHERE created_at > NOW()-interval '24 hours' AND terminal_outcome='cancelled')::text cancellations_1d,
              COUNT(*)::text attempts_7d,
              COUNT(*) FILTER (WHERE terminal_outcome='success')::text success_7d,
              COUNT(*) FILTER (WHERE terminal_outcome='failure')::text failures_7d,
              COUNT(*) FILTER (WHERE terminal_outcome='cancelled')::text cancellations_7d
         FROM classified
        GROUP BY model
        ORDER BY COUNT(*) FILTER (WHERE terminal_outcome='failure') DESC, COUNT(*) DESC`,
    ),
    query<{
      model: string; code: string; failures_1d: string; failures_7d: string; affected_users_7d: string;
    }>(
      `WITH failures AS (
         SELECT rfj.created_at,rfj.user_id,
                COALESCE(rfj.ctx->>'model',ur.model,'unknown') AS model,
                CASE
                  WHEN rfj.state='aborted' THEN COALESCE(rfj.failure_code,'UNKNOWN')
                  WHEN ur.price_snapshot->>'codex_status'='error' THEN 'CODEX_ERROR'
                  WHEN ur.price_snapshot->>'waived'='no_output'
                    OR (ur.status='success' AND COALESCE(ur.output_tokens,0)=0) THEN 'NO_OUTPUT'
                  WHEN ur.id IS NULL THEN 'MISSING_USAGE'
                  WHEN ur.status='billing_failed' THEN 'BILLING_PARTIAL'
                  WHEN ur.status='error' THEN 'USAGE_ERROR'
                  ELSE 'UNKNOWN'
                END AS code
           FROM request_finalize_journal rfj
           LEFT JOIN usage_records ur ON ur.id=rfj.usage_id
          WHERE rfj.created_at > NOW()-interval '7 days'
            AND rfj.state IN ('committed','aborted')
            AND (rfj.state='aborted'
                 AND COALESCE(rfj.failure_code,'UNKNOWN') IN ('CLIENT_ABORT','USER_CANCELLED')) IS NOT TRUE
            AND (rfj.state='committed'
                 AND COALESCE(ur.price_snapshot->>'codex_terminal_code','')='USER_CANCELLED') IS NOT TRUE
            AND (
              rfj.state='committed' AND ur.id IS NOT NULL AND ur.status='success'
              AND COALESCE(ur.output_tokens,0)>0
              AND COALESCE(ur.price_snapshot->>'codex_status','success')<>'error'
              AND COALESCE(ur.price_snapshot->>'waived','')<>'no_output'
            ) IS NOT TRUE
       )
       SELECT model,code,
              COUNT(*) FILTER (WHERE created_at > NOW()-interval '24 hours')::text failures_1d,
              COUNT(*)::text failures_7d,
              COUNT(DISTINCT user_id)::text affected_users_7d
         FROM failures GROUP BY model,code
        ORDER BY COUNT(*) DESC,model,code`,
    ),
    query<{ status: string; code: string; records: string; affected_users: string }>(
      `SELECT status,code,COUNT(*)::text records,
              COUNT(DISTINCT user_id)::text affected_users
         FROM (
           SELECT status,user_id,
                  CASE WHEN error_code IS NULL THEN 'NONE'
                       WHEN UPPER(error_code) ~ '^IMAGE_' THEN UPPER(error_code)
                       ELSE 'IMAGE_' || UPPER(error_code) END AS code
             FROM image_generation_usage_records
            WHERE updated_at > NOW()-interval '7 days'
         ) image_journeys
        GROUP BY status,code ORDER BY status,code`,
    ),
    query<{ outcome: string; code: string; attempts_1d: string; attempts_7d: string; affected_users_7d: string }>(
      `SELECT outcome,COALESCE(error_code,'NONE') AS code,
              COUNT(*) FILTER (WHERE started_at > NOW()-interval '24 hours')::text attempts_1d,
              COUNT(*)::text attempts_7d,
              COUNT(DISTINCT user_id)::text affected_users_7d
         FROM image_generation_attempts
        WHERE started_at > NOW()-interval '7 days'
        GROUP BY outcome,COALESCE(error_code,'NONE') ORDER BY outcome,code`,
    ),
    query<{ status: string; orders: string; affected_users: string; amount_cents: string }>(
      `SELECT status, COUNT(*)::text orders, COUNT(DISTINCT user_id)::text affected_users,
              COALESCE(SUM(amount_cents),0)::text amount_cents
         FROM orders WHERE created_at > NOW()-interval '30 days'
        GROUP BY status ORDER BY status`,
    ),
    listGithubFriction(),
    query<{ rating: string; ratings: string; affected_users: string; missing_reason: string; missing_trace: string }>(
      `SELECT rating, COUNT(*)::text ratings, COUNT(DISTINCT user_id)::text affected_users,
              COUNT(*) FILTER (WHERE rating='down' AND (cardinality(tags)=0 OR tags=ARRAY['未说明原因']::text[])
                                AND COALESCE(BTRIM(comment),'')='')::text missing_reason,
              COUNT(*) FILTER (WHERE trace_id IS NULL)::text missing_trace
         FROM response_rating WHERE created_at > NOW()-interval '30 days'
        GROUP BY rating ORDER BY rating`,
    ),
  ]);

  sendJson(res, 200, {
    generated_at: new Date().toISOString(),
    windows: { operational_days: 7, funnel_days: 30 },
    events: events.rows,
    models: models.rows,
    model_failures: modelFailures.rows,
    images: images.rows,
    image_attempts: imageAttempts.rows,
    orders: orders.rows,
    github,
    ratings: ratings.rows,
  });
}
