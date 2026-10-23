// OCV5-591 A2-1 — what one studio execution actually debited, read from credit_ledger (every bucket
// row of a charge carries the same ref). A clamped settle debits less than the list price, so the
// ledger, not the price, is the truth the deferred budget reconciliation books (A2-1 plan §4).

import type { Pool } from 'pg'

export async function ledgerDebited(
  pool: Pool,
  refType: string,
  refIds: string[],
): Promise<bigint> {
  if (refIds.length === 0) return 0n
  const r = await pool.query<{ debited: string }>(
    `SELECT COALESCE(-SUM(delta), 0)::text AS debited FROM credit_ledger
      WHERE ref_type = $1 AND ref_id = ANY($2::text[])`,
    [refType, refIds],
  )
  return BigInt(r.rows[0]?.debited ?? '0')
}
/**
 * OCV5-591 A2-1b-1: what a user-billed studio Grok call debited, over all its attempts (a retry
 * bills under `<requestId>~<n>`). Grok settles into usage_records + credit_ledger (ref
 * usage_record).
 */
export async function grokCharged(pool: Pool, userId: bigint, requestId: string): Promise<bigint> {
  const like = `${requestId.replace(/[\\%_]/g, (c) => `\\${c}`)}~%`
  const r = await pool.query<{ debited: string }>(
    `SELECT COALESCE(-SUM(cl.delta), 0)::text AS debited
       FROM usage_records ur
       JOIN credit_ledger cl ON cl.ref_type = 'usage_record' AND cl.ref_id = ur.id::text
      WHERE ur.user_id = $1 AND (ur.request_id = $2 OR ur.request_id LIKE $3)`,
    [userId.toString(), requestId, like],
  )
  return BigInt(r.rows[0]?.debited ?? '0')
}

/** The orchestrator aborts any single provider call after this long (image2Run has no own timeout). */
export const STUDIO_TASK_HARD_TIMEOUT_MS = 10 * 60_000
