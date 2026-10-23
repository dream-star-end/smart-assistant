import { createHash } from 'node:crypto'
import type { TicketActivity, TicketComment, TicketRun } from '../domain.js'
import { listActivitiesByIdsForTicket } from './activity.js'
import { listCommentsByIdsForTicket } from './comments.js'
import { listRunsByIdsForTicket } from './runs.js'
import { type TaskboardDb, TaskboardValidationError } from './schema.js'

export type TimelineKey = { createdAt: number; kind: 'activity' | 'comment' | 'run'; id: string }
export type TicketTimelineItem =
  | { kind: 'activity'; createdAt: number; activity: TicketActivity }
  | { kind: 'comment'; createdAt: number; comment: TicketComment }
  | { kind: 'run'; createdAt: number; run: TicketRun }
export type TicketTimelinePage = {
  window: 'latest-v1'
  items: TicketTimelineItem[]
  hasMore: boolean
  nextBefore: string | null
  head: string | null
  unchanged: boolean
}
const sources = [
  { table: 'tb_ticket_activity', kind: 'activity', rank: 0 },
  { table: 'tb_ticket_comment', kind: 'comment', rank: 1 },
  { table: 'tb_ticket_run', kind: 'run', rank: 2 },
] as const
const rank = { activity: 0, comment: 1, run: 2 }
function compare(a: TimelineKey, b: TimelineKey): number {
  return (
    a.createdAt - b.createdAt ||
    rank[a.kind] - rank[b.kind] ||
    Buffer.compare(Buffer.from(a.id), Buffer.from(b.id))
  )
}
function encode(ticketId: string, key: TimelineKey): string {
  return Buffer.from(JSON.stringify({ v: 1, ticketId, ...key })).toString('base64url')
}
function decode(ticketId: string, value: string): TimelineKey {
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('cursor')
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (
      parsed.v !== 1 ||
      parsed.ticketId !== ticketId ||
      !Number.isSafeInteger(parsed.createdAt) ||
      parsed.createdAt < 0 ||
      !Object.hasOwn(rank, parsed.kind) ||
      typeof parsed.id !== 'string' ||
      !parsed.id ||
      parsed.id.length > 256
    )
      throw new Error('cursor')
    return { createdAt: parsed.createdAt, kind: parsed.kind, id: parsed.id }
  } catch {
    throw new TaskboardValidationError('invalid timeline cursor for this ticket')
  }
}

function windowRevision(ticketId: string, keys: TimelineKey[], hasMore: boolean): string {
  const revision = createHash('sha256').update(JSON.stringify({ hasMore, keys })).digest('hex')
  return Buffer.from(JSON.stringify({ v: 1, ticketId, revision })).toString('base64url')
}
function validateRevision(ticketId: string, value: string): void {
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('revision')
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (
      parsed.v !== 1 ||
      parsed.ticketId !== ticketId ||
      typeof parsed.revision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.revision)
    )
      throw new Error('revision')
  } catch {
    throw new TaskboardValidationError('invalid timeline revision for this ticket')
  }
}

/** Three bounded key queries, then at most one payload query per source. No DDL. */
export function listTicketTimelinePage(
  db: TaskboardDb,
  ticketId: string,
  options: { limit?: number; before?: string | null; ifHead?: string | null } = {},
): TicketTimelinePage {
  const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)))
  if (!Number.isFinite(limit)) throw new TaskboardValidationError('invalid timeline limit')
  const before = options.before ? decode(ticketId, options.before) : null
  if (options.ifHead) validateRevision(ticketId, options.ifHead)
  return db.transaction(() => {
    const keys: TimelineKey[] = []
    for (const source of sources) {
      const rows = db
        .prepare(`SELECT id, created_at AS createdAt ${source.kind === 'run' ? ', json_array(status, finished_at, duration_ms, tokens_in, tokens_out, cost_usd, cost_imprecise, output_md IS NOT NULL) AS revision' : ''} FROM ${source.table}
        WHERE ticket_id = @ticketId ${before ? `AND (created_at < @at OR (created_at = @at AND (@rank < @beforeRank OR (@rank = @beforeRank AND id < @id))))` : ''}
        ORDER BY created_at DESC, id DESC LIMIT @take`)
        .all({
          ticketId,
          take: limit + 1,
          ...(before
            ? {
                at: before.createdAt,
                rank: source.rank,
                beforeRank: rank[before.kind],
                id: before.id,
              }
            : {}),
        }) as Array<{ id: string; createdAt: number }>
      keys.push(...rows.map((row) => ({ ...row, kind: source.kind })))
    }
    keys.sort((a, b) => compare(b, a))
    const selected = keys.slice(0, limit)
    const hasMore = keys.length > limit
    const head = windowRevision(ticketId, selected, hasMore)
    const last = selected.at(-1)
    const nextBefore = hasMore && last ? encode(ticketId, last) : null
    // Include lightweight run state in the revision so late output and reference
    // usage updates invalidate the window without reading long payloads unchanged.
    if (!before && head && head === options.ifHead)
      return { window: 'latest-v1' as const, items: [], head, hasMore, nextBefore, unchanged: true }
    const activity = new Map(
      listActivitiesByIdsForTicket(
        db,
        ticketId,
        selected.filter((key) => key.kind === 'activity').map((key) => key.id),
      ).map((row) => [row.id, row]),
    )
    const comment = new Map(
      listCommentsByIdsForTicket(
        db,
        ticketId,
        selected.filter((key) => key.kind === 'comment').map((key) => key.id),
      ).map((row) => [row.id, row]),
    )
    const run = new Map(
      listRunsByIdsForTicket(
        db,
        ticketId,
        selected.filter((key) => key.kind === 'run').map((key) => key.id),
      ).map((row) => [row.id, row]),
    )
    const items: TicketTimelineItem[] = selected.reverse().map((key) => {
      if (key.kind === 'activity')
        return { kind: 'activity', createdAt: key.createdAt, activity: activity.get(key.id)! }
      if (key.kind === 'comment')
        return { kind: 'comment', createdAt: key.createdAt, comment: comment.get(key.id)! }
      return { kind: 'run', createdAt: key.createdAt, run: run.get(key.id)! }
    })
    return { window: 'latest-v1' as const, items, hasMore, nextBefore, head, unchanged: false }
  })()
}
