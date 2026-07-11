/**
 * 个人版用量报表数据层 —— GET /api/me/usage/report 的数据源。
 *
 * 与企业版 org/orgReports.ts **同范式**:summary + 按模型 + 趋势,generate_series 补零、
 * day 桶按 Asia/Shanghai、hour 桶 date_trunc('hour', NOW())、大数一律 ::text。
 * 窗口/桶语义直接复用 orgReports 的 WINDOW_SPEC / trendBuckets(单一权威,**不发明第二套**)。
 *
 * 与 org 版的差异只在「scope 从 org_id 换成 user_id」+「多一段 credit_ledger 流水趋势」:
 *   - 用量三段(summary / trend / models)基础谓词 = `user_id = $1 AND status = 'success'`
 *     (与 http/handlers.ts handleGetMyUsage 的 summary 口径逐字一致),再叠加窗口条件。
 *   - 流水两段(ledger.trend / by_reason)基于 credit_ledger,谓词 = `user_id = $1`
 *     (与 handleGetMyUsage 复用的 admin/ledger.ts listLedger 个人流水口径一致,**不按 reason
 *     白名单过滤、不自创 bucket 过滤**),再叠加窗口条件。credited/debited 按 delta 正负拆分。
 *
 * user_id 由 HTTP 层从 requireAuth 的 JWT sub 推导后传入,本层**不接受**客户端传 user_id(无 IDOR)。
 */

import { query } from "../db/queries.js";
import {
  WINDOW_SPEC,
  trendBuckets,
  type UsageWindow,
} from "../org/orgReports.js";

// 窗口白名单谓词/判定沿用 org 版单一权威,向 HTTP 层再导出一层(个人端不必反向依赖 org 模块)。
export { isUsageWindow, type UsageWindow } from "../org/orgReports.js";

/** summary:四项 token + 请求数 + 名义扣费(cost_credits),全部字符串大数。 */
export interface UserUsageSummary {
  requests: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  credits: string;
}

/** 用量趋势点:桶 + 请求数 + 名义积分。 */
export interface UserUsageTrendPoint {
  bucket: string;
  requests: string;
  credits: string;
}

/** 按模型:GROUP BY model,credits 用 cost_credits(名义口径)。 */
export interface UserModelUsage {
  model: string;
  requests: string;
  credits: string;
}

/** 流水趋势点:桶 + 进账(delta>0)+ 出账(-delta,delta<0)。 */
export interface UserLedgerTrendPoint {
  bucket: string;
  credited: string;
  debited: string;
}

/** 按事由(仅支出侧):reason + 出账合计。 */
export interface UserLedgerReasonRow {
  reason: string;
  debited: string;
}

export interface UserUsageReport {
  window: UsageWindow;
  summary: UserUsageSummary;
  trend: UserUsageTrendPoint[];
  models: UserModelUsage[];
  ledger: {
    trend: UserLedgerTrendPoint[];
    by_reason: UserLedgerReasonRow[];
  };
}

const EMPTY_SUMMARY: UserUsageSummary = {
  requests: "0",
  input_tokens: "0",
  output_tokens: "0",
  cache_read_tokens: "0",
  cache_write_tokens: "0",
  credits: "0",
};

/**
 * 个人版用量报表:summary + 趋势 + 按模型 + 流水(趋势 + 按事由)。五段并发只读查询,
 * 全部 WHERE user_id=$1(无 IDOR)。用量三段吃 idx_ur_user_time (user_id, created_at DESC);
 * 流水两段吃 idx_cl_user_time (user_id, created_at DESC)。
 *
 * 窗口边界 `created_at >= NOW() - ($2::int * INTERVAL '1 hour')` 完全参数化($2=回看小时数),
 * 趋势段的窗口/桶边界则内聚在 trendBuckets 里(points 桶 + 桶下界),与 org 版逐字一致。
 */
export async function getUserUsageReport(
  userId: string,
  window: UsageWindow,
): Promise<UserUsageReport> {
  const spec = WINDOW_SPEC[window];

  const [summaryRes, modelsRes, trend, ledgerTrend, ledgerReasonRes] = await Promise.all([
    // ── summary(与 handleGetMyUsage summary 同口径 + 窗口)────────────────
    query<UserUsageSummary>(
      `SELECT COUNT(*)::text                              AS requests,
              COALESCE(SUM(input_tokens), 0)::text        AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::text       AS output_tokens,
              COALESCE(SUM(cache_read_tokens), 0)::text   AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens), 0)::text  AS cache_write_tokens,
              COALESCE(SUM(cost_credits), 0)::text        AS credits
         FROM usage_records
        WHERE user_id = $1 AND status = 'success'
          AND created_at >= NOW() - ($2::int * INTERVAL '1 hour')`,
      [userId, spec.hours],
    ),
    // ── 按模型 ─────────────────────────────────────────────────────────
    query<UserModelUsage>(
      `SELECT model,
              COUNT(*)::text                          AS requests,
              COALESCE(SUM(cost_credits), 0)::text    AS credits
         FROM usage_records
        WHERE user_id = $1 AND status = 'success'
          AND created_at >= NOW() - ($2::int * INTERVAL '1 hour')
        GROUP BY model
        ORDER BY SUM(cost_credits) DESC, model ASC`,
      [userId, spec.hours],
    ),
    // ── 用量趋势(补零,桶语义同 org)────────────────────────────────────
    trendBuckets<UserUsageTrendPoint>({
      unit: spec.trendUnit,
      points: spec.points,
      from: "usage_records",
      scopeWhere: "user_id = $1::bigint",
      extraWhere: "status = 'success'",
      scopeValue: userId,
      metrics: [
        { name: "requests", expr: "COUNT(*)" },
        { name: "credits", expr: "COALESCE(SUM(cost_credits), 0)" },
      ],
    }),
    // ── 流水趋势(credit_ledger,credited=进账 / debited=出账)────────────
    trendBuckets<UserLedgerTrendPoint>({
      unit: spec.trendUnit,
      points: spec.points,
      from: "credit_ledger",
      scopeWhere: "user_id = $1::bigint",
      scopeValue: userId,
      metrics: [
        { name: "credited", expr: "COALESCE(SUM(delta) FILTER (WHERE delta > 0), 0)" },
        { name: "debited", expr: "COALESCE(SUM(-delta) FILTER (WHERE delta < 0), 0)" },
      ],
    }),
    // ── 流水按事由(仅支出侧 delta<0,按出账降序)────────────────────────
    query<UserLedgerReasonRow>(
      `SELECT reason,
              COALESCE(SUM(-delta), 0)::text AS debited
         FROM credit_ledger
        WHERE user_id = $1 AND delta < 0
          AND created_at >= NOW() - ($2::int * INTERVAL '1 hour')
        GROUP BY reason
        ORDER BY SUM(-delta) DESC, reason ASC`,
      [userId, spec.hours],
    ),
  ]);

  return {
    window,
    summary: summaryRes.rows[0] ?? EMPTY_SUMMARY,
    trend,
    models: modelsRes.rows,
    ledger: {
      trend: ledgerTrend,
      by_reason: ledgerReasonRes.rows,
    },
  };
}
