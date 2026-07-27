/**
 * /api/admin/orders — P0-3 订单管理 admin 侧。
 *
 * 四个端点:
 *   GET  /api/admin/orders            list (status/user_id/from/to/cursor 分页)
 *   GET  /api/admin/orders/kpi        KPI(pending_overdue 等运营指标)
 *   GET  /api/admin/orders/:order_no  单订单详情(callback_payload + ledger_id)
 *   POST /api/admin/orders/:order_no/refund 一次性原路退款(top-up only)
 *
 * 鉴权:全部 requireAdmin(只读 JWT-only,不写 audit)。
 *
 * S3 拆分自 http/admin.ts。constants/helpers/serializer/handler 函数体逐字节等价
 * (plan §1.2 + §4.5 mechanical byte-equal gate)。
 *
 * Note: orders.csv 走 ./admin/export.ts(CSV 系列另立),不在本文件。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "../util.js";
import { requireAdmin, requireAdminVerifyDb } from "../../admin/requireAdmin.js";
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
import { HupijiaoError } from "../../payment/hupijiao/client.js";
import {
  applyProviderRefundStatus,
  markRefundChannelUnknown,
  OrderRefundError,
  reserveOrderRefund,
} from "../../payment/refunds.js";
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
    kind: row.kind,
    org_id: row.org_id,
    refund_state: row.refund_state,
    refund_reason: row.refund_reason,
    refund_requested_at: row.refund_requested_at?.toISOString() ?? null,
    refund_hold_ledger_id: row.refund_hold_ledger_id,
    provider_refund_no: row.provider_refund_no,
    refund_payload: row.refund_payload,
    refunded_at: row.refunded_at?.toISOString() ?? null,
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

function parseRefundOrderNo(pathname: string): string {
  const match = pathname.match(/^\/api\/admin\/orders\/([A-Za-z0-9._-]{1,64})\/refund$/);
  if (!match) {
    throw new HttpError(400, "VALIDATION", "invalid refund order path");
  }
  return match[1];
}

function parseRefundReason(body: unknown): string {
  const rawReason =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>).reason
      : undefined;
  const reason =
    typeof rawReason === "string"
      ? rawReason.trim()
      : "";
  if (reason.length < 1 || reason.length > 80) {
    throw new HttpError(400, "VALIDATION", "refund reason must be 1..80 characters", {
      issues: [{ path: "reason", message: "must be 1..80 characters" }],
    });
  }
  return reason;
}

function mapRefundError(err: OrderRefundError): HttpError {
  switch (err.code) {
    case "ORDER_NOT_FOUND":
      return new HttpError(404, err.code, "order not found");
    case "ORDER_REFUND_BALANCE_INSUFFICIENT":
      return new HttpError(
        409,
        err.code,
        "该订单发放的积分已被使用，无法自动原路退款，请人工核对",
      );
    case "ORDER_REFUND_REQUIRES_MANUAL_REVIEW":
      return new HttpError(
        409,
        err.code,
        "该订单类型无法安全自动还原权益，请人工核对",
      );
    default:
      return new HttpError(409, err.code, err.message, {
        issues: err.currentState
          ? [{ path: "refund_state", message: err.currentState }]
          : undefined,
      });
  }
}

/**
 * One-shot only: after reservation, no local path ever sends a second provider
 * POST. Unknown outcomes keep the entitlement hold for manual channel review.
 */
export async function handleAdminRefundOrder(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  if (!deps.hupijiao?.refund) {
    throw new HttpError(503, "PAYMENT_NOT_READY", "hupijiao refund is not configured");
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const orderNo = parseRefundOrderNo(url.pathname);
  const reason = parseRefundReason(await readJsonBody(req, 1024));

  let reserved;
  try {
    reserved = await reserveOrderRefund({
      orderNo,
      reason,
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
  } catch (err) {
    if (err instanceof OrderRefundError) throw mapRefundError(err);
    throw err;
  }

  try {
    const provider = await deps.hupijiao.refund({ orderNo, reason });
    const applied = await applyProviderRefundStatus(provider);
    sendJson(res, applied.outcome === "completed" ? 200 : 202, {
      refund: {
        order_no: orderNo,
        state: applied.state,
        provider_status: provider.status,
        amount_cents: reserved.amountCents.toString(),
        credits_held: reserved.creditsHeld.toString(),
        bucket: reserved.bucket,
      },
    });
  } catch (err) {
    const code = err instanceof HupijiaoError ? err.code : "UPSTREAM_UNKNOWN";
    const applied = await markRefundChannelUnknown(orderNo, code);
    sendJson(res, 202, {
      refund: {
        order_no: orderNo,
        state: applied.state,
        provider_status: null,
        amount_cents: reserved.amountCents.toString(),
        credits_held: reserved.creditsHeld.toString(),
        bucket: reserved.bucket,
      },
    });
  }
}
