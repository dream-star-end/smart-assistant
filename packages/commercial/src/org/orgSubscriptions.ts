/**
 * 企业版(P3.1 二期 · 批次 E) — org 席位订阅数据层(期内池池化)。
 *
 * 与个人版 billing/subscription.ts **同构**:本模块只管 org_subscriptions 状态机 +
 * org 期内池(period_credits),不碰 org 钱包(orgs.credits 由 payment/admin 管)、
 * 不碰成员集(席位闸在 invitations 层,批次 F)。扣费四桶收口在 billing/spend.ts。
 *
 * 与个人版 grantSubscriptionTx / rolloverExpiredSubscriptions 的语义对齐点:
 *   - grant/续费:先清零旧期内池写 subscription_expire 负流水 → 发新池 seats×每席积分
 *     写 subscription 正流水 → period_end 顺延(镜像 subscription.ts:243)。
 *   - rollover:FOR UPDATE SKIP LOCKED 认领 period_end<NOW() 的 active 行,清零池写
 *     subscription_expire 负流水,置 status='expired'(镜像 subscription.ts:448)。
 *   - **差异(org 无 free 档)**:个人到期降级 free 并重发 300;org 到期只置 expired、清零池,
 *     **不降档、不动 org 钱包、不踢成员**(方案 §11 宽松策略,席位闸只拦新进)。
 *
 * 锁序(全仓不变量,全局单向):**orgs → org_subscriptions → users → user_subscriptions**
 * (0115 席位订阅扩入 org_subscriptions,位于 orgs 之后、users 之前;见 billing/spend.ts 文件头)。
 *   - grant/加席:锁 orgs → org_subscriptions(本序前缀,与 spend 的 org 桶锁子序一致,无环)。
 *   - rollover:每行 FOR UPDATE SKIP LOCKED 认领 org_subscriptions;不锁 orgs/users,是本序子集。
 *
 * credit_ledger.user_id NOT NULL:org 期内池流水的"经办人"=
 *   - grant/加席 → operatorUserId(owner,§14 billing owner-only,路由层已收口);
 *   - rollover(系统 sweeper 无操作者)→ 解析 org owner(uq_org_owner),兜底 orgs.created_by。
 * org 归属由 org_id 列表达(bucket='org_period' + ck_cl_org_wallet_has_org 强制非空)。
 *
 * reason 复用 0096 已有白名单('subscription' 发放 / 'subscription_expire' 清零),不扩 CHECK。
 * BIGINT/bigint 贯穿,禁止 Number 化(seats 是 INTEGER,可安全 number)。
 */

import type { PoolClient } from "pg";
import { query, tx, type QueryRunner } from "../db/queries.js";
import { getPool } from "../db/index.js";
import { OrgError } from "./types.js";

// ─── 归一化 ──────────────────────────────────────────────────────────

function normId(name: string, v: bigint | number | string): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v <= 0) throw new TypeError(`${name} must be positive integer, got ${v}`);
    return String(v);
  }
  if (!/^\d+$/.test(v)) throw new TypeError(`${name} must be decimal digits, got ${v}`);
  return v;
}

function normSeats(seats: number): number {
  if (!Number.isInteger(seats) || seats <= 0) {
    throw new OrgError(400, "VALIDATION", `seats must be a positive integer, got ${seats}`);
  }
  return seats;
}

// ─── org 套餐档读取(单一 plans 权威,scope='org' 分区)───────────────

export interface OrgSubscriptionPlan {
  code: string;
  name: string;
  /** 每席位价(分)。 */
  priceCents: bigint;
  /** 每席位每周期积分(全部入 org 期内池)。 */
  monthlyCredits: bigint;
  periodDays: number;
  tier: number;
  sortOrder: number;
  enabled: boolean;
  /** 最低席位(org 档专用)。 */
  minSeats: number | null;
}

const ORG_PLAN_COLS = `code, name, price_cents::text AS price_cents,
  monthly_credits::text AS monthly_credits, period_days, tier, sort_order, enabled, min_seats`;

function rowToOrgPlan(r: {
  code: string; name: string; price_cents: string; monthly_credits: string;
  period_days: number; tier: number; sort_order: number; enabled: boolean; min_seats: number | null;
}): OrgSubscriptionPlan {
  return {
    code: r.code,
    name: r.name,
    priceCents: BigInt(r.price_cents),
    monthlyCredits: BigInt(r.monthly_credits),
    periodDays: r.period_days,
    tier: r.tier,
    sortOrder: r.sort_order,
    enabled: r.enabled,
    minSeats: r.min_seats,
  };
}

/** 按 code 取一档 org 套餐(**强制 scope='org'**,防误把个人档当 org 档用);非 org 档 → null。 */
export async function getOrgPlan(
  code: string,
  runner?: QueryRunner,
): Promise<OrgSubscriptionPlan | null> {
  if (typeof code !== "string" || code.length === 0 || code.length > 64) return null;
  const r = await query<Parameters<typeof rowToOrgPlan>[0]>(
    `SELECT ${ORG_PLAN_COLS} FROM subscription_plans WHERE code = $1 AND scope = 'org'`,
    [code],
    runner,
  );
  return r.rows.length === 0 ? null : rowToOrgPlan(r.rows[0]);
}

/** 列所有 enabled 的 org 套餐档(scope='org',sort_order DESC);批次 F/G 开通向导用。 */
export async function listOrgSubscriptionPlans(): Promise<OrgSubscriptionPlan[]> {
  const r = await query<Parameters<typeof rowToOrgPlan>[0]>(
    `SELECT ${ORG_PLAN_COLS} FROM subscription_plans
      WHERE enabled = TRUE AND scope = 'org' ORDER BY sort_order DESC, tier ASC`,
  );
  return r.rows.map(rowToOrgPlan);
}

// ─── org 订阅读取 ────────────────────────────────────────────────────

export interface OrgSubscriptionRow {
  id: bigint;
  orgId: bigint;
  planCode: string;
  seats: number;
  status: "active" | "expired";
  periodStart: Date;
  periodEnd: Date;
  periodCredits: bigint;
}

function rowToOrgSub(r: {
  id: string; org_id: string; plan_code: string; seats: number; status: string;
  period_start: Date; period_end: Date; period_credits: string;
}): OrgSubscriptionRow {
  return {
    id: BigInt(r.id),
    orgId: BigInt(r.org_id),
    planCode: r.plan_code,
    seats: r.seats,
    status: r.status as "active" | "expired",
    periodStart: r.period_start,
    periodEnd: r.period_end,
    periodCredits: BigInt(r.period_credits),
  };
}

const ORG_SUB_COLS = `id::text AS id, org_id::text AS org_id, plan_code, seats, status,
  period_start, period_end, period_credits::text AS period_credits`;

/** 读某 org 的订阅行(每 org 至多一行,无则 null)。 */
export async function getOrgSubscription(
  orgId: bigint | number | string,
  runner: QueryRunner = getPool() as unknown as QueryRunner,
): Promise<OrgSubscriptionRow | null> {
  const oid = normId("orgId", orgId);
  const r = await query<Parameters<typeof rowToOrgSub>[0]>(
    `SELECT ${ORG_SUB_COLS} FROM org_subscriptions WHERE org_id = $1::bigint`,
    [oid],
    runner,
  );
  return r.rows.length === 0 ? null : rowToOrgSub(r.rows[0]);
}

// ─── 内部:org 期内池流水 + 经办人解析 ────────────────────────────────

/**
 * 写一条 org 期内池流水(bucket='org_period',带 org_id + user_id 经办人)。
 * ck_cl_org_wallet_has_org 强制 org_period 行必须带 org_id;此处恒传。
 * ref_type='subscription' 与个人版 insertPeriodLedger 一致(订阅域分类标记,非 'order')。
 */
async function insertOrgPeriodLedger(
  client: PoolClient,
  args: {
    orgId: string;
    userId: string;
    delta: bigint;
    balanceAfter: bigint;
    reason: "subscription" | "subscription_expire";
    refId: string | null;
    memo: string;
  },
): Promise<bigint> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO credit_ledger
        (user_id, delta, balance_after, reason, bucket, ref_type, ref_id, memo, org_id)
     VALUES ($1, $2, $3, $4, 'org_period', 'subscription', $5, $6, $7::bigint)
     RETURNING id::text AS id`,
    [
      args.userId,
      args.delta.toString(),
      args.balanceAfter.toString(),
      args.reason,
      args.refId,
      args.memo,
      args.orgId,
    ],
  );
  return BigInt(r.rows[0].id);
}

/**
 * 解析 org 期内池流水的经办人 user_id(rollover 无操作者时用):owner(uq_org_owner)优先,
 * 兜底 orgs.created_by。两者皆空(理论不该发生,owner 单一权威由 createOrg 保证)→ null,
 * 调用方跳过流水但仍清零/置 expired(钱已由 spend 的 period_end>NOW() 谓词挡住,清零只是收尾)。
 */
async function resolveOrgLedgerActor(client: PoolClient, orgId: string): Promise<string | null> {
  const r = await client.query<{ uid: string | null }>(
    `SELECT COALESCE(
       (SELECT user_id FROM org_memberships WHERE org_id = $1::bigint AND org_role = 'owner' LIMIT 1),
       (SELECT created_by FROM orgs WHERE id = $1::bigint)
     )::text AS uid`,
    [orgId],
  );
  return r.rows[0]?.uid ?? null;
}

// ─── grant / 续费 ────────────────────────────────────────────────────

export interface GrantOrgSubscriptionInput {
  orgId: bigint | number | string;
  /** 目标 org 套餐 code(必须 scope='org' 且 enabled)。 */
  planCode: string;
  /** 席位数(>= plan.min_seats)。 */
  seats: number;
  /** 经办人(owner;§14 billing owner-only)。写 org 期内池流水的 user_id。 */
  operatorUserId: bigint | number | string;
  /** 关联订单号(审计 ref_id)。 */
  orderRef?: string | null;
}

export interface GrantOrgSubscriptionResult {
  periodCreditsAfter: bigint;
  periodEnd: Date;
  seats: number;
}

/**
 * org 订阅 / 续费:**重置** org 期内池(清零旧池写 subscription_expire 负流水 + 发放
 * seats×每席积分写 subscription 正流水 + period 顺延)。UPSERT org_subscriptions(UNIQUE org_id)。
 * 在调用方既有事务内执行(批次 F 的 fulfill 与建 org/owner 同事务)。
 *
 * 锁序:orgs FOR UPDATE(全局最前,兼校验 org 存在) → org_subscriptions FOR UPDATE。
 * 镜像个人版 grantSubscriptionTx(subscription.ts:243)语义;seats×monthly 为整份即时入池。
 */
export async function grantOrgSubscriptionTx(
  client: PoolClient,
  input: GrantOrgSubscriptionInput,
): Promise<GrantOrgSubscriptionResult> {
  const orgId = normId("orgId", input.orgId);
  const operator = normId("operatorUserId", input.operatorUserId);
  const seats = normSeats(input.seats);
  const refId = input.orderRef ?? null;

  // 锁 orgs(全局锁序最前 + 校验存在)。只清低水位戳(订阅发放抬高可用额,§17.2),
  // 不动 orgs.credits(钱包由 payment/admin 管)。
  const orgRow = await client.query<{ id: string }>(
    "SELECT id::text AS id FROM orgs WHERE id = $1::bigint FOR UPDATE",
    [orgId],
  );
  if (orgRow.rows.length === 0) throw new OrgError(404, "NOT_FOUND", `org not found: ${orgId}`);
  await client.query(
    "UPDATE orgs SET low_balance_notified_at = NULL WHERE id = $1::bigint AND low_balance_notified_at IS NOT NULL",
    [orgId],
  );

  const plan = await getOrgPlan(input.planCode, client);
  if (!plan) throw new OrgError(400, "PLAN_NOT_ORG", `plan not found or not an org plan: ${input.planCode}`);
  if (!plan.enabled) throw new OrgError(400, "PLAN_DISABLED", `org plan disabled: ${input.planCode}`);
  if (plan.minSeats != null && seats < plan.minSeats) {
    throw new OrgError(400, "SEAT_BELOW_MIN", `seats (${seats}) below plan min_seats (${plan.minSeats})`);
  }

  const newPeriod = BigInt(seats) * plan.monthlyCredits;

  const sel = await client.query<{ id: string; period_credits: string }>(
    "SELECT id::text AS id, period_credits::text AS period_credits FROM org_subscriptions WHERE org_id = $1::bigint FOR UPDATE",
    [orgId],
  );
  const oldPeriod = sel.rows[0] ? BigInt(sel.rows[0].period_credits) : 0n;

  if (sel.rows.length === 0) {
    await client.query(
      `INSERT INTO org_subscriptions
          (org_id, plan_code, seats, status, period_start, period_end, period_credits)
       VALUES ($1::bigint, $2, $3, 'active', NOW(), NOW() + ($4::int || ' days')::interval, $5)`,
      [orgId, input.planCode, seats, plan.periodDays, newPeriod.toString()],
    );
  } else {
    // 清零旧池(审计),再重置周期 + 发新额度。
    if (oldPeriod > 0n) {
      await insertOrgPeriodLedger(client, {
        orgId,
        userId: operator,
        delta: -oldPeriod,
        balanceAfter: 0n,
        reason: "subscription_expire",
        refId,
        memo: `expire ${oldPeriod} on ${input.planCode} renew/rollover`,
      });
    }
    await client.query(
      `UPDATE org_subscriptions
          SET plan_code = $2, seats = $3, status = 'active',
              period_start = NOW(), period_end = NOW() + ($4::int || ' days')::interval,
              period_credits = $5, updated_at = NOW()
        WHERE org_id = $1::bigint`,
      [orgId, input.planCode, seats, plan.periodDays, newPeriod.toString()],
    );
  }

  if (newPeriod > 0n) {
    await insertOrgPeriodLedger(client, {
      orgId,
      userId: operator,
      delta: newPeriod,
      balanceAfter: newPeriod,
      reason: "subscription",
      refId,
      memo: `grant ${input.planCode} seats=${seats} ${newPeriod}`,
    });
  }

  const endRow = await client.query<{ period_credits: string; period_end: Date }>(
    "SELECT period_credits::text AS period_credits, period_end FROM org_subscriptions WHERE org_id = $1::bigint",
    [orgId],
  );
  return {
    periodCreditsAfter: BigInt(endRow.rows[0].period_credits),
    periodEnd: endRow.rows[0].period_end,
    seats,
  };
}

// ─── 期中加席 ────────────────────────────────────────────────────────

export interface AddOrgSeatsInput {
  orgId: bigint | number | string;
  /** 席位增量(> 0),按整席全价购,整份积分即时入池。 */
  seats: number;
  operatorUserId: bigint | number | string;
  orderRef?: string | null;
}

export interface AddOrgSeatsResult {
  seatsAfter: number;
  periodCreditsAfter: bigint;
}

/**
 * 期中加席(方案 §11 宽松策略):seats += n、period_credits += n×每席积分(**整份即时入池,
 * period 不变**),仅当 active 订阅存在且未过期才可。在调用方既有事务内执行(批次 F fulfill)。
 * 锁序 orgs → org_subscriptions(全局单向前缀)。写 subscription 正流水(memo 注明加席)。
 */
export async function addOrgSeatsTx(
  client: PoolClient,
  input: AddOrgSeatsInput,
): Promise<AddOrgSeatsResult> {
  const orgId = normId("orgId", input.orgId);
  const operator = normId("operatorUserId", input.operatorUserId);
  const add = normSeats(input.seats);
  const refId = input.orderRef ?? null;

  const orgRow = await client.query<{ id: string }>(
    "SELECT id::text AS id FROM orgs WHERE id = $1::bigint FOR UPDATE",
    [orgId],
  );
  if (orgRow.rows.length === 0) throw new OrgError(404, "NOT_FOUND", `org not found: ${orgId}`);
  // 加席抬高期内池(可用额)→ 清低水位戳(§17.2)。
  await client.query(
    "UPDATE orgs SET low_balance_notified_at = NULL WHERE id = $1::bigint AND low_balance_notified_at IS NOT NULL",
    [orgId],
  );

  const sel = await client.query<{
    id: string; plan_code: string; seats: number; period_credits: string; status: string; period_end: Date;
  }>(
    `SELECT id::text AS id, plan_code, seats, period_credits::text AS period_credits, status, period_end
       FROM org_subscriptions WHERE org_id = $1::bigint FOR UPDATE`,
    [orgId],
  );
  const row = sel.rows[0];
  if (!row) throw new OrgError(400, "NO_ORG_SUBSCRIPTION", "org has no subscription to add seats to");
  if (row.status !== "active" || row.period_end.getTime() <= Date.now()) {
    throw new OrgError(400, "ORG_SUBSCRIPTION_INACTIVE", "org subscription is not active (expired or ended); renew first");
  }

  const plan = await getOrgPlan(row.plan_code, client);
  if (!plan) throw new OrgError(400, "PLAN_NOT_ORG", `plan not found or not an org plan: ${row.plan_code}`);

  const addPool = BigInt(add) * plan.monthlyCredits;
  const seatsAfter = row.seats + add;
  const periodAfter = BigInt(row.period_credits) + addPool;

  await client.query(
    "UPDATE org_subscriptions SET seats = $1, period_credits = $2, updated_at = NOW() WHERE id = $3",
    [seatsAfter, periodAfter.toString(), row.id],
  );

  if (addPool > 0n) {
    await insertOrgPeriodLedger(client, {
      orgId,
      userId: operator,
      delta: addPool,
      balanceAfter: periodAfter,
      reason: "subscription",
      refId,
      memo: `add ${add} seats on ${row.plan_code} +${addPool} (seats ${row.seats}->${seatsAfter})`,
    });
  }

  return { seatsAfter, periodCreditsAfter: periodAfter };
}

// ─── 到期轮转 sweeper ─────────────────────────────────────────────────

/**
 * org 订阅到期轮转(cron 调用,并入 subscriptionRolloverSweeper 同 tick):扫
 * period_end < now 的 active 行,逐条**清零期内池 + 置 status='expired'**。
 *
 * 语义(方案 §11,org 无 free 档):
 *   - 清零 period_credits 并写 subscription_expire 负流水(经办人=owner,兜底 created_by)。
 *   - status='expired';**不降档、不动 org 钱包(orgs.credits)、不踢成员**(席位闸只拦新进)。
 * 钱安全:spend 四桶已按 period_end>NOW() 排除过期池,过期到轮转之间不可花。
 *
 * 并发安全:UPDATE ... FOR UPDATE SKIP LOCKED 认领,每行单 sweeper 处理。返回处理的 org_id 列表。
 */
export async function rolloverExpiredOrgSubscriptions(limit = 200): Promise<bigint[]> {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new TypeError(`limit must be in (0,10000], got ${limit}`);
  }

  return tx(async (client) => {
    const claimed = await client.query<{ id: string; org_id: string; period_credits: string }>(
      `SELECT id::text AS id, org_id::text AS org_id, period_credits::text AS period_credits
         FROM org_subscriptions
        WHERE status = 'active' AND period_end < NOW()
        ORDER BY period_end ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [limit],
    );
    const out: bigint[] = [];
    for (const row of claimed.rows) {
      const pool = BigInt(row.period_credits);
      if (pool > 0n) {
        const actor = await resolveOrgLedgerActor(client, row.org_id);
        if (actor) {
          await insertOrgPeriodLedger(client, {
            orgId: row.org_id,
            userId: actor,
            delta: -pool,
            balanceAfter: 0n,
            reason: "subscription_expire",
            refId: null,
            memo: `org subscription expired, cleared ${pool}`,
          });
        } else {
          // owner + created_by 皆空(理论不该发生):跳过审计流水,但仍清零/置 expired。
          // eslint-disable-next-line no-console
          console.warn(`[rolloverExpiredOrgSubscriptions] org ${row.org_id} has no ledger actor; clearing pool without audit row`);
        }
      }
      await client.query(
        "UPDATE org_subscriptions SET period_credits = 0, status = 'expired', updated_at = NOW() WHERE id = $1",
        [row.id],
      );
      out.push(BigInt(row.org_id));
    }
    return out;
  });
}
