/**
 * P0-3 — Admin 订单管理。
 *
 * 现状:orders 表完整(0003_init_payment.sql),admin 没暴露任何视图。
 *       运营查 24h 失败 / pending 超时 / callback 冲突只能直连 PG。
 *
 * 本模块:
 *   - listOrders:分页 + 过滤
 *   - getOrderDetail:含 callback_payload 用于排查
 *   - getOrdersKpi:dashboard 顶部 KPI 卡片(24h 维度)
 *
 * **callback_conflicts_24h 数据源**:不是 orders.callback_payload(它不会落
 * conflict 标志),而是 admin_alert_outbox 中 event_type='payment.callback_conflict'
 * 的事件 — 这是 http/payment.ts:455 把 InvalidOrderStateError 转成 alert 的产物。
 * 用 COUNT(DISTINCT dedupe_key) 还原"出过几个真实冲突订单",而不是
 * "channel × 订单"行数。
 *
 * 复合游标 (created_at, id) 同 feedback,稳定翻页。
 */

import { query } from "../db/queries.js";

// ─── Row types ─────────────────────────────────────────────────────

export interface OrderRowView {
  id: string;
  order_no: string;
  user_id: string;
  username: string | null;
  provider: string;
  provider_order: string | null;
  amount_cents: string;
  credits: string;
  status: "pending" | "paid" | "expired" | "refunded" | "canceled";
  paid_at: Date | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface OrderDetailView extends OrderRowView {
  callback_payload: Record<string, unknown> | null;
  ledger_id: string | null;
  refunded_ledger_id: string | null;
}

const ORDER_LIST_COLS = `
  o.id::text             AS id,
  o.order_no,
  o.user_id::text        AS user_id,
  -- users 表无 username 列;display_name 可空,用 email 兜底
  COALESCE(u.display_name, u.email) AS username,
  o.provider,
  o.provider_order,
  o.amount_cents::text   AS amount_cents,
  o.credits::text        AS credits,
  o.status,
  o.paid_at,
  o.expires_at,
  o.created_at,
  o.updated_at
`;

const ORDER_DETAIL_COLS = `
  ${ORDER_LIST_COLS},
  o.callback_payload,
  o.ledger_id::text         AS ledger_id,
  o.refunded_ledger_id::text AS refunded_ledger_id
`;

// ─── List ──────────────────────────────────────────────────────────

export interface ListOrdersInput {
  status?: OrderRowView["status"];
  user_id?: string;
  // ISO timestamps for range filter on created_at
  from?: string;
  to?: string;
  // Cursor 分页:复合 (created_at, id) 严格小于
  before_created_at?: string;
  before_id?: string;
  limit?: number;
}

export interface ListOrdersResult {
  rows: OrderRowView[];
  next_before_created_at: string | null;
  next_before_id: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function listOrders(input: ListOrdersInput = {}): Promise<ListOrdersResult> {
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const where: string[] = [];
  const params: unknown[] = [];

  if (input.status) {
    params.push(input.status);
    where.push(`o.status = $${params.length}`);
  }
  if (input.user_id) {
    params.push(input.user_id);
    where.push(`o.user_id = $${params.length}::bigint`);
  }
  if (input.from) {
    params.push(input.from);
    where.push(`o.created_at >= $${params.length}::timestamptz`);
  }
  if (input.to) {
    params.push(input.to);
    where.push(`o.created_at <= $${params.length}::timestamptz`);
  }
  if (input.before_created_at && input.before_id) {
    params.push(input.before_created_at);
    const a = `$${params.length}::timestamptz`;
    params.push(input.before_id);
    const b = `$${params.length}::bigint`;
    where.push(`(o.created_at, o.id) < (${a}, ${b})`);
  }

  params.push(limit + 1);
  const limitIdx = params.length;

  const sql = `
    SELECT ${ORDER_LIST_COLS}
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT $${limitIdx}
  `;
  const r = await query<OrderRowView>(sql, params);
  const hasMore = r.rows.length > limit;
  const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
  const last = rows[rows.length - 1];
  return {
    rows,
    next_before_created_at: hasMore && last ? last.created_at.toISOString() : null,
    next_before_id: hasMore && last ? last.id : null,
  };
}

// ─── Detail ────────────────────────────────────────────────────────

export async function getOrderDetail(orderNo: string): Promise<OrderDetailView | null> {
  const r = await query<OrderDetailView>(
    `SELECT ${ORDER_DETAIL_COLS}
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
      WHERE o.order_no = $1`,
    [orderNo],
  );
  return r.rows[0] ?? null;
}

// ─── KPI ───────────────────────────────────────────────────────────

export interface OrdersKpiView {
  // 当前 status='pending' 且 expires_at < NOW() 的总数(不限 24h),典型卡死单
  pending_overdue: number;
  // 过去 24h 创建的、当前 status='pending' 且已过期的(运营关注的"今日卡单")
  pending_overdue_24h: number;
  // 过去 24h 唯一冲突订单数:admin_alert_outbox 里 event_type='payment.callback_conflict'
  // 的 distinct dedupe_key(每个真实订单一个 key)
  callback_conflicts_24h: number;
  // 过去 24h paid 笔数 + 总金额(分)
  paid_24h_count: number;
  paid_24h_amount_cents: string;
}

export async function getOrdersKpi(): Promise<OrdersKpiView> {
  // 一次取四块,各自独立 SQL 简单 / 可读 > 单查
  const [overdue, overdue24, conflict, paid] = await Promise.all([
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM orders
        WHERE status = 'pending' AND expires_at < NOW()`,
    ),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM orders
        WHERE status = 'pending'
          AND expires_at < NOW()
          AND created_at > NOW() - INTERVAL '24 hours'`,
    ),
    query<{ n: string }>(
      `SELECT COUNT(DISTINCT dedupe_key)::text AS n
         FROM admin_alert_outbox
        WHERE event_type = 'payment.callback_conflict'
          AND dedupe_key IS NOT NULL
          AND created_at > NOW() - INTERVAL '24 hours'`,
    ),
    query<{ n: string; amt: string }>(
      `SELECT COUNT(*)::text AS n,
              COALESCE(SUM(amount_cents), 0)::text AS amt
         FROM orders
        WHERE status = 'paid'
          AND paid_at > NOW() - INTERVAL '24 hours'`,
    ),
  ]);
  return {
    pending_overdue: Number(overdue.rows[0].n),
    pending_overdue_24h: Number(overdue24.rows[0].n),
    callback_conflicts_24h: Number(conflict.rows[0].n),
    paid_24h_count: Number(paid.rows[0].n),
    paid_24h_amount_cents: paid.rows[0].amt,
  };
}
