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

export const STAGE_KIND_LABEL: Record<StageKind, string> = {
  ai: 'AI 阶段',
  human: '人工阶段',
  gate: '闸门',
}

export const ON_SUCCESS_ACTIONS = ['advance', 'wait_human', 'stay'] as const
export type OnSuccessAction = (typeof ON_SUCCESS_ACTIONS)[number]

export const ON_SUCCESS_LABEL: Record<OnSuccessAction, string> = {
  advance: '进入下一站',
  wait_human: '转待我确认',
  stay: '留在本站',
}

export const ON_FAILURE_ACTIONS = ['block', 'retry', 'wait_human'] as const
export type OnFailureAction = (typeof ON_FAILURE_ACTIONS)[number]

export const ON_FAILURE_LABEL: Record<OnFailureAction, string> = {
  block: '标记受阻',
  retry: '重试',
  wait_human: '转待我确认',
}

export const STAGE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type StageEffort = (typeof STAGE_EFFORTS)[number]

export const STAGE_EFFORT_LABEL: Record<StageEffort, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
}

/** 与 gateway `DELEGATE_IDLE_TIMEOUT_MAX_SEC` / stage 校验锁步。 */
export const DELEGATE_IDLE_TIMEOUT_MAX_SEC = 45 * 60

/** 与 gateway `PROJECT_KEY_RE` 锁步：2–12 位大写字母或数字，且以字母开头。 */
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,11}$/

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
  workspaceSpec?: { kind: 'default' | 'isolated' | 'container_path'; path?: string } | null
  contextVersion?: number
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
  /** board 接口装饰；列表接口可能没有。合法落点一律以它为准，前端不重算。 */
  allowedMoves?: AllowedMove[]
}

export const MOVE_ACTIONS = [
  'promote',
  'promote_at_stage',
  'ack_advance',
  'skip_forward',
  'send_back',
  'return_to_backlog',
  'reopen',
] as const
export type MoveAction = (typeof MOVE_ACTIONS)[number]

export interface AllowedMove {
  toStageId: string | null
  action: MoveAction
  label: string
  requiresReason: boolean
  requiresConfirm: boolean
  warning?: string
  skippedStages?: Array<{ id: string; name: string; kind: StageKind }>
  abandonedStage?: { id: string; name: string; kind: StageKind }
}

export interface TicketMoveInput {
  toStageId: string | null
  expectedVersion: number
  reason?: string
  confirmSkippedStages?: boolean
  cancelRunningRun?: boolean
}

export interface TicketMoveInfo {
  action: MoveAction | 'noop'
  label: string
  fromStageId: string | null
  toStageId: string | null
  skippedStages?: Array<{ id: string; name: string; kind: StageKind }>
  abandonedStage?: { id: string; name: string; kind: StageKind } | null
  commentId?: string | null
}

export interface TicketMoveResult {
  ticket: Ticket
  move: TicketMoveInfo
}

export interface MoveBlocker {
  id: string
  identifier: string
  title: string
  status: TicketStatus
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
  /** null = 沿用 agent 默认模型。 */
  model: string | null
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
  /** 补价因缺 agent 倍率字段而 fail-closed。旧响应可缺席。 */
  costImprecise?: boolean | null
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
  /** 当前 ticketType 的积压票，不在 columns 里。 */
  backlog: { tickets: Ticket[] }
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
  /** 省略 = 服务端默认 backlog；human 可传 ready 直接开工。 */
  status?: 'backlog' | 'ready'
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

export interface ProjectCreateInput {
  key: string
  name: string
  description?: string | null
  workspace?: string | null
  workspaceSpec?: { kind: 'default' | 'isolated' | 'container_path'; path?: string } | null
  labels?: string[]
  /** 省略 = 种四条内置线；`[]` = 不种；非空 = 按 id 套用。 */
  templateIds?: string[]
}

export interface ProjectPatchInput {
  name?: string
  description?: string | null
  workspace?: string | null
  workspaceSpec?: { kind: 'default' | 'isolated' | 'container_path'; path?: string } | null
  labels?: string[]
  archivedAt?: number | null
}

export interface PipelineCreateInput {
  projectId: string
  name: string
  ticketType?: TicketType | null
  isDefault?: boolean
}

export interface PipelinePatchInput {
  name?: string
  ticketType?: TicketType | null
  isDefault?: boolean
}

export interface StageCreateInput {
  name: string
  kind: StageKind
  ordinal?: number
  agentId?: string | null
  model?: string | null
  promptTemplate?: string | null
  toolsets?: string[] | null
  effort?: string | null
  patrolCron?: string | null
  patrolEnabled?: boolean
  patrolTimezone?: string
  quietHoursStart?: number | null
  quietHoursEnd?: number | null
  maxRunsPerDay?: number
  timeoutSec?: number
  maxRetries?: number
  circuitBreakerThreshold?: number
  onSuccess?: OnSuccessAction
  onFailure?: OnFailureAction
  entryCondition?: string | null
  exitChecklist?: string | null
  requireHumanAck?: boolean
  autoClose?: boolean
}

export type StagePatchInput = Partial<StageCreateInput>

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
  /** 今日 token>0 且 cost 为 0/null 的 run 数。美元顶开启时用于失败关闭。 */
  unpricedRunsToday?: number
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

// ── M4：成本 / 模板 / 周报（与 gateway 响应锁步）────────────────────────────

export const COST_GROUP_BY = ['day', 'project', 'ticket', 'stage'] as const
export type CostGroupBy = (typeof COST_GROUP_BY)[number]

export const COST_GROUP_BY_LABEL: Record<CostGroupBy, string> = {
  day: '按日',
  project: '按项目',
  ticket: '按单据',
  stage: '按阶段',
}

export const COST_COVERAGES = ['full', 'partial', 'unpriced_only', 'none'] as const
export type CostCoverage = (typeof COST_COVERAGES)[number]

export interface CostSlice {
  runCount: number
  tokensIn: number
  tokensOut: number
  costUsd: number
}

export interface CostTotals extends CostSlice {
  priced: CostSlice
  unpriced: CostSlice
  unknownRunCount: number
  coverage: CostCoverage
}

export interface CostBucket extends CostTotals {
  key: string
  label: string
  projectId?: string
  ticketId?: string
  stageId?: string
  identifier?: string
}

export interface CostStatsQuery {
  from?: string
  to?: string
  projectId?: string
  ticketId?: string
  stageId?: string
  groupBy?: CostGroupBy
  timeZone?: string
}

export interface CostStatsResult {
  from: string
  to: string
  timeZone: string
  groupBy: CostGroupBy | null
  totals: CostTotals
  buckets: CostBucket[]
}

export interface WeeklyPeriod {
  week: string
  fromYmd: string
  toYmd: string
  fromMs: number
  toMs: number
  timeZone: string
}

export interface TicketFlow {
  created: number
  completed: number
  canceled: number
  waitingHuman: number
  blockedNow: number
  statusTransitions: { from: string; to: string; count: number }[]
}

export interface StageSpend {
  stageId: string
  stageName: string
  runCount: number
  succeeded: number
  failed: number
  timeout: number
  totalDurationMs: number
  avgDurationMs: number
}

export interface BlockedItem {
  identifier: string
  title: string
  blockedReason: string | null
}

export interface FailedRunItem {
  runId: string
  identifier: string
  stageName: string | null
  status: string
  error: string | null
  createdAt: number
}

export interface WeeklyReport {
  period: WeeklyPeriod
  projectId: string | null
  flow: TicketFlow
  stages: StageSpend[]
  cost: CostTotals
  blocked: BlockedItem[]
  failedRuns: FailedRunItem[]
}

export interface WeeklyReportQuery {
  week?: string
  from?: string
  to?: string
  projectId?: string
}

export const TEMPLATE_SOURCES = ['builtin', 'custom'] as const
export type TemplateSource = (typeof TEMPLATE_SOURCES)[number]

export interface TemplateStageSnapshot {
  ordinal: number
  name: string
  kind: StageKind
  agentId: string | null
  model: string | null
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
  entryCondition: string | null
  exitChecklist: string | null
  requireHumanAck: boolean
  autoClose: boolean
}

export interface PipelineTemplate {
  id: string
  slug: string
  name: string
  ticketType: TicketType | null
  source: TemplateSource
  stages: TemplateStageSnapshot[]
  createdAt: number
  updatedAt: number
}

export const BUILTIN_TEMPLATE_OPTIONS: ReadonlyArray<{
  id: string
  name: string
  ticketType: TicketType
}> = [
  { id: 'builtin:bug', name: '问题单默认流水线', ticketType: 'bug' },
  { id: 'builtin:feature', name: '需求单默认流水线', ticketType: 'feature' },
  { id: 'builtin:spike', name: '调研单默认流水线', ticketType: 'spike' },
  { id: 'builtin:chore', name: '杂务单默认流水线', ticketType: 'chore' },
]

export interface ApplyTemplateResult {
  ok: boolean
  template: PipelineTemplate
  pipeline: Pipeline | null
  createdPipelines: number
  createdStages: number
  skippedPipelines: number
  skippedStages: number
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
  const code = boardErrorCode(err)
  // /move 的 409 还可能是 running_run_active，有明确 code 时只认 version_conflict。
  if (code) return code === 'version_conflict'
  return err.status === 409
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

/** gateway `/move` 信封 `{ error, code, detail? }` 的 detail。 */
export function boardErrorDetail(err: unknown): Record<string, unknown> | undefined {
  if (!(err instanceof ApiError) || !err.body || typeof err.body !== 'object') return undefined
  const rec = err.body as Record<string, unknown>
  if (rec.detail && typeof rec.detail === 'object' && !Array.isArray(rec.detail)) {
    return rec.detail as Record<string, unknown>
  }
  return undefined
}

export function boardErrorWhy(err: unknown): string | undefined {
  const detail = boardErrorDetail(err)
  if (typeof detail?.why === 'string' && detail.why.trim()) return detail.why
  if (err instanceof ApiError && err.message.trim()) return err.message
  return undefined
}

const VALIDATION_ZH: Array<{ test: (msg: string) => boolean; zh: string }> = [
  { test: (m) => /project key already exists/i.test(m), zh: '项目前缀已被占用' },
  {
    test: (m) => /invalid project key/i.test(m),
    zh: '项目前缀须为 2–12 位大写字母或数字，且以字母开头',
  },
  { test: (m) => /key and name are required/i.test(m), zh: '请填写项目前缀和名称' },
  { test: (m) => /projectId and name are required/i.test(m), zh: '请填写流水线名称' },
  { test: (m) => /projectId is required/i.test(m), zh: '请先选择项目' },
  { test: (m) => /name and kind are required/i.test(m), zh: '请填写阶段名称和类型' },
  { test: (m) => /agentId is required for ai stages/i.test(m), zh: 'AI 阶段必须绑定 agent' },
  {
    test: (m) => /promptTemplate is required for ai stages/i.test(m),
    zh: 'AI 阶段必须填写提示词模板',
  },
  {
    test: (m) => /hidden-reviewer cannot be bound/i.test(m),
    zh: '不能把阶段绑定到隐藏 agent',
  },
  {
    test: (m) => /human stages cannot enable patrol/i.test(m),
    zh: '人工阶段不能开启巡检',
  },
  {
    test: (m) => /timeoutSec must be/i.test(m),
    zh: `无活动超时不能超过 ${DELEGATE_IDLE_TIMEOUT_MAX_SEC} 秒（45 分钟）`,
  },
  { test: (m) => /invalid kind/i.test(m), zh: '阶段类型只能是 AI、人工或闸门' },
  { test: (m) => /model not available/i.test(m), zh: '该模型当前不可用，请换一个或留空用 agent 默认' },
  { test: (m) => /model catalog unavailable/i.test(m), zh: '模型目录暂时不可用，稍后再改模型覆盖' },
  { test: (m) => /invalid ticketType/i.test(m), zh: '单据类型无效' },
  { test: (m) => /cannot delete builtin template/i.test(m), zh: '内置模板不能删除' },
  {
    test: (m) => /pipeline has no stages to snapshot/i.test(m),
    zh: '这条流水线还没有阶段，无法存为模板',
  },
  {
    test: (m) => /slug must not start with builtin/i.test(m),
    zh: '自定义模板标识不能以 builtin 开头',
  },
  { test: (m) => /template slug .+ already exists/i.test(m), zh: '该模板标识已被占用' },
]

function rawErrorText(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return ''
}

/**
 * 把 409 / 423 / 403 / 429 / 常见校验英文收成可读中文；其余走 `apiErrorMessage`。
 * 上层 toast 只吃这一处，不要自己再翻一遍 status。
 */
export function taskboardErrorMessage(err: unknown, fallback: string): string {
  const raw = rawErrorText(err)
  for (const row of VALIDATION_ZH) {
    if (row.test(raw)) return row.zh
  }
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

/** 千分位，固定英文逗号，避免测试/界面随运行环境 locale 抖动。 */
export function formatCount(n: number): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.round(Math.abs(n))
  return sign + String(abs).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function formatTokenUsage(tokensIn: number, tokensOut: number): string {
  const total = tokensIn + tokensOut
  return `${formatCount(total)} token（入 ${formatCount(tokensIn)} / 出 ${formatCount(tokensOut)}）`
}

/** partial 覆盖时钉死的提示原文。 */
export function formatUnpricedNote(unpriced: CostSlice): string {
  const tokens = unpriced.tokensIn + unpriced.tokensOut
  return `另有 ${formatCount(unpriced.runCount)} 次共 ${formatCount(tokens)} token 无单价，未计入`
}

/** unpriced_only 覆盖时钉死的提示原文。绝不能写成 $0。 */
export const UNPRICED_ONLY_COPY = '本区间全部无单价，仅有 token 数据'

/**
 * 美元行文案。永远不要在 unpriced_only 下返回 $0。
 * full 直接给金额；partial 金额后附缺单价说明；none 返回 null。
 */
export function formatCostMoneyLine(totals: CostTotals): string | null {
  if (totals.coverage === 'none') return null
  if (totals.coverage === 'unpriced_only') return UNPRICED_ONLY_COPY
  const amount = formatRunCostUsd(totals.costUsd) ?? '$0.0000'
  if (totals.coverage === 'partial') {
    return `${amount}（${formatUnpricedNote(totals.unpriced)}）`
  }
  return amount
}

export function emptyCostSlice(): CostSlice {
  return { runCount: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 }
}

/** 列表默认只看在途，终态要显式筛选。 */
export const ACTIVE_LIST_STATUSES = 'backlog,ready,running,waiting_human,blocked'

export const LAST_PROJECT_STORAGE_KEY = 'oc-taskboard.lastProjectId'

/** 冒烟/E2E 项目不当默认落点。 */
export const SMOKE_PROJECT_KEYS = new Set(['E2E'])

export function readLastProjectId(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_STORAGE_KEY)
  } catch {
    return null
  }
}

export function writeLastProjectId(id: string): void {
  try {
    localStorage.setItem(LAST_PROJECT_STORAGE_KEY, id)
  } catch {
    /* private mode / 无 storage */
  }
}

export function pickInitialProject<T extends { id: string; key: string; archivedAt: number | null }>(
  projects: T[],
  rememberedId: string | null,
): T | undefined {
  const live = projects.filter((p) => !p.archivedAt)
  if (rememberedId) {
    const hit = live.find((p) => p.id === rememberedId)
    if (hit) return hit
  }
  return live.find((p) => !SMOKE_PROJECT_KEYS.has(p.key)) ?? live[0]
}

/** 看板阶段列里的在办状态。积压/待确认/终态走自己的桶。 */
export function isStageColumnStatus(status: string): boolean {
  return (
    status !== 'backlog' &&
    status !== 'waiting_human' &&
    status !== 'done' &&
    status !== 'canceled'
  )
}

export function stageColumnTickets<T extends { status: string }>(tickets: T[]): T[] {
  return tickets.filter((t) => isStageColumnStatus(t.status))
}

/** inbox 与阶段列里的 waiting_human 并集，避免旧 API 只停在 AI 列时人找不到。 */
export function collectInboxTickets<T extends { id: string; status: string }>(board: {
  inbox?: T[]
  columns?: Array<{ tickets: T[] }>
}): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  const push = (ticket: T) => {
    if (ticket.status !== 'waiting_human' || seen.has(ticket.id)) return
    seen.add(ticket.id)
    out.push(ticket)
  }
  for (const ticket of board.inbox ?? []) push(ticket)
  for (const col of board.columns ?? []) {
    for (const ticket of col.tickets) push(ticket)
  }
  return out
}

export function emptyCostTotals(): CostTotals {
  return {
    runCount: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    priced: emptyCostSlice(),
    unpriced: emptyCostSlice(),
    unknownRunCount: 0,
    coverage: 'none',
  }
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
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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

  createProject: (a: AuthSession, body: ProjectCreateInput) =>
    boardSend<{ ok: boolean; project: Project }>(a, '/api/board/projects', 'POST', body),

  patchProject: (a: AuthSession, id: string, body: ProjectPatchInput) =>
    boardSend<{ ok: boolean; project: Project }>(
      a,
      `/api/board/projects/${encodeURIComponent(id)}`,
      'PATCH',
      body,
    ),

  archiveProject: (a: AuthSession, id: string) =>
    boardSend<{ ok: boolean; project: Project }>(
      a,
      `/api/board/projects/${encodeURIComponent(id)}`,
      'DELETE',
    ),

  listPipelines: (a: AuthSession, projectId: string) =>
    boardGet<{ items: Pipeline[] }>(a, `/api/board/pipelines${qs({ projectId })}`).then(
      (b) => b.items || [],
    ),

  getPipeline: (a: AuthSession, id: string) =>
    boardGet<{ pipeline: Pipeline; stages: PipelineStage[] }>(
      a,
      `/api/board/pipelines/${encodeURIComponent(id)}`,
    ),

  createPipeline: (a: AuthSession, body: PipelineCreateInput) =>
    boardSend<{ ok: boolean; pipeline: Pipeline }>(a, '/api/board/pipelines', 'POST', body),

  patchPipeline: (a: AuthSession, id: string, body: PipelinePatchInput) =>
    boardSend<{ ok: boolean; pipeline: Pipeline }>(
      a,
      `/api/board/pipelines/${encodeURIComponent(id)}`,
      'PATCH',
      body,
    ),

  listStages: (a: AuthSession, pipelineId: string) =>
    boardGet<{ items: PipelineStage[] }>(
      a,
      `/api/board/pipelines/${encodeURIComponent(pipelineId)}/stages`,
    ).then((b) => b.items || []),

  createStage: (a: AuthSession, pipelineId: string, body: StageCreateInput) =>
    boardSend<{ ok: boolean; stage: PipelineStage }>(
      a,
      `/api/board/pipelines/${encodeURIComponent(pipelineId)}/stages`,
      'POST',
      body,
    ),

  getStage: (a: AuthSession, id: string) =>
    boardGet<{ stage: PipelineStage }>(a, `/api/board/stages/${encodeURIComponent(id)}`).then(
      (b) => b.stage,
    ),

  patchStage: (a: AuthSession, id: string, body: StagePatchInput) =>
    boardSend<{ ok: boolean; stage: PipelineStage }>(
      a,
      `/api/board/stages/${encodeURIComponent(id)}`,
      'PATCH',
      body,
    ),

  reorderStages: (a: AuthSession, pipelineId: string, orderedIds: string[]) =>
    boardSend<{ ok: boolean; items: PipelineStage[] }>(
      a,
      `/api/board/pipelines/${encodeURIComponent(pipelineId)}/reorder`,
      'PUT',
      { orderedIds },
    ),

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

  moveTicket: (a: AuthSession, idOrIdent: string, body: TicketMoveInput) =>
    boardSend<TicketMoveResult>(a, ticketActionPath(idOrIdent, 'move'), 'POST', body),

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

  getSettings: (a: AuthSession) => boardGet<TaskboardSettingsSnapshot>(a, '/api/board/settings'),

  patchSettings: (a: AuthSession, body: Partial<TaskboardSettings>) =>
    boardSend<TaskboardSettingsSnapshot & { ok: boolean }>(a, '/api/board/settings', 'PATCH', body),

  getCostStats: (a: AuthSession, query?: CostStatsQuery) =>
    boardGet<CostStatsResult>(a, `/api/board/stats/cost${qs(query)}`),

  getWeeklyReport: (a: AuthSession, query?: WeeklyReportQuery) =>
    boardGet<{ report: WeeklyReport }>(a, `/api/board/reports/weekly${qs(query)}`).then(
      (b) => b.report,
    ),

  listTemplates: (a: AuthSession) =>
    boardGet<{ items: PipelineTemplate[] }>(a, '/api/board/templates').then((b) => b.items || []),

  getTemplate: (a: AuthSession, id: string) =>
    boardGet<{ template: PipelineTemplate }>(
      a,
      `/api/board/templates/${encodeURIComponent(id)}`,
    ).then((b) => b.template),

  createTemplate: (a: AuthSession, body: { pipelineId: string; name?: string; slug?: string }) =>
    boardSend<{ ok: boolean; template: PipelineTemplate }>(a, '/api/board/templates', 'POST', body),

  deleteTemplate: (a: AuthSession, id: string) =>
    boardSend<{ ok: boolean }>(a, `/api/board/templates/${encodeURIComponent(id)}`, 'DELETE'),

  applyTemplate: (a: AuthSession, id: string, body: { projectId: string; asDefault?: boolean }) =>
    boardSend<ApplyTemplateResult>(
      a,
      `/api/board/templates/${encodeURIComponent(id)}/apply`,
      'POST',
      body,
    ),

  listProjectMemories: (a: AuthSession, projectId: string, status?: string) =>
    boardGet<{
      projectId: string
      official: ProjectMemoryItem[]
      candidates: ProjectMemoryItem[]
    }>(
      a,
      `/api/board/projects/${encodeURIComponent(projectId)}/memories${qs({ status })}`,
    ),

  createProjectMemory: (
    a: AuthSession,
    projectId: string,
    body: { slug: string; content: string; supersedes?: string },
  ) =>
    boardSend<{ ok: boolean; candidate: ProjectMemoryItem }>(
      a,
      `/api/board/projects/${encodeURIComponent(projectId)}/memories`,
      'POST',
      body,
    ),

  promoteProjectMemory: (
    a: AuthSession,
    projectId: string,
    candidateId: string,
    expectedVersion: number,
  ) =>
    boardSend<{ ok: boolean; official: ProjectMemoryItem; idempotent?: boolean }>(
      a,
      `/api/board/projects/${encodeURIComponent(projectId)}/memories/${encodeURIComponent(candidateId)}/promote`,
      'POST',
      { expectedVersion },
    ),

  rejectProjectMemory: (
    a: AuthSession,
    projectId: string,
    candidateId: string,
    expectedVersion: number,
  ) =>
    boardSend<{ ok: boolean; candidate: ProjectMemoryItem; idempotent?: boolean }>(
      a,
      `/api/board/projects/${encodeURIComponent(projectId)}/memories/${encodeURIComponent(candidateId)}/reject`,
      'POST',
      { expectedVersion },
    ),

  deprecateProjectMemory: (
    a: AuthSession,
    projectId: string,
    slug: string,
    expectedVersion: number,
  ) =>
    boardSend<{ ok: boolean; official: ProjectMemoryItem; idempotent?: boolean }>(
      a,
      `/api/board/projects/${encodeURIComponent(projectId)}/memories/${encodeURIComponent(slug)}/deprecate`,
      'POST',
      { expectedVersion },
    ),
}

export interface ProjectMemoryItem {
  id?: string
  projectId: string
  slug: string
  file?: string
  contentSha256: string
  status?: string
  version: number
  content?: string | null
  tampered?: boolean
  deprecated?: boolean
  expires?: string | null
  sourceAgent?: string | null
  sourceSession?: string | null
  sourceTicket?: string | null
  supersedes?: string | null
}
