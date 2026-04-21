/**
 * T-24 — /api/payment/* HTTP handlers。
 *
 * 路由:
 *   GET  /api/payment/plans                公开(未登录可见)
 *   POST /api/payment/hupi/create          需登录 + 限流
 *   POST /api/payment/hupi/callback        虎皮椒服务器回调,不走 authn,只校签名
 *   GET  /api/payment/orders/:order_no     需登录(只看自己的)
 *
 * 错误映射:
 *   - PLAN_NOT_FOUND      → 400
 *   - UPSTREAM_*          → 502(虎皮椒调用失败)
 *   - INVALID_ORDER_STATE → 409(已过期/已退款订单收到回调,记日志但不当 success)
 *   - 签名不匹配          → 400 SIGNATURE_INVALID(text body 未校验,回 json 即可)
 *   - 缺字段              → 400 VALIDATION
 *   - 订单不存在          → 404 ORDER_NOT_FOUND
 *
 * 安全注意(05-SEC §11):
 *   - callback payload 完整 JSON 存 orders.callback_payload,留证(含金额、transaction_id)
 *   - 签名匹配才信任 payload;签名错误不可回 "success"(否则虎皮椒会停止重试,丢单)
 *   - PLAN/AMOUNT 以本地 DB 为准,不信任回调里的 total_fee(避免上游伪造低金额高积分)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HttpError,
  readJsonBody,
  readFormBody,
  sendJson,
  sendText,
} from "./util.js";
import { requireAuth } from "./auth.js";
import { DEFAULT_RATE_LIMITS, enforceRateLimit, type CommercialHttpDeps, type RequestContext } from "./handlers.js";
import {
  listPlans,
  createPendingOrder,
  getOrderByNo,
  markOrderPaid,
  PlanNotFoundError,
  FirstTopupAlreadyUsedError,
  InvalidOrderStateError,
  OrderNotFoundError,
  type OrderRow,
} from "../payment/orders.js";
import { verifyHupijiao } from "../payment/hupijiao/sign.js";
import type { HupijiaoClient, HupijiaoConfig } from "../payment/hupijiao/client.js";
import { HupijiaoError } from "../payment/hupijiao/client.js";

/** 订单对外视图(不暴露 user_id / callback_payload / ledger_id 等敏感字段)。 */
function orderToPublicView(o: OrderRow): Record<string, unknown> {
  return {
    order_no: o.order_no,
    status: o.status,
    amount_cents: o.amount_cents.toString(),
    credits: o.credits.toString(),
    expires_at: o.expires_at.toISOString(),
    paid_at: o.paid_at ? o.paid_at.toISOString() : null,
    created_at: o.created_at.toISOString(),
    provider: o.provider,
  };
}

// ─── GET /api/payment/plans ───────────────────────────────────────────

/**
 * 公开端点 —— 未登录也能看(冷访客在 landing page 浏览套餐)。
 * 但若 Authorization 头有效,则按用户身份过滤(老用户拿不到 plan-10 首充档)。
 */
export async function handleListPlans(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  // try-auth:有 token 解出来用,无 token / 解析失败一律按未登录处理
  // (不抛 401 —— 这是公开端点)
  let userId: string | null = null;
  try {
    const u = await requireAuth(req, deps.jwtSecret);
    userId = u.id;
  } catch {
    userId = null;
  }
  const plans = await listPlans({ userId });
  sendJson(res, 200, {
    ok: true,
    data: {
      plans: plans.map((p) => ({
        code: p.code,
        label: p.label,
        amount_cents: p.amount_cents.toString(),
        credits: p.credits.toString(),
      })),
    },
  });
}

// ─── POST /api/payment/hupi/create ────────────────────────────────────

function parsePlanCode(body: unknown): string {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "VALIDATION", "body must be JSON object");
  }
  const raw = (body as Record<string, unknown>).plan_code;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) {
    throw new HttpError(400, "VALIDATION", "plan_code is required (1..64 chars)");
  }
  return raw;
}

export async function handleCreateHupi(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  if (!deps.hupijiao) {
    throw new HttpError(503, "PAYMENT_NOT_READY", "hupijiao client is not configured");
  }
  // 04-API §8:同用户 10 次/1h
  const rlCfg = deps.rateLimits?.hupiCreate ?? DEFAULT_RATE_LIMITS.hupiCreate;
  await enforceRateLimit(deps, rlCfg, `user:${user.id}`);

  const body = await readJsonBody(req);
  const planCode = parsePlanCode(body);

  let created: { order: OrderRow; plan: { label: string; amount_cents: bigint; credits: bigint } };
  try {
    created = await createPendingOrder({ userId: user.id, planCode });
  } catch (err) {
    if (err instanceof PlanNotFoundError) {
      throw new HttpError(400, "PLAN_NOT_FOUND", err.message);
    }
    if (err instanceof FirstTopupAlreadyUsedError) {
      // 老用户(已有 paid 订单)企图再次买 plan-10 首充档
      throw new HttpError(409, "FIRST_TOPUP_USED", "新用户首充已用过,请选择其它充值方案");
    }
    throw err;
  }
  const { order, plan } = created;

  // 调虎皮椒拿 qrcode_url。失败时订单留 pending —— 15min 后 expire 扫掉
  let qr: { qrcodeUrl: string; mobileUrl: string | null; providerOrder?: string | null };
  try {
    qr = await deps.hupijiao.createQr({
      orderNo: order.order_no,
      amountCents: order.amount_cents,
      title: plan.label,
      attach: `user:${user.id}`,
    });
  } catch (err) {
    if (err instanceof HupijiaoError) {
      throw new HttpError(502, err.code, err.message);
    }
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

// ─── POST /api/payment/hupi/callback ─────────────────────────────────
// 虎皮椒服务器 → 我们。无 Authorization 头,只有表单 + hash。
// 任何错误都不能回 "success"(否则虎皮椒不会再重试)。

/** callback 字段最小校验。 */
function pickString(form: Record<string, string>, key: string): string {
  const v = form[key];
  return typeof v === "string" ? v : "";
}

export async function handleHupiCallback(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  if (!deps.hupijiaoConfig) {
    // 未配置:直接 503。虎皮椒会重试,运维看到 log 知道要配 secret
    throw new HttpError(503, "PAYMENT_NOT_READY", "hupijiao secret not configured");
  }
  const form = await readFormBody(req);
  const orderNo = pickString(form, "trade_order_id");
  if (orderNo.length === 0) {
    throw new HttpError(400, "VALIDATION", "trade_order_id is required");
  }

  // 1) 校验签名 —— 不匹配 → 400,不进入 DB
  const ok = verifyHupijiao(form, deps.hupijiaoConfig.appSecret);
  if (!ok) {
    // eslint-disable-next-line no-console
    console.warn(`[commercial/payment] signature invalid for order ${orderNo} reqId=${ctx.requestId}`);
    throw new HttpError(400, "SIGNATURE_INVALID", "hupijiao callback signature mismatch");
  }

  // 2) 状态字段:status=OD(虎皮椒订单已支付);其他(PN=待支付, NF=未完成)忽略不推进
  //    但仍返 "success":否则虎皮椒认为回调失败会一直重试
  const statusRaw = pickString(form, "status");
  if (statusRaw !== "OD") {
    sendText(res, 200, "success");
    return;
  }

  // 3) 推进状态机
  const providerOrder = pickString(form, "transaction_id");
  try {
    const r = await markOrderPaid({
      orderNo,
      providerOrder: providerOrder.length > 0 ? providerOrder : null,
      callbackPayload: { ...form, received_at: new Date().toISOString() },
    });
    if (!r.newlyPaid) {
      // eslint-disable-next-line no-console
      console.info(`[commercial/payment] duplicate callback for paid order ${orderNo}, replied success`);
    }
  } catch (err) {
    if (err instanceof OrderNotFoundError) {
      // 订单不存在:可能是回调到了错的环境(生产→测试)。400 告诉虎皮椒不要再重试
      throw new HttpError(400, "ORDER_NOT_FOUND", `unknown order: ${orderNo}`);
    }
    if (err instanceof InvalidOrderStateError) {
      // 已过期 / 已退款 / 已取消 —— 典型是用户超时后才付款 / 管理员已处理
      // 记 warning 让运维看得到,返 "success" 避免虎皮椒一直重试(因为真问题无法自愈)
      // eslint-disable-next-line no-console
      console.warn(
        `[commercial/payment] callback late or conflict: order=${orderNo} current=${err.currentStatus} reqId=${ctx.requestId}`,
      );
      sendText(res, 200, "success");
      return;
    }
    throw err;
  }

  sendText(res, 200, "success");
}

// ─── GET /api/payment/orders/:order_no ───────────────────────────────

export async function handleGetOrder(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const orderNo = extractOrderNoFromUrl(req.url ?? "/");
  if (!orderNo) throw new HttpError(400, "VALIDATION", "order_no is required");

  const order = await getOrderByNo(orderNo, { userId: user.id });
  if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", `order not found: ${orderNo}`);
  void ctx;
  sendJson(res, 200, { ok: true, data: orderToPublicView(order) });
}

/**
 * 从 URL 中抽 order_no 段。仅容器下游使用,简单字符白名单避免注入。
 * 匹配 `/api/payment/orders/<segment>`;多余 path 拒绝。
 */
const ORDER_NO_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export function extractOrderNoFromUrl(rawUrl: string): string | null {
  let pathname: string;
  try {
    // 给 URL 一个 base,仅为了解析 pathname
    pathname = new URL(rawUrl, "http://x.invalid").pathname;
  } catch {
    return null;
  }
  const prefix = "/api/payment/orders/";
  if (!pathname.startsWith(prefix)) return null;
  const seg = pathname.slice(prefix.length);
  if (seg.includes("/")) return null;
  if (!ORDER_NO_PATTERN.test(seg)) return null;
  return seg;
}

// ─── deps 扩展 —— 虎皮椒相关注入由 index.ts / 测试装配 ──────────────

export interface PaymentDeps {
  hupijiao?: HupijiaoClient;
  hupijiaoConfig?: Pick<HupijiaoConfig, "appSecret" | "appId">;
}
