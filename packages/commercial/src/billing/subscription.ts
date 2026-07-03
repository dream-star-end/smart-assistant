/**
 * 0096 — 月度订阅服务（双钱包 period_credits 桶的发放/续费/升档/轮转）。
 *
 * 数据模型见 db/migrations/0096_subscription_billing.sql。本模块只管 period_credits 期内桶
 * 与 user_subscriptions 状态机；持久钱包 users.credits 由 billing/ledger + payment/orders
 * 管。扣费收口在 billing/spend.ts（先期内桶后钱包）。
 *
 * 关键不变量：
 *   - 每用户恒有一行 user_subscriptions（默认 free）。ensureFreeSubscription 幂等兜底。
 *   - 发放/续费/升档/轮转都在事务内改 period_credits 并写 credit_ledger(bucket='period')，
 *     balance_after = 期内桶发放后值。
 *   - 锁序（全仓不变量 users → user_subscriptions）：多数函数只锁 user_subscriptions；
 *     applyUpgradeOrRefundTx 因含退款会锁 users，故**先锁 users 再锁 user_subscriptions**，
 *     与 spendTwoBucket 同序，无锁序环。
 *   - BIGINT/bigint 贯穿，禁止 Number 化。
 *
 * 模块依赖单向：本模块 → ledger/db；payment/orders、http 反向依赖本模块（避免环）。
 */

import type { PoolClient } from "pg";
import { query, tx } from "../db/queries.js";

export const FREE_PLAN_CODE = "free";

export interface SubscriptionPlan {
  code: string;
  name: string;
  priceCents: bigint;
  monthlyCredits: bigint;
  periodDays: number;
  tier: number;
  sortOrder: number;
  enabled: boolean;
}

export interface UserSubscriptionRow {
  id: bigint;
  userId: bigint;
  planCode: string;
  status: "active" | "expired";
  periodStart: Date;
  periodEnd: Date;
  periodCredits: bigint;
}

/** 对外展示视图（合并套餐档配置）。 */
export interface UserSubscriptionView {
  planCode: string;
  planName: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  /** 当期套餐期内桶余额。 */
  periodCredits: string;
  /** 当前档每周期额度。 */
  monthlyCredits: string;
  priceCents: string;
  tier: number;
  /** 是否付费档（非 free）。 */
  paid: boolean;
}

function normUid(userId: bigint | number | string): string {
  if (typeof userId === "bigint") return userId.toString();
  if (typeof userId === "number") {
    if (!Number.isInteger(userId) || userId <= 0) throw new TypeError(`bad user_id: ${userId}`);
    return String(userId);
  }
  if (!/^\d+$/.test(userId)) throw new TypeError(`bad user_id: ${userId}`);
  return userId;
}

function rowToPlan(r: {
  code: string; name: string; price_cents: string; monthly_credits: string;
  period_days: number; tier: number; sort_order: number; enabled: boolean;
}): SubscriptionPlan {
  return {
    code: r.code,
    name: r.name,
    priceCents: BigInt(r.price_cents),
    monthlyCredits: BigInt(r.monthly_credits),
    periodDays: r.period_days,
    tier: r.tier,
    sortOrder: r.sort_order,
    enabled: r.enabled,
  };
}

const PLAN_COLS =
  `code, name, price_cents::text AS price_cents, monthly_credits::text AS monthly_credits,
   period_days, tier, sort_order, enabled`;

/** 列所有 enabled 套餐档（sort_order DESC）。 */
export async function listSubscriptionPlans(): Promise<SubscriptionPlan[]> {
  const r = await query<Parameters<typeof rowToPlan>[0]>(
    `SELECT ${PLAN_COLS} FROM subscription_plans WHERE enabled = TRUE ORDER BY sort_order DESC, tier ASC`,
  );
  return r.rows.map(rowToPlan);
}

/** 按 code 取一档（含 disabled，调用方判断）。 */
export async function getPlan(code: string): Promise<SubscriptionPlan | null> {
  if (typeof code !== "string" || code.length === 0 || code.length > 64) return null;
  const r = await query<Parameters<typeof rowToPlan>[0]>(
    `SELECT ${PLAN_COLS} FROM subscription_plans WHERE code = $1`,
    [code],
  );
  return r.rows.length === 0 ? null : rowToPlan(r.rows[0]);
}

function rowToSub(r: {
  id: string; user_id: string; plan_code: string; status: string;
  period_start: Date; period_end: Date; period_credits: string;
}): UserSubscriptionRow {
  return {
    id: BigInt(r.id),
    userId: BigInt(r.user_id),
    planCode: r.plan_code,
    status: r.status as "active" | "expired",
    periodStart: r.period_start,
    periodEnd: r.period_end,
    periodCredits: BigInt(r.period_credits),
  };
}

/** 读用户当前订阅行（无则 null）。 */
export async function getUserSubscription(
  userId: bigint | number | string,
): Promise<UserSubscriptionRow | null> {
  const uid = normUid(userId);
  const r = await query<Parameters<typeof rowToSub>[0]>(
    `SELECT id::text AS id, user_id::text AS user_id, plan_code, status,
            period_start, period_end, period_credits::text AS period_credits
       FROM user_subscriptions WHERE user_id = $1`,
    [uid],
  );
  return r.rows.length === 0 ? null : rowToSub(r.rows[0]);
}

/** 写一条期内桶流水（bucket='period'）。 */
async function insertPeriodLedger(
  client: PoolClient,
  uid: string,
  delta: bigint,
  balanceAfter: bigint,
  reason: "subscription" | "subscription_expire" | "pack",
  refId: string | null,
  memo: string,
): Promise<void> {
  await client.query(
    `INSERT INTO credit_ledger
        (user_id, delta, balance_after, reason, bucket, ref_type, ref_id, memo)
     VALUES ($1, $2, $3, $4, 'period', 'subscription', $5, $6)`,
    [uid, delta.toString(), balanceAfter.toString(), reason, refId, memo],
  );
}

/**
 * 幂等兜底：用户无订阅行时创建 free 行并发放免费档期内桶（写 'subscription' 流水）。
 * 已有行则 noop。读路径（/api/me、订阅视图、下单前）调用以保证恒有一行。
 *
 * v3→v5 抑制二次赠送（迁移 0100，boss 决策 2026-07-03）：首期 300 只对
 * `users.free_bootstrap_settled = FALSE` 的用户发放（真·新注册）；存量 v3 用户在迁移
 * backfill 时已置 TRUE → 建 free 行但发放 0，避免与 v3 注册欢迎金二次叠加。发放/抑制
 * 与建行在同一事务、`SELECT ... FOR UPDATE` 锁 users 行串行化，防并发双发。
 */
export async function ensureFreeSubscription(
  userId: bigint | number | string,
): Promise<void> {
  const uid = normUid(userId);
  // 快路径：已有订阅行直接返回（避免 /api/me 等高频路径每次开事务写库）。
  const existing = await query<{ one: number }>(
    "SELECT 1 AS one FROM user_subscriptions WHERE user_id = $1",
    [uid],
  );
  if (existing.rows.length > 0) return;
  const free = await getPlan(FREE_PLAN_CODE);
  if (!free) throw new Error("free plan not configured");
  await tx(async (client) => {
    // 锁定用户行读结算标记，使"读标记→决定发放→置位"与建订阅行原子（并发首访不双发）。
    // 用户不存在（理论不该发生，调用方已鉴权）→ settled 兜底 true（不发放）；随后 INSERT
    // user_subscriptions 因 user_id FK 会失败抛错——即 fail-fast，不会静默产出脏数据。
    const urow = await client.query<{ free_bootstrap_settled: boolean }>(
      "SELECT free_bootstrap_settled FROM users WHERE id = $1 FOR UPDATE",
      [uid],
    );
    const settled = urow.rows[0]?.free_bootstrap_settled ?? true;
    const grant = settled ? 0n : free.monthlyCredits;
    const ins = await client.query<{ id: string; period_credits: string }>(
      `INSERT INTO user_subscriptions
          (user_id, plan_code, status, period_start, period_end, period_credits)
       VALUES ($1, $2, 'active', NOW(), NOW() + ($3::int || ' days')::interval, $4)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING id::text AS id, period_credits::text AS period_credits`,
      [uid, FREE_PLAN_CODE, free.periodDays, grant.toString()],
    );
    if (ins.rows.length > 0) {
      if (grant > 0n) {
        // 新建免费订阅且未抑制：发放首期 300（进期内桶），审计一条。
        await insertPeriodLedger(
          client,
          uid,
          grant,
          grant,
          "subscription",
          null,
          "free subscription bootstrap",
        );
      }
      // 结算终态：首次建行即置位（未结算的新用户），已 TRUE 的存量用户无需再写。
      if (!settled) {
        await client.query(
          "UPDATE users SET free_bootstrap_settled = TRUE, updated_at = NOW() WHERE id = $1",
          [uid],
        );
      }
    }
  });
}

export interface GrantSubscriptionInput {
  userId: bigint | number | string;
  /** 目标套餐 code（写入 user_subscriptions.plan_code）。 */
  planCode: string;
  /** 本期发放额度（**订单快照**，钱相关订单按下单时锁定的额度履约，不受套餐改价影响）。 */
  grantCredits: bigint;
  /** 周期天数（轮转/续费用当前档配置；rarely 变）。 */
  periodDays: number;
  /** 关联订单号（审计 ref_id）。 */
  orderNo?: string | null;
}

export interface GrantSubscriptionResult {
  periodCreditsAfter: bigint;
  periodEnd: Date;
}

/**
 * 订阅 / 续费 / 降级轮转：**重置**期内桶（清零旧桶 + 发放 grantCredits + 周期顺延），只锁
 * user_subscriptions。grantCredits 来自订单快照（subscribe）或当前 free 档（rollover）。
 * 升档不走此函数（见 applyUpgradeOrRefundTx，需校验防 stale 占便宜）。
 */
export async function grantSubscriptionTx(
  client: PoolClient,
  input: GrantSubscriptionInput,
): Promise<GrantSubscriptionResult> {
  const uid = normUid(input.userId);
  const refId = input.orderNo ?? null;
  const newPeriod = input.grantCredits;

  const sel = await client.query<{ id: string; period_credits: string }>(
    `SELECT id::text AS id, period_credits::text AS period_credits
       FROM user_subscriptions WHERE user_id = $1 FOR UPDATE`,
    [uid],
  );
  const oldPeriod = sel.rows[0] ? BigInt(sel.rows[0].period_credits) : 0n;

  if (sel.rows.length === 0) {
    await client.query(
      `INSERT INTO user_subscriptions
          (user_id, plan_code, status, period_start, period_end, period_credits)
       VALUES ($1, $2, 'active', NOW(), NOW() + ($3::int || ' days')::interval, $4)`,
      [uid, input.planCode, input.periodDays, newPeriod.toString()],
    );
  } else {
    // 清零旧桶（审计），再重置周期 + 发新额度。
    if (oldPeriod > 0n) {
      await insertPeriodLedger(client, uid, -oldPeriod, 0n, "subscription_expire", refId,
        `expire ${oldPeriod} on ${input.planCode} renew/rollover`);
    }
    await client.query(
      `UPDATE user_subscriptions
          SET plan_code = $2, status = 'active',
              period_start = NOW(), period_end = NOW() + ($3::int || ' days')::interval,
              period_credits = $4, updated_at = NOW()
        WHERE user_id = $1`,
      [uid, input.planCode, input.periodDays, newPeriod.toString()],
    );
  }
  if (newPeriod > 0n) {
    await insertPeriodLedger(client, uid, newPeriod, newPeriod, "subscription", refId,
      `grant ${input.planCode} ${newPeriod}`);
  }

  const endRow = await client.query<{ period_credits: string; period_end: Date }>(
    "SELECT period_credits::text AS period_credits, period_end FROM user_subscriptions WHERE user_id = $1",
    [uid],
  );
  return {
    periodCreditsAfter: BigInt(endRow.rows[0].period_credits),
    periodEnd: endRow.rows[0].period_end,
  };
}

export interface UpgradeOrRefundInput {
  userId: bigint | number | string;
  targetPlanCode: string;
  targetTier: number;
  /** 升档单的**源套餐档快照**：履约时当前订阅 plan_code 必须仍 == 此档，差价才成立。 */
  fromPlanCode: string | null;
  /** 升档后期内桶补到的额度（订单快照）。 */
  grantCredits: bigint;
  /** 本单实付（分），stale 时按此原额退回钱包，绝不吞钱。 */
  paidAmountCents: bigint;
  orderNo?: string | null;
}

export type UpgradeOrRefundResult =
  | { applied: true; periodCreditsAfter: bigint }
  /** stale（源档已变/到期/当前档不低于目标）→ 实付退回钱包，订阅不变。 */
  | { applied: false; refundLedgerId: bigint };

/**
 * 升档履约（含**付款时再校验**，防 stale 低价升级）：在调用方既有事务内执行。
 *
 * 有效升档当且仅当：当前订阅 active 且未过期、**当前 plan_code == 订单源档 fromPlanCode**、
 * 且当前 tier < 目标 tier。满足 → 期内桶补到 grantCredits、周期不变。否则视为失效升档单
 * （到期降级 / 源档已变 / 当前已不低于目标）→ 把实付金额原额退回 users.credits 钱包
 * （reason='refund'），订阅不动。绑定 fromPlanCode 杜绝"先降级再用旧差价单把低档周期升到高档"。
 *
 * **锁序（全仓不变量 users → user_subscriptions）**：无条件先锁 users 再锁 user_subscriptions，
 * 与 spendTwoBucket 同序，杜绝退款路径与扣费路径成环死锁。退款 1 分 = 1 积分（系统基准）。
 */
export async function applyUpgradeOrRefundTx(
  client: PoolClient,
  input: UpgradeOrRefundInput,
): Promise<UpgradeOrRefundResult> {
  const uid = normUid(input.userId);
  const refId = input.orderNo ?? null;

  // (1) 先锁 users（即便有效升档不改钱包，也按全局锁序无条件锁，杜绝与 spendTwoBucket 成环）。
  const wRow = await client.query<{ credits: string }>(
    "SELECT credits::text AS credits FROM users WHERE id = $1 FOR UPDATE",
    [uid],
  );
  if (wRow.rows.length === 0) throw new TypeError(`user not found: ${uid}`);

  // (2) 再锁 user_subscriptions + 取 plan/period_end。
  const sel = await client.query<{ id: string; plan_code: string; period_credits: string; period_end: Date }>(
    `SELECT id::text AS id, plan_code, period_credits::text AS period_credits, period_end
       FROM user_subscriptions WHERE user_id = $1 AND status = 'active' FOR UPDATE`,
    [uid],
  );
  const row = sel.rows[0];
  const stillActive = row ? row.period_end.getTime() > Date.now() : false;
  const fromMatches = !!row && !!input.fromPlanCode && row.plan_code === input.fromPlanCode;
  const curPlan = row ? await getPlan(row.plan_code) : null;
  const curTier = curPlan?.tier ?? -1;
  const valid = !!row && stillActive && fromMatches && curTier > 0 && curTier < input.targetTier;

  if (valid) {
    const oldPeriod = BigInt(row.period_credits);
    const newPeriod = input.grantCredits > oldPeriod ? input.grantCredits : oldPeriod;
    if (newPeriod > oldPeriod) {
      await insertPeriodLedger(client, uid, newPeriod - oldPeriod, newPeriod, "subscription", refId,
        `upgrade ${input.fromPlanCode}→${input.targetPlanCode} top-up ${newPeriod - oldPeriod}`);
    }
    await client.query(
      `UPDATE user_subscriptions
          SET plan_code = $2, period_credits = $3, updated_at = NOW()
        WHERE user_id = $1`,
      [uid, input.targetPlanCode, newPeriod.toString()],
    );
    return { applied: true, periodCreditsAfter: newPeriod };
  }

  // stale 升档：实付退回钱包（持久，users 已锁），订阅不变。
  const after = BigInt(wRow.rows[0].credits) + input.paidAmountCents;
  await client.query("UPDATE users SET credits = $1 WHERE id = $2", [after.toString(), uid]);
  const led = await client.query<{ id: string }>(
    `INSERT INTO credit_ledger
        (user_id, delta, balance_after, reason, bucket, ref_type, ref_id, memo)
     VALUES ($1, $2, $3, 'refund', 'wallet', 'order', $4, $5)
     RETURNING id::text AS id`,
    [uid, input.paidAmountCents.toString(), after.toString(), refId,
     `stale upgrade auto-refund to wallet ${input.paidAmountCents}`],
  );
  return { applied: false, refundLedgerId: BigInt(led.rows[0].id) };
}

/**
 * 加量包 pack 履约（在调用方既有事务内）：把 amount 加进**有效期内桶**。
 * 若用户无 active 订阅、或当前订阅已过期（period_end <= now，sweeper 未轮转），则**就地新开一个
 * free 周期**（grant free 额度 + 周期顺延）再加 pack —— 绝不让"仅套餐期内有效"的加量包落进永久
 * 钱包。返回加 pack 后的期内桶余额。
 */
export async function creditPeriodBucketTx(
  client: PoolClient,
  args: { userId: bigint | number | string; amount: bigint; orderNo?: string | null; memo: string },
): Promise<{ periodAfter: bigint }> {
  if (args.amount <= 0n) throw new TypeError(`amount must be > 0, got ${args.amount}`);
  const uid = normUid(args.userId);
  const refId = args.orderNo ?? null;

  const sel = await client.query<{ id: string; period_credits: string; period_end: Date }>(
    `SELECT id::text AS id, period_credits::text AS period_credits, period_end
       FROM user_subscriptions WHERE user_id = $1 FOR UPDATE`,
    [uid],
  );
  const row = sel.rows[0];
  const valid = row ? row.period_end.getTime() > Date.now() : false;

  if (!valid) {
    // 无有效周期 → 就地新开 free 周期（清零旧桶 + 发 free 额度 + 周期顺延），再加 pack。
    const free = await getPlan(FREE_PLAN_CODE);
    if (!free) throw new Error("free plan not configured");
    await grantSubscriptionTx(client, {
      userId: uid,
      planCode: FREE_PLAN_CODE,
      grantCredits: free.monthlyCredits,
      periodDays: free.periodDays,
      orderNo: refId,
    });
    const cur = await client.query<{ id: string; period_credits: string }>(
      "SELECT id::text AS id, period_credits::text AS period_credits FROM user_subscriptions WHERE user_id = $1",
      [uid],
    );
    const after = BigInt(cur.rows[0].period_credits) + args.amount;
    await client.query(
      "UPDATE user_subscriptions SET period_credits = $1, updated_at = NOW() WHERE id = $2",
      [after.toString(), cur.rows[0].id],
    );
    await insertPeriodLedger(client, uid, args.amount, after, "pack", refId, args.memo);
    return { periodAfter: after };
  }

  const after = BigInt(row.period_credits) + args.amount;
  await client.query(
    "UPDATE user_subscriptions SET period_credits = $1, updated_at = NOW() WHERE id = $2",
    [after.toString(), row.id],
  );
  await insertPeriodLedger(client, uid, args.amount, after, "pack", refId, args.memo);
  return { periodAfter: after };
}

/**
 * 周期轮转 sweeper（cron 调用）：扫 period_end < now 的 active 订阅，逐条
 * 降级/续期到 free（清零旧期内桶 + 重置 free 额度 + 周期顺延）。
 *
 * 语义（boss 决策：手动续费 + 用完即止 + 到期降级免费版）：
 *   - 付费档到期未续 → 降级 free（period_credits=300）。
 *   - free 档到期 → 续期 free（月度重置 300）。
 * 钱包 users.credits 不动（存量真金不受影响）。
 *
 * 并发安全：UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) 认领，
 * 每行单 sweeper 处理。返回处理的 user_id 列表。
 */
export async function rolloverExpiredSubscriptions(limit = 200): Promise<bigint[]> {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new TypeError(`limit must be in (0,10000], got ${limit}`);
  }
  const free = await getPlan(FREE_PLAN_CODE);
  if (!free) throw new Error("free plan not configured");

  return tx(async (client) => {
    // 认领一批到期行（SKIP LOCKED 防多 sweeper 抢同一行）。
    const claimed = await client.query<{ user_id: string }>(
      `SELECT user_id::text AS user_id
         FROM user_subscriptions
        WHERE status = 'active' AND period_end < NOW()
        ORDER BY period_end ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [limit],
    );
    const out: bigint[] = [];
    for (const row of claimed.rows) {
      // 已持有该行的行锁（同 tx 内 FOR UPDATE）；grantSubscriptionTx 再 SELECT FOR UPDATE
      // 同一行是可重入的（同事务已锁）。重置到 free。
      await grantSubscriptionTx(client, {
        userId: row.user_id,
        planCode: FREE_PLAN_CODE,
        grantCredits: free.monthlyCredits,
        periodDays: free.periodDays,
        orderNo: null,
      });
      out.push(BigInt(row.user_id));
    }
    return out;
  });
}

/** 读用户订阅展示视图（合并档配置）；无订阅行先 ensureFreeSubscription。 */
export async function getUserSubscriptionView(
  userId: bigint | number | string,
): Promise<UserSubscriptionView> {
  await ensureFreeSubscription(userId);
  const sub = await getUserSubscription(userId);
  if (!sub) throw new Error("subscription missing after ensure");
  const plan = (await getPlan(sub.planCode)) ?? (await getPlan(FREE_PLAN_CODE))!;
  return {
    planCode: sub.planCode,
    planName: plan.name,
    status: sub.status,
    periodStart: sub.periodStart.toISOString(),
    periodEnd: sub.periodEnd.toISOString(),
    periodCredits: sub.periodCredits.toString(),
    monthlyCredits: plan.monthlyCredits.toString(),
    priceCents: plan.priceCents.toString(),
    tier: plan.tier,
    paid: sub.planCode !== FREE_PLAN_CODE,
  };
}
