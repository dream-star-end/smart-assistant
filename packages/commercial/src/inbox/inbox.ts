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
import { query, tx } from "../db/queries.js";
import {
  InboxAssetValidationError,
  prepareInboxRichBody,
  type InboxAssetInput,
} from "./assets.js";

// ─── 公共类型 ────────────────────────────────────────────────────────

export type Audience = "all" | "user";
export type Level = "info" | "notice" | "promo" | "warning";
export const LEVELS: readonly Level[] = ["info", "notice", "promo", "warning"];
export type InboxCategory = "user" | "automation" | "billing" | "operations" | "marketing";

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
  category: InboxCategory;
  thread_key: string | null;
  thread_count: number;
  source_type: string | null;
  source_id: string | null;
  source_phase: string | null;
}

/** Plan C — 邮件群发状态汇总(jsonb).每条 inbox_messages 一份. */
export interface EmailSummary {
  /** 创建时锁定的快照行数(后续注册的用户不会补) */
  total: number;
  sent: number;
  failed: number;
  /** 进程崩前卡 sending,启动清扫后归入此项 */
  interrupted: number;
  /** worker 跑时发现 email 为空/账号被删/被禁等异常,主动跳过 */
  dropped: number;
}

/** inbox_messages.email_send_status 状态机. NULL = 未启用邮件推送. */
export type EmailSendStatus =
  | null
  | "queued"
  | "done"
  | "partial"
  | "interrupted";

/** Admin 列表 / 创建返回中带 email 字段的扩展(普通用户读 inbox 不暴露邮件状态). */
export interface InboxEmailFields {
  notify_email: boolean;
  email_send_status: EmailSendStatus;
  email_sent_at: string | null;
  email_summary: EmailSummary | null;
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
    category: z
      .enum(["user", "automation", "billing", "operations", "marketing"])
      .optional(),
    expires_at: z.string().datetime({ offset: true }).optional(),
    // Plan C:勾选后同事务给 audience 对应的 active+email_verified 用户写
    // inbox_email_jobs 快照,worker drain 后异步发邮件。详见 0065 migration 注释。
    notify_email: z.boolean().optional(),
    assets: z
      .array(
        z
          .object({
            client_id: z.string().uuid(),
            filename: z.string().min(1).max(512),
            mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
            data_base64: z.string().min(1).max(7_100_000),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.category === "operations") {
      ctx.addIssue({
        code: "custom",
        path: ["category"],
        message: "operations incident notices must use the selfheal approval workflow",
      });
    }
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
           m.category,
           m.thread_key,
           CASE
             WHEN m.thread_key IS NULL THEN 1
             ELSE (
               SELECT COUNT(*)::int
                 FROM inbox_messages threaded
                WHERE threaded.thread_key=m.thread_key
             )
           END AS thread_count,
           m.source_type,
           m.source_id::text AS source_id,
           m.source_phase,
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
    category: InboxCategory;
    thread_key: string | null;
    thread_count: number;
    source_type: string | null;
    source_id: string | null;
    source_phase: string | null;
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
      category: row.category,
      thread_key: row.thread_key,
      thread_count: row.thread_count,
      source_type: row.source_type,
      source_id: row.source_id,
      source_phase: row.source_phase,
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

export interface CronDeliveryInboxInput {
  userId: string | number | bigint;
  title: string;
  bodyMd: string;
  level: Level;
  createdBy: string | bigint;
  deliveryKey: string;
}

/** Persist one cron delivery with its stable occurrence key. */
export async function createCronDeliveryInboxMessage(
  input: CronDeliveryInboxInput,
): Promise<void> {
  const userId = String(input.userId);
  const existing = await query<{ title: string; body_md: string }>(
    `SELECT title,body_md FROM inbox_messages
      WHERE source_type='cron_delivery' AND source_id=$1::bigint AND source_phase=$2`,
    [userId, input.deliveryKey],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].title !== input.title || existing.rows[0].body_md !== input.bodyMd) {
      throw new Error("inbox-post: delivery key content collision");
    }
    return;
  }

  const inserted = await query(
    `INSERT INTO inbox_messages
       (audience,user_id,title,body_md,level,category,thread_key,created_by,
        source_type,source_id,source_phase)
     SELECT 'user',$1::bigint,$2,$3,$4,'automation',
            'cron:user:' || ($1::bigint)::text,$5::bigint,
            'cron_delivery',$1::bigint,$6
      WHERE EXISTS (
        SELECT 1 FROM users WHERE id=$1::bigint AND status='active'
      )
     ON CONFLICT (source_type,source_id,source_phase)
       WHERE source_type IS NOT NULL DO NOTHING`,
    [userId, input.title, input.bodyMd, input.level, String(input.createdBy), input.deliveryKey],
  );
  if ((inserted.rowCount ?? 0) === 1) return;

  const raced = await query<{ title: string; body_md: string }>(
    `SELECT title,body_md FROM inbox_messages
      WHERE source_type='cron_delivery' AND source_id=$1::bigint AND source_phase=$2`,
    [userId, input.deliveryKey],
  );
  if (raced.rows[0]?.title === input.title && raced.rows[0]?.body_md === input.bodyMd) return;
  throw new Error("inbox-post: recipient missing or delivery key collision");
}

// ─── Admin 侧:create / list / delete ─────────────────────────────

/** createInboxMessage 返回 — 总是带 email 字段,未启用 notify_email 时全部置零/null. */
export type CreatedInboxMessage = InboxMessage & InboxEmailFields;

/**
 * Admin 创建消息。校验后写入(audience='all' 时 user_id 强制为 null)。
 * 返回新建消息(包含 id 与邮件汇总字段)。
 *
 * audience='user' 时 verify 收件人存在且 status='active',否则 USER_NOT_FOUND。
 *
 * notify_email=true 路径(Plan C):
 *   1) tx() 内 INSERT message;
 *   2) 同事务 INSERT...SELECT 写 inbox_email_jobs(audience='user' → 单收件人 / 'all'
 *      → 创建时刻 status='active' AND email_verified=TRUE AND deleted_at IS NULL
 *      的全量 users 快照,锁定那一刻的列表);
 *   3) UPDATE message 设 notify_email=TRUE / email_send_status='queued'(若快照 0 行
 *      则直接 'done',避免空 jobs 永久卡在 queued)/ email_summary={total,...}。
 *
 * 所有写在一个 tx 中:任何一步失败 → 整体回滚,**不会出现"消息写了但 jobs 没写"
 * 或反过来**的半套状态。这是替代 fire-and-forget 设计的根因 —— 上线/部署/进程
 * 崩在创建中间一刻不会丢失收件人快照。
 */
export async function createInboxMessage(
  adminId: string | bigint,
  input: unknown,
): Promise<CreatedInboxMessage> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    throw new InboxError("VALIDATION", parsed.error.message, { issues: parsed.error.issues });
  }
  const v = parsed.data;
  const userId = v.audience === "user" ? String(v.user_id) : null;
  const notifyEmail = v.notify_email === true;
  let richBody: Awaited<ReturnType<typeof prepareInboxRichBody>>;
  try {
    richBody = await prepareInboxRichBody(v.body_md, v.assets as InboxAssetInput[] | undefined);
  } catch (err) {
    if (err instanceof InboxAssetValidationError) {
      throw new InboxError("VALIDATION", err.message, { issues: err.issues });
    }
    throw err;
  }

  if (userId !== null) {
    // 校验收件人存在且活跃
    const u = await query(`SELECT 1 FROM users WHERE id = $1::bigint AND status = 'active' LIMIT 1`, [
      userId,
    ]);
    if (u.rows.length === 0) {
      throw new InboxError("USER_NOT_FOUND", "recipient user not found or inactive");
    }
  }

  // 纯文本且不推邮件:保留历史单 INSERT 路径。只要带图片就必须开事务，保证消息与资产原子写。
  if (!notifyEmail && richBody.assets.length === 0) {
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
      `INSERT INTO inbox_messages
         (audience, user_id, title, body_md, level, category, created_by, expires_at)
       VALUES (
         $1, $2::bigint, $3, $4, COALESCE($5, 'info'),
         COALESCE($6, CASE WHEN $5='promo' THEN 'marketing' ELSE 'user' END),
         $7::bigint, $8::timestamptz
       )
       RETURNING id::text AS id, audience, user_id::text AS user_id, title, body_md, level,
                 created_by::text AS created_by, created_at, expires_at`,
      [
        v.audience,
        userId,
        v.title,
        richBody.bodyMd,
        v.level ?? null,
        v.category ?? null,
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
      notify_email: false,
      email_send_status: null,
      email_sent_at: null,
      email_summary: null,
    };
  }

  // 富图片和/或 notify_email=true:tx() 包住 message + assets + 邮件收件人快照。
  return tx(async (client) => {
    const r = await client.query<{
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
      `INSERT INTO inbox_messages
         (audience, user_id, title, body_md, level, category, created_by, expires_at, notify_email)
       VALUES (
         $1, $2::bigint, $3, $4, COALESCE($5, 'info'),
         COALESCE($6, CASE WHEN $5='promo' THEN 'marketing' ELSE 'user' END),
         $7::bigint, $8::timestamptz, $9
       )
       RETURNING id::text AS id, audience, user_id::text AS user_id, title, body_md, level,
                 created_by::text AS created_by, created_at, expires_at`,
      [
        v.audience,
        userId,
        v.title,
        richBody.bodyMd,
        v.level ?? null,
        v.category ?? null,
        String(adminId),
        v.expires_at ?? null,
        notifyEmail,
      ],
    );
    const row = r.rows[0];

    for (const asset of richBody.assets) {
      await client.query(
        `INSERT INTO inbox_message_assets
           (id, message_id, filename, mime_type, size_bytes, sha256, data)
         VALUES ($1::uuid, $2::bigint, $3, $4, $5, $6, $7)`,
        [
          asset.id,
          row.id,
          asset.filename,
          asset.mimeType,
          asset.sizeBytes,
          asset.sha256,
          asset.data,
        ],
      );
    }

    if (!notifyEmail) {
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
        notify_email: false,
        email_send_status: null,
        email_sent_at: null,
        email_summary: null,
      };
    }

    // 收件人快照:`u.email <> ''` 防 NOT NULL 但空串(0001 schema 只有 UNIQUE 没 CHECK)
    // 这一刻 INSERT...SELECT 的行集 = 该 message 永久邮件收件人(后续注册或改邮箱不补)。
    const jobSql =
      v.audience === "user"
        ? `INSERT INTO inbox_email_jobs (message_id, user_id, email)
           SELECT $1::bigint, u.id, u.email
             FROM users u
            WHERE u.id = $2::bigint
              AND u.status = 'active'
              AND u.email_verified = TRUE
              AND u.deleted_at IS NULL
              AND u.email IS NOT NULL
              AND u.email <> ''`
        : `INSERT INTO inbox_email_jobs (message_id, user_id, email)
           SELECT $1::bigint, u.id, u.email
             FROM users u
            WHERE u.status = 'active'
              AND u.email_verified = TRUE
              AND u.deleted_at IS NULL
              AND u.email IS NOT NULL
              AND u.email <> ''`;
    const jobParams: unknown[] = v.audience === "user" ? [row.id, userId] : [row.id];
    const jobsRes = await client.query(jobSql, jobParams);
    const total = jobsRes.rowCount ?? 0;

    // 快照 0 行 → status='done',email_sent_at=now;>0 → 'queued',等 worker drain。
    const initialStatus: EmailSendStatus = total === 0 ? "done" : "queued";
    const summary: EmailSummary = {
      total,
      sent: 0,
      failed: 0,
      interrupted: 0,
      dropped: 0,
    };
    const finUpd = await client.query<{ email_sent_at: Date | null }>(
      `UPDATE inbox_messages
          SET email_send_status = $2,
              email_summary = $3::jsonb,
              email_sent_at = CASE WHEN $4::int = 0 THEN NOW() ELSE NULL END
        WHERE id = $1::bigint
       RETURNING email_sent_at`,
      [row.id, initialStatus, JSON.stringify(summary), total],
    );

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
      notify_email: true,
      email_send_status: initialStatus,
      email_sent_at: finUpd.rows[0]?.email_sent_at
        ? finUpd.rows[0].email_sent_at.toISOString()
        : null,
      email_summary: summary,
    };
  });
}

export interface AdminListInput {
  limit?: number;
  offset?: number;
  category?: InboxCategory | null;
  /** `unattributed` selects rows whose source was not captured. */
  sourceType?: string | null;
}

export interface AdminInboxRow extends InboxMessage, InboxEmailFields {
  read_count: number;
  recipients: number;
  category: InboxCategory;
  thread_key: string | null;
  thread_count: number;
  source_type: string | null;
  source_id: string | null;
  source_phase: string | null;
  audience_snapshot_status: "captured" | "legacy_unavailable";
}

export interface AdminListResult {
  messages: AdminInboxRow[];
  total: number;
}

/** EmailSummary 校验 / 容错:DB 返 jsonb 可能是任意形状,缺字段补 0。 */
function normalizeEmailSummary(raw: unknown): EmailSummary | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const n = (k: string): number =>
    typeof o[k] === "number" && Number.isFinite(o[k] as number) ? (o[k] as number) : 0;
  return {
    total: n("total"),
    sent: n("sent"),
    failed: n("failed"),
    interrupted: n("interrupted"),
    dropped: n("dropped"),
  };
}

/**
 * Admin 列表分页。
 *
 * recipients 计算:
 *   - audience='user' → 1
 *   - audience='all'  → 该消息发出时 active 用户总数(创建时间 ≥ users.created_at 的人)
 *
 * 注:recipients 走子查询(N+1),量起来再做汇总缓存。
 *
 * Plan C 补:同步返 notify_email / email_send_status / email_sent_at / email_summary,
 * 前端列表渲染状态徽章直接读主表(不 N+1 jobs).
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
    notify_email: boolean;
    email_send_status: EmailSendStatus;
    email_sent_at: Date | null;
    email_summary: unknown;
    category: InboxCategory;
    thread_key: string | null;
    thread_count: number;
    source_type: string | null;
    source_id: string | null;
    source_phase: string | null;
    audience_snapshot_status: "captured" | "legacy_unavailable";
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
            m.notify_email,
            m.email_send_status,
            m.email_sent_at,
            m.email_summary,
            m.category,
            m.thread_key,
            m.source_type,
            m.source_id::text AS source_id,
            m.source_phase,
            CASE
              WHEN m.thread_key IS NULL THEN 1
              ELSE (
                SELECT COUNT(*)::int
                  FROM inbox_messages threaded
                 WHERE threaded.thread_key=m.thread_key
              )
            END AS thread_count,
            COALESCE((SELECT COUNT(*)::int FROM inbox_message_reads r WHERE r.message_id = m.id), 0) AS read_count,
            COALESCE((SELECT COUNT(*)::int FROM inbox_message_audience_snapshots s
                       WHERE s.message_id=m.id),0) AS recipients,
            CASE WHEN m.audience_snapshotted_at IS NOT NULL
              THEN 'captured' ELSE 'legacy_unavailable' END AS audience_snapshot_status
       FROM inbox_messages m
      WHERE ($3::text IS NULL OR m.category=$3)
        AND ($4::text IS NULL OR
             ($4='unattributed' AND m.source_type IS NULL) OR m.source_type=$4)
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset, input.category ?? null, input.sourceType ?? null],
  );

  const totalRes = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM inbox_messages
      WHERE ($1::text IS NULL OR category=$1)
        AND ($2::text IS NULL OR
             ($2='unattributed' AND source_type IS NULL) OR source_type=$2)`,
    [input.category ?? null, input.sourceType ?? null],
  );

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
      notify_email: row.notify_email === true,
      email_send_status: row.email_send_status,
      email_sent_at: row.email_sent_at ? row.email_sent_at.toISOString() : null,
      email_summary: normalizeEmailSummary(row.email_summary),
      category: row.category,
      thread_key: row.thread_key,
      thread_count: row.thread_count,
      source_type: row.source_type,
      source_id: row.source_id,
      source_phase: row.source_phase,
      audience_snapshot_status: row.audience_snapshot_status,
    })),
    total: totalRes.rows[0]?.n ?? 0,
  };
}

export interface InboxAudiencePreview {
  audience: Audience;
  category: InboxCategory;
  recipients: number;
  sample: Array<{
    user_id: string;
    username: string | null;
    traffic_class: string;
  }>;
  recipient_load: { p50_30d: number; p90_30d: number; max_30d: number };
}

export async function previewInboxAudience(input: {
  audience: Audience;
  user_id?: string | null;
  category?: InboxCategory | null;
}): Promise<InboxAudiencePreview> {
  const userId = input.audience === "user" ? input.user_id ?? null : null;
  if (input.audience === "user" && (userId === null || !/^[1-9]\d{0,19}$/.test(userId))) {
    throw new InboxError("VALIDATION", "user_id is required for user audience");
  }
  const category = input.category ?? "user";
  const audienceSql = input.audience === "all"
    ? "u.status='active'"
    : "u.status='active' AND u.id=$1::bigint";
  const params = input.audience === "all" ? [] : [userId];
  const [audience, load] = await Promise.all([
    query<{ user_id: string; username: string | null; traffic_class: string; total: number }>(
      `SELECT u.id::text AS user_id,COALESCE(u.display_name,u.email) AS username,
              u.signal_traffic_class AS traffic_class,
              COUNT(*) OVER()::int AS total
         FROM users u WHERE ${audienceSql}
        ORDER BY u.id LIMIT 20`,
      params,
    ),
    query<{ p50: string | null; p90: string | null; max: number | null }>(
      `WITH audience AS (
         SELECT u.id AS user_id FROM users u
          WHERE u.status='active' AND ($1::bigint IS NULL OR u.id=$1)
       ), recipient_load AS (
         SELECT a.user_id,COUNT(m.id)::int AS messages
           FROM audience a
           LEFT JOIN inbox_message_audience_snapshots s ON s.user_id=a.user_id
           LEFT JOIN inbox_messages m ON m.id=s.message_id
             AND m.created_at>=NOW()-INTERVAL '30 days'
          GROUP BY a.user_id
       )
       SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY messages)::text AS p50,
              percentile_cont(0.9) WITHIN GROUP(ORDER BY messages)::text AS p90,
              MAX(messages)::int AS max FROM recipient_load`,
      [userId],
    ),
  ]);
  return {
    audience: input.audience,
    category,
    recipients: audience.rows[0]?.total ?? 0,
    sample: audience.rows.map(({ total: _total, ...row }) => row),
    recipient_load: {
      p50_30d: Number(load.rows[0]?.p50 ?? 0),
      p90_30d: Number(load.rows[0]?.p90 ?? 0),
      max_30d: load.rows[0]?.max ?? 0,
    },
  };
}

export interface AdminInboxStats {
  window_days: number;
  snapshot_coverage: { captured_messages: number; legacy_unavailable_messages: number };
  read_funnel: { messages: number; recipients: number; reads: number; read_rate: number | null };
  by_source: Array<{ source_type: string; messages: number; recipients: number; reads: number; read_rate: number | null }>;
  by_category: Array<{ category: string; messages: number; recipients: number; reads: number; read_rate: number | null }>;
  recipient_load: { users: number; p50: number; p90: number; max: number; over_20: number; over_100: number };
}

export async function getAdminInboxStats(days = 30): Promise<AdminInboxStats> {
  const windowDays = Math.min(90, Math.max(1, Math.trunc(days)));
  const params = [windowDays];
  const aggregateSql = (group: "source_type" | "category") => {
    const fallback = group === "source_type" ? "unattributed" : "unknown";
    return `
    SELECT COALESCE(m.${group},'${fallback}') AS key,COUNT(DISTINCT m.id)::int AS messages,
           COUNT(s.user_id)::int AS recipients,COUNT(r.user_id)::int AS reads
      FROM inbox_messages m
      LEFT JOIN inbox_message_audience_snapshots s ON s.message_id=m.id
      LEFT JOIN inbox_message_reads r ON r.message_id=m.id AND r.user_id=s.user_id
     WHERE m.created_at>=NOW()-($1::int*INTERVAL '1 day')
       AND m.audience_snapshotted_at IS NOT NULL
     GROUP BY COALESCE(m.${group},'${fallback}') ORDER BY COUNT(DISTINCT m.id) DESC`;
  };
  const [coverage, funnel, sources, categories, load] = await Promise.all([
    query<{ captured: number; legacy: number }>(
      `SELECT COUNT(*) FILTER (WHERE m.audience_snapshotted_at IS NOT NULL)::int AS captured,
              COUNT(*) FILTER (WHERE m.audience_snapshotted_at IS NULL)::int AS legacy
         FROM inbox_messages m WHERE m.created_at>=NOW()-($1::int*INTERVAL '1 day')`, params),
    query<{ messages: number; recipients: number; reads: number }>(
      `SELECT COUNT(DISTINCT m.id)::int AS messages,COUNT(s.user_id)::int AS recipients,
              COUNT(r.user_id)::int AS reads
         FROM inbox_messages m
         LEFT JOIN inbox_message_audience_snapshots s ON s.message_id=m.id
         LEFT JOIN inbox_message_reads r ON r.message_id=m.id AND r.user_id=s.user_id
        WHERE m.created_at>=NOW()-($1::int*INTERVAL '1 day')
          AND m.audience_snapshotted_at IS NOT NULL`, params),
    query<{ key: string; messages: number; recipients: number; reads: number }>(aggregateSql("source_type"), params),
    query<{ key: string; messages: number; recipients: number; reads: number }>(aggregateSql("category"), params),
    query<{ users: number; p50: string | null; p90: string | null; max: number | null; over_20: number; over_100: number }>(
      `WITH loads AS (
         SELECT s.user_id,COUNT(*)::int AS messages
           FROM inbox_message_audience_snapshots s JOIN inbox_messages m ON m.id=s.message_id
          WHERE m.created_at>=NOW()-($1::int*INTERVAL '1 day') GROUP BY s.user_id
       ) SELECT COUNT(*)::int AS users,
                percentile_cont(0.5) WITHIN GROUP(ORDER BY messages)::text AS p50,
                percentile_cont(0.9) WITHIN GROUP(ORDER BY messages)::text AS p90,
                MAX(messages)::int AS max,
                COUNT(*) FILTER (WHERE messages>20)::int AS over_20,
                COUNT(*) FILTER (WHERE messages>100)::int AS over_100 FROM loads`, params),
  ]);
  const rate = (reads: number, recipients: number): number | null =>
    recipients > 0 ? Math.round((reads / recipients) * 10_000) / 10_000 : null;
  const f = funnel.rows[0] ?? { messages: 0, recipients: 0, reads: 0 };
  const mapRows = (rows: Array<{ key: string; messages: number; recipients: number; reads: number }>) =>
    rows.map((row) => ({ ...row, read_rate: rate(row.reads, row.recipients) }));
  const l = load.rows[0];
  return {
    window_days: windowDays,
    snapshot_coverage: {
      captured_messages: coverage.rows[0]?.captured ?? 0,
      legacy_unavailable_messages: coverage.rows[0]?.legacy ?? 0,
    },
    read_funnel: { ...f, read_rate: rate(f.reads, f.recipients) },
    by_source: mapRows(sources.rows).map(({ key, ...row }) => ({ source_type: key, ...row })),
    by_category: mapRows(categories.rows).map(({ key, ...row }) => ({ category: key, ...row })),
    recipient_load: {
      users: l?.users ?? 0,
      p50: Number(l?.p50 ?? 0),
      p90: Number(l?.p90 ?? 0),
      max: l?.max ?? 0,
      over_20: l?.over_20 ?? 0,
      over_100: l?.over_100 ?? 0,
    },
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
