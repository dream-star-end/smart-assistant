/**
 * T-22 — 流水 + 余额(事务)。
 *
 * 三个原子操作,全部走 `tx()`:
 *   - debit(user, amount, reason, ref, memo?)  扣积分,余额不足抛 InsufficientCreditsError
 *   - credit(user, amount, reason, ref, memo?) 加积分
 *   - adminAdjust(user, delta, memo, admin)    可正可负,同时写 admin_audit
 *
 * Invariants:
 *   - **BIGINT / BigInt 贯穿**。pg driver 把 BIGINT 按 string 返回,我们在边界一次性转 bigint,
 *     绝不经 Number。`amount` / `delta` 必须是 bigint。
 *   - `SELECT credits FROM users WHERE id=$1 FOR UPDATE` —— 行锁直到事务结束,
 *     保证并发场景下余额读 → 校验 → UPDATE 的原子性。NOWAIT 会导致第二个事务
 *     立即失败,默认行为(阻塞等待)才能让"10 个并发 debit,5 个成功 5 个失败
 *     (ERR_INSUFFICIENT_CREDITS)"的语义成立。
 *   - ledger.balance_after 写的是"扣/加之后"的真实余额(users.credits 更新后那一份),
 *     不是"扣之前"或"当前 read 的"。consumer-side 审计时可单调校验。
 *   - credit_ledger RULE 禁了 UPDATE/DELETE:这里只做 INSERT,禁止任何 update 路径(测试里也验)。
 *   - amount 必须 > 0(debit/credit 都是)。adminAdjust.delta 必须 ≠ 0,但允许正负。
 *     (delta=0 既没意义也会让 audit trail 出噪声,直接拒)
 *   - reason 必须在 schema 的 CHECK 白名单里;类型系统 + DB CHECK 双保险。
 *
 * 错误模型:
 *   - 不走 HttpError —— 本模块是 billing 核心,可能在 chat/agent 两个上游使用,
 *     上游自己决定状态码。这里只抛 `InsufficientCreditsError`(名字暴露 code),
 *     调用方捕获后映射到 402/403/etc.
 *   - 非法入参(负数 / 越界 / reason 不在白名单)抛 TypeError — 这是调用方 bug。
 */

import type { PoolClient } from "pg";
import { tx, query as rootQuery } from "../db/queries.js";

/** credit_ledger.reason 的 CHECK 白名单,和 0002 迁移保持同步。 */
export const LEDGER_REASONS = [
  "topup",
  "chat",
  "agent_chat",
  "agent_subscription",
  "refund",
  "admin_adjust",
  "promotion",
] as const;
export type LedgerReason = (typeof LEDGER_REASONS)[number];

export interface LedgerRef {
  /** e.g. 'usage_record' | 'order' | 'agent_sub' | 'refund' | null */
  type?: string | null;
  /** 对应外部系统的主键 / 订单号;长度不限但建议 < 64。 */
  id?: string | null;
}

export interface DebitResult {
  /** 写入 credit_ledger 后返回的自增主键,下游 usage_records.ledger_id 用它。 */
  ledger_id: bigint;
  /** 扣/加后 users.credits 的真实值(和 ledger.balance_after 一致)。 */
  balance_after: bigint;
}

/** 扣费失败专用错误:余额不足。code 固定 ERR_INSUFFICIENT_CREDITS。 */
export class InsufficientCreditsError extends Error {
  readonly code = "ERR_INSUFFICIENT_CREDITS" as const;
  /** 当前可用余额(事务内读到的值)。 */
  readonly balance: bigint;
  /** 本次想扣的值。 */
  readonly required: bigint;
  /** 差额(required - balance),方便前端直接展示 "还差 X 积分"。 */
  readonly shortfall: bigint;
  constructor(balance: bigint, required: bigint) {
    super(`insufficient credits: balance=${balance} required=${required}`);
    this.name = "InsufficientCreditsError";
    this.balance = balance;
    this.required = required;
    this.shortfall = required - balance;
  }
}

function assertReason(reason: string): asserts reason is LedgerReason {
  if (!(LEDGER_REASONS as ReadonlyArray<string>).includes(reason)) {
    throw new TypeError(`unknown ledger reason: ${reason}`);
  }
}

function normalizeUserId(userId: bigint | number | string): string {
  // users.id 是 BIGINT,pg driver 以 string 返回 —— 我们也保留 string 存储式传递,
  // 这样 $1 绑定对 pg 来说是最直观的(不用 cast)。bigint 入参转 string 保持一致。
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

function assertPositive(name: string, v: bigint): void {
  if (v <= 0n) throw new TypeError(`${name} must be > 0, got ${v}`);
}

function assertNonZero(name: string, v: bigint): void {
  if (v === 0n) throw new TypeError(`${name} must be != 0`);
}

/**
 * 事务内:扣用户积分,写 ledger。余额不足抛 InsufficientCreditsError。
 *
 * @param userId  users.id
 * @param amount  **正数**,以"分"为单位(积分的最小刻度)。
 * @param reason  ledger 白名单之一。chat/agent 分不同 reason,便于分维度报表。
 * @param ref     { type, id } 关联对象(可 null)。e.g. `{ type: 'usage_record', id: '42' }`
 * @param memo    可选备注。管理员调整写原因,普通 debit 可留空。
 */
export async function debit(
  userId: bigint | number | string,
  amount: bigint,
  reason: LedgerReason,
  ref: LedgerRef = {},
  memo?: string,
): Promise<DebitResult> {
  assertReason(reason);
  assertPositive("amount", amount);
  const uid = normalizeUserId(userId);

  return tx(async (client) => {
    const before = await client.query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id = $1 FOR UPDATE",
      [uid],
    );
    if (before.rows.length === 0) {
      throw new TypeError(`user not found: ${uid}`);
    }
    const balance = BigInt(before.rows[0].credits);
    if (balance < amount) {
      // 事务未 COMMIT;RollBack 会发生在 tx() 的 catch 分支。行锁随之释放。
      throw new InsufficientCreditsError(balance, amount);
    }
    const newBalance = balance - amount;
    await client.query(
      "UPDATE users SET credits = $1 WHERE id = $2",
      [newBalance.toString(), uid],
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO credit_ledger
        (user_id, delta, balance_after, reason, ref_type, ref_id, memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id::text AS id`,
      [
        uid,
        (-amount).toString(),
        newBalance.toString(),
        reason,
        ref.type ?? null,
        ref.id ?? null,
        memo ?? null,
      ],
    );
    return {
      ledger_id: BigInt(inserted.rows[0].id),
      balance_after: newBalance,
    };
  });
}

/**
 * 事务内:加用户积分,写 ledger。amount 必须 > 0(用 adminAdjust 做负值调整)。
 */
export async function credit(
  userId: bigint | number | string,
  amount: bigint,
  reason: LedgerReason,
  ref: LedgerRef = {},
  memo?: string,
): Promise<DebitResult> {
  assertReason(reason);
  assertPositive("amount", amount);
  const uid = normalizeUserId(userId);

  return tx(async (client) => {
    const before = await client.query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id = $1 FOR UPDATE",
      [uid],
    );
    if (before.rows.length === 0) {
      throw new TypeError(`user not found: ${uid}`);
    }
    const balance = BigInt(before.rows[0].credits);
    const newBalance = balance + amount;
    await client.query(
      "UPDATE users SET credits = $1 WHERE id = $2",
      [newBalance.toString(), uid],
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO credit_ledger
        (user_id, delta, balance_after, reason, ref_type, ref_id, memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id::text AS id`,
      [
        uid,
        amount.toString(),
        newBalance.toString(),
        reason,
        ref.type ?? null,
        ref.id ?? null,
        memo ?? null,
      ],
    );
    return {
      ledger_id: BigInt(inserted.rows[0].id),
      balance_after: newBalance,
    };
  });
}

export interface AdminAdjustResult extends DebitResult {
  /** 写入 admin_audit 的主键,方便排查。 */
  audit_id: bigint;
}

/**
 * 管理员手工调整积分(可正可负)。同事务内写 admin_audit。
 *
 * 规则:
 *   - delta != 0(0 没意义,直接拒)
 *   - delta < 0 且余额不足 → InsufficientCreditsError(同 debit)
 *   - memo 必传、非空(审计合规硬要求)
 *   - admin_id 必须存在 users 表且 role='admin' —— 这里不校验 role(上游路由层已过 isAdmin),
 *     但 FK(users.id)由 admin_audit 的外键保证存在
 */
export async function adminAdjust(
  userId: bigint | number | string,
  delta: bigint,
  memo: string,
  adminId: bigint | number | string,
  ref: LedgerRef = {},
  ip: string | null = null,
  userAgent: string | null = null,
): Promise<AdminAdjustResult> {
  assertNonZero("delta", delta);
  if (!memo || memo.trim().length === 0) {
    throw new TypeError("adminAdjust: memo is required (non-empty)");
  }
  const uid = normalizeUserId(userId);
  const aid = normalizeUserId(adminId);

  return tx(async (client) => {
    const before = await client.query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id = $1 FOR UPDATE",
      [uid],
    );
    if (before.rows.length === 0) {
      throw new TypeError(`user not found: ${uid}`);
    }
    const balance = BigInt(before.rows[0].credits);
    const newBalance = balance + delta;
    if (newBalance < 0n) {
      // 负调整不能把余额打成负数 —— 语义上等同"余额不足以扣"
      throw new InsufficientCreditsError(balance, -delta);
    }
    await client.query(
      "UPDATE users SET credits = $1 WHERE id = $2",
      [newBalance.toString(), uid],
    );
    const ledgerRow = await client.query<{ id: string }>(
      `INSERT INTO credit_ledger
        (user_id, delta, balance_after, reason, ref_type, ref_id, memo)
       VALUES ($1, $2, $3, 'admin_adjust', $4, $5, $6)
       RETURNING id::text AS id`,
      [
        uid,
        delta.toString(),
        newBalance.toString(),
        ref.type ?? null,
        ref.id ?? null,
        memo,
      ],
    );
    const ledgerId = BigInt(ledgerRow.rows[0].id);

    // admin_audit: before / after 只存受影响的 credits 字段 —— 完整 user 快照太大,
    // 且审计目的是 "看这次调整改了什么",credits 前后值已足够复核。
    const auditRow = await client.query<{ id: string }>(
      `INSERT INTO admin_audit
        (admin_id, action, target, before, after, ip, user_agent)
       VALUES ($1, 'credits.adjust', $2, $3::jsonb, $4::jsonb, $5, $6)
       RETURNING id::text AS id`,
      [
        aid,
        `user:${uid}`,
        JSON.stringify({ credits: balance.toString() }),
        JSON.stringify({
          credits: newBalance.toString(),
          delta: delta.toString(),
          memo,
          ledger_id: ledgerId.toString(),
        }),
        ip,
        userAgent,
      ],
    );
    return {
      ledger_id: ledgerId,
      balance_after: newBalance,
      audit_id: BigInt(auditRow.rows[0].id),
    };
  });
}

// ----------- 读路径辅助(不在事务里,只读当前快照) -----------

/** 当前余额。注意这是无锁读,多线程环境下仅用于展示,不能用于决策。 */
export async function getBalance(userId: bigint | number | string): Promise<bigint> {
  const uid = normalizeUserId(userId);
  const r = await rootQuery<{ credits: string }>(
    "SELECT credits::text AS credits FROM users WHERE id = $1",
    [uid],
  );
  if (r.rows.length === 0) throw new TypeError(`user not found: ${uid}`);
  return BigInt(r.rows[0].credits);
}

/**
 * 读用户的 ledger 流水(按时间倒序)。分页参数 limit + created_before。
 * 仅用于前端 "账户" 页;无锁读。
 */
export interface LedgerRow {
  id: bigint;
  user_id: bigint;
  delta: bigint;
  balance_after: bigint;
  reason: LedgerReason;
  ref_type: string | null;
  ref_id: string | null;
  memo: string | null;
  created_at: Date;
}

export async function listLedger(
  userId: bigint | number | string,
  opts: { limit?: number; before?: Date } = {},
): Promise<LedgerRow[]> {
  const uid = normalizeUserId(userId);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const before = opts.before ?? null;
  // 注意:这里按 `id DESC`(而不是 created_at DESC)。原因:
  //   created_at = transaction_timestamp(),是 tx BEGIN 时的时间,不是 INSERT 时间。
  //   在并发场景下,先 BEGIN 后拿锁 commit 的 tx 反而会有更早的 created_at,排序会错。
  //   id 是 BIGSERIAL,在 FOR UPDATE 串行化前提下严格跟 commit 顺序一致。
  // created_at 依然保留给"用户感知时间"展示,但不用它排序。
  const sql = before
    ? `SELECT id::text AS id, user_id::text AS user_id, delta::text AS delta,
              balance_after::text AS balance_after, reason, ref_type, ref_id, memo, created_at
         FROM credit_ledger
        WHERE user_id = $1 AND created_at < $2
        ORDER BY id DESC
        LIMIT $3`
    : `SELECT id::text AS id, user_id::text AS user_id, delta::text AS delta,
              balance_after::text AS balance_after, reason, ref_type, ref_id, memo, created_at
         FROM credit_ledger
        WHERE user_id = $1
        ORDER BY id DESC
        LIMIT $2`;
  const params: unknown[] = before ? [uid, before, limit] : [uid, limit];
  const r = await rootQuery<{
    id: string; user_id: string; delta: string; balance_after: string;
    reason: string; ref_type: string | null; ref_id: string | null;
    memo: string | null; created_at: Date;
  }>(sql, params);
  return r.rows.map((row) => ({
    id: BigInt(row.id),
    user_id: BigInt(row.user_id),
    delta: BigInt(row.delta),
    balance_after: BigInt(row.balance_after),
    reason: row.reason as LedgerReason,
    ref_type: row.ref_type,
    ref_id: row.ref_id,
    memo: row.memo,
    created_at: row.created_at,
  }));
}

// 内部辅助(暂未导出给外部,保留给 T-23 预检里直接在事务内 lock + debit)
export type TxClient = PoolClient;
