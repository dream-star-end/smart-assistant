/**
 * 企业版(P3.1)批次 D — org 维度用量报表数据层(方案 §5)。
 *
 * 主口径 = `usage_records WHERE org_id = $org`(**写时打戳为权威**,批次 B 的 0112
 * 落 org_id 列;本层 SQL 直接写该列,类型上不依赖批次 B 代码)。委派(delegate)成本
 * 在 settle 路径已归到队长成员的 user_id 名下(0104),故按成员聚合天然把组队开销并入
 * 队长行——**零特殊处理**。
 *
 * 边界(方案 §5):无实时并发下钻(inflight 无 user 维度),只做历史聚合。
 * 大数纪律:requests / tokens / credits 一律 BIGINT ::text,绝不在 SQL/JS 里数值化。
 *
 * org 由 HTTP 层从 caller membership 推导后传入 orgId,本层**不接受**客户端 user_id 列表。
 */

import { query } from "../db/queries.js";

export type UsageWindow = "24h" | "7d" | "30d";

/** window → { 回看小时数(参数化 WHERE 用),趋势桶单位 + 桶数 }。白名单,非客户端注入。 */
const WINDOW_SPEC: Record<UsageWindow, { hours: number; trendUnit: "hour" | "day"; points: number }> = {
  "24h": { hours: 24, trendUnit: "hour", points: 24 },
  "7d": { hours: 7 * 24, trendUnit: "day", points: 7 },
  "30d": { hours: 30 * 24, trendUnit: "day", points: 30 },
};

export function isUsageWindow(v: unknown): v is UsageWindow {
  return v === "24h" || v === "7d" || v === "30d";
}

/** 四项 token + 请求数 + 扣费(全部字符串大数)。summary / 成员 / 模型共用。 */
export interface UsageTotals {
  requests: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  credits: string;
}

export interface OrgMemberUsage extends UsageTotals {
  user_id: string;
  email: string;
  display_name: string | null;
}

export interface OrgModelUsage extends UsageTotals {
  model: string;
}

export interface OrgUsageTrendPoint {
  /** 'YYYY-MM-DD'(day)或 'MM-DD HH:00'(hour),用于 X 轴 label。 */
  bucket: string;
  requests: string;
  credits: string;
}

export interface OrgUsageReport {
  window: UsageWindow;
  summary: UsageTotals;
  members: OrgMemberUsage[];
  models: OrgModelUsage[];
  trend: OrgUsageTrendPoint[];
}

/** SELECT 里复用的五项聚合(FILTER 无需,窗口已在 WHERE 收窄)。 */
const TOTALS_SELECT = `
  COUNT(*)::text                                   AS requests,
  COALESCE(SUM(input_tokens), 0)::text             AS input_tokens,
  COALESCE(SUM(output_tokens), 0)::text            AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0)::text        AS cache_read_tokens,
  COALESCE(SUM(cache_write_tokens), 0)::text       AS cache_write_tokens,
  COALESCE(SUM(cost_credits), 0)::text             AS credits`;

/**
 * org 用量报表:summary + 按成员 + 按模型 + 趋势。四段独立查询(各自走
 * usage_records 的 (org_id, created_at) partial 索引,批次 B 0112 建)。
 *
 * 窗口边界 `created_at >= NOW() - ($2 * INTERVAL '1 hour')` 完全参数化($2=回看小时数),
 * 不拼接任何客户端串。趋势桶用 generate_series 补齐空桶(day 桶按 Asia/Shanghai 自然日,
 * 抄 admin/stats.ts 的 `AT TIME ZONE` 手法;hour 桶用原始 NOW() 小时,同 stats.ts 小时线)。
 */
export async function getOrgUsageReport(orgId: string, window: UsageWindow): Promise<OrgUsageReport> {
  const spec = WINDOW_SPEC[window];

  // ── summary ──────────────────────────────────────────────────────
  const summaryRes = await query<UsageTotals>(
    `SELECT ${TOTALS_SELECT}
       FROM usage_records
      WHERE org_id = $1::bigint
        AND created_at >= NOW() - ($2::int * INTERVAL '1 hour')`,
    [orgId, spec.hours],
  );
  const summary = summaryRes.rows[0];

  // ── 按成员(JOIN users 出 email/display_name;委派已归队长 user_id)──
  const membersRes = await query<OrgMemberUsage>(
    `SELECT ur.user_id::text AS user_id, u.email, u.display_name,
            ${TOTALS_SELECT}
       FROM usage_records ur
       JOIN users u ON u.id = ur.user_id
      WHERE ur.org_id = $1::bigint
        AND ur.created_at >= NOW() - ($2::int * INTERVAL '1 hour')
      GROUP BY ur.user_id, u.email, u.display_name
      ORDER BY SUM(ur.cost_credits) DESC, ur.user_id ASC`,
    [orgId, spec.hours],
  );

  // ── 按模型 ────────────────────────────────────────────────────────
  const modelsRes = await query<OrgModelUsage>(
    `SELECT model, ${TOTALS_SELECT}
       FROM usage_records
      WHERE org_id = $1::bigint
        AND created_at >= NOW() - ($2::int * INTERVAL '1 hour')
      GROUP BY model
      ORDER BY SUM(cost_credits) DESC, model ASC`,
    [orgId, spec.hours],
  );

  // ── 趋势(补齐空桶)────────────────────────────────────────────────
  const trend = await orgUsageTrend(orgId, spec.trendUnit, spec.points);

  return {
    window,
    summary,
    members: membersRes.rows,
    models: modelsRes.rows,
    trend,
  };
}

/**
 * 趋势查询:generate_series 造出恰好 `points` 个桶(含当前桶 + 前 points-1 个),
 * LEFT JOIN 聚合 → 空桶补 0。day 桶按 Asia/Shanghai 自然日(与 stats.ts 对齐);
 * hour 桶按服务器 NOW() 小时(与 stats.ts 小时线一致,不 tz 平移)。
 */
async function orgUsageTrend(
  orgId: string,
  unit: "hour" | "day",
  points: number,
): Promise<OrgUsageTrendPoint[]> {
  if (unit === "day") {
    const r = await query<OrgUsageTrendPoint>(
      `WITH days AS (
         SELECT generate_series(
           date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') - ($2::int - 1) * INTERVAL '1 day',
           date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai'),
           INTERVAL '1 day'
         ) AS day
       ),
       agg AS (
         SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai') AS day,
                COUNT(*) AS requests,
                COALESCE(SUM(cost_credits), 0) AS credits
           FROM usage_records
          WHERE org_id = $1::bigint
            AND created_at >= ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') - ($2::int - 1) * INTERVAL '1 day') AT TIME ZONE 'Asia/Shanghai')
          GROUP BY 1
       )
       SELECT to_char(days.day, 'YYYY-MM-DD') AS bucket,
              COALESCE(agg.requests, 0)::text AS requests,
              COALESCE(agg.credits, 0)::text  AS credits
         FROM days
         LEFT JOIN agg ON agg.day = days.day
        ORDER BY days.day ASC`,
      [orgId, points],
    );
    return r.rows;
  }
  const r = await query<OrgUsageTrendPoint>(
    `WITH hours AS (
       SELECT generate_series(
         date_trunc('hour', NOW()) - ($2::int - 1) * INTERVAL '1 hour',
         date_trunc('hour', NOW()),
         INTERVAL '1 hour'
       ) AS hour
     ),
     agg AS (
       SELECT date_trunc('hour', created_at) AS hour,
              COUNT(*) AS requests,
              COALESCE(SUM(cost_credits), 0) AS credits
         FROM usage_records
        WHERE org_id = $1::bigint
          AND created_at >= date_trunc('hour', NOW()) - ($2::int - 1) * INTERVAL '1 hour'
        GROUP BY 1
     )
     SELECT to_char(hours.hour, 'MM-DD HH24:00') AS bucket,
            COALESCE(agg.requests, 0)::text AS requests,
            COALESCE(agg.credits, 0)::text  AS credits
       FROM hours
       LEFT JOIN agg ON agg.hour = hours.hour
      ORDER BY hours.hour ASC`,
    [orgId, points],
  );
  return r.rows;
}
