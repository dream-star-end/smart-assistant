/**
 * 任务面板(taskboard)视觉预览场景。
 *
 * 2026-09 审计补充。原先两个场景没有包 `ProjectScopeProvider`,`useProjectScope()` 在无
 * Provider 时恒为 `all`,`TaskboardView` 只会画出「请选择一个工作项目以查看看板」的空态 ——
 * 看板 / 列表本体从未真正入镜。现在每个场景都:
 *   1. 包一层 `ProjectScopeProvider`,并在工作项目列表到位后显式 `setToken(project.id)`
 *      (等价于用户在顶栏选中项目;不能只靠 `?project=` 深链,见 `taskboard-scope-deeplink-reload`);
 *   2. 直接替换 `taskboardApi` 的方法 —— 它走裸 `fetch` 而不是 `lib/api` 的 `api` 对象,
 *      api-stub 的 Proxy 拦不到;每个场景在 render() 里重装一遍,避免同页前一个场景残留;
 *   3. 需要打开面板 / 抽屉 / 表单的场景用 `AutoClick` 在挂载后按 data-testid 顺序点开
 *      (面板都是组件内部 state,没有受控入口)。
 *
 * 场景均为静态截图;拖拽 / 菜单(Radix pointerdown)不在此覆盖。
 */
import { type ReactNode, useEffect } from 'react'
import { addDaysYmd, ymdInZone } from '../../src/components/taskboard/CostStatsView'
import { TaskboardView } from '../../src/components/taskboard/TaskboardView'
import { ProjectScopeProvider, useProjectScope } from '../../src/hooks/useProjectScope'
import { createMemoryAuthSession } from '../../src/lib/authSession'
import {
  type AllowedMove,
  type BoardSnapshot,
  type CostBucket,
  type CostStatsResult,
  type CostTotals,
  type Pipeline,
  type PipelineStage,
  type PipelineTemplate,
  type Project,
  type TaskboardSettingsSnapshot,
  type Ticket,
  type TicketActivity,
  type TicketComment,
  type TicketListQuery,
  type TicketRun,
  type TimelineItem,
  type WeeklyReport,
  filterTickets,
  taskboardApi,
} from '../../src/lib/taskboard'
import type { Scene } from './types'

const auth = createMemoryAuthSession(() => {}, 'taskboard-preview-token')
const now = Date.now()
const MIN = 60_000
const DAY = 86_400_000

// ── 假数据 ──────────────────────────────────────────────────────────────────

const project: Project = {
  id: 'preview-project',
  key: 'V5',
  name: '产品体验优化',
  description: '任务面板移动端与桌面端体验',
  workspace: null,
  workspaceSpec: { kind: 'default' },
  contextVersion: 3,
  labels: ['产品'],
  archivedAt: null,
  createdAt: now - 14 * DAY,
  updatedAt: now,
}

const archivedProject: Project = {
  id: 'preview-archived',
  key: 'OLD',
  name: '旧版迁移',
  description: null,
  workspace: null,
  labels: [],
  archivedAt: now - 30 * DAY,
  createdAt: now - 90 * DAY,
  updatedAt: now - 30 * DAY,
}

const pipeline: Pipeline = {
  id: 'preview-pipeline',
  projectId: project.id,
  name: '问题单默认线',
  ticketType: 'bug',
  isDefault: true,
  createdAt: project.createdAt,
  updatedAt: now,
}

const featurePipeline: Pipeline = {
  id: 'preview-pipeline-feature',
  projectId: project.id,
  name: '需求单默认线',
  ticketType: 'feature',
  isDefault: true,
  createdAt: project.createdAt,
  updatedAt: now,
}

function stage(
  pipelineId: string,
  ordinal: number,
  id: string,
  name: string,
  kind: PipelineStage['kind'],
  over: Partial<PipelineStage> = {},
): PipelineStage {
  return {
    id,
    pipelineId,
    ordinal,
    name,
    kind,
    agentId: null,
    model: null,
    promptTemplate: null,
    toolsets: null,
    effort: null,
    patrolCron: null,
    patrolEnabled: false,
    patrolTimezone: 'Asia/Shanghai',
    quietHoursStart: null,
    quietHoursEnd: null,
    maxRunsPerDay: 20,
    timeoutSec: 2400,
    maxRetries: 1,
    circuitBreakerThreshold: 3,
    onSuccess: 'advance',
    onFailure: 'block',
    autoClose: false,
    entryCondition: null,
    exitChecklist: null,
    requireHumanAck: false,
    createdAt: project.createdAt,
    updatedAt: now,
    ...over,
  }
}

const stages: PipelineStage[] = [
  stage(pipeline.id, 0, 'stage-clarify', '需求澄清', 'human'),
  stage(pipeline.id, 1, 'stage-build', '开发实现', 'ai', {
    agentId: 'coding-assistant',
    promptTemplate:
      '你是 {{ticket.identifier}} 的实现者。\n目标:{{ticket.title}}\n\n{{ticket.body}}\n\n上一轮:{{last_run.summary}}',
    toolsets: ['fs', 'shell'],
    effort: 'high',
    patrolCron: '*/30 9-19 * * 1-5',
    patrolEnabled: true,
    quietHoursStart: 23,
    quietHoursEnd: 8,
    onSuccess: 'wait_human',
    requireHumanAck: true,
    exitChecklist: '- typecheck 绿\n- 附 before/after 截图',
  }),
  stage(pipeline.id, 2, 'stage-test', '自动测试', 'ai', {
    agentId: 'qa-bot',
    promptTemplate: '对 {{ticket.identifier}} 跑回归并给出结论。',
    patrolCron: '0 */2 * * *',
    patrolEnabled: true,
    maxRetries: 2,
    onFailure: 'retry',
    entryCondition: 'last_run_succeeded',
  }),
  stage(pipeline.id, 3, 'stage-accept', '体验验收', 'gate', {
    onSuccess: 'close',
    requireHumanAck: true,
    entryCondition: 'last_run_succeeded && no_open_blockers',
  }),
]

const featureStages: PipelineStage[] = [
  stage(featurePipeline.id, 0, 'fstage-prd', 'PRD 评审', 'human'),
  stage(featurePipeline.id, 1, 'fstage-build', '开发实现', 'ai', {
    agentId: 'coding-assistant',
    promptTemplate: '实现 {{ticket.title}}',
  }),
]

const stageById = new Map(stages.map((s) => [s.id, s]))

const moveTo = (
  toStageId: string | null,
  action: AllowedMove['action'],
  label: string,
  over: Partial<AllowedMove> = {},
): AllowedMove => ({
  toStageId,
  action,
  label,
  requiresReason: action === 'send_back',
  requiresConfirm: action === 'skip_forward',
  ...over,
})

function ticket(
  num: number,
  title: string,
  status: Ticket['status'],
  stageId: string | null,
  priority: Ticket['priority'],
  updatedMinutesAgo: number,
  over: Partial<Ticket> = {},
): Ticket {
  return {
    id: `t-${num}`,
    identifier: `V5-${num}`,
    projectId: project.id,
    type: 'bug',
    title,
    body: '把用户要做的下一步说清楚,并确保窄屏下无需猜测或横向找按钮。',
    status,
    stageId,
    pipelineId: pipeline.id,
    priority,
    severity: 'major',
    labels: ['体验'],
    assignee: stageId === 'stage-build' ? 'agent:coding-assistant' : null,
    reporter: 'user:alice',
    source: 'manual',
    originSessionKey: null,
    dueDate: null,
    startDate: null,
    version: 1,
    blockedReason: status === 'blocked' ? '等待产品文案确认' : null,
    stageLoopCount: 0,
    createdAt: now - 3 * DAY,
    updatedAt: now - updatedMinutesAgo * MIN,
    closedAt: status === 'done' || status === 'canceled' ? now - updatedMinutesAgo * MIN : null,
    approvedBy: null,
    approvedAt: null,
    ...over,
  }
}

const longTitle =
  '整理看板与列表页重复出现的空态文案与徽章样式,并核对深色主题下的对比度(这是一条刻意写长的标题,用来检查卡片与表格里的截断与省略号)'

const tickets: Ticket[] = [
  ticket(101, '移动端顶部操作区重新分组', 'running', 'stage-build', 'P0', 2, {
    version: 4,
    body: [
      '## 现象',
      '390px 宽下,顶栏的项目 / 阶段 / 模板 / 看板四个图标按钮挤在一行,标签只有 10px。',
      '',
      '## 验收标准',
      '- 触控目标 ≥ 44px',
      '- 标签可读(≥ 12px)',
      '- 不出现横向滚动',
      '',
      '```ts',
      "const desktop = useMdViewport() // md 及以上",
      '```',
    ].join('\n'),
    originSessionKey: 'agent:coding-assistant:webchat:dm:sess-preview-0001',
    approvedBy: 'user:alice',
    approvedAt: now - 2 * DAY,
    allowedMoves: [
      moveTo('stage-test', 'skip_forward', '跳到', {
        warning: '将跳过「开发实现」的人工确认',
      }),
      moveTo('stage-clarify', 'send_back', '打回'),
      moveTo(null, 'return_to_backlog', '退回积压'),
    ],
  }),
  ticket(102, '列表在窄屏改为信息卡片', 'waiting_human', 'stage-accept', 'P1', 18, {
    approvedBy: 'user:alice',
    approvedAt: now - DAY,
    allowedMoves: [moveTo('stage-build', 'send_back', '打回')],
  }),
  ticket(103, '筛选项默认收起并显示已选数量', 'ready', 'stage-clarify', 'P2', 45, {
    allowedMoves: [
      moveTo('stage-build', 'skip_forward', '跳到'),
      moveTo(null, 'return_to_backlog', '退回积压'),
    ],
  }),
  ticket(104, '统一危险操作的位置与确认文案', 'blocked', 'stage-build', 'P1', 80, {
    allowedMoves: [moveTo('stage-clarify', 'send_back', '打回')],
  }),
  ticket(105, '补齐空状态和首次使用引导', 'backlog', null, 'P3', 120, {
    allowedMoves: [moveTo('stage-clarify', 'promote', '批准开工')],
  }),
  ticket(106, longTitle, 'backlog', null, 'P2', 6 * 60, {
    labels: ['体验', '样式'],
    allowedMoves: [moveTo('stage-clarify', 'promote', '批准开工')],
  }),
  ticket(107, '看板列头在滚动时吸顶', 'done', null, 'P2', 2 * 24 * 60, {
    approvedBy: 'user:alice',
  }),
  ticket(108, '重复的模板导入入口', 'canceled', null, 'P3', 5 * 24 * 60),
  ticket(109, '回归用例补齐:抽屉键盘可达性', 'running', 'stage-test', 'P2', 9, {
    assignee: 'agent:qa-bot',
    allowedMoves: [moveTo('stage-build', 'send_back', '打回')],
  }),
  ticket(110, '拖拽落点在触屏上不可用', 'ready', 'stage-clarify', 'P1', 30, {
    allowedMoves: [moveTo(null, 'return_to_backlog', '退回积压')],
  }),
]

const ticketByRef = (ref: string) =>
  tickets.find((t) => t.id === ref || t.identifier === ref) ?? tickets[0]

function pageOf(query?: TicketListQuery) {
  const rows = filterTickets(tickets, query ?? {})
  const offset = query?.offset ?? 0
  const limit = query?.limit ?? 200
  return { items: rows.slice(offset, offset + limit), total: rows.length }
}

function snapshot(over: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    project,
    pipeline,
    ticketType: 'bug',
    columns: stages.map((s) => ({
      stage: s,
      tickets: tickets.filter((t) => t.stageId === s.id),
    })),
    inbox: tickets.filter((t) => t.status === 'waiting_human'),
    backlog: { tickets: tickets.filter((t) => t.status === 'backlog') },
    ...over,
  }
}

const agents = [
  { id: 'coding-assistant', name: '编程助手' },
  { id: 'qa-bot', name: '测试助手' },
]

const runs: TicketRun[] = [
  {
    id: 'run-1',
    ticketId: 't-101',
    stageId: 'stage-build',
    agentId: 'coding-assistant',
    trigger: 'patrol',
    sessionKey: 'agent:coding-assistant:webchat:dm:sess-preview-0001',
    status: 'succeeded',
    skipReason: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    startedAt: now - 2 * DAY,
    finishedAt: now - 2 * DAY + 12.5 * MIN,
    durationMs: 12.5 * MIN,
    tokensIn: 18234,
    tokensOut: 4120,
    costUsd: 0.1234,
    costImprecise: false,
    summary: '完成顶部操作区分组:项目/阶段/模板归入「配置」菜单,看板护栏单独保留。',
    outputMd:
      '### 改动\n- `TaskboardView.tsx` header 重排\n- 新增 `HeaderMenu`\n\n### 验证\n- typecheck ✅\n- vitest taskboard ✅',
    error: null,
    createdAt: now - 2 * DAY,
    contextSha256: 'a3f9c1d2e4b5f60718293a4b5c6d7e8f9012abcd',
    contextVersion: 2,
  },
  {
    id: 'run-2',
    ticketId: 't-101',
    stageId: 'stage-build',
    agentId: 'coding-assistant',
    trigger: 'retry',
    sessionKey: null,
    status: 'failed',
    skipReason: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    startedAt: now - DAY,
    finishedAt: now - DAY + 45 * MIN,
    durationMs: 45 * MIN,
    tokensIn: 9021,
    tokensOut: 0,
    costUsd: 0,
    costImprecise: null,
    summary: null,
    outputMd: null,
    error: 'ETIMEDOUT: 容器在 45 分钟内无输出,已按无活动超时中断。',
    createdAt: now - DAY,
  },
  {
    id: 'run-3',
    ticketId: 't-101',
    stageId: 'stage-build',
    agentId: 'coding-assistant',
    trigger: 'patrol',
    sessionKey: null,
    status: 'skipped',
    skipReason: 'entry_condition',
    leaseOwner: null,
    leaseExpiresAt: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    tokensIn: null,
    tokensOut: null,
    costUsd: null,
    summary: null,
    outputMd: null,
    error: null,
    createdAt: now - 6 * 60 * MIN,
  },
]

const comments: TicketComment[] = [
  {
    id: 'c-1',
    ticketId: 't-101',
    authorKind: 'agent',
    author: 'agent:coding-assistant',
    body: [
      '本轮把顶栏四个图标按钮收进了一个「配置」下拉,移动端只保留「新建单据」与菜单入口。',
      '',
      '需要拍板的点:',
      '1. 「看板」这个标签实际打开的是护栏设置,是否改名为「护栏」?',
      '2. 阶段配置在没有项目时是禁用的,但图标没有任何禁用提示,是否加 tooltip?',
      '3. 模板库套用后是否应自动刷新看板列(目前只刷新阶段配置)?',
      '',
      '以上三条都不阻塞合入,先按当前实现提交,等确认后补一轮。',
    ].join('\n'),
    runId: 'run-1',
    createdAt: now - 2 * DAY + 13 * MIN,
  },
  {
    id: 'c-2',
    ticketId: 't-101',
    authorKind: 'human',
    author: 'user:alice',
    body: '第 1 条同意改名「护栏」;第 2 条加 tooltip;第 3 条先不做。',
    runId: null,
    createdAt: now - DAY - 30 * MIN,
  },
]

const activities: TicketActivity[] = [
  {
    id: 'a-1',
    ticketId: 't-101',
    actor: 'human',
    actorId: 'user:alice',
    action: 'ticket_created',
    field: null,
    fromValue: null,
    toValue: null,
    createdAt: now - 3 * DAY,
  },
  {
    id: 'a-2',
    ticketId: 't-101',
    actor: 'human',
    actorId: 'user:alice',
    action: 'status_changed',
    field: 'status',
    fromValue: 'backlog',
    toValue: 'ready',
    createdAt: now - 2 * DAY - 5 * MIN,
  },
  {
    id: 'a-3',
    ticketId: 't-101',
    actor: 'system',
    actorId: 'system',
    action: 'status_changed',
    field: 'status',
    fromValue: 'ready',
    toValue: 'running',
    createdAt: now - 2 * MIN,
  },
]

const timeline: TimelineItem[] = [
  ...activities.map((activity) => ({ kind: 'activity' as const, createdAt: activity.createdAt, activity })),
  ...runs.map((run) => ({ kind: 'run' as const, createdAt: run.createdAt, run })),
  ...comments.map((comment) => ({ kind: 'comment' as const, createdAt: comment.createdAt, comment })),
]

const settings: TaskboardSettingsSnapshot = {
  maxConcurrentRuns: 2,
  maxRunsPerDay: 200,
  maxCostPerDayUsd: 5,
  quietHoursStart: 23,
  quietHoursEnd: 8,
  circuitBreakerThreshold: 3,
  maxStageLoops: 5,
  maxRunsPerTick: 2,
  patrolPaused: false,
  usage: { runsToday: 37, costTodayUsd: 1.2345, activeRuns: 1, unpricedRunsToday: 4 },
}

function templateOf(
  id: string,
  name: string,
  ticketType: PipelineTemplate['ticketType'],
  source: PipelineTemplate['source'],
  names: string[],
): PipelineTemplate {
  return {
    id,
    slug: id,
    name,
    ticketType,
    source,
    stages: names.map((n, i) => ({
      ordinal: i,
      name: n,
      kind: i === 1 ? 'ai' : i === names.length - 1 ? 'gate' : 'human',
      agentId: i === 1 ? 'coding-assistant' : null,
      model: null,
      promptTemplate: i === 1 ? '实现 {{ticket.title}}' : null,
      toolsets: null,
      effort: null,
      patrolCron: null,
      patrolEnabled: i === 1,
      patrolTimezone: 'Asia/Shanghai',
      quietHoursStart: null,
      quietHoursEnd: null,
      maxRunsPerDay: 20,
      timeoutSec: 2400,
      maxRetries: 1,
      circuitBreakerThreshold: 3,
      onSuccess: 'advance',
      onFailure: 'block',
      entryCondition: null,
      exitChecklist: null,
      requireHumanAck: false,
      autoClose: false,
    })),
    createdAt: project.createdAt,
    updatedAt: now,
  }
}

const templates: PipelineTemplate[] = [
  templateOf('builtin:bug', '问题单默认流水线', 'bug', 'builtin', ['需求澄清', '开发实现', '体验验收']),
  templateOf('builtin:feature', '需求单默认流水线', 'feature', 'builtin', ['PRD 评审', '开发实现', '验收']),
  templateOf('builtin:spike', '调研单默认流水线', 'spike', 'builtin', ['问题定义', '调研', '结论评审']),
  templateOf('builtin:chore', '杂务单默认流水线', 'chore', 'builtin', ['确认', '执行']),
  templateOf('custom-qa', '带自动测试的问题线', 'bug', 'custom', ['需求澄清', '开发实现', '自动测试', '体验验收']),
]

const costTotals: CostTotals = {
  runCount: 42,
  tokensIn: 812_345,
  tokensOut: 201_234,
  costUsd: 3.4567,
  priced: { runCount: 30, tokensIn: 640_000, tokensOut: 150_000, costUsd: 3.4567 },
  unpriced: { runCount: 9, tokensIn: 172_345, tokensOut: 51_234, costUsd: 0 },
  unknownRunCount: 3,
  coverage: 'partial',
}

// 与 CostStatsView 默认区间(上海日历,今天往前 6 天)对齐,免得合计行与筛选框日期对不上。
const todayYmd = ymdInZone()
const costBuckets: CostBucket[] = Array.from({ length: 7 }, (_, i) => {
  const ymd = addDaysYmd(todayYmd, i - 6)
  const priced = 3 + (i % 3)
  const unpriced = i === 2 || i === 5 ? 2 : 0
  return {
    key: ymd,
    label: ymd,
    runCount: priced + unpriced + (i === 4 ? 1 : 0),
    tokensIn: 90_000 + i * 12_000,
    tokensOut: 20_000 + i * 3_000,
    costUsd: 0.31 + i * 0.07,
    priced: { runCount: priced, tokensIn: 80_000, tokensOut: 18_000, costUsd: 0.31 + i * 0.07 },
    unpriced: { runCount: unpriced, tokensIn: unpriced ? 10_000 : 0, tokensOut: unpriced ? 2_000 : 0, costUsd: 0 },
    unknownRunCount: i === 4 ? 1 : 0,
    coverage: unpriced ? 'partial' : 'full',
  }
})

const costStats: CostStatsResult = {
  from: costBuckets[0].key,
  to: costBuckets[costBuckets.length - 1].key,
  timeZone: 'Asia/Shanghai',
  groupBy: 'day',
  totals: costTotals,
  buckets: costBuckets,
}

const weekly: WeeklyReport = {
  period: {
    week: '2026-W37',
    fromYmd: '2026-09-07',
    toYmd: '2026-09-13',
    fromMs: now - 7 * DAY,
    toMs: now,
    timeZone: 'Asia/Shanghai',
  },
  projectId: project.id,
  flow: {
    created: 12,
    completed: 7,
    canceled: 1,
    waitingHuman: 2,
    blockedNow: 1,
    statusTransitions: [
      { from: 'backlog', to: 'ready', count: 9 },
      { from: 'ready', to: 'running', count: 14 },
      { from: 'running', to: 'waiting_human', count: 8 },
      { from: 'waiting_human', to: 'done', count: 7 },
      { from: 'running', to: 'blocked', count: 1 },
    ],
  },
  stages: [
    { stageId: 'stage-build', stageName: '开发实现', runCount: 21, succeeded: 17, failed: 3, timeout: 1, totalDurationMs: 21 * 11 * MIN, avgDurationMs: 11 * MIN },
    { stageId: 'stage-test', stageName: '自动测试', runCount: 15, succeeded: 14, failed: 1, timeout: 0, totalDurationMs: 15 * 4 * MIN, avgDurationMs: 4 * MIN },
  ],
  cost: costTotals,
  blocked: [{ identifier: 'V5-104', title: '统一危险操作的位置与确认文案', blockedReason: '等待产品文案确认' }],
  failedRuns: [
    {
      runId: 'run-2',
      identifier: 'V5-101',
      stageName: '开发实现',
      status: 'timeout',
      error: 'ETIMEDOUT: 容器在 45 分钟内无输出,已按无活动超时中断。',
      createdAt: now - DAY,
    },
  ],
}

// ── taskboardApi 替身 ────────────────────────────────────────────────────────

type Api = typeof taskboardApi
type Overrides = { [K in keyof Api]?: Api[K] }

/** 每个场景 render() 时重装:taskboardApi 是模块级单例,同页前一个场景的替身会残留。 */
function installStubs(over: Overrides = {}) {
  const base: Overrides = {
    listProjects: async (_a, includeArchived) => (includeArchived ? [project, archivedProject] : [project]),
    listTickets: async (_a, query) => pageOf(query),
    listAgents: async () => agents,
    getProjectBoard: async () => snapshot(),
    getTicketDetail: async (_a, ref) => {
      const t = ticketByRef(ref)
      return { ticket: t, pipeline, stage: t.stageId ? stageById.get(t.stageId) ?? null : null }
    },
    getTicket: async (_a, ref) => ticketByRef(ref),
    listRuns: async () => ({ items: runs, total: runs.length }),
    listTimeline: async () => timeline,
    listComments: async () => comments,
    listActivity: async () => activities,
    listPipelines: async () => [pipeline, featurePipeline],
    getPipeline: async (_a, id) =>
      id === featurePipeline.id
        ? { pipeline: featurePipeline, stages: featureStages }
        : { pipeline, stages },
    getSettings: async () => settings,
    listTemplates: async () => templates,
    getCostStats: async () => costStats,
    getWeeklyReport: async () => weekly,
    getProjectContext: async () => ({
      version: 3,
      workspaceSpec: { kind: 'default' },
      instructions: '优先保证移动端可用;所有危险操作必须二次确认。',
    }),
    previewProjectContext: async () => ({
      slots: [
        { name: 'project.instructions', bytes: 1024 },
        { name: 'memory.official', bytes: 2048, redacted: true },
        { name: 'live.git_status', bytes: 512, volatile: true },
      ],
    }),
    listProjectMemories: async () => ({
      projectId: project.id,
      official: [
        { projectId: project.id, slug: 'coding-conventions', contentSha256: 'sha-1', version: 2 },
        { projectId: project.id, slug: 'legacy-api-notes', contentSha256: 'sha-2', version: 1, deprecated: true },
        { projectId: project.id, slug: 'release-notes-draft', contentSha256: 'sha-3', version: 1, tampered: true },
      ],
      candidates: [
        {
          id: 'cand-1',
          projectId: project.id,
          slug: 'release-checklist',
          contentSha256: 'sha-4',
          status: 'pending',
          version: 1,
          content: '- 发版前跑 typecheck\n- 附 before/after 截图\n- 更新 docs/audit',
        },
      ],
    }),
  }
  Object.assign(taskboardApi, base, over)
}

// ── 挂载辅助 ────────────────────────────────────────────────────────────────

/** 工作项目列表到位后选中它 —— 等价于用户在顶栏下拉里选项目。 */
function SelectWorkProject({ id, children }: { id: string | null; children: ReactNode }) {
  const { workProjects, token, setToken } = useProjectScope()
  useEffect(() => {
    if (!id) {
      if (token !== 'all') setToken('all')
      return
    }
    if (workProjects.some((p) => p.id === id) && token !== id) setToken(id)
  }, [id, workProjects, token, setToken])
  return <>{children}</>
}

/** 卸载时把 ?project= 从 URL 上摘掉,免得同页后续场景继承到。 */
function CleanUrlOnUnmount({ children }: { children: ReactNode }) {
  useEffect(
    () => () => {
      history.replaceState({}, '', `${location.pathname}${location.hash}`)
    },
    [],
  )
  return <>{children}</>
}

function waitFor(selector: string, timeoutMs = 4000): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      const el = document.querySelector<HTMLElement>(selector)
      if (el && !el.hasAttribute('disabled')) return resolve(el)
      if (Date.now() - started > timeoutMs) return resolve(null)
      setTimeout(tick, 50)
    }
    tick()
  })
}

/**
 * 挂载后按顺序等元素出现再点击(面板/抽屉/表单都是组件内部 state,没有受控入口)。
 * 步骤前缀:
 * - `event:<name>` 在 document 上派发该事件(如 visibilitychange 触发看板后台对账);
 * - `?` 可选步骤:找不到(1.5s)就跳过继续,用于只在某个视口才存在的入口
 *   (移动端的「配置」菜单在桌面视口没有);
 * - `menu:` Radix DropdownMenu 的触发器靠 pointerdown 打开,`.click()` 打不开,这里改派发 pointerdown。
 */
function AutoClick({ selectors, children }: { selectors: string[]; children: ReactNode }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectors 每个场景是常量,只在挂载时跑一次
  useEffect(() => {
    let cancelled = false
    void (async () => {
      for (const raw of selectors) {
        if (raw.startsWith('event:')) {
          await new Promise((r) => setTimeout(r, 150))
          document.dispatchEvent(new Event(raw.slice('event:'.length)))
          await new Promise((r) => setTimeout(r, 150))
          continue
        }
        let sel = raw
        const optional = sel.startsWith('?')
        if (optional) sel = sel.slice(1)
        const menu = sel.startsWith('menu:')
        if (menu) sel = sel.slice('menu:'.length)
        // 可选步骤只等 400ms:它对应的入口(移动端菜单)是同步挂载的,没有就是没有;等久了会撞上截图延时。
        const el = await waitFor(sel, optional ? 400 : 4000)
        if (cancelled) return
        if (!el) {
          if (!optional) console.warn('[taskboard-preview] auto-click 未找到', sel)
          continue
        }
        if (menu) {
          el.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }),
          )
        } else {
          el.click()
        }
        await new Promise((r) => setTimeout(r, 120))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  return <>{children}</>
}

/** 移动端视口下先把顶栏「配置」菜单打开(桌面没有这个菜单,可选步骤直接跳过)。 */
const OPEN_CONFIG_MENU = '?menu:[data-testid="taskboard-config-menu"]'

function Board({
  view,
  ticketId = null,
  scoped = true,
  clicks = [],
  sidebarCollapsed = true,
}: {
  view: 'board' | 'list' | 'cost' | 'weekly'
  ticketId?: string | null
  scoped?: boolean
  clicks?: string[]
  sidebarCollapsed?: boolean
}) {
  return (
    <CleanUrlOnUnmount>
      <ProjectScopeProvider auth={auth} chatProjects={[]}>
        <SelectWorkProject id={scoped ? project.id : null}>
          <AutoClick selectors={clicks}>
            <div className="h-screen bg-bg text-fg">
              <TaskboardView
                auth={auth}
                view={view}
                ticketId={ticketId}
                onViewChange={() => {}}
                onOpenTicket={() => {}}
                onOpenMobileNav={() => {}}
                onOpenSession={() => {}}
                sessionIds={['sess-preview-0001']}
                sidebarCollapsed={sidebarCollapsed}
                onExpandSidebar={() => {}}
              />
            </div>
          </AutoClick>
        </SelectWorkProject>
      </ProjectScopeProvider>
    </CleanUrlOnUnmount>
  )
}

const VP: Scene['viewports'] = ['desktop', 'mobile']
const GROUP: Scene['group'] = '工作区'

/** 阶段设置里的模型下拉走 lib/api 的 api 对象,由 api-stub 表提供。 */
const publicModels = {
  getPublicModels: async () => ({
    models: [
      { id: 'gpt-5', display_name: 'GPT-5' },
      { id: 'claude-4.5', display_name: 'Claude 4.5' },
      { id: 'glm-5.2', display_name: 'GLM 5.2', degraded: true },
    ],
    lockedModels: [],
  }),
}

export const taskboardScenes: Scene[] = [
  {
    id: 'taskboard-board-responsive',
    label: '任务面板 · 看板(积压 / 待确认 / 四个阶段列)',
    group: GROUP,
    viewports: VP,
    api: {},
    render: () => {
      installStubs()
      return <Board view="board" />
    },
  },
  {
    id: 'taskboard-list-responsive',
    label: '任务面板 · 列表(桌面表格 / 移动卡片 + 筛选)',
    group: GROUP,
    viewports: VP,
    api: {},
    render: () => {
      installStubs()
      return <Board view="list" />
    },
  },
  {
    id: 'taskboard-ticket-drawer',
    label: '任务面板 · 单据抽屉(正文 / 操作 / 讨论 / 系统活动展开)',
    group: GROUP,
    viewports: VP,
    api: {},
    render: () => {
      installStubs()
      return <Board view="board" ticketId="V5-101" clicks={['[data-testid="ticket-system-toggle"]']} />
    },
  },
  {
    id: 'taskboard-ticket-drawer-edit',
    label: '任务面板 · 单据抽屉「改需求」编辑态',
    group: GROUP,
    viewports: VP,
    api: {},
    render: () => {
      installStubs()
      return <Board view="board" ticketId="V5-104" clicks={['[data-testid="ticket-drawer-edit"]']} />
    },
  },
  {
    id: 'taskboard-create-form',
    label: '任务面板 · 新建单据(桌面内联表单 / 移动贴底抽屉)',
    group: GROUP,
    viewports: VP,
    api: {},
    render: () => {
      installStubs()
      return <Board view="board" clicks={['[data-testid="ticket-create-toggle"]']} />
    },
  },
  {
    id: 'taskboard-mobile-config-menu',
    label: '任务面板 · 移动端顶栏「配置」菜单（项目 / 流水线 / 模板 / 护栏收进一个入口）',
    group: GROUP,
    viewports: ['mobile'],
    api: {},
    render: () => {
      installStubs()
      return <Board view="board" clicks={[OPEN_CONFIG_MENU]} />
    },
  },
  {
    id: 'taskboard-empty-columns',
    label: '任务面板 · 空看板(有阶段、无单据)',
    group: GROUP,
    viewports: VP,
    api: {},
    render: () => {
      installStubs({
        listTickets: async () => ({ items: [], total: 0 }),
        getProjectBoard: async () =>
          snapshot({
            columns: stages.map((s) => ({ stage: s, tickets: [] })),
            inbox: [],
            backlog: { tickets: [] },
          }),
      })
      return <Board view="board" />
    },
  },
  {
    id: 'taskboard-no-pipeline',
    label: '任务面板 · 项目还没有流水线（空态给出配置 / 套用模板两个下一步）',
    group: GROUP,
    viewports: VP,
    api: {},
    render: () => {
      installStubs({
        listTickets: async () => ({ items: [], total: 0 }),
        getProjectBoard: async () => snapshot({ columns: [], inbox: [], backlog: { tickets: [] } }),
      })
      return <Board view="board" />
    },
  },
  {
    id: 'taskboard-scope-unselected',
    label: '任务面板 · 未选择工作项目的空态',
    group: GROUP,
    viewports: VP,
    api: {},
    render: () => {
      installStubs()
      return <Board view="board" scoped={false} />
    },
  },
  {
    id: 'taskboard-scope-deeplink-reload',
    label: '任务面板 · 冷启只带 ?project=<工作项目> 深链(应显示看板)',
    group: GROUP,
    viewports: VP,
    api: {},
    render: () => {
      installStubs()
      // 只写 URL、不显式 setToken:模拟用户刷新页面。ProjectScopeProvider 在工作项目列表
      // 到位前把找不到的 token 判成 invalid 并回落 all,于是看板永远不会出现。
      history.replaceState({}, '', `${location.pathname}?project=${project.id}`)
      return (
        <CleanUrlOnUnmount>
          <ProjectScopeProvider auth={auth} chatProjects={[]}>
            <div className="h-screen bg-bg text-fg">
              <TaskboardView
                auth={auth}
                view="board"
                ticketId={null}
                onViewChange={() => {}}
                onOpenTicket={() => {}}
                onOpenMobileNav={() => {}}
              />
            </div>
          </ProjectScopeProvider>
        </CleanUrlOnUnmount>
      )
    },
  },
  {
    id: 'taskboard-load-error',
    label: '任务面板 · 看板接口失败(错误态 + 重试)',
    group: GROUP,
    viewports: VP,
    api: {},
    render: () => {
      // 项目列表成功(否则连看板都进不去),看板与单据列表两个接口都挂:
      // 阶段 B 之后应落在「任务面板加载失败」+「重试」上,而不是「还没有流水线列」。
      const boom = async () => {
        throw new Error('网关 502:上游任务服务暂时不可用')
      }
      installStubs({ getProjectBoard: boom, listTickets: boom })
      return <Board view="board" />
    },
  },
  {
    id: 'taskboard-stage-settings',
    label: '任务面板 · 流水线配置(展开「开发实现」阶段编辑)',
    group: GROUP,
    viewports: VP,
    api: publicModels,
    render: () => {
      installStubs()
      return (
        <Board
          view="board"
          clicks={[
            OPEN_CONFIG_MENU,
            '[data-testid="stage-settings-open"]',
            '[data-testid="stage-edit-stage-build"]',
          ]}
        />
      )
    },
  },
  {
    id: 'taskboard-template-library',
    label: '任务面板 · 流水线模板库',
    group: GROUP,
    viewports: VP,
    api: {},
    render: () => {
      installStubs()
      return <Board view="board" clicks={[OPEN_CONFIG_MENU, '[data-testid="template-library-open"]']} />
    },
  },
  {
    id: 'taskboard-board-settings',
    label: '任务面板 · 护栏设置',
    group: GROUP,
    viewports: VP,
    api: {},
    render: () => {
      installStubs()
      return <Board view="board" clicks={[OPEN_CONFIG_MENU, '[data-testid="board-settings-open"]']} />
    },
  },
  {
    id: 'taskboard-project-settings',
    label: '任务面板 · 管理项目(工作区 / 上下文 / 记忆 / 已归档)',
    group: GROUP,
    viewports: VP,
    api: {},
    render: () => {
      installStubs()
      // 阶段 B 之后首屏 projects 不再被竞态丢掉(审计 T-01),「管理项目」入口第一屏就在,
      // 不需要再靠 visibilitychange 触发对账。
      return (
        <Board
          view="board"
          clicks={[
            OPEN_CONFIG_MENU,
            '[data-testid="project-edit-open"]',
            '[data-testid="project-context-preview"]',
          ]}
        />
      )
    },
  },
  {
    id: 'taskboard-cost-stats',
    label: '任务面板 · 成本统计(partial 覆盖)',
    group: GROUP,
    viewports: VP,
    api: {},
    render: () => {
      installStubs()
      return <Board view="cost" />
    },
  },
  {
    id: 'taskboard-weekly-report',
    label: '任务面板 · 周报',
    group: GROUP,
    viewports: VP,
    api: {},
    render: () => {
      installStubs()
      return <Board view="weekly" />
    },
  },
]
