/**
 * 0096 — 双钱包扣费收口（period_credits 期内桶 → users.credits 持久钱包）。
 *
 * 背景见 db/migrations/0096_subscription_billing.sql：v5 引入月度订阅后，可消费余额分两桶：
 *   · 期内桶 user_subscriptions.period_credits —— 当期套餐额度 + 期内加量包，扣费优先消耗、
 *     周期轮转清零重置。
 *   · 持久钱包 users.credits —— 存量充值/欢迎金/旧资产，永不自动过期。
 *
 * 本模块是**所有真实扣费的唯一收口**（chat finalize / minimax media / 未来其它 spend）：
 *   - `spendTwoBucket(client, …)`  在调用方既有 tx 内执行：锁两桶 → 先扣期内桶再扣钱包 →
 *     按桶各写一条 credit_ledger（balance_after = 该桶扣后值）→ 返回明细。**clamp 到可用总额**
 *     （余额不足不抛错，按可用扣完——对齐 proxyBilling 既有 clamp 语义：流已交付，字节回不来）。
 *   - `getSpendableBalance / getBalanceBreakdown` 只读：preCheck 预检与 /api/me 展示用「总可用」。
 *
 * 死锁规避（全仓不变量，全局锁序**单向**）：
 *   **orgs → org_subscriptions → users → user_subscriptions**（0115 企业版席位订阅扩入
 *   org_subscriptions,位于 orgs 之后、users 之前)。
 *   - 触 org 桶的扣费（传 orgId,0112/0115 企业版 org_period+org_wallet 优先桶）：先
 *     `SELECT credits FROM orgs WHERE id=$1 AND status='active' FOR UPDATE`,紧接
 *     `SELECT period_credits FROM org_subscriptions WHERE org_id=$1 AND status='active'
 *      AND period_end>NOW() FOR UPDATE`(谓词与个人期内桶同款,过期未轮转不可花),
 *     再锁 users、再锁 user_subscriptions。org 行不存在/非 active → 静默跳过 org 两桶,
 *     降级纯个人两桶（settle 解析与扣费之间 org 可能被停用,fail-open 保证"流已交付必须记账"）。
 *   - 纯个人扣费（无 orgId）：锁 users → user_subscriptions（org 层不参与,序仍单向)。
 *   - 仅锁期内桶的操作（个人/org 订阅发放/轮转）:个人只锁 user_subscriptions;org
 *     订阅发放/轮转锁 orgs→org_subscriptions(见 org/orgSubscriptions.ts),均是本序前缀,无环。
 *   - **任何未来新触 org 层的兄弟路径(refund/upgrade 等)必须把 orgs→org_subscriptions 锁在最前**。
 *
 * 扣费顺序（优先桶在前）：org_period → org_wallet → user_period → user_wallet
 *   （企业订阅池优先、企业钱包次之、个人期内桶再次、个人钱包兜底）。
 * clamp 语义不变：org+user 总额不足按可用扣完。
 *
 * BIGINT/bigint 贯穿，禁止 Number 化。
 */

import type { PoolClient } from "pg";
import { query } from "../db/queries.js";
import { sumMemberOrgMonthSpend } from "../org/orgBilling.js";
import type { LedgerBucket, LedgerRef, LedgerReason } from "./ledger.js";

export interface SpendTwoBucketInput {
  userId: bigint | number | string;
  /** 期望扣费额（分/积分最小刻度），必须 > 0。 */
  amount: bigint;
  reason: LedgerReason;
  ref?: LedgerRef;
  memo?: string;
  /**
   * org 桶（0112 org 钱包 + 0115 org 期内池，企业版优先桶）。传入即尝试先扣 org 桶。
   *   - org 行存在且 status='active' → 参与,`org_period → org_wallet → period → wallet` 顺序扣
   *     （org 期内池=席位订阅池,active+未过期才计入;org 钱包=充值兜底）。
   *   - org 行不存在 / 非 active → **静默跳过**（不抛错），降级为纯个人两桶
   *     （fail-open:settle 解析与扣费之间 org 可能被停用,已交付的流必须记账）。
   * 由 settle 收口从成员 active membership 推导(billing_enabled=true 才传),
   * 调用方**不接受客户端直传**(防越权花别的 org 钱)。
   */
  orgId?: bigint | number | string;
  /**
   * 成员月度 org 预算(§17.4,org_memberships.monthly_org_budget)。仅 orgId 参与时有意义:
   * 非 null 时 org 桶总可用额钳到 `min(org 期内池+org 钱包, max(0, budget - 本自然月已用))`,
   * org_period 优先耗尽再 org_wallet;预算耗尽 → org 两桶出 0,静默落个人桶(打戳不变、零报错)。
   * null / undefined = 不限(默认宽松)。由 settle 从 resolveOrgBillingContext 一并传入。
   */
  monthlyOrgBudget?: bigint | null;
}

export interface SpendTwoBucketResult {
  /** 期望扣费额（入参 amount）。 */
  requested: bigint;
  /** 实扣额（= min(amount, 总可用)）。 */
  debited: bigint;
  /** true = 余额不足按可用扣完（实扣 < 期望；含 org+个人总额不足）。 */
  clamped: boolean;
  /** 从 org 期内池（席位订阅，0115）扣的部分（org 桶未参与 / 无 active org 订阅则 0n）。 */
  fromOrgPeriod: bigint;
  /** 从 org 钱包扣的部分（org 桶未参与则 0n）。 */
  fromOrg: bigint;
  /** 从个人期内桶扣的部分。 */
  fromPeriod: bigint;
  /** 从持久钱包扣的部分。 */
  fromWallet: bigint;
  /** 扣后 org 期内池余额；org 桶未参与（无 orgId / org 非 active）→ null。 */
  orgPeriodAfter: bigint | null;
  /** 扣后 org 钱包余额；org 桶未参与（无 orgId / org 非 active）→ null。 */
  orgAfter: bigint | null;
  /** 扣后个人期内桶余额。 */
  periodAfter: bigint;
  /** 扣后钱包余额。 */
  walletAfter: bigint;
  /** 扣后**个人**总可用（period + wallet）。org 两桶不并入(归属主体不同)。 */
  totalAfter: bigint;
  /** org 期内池那条流水 id（无则 null）。 */
  ledgerOrgPeriodId: bigint | null;
  /** org 钱包那条流水 id（无则 null）。 */
  ledgerOrgId: bigint | null;
  /** 个人期内桶那条流水 id（无则 null）。 */
  ledgerPeriodId: bigint | null;
  /** 钱包那条流水 id（无则 null）。 */
  ledgerWalletId: bigint | null;
  /**
   * 供 usage_records.ledger_id 关联的主流水：钱包 → 个人期内桶 → org 钱包 → org 期内池 → null。
   * 个人位次零变（wallet→period 在前），org 两桶垫底（org_wallet→org_period），
   * 保证 org 独付（仅动 org 桶）时主流水仍非 null。
   */
  primaryLedgerId: bigint | null;
}

function normUid(userId: bigint | number | string): string {
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

async function insertLedger(
  client: PoolClient,
  args: {
    uid: string;
    /** org 桶流水的归属 org（bucket='org_wallet' 时非 null）；个人桶为 null。 */
    orgId?: string | null;
    delta: bigint;
    balanceAfter: bigint;
    reason: LedgerReason;
    bucket: LedgerBucket;
    ref?: LedgerRef;
    memo?: string;
  },
): Promise<bigint> {
  // org_id 追加到列尾(非插在 user_id 之后):保持既有 $1..$8 位次不变,避免打乱
  // 按参数位断言 credit_ledger INSERT 的既有测试(codex/bridge)。
  const r = await client.query<{ id: string }>(
    `INSERT INTO credit_ledger
        (user_id, delta, balance_after, reason, bucket, ref_type, ref_id, memo, org_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id::text AS id`,
    [
      args.uid,
      args.delta.toString(),
      args.balanceAfter.toString(),
      args.reason,
      args.bucket,
      args.ref?.type ?? null,
      args.ref?.id ?? null,
      args.memo ?? null,
      args.orgId ?? null,
    ],
  );
  return BigInt(r.rows[0].id);
}

/** org_id 严格归一化（来自服务端解析的 membership,恒为数字串）。 */
function normOrgId(orgId: bigint | number | string): string {
  if (typeof orgId === "bigint") return orgId.toString();
  if (typeof orgId === "number") {
    if (!Number.isInteger(orgId) || orgId <= 0) {
      throw new TypeError(`org_id must be positive integer, got ${orgId}`);
    }
    return String(orgId);
  }
  if (!/^\d+$/.test(orgId)) throw new TypeError(`org_id must be decimal digits, got ${orgId}`);
  return orgId;
}

/**
 * 在调用方既有事务内执行扣费（clamp 到可用总额，不抛余额不足）。
 *
 * 桶与锁序（全局单向 orgs → org_subscriptions → users → user_subscriptions）：
 *   0a) （orgId 存在时）`SELECT credits FROM orgs WHERE id=$1 AND status='active' FOR UPDATE`。
 *       无行 → 静默跳过 org 两桶（降级纯个人两桶,fail-open）。
 *   0b) （org 参与时）`SELECT period_credits FROM org_subscriptions WHERE org_id=$1 AND
 *       status='active' AND period_end>NOW() FOR UPDATE`（过期未轮转不可花,谓词同个人期内桶）。
 *   1) `SELECT credits FROM users FOR UPDATE`（持久钱包）。
 *   2) `SELECT period_credits FROM user_subscriptions WHERE status='active' AND period_end>NOW() FOR UPDATE`。
 * 扣费顺序 org_period → org_wallet → period → wallet；各桶分别写 credit_ledger（balance_after=该桶
 * 扣后值,org 两桶行带 org_id + user_id=消费成员）。
 */
export async function spendTwoBucket(
  client: PoolClient,
  input: SpendTwoBucketInput,
): Promise<SpendTwoBucketResult> {
  if (input.amount <= 0n) throw new TypeError(`amount must be > 0, got ${input.amount}`);
  const uid = normUid(input.userId);

  // 0a) （org 桶）锁 org 钱包 —— **锁序最前**。org 不存在/非 active → 不参与(orgParticipates=false),
  //     降级为纯个人两桶(fail-open:流已交付必须记账)。
  let orgId: string | null = null;
  let orgParticipates = false;
  let orgCredits = 0n;
  if (input.orgId !== undefined) {
    orgId = normOrgId(input.orgId);
    const oRow = await client.query<{ credits: string }>(
      "SELECT credits::text AS credits FROM orgs WHERE id = $1::bigint AND status = 'active' FOR UPDATE",
      [orgId],
    );
    if (oRow.rows.length > 0) {
      orgParticipates = true;
      orgCredits = BigInt(oRow.rows[0].credits);
    }
  }

  // 0b) （org 参与时）锁 org 期内池（**仅 active 且未过期**的席位订阅,0115）。锁序紧接 orgs、
  //     先于 users —— 全局单向 orgs → org_subscriptions → users → user_subscriptions。
  //     过期但 sweeper 未轮转的行不计入可用(谓词 period_end>NOW(),同个人期内桶,防到期后花旧池)。
  let orgSubId: string | null = null;
  let orgPeriod = 0n;
  if (orgParticipates && orgId !== null) {
    const osRow = await client.query<{ id: string; period_credits: string }>(
      `SELECT id::text AS id, period_credits::text AS period_credits
         FROM org_subscriptions
        WHERE org_id = $1::bigint AND status = 'active' AND period_end > NOW()
        FOR UPDATE`,
      [orgId],
    );
    orgSubId = osRow.rows[0]?.id ?? null;
    orgPeriod = osRow.rows[0] ? BigInt(osRow.rows[0].period_credits) : 0n;
  }

  // 0c) 成员月度 org 预算钳制（§17.4）。budget 非 null 且 org 参与时:
  //     org 两桶总可用额 = min(org 资金, max(0, budget - 本自然月已用))。
  //     SUM 走 0118 idx_cl_org_user_time(org_id,user_id,created_at),在本 tx 内点查
  //     (与扣费/写流水同事务,读到的月度已用不含本 turn 未提交的负 delta,正确)。
  //     预算耗尽 → orgSpendCap=0 → org 两桶出 0,静默落个人桶(usage_records.org_id 打戳在
  //     settle 侧、与桶解耦,故"打戳不变")。budget 为 null → orgSpendCap=null(不限)。
  let orgSpendCap: bigint | null = null;
  if (orgParticipates && orgId !== null && input.monthlyOrgBudget != null) {
    const budget = input.monthlyOrgBudget;
    if (budget > 0n) {
      const monthSpent = await sumMemberOrgMonthSpend(client, orgId, uid);
      const remaining = budget - monthSpent;
      orgSpendCap = remaining > 0n ? remaining : 0n;
    } else {
      // 防御:预算非正(数据层 CHECK 已挡 <=0,此处兜底)→ 不给 org 桶花。
      orgSpendCap = 0n;
    }
  }

  // 1) 锁钱包（持久）
  const wRow = await client.query<{ credits: string }>(
    "SELECT credits::text AS credits FROM users WHERE id = $1 FOR UPDATE",
    [uid],
  );
  if (wRow.rows.length === 0) throw new TypeError(`user not found: ${uid}`);
  const wallet = BigInt(wRow.rows[0].credits);

  // 2) 锁期内桶（**仅 active 且未过期**的订阅）。已过期但 sweeper 未轮转的行不计入可用——
  //    否则到期后到 sweeper 跑之间会留下"继续花旧套餐/加量包额度"的窗口（钱安全）。
  const sRow = await client.query<{ id: string; period_credits: string }>(
    `SELECT id::text AS id, period_credits::text AS period_credits
       FROM user_subscriptions
      WHERE user_id = $1 AND status = 'active' AND period_end > NOW()
      FOR UPDATE`,
    [uid],
  );
  const subId = sRow.rows[0]?.id ?? null;
  const period = sRow.rows[0] ? BigInt(sRow.rows[0].period_credits) : 0n;

  // 可用总额 = org 期内池 + org 钱包(均 org 参与时,且经预算钳制) + 个人期内桶 + 个人钱包;
  // 扣费顺序（瀑布）org_period → org_wallet → period → wallet。
  // 预算钳制(§17.4):org 两桶总可用 = min(orgPeriod+orgCredits, orgSpendCap),org_period 优先耗;
  // orgSpendCap=null → 不限(等价旧行为)。钳制只缩 org 桶,个人桶不受影响(超限落个人桶)。
  const orgPeriodRaw = orgParticipates ? orgPeriod : 0n;
  const orgWalletRaw = orgParticipates ? orgCredits : 0n;
  const orgTotalRaw = orgPeriodRaw + orgWalletRaw;
  const orgTotalAvail =
    orgSpendCap === null ? orgTotalRaw : orgTotalRaw < orgSpendCap ? orgTotalRaw : orgSpendCap;
  const orgPeriodAvail = orgTotalAvail < orgPeriodRaw ? orgTotalAvail : orgPeriodRaw;
  const orgWalletAvail = orgTotalAvail - orgPeriodAvail;
  const total = orgPeriodAvail + orgWalletAvail + period + wallet;
  const debited = input.amount < total ? input.amount : total;
  const clamped = debited < input.amount;
  let rem = debited;
  const fromOrgPeriod = rem < orgPeriodAvail ? rem : orgPeriodAvail;
  rem -= fromOrgPeriod;
  const fromOrg = rem < orgWalletAvail ? rem : orgWalletAvail;
  rem -= fromOrg;
  const fromPeriod = rem < period ? rem : period;
  rem -= fromPeriod;
  const fromWallet = rem; // 保证 rem <= wallet（total 已含 wallet）
  const orgPeriodAfter = orgParticipates ? orgPeriod - fromOrgPeriod : null;
  const orgAfter = orgParticipates ? orgCredits - fromOrg : null;
  const periodAfter = period - fromPeriod;
  const walletAfter = wallet - fromWallet;

  // 余额不足按可用扣完时，ledger memo 标 clamped + 原始请求/总额，保留持久审计（回归修复）。
  const memo = clamped
    ? `${input.memo ?? ""} clamped requested=${input.amount} total=${total}`.trim()
    : input.memo;

  let ledgerOrgPeriodId: bigint | null = null;
  let ledgerOrgId: bigint | null = null;
  let ledgerPeriodId: bigint | null = null;
  let ledgerWalletId: bigint | null = null;

  if (fromOrgPeriod > 0n && orgSubId && orgId !== null) {
    await client.query(
      "UPDATE org_subscriptions SET period_credits = $1, updated_at = NOW() WHERE id = $2",
      [(orgPeriodAfter as bigint).toString(), orgSubId],
    );
    ledgerOrgPeriodId = await insertLedger(client, {
      uid, // 消费成员(经办人),org 桶归属由 orgId 列表达
      orgId,
      delta: -fromOrgPeriod,
      balanceAfter: orgPeriodAfter as bigint,
      reason: input.reason,
      bucket: "org_period",
      ref: input.ref,
      memo,
    });
  }
  if (fromOrg > 0n && orgParticipates && orgId !== null) {
    await client.query(
      "UPDATE orgs SET credits = $1, updated_at = NOW() WHERE id = $2::bigint",
      [(orgAfter as bigint).toString(), orgId],
    );
    ledgerOrgId = await insertLedger(client, {
      uid, // 消费成员(经办人),org 桶归属由 orgId 列表达
      orgId,
      delta: -fromOrg,
      balanceAfter: orgAfter as bigint,
      reason: input.reason,
      bucket: "org_wallet",
      ref: input.ref,
      memo,
    });
  }
  if (fromPeriod > 0n && subId) {
    await client.query(
      "UPDATE user_subscriptions SET period_credits = $1, updated_at = NOW() WHERE id = $2",
      [periodAfter.toString(), subId],
    );
    ledgerPeriodId = await insertLedger(client, {
      uid,
      delta: -fromPeriod,
      balanceAfter: periodAfter,
      reason: input.reason,
      bucket: "period",
      ref: input.ref,
      memo,
    });
  }
  if (fromWallet > 0n) {
    await client.query("UPDATE users SET credits = $1 WHERE id = $2", [walletAfter.toString(), uid]);
    ledgerWalletId = await insertLedger(client, {
      uid,
      delta: -fromWallet,
      balanceAfter: walletAfter,
      reason: input.reason,
      bucket: "wallet",
      ref: input.ref,
      memo,
    });
  }

  return {
    requested: input.amount,
    debited,
    clamped,
    fromOrgPeriod,
    fromOrg,
    fromPeriod,
    fromWallet,
    orgPeriodAfter,
    orgAfter,
    periodAfter,
    walletAfter,
    totalAfter: periodAfter + walletAfter,
    ledgerOrgPeriodId,
    ledgerOrgId,
    ledgerPeriodId,
    ledgerWalletId,
    // usage_records.ledger_id 主流水关联:钱包 → 个人期内桶 → org 钱包 → org 期内池
    //（个人位次零变、org 桶垫底,保证 org 独付时也非 null）。
    primaryLedgerId: ledgerWalletId ?? ledgerPeriodId ?? ledgerOrgId ?? ledgerOrgPeriodId,
  };
}

export interface BalanceBreakdown {
  /** 持久钱包（users.credits）。 */
  wallet: bigint;
  /** 当期套餐期内桶（无 active 订阅时 0）。 */
  period: bigint;
  /** 总可用（wallet + period）。 */
  total: bigint;
}

/**
 * 读总可用余额明细（无锁快照，仅用于展示/软预检）。
 * active 订阅的 period_credits + users.credits。
 */
export async function getBalanceBreakdown(
  userId: bigint | number | string,
): Promise<BalanceBreakdown> {
  const uid = normUid(userId);
  const r = await query<{ wallet: string; period: string }>(
    `SELECT u.credits::text AS wallet,
            COALESCE(us.period_credits, 0)::text AS period
       FROM users u
       LEFT JOIN user_subscriptions us
         ON us.user_id = u.id AND us.status = 'active' AND us.period_end > NOW()
      WHERE u.id = $1`,
    [uid],
  );
  if (r.rows.length === 0) throw new TypeError(`user not found: ${uid}`);
  const wallet = BigInt(r.rows[0].wallet);
  const period = BigInt(r.rows[0].period);
  return { wallet, period, total: wallet + period };
}

/** 总可用余额（period + wallet）。preCheck 软预检与对话前置门用。 */
export async function getSpendableBalance(
  userId: bigint | number | string,
): Promise<bigint> {
  return (await getBalanceBreakdown(userId)).total;
}
