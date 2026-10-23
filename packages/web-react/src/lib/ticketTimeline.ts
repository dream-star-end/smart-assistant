/**
 * 单据时间线的纯组装：把评论、执行记录、活动事件合并成按时间正序的节点，
 * 再做同作者 5 分钟连续评论分组和筛选。不读网络、不碰 DOM。
 *
 * 缺字段、null、非数组一律跳过，不抛错。时间戳必须是有限 number（含 0）。
 */
import {
  assigneeLabel,
  type AuthorKind,
  type RunStatus,
  type TicketActivity,
  type TicketComment,
  type TicketRun,
  type TimelineItem,
} from './taskboard'

export const COMMENT_GROUP_WINDOW_MS = 5 * 60 * 1000
export const TIMELINE_COMMENT_MAX_LINES = 8
/** 按抽屉里评论的大致显示宽度估算：一行约 80 个单位。 */
export const TIMELINE_LINE_UNITS = 80

export const TIMELINE_FILTERS = ['all', 'comment', 'status', 'run'] as const
export type TicketTimelineFilter = (typeof TIMELINE_FILTERS)[number]

export type TicketTimelineKind =
  | 'comment'
  | 'status'
  | 'approval'
  | 'activity'
  | 'run_start'
  | 'run_end'

export type TicketTimelineBucket = 'comment' | 'status' | 'run'

/** 同刻排序：动态 < 审批 < 状态 < 评论 < 执行开始 < 执行结束，再按 id。 */
const KIND_RANK: Record<TicketTimelineKind, number> = {
  activity: 0,
  approval: 1,
  status: 2,
  comment: 3,
  run_start: 4,
  run_end: 5,
}

export interface TicketTimelineNode {
  id: string
  kind: TicketTimelineKind
  bucket: TicketTimelineBucket
  createdAt: number
  author: string
  authorKind: AuthorKind
  stageId: string | null
  stageHint: string | null
  comment?: TicketComment
  activity?: TicketActivity
  run?: TicketRun
  /** start = 同一次执行后面还有结束节点；single = 只此一个节点，展示完整明细。 */
  runPhase?: 'start' | 'end' | 'single'
}

export interface TicketTimelineGroup {
  id: string
  nodes: TicketTimelineNode[]
}

export interface TicketTimelineCounts {
  all: number
  comment: number
  status: number
  run: number
}

export interface TicketTimelineModel {
  nodes: TicketTimelineNode[]
  groups: TicketTimelineGroup[]
  counts: TicketTimelineCounts
}

/** 中日韩全角（含全角标点）算 2 个显示单位，其余算 1。 */
function charUnits(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

/**
 * 没有布局时的长评论判定。每段至少 1 行，按每行约 80 个显示单位折行，
 * 估算行数超过 8 才算长。有布局时以渲染高度为准，这里只做回落。
 */
export function isTimelineCommentLong(body: unknown): boolean {
  if (typeof body !== 'string' || body.length === 0) return false
  let lines = 0
  for (const paragraph of body.split(/\r?\n/)) {
    if (paragraph.length === 0) {
      lines += 1
      continue
    }
    let units = 0
    for (const char of paragraph) units += charUnits(char)
    lines += Math.max(1, Math.ceil(units / TIMELINE_LINE_UNITS))
  }
  return lines > TIMELINE_COMMENT_MAX_LINES
}

interface ShanghaiParts {
  year: string
  month: string
  day: string
  hour: string
  minute: string
  second: string
}

function shanghaiParts(ms: number): ShanghaiParts | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour') === '24' ? '00' : pick('hour'),
    minute: pick('minute'),
    second: pick('second'),
  }
}

/** 绝对时间固定 Asia/Shanghai，不跟容器本地时区走。悬停 title 用到秒。 */
export function formatShanghaiAbsolute(ms: number): string {
  const parts = shanghaiParts(ms)
  if (!parts) return '—'
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * 时间线节点上的时间。近 24 小时用相对说法，更早的写出上海时间的月日和时刻，
 * 避免同一天的节点都挤成一个日期。
 */
export function formatTimelineTime(ms: number, now: number): string {
  const when = shanghaiParts(ms)
  if (!when) return '—'
  const safeNow = typeof now === 'number' && Number.isFinite(now) ? now : ms
  const delta = safeNow - ms
  if (delta >= 0 && delta < MINUTE_MS) return '刚刚'
  if (delta >= 0 && delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)} 分钟前`
  if (delta >= 0 && delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)} 小时前`
  const today = shanghaiParts(safeNow)
  if (today && today.year === when.year) {
    return `${when.month}-${when.day} ${when.hour}:${when.minute}`
  }
  return `${when.year}-${when.month}-${when.day} ${when.hour}:${when.minute}`
}

/** 时间线上的作者名。unidentified 是上游占位，不直接露给界面。 */
export function timelineAuthorLabel(author: unknown, authorKind?: unknown, pending?: boolean): string {
  if (pending && authorKind === 'human') return '我'
  const raw = typeof author === 'string' ? author.trim() : ''
  if (raw === '' || raw === 'unidentified' || raw.endsWith(':unidentified')) return '未识别来源'
  const label = assigneeLabel(raw)
  if (!label || label === 'unidentified') return '未识别来源'
  return label
}

export function timelineSourcesFromItems(items: readonly TimelineItem[] | null | undefined): {
  comments: TicketComment[]
  runs: TicketRun[]
  events: TicketActivity[]
} {
  const comments: TicketComment[] = []
  const runs: TicketRun[] = []
  const events: TicketActivity[] = []
  if (!Array.isArray(items)) return { comments, runs, events }
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    if (item.kind === 'comment' && item.comment) comments.push(item.comment)
    else if (item.kind === 'run' && item.run) runs.push(item.run)
    else if (item.kind === 'activity' && item.activity) events.push(item.activity)
  }
  return { comments, runs, events }
}

export function buildTicketTimeline(
  comments?: unknown,
  runs?: unknown,
  events?: unknown,
  options?: { filter?: unknown },
): TicketTimelineModel {
  const seen = new Set<string>()
  const runStage = new Map<string, string>()
  const normalizedRuns: TicketRun[] = []
  for (const [index, raw] of asList(runs).entries()) {
    const run = normalizeRun(raw, index)
    if (!run) continue
    normalizedRuns.push(run)
    if (run.stageId) runStage.set(run.id, run.stageId)
  }

  const nodes: TicketTimelineNode[] = []
  for (const [index, raw] of asList(events).entries()) {
    const activity = normalizeActivity(raw, index)
    if (!activity) continue
    const kind = classifyActivity(activity)
    const stage = activityStage(activity)
    nodes.push({
      id: uniqueId(seen, activity.id),
      kind,
      bucket: 'status',
      createdAt: activity.createdAt,
      author: activity.actorId,
      authorKind: activity.actor,
      stageId: stage.stageId,
      stageHint: stage.stageHint,
      activity,
    })
  }
  for (const run of normalizedRuns) {
    pushRunNodes(run, nodes, seen)
  }
  for (const [index, raw] of asList(comments).entries()) {
    const comment = normalizeComment(raw, index)
    if (!comment) continue
    const stageId = comment.runId ? (runStage.get(comment.runId) ?? null) : null
    nodes.push({
      id: uniqueId(seen, comment.id),
      kind: 'comment',
      bucket: 'comment',
      createdAt: comment.createdAt,
      author: comment.author,
      authorKind: comment.authorKind,
      stageId,
      stageHint: null,
      comment,
    })
  }

  nodes.sort(compareNodes)
  const counts = countNodes(nodes)
  const filter = normalizeFilter(options?.filter)
  const groups = groupsForFilter(nodes, filter)
  const visible = filter === 'all' ? nodes : nodes.filter((node) => node.bucket === filter)
  return { nodes: visible, groups, counts }
}

/**
 * 先在全量时间线上分组，筛选时只丢掉整组或组内不可见节点。
 * 不能把筛完的评论重新相邻再分组，否则中间被藏起来的执行/状态会把两段评论错误粘在一起。
 */
function groupsForFilter(
  nodes: TicketTimelineNode[],
  filter: TicketTimelineFilter,
): TicketTimelineGroup[] {
  const groups = groupNodes(nodes)
  if (filter === 'all') return groups
  const out: TicketTimelineGroup[] = []
  for (const group of groups) {
    const visible = group.nodes.filter((node) => node.bucket === filter)
    if (visible.length === 0) continue
    out.push({ id: group.id, nodes: visible })
  }
  return out
}

function groupNodes(nodes: TicketTimelineNode[]): TicketTimelineGroup[] {
  const groups: TicketTimelineGroup[] = []
  let last: TicketTimelineNode | null = null
  let open: TicketTimelineGroup | null = null
  for (const node of nodes) {
    const join =
      node.kind === 'comment' &&
      last?.kind === 'comment' &&
      open != null &&
      last.author === node.author &&
      last.authorKind === node.authorKind &&
      node.createdAt >= last.createdAt &&
      node.createdAt - last.createdAt <= COMMENT_GROUP_WINDOW_MS
    if (join && open) {
      open.nodes.push(node)
    } else {
      open = { id: `g:${node.id}`, nodes: [node] }
      groups.push(open)
    }
    last = node
  }
  return groups
}

function compareNodes(a: TicketTimelineNode, b: TicketTimelineNode): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  const rank = KIND_RANK[a.kind] - KIND_RANK[b.kind]
  if (rank !== 0) return rank
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

function countNodes(nodes: TicketTimelineNode[]): TicketTimelineCounts {
  const counts: TicketTimelineCounts = { all: nodes.length, comment: 0, status: 0, run: 0 }
  for (const node of nodes) counts[node.bucket] += 1
  return counts
}

function normalizeFilter(value: unknown): TicketTimelineFilter {
  return TIMELINE_FILTERS.includes(value as TicketTimelineFilter)
    ? (value as TicketTimelineFilter)
    : 'all'
}

function pushRunNodes(run: TicketRun, out: TicketTimelineNode[], seen: Set<string>): void {
  const startAt = run.startedAt ?? run.createdAt
  const endAt = run.finishedAt
  const author = run.agentId || run.leaseOwner || 'system'
  const authorKind: AuthorKind = run.agentId ? 'agent' : 'system'
  const shared = {
    author,
    authorKind,
    stageId: run.stageId || null,
    stageHint: null as string | null,
    bucket: 'run' as const,
    run,
  }
  const hasDistinctEnd = endAt != null && endAt !== startAt
  if (!hasDistinctEnd) {
    const open = endAt == null && (run.status === 'queued' || run.status === 'running')
    const kind: TicketTimelineKind = open ? 'run_start' : 'run_end'
    out.push({
      ...shared,
      id: uniqueId(seen, `${run.id}:${open ? 'start' : 'end'}`),
      kind,
      createdAt: endAt ?? startAt,
      runPhase: 'single',
    })
    return
  }
  out.push({
    ...shared,
    id: uniqueId(seen, `${run.id}:start`),
    kind: 'run_start',
    createdAt: startAt,
    runPhase: 'start',
  })
  out.push({
    ...shared,
    id: uniqueId(seen, `${run.id}:end`),
    kind: 'run_end',
    createdAt: endAt,
    runPhase: 'end',
  })
}

function classifyActivity(activity: TicketActivity): TicketTimelineKind {
  const action = activity.action || ''
  if (action === 'ticket_approved' || action === 'approved' || /approv/i.test(action)) {
    return 'approval'
  }
  if (
    action === 'status_changed' ||
    action === 'stage_advanced' ||
    activity.field === 'status' ||
    activity.field === 'stageId' ||
    activity.field === 'stage'
  ) {
    return 'status'
  }
  return 'activity'
}

function activityStage(activity: TicketActivity): { stageId: string | null; stageHint: string | null } {
  if ((activity.field === 'stageId' || activity.field === 'stage') && activity.toValue) {
    return { stageId: activity.toValue, stageHint: activity.toValue }
  }
  return { stageId: null, stageHint: null }
}

function normalizeComment(raw: unknown, index: number): TicketComment | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Partial<TicketComment>
  const createdAt = timeOf(row.createdAt)
  if (createdAt == null) return null
  const author = typeof row.author === 'string' ? row.author : ''
  return {
    id: typeof row.id === 'string' && row.id ? row.id : `comment:${index}:${createdAt}`,
    ticketId: typeof row.ticketId === 'string' ? row.ticketId : '',
    authorKind: authorKindOf(row.authorKind, author),
    author,
    body: typeof row.body === 'string' ? row.body : '',
    runId: typeof row.runId === 'string' ? row.runId : null,
    createdAt,
  }
}

function normalizeActivity(raw: unknown, index: number): TicketActivity | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Partial<TicketActivity>
  const createdAt = timeOf(row.createdAt)
  if (createdAt == null) return null
  const actorId = typeof row.actorId === 'string' ? row.actorId : ''
  const actor =
    row.actor === 'human' || row.actor === 'agent' || row.actor === 'system'
      ? row.actor
      : authorKindOf(undefined, actorId)
  return {
    id: typeof row.id === 'string' && row.id ? row.id : `activity:${index}:${createdAt}`,
    ticketId: typeof row.ticketId === 'string' ? row.ticketId : '',
    actor,
    actorId,
    action: typeof row.action === 'string' ? row.action : '',
    field: typeof row.field === 'string' ? row.field : null,
    fromValue: typeof row.fromValue === 'string' ? row.fromValue : null,
    toValue: typeof row.toValue === 'string' ? row.toValue : null,
    createdAt,
  }
}

function normalizeRun(raw: unknown, index: number): TicketRun | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Partial<TicketRun>
  const createdAt = timeOf(row.createdAt)
  const startedAt = timeOf(row.startedAt)
  const finishedAt = timeOf(row.finishedAt)
  const anchor = startedAt ?? finishedAt ?? createdAt
  if (anchor == null) return null
  const status = typeof row.status === 'string' && row.status ? row.status : 'queued'
  const trigger = typeof row.trigger === 'string' && row.trigger ? row.trigger : 'manual'
  return {
    id: typeof row.id === 'string' && row.id ? row.id : `run:${index}:${anchor}`,
    ticketId: typeof row.ticketId === 'string' ? row.ticketId : '',
    stageId: typeof row.stageId === 'string' ? row.stageId : '',
    agentId: typeof row.agentId === 'string' ? row.agentId : null,
    trigger: trigger as TicketRun['trigger'],
    sessionKey: typeof row.sessionKey === 'string' ? row.sessionKey : null,
    status: status as RunStatus,
    skipReason:
      typeof row.skipReason === 'string' ? (row.skipReason as TicketRun['skipReason']) : null,
    leaseOwner: typeof row.leaseOwner === 'string' ? row.leaseOwner : null,
    leaseExpiresAt: timeOf(row.leaseExpiresAt),
    startedAt,
    finishedAt,
    durationMs: typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) ? row.durationMs : null,
    tokensIn: typeof row.tokensIn === 'number' && Number.isFinite(row.tokensIn) ? row.tokensIn : null,
    tokensOut: typeof row.tokensOut === 'number' && Number.isFinite(row.tokensOut) ? row.tokensOut : null,
    costUsd: typeof row.costUsd === 'number' && Number.isFinite(row.costUsd) ? row.costUsd : null,
    costImprecise: typeof row.costImprecise === 'boolean' ? row.costImprecise : null,
    summary: typeof row.summary === 'string' ? row.summary : null,
    outputMd: typeof row.outputMd === 'string' ? row.outputMd : null,
    error: typeof row.error === 'string' ? row.error : null,
    createdAt: createdAt ?? anchor,
    stopRequested: row.stopRequested === true,
    actualModels: Array.isArray(row.actualModels)
      ? [...new Set(row.actualModels.filter((model): model is string => typeof model === 'string' && model !== '' && model !== 'auto'))]
      : undefined,
    preview: row.preview && typeof row.preview === 'object' && typeof row.preview.text === 'string'
      ? {
          text: row.preview.text.slice(-4096),
          toolNames: Array.isArray(row.preview.toolNames)
            ? row.preview.toolNames.filter((name): name is string => typeof name === 'string').slice(-8).map((name) => name.slice(0, 64)) : [],
          lastActivityAt: timeOf(row.preview.lastActivityAt),
        } : undefined,
    contextSha256: typeof row.contextSha256 === 'string' ? row.contextSha256 : null,
    contextVersion:
      typeof row.contextVersion === 'number' && Number.isFinite(row.contextVersion)
        ? row.contextVersion
        : null,
  }
}

function authorKindOf(kind: unknown, author: string): AuthorKind {
  if (kind === 'human' || kind === 'agent' || kind === 'system') return kind
  if (author.startsWith('agent:')) return 'agent'
  if (author.startsWith('user:')) return 'human'
  return 'system'
}

function timeOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function uniqueId(seen: Set<string>, base: string): string {
  let id = base || 'item'
  let n = 2
  while (seen.has(id)) {
    id = `${base}#${n}`
    n += 1
  }
  seen.add(id)
  return id
}
