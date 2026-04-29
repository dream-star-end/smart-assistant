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

// ─── Funnel KPI(P-FUNNEL):新用户 cohort 转化率 ────────────────────
//
// 给定 days = 7 / 30,统计:在过去 [days] 个自然日(Asia/Shanghai)注册的 cohort,
// 各阶段绝对人数 + D1/D7 留存率。
//
// Cohort 边界:
//   today_start  := date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai')
//                   AT TIME ZONE 'Asia/Shanghai'         (今日 0 点 +08:00 → UTC)
//   cohort_lo    := today_start - (days - 1) * INTERVAL '1 day'
//   cohort_hi    := today_start + INTERVAL '1 day'        (含今天)
//   cohort: users WHERE created_at >= cohort_lo AND created_at < cohort_hi AND deleted_at IS NULL
//
// 阶段定义:
//   verified            email_verified = TRUE
//   first_topup         EXISTS credit_ledger reason='topup' delta>0
//   first_request       EXISTS usage_records (任意一次)
//
// 留存窗口(D1 = 注册次日 24h 内有 usage_records,Asia/Shanghai 自然日):
//   d1_window: created_at_day + INTERVAL '1 day' .. + INTERVAL '2 days'
//   d7_window: created_at_day + INTERVAL '7 days' .. + INTERVAL '8 days'
//
// 留存的 eligible 分母(诚实分母 — 只有 D1/D7 窗口已完整结束的 cohort 才计入):
//   D1 窗口 [created_day+1d, created_day+2d) 完整结束 ⇔ created_day+2d ≤ tz0
//                                                  ⇔ created_day < tz0 - 1 day
//   D7 窗口 [created_day+7d, created_day+8d) 完整结束 ⇔ created_day+8d ≤ tz0
//                                                  ⇔ created_day < tz0 - 7 days
//   日历日窗口已过的 cohort 才进分母,窗口仍在进行中的不污染留存率。

export interface FunnelStatsResult {
  /** 入参 days(已 clamp)。 */
  days: number;
  /** cohort 总人数(分母 1)。 */
  cohort_total: number;
  /** cohort 中 email_verified=TRUE 的人数。 */
  verified: number;
  /** cohort 中至少有 1 笔 topup(delta>0)的人数。 */
  first_topup: number;
  /** cohort 中至少有 1 条 usage_records 的人数。 */
  first_request: number;
  /** D1 留存合格分母 — D1 窗口已完整结束的 cohort 子集(created_day < tz0 - 1d)。 */
  eligible_for_d1: number;
  /** D7 留存合格分母 — D7 窗口已完整结束的 cohort 子集(created_day < tz0 - 7d)。 */
  eligible_for_d7: number;
  /** D1 留存命中(eligible_for_d1 中,在 [d+1,d+2) 自然日窗口内有 usage_records)。 */
  d1_retained: number;
  /** D7 留存命中(eligible_for_d7 中,在 [d+7,d+8) 自然日窗口内有 usage_records)。 */
  d7_retained: number;
}

/** allowlist days,避免 caller 传任意大窗口。 */
const FUNNEL_DAYS_VALUES = new Set([7, 30]);

export async function getFunnelStats(days: number): Promise<FunnelStatsResult> {
  if (!FUNNEL_DAYS_VALUES.has(days)) {
    throw new RangeError(`getFunnelStats: days must be 7 or 30 (got ${days})`);
  }

  // 一次 SQL 查完所有 8 个数 — cohort + 阶段 + 分母 + 留存。
  // - tz0 = Asia/Shanghai 今日 0 点(UTC tstamp)
  // - cohort 用 LATERAL 把每个用户的 created_at_day(自然日 0 点)算出来,
  //   方便 d1/d7 窗口直接 day + interval。
  const r = await query<{
    cohort_total: string;
    verified: string;
    first_topup: string;
    first_request: string;
    eligible_for_d1: string;
    eligible_for_d7: string;
    d1_retained: string;
    d7_retained: string;
  }>(
    `WITH params AS (
       SELECT
         (date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') AS tz0,
         $1::int AS days
     ),
     cohort AS (
       SELECT
         u.id,
         u.email_verified,
         (date_trunc('day', u.created_at AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') AS created_day
       FROM users u, params p
       WHERE u.deleted_at IS NULL
         AND u.created_at >= (p.tz0 - ((p.days - 1) || ' days')::interval)
         AND u.created_at <  (p.tz0 + INTERVAL '1 day')
     ),
     enriched AS (
       SELECT
         c.id,
         c.email_verified,
         c.created_day,
         EXISTS (
           SELECT 1 FROM credit_ledger cl
           WHERE cl.user_id = c.id AND cl.reason = 'topup' AND cl.delta > 0
         ) AS has_topup,
         EXISTS (
           SELECT 1 FROM usage_records ur WHERE ur.user_id = c.id
         ) AS has_request,
         EXISTS (
           SELECT 1 FROM usage_records ur
           WHERE ur.user_id = c.id
             AND ur.created_at >= c.created_day + INTERVAL '1 day'
             AND ur.created_at <  c.created_day + INTERVAL '2 days'
         ) AS d1_hit,
         EXISTS (
           SELECT 1 FROM usage_records ur
           WHERE ur.user_id = c.id
             AND ur.created_at >= c.created_day + INTERVAL '7 days'
             AND ur.created_at <  c.created_day + INTERVAL '8 days'
         ) AS d7_hit
       FROM cohort c
     )
     SELECT
       COUNT(*)::text                                                 AS cohort_total,
       COUNT(*) FILTER (WHERE email_verified)::text                   AS verified,
       COUNT(*) FILTER (WHERE has_topup)::text                        AS first_topup,
       COUNT(*) FILTER (WHERE has_request)::text                      AS first_request,
       COUNT(*) FILTER (WHERE created_day < (SELECT tz0 - INTERVAL '1 day' FROM params))::text             AS eligible_for_d1,
       COUNT(*) FILTER (WHERE created_day < (SELECT tz0 - INTERVAL '7 days' FROM params))::text             AS eligible_for_d7,
       COUNT(*) FILTER (WHERE d1_hit AND created_day < (SELECT tz0 - INTERVAL '1 day' FROM params))::text   AS d1_retained,
       COUNT(*) FILTER (WHERE d7_hit AND created_day < (SELECT tz0 - INTERVAL '7 days' FROM params))::text  AS d7_retained
     FROM enriched`,
    [days],
  );

  const u = r.rows[0] ?? {
    cohort_total: "0", verified: "0", first_topup: "0", first_request: "0",
    eligible_for_d1: "0", eligible_for_d7: "0", d1_retained: "0", d7_retained: "0",
  };
  return {
    days,
    cohort_total: Number(u.cohort_total),
    verified: Number(u.verified),
    first_topup: Number(u.first_topup),
    first_request: Number(u.first_request),
    eligible_for_d1: Number(u.eligible_for_d1),
    eligible_for_d7: Number(u.eligible_for_d7),
    d1_retained: Number(u.d1_retained),
    d7_retained: Number(u.d7_retained),
  };
}
