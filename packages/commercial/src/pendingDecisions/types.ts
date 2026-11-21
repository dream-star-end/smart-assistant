import type {
  PendingDecisionAction,
  PendingDecisionItem,
  PendingDecisionRiskLevel,
  PendingDecisionSource,
  ResolvePendingDecisionRequest,
  ResolvePendingDecisionResponse,
} from '@openclaude/protocol'

export type PendingDecisionErrorCode =
  | 'INVALID_ID'
  | 'INVALID_ACTION'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'EXPIRED'
  | 'CONFLICT_ALREADY_RESOLVED'
  | 'REQUIRES_INTERACTIVE_ANSWER'
  | 'SOURCE_UNAVAILABLE'
  | 'INTERNAL'

export class PendingDecisionError extends Error {
  readonly code: PendingDecisionErrorCode
  readonly httpStatus: number

  constructor(code: PendingDecisionErrorCode, message: string, httpStatus?: number) {
    super(message)
    this.name = 'PendingDecisionError'
    this.code = code
    this.httpStatus = httpStatus ?? defaultStatusForCode(code)
  }
}

function defaultStatusForCode(code: PendingDecisionErrorCode): number {
  switch (code) {
    case 'INVALID_ID':
    case 'INVALID_ACTION':
      return 400
    case 'FORBIDDEN':
      return 403
    case 'NOT_FOUND':
      return 404
    case 'EXPIRED':
    case 'CONFLICT_ALREADY_RESOLVED':
      return 409
    case 'REQUIRES_INTERACTIVE_ANSWER':
      return 422
    case 'SOURCE_UNAVAILABLE':
      return 503
    default:
      return 500
  }
}

export interface PendingDecisionSourceAdapter {
  readonly source: PendingDecisionSource
  listPending(userId: string, opts?: { limit?: number; nowMs?: number }): Promise<PendingDecisionItem[]>
  resolve(
    userId: string,
    sourceId: string,
    req: ResolvePendingDecisionRequest,
    nowMs?: number,
  ): Promise<ResolvePendingDecisionResponse>
}

export interface TaskboardTicketRecord {
  id: string
  identifier?: string
  userId: string
  sessionId?: string | null
  title: string
  summary?: string
  status: 'backlog' | 'ready' | 'running' | 'waiting_human' | 'blocked' | 'done' | 'canceled'
  /** Monotonic ticket/round version; increments on every transition & reopen to fence stale cards. */
  version?: number
  /** Whether approving this waiting_human station closes ('done') or advances ('running'). Default 'done'. */
  approveTargetStatus?: 'done' | 'running'
  priority?: 'P0' | 'P1' | 'P2' | 'P3'
  stageName?: string
  createdAt: string | Date
  updatedAt?: string | Date
  metadata?: Record<string, unknown>
}

export interface TaskboardDecisionBackend {
  listWaitingHuman(userId: string, limit: number): Promise<TaskboardTicketRecord[]>
  getTicket(ticketId: string): Promise<TaskboardTicketRecord | null>
  /**
   * Atomic CAS transition gated by `(ticketId, userId, expectedStatus='waiting_human', expectedVersion)`.
   * Same-decision replay against an already-decided `expectedVersion` returns `idempotentReplay: true`;
   * opposite decision or stale version after reopen MUST throw `PendingDecisionError('CONFLICT_ALREADY_RESOLVED')`.
   */
  transitionTicket(input: {
    ticketId: string
    userId: string
    expectedVersion: number
    expectedStatus: 'waiting_human'
    decision: PendingDecisionAction
    toStatus: 'done' | 'running' | 'ready'
    reason?: string
    originChannel?: string
  }): Promise<{
    status: 'done' | 'running' | 'ready'
    idempotentReplay: boolean
    resolvedAt: string
  }>
}

export interface BrowserHandoffRecord {
  id: string
  userId: string
  sessionId: string | null
  title: string
  url: string
  reason: string
  riskLevel?: PendingDecisionRiskLevel
  status: 'pending' | 'approved' | 'denied' | 'expired'
  createdAt: string
  expiresAt: string
  resolvedAt?: string | null
  resolutionNote?: string | null
  metadata?: Record<string, unknown>
}

export interface BrowserHandoffStore {
  create(input: {
    id?: string
    userId: string
    sessionId?: string | null
    title: string
    url: string
    reason: string
    riskLevel?: PendingDecisionRiskLevel
    ttlMs?: number
    metadata?: Record<string, unknown>
  }): Promise<BrowserHandoffRecord>
  listPending(userId: string, limit: number, nowMs?: number): Promise<BrowserHandoffRecord[]>
  getById(id: string): Promise<BrowserHandoffRecord | null>
  resolve(input: {
    id: string
    userId: string
    decision: PendingDecisionAction
    reason?: string
    nowMs?: number
  }): Promise<{ status: 'approved' | 'denied'; idempotentReplay: boolean; resolvedAt: string }>
}

export interface PendingDecisionLifecycleHooks {
  onCreated?: (item: PendingDecisionItem) => void | Promise<void>
  onResolved?: (result: ResolvePendingDecisionResponse, userId: string) => void | Promise<void>
}
