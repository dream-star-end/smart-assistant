// Taskboard — 领域类型契约（冻结层）。
//
// 本文件是 taskboard 子系统所有分层（db / stateMachine / http / patrol / cli / mcp）
// 共享的唯一类型来源。它只放**类型与常量**,不放任何 I/O、不 import 任何运行时依赖,
// 因此可以被纯逻辑模块和 DAO 同时安全引用。
//
// 命名冻结(不得改,理由见 notes/CORRECTIONS.md §0):
//   - 子系统名 `taskboard`,禁止用 `task`(`channel:'task'` 与 `/api/tasks` 已被旧定时
//     任务子系统占用)
//   - HTTP 前缀 `/api/board`
//   - 巡检 sessionKey 形状 `agent:<agentId>:taskboard:<ticketId>:<stageId>:<runId>`
//
// status 与 stage 是**正交**的两个维度:status 说「卡在谁那里」,stage 说「走到哪一站」。

// ── 单据类型 ────────────────────────────────────────────────────────────────

/** 单据类型。决定默认流水线,是一等公民字段(不用标签凑)。 */
export const TICKET_TYPES = ['bug', 'feature', 'spike', 'chore'] as const
export type TicketType = (typeof TICKET_TYPES)[number]

/** 类型的中文显示名(前端与 CLI 共用,避免各写一份)。 */
export const TICKET_TYPE_LABEL: Record<TicketType, string> = {
  bug: '问题单',
  feature: '需求单',
  spike: '调研单',
  chore: '杂务单',
}

// ── 状态机 ──────────────────────────────────────────────────────────────────

/**
 * 单据状态。语义是「现在卡在谁那里」:
 *   backlog       待立项  —— 人没批准,AI 不许碰
 *   ready         待执行  —— 已批准,等当前 stage 的 agent 认领
 *   running       执行中  —— 某个 run 持有 lease
 *   waiting_human 等人确认 —— AI 做完了,等人拍板(主界面第一泳道)
 *   blocked       受阻    —— 依赖未完成 / 连续失败 / agent 主动求助
 *   done          完成
 *   canceled      取消
 */
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

/** 状态的中文显示名(前端泳道标题、CLI 输出、时间线文案共用)。 */
export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  backlog: '待立项',
  ready: '待执行',
  running: '执行中',
  waiting_human: '等我确认',
  blocked: '受阻',
  done: '完成',
  canceled: '取消',
}

/** 终态:不再参与巡检调度。 */
export const TERMINAL_STATUSES: ReadonlySet<TicketStatus> = new Set<TicketStatus>([
  'done',
  'canceled',
])

/** 转移发起方。服务端据此强制权限表,越权 403(不是只写在 skill 里的君子协定)。 */
export type Actor = 'human' | 'agent' | 'system'

export const TICKET_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]

/** 仅 bug 使用。 */
export const TICKET_SEVERITIES = ['critical', 'major', 'minor', 'trivial'] as const
export type TicketSeverity = (typeof TICKET_SEVERITIES)[number]

/** 单据从哪来。 */
export const TICKET_SOURCES = ['chat', 'manual', 'webhook', 'cron', 'patrol'] as const
export type TicketSource = (typeof TICKET_SOURCES)[number]

// ── 流水线 ──────────────────────────────────────────────────────────────────

/**
 * 阶段类型:
 *   ai    —— 绑定 agent 自动干
 *   human —— 等人干(不参与巡检)
 *   gate  —— 纯条件判断,满足即自动过站,不消耗 agent
 */
export const STAGE_KINDS = ['ai', 'human', 'gate'] as const
export type StageKind = (typeof STAGE_KINDS)[number]

/** 阶段成功后的去向。 */
export const ON_SUCCESS_ACTIONS = ['advance', 'wait_human', 'stay'] as const
export type OnSuccessAction = (typeof ON_SUCCESS_ACTIONS)[number]

/** 阶段失败后的去向。 */
export const ON_FAILURE_ACTIONS = ['block', 'retry', 'wait_human'] as const
export type OnFailureAction = (typeof ON_FAILURE_ACTIONS)[number]

// ── 执行记录 ────────────────────────────────────────────────────────────────

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

/** run 被跳过的原因。用于「为什么这卡没动」的可解释性,前端直接展示。 */
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
  /** 该 stage 的 patrolEnabled 被关掉(人工关闭或熔断自动关闭)。 */
  'patrol_disabled',
  /** 连续空转触发降频,本轮不到重试点。与 outside_window 区分,便于解释「为什么变慢了」。 */
  'idle_backoff',
] as const
export type RunSkipReason = (typeof RUN_SKIP_REASONS)[number]

// ── 关系与时间线 ────────────────────────────────────────────────────────────

/** parent 单父防环;blocks 有向;related 无向去重。三者均禁止跨项目。 */
export const RELATION_KINDS = ['parent', 'blocks', 'related'] as const
export type RelationKind = (typeof RELATION_KINDS)[number]

export const AUTHOR_KINDS = ['human', 'agent', 'system'] as const
export type AuthorKind = (typeof AUTHOR_KINDS)[number]

// ── 实体 ────────────────────────────────────────────────────────────────────

export interface Project {
  id: string
  /** 大写前缀,如 OCV5。创建后冻结,identifier 用它。 */
  key: string
  name: string
  description: string | null
  /** 关联代码路径 / 远程主机,可选。 */
  workspace: string | null
  labels: string[]
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface Ticket {
  id: string
  /** 形如 `OCV5-42`。服务端生成,客户端**禁止推导**(服务端强制校验)。 */
  identifier: string
  projectId: string
  type: TicketType
  title: string
  /** Markdown。 */
  body: string
  status: TicketStatus
  /** 当前所处流水线阶段;终态或未入线时为 null。 */
  stageId: string | null
  pipelineId: string | null
  priority: TicketPriority
  /** 仅 type='bug' 有意义。 */
  severity: TicketSeverity | null
  labels: string[]
  /** `user:<id>` | `agent:<agentId>` | null。 */
  assignee: string | null
  reporter: string
  source: TicketSource
  /** 从哪个对话建的,可点回去。 */
  originSessionKey: string | null
  dueDate: number | null
  startDate: number | null
  /** 乐观锁。每次写 +1;客户端带旧值即 409。 */
  version: number
  blockedReason: string | null
  /** 同一卡在同一 stage 反复 running→ready 的次数,用于循环熔断。 */
  stageLoopCount: number
  createdAt: number
  updatedAt: number
  closedAt: number | null
}

export interface Pipeline {
  id: string
  projectId: string
  name: string
  /** 该流水线服务于哪种单据类型;null = 通用兜底。 */
  ticketType: TicketType | null
  isDefault: boolean
  createdAt: number
  updatedAt: number
}

export interface PipelineStage {
  id: string
  pipelineId: string
  /** 站序,从 0 开始,同一 pipeline 内唯一。 */
  ordinal: number
  name: string
  kind: StageKind
  /** kind='ai' 时必填。 */
  agentId: string | null
  /**
   * 提示词模板。占位符:{{ticket.identifier}} {{ticket.title}} {{ticket.body}}
   * {{last_run.summary}} {{comments}} {{stage.exit_checklist}}。
   */
  promptTemplate: string | null
  /** 该阶段允许的工具集;null = 用 agent 默认。 */
  toolsets: string[] | null
  /** 推理档位;null = 用 agent 默认。 */
  effort: string | null
  /** 5 字段 crontab,如 `*​/30 9-19 * * 1-5`。null = 不巡检。 */
  patrolCron: string | null
  patrolEnabled: boolean
  /** IANA 时区,用于解释 patrolCron 与静默时段。 */
  patrolTimezone: string
  /** 静默时段起止(0-23 小时)。落在区间内不巡检。null = 用全局默认。 */
  quietHoursStart: number | null
  quietHoursEnd: number | null
  /** 该阶段每卡每日执行上限。 */
  maxRunsPerDay: number
  /** 连续无活动超时(秒)。真实输出/工具活动会续租，不是总执行时长。 */
  timeoutSec: number
  maxRetries: number
  /** 连续失败达到该值 → 熔断(冷却后半开试探,不再永久关掉 patrolEnabled)。 */
  circuitBreakerThreshold: number
  onSuccess: OnSuccessAction
  onFailure: OnFailureAction
  /**
   * 本阶段成功后允许 agent 直接关单(`* → done`)。默认 false —— `done` 永远属于人。
   * 设计文档 §3 写「除非 stage 显式配了 auto_close」,这就是那个显式开关:不要靠
   * 「最后一站且 !requireHumanAck」去猜,那种推断在流水线被改序后会静默失效。
   */
  autoClose: boolean
  /** 准入条件表达式(如「必须有复现步骤」「必须无未完成 blocks」)。 */
  entryCondition: string | null
  /** 产出要求。写进提示词,也用于自检。 */
  exitChecklist: string | null
  /** 本阶段完成后是否必须人点确认。 */
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
  /** `agent:<agentId>:taskboard:<ticketId>:<stageId>:<runId>`,可点进去看全过程。 */
  sessionKey: string | null
  status: RunStatus
  skipReason: RunSkipReason | null
  /** 防重入租约；长 run 由 PatrolEngine 周期续租。 */
  leaseOwner: string | null
  leaseExpiresAt: number | null
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
  /** 巡检收尾从 delegate 同步抄数,缺则从 usage_log 按 sessionKey 回填;失败保持 null。 */
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
  /** agent 的结论摘要,写进卡片时间线。 */
  summary: string | null
  /** 完整产出。 */
  outputMd: string | null
  error: string | null
  createdAt: number
}

export interface TicketRelation {
  id: string
  /** 有向:from → to。related 存一条并在写入时归一化(小 id 在前)。 */
  fromTicketId: string
  toTicketId: string
  kind: RelationKind
  createdAt: number
}

export interface TicketComment {
  id: string
  ticketId: string
  authorKind: AuthorKind
  /** `user:<id>` | `agent:<agentId>` | `system`。 */
  author: string
  body: string
  /** 由哪次 run 产生;人工评论为 null。 */
  runId: string | null
  createdAt: number
}

export interface TicketActivity {
  id: string
  ticketId: string
  actor: Actor
  /** `user:<id>` | `agent:<agentId>` | `system`。 */
  actorId: string
  /** 如 `status_changed` / `stage_advanced` / `field_updated` / `relation_added`。 */
  action: string
  field: string | null
  fromValue: string | null
  toValue: string | null
  createdAt: number
}

// ── 护栏默认值 ──────────────────────────────────────────────────────────────

/**
 * 护栏默认值。全部可被 stage 或全局配置覆盖。
 * 这些数字的取值理由见 notes/CORRECTIONS.md §2。
 */
export const GUARDRAIL_DEFAULTS = {
  /** taskboard 独立并发槽。现网 delegate 全局 4 槽,必须自建计数器不与对话抢。 */
  maxConcurrentRuns: 2,
  /** 全局每日 run 上限,触顶自动暂停并通知。 */
  maxRunsPerDay: 200,
  /** 全局每日成本上限(美元);null = 不限。 */
  maxCostPerDayUsd: null as number | null,
  /** 默认静默时段(本地时区小时)。23:00–08:00 不巡检。 */
  quietHoursStart: 23,
  quietHoursEnd: 8,
  /** 同一 stage 连续失败达到该值 → 熔断(半开:冷却后试探一次)。 */
  circuitBreakerThreshold: 3,
  /**
   * 熔断冷却(毫秒)。跳闸后这段时间内不派新 run;到期允许 1 次半开试探。
   * 成功则闭合,失败则重新计时。可用环境变量
   * OPENCLAUDE_TASKBOARD_CIRCUIT_COOLDOWN_MS 覆盖。默认 10 分钟 ——
   * 与空转降频同一量级,够上游 4xx/5xx 抖过去,又不让单据隔夜假死。
   */
  circuitCooldownMs: 10 * 60 * 1000,
  /** 同一卡在同一 stage 反复循环超过该值 → 强制 blocked。 */
  maxStageLoops: 5,
  /** 单轮 tick 最多启动的 run 数。 */
  maxRunsPerTick: 2,
  /** tick 间隔(毫秒)。 */
  tickIntervalMs: 60_000,
  /** lease 时长(毫秒)。活跃 run 会在到期前续租；进程崩溃后自然回收。 */
  leaseTtlMs: 50 * 60 * 1000,
  /** lease 续租间隔(毫秒)。 */
  leaseRenewIntervalMs: 10 * 60 * 1000,
  /** 单次 run 默认连续无活动超时(秒)。 */
  defaultTimeoutSec: 40 * 60,
  /** 某 stage 连续空转轮数达到该值 → 降频。 */
  idleBackoffAfterTicks: 10,
  /** 降频后的巡检间隔(毫秒)。 */
  idleBackoffIntervalMs: 10 * 60 * 1000,
} as const

// ── sessionKey ──────────────────────────────────────────────────────────────

/**
 * 巡检会话 sessionKey。**必须**是 `agent:<agentId>:taskboard:...` 形状:
 * 现网驱逐与 live 列表逻辑假定 `agent:<agentId>:<kind>:...`
 * (server.ts:3805、sessionManager.ts:6008)。用裸 `taskboard:...` 会让巡检会话被当成
 * 聊天会话长留内存(LRU 不驱逐)且 live list 滤不掉。
 */
export function buildPatrolSessionKey(
  agentId: string,
  ticketId: string,
  stageId: string,
  runId: string,
): string {
  return `agent:${agentId}:taskboard:${ticketId}:${stageId}:${runId}`
}

/** 判断一个 sessionKey 是否由 taskboard 巡检产生(用于从 live 列表里排除)。 */
export function isPatrolSessionKey(sessionKey: string): boolean {
  return /^agent:[^:]+:taskboard:/.test(sessionKey)
}
