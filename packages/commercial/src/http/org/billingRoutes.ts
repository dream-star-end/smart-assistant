/**
 * `/api/org/*` 计费路由(批次 B 充值 + 批次 F 席位订阅/加席/自助开通 + 权限收紧)。
 *
 * 路由(minRole 由分发器 requireOrgRole 统一先跑;org 从 caller membership 推导,
 * 不接受客户端传 org_id,防 IDOR):
 *   POST /api/org/topup     (billing) → 建 org 充值单 + 二维码(§14 收紧 + §17.3 财务委派)
 *   POST /api/org/subscribe (billing) → 建 org 订阅/续费单 + 二维码
 *   POST /api/org/seats     (billing) → 建 org 加席单 + 二维码
 *   GET  /api/org/subscription (member) → 当前订阅(档/席位/周期/期内池余额)+ 可购档位
 *   GET  /api/org/orders       (admin)  → org 订单列表(keyset 分页)
 *   GET  /api/org/ledger       (admin)  → org 桶流水(keyset 分页)
 *   GET  /api/org/balance      (member) → orgs.credits 只读
 *   POST /api/org/provision    (null)   → 自助开通(无 org 的普通用户)建开通单 + 二维码
 *   GET  /api/org/plans        (null)   → 列 org 档(创建向导用)
 *
 * 履约走既有虎皮椒回调 → markOrderPaid → fulfillPaidOrderTx(org_id/kind 分支),回调入口零改动。
 * 金额纵深防御(markOrderPaid expectedAmountCents 比对 order.amount_cents)对所有 org 单同样生效。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import {
  DEFAULT_RATE_LIMITS,
  enforceRateLimit,
  type CommercialHttpDeps,
  type RequestContext,
} from "../handlers.js";
import {
  createOrgProvisionOrder,
  createOrgSeatsOrder,
  createOrgSubscriptionOrder,
  createOrgTopupOrder,
  type OrderRow,
} from "../../payment/orders.js";
import { recordQrIssueFailure } from "../../payment/qrIssueFailure.js";
import { HupijiaoError } from "../../payment/hupijiao/client.js";
import { listOrgLedger, listOrgOrders, getOrgBalance } from "../../org/orgBilling.js";
import {
  getOrgSubscription,
  listOrgSubscriptionPlans,
  type OrgSubscriptionPlan,
} from "../../org/orgSubscriptions.js";
import { OrgError } from "../../org/types.js";
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

/** OrgError → HttpError(携带 status/code);TypeError → 400 VALIDATION;其余原样抛。 */
function throwOrg(err: unknown): never {
  if (err instanceof OrgError) throw new HttpError(err.status, err.code, err.message);
  if (err instanceof TypeError) throw new HttpError(400, "VALIDATION", err.message);
  throw err;
}

/** 解析必填非空字符串字段(如 plan_code)。 */
function parseRequiredString(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new HttpError(400, "VALIDATION", `${field} is required`, { issues: [{ path: field, message: "" }] });
  }
  return raw.trim();
}

/** 解析席位数(正整数,number 或数字串)。 */
function parseSeats(raw: unknown): number {
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && /^[1-9][0-9]{0,6}$/.test(raw)) n = Number(raw);
  else n = NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, "VALIDATION", "seats must be a positive integer", {
      issues: [{ path: "seats", message: String(raw) }],
    });
  }
  return n;
}

/** org 套餐档序列化(读面 + 向导公用)。 */
function serializeOrgPlan(p: OrgSubscriptionPlan): Record<string, unknown> {
  return {
    code: p.code,
    name: p.name,
    price_cents: p.priceCents.toString(),
    monthly_credits: p.monthlyCredits.toString(),
    period_days: p.periodDays,
    min_seats: p.minSeats,
    tier: p.tier,
    sort_order: p.sortOrder,
  };
}

/**
 * 已建单 → 虎皮椒二维码 → 统一响应体(topup/subscribe/seats/provision 复用,响应形状一致)。
 * hupijiao 未配置 → 503(调用方应在建单前已挡一次,此处 fail-closed 兜底)。
 */
async function issueOrderQr(
  deps: CommercialHttpDeps,
  order: OrderRow,
  opts: { title: string; attach: string },
): Promise<Record<string, unknown>> {
  if (!deps.hupijiao) {
    throw new HttpError(503, "PAYMENT_NOT_READY", "hupijiao client is not configured");
  }
  let qr: { qrcodeUrl: string; mobileUrl: string | null };
  try {
    qr = await deps.hupijiao.createQr({
      orderNo: order.order_no,
      amountCents: order.amount_cents,
      title: opts.title,
      attach: opts.attach,
    });
  } catch (err) {
    await recordQrIssueFailure(order);
    if (err instanceof HupijiaoError) throw new HttpError(502, err.code, err.message);
    throw err;
  }
  return {
    order_no: order.order_no,
    qrcode_url: qr.qrcodeUrl,
    mobile_url: qr.mobileUrl,
    amount_cents: order.amount_cents.toString(),
    credits: order.credits.toString(),
    expires_at: order.expires_at.toISOString(),
  };
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

/** 同经办人限流(与个人 hupi/create 同 bucket 语义)。建单类端点复用。 */
async function rateLimitPay(deps: CommercialHttpDeps, userKey: string): Promise<void> {
  const rlCfg = deps.rateLimits?.hupiCreate ?? DEFAULT_RATE_LIMITS.hupiCreate;
  await enforceRateLimit(deps, rlCfg, `user:${userKey}`);
}

/** hupijiao 未配置 → 建单前 fail-fast(不留下无法支付的 pending 单)。 */
function requireHupijiao(deps: CommercialHttpDeps): void {
  if (!deps.hupijiao) {
    throw new HttpError(503, "PAYMENT_NOT_READY", "hupijiao client is not configured");
  }
}

// ─── POST /api/org/topup(owner — §14 收紧)────────────────────────────

async function handleOrgTopup(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { userId, orgId } = requireOrg(auth);
  requireHupijiao(deps);
  await rateLimitPay(deps, userId);

  const b = asObject(await readJsonBody(req));
  const amountCents = parseAmountCents(b.amount_cents);

  let order: OrderRow;
  try {
    order = await createOrgTopupOrder({ orgId, operatorUserId: userId, amountCents });
  } catch (err) {
    throwOrg(err);
  }

  const yuan = (Number(order.amount_cents) / 100).toFixed(2);
  const data = await issueOrderQr(deps, order, {
    title: `组织钱包充值 ¥${yuan}`,
    attach: `org:${orgId}:by:${userId}`,
  });
  sendJson(res, 200, { ok: true, data });
}

// ─── POST /api/org/subscribe(owner)──────────────────────────────────

async function handleOrgSubscribe(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { userId, orgId } = requireOrg(auth);
  requireHupijiao(deps);
  await rateLimitPay(deps, userId);

  const b = asObject(await readJsonBody(req));
  const planCode = parseRequiredString(b.plan_code, "plan_code");
  const seats = parseSeats(b.seats);

  let order: OrderRow;
  try {
    order = await createOrgSubscriptionOrder({ orgId, planCode, seats, operatorUserId: userId });
  } catch (err) {
    throwOrg(err);
  }

  const data = await issueOrderQr(deps, order, {
    title: `企业订阅 ${planCode} × ${seats} 席`,
    attach: `org:${orgId}:sub:by:${userId}`,
  });
  sendJson(res, 200, { ok: true, data });
}

// ─── POST /api/org/seats(owner)──────────────────────────────────────

async function handleOrgSeats(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { userId, orgId } = requireOrg(auth);
  requireHupijiao(deps);
  await rateLimitPay(deps, userId);

  const b = asObject(await readJsonBody(req));
  const seats = parseSeats(b.seats);

  let order: OrderRow;
  try {
    order = await createOrgSeatsOrder({ orgId, seats, operatorUserId: userId });
  } catch (err) {
    throwOrg(err);
  }

  const data = await issueOrderQr(deps, order, {
    title: `企业加席 +${seats} 席`,
    attach: `org:${orgId}:seats:by:${userId}`,
  });
  sendJson(res, 200, { ok: true, data });
}

// ─── GET /api/org/subscription(member)───────────────────────────────

async function handleOrgSubscription(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { orgId } = requireOrg(auth);
  const sub = await getOrgSubscription(orgId);
  const plans = await listOrgSubscriptionPlans();
  sendJson(res, 200, {
    subscription: sub
      ? {
          plan_code: sub.planCode,
          seats: sub.seats,
          status: sub.status,
          period_start: sub.periodStart.toISOString(),
          period_end: sub.periodEnd.toISOString(),
          period_credits: sub.periodCredits.toString(),
        }
      : null,
    plans: plans.map(serializeOrgPlan),
  });
}

// ─── POST /api/org/provision(null — 无 org 的普通用户自助开通)────────

async function handleOrgProvision(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  // minRole=null:auth 只有 userId(caller 尚无 org);无 org 校验在 createOrgProvisionOrder 内。
  const userId = auth.userId;
  requireHupijiao(deps);
  await rateLimitPay(deps, userId);

  const b = asObject(await readJsonBody(req));
  const orgName = parseRequiredString(b.org_name, "org_name");
  const planCode = parseRequiredString(b.plan_code, "plan_code");
  const seats = parseSeats(b.seats);

  let order: OrderRow;
  try {
    order = await createOrgProvisionOrder({ userId, orgName, planCode, seats });
  } catch (err) {
    throwOrg(err);
  }

  const data = await issueOrderQr(deps, order, {
    title: `创建企业组织「${orgName}」${planCode} × ${seats} 席`,
    attach: `org_provision:by:${userId}`,
  });
  sendJson(res, 200, { ok: true, data });
}

// ─── GET /api/org/plans(null — 创建向导用)────────────────────────────

async function handleOrgPlans(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  _auth: OrgRouteAuth,
): Promise<void> {
  const plans = await listOrgSubscriptionPlans();
  sendJson(res, 200, { plans: plans.map(serializeOrgPlan) });
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
  // 计费写面:§14 收紧为 owner-only,§17.3 再放开给财务委派 → minRole='billing'
  // (owner ∥ billing_delegate)。topup/subscribe/seats 均计费写面,统一 'billing'。
  { method: "POST", pattern: "/api/org/topup", minRole: "billing", handler: handleOrgTopup },
  { method: "POST", pattern: "/api/org/subscribe", minRole: "billing", handler: handleOrgSubscribe },
  { method: "POST", pattern: "/api/org/seats", minRole: "billing", handler: handleOrgSeats },
  // 读面保持原 minRole 不动。
  { method: "GET", pattern: "/api/org/subscription", minRole: "member", handler: handleOrgSubscription },
  { method: "GET", pattern: "/api/org/orders", minRole: "admin", handler: handleOrgOrders },
  { method: "GET", pattern: "/api/org/ledger", minRole: "admin", handler: handleOrgLedger },
  { method: "GET", pattern: "/api/org/balance", minRole: "member", handler: handleOrgBalance },
  // 自助开通(受邀者外的无 org 普通用户):minRole=null,只 requireAuth,内部校验无 active org。
  { method: "POST", pattern: "/api/org/provision", minRole: null, handler: handleOrgProvision },
  { method: "GET", pattern: "/api/org/plans", minRole: null, handler: handleOrgPlans },
];
