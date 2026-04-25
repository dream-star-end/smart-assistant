/**
 * P1-2 — 用户反馈入库 + admin 列表/ack。
 *
 * 现状:gateway/server.ts:1325 写文件 ~/.openclaude/feedback/fb-*.json,
 *       admin 只能 ssh ls。本模块 + http/feedback.ts 把 /api/feedback POST
 *       接管入 PG,/api/admin/feedback 列表 + /api/admin/feedback/:id/ack 提供
 *       超管视图。
 *
 * 设计要点:
 * - **复合游标 (created_at, id)**:同一时间戳多行常见,纯 created_at 游标会跳。
 * - **BIGINT 序列化为 string**:JS Number 不安全,统一 ::text。
 * - **idempotent ack**:对已 acked 行再 ack 不更新 handled_at,不报错(返回原值)。
 * - **status 语义**:open=未看,acked=已看到,closed=已处理(本批不出 close 入口,
 *   留 close 给后续工单系统)。
 */

import { query, tx } from "../db/queries.js";
import { writeAdminAudit } from "./audit.js";

// ─── Row types ─────────────────────────────────────────────────────

export interface FeedbackRowView {
  id: string;
  user_id: string | null;
  category: string;
  description: string;
  request_id: string | null;
  version: string | null;
  session_id: string | null;
  user_agent: string | null;
  meta: Record<string, unknown>;
  status: "open" | "acked" | "closed";
  handled_by: string | null;
  handled_at: Date | null;
  created_at: Date;
  // 用户信息(JOIN users),便于 admin 一眼看到是谁;deleted/未注册返回 null
  username: string | null;
}

const FEEDBACK_COLS = `
  f.id::text          AS id,
  f.user_id::text     AS user_id,
  f.category,
  f.description,
  f.request_id,
  f.version,
  f.session_id,
  f.user_agent,
  f.meta,
  f.status,
  f.handled_by::text  AS handled_by,
  f.handled_at,
  f.created_at,
  -- users 表无 username 列;display_name 可空,用 email 兜底
  COALESCE(u.display_name, u.email) AS username
`;

// ─── List ──────────────────────────────────────────────────────────

export interface ListFeedbackInput {
  status?: "open" | "acked" | "closed";
  user_id?: string; // bigint as string
  // 复合游标:取严格小于 (before_created_at, before_id) 的行
  before_created_at?: string; // ISO timestamp
  before_id?: string; // bigint as string
  limit?: number;
}

export interface ListFeedbackResult {
  rows: FeedbackRowView[];
  // null 表示已到末页;否则 caller 下次传 before_created_at + before_id
  next_before_created_at: string | null;
  next_before_id: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function listFeedback(input: ListFeedbackInput = {}): Promise<ListFeedbackResult> {
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const where: string[] = [];
  const params: unknown[] = [];

  if (input.status) {
    params.push(input.status);
    where.push(`f.status = $${params.length}`);
  }
  if (input.user_id) {
    params.push(input.user_id);
    where.push(`f.user_id = $${params.length}::bigint`);
  }
  if (input.before_created_at && input.before_id) {
    params.push(input.before_created_at);
    const a = `$${params.length}::timestamptz`;
    params.push(input.before_id);
    const b = `$${params.length}::bigint`;
    // 复合 (created_at, id) 严格 < cursor;同 ts 多行也能稳定翻页
    where.push(`(f.created_at, f.id) < (${a}, ${b})`);
  }

  params.push(limit + 1); // +1 sentinel:用于判断是否还有下一页
  const limitIdx = params.length;

  const sql = `
    SELECT ${FEEDBACK_COLS}
    FROM feedback f
    LEFT JOIN users u ON u.id = f.user_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY f.created_at DESC, f.id DESC
    LIMIT $${limitIdx}
  `;

  const r = await query<FeedbackRowView>(sql, params);
  const hasMore = r.rows.length > limit;
  const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
  const last = rows[rows.length - 1];
  return {
    rows,
    next_before_created_at: hasMore && last ? last.created_at.toISOString() : null,
    next_before_id: hasMore && last ? last.id : null,
  };
}

// ─── Ack ───────────────────────────────────────────────────────────

export class FeedbackNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`feedback ${id} not found`);
    this.name = "FeedbackNotFoundError";
  }
}

export interface AckFeedbackCtx {
  adminId: string; // bigint as string
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * status='open' → 'acked',写 handled_by + handled_at + admin_audit。
 * 已经 acked/closed 的:idempotent —— 不修改任何字段,返回当前 row。
 * 不存在 → throw FeedbackNotFoundError(handler 转 404)。
 */
export async function ackFeedback(id: string, ctx: AckFeedbackCtx): Promise<FeedbackRowView> {
  return tx(async (client) => {
    // 先锁住目标行,避免并发双 ack
    const cur = await client.query<FeedbackRowView>(
      `SELECT ${FEEDBACK_COLS}
         FROM feedback f
         LEFT JOIN users u ON u.id = f.user_id
        WHERE f.id = $1::bigint
        FOR UPDATE OF f`,
      [id],
    );
    if (cur.rows.length === 0) {
      throw new FeedbackNotFoundError(id);
    }
    const row = cur.rows[0];
    if (row.status !== "open") {
      // idempotent:已 acked / closed 直接原样返回,不写 audit(避免噪音)
      return row;
    }
    await client.query(
      `UPDATE feedback
          SET status = 'acked',
              handled_by = $2::bigint,
              handled_at = NOW()
        WHERE id = $1::bigint`,
      [id, ctx.adminId],
    );
    const after = await client.query<FeedbackRowView>(
      `SELECT ${FEEDBACK_COLS}
         FROM feedback f LEFT JOIN users u ON u.id = f.user_id
        WHERE f.id = $1::bigint`,
      [id],
    );
    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: "feedback.ack",
      target: id,
      before: { status: row.status },
      after: { status: "acked" },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return after.rows[0];
  });
}

// ─── Insert (called from /api/feedback POST handler) ───────────────

export interface InsertFeedbackInput {
  user_id: string | null;
  category: string;
  description: string;
  request_id: string | null;
  version: string | null;
  session_id: string | null;
  user_agent: string | null;
  meta: Record<string, unknown>;
}

export interface InsertFeedbackResult {
  id: string; // bigint as string
  created_at: Date;
}

export async function insertFeedback(input: InsertFeedbackInput): Promise<InsertFeedbackResult> {
  const r = await query<{ id: string; created_at: Date }>(
    `INSERT INTO feedback
       (user_id, category, description, request_id, version, session_id, user_agent, meta)
       VALUES ($1::bigint, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING id::text AS id, created_at`,
    [
      input.user_id,
      input.category,
      input.description,
      input.request_id,
      input.version,
      input.session_id,
      input.user_agent,
      JSON.stringify(input.meta),
    ],
  );
  return r.rows[0];
}
