/**
 * Turn 级免单退款(boss 2026-07-02:模型无响应/超时不扣费)。
 *
 * 背景:计费权威在 master 代理层、按上游请求逐笔 finalize;而"用户这轮到底有没有
 * 收到响应"只有容器 gateway 的 turn 视角知道。两个权威天然错位 —— 一轮 turn 内
 * 若干请求各自"成功"扣了费,但 turn 最终 idle-timeout 被杀、用户什么都没拿到
 * (典型:Ark/glm 缓冲 tool_use 导致 gateway 5min 无输出判死,上游那笔却按 final
 * 结算)。零输出免单(proxyBilling waivedNoOutput)拦不住这种"有产出但没送达"。
 *
 * 本模块是补偿侧收口:按 (userId, ccb sessionId, turn 起始时间) 圈定该 turn 的
 * 已扣费 usage_records,逐笔**按原扣费桶精确冲正**(credit_ledger 里有按桶的负 delta
 * 原始行,reason='refund' 正 delta 写回)。
 *
 * 不变量:
 *   - **对称性(退款 = 扣费的逆运算)**:spendTwoBucket 按四桶瀑布扣费
 *     (org_period → org_wallet → user_period → user_wallet),退款必须退回**原桶**。
 *     org 桶(org_wallet/org_period)一律退回其 org(由 credit_ledger.org_id 定位),
 *     **严禁退进个人持久钱包** —— 否则等于把企业池的钱铸造成成员个人积分(资损 +
 *     跨主体套现向量:成员循环"真花 org 池 → 报 idle 超时"抽走企业额度)。org 已停用/
 *     无 active 订阅且无 org 钱包可退时,该行**跳过不退 + 告警交人工**,绝不落个人钱包。
 *   - **幂等**:per-user pg_advisory_xact_lock 串行化 + 事务内查已有 refund 行
 *     (reason='refund' AND ref_type='usage_record' AND ref_id=usageId)跳过。
 *     锁到 commit 才释放,并发第二笔进来时必能看到第一笔的 refund 行。
 *   - **锁序**:orgs → org_subscriptions → users → user_subscriptions(全局单向锁序,
 *     与 spendTwoBucket 完全一致,防死锁;多 org 时 org_id 升序锁)。
 *   - **桶语义**:period 部分优先退回当前 active 且未过期的订阅期内桶(它到期仍会清零,
 *     不构成永久资产泄漏);无 active 有效订阅(已到期/取消/未轮转)则退到钱包,memo 标注改道。
 *     org_period 同理:无 active 有效 org 订阅则改道退回 org 持久钱包。
 *   - BIGINT 贯穿,不经 Number。
 */

import type { Pool, PoolClient } from "pg";
import { rootLogger, type Logger } from "../logging/logger.js";

export interface RefundSessionWindowInput {
  userId: bigint;
  /** LLM metadata 口径的会话 id(= usage_records.session_id,CCB 内部会话 UUID)。 */
  sessionId: string;
  /** turn 起始时间(ms epoch)。只退这之后 settle 的记录。 */
  sinceMs: number;
  /** 落进 refund ledger memo,标注免单原因(如 waive:idle_timeout)。 */
  memo: string;
  logger?: Logger;
}

export interface RefundSessionWindowResult {
  /** 实际退回积分总额(0 = 窗口内无可退记录)。 */
  refundedCredits: bigint;
  /** 冲正覆盖的 usage_records 条数。 */
  recordCount: number;
  /** 退回后总可用(钱包 + active 期内桶);无退款时为 null(未加锁读取,不提供)。 */
  totalAfter: bigint | null;
  /**
   * org 桶无法退回(org 已停用且无可退目标)而跳过的额度总和。>0 表示有 org 退款
   * 落空,需人工核对(调用方应上报 metric/告警)。
   */
  skippedOrgCredits: bigint;
}

type LedgerBucketRow = "wallet" | "period" | "org_wallet" | "org_period";

interface DebitRow {
  usage_id: string;
  bucket: LedgerBucketRow;
  delta: string; // 负数(原扣费行)
  org_id: string | null;
}

interface OrgLock {
  /** org 持久钱包余额;null = org 非 active(不可退)。 */
  credits: bigint | null;
  credits0: bigint | null;
  /** org 当前 active 且未过期的订阅期内桶;null = 无。 */
  sub: { id: string; period: bigint; period0: bigint } | null;
}

export async function refundSessionWindow(
  pool: Pool,
  input: RefundSessionWindowInput,
): Promise<RefundSessionWindowResult> {
  const log = (input.logger ?? rootLogger).child({ subsys: "billingRefund" });
  const uid = input.userId.toString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // per-user 串行化:并发 waive(多 turn / 重试)排队走,后到者事务内能看到
    // 先到者已提交的 refund 行,dedupe 查询因此完备。
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`turn-waive:${uid}`]);

    // 1) 圈定窗口内已扣费记录,连同各自的原始扣费 ledger 行(按桶 + org 归属),排除已退过的。
    const rows = await client.query<DebitRow>(
      `SELECT ur.id::text AS usage_id, cl.bucket, cl.delta::text AS delta, cl.org_id::text AS org_id
         FROM usage_records ur
         JOIN credit_ledger cl
           ON cl.ref_type = 'usage_record' AND cl.ref_id = ur.id::text
          AND cl.user_id = ur.user_id AND cl.delta < 0
        WHERE ur.user_id = $1
          AND ur.session_id = $2
          AND ur.created_at >= to_timestamp($3::double precision / 1000.0)
          AND ur.status = 'success'
          AND ur.cost_credits > 0
          AND NOT EXISTS (
            SELECT 1 FROM credit_ledger r
             WHERE r.user_id = ur.user_id AND r.reason = 'refund'
               AND r.ref_type = 'usage_record' AND r.ref_id = ur.id::text
          )
        ORDER BY ur.id`,
      [uid, input.sessionId, input.sinceMs],
    );
    if (rows.rowCount === 0) {
      await client.query("ROLLBACK");
      return { refundedCredits: 0n, recordCount: 0, totalAfter: null, skippedOrgCredits: 0n };
    }

    // 2) 按锁序加锁:orgs → org_subscriptions → users → user_subscriptions(与 spendTwoBucket 一致)。
    // 2a) 先锁涉及的所有 org(org_id 升序,防多 org 退款互相死锁;谓词 status='active' 同 spend)。
    const orgIds = [
      ...new Set(
        rows.rows
          .filter((r) => (r.bucket === "org_wallet" || r.bucket === "org_period") && r.org_id)
          .map((r) => r.org_id as string),
      ),
    ].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    const orgLocks = new Map<string, OrgLock>();
    for (const oid of orgIds) {
      const o = await client.query<{ credits: string }>(
        "SELECT credits::text AS credits FROM orgs WHERE id = $1::bigint AND status = 'active' FOR UPDATE",
        [oid],
      );
      const c = o.rowCount ? BigInt(o.rows[0]!.credits) : null;
      orgLocks.set(oid, { credits: c, credits0: c, sub: null });
    }
    // 2b) 再锁各 org 的 active 且未过期订阅(谓词与 spend org 期内桶同款)。
    for (const oid of orgIds) {
      const s = await client.query<{ id: string; period_credits: string }>(
        `SELECT id::text AS id, period_credits::text AS period_credits
           FROM org_subscriptions
          WHERE org_id = $1::bigint AND status = 'active' AND period_end > NOW()
          ORDER BY id DESC LIMIT 1
          FOR UPDATE`,
        [oid],
      );
      if (s.rowCount) {
        const p = BigInt(s.rows[0]!.period_credits);
        orgLocks.get(oid)!.sub = { id: s.rows[0]!.id, period: p, period0: p };
      }
    }
    // 2c) users 持久钱包。
    const walletSel = await client.query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id = $1 FOR UPDATE",
      [uid],
    );
    if (walletSel.rowCount === 0) {
      throw new Error(`refund: user ${uid} not found`);
    }
    let wallet = BigInt(walletSel.rows[0]!.credits);
    // 2d) user_subscriptions:active 且未过期(与 spend 谓词对齐 —— 修 P1-1:原仅 status='active'
    //     可能选中已过期未轮转的行,退款打进去被 sweeper 清零蒸发)。
    const subSel = await client.query<{ id: string; period_credits: string }>(
      `SELECT id::text AS id, period_credits::text AS period_credits
         FROM user_subscriptions
        WHERE user_id = $1 AND status = 'active' AND period_end > NOW()
        ORDER BY id DESC LIMIT 1
        FOR UPDATE`,
      [uid],
    );
    const activeSub = subSel.rowCount === 0 ? null : subSel.rows[0]!;
    let period = activeSub ? BigInt(activeSub.period_credits) : 0n;

    // 3) 逐 usage 记录、逐桶按原桶冲正。
    let refunded = 0n;
    let skippedOrg = 0n;
    const usageIds = new Set<string>();

    const writeLedger = async (
      back: bigint,
      balanceAfter: bigint,
      bucket: LedgerBucketRow,
      orgId: string | null,
      usageId: string,
      memo: string,
    ) => {
      await client.query(
        `INSERT INTO credit_ledger
            (user_id, delta, balance_after, reason, bucket, ref_type, ref_id, memo, org_id)
         VALUES ($1, $2, $3, 'refund', $4, 'usage_record', $5, $6, $7)`,
        [uid, back.toString(), balanceAfter.toString(), bucket, usageId, memo, orgId],
      );
    };

    for (const r of rows.rows) {
      const back = -BigInt(r.delta);
      if (back <= 0n) continue;

      // ── org 桶:退回 org,严禁落个人钱包(P0 资损/套现)。不可退则跳过 + 告警。──
      if (r.bucket === "org_wallet" || r.bucket === "org_period") {
        const lock = r.org_id ? orgLocks.get(r.org_id) : undefined;
        if (!lock) {
          skippedOrg += back;
          log.warn("refund_org_bucket_skipped", {
            reason: "missing_org_id", usageId: r.usage_id, bucket: r.bucket, back: back.toString(),
          });
          continue;
        }
        if (r.bucket === "org_period" && lock.sub) {
          lock.sub.period += back;
          await writeLedger(back, lock.sub.period, "org_period", r.org_id, r.usage_id, input.memo);
          refunded += back; usageIds.add(r.usage_id);
        } else if (lock.credits !== null) {
          // org_wallet 直退;或 org_period 无 active org 订阅 → 改道退回 org 持久钱包。
          lock.credits += back;
          const memo =
            r.bucket === "org_period"
              ? `${input.memo};org_period→org_wallet(no active org sub)`
              : input.memo;
          await writeLedger(back, lock.credits, "org_wallet", r.org_id, r.usage_id, memo);
          refunded += back; usageIds.add(r.usage_id);
        } else {
          // org 已停用(非 active)且无可退目标 → 跳过,交人工,绝不落个人钱包。
          skippedOrg += back;
          log.warn("refund_org_bucket_skipped", {
            reason: "org_inactive", usageId: r.usage_id, bucket: r.bucket,
            orgId: r.org_id, back: back.toString(),
          });
        }
        continue;
      }

      // ── 个人桶(wallet/period):period 有 active 有效订阅退期内桶,否则退钱包(改道)。──
      usageIds.add(r.usage_id);
      refunded += back;
      const useBucket: "wallet" | "period" =
        r.bucket === "period" && activeSub !== null ? "period" : "wallet";
      const redirected = r.bucket === "period" && activeSub === null;
      let balanceAfter: bigint;
      if (useBucket === "period") {
        period += back;
        balanceAfter = period;
      } else {
        wallet += back;
        balanceAfter = wallet;
      }
      await writeLedger(
        back,
        balanceAfter,
        useBucket,
        null,
        r.usage_id,
        redirected ? `${input.memo};period→wallet(no active sub)` : input.memo,
      );
    }

    if (refunded === 0n) {
      await client.query("ROLLBACK");
      return { refundedCredits: 0n, recordCount: 0, totalAfter: null, skippedOrgCredits: skippedOrg };
    }

    // 4) 落库:仅写被改动的行。
    await client.query("UPDATE users SET credits = $1 WHERE id = $2", [wallet.toString(), uid]);
    if (activeSub && period !== BigInt(activeSub.period_credits)) {
      await client.query(
        "UPDATE user_subscriptions SET period_credits = $1, updated_at = NOW() WHERE id = $2",
        [period.toString(), activeSub.id],
      );
    }
    for (const [oid, lock] of orgLocks) {
      if (lock.credits !== null && lock.credits0 !== null && lock.credits !== lock.credits0) {
        await client.query(
          "UPDATE orgs SET credits = $1, updated_at = NOW() WHERE id = $2::bigint",
          [lock.credits.toString(), oid],
        );
      }
      if (lock.sub && lock.sub.period !== lock.sub.period0) {
        await client.query(
          "UPDATE org_subscriptions SET period_credits = $1, updated_at = NOW() WHERE id = $2",
          [lock.sub.period.toString(), lock.sub.id],
        );
      }
    }
    await client.query("COMMIT");
    const totalAfter = wallet + period;
    log.info("turn_waive_refunded", {
      userId: uid,
      sessionId: input.sessionId,
      sinceMs: input.sinceMs,
      refundedCredits: refunded.toString(),
      recordCount: usageIds.size,
      skippedOrgCredits: skippedOrg.toString(),
      memo: input.memo,
    });
    return {
      refundedCredits: refunded,
      recordCount: usageIds.size,
      totalAfter,
      skippedOrgCredits: skippedOrg,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw err;
  } finally {
    client.release();
  }
}
