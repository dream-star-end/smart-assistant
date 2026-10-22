/**
 * Gateway prompt queue client wiring: queue context, client registration, grant cancellation, snapshots and queued-turn dispatch
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-533. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. PromptQueueDispatchHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import { PROMPT_QUEUE_DISPATCH_CANCEL_TYPE, type PromptQueueDispatchRequest, type PromptQueueDispatchCancel, type PromptQueueSessionContext } from './promptQueueCoordinator.js'
import { WebSocket } from 'ws'
import { makePeerKey } from './server.js'
import type { Gateway } from './server.js'

export interface PromptQueueDispatchHost {
  _bridgeConnections: Gateway['_bridgeConnections']
  _promptQueueClientSessions: Gateway['_promptQueueClientSessions']
  _promptQueueCoordinator: Gateway['_promptQueueCoordinator']
  _sendStampedSessionFrame: Gateway['_sendStampedSessionFrame']
  clientsByPeer: Gateway['clientsByPeer']
  log: Gateway['log']
}

export function _promptQueueContext(this: PromptQueueDispatchHost, userId: string, peerId: string, agentId: string): PromptQueueSessionContext {
  const safeId = peerId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return {
    userId,
    owner: {
      sessionKey: `agent:${agentId}:webchat:dm:${safeId}`,
      clientSessionId: peerId,
      agentId,
      peer: { id: peerId, kind: 'dm' },
    },
  }
}

export function _registerPromptQueueClient(this: PromptQueueDispatchHost, ws: WebSocket, context: PromptQueueSessionContext): void {
  let registered = this._promptQueueClientSessions.get(ws)
  if (!registered) {
    registered = new Set()
    this._promptQueueClientSessions.set(ws, registered)
  }
  if (!registered.has(context.owner.sessionKey)) {
    registered.add(context.owner.sessionKey)
    ws.once('close', () => {
      void this._promptQueueCoordinator?.disconnect(context, ws).catch((err) => {
        this.log.warn('prompt queue disconnect cleanup failed', {
          sessionKey: context.owner.sessionKey,
        }, err as Error)
      })
    })
  }
  const peerKey = makePeerKey(context.userId, 'webchat', context.owner.peer.id)
  let set = this.clientsByPeer.get(peerKey)
  if (!set) {
    set = new Set()
    this.clientsByPeer.set(peerKey, set)
  }
  if (set.has(ws)) return
  set.add(ws)
  ws.once('close', () => {
    set?.delete(ws)
    if (set?.size === 0) this.clientsByPeer.delete(peerKey)
  })
}

/** If commercial preparation already reserved a slot/precheck/journal but
 * the gateway cannot consume the exact grant, tell that same trusted bridge
 * to unwind immediately. The bridge validates every original correlation
 * field before applying compensation, so a malformed/forged marker is inert. */
export function _sendPromptQueueGrantCancellation(this: PromptQueueDispatchHost, ws: WebSocket, context: PromptQueueSessionContext, markerValue: unknown, reasonCode: string): boolean {
  if (
    !markerValue || typeof markerValue !== 'object' || Array.isArray(markerValue) ||
    !this._bridgeConnections.has(ws) || ws.readyState !== WebSocket.OPEN
  ) return false
  const marker = markerValue as Record<string, unknown>
  if (
    typeof marker.grantId !== 'string' ||
    typeof marker.itemId !== 'string' ||
    typeof marker.contentHash !== 'string' ||
    typeof marker.epoch !== 'string' ||
    typeof marker.claimToken !== 'string'
  ) return false
  const cancel: PromptQueueDispatchCancel = {
    type: PROMPT_QUEUE_DISPATCH_CANCEL_TYPE,
    grantId: marker.grantId,
    owner: context.owner,
    itemId: marker.itemId,
    contentHash: marker.contentHash,
    epoch: marker.epoch,
    claimToken: marker.claimToken,
    reasonCode,
  }
  try {
    ws.send(JSON.stringify(cancel))
    return true
  } catch {
    return false
  }
}

export function _broadcastPromptQueueSnapshot(this: PromptQueueDispatchHost, context: PromptQueueSessionContext, snapshot: import('@openclaude/protocol').PromptQueueSnapshot): void {
  const peerKey = makePeerKey(context.userId, 'webchat', context.owner.peer.id)
  this._sendStampedSessionFrame(context.owner.sessionKey, peerKey, snapshot as unknown as Record<string, unknown>)
}

export function _sendPromptQueueSnapshotToClient(this: PromptQueueDispatchHost, _context: PromptQueueSessionContext, ws: WebSocket, snapshot: import('@openclaude/protocol').PromptQueueSnapshot): void {
  if (ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(JSON.stringify({ ...snapshot, ts: Date.now() }))
  } catch {}
}

export function _sendPromptQueueDispatch(this: PromptQueueDispatchHost, context: PromptQueueSessionContext, frame: PromptQueueDispatchRequest): boolean {
  const peerKey = makePeerKey(context.userId, 'webchat', context.owner.peer.id)
  const clients = this.clientsByPeer.get(peerKey)
  if (!clients) return false
  const data = JSON.stringify(frame)
  for (const ws of clients) {
    if (!this._bridgeConnections.has(ws) || ws.readyState !== WebSocket.OPEN) continue
    try {
      ws.send(data)
      return true
    } catch {
      // Try another bridge tab before treating the claim as undeliverable.
    }
  }
  return false
}
