// OCV5-591 A2-1c-2 — studio activity pushed to the browser as `sys.studio_event` (backend plan
// §push). studio_events is already the activity log; each master slot reads new rows and delivers
// them to the users connected to *that* slot. Both slots run the pump, each for its own
// connections, so a user gets one copy wherever they are connected — no cross-slot fan-out and no
// leader election needed. The web keeps polling as the fallback (a push is a hint to reload) and
// reloads the view whenever its socket opens, so what committed before a connection is not needed.

import type { Pool, QueryResult } from 'pg'

import type { Logger } from '../../logging/logger.js'

export const PUSH_EVERY_MS = 1_500
const BATCH = 200
/**
 * Ids are not committed in order (code r1 P1): a lower id can still be in flight when a higher one
 * is read. Missing ids below the cursor are re-checked until they show up or this long has passed
 * (a rolled-back insert never shows up; anything slower is caught by the web's poll).
 */
export const GAP_TTL_MS = 120_000
const MAX_GAPS = 1_000

export interface StudioEventFrame {
  type: 'sys.studio_event'
  projectId: string
  /** The project's status after this event (the web refreshes its view on any frame anyway). */
  status: string
  event: { id: string; type: string; ts: string; message: string | null; payload?: Record<string, unknown> }
}

interface Row {
  id: string
  project_id: string
  user_id: string
  status: string
  type: string
  ts: Date
  message: string | null
  payload?: Record<string, unknown>
  live: boolean
}

export function toFrame(r: Omit<Row, 'live'>): StudioEventFrame {
  return {
    type: 'sys.studio_event',
    projectId: r.project_id,
    status: r.status,
    event: {
      id: r.id, type: r.type, ts: r.ts.toISOString(), message: r.message,
      ...(r.type === 'plan.delta' ? { payload: r.payload } : {}),
    },
  }
}

const SELECT = `SELECT e.id::text AS id, e.project_id::text AS project_id, p.user_id::text AS user_id,
                       p.status, e.type, e.ts, e.payload->>'message' AS message, e.payload,
                       (p.deleted_at IS NULL) AS live
                  FROM studio_events e JOIN studio_projects p ON p.id = e.project_id`

/**
 * Starts the pump from the newest event at boot (history is read through the REST view). Returns
 * a stop function. `send` delivers to this slot's connections of that user.
 */
export function startStudioEventPump(input: {
  pool: Pool
  send: (userId: bigint, frame: StudioEventFrame) => void
  log: Logger
  everyMs?: number
  now?: () => number
}): () => void {
  const now = input.now ?? Date.now
  let cursor: bigint | null = null
  /** Missing ids below the cursor → when they were first missed. */
  const gaps = new Map<string, number>()
  let stopped = false
  let busy = false
  const deliver = (row: Row) => {
    if (!row.live) return
    try {
      input.send(BigInt(row.user_id), toFrame(row))
    } catch (err) {
      input.log.warn('studio_push_send_failed', { err: err as Error })
    }
  }
  const tick = async () => {
    if (stopped || busy) return
    busy = true
    try {
      if (cursor === null) {
        const r = await input.pool.query<{ id: string }>(
          'SELECT COALESCE(MAX(id), 0)::text AS id FROM studio_events',
        )
        cursor = BigInt(r.rows[0]!.id)
        return
      }
      for (;;) {
        const r: QueryResult<Row> = await input.pool.query<Row>(
          `${SELECT} WHERE e.id > $1::bigint ORDER BY e.id LIMIT $2`,
          [cursor.toString(), BATCH],
        )
        for (const row of r.rows) {
          const id = BigInt(row.id)
          for (let missing = cursor + 1n; missing < id && gaps.size < MAX_GAPS; missing++)
            gaps.set(missing.toString(), now())
          cursor = id
          deliver(row)
        }
        if (r.rows.length < BATCH) break
      }
      if (gaps.size) {
        const late = await input.pool.query<Row>(`${SELECT} WHERE e.id = ANY($1::bigint[])`, [
          [...gaps.keys()],
        ])
        for (const row of late.rows) {
          gaps.delete(row.id)
          deliver(row)
        }
        const expired = now() - GAP_TTL_MS
        for (const [id, at] of gaps) if (at < expired) gaps.delete(id)
      }
    } catch (err) {
      input.log.warn('studio_push_failed', { err: err as Error })
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => void tick(), input.everyMs ?? PUSH_EVERY_MS)
  timer.unref?.()
  void tick()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
