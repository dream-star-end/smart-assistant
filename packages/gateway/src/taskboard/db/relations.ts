// TicketRelation DAO — parent / blocks / related。
//
// 约束(服务端强制,不是君子协定):
//   - 一律禁止跨项目;
//   - parent:from=子 to=父,一个 ticket 只能有一个 parent(部分唯一索引兜底);
//   - parent / blocks:加边前做同 kind 有向可达性检查,能走到自己就拒(防环);
//   - related:无向,写入时把较小 id 放 from,UNIQUE(from,to,kind) 去重。
//
// 坑:
//   - 自环(from===to)直接当环,不要等 BFS。
//   - related 归一化后 (A,B) 与 (B,A) 是同一条,查询时两边都要能查到。
//   - 防环只在同 kind 图上走,parent 边不影响 blocks 图。

import type { RelationKind, TicketRelation } from '../domain.js'
import { RELATION_KINDS } from '../domain.js'
import {
  TaskboardCrossProjectError,
  TaskboardCycleError,
  type TaskboardDb,
  TaskboardDuplicateRelationError,
  TaskboardNotFound,
  TaskboardSingleParentError,
  TaskboardValidationError,
  newId,
  nowMs,
} from './schema.js'

interface RelationRow {
  id: string
  from_ticket_id: string
  to_ticket_id: string
  kind: RelationKind
  created_at: number
}

const REL_COLS = 'id, from_ticket_id, to_ticket_id, kind, created_at'

function mapRelation(row: RelationRow): TicketRelation {
  return {
    id: row.id,
    fromTicketId: row.from_ticket_id,
    toTicketId: row.to_ticket_id,
    kind: row.kind,
    createdAt: row.created_at,
  }
}

function getTicketProject(db: TaskboardDb, ticketId: string): string {
  const row = db.prepare('SELECT project_id FROM tb_ticket WHERE id = ?').get(ticketId) as
    | { project_id: string }
    | undefined
  if (!row) throw new TaskboardNotFound('ticket', ticketId)
  return row.project_id
}

function canReach(db: TaskboardDb, startId: string, targetId: string, kind: RelationKind): boolean {
  const stmt = db.prepare(
    `SELECT to_ticket_id FROM tb_ticket_relation
      WHERE from_ticket_id = ? AND kind = ?`,
  )
  const seen = new Set<string>()
  const queue = [startId]
  while (queue.length > 0) {
    const cur = queue.pop() as string
    if (cur === targetId) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    const next = stmt.all(cur, kind) as { to_ticket_id: string }[]
    for (const row of next) queue.push(row.to_ticket_id)
  }
  return false
}

function normalizePair(
  kind: RelationKind,
  fromTicketId: string,
  toTicketId: string,
): { from: string; to: string } {
  if (kind !== 'related') return { from: fromTicketId, to: toTicketId }
  return fromTicketId < toTicketId
    ? { from: fromTicketId, to: toTicketId }
    : { from: toTicketId, to: fromTicketId }
}

export interface AddRelationInput {
  fromTicketId: string
  toTicketId: string
  kind: RelationKind
}

export function addRelation(db: TaskboardDb, input: AddRelationInput): TicketRelation {
  if (!RELATION_KINDS.includes(input.kind)) {
    throw new TaskboardValidationError(`invalid relation kind: ${input.kind}`)
  }
  if (input.fromTicketId === input.toTicketId) {
    throw new TaskboardCycleError(input.kind)
  }

  const fromProject = getTicketProject(db, input.fromTicketId)
  const toProject = getTicketProject(db, input.toTicketId)
  if (fromProject !== toProject) {
    throw new TaskboardCrossProjectError(input.fromTicketId, input.toTicketId)
  }

  const { from, to } = normalizePair(input.kind, input.fromTicketId, input.toTicketId)

  const insert = db.transaction(() => {
    if (input.kind === 'parent') {
      const existingParent = db
        .prepare(
          `SELECT id FROM tb_ticket_relation
            WHERE from_ticket_id = ? AND kind = 'parent'`,
        )
        .get(from) as { id: string } | undefined
      if (existingParent) throw new TaskboardSingleParentError(from)
    }

    if (input.kind === 'parent' || input.kind === 'blocks') {
      // 加 from→to 后成环 ⇔ to 已经能走到 from(或 to===from,上面已拒)
      if (canReach(db, to, from, input.kind)) {
        throw new TaskboardCycleError(input.kind)
      }
    }

    const dup = db
      .prepare(
        `SELECT id FROM tb_ticket_relation
          WHERE from_ticket_id = ? AND to_ticket_id = ? AND kind = ?`,
      )
      .get(from, to, input.kind) as { id: string } | undefined
    if (dup) throw new TaskboardDuplicateRelationError()

    const id = newId()
    const createdAt = nowMs()
    db.prepare(
      `INSERT INTO tb_ticket_relation (id, from_ticket_id, to_ticket_id, kind, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, from, to, input.kind, createdAt)
    return getRelation(db, id) as TicketRelation
  })

  try {
    return insert.immediate()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('idx_tb_rel_single_parent')) {
      throw new TaskboardSingleParentError(from)
    }
    if (msg.includes('UNIQUE constraint failed') && msg.includes('tb_ticket_relation')) {
      throw new TaskboardDuplicateRelationError()
    }
    throw err
  }
}

export function getRelation(db: TaskboardDb, id: string): TicketRelation | null {
  const row = db.prepare(`SELECT ${REL_COLS} FROM tb_ticket_relation WHERE id = ?`).get(id) as
    | RelationRow
    | undefined
  return row ? mapRelation(row) : null
}

export function listRelations(db: TaskboardDb, ticketId: string): TicketRelation[] {
  const rows = db
    .prepare(
      `SELECT ${REL_COLS} FROM tb_ticket_relation
        WHERE from_ticket_id = ? OR to_ticket_id = ?
        ORDER BY created_at ASC`,
    )
    .all(ticketId, ticketId) as RelationRow[]
  return rows.map(mapRelation)
}

export function removeRelation(db: TaskboardDb, id: string): void {
  const result = db.prepare('DELETE FROM tb_ticket_relation WHERE id = ?').run(id)
  if (result.changes === 0) throw new TaskboardNotFound('relation', id)
}

export function removeRelationByEnds(
  db: TaskboardDb,
  fromTicketId: string,
  toTicketId: string,
  kind: RelationKind,
): void {
  const { from, to } = normalizePair(kind, fromTicketId, toTicketId)
  const result = db
    .prepare(
      `DELETE FROM tb_ticket_relation
        WHERE from_ticket_id = ? AND to_ticket_id = ? AND kind = ?`,
    )
    .run(from, to, kind)
  if (result.changes === 0) throw new TaskboardNotFound('relation', `${kind}:${from}->${to}`)
}
