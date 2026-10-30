import { isClientMessageId, type SessionSnapshot } from '@openclaude/protocol'
import type { Pool } from 'pg'
import { WebSocket } from 'ws'
import { readSessionSnapshot, SESSION_SNAPSHOT_MAX_BYTES } from '../db/sessionSnapshot.js'
import { openDispatchTurnStatusSnapshotFrame } from '../db/sessionSnapshotStatus.js'
export { openDispatchTurnStatusSnapshotFrame } from '../db/sessionSnapshotStatus.js'

type SnapshotLog = {
  info(msg: string, meta: Record<string, unknown>): void
  warn(msg: string, meta: Record<string, unknown>): void
} | null | undefined
type SnapshotSocket = Pick<WebSocket, 'readyState' | 'send' | 'bufferedAmount'>

/** Rolling-client projection of #1198. Credits are the very same object as
 * the canonical snapshot; this compatibility frame never advances frameSeq. */
export function sendHelloOpenDispatchSnapshot(
  userWs: SnapshotSocket, snapshot: SessionSnapshot,
): void {
  const row = snapshot.dispatch
  if (!row || (row.status !== 'admitted' && row.status !== 'accepted')) return
  userWs.send(JSON.stringify(openDispatchTurnStatusSnapshotFrame({
    peerId: snapshot.sessionId, agentId: row.agentId, clientMessageId: row.clientMessageId,
    engineReady: snapshot.engineReady === true, admittedAt: new Date(row.since),
    credits: snapshot.credits, now: snapshot.asOf,
  })))
}

/** Started after forwarding hello. Only PG participates; no ContainerLink or
 * browser-owned cache is a source of snapshot facts. */
export async function sendHelloSessionSnapshots(
  pool: Pool, userWs: SnapshotSocket, uid: string, peers: unknown[], log: SnapshotLog, connId?: string,
): Promise<void> {
  await Promise.resolve()
  const seen = new Set<string>()
  // Preserve the old eight-session budget and prioritize in-flight sessions.
  const candidates = peers.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .sort((a, b) => Number(b.inFlight === true) - Number(a.inFlight === true))
  for (const peer of candidates) {
    if (userWs.readyState !== WebSocket.OPEN || userWs.bufferedAmount > 4 * SESSION_SNAPSHOT_MAX_BYTES) break
    if (typeof peer.peerId !== 'string' || seen.has(peer.peerId)) continue
    if (seen.size >= 8) break
    seen.add(peer.peerId)
    const cmid = peer.inFlightClientMessageId
    const clientMessageId = peer.inFlight === true && typeof cmid === 'string' && cmid.length <= 200 && isClientMessageId(cmid)
      ? cmid : undefined
    try {
      const snapshot = await readSessionSnapshot(pool, uid, peer.peerId, {
        clientMessageId,
        afterSeq: typeof peer.lastFrameSeq === 'number' ? peer.lastFrameSeq : 0,
        streamKey: typeof peer.lastStreamKey === 'string' ? peer.lastStreamKey : undefined,
      })
      if (!snapshot || userWs.readyState !== WebSocket.OPEN) continue
      sendHelloOpenDispatchSnapshot(userWs, snapshot)
      if (clientMessageId === snapshot.dispatch?.clientMessageId && snapshot.reconcile) {
        userWs.send(JSON.stringify({
          type: 'outbound.message', channel: 'webchat', peer: { id: peer.peerId, kind: 'dm' },
          clientMessageId, blocks: [], isFinal: true,
          meta: { reconcile: snapshot.reconcile, clientMessageId }, ts: snapshot.asOf,
        }))
      }
      userWs.send(JSON.stringify({
        type: 'outbound.session_snapshot', channel: 'webchat',
        peer: { id: peer.peerId, kind: 'dm' }, snapshot,
      }))
      log?.info('user-chat-bridge: hello session snapshot sent', { uid, sessionId: peer.peerId })
    } catch (error) {
      // A failing session must not block hello forwarding or other sessions.
      const code = (error as { code?: unknown } | null)?.code
      log?.warn('hello_session_snapshot_failed', {
        uid, sessionId: peer.peerId, connId,
        errorName: error instanceof Error && /^(?:Error|TypeError|SyntaxError|RangeError|AbortError)$/.test(error.name)
          ? error.name : 'Error',
        ...(typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? { errorCode: code } : {}),
      })
    }
  }
}
