/**
 * Unified Pending Decisions ("待拍板") Protocol Contract.
 *
 * Aggregates human-decision gates across:
 *   - turn_permission  (turn_permission_requests)
 *   - connector_write  (connector_write_ledger pending writes)
 *   - taskboard        (taskboard waiting_human tickets)
 *   - browser_handoff  (active live-browser login/2FA/captcha handoffs)
 */

export const PENDING_DECISION_SOURCES = [
  'turn_permission',
  'connector_write',
  'taskboard',
  'browser_handoff',
] as const
export type PendingDecisionSource = (typeof PENDING_DECISION_SOURCES)[number]

export const PENDING_DECISION_STATUSES = [
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
] as const
export type PendingDecisionStatus = (typeof PENDING_DECISION_STATUSES)[number]

export const PENDING_DECISION_ACTIONS = ['approve', 'deny'] as const
export type PendingDecisionAction = (typeof PENDING_DECISION_ACTIONS)[number]

export const PENDING_DECISION_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const
export type PendingDecisionRiskLevel = (typeof PENDING_DECISION_RISK_LEVELS)[number]

export interface PendingDecisionItem {
  /** Globally unique composite id: `<source>:<sourceId>`. */
  id: string
  source: PendingDecisionSource
  /** Underlying primary key / requestId / ticketId / handoffId. */
  sourceId: string
  /** Owner user id (stringified integer uid). */
  userId: string
  /** Associated chat session id if any. */
  sessionId: string | null
  title: string
  summary: string
  riskLevel: PendingDecisionRiskLevel
  status: PendingDecisionStatus
  metadata: Record<string, unknown>
  createdAt: string
  expiresAt: string | null
  allowedActions: readonly PendingDecisionAction[]
}

export interface PendingDecisionWarning {
  source: PendingDecisionSource
  code: string
  message: string
}

export interface ListPendingDecisionsResponse {
  items: PendingDecisionItem[]
  counts: {
    total: number
    bySource: Record<PendingDecisionSource, number>
  }
  warnings?: PendingDecisionWarning[]
  generatedAt: string
}

export interface ResolvePendingDecisionRequest {
  decision: PendingDecisionAction
  /** Optional comment (approve note or deny reason). */
  reason?: string
  /** Optional caller-provided idempotency key for replay-safe retries. */
  idempotencyKey?: string
  /** Originating surface: web | wechat | qqbot | telegram | feishu | api. */
  originChannel?: string
}

export interface ResolvePendingDecisionResponse {
  id: string
  source: PendingDecisionSource
  sourceId: string
  decision: PendingDecisionAction
  status: 'approved' | 'denied'
  /** True when the item was already resolved with the same decision. */
  idempotentReplay: boolean
  resolvedAt: string
  message?: string
}

export const PENDING_DECISION_SOURCE_LABELS: Readonly<Record<PendingDecisionSource, string>> = {
  turn_permission: '工具权限确认',
  connector_write: '连接器外部写入',
  taskboard: '任务单待验收',
  browser_handoff: '浏览器人工接管',
}

export const PENDING_DECISIONS_LIST_PATH = '/api/me/pending-decisions'

export function isPendingDecisionSource(value: unknown): value is PendingDecisionSource {
  return (
    typeof value === 'string' &&
    (PENDING_DECISION_SOURCES as readonly string[]).includes(value)
  )
}

export function isPendingDecisionAction(value: unknown): value is PendingDecisionAction {
  return value === 'approve' || value === 'deny'
}

/**
 * Encode `<source>:<sourceId>` composite identifier.
 * Validates source and rejects control characters or empty sourceId.
 */
export function encodePendingDecisionId(
  source: PendingDecisionSource,
  sourceId: string,
): string {
  const trimmed = sourceId.trim()
  if (!trimmed || /[\r\n\0]/.test(trimmed)) {
    throw new Error('invalid pending decision sourceId')
  }
  return `${source}:${trimmed}`
}

/**
 * Parse composite `<source>:<sourceId>` identifier.
 * Preserves colons inside sourceId (e.g. `turn_permission:ask-user:123`).
 */
export function parsePendingDecisionId(
  id: string,
): { source: PendingDecisionSource; sourceId: string } | null {
  if (typeof id !== 'string') return null
  const idx = id.indexOf(':')
  if (idx <= 0) return null
  const prefix = id.slice(0, idx)
  const sourceId = id.slice(idx + 1).trim()
  if (!isPendingDecisionSource(prefix)) return null
  if (!sourceId || sourceId.length > 256 || /[\r\n\0]/.test(sourceId)) return null
  return { source: prefix, sourceId }
}

export function emptyPendingDecisionCounts(): Record<PendingDecisionSource, number> {
  return {
    turn_permission: 0,
    connector_write: 0,
    taskboard: 0,
    browser_handoff: 0,
  }
}
