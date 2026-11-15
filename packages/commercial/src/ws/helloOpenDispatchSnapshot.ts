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
  containerId?: number,
): Promise<void> {
  await Promise.resolve()
  const posSeq = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
  type AggPeer = {
    peerId: string; inFlight: boolean; inFlightClientMessageId?: string
    leadAfterSeq: number; afterSeqByAgent: Record<string, number>
    hasAnyPositiveCursor: boolean; streamKey?: string; streamKeyAgentId?: string
  }
  const byPeer = new Map<string, AggPeer>()
  for (const raw of peers) {
    if (!raw || typeof raw !== 'object') continue
    const p = raw as Record<string, unknown>
    if (typeof p.peerId !== 'string') continue
    let agg = byPeer.get(p.peerId)
    const seq = posSeq(p.lastFrameSeq)
    const aid = typeof p.agentId === 'string' && p.agentId ? p.agentId : 'main'
    if (!agg) {
      agg = {
        peerId: p.peerId, inFlight: false, leadAfterSeq: seq,
        afterSeqByAgent: {}, hasAnyPositiveCursor: seq > 0,
      }
      byPeer.set(p.peerId, agg)
    }
    if (p.inFlight === true) {
      agg.inFlight = true
      if (!agg.inFlightClientMessageId && typeof p.inFlightClientMessageId === 'string') {
        agg.inFlightClientMessageId = p.inFlightClientMessageId
      }
    }
    if (aid) agg.afterSeqByAgent[aid] = Math.max(agg.afterSeqByAgent[aid] ?? 0, seq)
    if (seq > 0) agg.hasAnyPositiveCursor = true
    if (!agg.streamKey && typeof p.lastStreamKey === 'string' && p.lastStreamKey) {
      agg.streamKey = p.lastStreamKey
      agg.streamKeyAgentId = aid
    }
  }
  const priority = (a: AggPeer) => a.inFlight ? 2 : a.hasAnyPositiveCursor ? 1 : 0
  // Keep 8-session budget for zero-cursor idle sessions; allow up to 64 for positive-cursor arbitration across containers.
  const candidates = [...byPeer.values()].sort((a, b) => priority(b) - priority(a))
  let sentCount = 0
  for (const agg of candidates) {
    if (userWs.readyState !== WebSocket.OPEN || userWs.bufferedAmount > 4 * SESSION_SNAPSHOT_MAX_BYTES) break
    const needsCursorBudget = typeof containerId === 'number' && agg.hasAnyPositiveCursor
    if (sentCount >= 64) break
    if (sentCount >= 8 && !needsCursorBudget) continue
    sentCount++
    const cmid = agg.inFlightClientMessageId
    const clientMessageId = agg.inFlight && typeof cmid === 'string' && cmid.length <= 200 && isClientMessageId(cmid)
      ? cmid : undefined
    try {
      const snapshot = await readSessionSnapshot(pool, uid, agg.peerId, {
        clientMessageId,
        afterSeq: agg.leadAfterSeq,
        ...(Object.keys(agg.afterSeqByAgent).length > 0 ? { afterSeqByAgent: agg.afterSeqByAgent } : {}),
        streamKey: agg.streamKey,
        ...(agg.streamKeyAgentId ? { streamKeyAgentId: agg.streamKeyAgentId } : {}),
        ...(typeof containerId === 'number' ? { containerId } : {}),
      })
      if (!snapshot || userWs.readyState !== WebSocket.OPEN) continue
      sendHelloOpenDispatchSnapshot(userWs, snapshot)
      if (clientMessageId === snapshot.dispatch?.clientMessageId && snapshot.reconcile) {
        userWs.send(JSON.stringify({
          type: 'outbound.message', channel: 'webchat', peer: { id: agg.peerId, kind: 'dm' },
          clientMessageId, blocks: [], isFinal: true,
          meta: { reconcile: snapshot.reconcile, clientMessageId }, ts: snapshot.asOf,
        }))
      }
      userWs.send(JSON.stringify({
        type: 'outbound.session_snapshot', channel: 'webchat',
        peer: { id: agg.peerId, kind: 'dm' }, snapshot,
      }))
      log?.info('user-chat-bridge: hello session snapshot sent', { uid, sessionId: agg.peerId })
    } catch (error) {
      // A failing session must not block hello forwarding or other sessions.
      const code = (error as { code?: unknown } | null)?.code
      log?.warn('hello_session_snapshot_failed', {
        uid, sessionId: agg.peerId, connId,
        errorName: error instanceof Error && /^(?:Error|TypeError|SyntaxError|RangeError|AbortError)$/.test(error.name)
          ? error.name : 'Error',
        ...(typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? { errorCode: code } : {}),
      })
    }
  }
}
