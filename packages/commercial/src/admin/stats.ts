/**
 * Admin 总览聚合查询。
 *
 * dashboard tab 用,所有查询都是"只读 + SUM/COUNT/GROUP BY",直接落 SQL
 * 不走 ORM。每个函数独立,前端并行拉。
 *
 * **安全**:
 *  - window/days/hours 参数全部在 caller 侧 clamp 到合理上限(防扫全表)
 *  - 所有 SQL 参数化,没有动态拼接
 *  - 结果用 `bigint → string` 序列化(Claude 余额字段是 bigint cents)
 *
 * **性能**:
 *  - usage_records / credit_ledger / orders 都按 created_at / paid_at 有索引
 *  - 聚合在 PG 内做,不把明细传到 Node
 *  - 查询 now() 锚点:同一 handler 多条 SQL 尽量共用 now()(按需)
 */

import { query } from "../db/queries.js";
import { listComputeHostsForAdmin } from "./computeHosts.js";

// ─── DAU / WAU / MAU ──────────────────────────────────────────────────

export type ActivityWindow = "24h" | "7d" | "30d";

export interface ActivityStatsResult {
  window: ActivityWindow;
  /** 窗口内有 usage_records 的独立 user 数 */
  active_users: number;
  /** 窗口内的登录/下单用户数(从 refresh_tokens.created_at 推) */
  returning_users: number;
  /** 窗口内新注册用户数 */
  new_users: number;
  /** 付费用户数(窗口内有 delta>0 的 topup) */
  paying_users: number;
}

/** 活跃度统计。一次查出 4 个 distinct 用户数。 */
export async function getActivityStats(window: ActivityWindow): Promise<ActivityStatsResult> {
  const hours = WINDOW_HOURS[window];
  const r = await query<{
    active_users: string;
    returning_users: string;
    new_users: string;
    paying_users: string;
  }>(
    `SELECT
       (SELECT COUNT(DISTINCT user_id) FROM usage_records
          WHERE created_at > NOW() - $1::int * INTERVAL '1 hour') AS active_users,
       (SELECT COUNT(DISTINCT user_id) FROM refresh_tokens
          WHERE created_at > NOW() - $1::int * INTERVAL '1 hour'
            AND revoked_at IS NULL) AS returning_users,
       (SELECT COUNT(*) FROM users
          WHERE created_at > NOW() - $1::int * INTERVAL '1 hour'
            AND status != 'deleted'
            AND deleted_at IS NULL) AS new_users,
       (SELECT COUNT(DISTINCT user_id) FROM credit_ledger
          WHERE created_at > NOW() - $1::int * INTERVAL '1 hour'
            AND reason = 'topup'
            AND delta > 0) AS paying_users`,
    [hours],
  );
  const row = r.rows[0] ?? {
    active_users: "0",
    returning_users: "0",
    new_users: "0",
    paying_users: "0",
  };
  return {
    window,
    active_users: Number(row.active_users),
    returning_users: Number(row.returning_users),
    new_users: Number(row.new_users),
    paying_users: Number(row.paying_users),
  };
}

/** 白名单窗口 → 小时数(参数化到 `$1::int * INTERVAL '1 hour'`)。 */
const WINDOW_HOURS: Record<ActivityWindow, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

// ─── 营收趋势(按天) ─────────────────────────────────────────────────

export interface RevenueByDayRow {
  /** ISO 日期(`YYYY-MM-DD`,Asia/Shanghai 当天) */
  day: string;
  /** 当日付清订单金额总和(cents) */
  paid_amount_cents: string;
  /** 当日新购订阅数(agent_subscription 正 delta 条数) */
  new_subscriptions: number;
  /** 当日付费笔数 */
  orders_paid: number;
}

/**
 * 最近 N 天营收。N clamp 到 [1, 90]。
 * 返回 exactly N 个 bucket:今天(含) + 前 N-1 天。
 *
 * **P1-6 时区**:全部按 Asia/Shanghai 截取。`paid_at` 是 `timestamptz`,
 * `paid_at AT TIME ZONE 'Asia/Shanghai'` 返回 `timestamp without time zone`(把
 * 那一瞬解释到 +08:00 的墙上时钟),`date_trunc('day', ...)` 即得 +08:00 当天 00:00。
 * `days` CTE 同样用 `NOW() AT TIME ZONE 'Asia/Shanghai'` → naive timestamp,JOIN 类型
 * 对齐。WHERE 过滤把第一个 bucket 起点(naive)用 `AT TIME ZONE 'Asia/Shanghai'`
 * 转回 `timestamptz`(+08:00 那一瞬的 UTC instant),与 `paid_at` 类型一致。
 */
export async function getRevenueByDay(days = 14): Promise<RevenueByDayRow[]> {
  const d = Math.min(90, Math.max(1, Math.floor(days)));
  const r = await query<{
    day: string;
    paid_amount_cents: string | null;
    orders_paid: string;
    new_subscriptions: string;
  }>(
    `WITH days AS (
       SELECT generate_series(
         date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') - ($1::int - 1) * INTERVAL '1 day',
         date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai'),
         INTERVAL '1 day'
       ) AS day
     ),
     orders_agg AS (
       SELECT date_trunc('day', paid_at AT TIME ZONE 'Asia/Shanghai') AS day,
              SUM(amount_cents) AS paid_amount_cents,
              COUNT(*) AS orders_paid
       FROM orders
       WHERE status = 'paid'
         AND paid_at >= ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') - ($1::int - 1) * INTERVAL '1 day') AT TIME ZONE 'Asia/Shanghai')
       GROUP BY 1
     ),
     subs_agg AS (
       -- 按 agent_subscriptions.created_at 统计新订阅行数。Agent 订阅不走
       -- credit_ledger delta 扣费(subscription 表本身是来源),统计"行数"等价
       -- 于"该日新购"。status = active/canceled/... 不影响"新购"数据,不过滤。
       SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai') AS day,
              COUNT(*) AS new_subscriptions
       FROM agent_subscriptions
       WHERE created_at >= ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') - ($1::int - 1) * INTERVAL '1 day') AT TIME ZONE 'Asia/Shanghai')
       GROUP BY 1
     )
     SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
            COALESCE(orders_agg.paid_amount_cents, 0)::text AS paid_amount_cents,
            COALESCE(orders_agg.orders_paid, 0)::text AS orders_paid,
            COALESCE(subs_agg.new_subscriptions, 0)::text AS new_subscriptions
     FROM days
     LEFT JOIN orders_agg ON orders_agg.day = days.day
     LEFT JOIN subs_agg   ON subs_agg.day   = days.day
     ORDER BY days.day ASC`,
    [d],
  );
  return r.rows.map((x) => ({
    day: x.day,
    paid_amount_cents: x.paid_amount_cents ?? "0",
    orders_paid: Number(x.orders_paid),
    new_subscriptions: Number(x.new_subscriptions),
  }));
}

// ─── 注册趋势(按天) ─────────────────────────────────────────────────
//
// Phase C(admin 新用户跟踪):dashboard 注册量日折线。语义边界完全 mirror
// getRevenueByDay —— Asia/Shanghai 自然日,exactly N 个 bucket(今天 + 前 N-1 天)。
//
// `verified` 是当前状态视角:cohort 中 email_verified=TRUE 的人数,会随时间
// 单调上升(用户后续验证邮箱也会落入历史 bucket)。schema 没存 email_verified_at
// 所以无法做"该日产生的验证事件"语义,这是已知 trade-off。

export interface SignupsByDayRow {
  /** ISO 日期(`YYYY-MM-DD`,Asia/Shanghai 当天) */
  day: string;
  /** 当日新注册人数(deleted_at IS NULL) */
  signups: number;
  /** 当日注册并已验证邮箱人数(cohort 当前状态) */
  verified: number;
}

/**
 * 最近 N 天注册量。N clamp 到 [1, 90],与 getRevenueByDay 一致。
 *
 * 索引依赖:users 表当前 <100k seq scan 可接受(usersStats.ts 既有结论);若
 * 长期超过该规模,补 `users(created_at DESC) WHERE deleted_at IS NULL`。
 */
export async function getSignupsByDay(days = 14): Promise<SignupsByDayRow[]> {
  const d = Math.min(90, Math.max(1, Math.floor(days)));
  const r = await query<{
    day: string;
    signups: string;
    verified: string;
  }>(
    `WITH days AS (
       SELECT generate_series(
         date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') - ($1::int - 1) * INTERVAL '1 day',
         date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai'),
         INTERVAL '1 day'
       ) AS day
     ),
     signups_agg AS (
       SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai') AS day,
              COUNT(*)                                AS signups,
              COUNT(*) FILTER (WHERE email_verified)  AS verified
       FROM users
       WHERE deleted_at IS NULL
         AND created_at >= ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') - ($1::int - 1) * INTERVAL '1 day') AT TIME ZONE 'Asia/Shanghai')
       GROUP BY 1
     )
     SELECT to_char(days.day, 'YYYY-MM-DD')              AS day,
            COALESCE(signups_agg.signups,  0)::text       AS signups,
            COALESCE(signups_agg.verified, 0)::text       AS verified
     FROM days
     LEFT JOIN signups_agg ON signups_agg.day = days.day
     ORDER BY days.day ASC`,
    [d],
  );
  return r.rows.map((x) => ({
    day: x.day,
    signups: Number(x.signups),
    verified: Number(x.verified),
  }));
}

// ─── 请求趋势(按小时) ───────────────────────────────────────────────

export interface RequestSeriesBucket {
  /** ISO "YYYY-MM-DD HH:00" */
  hour: string;
  success: number;
  error: number;
  total: number;
  /** 该小时 distinct user 数 */
  users: number;
  /** 该小时 total tokens (input + output + cache_read + cache_write) */
  tokens: string;
}

/**
 * 最近 N 小时请求趋势(按小时聚合)。N clamp 到 [1, 168](最多 7 天)。
 *
 * status 字段:usage_records.status ∈ {success, billing_failed, error}。
 * success 当成功,billing_failed + error 当 error。
 */
export async function getRequestSeries(hours = 24): Promise<RequestSeriesBucket[]> {
  const h = Math.min(168, Math.max(1, Math.floor(hours)));
  const r = await query<{
    hour: string;
    success: string;
    error: string;
    total: string;
    users: string;
    tokens: string;
  }>(
    // 返回 exactly N 个 bucket:当前小时(含) + 前 N-1 小时。
    // 过滤对齐到第一个 bucket 起点,防止窗口外旧数据泄漏进图表(R1 Codex M1)。
    `WITH hours AS (
       SELECT generate_series(
         date_trunc('hour', NOW() - ($1::int - 1) * INTERVAL '1 hour'),
         date_trunc('hour', NOW()),
         INTERVAL '1 hour'
       ) AS hour
     ),
     agg AS (
       SELECT date_trunc('hour', created_at) AS hour,
              COUNT(*) FILTER (WHERE status = 'success') AS success,
              COUNT(*) FILTER (WHERE status != 'success') AS error,
              COUNT(*) AS total,
              COUNT(DISTINCT user_id) AS users,
              COALESCE(SUM(
                COALESCE(input_tokens,0) + COALESCE(output_tokens,0)
                + COALESCE(cache_read_tokens,0) + COALESCE(cache_write_tokens,0)
              ), 0) AS tokens
       FROM usage_records
       WHERE created_at >= date_trunc('hour', NOW() - ($1::int - 1) * INTERVAL '1 hour')
       GROUP BY 1
     )
     SELECT to_char(hours.hour, 'YYYY-MM-DD HH24:00') AS hour,
            COALESCE(agg.success, 0)::text AS success,
            COALESCE(agg.error,   0)::text AS error,
            COALESCE(agg.total,   0)::text AS total,
            COALESCE(agg.users,   0)::text AS users,
            COALESCE(agg.tokens,  0)::text AS tokens
     FROM hours
     LEFT JOIN agg ON agg.hour = hours.hour
     ORDER BY hours.hour ASC`,
    [h],
  );
  return r.rows.map((x) => ({
    hour: x.hour,
    success: Number(x.success),
    error: Number(x.error),
    total: Number(x.total),
    users: Number(x.users),
    tokens: x.tokens,
  }));
}

// ─── 告警摘要 ─────────────────────────────────────────────────────────

export interface AlertsSummaryResult {
  /** 规则状态:FIRING 数量、最后 firing 时间 */
  rules: {
    firing: number;
    normal: number;
    recent_firing: Array<{
      rule_id: string;
      fired_at: string;
    }>;
  };
  /** outbox 状态分布 */
  outbox: {
    pending: number;
    failed: number;
    sent_24h: number;
    /** 最久未处理 pending 的等待秒数(越大越红) */
    oldest_pending_age_sec: number;
  };
  /** 按 severity 统计过去 24h sent+pending+failed 总数 */
  events_24h_by_severity: {
    critical: number;
    warning: number;
    info: number;
  };
}

export async function getAlertsSummary(): Promise<AlertsSummaryResult> {
  // 规则状态 (schema: firing boolean + last_transition_at)
  const rulesRes = await query<{
    firing: string;
    normal: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE firing = true)  AS firing,
       COUNT(*) FILTER (WHERE firing = false) AS normal
     FROM admin_alert_rule_state`,
  );
  const recentFiringRes = await query<{
    rule_id: string;
    last_transition_at: string;
  }>(
    `SELECT rule_id, last_transition_at
       FROM admin_alert_rule_state
      WHERE firing = true
      ORDER BY last_transition_at DESC NULLS LAST
      LIMIT 5`,
  );

  // outbox 状态
  const outboxRes = await query<{
    pending: string;
    failed: string;
    sent_24h: string;
    oldest_pending_age_sec: string | null;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending') AS pending,
       COUNT(*) FILTER (WHERE status = 'failed')  AS failed,
       COUNT(*) FILTER (WHERE status = 'sent' AND sent_at > NOW() - INTERVAL '24 hours') AS sent_24h,
       COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status = 'pending')))::bigint, 0)::text AS oldest_pending_age_sec
     FROM admin_alert_outbox`,
  );

  // 按 severity 统计 24h 内「已尝试或即将尝试送出」的事件。
  // 排除 suppressed(dedupe 抑制)与 skipped(conditional skip),这两类是流控,
  // 不应被计入"触发了告警"的总数(R1 Codex M5)。
  const sevRes = await query<{
    critical: string;
    warning: string;
    info: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE severity = 'critical') AS critical,
       COUNT(*) FILTER (WHERE severity = 'warning')  AS warning,
       COUNT(*) FILTER (WHERE severity = 'info')     AS info
     FROM admin_alert_outbox
     WHERE created_at > NOW() - INTERVAL '24 hours'
       AND status IN ('pending', 'sent', 'failed')`,
  );

  const r = rulesRes.rows[0] ?? { firing: "0", normal: "0" };
  const o = outboxRes.rows[0] ?? {
    pending: "0", failed: "0", sent_24h: "0", oldest_pending_age_sec: "0",
  };
  const s = sevRes.rows[0] ?? { critical: "0", warning: "0", info: "0" };

  return {
    rules: {
      firing: Number(r.firing),
      normal: Number(r.normal),
      recent_firing: recentFiringRes.rows.map((x) => ({
        rule_id: x.rule_id,
        fired_at: x.last_transition_at,
      })),
    },
    outbox: {
      pending: Number(o.pending),
      failed: Number(o.failed),
      sent_24h: Number(o.sent_24h),
      oldest_pending_age_sec: Number(o.oldest_pending_age_sec ?? 0),
    },
    events_24h_by_severity: {
      critical: Number(s.critical),
      warning: Number(s.warning),
      info: Number(s.info),
    },
  };
}

// ─── 账号池健康 snapshot (dashboard 饼图用) ───────────────────────────

export interface AccountPoolSnapshot {
  total: number;
  active: number;
  cooldown: number;
  disabled: number;
  banned: number;
  /** 平均 health_score */
  avg_health: number;
  /** 今日总请求(走这些账号) */
  today_requests: number;
  /** 今日成功率 (0~1) */
  today_success_rate: number;
}

export async function getAccountPoolSnapshot(): Promise<AccountPoolSnapshot> {
  const poolRes = await query<{
    total: string;
    active: string;
    cooldown: string;
    disabled: string;
    banned: string;
    avg_health: string | null;
  }>(
    // 0098 channel 划分:v3 池快照只统计 v3 权威的行(claude 共享池 + v3 channel
    // 的 codex),v5 codex 行不进本实例口径。
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE status = 'active') AS active,
       COUNT(*) FILTER (WHERE status = 'cooldown') AS cooldown,
       COUNT(*) FILTER (WHERE status = 'disabled') AS disabled,
       COUNT(*) FILTER (WHERE status = 'banned') AS banned,
       AVG(health_score)::text AS avg_health
     FROM claude_accounts
     WHERE NOT (provider = 'codex' AND runtime_channel <> 'v3')`,
  );

  const reqRes = await query<{
    total: string;
    success: string;
  }>(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE status = 'success') AS success
     FROM usage_records
     WHERE created_at > date_trunc('day', NOW())`,
  );

  const p = poolRes.rows[0] ?? {
    total: "0", active: "0", cooldown: "0", disabled: "0", banned: "0", avg_health: null,
  };
  const q = reqRes.rows[0] ?? { total: "0", success: "0" };
  const total = Number(q.total);
  const success = Number(q.success);
  return {
    total: Number(p.total),
    active: Number(p.active),
    cooldown: Number(p.cooldown),
    disabled: Number(p.disabled),
    banned: Number(p.banned),
    avg_health: p.avg_health == null ? 0 : Number(p.avg_health),
    today_requests: total,
    today_success_rate: total > 0 ? success / total : 1,
  };
}

// ─── P2 — Hosts utilization (for dashboard "虚机利用率分布" stacked bar) ───

export interface HostUtilizationItem {
  uuid: string;
  name: string;
  active: number;
  max: number;
  status: string;
}

export interface HostsUtilizationResult {
  /** sum(active_containers) over all hosts */
  used: number;
  /** sum(max_containers) over all hosts */
  capacity: number;
  per_host: HostUtilizationItem[];
}

/**
 * 虚机利用率聚合。复用 `listComputeHostsForAdmin()` —— 已经做了 active 计数 join,
 * 不重复跑 SQL,避免和 hosts tab 出现两套口径。
 *
 * Plan v10 P2 spec:dashboard 顶部 stacked bar,每个 host 一根柱子(active vs free)。
 */
export async function getHostsUtilization(): Promise<HostsUtilizationResult> {
  const hosts = await listComputeHostsForAdmin();
  let used = 0;
  let capacity = 0;
  const per_host: HostUtilizationItem[] = hosts.map((h) => {
    const active = h.active_containers | 0;
    const max = h.max_containers | 0;
    used += active;
    capacity += max;
    return { uuid: h.id, name: h.name, active, max, status: h.status };
  });
  return { used, capacity, per_host };
}

// ─── P2 — Alert events 7d (for dashboard "告警 · 7d 事件分布" stacked bar) ─

export interface AlertEvent7dRow {
  /** "YYYY-MM-DD"(date_trunc('day') + ::date) */
  day: string;
  event_type: string;
  count: number;
}

/**
 * 7 天告警事件分布。
 *
 * SQL `COUNT(*)::int` —— PG int8 在 node-pg 里默认是 string,前端 sum/sort 会
 * 静默错(参考 P1 同模式)。row mapper 也兜底 `Number()`。
 *
 * 走 idx_aao_created_at(created_at DESC) 扫 7 天范围,即使 outbox 涨到 100k+ 也
 * 不会成瓶颈(admin 调用量低 + 7d 窗口小)。
 */
export async function getAlertEvents7d(): Promise<AlertEvent7dRow[]> {
  const r = await query<{ day: Date; event_type: string; count: number }>(
    `SELECT date_trunc('day', created_at)::date AS day,
            event_type,
            COUNT(*)::int AS count
       FROM admin_alert_outbox
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY 1, 2
      ORDER BY 1`,
  );
  return r.rows.map((row) => ({
    // PG date 列被 node-pg 反序列化成 Date(本地时区午夜);toISOString().slice(0,10)
    // 是 UTC 日期,可能与"北京时间所在那天"差一天。但 outbox 用 NOW()(server tz)
    // 和 date_trunc 都在 PG 里,不跨 tz;前端只是 X 轴 label 用,差一天可接受。
    day: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day),
    event_type: row.event_type,
    count: Number(row.count),
  }));
}

// ─── 运营至今累计指标 (lifetime) ───────────────────────────────────────
//
// dashboard 顶部"运营至今"卡片用。语义边界:
//   - 全部"自系统上线以来"累计,无窗口参数
//   - paying_users / orders / revenue 三个口径**全部锚定 orders WHERE status='paid'**
//     (Codex 评审:与既有营收口径一致,避免 credit_ledger reason='topup' 把人工补账
//      / 后台赠送也算成"付费用户")
//   - first_paid_at 取 MIN(paid_at) 作为"运营起点",days_in_operation 据此算
//
// 性能:全表 COUNT/SUM,不带 WHERE。当前规模(usage_records < 100k)可接受。
// 不加 5min cache(boss 商业版用户量小;前端策略上首屏拉一次 + 手动刷新触发,
// 不进 30s 自动轮询,见 admin.js loadDashboardData)。如果未来 usage_records >100k 且
// dashboard 拉 lifetime 出现明显延迟,再考虑加 process-local TTL cache 或物化视图。

export interface LifetimeStatsResult {
  /** 累计注册用户(deleted_at IS NULL AND status != 'deleted')。 */
  total_users: number;
  /** 累计付费用户(DISTINCT user_id FROM orders WHERE status='paid')。 */
  total_paying_users: number;
  /** 累计营收(SUM amount_cents FROM orders WHERE status='paid'),bigint → string。 */
  total_revenue_cents: string;
  /** 累计付费订单数(COUNT FROM orders WHERE status='paid')。 */
  total_orders_paid: number;
  /** 累计请求数(COUNT usage_records),bigint → string。 */
  total_requests: string;
  /** 累计 token(input+output+cache_read+cache_write),bigint → string。 */
  total_tokens: string;
  /** 首单时间(运营起点),ISO 字符串;若从未有付费订单则为 null。 */
  first_paid_at: string | null;
  /** 运营天数:无首单 = 0;当天 = 1;之后按 PG `(now()::date - first_paid::date) + 1` 算。 */
  days_in_operation: number;
}

/**
 * 累计运营指标。
 *
 * 单 SQL,各子查询并联(PG planner 各自命中独立索引):
 *  - users(deleted_at IS NULL)
 *  - orders 上 idx_orders_paid_at(status='paid' 自然走 paid_at 非空过滤;
 *    idx_orders_status 是 status='pending' 的 partial index,这里用不上)
 *  - usage_records 全表 COUNT/SUM(idx_ur_user_time 命中无用,seq scan;
 *    当前规模可接受)
 *
 * days_in_operation 用 PG 端算,且锚定 Asia/Shanghai 业务日(与既有
 * revenue-by-day / signups-by-day 同口径,避免"运营第 X 天"在 server tz 与
 * 中国时间间漂移)。
 */
export async function getLifetimeStats(): Promise<LifetimeStatsResult> {
  const r = await query<{
    total_users: string;
    total_paying_users: string;
    total_revenue_cents: string | null;
    total_orders_paid: string;
    total_requests: string;
    total_tokens: string | null;
    first_paid_at: Date | null;
    days_in_operation: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM users
          WHERE deleted_at IS NULL AND status != 'deleted') AS total_users,
       (SELECT COUNT(DISTINCT user_id) FROM orders
          WHERE status = 'paid') AS total_paying_users,
       (SELECT COALESCE(SUM(amount_cents), 0)::text FROM orders
          WHERE status = 'paid') AS total_revenue_cents,
       (SELECT COUNT(*) FROM orders
          WHERE status = 'paid') AS total_orders_paid,
       (SELECT COUNT(*)::text FROM usage_records) AS total_requests,
       (SELECT COALESCE(SUM(
          COALESCE(input_tokens,0) + COALESCE(output_tokens,0)
          + COALESCE(cache_read_tokens,0) + COALESCE(cache_write_tokens,0)
        ), 0)::text FROM usage_records) AS total_tokens,
       (SELECT MIN(paid_at) FROM orders WHERE status = 'paid') AS first_paid_at,
       (SELECT
          CASE
            WHEN MIN(paid_at) IS NULL THEN '0'
            ELSE (
              (NOW() AT TIME ZONE 'Asia/Shanghai')::date
              - (MIN(paid_at) AT TIME ZONE 'Asia/Shanghai')::date
              + 1
            )::text
          END
        FROM orders WHERE status = 'paid') AS days_in_operation`,
  );
  const row = r.rows[0];
  if (!row) {
    return {
      total_users: 0,
      total_paying_users: 0,
      total_revenue_cents: "0",
      total_orders_paid: 0,
      total_requests: "0",
      total_tokens: "0",
      first_paid_at: null,
      days_in_operation: 0,
    };
  }
  return {
    total_users: Number(row.total_users),
    total_paying_users: Number(row.total_paying_users),
    total_revenue_cents: row.total_revenue_cents ?? "0",
    total_orders_paid: Number(row.total_orders_paid),
    total_requests: row.total_requests,
    total_tokens: row.total_tokens ?? "0",
    first_paid_at: row.first_paid_at ? row.first_paid_at.toISOString() : null,
    days_in_operation: Number(row.days_in_operation),
  };
}
