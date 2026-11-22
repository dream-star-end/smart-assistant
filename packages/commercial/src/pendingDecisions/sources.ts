/**
 * Concrete Pending Decision Source Adapters for all 4 Stage-4 sources:
 *   1. turn_permission  (`turn_permission_requests` + full `InboundPermissionResponse` protocol frame)
 *   2. connector_write  (`connector_write_ledger` + atomic pending-only CAS)
 *   3. taskboard        (waiting_human tickets + version-fenced atomic CAS)
 *   4. browser_handoff  (active live-browser login/2FA/captcha handoffs)
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import {
  encodePendingDecisionId,
  type InboundPermissionResponse,
  type PendingDecisionAction,
  type PendingDecisionItem,
  type PendingDecisionRiskLevel,
  type ResolvePendingDecisionRequest,
  type ResolvePendingDecisionResponse,
} from '@openclaude/protocol'
import {
  approvePendingConfirmationCas,
  denyPendingConfirmationCas,
  type LedgerStatus,
} from '../connectors/ledger.js'
import { ConnectorError } from '../connectors/errors.js'
import {
  TurnControlConflictError,
  admitDurableControl,
  type DurableControlInput,
} from '../dispatch/turnControlStore.js'
import {
  PendingDecisionError,
  type BrowserHandoffRecord,
  type BrowserHandoffStore,
  type PendingDecisionSourceAdapter,
  type TaskboardDecisionBackend,
  type TaskboardTicketRecord,
} from './types.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_HANDOFF_TTL_MS = 15 * 60_000

function toIso(value: Date | string | null | undefined, fallbackMs = Date.now()): string {
  if (!value) return new Date(fallbackMs).toISOString()
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? new Date(fallbackMs).toISOString() : d.toISOString()
}

function parseJsonObj(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return {}
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function deterministicControlId(
  userId: string,
  requestId: string,
  decision: PendingDecisionAction,
  callerKey?: string,
): string {
  if (callerKey && /^[A-Za-z0-9._:-]{8,128}$/.test(callerKey.trim())) {
    return callerKey.trim()
  }
  const digest = createHash('sha256')
    .update(`pd-perm:${userId}:${requestId}:${decision}`)
    .digest('hex')
    .slice(0, 32)
  return `pd-perm-${digest}`
}

function parseUidBigInt(userId: string): bigint {
  if (!/^\d+$/.test(userId)) {
    throw new PendingDecisionError('INVALID_ID', `invalid numeric userId: ${userId}`)
  }
  return BigInt(userId)
}

function parseUidInt(userId: string): number {
  if (!/^\d+$/.test(userId)) {
    throw new PendingDecisionError('INVALID_ID', `invalid numeric userId: ${userId}`)
  }
  const n = Number(userId)
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new PendingDecisionError('INVALID_ID', `userId out of safe integer range: ${userId}`)
  }
  return n
}

// ---------------------------------------------------------------------------
// 1. turn_permission_requests Source Adapter (B5 full protocol frame + ask_user guard)
// ---------------------------------------------------------------------------

interface TurnPermissionPgRow {
  user_id: string
  request_id: string
  session_id: string
  client_message_id: string | null
  tool_use_id: string | null
  tool_name: string
  input_json: unknown
  ask_payload_json?: unknown
  status: string
  response_json: unknown
  created_at: Date | string
  updated_at?: Date | string
  expires_at: Date | string
}

export interface TurnPermissionSourceDeps {
  pool: Pick<Pool, 'query'> & Partial<Pick<Pool, 'connect'>>
  admitControl?: (
    pool: Pool,
    input: DurableControlInput,
  ) => Promise<{ inserted: boolean; status: string; errorCode?: string }>
  /** Optional trigger to wake durable control delivery (`drainDurableControlsForUser`). */
  onControlAdmitted?: (uid: bigint) => void | Promise<void>
}

function isStructuredAskUserPrompt(row: {
  request_id: string
  tool_name: string
  ask_payload_json?: unknown
}): boolean {
  return (
    row.request_id.startsWith('ask-user:') ||
    /^AskUserQuestion$/i.test(row.tool_name) ||
    (row.ask_payload_json !== undefined && row.ask_payload_json !== null)
  )
}

function inferPermissionRisk(toolName: string, input: Record<string, unknown>): PendingDecisionRiskLevel {
  const name = toolName.toLowerCase()
  const cmd = typeof input.command === 'string' ? input.command : ''
  if (/rm\s+-[a-z]*r[a-z]*f|git\s+push.*--force|drop\s+table/i.test(cmd)) return 'critical'
  if (name === 'bash' || name === 'shell' || name.includes('write') || name.includes('delete')) return 'high'
  return 'medium'
}

/**
 * Build the exact wire-compatible `InboundPermissionResponse` control frame expected
 * by `containerLinkControls` and `packages/gateway/src/wsConnection.ts`.
 */
export function buildDurablePermissionResponseFrame(params: {
  controlId: string
  sessionId: string
  requestId: string
  behavior: 'allow' | 'deny'
  message?: string
  channel?: string
}): InboundPermissionResponse & { controlId: string } {
  return {
    type: 'inbound.permission_response',
    controlId: params.controlId,
    channel: params.channel ?? 'webchat',
    peer: { id: params.sessionId, kind: 'dm' },
    requestId: params.requestId,
    behavior: params.behavior,
    ...(params.message ? { message: params.message.slice(0, 500) } : {}),
  }
}

export function createTurnPermissionSource(deps: TurnPermissionSourceDeps): PendingDecisionSourceAdapter {
  const admit = deps.admitControl ?? admitDurableControl

  return {
    source: 'turn_permission',

    async listPending(userId, opts): Promise<PendingDecisionItem[]> {
      const uid = parseUidBigInt(userId)
      const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200))
      const result = await deps.pool.query<TurnPermissionPgRow>(
        `SELECT p.user_id::text, p.request_id, p.session_id, p.client_message_id,
                p.tool_use_id, p.tool_name, p.input_json, p.ask_payload_json,
                p.status, p.response_json, p.created_at, p.expires_at
           FROM turn_permission_requests p
          WHERE p.user_id = $1 AND p.status = 'pending' AND p.expires_at > NOW()
            AND (
              p.request_id LIKE 'ask-user:%'
              OR p.client_message_id IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM turn_control_requests c
                 WHERE c.user_id = p.user_id AND c.session_id = p.session_id
                   AND c.kind = 'stop' AND c.status <> 'cancelled'
                   AND (
                     c.root_client_message_id = p.client_message_id
                     OR (c.root_client_message_id IS NULL AND c.created_at >= p.created_at)
                   )
              )
            )
          ORDER BY p.created_at ASC
          LIMIT $2`,
        [uid.toString(), limit],
      )

      return result.rows.map((row) => {
        const input = parseJsonObj(row.input_json)
        const askUser = isStructuredAskUserPrompt(row)
        const preview =
          typeof input.command === 'string'
            ? input.command.slice(0, 240)
            : JSON.stringify(input).slice(0, 240)
        return {
          id: encodePendingDecisionId('turn_permission', row.request_id),
          source: 'turn_permission',
          sourceId: row.request_id,
          userId: row.user_id,
          sessionId: row.session_id,
          title: askUser ? `交互式提问: ${row.tool_name}` : `工具授权: ${row.tool_name}`,
          summary: askUser
            ? '需要前往网页会话填写结构化回答（不支持远程二元批准）'
            : preview || `请求执行 ${row.tool_name}`,
          riskLevel: askUser ? 'medium' : inferPermissionRisk(row.tool_name, input),
          status: 'pending',
          metadata: {
            toolName: row.tool_name,
            toolUseId: row.tool_use_id,
            clientMessageId: row.client_message_id,
            inputPreview: preview,
            ...(askUser ? { requiresInteractiveAnswer: true } : {}),
          },
          createdAt: toIso(row.created_at),
          expiresAt: toIso(row.expires_at),
          allowedActions: askUser ? ['deny'] : ['approve', 'deny'],
        }
      })
    },

    async resolve(userId, sourceId, req, nowMs = Date.now()): Promise<ResolvePendingDecisionResponse> {
      const uid = parseUidBigInt(userId)
      const lookup = await deps.pool.query<TurnPermissionPgRow>(
        `SELECT user_id::text, request_id, session_id, client_message_id, tool_use_id,
                tool_name, input_json, ask_payload_json, status, response_json,
                created_at, updated_at, expires_at
           FROM turn_permission_requests
          WHERE request_id = $1
          ORDER BY (user_id = $2) DESC
          LIMIT 1`,
        [sourceId, uid.toString()],
      )
      const row = lookup.rows[0]
      if (!row) {
        throw new PendingDecisionError('NOT_FOUND', `permission request not found: ${sourceId}`)
      }
      if (row.user_id !== uid.toString()) {
        throw new PendingDecisionError('FORBIDDEN', 'permission request belongs to another user')
      }

      if (isStructuredAskUserPrompt(row) && req.decision === 'approve') {
        throw new PendingDecisionError(
          'REQUIRES_INTERACTIVE_ANSWER',
          'Structured ask_user prompt requires answering in the web UI and cannot be binary-approved.',
          422,
        )
      }

      const desiredBehavior = req.decision === 'approve' ? 'allow' : 'deny'
      const desiredStatus = req.decision === 'approve' ? 'approved' : 'denied'

      if (row.status !== 'pending') {
        const resp = parseJsonObj(row.response_json)
        const existingBehavior =
          resp.behavior === 'allow'
            ? 'allow'
            : resp.behavior === 'deny' || row.status === 'cancelled'
              ? 'deny'
              : null
        if (existingBehavior === desiredBehavior) {
          return {
            id: encodePendingDecisionId('turn_permission', sourceId),
            source: 'turn_permission',
            sourceId,
            decision: req.decision,
            status: desiredStatus,
            idempotentReplay: true,
            resolvedAt: toIso(row.updated_at ?? row.created_at, nowMs),
          }
        }
        throw new PendingDecisionError(
          'CONFLICT_ALREADY_RESOLVED',
          `permission request already resolved (${row.status})`,
        )
      }

      const expiresAtMs = new Date(row.expires_at).getTime()
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
        throw new PendingDecisionError('EXPIRED', 'permission request has expired')
      }

      const controlId = deterministicControlId(userId, sourceId, req.decision, req.idempotencyKey)
      const durablePayload = buildDurablePermissionResponseFrame({
        controlId,
        sessionId: row.session_id,
        requestId: sourceId,
        behavior: desiredBehavior,
        message: req.reason,
      })

      let admissionInserted = true
      try {
        const admission = await admit(deps.pool as Pool, {
          controlId,
          userId: uid,
          sessionId: row.session_id,
          rootClientMessageId: row.client_message_id,
          kind: 'permission',
          requestId: sourceId,
          payload: durablePayload as unknown as Record<string, unknown>,
        })
        admissionInserted = admission.inserted !== false
      } catch (err) {
        if (err instanceof TurnControlConflictError) {
          const reread = await deps.pool.query<TurnPermissionPgRow>(
            `SELECT user_id::text, request_id, session_id, status, response_json, updated_at, expires_at
               FROM turn_permission_requests
              WHERE user_id = $1 AND request_id = $2
              LIMIT 1`,
            [uid.toString(), sourceId],
          )
          const cur = reread.rows[0]
          if (cur && cur.status !== 'pending') {
            const resp = parseJsonObj(cur.response_json)
            const curBehavior =
              resp.behavior === 'allow'
                ? 'allow'
                : resp.behavior === 'deny' || cur.status === 'cancelled'
                  ? 'deny'
                  : null
            if (curBehavior === desiredBehavior) {
              return {
                id: encodePendingDecisionId('turn_permission', sourceId),
                source: 'turn_permission',
                sourceId,
                decision: req.decision,
                status: desiredStatus,
                idempotentReplay: true,
                resolvedAt: toIso(cur.updated_at, nowMs),
              }
            }
            throw new PendingDecisionError(
              'CONFLICT_ALREADY_RESOLVED',
              `permission request already resolved (${cur.status})`,
            )
          }
          if (cur && new Date(cur.expires_at).getTime() <= nowMs) {
            throw new PendingDecisionError('EXPIRED', 'permission request has expired')
          }
          throw new PendingDecisionError('CONFLICT_ALREADY_RESOLVED', err.code)
        }
        throw err
      }

      if (admissionInserted && deps.onControlAdmitted) {
        await deps.onControlAdmitted(uid)
      }

      return {
        id: encodePendingDecisionId('turn_permission', sourceId),
        source: 'turn_permission',
        sourceId,
        decision: req.decision,
        status: desiredStatus,
        idempotentReplay: !admissionInserted,
        resolvedAt: new Date(nowMs).toISOString(),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 2. connector_write_ledger Source Adapter (B6 atomic pending-only CAS)
// ---------------------------------------------------------------------------

interface ConnectorWritePgRow {
  id: string
  user_id: number
  connection_id: string
  provider: string
  action: string
  summary: string
  status: LedgerStatus
  created_at: Date | string
  approved_at: Date | string | null
  finished_at: Date | string | null
  expires_at: Date | string
}

export interface ConnectorWriteSourceDeps {
  pool: Pick<Pool, 'query'> & Partial<Pick<Pool, 'connect'>>
  approvePendingCasFn?: (
    id: string,
    userId: number,
    pool: Pool,
  ) => Promise<{ status: 'approved'; idempotentReplay: boolean }>
  denyPendingCasFn?: (
    id: string,
    userId: number,
    pool: Pool,
  ) => Promise<{ status: 'denied'; idempotentReplay: boolean }>
}

export function createConnectorWriteSource(deps: ConnectorWriteSourceDeps): PendingDecisionSourceAdapter {
  const approveCas = deps.approvePendingCasFn ?? approvePendingConfirmationCas
  const denyCas = deps.denyPendingCasFn ?? denyPendingConfirmationCas

  return {
    source: 'connector_write',

    async listPending(userId, opts): Promise<PendingDecisionItem[]> {
      const uid = parseUidInt(userId)
      const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200))
      const result = await deps.pool.query<ConnectorWritePgRow>(
        `SELECT id::text AS id, user_id::int AS user_id, connection_id::text AS connection_id,
                provider, action, summary, status, created_at, approved_at, finished_at, expires_at
           FROM connector_write_ledger
          WHERE user_id = $1 AND status = 'pending' AND expires_at > NOW()
          ORDER BY created_at ASC
          LIMIT $2`,
        [uid, limit],
      )

      return result.rows.map((row) => ({
        id: encodePendingDecisionId('connector_write', row.id),
        source: 'connector_write',
        sourceId: row.id,
        userId: String(row.user_id),
        sessionId: null,
        title: `${row.provider}: ${row.action}`,
        summary: row.summary || `连接器外部写入 (${row.provider}.${row.action})`,
        riskLevel: /delete|remove|send|publish|pay|transfer/i.test(row.action) ? 'high' : 'medium',
        status: 'pending',
        metadata: {
          connectionId: row.connection_id,
          provider: row.provider,
          action: row.action,
        },
        createdAt: toIso(row.created_at),
        expiresAt: toIso(row.expires_at),
        allowedActions: ['approve', 'deny'],
      }))
    },

    async resolve(userId, sourceId, req, nowMs = Date.now()): Promise<ResolvePendingDecisionResponse> {
      const uid = parseUidInt(userId)
      if (!UUID_RE.test(sourceId)) {
        throw new PendingDecisionError('INVALID_ID', `invalid connector write confirmation id: ${sourceId}`)
      }

      // Single atomic CAS directly on the ledger (`WHERE status = 'pending' AND user_id = $2`).
      // Only inspect foreign ownership if CAS reports CONFIRMATION_NOT_FOUND.
      try {
        const res =
          req.decision === 'approve'
            ? await approveCas(sourceId, uid, deps.pool as Pool)
            : await denyCas(sourceId, uid, deps.pool as Pool)

        return {
          id: encodePendingDecisionId('connector_write', sourceId),
          source: 'connector_write',
          sourceId,
          decision: req.decision,
          status: res.status,
          idempotentReplay: res.idempotentReplay,
          resolvedAt: new Date(nowMs).toISOString(),
        }
      } catch (err) {
        if (err instanceof ConnectorError) {
          if (err.code === 'CONFIRMATION_NOT_FOUND') {
            const ownerCheck = await deps.pool.query<{ user_id: number }>(
              `SELECT user_id::int AS user_id FROM connector_write_ledger WHERE id = $1::uuid LIMIT 1`,
              [sourceId],
            )
            if (ownerCheck.rows[0] && ownerCheck.rows[0].user_id !== uid) {
              throw new PendingDecisionError(
                'FORBIDDEN',
                'connector write confirmation belongs to another user',
              )
            }
            throw new PendingDecisionError('NOT_FOUND', err.message)
          }
          if (err.code === 'CONFIRMATION_EXPIRED') {
            throw new PendingDecisionError('EXPIRED', err.message)
          }
          if (
            err.code === 'CONFIRMATION_ALREADY_FINALIZED' ||
            err.code === 'CONFIRMATION_IN_PROGRESS'
          ) {
            throw new PendingDecisionError('CONFLICT_ALREADY_RESOLVED', err.message)
          }
        }
        throw err
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 3. taskboard (waiting_human) Source Adapter (B6 version-fenced atomic CAS)
// ---------------------------------------------------------------------------

function priorityToRisk(priority?: TaskboardTicketRecord['priority']): PendingDecisionRiskLevel {
  if (priority === 'P0') return 'critical'
  if (priority === 'P1') return 'high'
  if (priority === 'P2') return 'medium'
  return 'low'
}

export function encodeTaskboardVersionedSourceId(ticketId: string, version: number): string {
  return `${ticketId}@v${version}`
}

export function parseTaskboardVersionedSourceId(
  sourceId: string,
): { ticketId: string; expectedVersion: number | null } {
  const m = /^(.+)@v(\d+)$/.exec(sourceId)
  if (!m) return { ticketId: sourceId, expectedVersion: null }
  return { ticketId: m[1]!, expectedVersion: Number(m[2]) }
}

export function createTaskboardSource(backend: TaskboardDecisionBackend): PendingDecisionSourceAdapter {
  return {
    source: 'taskboard',

    async listPending(userId, opts): Promise<PendingDecisionItem[]> {
      const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200))
      const tickets = await backend.listWaitingHuman(userId, limit)
      return tickets
        .filter((t) => t.userId === userId && t.status === 'waiting_human')
        .map((t) => {
          const version = t.version ?? 1
          const versionedId = encodeTaskboardVersionedSourceId(t.id, version)
          return {
            id: encodePendingDecisionId('taskboard', versionedId),
            source: 'taskboard',
            sourceId: versionedId,
            userId: t.userId,
            sessionId: t.sessionId ?? null,
            title: t.identifier ? `[${t.identifier}] ${t.title}` : t.title,
            summary: t.summary || `任务单等待人工验收${t.stageName ? ` (${t.stageName})` : ''}`,
            riskLevel: priorityToRisk(t.priority),
            status: 'pending',
            metadata: {
              ticketId: t.id,
              version,
              approveTargetStatus: t.approveTargetStatus ?? 'done',
              ...(t.identifier ? { identifier: t.identifier } : {}),
              ...(t.priority ? { priority: t.priority } : {}),
              ...(t.stageName ? { stageName: t.stageName } : {}),
              ...(t.metadata ?? {}),
            },
            createdAt: toIso(t.createdAt),
            expiresAt: null,
            allowedActions: ['approve', 'deny'],
          }
        })
    },

    async resolve(userId, sourceId, req): Promise<ResolvePendingDecisionResponse> {
      const parsed = parseTaskboardVersionedSourceId(sourceId)
      if (parsed.expectedVersion === null) {
        throw new PendingDecisionError(
          'CONFLICT_ALREADY_RESOLVED',
          `taskboard decision id must include explicit round version (@v<n>): ${sourceId}`,
          409,
        )
      }
      const ticket = await backend.getTicket(parsed.ticketId, userId)
      if (!ticket) {
        throw new PendingDecisionError('NOT_FOUND', `taskboard ticket not found: ${parsed.ticketId}`)
      }
      if (ticket.userId !== userId) {
        throw new PendingDecisionError('FORBIDDEN', 'taskboard ticket belongs to another user')
      }

      const expectedVersion = parsed.expectedVersion
      const toStatus =
        req.decision === 'approve'
          ? (ticket.approveTargetStatus ?? 'done')
          : 'ready'

      const transitioned = await backend.transitionTicket({
        ticketId: parsed.ticketId,
        userId,
        expectedVersion,
        expectedStatus: 'waiting_human',
        decision: req.decision,
        toStatus,
        reason: req.reason,
        originChannel: req.originChannel,
      })

      return {
        id: encodePendingDecisionId('taskboard', sourceId),
        source: 'taskboard',
        sourceId,
        decision: req.decision,
        status: req.decision === 'approve' ? 'approved' : 'denied',
        idempotentReplay: transitioned.idempotentReplay,
        resolvedAt: transitioned.resolvedAt,
      }
    },
  }
}

interface TicketRoundResolution {
  decision: PendingDecisionAction
  toStatus: 'done' | 'running' | 'ready'
  resolvedAt: string
}

export class InMemoryTaskboardDecisionBackend implements TaskboardDecisionBackend {
  private readonly tickets = new Map<string, TaskboardTicketRecord>()
  /** Tracks atomic per-(ticketId, version) decision outcomes for idempotent replay vs 409 conflict. */
  private readonly roundResolutions = new Map<string, TicketRoundResolution>()

  upsert(ticket: TaskboardTicketRecord): void {
    this.tickets.set(ticket.id, { ...ticket, version: ticket.version ?? 1 })
  }

  /** Reopen a ticket back to `waiting_human` with a bumped version (fences all prior cards). */
  reopenToWaitingHuman(ticketId: string): number {
    const existing = this.tickets.get(ticketId)
    if (!existing) throw new PendingDecisionError('NOT_FOUND', `ticket not found: ${ticketId}`)
    const nextVersion = (existing.version ?? 1) + 1
    existing.status = 'waiting_human'
    existing.version = nextVersion
    existing.updatedAt = new Date().toISOString()
    return nextVersion
  }

  async listWaitingHuman(userId: string, limit: number): Promise<TaskboardTicketRecord[]> {
    return Array.from(this.tickets.values())
      .filter((t) => t.userId === userId && t.status === 'waiting_human')
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, limit)
  }

  async getTicket(ticketId: string): Promise<TaskboardTicketRecord | null> {
    const found = this.tickets.get(ticketId)
    return found ? { ...found } : null
  }

  async transitionTicket(input: {
    ticketId: string
    userId: string
    expectedVersion: number
    expectedStatus: 'waiting_human'
    decision: PendingDecisionAction
    toStatus: 'done' | 'running' | 'ready'
    reason?: string
    originChannel?: string
  }): Promise<{ status: 'done' | 'running' | 'ready'; idempotentReplay: boolean; resolvedAt: string }> {
    const existing = this.tickets.get(input.ticketId)
    if (!existing) throw new PendingDecisionError('NOT_FOUND', `ticket not found: ${input.ticketId}`)
    if (existing.userId !== input.userId) {
      throw new PendingDecisionError('FORBIDDEN', 'ticket belongs to another user')
    }

    const curVersion = existing.version ?? 1
    const roundKey = `${input.ticketId}@v${input.expectedVersion}`
    const prior = this.roundResolutions.get(roundKey)

    // If this exact round was already decided:
    //   - Reopen moved ticket past expectedVersion + 1 -> stale card from an older round -> CONFLICT!
    //   - Still at expectedVersion + 1 (just decided) and same decision -> idempotent replay.
    //   - Opposite decision -> 409 CONFLICT.
    if (prior) {
      if (curVersion > input.expectedVersion + 1) {
        throw new PendingDecisionError(
          'CONFLICT_ALREADY_RESOLVED',
          `ticket ${input.ticketId} was reopened to v${curVersion}; decision for v${input.expectedVersion} is stale`,
        )
      }
      if (prior.decision === input.decision) {
        return {
          status: prior.toStatus,
          idempotentReplay: true,
          resolvedAt: prior.resolvedAt,
        }
      }
      throw new PendingDecisionError(
        'CONFLICT_ALREADY_RESOLVED',
        `ticket ${input.ticketId}@v${input.expectedVersion} was already resolved as ${prior.decision}`,
      )
    }

    if (curVersion !== input.expectedVersion || existing.status !== input.expectedStatus) {
      throw new PendingDecisionError(
        'CONFLICT_ALREADY_RESOLVED',
        `CAS mismatch for ${input.ticketId}: expected v${input.expectedVersion}/${input.expectedStatus}, got v${curVersion}/${existing.status}`,
      )
    }

    const resolvedAt = new Date().toISOString()
    existing.status = input.toStatus
    existing.version = curVersion + 1
    existing.updatedAt = resolvedAt
    existing.metadata = {
      ...(existing.metadata ?? {}),
      ...(input.reason ? { resolutionReason: input.reason } : {}),
      ...(input.originChannel ? { resolutionChannel: input.originChannel } : {}),
    }
    this.roundResolutions.set(roundKey, {
      decision: input.decision,
      toStatus: input.toStatus,
      resolvedAt,
    })
    return { status: input.toStatus, idempotentReplay: false, resolvedAt }
  }
}

// ---------------------------------------------------------------------------
// 4. browser_handoff Source Adapter + In-Memory Store
// ---------------------------------------------------------------------------

export class InMemoryBrowserHandoffStore implements BrowserHandoffStore {
  private readonly items = new Map<string, BrowserHandoffRecord>()
  private readonly now: () => number

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now())
  }

  async create(input: {
    id?: string
    userId: string
    sessionId?: string | null
    title: string
    url: string
    reason: string
    riskLevel?: PendingDecisionRiskLevel
    ttlMs?: number
    metadata?: Record<string, unknown>
  }): Promise<BrowserHandoffRecord> {
    const nowMs = this.now()
    const id = input.id?.trim() || `bh-${randomUUID()}`
    const ttlMs = Math.max(1000, input.ttlMs ?? DEFAULT_HANDOFF_TTL_MS)
    const rec: BrowserHandoffRecord = {
      id,
      userId: input.userId,
      sessionId: input.sessionId ?? null,
      title: input.title,
      url: input.url,
      reason: input.reason,
      riskLevel: input.riskLevel ?? 'high',
      status: 'pending',
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
      resolvedAt: null,
      resolutionNote: null,
      metadata: input.metadata,
    }
    this.items.set(id, rec)
    return { ...rec }
  }

  async listPending(userId: string, limit: number, nowMs = this.now()): Promise<BrowserHandoffRecord[]> {
    const out: BrowserHandoffRecord[] = []
    for (const rec of this.items.values()) {
      if (rec.userId !== userId) continue
      if (rec.status !== 'pending') continue
      if (new Date(rec.expiresAt).getTime() <= nowMs) {
        rec.status = 'expired'
        continue
      }
      out.push({ ...rec })
    }
    return out
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, limit)
  }

  async getById(id: string): Promise<BrowserHandoffRecord | null> {
    const rec = this.items.get(id)
    return rec ? { ...rec } : null
  }

  async resolve(input: {
    id: string
    userId: string
    decision: PendingDecisionAction
    reason?: string
    nowMs?: number
  }): Promise<{ status: 'approved' | 'denied'; idempotentReplay: boolean; resolvedAt: string }> {
    const nowMs = input.nowMs ?? this.now()
    const rec = this.items.get(input.id)
    if (!rec) {
      throw new PendingDecisionError('NOT_FOUND', `browser handoff not found: ${input.id}`)
    }
    if (rec.userId !== input.userId) {
      throw new PendingDecisionError('FORBIDDEN', 'browser handoff belongs to another user')
    }
    const desired: 'approved' | 'denied' = input.decision === 'approve' ? 'approved' : 'denied'
    if (rec.status === 'approved' || rec.status === 'denied') {
      if (rec.status === desired) {
        return {
          status: desired,
          idempotentReplay: true,
          resolvedAt: rec.resolvedAt ?? new Date(nowMs).toISOString(),
        }
      }
      throw new PendingDecisionError(
        'CONFLICT_ALREADY_RESOLVED',
        `browser handoff already resolved (${rec.status})`,
      )
    }
    if (rec.status === 'expired' || new Date(rec.expiresAt).getTime() <= nowMs) {
      rec.status = 'expired'
      throw new PendingDecisionError('EXPIRED', 'browser handoff has expired')
    }
    const resolvedAt = new Date(nowMs).toISOString()
    rec.status = desired
    rec.resolvedAt = resolvedAt
    rec.resolutionNote = input.reason ?? null
    return { status: desired, idempotentReplay: false, resolvedAt }
  }
}

export function createBrowserHandoffSource(store: BrowserHandoffStore): PendingDecisionSourceAdapter {
  return {
    source: 'browser_handoff',

    async listPending(userId, opts): Promise<PendingDecisionItem[]> {
      const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200))
      const rows = await store.listPending(userId, limit, opts?.nowMs)
      return rows.map((rec) => ({
        id: encodePendingDecisionId('browser_handoff', rec.id),
        source: 'browser_handoff',
        sourceId: rec.id,
        userId: rec.userId,
        sessionId: rec.sessionId,
        title: rec.title || '浏览器人工接管',
        summary: `${rec.reason} (${rec.url})`,
        riskLevel: rec.riskLevel ?? 'high',
        status: 'pending',
        metadata: {
          url: rec.url,
          reason: rec.reason,
          ...(rec.metadata ?? {}),
        },
        createdAt: rec.createdAt,
        expiresAt: rec.expiresAt,
        allowedActions: ['approve', 'deny'],
      }))
    },

    async resolve(userId, sourceId, req, nowMs = Date.now()): Promise<ResolvePendingDecisionResponse> {
      const result = await store.resolve({
        id: sourceId,
        userId,
        decision: req.decision,
        reason: req.reason,
        nowMs,
      })
      return {
        id: encodePendingDecisionId('browser_handoff', sourceId),
        source: 'browser_handoff',
        sourceId,
        decision: req.decision,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
        resolvedAt: result.resolvedAt,
      }
    },
  }
}
