/** OCV5-761: execution ownership, not RPC traffic, permits a rolling route. */
import type { Pool } from 'pg'
import type { AntigravityRelayRoute } from './antigravityRouteContext.js'

export type AntigravityRouteAuthority = 'active' | 'legacy' | 'denied'

/** Stale settlement must not race an execution or its terminal delivery.
 * Routing is stricter: a stopped/finalizing owner cannot start new model calls. */
export function antigravityOwnerProtectedSql(turn: string): string {
  if (!/^[a-z_]+$/.test(turn)) throw new Error('invalid SQL alias')
  return `(
    EXISTS (SELECT 1 FROM turn_dispatches d
      WHERE d.billing_request_id=${turn}.request_id AND d.user_id=${turn}.user_id
        AND (d.status IN ('admitted','accepted','rejecting')
          OR (d.status='manual_reconcile' AND d.resolved_at IS NULL)
          OR d.terminal_at >= NOW() - INTERVAL '10 minutes'))
    OR EXISTS (SELECT 1 FROM request_finalize_journal j
      WHERE j.request_id=${turn}.request_id AND j.user_id=${turn}.user_id
        AND j.ctx->>'source'='delegate_antigravity'
        AND j.state IN ('inflight','finalizing'))
  )`
}

export async function readAntigravityRouteAuthority(
  pool: Pick<Pool, 'query'>,
  route: AntigravityRelayRoute,
): Promise<AntigravityRouteAuthority> {
  const result = await pool.query<{ authority: AntigravityRouteAuthority }>(
    `SELECT CASE
       WHEN t.status <> 'pending' OR t.model_id <> $4 THEN 'denied'
       WHEN d.dispatch_id IS NOT NULL THEN CASE WHEN
         d.user_id=$2 AND (d.agent_container_id IS NULL OR d.agent_container_id=$3)
         AND d.status IN ('admitted','accepted')
         AND d.terminal_at IS NULL AND d.producer_fenced_at IS NULL
         AND (
           NOT EXISTS (SELECT 1 FROM authority_turn_dispatches a WHERE a.dispatch_id=d.dispatch_id)
           OR EXISTS (SELECT 1 FROM authority_turn_dispatches a
             WHERE a.dispatch_id=d.dispatch_id AND a.user_id=$2
               AND a.attempt_no=d.attempt_no AND a.canonical_model=$4
               AND NOT EXISTS (SELECT 1 FROM server_authored_turn_anchor_map x
                 WHERE x.user_id='c:' || $2::text AND x.turn_key=a.turn_key)
               AND NOT EXISTS (SELECT 1 FROM turn_waivers w
                 WHERE w.user_id=$2 AND w.turn_key=a.turn_key))
         )
         AND NOT EXISTS (SELECT 1 FROM turn_control_requests c
           WHERE c.user_id=d.user_id AND c.session_id=d.session_id AND c.kind='stop'
             AND c.status<>'cancelled'
             AND c.error_code IS DISTINCT FROM 'TURN_ALREADY_ENDED'
             AND c.created_at>=d.admitted_at
             AND (c.root_client_message_id IS NULL
               OR c.root_client_message_id=d.client_message_id
               OR EXISTS (SELECT 1 FROM turn_recovery_jobs r
                 WHERE r.user_id=c.user_id AND r.session_id=c.session_id
                   AND r.root_client_message_id=c.root_client_message_id
                   AND r.request_json->>'clientMessageId'=d.client_message_id)))
         THEN 'active' ELSE 'denied' END
       WHEN j.request_id IS NOT NULL THEN CASE WHEN
         j.user_id=$2 AND j.container_id=$3 AND j.state='inflight'
         AND j.ctx->>'source'='delegate_antigravity'
         THEN 'active' ELSE 'denied' END
       WHEN EXISTS (SELECT 1 FROM turn_control_requests c
         WHERE c.user_id=t.user_id AND c.session_id=t.session_id AND c.kind='stop'
           AND c.root_client_message_id IS NULL AND c.created_at>=t.created_at
           AND c.status<>'cancelled'
           AND c.error_code IS DISTINCT FROM 'TURN_ALREADY_ENDED') THEN 'denied'
       ELSE 'legacy'
     END AS authority
     FROM antigravity_turns t
     LEFT JOIN turn_dispatches d ON d.billing_request_id=t.request_id
     LEFT JOIN request_finalize_journal j ON j.request_id=t.request_id
     WHERE t.request_id=$1 AND t.user_id=$2`,
    [route.requestId, route.userId.toString(), route.containerId, route.modelId],
  )
  return result.rows[0]?.authority ?? 'denied'
}
