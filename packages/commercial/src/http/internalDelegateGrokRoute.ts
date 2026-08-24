/**
 * Master-side mint/renew/release for container-local delegate Grok relay routes.
 *
 * Browser grok-build turns get their master-minted route injected per frame by
 * the user chat bridge (`__oc_grok_route`). Container-local delegate turns
 * (delegate_task / taskboard patrol / review) bypass the bridge entirely, so
 * the container gateway asks this endpoint for the same kind of route against
 * the same account pool and the same durable `grok_route_contexts`
 * concurrency authority.
 *
 * Trust boundary mirrors internalGrokRelay / internalTurnLeaseRenew:
 * verifyContainerIdentity (oc-v3 bearer + (host_uuid, bound_ip) row) decides
 * containerId/userId; body-supplied identity fields are rejected at the
 * schema level. Release/renew additionally scope the row lookup to the
 * caller's (containerId, userId), so one container can never expire or slide
 * another container's lease.
 *
 * Mount gating: only routed when the master runs with the selfhost
 * engine-local-turn exemption (OC_SELFHOST_ENGINE_LOCAL_TURNS=1, parity with
 * gateway modelAuthority.ts isEngineLocalTurnExempt). Production masters never
 * mount it: production containers reject grok delegate turns in
 * decideLocalExecution long before they could call here, and an unrouted path
 * keeps this a fail-closed non-billing bypass rather than an open one.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { type Logger, rootLogger } from '../logging/logger.js'
import { REQUEST_ID_HEADER, ensureRequestId, isObj, setSecurityHeaders } from './util.js'

export const DELEGATE_GROK_ROUTE_MINT_PATH = '/internal/v5/delegate/grok-route/mint'
export const DELEGATE_GROK_ROUTE_RELEASE_PATH = '/internal/v5/delegate/grok-route/release'
export const DELEGATE_GROK_ROUTE_RENEW_PATH = '/internal/v5/delegate/grok-route/renew'

export function isDelegateGrokRoutePath(path: string): boolean {
  return (
    path === DELEGATE_GROK_ROUTE_MINT_PATH ||
    path === DELEGATE_GROK_ROUTE_RELEASE_PATH ||
    path === DELEGATE_GROK_ROUTE_RENEW_PATH
  )
}

const MAX_BODY_BYTES = 8 * 1024
const MODEL_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/
const SESSION_ID_RE = /^[A-Za-z0-9_:@.-]{1,128}$/
const ROUTE_TOKEN_RE = /^[0-9a-f]{64}$/

/**
 * Allocation outcome wired from index.ts — field-complete alias of the bridge
 * grok branch so createCommercialCodexRoute keeps satisfying CodexRouteDecision
 * while the delegate endpoint consumes the same object.
 */
export type DelegateGrokRouteAllocation =
  | {
      kind: 'api_relay'
      engine: 'grok'
      token: string
      baseUrl: string
      modelProvider: string
      providerName?: string | null
      wireApi?: 'responses' | 'chat'
      preferredAuthMethod?: 'apikey' | 'chatgpt'
      disableResponseStorage?: boolean
      groupId: string
      credentialId: string
      accountId?: string
      slotId?: string
    }
  | { kind: 'unavailable'; reason: string }

export interface DelegateGrokRouteHandlerDeps {
  identityRepo: ContainerIdentityRepo
  /**
   * Throws AccountPoolBusyError when every enabled grok group is at capacity,
   * GrokDelegateLeaseLimitError when this container is over its delegate
   * lease cap (mapped to 429 GROK_DELEGATE_LEASE_LIMIT).
   */
  allocate: (input: {
    containerId: number
    userId: bigint
    modelId: string
    sessionId?: string
  }) => Promise<DelegateGrokRouteAllocation>
  /** Expire the durable row (by lease) + free the scheduler mirror. Idempotent. */
  release: (input: {
    routeToken: string
    containerId: number
    userId: bigint
  }) => Promise<boolean>
  /** Slide the durable TTL + renew the scheduler slot mirror. */
  renew: (input: {
    routeToken: string
    containerId: number
    userId: bigint
  }) => Promise<boolean>
  logger?: Logger
}

export interface DelegateGrokRouteHandlerCtx {
  hostUuid: string
  boundIp: string
}

export type DelegateGrokRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DelegateGrokRouteHandlerCtx,
) => Promise<void>

export function makeDelegateGrokRouteHandler(
  deps: DelegateGrokRouteHandlerDeps,
): DelegateGrokRouteHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'internalDelegateGrokRoute' })
  return async (req, res, ctx) => {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)
    const path = (req.url ?? '/').split('?')[0]
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } })
      return
    }

    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        log.warn('delegate_grok_route_identity_failed', { requestId, path, errcode: err.code })
        sendJson(res, 401, {
          error: { code: 'UNAUTHORIZED', message: 'container identity verification failed' },
        })
        return
      }
      throw err
    }

    let raw: unknown
    try {
      raw = await readBoundedJson(req, MAX_BODY_BYTES)
    } catch {
      sendJson(res, 400, { error: { code: 'INVALID_BODY', message: 'invalid JSON body' } })
      return
    }
    if (!isObj(raw)) {
      sendJson(res, 400, { error: { code: 'INVALID_BODY', message: 'object body required' } })
      return
    }

    if (path === DELEGATE_GROK_ROUTE_MINT_PATH) {
      if (
        typeof raw.modelId !== 'string' ||
        !MODEL_ID_RE.test(raw.modelId) ||
        (raw.sessionId !== undefined &&
          (typeof raw.sessionId !== 'string' || !SESSION_ID_RE.test(raw.sessionId)))
      ) {
        sendJson(res, 400, {
          error: { code: 'INVALID_BODY', message: 'modelId or sessionId malformed' },
        })
        return
      }
      let allocation: DelegateGrokRouteAllocation
      try {
        allocation = await deps.allocate({
          containerId: identity.containerId,
          userId: BigInt(identity.userId),
          modelId: raw.modelId,
          ...(raw.sessionId !== undefined ? { sessionId: raw.sessionId } : {}),
        })
      } catch (err) {
        const errName = (err as { name?: string })?.name
        if (errName === 'AccountPoolBusyError') {
          sendJson(res, 409, {
            error: { code: 'GROK_POOL_BUSY', message: 'grok subscription accounts are busy' },
          })
          return
        }
        // Per-container delegate lease cap (groups.ts): a mint-looping or
        // leaking container must not fill the shared pool for everyone else.
        if (errName === 'GrokDelegateLeaseLimitError') {
          log.warn('delegate_grok_route_lease_limit', {
            requestId,
            userId: String(identity.userId),
            containerId: identity.containerId,
          })
          sendJson(res, 429, {
            error: {
              code: 'GROK_DELEGATE_LEASE_LIMIT',
              message: 'container already holds the maximum number of delegate grok routes',
            },
          })
          return
        }
        log.error('delegate_grok_route_mint_failed', {
          requestId,
          err: (err as Error).message,
        })
        sendJson(res, 500, {
          error: { code: 'INTERNAL', message: 'grok route allocation failed' },
        })
        return
      }
      if (allocation.kind === 'unavailable') {
        sendJson(res, 503, {
          error: { code: 'GROK_POOL_UNAVAILABLE', message: allocation.reason },
        })
        return
      }
      log.info('delegate_grok_route_minted', {
        requestId,
        userId: String(identity.userId),
        containerId: identity.containerId,
        modelId: raw.modelId,
      })
      // Deliberately omit accountId/slotId: the gateway client only consumes
      // baseUrl+routeToken (release/renew are token-scoped), and internal pool
      // identifiers must not leak into containers.
      sendJson(res, 200, {
        ok: true,
        baseUrl: allocation.baseUrl,
        routeToken: allocation.token,
      })
      return
    }

    if (
      typeof raw.routeToken !== 'string' ||
      !ROUTE_TOKEN_RE.test(raw.routeToken)
    ) {
      sendJson(res, 400, {
        error: { code: 'INVALID_BODY', message: 'routeToken malformed' },
      })
      return
    }

    if (path === DELEGATE_GROK_ROUTE_RELEASE_PATH) {
      // Idempotent terminal cleanup: an unknown/already-expired row is success.
      let expiredHere = false
      try {
        expiredHere = await deps.release({
          routeToken: raw.routeToken,
          containerId: identity.containerId,
          userId: BigInt(identity.userId),
        })
      } catch (err) {
        log.error('delegate_grok_route_release_failed', {
          requestId,
          err: (err as Error).message,
        })
        sendJson(res, 500, {
          error: { code: 'INTERNAL', message: 'grok route release failed' },
        })
        return
      }
      sendJson(res, 200, { ok: true, expired: expiredHere })
      return
    }

    if (path === DELEGATE_GROK_ROUTE_RENEW_PATH) {
      let live = false
      try {
        live = await deps.renew({
          routeToken: raw.routeToken,
          containerId: identity.containerId,
          userId: BigInt(identity.userId),
        })
      } catch (err) {
        log.error('delegate_grok_route_renew_failed', {
          requestId,
          err: (err as Error).message,
        })
        sendJson(res, 500, {
          error: { code: 'INTERNAL', message: 'grok route renew failed' },
        })
        return
      }
      sendJson(res, 200, { ok: live, ...(live ? {} : { expired: true }) })
      return
    }

    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'unknown delegate grok route path' } })
  }
}

async function readBoundedJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const bytes = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string)
    total += bytes.length
    if (total > maxBytes) throw new Error('request too large')
    chunks.push(bytes)
  }
  if (total === 0) throw new Error('empty body')
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8'))
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}
