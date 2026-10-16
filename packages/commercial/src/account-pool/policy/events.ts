/**
 * OCV5-424 — pool_events: one audit trail of policy transitions for every pool.
 * Best-effort: a failed insert never blocks or fails the transition itself.
 */

import { query } from '../../db/queries.js'

export type PoolMemberKind = 'account' | 'relay_key' | 'api_key' | 'box_profile'

export interface PoolEventInput {
  service: string
  memberKind: PoolMemberKind
  memberId: string
  outcome: string
  fromStatus: string | null
  toStatus: string | null
  reason: string | null
  until: Date | null
}

export async function recordPoolEvent(e: PoolEventInput): Promise<void> {
  try {
    await query(
      `INSERT INTO pool_events (service, member_kind, member_id, outcome, from_status, to_status, reason, until_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [e.service, e.memberKind, e.memberId, e.outcome.slice(0, 200), e.fromStatus, e.toStatus, e.reason, e.until],
    )
  } catch (err) {
    // eslint-disable-next-line no-console -- audit is best-effort
    console.warn('[pool_events] insert failed:', (err as Error)?.message ?? err)
  }
}
