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
import { query, tx } from "../db/queries.js";

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

function rowToPlan(r: {
  id: string; code: string; label: string; amount_cents: string; credits: string;
  sort_order: number; enabled: boolean;
}): TopupPlan {
  return {
    id: BigInt(r.id),
    code: r.code,
    label: r.label,
    amount_cents: BigInt(r.amount_cents),
    credits: BigInt(r.credits),
    sort_order: r.sort_order,
    enabled: r.enabled,
  };
}

function rowToOrder(r: {
  id: string; order_no: string; user_id: string; provider: "hupijiao";
  provider_order: string | null; amount_cents: string; credits: string;
  status: OrderStatus; paid_at: Date | null; expires_at: Date;
  ledger_id: string | null; refunded_ledger_id: string | null;
  created_at: Date; updated_at: Date;
}): OrderRow {
  return {
    id: BigInt(r.id),
    order_no: r.order_no,
    user_id: BigInt(r.user_id),
    provider: r.provider,
    provider_order: r.provider_order,
    amount_cents: BigInt(r.amount_cents),
    credits: BigInt(r.credits),
    status: r.status,
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
  const r = await query<{
    id: string; code: string; label: string; amount_cents: string; credits: string;
    sort_order: number; enabled: boolean;
  }>(
    `SELECT id::text AS id, code, label,
            amount_cents::text AS amount_cents, credits::text AS credits,
            sort_order, enabled
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
  const r = await query<{
    id: string; code: string; label: string; amount_cents: string; credits: string;
    sort_order: number; enabled: boolean;
  }>(
    `SELECT id::text AS id, code, label,
            amount_cents::text AS amount_cents, credits::text AS credits,
            sort_order, enabled
       FROM topup_plans WHERE code = $1`,
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

  const r = await query<{
    id: string; order_no: string; user_id: string; provider: "hupijiao";
    provider_order: string | null; amount_cents: string; credits: string;
    status: OrderStatus; paid_at: Date | null; expires_at: Date;
    ledger_id: string | null; refunded_ledger_id: string | null;
    created_at: Date; updated_at: Date;
  }>(
    `INSERT INTO orders
      (order_no, user_id, provider, amount_cents, credits, status, expires_at)
     VALUES ($1, $2, 'hupijiao', $3, $4, 'pending', $5)
     RETURNING
       id::text AS id, order_no, user_id::text AS user_id, provider,
       provider_order, amount_cents::text AS amount_cents, credits::text AS credits,
       status, paid_at, expires_at,
       ledger_id::text AS ledger_id, refunded_ledger_id::text AS refunded_ledger_id,
       created_at, updated_at`,
    [orderNo, uid, plan.amount_cents.toString(), plan.credits.toString(), expiresAt],
  );
  return { order: rowToOrder(r.rows[0]), plan };
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
  let sql =
    `SELECT id::text AS id, order_no, user_id::text AS user_id, provider,
            provider_order, amount_cents::text AS amount_cents, credits::text AS credits,
            status, paid_at, expires_at,
            ledger_id::text AS ledger_id, refunded_ledger_id::text AS refunded_ledger_id,
            created_at, updated_at
       FROM orders WHERE order_no = $1`;
  if (opts.userId !== undefined) {
    params.push(normalizeUserId(opts.userId));
    sql += " AND user_id = $2";
  }
  const r = await query<{
    id: string; order_no: string; user_id: string; provider: "hupijiao";
    provider_order: string | null; amount_cents: string; credits: string;
    status: OrderStatus; paid_at: Date | null; expires_at: Date;
    ledger_id: string | null; refunded_ledger_id: string | null;
    created_at: Date; updated_at: Date;
  }>(sql, params);
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
export async function markOrderPaid(
  input: MarkOrderPaidInput,
): Promise<MarkOrderPaidResult> {
  if (typeof input.orderNo !== "string" || input.orderNo.length === 0) {
    throw new TypeError("markOrderPaid: orderNo is required");
  }

  return tx(async (client) => {
    const sel = await client.query<{
      id: string; order_no: string; user_id: string; provider: "hupijiao";
      provider_order: string | null; amount_cents: string; credits: string;
      status: OrderStatus; paid_at: Date | null; expires_at: Date;
      ledger_id: string | null; refunded_ledger_id: string | null;
      created_at: Date; updated_at: Date;
    }>(
      `SELECT id::text AS id, order_no, user_id::text AS user_id, provider,
              provider_order, amount_cents::text AS amount_cents, credits::text AS credits,
              status, paid_at, expires_at,
              ledger_id::text AS ledger_id, refunded_ledger_id::text AS refunded_ledger_id,
              created_at, updated_at
         FROM orders WHERE order_no = $1 FOR UPDATE`,
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

    // 1. 锁用户余额
    const balRow = await client.query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id = $1 FOR UPDATE",
      [current.user_id.toString()],
    );
    if (balRow.rows.length === 0) {
      throw new TypeError(`user not found for order ${input.orderNo}: ${current.user_id}`);
    }
    const balance = BigInt(balRow.rows[0].credits);
    const newBalance = balance + current.credits;
    await client.query(
      "UPDATE users SET credits = $1 WHERE id = $2",
      [newBalance.toString(), current.user_id.toString()],
    );

    // 2. 写 credit_ledger(reason='topup', ref=order:<order_id>)
    const ledgerRow = await client.query<{ id: string }>(
      `INSERT INTO credit_ledger
        (user_id, delta, balance_after, reason, ref_type, ref_id, memo)
       VALUES ($1, $2, $3, 'topup', 'order', $4, $5)
       RETURNING id::text AS id`,
      [
        current.user_id.toString(),
        current.credits.toString(),
        newBalance.toString(),
        current.id.toString(),
        `topup plan amount_cents=${current.amount_cents} order_no=${current.order_no}`,
      ],
    );
    const ledgerId = BigInt(ledgerRow.rows[0].id);

    // 3. orders 推到 paid
    const updRow = await client.query<{
      id: string; order_no: string; user_id: string; provider: "hupijiao";
      provider_order: string | null; amount_cents: string; credits: string;
      status: OrderStatus; paid_at: Date | null; expires_at: Date;
      ledger_id: string | null; refunded_ledger_id: string | null;
      created_at: Date; updated_at: Date;
    }>(
      `UPDATE orders
          SET status = 'paid',
              paid_at = NOW(),
              provider_order = COALESCE($1, provider_order),
              callback_payload = $2::jsonb,
              ledger_id = $3,
              updated_at = NOW()
        WHERE id = $4
       RETURNING
         id::text AS id, order_no, user_id::text AS user_id, provider,
         provider_order, amount_cents::text AS amount_cents, credits::text AS credits,
         status, paid_at, expires_at,
         ledger_id::text AS ledger_id, refunded_ledger_id::text AS refunded_ledger_id,
         created_at, updated_at`,
      [
        input.providerOrder ?? null,
        JSON.stringify(input.callbackPayload ?? null),
        ledgerId.toString(),
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
