/**
 * Taskboard 前端类型 + `/api/board` 客户端。
 *
 * 类型与 `packages/gateway/src/taskboard/domain.ts` 锁步（字段名、枚举值、
 * 时间戳 = epoch 毫秒 number）。本文件不 import gateway，避免前端包绑后端。
 *
 * 鉴权四件套照抄 `lib/api.ts`：`callWithRefresh` + `bearerHeaders` +
 * `credentials: "include"` + `jsonOrThrow`。
 */
import { ApiError, apiErrorMessage, bearerHeaders, callWithRefresh, jsonOrThrow } from './api'
import type { AuthSession } from './types'

// ── 与 domain.ts 锁步的枚举 / 标签 ─────────────────────────────────────────

export const TICKET_TYPES = ['bug', 'feature', 'spike', 'chore'] as const
export type TicketType = (typeof TICKET_TYPES)[number]

export const TICKET_TYPE_LABEL: Record<TicketType, string> = {
  bug: '问题单',
  feature: '需求单',
  spike: '调研单',
  chore: '杂务单',
}

export const TICKET_STATUSES = [
  'backlog',
  'ready',
  'running',
  'waiting_human',
  'blocked',
  'done',
  'canceled',
] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  backlog: '待立项',
  ready: '待执行',
  running: '执行中',
  waiting_human: '等我确认',
  blocked: '受阻',
  done: '完成',
  canceled: '取消',
}

export const TERMINAL_STATUSES: ReadonlySet<TicketStatus> = new Set<TicketStatus>([
  'done',
  'canceled',
])

export type Actor = 'human' | 'agent' | 'system'

export const TICKET_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]

export const TICKET_SEVERITIES = ['critical', 'major', 'minor', 'trivial'] as const
export type TicketSeverity = (typeof TICKET_SEVERITIES)[number]

export const TICKET_SOURCES = ['chat', 'manual', 'webhook', 'cron', 'patrol'] as const
export type TicketSource = (typeof TICKET_SOURCES)[number]

export const STAGE_KINDS = ['ai', 'human', 'gate'] as const
export type StageKind = (typeof STAGE_KINDS)[number]

export const ON_SUCCESS_ACTIONS = ['advance', 'wait_human', 'stay'] as const
export type OnSuccessAction = (typeof ON_SUCCESS_ACTIONS)[number]

export const ON_FAILURE_ACTIONS = ['block', 'retry', 'wait_human'] as const
export type OnFailureAction = (typeof ON_FAILURE_ACTIONS)[number]

export const RUN_TRIGGERS = ['patrol', 'manual', 'transition', 'webhook', 'retry'] as const
export type RunTrigger = (typeof RUN_TRIGGERS)[number]

export const RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'timeout',
  'skipped',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const RUN_SKIP_REASONS = [
  'blocked_by_dependency',
  'daily_quota',
  'outside_window',
  'lease_held',
  'entry_condition',
  'concurrency_full',
  'budget_exhausted',
  'circuit_open',
  'loop_guard',
  'patrol_disabled',
  'idle_backoff',
] as const
export type RunSkipReason = (typeof RUN_SKIP_REASONS)[number]

export const RELATION_KINDS = ['parent', 'blocks', 'related'] as const
export type RelationKind = (typeof RELATION_KINDS)[number]

export const AUTHOR_KINDS = ['human', 'agent', 'system'] as const
export type AuthorKind = (typeof AUTHOR_KINDS)[number]

// ── 实体（camelCase，时间戳 number）────────────────────────────────────────

export interface Project {
  id: string
  key: string
  name: string
  description: string | null
  workspace: string | null
  labels: string[]
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface Ticket {
  id: string
  identifier: string
  projectId: string
  type: TicketType
  title: string
  body: string
  status: TicketStatus
  stageId: string | null
  pipelineId: string | null
  priority: TicketPriority
  severity: TicketSeverity | null
  labels: string[]
  assignee: string | null
  reporter: string
  source: TicketSource
  originSessionKey: string | null
  dueDate: number | null
  startDate: number | null
  version: number
  blockedReason: string | null
  stageLoopCount: number
  createdAt: number
  updatedAt: number
  closedAt: number | null
}

export interface Pipeline {
  id: string
  projectId: string
  name: string
  ticketType: TicketType | null
  isDefault: boolean
  createdAt: number
  updatedAt: number
}

export interface PipelineStage {
  id: string
  pipelineId: string
  ordinal: number
  name: string
  kind: StageKind
  agentId: string | null
  promptTemplate: string | null
  toolsets: string[] | null
  effort: string | null
  patrolCron: string | null
  patrolEnabled: boolean
  patrolTimezone: string
  quietHoursStart: number | null
  quietHoursEnd: number | null
  maxRunsPerDay: number
  timeoutSec: number
  maxRetries: number
  circuitBreakerThreshold: number
  onSuccess: OnSuccessAction
  onFailure: OnFailureAction
  autoClose: boolean
  entryCondition: string | null
  exitChecklist: string | null
  requireHumanAck: boolean
  createdAt: number
  updatedAt: number
}

export interface TicketRun {
  id: string
  ticketId: string
  stageId: string
  agentId: string | null
  trigger: RunTrigger
  sessionKey: string | null
  status: RunStatus
  skipReason: RunSkipReason | null
  leaseOwner: string | null
  leaseExpiresAt: number | null
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
  summary: string | null
  outputMd: string | null
  error: string | null
  createdAt: number
}

export interface TicketRelation {
  id: string
  fromTicketId: string
  toTicketId: string
  kind: RelationKind
  createdAt: number
}

export interface TicketComment {
  id: string
  ticketId: string
  authorKind: AuthorKind
  author: string
  body: string
  runId: string | null
  createdAt: number
}

export interface TicketActivity {
  id: string
  ticketId: string
  actor: Actor
  actorId: string
  action: string
  field: string | null
  fromValue: string | null
  toValue: string | null
  createdAt: number
}

export interface BoardColumn {
  stage: PipelineStage
  tickets: Ticket[]
}

export interface BoardSnapshot {
  project: Project
  pipeline: Pipeline
  ticketType: TicketType
  columns: BoardColumn[]
  inbox: Ticket[]
}

export interface BoardAgent {
  id: string
  name: string
  model?: string
  description?: string
}

export interface TicketListQuery {
  projectId?: string
  status?: string
  type?: string
  priority?: string
  assignee?: string
  stageId?: string
  label?: string
  q?: string
  limit?: number
  offset?: number
}

export interface TicketCreateInput {
  projectId: string
  type: TicketType
  title: string
  body?: string
  priority?: TicketPriority
  severity?: TicketSeverity | null
  labels?: string[]
  assignee?: string | null
  reporter?: string
  source?: TicketSource
  originSessionKey?: string | null
  dueDate?: number | null
  startDate?: number | null
  pipelineId?: string | null
  stageId?: string | null
}

export interface TicketPatchInput {
  expectedVersion: number
  title?: string
  body?: string
  priority?: TicketPriority
  severity?: TicketSeverity | null
  labels?: string[]
  assignee?: string | null
  dueDate?: number | null
  startDate?: number | null
  blockedReason?: string | null
}

export interface ListPage<T> {
  items: T[]
  total: number
}

export interface TaskboardSettings {
  maxConcurrentRuns: number
  maxRunsPerDay: number
  maxCostPerDayUsd: number | null
  quietHoursStart: number
  quietHoursEnd: number
  circuitBreakerThreshold: number
  maxStageLoops: number
  maxRunsPerTick: number
  patrolPaused: boolean
}

export interface TaskboardUsage {
  runsToday: number
  costTodayUsd: number
  activeRuns: number
}

export type TaskboardSettingsSnapshot = TaskboardSettings & {
  usage: TaskboardUsage
}

export type TimelineItem =
  | { kind: 'activity'; createdAt: number; activity: TicketActivity }
  | { kind: 'run'; createdAt: number; run: TicketRun }
  | { kind: 'comment'; createdAt: number; comment: TicketComment }

export interface TicketDetail {
  ticket: Ticket
  pipeline?: Pipeline | null
  stage?: PipelineStage | null
}

// ── 错误码映射 ─────────────────────────────────────────────────────────────

function extractBodyCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const rec = body as Record<string, unknown>
  if (typeof rec.code === 'string') return rec.code
  const err = rec.error
  if (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code
  }
  return undefined
}

export function boardErrorCode(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined
  return err.code ?? extractBodyCode(err.body)
}

export function isVersionConflict(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false
  return err.status === 409 || boardErrorCode(err) === 'version_conflict'
}

export function isLeaseHeld(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false
  return err.status === 423 || boardErrorCode(err) === 'lease_held'
}

export function isForbidden(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false
  return err.status === 403 || boardErrorCode(err) === 'forbidden'
}

export function isConcurrencyFull(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false
  return err.status === 429 || boardErrorCode(err) === 'concurrency_full'
}

/**
 * 把 409 / 423 / 403 / 429 收成可读中文；其余走 `apiErrorMessage`。
 * 上层 toast 只吃这一处，不要自己再翻一遍 status。
 */
export function taskboardErrorMessage(err: unknown, fallback: string): string {
  if (isVersionConflict(err)) return '单据已被其他人更新，已刷新最新内容'
  if (isLeaseHeld(err)) return '该单据正在执行中，请稍后再试'
  if (isForbidden(err)) return '当前身份无权执行此操作'
  if (isConcurrencyFull(err)) return '巡检并发已满，请稍后再试'
  return apiErrorMessage(err, fallback)
}

// ── 展示辅助 ───────────────────────────────────────────────────────────────

export type TicketTypeTone = 'danger' | 'info' | 'accent' | 'neutral'

export const TICKET_TYPE_TONE: Record<TicketType, TicketTypeTone> = {
  bug: 'danger',
  feature: 'info',
  spike: 'accent',
  chore: 'neutral',
}

export const TICKET_PRIORITY_TONE: Record<TicketPriority, TicketTypeTone | 'warning'> = {
  P0: 'danger',
  P1: 'warning',
  P2: 'info',
  P3: 'neutral',
}

export function assigneeLabel(assignee: string | null): string | null {
  if (!assignee) return null
  if (assignee.startsWith('agent:')) return assignee.slice('agent:'.length)
  if (assignee.startsWith('user:')) return assignee.slice('user:'.length)
  return assignee
}

export function latestRunHint(
  status: TicketStatus,
  latestRunStatus?: RunStatus | null,
): 'running' | 'failed' | null {
  if (latestRunStatus === 'running' || status === 'running') return 'running'
  if (latestRunStatus === 'failed' || latestRunStatus === 'timeout') return 'failed'
  return null
}

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  timeout: '超时',
  skipped: '已跳过',
}

export const RUN_TRIGGER_LABEL: Record<RunTrigger, string> = {
  patrol: '定时巡检',
  manual: '手动巡检',
  transition: '状态转移',
  webhook: '外部触发',
  retry: '重试',
}

export const RUN_SKIP_REASON_LABEL: Record<RunSkipReason, string> = {
  blocked_by_dependency: '被依赖单据挡住',
  daily_quota: '已达每日巡检上限',
  outside_window: '当前处于静默时段',
  lease_held: '该单据正在执行中',
  entry_condition: '未满足进入条件',
  concurrency_full: '巡检并发已满',
  budget_exhausted: '今日成本预算已用尽',
  circuit_open: '连续失败已熔断',
  loop_guard: '同阶段循环次数过多',
  patrol_disabled: '巡检已暂停',
  idle_backoff: '空转降频中',
}

const ACTIVITY_ACTION_LABEL: Record<string, string> = {
  ticket_created: '创建了单据',
  status_changed: '变更了状态',
  stage_advanced: '推进了阶段',
  field_updated: '更新了字段',
  relation_added: '添加了关联',
}

/** 网页对话 sessionKey：`agent:<agentId>:webchat:dm:<peerId>`，peerId = 侧栏 Session.id。 */
const WEBCHAT_SESSION_KEY = /^agent:[^:]+:webchat:dm:([A-Za-z0-9_-]{8,50})$/
const CLIENT_SESSION_ID = /^[A-Za-z0-9_-]{8,50}$/

/**
 * 从单据 `originSessionKey` 抽出侧栏可用的 Session.id。
 * 抽不出（巡检 key、带冒号的裸 key、非法形状）一律返回 null，调用方不得把原 key 当 id。
 */
export function sessionIdFromOriginKey(originSessionKey: string | null | undefined): string | null {
  if (!originSessionKey) return null
  const web = WEBCHAT_SESSION_KEY.exec(originSessionKey)
  if (web) return web[1]
  if (!originSessionKey.includes(':') && CLIENT_SESSION_ID.test(originSessionKey)) {
    return originSessionKey
  }
  return null
}

/**
 * 在侧栏会话列表里按 id 对账。映射不到就返回 null，禁止硬推 `/s/agent:…`。
 */
export function resolveOriginSessionId(
  originSessionKey: string | null | undefined,
  sessionIds: readonly string[],
): string | null {
  const id = sessionIdFromOriginKey(originSessionKey)
  if (!id || id.includes(':')) return null
  return sessionIds.includes(id) ? id : null
}

export function sortTimelineDesc(items: TimelineItem[]): TimelineItem[] {
  return [...items].sort((a, b) => b.createdAt - a.createdAt || b.kind.localeCompare(a.kind))
}

export function mergeTimelineSources(input: {
  activities?: TicketActivity[]
  runs?: TicketRun[]
  comments?: TicketComment[]
}): TimelineItem[] {
  const items: TimelineItem[] = [
    ...(input.activities ?? []).map((activity) => ({
      kind: 'activity' as const,
      createdAt: activity.createdAt,
      activity,
    })),
    ...(input.runs ?? []).map((run) => ({ kind: 'run' as const, createdAt: run.createdAt, run })),
    ...(input.comments ?? []).map((comment) => ({
      kind: 'comment' as const,
      createdAt: comment.createdAt,
      comment,
    })),
  ]
  return sortTimelineDesc(items)
}

export function formatDurationMs(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec} 秒`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  if (min < 60) return rem ? `${min} 分 ${rem} 秒` : `${min} 分`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  return remMin ? `${hr} 小时 ${remMin} 分` : `${hr} 小时`
}

export function formatRunCostUsd(cost: number | null | undefined): string | null {
  if (cost == null || !Number.isFinite(cost)) return null
  return `$${cost.toFixed(4)}`
}

export function skipReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null
  if ((RUN_SKIP_REASONS as readonly string[]).includes(reason)) {
    return RUN_SKIP_REASON_LABEL[reason as RunSkipReason]
  }
  return reason
}

export function activityActionLabel(action: string): string {
  return ACTIVITY_ACTION_LABEL[action] ?? action
}

export function formatActivityLine(activity: TicketActivity): string {
  const who = assigneeLabel(activity.actorId) ?? activity.actor
  const verb = activityActionLabel(activity.action)
  if (activity.field && (activity.fromValue || activity.toValue)) {
    const from =
      activity.field === 'status' && activity.fromValue
        ? (TICKET_STATUS_LABEL[activity.fromValue as TicketStatus] ?? activity.fromValue)
        : (activity.fromValue ?? '空')
    const to =
      activity.field === 'status' && activity.toValue
        ? (TICKET_STATUS_LABEL[activity.toValue as TicketStatus] ?? activity.toValue)
        : (activity.toValue ?? '空')
    return `${who} ${verb}：${from} → ${to}`
  }
  return `${who} ${verb}`
}

export function groupTicketsByStage(tickets: Ticket[], stages: PipelineStage[]): BoardColumn[] {
  const sorted = [...stages].sort((a, b) => a.ordinal - b.ordinal)
  return sorted.map((stage) => ({
    stage,
    tickets: tickets.filter((t) => t.stageId === stage.id),
  }))
}

export function filterTickets(tickets: Ticket[], query: TicketListQuery): Ticket[] {
  return tickets.filter((t) => {
    if (query.projectId && t.projectId !== query.projectId) return false
    if (query.status) {
      const set = new Set(
        query.status
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
      if (set.size && !set.has(t.status)) return false
    }
    if (query.type) {
      const set = new Set(
        query.type
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
      if (set.size && !set.has(t.type)) return false
    }
    if (query.priority && t.priority !== query.priority) return false
    if (query.assignee && t.assignee !== query.assignee) return false
    if (query.stageId && t.stageId !== query.stageId) return false
    if (query.label && !t.labels.includes(query.label)) return false
    if (query.q) {
      const q = query.q.toLowerCase()
      const hay = `${t.title} ${t.identifier} ${t.body}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

// ── HTTP 客户端 ────────────────────────────────────────────────────────────

function qs(query?: object): string {
  if (!query) return ''
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

function boardGet<T>(a: AuthSession, path: string): Promise<T> {
  return jsonOrThrow<T>(
    callWithRefresh(a, (t) => fetch(path, { credentials: 'include', headers: bearerHeaders(t) })),
  )
}

function boardSend<T>(
  a: AuthSession,
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> {
  return jsonOrThrow<T>(
    callWithRefresh(a, (t) =>
      fetch(path, {
        method,
        credentials: 'include',
        headers: body === undefined ? bearerHeaders(t) : bearerHeaders(t, true),
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    ),
  )
}

function ticketActionPath(idOrIdent: string, action: string): string {
  return `/api/board/tickets/${encodeURIComponent(idOrIdent)}/${action}`
}

export const taskboardApi = {
  listProjects: (a: AuthSession, includeArchived = false) =>
    boardGet<{ items: Project[] }>(
      a,
      `/api/board/projects${qs({ includeArchived: includeArchived ? 'true' : undefined })}`,
    ).then((b) => b.items || []),

  getProject: (a: AuthSession, id: string) =>
    boardGet<{ project: Project }>(a, `/api/board/projects/${encodeURIComponent(id)}`).then(
      (b) => b.project,
    ),

  createProject: (
    a: AuthSession,
    body: {
      key: string
      name: string
      description?: string | null
      workspace?: string | null
      labels?: string[]
    },
  ) => boardSend<{ ok: boolean; project: Project }>(a, '/api/board/projects', 'POST', body),

  listTickets: (a: AuthSession, query?: TicketListQuery) =>
    boardGet<ListPage<Ticket>>(a, `/api/board/tickets${qs(query)}`),

  getTicket: (a: AuthSession, idOrIdent: string) =>
    boardGet<TicketDetail>(a, `/api/board/tickets/${encodeURIComponent(idOrIdent)}`).then(
      (b) => b.ticket,
    ),

  getTicketDetail: (a: AuthSession, idOrIdent: string) =>
    boardGet<TicketDetail>(
      a,
      `/api/board/tickets/${encodeURIComponent(idOrIdent)}${qs({ expand: 'pipeline,stage' })}`,
    ),

  createTicket: (a: AuthSession, body: TicketCreateInput) =>
    boardSend<{ ok: boolean; ticket: Ticket }>(a, '/api/board/tickets', 'POST', body),

  patchTicket: (a: AuthSession, idOrIdent: string, body: TicketPatchInput) =>
    boardSend<{ ok: boolean; ticket: Ticket }>(
      a,
      `/api/board/tickets/${encodeURIComponent(idOrIdent)}`,
      'PATCH',
      body,
    ),

  getProjectBoard: (a: AuthSession, projectId: string, ticketType?: TicketType) =>
    boardGet<BoardSnapshot>(
      a,
      `/api/board/projects/${encodeURIComponent(projectId)}/board${qs({ ticketType })}`,
    ),

  listAgents: (a: AuthSession) =>
    boardGet<{ items: BoardAgent[] }>(a, '/api/board/agents').then((b) => b.items || []),

  ready: (a: AuthSession, idOrIdent: string, expectedVersion: number) =>
    boardSend<{ ok: boolean; ticket: Ticket }>(a, ticketActionPath(idOrIdent, 'ready'), 'POST', {
      expectedVersion,
    }),

  claim: (a: AuthSession, idOrIdent: string, expectedVersion: number, owner: string) =>
    boardSend<{ ok: boolean; ticket: Ticket }>(a, ticketActionPath(idOrIdent, 'claim'), 'POST', {
      expectedVersion,
      owner,
    }),

  advance: (
    a: AuthSession,
    idOrIdent: string,
    body: { expectedVersion: number; summary?: string; outputMd?: string; runId?: string },
  ) =>
    boardSend<{ ok: boolean; ticket: Ticket }>(
      a,
      ticketActionPath(idOrIdent, 'advance'),
      'POST',
      body,
    ),

  block: (a: AuthSession, idOrIdent: string, expectedVersion: number, reason: string) =>
    boardSend<{ ok: boolean; ticket: Ticket }>(a, ticketActionPath(idOrIdent, 'block'), 'POST', {
      expectedVersion,
      reason,
    }),

  approve: (a: AuthSession, idOrIdent: string, expectedVersion: number, close = false) =>
    boardSend<{ ok: boolean; ticket: Ticket }>(a, ticketActionPath(idOrIdent, 'approve'), 'POST', {
      expectedVersion,
      close,
    }),

  reject: (
    a: AuthSession,
    idOrIdent: string,
    expectedVersion: number,
    reason: string,
    targetStageId?: string | null,
  ) =>
    boardSend<{ ok: boolean; ticket: Ticket }>(a, ticketActionPath(idOrIdent, 'reject'), 'POST', {
      expectedVersion,
      reason,
      targetStageId: targetStageId ?? null,
    }),

  done: (a: AuthSession, idOrIdent: string, expectedVersion: number) =>
    boardSend<{ ok: boolean; ticket: Ticket }>(a, ticketActionPath(idOrIdent, 'done'), 'POST', {
      expectedVersion,
    }),

  cancel: (a: AuthSession, idOrIdent: string, expectedVersion: number, reason?: string | null) =>
    boardSend<{ ok: boolean; ticket: Ticket }>(a, ticketActionPath(idOrIdent, 'cancel'), 'POST', {
      expectedVersion,
      reason: reason ?? null,
    }),

  comment: (
    a: AuthSession,
    idOrIdent: string,
    body: { body: string; authorKind?: AuthorKind; author?: string; runId?: string | null },
  ) =>
    boardSend<{ ok: boolean; comment: TicketComment }>(
      a,
      ticketActionPath(idOrIdent, 'comment'),
      'POST',
      body,
    ),

  patrol: (a: AuthSession, idOrIdent: string, expectedVersion: number, stageId?: string | null) =>
    boardSend<{ ok: boolean; run: TicketRun; ticket: Ticket }>(
      a,
      ticketActionPath(idOrIdent, 'patrol'),
      'POST',
      { expectedVersion, stageId: stageId ?? null },
    ),

  listRuns: (a: AuthSession, idOrIdent: string) =>
    boardGet<ListPage<TicketRun>>(a, `${ticketActionPath(idOrIdent, 'runs')}`),

  listComments: (a: AuthSession, idOrIdent: string) =>
    boardGet<{ items: TicketComment[] }>(a, ticketActionPath(idOrIdent, 'comments')).then(
      (b) => b.items || [],
    ),

  listActivity: (a: AuthSession, idOrIdent: string) =>
    boardGet<{ items: TicketActivity[] }>(a, ticketActionPath(idOrIdent, 'activity')).then(
      (b) => b.items || [],
    ),

  listTimeline: (a: AuthSession, idOrIdent: string) =>
    boardGet<{ items: TimelineItem[] }>(a, ticketActionPath(idOrIdent, 'timeline')).then(
      (b) => b.items || [],
    ),

  getSettings: (a: AuthSession) =>
    boardGet<TaskboardSettingsSnapshot>(a, '/api/board/settings'),

  patchSettings: (a: AuthSession, body: Partial<TaskboardSettings>) =>
    boardSend<TaskboardSettingsSnapshot & { ok: boolean }>(a, '/api/board/settings', 'PATCH', body),
}
