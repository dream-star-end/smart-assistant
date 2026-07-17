/**
 * response_rating —— v5-only 每条响应满意度评分(👍/👎 + 可选标签 + 可选评论)的 DB 层。
 *
 * 单一权威:本表所有读写(用户 upsert / 用户按会话回读 / admin 统计 / admin 差评明细)
 * 都收口在此模块,与 feedback 的 admin/feedback.ts 同构(一张表一个 DB 模块)。
 *
 * 语义边界见迁移 0121 头注释:与 feedback(自由文本问题上报)语义不同,勿混用。
 */

import { query } from "./db/queries.js";
import { incrImplicitRatingOverridden } from "./admin/metrics.js";

// ─── 用户侧:upsert 一条评分 ──────────────────────────────────────────

export interface UpsertResponseRatingInput {
  userId: string; // bigint as string(claims.sub)
  sessionId: string | null;
  messageId: string;
  traceId: string | null;
  model: string | null;
  rating: "up" | "down";
  tags: string[];
  comment: string | null;
}

/**
 * 隐式评分的机器标记 tag(方案 b,2026-07-16):前端把"turn 中途被用户打断/同一问题
 * 5 分钟内改写重发"作为弱差评静默上报,tags 含本标记。语义地位:
 *   - **显式永远压过隐式**:upsert 冲突时,隐式来件不得覆盖已有显式评分;
 *     显式来件照常覆盖一切(含隐式)。
 *   - 展示/统计面(前端已评回读、admin 满意度统计、市场公开评分聚合)一律排除隐式;
 *     **差评驱动训练燃料查询(marketplaceDb skill-feedback)有意纳入** —— 那是本机制的
 *     目的。新增消费面时先决定它属于哪一侧。
 */
export const IMPLICIT_RATING_TAG = "implicit";

export function isImplicitRating(tags: string[]): boolean {
  return tags.includes(IMPLICIT_RATING_TAG);
}

/**
 * INSERT ... ON CONFLICT (user_id, message_id) DO UPDATE。
 * 用户可改 👍↔👎、改标签、补/改评论 —— 命中唯一键即更新可变字段 + updated_at。
 * created_at 不动(首评时间保留)。
 * 隐式来件(tags 含 IMPLICIT_RATING_TAG)只允许覆盖同为隐式的既有行:
 * DO UPDATE 带 WHERE,显式行命中冲突时隐式来件静默不生效(0 行更新,非错误)。
 */
export async function upsertResponseRating(input: UpsertResponseRatingInput): Promise<void> {
  const incomingImplicit = isImplicitRating(input.tags);
  // existing CTE 在 upsert 之前对同一 (user,message) 读旧行的隐式态(语句快照 → 读到的是
  // 旧值,看不到 upserted 的写入);upserted 保持原 INSERT..ON CONFLICT 语义不变,
  // RETURNING 1 让 did_write 反映"确有写入"(隐式来件命中显式行时 WHERE 为假 → 0 行 → false)。
  const r = await query<{ was_implicit: boolean | null; did_write: boolean }>(
    `WITH existing AS (
       SELECT ($10 = ANY(tags)) AS was_implicit
         FROM response_rating
        WHERE user_id = $1::bigint AND message_id = $3
     ),
     upserted AS (
       INSERT INTO response_rating
         (user_id, session_id, message_id, trace_id, model, rating, tags, comment)
       VALUES ($1::bigint, $2, $3, $4, $5, $6, $7::text[], $8)
       ON CONFLICT (user_id, message_id) DO UPDATE
         SET rating     = EXCLUDED.rating,
             tags       = EXCLUDED.tags,
             comment    = EXCLUDED.comment,
             model      = EXCLUDED.model,
             trace_id   = EXCLUDED.trace_id,
             session_id = EXCLUDED.session_id,
             updated_at = NOW()
         WHERE NOT $9::boolean OR $10 = ANY(response_rating.tags)
       RETURNING 1
     )
     SELECT (SELECT was_implicit FROM existing) AS was_implicit,
            EXISTS (SELECT 1 FROM upserted)      AS did_write`,
    [
      input.userId,
      input.sessionId,
      input.messageId,
      input.traceId,
      input.model,
      input.rating,
      input.tags, // node-pg 把 JS string[] 序列化为 PG text[] 字面量
      input.comment,
      incomingImplicit,
      IMPLICIT_RATING_TAG,
    ],
  );
  // E7 误伤率活体指标:显式来件(incomingImplicit=false)覆盖了原本 implicit 的行 →
  // 用户主动纠正了一次隐式误判(误伤),打点。隐式来件不计(它压根不能覆盖显式)。
  const row = r.rows[0];
  if (!incomingImplicit && row?.did_write === true && row.was_implicit === true) {
    incrImplicitRatingOverridden();
  }
}

// ─── 用户侧:按会话回读该用户所有评分(前端"已评状态"恢复)──────────────

export interface SessionRatingEntry {
  rating: "up" | "down";
  tags: string[];
}

/** 返回 { [messageId]: { rating, tags } };前端重开会话据此标出已评响应、避免重复采集。
 *  排除隐式行:UI 绝不把用户没点过的 👎 渲染成已选态(隐式行存在时用户仍可正常显式评,
 *  显式 upsert 会覆盖隐式)。 */
export async function listSessionRatings(
  userId: string,
  sessionId: string,
): Promise<Record<string, SessionRatingEntry>> {
  const r = await query<{ message_id: string; rating: "up" | "down"; tags: string[] | null }>(
    `SELECT message_id, rating, tags
       FROM response_rating
      WHERE user_id = $1::bigint AND session_id = $2
        AND NOT ($3 = ANY(tags))`,
    [userId, sessionId, IMPLICIT_RATING_TAG],
  );
  const out: Record<string, SessionRatingEntry> = {};
  for (const row of r.rows) {
    out[row.message_id] = { rating: row.rating, tags: row.tags ?? [] };
  }
  return out;
}

// ─── admin 侧:按模型 + 时间窗好评率统计 ─────────────────────────────

export interface RatingBucket {
  up: number;
  down: number;
  total: number;
  /** up / total(0..1),保留 4 位小数;total=0 时为 null。 */
  up_rate: number | null;
}

export interface ModelRatingStat extends RatingBucket {
  model: string | null; // 可空:评分时未带模型 id
}

export interface ResponseRatingStats {
  overall: RatingBucket;
  last_7d: RatingBucket;
  last_30d: RatingBucket;
  by_model: ModelRatingStat[];
}

function toBucket(up: number, down: number): RatingBucket {
  const total = up + down;
  return {
    up,
    down,
    total,
    up_rate: total > 0 ? Math.round((up / total) * 1e4) / 1e4 : null,
  };
}

export async function getResponseRatingStats(): Promise<ResponseRatingStats> {
  // 一次扫表算出 overall + 7d + 30d 三个窗口的 up/down(条件聚合,走 created_at / model_rating 索引)。
  // 满意度口径只统计显式评分:隐式弱信号(中途打断/改写重发)不进 up_rate,防止把
  // "用户拿到所需后主动停止"这类中性行为计成不满意。
  const windows = await query<{
    up_all: number;
    down_all: number;
    up_7d: number;
    down_7d: number;
    up_30d: number;
    down_30d: number;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE rating = 'up')::int   AS up_all,
       COUNT(*) FILTER (WHERE rating = 'down')::int AS down_all,
       COUNT(*) FILTER (WHERE rating = 'up'   AND created_at >= NOW() - INTERVAL '7 days')::int  AS up_7d,
       COUNT(*) FILTER (WHERE rating = 'down' AND created_at >= NOW() - INTERVAL '7 days')::int  AS down_7d,
       COUNT(*) FILTER (WHERE rating = 'up'   AND created_at >= NOW() - INTERVAL '30 days')::int AS up_30d,
       COUNT(*) FILTER (WHERE rating = 'down' AND created_at >= NOW() - INTERVAL '30 days')::int AS down_30d
     FROM response_rating
     WHERE NOT ($1 = ANY(tags))`,
    [IMPLICIT_RATING_TAG],
  );
  const w = windows.rows[0] ?? {
    up_all: 0,
    down_all: 0,
    up_7d: 0,
    down_7d: 0,
    up_30d: 0,
    down_30d: 0,
  };

  const byModel = await query<{ model: string | null; up: number; down: number }>(
    `SELECT model,
       COUNT(*) FILTER (WHERE rating = 'up')::int   AS up,
       COUNT(*) FILTER (WHERE rating = 'down')::int AS down
     FROM response_rating
     WHERE NOT ($1 = ANY(tags))
     GROUP BY model
     ORDER BY (COUNT(*)) DESC, model ASC NULLS LAST`,
    [IMPLICIT_RATING_TAG],
  );

  return {
    overall: toBucket(w.up_all, w.down_all),
    last_7d: toBucket(w.up_7d, w.down_7d),
    last_30d: toBucket(w.up_30d, w.down_30d),
    by_model: byModel.rows.map((m) => ({ model: m.model, ...toBucket(m.up, m.down) })),
  };
}

// ─── admin 侧:差评明细(复合游标分页,仿 admin/feedback.ts listFeedback)──────

export interface DownRatingRow {
  id: string; // bigint as string
  model: string | null;
  tags: string[];
  comment: string | null;
  trace_id: string | null;
  session_id: string | null;
  created_at: string; // ISO
  username: string | null; // JOIN users:display_name ?? email
}

export interface ListDownRatingsInput {
  // 复合游标:取严格小于 (before_created_at, before_id) 的行
  before_created_at?: string;
  before_id?: string;
  limit?: number;
}

export interface ListDownRatingsResult {
  rows: DownRatingRow[];
  next_before_created_at: string | null;
  next_before_id: string | null;
}

const DOWN_DEFAULT_LIMIT = 50;
const DOWN_MAX_LIMIT = 200;

export async function listDownRatings(
  input: ListDownRatingsInput = {},
): Promise<ListDownRatingsResult> {
  const limit = Math.min(Math.max(1, input.limit ?? DOWN_DEFAULT_LIMIT), DOWN_MAX_LIMIT);
  const where: string[] = ["r.rating = 'down'"];
  const params: unknown[] = [];

  if (input.before_created_at && input.before_id) {
    params.push(input.before_created_at);
    const a = `$${params.length}::timestamptz`;
    params.push(input.before_id);
    const b = `$${params.length}::bigint`;
    where.push(`(r.created_at, r.id) < (${a}, ${b})`);
  }

  params.push(limit + 1); // +1 sentinel:判断是否还有下一页
  const limitIdx = params.length;

  const sql = `
    SELECT
      r.id::text        AS id,
      r.model,
      r.tags,
      r.comment,
      r.trace_id,
      r.session_id,
      r.created_at,
      COALESCE(u.display_name, u.email) AS username
    FROM response_rating r
    LEFT JOIN users u ON u.id = r.user_id
    WHERE ${where.join(" AND ")}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT $${limitIdx}
  `;

  const r = await query<{
    id: string;
    model: string | null;
    tags: string[] | null;
    comment: string | null;
    trace_id: string | null;
    session_id: string | null;
    created_at: Date;
    username: string | null;
  }>(sql, params);

  const hasMore = r.rows.length > limit;
  const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
  const last = rows[rows.length - 1];
  return {
    rows: rows.map((row) => ({
      id: row.id,
      model: row.model,
      tags: row.tags ?? [],
      comment: row.comment,
      trace_id: row.trace_id,
      session_id: row.session_id,
      created_at: row.created_at.toISOString(),
      username: row.username,
    })),
    next_before_created_at: hasMore && last ? last.created_at.toISOString() : null,
    next_before_id: hasMore && last ? last.id : null,
  };
}
