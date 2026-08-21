// TicketComment DAO — 人 / agent / system 共用评论。
// agent 巡检结论也可以落这里(runId 指向产生它的那次 run)。

import type { AuthorKind, TicketComment } from '../domain.js'
import { AUTHOR_KINDS } from '../domain.js'
import {
  type TaskboardDb,
  TaskboardNotFound,
  TaskboardValidationError,
  newId,
  nowMs,
} from './schema.js'

interface CommentRow {
  id: string
  ticket_id: string
  author_kind: AuthorKind
  author: string
  body: string
  run_id: string | null
  created_at: number
}

const COMMENT_COLS = 'id, ticket_id, author_kind, author, body, run_id, created_at'

function mapComment(row: CommentRow): TicketComment {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    authorKind: row.author_kind,
    author: row.author,
    body: row.body,
    runId: row.run_id,
    createdAt: row.created_at,
  }
}

export interface CreateCommentInput {
  ticketId: string
  authorKind: AuthorKind
  author: string
  body: string
  runId?: string | null
}

export function createComment(db: TaskboardDb, input: CreateCommentInput): TicketComment {
  if (!AUTHOR_KINDS.includes(input.authorKind)) {
    throw new TaskboardValidationError(`invalid authorKind: ${input.authorKind}`)
  }
  if (!input.body.trim()) {
    throw new TaskboardValidationError('comment body is required')
  }
  const ticket = db.prepare('SELECT id FROM tb_ticket WHERE id = ?').get(input.ticketId) as
    | { id: string }
    | undefined
  if (!ticket) throw new TaskboardNotFound('ticket', input.ticketId)

  const id = newId()
  const createdAt = nowMs()
  db.prepare(
    `INSERT INTO tb_ticket_comment (
       id, ticket_id, author_kind, author, body, run_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.ticketId,
    input.authorKind,
    input.author,
    input.body,
    input.runId ?? null,
    createdAt,
  )
  return getComment(db, id) as TicketComment
}

export function getComment(db: TaskboardDb, id: string): TicketComment | null {
  const row = db.prepare(`SELECT ${COMMENT_COLS} FROM tb_ticket_comment WHERE id = ?`).get(id) as
    | CommentRow
    | undefined
  return row ? mapComment(row) : null
}

export function listComments(
  db: TaskboardDb,
  ticketId: string,
  opts: { limit?: number; offset?: number } = {},
): TicketComment[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)
  const rows = db
    .prepare(
      `SELECT ${COMMENT_COLS} FROM tb_ticket_comment
        WHERE ticket_id = ?
        ORDER BY created_at ASC
        LIMIT ? OFFSET ?`,
    )
    .all(ticketId, limit, offset) as CommentRow[]
  return rows.map(mapComment)
}
