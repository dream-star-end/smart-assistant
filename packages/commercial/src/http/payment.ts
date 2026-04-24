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
  markOrderCanceled,
  countPaidOrdersForUser,
  PlanNotFoundError,
  FirstTopupAlreadyUsedError,
  InvalidOrderStateError,
  OrderNotFoundError,
  OrderCallbackTamperedError,
  type OrderRow,
} from "../payment/orders.js";
import { verifyHupijiao } from "../payment/hupijiao/sign.js";
import type { HupijiaoClient, HupijiaoConfig } from "../payment/hupijiao/client.js";
import { HupijiaoError } from "../payment/hupijiao/client.js";
import { safeEnqueueAlert } from "../admin/alertOutbox.js";
import { EVENTS } from "../admin/alertEvents.js";

/**
 * 告警:单笔充值金额达到此值(分)→ 发 payment.large_topup。
 * 硬编码 200 元(20000 分),二期再接 system_settings。
 */
const LARGE_TOPUP_THRESHOLD_CENTS = 20_000n;

/**
 * 订单刚从 pending → paid 时发 payment.first_topup / payment.large_topup 告警。
 *
 * - fire-and-forget:失败不影响 callback 回 "success"
 * - dedupe 按订单号,重复回调自动 ON CONFLICT DO NOTHING
 * - 在 callback 主流程之外 await(同一 handler 内,但 safeEnqueueAlert 内部已 try/catch)
 */
async function emitPaymentPaidAlerts(order: OrderRow): Promise<void> {
  try {
    const yuan = (Number(order.amount_cents) / 100).toFixed(2);
    // 首充:订单推到 paid 后若该用户 paid 订单数恰好 == 1,即本次为首单。
    try {
      const count = await countPaidOrdersForUser(order.user_id.toString());
      if (count === 1) {
        safeEnqueueAlert({
          event_type: EVENTS.PAYMENT_FIRST_TOPUP,
          severity: "info",
          title: "首次充值",
          body: `用户 #${order.user_id} 完成首次充值 ¥${yuan}(订单 \`${order.order_no}\`)。`,
          payload: {
            user_id: order.user_id.toString(),
            order_no: order.order_no,
            amount_cents: order.amount_cents.toString(),
            credits: order.credits.toString(),
          },
          dedupe_key: `payment.first_topup:user:${order.user_id}`,
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[commercial/payment] first_topup detection failed:", err);
    }
    // 大额:金额 ≥ 阈值 即告警。dedupe by order_no 确保同一订单只发一次。
    if (order.amount_cents >= LARGE_TOPUP_THRESHOLD_CENTS) {
      safeEnqueueAlert({
        event_type: EVENTS.PAYMENT_LARGE_TOPUP,
        severity: "info",
        title: "大额充值",
        body: `用户 #${order.user_id} 单笔充值 ¥${yuan}(订单 \`${order.order_no}\`)。`,
        payload: {
          user_id: order.user_id.toString(),
          order_no: order.order_no,
          amount_cents: order.amount_cents.toString(),
        },
        dedupe_key: `payment.large_topup:${order.order_no}`,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[commercial/payment] emitPaymentPaidAlerts top-level:", err);
  }
}

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
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  // try-auth:有 token 解出来用,无 token / 解析失败一律按未登录处理
  // (不抛 401 —— 这是公开端点)
  let userId: string | null = null;
  try {
    const u = await requireAuth(req, deps.jwtSecret);
    userId = u.id;
  } catch (err) {
    // 2026-04-21 安全审计 Medium#4:此前这个 catch 完全静默,让老用户反馈
    // "首充档没出现"时 server 侧没有任何线索 —— 区分不了"bearer token 过期"
    // (正常)vs "requireAuth 内部异常"(bug)。加一条 debug 日志即可,
    // 公开端点照常放行,不向用户暴露细节。
    userId = null;
    ctx.log.debug("list_plans_auth_skip", {
      reason: err instanceof Error ? err.message : String(err),
    });
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

/**
 * 严格定点十进制解析 total_fee("元" 字符串 → bigint cents)。
 *
 * 只接受 `^\d+(\.\d{1,2})?$`(整数,或整数 + 1-2 位小数)。拒绝:
 *   - 空 / undefined
 *   - 负号(签名校验通常会过,但 "-10" 进 DB 比对是灾难)
 *   - 指数记法 `1e2`(JS Number 会当作 100)
 *   - 千分位 `1,000.00`
 *   - 非数字 `abc`、`NaN`、`Infinity`
 *   - 过度精度 `10.123`(微信 / 支付宝协议最小单位是分)
 *
 * 不用 `Number + Math.round`:浮点 rounding 在 0.29 之类边界会飘。
 */
function parseTotalFeeToCents(raw: string): bigint | null {
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const [intPart, fracPart = ""] = raw.split(".");
  const cents = BigInt(intPart) * 100n + BigInt((fracPart + "00").slice(0, 2));
  return cents;
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
    // 告警:签名校验失败 — 可能被伪造 / 密钥泄露 / 回调打错环境,critical。
    // dedupe 按分钟桶防风暴。
    safeEnqueueAlert({
      event_type: EVENTS.PAYMENT_CALLBACK_SIGNATURE_INVALID,
      severity: "critical",
      title: "虎皮椒回调签名校验失败",
      body: `订单 \`${orderNo}\` 的回调签名校验失败,可能被伪造或密钥泄露。reqId=${ctx.requestId}`,
      payload: { order_no: orderNo, req_id: ctx.requestId },
      dedupe_key: `payment.callback_signature_invalid:${new Date().toISOString().slice(0, 16)}`,
    });
    throw new HttpError(400, "SIGNATURE_INVALID", "hupijiao callback signature mismatch");
  }

  // 2) 状态字段:
  //    - OD = 已支付(推进状态机)
  //    - NF = 未完成(用户取消 / 支付失败 / 支付超时) → pending 推 canceled + 告警
  //    - PN / 其它 = 待支付 / 未知 → 静默 success(不告警,正常流程)
  //    任何分支都回 "success":否则虎皮椒认为回调失败会一直重试
  const statusRaw = pickString(form, "status");
  if (statusRaw === "NF") {
    // eslint-disable-next-line no-console
    console.info(
      `[commercial/payment] callback NF (user side failure/cancel): order=${orderNo} reqId=${ctx.requestId}`,
    );

    // 行为对齐 OD 分支的异常处理:
    //   - DB / tx 抛 → 让 error 冒到 http handler 返 5xx,虎皮椒会重试
    //     (吞掉 + 回 success 会让 transient DB error 下订单永远停在 pending)
    //   - outcome=canceled → 推状态成功,发告警 + success
    //   - outcome=already_*(paid/canceled/expired/refunded)→ 历史订单,不改不告警,success
    //   - outcome=not_found → 对齐 OD 的 ORDER_NOT_FOUND 语义,400 告诉虎皮椒
    //     "这订单不属于本系统,别再重试",避免错环境/错订单 NF 被完全吞掉
    const r = await markOrderCanceled({
      orderNo,
      callbackPayload: { ...form, received_at: new Date().toISOString() },
    });
    if (r.outcome === "not_found") {
      throw new HttpError(400, "ORDER_NOT_FOUND", `unknown order: ${orderNo}`);
    }
    if (r.outcome === "canceled") {
      // 告警:本次把 pending → canceled,代表用户真实放弃/失败。
      // 不看金额,低频但需要人工感知(可能代表 UX/价格/渠道问题)。
      // dedupe_key 绑定 order_no;同一订单 outbox 层 ON CONFLICT DO NOTHING 挡重复入队。
      // markOrderCanceled 本身在 DB 层 FOR UPDATE 幂等(非 pending 不改),
      // 所以即使跨 outbox bucket / cache 失效也不会重复告警。
      safeEnqueueAlert({
        event_type: EVENTS.PAYMENT_FAILED,
        severity: "warning",
        title: "虎皮椒回调:支付失败 / 取消",
        body: `订单 \`${orderNo}\` 虎皮椒回调 status=NF(用户侧支付失败 / 超时 / 取消)。若短时间内同一用户多次出现,排查支付链路或价格/渠道问题。`,
        payload: { order_no: orderNo, status: "NF", req_id: ctx.requestId },
        dedupe_key: `payment.failed:${orderNo}`,
      });
    } else {
      // already_paid / already_canceled / already_expired / already_refunded
      // eslint-disable-next-line no-console
      console.info(
        `[commercial/payment] NF callback ignored (non-pending): order=${orderNo} outcome=${r.outcome} reqId=${ctx.requestId}`,
      );
    }

    sendText(res, 200, "success");
    return;
  }
  if (statusRaw !== "OD") {
    sendText(res, 200, "success");
    return;
  }

  // 3) 推进状态机
  const providerOrder = pickString(form, "transaction_id");
  // 回调字段纵深防御校验(M22 fail-closed)
  // ─────────────────────────────────────────────────────────────────
  // 设计前提就是"不信签名那一层":如果走到这里 = 签名已过,但我们仍要
  // 防 appSecret 泄露 / hupijiao 签名算法瑕疵 / 攻击者重签。fail-open
  // 版本(老逻辑)只要 callback 不带 total_fee 就跳校验 = 直接打通攻击。
  //
  // - total_fee:严格定点十进制 `^\d+(\.\d{1,2})?$`,拒绝 `1e2` / `abc`
  //   / `10.123`;成功 → bigint cents,失败 → 走 tampered 告警
  // - appid:必须等于配置里的 appId;缺 / 不等 → tampered
  //
  // 缺失 / 非法一律走 OrderCallbackTamperedError 统一告警路径,不传到
  // markOrderPaid(tx 内校验作为"未来新 caller 不走 handler"的第二道防线仍保留)
  const totalFeeRaw = pickString(form, "total_fee");
  const expectedAmountCents = parseTotalFeeToCents(totalFeeRaw);
  const callbackAppid = pickString(form, "appid");
  const refAppid = deps.hupijiaoConfig.appId;

  try {
    // handler 层 fail-closed 前置校验:字段缺 / 格式非法 / appid 不等 → 抛 tampered
    // 同 catch 分支走相同 alert + 400 路径,不进 markOrderPaid 扣积分事务
    if (expectedAmountCents === null) {
      throw new OrderCallbackTamperedError(
        orderNo,
        "amount_cents",
        "<order amount from DB>",
        totalFeeRaw.length === 0 ? "<missing>" : `<invalid:${totalFeeRaw}>`,
      );
    }
    if (callbackAppid.length === 0) {
      throw new OrderCallbackTamperedError(orderNo, "appid", refAppid, "<missing>");
    }
    if (callbackAppid !== refAppid) {
      throw new OrderCallbackTamperedError(orderNo, "appid", refAppid, callbackAppid);
    }

    const r = await markOrderPaid({
      orderNo,
      providerOrder: providerOrder.length > 0 ? providerOrder : null,
      callbackPayload: { ...form, received_at: new Date().toISOString() },
      expectedAmountCents,
      expectedAppid: callbackAppid,
      expectedAppidRef: refAppid,
    });
    if (!r.newlyPaid) {
      // eslint-disable-next-line no-console
      console.info(`[commercial/payment] duplicate callback for paid order ${orderNo}, replied success`);
    } else {
      // 告警:本次刚推到 paid,判定首充 / 大额 —— fire-and-forget,失败不影响 callback 回包
      void emitPaymentPaidAlerts(r.order);
    }
  } catch (err) {
    if (err instanceof OrderNotFoundError) {
      // 订单不存在:可能是回调到了错的环境(生产→测试)。400 告诉虎皮椒不要再重试
      throw new HttpError(400, "ORDER_NOT_FOUND", `unknown order: ${orderNo}`);
    }
    if (err instanceof OrderCallbackTamperedError) {
      // 回调字段与 DB 不匹配 — 签名对得上但金额 / appid 被改,要么 hupijiao 实现有 bug,
      // 要么 appSecret 泄露被攻击者重签。订单保持 pending(下次回调有机会被纠正,
      // 或 15min 后 expire)。critical 告警让人工介入。
      // eslint-disable-next-line no-console
      console.error(
        `[commercial/payment] callback tampered: order=${orderNo} field=${err.field} expected=${err.expected} got=${err.got} reqId=${ctx.requestId}`,
      );
      safeEnqueueAlert({
        event_type: EVENTS.PAYMENT_CALLBACK_TAMPERED,
        severity: "critical",
        title: "虎皮椒回调字段篡改",
        body:
          `订单 \`${orderNo}\` 的回调 ${err.field} 字段与本地订单不匹配 ` +
          `(expected=\`${err.expected}\`, got=\`${err.got}\`)。` +
          `签名验过但关键字段被改,可能是 appSecret 泄露或上游签名 bug,需人工核对。`,
        payload: {
          order_no: orderNo,
          field: err.field,
          expected: err.expected,
          got: err.got,
          req_id: ctx.requestId,
        },
        dedupe_key: `payment.callback_tampered:${orderNo}:${err.field}`,
      });
      const code = err.field === "amount_cents" ? "AMOUNT_MISMATCH" : "APPID_MISMATCH";
      throw new HttpError(400, code, err.message);
    }
    if (err instanceof InvalidOrderStateError) {
      // 已过期 / 已退款 / 已取消 —— 典型是用户超时后才付款 / 管理员已处理
      // 记 warning 让运维看得到,返 "success" 避免虎皮椒一直重试(因为真问题无法自愈)
      // eslint-disable-next-line no-console
      console.warn(
        `[commercial/payment] callback late or conflict: order=${orderNo} current=${err.currentStatus} reqId=${ctx.requestId}`,
      );
      safeEnqueueAlert({
        event_type: EVENTS.PAYMENT_CALLBACK_CONFLICT,
        severity: "critical",
        title: "虎皮椒回调状态冲突",
        body: `订单 \`${orderNo}\` 收到 paid 回调,但本地状态为 \`${err.currentStatus}\`。可能是用户超时付款或管理员已处理,需人工核对。`,
        payload: { order_no: orderNo, current_status: err.currentStatus, req_id: ctx.requestId },
        dedupe_key: `payment.callback_conflict:${orderNo}`,
      });
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
