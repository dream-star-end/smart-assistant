import type { DispatchCredits } from '@openclaude/protocol'
import type { Pool } from 'pg'

/** Same actual-debit attribution as the answer badge and goal budget. Root
 * dispatch identity comes from usage_records; delegates join by parent key. */
export async function readDispatchSettledCredits(
  q: Pick<Pool, 'query'>,
  input: { uid: string; dispatchId: string; attemptNo: number; admittedAt: Date },
): Promise<DispatchCredits> {
  const result = await q.query<{ settled: string; requests: number; as_of: string }>(
    `/* dispatch-settled-credits */
WITH roots AS (
  SELECT DISTINCT COALESCE(ur.parent_turn_key, ur.turn_key) AS turn_key
    FROM usage_records ur
   WHERE ur.user_id = $1::bigint
     AND ur.created_at >= $4::timestamptz          -- admitted_at：走 idx_ur_user_time 做范围扫描
     AND ur.dispatch_id = $2::uuid AND ur.attempt_no = $3::int
     AND COALESCE(ur.parent_turn_key, ur.turn_key) IS NOT NULL
), parts AS (
  SELECT c.request_id, c.cost_credits
    FROM client_session_turn_tapes t
    JOIN turn_tape_cost_components c
      ON c.session_id = t.session_id AND c.user_id = t.user_id AND c.tape_id = t.tape_id
   WHERE t.user_id = $5 AND t.turn_key IN (SELECT turn_key FROM roots)
  UNION ALL
  SELECT p.request_id, p.cost_credits::numeric
    FROM pending_usage_patches p
   WHERE p.user_id = $5
     AND (p.turn_key IN (SELECT turn_key FROM roots) OR p.parent_turn_key IN (SELECT turn_key FROM roots))
     AND p.cost_credits ~ '^[0-9]+$'
     AND NOT EXISTS (SELECT 1 FROM turn_tape_cost_components c0
                      WHERE c0.request_id = p.request_id AND c0.user_id = p.user_id)
)
SELECT COALESCE(SUM(cost_credits),0)::text AS settled, COUNT(*)::int AS requests,
       (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS as_of
  FROM parts`,
    [input.uid, input.dispatchId, input.attemptNo, input.admittedAt, `c:${input.uid}`],
  )
  const row = result.rows[0]!
  return { settled: row.settled, requests: row.requests, asOf: Number(row.as_of) }
}
