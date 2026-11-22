/**
 * Unified Pending Decisions ("待拍板") & IM Remote Control Bootstrap.
 *
 * Extracted from packages/commercial/src/index.ts to keep index.ts strictly < 3,000L.
 *
 * Wires all 4 Stage-4 pending decision sources:
 *   1. `turn_permission` — real PG `turn_permission_requests` + `admitDurableControl`
 *      + `onControlAdmitted` hooked to `userChatBridge.drainControlsForUser(uid)`
 *      + `onPermissionAuthorityCreated` producer hook for proactive IM push (B3).
 *   2. `connector_write` — real PG `connector_write_ledger` atomic CAS
 *      + `onConnectorWritePendingCreated` producer hook for proactive IM push (B3).
 *   3. `taskboard`       — real per-user container taskboard HTTP bridge (`/api/board/tickets*`)
 *      with strict `waiting_human` + version fence, container-authoritative replay verification
 *      across restarts (B5), and non-silent `SOURCE_UNAVAILABLE` propagation when sleeping (B8).
 *   4. `browser_handoff` — durable PG-backed `PgBrowserHandoffStore` (`pending_browser_handoffs`)
 *      + outbound assistant `browser_handoff` card observer (B3).
 *
 * Also constructs shared `ShortCodeRegistry` + channel-specific `ImRemoteControlHandler`
 * instances for WeChat (`wechat_session_pointer`) and QQ (`qq_session_pointer`) with:
 *   - Fail-closed active commercial account verification (B2).
 *   - Strictly continuable `wsess-[0-9a-f]{16}` session filtering & validation (B4).
 *   - Idempotent deduplicated proactive IM push fan-out on `service.onCreated(...)` (B3).
 */

import type { Pool } from 'pg'
import { listClientSessions } from '@openclaude/storage'
import {
  encodePendingDecisionId,
  type PendingDecisionAction,
  type PendingDecisionItem,
  type PendingDecisionRiskLevel,
} from '@openclaude/protocol'
import { isMasterTaskboardEnabled } from '../agent-sandbox/taskboardEnv.js'
import type { V3SupervisorDeps } from '../agent-sandbox/v3supervisor.js'
import { onConnectorWritePendingCreated } from '../connectors/ledger.js'
import { onPermissionAuthorityCreated } from '../dispatch/turnControlStore.js'
import {
  ContainerInternalRequestError,
  requestUserContainerInternal,
  type ContainerInternalClientDeps,
} from '../http/containerInternalClient.js'
import { requireActiveAccountVerifyDb } from '../http/requireUser.js'
import { rootLogger } from '../logging/logger.js'
import {
  ImSessionSwitchError,
  PendingDecisionError,
  PgBrowserHandoffStore,
  ShortCodeRegistry,
  createBrowserHandoffSource,
  createConnectorWriteSource,
  createImRemoteControlHandler,
  createPendingDecisionsService,
  createTaskboardSource,
  createTurnPermissionSource,
  deterministicBrowserHandoffId,
  extractBrowserHandoffCardsFromText,
  onOutboundBrowserHandoffFrame,
  type BrowserHandoffRecord,
  type BrowserHandoffStore,
  type ImRemoteControlHandler,
  type ImSessionController,
  type ImSessionSummary,
  type PendingDecisionsService,
  type TaskboardDecisionBackend,
  type TaskboardTicketRecord,
} from '../pendingDecisions/index.js'
import { getCurrentQqSessionId, setCurrentQqSessionId } from '../qqbot/sessionPointer.js'
import { getCurrentSessionId, setCurrentSessionId } from '../wechat/sessionPointer.js'
import type { WechatSessionId } from '../wechat/types.js'
import { MASTER_USER_PREFIX } from '../wechat/userIds.js'

const log = rootLogger.child({ subsys: 'commercial', module: 'pendingDecisionsBootstrap' })

/**
 * Only `wsess-<16 hex>` sessions satisfy both `qq_session_pointer` DB CHECK constraint
 * and `packages/gateway/src/v3WechatOutbound.ts` (`WSESS_RE`) outbound delivery contract (B4).
 */
export const CONTINUABLE_IM_SESSION_ID_RE = /^wsess-[0-9a-f]{16}$/
const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const PUSH_DEDUP_TTL_MS = 24 * 60 * 60_000
const PUSH_DEDUP_MAX_ENTRIES = 20_000

interface ContainerTaskboardTicketRaw {
  id?: unknown
  identifier?: unknown
  title?: unknown
  body?: unknown
  status?: unknown
  version?: unknown
  priority?: unknown
  stageId?: unknown
  originSessionKey?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

interface ContainerTaskboardActivityRaw {
  action?: unknown
  field?: unknown
  fromValue?: unknown
  toValue?: unknown
  oldValue?: unknown
  newValue?: unknown
  actor?: unknown
  actorKind?: unknown
  createdAt?: unknown
}

interface ContainerTaskboardCommentRaw {
  authorKind?: unknown
  body?: unknown
  createdAt?: unknown
}

function normalizeContainerTicket(
  userId: string,
  raw: ContainerTaskboardTicketRaw,
): TaskboardTicketRecord | null {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null
  const status = typeof raw.status === 'string' ? raw.status : 'waiting_human'
  const validStatuses = new Set([
    'backlog',
    'ready',
    'running',
    'waiting_human',
    'blocked',
    'done',
    'canceled',
  ])
  if (!validStatuses.has(status)) return null
  const version =
    typeof raw.version === 'number' && Number.isInteger(raw.version) && raw.version > 0
      ? raw.version
      : 1
  const createdMs =
    typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : Date.now()
  const updatedMs =
    typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : undefined
  const priority =
    raw.priority === 'P0' || raw.priority === 'P1' || raw.priority === 'P2' || raw.priority === 'P3'
      ? raw.priority
      : undefined
  const originKey = typeof raw.originSessionKey === 'string' ? raw.originSessionKey : null
  const sessionIdMatch = originKey ? /:dm:([^:]+)$/.exec(originKey) : null
  return {
    id: raw.id,
    ...(typeof raw.identifier === 'string' && raw.identifier ? { identifier: raw.identifier } : {}),
    userId,
    sessionId: sessionIdMatch ? sessionIdMatch[1]! : null,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : raw.id,
    ...(typeof raw.body === 'string' && raw.body.trim()
      ? { summary: raw.body.trim().slice(0, 240) }
      : {}),
    status: status as TaskboardTicketRecord['status'],
    version,
    approveTargetStatus: 'done',
    ...(priority ? { priority } : {}),
    createdAt: new Date(createdMs).toISOString(),
    ...(updatedMs !== undefined ? { updatedAt: new Date(updatedMs).toISOString() } : {}),
  }
}

function inferPermissionRisk(
  toolName: string,
  input: Record<string, unknown>,
): PendingDecisionRiskLevel {
  const name = toolName.toLowerCase()
  const cmd = typeof input.command === 'string' ? input.command : ''
  if (/rm\s+-[a-z]*r[a-z]*f|git\s+push.*--force|drop\s+table/i.test(cmd)) return 'critical'
  if (name === 'bash' || name === 'shell' || name.includes('write') || name.includes('delete')) {
    return 'high'
  }
  return 'medium'
}

export function browserHandoffRecordToDecisionItem(rec: BrowserHandoffRecord): PendingDecisionItem {
  return {
    id: encodePendingDecisionId('browser_handoff', rec.id),
    source: 'browser_handoff',
    sourceId: rec.id,
    userId: rec.userId,
    sessionId: rec.sessionId,
    title: rec.title,
    summary: `${rec.reason}${rec.url ? ` (${rec.url})` : ''}`,
    riskLevel: rec.riskLevel ?? 'medium',
    status: 'pending',
    metadata: {
      url: rec.url,
      reason: rec.reason,
      ...(rec.metadata ?? {}),
    },
    createdAt: rec.createdAt,
    expiresAt: rec.expiresAt,
    allowedActions: ['approve', 'deny'],
  }
}

/**
 * Container-backed `TaskboardDecisionBackend` that queries and transitions waiting_human
 * tickets inside the authenticated user's own isolated container via `/api/board/tickets*`.
 *
 * B5 & B8 guarantees:
 *   - Sleeping / unreachable / non-200 container throws `SOURCE_UNAVAILABLE` (surfaces in
 *     `warnings` and IM `/pending` notice; NEVER pretends "no pending decisions").
 *   - Enforces strict `status === 'waiting_human'` and `version === expectedVersion` before
 *     calling `/approve` or `/reject` (backlog tickets can NEVER be approved as waiting_human).
 *   - On conflict (403/409 or pre-check mismatch), inspects container-authoritative ticket state,
 *     activity log, and human comments so idempotent replay works across master restarts while
 *     opposite intents, reopened tickets (`version > expectedVersion + 1`), and non-waiting_human
 *     transitions always return `409 CONFLICT_ALREADY_RESOLVED`.
 */
export function createContainerTaskboardDecisionBackend(deps: {
  v3Supervisor?: V3SupervisorDeps
  bridgeSecret?: string
  clientOverrides?: Partial<ContainerInternalClientDeps>
}): TaskboardDecisionBackend {
  const ticketOwnerCache = new Map<string, string>()

  function getClientDeps(): ContainerInternalClientDeps | null {
    if (!deps.v3Supervisor || !deps.bridgeSecret) return null
    return {
      v3: deps.v3Supervisor,
      bridgeSecret: deps.bridgeSecret,
      selfHostId: deps.v3Supervisor.selfHostId,
      ...deps.clientOverrides,
    }
  }

  function rememberTicketOwner(ticketId: string, userId: string): void {
    ticketOwnerCache.set(ticketId, userId)
    if (ticketOwnerCache.size > 4_000) {
      const oldest = ticketOwnerCache.keys().next().value
      if (oldest !== undefined) ticketOwnerCache.delete(oldest)
    }
  }

  async function fetchTicketAuthoritative(
    clientDeps: ContainerInternalClientDeps,
    userId: string,
    ticketId: string,
  ): Promise<TaskboardTicketRecord | null> {
    let resp
    try {
      resp = await requestUserContainerInternal(clientDeps, {
        uid: BigInt(userId),
        method: 'GET',
        pathAndQuery: `/api/board/tickets/${encodeURIComponent(ticketId)}`,
        connectTimeoutMs: 2_000,
        idleTimeoutMs: 8_000,
      })
    } catch (err) {
      throw new PendingDecisionError(
        'SOURCE_UNAVAILABLE',
        `container taskboard unavailable: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (resp.status === 404) return null
    if (resp.status !== 200) {
      throw new PendingDecisionError(
        'SOURCE_UNAVAILABLE',
        `taskboard ticket lookup failed (${resp.status})`,
      )
    }
    let parsed: { ticket?: ContainerTaskboardTicketRaw }
    try {
      parsed = JSON.parse(resp.body.toString('utf8')) as { ticket?: ContainerTaskboardTicketRaw }
    } catch {
      throw new PendingDecisionError('SOURCE_UNAVAILABLE', 'taskboard ticket returned invalid JSON')
    }
    if (!parsed?.ticket) return null
    const rec = normalizeContainerTicket(userId, parsed.ticket)
    if (rec) rememberTicketOwner(rec.id, userId)
    return rec
  }

  async function fetchTicketActivities(
    clientDeps: ContainerInternalClientDeps,
    userId: string,
    ticketId: string,
  ): Promise<ContainerTaskboardActivityRaw[]> {
    const PAGE_SIZE = 500
    const MAX_PAGES = 20
    const all: ContainerTaskboardActivityRaw[] = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE
      let resp
      try {
        resp = await requestUserContainerInternal(clientDeps, {
          uid: BigInt(userId),
          method: 'GET',
          pathAndQuery: `/api/board/tickets/${encodeURIComponent(ticketId)}/activity?limit=${PAGE_SIZE}&offset=${offset}`,
          connectTimeoutMs: 2_000,
          idleTimeoutMs: 6_000,
        })
      } catch (err) {
        throw new PendingDecisionError(
          'SOURCE_UNAVAILABLE',
          `taskboard activity lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (resp.status !== 200) {
        throw new PendingDecisionError(
          'SOURCE_UNAVAILABLE',
          `taskboard activity lookup returned HTTP ${resp.status}`,
        )
      }
      let parsed: { items?: ContainerTaskboardActivityRaw[] }
      try {
        parsed = JSON.parse(resp.body.toString('utf8')) as {
          items?: ContainerTaskboardActivityRaw[]
        }
      } catch {
        throw new PendingDecisionError(
          'SOURCE_UNAVAILABLE',
          'taskboard activity returned malformed JSON',
        )
      }
      if (!Array.isArray(parsed?.items)) {
        throw new PendingDecisionError(
          'SOURCE_UNAVAILABLE',
          'taskboard activity returned unexpected payload',
        )
      }
      all.push(...parsed.items)
      if (parsed.items.length < PAGE_SIZE) {
        return all
      }
    }
    throw new PendingDecisionError(
      'SOURCE_UNAVAILABLE',
      `taskboard activity history exceeded pagination cap for ${ticketId}`,
    )
  }

  async function fetchTicketComments(
    clientDeps: ContainerInternalClientDeps,
    userId: string,
    ticketId: string,
  ): Promise<ContainerTaskboardCommentRaw[]> {
    const PAGE_SIZE = 500
    const MAX_PAGES = 20
    const all: ContainerTaskboardCommentRaw[] = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE
      let resp
      try {
        resp = await requestUserContainerInternal(clientDeps, {
          uid: BigInt(userId),
          method: 'GET',
          pathAndQuery: `/api/board/tickets/${encodeURIComponent(ticketId)}/comments?limit=${PAGE_SIZE}&offset=${offset}`,
          connectTimeoutMs: 2_000,
          idleTimeoutMs: 6_000,
        })
      } catch (err) {
        throw new PendingDecisionError(
          'SOURCE_UNAVAILABLE',
          `taskboard comments lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (resp.status !== 200) {
        throw new PendingDecisionError(
          'SOURCE_UNAVAILABLE',
          `taskboard comments lookup returned HTTP ${resp.status}`,
        )
      }
      let parsed: { items?: ContainerTaskboardCommentRaw[] }
      try {
        parsed = JSON.parse(resp.body.toString('utf8')) as {
          items?: ContainerTaskboardCommentRaw[]
        }
      } catch {
        throw new PendingDecisionError(
          'SOURCE_UNAVAILABLE',
          'taskboard comments returned malformed JSON',
        )
      }
      if (!Array.isArray(parsed?.items)) {
        throw new PendingDecisionError(
          'SOURCE_UNAVAILABLE',
          'taskboard comments returned unexpected payload',
        )
      }
      all.push(...parsed.items)
      if (parsed.items.length < PAGE_SIZE) {
        return all
      }
    }
    throw new PendingDecisionError(
      'SOURCE_UNAVAILABLE',
      `taskboard comments history exceeded pagination cap for ${ticketId}`,
    )
  }

  /**
   * Authoritatively decide whether a non-waiting_human / conflicting ticket state is a genuine
   * same-round, same-intent idempotent replay (survives master restarts) or a 409 conflict.
   *
   * B5 strict invariants (OCV5-832 R2):
   *   - `approve` idempotent replay is ONLY allowed when `current.status === 'done'` and
   *     authoritative activity proves `waiting_human -> done` at `expectedVersion + 1`.
   *   - If `current.status === 'ready'`, an `approve` request ALWAYS returns 409
   *     `CONFLICT_ALREADY_RESOLVED` (never infers approval from missing reject comments).
   *   - `deny` idempotent replay requires `current.status === 'ready'`, `waiting_human -> ready`
   *     `status_changed` activity, AND positive evidence of a matching human reject comment
   *     read via paginated fail-closed `/comments` (non-200 / error throws `SOURCE_UNAVAILABLE`).
   */
  async function evaluateAuthoritativeReplayOrConflict(
    clientDeps: ContainerInternalClientDeps,
    input: {
      ticketId: string
      userId: string
      expectedVersion: number
      decision: PendingDecisionAction
    },
  ): Promise<{ status: 'done' | 'running' | 'ready'; idempotentReplay: true; resolvedAt: string }> {
    const current = await fetchTicketAuthoritative(clientDeps, input.userId, input.ticketId)
    if (!current) {
      throw new PendingDecisionError('NOT_FOUND', `taskboard ticket not found: ${input.ticketId}`)
    }

    const curVersion = current.version ?? 1
    // Strict single-step round fence:
    //   - curVersion < expectedVersion + 1  -> never transitioned from waiting_human (e.g. backlog@v1)
    //   - curVersion > expectedVersion + 1  -> reopened or further transitioned -> stale card
    if (curVersion !== input.expectedVersion + 1) {
      throw new PendingDecisionError(
        'CONFLICT_ALREADY_RESOLVED',
        `taskboard ticket ${input.ticketId}@v${input.expectedVersion} conflict (current v${curVersion}/${current.status})`,
      )
    }

    if (current.status !== 'done' && current.status !== 'ready') {
      throw new PendingDecisionError(
        'CONFLICT_ALREADY_RESOLVED',
        `taskboard ticket ${input.ticketId}@v${input.expectedVersion} is in non-replayable status ${current.status}`,
      )
    }

    // B5 hard fence: `ready` is NEVER an idempotent replay for `approve` (pending-decisions
    // approval targets terminal `done`), and `done` is NEVER an idempotent replay for `deny`.
    if (input.decision === 'approve' && current.status !== 'done') {
      throw new PendingDecisionError(
        'CONFLICT_ALREADY_RESOLVED',
        `taskboard ticket ${input.ticketId}@v${input.expectedVersion} is in status ${current.status}, cannot replay approve`,
      )
    }
    if (input.decision === 'deny' && current.status !== 'ready') {
      throw new PendingDecisionError(
        'CONFLICT_ALREADY_RESOLVED',
        `taskboard ticket ${input.ticketId}@v${input.expectedVersion} is in status ${current.status}, cannot replay deny`,
      )
    }

    const activities = await fetchTicketActivities(clientDeps, input.userId, input.ticketId)
    const statusActivities = activities
      .filter(
        (a) =>
          a &&
          typeof a === 'object' &&
          a.field === 'status' &&
          (a.action === 'status_changed' ||
            a.action === 'stage_advanced' ||
            a.action === 'ticket_approved'),
      )
      .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))

    const latest = statusActivities[0]
    const latestFrom = latest?.fromValue ?? latest?.oldValue
    const latestTo = latest?.toValue ?? latest?.newValue
    if (!latest || latestFrom !== 'waiting_human' || latestTo !== current.status) {
      throw new PendingDecisionError(
        'CONFLICT_ALREADY_RESOLVED',
        `taskboard ticket ${input.ticketId}@v${input.expectedVersion} has no matching waiting_human transition`,
      )
    }

    const latestTs =
      typeof latest.createdAt === 'number' && Number.isFinite(latest.createdAt)
        ? latest.createdAt
        : Date.now()
    const resolvedAt = new Date(latestTs).toISOString()

    if (input.decision === 'approve') {
      // `current.status === 'done'` and `waiting_human -> done` verified above.
      return {
        status: 'done',
        idempotentReplay: true,
        resolvedAt,
      }
    }

    // `input.decision === 'deny'` && `current.status === 'ready'`:
    // Require positive human reject comment evidence (paginated, fail-closed on non-200/errors).
    if (latest.action !== 'status_changed') {
      throw new PendingDecisionError(
        'CONFLICT_ALREADY_RESOLVED',
        `taskboard ticket ${input.ticketId}@v${input.expectedVersion} transition ${String(latest.action)} is not a rejection`,
      )
    }
    const comments = await fetchTicketComments(clientDeps, input.userId, input.ticketId)
    const hasRejectComment = comments.some(
      (c) =>
        c &&
        c.authorKind === 'human' &&
        typeof c.createdAt === 'number' &&
        Math.abs(c.createdAt - latestTs) <= 2_000,
    )
    if (!hasRejectComment) {
      throw new PendingDecisionError(
        'CONFLICT_ALREADY_RESOLVED',
        `taskboard ticket ${input.ticketId}@v${input.expectedVersion} has no authoritative reject comment`,
      )
    }
    return {
      status: 'ready',
      idempotentReplay: true,
      resolvedAt,
    }
  }

  return {
    async listWaitingHuman(userId, limit): Promise<TaskboardTicketRecord[]> {
      const clientDeps = getClientDeps()
      if (!clientDeps || !/^\d+$/.test(userId)) {
        throw new PendingDecisionError('SOURCE_UNAVAILABLE', 'container taskboard not configured')
      }
      try {
        const resp = await requestUserContainerInternal(clientDeps, {
          uid: BigInt(userId),
          method: 'GET',
          pathAndQuery: `/api/board/tickets?status=waiting_human&limit=${Math.max(1, Math.min(limit, 200))}`,
          connectTimeoutMs: 1_500,
          idleTimeoutMs: 5_000,
        })
        if (resp.status !== 200) {
          throw new PendingDecisionError(
            'SOURCE_UNAVAILABLE',
            `container taskboard returned HTTP ${resp.status}`,
          )
        }
        let parsed: { items?: ContainerTaskboardTicketRaw[] }
        try {
          parsed = JSON.parse(resp.body.toString('utf8')) as {
            items?: ContainerTaskboardTicketRaw[]
          }
        } catch {
          throw new PendingDecisionError(
            'SOURCE_UNAVAILABLE',
            'container taskboard returned malformed JSON',
          )
        }
        if (!Array.isArray(parsed?.items)) {
          throw new PendingDecisionError(
            'SOURCE_UNAVAILABLE',
            'container taskboard returned unexpected payload',
          )
        }
        const out: TaskboardTicketRecord[] = []
        for (const raw of parsed.items) {
          const rec = normalizeContainerTicket(userId, raw)
          if (rec) {
            rememberTicketOwner(rec.id, userId)
            out.push(rec)
          }
        }
        return out
      } catch (err) {
        if (err instanceof PendingDecisionError) throw err
        if (
          err instanceof ContainerInternalRequestError &&
          err.code === 'CONTAINER_NOT_RUNNING'
        ) {
          throw new PendingDecisionError(
            'SOURCE_UNAVAILABLE',
            'taskboard container is sleeping or not running',
          )
        }
        throw new PendingDecisionError(
          'SOURCE_UNAVAILABLE',
          `container taskboard unavailable: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },

    async getTicket(ticketId, userId): Promise<TaskboardTicketRecord | null> {
      const clientDeps = getClientDeps()
      const targetUid = userId ?? ticketOwnerCache.get(ticketId)
      if (!clientDeps || !targetUid || !/^\d+$/.test(targetUid)) return null

      // If we previously observed this ticket under a different user, surface that owner
      // so `createTaskboardSource` returns 403 FORBIDDEN rather than silently probing another container.
      const cachedOwner = ticketOwnerCache.get(ticketId)
      if (cachedOwner && userId && cachedOwner !== userId) {
        return {
          id: ticketId,
          userId: cachedOwner,
          title: ticketId,
          status: 'waiting_human',
          version: 1,
          createdAt: new Date().toISOString(),
        }
      }

      return await fetchTicketAuthoritative(clientDeps, targetUid, ticketId)
    },

    async transitionTicket(input) {
      const clientDeps = getClientDeps()
      if (!clientDeps || !/^\d+$/.test(input.userId)) {
        throw new PendingDecisionError('SOURCE_UNAVAILABLE', 'container taskboard unavailable')
      }

      // B5 pre-check: enforce strict `waiting_human` + `expectedVersion` fence BEFORE hitting
      // container `/approve` (which otherwise accepts `backlog` tickets as backlog approvals).
      const currentBefore = await fetchTicketAuthoritative(clientDeps, input.userId, input.ticketId)
      if (!currentBefore) {
        throw new PendingDecisionError('NOT_FOUND', `taskboard ticket not found: ${input.ticketId}`)
      }
      if (
        currentBefore.status !== input.expectedStatus ||
        (currentBefore.version ?? 1) !== input.expectedVersion
      ) {
        return await evaluateAuthoritativeReplayOrConflict(clientDeps, input)
      }

      const action = input.decision === 'approve' ? 'approve' : 'reject'
      const bodyPayload =
        input.decision === 'approve'
          ? {
              expectedVersion: input.expectedVersion,
              close: input.toStatus === 'done',
            }
          : {
              expectedVersion: input.expectedVersion,
              reason: (input.reason?.trim() || 'Rejected via pending decisions').slice(0, 500),
            }

      let resp
      try {
        resp = await requestUserContainerInternal(clientDeps, {
          uid: BigInt(input.userId),
          method: 'POST',
          pathAndQuery: `/api/board/tickets/${encodeURIComponent(input.ticketId)}/${action}`,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(bodyPayload),
          connectTimeoutMs: 2_000,
          idleTimeoutMs: 10_000,
        })
      } catch (err) {
        throw new PendingDecisionError(
          'SOURCE_UNAVAILABLE',
          `container taskboard transition failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      if (resp.status === 200) {
        const resolvedAt = new Date().toISOString()
        const parsed = JSON.parse(resp.body.toString('utf8')) as {
          ticket?: { status?: string }
        }
        const statusRaw = parsed?.ticket?.status
        const finalStatus: 'done' | 'running' | 'ready' =
          statusRaw === 'done' || statusRaw === 'running' || statusRaw === 'ready'
            ? statusRaw
            : input.toStatus
        return { status: finalStatus, idempotentReplay: false, resolvedAt }
      }

      if (resp.status === 404) {
        throw new PendingDecisionError('NOT_FOUND', `taskboard ticket not found: ${input.ticketId}`)
      }
      if (resp.status === 403 || resp.status === 409) {
        return await evaluateAuthoritativeReplayOrConflict(clientDeps, input)
      }

      throw new PendingDecisionError(
        'SOURCE_UNAVAILABLE',
        `taskboard transition returned HTTP ${resp.status}`,
      )
    },
  }
}

export interface ChannelSessionControllerDeps {
  pool: Pool
  channel: 'wechat' | 'qqbot'
  /** Test seam: override `@openclaude/storage` `listClientSessions`. */
  listSessionsRaw?: (
    storageUid: string,
    opts: { limit: number },
  ) => Promise<{ sessions: Array<{ id: string; title?: string; agentId?: string; updatedAt?: number }> }>
  /** Test seam: override pointer getters/setters. */
  getPointerSessionId?: (pool: Pool, bareUid: string) => Promise<WechatSessionId | null>
  setPointerSessionId?: (
    pool: Pool,
    bareUid: string,
    sessionId: WechatSessionId,
    now: number,
    agentId?: string,
  ) => Promise<boolean>
}

/**
 * Channel-safe IM session controller (OCV5-832 B4):
 *   - `/sessions` exposes ONLY sessions whose ID satisfies `wsess-[0-9a-f]{16}` (actually
 *     continuable by both WeChat & QQ inbound dispatch + outbound delivery).
 *   - `/switch` strictly validates `wsess-[0-9a-f]{16}` format AND user ownership before
 *     updating `wechat_session_pointer` / `qq_session_pointer`, rejecting unsupported web
 *     session IDs explicitly instead of claiming false success.
 */
export function createChannelSessionController(
  args: ChannelSessionControllerDeps,
): ImSessionController {
  const listRaw =
    args.listSessionsRaw ??
    ((storageUid: string, opts: { limit: number }) => listClientSessions(storageUid, opts))
  const getPointer =
    args.getPointerSessionId ??
    (args.channel === 'wechat' ? getCurrentSessionId : getCurrentQqSessionId)
  const setPointer =
    args.setPointerSessionId ??
    (args.channel === 'wechat' ? setCurrentSessionId : setCurrentQqSessionId)

  function normalizeUids(userId: string): { bareUid: string; storageUid: string } {
    const bareUid = userId.startsWith(MASTER_USER_PREFIX)
      ? userId.slice(MASTER_USER_PREFIX.length)
      : userId
    return { bareUid, storageUid: `${MASTER_USER_PREFIX}${bareUid}` }
  }

  async function listContinuable(userId: string, limit: number): Promise<ImSessionSummary[]> {
    const { storageUid } = normalizeUids(userId)
    const fetchLimit = Math.min(200, Math.max(limit * 5, 50))
    const listed = await listRaw(storageUid, { limit: fetchLimit })
    const out: ImSessionSummary[] = []
    for (const s of listed.sessions) {
      if (!CONTINUABLE_IM_SESSION_ID_RE.test(s.id)) continue
      out.push({
        sessionId: s.id,
        title: s.title || '未命名会话',
        ...(s.agentId && SAFE_AGENT_ID_RE.test(s.agentId) ? { agentId: s.agentId } : {}),
        ...(s.updatedAt !== undefined ? { updatedAt: s.updatedAt } : {}),
      })
      if (out.length >= limit) break
    }
    return out
  }

  return {
    async listSessions(userId, limit = 10) {
      return await listContinuable(userId, limit)
    },

    async getCurrentSessionId(userId) {
      const { bareUid } = normalizeUids(userId)
      return await getPointer(args.pool, bareUid)
    },

    async switchSession(userId, sessionId, agentId) {
      if (!CONTINUABLE_IM_SESSION_ID_RE.test(sessionId)) {
        throw new ImSessionSwitchError(
          'UNSUPPORTED_SESSION',
          '该会话不是本渠道可续接会话（仅支持 wsess- 会话）',
        )
      }
      const owned = await listContinuable(userId, 200)
      const matched = owned.find((s) => s.sessionId === sessionId)
      if (!matched) {
        throw new ImSessionSwitchError(
          'SESSION_NOT_FOUND',
          '未找到属于当前账号的可续接会话',
        )
      }
      const effectiveAgentId =
        matched.agentId ??
        (agentId && SAFE_AGENT_ID_RE.test(agentId) ? agentId : undefined)
      const { bareUid } = normalizeUids(userId)
      const written = await setPointer(
        args.pool,
        bareUid,
        sessionId as WechatSessionId,
        Date.now(),
        effectiveAgentId,
      )
      if (!written) {
        throw new ImSessionSwitchError(
          'POINTER_CONFLICT',
          '会话指针未被更新（存在更新的并发会话操作），本次切换未生效',
        )
      }
    },
  }
}

export interface CommercialPendingDecisionsRuntimeDeps {
  pool: Pool
  v3Supervisor?: V3SupervisorDeps
  bridgeSecret?: string
  /** Lazy ref to `userChatBridge.drainControlsForUser(uid)` wired after bridge creation. */
  onControlAdmitted: (uid: bigint) => void | Promise<void>
  /** Optional lazy push targets for proactive IM alerts when new pending decisions arrive. */
  pushToWechat?: (item: PendingDecisionItem) => Promise<unknown>
  pushToQq?: (item: PendingDecisionItem) => Promise<unknown>
  /** Optional callback fired when a browser_handoff pending decision is resolved (non-replay). */
  onBrowserHandoffResolved?: (
    result: import('@openclaude/protocol').ResolvePendingDecisionResponse,
    userId: string,
  ) => void | Promise<void>
  /** Optional overrides for tests. */
  taskboardEnabled?: boolean
  taskboardBackend?: TaskboardDecisionBackend
  browserHandoffStore?: BrowserHandoffStore
  wechatSessions?: ImSessionController
  qqSessions?: ImSessionController
  verifyAccountActive?: (userId: string) => Promise<boolean>
  /** Optional clock for tests. */
  now?: () => number
}

export interface CommercialPendingDecisionsRuntime {
  service: PendingDecisionsService
  shortCodes: ShortCodeRegistry
  browserHandoffStore: BrowserHandoffStore
  wechatRemoteControl: ImRemoteControlHandler
  qqRemoteControl: ImRemoteControlHandler
  /** Unsubscribe global producer hooks (useful for tests & graceful shutdown). */
  dispose: () => void
}

export function createCommercialPendingDecisionsRuntime(
  deps: CommercialPendingDecisionsRuntimeDeps,
): CommercialPendingDecisionsRuntime {
  const now = deps.now ?? (() => Date.now())
  let serviceRef: PendingDecisionsService | null = null

  const browserHandoffStore =
    deps.browserHandoffStore ??
    new PgBrowserHandoffStore({
      pool: deps.pool,
      now,
      onCreated: async (rec) => {
        if (serviceRef) {
          await serviceRef.notifyCreated(browserHandoffRecordToDecisionItem(rec))
        }
      },
    })

  const taskboardEnabled = deps.taskboardEnabled ?? isMasterTaskboardEnabled()

  const service = createPendingDecisionsService({
    now,
    sources: [
      createTurnPermissionSource({
        pool: deps.pool,
        onControlAdmitted: async (uid) => {
          try {
            await deps.onControlAdmitted(uid)
          } catch (err) {
            log.warn('pending_decision_control_drain_failed', {
              uid: uid.toString(),
              errMessage: err instanceof Error ? err.message : String(err),
            })
          }
        },
      }),
      createConnectorWriteSource({ pool: deps.pool }),
      ...(taskboardEnabled
        ? [
            createTaskboardSource(
              deps.taskboardBackend ??
                createContainerTaskboardDecisionBackend({
                  v3Supervisor: deps.v3Supervisor,
                  bridgeSecret: deps.bridgeSecret,
                }),
            ),
          ]
        : []),
      createBrowserHandoffSource(browserHandoffStore),
    ],
  })
  serviceRef = service

  const shortCodes = new ShortCodeRegistry({ now })

  // B2: Fail-closed commercial active-account verification for WeChat & QQ remote commands.
  const verifyAccountActive =
    deps.verifyAccountActive ??
    (async (userId: string): Promise<boolean> => {
      const bareUid = userId.startsWith(MASTER_USER_PREFIX)
        ? userId.slice(MASTER_USER_PREFIX.length)
        : userId
      if (!/^\d+$/.test(bareUid)) return false
      const active = await requireActiveAccountVerifyDb(bareUid, ['user', 'admin'], deps.pool)
      return active !== null
    })

  const wechatRemoteControl = createImRemoteControlHandler({
    pendingDecisions: service,
    shortCodes,
    verifyAccountActive,
    now,
    sessions:
      deps.wechatSessions ??
      createChannelSessionController({ pool: deps.pool, channel: 'wechat' }),
  })

  const qqRemoteControl = createImRemoteControlHandler({
    pendingDecisions: service,
    shortCodes,
    verifyAccountActive,
    now,
    sessions:
      deps.qqSessions ?? createChannelSessionController({ pool: deps.pool, channel: 'qqbot' }),
  })

  // B3: Idempotent per-(channel, userId, decisionId) deduplication so repeated creation events
  // never double-push the same pending decision to WeChat or QQ.
  const pushedKeys = new Map<string, number>()

  function claimPushSlot(channel: 'wechat' | 'qqbot', item: PendingDecisionItem): string | null {
    const nowMs = now()
    const key = `${channel}:${item.userId}:${item.id}`
    const existingExp = pushedKeys.get(key)
    if (existingExp !== undefined && existingExp > nowMs) {
      return null
    }
    if (pushedKeys.size >= PUSH_DEDUP_MAX_ENTRIES) {
      for (const [k, exp] of pushedKeys) {
        if (exp <= nowMs) pushedKeys.delete(k)
      }
      while (pushedKeys.size >= PUSH_DEDUP_MAX_ENTRIES) {
        const oldest = pushedKeys.keys().next().value
        if (oldest !== undefined) pushedKeys.delete(oldest)
        else break
      }
    }
    pushedKeys.set(key, nowMs + PUSH_DEDUP_TTL_MS)
    return key
  }

  // Best-effort, idempotently deduplicated proactive IM notification fan-out.
  const unsubOnCreated = service.onCreated(async (item) => {
    const tasks: Promise<unknown>[] = []
    if (deps.pushToWechat) {
      const slot = claimPushSlot('wechat', item)
      if (slot) {
        tasks.push(
          deps.pushToWechat(item).catch((err) => {
            pushedKeys.delete(slot)
            log.warn('pending_decision_wechat_push_failed', {
              decisionId: item.id,
              userId: item.userId,
              errMessage: err instanceof Error ? err.message : String(err),
            })
          }),
        )
      }
    }
    if (deps.pushToQq) {
      const slot = claimPushSlot('qqbot', item)
      if (slot) {
        tasks.push(
          deps.pushToQq(item).catch((err) => {
            pushedKeys.delete(slot)
            log.warn('pending_decision_qq_push_failed', {
              decisionId: item.id,
              userId: item.userId,
              errMessage: err instanceof Error ? err.message : String(err),
            })
          }),
        )
      }
    }
    if (tasks.length > 0) await Promise.all(tasks)
  })

  // Clean up IM push-dedup slots on resolve and emit browser_handoff resolution hooks.
  const unsubOnResolved = service.onResolved(async (result, userId) => {
    pushedKeys.delete(`wechat:${userId}:${result.id}`)
    pushedKeys.delete(`qqbot:${userId}:${result.id}`)
    if (result.source === 'browser_handoff' && !result.idempotentReplay) {
      log.info('browser_handoff_resolved', {
        decisionId: result.id,
        sourceId: result.sourceId,
        userId,
        decision: result.decision,
        status: result.status,
      })
      if (deps.onBrowserHandoffResolved) {
        try {
          await deps.onBrowserHandoffResolved(result, userId)
        } catch (err) {
          log.warn('browser_handoff_resolved_hook_failed', {
            decisionId: result.id,
            userId,
            errMessage: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
  })

  // B3: Real producer wiring #1 — newly persisted `turn_permission_requests` rows.
  const unsubPerm = onPermissionAuthorityCreated(async (input) => {
    const askUser =
      input.requestId.startsWith('ask-user:') ||
      /^AskUserQuestion$/i.test(input.toolName) ||
      (input.askPayload !== undefined && input.askPayload !== null)
    const preview =
      typeof input.input.command === 'string'
        ? input.input.command.slice(0, 240)
        : JSON.stringify(input.input).slice(0, 240)
    const item: PendingDecisionItem = {
      id: encodePendingDecisionId('turn_permission', input.requestId),
      source: 'turn_permission',
      sourceId: input.requestId,
      userId: input.userId.toString(),
      sessionId: input.sessionId,
      title: askUser ? `交互式提问: ${input.toolName}` : `工具授权: ${input.toolName}`,
      summary: askUser
        ? '需要前往网页会话填写结构化回答（不支持远程二元批准）'
        : preview || `请求执行 ${input.toolName}`,
      riskLevel: askUser ? 'medium' : inferPermissionRisk(input.toolName, input.input),
      status: 'pending',
      metadata: {
        toolName: input.toolName,
        toolUseId: input.toolUseId ?? null,
        clientMessageId: input.clientMessageId ?? null,
        inputPreview: preview,
        ...(askUser ? { requiresInteractiveAnswer: true } : {}),
      },
      createdAt: new Date(now()).toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      allowedActions: askUser ? ['deny'] : ['approve', 'deny'],
    }
    await service.notifyCreated(item)
  })

  // B3: Real producer wiring #2 — newly created interactive `connector_write_ledger` confirmations.
  const unsubConn = onConnectorWritePendingCreated(async (evt) => {
    const item: PendingDecisionItem = {
      id: encodePendingDecisionId('connector_write', evt.id),
      source: 'connector_write',
      sourceId: evt.id,
      userId: String(evt.userId),
      sessionId: null,
      title: `${evt.provider}: ${evt.action}`,
      summary: evt.summary || `连接器外部写入 (${evt.provider}.${evt.action})`,
      riskLevel: /delete|remove|send|publish|pay|transfer/i.test(evt.action) ? 'high' : 'medium',
      status: 'pending',
      metadata: {
        connectionId: evt.connectionId,
        provider: evt.provider,
        action: evt.action,
      },
      createdAt: evt.createdAt.toISOString(),
      expiresAt: evt.expiresAt.toISOString(),
      allowedActions: ['approve', 'deny'],
    }
    await service.notifyCreated(item)
  })

  // B3: Real producer wiring #3 — assistant outbound `browser_handoff` UI cards persisted into
  // the authoritative `PgBrowserHandoffStore` (deterministic id prevents replay duplicates).
  const unsubHandoff = onOutboundBrowserHandoffFrame(async (evt) => {
    const cards = extractBrowserHandoffCardsFromText(evt.text)
    for (let idx = 0; idx < cards.length; idx++) {
      const card = cards[idx]!
      const id = deterministicBrowserHandoffId({
        userId: evt.userId,
        sessionId: evt.sessionId,
        messageId: evt.messageId,
        cardIndex: idx,
        url: card.url,
        title: card.title,
      })
      try {
        const rec = await browserHandoffStore.create({
          id,
          userId: evt.userId,
          sessionId: evt.sessionId,
          title: card.title,
          url: card.url,
          reason: card.reason,
          riskLevel: 'high',
          ...(card.continuePrompt ? { metadata: { continuePrompt: card.continuePrompt } } : {}),
        })
        // Custom injected test stores (e.g. InMemoryBrowserHandoffStore) do not have PgBrowserHandoffStore's
        // built-in onCreated callback, so notify service explicitly (dedup protects PgBrowserHandoffStore).
        if (deps.browserHandoffStore) {
          await service.notifyCreated(browserHandoffRecordToDecisionItem(rec))
        }
      } catch (err) {
        log.warn('browser_handoff_persist_failed', {
          userId: evt.userId,
          sessionId: evt.sessionId,
          errMessage: err instanceof Error ? err.message : String(err),
        })
      }
    }
  })

  let disposed = false
  return {
    service,
    shortCodes,
    browserHandoffStore,
    wechatRemoteControl,
    qqRemoteControl,
    dispose: () => {
      if (disposed) return
      disposed = true
      unsubOnCreated()
      unsubOnResolved()
      unsubPerm()
      unsubConn()
      unsubHandoff()
    },
  }
}
