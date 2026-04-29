/**
 * V3 站内信(in-app messages)— service 层。
 *
 * 表见 migrations/0046_inbox_messages.sql:
 *   - inbox_messages       (id, audience, user_id?, title, body_md, level, created_by, created_at, expires_at?)
 *   - inbox_message_reads  (user_id, message_id, read_at)
 *
 * 可见性规则(listMyInbox / countMyUnread / readAll 共享):
 *   - audience='user'  AND user_id = me                          → 可见
 *   - audience='all'   AND created_at >= 用户 users.created_at   → 可见(注册前的广播不补)
 *   - expires_at IS NULL OR expires_at > NOW()                   → 未过期
 *
 * 注:audience='all' 谓词写成 `m.created_at >= (SELECT created_at FROM users WHERE id=$1)`,
 * 用户行不存在时(账号被硬删但 JWT 未过期)子查询返 NULL,`>= NULL` 计算为 NULL(非
 * TRUE),整条 OR 失败 —— 失败闭合。早期版本用 COALESCE(..., '-infinity') 兜底会让
 * 已被删的账号看到所有广播,这是 Codex 审查抓到的可见性回归。
 *
 * 已读 = 在 inbox_message_reads 中存在 (user_id, message_id) 行。
 */

import { z } from "zod";
import { query } from "../db/queries.js";

// ─── 公共类型 ────────────────────────────────────────────────────────

export type Audience = "all" | "user";
export type Level = "info" | "notice" | "promo" | "warning";
export const LEVELS: readonly Level[] = ["info", "notice", "promo", "warning"];

export interface InboxMessage {
  id: string;
  audience: Audience;
  user_id: string | null;
  title: string;
  body_md: string;
  level: Level;
  created_by: string;
  created_at: string; // ISO
  expires_at: string | null;
}

export interface InboxMessageView extends InboxMessage {
  read: boolean;
}

export class InboxError extends Error {
  constructor(
    public code: "VALIDATION" | "NOT_FOUND" | "USER_NOT_FOUND",
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "InboxError";
  }
}

// ─── zod schema(admin 写入校验)─────────────────────────────────────

const createSchema = z
  .object({
    audience: z.enum(["all", "user"]),
    user_id: z.union([z.string().regex(/^[1-9]\d{0,19}$/), z.number().int().positive()]).optional(),
    title: z.string().min(1).max(200),
    body_md: z.string().min(1).max(16384),
    level: z.enum(["info", "notice", "promo", "warning"]).optional(),
    expires_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.audience === "all" && v.user_id != null) {
      ctx.addIssue({
        code: "custom",
        path: ["user_id"],
        message: "user_id must be omitted when audience='all'",
      });
    }
    if (v.audience === "user" && v.user_id == null) {
      ctx.addIssue({
        code: "custom",
        path: ["user_id"],
        message: "user_id is required when audience='user'",
      });
    }
  });

export type CreateInboxInput = z.infer<typeof createSchema>;

// ─── 用户侧:list / count / read / readAll ─────────────────────────

export interface ListMyInboxInput {
  userId: string | bigint;
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListMyInboxResult {
  messages: InboxMessageView[];
  unread_count: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * 列出当前用户的可见消息 + 未读总数(分开两条 SQL)。
 *
 * 1) 主列表:join reads 计算 read 标志;按时间倒序;limit/offset 分页。
 * 2) 未读数:同 visibility 谓词 但 LEFT JOIN reads WHERE r.user_id IS NULL,COUNT(*)。
 */
export async function listMyInbox(input: ListMyInboxInput): Promise<ListMyInboxResult> {
  const userId = String(input.userId);
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(input.offset ?? 0, 0);
  const unreadOnly = input.unreadOnly === true;

  // 公共可见性谓词(占位 $1=userId)
  // 注:audience='all' 走 idx_im_all_recent;audience='user' 走 idx_im_user_recent。
  // OR 子句让 planner 可能合并扫描,实测两个 partial idx 都会用到。
  const visibilitySql = `
    (
      (m.audience = 'user' AND m.user_id = $1::bigint)
      OR
      (m.audience = 'all'  AND m.created_at >= (SELECT created_at FROM users WHERE id = $1::bigint))
    )
    AND (m.expires_at IS NULL OR m.expires_at > NOW())
  `;

  const filterSql = unreadOnly ? "AND r.user_id IS NULL" : "";

  const listSql = `
    SELECT m.id::text AS id,
           m.audience,
           m.user_id::text AS user_id,
           m.title,
           m.body_md,
           m.level,
           m.created_by::text AS created_by,
           m.created_at,
           m.expires_at,
           (r.user_id IS NOT NULL) AS read
      FROM inbox_messages m
      LEFT JOIN inbox_message_reads r
        ON r.message_id = m.id AND r.user_id = $1::bigint
     WHERE ${visibilitySql}
       ${filterSql}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $2 OFFSET $3
  `;

  const listRes = await query<{
    id: string;
    audience: Audience;
    user_id: string | null;
    title: string;
    body_md: string;
    level: Level;
    created_by: string;
    created_at: Date;
    expires_at: Date | null;
    read: boolean;
  }>(listSql, [userId, limit, offset]);

  // 未读数(独立查询,与分页解耦 — 不管 unreadOnly 都是全量未读总数)
  const countSql = `
    SELECT COUNT(*)::int AS n
      FROM inbox_messages m
      LEFT JOIN inbox_message_reads r
        ON r.message_id = m.id AND r.user_id = $1::bigint
     WHERE ${visibilitySql} AND r.user_id IS NULL
  `;
  const countRes = await query<{ n: number }>(countSql, [userId]);

  return {
    messages: listRes.rows.map((row) => ({
      id: row.id,
      audience: row.audience,
      user_id: row.user_id,
      title: row.title,
      body_md: row.body_md,
      level: row.level,
      created_by: row.created_by,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      expires_at:
        row.expires_at instanceof Date ? row.expires_at.toISOString() : (row.expires_at as string | null),
      read: row.read === true,
    })),
    unread_count: countRes.rows[0]?.n ?? 0,
  };
}

/**
 * 仅返未读总数(polling 用,比 listMyInbox 便宜 — 不返 body)。
 */
export async function countMyUnread(userId: string | bigint): Promise<number> {
  const sql = `
    SELECT COUNT(*)::int AS n
      FROM inbox_messages m
      LEFT JOIN inbox_message_reads r
        ON r.message_id = m.id AND r.user_id = $1::bigint
     WHERE (
        (m.audience = 'user' AND m.user_id = $1::bigint)
        OR (m.audience = 'all' AND m.created_at >= (SELECT created_at FROM users WHERE id = $1::bigint))
       )
       AND (m.expires_at IS NULL OR m.expires_at > NOW())
       AND r.user_id IS NULL
  `;
  const r = await query<{ n: number }>(sql, [String(userId)]);
  return r.rows[0]?.n ?? 0;
}

/**
 * 标记单条消息为已读。消息不可见或不存在 → 抛 InboxError(NOT_FOUND)。
 * 可见但已读 → noop(ON CONFLICT DO NOTHING),返 already=true。
 */
export async function markRead(
  userId: string | bigint,
  messageId: string | bigint,
): Promise<{ already: boolean }> {
  const uid = String(userId);
  const mid = String(messageId);
  if (!/^[1-9]\d{0,19}$/.test(mid)) {
    throw new InboxError("NOT_FOUND", "message not found");
  }

  // 可见性预检(避免给"我看不见"的 message 写 read 记录)
  const visSql = `
    SELECT 1
      FROM inbox_messages m
     WHERE m.id = $2::bigint
       AND (
         (m.audience = 'user' AND m.user_id = $1::bigint)
         OR (m.audience = 'all' AND m.created_at >= (SELECT created_at FROM users WHERE id = $1::bigint))
       )
       AND (m.expires_at IS NULL OR m.expires_at > NOW())
     LIMIT 1
  `;
  const vis = await query<{ "?column?": number }>(visSql, [uid, mid]);
  if (vis.rows.length === 0) {
    throw new InboxError("NOT_FOUND", "message not found");
  }

  const r = await query<{ inserted: boolean }>(
    `INSERT INTO inbox_message_reads (user_id, message_id)
     VALUES ($1::bigint, $2::bigint)
     ON CONFLICT (user_id, message_id) DO NOTHING
     RETURNING TRUE AS inserted`,
    [uid, mid],
  );
  return { already: r.rows.length === 0 };
}

/**
 * 一次把当前用户所有可见未读批量标记为已读。返插入行数。
 */
export async function readAll(userId: string | bigint): Promise<{ inserted: number }> {
  const uid = String(userId);
  const sql = `
    INSERT INTO inbox_message_reads (user_id, message_id)
    SELECT $1::bigint, m.id
      FROM inbox_messages m
      LEFT JOIN inbox_message_reads r
        ON r.message_id = m.id AND r.user_id = $1::bigint
     WHERE (
        (m.audience = 'user' AND m.user_id = $1::bigint)
        OR (m.audience = 'all' AND m.created_at >= (SELECT created_at FROM users WHERE id = $1::bigint))
       )
       AND (m.expires_at IS NULL OR m.expires_at > NOW())
       AND r.user_id IS NULL
    ON CONFLICT (user_id, message_id) DO NOTHING
  `;
  const r = await query(sql, [uid]);
  return { inserted: r.rowCount ?? 0 };
}

// ─── Admin 侧:create / list / delete ─────────────────────────────

/**
 * Admin 创建消息。校验后写入(audience='all' 时 user_id 强制为 null)。
 * 返回新建消息(包含 id)。
 *
 * audience='user' 时 verify 收件人存在且 status='active',否则 USER_NOT_FOUND。
 */
export async function createInboxMessage(
  adminId: string | bigint,
  input: unknown,
): Promise<InboxMessage> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    throw new InboxError("VALIDATION", parsed.error.message, { issues: parsed.error.issues });
  }
  const v = parsed.data;
  const userId = v.audience === "user" ? String(v.user_id) : null;

  if (userId !== null) {
    // 校验收件人存在且活跃
    const u = await query(`SELECT 1 FROM users WHERE id = $1::bigint AND status = 'active' LIMIT 1`, [
      userId,
    ]);
    if (u.rows.length === 0) {
      throw new InboxError("USER_NOT_FOUND", "recipient user not found or inactive");
    }
  }

  const r = await query<{
    id: string;
    audience: Audience;
    user_id: string | null;
    title: string;
    body_md: string;
    level: Level;
    created_by: string;
    created_at: Date;
    expires_at: Date | null;
  }>(
    `INSERT INTO inbox_messages (audience, user_id, title, body_md, level, created_by, expires_at)
     VALUES ($1, $2::bigint, $3, $4, COALESCE($5, 'info'), $6::bigint, $7::timestamptz)
     RETURNING id::text AS id, audience, user_id::text AS user_id, title, body_md, level,
               created_by::text AS created_by, created_at, expires_at`,
    [
      v.audience,
      userId,
      v.title,
      v.body_md,
      v.level ?? null,
      String(adminId),
      v.expires_at ?? null,
    ],
  );
  const row = r.rows[0];
  return {
    id: row.id,
    audience: row.audience,
    user_id: row.user_id,
    title: row.title,
    body_md: row.body_md,
    level: row.level,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at ? row.expires_at.toISOString() : null,
  };
}

export interface AdminListInput {
  limit?: number;
  offset?: number;
}

export interface AdminInboxRow extends InboxMessage {
  read_count: number;
  recipients: number;
}

export interface AdminListResult {
  messages: AdminInboxRow[];
  total: number;
}

/**
 * Admin 列表分页。
 *
 * recipients 计算:
 *   - audience='user' → 1
 *   - audience='all'  → 该消息发出时 active 用户总数(创建时间 ≥ users.created_at 的人)
 *
 * 注:recipients 走子查询(N+1),量起来再做汇总缓存。
 */
export async function adminListInbox(input: AdminListInput): Promise<AdminListResult> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(input.offset ?? 0, 0);

  const listRes = await query<{
    id: string;
    audience: Audience;
    user_id: string | null;
    title: string;
    body_md: string;
    level: Level;
    created_by: string;
    created_at: Date;
    expires_at: Date | null;
    read_count: number;
    recipients: number;
  }>(
    `SELECT m.id::text AS id,
            m.audience,
            m.user_id::text AS user_id,
            m.title,
            m.body_md,
            m.level,
            m.created_by::text AS created_by,
            m.created_at,
            m.expires_at,
            COALESCE((SELECT COUNT(*)::int FROM inbox_message_reads r WHERE r.message_id = m.id), 0) AS read_count,
            CASE WHEN m.audience = 'user' THEN 1
                 ELSE COALESCE(
                   (SELECT COUNT(*)::int FROM users u
                     WHERE u.status = 'active' AND u.created_at <= m.created_at), 0)
            END AS recipients
       FROM inbox_messages m
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );

  const totalRes = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM inbox_messages`);

  return {
    messages: listRes.rows.map((row) => ({
      id: row.id,
      audience: row.audience,
      user_id: row.user_id,
      title: row.title,
      body_md: row.body_md,
      level: row.level,
      created_by: row.created_by,
      created_at: row.created_at.toISOString(),
      expires_at: row.expires_at ? row.expires_at.toISOString() : null,
      read_count: row.read_count,
      recipients: row.recipients,
    })),
    total: totalRes.rows[0]?.n ?? 0,
  };
}

/**
 * Admin 硬删一条消息。reads 表行 CASCADE 一起清。
 * 不存在 → InboxError(NOT_FOUND);成功 → 返删除前的快照(用于 admin_audit before)。
 */
export async function adminDeleteInbox(messageId: string | bigint): Promise<InboxMessage> {
  const mid = String(messageId);
  if (!/^[1-9]\d{0,19}$/.test(mid)) {
    throw new InboxError("NOT_FOUND", "message not found");
  }
  const r = await query<{
    id: string;
    audience: Audience;
    user_id: string | null;
    title: string;
    body_md: string;
    level: Level;
    created_by: string;
    created_at: Date;
    expires_at: Date | null;
  }>(
    `DELETE FROM inbox_messages
      WHERE id = $1::bigint
     RETURNING id::text AS id, audience, user_id::text AS user_id, title, body_md, level,
               created_by::text AS created_by, created_at, expires_at`,
    [mid],
  );
  if (r.rows.length === 0) {
    throw new InboxError("NOT_FOUND", "message not found");
  }
  const row = r.rows[0];
  return {
    id: row.id,
    audience: row.audience,
    user_id: row.user_id,
    title: row.title,
    body_md: row.body_md,
    level: row.level,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at ? row.expires_at.toISOString() : null,
  };
}
