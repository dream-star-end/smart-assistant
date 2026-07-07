/**
 * T-24 — 订单 / 套餐 业务逻辑。
 *
 * 对外暴露的纯 DB 操作:
 *   - listPlans()                       → 所有 enabled topup_plans
 *   - getPlanByCode(code)               → 一档(disabled 也返回,调用方判断)
 *   - generateOrderNo()                 → "YYYYMMDD-<8 hex>"
 *   - createPendingOrder({...})         → INSERT orders status=pending, expires 15min
 *   - getOrderByNo(orderNo, userId?)    → 读一条(user_id 参数用于前端"我的订单")
 *   - markOrderPaid({orderNo, providerOrder, payload})
 *       事务内:若 pending → 状态机推进 + credit + ledger;若 paid → 幂等 true
 *   - expirePendingOrders()             → UPDATE pending & expires_at < now → expired
 *
 * 订单状态机(数据库 CHECK 约束同步):
 *   pending → paid        (正常支付回调)
 *   pending → expired     (15min 无回调,定时任务扫)
 *   pending → canceled    (用户主动取消 / 管理员操作;MVP 不开放)
 *   paid    → refunded    (管理员手工退款;MVP 不开放)
 *
 * 非法跃迁会抛 `InvalidOrderStateError`,保证任何 callback 重放都不会把已付订单打回 pending。
 */

import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { query, tx } from "../db/queries.js";
import {
  applyUpgradeOrRefundTx,
  creditPeriodBucketTx,
  getPlan,
  grantSubscriptionTx,
  type SubscriptionPlan,
} from "../billing/subscription.js";
import { OrgError } from "../org/types.js";
import { getOrgById } from "../org/orgs.js";
import { getActiveMembership } from "../org/memberships.js";
import {
  addOrgSeatsTx,
  getOrgPlan,
  getOrgSubscription,
  grantOrgSubscriptionTx,
} from "../org/orgSubscriptions.js";
import { DEFAULT_ORG_MAX_MEMBERS, fulfillOrgProvisionTx } from "../org/orgProvision.js";

/**
 * 订单种类。topup→钱包；pack→期内桶(加量包)；subscription→订阅/续费(期内桶重置+周期顺延)；
 * upgrade→升档(期内桶补到新档额度+周期不变)。
 *
 * 企业版(0112/0115)对 org 复用既有 kind,不新增歧义种类:
 *   - kind='topup'        + org_id 非空 → org 钱包充值(fulfillOrgTopupTx)
 *   - kind='subscription' + org_id 非空 → org **订阅/续费**(grantOrgSubscriptionTx,重置期内池)
 *   - kind='upgrade'      + org_id 非空 → org **加席**(addOrgSeatsTx,整份即时入池;from_plan_code=NULL)
 *   - kind='org_provision'(org_id 建单时为 NULL)→ 自助开通(履约时建 org+owner+订阅,fulfill 回填 org_id)
 * 选型依据:subscription(重置)与 upgrade(增量)语义在个人版已分立,org 沿用同一语义分区可让
 * fulfill 分支无歧义(重置 vs 加席),避免"单一 kind 混两种履约"的歧义单。见 0115 迁移注释。
 */
export const ORDER_KINDS = ["topup", "pack", "subscription", "upgrade", "org_provision"] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

/** 订单状态的字面量类型。数据库 CHECK 同步。 */
export const ORDER_STATUSES = [
  "pending",
  "paid",
  "expired",
  "refunded",
  "canceled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface TopupPlan {
  id: bigint;
  code: string;
  label: string;
  amount_cents: bigint;
  credits: bigint;
  sort_order: number;
  enabled: boolean;
  /** 0096：true=进 period_credits 期内桶(加量包)；false=进 users.credits 钱包(存量充值)。 */
  period_scoped: boolean;
}

export interface OrderRow {
  id: bigint;
  order_no: string;
  user_id: bigint;
  provider: "hupijiao";
  provider_order: string | null;
  amount_cents: bigint;
  credits: bigint;
  status: OrderStatus;
  /** 0096 订单种类。 */
  kind: OrderKind;
  /** 0096 subscription/upgrade 的目标套餐档（topup/pack 为 null）。 */
  plan_code: string | null;
  /** 0096 upgrade 单的源套餐档快照（履约校验当前订阅仍 == 此档；仅 upgrade 非 null）。 */
  from_plan_code: string | null;
  /**
   * 0112/0115 企业版:org 订单归属。user_id=经办人。
   *   - org 充值/订阅/加席单:建单即落 org_id;
   *   - 自助开通单(kind='org_provision'):建单为 NULL,履约建 org 后回填。
   */
  org_id: bigint | null;
  /** 0115 企业版:自助开通单(kind='org_provision')新建 org 的名称快照;非开通单 null。 */
  org_name: string | null;
  /** 0115 企业版:org 订阅/开通/加席的席位数(subscription/org_provision=总席位;upgrade=加席增量)。 */
  plan_seats: number | null;
  paid_at: Date | null;
  expires_at: Date;
  ledger_id: bigint | null;
  refunded_ledger_id: bigint | null;
  created_at: Date;
  updated_at: Date;
}

export class PlanNotFoundError extends Error {
  readonly code = "PLAN_NOT_FOUND" as const;
  readonly planCode: string;
  constructor(planCode: string) {
    super(`topup plan not found or disabled: ${planCode}`);
    this.name = "PlanNotFoundError";
    this.planCode = planCode;
  }
}

/**
 * 「新用户首充」专用套餐 code。该套餐只允许尚未有任何 paid 订单的用户使用。
 * 入口同时由 `listPlans({ userId })` 过滤(老用户看不见) +
 * `createPendingOrder` 二次校验(老用户即使知道 code 也下不了单)双重把关。
 */
export const FIRST_TOPUP_PLAN_CODE = "plan-10";

export class FirstTopupAlreadyUsedError extends Error {
  readonly code = "FIRST_TOPUP_USED" as const;
  readonly userId: string;
  constructor(userId: string) {
    super(`user ${userId} already has paid orders, plan-10 is first-topup-only`);
    this.name = "FirstTopupAlreadyUsedError";
    this.userId = userId;
  }
}

/** 用户是否有过任何 paid 订单(用于判定「新用户」)。 */
async function userHasAnyPaidOrder(uid: string): Promise<boolean> {
  const r = await query<{ one: number }>(
    `SELECT 1 AS one FROM orders WHERE user_id = $1 AND status = 'paid' LIMIT 1`,
    [uid],
  );
  return r.rowCount !== null && r.rowCount > 0;
}

/** 用户 paid 订单数(告警判定首充 / 大额充值用)。 */
export async function countPaidOrdersForUser(uid: string): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM orders WHERE user_id = $1 AND status = 'paid'`,
    [uid],
  );
  return Number(r.rows[0]?.n ?? 0);
}

export class OrderNotFoundError extends Error {
  readonly code = "ORDER_NOT_FOUND" as const;
  readonly orderNo: string;
  constructor(orderNo: string) {
    super(`order not found: ${orderNo}`);
    this.name = "OrderNotFoundError";
    this.orderNo = orderNo;
  }
}

export class InvalidOrderStateError extends Error {
  readonly code = "INVALID_ORDER_STATE" as const;
  readonly orderNo: string;
  readonly currentStatus: OrderStatus;
  constructor(orderNo: string, currentStatus: OrderStatus) {
    super(`order ${orderNo} is in ${currentStatus}, cannot transition to paid`);
    this.name = "InvalidOrderStateError";
    this.orderNo = orderNo;
    this.currentStatus = currentStatus;
  }
}

/**
 * 回调 payload 中声称的字段与本地订单不匹配 —— 签名验过了但业务字段被篡改。
 * 只在 markOrderPaid 事务入口做纵深防御校验,保证即使 hupijiao 签名算法有瑕疵或
 * appSecret 泄露,攻击者也无法让「100 元订单」只付 1 元进账。
 *
 * field: "amount_cents" 或 "appid" — 区分告警语义
 */
export class OrderCallbackTamperedError extends Error {
  readonly code = "PAYMENT_CALLBACK_TAMPERED" as const;
  readonly orderNo: string;
  readonly field: "amount_cents" | "appid";
  readonly expected: string;
  readonly got: string;
  constructor(
    orderNo: string,
    field: "amount_cents" | "appid",
    expected: string,
    got: string,
  ) {
    super(
      `order ${orderNo} callback ${field} mismatch: expected=${expected} got=${got}`,
    );
    this.name = "OrderCallbackTamperedError";
    this.orderNo = orderNo;
    this.field = field;
    this.expected = expected;
    this.got = got;
  }
}

/** 归一化 user_id,复用 ledger 里同样的宽容策略。 */
function normalizeUserId(userId: bigint | number | string): string {
  if (typeof userId === "bigint") return userId.toString();
  if (typeof userId === "number") {
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new TypeError(`user_id must be positive integer, got ${userId}`);
    }
    return String(userId);
  }
  if (!/^\d+$/.test(userId)) throw new TypeError(`user_id must be decimal digits, got ${userId}`);
  return userId;
}

/**
 * order_no 生成策略:`YYYYMMDD-<8 hex>`(共 17 字符)。
 *
 * 8 hex = 32-bit random → 碰撞概率按每天 1M 订单算也极低;UNIQUE 冲突兜底重试由调用方做
 * (实际 MVP 不会到这个量级,单次生成即可)。
 */
export function generateOrderNo(nowFn: () => Date = () => new Date()): string {
  const now = nowFn();
  const yyyy = now.getUTCFullYear().toString().padStart(4, "0");
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = now.getUTCDate().toString().padStart(2, "0");
  const rand = randomBytes(4).toString("hex");
  return `${yyyy}${mm}${dd}-${rand}`;
}

type PlanDbRow = {
  id: string; code: string; label: string; amount_cents: string; credits: string;
  sort_order: number; enabled: boolean; period_scoped: boolean;
};

const TOPUP_PLAN_COLS =
  `id::text AS id, code, label, amount_cents::text AS amount_cents, credits::text AS credits,
   sort_order, enabled, period_scoped`;

function rowToPlan(r: PlanDbRow): TopupPlan {
  return {
    id: BigInt(r.id),
    code: r.code,
    label: r.label,
    amount_cents: BigInt(r.amount_cents),
    credits: BigInt(r.credits),
    sort_order: r.sort_order,
    enabled: r.enabled,
    period_scoped: r.period_scoped,
  };
}

type OrderDbRow = {
  id: string; order_no: string; user_id: string; provider: "hupijiao";
  provider_order: string | null; amount_cents: string; credits: string;
  status: OrderStatus; kind: string; plan_code: string | null; from_plan_code: string | null;
  org_id: string | null; org_name: string | null; plan_seats: number | null;
  paid_at: Date | null; expires_at: Date;
  ledger_id: string | null; refunded_ledger_id: string | null;
  created_at: Date; updated_at: Date;
};

/** 所有 orders SELECT 复用的列清单（含 0096 kind/plan_code/from_plan_code + 0112 org_id + 0115 org_name/plan_seats）。 */
const ORDER_COLS =
  `id::text AS id, order_no, user_id::text AS user_id, provider,
   provider_order, amount_cents::text AS amount_cents, credits::text AS credits,
   status, kind, plan_code, from_plan_code, org_id::text AS org_id, org_name, plan_seats,
   paid_at, expires_at,
   ledger_id::text AS ledger_id, refunded_ledger_id::text AS refunded_ledger_id,
   created_at, updated_at`;

function rowToOrder(r: OrderDbRow): OrderRow {
  return {
    id: BigInt(r.id),
    order_no: r.order_no,
    user_id: BigInt(r.user_id),
    provider: r.provider,
    provider_order: r.provider_order,
    amount_cents: BigInt(r.amount_cents),
    credits: BigInt(r.credits),
    status: r.status,
    kind: (ORDER_KINDS as ReadonlyArray<string>).includes(r.kind) ? (r.kind as OrderKind) : "topup",
    plan_code: r.plan_code,
    from_plan_code: r.from_plan_code,
    org_id: r.org_id ? BigInt(r.org_id) : null,
    org_name: r.org_name,
    plan_seats: r.plan_seats,
    paid_at: r.paid_at,
    expires_at: r.expires_at,
    ledger_id: r.ledger_id ? BigInt(r.ledger_id) : null,
    refunded_ledger_id: r.refunded_ledger_id ? BigInt(r.refunded_ledger_id) : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export interface ListPlansOptions {
  /**
   * 已认证用户 id。传了之后:
   *   - 若该用户已有 paid 订单 → 过滤掉首充套餐 plan-10
   *   - 否则全量返回(plan-10 仍可见)
   * 不传(冷访客 / 未登录) → 全量返回(让 landing 上能看到首充优惠)
   */
  userId?: bigint | number | string | null;
}

/** 读所有 enabled 套餐,按 sort_order DESC。 */
export async function listPlans(opts: ListPlansOptions = {}): Promise<TopupPlan[]> {
  const r = await query<PlanDbRow>(
    `SELECT ${TOPUP_PLAN_COLS}
       FROM topup_plans
      WHERE enabled = TRUE
      ORDER BY sort_order DESC, id ASC`,
  );
  const all = r.rows.map(rowToPlan);
  if (opts.userId == null) return all;
  const uid = normalizeUserId(opts.userId);
  // 已老用户 → 过滤首充套餐
  if (await userHasAnyPaidOrder(uid)) {
    return all.filter((p) => p.code !== FIRST_TOPUP_PLAN_CODE);
  }
  return all;
}

/** 按 code 读一档(不过滤 enabled);找不到返 null,调用方决定怎么报错。 */
export async function getPlanByCode(code: string): Promise<TopupPlan | null> {
  if (typeof code !== "string" || code.length === 0 || code.length > 64) return null;
  const r = await query<PlanDbRow>(
    `SELECT ${TOPUP_PLAN_COLS} FROM topup_plans WHERE code = $1`,
    [code],
  );
  return r.rows.length === 0 ? null : rowToPlan(r.rows[0]);
}

export interface CreatePendingOrderInput {
  userId: bigint | number | string;
  planCode: string;
  /** TTL 毫秒,默认 15 分钟(F-3.3 规定) */
  ttlMs?: number;
  /** 可注入固定 order_no,测试用 */
  orderNo?: string;
  /** 时间注入,测试用 */
  nowFn?: () => Date;
}

/**
 * 创建订单:校验 plan enabled → generateOrderNo → INSERT pending。
 *
 * 不调用虎皮椒 API;调用方决定 order 创建后再去拿 qrcode_url。
 * 这样即便上游 API 超时,本地 order 也是 pending 状态,可被 expirePending 扫到。
 */
export async function createPendingOrder(
  input: CreatePendingOrderInput,
): Promise<{ order: OrderRow; plan: TopupPlan }> {
  const uid = normalizeUserId(input.userId);
  const plan = await getPlanByCode(input.planCode);
  if (!plan || !plan.enabled) throw new PlanNotFoundError(input.planCode);

  // 首充套餐:必须用户从未有 paid 订单,否则拒
  // 注意:这里只检查 paid 订单,pending 不算 —— 老用户可能并发尝试,
  // 实际能否结算由 markOrderPaid 的状态机收尾。但若已有任何 paid 单,
  // 当前的下单就直接拒,避免后续付款时再退款的扯皮。
  if (plan.code === FIRST_TOPUP_PLAN_CODE) {
    if (await userHasAnyPaidOrder(uid)) {
      throw new FirstTopupAlreadyUsedError(uid);
    }
  }

  const nowFn = input.nowFn ?? (() => new Date());
  const ttlMs = Math.max(1, input.ttlMs ?? 15 * 60 * 1000);
  const expiresAt = new Date(nowFn().getTime() + ttlMs);
  const orderNo = input.orderNo ?? generateOrderNo(nowFn);

  // 0096：加量包(period_scoped)→ kind='pack'(进期内桶)；存量充值 → kind='topup'(进钱包)。
  const kind: OrderKind = plan.period_scoped ? "pack" : "topup";

  const r = await query<OrderDbRow>(
    `INSERT INTO orders
      (order_no, user_id, provider, amount_cents, credits, status, kind, plan_code, expires_at)
     VALUES ($1, $2, 'hupijiao', $3, $4, 'pending', $5, $6, $7)
     RETURNING ${ORDER_COLS}`,
    [orderNo, uid, plan.amount_cents.toString(), plan.credits.toString(), kind, plan.code, expiresAt],
  );
  return { order: rowToOrder(r.rows[0]), plan };
}

export interface CreateSubscriptionOrderInput {
  userId: bigint | number | string;
  /** 'subscription'=购买/续费；'upgrade'=升档（amountCents 应为差价）。 */
  kind: "subscription" | "upgrade";
  /** 目标套餐档 code。 */
  planCode: string;
  /** 升档单的**源套餐档快照**（履约校验当前订阅仍 == 此档；subscription 单传 null）。 */
  fromPlanCode?: string | null;
  /** 本单应付（分）。subscription=档全价；upgrade=新旧档差价。 */
  amountCents: bigint;
  /** 履约发放进期内桶的额度（= 目标档 monthly_credits 快照）。 */
  credits: bigint;
  ttlMs?: number;
  orderNo?: string;
  nowFn?: () => Date;
}

/**
 * 创建订阅/升档订单（pending）。金额/积分由调用方（subscription 端点）依套餐档算好传入，
 * 不复用 topup_plans。履约由 markOrderPaid 按 kind 分支（grantSubscriptionTx）。
 */
export async function createSubscriptionOrder(
  input: CreateSubscriptionOrderInput,
): Promise<OrderRow> {
  const uid = normalizeUserId(input.userId);
  if (input.amountCents <= 0n) throw new TypeError(`amountCents must be > 0, got ${input.amountCents}`);
  if (input.credits < 0n) throw new TypeError(`credits must be >= 0, got ${input.credits}`);
  // 升档单必须带源档快照（履约据此校验当前订阅未被换档/降级）；否则后续调用方会造出
  // 永远走退款的"废升档单"。fail-fast 防误用。
  if (input.kind === "upgrade" && !input.fromPlanCode) {
    throw new TypeError("createSubscriptionOrder: upgrade order requires fromPlanCode");
  }
  const nowFn = input.nowFn ?? (() => new Date());
  const ttlMs = Math.max(1, input.ttlMs ?? 15 * 60 * 1000);
  const expiresAt = new Date(nowFn().getTime() + ttlMs);
  const orderNo = input.orderNo ?? generateOrderNo(nowFn);

  const r = await query<OrderDbRow>(
    `INSERT INTO orders
      (order_no, user_id, provider, amount_cents, credits, status, kind, plan_code, from_plan_code, expires_at)
     VALUES ($1, $2, 'hupijiao', $3, $4, 'pending', $5, $6, $7, $8)
     RETURNING ${ORDER_COLS}`,
    [
      orderNo, uid, input.amountCents.toString(), input.credits.toString(),
      input.kind, input.planCode, input.fromPlanCode ?? null, expiresAt,
    ],
  );
  return rowToOrder(r.rows[0]);
}

/** v5 加量包的 topup_plans code（在共享表里 enabled=FALSE，对 v3 现网隐藏；v5 按 code 读）。 */
export const PACK_PLAN_CODE = "pack-50";

/**
 * 创建加量包订单（v5 专属，进期内桶）。**不走公开 /api/payment/plans**（那是 v3/v5 共享的
 * enabled 列表），而是按 code 直读 pack-50（getPlanByCode 不过滤 enabled），故 pack 在共享表
 * 里 enabled=FALSE 对 v3 现网不可见，v5 仍可下单。要求该 plan period_scoped=TRUE。
 */
export async function createPackOrder(input: {
  userId: bigint | number | string;
  ttlMs?: number;
  orderNo?: string;
  nowFn?: () => Date;
}): Promise<{ order: OrderRow; plan: TopupPlan }> {
  const uid = normalizeUserId(input.userId);
  const plan = await getPlanByCode(PACK_PLAN_CODE);
  if (!plan || !plan.period_scoped) throw new PlanNotFoundError(PACK_PLAN_CODE);

  const nowFn = input.nowFn ?? (() => new Date());
  const ttlMs = Math.max(1, input.ttlMs ?? 15 * 60 * 1000);
  const expiresAt = new Date(nowFn().getTime() + ttlMs);
  const orderNo = input.orderNo ?? generateOrderNo(nowFn);

  const r = await query<OrderDbRow>(
    `INSERT INTO orders
      (order_no, user_id, provider, amount_cents, credits, status, kind, plan_code, expires_at)
     VALUES ($1, $2, 'hupijiao', $3, $4, 'pending', 'pack', $5, $6)
     RETURNING ${ORDER_COLS}`,
    [orderNo, uid, plan.amount_cents.toString(), plan.credits.toString(), plan.code, expiresAt],
  );
  return { order: rowToOrder(r.rows[0]), plan };
}

/** org 充值单金额上限(分):¥100 万,镜像 admin 调额 cap,防误操作巨额单。 */
export const ORG_TOPUP_MAX_AMOUNT_CENTS = 100_000_000n;

/** org_id 严格归一化为数字串(来自服务端解析的 auth.orgId)。 */
function normalizeOrgId(orgId: bigint | number | string): string {
  if (typeof orgId === "bigint") return orgId.toString();
  const s = String(orgId);
  if (!/^[1-9][0-9]{0,19}$/.test(s)) throw new TypeError(`org_id must be positive integer, got ${s}`);
  return s;
}

export interface CreateOrgTopupOrderInput {
  orgId: string | bigint;
  /** 经办人(操作 owner/admin)的 user_id → orders.user_id(NOT NULL,语义=经办人)。 */
  operatorUserId: bigint | number | string;
  /** 本单应付(分),1..ORG_TOPUP_MAX_AMOUNT_CENTS。 */
  amountCents: bigint;
  ttlMs?: number;
  orderNo?: string;
  nowFn?: () => Date;
}

/**
 * 创建 org 钱包充值单(pending)。org 钱包积分按**系统基准 1 分 = 1 积分**入账
 * (credits = amount_cents,V1 无赠送档;org 套餐/赠送由 boss 定企业定价后再引入)。
 * orders.org_id 落库 + kind='topup' + user_id=经办人。虎皮椒建单/二维码链路与个人单同构
 * (调用方拿到 order 后调 hupijiao.createQr);履约由 markOrderPaid → fulfillOrgTopupTx 分支
 * (order.org_id 非空)入 orgs.credits + org_wallet 流水。金额纵深防御(markOrderPaid
 * expectedAmountCents 比对 order.amount_cents)对 org 单同样生效。
 */
export async function createOrgTopupOrder(input: CreateOrgTopupOrderInput): Promise<OrderRow> {
  const orgId = normalizeOrgId(input.orgId);
  const uid = normalizeUserId(input.operatorUserId);
  if (input.amountCents <= 0n) throw new TypeError(`amountCents must be > 0, got ${input.amountCents}`);
  if (input.amountCents > ORG_TOPUP_MAX_AMOUNT_CENTS) {
    throw new TypeError(`amountCents exceeds cap ${ORG_TOPUP_MAX_AMOUNT_CENTS}, got ${input.amountCents}`);
  }
  const credits = input.amountCents; // 系统基准 1 分 = 1 积分(与 refund/subscription 口径一致)

  const nowFn = input.nowFn ?? (() => new Date());
  const ttlMs = Math.max(1, input.ttlMs ?? 15 * 60 * 1000);
  const expiresAt = new Date(nowFn().getTime() + ttlMs);
  const orderNo = input.orderNo ?? generateOrderNo(nowFn);

  const r = await query<OrderDbRow>(
    `INSERT INTO orders
      (order_no, user_id, org_id, provider, amount_cents, credits, status, kind, expires_at)
     VALUES ($1, $2, $3::bigint, 'hupijiao', $4, $5, 'pending', 'topup', $6)
     RETURNING ${ORDER_COLS}`,
    [orderNo, uid, orgId, credits.toString(), credits.toString(), expiresAt],
  );
  return rowToOrder(r.rows[0]);
}

// ─── org 席位订阅 / 加席 / 自助开通订单(0115,批次 F)──────────────────────

/** 席位数强校验(正整数)。抛结构化 OrgError,路由层映射为 400。 */
function normOrgSeats(seats: unknown): number {
  if (typeof seats !== "number" || !Number.isInteger(seats) || seats <= 0) {
    throw new OrgError(400, "VALIDATION", `seats must be a positive integer, got ${String(seats)}`);
  }
  return seats;
}

/** org 名称强校验(1..200,复用 orgs CHECK / createOrg 语义)。 */
function normOrgName(name: unknown): string {
  const s = typeof name === "string" ? name.trim() : "";
  if (s.length === 0 || s.length > 200) {
    throw new OrgError(400, "VALIDATION", "org name must be 1..200 chars");
  }
  return s;
}

export interface CreateOrgSubscriptionOrderInput {
  orgId: string | bigint;
  /** 目标 org 套餐 code(必须 scope='org' 且 enabled)。 */
  planCode: string;
  /** 席位数(>= plan.min_seats 且 <= org.max_members)。 */
  seats: number;
  /** 经办人(owner;§14 billing owner-only,路由层收口)→ orders.user_id。 */
  operatorUserId: bigint | number | string;
  ttlMs?: number;
  orderNo?: string;
  nowFn?: () => Date;
}

/**
 * 建 org 订阅/续费单(kind='subscription' + org_id + plan_code + plan_seats)。
 * 金额=每席价×seats(快照,支付 + 篡改纵深防御的基准);credits=每席积分×seats(快照,仅展示——
 * 履约由 grantOrgSubscriptionTx 按 fulfill 时的 plan.monthly_credits 现值发放,池化重置)。
 * 校验:plan scope='org' enabled、seats>=min_seats、org active、seats<=org.max_members。
 * 履约:markOrderPaid → fulfillPaidOrderTx(org_id 非空 + kind='subscription')→ grantOrgSubscriptionTx。
 */
export async function createOrgSubscriptionOrder(
  input: CreateOrgSubscriptionOrderInput,
): Promise<OrderRow> {
  const orgId = normalizeOrgId(input.orgId);
  const uid = normalizeUserId(input.operatorUserId);
  const seats = normOrgSeats(input.seats);

  const plan = await getOrgPlan(input.planCode);
  if (!plan) throw new OrgError(400, "PLAN_NOT_ORG", `plan not found or not an org plan: ${input.planCode}`);
  if (!plan.enabled) throw new OrgError(400, "PLAN_DISABLED", `org plan disabled: ${input.planCode}`);
  if (plan.minSeats != null && seats < plan.minSeats) {
    throw new OrgError(400, "SEAT_BELOW_MIN", `seats (${seats}) below plan min_seats (${plan.minSeats})`);
  }

  const org = await getOrgById(orgId);
  if (!org) throw new OrgError(404, "NOT_FOUND", `org not found: ${orgId}`);
  if (org.status !== "active") throw new OrgError(409, "ORG_UNAVAILABLE", "organization is not active");
  if (seats > org.max_members) {
    throw new OrgError(400, "SEAT_ABOVE_MAX", `seats (${seats}) exceeds org max_members (${org.max_members})`);
  }

  const amountCents = plan.priceCents * BigInt(seats);
  const credits = plan.monthlyCredits * BigInt(seats);

  const nowFn = input.nowFn ?? (() => new Date());
  const ttlMs = Math.max(1, input.ttlMs ?? 15 * 60 * 1000);
  const expiresAt = new Date(nowFn().getTime() + ttlMs);
  const orderNo = input.orderNo ?? generateOrderNo(nowFn);

  const r = await query<OrderDbRow>(
    `INSERT INTO orders
      (order_no, user_id, org_id, provider, amount_cents, credits, status, kind, plan_code, plan_seats, expires_at)
     VALUES ($1, $2, $3::bigint, 'hupijiao', $4, $5, 'pending', 'subscription', $6, $7, $8)
     RETURNING ${ORDER_COLS}`,
    [orderNo, uid, orgId, amountCents.toString(), credits.toString(), plan.code, seats, expiresAt],
  );
  return rowToOrder(r.rows[0]);
}

export interface CreateOrgSeatsOrderInput {
  orgId: string | bigint;
  /** 席位**增量**(> 0),按整席全价购,整份积分即时入池。 */
  seats: number;
  operatorUserId: bigint | number | string;
  ttlMs?: number;
  orderNo?: string;
  nowFn?: () => Date;
}

/**
 * 建 org 加席单(kind='upgrade' + org_id;plan_seats=**增量**;from_plan_code=NULL)。
 * 选型:复用 'upgrade'(个人版语义=期内桶增量/周期不变)表达 org 加席(整份即时入池/period 不变),
 * 与 'subscription'(重置)分立,fulfill 分支无歧义。from_plan_code 留 NULL——org 加席不需源档快照
 * (履约 addOrgSeatsTx 从 org_subscriptions 现值读当前档,不走 applyUpgradeOrRefundTx 的 from 校验)。
 * 校验:org 有 active 且未过期订阅、org active、加席后总席位 <= org.max_members。
 * 金额=当前档每席价×增量;credits=每席积分×增量(快照,展示用)。
 */
export async function createOrgSeatsOrder(input: CreateOrgSeatsOrderInput): Promise<OrderRow> {
  const orgId = normalizeOrgId(input.orgId);
  const uid = normalizeUserId(input.operatorUserId);
  const addSeats = normOrgSeats(input.seats);

  const sub = await getOrgSubscription(orgId);
  if (!sub) throw new OrgError(400, "NO_ORG_SUBSCRIPTION", "org has no subscription; subscribe before adding seats");
  if (sub.status !== "active" || sub.periodEnd.getTime() <= Date.now()) {
    throw new OrgError(400, "ORG_SUBSCRIPTION_INACTIVE", "org subscription is expired or ended; renew before adding seats");
  }

  const plan = await getOrgPlan(sub.planCode);
  if (!plan) throw new OrgError(400, "PLAN_NOT_ORG", `plan not found or not an org plan: ${sub.planCode}`);

  const org = await getOrgById(orgId);
  if (!org) throw new OrgError(404, "NOT_FOUND", `org not found: ${orgId}`);
  if (org.status !== "active") throw new OrgError(409, "ORG_UNAVAILABLE", "organization is not active");
  if (sub.seats + addSeats > org.max_members) {
    throw new OrgError(
      400,
      "SEAT_ABOVE_MAX",
      `seats after add (${sub.seats + addSeats}) exceeds org max_members (${org.max_members})`,
    );
  }

  const amountCents = plan.priceCents * BigInt(addSeats);
  const credits = plan.monthlyCredits * BigInt(addSeats);

  const nowFn = input.nowFn ?? (() => new Date());
  const ttlMs = Math.max(1, input.ttlMs ?? 15 * 60 * 1000);
  const expiresAt = new Date(nowFn().getTime() + ttlMs);
  const orderNo = input.orderNo ?? generateOrderNo(nowFn);

  const r = await query<OrderDbRow>(
    `INSERT INTO orders
      (order_no, user_id, org_id, provider, amount_cents, credits, status, kind, plan_code, plan_seats, expires_at)
     VALUES ($1, $2, $3::bigint, 'hupijiao', $4, $5, 'pending', 'upgrade', $6, $7, $8)
     RETURNING ${ORDER_COLS}`,
    [orderNo, uid, orgId, amountCents.toString(), credits.toString(), plan.code, addSeats, expiresAt],
  );
  return rowToOrder(r.rows[0]);
}

export interface CreateOrgProvisionOrderInput {
  /** 付款人(自助开通者)→ orders.user_id;履约建 org 时成为 owner。 */
  userId: bigint | number | string;
  /** 新建组织名(1..200)。 */
  orgName: string;
  /** 目标 org 套餐 code(scope='org' 且 enabled)。 */
  planCode: string;
  /** 席位数(>= plan.min_seats 且 <= 默认组织席位上限)。 */
  seats: number;
  ttlMs?: number;
  orderNo?: string;
  nowFn?: () => Date;
}

/**
 * 建自助开通单(kind='org_provision';org_id 建单为 NULL——org 不提前建,避免 pending 僵尸;
 * org_name/plan_seats 落列)。校验:用户当前无 active org(预检,fulfill 再校验为权威)、
 * orgName 合法、plan scope='org' enabled、seats>=min_seats 且 <= 默认组织席位上限。
 * 金额=每席价×seats;credits=每席积分×seats(快照)。
 * 履约:markOrderPaid → fulfillPaidOrderTx(kind='org_provision')→ **一个事务**建 org+owner+订阅
 * 并回填 orders.org_id;若届时用户已入他 org → 订单照常 paid + critical 告警 + 不建 org(§13)。
 */
export async function createOrgProvisionOrder(input: CreateOrgProvisionOrderInput): Promise<OrderRow> {
  const uid = normalizeUserId(input.userId);
  const orgName = normOrgName(input.orgName);
  const seats = normOrgSeats(input.seats);

  const plan = await getOrgPlan(input.planCode);
  if (!plan) throw new OrgError(400, "PLAN_NOT_ORG", `plan not found or not an org plan: ${input.planCode}`);
  if (!plan.enabled) throw new OrgError(400, "PLAN_DISABLED", `org plan disabled: ${input.planCode}`);
  if (plan.minSeats != null && seats < plan.minSeats) {
    throw new OrgError(400, "SEAT_BELOW_MIN", `seats (${seats}) below plan min_seats (${plan.minSeats})`);
  }
  if (seats > DEFAULT_ORG_MAX_MEMBERS) {
    throw new OrgError(400, "SEAT_ABOVE_MAX", `seats (${seats}) exceeds default org member cap (${DEFAULT_ORG_MAX_MEMBERS})`);
  }

  // 预检:用户当前无 active org(V1 单 org)。fulfill 时在 payer 行锁下再校验为权威。
  const existing = await getActiveMembership(uid);
  if (existing) throw new OrgError(409, "ALREADY_IN_ORG", "you already belong to an organization");

  const amountCents = plan.priceCents * BigInt(seats);
  const credits = plan.monthlyCredits * BigInt(seats);

  const nowFn = input.nowFn ?? (() => new Date());
  const ttlMs = Math.max(1, input.ttlMs ?? 15 * 60 * 1000);
  const expiresAt = new Date(nowFn().getTime() + ttlMs);
  const orderNo = input.orderNo ?? generateOrderNo(nowFn);

  const r = await query<OrderDbRow>(
    `INSERT INTO orders
      (order_no, user_id, provider, amount_cents, credits, status, kind, plan_code, plan_seats, org_name, expires_at)
     VALUES ($1, $2, 'hupijiao', $3, $4, 'pending', 'org_provision', $5, $6, $7, $8)
     RETURNING ${ORDER_COLS}`,
    [orderNo, uid, amountCents.toString(), credits.toString(), plan.code, seats, orgName, expiresAt],
  );
  return rowToOrder(r.rows[0]);
}

export interface GetOrderOptions {
  /** 要求订单属于指定用户(用于 GET /api/payment/orders/:no) */
  userId?: bigint | number | string;
}

/** 按 order_no 查。传 userId 则额外校验属主,返回 null 表示 not found 或不属此用户。 */
export async function getOrderByNo(
  orderNo: string,
  opts: GetOrderOptions = {},
): Promise<OrderRow | null> {
  const params: unknown[] = [orderNo];
  let sql = `SELECT ${ORDER_COLS} FROM orders WHERE order_no = $1`;
  if (opts.userId !== undefined) {
    params.push(normalizeUserId(opts.userId));
    sql += " AND user_id = $2";
  }
  const r = await query<OrderDbRow>(sql, params);
  return r.rows.length === 0 ? null : rowToOrder(r.rows[0]);
}

export interface MarkOrderPaidInput {
  orderNo: string;
  providerOrder?: string | null;
  callbackPayload: unknown;
  /**
   * 回调里声称的 amount_cents。传了就在 tx 里 FOR UPDATE 拿到订单后,校验
   * 与 DB 的 amount_cents 完全相等;不等 → 抛 OrderCallbackTamperedError。
   * 不传 → 跳过校验(给内部强制推进 / 测试用;不应由外部 callback 直接调到不传路径)。
   */
  expectedAmountCents?: bigint;
  /**
   * 回调里声称的支付渠道 appid。给了就要求等于 expectedAppidRef;
   * 不等 → OrderCallbackTamperedError(field=appid)。
   */
  expectedAppid?: string;
  /**
   * 比对 expectedAppid 的基准值(来自服务端配置)。
   * 两者一定要同时传或同时不传:外层没配 appid 基准,就不做 appid 校验。
   */
  expectedAppidRef?: string;
}

export interface MarkOrderPaidResult {
  /** true = 本次处理完成 credit + ledger;false = 订单之前已 paid,幂等返回 */
  newlyPaid: boolean;
  order: OrderRow;
  /** 本次新增 ledger id;幂等分支返回已存在的 ledger_id */
  ledgerId: bigint | null;
}

/**
 * 把订单推进到 paid。事务内完成:
 *   1. SELECT FOR UPDATE orders WHERE order_no=$1
 *   2. status='paid' → 直接返回(幂等,不写 ledger 不加积分)
 *   3. status 非 pending(expired/canceled/refunded) → 抛 InvalidOrderStateError
 *   4. pending → INSERT credit_ledger(reason=topup) + UPDATE users.credits + UPDATE orders
 *      status='paid', paid_at=now, provider_order, callback_payload, ledger_id
 *
 * 为什么这里自己写 SQL 而不调 `credit(...)`:
 *   - 需要把 INSERT ledger / UPDATE users / UPDATE orders 三张表塞进同一个 tx,
 *     共用 SELECT FOR UPDATE 的 orders 行锁
 *   - 复用 credit(...) 会开嵌套事务(当前 tx 工具不支持),且需要把拿到的 ledger_id
 *     再回写 orders,两次事务有竞态窗口
 *   - 扣费路径已经在 T-22 / T-23 验过 "自写 tx" 模式,这里同样处理最干净
 */
/**
 * 钱包充值履约（topup / pack 无订阅兜底）：锁 users → 加 users.credits → 写 'topup' 钱包流水。
 * 返回钱包流水 id。
 */
async function fulfillWalletTopupTx(client: PoolClient, order: OrderRow): Promise<bigint> {
  const balRow = await client.query<{ credits: string }>(
    "SELECT credits::text AS credits FROM users WHERE id = $1 FOR UPDATE",
    [order.user_id.toString()],
  );
  if (balRow.rows.length === 0) {
    throw new TypeError(`user not found for order ${order.order_no}: ${order.user_id}`);
  }
  const newBalance = BigInt(balRow.rows[0].credits) + order.credits;
  await client.query("UPDATE users SET credits = $1 WHERE id = $2", [
    newBalance.toString(),
    order.user_id.toString(),
  ]);
  const ledgerRow = await client.query<{ id: string }>(
    `INSERT INTO credit_ledger
        (user_id, delta, balance_after, reason, bucket, ref_type, ref_id, memo)
     VALUES ($1, $2, $3, 'topup', 'wallet', 'order', $4, $5)
     RETURNING id::text AS id`,
    [
      order.user_id.toString(),
      order.credits.toString(),
      newBalance.toString(),
      order.id.toString(),
      `topup amount_cents=${order.amount_cents} order_no=${order.order_no}`,
    ],
  );
  return BigInt(ledgerRow.rows[0].id);
}

/**
 * org 钱包充值履约(0112,同 tx,与 orders→paid 原子)。遵守全局锁序 orgs→users→user_subscriptions:
 * fulfill 场景只锁 orgs 一层(不触 users/subscriptions)。org deleted/deleting → 拒绝履约(抛错,
 * 订单保持 pending,走既有 5xx/人工退款路径);suspended 仍可充值(余额保留待恢复,充值是恢复手段)。
 * 返回 org_wallet 流水 id(回写 orders.ledger_id)。
 */
async function fulfillOrgTopupTx(client: PoolClient, order: OrderRow): Promise<bigint> {
  const orgId = (order.org_id as bigint).toString();
  const orgSel = await client.query<{ credits: string; status: string }>(
    "SELECT credits::text AS credits, status FROM orgs WHERE id = $1::bigint FOR UPDATE",
    [orgId],
  );
  if (orgSel.rows.length === 0) {
    throw new TypeError(`org not found for order ${order.order_no}: ${orgId}`);
  }
  const status = orgSel.rows[0].status;
  if (status === "deleted" || status === "deleting") {
    throw new TypeError(`org ${orgId} is ${status}, cannot fulfill topup for order ${order.order_no}`);
  }
  const newBalance = BigInt(orgSel.rows[0].credits) + order.credits;
  // 充值抬高可用额 → 清低水位预警去重戳(§17.2),允许余额再次跌破阈值时重新预警。
  await client.query(
    "UPDATE orgs SET credits = $1, low_balance_notified_at = NULL, updated_at = NOW() WHERE id = $2::bigint",
    [newBalance.toString(), orgId],
  );
  const ledgerRow = await client.query<{ id: string }>(
    `INSERT INTO credit_ledger
        (user_id, org_id, delta, balance_after, reason, bucket, ref_type, ref_id, memo)
     VALUES ($1, $2::bigint, $3, $4, 'topup', 'org_wallet', 'order', $5, $6)
     RETURNING id::text AS id`,
    [
      order.user_id.toString(), // 经办人(orders.user_id);org 归属由 org_id 列表达
      orgId,
      order.credits.toString(),
      newBalance.toString(),
      order.id.toString(),
      `org topup amount_cents=${order.amount_cents} order_no=${order.order_no}`,
    ],
  );
  return BigInt(ledgerRow.rows[0].id);
}

/**
 * 按订单 kind 履约（同一 tx 内，与 orders→paid 原子）。返回回写 orders.ledger_id 的钱包流水 id
 * （期内桶路径返回 null —— 流水以 ref_id=order_no 关联，不占 orders.ledger_id）。
 */
async function fulfillPaidOrderTx(client: PoolClient, order: OrderRow): Promise<bigint | null> {
  // 0115 企业版:自助开通单(kind='org_provision',建单时 org_id=NULL)。**一个事务**建
  // org+owner+订阅并回填 orders.org_id;若 payer 届时已入他 org → 不建 org、订单照常 paid、
  // 发 critical 告警人工处置(§13 显式接受的极小概率窗口)。开通单不产生个人钱包流水 → 返回 null。
  if (order.kind === "org_provision") {
    if (order.org_name == null || order.plan_code == null || order.plan_seats == null) {
      throw new TypeError(
        `malformed org_provision order ${order.order_no}: org_name/plan_code/plan_seats required`,
      );
    }
    await fulfillOrgProvisionTx(client, {
      orderId: order.id.toString(),
      orderNo: order.order_no,
      payerUserId: order.user_id.toString(),
      orgName: order.org_name,
      planCode: order.plan_code,
      seats: order.plan_seats,
    });
    return null;
  }

  // 0112/0115 企业版:org 归属单(org_id 非空)白名单履约。topup=org 钱包充值;
  // subscription=org 订阅/续费(重置期内池);upgrade=org 加席(整份即时入池)。
  // 白名单外的 kind 拒绝履约(防未来误配走错个人履约路径)。
  if (order.org_id !== null) {
    switch (order.kind) {
      case "topup":
        return fulfillOrgTopupTx(client, order);
      case "subscription": {
        // org 订阅/续费:按订单席位重置期内池(池化)。plan_code/plan_seats 建单已落。
        await grantOrgSubscriptionTx(client, {
          orgId: order.org_id,
          planCode: order.plan_code ?? "",
          seats: order.plan_seats ?? 0,
          operatorUserId: order.user_id,
          orderRef: order.order_no,
        });
        return null;
      }
      case "upgrade": {
        // org 加席:plan_seats=增量,整份即时入池、period 不变。若订阅已在窗口内过期/失效
        // (stale window),不丢已付款项——退而将等额积分入 org 钱包(镜像个人版 upgrade 的
        // refund-to-wallet 语义,orders.ledger_id 回写该 org_wallet 流水),保证订单始终成单。
        try {
          await addOrgSeatsTx(client, {
            orgId: order.org_id,
            seats: order.plan_seats ?? 0,
            operatorUserId: order.user_id,
            orderRef: order.order_no,
          });
          return null;
        } catch (err) {
          if (
            err instanceof OrgError &&
            (err.code === "ORG_SUBSCRIPTION_INACTIVE" || err.code === "NO_ORG_SUBSCRIPTION")
          ) {
            return fulfillOrgTopupTx(client, order); // 降级:等额积分入 org 钱包,不丢款
          }
          throw err;
        }
      }
      default:
        throw new TypeError(
          `org order ${order.order_no} has unsupported kind ${order.kind} (allowed: topup/subscription/upgrade)`,
        );
    }
  }
  switch (order.kind) {
    case "topup":
      return fulfillWalletTopupTx(client, order);
    case "pack": {
      // 加量包进**有效期内桶**；无有效周期则就地新开 free 周期再加 pack（绝不落进永久钱包）。
      await creditPeriodBucketTx(client, {
        userId: order.user_id,
        amount: order.credits,
        orderNo: order.order_no,
        memo: `pack amount_cents=${order.amount_cents} order_no=${order.order_no}`,
      });
      return null;
    }
    case "subscription": {
      // 订阅/续费：按**订单快照** order.credits 发放（不受套餐改价影响）；periodDays 取当前档配置。
      const plan: SubscriptionPlan | null = await getPlan(order.plan_code ?? "");
      const periodDays = plan?.periodDays ?? 30;
      await grantSubscriptionTx(client, {
        userId: order.user_id,
        planCode: order.plan_code ?? "",
        grantCredits: order.credits,
        periodDays,
        orderNo: order.order_no,
      });
      return null;
    }
    case "upgrade": {
      // 升档：付款时再校验当前订阅仍是更低付费档且未过期，否则把实付退回钱包（防 stale 占便宜）。
      const plan: SubscriptionPlan | null = await getPlan(order.plan_code ?? "");
      if (!plan) {
        throw new TypeError(`order ${order.order_no} plan not found: ${order.plan_code ?? "<null>"}`);
      }
      const r = await applyUpgradeOrRefundTx(client, {
        userId: order.user_id,
        targetPlanCode: plan.code,
        targetTier: plan.tier,
        fromPlanCode: order.from_plan_code,
        grantCredits: order.credits,
        paidAmountCents: order.amount_cents,
        orderNo: order.order_no,
      });
      // 退款路径把实付入钱包，回写 orders.ledger_id 指向该退款流水。
      return r.applied ? null : r.refundLedgerId;
    }
    default:
      throw new TypeError(`unknown order kind: ${order.kind}`);
  }
}

export async function markOrderPaid(
  input: MarkOrderPaidInput,
): Promise<MarkOrderPaidResult> {
  if (typeof input.orderNo !== "string" || input.orderNo.length === 0) {
    throw new TypeError("markOrderPaid: orderNo is required");
  }

  return tx(async (client) => {
    const sel = await client.query<OrderDbRow>(
      `SELECT ${ORDER_COLS} FROM orders WHERE order_no = $1 FOR UPDATE`,
      [input.orderNo],
    );
    if (sel.rows.length === 0) throw new OrderNotFoundError(input.orderNo);

    const current = rowToOrder(sel.rows[0]);
    if (current.status === "paid") {
      // 幂等:回调重放;不再写 ledger 或加积分,直接返现存信息
      return { newlyPaid: false, order: current, ledgerId: current.ledger_id };
    }
    if (current.status !== "pending") {
      // expired/canceled/refunded 都不能翻回 paid
      throw new InvalidOrderStateError(input.orderNo, current.status);
    }

    // 不在 markOrderPaid 内做"expires_at < now → 拒付"的硬防线。
    // 理由:用户 15 分 0 秒 ~ 15 分 30 秒扫码到回调到达的真实路径很常见,
    // 硬拒会让"扣了钱但订单未入账"的体验广泛出现。过期单的清理由 sweeper
    // (pendingOrdersExpirer 60s tick)负责:订单被推 expired 后,markOrderPaid
    // 走上面的 status!=='pending' 分支自然拒付。这等价于"60s 宽容尾巴",
    // 兼顾价格冻结漏洞修复 + 用户超时体验。

    // 纵深防御:回调字段与订单不匹配 → 中止,不扣积分不写 ledger,订单保持 pending
    // 等待下次回调或 expire。攻击面覆盖"签名算法绕过 / appSecret 泄露 / 上游 bug"。
    if (
      input.expectedAmountCents !== undefined &&
      input.expectedAmountCents !== current.amount_cents
    ) {
      throw new OrderCallbackTamperedError(
        input.orderNo,
        "amount_cents",
        current.amount_cents.toString(),
        input.expectedAmountCents.toString(),
      );
    }
    if (
      input.expectedAppid !== undefined &&
      input.expectedAppidRef !== undefined &&
      input.expectedAppid !== input.expectedAppidRef
    ) {
      throw new OrderCallbackTamperedError(
        input.orderNo,
        "appid",
        input.expectedAppidRef,
        input.expectedAppid,
      );
    }

    // 1+2. 履约：按订单种类发放（0096 双钱包）。同一 tx 内完成，与 orders→paid 原子。
    //   topup        → 进 users.credits 持久钱包（行为不变）
    //   pack         → 进 period_credits 期内桶（加量包）；无 active 订阅兜底回钱包
    //   subscription → 期内桶重置为档额度 + 周期顺延
    //   upgrade      → 期内桶补到新档额度 + 周期不变
    // orders.ledger_id 仅 topup/兜底钱包路径回写钱包流水 id；期内桶路径留 null
    // （期内桶流水以 ref_type='subscription', ref_id=order_no 关联，可追溯）。
    const ledgerId = await fulfillPaidOrderTx(client, current);

    // 3. orders 推到 paid
    const updRow = await client.query<OrderDbRow>(
      `UPDATE orders
          SET status = 'paid',
              paid_at = NOW(),
              provider_order = COALESCE($1, provider_order),
              callback_payload = $2::jsonb,
              ledger_id = $3,
              updated_at = NOW()
        WHERE id = $4
       RETURNING ${ORDER_COLS}`,
      [
        input.providerOrder ?? null,
        JSON.stringify(input.callbackPayload ?? null),
        ledgerId === null ? null : ledgerId.toString(),
        current.id.toString(),
      ],
    );
    return {
      newlyPaid: true,
      order: rowToOrder(updRow.rows[0]),
      ledgerId,
    };
  });
}

export type MarkOrderCanceledOutcome =
  /** 本次调用把 pending 推到 canceled(首次,应发告警) */
  | "canceled"
  /** 订单已在终态(paid / expired / refunded / canceled),本次无操作,不应告警 */
  | "already_paid"
  | "already_canceled"
  | "already_expired"
  | "already_refunded"
  /** DB 里找不到此 order_no */
  | "not_found";

export interface MarkOrderCanceledResult {
  outcome: MarkOrderCanceledOutcome;
  /** 命中时原订单状态;not_found 时为 null */
  previousStatus: OrderStatus | null;
}

/**
 * 把 pending 订单推到 canceled。幂等 —— 已 paid / canceled / expired / refunded
 * 都不改,只返回相应 outcome,让 caller 决定是否发告警。
 *
 * 用于虎皮椒 callback status=NF(用户侧失败/超时/取消)分支:
 *   - pending → canceled:首次 NF,发 payment.failed 告警
 *   - paid:用户先支付成功后又误回 NF(异常链路),不改状态,不发告警
 *   - canceled/expired/refunded:历史订单,不发重复告警
 *   - not_found:order_no 不属于本系统。**签名校验只能证明 payload 来自持有
 *     secret 的一方,不能证明 order_no 是本系统产生的**。typical 原因:
 *     生产 secret 被测试环境共用、虎皮椒平台串环境、或同商户号下不同系统。
 *     caller 应该按 "未知订单" 处理(对齐 OD 分支 ORDER_NOT_FOUND 的 400),
 *     而不是静默 success,否则异常 NF 回调会被完全吞掉。
 *
 * callback_payload 也顺手写入,便于事后排查。
 */
export async function markOrderCanceled(input: {
  orderNo: string;
  callbackPayload: unknown;
}): Promise<MarkOrderCanceledResult> {
  if (typeof input.orderNo !== "string" || input.orderNo.length === 0) {
    throw new TypeError("markOrderCanceled: orderNo is required");
  }
  return tx(async (client) => {
    const sel = await client.query<{ status: OrderStatus }>(
      "SELECT status FROM orders WHERE order_no = $1 FOR UPDATE",
      [input.orderNo],
    );
    if (sel.rows.length === 0) {
      return { outcome: "not_found", previousStatus: null };
    }
    const prev = sel.rows[0].status;
    if (prev !== "pending") {
      return {
        outcome: (`already_${prev}` as MarkOrderCanceledOutcome),
        previousStatus: prev,
      };
    }
    await client.query(
      `UPDATE orders
          SET status = 'canceled',
              callback_payload = $1::jsonb,
              updated_at = NOW()
        WHERE id = (SELECT id FROM orders WHERE order_no = $2)`,
      [JSON.stringify(input.callbackPayload ?? {}), input.orderNo],
    );
    return { outcome: "canceled", previousStatus: "pending" };
  });
}

/**
 * 扫 pending 且 expires_at < now 的订单,置为 expired。返回受影响行数。
 *
 * 无需事务:UPDATE 原子;订单被推到 expired 后 markOrderPaid 不会再接回来
 * (InvalidOrderStateError)—— 与 callback 竞态也是安全的:
 *   - callback 更早 → 订单进 paid,此 UPDATE 的 WHERE 过滤 status='pending' 自然跳过
 *   - UPDATE 更早 → 订单进 expired,callback 到达时 markOrderPaid 抛错,调用方记日志/告警
 */
export async function expirePendingOrders(): Promise<number> {
  const r = await query<{ id: string }>(
    `UPDATE orders
        SET status = 'expired', updated_at = NOW()
      WHERE status = 'pending' AND expires_at < NOW()
      RETURNING id::text AS id`,
  );
  return r.rowCount ?? 0;
}
