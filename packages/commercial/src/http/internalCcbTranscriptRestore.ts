import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CCB_TRANSCRIPT_RESTORE_PATH, type CcbNativeTranscriptArchive, type CcbTranscriptRestoreBinding } from '@openclaude/protocol'
import { verifyContainerIdentity, type ContainerIdentityRepo } from '../auth/containerIdentity.js'
import { ensureRequestId, setSecurityHeaders, sendJsonError } from './util.js'
import type { ServerAuthoredHandler } from './internalServerAuthored.js'

export { CCB_TRANSCRIPT_RESTORE_PATH }
interface Deps {
  identityRepo: ContainerIdentityRepo
  read: (owner: string, binding: CcbTranscriptRestoreBinding) => Promise<CcbNativeTranscriptArchive>
  verify?: (req: IncomingMessage, ctx: Parameters<ServerAuthoredHandler>[2]) => Promise<{ userId: number }>
}
async function waitForDrain(res: ServerResponse): Promise<void> {
  if (res.destroyed) throw new Error('CLOSED')
  await new Promise<void>((accept, reject) => {
    const cleanup = () => { res.off('drain', drained); res.off('close', closed); res.off('error', closed) }
    const drained = () => { cleanup(); accept() }
    const closed = () => { cleanup(); reject(new Error('CLOSED')) }
    res.once('drain', drained); res.once('close', closed); res.once('error', closed)
  })
}
/** Internal listener only. A complete digest trailer is required by the
 * consumer; a disconnected response can never authorize a partial restore. */
export function makeCcbTranscriptRestoreHandler(deps: Deps): ServerAuthoredHandler {
  return async (req, res, ctx) => {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader('x-request-id', requestId)
    if (req.method !== 'GET') { sendJsonError(res, 405, 'METHOD_NOT_ALLOWED', 'GET required', requestId); return }
    let owner: string
    try {
      const identity = deps.verify ? await deps.verify(req, ctx) : await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
      owner = `c:${identity.userId}`
    } catch { sendJsonError(res, 401, 'UNAUTHORIZED', 'container identity verification failed', requestId); return }
    const url = new URL(req.url ?? '/', 'http://internal')
    const peerId = url.searchParams.get('peerId') ?? ''
    const agentId = url.searchParams.get('agentId') ?? ''
    const nativeSessionId = url.searchParams.get('nativeSessionId') ?? ''
    const queryKeys = [...url.searchParams.keys()]
    if (queryKeys.length !== 3 || new Set(queryKeys).size !== 3 || queryKeys.some(key => !['peerId', 'agentId', 'nativeSessionId'].includes(key))
      || !/^[A-Za-z0-9_-]{1,160}$/.test(peerId) || !/^[A-Za-z0-9_-]{1,64}$/.test(agentId)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(nativeSessionId)) {
      sendJsonError(res, 400, 'INVALID_RESTORE_BINDING', 'invalid continuity binding', requestId); return
    }
    try {
      const archive = await deps.read(owner, { peerId, agentId, nativeSessionId })
      const bytes = Buffer.from(JSON.stringify(archive))
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      res.statusCode = 200
      res.setHeader('content-type', 'application/x-ndjson')
      res.setHeader('cache-control', 'no-store')
      let index = 0
      for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
        if (res.destroyed) return
        if (!res.write(JSON.stringify({ index: index++, data: bytes.subarray(offset, offset + 256 * 1024).toString('base64') }) + '\n')) {
          await waitForDrain(res)
        }
      }
      res.end(JSON.stringify({ complete: true, chunks: index, bytes: bytes.length, sha256 }) + '\n')
    } catch {
      // Never print raw parser/network errors: they can contain native content.
      if (!res.headersSent) sendJsonError(res, 409, 'CCB_TRANSCRIPT_RESTORE_UNAVAILABLE', 'complete continuity archive unavailable', requestId)
      else res.destroy()
    }
  }
}
