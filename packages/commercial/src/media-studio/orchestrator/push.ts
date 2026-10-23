// OCV5-591 A2-1c-2 — studio activity pushed to the browser as `sys.studio_event` (backend plan
// §push). studio_events is already the activity log; each master slot reads new rows and delivers
// them to the users connected to *that* slot. Both slots run the pump, each for its own
// connections, so a user gets one copy wherever they are connected — no cross-slot fan-out and no
// leader election needed. The web keeps polling as the fallback (a push is a hint to reload).

import type { Pool, QueryResult } from 'pg'

import type { Logger } from '../../logging/logger.js'

export const PUSH_EVERY_MS = 1_500
const BATCH = 200

export interface StudioEventFrame {
  type: 'sys.studio_event'
  projectId: string
  /** The project's status after this event (the web refreshes its view on any frame anyway). */
  status: string
  event: { id: string; type: string; ts: string; message: string | null }
}

interface Row {
  id: string
  project_id: string
  user_id: string
  status: string
  type: string
  ts: Date
  message: string | null
}

export function toFrame(r: Row): StudioEventFrame {
  return {
    type: 'sys.studio_event',
    projectId: r.project_id,
    status: r.status,
    event: { id: r.id, type: r.type, ts: r.ts.toISOString(), message: r.message },
  }
}

/**
 * Starts the pump from the newest event at boot (history is read through the REST view). Returns
 * a stop function. `send` delivers to this slot's connections of that user.
 */
export function startStudioEventPump(input: {
  pool: Pool
  send: (userId: bigint, frame: StudioEventFrame) => void
  log: Logger
  everyMs?: number
}): () => void {
  let cursor: string | null = null
  let stopped = false
  let busy = false
  const tick = async () => {
    if (stopped || busy) return
    busy = true
    try {
      if (cursor === null) {
        const r = await input.pool.query<{ id: string }>(
          'SELECT COALESCE(MAX(id), 0)::text AS id FROM studio_events',
        )
        cursor = r.rows[0]!.id
        return
      }
      for (;;) {
        const r: QueryResult<Row> = await input.pool.query<Row>(
          `SELECT e.id::text AS id, e.project_id::text AS project_id, p.user_id::text AS user_id, p.status,
                  e.type, e.ts, e.payload->>'message' AS message
             FROM studio_events e JOIN studio_projects p ON p.id = e.project_id
            WHERE e.id > $1::bigint AND p.deleted_at IS NULL
            ORDER BY e.id LIMIT $2`,
          [cursor, BATCH],
        )
        for (const row of r.rows) {
          try {
            input.send(BigInt(row.user_id), toFrame(row))
          } catch (err) {
            input.log.warn('studio_push_send_failed', { err: err as Error })
          }
        }
        if (r.rows.length) cursor = r.rows.at(-1)!.id
        if (r.rows.length < BATCH) break
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
