// Muse media bridge — per-job credits (OCV5-574, commercial).
//
// Prices are whole credits per job (the 积分 the UI shows = cost_credits): user decision
// 2026-10-22, video 50 and image 10. Admission only checks that the balance covers this job plus
// the account's other open jobs; nothing is held. The charge happens once, when a job succeeds,
// in the same transaction that records the success on its muse_media_jobs row, so a row is never
// charged without being succeeded or succeeded without being charged. Failed, cancelled, timed-out
// or orphaned jobs are never charged, so there is nothing to refund.

import type { Pool } from 'pg'

import { readTotalSpendableBalance } from '../billing/preCheck.js'
import { spendTwoBucket } from '../billing/spend.js'
import { resolveOrgBillingContext } from '../org/orgBilling.js'
import { MuseError, type MuseKind } from './protocol.js'

export interface MuseSettleInput {
  jobId: string
  userId: string
  kind: MuseKind
  price: bigint
  files: Array<{ mime: string; bytes: number; sha256: string }>
  artifactIds: string[]
  snapshotId: string | null
}

export interface MuseSettleResult {
  ledgerId: bigint | null
  debitedCredits: bigint | null
  clamped: boolean
}

export interface MuseBilling {
  /** Credits a successful job of this kind costs; 0n = not billed. */
  price(kind: MuseKind): bigint
  /** Throws MuseError 402 MUSE_INSUFFICIENT_CREDITS when the spendable balance is below `required`. */
  ensureBalance(userId: string, required: bigint): Promise<void>
  /** Marks the running row succeeded and charges it, atomically. Throws when the row is no longer running. */
  settle(input: MuseSettleInput): Promise<MuseSettleResult>
  /** After settle threw: whether that transaction committed anyway (a lost COMMIT reply). */
  outcome(jobId: string): Promise<{ charged: boolean; debitedCredits: bigint | null }>
}

export const MUSE_PRICE_SOURCE =
  'OCV5-574 user decision 2026-10-22: video 50, image 10 credits per job'

export function createMuseBilling(
  pool: Pool,
  prices: Readonly<Record<MuseKind, number>>,
  deps: { spendable?: (userId: string) => Promise<bigint> } = {},
): MuseBilling {
  const spendable = deps.spendable ?? readTotalSpendableBalance
  return {
    price(kind) {
      return BigInt(prices[kind] ?? 0)
    },

    async ensureBalance(userId, required) {
      if (required <= 0n) return
      const balance = await spendable(userId)
      if (balance < required) {
        throw new MuseError(
          402,
          'MUSE_INSUFFICIENT_CREDITS',
          `insufficient credits: balance=${balance} required=${required}`,
        )
      }
    },

    async settle(input) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const snapshot = {
          provider: 'muse',
          kind: input.kind,
          unit: 'job',
          cost_credits: input.price.toString(),
          source: MUSE_PRICE_SOURCE,
          captured_at: new Date().toISOString(),
        }
        const done = await client.query(
          `UPDATE muse_media_jobs
              SET status = 'succeeded', error_code = NULL, upstream_error_code = NULL, files = $3,
                  muse_artifact_ids = $4, muse_snapshot_id = $5, finished_at = NOW(),
                  cost_credits = $6, price_snapshot = $7
            WHERE id = $1 AND user_id = $2 AND status = 'running'
            RETURNING id`,
          [
            input.jobId,
            input.userId,
            JSON.stringify(input.files),
            input.artifactIds,
            input.snapshotId,
            input.price.toString(),
            JSON.stringify(snapshot),
          ],
        )
        if (done.rowCount !== 1) throw new Error('MUSE_JOB_NOT_RUNNING')
        // org 归属(0112):billing_enabled 的成员先扣 org 钱包,与 MiniMax 媒体计费同一条路径。
        const orgCtx = await resolveOrgBillingContext(client, BigInt(input.userId))
        const spend = await spendTwoBucket(client, {
          userId: input.userId,
          amount: input.price,
          reason: 'muse_media',
          ref: { type: 'muse_media_job', id: input.jobId },
          memo: `muse ${input.kind} cost=${input.price}`,
          orgId: orgCtx?.billingEnabled ? orgCtx.orgId : undefined,
          monthlyOrgBudget: orgCtx?.billingEnabled ? orgCtx.monthlyOrgBudget : undefined,
        })
        await client.query(
          'UPDATE muse_media_jobs SET ledger_id = $2, debited_credits = $3 WHERE id = $1',
          [input.jobId, spend.primaryLedgerId?.toString() ?? null, spend.debited.toString()],
        )
        await client.query('COMMIT')
        return {
          ledgerId: spend.primaryLedgerId,
          debitedCredits: spend.debited,
          clamped: spend.clamped,
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    async outcome(jobId) {
      const r = await pool.query<{ status: string; cost: string | null; debited: string | null }>(
        `SELECT status, cost_credits::text AS cost, debited_credits::text AS debited
           FROM muse_media_jobs WHERE id = $1`,
        [jobId],
      )
      const row = r.rows[0]
      const charged = row?.status === 'succeeded' && row.cost !== null
      return {
        charged,
        debitedCredits: charged && row!.debited !== null ? BigInt(row!.debited) : null,
      }
    },
  }
}
