/**
 * R3 — accounts tab 专用 KPI + per-account 今日聚合。
 *
 * 两个导出:
 *   - `getAccountsPoolStats()` → 池子级 KPI(总数、按 status 分布、oauth 过期分布、
 *     今日请求/错误总和)一次查完,给顶部 KPI 卡片用
 *   - `getAccountsTodayStats(ids)` → 指定 account_id[] 的今日请求/错误计数,给
 *     表格的"今日请求"列用。限制:ids.length ≤ 500,防 IN 列表失控。
 *
 * 索引依赖:
 *   - `idx_ur_account(account_id, created_at DESC)` —— 0002 建,per-account GROUP BY 命中
 *   - `claude_accounts.status` 上现有 `idx_pool_active_ready`(partial,status='active')
 *     其他 status 走 seq scan,池表小(<1k)可以接受
 */

import { query } from "../db/queries.js";

export interface AccountsPoolStats {
  total: number;
  active: number;
  cooldown: number;
  disabled: number;
  banned: number;
  /**
   * oauth_expires_at < NOW() 且**有** refresh token(密文 + nonce 都非空)。
   * 走 anthropicProxy.ts 的 lazy refresh,人工无需介入,UI 用 muted chip。
   */
  expired_refreshable: number;
  /**
   * oauth_expires_at < NOW() 且**没有** refresh token —— 真坏,需要管理员重登。
   * KPI 主值的 danger 信号源。
   */
  expired_unrefreshable: number;
  /** oauth_expires_at ≥ NOW() AND oauth_expires_at < NOW() + 24h */
  expiring_24h: number;
  /** 今日 usage_records 总请求数(所有账号汇总) */
  today_requests: number;
  /** 今日 usage_records 中 status != 'success' 的数 */
  today_errors: number;
}

export async function getAccountsPoolStats(): Promise<AccountsPoolStats> {
  // claude_accounts 单张表多 FILTER 一次查完;usage_records 另起一条按 created_at
  // 范围扫,两路都参数为零、索引走得稳。
  const r = await query<{
    total: string;
    active: string;
    cooldown: string;
    disabled: string;
    banned: string;
    expired_refreshable: string;
    expired_unrefreshable: string;
    expiring_24h: string;
  }>(
    `SELECT
       COUNT(*)                                                         AS total,
       COUNT(*) FILTER (WHERE status = 'active')                        AS active,
       COUNT(*) FILTER (WHERE status = 'cooldown')                      AS cooldown,
       COUNT(*) FILTER (WHERE status = 'disabled')                      AS disabled,
       COUNT(*) FILTER (WHERE status = 'banned')                        AS banned,
       COUNT(*) FILTER (
         WHERE oauth_expires_at IS NOT NULL
           AND oauth_expires_at < NOW()
           AND oauth_refresh_enc IS NOT NULL
           AND oauth_refresh_nonce IS NOT NULL
       )                                                                 AS expired_refreshable,
       COUNT(*) FILTER (
         WHERE oauth_expires_at IS NOT NULL
           AND oauth_expires_at < NOW()
           AND (oauth_refresh_enc IS NULL OR oauth_refresh_nonce IS NULL)
       )                                                                 AS expired_unrefreshable,
       COUNT(*) FILTER (
         WHERE oauth_expires_at IS NOT NULL
           AND oauth_expires_at >= NOW()
           AND oauth_expires_at < NOW() + INTERVAL '24 hours'
       )                                                                 AS expiring_24h
     FROM claude_accounts`,
  );

  // 今日请求/错误总计 —— usage_records.created_at 走 idx_ur_created_at(0026)
  const u = await query<{ today_requests: string; today_errors: string }>(
    `SELECT
       COUNT(*)                                                   AS today_requests,
       COUNT(*) FILTER (WHERE status != 'success')                AS today_errors
     FROM usage_records
     WHERE created_at > date_trunc('day', NOW())`,
  );

  const p = r.rows[0] ?? {
    total: "0", active: "0", cooldown: "0", disabled: "0", banned: "0",
    expired_refreshable: "0", expired_unrefreshable: "0", expiring_24h: "0",
  };
  const t = u.rows[0] ?? { today_requests: "0", today_errors: "0" };
  return {
    total: Number(p.total),
    active: Number(p.active),
    cooldown: Number(p.cooldown),
    disabled: Number(p.disabled),
    banned: Number(p.banned),
    expired_refreshable: Number(p.expired_refreshable),
    expired_unrefreshable: Number(p.expired_unrefreshable),
    expiring_24h: Number(p.expiring_24h),
    today_requests: Number(t.today_requests),
    today_errors: Number(t.today_errors),
  };
}

export interface AccountTodayStats {
  /** account_id 的 text 形式(BigInt 对齐 API 层 account.id) */
  account_id: string;
  today_requests: number;
  today_errors: number;
}

/**
 * 按 account_id[] scope 拿今日请求/错误。
 *
 * - `ids` ≤ 500,防撑爆 ANY 列表与执行计划。
 * - 未出现在结果里的 account_id = 今日无 usage_records(前端 fallback 0)。
 * - 命中 `idx_ur_account(account_id, created_at DESC)` 做每个账号的分区扫。
 */
export async function getAccountsTodayStats(
  ids: readonly (bigint | string)[],
): Promise<AccountTodayStats[]> {
  if (ids.length === 0) return [];
  if (ids.length > 500) throw new RangeError("too_many_ids");
  const strIds = ids.map((i) => String(i));
  const r = await query<{
    account_id: string;
    today_requests: string;
    today_errors: string;
  }>(
    `SELECT account_id::text                                     AS account_id,
            COUNT(*)                                             AS today_requests,
            COUNT(*) FILTER (WHERE status != 'success')          AS today_errors
     FROM usage_records
     WHERE account_id = ANY($1::bigint[])
       AND created_at > date_trunc('day', NOW())
     GROUP BY account_id`,
    [strIds],
  );
  return r.rows.map((x) => ({
    account_id: x.account_id,
    today_requests: Number(x.today_requests),
    today_errors: Number(x.today_errors),
  }));
}
