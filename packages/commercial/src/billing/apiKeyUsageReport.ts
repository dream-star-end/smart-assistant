/**
 * 外接 API key 消耗报表数据层 —— GET /api/me/api-keys/usage 的数据源(0277)。
 *
 * 与 billing/usageReport.ts **同范式**(summary + 趋势 + 按模型,generate_series 补零,
 * 大数 ::text),差异只在:
 *   - 基础谓词多一段 `api_key_id IS NOT NULL`(只统计经 `oc-cc.*` key 进来的流量),
 *     可选再钉到单个 key(`api_key_id = $3`);
 *   - 多两段:按 key 拆分(LEFT JOIN user_api_keys 取 label / prefix / 状态,**含已撤销**
 *     key —— 历史消耗不应随撤销消失)+ 最近 N 条请求明细。
 *
 * user_id 由 HTTP 层从 JWT 推导,本层**不接受**客户端 user_id(无 IDOR);key_id 仅接受
 * `[1-9][0-9]{0,19}` 且额外用 `user_id = $1` 双重限定 —— 别人的 key id 只会得到空结果。
 * trendBuckets 的 extraWhere 是源码常量 + 已通过正则校验的数字字面量(同 usageReport 的
 * board_project_id 做法),不存在注入面。
 */

import { query } from "../db/queries.js";
import { WINDOW_SPEC, trendBuckets, type UsageWindow } from "../org/orgReports.js";
import type { UserModelUsage, UserUsageSummary, UserUsageTrendPoint } from "./usageReport.js";

export { isUsageWindow, type UsageWindow } from "../org/orgReports.js";

export interface ApiKeyUsageByKeyRow {
  /** user_api_keys.id(字符串大数)。 */
  api_key_id: string;
  /** 已硬删(users CASCADE 之外理论不会发生)时为 null。 */
  label: string | null;
  key_prefix: string | null;
  revoked: boolean;
  disabled: boolean;
  requests: string;
  credits: string;
  input_tokens: string;
  output_tokens: string;
  last_used_at: string | null;
}

export interface ApiKeyUsageRecentRow {
  id: string;
  created_at: string;
  api_key_id: string | null;
  label: string | null;
  model: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  cost_credits: string;
  status: string;
}

export interface ApiKeyUsageReport {
  window: UsageWindow;
  /** 钉到单 key 时回显,否则 null。 */
  key_id: string | null;
  summary: UserUsageSummary;
  trend: UserUsageTrendPoint[];
  by_key: ApiKeyUsageByKeyRow[];
  by_model: UserModelUsage[];
  recent: ApiKeyUsageRecentRow[];
}

const EMPTY_SUMMARY: UserUsageSummary = {
  requests: "0",
  input_tokens: "0",
  output_tokens: "0",
  cache_read_tokens: "0",
  cache_write_tokens: "0",
  credits: "0",
};

/** 与 apiKeyAdmin 路径 id 同一正则;BIGINT 上限由 SQL 层比较兜底(超界返回空集,不 500)。 */
const KEY_ID_RE = /^[1-9][0-9]{0,19}$/;
const PG_BIGINT_MAX = 9223372036854775807n;

/** 校验 key_id 查询串;非法返 null(caller 400)。 */
export function parseApiKeyIdQuery(raw: string | null): { ok: true; keyId: string | null } | { ok: false } {
  if (raw === null || raw === "") return { ok: true, keyId: null };
  if (!KEY_ID_RE.test(raw)) return { ok: false };
  if (BigInt(raw) > PG_BIGINT_MAX) return { ok: false };
  return { ok: true, keyId: raw };
}

export const API_KEY_USAGE_RECENT_LIMIT = 50;

export async function getApiKeyUsageReport(
  userId: string,
  window: UsageWindow,
  keyId: string | null,
): Promise<ApiKeyUsageReport> {
  if (keyId !== null && !KEY_ID_RE.test(keyId)) {
    throw new Error("apiKeyUsageReport: keyId must be validated by caller");
  }
  const spec = WINDOW_SPEC[window];
  // $1 user_id, $2 hours, [$3 key_id]。`p` = 列前缀("" 或 "u."),JOIN 查询用。
  const whereFor = (p: string, successOnly: boolean): string =>
    `WHERE ${p}user_id = $1 AND ${p}api_key_id IS NOT NULL` +
    (successOnly ? ` AND ${p}status = 'success'` : "") +
    ` AND ${p}created_at >= NOW() - ($2::int * INTERVAL '1 hour')` +
    (keyId === null ? "" : ` AND ${p}api_key_id = $3::bigint`);
  const usageWhere = whereFor("", true);
  const usageParams: (string | number)[] = keyId === null ? [userId, spec.hours] : [userId, spec.hours, keyId];
  // trendBuckets 只接受 $1 scope + 常量 extraWhere:keyId 已通过 KEY_ID_RE(纯数字字面量)。
  const trendExtra =
    keyId === null
      ? "status = 'success' AND api_key_id IS NOT NULL"
      : `status = 'success' AND api_key_id = ${keyId}`;

  const [summaryRes, trend, byKeyRes, byModelRes, recentRes] = await Promise.all([
    query<UserUsageSummary>(
      `SELECT COUNT(*)::text                              AS requests,
              COALESCE(SUM(input_tokens), 0)::text        AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::text       AS output_tokens,
              COALESCE(SUM(cache_read_tokens), 0)::text   AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens), 0)::text  AS cache_write_tokens,
              COALESCE(SUM(cost_credits), 0)::text        AS credits
         FROM usage_records
        ${usageWhere}`,
      usageParams,
    ),
    trendBuckets<UserUsageTrendPoint>({
      unit: spec.trendUnit,
      points: spec.points,
      from: "usage_records",
      scopeWhere: "user_id = $1::bigint",
      extraWhere: trendExtra,
      scopeValue: userId,
      metrics: [
        { name: "requests", expr: "COUNT(*)" },
        { name: "credits", expr: "COALESCE(SUM(cost_credits), 0)" },
      ],
    }),
    query<ApiKeyUsageByKeyRow>(
      `SELECT u.api_key_id::text                          AS api_key_id,
              k.label                                     AS label,
              k.key_prefix                                AS key_prefix,
              (k.revoked_at IS NOT NULL)                  AS revoked,
              (k.disabled_at IS NOT NULL)                 AS disabled,
              COUNT(*)::text                              AS requests,
              COALESCE(SUM(u.cost_credits), 0)::text      AS credits,
              COALESCE(SUM(u.input_tokens), 0)::text      AS input_tokens,
              COALESCE(SUM(u.output_tokens), 0)::text     AS output_tokens,
              MAX(u.created_at)::text                     AS last_used_at
         FROM usage_records u
         LEFT JOIN user_api_keys k ON k.id = u.api_key_id
        ${whereFor("u.", true)}
        GROUP BY u.api_key_id, k.label, k.key_prefix, k.revoked_at, k.disabled_at
        ORDER BY SUM(u.cost_credits) DESC, u.api_key_id ASC`,
      usageParams,
    ),
    query<UserModelUsage>(
      `SELECT model,
              COUNT(*)::text                              AS requests,
              COALESCE(SUM(cost_credits), 0)::text        AS credits,
              COALESCE(SUM(input_tokens), 0)::text        AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::text       AS output_tokens,
              COALESCE(SUM(cache_read_tokens), 0)::text   AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens), 0)::text  AS cache_write_tokens
         FROM usage_records
        ${usageWhere}
        GROUP BY model
        ORDER BY SUM(cost_credits) DESC, model ASC`,
      usageParams,
    ),
    // 最近明细:这里**不**过滤 status —— 让 owner 看到失败/被拒的请求(0 积分)也在列。
    query<ApiKeyUsageRecentRow>(
      `SELECT u.id::text                 AS id,
              u.created_at::text         AS created_at,
              u.api_key_id::text         AS api_key_id,
              k.label                    AS label,
              u.model                    AS model,
              u.input_tokens::text       AS input_tokens,
              u.output_tokens::text      AS output_tokens,
              u.cache_read_tokens::text  AS cache_read_tokens,
              u.cache_write_tokens::text AS cache_write_tokens,
              u.cost_credits::text       AS cost_credits,
              u.status                   AS status
         FROM usage_records u
         LEFT JOIN user_api_keys k ON k.id = u.api_key_id
        ${whereFor("u.", false)}
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT ${API_KEY_USAGE_RECENT_LIMIT}`,
      usageParams,
    ),
  ]);

  return {
    window,
    key_id: keyId,
    summary: summaryRes.rows[0] ?? EMPTY_SUMMARY,
    trend,
    by_key: byKeyRes.rows,
    by_model: byModelRes.rows,
    recent: recentRes.rows,
  };
}
