// OCV5-591 A2-1b-2 — the annotation API (plan §2.1): drafts on a take of the caller's project,
// send (→ interpret), apply / reject what the agent understood. Every call is one transaction on
// the caller's own project; ids from the body are only ever looked up inside that project.

import type { Pool, PoolClient } from 'pg'

import { HttpError } from '../../http/util.js'
import { enqueueStudioTask } from '../queue.js'
import { appendStudioEvent } from '../store.js'
import type { AdvanceDeps } from './advance.js'
import { executeAnnotation } from './annotate.js'

export const MAX_ANNOTATIONS_PER_PROJECT = 500
/** Interpret calls a project runs at once (plan §2.3); more wait their turn. */
export const MAX_INTERPRET_INFLIGHT = 2
const MAX_MS = 3_600_000

const TARGET_OF: Record<string, 'shot' | 'line' | 'music' | 'final' | 'asset'> = {
  shot_frame: 'shot',
  shot_video: 'shot',
  line: 'line',
  music: 'music',
  final: 'final',
  bible: 'asset',
}

const notFound = () => new HttpError(404, 'NOT_FOUND', 'not found')
const bad = (m: string) => new HttpError(400, 'BAD_REQUEST', m)

async function inTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    const out = await fn(c)
    await c.query('COMMIT')
    return out
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    c.release()
  }
}

interface Fields {
  kind: 'point' | 'box' | 'range' | 'text'
  tStartMs: number | null
  tEndMs: number | null
  geom: { x: number; y: number; w?: number; h?: number } | null
  text: string
}

const unit = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
const ms = (v: unknown, name: string): number | null => {
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_MS)
    throw bad(`${name} must be an integer 0..${MAX_MS}`)
  return v
}

/** Shape and range checks shared by create and patch. */
export function validateFields(body: Record<string, unknown>): Fields {
  const kind = body.kind
  if (kind !== 'point' && kind !== 'box' && kind !== 'range' && kind !== 'text')
    throw bad('kind must be point, box, range or text')
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (text.length > 1000) throw bad('text is at most 1000 characters')
  const tStartMs = ms(body.tStartMs, 'tStartMs')
  const tEndMs = ms(body.tEndMs, 'tEndMs')
  if (tEndMs !== null && (tStartMs === null || tEndMs < tStartMs))
    throw bad('tEndMs before tStartMs')
  if (kind === 'range' && (tStartMs === null || tEndMs === null))
    throw bad('a range needs tStartMs and tEndMs')
  let geom: Fields['geom'] = null
  const g = body.geom as Record<string, unknown> | undefined
  if (kind === 'point' || kind === 'box') {
    if (!g || !unit(g.x) || !unit(g.y)) throw bad('geom.x / geom.y must be 0..1')
    geom = { x: g.x as number, y: g.y as number }
    if (kind === 'box') {
      if (!unit(g.w) || !unit(g.h) || (g.w as number) <= 0 || (g.h as number) <= 0)
        throw bad('geom.w / geom.h must be 0..1')
      if ((g.x as number) + (g.w as number) > 1.001 || (g.y as number) + (g.h as number) > 1.001)
        throw bad('the box leaves the frame')
      geom = { ...geom, w: g.w as number, h: g.h as number }
    }
  }
  return { kind, tStartMs, tEndMs, geom, text }
}

async function ownedProject(c: PoolClient, userId: string, projectId: string) {
  const r = await c.query<{ status: string }>(
    'SELECT status FROM studio_projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE',
    [projectId, userId],
  )
  if (!r.rows[0]) throw notFound()
  return r.rows[0].status
}

async function ownedAnnotation(c: PoolClient, userId: string, id: string) {
  const r = await c.query<{
    project_id: string
    status: string
    interpretation: Record<string, unknown> | null
  }>(
    `SELECT a.project_id::text AS project_id, a.status, a.interpretation
       FROM studio_annotations a JOIN studio_projects p ON p.id = a.project_id
      WHERE a.id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL
      FOR UPDATE OF a, p`,
    [id, userId],
  )
  if (!r.rows[0]) throw notFound()
  return r.rows[0]
}

export function makeAnnotationApi(
  pool: Pool,
  deps: AdvanceDeps | undefined,
  kick: (id: string) => void,
) {
  return {
    async create(userId: string, projectId: string, body: Record<string, unknown>) {
      const f = validateFields(body)
      const takeId = typeof body.takeId === 'string' ? body.takeId : ''
      return inTx(pool, async (c) => {
        const status = await ownedProject(c, userId, projectId)
        if (['canceled', 'failed'].includes(status))
          throw new HttpError(409, 'STUDIO_BAD_TRANSITION', `cannot annotate a ${status} project`)
        const t = (
          await c.query<{ owner_kind: string; owner_id: string; status: string }>(
            'SELECT owner_kind, owner_id::text AS owner_id, status FROM studio_takes WHERE id = $1 AND project_id = $2',
            [takeId, projectId],
          )
        ).rows[0]
        if (!t || t.status !== 'succeeded' || !TARGET_OF[t.owner_kind])
          throw bad('takeId must be a finished take of this project')
        const n = await c.query<{ n: string }>(
          'SELECT COUNT(*)::text AS n FROM studio_annotations WHERE project_id = $1',
          [projectId],
        )
        if (Number(n.rows[0]!.n) >= MAX_ANNOTATIONS_PER_PROJECT)
          throw new HttpError(409, 'ANNOTATION_LIMIT', 'too many annotations on this project')
        const r = await c.query<{ id: string }>(
          `INSERT INTO studio_annotations(id, project_id, target_kind, target_id, take_id, author, kind,
                                          t_start_ms, t_end_ms, geom, text, status)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'user', $5, $6, $7, $8::jsonb, $9, 'draft')
           RETURNING id::text AS id`,
          [
            projectId,
            TARGET_OF[t.owner_kind],
            t.owner_id,
            takeId,
            f.kind,
            f.tStartMs,
            f.tEndMs,
            f.geom ? JSON.stringify(f.geom) : null,
            f.text,
          ],
        )
        return { id: r.rows[0]!.id }
      })
    },

    async update(userId: string, id: string, body: Record<string, unknown>) {
      const f = validateFields(body)
      await inTx(pool, async (c) => {
        const a = await ownedAnnotation(c, userId, id)
        if (a.status !== 'draft')
          throw new HttpError(409, 'ANNOTATION_NOT_DRAFT', 'only a draft can be changed')
        await c.query(
          'UPDATE studio_annotations SET kind = $2, t_start_ms = $3, t_end_ms = $4, geom = $5::jsonb, text = $6 WHERE id = $1',
          [id, f.kind, f.tStartMs, f.tEndMs, f.geom ? JSON.stringify(f.geom) : null, f.text],
        )
      })
    },

    async remove(userId: string, id: string) {
      await inTx(pool, async (c) => {
        const a = await ownedAnnotation(c, userId, id)
        if (a.status !== 'draft')
          throw new HttpError(409, 'ANNOTATION_NOT_DRAFT', 'only a draft can be deleted')
        await c.query('DELETE FROM studio_annotations WHERE id = $1', [id])
      })
    },

    /** draft → sent (or a sent one the agent did not get, again): interpret it. */
    async send(userId: string, id: string) {
      const projectId = await inTx(pool, async (c) => {
        const a = await ownedAnnotation(c, userId, id)
        const status = await ownedProject(c, userId, a.project_id)
        if (['canceled', 'failed', 'draft', 'planning'].includes(status))
          throw new HttpError(
            409,
            'STUDIO_BAD_TRANSITION',
            `cannot send an annotation while the project is ${status}`,
          )
        const again =
          a.status === 'sent' && a.interpretation?.op === null && !a.interpretation?.execution
        if (a.status !== 'draft' && !again)
          throw new HttpError(409, 'ANNOTATION_NOT_DRAFT', 'this annotation was already sent')
        const sent = await c.query<{ n: string }>(
          `UPDATE studio_annotations SET status = 'sent', interpretation = NULL
            WHERE id = $1 AND length(text) > 0 RETURNING
              (SELECT COUNT(*) FROM studio_tasks WHERE kind = 'interpret' AND payload->>'annotationId' = $1)::text AS n`,
          [id],
        )
        if (!sent.rows[0]) throw new HttpError(400, 'BAD_REQUEST', 'write what should change first')
        const inflight = await c.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM studio_tasks WHERE project_id = $1 AND kind = 'interpret' AND status IN ('queued','leased')`,
          [a.project_id],
        )
        await enqueueStudioTask(c, {
          projectId: a.project_id,
          kind: 'interpret',
          idempotencyKey: `interpret:${id}:${sent.rows[0].n}`,
          payload: { annotationId: id },
          runAfterSeconds: Number(inflight.rows[0]!.n) >= MAX_INTERPRET_INFLIGHT ? 15 : 0,
        })
        await appendStudioEvent(c, a.project_id, 'annotation.sent', {
          annotationId: id,
          message: '批注已交给导演 agent。',
        })
        return a.project_id
      })
      kick(projectId)
    },

    /** The user confirms what the agent understood (same one-time execution as auto-apply). */
    async apply(userId: string, id: string) {
      if (!deps)
        throw new HttpError(503, 'STUDIO_ORCHESTRATOR_OFF', 'the director agent is not running')
      const projectId = await inTx(pool, async (c) => {
        const a = await ownedAnnotation(c, userId, id)
        await ownedProject(c, userId, a.project_id)
        const out = await executeAnnotation(c, deps, a.project_id, id)
        if (out === false)
          throw new HttpError(
            409,
            'ANNOTATION_BUSY',
            'this annotation is running or has nothing to apply',
          )
        return a.project_id
      })
      kick(projectId)
    },

    async reject(userId: string, id: string) {
      await inTx(pool, async (c) => {
        const a = await ownedAnnotation(c, userId, id)
        const r = await c.query(
          `UPDATE studio_annotations SET status = 'rejected'
            WHERE id = $1 AND status = 'sent'
              AND (interpretation->'execution' IS NULL OR interpretation->'execution'->>'state' = 'failed')`,
          [id],
        )
        if (!r.rowCount)
          throw new HttpError(
            409,
            'ANNOTATION_BUSY',
            'this annotation is running or already settled',
          )
        await appendStudioEvent(c, a.project_id, 'annotation.rejected', { annotationId: id })
      })
    },
  }
}

export type AnnotationApi = ReturnType<typeof makeAnnotationApi>
