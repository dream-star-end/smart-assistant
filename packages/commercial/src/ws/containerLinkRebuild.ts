import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { getContainerLinkHandle, type ContainerLinkRegistry } from './containerLink.js'
import { attachContainerTransport } from './containerLinkTransport.js'
import type { UserChatBridgeDeps, ResolveContainerEndpoint } from './userChatBridge.js'
import type { LinkCarrier, LinkDispatch } from './containerLinkRecoveryStore.js'

/** No browser input, quota slot, keepalive or authorization context. */
class RecoverySubscriber extends EventEmitter {
  readyState: number = WebSocket.CLOSED
  bufferedAmount = 0
  send(): void {}
  ping(): void {}
  close(): void { this.emit('close', 1000, Buffer.alloc(0)) }
  terminate(): void { this.close() }
}
type Endpoint = Awaited<ReturnType<ResolveContainerEndpoint>>
export type StartRecoveryBridge = (user: WebSocket, uid: bigint, endpoint: Endpoint, socket: WebSocket, abort: AbortController, connId: string) => void

export async function rebuildContainerLink(input: {
  carrier: LinkCarrier; rows: LinkDispatch[]; signal: AbortSignal
  links: ContainerLinkRegistry; deps: UserChatBridgeDeps; maxFrameBytes: number; start: StartRecoveryBridge
}): Promise<'rebuilt' | 'attached' | 'vanished'> {
  const { carrier, signal, links, deps } = input
  const uid = BigInt(carrier.uid)
  const endpoint = await deps.resolveContainerLinkEndpoint!(uid, carrier.containerId)
  if (signal.aborted || links.stopping) throw new Error('container link recovery stopped')
  if (!endpoint || endpoint.containerId !== carrier.containerId) return 'vanished'
  const existed = links.snapshots().some(link => link.uid === carrier.uid && link.containerId === carrier.containerId)
  const connId = randomUUID()
  const abort = new AbortController()
  const cancel = () => abort.abort()
  signal.addEventListener('abort', cancel, { once: true })
  let socket: WebSocket | undefined
  try {
    socket = await attachContainerTransport({ uid, endpoint, links, deps, maxFrameBytes: input.maxFrameBytes, signal: abort.signal, connId })
    if (signal.aborted || links.stopping) throw new Error('container link recovery stopped')
    const handle = getContainerLinkHandle(socket)!
    handle.recoveryOnly = true
    for (const row of input.rows) handle.restoreDispatch(row)
    if (!handle.hasOpenDispatches) { socket.terminate(); return 'attached' }
    const user = new RecoverySubscriber()
    input.start(user as unknown as WebSocket, uid, endpoint, socket, abort, connId)
    // Existing cleanup detaches timers/executors while retaining open streams.
    user.close()
    const opened = new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); socket!.off('open', onOpen); socket!.off('error', onError); socket!.off('close', onClose); signal.removeEventListener('abort', onAbort) }
      const onOpen = () => { cleanup(); resolve() }
      const onError = (error: Error) => { cleanup(); reject(error) }
      const onClose = () => onError(new Error('container link closed during rebuild'))
      const onAbort = () => onError(new Error('container link recovery stopped'))
      const timer = setTimeout(() => onError(new Error('container link rebuild timeout')), deps.containerConnectTimeoutMs ?? 5000)
      socket!.once('open', onOpen); socket!.once('error', onError); socket!.once('close', onClose)
      signal.addEventListener('abort', onAbort, { once: true })
      handle.activate()
    })
    await opened
    if (signal.aborted) throw new Error('container link recovery stopped')
    const peers = [...new Map(input.rows.map(row => [`${row.agentId}:${row.sessionId}`, { peerId: row.sessionId, agentId: row.agentId }])).values()]
    // Gateway hello accepts eight peers per frame. Link prepares PG cursors.
    for (let offset = 0; offset < peers.length; offset += 8) {
      await new Promise<void>((resolve, reject) => socket!.send(Buffer.from(JSON.stringify({ type: 'inbound.hello', peers: peers.slice(offset, offset + 8) })), {}, error => error ? reject(error) : resolve()))
    }
    return existed ? 'attached' : 'rebuilt'
  } catch (error) {
    socket?.terminate()
    throw error
  } finally { signal.removeEventListener('abort', cancel) }
}
