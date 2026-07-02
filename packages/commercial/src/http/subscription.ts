/**
 * 0096 — /api/subscription/* HTTP handlers（月度订阅）。
 *
 * 路由：
 *   GET  /api/subscription/plans     公开，列 4 档套餐（landing/账户展示）
 *   GET  /api/subscription/me        需登录，当前订阅 + 双钱包余额明细
 *   POST /api/subscription/subscribe 需登录，购买/续费某档 → 虎皮椒扫码（kind=subscription）
 *   POST /api/subscription/upgrade   需登录，升档（补差价·周期不变）→ 扫码（kind=upgrade）
 *
 * 履约：付款回调走既有 /api/payment/hupi/callback → markOrderPaid 按 kind 分支
 * （grantSubscriptionTx）。订单轮询复用 GET /api/payment/orders/:order_no。
 *
 * 金额/积分一律「分」/积分字符串大数，禁止 Number 化。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "./util.js";
import { requireAuth } from "./auth.js";
import {
  DEFAULT_RATE_LIMITS,
  enforceRateLimit,
  type CommercialHttpDeps,
  type RequestContext,
} from "./handlers.js";
import {
  FREE_PLAN_CODE,
  ensureFreeSubscription,
  getPlan,
  getUserSubscriptionView,
  listSubscriptionPlans,
} from "../billing/subscription.js";
import { getBalanceBreakdown } from "../billing/spend.js";
import { createPackOrder, createSubscriptionOrder } from "../payment/orders.js";
import { HupijiaoError } from "../payment/hupijiao/client.js";

// ─── GET /api/subscription/plans ─────────────────────────────────────────
export async function handleListSubscriptionPlans(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const plans = await listSubscriptionPlans();
  sendJson(res, 200, {
    ok: true,
    data: {
      plans: plans.map((p) => ({
        code: p.code,
        name: p.name,
        price_cents: p.priceCents.toString(),
        monthly_credits: p.monthlyCredits.toString(),
        period_days: p.periodDays,
        tier: p.tier,
      })),
    },
  });
}

// ─── GET /api/subscription/me ────────────────────────────────────────────
export async function handleGetMySubscription(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const view = await getUserSubscriptionView(user.id);
  const bal = await getBalanceBreakdown(user.id);
  sendJson(res, 200, {
    ok: true,
    data: {
      subscription: {
        plan_code: view.planCode,
        plan_name: view.planName,
        status: view.status,
        period_start: view.periodStart,
        period_end: view.periodEnd,
        period_credits: view.periodCredits,
        monthly_credits: view.monthlyCredits,
        price_cents: view.priceCents,
        tier: view.tier,
        paid: view.paid,
      },
      balance: {
        wallet: bal.wallet.toString(),
        period: bal.period.toString(),
        total: bal.total.toString(),
      },
    },
  });
}

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

/** 创建订阅/升档订单 + 调虎皮椒拿二维码，统一回包（与 payment/hupi/create 同形）。 */
async function createOrderAndQr(
  deps: CommercialHttpDeps,
  args: {
    userId: string;
    kind: "subscription" | "upgrade";
    planCode: string;
    fromPlanCode?: string | null;
    amountCents: bigint;
    credits: bigint;
    title: string;
  },
  res: ServerResponse,
): Promise<void> {
  if (!deps.hupijiao) {
    throw new HttpError(503, "PAYMENT_NOT_READY", "hupijiao client is not configured");
  }
  const order = await createSubscriptionOrder({
    userId: args.userId,
    kind: args.kind,
    planCode: args.planCode,
    fromPlanCode: args.fromPlanCode ?? null,
    amountCents: args.amountCents,
    credits: args.credits,
  });
  let qr: { qrcodeUrl: string; mobileUrl: string | null };
  try {
    qr = await deps.hupijiao.createQr({
      orderNo: order.order_no,
      amountCents: order.amount_cents,
      title: args.title,
      attach: `user:${args.userId}`,
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

// ─── POST /api/subscription/subscribe ────────────────────────────────────
export async function handleSubscribe(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const rlCfg = deps.rateLimits?.hupiCreate ?? DEFAULT_RATE_LIMITS.hupiCreate;
  await enforceRateLimit(deps, rlCfg, `user:${user.id}`);

  const planCode = parsePlanCode(await readJsonBody(req));
  const plan = await getPlan(planCode);
  if (!plan || !plan.enabled) throw new HttpError(400, "PLAN_NOT_FOUND", `unknown plan: ${planCode}`);
  if (plan.code === FREE_PLAN_CODE || plan.priceCents <= 0n) {
    throw new HttpError(400, "PLAN_NOT_PURCHASABLE", "免费版无需购买");
  }
  // 服务端拒绝"期内高档买低档":grantSubscriptionTx 的语义是**重置**期内桶+周期重开,
  // pro 用户误点 basic 会静默清掉剩余期内额度并降级(用户吃亏,投诉/退款风险)。
  // 同档=续费放行;升档走 /upgrade(补差价);要降级的等本期结束自动落 free 再买。
  // 只拦"仍在有效期内"的高档(status=active 且 period_end 未过):已到期但 rollover
  // sweeper 尚未把行切回 free 的用户,期内桶本就无可清,买低档是合法诉求,不能误拦。
  const cur = await getUserSubscriptionView(user.id);
  const curStillActive =
    cur.status === "active" && new Date(cur.periodEnd).getTime() > Date.now();
  if (cur.paid && curStillActive && plan.tier < cur.tier) {
    throw new HttpError(
      400,
      "PLAN_DOWNGRADE_BLOCKED",
      `当前套餐(${cur.planName})高于目标套餐,期内购买低档会清空剩余额度。如需更换,请等本期结束后再购买。`,
    );
  }
  // 购买/续费：全价付款，履约时期内桶重置为该档额度 + 周期顺延。
  await createOrderAndQr(
    deps,
    {
      userId: user.id,
      kind: "subscription",
      planCode: plan.code,
      amountCents: plan.priceCents,
      credits: plan.monthlyCredits,
      title: `订阅 ${plan.name}`,
    },
    res,
  );
}

// ─── POST /api/subscription/pack ─────────────────────────────────────────
// 加量包（进期内桶）。v5 专属：按 code 读 pack-50（共享表里 enabled=FALSE，对 v3 隐藏）→ 扫码。
export async function handleBuyPack(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  if (!deps.hupijiao) {
    throw new HttpError(503, "PAYMENT_NOT_READY", "hupijiao client is not configured");
  }
  const rlCfg = deps.rateLimits?.hupiCreate ?? DEFAULT_RATE_LIMITS.hupiCreate;
  await enforceRateLimit(deps, rlCfg, `user:${user.id}`);

  // 有效期内桶承载加量包；先确保有订阅行（履约侧也会就地兜底，但此处提前 bootstrap 更直观）。
  await ensureFreeSubscription(user.id);
  const { order, plan } = await createPackOrder({ userId: user.id });

  let qr: { qrcodeUrl: string; mobileUrl: string | null };
  try {
    qr = await deps.hupijiao.createQr({
      orderNo: order.order_no,
      amountCents: order.amount_cents,
      title: plan.label,
      attach: `user:${user.id}`,
    });
  } catch (e) {
    if (e instanceof HupijiaoError) throw new HttpError(502, e.code, e.message);
    throw e;
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

// ─── POST /api/subscription/upgrade ──────────────────────────────────────
export async function handleUpgrade(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const rlCfg = deps.rateLimits?.hupiCreate ?? DEFAULT_RATE_LIMITS.hupiCreate;
  await enforceRateLimit(deps, rlCfg, `user:${user.id}`);

  const planCode = parsePlanCode(await readJsonBody(req));
  const target = await getPlan(planCode);
  if (!target || !target.enabled) {
    throw new HttpError(400, "PLAN_NOT_FOUND", `unknown plan: ${planCode}`);
  }

  await ensureFreeSubscription(user.id);
  const current = await getUserSubscriptionView(user.id);
  const currentPlan = await getPlan(current.planCode);
  if (!currentPlan) throw new HttpError(500, "PLAN_NOT_FOUND", "current plan missing");

  // 升档只允许：当前为付费档 + 目标 tier 更高。从免费档请走 subscribe（全价·新周期）。
  if (currentPlan.tier <= 0) {
    throw new HttpError(409, "UPGRADE_FROM_FREE", "免费版请直接选择套餐订阅");
  }
  if (target.tier <= currentPlan.tier) {
    throw new HttpError(409, "NOT_AN_UPGRADE", "目标套餐不高于当前套餐，无法升档");
  }
  const diff = target.priceCents - currentPlan.priceCents;
  if (diff <= 0n) {
    throw new HttpError(409, "NO_PRICE_DIFF", "升档差价非正，无法下单");
  }
  // 升档：补差价付款，履约时期内桶补到新档额度（不减少）+ 周期不变。
  // 绑定源档 currentPlan.code：履约时当前订阅必须仍 == 此档，差价才成立（防 stale 低价升级）。
  await createOrderAndQr(
    deps,
    {
      userId: user.id,
      kind: "upgrade",
      planCode: target.code,
      fromPlanCode: currentPlan.code,
      amountCents: diff,
      credits: target.monthlyCredits,
      title: `升档至 ${target.name}`,
    },
    res,
  );
}
