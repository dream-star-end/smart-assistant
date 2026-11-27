/**
 * Master-side internal container endpoint for remote-pool delegate & remote swarm lanes (OCV5-835).
 *
 * Security & financial invariants:
 *   1. `POST /internal/v3/delegate/remote-lane/ensure`:
 *      - Selfhost v5 only (`getRuntimeChannel() === 'v5' && flavor === 'selfhost'`); commercial returns 404.
 *      - Container 2FA via `verifyContainerIdentity` (never trust body uid/containerId).
 *      - Child `sessionKey` strictly restricted by `isRemoteDriverChildSessionKey` (never webchat/reserved).
 *      - Fresh catalog (`placement === 'remote_pool'`) + user model authz (`snapshot.canUseModel`).
 *      - Master-verified `parentTurnKey` (checked against `turn_dispatches` for this `user_id`, or
 *        resolved via `lookupSingleOpenTurn`) embedded into the Master-signed `ModelAuthorityPayload`
 *        (`billingAttribution: { mode: 'delegate', ... }`) so `remoteDriverTurnBilling` settles child
 *        turns under `mode='delegate'` with `parent_turn_key` intact for parent turn refunds.
 *      - Standard rolling lease window (`TURN_LEASE_TTL_MS` = 50 min) aligned with `TURN_LEASE_RENEW_AFTER_MS`.
 *      - Full compensation rollback: any failure after `selectMasterCc5Backend` (including `admitDispatch`
 *        throw, non-admitted, `signBundle`, or `bindAuthorityTurnDispatch`) settles any admitted dispatch
 *        and releases the exact `(operationId, generation)` lane.
 *   2. `POST /internal/v3/delegate/remote-lane/release`:
 *      - Ownership-bound SQL `UPDATE turn_dispatches` constraining `(dispatch_id, user_id, agent_container_id,
 *        session_id, owner_id, lease_epoch)` — cannot mutate foreign dispatches.
 *      - Generation/operation-scoped lane release (`operationId`, `generation`) — stale releases never stop
 *        a successor lane.
 *      - Honest failure reporting: unproven stop (`state === 'unknown'`) or DB failure returns HTTP 503
 *        `{ released: false, state: 'unknown' }` so callers can retry instead of assuming released.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'

import {
  type AuthorityBillingAttribution,
  type Cc5PolicyEnvironment,
  DELEGATE_REMOTE_LANE_ENSURE_PATH,
  DELEGATE_REMOTE_LANE_RELEASE_PATH,
  TURN_LEASE_TTL_MS,
  isAllowedDelegateModel,
  isDelegateRemoteLaneInternalPath,
  isRemoteDriverChildSessionKey,
  isRemoteDriverExecutionBackend,
} from '@openclaude/protocol'
import { isReservedVerificationSessionKey } from '../account-pool/remotePool/index.js'
import {
  selectMasterCc5Backend,
  type createMasterCc5Runtime,
} from '../agent-sandbox/cc5Runtime.js'
import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import type { makeLoadUserModelAuthz } from '../auth/userModelAuthz.js'
import type { ModelCatalogCache } from '../billing/modelCatalog.js'
import {
  lookupSingleOpenTurn,
  verifyAndBindParentTurnFromEvidence,
} from '../billing/openTurnAttribution.js'
import { bindAuthorityTurnDispatch } from '../billing/verificationSponsorship.js'
import { admitDispatch } from '../dispatch/turnDispatchStore.js'
import type { assertFlavorIdentity } from '../flavor/assertFlavor.js'
import { getRuntimeChannel } from '../runtimeChannel.js'
import type { AuthoritySigner } from '../ws/authoritySigner.js'
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from './util.js'

export {
  DELEGATE_REMOTE_LANE_ENSURE_PATH,
  DELEGATE_REMOTE_LANE_RELEASE_PATH,
  isDelegateRemoteLaneInternalPath,
}

const MAX_BODY_BYTES = 32 * 1024
const AGENT_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/
const MODEL_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const HEX64_RE = /^[a-f0-9]{64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GENERATION_RE = /^[1-9][0-9]{0,15}$/

export type DelegateRemoteLaneHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { hostUuid: string; boundIp: string },
  path: string,
) => Promise<void>

export interface DelegateRemoteLaneDeps {
  identityRepo: ContainerIdentityRepo
  pool: Pool
  flavorIdentity: ReturnType<typeof assertFlavorIdentity>
  env: Cc5PolicyEnvironment
  loadUserModelAuthz: ReturnType<typeof makeLoadUserModelAuthz>
  cc5RuntimeRef: { current: ReturnType<typeof createMasterCc5Runtime> }
  getModelAuthoritySigner: () => AuthoritySigner | null | undefined
  getModelCatalog: () => ModelCatalogCache | null | undefined
}

function sendJsonResponse(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  requestId: string,
): void {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader(REQUEST_ID_HEADER, requestId)
  res.end(payload)
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    total += buf.length
    if (total > MAX_BODY_BYTES) throw new Error('DELEGATE_REMOTE_LANE_BODY_TOO_LARGE')
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks, total).toString('utf8').trim()
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('DELEGATE_REMOTE_LANE_INVALID_JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('DELEGATE_REMOTE_LANE_INVALID_BODY')
  }
  return parsed as Record<string, unknown>
}

function statusForError(code: string): number {
  if (
    code === 'DELEGATE_REMOTE_LANE_INVALID_JSON' ||
    code === 'DELEGATE_REMOTE_LANE_INVALID_BODY' ||
    code === 'DELEGATE_REMOTE_LANE_INVALID_SESSION_KEY' ||
    code === 'DELEGATE_REMOTE_LANE_INVALID_MODEL' ||
    code === 'DELEGATE_REMOTE_LANE_MODEL_FAMILY_NOT_ALLOWED' ||
    code === 'DELEGATE_REMOTE_LANE_NOT_REMOTE_POOL' ||
    code === 'DELEGATE_REMOTE_LANE_INVALID_RELEASE_SCOPE'
  ) {
    return 400
  }
  if (code === 'DELEGATE_REMOTE_LANE_BODY_TOO_LARGE') return 413
  if (
    code === 'DELEGATE_REMOTE_LANE_MODEL_FORBIDDEN' ||
    code === 'DELEGATE_REMOTE_LANE_PARENT_TURN_INVALID' ||
    code === 'REMOTE_SESSION_KEY_RESERVED'
  ) {
    return 403
  }
  if (
    code === 'REMOTE_LANE_UNAVAILABLE' ||
    code === 'REMOTE_LANE_CAPACITY_EXHAUSTED' ||
    code === 'REMOTE_NODE_MEMORY_EXHAUSTED' ||
    code === 'REMOTE_NODE_TASKS_EXHAUSTED' ||
    code === 'REMOTE_POOL_DRAINING_RETRY_LATER' ||
    code === 'DELEGATE_REMOTE_LANE_RUNTIME_UNAVAILABLE'
  ) {
    return 503
  }
  return 500
}

/**
 * Ownership-bound terminal transition on `turn_dispatches`.
 * Distinguishes:
 *   - `'forbidden'`: dispatch does not exist or does not belong to (userId, containerId, sessionId, ownerId)
 *     -> caller MUST abort and MUST NOT stop any lane (B2).
 *   - `'already_terminal'`: dispatch belongs to this exact owner and is already terminal (idempotent).
 *   - `'updated'`: dispatch transitioned cleanly to terminal.
 */
async function terminateOwnedDispatch(
  pool: Pick<Pool, 'query'>,
  args: {
    dispatchId: string
    userId: number
    containerId: number
    sessionId: string
    ownerId: string
    leaseEpoch: number
    outcome: 'completed' | 'interrupted' | 'executed_error' | 'not_accepted'
  },
): Promise<{ status: 'updated' | 'already_terminal' | 'forbidden' }> {
  const existing = await pool.query<{
    user_id: string
    agent_container_id: string | null
    session_id: string
    owner_id: string | null
    status: string
    lease_epoch: string | number
  }>(
    `/* delegate-remote-lane:check-owned */
     SELECT user_id::text, agent_container_id::text, session_id, owner_id, status, lease_epoch
       FROM turn_dispatches
      WHERE dispatch_id = $1::uuid
      LIMIT 1`,
    [args.dispatchId],
  )
  const row = existing.rows[0]
  if (
    !row ||
    row.user_id !== String(args.userId) ||
    row.agent_container_id !== String(args.containerId) ||
    row.session_id !== args.sessionId ||
    row.owner_id !== args.ownerId ||
    Number(row.lease_epoch) !== args.leaseEpoch
  ) {
    return { status: 'forbidden' }
  }
  if (row.status === 'terminal') {
    return { status: 'already_terminal' }
  }
  const result = await pool.query(
    `/* delegate-remote-lane:release-owned */
     UPDATE turn_dispatches
        SET status = 'terminal',
            outcome = $7,
            client_notified = true,
            terminal_at = COALESCE(terminal_at, NOW()),
            lease_until = NULL
      WHERE dispatch_id = $1::uuid
        AND user_id = $2::bigint
        AND agent_container_id = $3::bigint
        AND session_id = $4
        AND owner_id = $5
        AND lease_epoch = $6
        AND status IN ('admitted', 'accepted', 'rejecting')
        AND terminal_at IS NULL
      RETURNING dispatch_id`,
    [
      args.dispatchId,
      String(args.userId),
      String(args.containerId),
      args.sessionId,
      args.ownerId,
      args.leaseEpoch,
      args.outcome,
    ],
  )
  return { status: (result.rowCount ?? 0) > 0 ? 'updated' : 'already_terminal' }
}

/**
 * Verify or resolve Master-authoritative parent billing attribution for a child turn.
 * Explicit `parentTurnKey` MUST belong to an ACTIVE (non-terminal, non-fenced) dispatch
 * owned by `(userId, containerId)` — never an arbitrary historical or already-waived turn (B3).
 */
async function resolveMasterChildAttribution(
  pool: Pick<Pool, 'query' | 'connect'>,
  args: {
    userId: number
    containerId: number
    requestedParentTurnKey?: string
    requestedParentSessionId?: string
    delegateAgentId: string
  },
): Promise<AuthorityBillingAttribution> {
  let verifiedParentTurnKey: string | undefined
  let verifiedParentSessionId: string | undefined

  if (args.requestedParentTurnKey) {
    const hit = await pool.query<{ session_id: string | null }>(
      `/* delegate-remote-lane:verify-parent-turn */
       SELECT session_id
         FROM turn_dispatches
        WHERE user_id = $1::bigint
          AND agent_container_id = $2::bigint
          AND turn_key = $3
          AND status IN ('admitted', 'accepted')
          AND terminal_at IS NULL
          AND producer_fenced_at IS NULL
        ORDER BY admitted_at DESC
        LIMIT 1`,
      [String(args.userId), String(args.containerId), args.requestedParentTurnKey],
    )
    let rowSession = (hit.rowCount ?? 0) > 0 ? hit.rows[0]?.session_id : undefined
    if ((hit.rowCount ?? 0) === 0) {
      // Positive Master-side evidence fallback ONLY (OCV5-898 R2): accept and backfill
      // `turn_dispatches.turn_key` only when `authority_turn_dispatches` or an inflight
      // `request_finalize_journal` already proves `turnKey` belongs to an active dispatch
      // owned by `(userId, containerId)`. Unverified keys (including old containers with
      // no receipt and no Master evidence) fail closed with 403.
      const bound = await verifyAndBindParentTurnFromEvidence(pool, {
        userId: BigInt(args.userId),
        containerId: BigInt(args.containerId),
        turnKey: args.requestedParentTurnKey,
        ...(args.requestedParentSessionId
          ? { requestedParentSessionId: args.requestedParentSessionId }
          : {}),
      })
      if (!bound) {
        throw new Error('DELEGATE_REMOTE_LANE_PARENT_TURN_INVALID')
      }
      rowSession = bound.sessionId
    }
    if (
      args.requestedParentSessionId &&
      typeof rowSession === 'string' &&
      rowSession.length > 0 &&
      rowSession !== args.requestedParentSessionId &&
      !rowSession.endsWith(`:${args.requestedParentSessionId}`)
    ) {
      throw new Error('DELEGATE_REMOTE_LANE_PARENT_TURN_INVALID')
    }
    verifiedParentTurnKey = args.requestedParentTurnKey
    verifiedParentSessionId =
      (typeof rowSession === 'string' && rowSession.length > 0 ? rowSession : undefined) ??
      args.requestedParentSessionId
  } else {
    const open = await lookupSingleOpenTurn(pool, {
      userId: BigInt(args.userId),
      containerId: BigInt(args.containerId),
    }).catch(() => null)
    if (open?.kind === 'one') {
      verifiedParentTurnKey = open.turn.turnKey
      verifiedParentSessionId = open.turn.sessionId || args.requestedParentSessionId
    } else if (args.requestedParentSessionId) {
      verifiedParentSessionId = args.requestedParentSessionId
    }
  }

  return {
    mode: 'delegate',
    ...(verifiedParentTurnKey ? { parentTurnKey: verifiedParentTurnKey } : {}),
    ...(verifiedParentSessionId ? { parentSessionId: verifiedParentSessionId.slice(0, 256) } : {}),
    delegateAgentId: args.delegateAgentId.slice(0, 128),
  }
}

export function makeDelegateRemoteLaneHandler(
  deps: DelegateRemoteLaneDeps,
): DelegateRemoteLaneHandler {
  return async (req, res, ctx, path) => {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)

    if (req.method !== 'POST') {
      sendJsonResponse(
        res,
        405,
        { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } },
        requestId,
      )
      return
    }

    const isSelfhost =
      getRuntimeChannel() === 'v5' &&
      deps.flavorIdentity.status === 'ok' &&
      deps.flavorIdentity.flavor === 'selfhost'
    if (!isSelfhost) {
      sendJsonResponse(
        res,
        404,
        { error: { code: 'NOT_FOUND', message: 'endpoint unavailable' } },
        requestId,
      )
      return
    }

    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        sendJsonResponse(
          res,
          401,
          { error: { code: 'UNAUTHORIZED', message: 'identity verification failed' } },
          requestId,
        )
        return
      }
      throw err
    }

    try {
      const body = await readJsonObject(req)
      const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.trim() : ''
      if (!isRemoteDriverChildSessionKey(sessionKey) || isReservedVerificationSessionKey(sessionKey)) {
        throw new Error('DELEGATE_REMOTE_LANE_INVALID_SESSION_KEY')
      }

      const cc5Runtime = deps.cc5RuntimeRef.current
      if (!cc5Runtime) {
        throw new Error('DELEGATE_REMOTE_LANE_RUNTIME_UNAVAILABLE')
      }

      if (path === DELEGATE_REMOTE_LANE_RELEASE_PATH) {
        const dispatchId = typeof body.dispatchId === 'string' ? body.dispatchId.trim() : ''
        const ownerId = typeof body.ownerId === 'string' ? body.ownerId.trim() : ''
        const leaseEpoch =
          typeof body.leaseEpoch === 'number' && Number.isSafeInteger(body.leaseEpoch) && body.leaseEpoch > 0
            ? body.leaseEpoch
            : 0
        const operationId = typeof body.operationId === 'string' ? body.operationId.trim() : ''
        const generation = typeof body.generation === 'string' ? body.generation.trim() : ''
        const outcomeRaw = typeof body.outcome === 'string' ? body.outcome : 'completed'
        const outcome =
          outcomeRaw === 'interrupted' || outcomeRaw === 'executed_error' || outcomeRaw === 'not_accepted'
            ? outcomeRaw
            : 'completed'
        const releaseLane = body.releaseLane !== false

        if (dispatchId && (!UUID_RE.test(dispatchId) || !ownerId || leaseEpoch <= 0)) {
          throw new Error('DELEGATE_REMOTE_LANE_INVALID_RELEASE_SCOPE')
        }
        if (releaseLane && (!UUID_RE.test(operationId) || (generation && !GENERATION_RE.test(generation)))) {
          throw new Error('DELEGATE_REMOTE_LANE_INVALID_RELEASE_SCOPE')
        }

        let dispatchUpdated = false
        if (dispatchId) {
          try {
            const r = await terminateOwnedDispatch(deps.pool, {
              dispatchId,
              userId: identity.userId,
              containerId: identity.containerId,
              sessionId: sessionKey,
              ownerId,
              leaseEpoch,
              outcome,
            })
            if (r.status === 'forbidden') {
              // Ownership check failed: refuse BEFORE touching any live lane (B2).
              sendJsonResponse(
                res,
                403,
                {
                  released: false,
                  state: 'forbidden',
                  dispatchUpdated: false,
                  sessionKey,
                },
                requestId,
              )
              return
            }
            dispatchUpdated = r.status === 'updated'
          } catch (dbErr) {
            sendJsonResponse(
              res,
              503,
              {
                released: false,
                state: 'unknown',
                error: {
                  code: 'DISPATCH_RELEASE_FAILED',
                  message: dbErr instanceof Error ? dbErr.message.slice(0, 160) : 'dispatch release failed',
                },
              },
              requestId,
            )
            return
          }
        }

        let laneState: 'released' | 'not_found' | 'mismatch' | 'unknown' | 'skipped' = 'skipped'
        let laneReleased = true
        if (releaseLane && typeof cc5Runtime.releaseSessionKey === 'function') {
          try {
            const r = await cc5Runtime.releaseSessionKey(identity.userId, sessionKey, {
              containerDbId: String(identity.containerId),
              operationId,
              ...(generation ? { generation } : {}),
            })
            laneState = r.state
            laneReleased = r.released
          } catch {
            laneState = 'unknown'
            laneReleased = false
          }
        }

        if (laneState === 'unknown') {
          sendJsonResponse(
            res,
            503,
            {
              released: false,
              state: 'unknown',
              dispatchUpdated,
              sessionKey,
            },
            requestId,
          )
          return
        }

        sendJsonResponse(
          res,
          200,
          {
            released: laneReleased,
            state: laneState,
            dispatchUpdated,
            sessionKey,
          },
          requestId,
        )
        return
      }

      if (path !== DELEGATE_REMOTE_LANE_ENSURE_PATH) {
        sendJsonResponse(
          res,
          404,
          { error: { code: 'NOT_FOUND', message: 'unknown remote-lane path' } },
          requestId,
        )
        return
      }

      const signer = deps.getModelAuthoritySigner()
      const catalog = deps.getModelCatalog()
      if (!signer || !catalog) {
        throw new Error('DELEGATE_REMOTE_LANE_RUNTIME_UNAVAILABLE')
      }

      const rawModel = typeof body.model === 'string' ? body.model.trim() : ''
      if (!MODEL_ID_RE.test(rawModel)) {
        throw new Error('DELEGATE_REMOTE_LANE_INVALID_MODEL')
      }
      const rawAgentId = typeof body.agentId === 'string' ? body.agentId.trim() : 'main'
      const agentId = AGENT_ID_RE.test(rawAgentId) ? rawAgentId : 'main'
      const rawDelegateAgentId =
        typeof body.delegateAgentId === 'string' ? body.delegateAgentId.trim() : agentId
      const delegateAgentId = AGENT_ID_RE.test(rawDelegateAgentId) ? rawDelegateAgentId : agentId
      const rawParentTurnKey =
        typeof body.parentTurnKey === 'string' ? body.parentTurnKey.trim() : ''
      if (rawParentTurnKey && !HEX64_RE.test(rawParentTurnKey)) {
        throw new Error('DELEGATE_REMOTE_LANE_PARENT_TURN_INVALID')
      }
      const rawParentSessionId =
        typeof body.parentSessionId === 'string' && body.parentSessionId.trim().length <= 256
          ? body.parentSessionId.trim()
          : undefined
      const rawTurnKey = typeof body.turnKey === 'string' ? body.turnKey.trim() : ''
      const turnKey = HEX64_RE.test(rawTurnKey) ? rawTurnKey : randomBytes(32).toString('hex')

      const snapshot = await catalog.assertFresh()
      const canonical = snapshot.aliasToCanonical(rawModel) ?? rawModel
      const entry = snapshot.resolve(canonical)
      if (
        !entry ||
        entry.placement !== 'remote_pool' ||
        !['ccb', 'codex', 'antigravity'].includes(entry.engine)
      ) {
        throw new Error('DELEGATE_REMOTE_LANE_NOT_REMOTE_POOL')
      }
      if (!isAllowedDelegateModel(entry.canonicalModel)) {
        throw new Error('DELEGATE_REMOTE_LANE_MODEL_FAMILY_NOT_ALLOWED')
      }

      const authz = await deps.loadUserModelAuthz(BigInt(identity.userId))
      const modelScope = { ...authz, uid: authz.uid ?? BigInt(identity.userId) }
      if (!snapshot.canUseModel(modelScope, entry.canonicalModel)) {
        throw new Error('DELEGATE_REMOTE_LANE_MODEL_FORBIDDEN')
      }

      const billingAttribution = await resolveMasterChildAttribution(deps.pool, {
        userId: identity.userId,
        containerId: identity.containerId,
        ...(rawParentTurnKey ? { requestedParentTurnKey: rawParentTurnKey } : {}),
        ...(rawParentSessionId ? { requestedParentSessionId: rawParentSessionId } : {}),
        delegateAgentId,
      })

      const executionBackend = await selectMasterCc5Backend(
        cc5Runtime,
        {
          uid: identity.userId,
          containerId: identity.containerId,
          sessionKey,
          canonicalModel: entry.canonicalModel,
          engine: entry.engine,
          placement: 'remote_pool',
        },
        true,
        deps.env,
      )
      if (!executionBackend || !isRemoteDriverExecutionBackend(executionBackend)) {
        throw new Error('REMOTE_LANE_UNAVAILABLE')
      }

      const dispatchId = randomUUID()
      const billingRequestId = randomBytes(16).toString('hex')
      const clientMessageId = `drl-${randomUUID()}`
      const ownerId = `delegate-remote:${identity.containerId}:${dispatchId.slice(0, 8)}`
      const requestHash = createHash('sha256')
        .update(`${identity.userId}:${sessionKey}:${entry.canonicalModel}:${turnKey}`)
        .digest('hex')

      let admittedDispatch: { dispatchId: string; ownerId: string; leaseEpoch: number; attemptNo: number } | null = null
      try {
        const admit = await admitDispatch(deps.pool, {
          dispatchId,
          userId: BigInt(identity.userId),
          sessionId: sessionKey,
          clientMessageId,
          agentId,
          model: entry.canonicalModel,
          requestHash,
          billingRequestId,
          ownerId,
          anchorSeq: null,
          leaseTtlMs: TURN_LEASE_TTL_MS,
          agentContainerId: identity.containerId,
          runtimeKind: 'v5',
        })
        if (admit.kind !== 'admitted') {
          throw new Error(`DELEGATE_REMOTE_LANE_DISPATCH_${admit.kind.toUpperCase()}`)
        }
        admittedDispatch = {
          dispatchId: admit.dispatch.dispatchId,
          ownerId: admit.dispatch.ownerId ?? ownerId,
          leaseEpoch: admit.dispatch.leaseEpoch,
          attemptNo: admit.dispatch.attemptNo,
        }

        const signed = signer.signBundle(
          {
            uid: identity.userId,
            containerId: identity.containerId,
            connectionChallenge: `drl-${randomBytes(16).toString('hex')}`,
            canonicalModel: entry.canonicalModel,
            engine: entry.engine as 'ccb' | 'codex' | 'antigravity',
            auxModels: [],
            executionRevision: snapshot.executionRevision,
            securityEpoch: Number(snapshot.securityEpoch),
            billingRequestId,
            billingAttribution,
            executionBackend,
            executionDescriptor: {
              capabilityProfile: entry.capabilityProfile as never,
              capabilitySchemaVersion: entry.capabilitySchemaVersion,
              contextWindow: entry.contextWindow,
              supportedEfforts: [...entry.capabilityProfile.reasoning.supported],
              ...(entry.capabilityProfile.reasoning.codexModelDefault === null
                ? {}
                : { codexDefaultEffort: entry.capabilityProfile.reasoning.codexModelDefault }),
              supportsVision: Boolean(entry.capabilityProfile.supportsVision),
            },
          },
          { leaseTtlMs: TURN_LEASE_TTL_MS },
        )

        await bindAuthorityTurnDispatch(deps.pool, {
          authorityTurnId: signed.payload.authorityTurnId,
          dispatchId: admittedDispatch.dispatchId,
          userId: BigInt(identity.userId),
          sessionId: sessionKey,
          dispatchModel: entry.canonicalModel,
          canonicalModel: entry.canonicalModel,
          attemptNo: admittedDispatch.attemptNo,
          ownerId: admittedDispatch.ownerId,
          leaseEpoch: admittedDispatch.leaseEpoch,
          agentContainerId: identity.containerId,
          runtimeKind: 'v5',
        })

        sendJsonResponse(
          res,
          200,
          {
            canonicalModel: entry.canonicalModel,
            engine: entry.engine,
            executionBackend,
            modelAuthority: signed.bundle,
            executionDescriptor: {
              canonicalModel: entry.canonicalModel,
              contextWindow: entry.contextWindow,
              capabilityZero: Boolean(entry.capabilityProfile.ccb.capabilityZero),
              supportsThinking: Boolean(entry.capabilityProfile.ccb.supportsThinking),
              supportsVision: Boolean(entry.capabilityProfile.supportsVision),
              supportedEfforts: [...entry.capabilityProfile.reasoning.supported],
              ...(entry.capabilityProfile.ccb.contextOwner === 'box-native-v1'
                ? { contextOwner: 'box-native-v1' }
                : {}),
            },
            turnKey,
            billingRequestId,
            dispatchId: admittedDispatch.dispatchId,
            ownerId: admittedDispatch.ownerId,
            leaseEpoch: admittedDispatch.leaseEpoch,
          },
          requestId,
        )
      } catch (postLaneErr) {
        if (admittedDispatch) {
          await terminateOwnedDispatch(deps.pool, {
            dispatchId: admittedDispatch.dispatchId,
            userId: identity.userId,
            containerId: identity.containerId,
            sessionId: sessionKey,
            ownerId: admittedDispatch.ownerId,
            leaseEpoch: admittedDispatch.leaseEpoch,
            outcome: 'not_accepted',
          }).catch(() => {})
        }
        if (typeof cc5Runtime.releaseSessionKey === 'function') {
          await cc5Runtime
            .releaseSessionKey(identity.userId, sessionKey, {
              containerDbId: String(identity.containerId),
              operationId: executionBackend.operationId,
              generation: executionBackend.generation,
            })
            .catch(() => {})
        }
        throw postLaneErr
      }
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err)
      const status = statusForError(code)
      sendJsonResponse(
        res,
        status,
        { error: { code: code.slice(0, 120), message: code.slice(0, 200) } },
        requestId,
      )
    }
  }
}
