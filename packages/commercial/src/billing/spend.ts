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
 * 死锁规避（全仓不变量）：任何同时锁两桶的事务，**一律先锁 users 再锁 user_subscriptions**。
 * 仅锁期内桶的操作（订阅发放/轮转）不锁 users，故与本扣费路径无锁序环。
 *
 * BIGINT/bigint 贯穿，禁止 Number 化。
 */

import type { PoolClient } from "pg";
import { query } from "../db/queries.js";
import type { LedgerBucket, LedgerRef, LedgerReason } from "./ledger.js";

export interface SpendTwoBucketInput {
  userId: bigint | number | string;
  /** 期望扣费额（分/积分最小刻度），必须 > 0。 */
  amount: bigint;
  reason: LedgerReason;
  ref?: LedgerRef;
  memo?: string;
}

export interface SpendTwoBucketResult {
  /** 期望扣费额（入参 amount）。 */
  requested: bigint;
  /** 实扣额（= min(amount, 总可用)）。 */
  debited: bigint;
  /** true = 余额不足按可用扣完（实扣 < 期望）。 */
  clamped: boolean;
  /** 从期内桶扣的部分。 */
  fromPeriod: bigint;
  /** 从持久钱包扣的部分。 */
  fromWallet: bigint;
  /** 扣后期内桶余额。 */
  periodAfter: bigint;
  /** 扣后钱包余额。 */
  walletAfter: bigint;
  /** 扣后总可用（period + wallet）。 */
  totalAfter: bigint;
  /** 期内桶那条流水 id（无则 null）。 */
  ledgerPeriodId: bigint | null;
  /** 钱包那条流水 id（无则 null）。 */
  ledgerWalletId: bigint | null;
  /** 供 usage_records.ledger_id 关联的主流水：优先钱包行，否则期内桶行，否则 null。 */
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
    delta: bigint;
    balanceAfter: bigint;
    reason: LedgerReason;
    bucket: LedgerBucket;
    ref?: LedgerRef;
    memo?: string;
  },
): Promise<bigint> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO credit_ledger
        (user_id, delta, balance_after, reason, bucket, ref_type, ref_id, memo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
    ],
  );
  return BigInt(r.rows[0].id);
}

/**
 * 在调用方既有事务内执行双钱包扣费（clamp 到可用总额，不抛余额不足）。
 *
 * 锁序：先 `SELECT credits FROM users FOR UPDATE`，再
 * `SELECT period_credits FROM user_subscriptions WHERE status='active' FOR UPDATE`。
 * 先扣期内桶后扣钱包；各桶分别写 credit_ledger（balance_after = 该桶扣后值）。
 */
export async function spendTwoBucket(
  client: PoolClient,
  input: SpendTwoBucketInput,
): Promise<SpendTwoBucketResult> {
  if (input.amount <= 0n) throw new TypeError(`amount must be > 0, got ${input.amount}`);
  const uid = normUid(input.userId);

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

  const total = period + wallet;
  const debited = input.amount < total ? input.amount : total;
  const clamped = debited < input.amount;
  const fromPeriod = debited < period ? debited : period;
  const fromWallet = debited - fromPeriod;
  const periodAfter = period - fromPeriod;
  const walletAfter = wallet - fromWallet;

  // 余额不足按可用扣完时，ledger memo 标 clamped + 原始请求/总额，保留持久审计（回归修复）。
  const memo = clamped
    ? `${input.memo ?? ""} clamped requested=${input.amount} total=${total}`.trim()
    : input.memo;

  let ledgerPeriodId: bigint | null = null;
  let ledgerWalletId: bigint | null = null;

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
    fromPeriod,
    fromWallet,
    periodAfter,
    walletAfter,
    totalAfter: periodAfter + walletAfter,
    ledgerPeriodId,
    ledgerWalletId,
    primaryLedgerId: ledgerWalletId ?? ledgerPeriodId,
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
