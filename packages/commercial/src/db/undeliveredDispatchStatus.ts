import type { Pool, PoolClient } from 'pg'

type Status = { client_message_id: string; failure_code: string | null }
type Recovery = {
  source_client_message_id: string; child_message_id: string | null; status: string
  child_status: string | null; child_outcome: string | null; child_notified: boolean | null
}

/** One delivery notice per root, including across reconnect/history reads.
 * Child failures update that notice instead of creating a second one. */
export async function undeliveredDispatchStatus<T extends Status>(
  q: Pick<Pool | PoolClient, 'query'>, userId: string, sessionId: string, rows: T[],
): Promise<Array<T & { deliveryRecovery?: 'resent' | 'failed' | 'hidden'; retryClientMessageId?: string }>> {
  if (!rows.some(row => row.failure_code === 'DISPATCH_AUTHORITY_EXPIRED')) return rows
  const jobs = (await q.query<Recovery>(
    `SELECT j.source_client_message_id,j.request_json->>'clientMessageId' AS child_message_id,j.status,
            d.status AS child_status,d.outcome AS child_outcome,d.client_notified AS child_notified
       FROM turn_recovery_jobs j LEFT JOIN turn_dispatches d ON d.dispatch_id=j.dispatch_id
      WHERE j.user_id=$1 AND j.session_id=$2 AND j.error_code='dispatch_authority_expired'
      ORDER BY j.semantic_recovery_attempt`, [userId, sessionId],
  )).rows
  const children = new Set(jobs.map(job => job.child_message_id))
  return rows.flatMap(row => {
    if (row.failure_code !== 'DISPATCH_AUTHORITY_EXPIRED') return [row]
    if (children.has(row.client_message_id)) return [{ ...row, deliveryRecovery: 'hidden' as const }]
    const job = jobs.find(job => job.source_client_message_id === row.client_message_id)
    const failed = !job || ['paused', 'cancelled', 'manual_reconcile'].includes(job.status) ||
      (job.child_status === 'terminal' && job.child_outcome === 'not_accepted' && job.child_notified === true)
    return [{ ...row, deliveryRecovery: failed ? 'failed' as const : 'resent' as const,
      retryClientMessageId: job?.child_message_id ?? row.client_message_id }]
  })
}
