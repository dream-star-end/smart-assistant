/**
 * `/api/org/*` 计费路由(批次 B — 方案 §3)。
 *
 * 路由(minRole 由分发器 requireOrgRole 统一先跑;org 从 caller membership 推导,
 * 不接受客户端传 org_id,防 IDOR):
 *   POST /api/org/topup   (admin)  → 建 org 充值单 + 虎皮椒二维码(复用个人单同构链路)
 *   GET  /api/org/orders  (admin)  → org 充值单列表(keyset 分页)
 *   GET  /api/org/ledger  (admin)  → org 桶流水(bucket='org_wallet',keyset 分页)
 *   GET  /api/org/balance (member) → orgs.credits 只读
 *
 * 履约走既有虎皮椒回调 handleHupiCallback → markOrderPaid → fulfillOrgTopupTx(org_id 非空分支),
 * 回调入口零改动。金额纵深防御(markOrderPaid expectedAmountCents 比对 order.amount_cents)对
 * org 单同样生效。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import {
  DEFAULT_RATE_LIMITS,
  enforceRateLimit,
  type CommercialHttpDeps,
  type RequestContext,
} from "../handlers.js";
import { createOrgTopupOrder } from "../../payment/orders.js";
import { HupijiaoError } from "../../payment/hupijiao/client.js";
import { listOrgLedger, listOrgOrders, getOrgBalance } from "../../org/orgBilling.js";
import type { OrgRoute, OrgRouteAuth } from "./routeTypes.js";

// ─── 小工具 ────────────────────────────────────────────────────────

/** gated 路由(minRole != null)保证 orgId 非空;fail-closed 兜底防漏配。 */
function requireOrg(auth: OrgRouteAuth): { userId: string; orgId: string } {
  if (auth.orgId === undefined) {
    throw new HttpError(500, "INTERNAL", "missing org auth context");
  }
  return { userId: auth.userId, orgId: auth.orgId };
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** 解析 amount_cents(number 小额 / string 大额),要求正整数。 */
function parseAmountCents(raw: unknown): bigint {
  let v: bigint;
  try {
    if (typeof raw === "number") {
      if (!Number.isInteger(raw)) throw new TypeError("amount_cents must be integer");
      v = BigInt(raw);
    } else if (typeof raw === "string") {
      if (!/^[0-9]+$/.test(raw)) throw new TypeError("amount_cents must be a non-negative integer string");
      v = BigInt(raw);
    } else {
      throw new TypeError("amount_cents is required");
    }
  } catch (err) {
    throw new HttpError(400, "VALIDATION", (err as Error).message, {
      issues: [{ path: "amount_cents", message: String(raw) }],
    });
  }
  if (v <= 0n) {
    throw new HttpError(400, "VALIDATION", "amount_cents must be > 0", {
      issues: [{ path: "amount_cents", message: v.toString() }],
    });
  }
  return v;
}

function parseKeyset(url: URL): { limit?: number; cursor?: string } {
  const sp = url.searchParams;
  const out: { limit?: number; cursor?: string } = {};
  const limitRaw = sp.get("limit");
  if (limitRaw !== null && limitRaw !== "") {
    if (!/^[1-9][0-9]{0,3}$/.test(limitRaw)) {
      throw new HttpError(400, "VALIDATION", "invalid limit", { issues: [{ path: "limit", message: limitRaw }] });
    }
    out.limit = Number(limitRaw);
  }
  const cursorRaw = sp.get("cursor");
  if (cursorRaw !== null && cursorRaw !== "") {
    if (!/^[1-9][0-9]{0,19}$/.test(cursorRaw)) {
      throw new HttpError(400, "VALIDATION", "invalid cursor", { issues: [{ path: "cursor", message: cursorRaw }] });
    }
    out.cursor = cursorRaw;
  }
  return out;
}

// ─── POST /api/org/topup(admin)──────────────────────────────────────

async function handleOrgTopup(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { userId, orgId } = requireOrg(auth);
  if (!deps.hupijiao) {
    throw new HttpError(503, "PAYMENT_NOT_READY", "hupijiao client is not configured");
  }
  // 同经办人限流(与个人 hupi/create 同 bucket 语义)。
  const rlCfg = deps.rateLimits?.hupiCreate ?? DEFAULT_RATE_LIMITS.hupiCreate;
  await enforceRateLimit(deps, rlCfg, `user:${userId}`);

  const b = asObject(await readJsonBody(req));
  const amountCents = parseAmountCents(b.amount_cents);

  let order;
  try {
    order = await createOrgTopupOrder({ orgId, operatorUserId: userId, amountCents });
  } catch (err) {
    if (err instanceof TypeError) throw new HttpError(400, "VALIDATION", err.message);
    throw err;
  }

  const yuan = (Number(order.amount_cents) / 100).toFixed(2);
  let qr: { qrcodeUrl: string; mobileUrl: string | null };
  try {
    qr = await deps.hupijiao.createQr({
      orderNo: order.order_no,
      amountCents: order.amount_cents,
      title: `组织钱包充值 ¥${yuan}`,
      attach: `org:${orgId}:by:${userId}`,
    });
  } catch (err) {
    if (err instanceof HupijiaoError) throw new HttpError(502, err.code, err.message);
    throw err;
  }

  sendJson(res, 200, {
    ok: true,
    data: {
      order_no: order.order_no,
      qrcode_url: qr.qrcodeUrl,
      mobile_url: qr.mobileUrl,
      amount_cents: order.amount_cents.toString(),
      credits: order.credits.toString(),
      expires_at: order.expires_at.toISOString(),
    },
  });
}

// ─── GET /api/org/orders(admin)──────────────────────────────────────

async function handleOrgOrders(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { orgId } = requireOrg(auth);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const page = await listOrgOrders(orgId, parseKeyset(url));
  sendJson(res, 200, {
    orders: page.rows.map((o) => ({
      id: o.id,
      order_no: o.order_no,
      user_id: o.user_id, // 经办人
      amount_cents: o.amount_cents,
      credits: o.credits,
      status: o.status,
      kind: o.kind,
      paid_at: o.paid_at instanceof Date ? o.paid_at.toISOString() : o.paid_at,
      expires_at: o.expires_at instanceof Date ? o.expires_at.toISOString() : o.expires_at,
      created_at: o.created_at instanceof Date ? o.created_at.toISOString() : o.created_at,
    })),
    next_cursor: page.next_cursor,
  });
}

// ─── GET /api/org/ledger(admin)──────────────────────────────────────

async function handleOrgLedger(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { orgId } = requireOrg(auth);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const page = await listOrgLedger(orgId, parseKeyset(url));
  sendJson(res, 200, {
    ledger: page.rows.map((l) => ({
      id: l.id,
      user_id: l.user_id, // 经办/消费成员
      delta: l.delta,
      balance_after: l.balance_after,
      reason: l.reason,
      ref_type: l.ref_type,
      ref_id: l.ref_id,
      memo: l.memo,
      created_at: l.created_at instanceof Date ? l.created_at.toISOString() : l.created_at,
    })),
    next_cursor: page.next_cursor,
  });
}

// ─── GET /api/org/balance(member)────────────────────────────────────

async function handleOrgBalance(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { orgId } = requireOrg(auth);
  const balance = await getOrgBalance(orgId);
  if (balance === null) throw new HttpError(404, "NOT_FOUND", "org not found");
  sendJson(res, 200, { balance: balance.toString() });
}

// ─── 路由表 ────────────────────────────────────────────────────────

export const billingRoutes: OrgRoute[] = [
  { method: "POST", pattern: "/api/org/topup", minRole: "admin", handler: handleOrgTopup },
  { method: "GET", pattern: "/api/org/orders", minRole: "admin", handler: handleOrgOrders },
  { method: "GET", pattern: "/api/org/ledger", minRole: "admin", handler: handleOrgLedger },
  { method: "GET", pattern: "/api/org/balance", minRole: "member", handler: handleOrgBalance },
];
