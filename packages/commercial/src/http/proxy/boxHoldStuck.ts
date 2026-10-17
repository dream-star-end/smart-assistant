/** OCV5-488: Box journal rows that still hold a session/account slot
 * although the cleanup worker saw nothing of the run on the Box over ten
 * minutes ago (boxRunAbsent), or 15 min past the 4 h 15 min ceiling. Either
 * way the automatic closers are failing. Read by the ops.box_hold_stuck alert
 * rule and, verbatim, by the Box incident proofs. No imports: the proofs load
 * this file on its own. */
export const BOX_HOLD_STUCK_SQL = `SELECT request_id, ctx->>'boxAccountId' AS account_id,
       ctx->>'boxState' AS box_state,
       (EXTRACT(EPOCH FROM (NOW() - created_at)) / 60)::int AS age_min,
       (jsonb_typeof(ctx->'boxRunAbsent'->'atMs') = 'number') AS absent
  FROM request_finalize_journal
 WHERE ctx->>'boxInvocationRecovery' = 'v1'
   AND ctx->>'boxState' IN ('reserved','starting','running','unknown','handoff','resuming','linked')
   AND ((jsonb_typeof(ctx->'boxRunAbsent'->'atMs') = 'number'
         AND (ctx->'boxRunAbsent'->>'atMs') ~ '^[0-9]{13}$'
         AND (ctx->'boxRunAbsent'->>'atMs')::bigint
           < (EXTRACT(EPOCH FROM NOW() - INTERVAL '10 minutes') * 1000)::bigint)
     OR created_at < NOW() - INTERVAL '4 hours 30 minutes')
 ORDER BY created_at ASC LIMIT 20`;

export interface BoxHoldStuckRow { requestId: string; accountId: string; boxState: string;
  ageMin: number; absent: boolean }

export function boxHoldStuckRows(rows: ReadonlyArray<{ request_id: string;
  account_id: string | null; box_state: string; age_min: number; absent: boolean }>): BoxHoldStuckRow[] {
  return rows.map((row) => ({ requestId: row.request_id, accountId: row.account_id ?? "?",
    boxState: row.box_state, ageMin: Number(row.age_min), absent: row.absent === true }));
}
