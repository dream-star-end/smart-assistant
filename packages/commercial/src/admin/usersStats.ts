/**
 * 超管 /users tab 专用 KPI 聚合。
 *
 * 只一个导出 `getUsersStats()`,一次性查出 4 张 KPI 卡片需要的所有数字。
 * 查询都是"只读 + COUNT/SUM/AVG",参数化,窗口固定到"now() / 7d / 30d",
 * 不让 caller 自由放大窗口以防扫全表。
 *
 * 索引使用:
 *   - users.created_at 有复合 (email, ...)? 实际上没有 created_at 单独索引 —
 *     但 users 表相对小(<100k),seq scan 可接受
 *   - usage_records.idx_ur_created_at (R1 新加) 支持 active_7d / active_24h
 *   - credit_ledger.idx_cl_reason (reason, created_at DESC) 的前缀命中 paying_7d
 */

import { query } from "../db/queries.js";

export interface UsersStatsResult {
  /** users 表总行数(排除 deleted_at IS NOT NULL)。 */
  total_users: number;
  /** status='active' 的用户数。 */
  active_users: number;
  /** status='banned' 的用户数。 */
  banned_users: number;
  /** status='deleting' 或 'deleted' 或 deleted_at 非空的用户数。 */
  deleted_users: number;
  /** 过去 7 天新注册(按 users.created_at,排除已删)。 */
  new_7d: number;
  /** 过去 7 天 DAU union(有 usage_records 的独立用户数)。 */
  active_7d: number;
  /** 过去 7 天付费用户(credit_ledger reason='topup' AND delta>0 distinct user)。 */
  paying_7d: number;
  /** 当前所有未删除 users 的 credits 均值(cents,字符串避免 bigint 溢出)。 */
  avg_credits_cents: string;
  /** 当前所有未删除 users 的 credits 合计(cents,字符串)。 */
  total_credits_cents: string;
}

/**
 * 一次查完所有 KPI。4 条子查询全部独立,PG 会 parallel-scan,比前端分 4 次请求
 * 快(省掉 auth round-trip × 4)。
 */
export async function getUsersStats(): Promise<UsersStatsResult> {
  const r = await query<{
    total_users: string;
    active_users: string;
    banned_users: string;
    deleted_users: string;
    new_7d: string;
    avg_credits_cents: string | null;
    total_credits_cents: string | null;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE deleted_at IS NULL AND status != 'deleted')      AS total_users,
       COUNT(*) FILTER (WHERE status = 'active' AND deleted_at IS NULL)        AS active_users,
       COUNT(*) FILTER (WHERE status = 'banned' AND deleted_at IS NULL)        AS banned_users,
       COUNT(*) FILTER (WHERE status IN ('deleting','deleted') OR deleted_at IS NOT NULL) AS deleted_users,
       COUNT(*) FILTER (
         WHERE created_at > NOW() - INTERVAL '7 days'
           AND deleted_at IS NULL
           AND status != 'deleted'
       )                                                                        AS new_7d,
       COALESCE(AVG(credits) FILTER (WHERE deleted_at IS NULL), 0)::bigint::text
                                                                                AS avg_credits_cents,
       COALESCE(SUM(credits) FILTER (WHERE deleted_at IS NULL), 0)::text
                                                                                AS total_credits_cents
     FROM users`,
  );

  const act = await query<{ active_7d: string }>(
    `SELECT COUNT(DISTINCT user_id)::text AS active_7d
       FROM usage_records
      WHERE created_at > NOW() - INTERVAL '7 days'`,
  );
  const pay = await query<{ paying_7d: string }>(
    `SELECT COUNT(DISTINCT user_id)::text AS paying_7d
       FROM credit_ledger
      WHERE reason = 'topup'
        AND delta > 0
        AND created_at > NOW() - INTERVAL '7 days'`,
  );

  const u = r.rows[0] ?? {
    total_users: "0", active_users: "0", banned_users: "0", deleted_users: "0",
    new_7d: "0", avg_credits_cents: "0", total_credits_cents: "0",
  };
  return {
    total_users: Number(u.total_users),
    active_users: Number(u.active_users),
    banned_users: Number(u.banned_users),
    deleted_users: Number(u.deleted_users),
    new_7d: Number(u.new_7d),
    active_7d: Number(act.rows[0]?.active_7d ?? "0"),
    paying_7d: Number(pay.rows[0]?.paying_7d ?? "0"),
    avg_credits_cents: u.avg_credits_cents ?? "0",
    total_credits_cents: u.total_credits_cents ?? "0",
  };
}
