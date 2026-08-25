import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { getAutoDreamPolicy } from '../user/autoDream.js'
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from './util.js'

export { AUTO_DREAM_POLICY_PATH } from '@openclaude/protocol'

export type AutoDreamPolicyHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { hostUuid: string; boundIp: string },
) => Promise<void>

function send(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify({ ...(body as object), requestId }))
}

/** Container-authenticated, identity-derived effective Auto-Dream policy. */
export function makeAutoDreamPolicyHandler(deps: {
  identityRepo: ContainerIdentityRepo
}): AutoDreamPolicyHandler {
  return async (req, res, ctx) => {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)
    if (req.method !== 'GET') {
      send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'GET required' } }, requestId)
      return
    }
    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'identity verification failed' } }, requestId)
        return
      }
      throw err
    }
    try {
      send(res, 200, await getAutoDreamPolicy(identity.userId), requestId)
    } catch {
      // Policy is fail-closed: the container treats any non-2xx/malformed
      // response as disabled and never starts a paid background call.
      send(res, 503, { error: { code: 'AUTO_DREAM_POLICY_UNAVAILABLE', message: 'policy unavailable' } }, requestId)
    }
  }
}
