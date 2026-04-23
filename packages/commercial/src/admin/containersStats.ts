/**
 * R4 — containers tab 专用 KPI。
 *
 * 统一把 v2 行(subscription_id IS NOT NULL / status 字段)和
 * v3 行(subscription_id IS NULL / state 字段)折算成一个 "lifecycle" 维度:
 *   - v2 running / v3 active       → running
 *   - v2 provisioning              → provisioning
 *   - v2 stopped                   → stopped
 *   - v2 removed / v3 vanished     → gone
 *   - v2 error                     → error
 *
 * 一个导出:
 *   - `getContainersPoolStats()` → 池级 KPI,一次查完给顶部 4 卡用
 *   - 不做 per-row 今日聚合 —— docker stats 太贵,R4 scope 明确跳过
 *
 * 索引依赖:
 *   - idx_ac_state_activity (0012 建, state='active' partial) —— v3 running 分支命中
 *   - agent_containers 总行数 < 几千(每用户 1 个 v2 + 最多 1 个 v3 active),
 *     即便 seq scan 也零压力
 */

import { query } from "../db/queries.js";

export interface ContainersPoolStats {
  total: number;
  running: number;
  provisioning: number;
  stopped: number;
  error: number;
  /** v2 removed + v3 vanished */
  gone: number;
  /** 按 row_kind 分组,便于观察 v2→v3 迁移进度 */
  v2: number;
  v3: number;
  /**
   * 7 天内订阅到期的 v2 行(subscription_status='active' AND end_at < NOW()+7d)。
   * v3 行不绑订阅,不计入。
   */
  expiring_7d: number;
  /**
   * 已有 last_error 非空的容器数 —— 提醒 admin 关注有历史报错的行。
   * 包含 v2/v3 全部。
   */
  with_last_error: number;
}

export async function getContainersPoolStats(): Promise<ContainersPoolStats> {
  // 一条 SQL 多 FILTER 查完主体 KPI,成本 = 1 次 seq scan(表很小)。
  const r = await query<{
    total: string;
    running: string;
    provisioning: string;
    stopped: string;
    error: string;
    gone: string;
    v2: string;
    v3: string;
    with_last_error: string;
  }>(
    `SELECT
       COUNT(*)                                                                                AS total,
       -- running: v2 status='running' OR v3 state='active'
       COUNT(*) FILTER (
         WHERE (subscription_id IS NOT NULL AND status = 'running')
            OR (subscription_id IS NULL     AND state  = 'active')
       )                                                                                        AS running,
       COUNT(*) FILTER (WHERE subscription_id IS NOT NULL AND status = 'provisioning')          AS provisioning,
       COUNT(*) FILTER (WHERE subscription_id IS NOT NULL AND status = 'stopped')               AS stopped,
       COUNT(*) FILTER (WHERE subscription_id IS NOT NULL AND status = 'error')                 AS error,
       -- gone: v2 removed + v3 vanished
       COUNT(*) FILTER (
         WHERE (subscription_id IS NOT NULL AND status = 'removed')
            OR (subscription_id IS NULL     AND state  = 'vanished')
       )                                                                                        AS gone,
       COUNT(*) FILTER (WHERE subscription_id IS NOT NULL)                                      AS v2,
       COUNT(*) FILTER (WHERE subscription_id IS NULL)                                          AS v3,
       COUNT(*) FILTER (WHERE last_error IS NOT NULL AND last_error <> '')                      AS with_last_error
     FROM agent_containers`,
  );

  // 订阅到期计数走 agent_subscriptions 独立查,因为 agent_containers 没存 end_at。
  // 只统计还在用的 v2 容器(status != 'removed')且订阅 active 且 7 天内到期。
  const e = await query<{ expiring_7d: string }>(
    `SELECT COUNT(*) AS expiring_7d
       FROM agent_containers c
       JOIN agent_subscriptions s ON s.id = c.subscription_id
      WHERE c.subscription_id IS NOT NULL
        AND c.status <> 'removed'
        AND s.status = 'active'
        AND s.end_at IS NOT NULL
        AND s.end_at >= NOW()
        AND s.end_at <  NOW() + INTERVAL '7 days'`,
  );

  const p = r.rows[0] ?? {
    total: "0", running: "0", provisioning: "0", stopped: "0", error: "0",
    gone: "0", v2: "0", v3: "0", with_last_error: "0",
  };
  const ex = e.rows[0] ?? { expiring_7d: "0" };
  return {
    total: Number(p.total),
    running: Number(p.running),
    provisioning: Number(p.provisioning),
    stopped: Number(p.stopped),
    error: Number(p.error),
    gone: Number(p.gone),
    v2: Number(p.v2),
    v3: Number(p.v3),
    expiring_7d: Number(ex.expiring_7d),
    with_last_error: Number(p.with_last_error),
  };
}
