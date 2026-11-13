import type { SessionSnapshot } from '@openclaude/protocol'
import { inboundSessionKey } from '@openclaude/gateway'
import type { Queryable } from '../dispatch/turnDispatchStore.js'

import { readContainerLinkDispatches } from '../dispatch/turnDispatchStore.js'
export { readContainerLinkDispatches, scanContainerLinkCarriers } from '../dispatch/turnDispatchStore.js'
export type { LinkCarrier, LinkDispatch } from '../dispatch/turnDispatchStore.js'

/** Evidence only: never fabricate a frame or advance the persisted replay cursor. */
export async function recordContainerLinkGap(pool: Queryable, uid: bigint, containerId: number, frame: Record<string, unknown>): Promise<number> {
  if (frame.type !== 'outbound.resume_failed' || typeof frame.sessionKey !== 'string' ||
      !Number.isSafeInteger(frame.from) || !Number.isSafeInteger(frame.to) || Number(frame.from) < 0 || Number(frame.to) < 0) return 0
  const peer = frame.peer as { id?: unknown } | undefined
  if (typeof peer?.id !== 'string') return 0
  const rows = await readContainerLinkDispatches(pool, { uid: String(uid), containerId })
  let written = 0
  for (const row of rows) {
    if (row.sessionId !== peer.id || inboundSessionKey({ agentId: row.agentId, channel: 'webchat', peer: { id: row.sessionId, kind: 'dm' } }) !== frame.sessionKey) continue
    const gap: SessionSnapshot['gap'] = Number(frame.from) > Number(frame.to)
      ? { reason: 'cursor_reset' }
      : { reason: 'sequence_gap', afterSeq: Number(frame.from), beforeSeq: Number(frame.to) + 1 }
    const result = await pool.query(
      `WITH open_dispatch AS (
         SELECT * FROM turn_dispatches WHERE dispatch_id=$1 AND user_id=$2 AND agent_container_id=$3
           AND attempt_no=$4 AND lease_epoch=$5 AND status IN ('admitted','accepted') AND terminal_at IS NULL FOR UPDATE
       ) INSERT INTO client_session_live_streams
           (stream_key,session_id,user_id,client_message_id,dispatch_id,attempt_no,agent_container_id,source,provenance)
         SELECT 'dispatch:' || dispatch_id::text || ':' || attempt_no,session_id,'c:' || user_id::text,
           client_message_id,dispatch_id,attempt_no,agent_container_id,'gateway',jsonb_build_object('containerLinkGap',$6::jsonb)
           FROM open_dispatch
         ON CONFLICT (stream_key) DO UPDATE SET
           provenance=client_session_live_streams.provenance || EXCLUDED.provenance,updated_at=NOW()
         WHERE client_session_live_streams.user_id=EXCLUDED.user_id
           AND client_session_live_streams.agent_container_id=EXCLUDED.agent_container_id
           AND client_session_live_streams.session_id=EXCLUDED.session_id
           AND client_session_live_streams.projection_source='live'
           AND NOT (client_session_live_streams.provenance ? 'containerLinkGap')`,
      [row.dispatchId, String(uid), containerId, row.attemptNo, row.leaseEpoch, JSON.stringify(gap)],
    )
    written += result.rowCount ?? 0
  }
  return written
}
