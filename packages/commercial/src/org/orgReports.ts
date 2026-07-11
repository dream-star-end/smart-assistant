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

/** window → { 回看小时数(参数化 WHERE 用),趋势桶单位 + 桶数 }。白名单,非客户端注入。
 *  **单一权威**:org / 个人版(billing/usageReport.ts)共用同一张表,严禁复制第二份窗口语义。 */
export const WINDOW_SPEC: Record<UsageWindow, { hours: number; trendUnit: "hour" | "day"; points: number }> = {
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
 * org 趋势:委派给 `trendBuckets` 共享脚手架(见其注释)。org 特化 = 源表 usage_records、
 * scope 谓词 org_id、聚合 (requests, credits)。个人版用量/流水趋势同样复用该脚手架,
 * 桶语义(沪时自然日 / NOW() 小时 / 补零)由此**单一权威**保证不漂移。
 */
async function orgUsageTrend(
  orgId: string,
  unit: TrendUnit,
  points: number,
): Promise<OrgUsageTrendPoint[]> {
  return trendBuckets<OrgUsageTrendPoint>({
    unit,
    points,
    from: "usage_records",
    scopeWhere: "org_id = $1::bigint",
    scopeValue: orgId,
    metrics: [
      { name: "requests", expr: "COUNT(*)" },
      { name: "credits", expr: "COALESCE(SUM(cost_credits), 0)" },
    ],
  });
}

export type TrendUnit = "hour" | "day";

/**
 * 趋势聚合列描述:输出列名 + inner agg CTE 的聚合表达式。
 * **name / expr 均为调用方源码里的白名单常量**(如 'COUNT(*)' / "SUM(delta) FILTER (WHERE delta > 0)"),
 * 绝不含客户端输入 —— 故可安全内插进 SQL 标识/表达式位。
 */
export interface TrendMetric {
  name: string;
  expr: string;
}

/**
 * 趋势桶脚手架 —— org 用量 / 个人用量 / 个人流水三处**唯一**权威(消除三份 generate_series
 * 桶语义漂移这一整类风险)。generate_series 造出恰好 `points` 个桶(含当前桶 + 前 points-1 个),
 * LEFT JOIN 聚合 → 空桶补 0:
 *   - day 桶:边界按 Asia/Shanghai 自然日,agg 侧也按沪时 date_trunc;下界再
 *     `AT TIME ZONE 'Asia/Shanghai'` 转回 timestamptz 做 `created_at >=`(与 stats.ts 对齐)。
 *   - hour 桶:按服务器 NOW() 小时,不做 tz 平移(与 stats.ts 小时线一致)。
 * 输出每桶 `{ bucket, ...metrics }`,metrics 全部 `COALESCE(...,0)::text` 大数字符串。
 *
 * **注入面**:from / scopeWhere / extraWhere / metrics 全部是调用方源码常量(scope 列名来自
 * 内部枚举,绝非客户端注入);唯一外部值 = scopeValue($1)、points($2),均已参数化。
 * 切勿把任何客户端串接进这些片段。
 */
export async function trendBuckets<T extends { bucket: string }>(opts: {
  unit: TrendUnit;
  points: number;
  /** 源表(白名单常量),如 'usage_records' / 'credit_ledger'。 */
  from: string;
  /** scope 谓词(白名单常量,含 $1),如 "org_id = $1::bigint" / "user_id = $1::bigint"。 */
  scopeWhere: string;
  /** 附加谓词(白名单常量,无参数),如 "status = 'success'";可省。 */
  extraWhere?: string;
  /** $1 值:org_id / user_id(bigint-safe 字符串)。 */
  scopeValue: string | number;
  /** 输出聚合列(inner agg 表达式 + outer 别名)。 */
  metrics: TrendMetric[];
}): Promise<T[]> {
  const { unit, points, from, scopeWhere, extraWhere, scopeValue, metrics } = opts;
  const where = extraWhere ? `${scopeWhere} AND ${extraWhere}` : scopeWhere;
  const innerAgg = metrics.map((m) => `${m.expr} AS ${m.name}`).join(",\n                ");
  const outerAgg = metrics.map((m) => `COALESCE(agg.${m.name}, 0)::text AS ${m.name}`).join(",\n              ");

  if (unit === "day") {
    const r = await query<T>(
      `WITH days AS (
         SELECT generate_series(
           date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') - ($2::int - 1) * INTERVAL '1 day',
           date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai'),
           INTERVAL '1 day'
         ) AS day
       ),
       agg AS (
         SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai') AS day,
                ${innerAgg}
           FROM ${from}
          WHERE ${where}
            AND created_at >= ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') - ($2::int - 1) * INTERVAL '1 day') AT TIME ZONE 'Asia/Shanghai')
          GROUP BY 1
       )
       SELECT to_char(days.day, 'YYYY-MM-DD') AS bucket,
              ${outerAgg}
         FROM days
         LEFT JOIN agg ON agg.day = days.day
        ORDER BY days.day ASC`,
      [scopeValue, points],
    );
    return r.rows;
  }
  const r = await query<T>(
    `WITH hours AS (
       SELECT generate_series(
         date_trunc('hour', NOW()) - ($2::int - 1) * INTERVAL '1 hour',
         date_trunc('hour', NOW()),
         INTERVAL '1 hour'
       ) AS hour
     ),
     agg AS (
       SELECT date_trunc('hour', created_at) AS hour,
              ${innerAgg}
         FROM ${from}
        WHERE ${where}
          AND created_at >= date_trunc('hour', NOW()) - ($2::int - 1) * INTERVAL '1 hour'
        GROUP BY 1
     )
     SELECT to_char(hours.hour, 'MM-DD HH24:00') AS bucket,
            ${outerAgg}
       FROM hours
       LEFT JOIN agg ON agg.hour = hours.hour
      ORDER BY hours.hour ASC`,
    [scopeValue, points],
  );
  return r.rows;
}
