/**
 * Master-side mint/renew/release for container-local delegate Antigravity
 * relay routes (OCV5-738).
 *
 * Browser Antigravity turns get their master-minted route injected per frame
 * by the user chat bridge (`__oc_antigravity_route`). Container-local delegate
 * turns (delegate_task / taskboard patrol / review) bypass the bridge entirely,
 * so the container gateway asks this endpoint for the same kind of route
 * against the same account pool, the same `antigravity_turns` durable record
 * and the same `antigravity_relay_usage` meter.
 *
 * Two-phase on purpose: the delegate engine-billing admit already created the
 * 32-hex requestId, precheck reservation and inflight journal row. Mint reads
 * that row (never a body-supplied model/container/user), so the route can only
 * be issued for a delegate admission this container actually owns, and the
 * budget is the reservation the admission already took.
 *
 * Trust boundary mirrors internalDelegateGrokRoute: verifyContainerIdentity
 * (oc-v3 bearer + (host_uuid, bound_ip) row) decides containerId/userId, and
 * every mint input is read from the journal row — body-supplied identity or
 * model fields can never select another container's admission. Release/
 * renew scope the route to the caller's (containerId, userId), so one
 * container can never expire or slide another container's route.
 *
 * Mount gating: only routed when master runs the selfhost engine-local-turn
 * exemption (OC_SELFHOST_ENGINE_LOCAL_TURNS=1). Production masters never mount
 * it, and production containers already reject antigravity delegate turns in
 * decideLocalExecution.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'

import { isAntigravityEngineModel } from '@openclaude/protocol'

import {
  AntigravityAdmissionError,
  admitAntigravityTurn,
} from '../account-pool/antigravityAdmission.js'
import { releaseInflight } from '../account-pool/policy/affinity.js'
import {
  abandonAntigravityTurn,
  recordAntigravityTurn,
} from '../billing/antigravitySettle.js'
import {
  expireAntigravityRelayRoute,
  resolveAntigravityRelayRoute,
} from '../billing/antigravityRouteContext.js'
import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { type Logger, rootLogger } from '../logging/logger.js'
import { REQUEST_ID_HEADER, ensureRequestId, isObj, setSecurityHeaders } from './util.js'

import {
  DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH,
  DELEGATE_ANTIGRAVITY_ROUTE_RELEASE_PATH,
  DELEGATE_ANTIGRAVITY_ROUTE_RENEW_PATH,
  isDelegateAntigravityRoutePath,
} from '@openclaude/protocol'

export {
  DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH,
  DELEGATE_ANTIGRAVITY_ROUTE_RELEASE_PATH,
  DELEGATE_ANTIGRAVITY_ROUTE_RENEW_PATH,
  isDelegateAntigravityRoutePath,
}

const MAX_BODY_BYTES = 8 * 1024
const REQUEST_ID_RE = /^[0-9a-f]{32}$/
const ROUTE_TOKEN_RE = /^[0-9a-f]{64}$/

export interface DelegateAntigravityRouteDeps {
  identityRepo: ContainerIdentityRepo
  logger?: Logger
  /** Loopback relay port the minted route must target (V3_CONTAINER_PORT). */
  relayPort: number
  /** OC_ANTIGRAVITY_OAUTH_CLIENT_SECRET; empty → 503 ANTIGRAVITY_NOT_CONFIGURED. */
  clientSecret: string
  /** Journal + turn-record pool used to bind mint to an owned delegate admission. */
  pool: Pick<Pool, 'query'>
  admit?: typeof admitAntigravityTurn
  recordTurn?: typeof recordAntigravityTurn
  abandonTurn?: typeof abandonAntigravityTurn
  expireRoute?: (token: string) => Promise<void>
  resolveRoute?: typeof resolveAntigravityRelayRoute
  releaseInflightFn?: typeof releaseInflight
}

export interface DelegateAntigravityRouteHandlerCtx {
  hostUuid: string
  boundIp: string
}

export type DelegateAntigravityRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DelegateAntigravityRouteHandlerCtx,
) => Promise<void>

interface JournalAdmissionRow {
  user_id: string
  container_id: string | null
  state: string
  ctx: Record<string, unknown> | null
  precheck_credits: string | null
}

export function makeDelegateAntigravityRouteHandler(
  deps: DelegateAntigravityRouteDeps,
): DelegateAntigravityRouteHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'internalDelegateAntigravityRoute' })
  const runAdmit = deps.admit ?? admitAntigravityTurn
  const runRecord = deps.recordTurn ?? recordAntigravityTurn
  const runAbandon = deps.abandonTurn ?? abandonAntigravityTurn
  const runResolve = deps.resolveRoute ?? resolveAntigravityRelayRoute
  const runExpire = deps.expireRoute ?? expireAntigravityRelayRoute
  const runReleaseInflight = deps.releaseInflightFn ?? releaseInflight

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
        log.warn('delegate_antigravity_route_identity_failed', {
          requestId,
          path,
          errcode: err.code,
        })
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

    if (path === DELEGATE_ANTIGRAVITY_ROUTE_MINT_PATH) {
      if (typeof raw.requestId !== 'string' || !REQUEST_ID_RE.test(raw.requestId)) {
        sendJson(res, 400, {
          error: { code: 'INVALID_BODY', message: 'requestId malformed' },
        })
        return
      }
      const journalRequestId = raw.requestId
      let row: JournalAdmissionRow | undefined
      try {
        const result = await deps.pool.query(
          `SELECT user_id::text AS user_id, container_id::text AS container_id, state,
                  ctx, precheck_credits::text AS precheck_credits
             FROM request_finalize_journal WHERE request_id=$1`,
          [journalRequestId],
        )
        row = result.rows[0] as JournalAdmissionRow | undefined
      } catch (err) {
        log.error('delegate_antigravity_route_journal_lookup_failed', {
          requestId,
          err: (err as Error).message,
        })
        sendJson(res, 503, {
          error: { code: 'ANTIGRAVITY_ROUTE_JOURNAL_UNAVAILABLE', message: 'journal unavailable' },
        })
        return
      }
      const invalid = validateAdmissionRow(row, identity)
      if (invalid) {
        log.warn('delegate_antigravity_route_journal_rejected', {
          requestId,
          reason: invalid,
          userId: String(identity.userId),
          containerId: identity.containerId,
        })
        sendJson(res, 409, {
          error: { code: 'DELEGATE_ANTIGRAVITY_ROUTE_JOURNAL_INVALID', message: invalid },
        })
        return
      }
      const claim = row as JournalAdmissionRow
      const ctxJson = claim.ctx ?? {}
      if (typeof ctxJson.antigravityRouteToken === 'string') {
        // A retry whose response was lost. The route itself cannot be replayed
        // (access tokens are not stored), so fail closed; the container
        // abandons the admission and the journal token is released there.
        sendJson(res, 409, {
          error: {
            code: 'DELEGATE_ANTIGRAVITY_ROUTE_ALREADY_MINTED',
            message: 'route already minted for this admission',
          },
        })
        return
      }
      const modelId = ctxJson.model
      if (typeof modelId !== 'string' || !isAntigravityEngineModel(modelId)) {
        sendJson(res, 409, {
          error: {
            code: 'DELEGATE_ANTIGRAVITY_ROUTE_JOURNAL_INVALID',
            message: 'admission model is not an Antigravity model',
          },
        })
        return
      }
      const budgetCredits =
        typeof claim.precheck_credits === 'string' && /^\d+$/.test(claim.precheck_credits)
          ? BigInt(claim.precheck_credits)
          : 0n
      if (budgetCredits <= 0n) {
        sendJson(res, 503, {
          error: { code: 'ANTIGRAVITY_BUDGET_UNAVAILABLE', message: 'admission budget missing' },
        })
        return
      }
      const userId = BigInt(identity.userId)
      let minted: Awaited<ReturnType<typeof admitAntigravityTurn>>
      try {
        minted = await runAdmit(
          {
            containerId: identity.containerId,
            userId,
            requestId: journalRequestId,
            modelId,
            budgetCredits,
            relayPort: deps.relayPort,
          },
          { clientSecret: deps.clientSecret },
        )
      } catch (err) {
        const code = err instanceof AntigravityAdmissionError ? err.code : 'ANTIGRAVITY_UNAVAILABLE'
        log.warn('delegate_antigravity_route_mint_failed', {
          requestId,
          userId: String(identity.userId),
          containerId: identity.containerId,
          modelId,
          code,
        })
        sendJson(res, 503, { error: { code, message: code } })
        return
      }

      // Durable before the container can spend: settlement is claimed from
      // this row by the delegate settle path (same authority as chat turns).
      try {
        await runRecord(deps.pool, {
          requestId: journalRequestId,
          userId,
          modelId,
          sessionId: typeof ctxJson.parentSessionId === 'string' ? ctxJson.parentSessionId : null,
          traceId: null,
        })
      } catch (err) {
        await cleanupMinted({ deps, runExpire, runAbandon, runReleaseInflight, log, requestId, userId, journalRequestId, token: minted.token })
        sendJson(res, 503, {
          error: { code: 'ANTIGRAVITY_ROUTE_RECORD_FAILED', message: 'turn record failed' },
        })
        return
      }

      // Persist the opaque token into the admission journal before returning:
      // settle/abandon read it even after a gateway restart.
      let persisted: { rows: Record<string, unknown>[] }
      try {
        persisted = await deps.pool.query(
          `UPDATE request_finalize_journal
              SET ctx = ctx || jsonb_build_object('antigravityRouteToken', $2::text),
                  updated_at = NOW()
            WHERE request_id=$1 AND user_id=$3 AND container_id=$4
              AND state='inflight' AND NOT (ctx ? 'antigravityRouteToken')
            RETURNING request_id`,
          [journalRequestId, minted.token, identity.userId, identity.containerId],
        )
      } catch (err) {
        await cleanupMinted({ deps, runExpire, runAbandon, runReleaseInflight, log, requestId, userId, journalRequestId, token: minted.token })
        sendJson(res, 503, {
          error: { code: 'ANTIGRAVITY_ROUTE_PERSIST_FAILED', message: 'journal persist failed' },
        })
        return
      }
      if (persisted.rows.length !== 1) {
        // Lost the race (concurrent mint) or the journal moved on: never hand
        // out a second live route for one admission.
        await cleanupMinted({ deps, runExpire, runAbandon, runReleaseInflight, log, requestId, userId, journalRequestId, token: minted.token })
        sendJson(res, 409, {
          error: {
            code: 'DELEGATE_ANTIGRAVITY_ROUTE_ALREADY_MINTED',
            message: 'admission already holds a route',
          },
        })
        return
      }

      log.info('delegate_antigravity_route_minted', {
        requestId,
        userId: String(identity.userId),
        containerId: identity.containerId,
        modelId,
      })
      // Deliberately omit account ids and the OAuth client secret: the
      // container only consumes the route + limited token.
      sendJson(res, 200, {
        ok: true,
        route: {
          baseUrl: minted.baseUrl,
          routeToken: minted.token,
          accessToken: minted.accessToken,
          accessTokenExpiresAt: minted.accessTokenExpiresAt,
          ...(minted.idToken ? { idToken: minted.idToken } : {}),
        },
      })
      return
    }

    if (typeof raw.routeToken !== 'string' || !ROUTE_TOKEN_RE.test(raw.routeToken)) {
      sendJson(res, 400, { error: { code: 'INVALID_BODY', message: 'routeToken malformed' } })
      return
    }
    const routeToken = raw.routeToken
    const userId = BigInt(identity.userId)

    if (path === DELEGATE_ANTIGRAVITY_ROUTE_RELEASE_PATH) {
      // Idempotent terminal cleanup: unknown/already-expired is success.
      let owned = false
      try {
        const route = await runResolve({
          token: routeToken,
          containerId: identity.containerId,
          userId,
        })
        owned = route !== null
      } catch (err) {
        log.error('delegate_antigravity_route_release_lookup_failed', {
          requestId,
          err: (err as Error).message,
        })
        sendJson(res, 500, {
          error: { code: 'INTERNAL', message: 'route release failed' },
        })
        return
      }
      if (!owned) {
        sendJson(res, 200, { ok: true, expired: false })
        return
      }
      try {
        await runExpire(routeToken)
      } catch (err) {
        log.error('delegate_antigravity_route_release_failed', {
          requestId,
          err: (err as Error).message,
        })
        sendJson(res, 500, { error: { code: 'INTERNAL', message: 'route release failed' } })
        return
      }
      sendJson(res, 200, { ok: true, expired: true })
      return
    }

    if (path === DELEGATE_ANTIGRAVITY_ROUTE_RENEW_PATH) {
      // Relay calls already renew the KV TTL; this endpoint keeps the delegate
      // lease contract symmetric with grok and proves liveness for the caller.
      let live = false
      try {
        live =
          (await runResolve({
            token: routeToken,
            containerId: identity.containerId,
            userId,
          })) !== null
      } catch (err) {
        log.error('delegate_antigravity_route_renew_failed', {
          requestId,
          err: (err as Error).message,
        })
        sendJson(res, 500, { error: { code: 'INTERNAL', message: 'route renew failed' } })
        return
      }
      sendJson(res, 200, { ok: live, ...(live ? {} : { expired: true }) })
      return
    }

    sendJson(res, 404, {
      error: { code: 'NOT_FOUND', message: 'unknown delegate antigravity route path' },
    })
  }
}

function validateAdmissionRow(
  row: JournalAdmissionRow | undefined,
  identity: { userId: number; containerId: number },
): string | null {
  if (!row) return 'journal not found'
  if (row.user_id !== String(identity.userId)) return 'journal user mismatch'
  if (row.container_id !== String(identity.containerId)) return 'journal container mismatch'
  if (row.state !== 'inflight') return `journal state is ${row.state}`
  const source = row.ctx?.source
  if (source !== 'delegate_antigravity') return 'not a delegate antigravity admission'
  return null
}

async function cleanupMinted(args: {
  deps: DelegateAntigravityRouteDeps
  runExpire: (token: string) => Promise<void>
  runAbandon: typeof abandonAntigravityTurn
  runReleaseInflight: typeof releaseInflight
  log: Pick<Logger, 'warn'>
  requestId: string
  userId: bigint
  journalRequestId: string
  token: string
}): Promise<void> {
  await args.runExpire(args.token).catch(() => {})
  await args.runAbandon(args.deps.pool, args.journalRequestId, args.userId).catch(() => {})
  // Admission reserved one account in-flight unit; a route that never reaches
  // the container must not slowly fill ANTIGRAVITY_MAX_INFLIGHT_PER_ROUTE.
  args.runReleaseInflight(args.journalRequestId)
  args.log.warn('delegate_antigravity_route_mint_rolled_back', {
    requestId: args.requestId,
  })
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
