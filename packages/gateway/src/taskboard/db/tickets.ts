// Ticket DAO — 建单、乐观锁写、identifier 原子分配。
//
// identifier 形如 OCV5-42,由服务端在事务里生成,createTicket **不接受**
// 调用方传入。分配策略:tb_project.next_ticket_seq 在 BEGIN IMMEDIATE 里
// UPDATE … RETURNING,再 INSERT。选 per-project 计数器而不是 MAX+1:
//   1. 删单不会让序号回退重号;
//   2. 不解析 identifier 字符串;
//   3. 冲突面是一行 UPDATE,SQLite 写锁即可串行化并发连接。
// UNIQUE(identifier) 是兜底;万一撞号(手工改库)重试最多 3 次。
//
// 乐观锁:所有写签名带 expectedVersion,WHERE version=? 影响 0 行就抛
// TaskboardVersionConflict,成功则 version+=1 且刷新 updated_at。
//
// 坑:
//   - 不要在事务外先读 next_ticket_seq 再写,那是 TOCTOU。
//   - labels 出库必须 parseJsonArray,入库 stringify,禁止把 TEXT 传上楼。

import type {
  Ticket,
  TicketPriority,
  TicketSeverity,
  TicketSource,
  TicketStatus,
  TicketType,
} from '../domain.js'
import { TICKET_PRIORITIES, TICKET_SOURCES, TICKET_STATUSES, TICKET_TYPES } from '../domain.js'
import {
  type TaskboardDb,
  TaskboardNotFound,
  TaskboardValidationError,
  TaskboardVersionConflict,
  newId,
  nowMs,
  parseJsonArray,
  stringifyJsonArray,
} from './schema.js'

interface TicketRow {
  id: string
  identifier: string
  project_id: string
  type: TicketType
  title: string
  body: string
  status: TicketStatus
  stage_id: string | null
  pipeline_id: string | null
  priority: TicketPriority
  severity: TicketSeverity | null
  labels: string
  assignee: string | null
  reporter: string
  source: TicketSource
  origin_session_key: string | null
  due_date: number | null
  start_date: number | null
  version: number
  blocked_reason: string | null
  stage_loop_count: number
  created_at: number
  updated_at: number
  closed_at: number | null
}

const TICKET_COLS = `
  id, identifier, project_id, type, title, body, status, stage_id, pipeline_id,
  priority, severity, labels, assignee, reporter, source, origin_session_key,
  due_date, start_date, version, blocked_reason, stage_loop_count,
  created_at, updated_at, closed_at
`

function mapTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    type: row.type,
    title: row.title,
    body: row.body,
    status: row.status,
    stageId: row.stage_id,
    pipelineId: row.pipeline_id,
    priority: row.priority,
    severity: row.severity,
    labels: parseJsonArray(row.labels),
    assignee: row.assignee,
    reporter: row.reporter,
    source: row.source,
    originSessionKey: row.origin_session_key,
    dueDate: row.due_date,
    startDate: row.start_date,
    version: row.version,
    blockedReason: row.blocked_reason,
    stageLoopCount: row.stage_loop_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  }
}

export interface CreateTicketInput {
  projectId: string
  type: TicketType
  title: string
  body?: string
  status?: TicketStatus
  stageId?: string | null
  pipelineId?: string | null
  priority?: TicketPriority
  severity?: TicketSeverity | null
  labels?: string[]
  assignee?: string | null
  reporter: string
  source?: TicketSource
  originSessionKey?: string | null
  dueDate?: number | null
  startDate?: number | null
}

export interface UpdateTicketPatch {
  title?: string
  body?: string
  status?: TicketStatus
  stageId?: string | null
  pipelineId?: string | null
  priority?: TicketPriority
  severity?: TicketSeverity | null
  labels?: string[]
  assignee?: string | null
  blockedReason?: string | null
  stageLoopCount?: number
  dueDate?: number | null
  startDate?: number | null
  closedAt?: number | null
}

export interface TicketListQuery {
  projectId?: string
  status?: TicketStatus | TicketStatus[]
  type?: TicketType | TicketType[]
  priority?: TicketPriority
  assignee?: string
  stageId?: string
  q?: string
  label?: string
  limit?: number
  offset?: number
}

const IDENTIFIER_RETRIES = 3

function isUniqueConstraint(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('UNIQUE constraint failed') && msg.includes('identifier')
}

function allocateIdentifier(db: TaskboardDb, projectId: string): string {
  const row = db
    .prepare(
      `UPDATE tb_project
          SET next_ticket_seq = next_ticket_seq + 1
        WHERE id = ?
    RETURNING key, next_ticket_seq`,
    )
    .get(projectId) as { key: string; next_ticket_seq: number } | undefined
  if (!row) throw new TaskboardNotFound('project', projectId)
  return `${row.key}-${row.next_ticket_seq}`
}

function assertEnum<T extends string>(value: T, allowed: readonly T[], field: string): void {
  if (!allowed.includes(value)) {
    throw new TaskboardValidationError(`invalid ${field}: ${value}`)
  }
}

export function createTicket(db: TaskboardDb, input: CreateTicketInput): Ticket {
  assertEnum(input.type, TICKET_TYPES, 'type')
  const status = input.status ?? 'backlog'
  const priority = input.priority ?? 'P2'
  const source = input.source ?? 'manual'
  assertEnum(status, TICKET_STATUSES, 'status')
  assertEnum(priority, TICKET_PRIORITIES, 'priority')
  assertEnum(source, TICKET_SOURCES, 'source')
  if (!input.title.trim()) {
    throw new TaskboardValidationError('title is required')
  }

  const insert = db.transaction(() => {
    const identifier = allocateIdentifier(db, input.projectId)
    const now = nowMs()
    const id = newId()
    db.prepare(
      `INSERT INTO tb_ticket (
         id, identifier, project_id, type, title, body, status, stage_id,
         pipeline_id, priority, severity, labels, assignee, reporter, source,
         origin_session_key, due_date, start_date, version, blocked_reason,
         stage_loop_count, created_at, updated_at, closed_at
       ) VALUES (
         @id, @identifier, @projectId, @type, @title, @body, @status, @stageId,
         @pipelineId, @priority, @severity, @labels, @assignee, @reporter, @source,
         @originSessionKey, @dueDate, @startDate, 1, NULL,
         0, @now, @now, NULL
       )`,
    ).run({
      id,
      identifier,
      projectId: input.projectId,
      type: input.type,
      title: input.title.trim(),
      body: input.body ?? '',
      status,
      stageId: input.stageId ?? null,
      pipelineId: input.pipelineId ?? null,
      priority,
      severity: input.severity ?? null,
      labels: stringifyJsonArray(input.labels ?? []),
      assignee: input.assignee ?? null,
      reporter: input.reporter,
      source,
      originSessionKey: input.originSessionKey ?? null,
      dueDate: input.dueDate ?? null,
      startDate: input.startDate ?? null,
      now,
    })
    return getTicket(db, id) as Ticket
  })

  let lastErr: unknown
  for (let attempt = 0; attempt < IDENTIFIER_RETRIES; attempt++) {
    try {
      return insert.immediate()
    } catch (err) {
      lastErr = err
      if (!isUniqueConstraint(err)) throw err
    }
  }
  throw lastErr
}

export function getTicket(db: TaskboardDb, id: string): Ticket | null {
  const row = db.prepare(`SELECT ${TICKET_COLS} FROM tb_ticket WHERE id = ?`).get(id) as
    | TicketRow
    | undefined
  return row ? mapTicket(row) : null
}

export function getTicketByIdentifier(db: TaskboardDb, identifier: string): Ticket | null {
  const row = db
    .prepare(`SELECT ${TICKET_COLS} FROM tb_ticket WHERE identifier = ?`)
    .get(identifier) as TicketRow | undefined
  return row ? mapTicket(row) : null
}

/** 按内部 id 或 identifier(如 OCV5-42)取单。 */
export function getTicketByIdOrIdentifier(db: TaskboardDb, idOrIdent: string): Ticket | null {
  return getTicket(db, idOrIdent) ?? getTicketByIdentifier(db, idOrIdent)
}

export function listTickets(
  db: TaskboardDb,
  query: TicketListQuery = {},
): { items: Ticket[]; total: number } {
  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (query.projectId) {
    where.push('project_id = @projectId')
    params.projectId = query.projectId
  }
  if (query.status) {
    const statuses = Array.isArray(query.status) ? query.status : [query.status]
    where.push(`status IN (${statuses.map((_, i) => `@st${i}`).join(', ')})`)
    statuses.forEach((s, i) => {
      params[`st${i}`] = s
    })
  }
  if (query.type) {
    const types = Array.isArray(query.type) ? query.type : [query.type]
    where.push(`type IN (${types.map((_, i) => `@ty${i}`).join(', ')})`)
    types.forEach((t, i) => {
      params[`ty${i}`] = t
    })
  }
  if (query.priority) {
    where.push('priority = @priority')
    params.priority = query.priority
  }
  if (query.assignee) {
    where.push('assignee = @assignee')
    params.assignee = query.assignee
  }
  if (query.stageId) {
    where.push('stage_id = @stageId')
    params.stageId = query.stageId
  }
  if (query.q) {
    where.push('(title LIKE @q OR identifier LIKE @q OR body LIKE @q)')
    params.q = `%${query.q}%`
  }
  if (query.label) {
    // labels 是 JSON TEXT,用 LIKE 做包含匹配(标签名不含 " 即可)
    where.push('labels LIKE @label')
    params.label = `%"${query.label}"%`
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM tb_ticket ${whereSql}`).get(params) as { n: number }
  ).n

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const offset = Math.max(query.offset ?? 0, 0)
  const rows = db
    .prepare(
      `SELECT ${TICKET_COLS} FROM tb_ticket ${whereSql}
        ORDER BY updated_at DESC
        LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as TicketRow[]

  return { items: rows.map(mapTicket), total }
}

/**
 * 项目内非终态票据按 type 计数。看板未指定 ticketType 时选「积压最多的类型」。
 */
export function countNonTerminalTicketsByType(
  db: TaskboardDb,
  projectId: string,
): Record<TicketType, number> {
  const counts: Record<TicketType, number> = { bug: 0, feature: 0, spike: 0, chore: 0 }
  const rows = db
    .prepare(
      `SELECT type, COUNT(*) AS n FROM tb_ticket
        WHERE project_id = ?
          AND status NOT IN ('done', 'canceled')
        GROUP BY type`,
    )
    .all(projectId) as { type: TicketType; n: number }[]
  for (const row of rows) {
    if (row.type in counts) counts[row.type] = row.n
  }
  return counts
}

/**
 * 带乐观锁的写。expectedVersion 必须等于当前 version,否则抛
 * TaskboardVersionConflict。成功后 version+1。
 */
export function updateTicket(
  db: TaskboardDb,
  id: string,
  expectedVersion: number,
  patch: UpdateTicketPatch,
): Ticket {
  const existing = getTicket(db, id)
  if (!existing) throw new TaskboardNotFound('ticket', id)
  if (existing.version !== expectedVersion) {
    throw new TaskboardVersionConflict(id, expectedVersion, existing.version)
  }
  if (patch.status) assertEnum(patch.status, TICKET_STATUSES, 'status')
  if (patch.priority) assertEnum(patch.priority, TICKET_PRIORITIES, 'priority')

  const now = nowMs()
  const result = db
    .prepare(
      `UPDATE tb_ticket SET
         title = @title,
         body = @body,
         status = @status,
         stage_id = @stageId,
         pipeline_id = @pipelineId,
         priority = @priority,
         severity = @severity,
         labels = @labels,
         assignee = @assignee,
         blocked_reason = @blockedReason,
         stage_loop_count = @stageLoopCount,
         due_date = @dueDate,
         start_date = @startDate,
         closed_at = @closedAt,
         version = version + 1,
         updated_at = @now
       WHERE id = @id AND version = @expectedVersion`,
    )
    .run({
      id,
      expectedVersion,
      title: patch.title ?? existing.title,
      body: patch.body ?? existing.body,
      status: patch.status ?? existing.status,
      stageId: patch.stageId === undefined ? existing.stageId : patch.stageId,
      pipelineId: patch.pipelineId === undefined ? existing.pipelineId : patch.pipelineId,
      priority: patch.priority ?? existing.priority,
      severity: patch.severity === undefined ? existing.severity : patch.severity,
      labels: stringifyJsonArray(patch.labels ?? existing.labels),
      assignee: patch.assignee === undefined ? existing.assignee : patch.assignee,
      blockedReason:
        patch.blockedReason === undefined ? existing.blockedReason : patch.blockedReason,
      stageLoopCount: patch.stageLoopCount ?? existing.stageLoopCount,
      dueDate: patch.dueDate === undefined ? existing.dueDate : patch.dueDate,
      startDate: patch.startDate === undefined ? existing.startDate : patch.startDate,
      closedAt: patch.closedAt === undefined ? existing.closedAt : patch.closedAt,
      now,
    })

  if (result.changes === 0) {
    const again = getTicket(db, id)
    if (!again) throw new TaskboardNotFound('ticket', id)
    throw new TaskboardVersionConflict(id, expectedVersion, again.version)
  }
  return getTicket(db, id) as Ticket
}
