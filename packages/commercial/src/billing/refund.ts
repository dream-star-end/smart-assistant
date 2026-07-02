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
 * 已扣费 usage_records,逐笔按原扣费桶精确冲正(credit_ledger 里有按桶的负 delta
 * 原始行,reason='refund' 正 delta 写回)。
 *
 * 不变量:
 *   - **幂等**:per-user pg_advisory_xact_lock 串行化 + 事务内查已有 refund 行
 *     (reason='refund' AND ref_type='usage_record' AND ref_id=usageId)跳过。
 *     锁到 commit 才释放,并发第二笔进来时必能看到第一笔的 refund 行。
 *   - **锁序**:先 users FOR UPDATE 再 user_subscriptions FOR UPDATE(全仓不变量,
 *     与 spendTwoBucket 对齐,防死锁)。
 *   - **桶语义**:period 部分优先退回当前 active 订阅的期内桶(它到期仍会清零,
 *     不构成永久资产泄漏);无 active 订阅(已到期/取消)则退到钱包,memo 标注改道。
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
}

interface DebitRow {
  usage_id: string;
  bucket: "wallet" | "period";
  delta: string; // 负数(原扣费行)
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

    // 1) 圈定窗口内已扣费记录,连同各自的原始扣费 ledger 行(按桶),排除已退过的。
    const rows = await client.query<DebitRow>(
      `SELECT ur.id::text AS usage_id, cl.bucket, cl.delta::text AS delta
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
      return { refundedCredits: 0n, recordCount: 0, totalAfter: null };
    }

    // 2) 锁两桶(锁序:users → user_subscriptions,与 spendTwoBucket 一致)。
    const walletSel = await client.query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id = $1 FOR UPDATE",
      [uid],
    );
    if (walletSel.rowCount === 0) {
      throw new Error(`refund: user ${uid} not found`);
    }
    let wallet = BigInt(walletSel.rows[0]!.credits);
    const subSel = await client.query<{ id: string; period_credits: string }>(
      `SELECT id::text AS id, period_credits::text AS period_credits
         FROM user_subscriptions
        WHERE user_id = $1 AND status = 'active'
        ORDER BY id DESC LIMIT 1
        FOR UPDATE`,
      [uid],
    );
    const activeSub = subSel.rowCount === 0 ? null : subSel.rows[0]!;
    let period = activeSub ? BigInt(activeSub.period_credits) : 0n;

    // 3) 逐 usage 记录、逐桶冲正(delta 取原扣费行绝对值)。
    let refunded = 0n;
    const usageIds = new Set<string>();
    for (const r of rows.rows) {
      const back = -BigInt(r.delta);
      if (back <= 0n) continue;
      usageIds.add(r.usage_id);
      refunded += back;
      // period 原扣 → 有 active 订阅退期内桶;订阅没了(到期/取消)退钱包并在 memo 标注。
      const bucket: "wallet" | "period" =
        r.bucket === "period" && activeSub !== null ? "period" : "wallet";
      const redirected = r.bucket === "period" && activeSub === null;
      let balanceAfter: bigint;
      if (bucket === "period") {
        period += back;
        balanceAfter = period;
      } else {
        wallet += back;
        balanceAfter = wallet;
      }
      await client.query(
        `INSERT INTO credit_ledger
            (user_id, delta, balance_after, reason, bucket, ref_type, ref_id, memo)
         VALUES ($1, $2, $3, 'refund', $4, 'usage_record', $5, $6)`,
        [
          uid,
          back.toString(),
          balanceAfter.toString(),
          bucket,
          r.usage_id,
          redirected ? `${input.memo};period→wallet(no active sub)` : input.memo,
        ],
      );
    }
    if (refunded === 0n) {
      await client.query("ROLLBACK");
      return { refundedCredits: 0n, recordCount: 0, totalAfter: null };
    }
    await client.query("UPDATE users SET credits = $1 WHERE id = $2", [wallet.toString(), uid]);
    if (activeSub && period !== BigInt(activeSub.period_credits)) {
      await client.query(
        "UPDATE user_subscriptions SET period_credits = $1, updated_at = NOW() WHERE id = $2",
        [period.toString(), activeSub.id],
      );
    }
    await client.query("COMMIT");
    const totalAfter = wallet + period;
    log.info("turn_waive_refunded", {
      userId: uid,
      sessionId: input.sessionId,
      sinceMs: input.sinceMs,
      refundedCredits: refunded.toString(),
      recordCount: usageIds.size,
      memo: input.memo,
    });
    return { refundedCredits: refunded, recordCount: usageIds.size, totalAfter };
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
