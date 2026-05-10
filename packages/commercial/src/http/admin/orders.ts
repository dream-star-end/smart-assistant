/**
 * /api/admin/orders — P0-3 订单管理 admin 侧。
 *
 * 三个端点:
 *   GET  /api/admin/orders            list (status/user_id/from/to/cursor 分页)
 *   GET  /api/admin/orders/kpi        KPI(pending_overdue 等运营指标)
 *   GET  /api/admin/orders/:order_no  单订单详情(callback_payload + ledger_id)
 *
 * 鉴权:全部 requireAdmin(只读 JWT-only,不写 audit)。
 *
 * S3 拆分自 http/admin.ts。constants/helpers/serializer/handler 函数体逐字节等价
 * (plan §1.2 + §4.5 mechanical byte-equal gate)。
 *
 * Note: orders.csv 走 ./admin/export.ts(CSV 系列另立),不在本文件。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson } from "../util.js";
import { requireAdmin } from "../../admin/requireAdmin.js";
import {
  listOrders,
  getOrderDetail,
  getOrdersKpi,
  ORDER_STATUSES,
  type OrderRowView,
  type OrderDetailView,
  type OrdersKpiView,
  type OrderStatus,
} from "../../admin/orders.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import {
  parsePositiveInt,
  parseUserId,
  parseIsoTimestamp,
  parseBigintIdParam,
} from "./_shared.js";

const ORDERS_MAX_LIMIT = 200;

function parseOrderStatus(raw: string | null): OrderStatus | undefined {
  if (raw === null || raw === "") return undefined;
  if (!(ORDER_STATUSES as readonly string[]).includes(raw)) {
    throw new HttpError(400, "VALIDATION", "invalid status", {
      issues: [{ path: "status", message: raw }],
    });
  }
  return raw as OrderStatus;
}

// parseBigintIdParam / parseUserId / parseIsoTimestamp 已迁至 ./admin/_shared.ts(plan §3.1)。

function serializeOrderRow(row: OrderRowView): Record<string, unknown> {
  return {
    id: row.id,
    order_no: row.order_no,
    user_id: row.user_id,
    username: row.username,
    provider: row.provider,
    provider_order: row.provider_order,
    amount_cents: row.amount_cents,
    credits: row.credits,
    status: row.status,
    paid_at: row.paid_at?.toISOString() ?? null,
    expires_at: row.expires_at.toISOString(),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function serializeOrderDetail(row: OrderDetailView): Record<string, unknown> {
  return {
    ...serializeOrderRow(row),
    callback_payload: row.callback_payload,
    ledger_id: row.ledger_id,
    refunded_ledger_id: row.refunded_ledger_id,
  };
}

function serializeOrdersKpi(k: OrdersKpiView): Record<string, unknown> {
  return {
    pending_overdue: k.pending_overdue,
    pending_overdue_24h: k.pending_overdue_24h,
    callback_conflicts_24h: k.callback_conflicts_24h,
    paid_24h_count: k.paid_24h_count,
    paid_24h_amount_cents: k.paid_24h_amount_cents,
  };
}

export async function handleAdminListOrders(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const status = parseOrderStatus(url.searchParams.get("status"));
  const userId = parseUserId(url.searchParams.get("user_id"));
  const from = parseIsoTimestamp(url.searchParams.get("from"), "from");
  const to = parseIsoTimestamp(url.searchParams.get("to"), "to");
  const beforeCreatedAt = parseIsoTimestamp(url.searchParams.get("before_created_at"), "before_created_at");
  const beforeId = parseBigintIdParam(url.searchParams.get("before_id"), "before_id");
  const limit = parsePositiveInt(url.searchParams.get("limit"), "limit", ORDERS_MAX_LIMIT);
  const r = await listOrders({
    status,
    user_id: userId,
    from,
    to,
    before_created_at: beforeCreatedAt,
    before_id: beforeId,
    limit,
  });
  sendJson(res, 200, {
    rows: r.rows.map(serializeOrderRow),
    next_before_created_at: r.next_before_created_at,
    next_before_id: r.next_before_id,
  });
}

export async function handleAdminOrdersKpi(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const k = await getOrdersKpi();
  sendJson(res, 200, { kpi: serializeOrdersKpi(k) });
}

export async function handleAdminGetOrder(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const tail = url.pathname.slice("/api/admin/orders/".length);
  // order_no 是 hupijiao 拼出来的字符串;现行实现是 yyyymmdd-uid-uuid 风格,
  // 但 hupijiao 也能传来自定义。这里宽松校验:非空、长度 ≤ 64、ASCII 安全字符。
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(tail)) {
    throw new HttpError(400, "VALIDATION", "invalid order_no", {
      issues: [{ path: "order_no", message: tail }],
    });
  }
  const row = await getOrderDetail(tail);
  if (!row) {
    throw new HttpError(404, "ORDER_NOT_FOUND", "order not found");
  }
  sendJson(res, 200, { order: serializeOrderDetail(row) });
}
