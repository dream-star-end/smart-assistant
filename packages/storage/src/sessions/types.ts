import type {
  AutomaticTurnRecoverySnapshot,
  SessionSnapshot,
} from '@openclaude/protocol'
import type { MessageUsageDelegate } from '@openclaude/protocol/teamCards'

export interface SessionMeta {
  id: string
  agentId: string
  channel: string
  peerId: string
  title: string
  startedAt: number
  lastAt: number
  turnCount: number
  totalCostUSD: number
}

export interface AutoDreamSuccessfulSession {
  seq: number
  id: string
  agentId: string
  channel: string
  completedAt: number
}

export type TurnDispatchInboxState =
  | 'queued'
  | 'running'
  | 'recovery_pending'
  | 'sink_staged'
  | 'sink_stage_failed'
  | 'terminal'
  | 'rejected'

export type TurnDispatchInboxOutcome = 'completed' | 'interrupted' | 'crashed' | 'not_accepted'

export interface TurnDispatchInboxRow {
  userId: string
  sessionId: string
  clientMessageId: string
  dispatchId: string
  attemptNo: number
  payloadHash: string
  state: TurnDispatchInboxState
  outcome: TurnDispatchInboxOutcome | null
  agentId: string | null
  turnIndex: number | null
  turnKey: string | null
  requestId: string | null
  createdAt: number
  acceptedAt: number
  updatedAt: number
  /** Set only when a queued turn is rejected for the attachment total. */
  userFailureCode?: string
}

export interface ExactTurnDispatchIdentity {
  userId: string
  sessionId: string
  clientMessageId: string
  dispatchId: string
  attemptNo: number
}

export interface SearchHit {
  sessionId: string
  agentId: string
  channel: string
  peerId: string
  title: string
  lastAt: number
  snippet: string
  score: number
}

export interface EventLogEntry {
  id: string
  type: string
  timestamp: number
  agentId: string
  sessionKey?: string
  schemaVersion: number
  payload: string
  peerId?: string
  channel?: string
}

export type UsageTerminalStatus =
  | 'completed'
  | 'error'
  | 'crashed'
  | 'aborted'
  | 'stopped'
  | 'timeout'
  | 'reconciled'

export interface UsageLogEntry {
  id: string
  sessionId: string
  agentId: string
  turnIndex: number
  model?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  durationMs: number
  toolCalls: number
  timestamp: number
  terminalStatus?: UsageTerminalStatus
}

export type InsertUsageLogResult =
  | { status: 'inserted' }
  | { status: 'duplicate'; conflict: boolean }

export interface UsageSummary {
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTurns: number
}

export interface ClientSessionPermissionPromptItem {
  requestId: string
  clientMessageId: string | null
  toolUseId: string | null
  toolName: string
  inputJson: Record<string, unknown>
  inputTruncated?: boolean
  status: 'pending' | 'responded' | 'cancelled' | 'expired'
  behavior: 'allow' | 'deny' | null
  reason: string | null
  answers: Record<string, string> | null
  expiresAt: number
  createdAt: number
  updatedAt: number
}

export interface ClientSession {
  id: string
  userId: string
  agentId: string
  title: string
  pinned: boolean
  createdAt: number
  lastAt: number
  messages: unknown[]
  updatedAt: number
  modelId?: string
  historyRevision?: number
  timelineGeneration?: number
  timelineCursor?: ClientTimelineCursor | null
  timelineHasMore?: boolean
  timelineSnapshotMaxSeq?: number
  archivedCount?: number
  archivedThroughSeq?: number
  automaticRecoveries?: AutomaticTurnRecoverySnapshot[]
  openDispatch?: {
    dispatchId: string
    clientMessageId: string
    status: string
    acceptedAt: number | null
    lastFrameAt: number | null
    model?: string
  }
  permissionPrompts?: {
    items: ClientSessionPermissionPromptItem[]
    completeness: 'complete' | 'truncated' | 'unavailable'
    source: 'pg' | 'runtime'
    lookups?: ClientSessionPermissionPromptItem[]
  }
}

export interface ClientTimelineCursor {
  version: 1
  timelineGeneration: number
  beforeOrderSeq: number
  tapeId?: string
  tapeSha256?: string
  beforeOrdinal?: number
}

export interface ClientTimelinePage {
  messages: MessageLike[]
  nextCursor: ClientTimelineCursor | null
  hasMore: boolean
  timelineGeneration: number
  historyRevision: number
  snapshotMaxSeq: number
}

export class ClientTimelineCursorStaleError extends Error {
  constructor() {
    super('client timeline cursor generation is stale')
    this.name = 'ClientTimelineCursorStaleError'
  }
}

const TIMELINE_CURSOR_TAPE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/
const TIMELINE_CURSOR_SHA_RE = /^[0-9a-f]{64}$/

export function encodeClientTimelineCursor(cursor: ClientTimelineCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function isValidTimelineCursorCore(value: Partial<ClientTimelineCursor>): boolean {
  if (value.version !== 1) return false
  if (!Number.isSafeInteger(value.timelineGeneration) || (value.timelineGeneration ?? 0) < 1) {
    return false
  }
  return Number.isSafeInteger(value.beforeOrderSeq) && (value.beforeOrderSeq ?? 0) >= 1
}

function isValidTimelineCursorTape(value: Partial<ClientTimelineCursor>): boolean {
  const hasTape =
    value.tapeId !== undefined ||
    value.tapeSha256 !== undefined ||
    value.beforeOrdinal !== undefined
  if (!hasTape) return true
  if (typeof value.tapeId !== 'string' || !TIMELINE_CURSOR_TAPE_ID_RE.test(value.tapeId)) {
    return false
  }
  if (typeof value.tapeSha256 !== 'string' || !TIMELINE_CURSOR_SHA_RE.test(value.tapeSha256)) {
    return false
  }
  return Number.isSafeInteger(value.beforeOrdinal) && (value.beforeOrdinal ?? -1) >= 0
}

export function decodeClientTimelineCursor(raw: string): ClientTimelineCursor | null {
  if (!raw || raw.length > 512) return null
  try {
    const value = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as Partial<ClientTimelineCursor>
    if (!isValidTimelineCursorCore(value)) return null
    if (!isValidTimelineCursorTape(value)) return null
    return value as ClientTimelineCursor
  } catch {
    return null
  }
}

export type ClientSessionRunState = 'running' | 'idle'

export type ClientSessionLastOutcome =
  | 'completed'
  | 'interrupted'
  | 'crashed'
  | 'not_accepted'
  | 'executed_error'

export interface ClientSessionMeta {
  id: string
  agentId: string
  title: string
  pinned: boolean
  createdAt: number
  lastAt: number
  messageCount: number
  updatedAt: number
  modelId?: string
  projectId: string | null
  runState: ClientSessionRunState
  lastOutcome: ClientSessionLastOutcome | null
  lastErrorCode: string | null
  archived: boolean
  unread: boolean
  lastMessagePreview?: string
}

export function parseChatProjectCronJobIds(value: unknown): string[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 200) return null
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) return null
    if (!out.includes(v)) out.push(v)
  }
  return out
}

export const SESSION_SEARCH_Q_MAX = 200
export const SESSION_LIST_LIMIT_MAX = 200

export const CLIENT_SESSION_UNREAD_OUTCOMES = [
  'completed',
  'interrupted',
  'crashed',
  'not_accepted',
  'executed_error',
] as const

export const UNREAD_OUTCOME_SQL = CLIENT_SESSION_UNREAD_OUTCOMES.map((o) => `'${o}'`).join(',')
export const LAST_READ_AT_EPOCH_MS_FLOOR = 100_000_000_000

export function lastReadAtWatermarkMsSql(col = 'cs.last_read_at'): string {
  return `(CASE WHEN COALESCE(${col}, 0) <= 0 THEN 0 WHEN ${col} < ${LAST_READ_AT_EPOCH_MS_FLOOR} THEN (${col} * 1000) ELSE ${col} END)`
}

export const LAST_READ_AT_MS_SQL = lastReadAtWatermarkMsSql('cs.last_read_at')
export const LAST_D_TERMINAL_MS_SQL = lastReadAtWatermarkMsSql('last_d.terminal_at')
export const LAST_MESSAGE_PREVIEW_MAX = 80
export const LAST_MESSAGE_PREVIEW_TAIL_MAX = 20
export const SESSION_SEARCH_JSON_EXPAND_MAX_BYTES = 2 * 1024 * 1024

export type ListClientSessionsOpts = {
  includeArchived?: boolean
  limit?: number
  before?: number
}

export type ListClientSessionsResult = {
  sessions: ClientSessionMeta[]
  nextCursor?: number
}

/** LIKE/ILIKE wildcard escape; pair with ESCAPE '\'. */
export function escapeLikePattern(q: string): string {
  return q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/** Strip code fences, markdown images, HTML tags, line breaks and control chars. */
export function toPlainSessionText(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function toLastMessagePreview(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined
  const plain = toPlainSessionText(raw)
  if (!plain) return undefined
  return plain.length > LAST_MESSAGE_PREVIEW_MAX ? plain.slice(0, LAST_MESSAGE_PREVIEW_MAX) : plain
}

export function parseOptionalPositiveInt(
  raw: string | null,
  fallback: number,
  max: number,
): number {
  if (raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.floor(n))
}

export function parseIncludeArchivedFlag(raw: string | null): boolean {
  return raw === '1' || raw === 'true'
}

export function mapClientSessionLastOutcome(raw: unknown): ClientSessionLastOutcome | null {
  switch (raw) {
    case 'completed':
    case 'interrupted':
    case 'crashed':
    case 'not_accepted':
    case 'executed_error':
      return raw
    default:
      return null
  }
}

export interface ClientSessionLifecycleRef {
  sessionId: string
  userId: string
}

export type ClientSessionLifecycleState = 'active' | 'deleted' | 'missing'

export interface ClientSessionLifecycle extends ClientSessionLifecycleRef {
  state: ClientSessionLifecycleState
}

/** Minimal shape this module relies on. Real messages carry more fields. */
export type MessageLike = {
  id?: string
  ts?: number
  _source?: string
  _orderSeq?: number
  _turnTapeOrdinal?: number
  [k: string]: unknown
}

export type ClientSessionReadOptions = {
  view?: 'exact' | 'timeline'
  sinceHistoryRevision?: number
  permissionLookupIds?: string[]
}

export const MAX_SESSION_BYTES = 4 * 1024 * 1024
export const SESSION_SOFT_TRIM_BYTES = Math.floor(2.5 * 1024 * 1024)
export const SESSION_TAIL_TARGET_BYTES = 2 * 1024 * 1024
export const SESSION_TAIL_MIN_MSGS = 64
export const ARCHIVE_CHUNK_MAX_MSGS = 200
export const ARCHIVE_CHUNK_MAX_BYTES = 768 * 1024

export type UpsertClientSessionResult = 'applied' | 'rejected_stale' | 'oversized'

export interface SpillOverflowResult {
  tail: MessageLike[]
  archivedDelta: number
  archivedThroughSeq: number
}

export type ServerAuthoredAppendResult =
  | { applied: true }
  | {
      applied: false
      reason: 'session_not_found' | 'session_deleted' | 'already_exists' | 'malformed' | 'oversized'
    }

export type AppendForRequestResult =
  | { applied: true }
  | {
      applied: false
      reason: 'session_not_found' | 'session_deleted' | 'already_exists' | 'malformed' | 'oversized'
    }

export type AppendCostCreditsResult =
  | { applied: 'patched' }
  | { applied: 'pending' }
  | { applied: 'noop' }

export interface DrainDelegateCostResult {
  merged: string
  drained: number
  delegates?: MessageUsageDelegate[]
}

export interface UsageAggregationGcStats {
  pendingAging: number
  pendingExpired: number
  mapExpired: number
  pendingFolded: number
  pendingFoldAnomaly: number
  pendingUnreachableExpired: number
  tapePartsPurged: number
}

export interface QueuedMessage {
  sessId: string
  userId: string
  message: {
    id: string
    role: 'assistant' | 'user' | 'system' | 'thinking' | 'tool' | 'permission'
    text?: string
    ts?: number
    status?: 'completed' | 'interrupted' | 'crashed'
    [k: string]: unknown
  }
  queuedAt: number
  reason?: string
}

export type ClientSessionCollabParent = {
  sessionId: string
  userId: string
  agentId: string
  modelId?: string
}

export interface ClientSessionPartial extends ClientSession {
  totalMessageCount: number
  maxSeq: number
  isPartial: boolean
}

export interface ReadArchivedMessagesResult {
  messages: MessageLike[]
  hasMore: boolean
  oldestSeq: number | null
  historyRevision?: number
}

export interface ClientSessionLiveFramePage {
  snapshot?: SessionSnapshot | null
  frames: Array<{
    recordId: string
    streamKey: string
    source: 'gateway' | 'rollout_import'
    clientMessageId: string | null
    payload: unknown
  }>
  nextCursor: string | null
  hasMore: boolean
  hasMoreBefore: boolean
  streamClientMessageIds: string[]
  hasTapeProjection: boolean
  tapeProjectionVersion: number
}

export interface EngineContextReadOptions {
  contextWindow?: number | null
  engine?: string
  currentUserText?: string
  excludeClientMessageId?: string
}

export type PatchServerAuthoredResult =
  | { applied: true }
  | { applied: false; reason: 'session_not_found' | 'session_deleted' | 'not_found' }

export function safeParseMessageArray(raw: string): MessageLike[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as MessageLike[]) : []
  } catch {
    return []
  }
}
