// TicketActivity DAO — 审计流水。谁在什么时候改了什么。
//
// 只追加、不改、不删。前端时间线把 activity + run + comment 混排,
// 本表是「字段变更 / 状态转移 / 关系增删」的权威记录。

import type { Actor, TicketActivity } from '../domain.js'
import { type TaskboardDb, TaskboardNotFound, newId, nowMs } from './schema.js'

interface ActivityRow {
  id: string
  ticket_id: string
  actor: Actor
  actor_id: string
  action: string
  field: string | null
  from_value: string | null
  to_value: string | null
  created_at: number
}

const ACTIVITY_COLS = `
  id, ticket_id, actor, actor_id, action, field, from_value, to_value, created_at
`

function mapActivity(row: ActivityRow): TicketActivity {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    actor: row.actor,
    actorId: row.actor_id,
    action: row.action,
    field: row.field,
    fromValue: row.from_value,
    toValue: row.to_value,
    createdAt: row.created_at,
  }
}

export interface CreateActivityInput {
  ticketId: string
  actor: Actor
  actorId: string
  action: string
  field?: string | null
  fromValue?: string | null
  toValue?: string | null
}

export function createActivity(db: TaskboardDb, input: CreateActivityInput): TicketActivity {
  const ticket = db.prepare('SELECT id FROM tb_ticket WHERE id = ?').get(input.ticketId) as
    | { id: string }
    | undefined
  if (!ticket) throw new TaskboardNotFound('ticket', input.ticketId)

  const id = newId()
  const createdAt = nowMs()
  db.prepare(
    `INSERT INTO tb_ticket_activity (
       id, ticket_id, actor, actor_id, action, field, from_value, to_value, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.ticketId,
    input.actor,
    input.actorId,
    input.action,
    input.field ?? null,
    input.fromValue ?? null,
    input.toValue ?? null,
    createdAt,
  )
  return getActivity(db, id) as TicketActivity
}

export function getActivity(db: TaskboardDb, id: string): TicketActivity | null {
  const row = db.prepare(`SELECT ${ACTIVITY_COLS} FROM tb_ticket_activity WHERE id = ?`).get(id) as
    | ActivityRow
    | undefined
  return row ? mapActivity(row) : null
}

export function listActivities(
  db: TaskboardDb,
  ticketId: string,
  opts: { limit?: number; offset?: number } = {},
): TicketActivity[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)
  const rows = db
    .prepare(
      `SELECT ${ACTIVITY_COLS} FROM tb_ticket_activity
        WHERE ticket_id = ?
        ORDER BY created_at ASC
        LIMIT ? OFFSET ?`,
    )
    .all(ticketId, limit, offset) as ActivityRow[]
  return rows.map(mapActivity)
}
