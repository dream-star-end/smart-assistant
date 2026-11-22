/**
 * Commercial master → user-container proxy handler for Swarm control commands:
 *   - POST `/api/sessions/:id/swarm/command`
 *
 * Security invariants:
 *   1. Authenticates caller via Bearer JWT or `oc_session` cookie (401 on failure).
 *   2. Verifies active account in DB when `v3Supervisor` is wired (403 if inactive).
 *   3. Rejects client-supplied `brainDir` immediately at master edge (`400 FORBIDDEN_FIELD`).
 *   4. Verifies `sessionId` ownership via `ClientSessionsBackend` (`403 FORBIDDEN` if another
 *      user's session, `404 SWARM_NOT_FOUND` if missing/deleted).
 *   5. Forwards strictly to the caller's own running container `/internal/swarm/command`
 *      with signed `X-OpenClaude-Container-Id` + `X-OpenClaude-Bridge-Nonce` +
 *      `X-OpenClaude-User-Id` headers.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  INTERNAL_SWARM_COMMAND_PATH,
  INTERNAL_SWARM_USER_ID_HEADER,
  SWARM_COMMAND_ROUTE_RE,
} from '@openclaude/gateway'
import { verifyClientSessionOwnership } from '@openclaude/storage'
import { MASTER_USER_PREFIX } from '../wechat/userIds.js'
import { ContainerUnreadyError } from '../ws/userChatBridge.js'
import {
  ContainerInternalRequestError,
  requestUserContainerInternal,
  type ContainerInternalClientDeps,
} from './containerInternalClient.js'
import { authenticateActiveCommercialUser } from './activeUserAuth.js'
import type { CommercialHttpDeps, RequestContext } from './handlers.js'
import { HttpError, readJsonBody, sendJson } from './util.js'

const MAX_SWARM_COMMAND_BODY_BYTES = 32 * 1024

export interface CommercialSwarmCommandDeps {
  /** Test seam: override session ownership lookup ('owner' | 'forbidden' | 'not_found'). */
  verifySessionOwnership?: (
    userId: string,
    sessionId: string,
  ) => Promise<'owner' | 'forbidden' | 'not_found'>
  /** Test seam: override container internal client (e.g., loopback test container). */
  containerClientOverrides?: Partial<ContainerInternalClientDeps>
  /** Test seam: skip DB active account check in unit tests without PG. */
  skipDbActiveCheck?: boolean
}

async function defaultVerifySessionOwnership(
  userId: string,
  sessionId: string,
): Promise<'owner' | 'forbidden' | 'not_found'> {
  return verifyClientSessionOwnership(sessionId, `${MASTER_USER_PREFIX}${userId}`)
}

export async function handleCommercialSwarmCommand(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  if ((req.method ?? '').toUpperCase() !== 'POST') {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'POST required', {
      extraHeaders: { Allow: 'POST' },
    })
  }

  const overrides = deps.swarmCommandRouteDeps
  const user = await authenticateActiveCommercialUser(req, deps.jwtSecret, {
    pool: deps.v3Supervisor?.pool,
    verifyActiveAccount: deps.verifyActiveAccount,
    skipDbActiveCheck: overrides?.skipDbActiveCheck,
  })

  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const match = SWARM_COMMAND_ROUTE_RE.exec(pathname)
  if (!match) {
    throw new HttpError(404, 'NOT_FOUND', 'swarm command route not found')
  }
  let sessionId: string
  try {
    sessionId = decodeURIComponent(match[1]!).trim()
  } catch {
    throw new HttpError(400, 'INVALID_SESSION_ID', 'invalid session id encoding')
  }
  if (!sessionId) {
    throw new HttpError(400, 'INVALID_SESSION_ID', 'sessionId required')
  }

  const rawBody = await readJsonBody(req, MAX_SWARM_COMMAND_BODY_BYTES)
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw new HttpError(400, 'INVALID_BODY', 'JSON object body required')
  }
  const bodyObj = rawBody as Record<string, unknown>

  // Belt-and-suspenders edge check: never forward client-supplied `brainDir`.
  if ('brainDir' in bodyObj) {
    throw new HttpError(400, 'FORBIDDEN_FIELD', 'client-supplied brainDir is not allowed')
  }

  const ownership = overrides?.verifySessionOwnership
    ? await overrides.verifySessionOwnership(user.id, sessionId)
    : await defaultVerifySessionOwnership(user.id, sessionId)

  if (ownership === 'forbidden') {
    throw new HttpError(403, 'FORBIDDEN', 'session does not belong to user')
  }
  if (ownership === 'not_found') {
    throw new HttpError(404, 'SWARM_NOT_FOUND', 'no active swarm for session')
  }

  if (!deps.v3Supervisor || !deps.bridgeSecret) {
    throw new HttpError(503, 'SWARM_COMMAND_UNAVAILABLE', 'container runtime unavailable')
  }

  const uid = BigInt(user.id)
  if (deps.ensureContainerReady) {
    try {
      await deps.ensureContainerReady(uid)
    } catch (err) {
      if (err instanceof ContainerUnreadyError) {
        throw new HttpError(503, 'CONTAINER_UNREADY', `container not ready: ${err.reason}`, {
          extraHeaders: { 'Retry-After': err.retryAfterSec },
        })
      }
      throw err
    }
  }

  const clientDeps: ContainerInternalClientDeps = {
    v3: deps.v3Supervisor,
    bridgeSecret: deps.bridgeSecret,
    selfHostId: deps.v3Supervisor.selfHostId,
    ...overrides?.containerClientOverrides,
  }

  try {
    const resp = await requestUserContainerInternal(clientDeps, {
      uid,
      method: 'POST',
      pathAndQuery: `${INTERNAL_SWARM_COMMAND_PATH}?sessionId=${encodeURIComponent(sessionId)}`,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        [INTERNAL_SWARM_USER_ID_HEADER]: user.id,
      },
      body: JSON.stringify(bodyObj),
    })

    let parsed: unknown = null
    try {
      parsed = resp.body.length > 0 ? JSON.parse(resp.body.toString('utf8')) : null
    } catch {
      parsed = null
    }
    if (parsed && typeof parsed === 'object') {
      sendJson(res, resp.status, parsed)
      return
    }
    throw new HttpError(
      resp.status >= 400 ? resp.status : 502,
      'BAD_GATEWAY',
      'invalid swarm command response from container',
    )
  } catch (err) {
    if (err instanceof ContainerInternalRequestError) {
      throw new HttpError(err.httpStatus, err.code, err.message)
    }
    throw err
  }
}
