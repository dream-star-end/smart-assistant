/**
 * Exact logical-turn waiver.
 *
 * A terminal lossless tape first commits a `turn_waivers(status='pending')`
 * fence in the same transaction as the terminal anchor.  Every settlement for
 * that turn (or a delegated child carrying parent_turn_key) takes the same
 * advisory lock and checks this fence before debit.  Applying the waiver then
 * reverses every already-committed debit into its original owner. Active
 * period debits return to that period bucket; an expired period returns to
 * the same owner's wallet so the refund remains usable. The same transaction
 * atomically creates one targeted in-app receipt.
 */

import type { TurnWaiveReason } from '@openclaude/protocol'
import type { Pool, PoolClient } from 'pg'

import { type Logger, rootLogger } from '../logging/logger.js'
import { lockTurnBillingKeys } from './turnLock.js'

export interface TurnWaiverInput {
  userId: bigint
  turnKey: string
  reason: TurnWaiveReason
  logger?: Logger
}

export interface TurnWaiverResult {
  waiverId: string
  /** true only for the transaction that changed pending → applied. */
  newlyApplied: boolean
  refundedCredits: bigint
  recordCount: number
  totalAfter: bigint | null
  inboxMessageId: string
}

type LedgerBucketRow = 'wallet' | 'period' | 'org_wallet' | 'org_period'

interface DebitRow {
  usage_id: string
  bucket: LedgerBucketRow
  delta: string
  org_id: string | null
  debited_at_us: string
}

interface WaiverRow {
  id: string
  reason: TurnWaiveReason
  status: 'pending' | 'applied'
  refunded_credits: string
  record_count: number
  inbox_message_id: string | null
}

interface OrgLock {
  credits: bigint
  credits0: bigint
  sub: {
    id: string
    period: bigint
    period0: bigint
    periodStartUs: bigint
    periodEndUs: bigint
  } | null
}

const REASON_COPY: Record<TurnWaiveReason, string> = {
  idle_timeout: '任务长时间没有新输出',
  no_response: '任务未能产生有效回复',
  platform_authority_expired: '长任务的执行凭证异常',
  turn_limit: '任务达到 12 小时运行上限',
}

/**
 * Caller transaction helper used by lossless tape finalization.  The caller
 * may already hold the turn lock; PostgreSQL advisory xact locks are reentrant,
 * so taking it here too makes this function safe for every future call site.
 */
export async function ensurePendingTurnWaiverInTransaction(
  client: PoolClient,
  input: TurnWaiverInput,
): Promise<WaiverRow> {
  await lockTurnBillingKeys(client, input.userId, [input.turnKey])
  const uid = input.userId.toString()
  const existing = await client.query<WaiverRow>(
    `SELECT id::text AS id, reason, status, refunded_credits::text AS refunded_credits,
            record_count, inbox_message_id::text AS inbox_message_id
       FROM turn_waivers
      WHERE user_id = $1 AND turn_key = $2
      FOR UPDATE`,
    [uid, input.turnKey],
  )
  if (existing.rowCount) {
    const row = existing.rows[0]!
    if (row.reason !== input.reason) {
      throw new Error(
        `turn waiver reason conflict for ${input.turnKey}: ${row.reason} != ${input.reason}`,
      )
    }
    return row
  }
  const inserted = await client.query<WaiverRow>(
    `INSERT INTO turn_waivers (user_id, turn_key, reason, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING id::text AS id, reason, status,
               refunded_credits::text AS refunded_credits,
               record_count, inbox_message_id::text AS inbox_message_id`,
    [uid, input.turnKey, input.reason],
  )
  return inserted.rows[0]!
}

/** Manual/rolling compatibility entry: durable pending fence first. */
export async function ensurePendingTurnWaiver(pool: Pool, input: TurnWaiverInput): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await ensurePendingTurnWaiverInTransaction(client, input)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Reverse all already-committed debits and create exactly one receipt.
 * Refund + receipt + pending→applied are one transaction.
 */
export async function applyTurnWaiver(
  pool: Pool,
  input: TurnWaiverInput,
): Promise<TurnWaiverResult> {
  const log = (input.logger ?? rootLogger).child({ subsys: 'billingTurnWaiver' })
  const uid = input.userId.toString()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await lockTurnBillingKeys(client, input.userId, [input.turnKey])
    const waiver = await ensurePendingTurnWaiverInTransaction(client, input)

    if (waiver.status === 'applied') {
      if (!waiver.inbox_message_id) throw new Error('applied turn waiver missing inbox receipt')
      const totalAfter = await readPersonalTotal(client, uid)
      await client.query('COMMIT')
      return {
        waiverId: waiver.id,
        newlyApplied: false,
        refundedCredits: BigInt(waiver.refunded_credits),
        recordCount: waiver.record_count,
        totalAfter,
        inboxMessageId: waiver.inbox_message_id,
      }
    }

    const debits = await client.query<DebitRow>(
      `SELECT ur.id::text AS usage_id, cl.bucket, cl.delta::text AS delta,
              cl.org_id::text AS org_id,
              FLOOR(EXTRACT(EPOCH FROM cl.created_at) * 1000000)::bigint::text AS debited_at_us
         FROM usage_records ur
         JOIN credit_ledger cl
           ON cl.ref_type = 'usage_record' AND cl.ref_id = ur.id::text
          AND cl.user_id = ur.user_id AND cl.delta < 0
        WHERE ur.user_id = $1
          AND (ur.turn_key = $2 OR ur.parent_turn_key = $2)
          AND ur.status = 'success'
          AND NOT EXISTS (
            SELECT 1 FROM credit_ledger r
             WHERE r.user_id = ur.user_id AND r.reason = 'refund'
               AND r.ref_type = 'usage_record' AND r.ref_id = ur.id::text
          )
        ORDER BY ur.id, cl.id`,
      [uid, input.turnKey],
    )

    // Global money-row lock order matches spendTwoBucket:
    // orgs → org_subscriptions → users → user_subscriptions.
    const orgIds = [
      ...new Set(
        debits.rows
          .filter((r) => r.bucket === 'org_wallet' || r.bucket === 'org_period')
          .map((r) => r.org_id)
          .filter((v): v is string => v !== null),
      ),
    ].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))

    const orgLocks = new Map<string, OrgLock>()
    for (const oid of orgIds) {
      // Historical debit ledger has ON DELETE RESTRICT ownership. Suspended /
      // deleting orgs are still the rightful recipient and must be restored.
      const org = await client.query<{ credits: string }>(
        'SELECT credits::text AS credits FROM orgs WHERE id=$1::bigint FOR UPDATE',
        [oid],
      )
      if (!org.rowCount) throw new Error(`refund invariant: referenced org ${oid} is missing`)
      const credits = BigInt(org.rows[0]!.credits)
      orgLocks.set(oid, { credits, credits0: credits, sub: null })
    }
    for (const oid of orgIds) {
      const sub = await client.query<{
        id: string
        period_credits: string
        period_start_us: string
        period_end_us: string
      }>(
        `SELECT id::text AS id, period_credits::text AS period_credits,
                FLOOR(EXTRACT(EPOCH FROM period_start) * 1000000)::bigint::text AS period_start_us,
                FLOOR(EXTRACT(EPOCH FROM period_end) * 1000000)::bigint::text AS period_end_us
           FROM org_subscriptions
          WHERE org_id=$1::bigint AND status='active'
            AND period_start <= NOW() AND period_end > NOW()
          ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [oid],
      )
      if (sub.rowCount) {
        const period = BigInt(sub.rows[0]!.period_credits)
        orgLocks.get(oid)!.sub = {
          id: sub.rows[0]!.id,
          period,
          period0: period,
          periodStartUs: BigInt(sub.rows[0]!.period_start_us),
          periodEndUs: BigInt(sub.rows[0]!.period_end_us),
        }
      }
    }

    const user = await client.query<{ credits: string }>(
      'SELECT credits::text AS credits FROM users WHERE id=$1 FOR UPDATE',
      [uid],
    )
    if (!user.rowCount) throw new Error(`refund invariant: user ${uid} is missing`)
    let wallet = BigInt(user.rows[0]!.credits)
    const sub = await client.query<{
      id: string
      period_credits: string
      period_start_us: string
      period_end_us: string
    }>(
      `SELECT id::text AS id, period_credits::text AS period_credits,
              FLOOR(EXTRACT(EPOCH FROM period_start) * 1000000)::bigint::text AS period_start_us,
              FLOOR(EXTRACT(EPOCH FROM period_end) * 1000000)::bigint::text AS period_end_us
         FROM user_subscriptions
        WHERE user_id=$1 AND status='active'
          AND period_start <= NOW() AND period_end > NOW()
        ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [uid],
    )
    const activeSub = sub.rowCount ? sub.rows[0]! : null
    let period = activeSub ? BigInt(activeSub.period_credits) : 0n

    let refunded = 0n
    const usageIds = new Set<string>()
    const memo = `waive:${input.reason};turn:${input.turnKey}`
    const writeLedger = async (
      back: bigint,
      balanceAfter: bigint,
      bucket: LedgerBucketRow,
      orgId: string | null,
      usageId: string,
      rowMemo: string,
    ): Promise<void> => {
      await client.query(
        `INSERT INTO credit_ledger
           (user_id, delta, balance_after, reason, bucket, ref_type, ref_id, memo, org_id)
         VALUES ($1,$2,$3,'refund',$4,'usage_record',$5,$6,$7)`,
        [uid, back.toString(), balanceAfter.toString(), bucket, usageId, rowMemo, orgId],
      )
    }

    for (const row of debits.rows) {
      const back = -BigInt(row.delta)
      if (back <= 0n) continue
      usageIds.add(row.usage_id)
      refunded += back
      if (row.bucket === 'org_wallet' || row.bucket === 'org_period') {
        if (!row.org_id) throw new Error(`refund invariant: ${row.bucket} debit missing org_id`)
        const lock = orgLocks.get(row.org_id)
        if (!lock) throw new Error(`refund invariant: org ${row.org_id} was not locked`)
        const debitAtUs = BigInt(row.debited_at_us)
        const refundToOrgPeriod =
          row.bucket === 'org_period' &&
          lock.sub !== null &&
          debitAtUs >= lock.sub.periodStartUs &&
          debitAtUs < lock.sub.periodEndUs
        if (refundToOrgPeriod && lock.sub) {
          lock.sub.period += back
          await writeLedger(back, lock.sub.period, 'org_period', row.org_id, row.usage_id, memo)
        } else {
          lock.credits += back
          await writeLedger(
            back,
            lock.credits,
            'org_wallet',
            row.org_id,
            row.usage_id,
            row.bucket === 'org_period' ? `${memo};org_period→org_wallet(expired period)` : memo,
          )
        }
        continue
      }

      const debitAtUs = BigInt(row.debited_at_us)
      const refundToPeriod =
        row.bucket === 'period' &&
        activeSub !== null &&
        debitAtUs >= BigInt(activeSub.period_start_us) &&
        debitAtUs < BigInt(activeSub.period_end_us)
      if (refundToPeriod) {
        period += back
        await writeLedger(back, period, 'period', null, row.usage_id, memo)
      } else {
        wallet += back
        await writeLedger(
          back,
          wallet,
          'wallet',
          null,
          row.usage_id,
          row.bucket === 'period' ? `${memo};period→wallet(expired period)` : memo,
        )
      }
    }

    await client.query('UPDATE users SET credits=$1 WHERE id=$2', [wallet.toString(), uid])
    if (activeSub && period !== BigInt(activeSub.period_credits)) {
      await client.query(
        'UPDATE user_subscriptions SET period_credits=$1, updated_at=NOW() WHERE id=$2',
        [period.toString(), activeSub.id],
      )
    }
    for (const [oid, lock] of orgLocks) {
      if (lock.credits !== lock.credits0) {
        await client.query('UPDATE orgs SET credits=$1, updated_at=NOW() WHERE id=$2::bigint', [
          lock.credits.toString(),
          oid,
        ])
      }
      if (lock.sub && lock.sub.period !== lock.sub.period0) {
        await client.query(
          'UPDATE org_subscriptions SET period_credits=$1, updated_at=NOW() WHERE id=$2',
          [lock.sub.period.toString(), lock.sub.id],
        )
      }
    }

    const reasonCopy = REASON_COPY[input.reason]
    const body =
      refunded > 0n
        ? `由于${reasonCopy}，本轮已自动免单，并退还 **${refunded.toString()} 积分**。积分已按原扣费来源退回个人或组织额度。你可以回到原会话重新尝试。`
        : `由于${reasonCopy}，本轮已自动免单。本轮没有实际扣除积分，你可以回到原会话重新尝试。`
    const inbox = await client.query<{ id: string }>(
      `INSERT INTO inbox_messages
         (audience,user_id,title,body_md,level,created_by,notify_email,
          source_type,source_id,source_phase)
       SELECT 'user',$1,'本轮已自动免单',$2,'notice',a.id,FALSE,
              'turn_waive',$3::bigint,'receipt'
         FROM (
           SELECT id FROM users
            WHERE role='admin' AND status='active'
            ORDER BY id ASC LIMIT 1
         ) a
       RETURNING id::text AS id`,
      [uid, body, waiver.id],
    )
    const inboxMessageId = inbox.rows[0]?.id
    if (!inboxMessageId) {
      throw new Error('turn waiver receipt requires an active system admin sender')
    }

    await client.query(
      `UPDATE turn_waivers
          SET status='applied', refunded_credits=$2, record_count=$3,
              inbox_message_id=$4::bigint, applied_at=NOW()
        WHERE id=$1::bigint AND status='pending'`,
      [waiver.id, refunded.toString(), usageIds.size, inboxMessageId],
    )
    await client.query('COMMIT')

    const totalAfter = wallet + period
    log.info('turn_waiver_applied', {
      userId: uid,
      turnKey: input.turnKey,
      reason: input.reason,
      refundedCredits: refunded.toString(),
      recordCount: usageIds.size,
      inboxMessageId,
    })
    return {
      waiverId: waiver.id,
      newlyApplied: true,
      refundedCredits: refunded,
      recordCount: usageIds.size,
      totalAfter,
      inboxMessageId,
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function readPersonalTotal(client: PoolClient, uid: string): Promise<bigint | null> {
  const row = await client.query<{ total: string }>(
    `SELECT (u.credits + COALESCE((
              SELECT us.period_credits
                FROM user_subscriptions us
               WHERE us.user_id=u.id AND us.status='active' AND us.period_end > NOW()
               ORDER BY us.id DESC LIMIT 1
            ),0))::text AS total
       FROM users u WHERE u.id=$1`,
    [uid],
  )
  return row.rowCount ? BigInt(row.rows[0]!.total) : null
}
