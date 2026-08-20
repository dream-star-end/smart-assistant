import { TaskboardView } from '../../src/components/taskboard/TaskboardView'
import { createMemoryAuthSession } from '../../src/lib/authSession'
import {
  type BoardSnapshot,
  type Pipeline,
  type PipelineStage,
  type Project,
  type Ticket,
  type TicketListQuery,
  taskboardApi,
} from '../../src/lib/taskboard'
import type { Scene } from './types'

const auth = createMemoryAuthSession(() => {}, 'taskboard-preview-token')
const now = Date.now()

const project: Project = {
  id: 'preview-project',
  key: 'V5',
  name: '产品体验优化',
  description: '任务面板移动端与桌面端体验',
  workspace: null,
  labels: ['产品'],
  archivedAt: null,
  createdAt: now - 14 * 86_400_000,
  updatedAt: now,
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

const stages: PipelineStage[] = [
  {
    id: 'stage-clarify',
    pipelineId: pipeline.id,
    ordinal: 0,
    name: '需求澄清',
    kind: 'human',
    agentId: null,
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
  },
  {
    id: 'stage-build',
    pipelineId: pipeline.id,
    ordinal: 1,
    name: '开发实现',
    kind: 'ai',
    agentId: 'coding-assistant',
    promptTemplate: '完成实现并验证',
    toolsets: null,
    effort: 'high',
    patrolCron: null,
    patrolEnabled: true,
    patrolTimezone: 'Asia/Shanghai',
    quietHoursStart: null,
    quietHoursEnd: null,
    maxRunsPerDay: 20,
    timeoutSec: 2400,
    maxRetries: 1,
    circuitBreakerThreshold: 3,
    onSuccess: 'wait_human',
    onFailure: 'block',
    autoClose: false,
    entryCondition: null,
    exitChecklist: null,
    requireHumanAck: true,
    createdAt: project.createdAt,
    updatedAt: now,
  },
  {
    id: 'stage-accept',
    pipelineId: pipeline.id,
    ordinal: 2,
    name: '体验验收',
    kind: 'gate',
    agentId: null,
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
    onSuccess: 'close',
    onFailure: 'block',
    autoClose: false,
    entryCondition: null,
    exitChecklist: null,
    requireHumanAck: true,
    createdAt: project.createdAt,
    updatedAt: now,
  },
]

function ticket(
  id: string,
  title: string,
  status: Ticket['status'],
  stageId: string | null,
  priority: Ticket['priority'],
  updatedMinutesAgo: number,
): Ticket {
  return {
    id,
    identifier: `V5-${id.replace(/\D/g, '')}`,
    projectId: project.id,
    type: 'bug',
    title,
    body: '把用户要做的下一步说清楚，并确保窄屏下无需猜测或横向找按钮。',
    status,
    stageId,
    pipelineId: pipeline.id,
    priority,
    severity: 'major',
    labels: ['体验'],
    assignee: stageId === 'stage-build' ? 'agent:coding-assistant' : null,
    reporter: 'user:preview',
    source: 'manual',
    originSessionKey: null,
    dueDate: null,
    startDate: null,
    version: 1,
    blockedReason: status === 'blocked' ? '等待产品文案确认' : null,
    stageLoopCount: 0,
    createdAt: now - 3 * 86_400_000,
    updatedAt: now - updatedMinutesAgo * 60_000,
    closedAt: status === 'done' ? now - updatedMinutesAgo * 60_000 : null,
  }
}

const tickets = [
  ticket('101', '移动端顶部操作区重新分组', 'running', 'stage-build', 'P0', 2),
  ticket('102', '列表在窄屏改为信息卡片', 'waiting_human', 'stage-accept', 'P1', 18),
  ticket('103', '筛选项默认收起并显示已选数量', 'ready', 'stage-clarify', 'P2', 45),
  ticket('104', '统一危险操作的位置与确认文案', 'blocked', 'stage-build', 'P1', 80),
  ticket('105', '补齐空状态和首次使用引导', 'backlog', null, 'P3', 120),
]

function filterTickets(query?: TicketListQuery): Ticket[] {
  if (!query) return tickets
  return tickets.filter((item) => {
    if (query.status && item.status !== query.status) return false
    if (query.type && item.type !== query.type) return false
    if (query.priority && item.priority !== query.priority) return false
    if (query.assignee && item.assignee !== query.assignee) return false
    if (query.label && !item.labels.includes(query.label)) return false
    if (query.q) {
      const q = query.q.toLowerCase()
      if (!`${item.identifier} ${item.title}`.toLowerCase().includes(q)) return false
    }
    return true
  })
}

function snapshot(): BoardSnapshot {
  return {
    project,
    pipeline,
    ticketType: 'bug',
    columns: stages.map((stage) => ({
      stage,
      tickets: tickets.filter((item) => item.stageId === stage.id),
    })),
    inbox: tickets.filter((item) => item.status === 'waiting_human'),
    backlog: { tickets: tickets.filter((item) => item.status === 'backlog') },
  }
}

function TaskboardPreview({ view }: { view: 'board' | 'list' }) {
  taskboardApi.listProjects = async () => [project]
  taskboardApi.listTickets = async (_auth, query) => {
    const items = filterTickets(query)
    return { items, total: items.length }
  }
  taskboardApi.listAgents = async () => [
    { id: 'coding-assistant', name: '编程助手', hidden: false },
  ]
  taskboardApi.getProjectBoard = async () => snapshot()

  return (
    <div className="h-screen bg-bg text-fg">
      <TaskboardView
        auth={auth}
        view={view}
        ticketId={null}
        onViewChange={() => {}}
        onOpenTicket={() => {}}
        onOpenMobileNav={() => {}}
      />
    </div>
  )
}

export const taskboardScenes: Scene[] = [
  {
    id: 'taskboard-board-responsive',
    label: '任务面板 · 响应式看板与阶段导航',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <TaskboardPreview view="board" />,
  },
  {
    id: 'taskboard-list-responsive',
    label: '任务面板 · 桌面表格与移动卡片筛选',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <TaskboardPreview view="list" />,
  },
]
