// OCV5-591 A2-1b-2 — the interpret task (plan §2.2): the annotated frame (the box / point drawn on
// it) and the project's shots, lines and system voices go to Grok (platform-paid); the answer is
// stored per request id before use, checked against the whitelist and this project, written onto
// the annotation, and run straight away only for an autonomous project and a sure instruction.

import { copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import sharp from 'sharp'

import { MediaProviderError } from '../providers/types.js'
import { type StudioTask, finishStudioTask, retryStudioTask } from '../queue.js'
import { appendStudioEvent } from '../store.js'
import { executeAnnotation } from './annotate.js'
import type { ExecuteDeps } from './execute.js'
import {
  type InterpretContext,
  InterpretParseError,
  type Interpretation,
  autoApply,
  buildInterpretPrompt,
  parseInterpretation,
} from './interpret.js'
import { withLease } from './lease.js'

interface AnnotationRow {
  id: string
  project_id: string
  target_kind: InterpretContext['annotation']['targetKind']
  target_id: string
  take_id: string | null
  kind: InterpretContext['annotation']['kind']
  t_start_ms: number | null
  t_end_ms: number | null
  geom: InterpretContext['annotation']['geom']
  text: string
  status: string
  interpretation: unknown
  frame_blob_sha: string | null
}

const IMAGE_TAKES = new Set(['shot_frame', 'bible'])
const VIDEO_TAKES = new Set(['shot_video', 'final'])

/** The frame the user marked, with the mark drawn on it (null for audio / text-only targets). */
async function markedFrame(
  deps: ExecuteDeps,
  task: StudioTask,
  userId: bigint,
  a: AnnotationRow,
  take: { owner_kind: string; blob_sha: string | null; duration_ms: number | null } | null,
): Promise<Buffer | null> {
  if (!take?.blob_sha) return null
  let frame: Buffer | null = null
  if (IMAGE_TAKES.has(take.owner_kind)) {
    const f = await deps.blobs.open(userId, take.blob_sha)
    frame = f ? await readFile(f.path) : null
  } else if (VIDEO_TAKES.has(take.owner_kind) && deps.compose?.configured()) {
    const runner = deps.compose
    const job = `i-${task.id}-e${task.epoch}`
    try {
      const { inDir } = await runner.prepare(job)
      const f = await deps.blobs.open(userId, take.blob_sha)
      if (!f) return null
      await copyFile(f.path, join(inDir, 'clip.mp4'))
      const max = take.duration_ms && take.duration_ms > 100 ? take.duration_ms / 1000 - 0.05 : 0
      const at = Math.max(
        0,
        Math.min((a.t_start_ms ?? 0) / 1000, max || (a.t_start_ms ?? 0) / 1000),
      )
      const out = await runner.run(job, {
        op: 'frames',
        file: 'clip.mp4',
        times: [Math.round(at * 100) / 100],
      })
      const png = out.outputs.find((o) => o.name === 'frame-0.png')
      frame = png ? await readFile(png.path) : null
    } finally {
      await runner.cleanup(job).catch(() => {})
    }
  }
  if (!frame) return null
  // The mark is drawn at the size of the resized frame (code r1 P1: never larger than the base).
  const base = await sharp(frame)
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true })
  const w = base.info.width
  const h = base.info.height
  const g = a.geom
  const mark =
    a.kind === 'box' && g?.w && g.h
      ? `<rect x="${g.x * w}" y="${g.y * h}" width="${g.w * w}" height="${g.h * h}" fill="none" stroke="#ff2d2d" stroke-width="${Math.max(3, w / 300)}"/>`
      : a.kind === 'point' && g
        ? `<circle cx="${g.x * w}" cy="${g.y * h}" r="${Math.max(14, w / 40)}" fill="none" stroke="#ff2d2d" stroke-width="${Math.max(3, w / 300)}"/>`
        : ''
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${mark}</svg>`,
  )
  return sharp(base.data)
    .composite([{ input: svg, left: 0, top: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer()
}

async function context(
  deps: ExecuteDeps,
  a: AnnotationRow,
  take: { owner_kind: string; owner_id: string } | null,
): Promise<InterpretContext> {
  const [shots, lines, takes] = await Promise.all([
    deps.pool.query<{ id: string; ordinal: number; spec: Record<string, unknown> }>(
      'SELECT id::text AS id, ordinal, spec FROM studio_shots WHERE project_id = $1 ORDER BY ordinal',
      [a.project_id],
    ),
    deps.pool.query<{ id: string; shot_id: string | null; text: string }>(
      'SELECT id::text AS id, shot_id::text AS shot_id, text FROM studio_lines WHERE project_id = $1 ORDER BY ordinal',
      [a.project_id],
    ),
    take
      ? deps.pool.query<{ id: string; owner_kind: string; version: number }>(
          `SELECT id::text AS id, owner_kind, version FROM studio_takes
            WHERE project_id = $1 AND owner_id = $2 AND status = 'succeeded' AND blob_sha IS NOT NULL
            ORDER BY version DESC LIMIT 12`,
          [a.project_id, take.owner_id],
        )
      : Promise.resolve({ rows: [] as Array<{ id: string; owner_kind: string; version: number }> }),
  ])
  let start = 0
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const shotRows = shots.rows.map((s) => {
    const dur = Number(s.spec?.durationSec)
    const durationSec = Number.isFinite(dur) && dur > 0 ? dur : 5
    const row = {
      id: s.id,
      ordinal: s.ordinal,
      startSec: start,
      durationSec,
      ...(str(s.spec?.framing) ? { framing: str(s.spec.framing) } : {}),
      ...(str(s.spec?.action) ? { action: str(s.spec.action) } : {}),
    }
    start += durationSec
    return row
  })
  // The shot the annotation is about: its owner, a line's shot, or the shot at a film's time point.
  let shotId: string | null = null
  if (a.target_kind === 'shot') shotId = a.target_id
  else if (a.target_kind === 'line')
    shotId = lines.rows.find((l) => l.id === a.target_id)?.shot_id ?? null
  else if (a.target_kind === 'final') {
    const t = (a.t_start_ms ?? 0) / 1000
    shotId =
      shotRows.find((s) => t >= s.startSec && t < s.startSec + s.durationSec)?.id ??
      shotRows.at(-1)?.id ??
      null
  }
  const voices = await deps.systemVoices().catch(() => [])
  return {
    annotation: {
      text: a.text,
      kind: a.kind,
      targetKind: a.target_kind,
      tStartMs: a.t_start_ms,
      tEndMs: a.t_end_ms,
      geom: a.geom,
    },
    shotId,
    shots: shotRows,
    lines: lines.rows.map((l) => ({ id: l.id, shotId: l.shot_id, text: l.text })),
    voices: voices.map((v) => ({ voiceId: v.voiceId, name: v.name })),
    takes: takes.rows.map((t) => ({ id: t.id, ownerKind: t.owner_kind, version: t.version })),
  }
}

export async function runInterpret(deps: ExecuteDeps, task: StudioTask): Promise<void> {
  const annotationId = (task.payload as { annotationId?: unknown }).annotationId
  if (typeof annotationId !== 'string')
    throw new MediaProviderError('INVALID_TASK', false, 'interpret task has no annotation')
  const a = (
    await deps.pool.query<AnnotationRow>(
      `SELECT id::text AS id, project_id::text AS project_id, target_kind, target_id::text AS target_id,
              take_id::text AS take_id, kind, t_start_ms, t_end_ms, geom, text, status, interpretation, frame_blob_sha
         FROM studio_annotations WHERE id = $1 AND project_id = $2`,
      [annotationId, task.projectId],
    )
  ).rows[0]
  if (!a || a.status !== 'sent' || a.interpretation) {
    await withLease(deps.pool, task, (c) =>
      finishStudioTask(c, task, { status: 'done', error: 'nothing to interpret' }),
    )
    return
  }
  const p = (
    await deps.pool.query<{ user_id: string; autonomy: 'max' | 'confirm' }>(
      'SELECT user_id::text AS user_id, autonomy FROM studio_projects WHERE id = $1',
      [task.projectId],
    )
  ).rows[0]
  if (!p) throw new MediaProviderError('INVALID_TASK', false, 'project gone')
  const userId = BigInt(p.user_id)
  const take = a.take_id
    ? ((
        await deps.pool.query<{
          owner_kind: string
          owner_id: string
          blob_sha: string | null
          duration_ms: number | null
        }>(
          `SELECT owner_kind, owner_id::text AS owner_id, blob_sha, (meta->>'durationMs')::float8 AS duration_ms
             FROM studio_takes WHERE id = $1 AND project_id = $2`,
          [a.take_id, task.projectId],
        )
      ).rows[0] ?? null)
    : null
  const ctx = await context(deps, a, take)

  const stored = await deps.pool.query<{ output: { text?: string; frameSha?: string | null } }>(
    'SELECT output FROM studio_step_results WHERE request_id = $1',
    [task.execRequestId],
  )
  let answer = typeof stored.rows[0]?.output?.text === 'string' ? stored.rows[0].output.text : null
  let frameSha = stored.rows[0]?.output?.frameSha ?? a.frame_blob_sha
  if (answer === null) {
    if (!deps.grok)
      throw new MediaProviderError(
        'INTERPRET_UNAVAILABLE',
        false,
        'the interpreter is not configured',
      )
    const marked = await markedFrame(deps, task, userId, a, take)
    if (marked && !frameSha) {
      // Kept with the annotation: edit_frame sends it as the reference of what to change.
      frameSha = (
        await deps.blobs.put({
          userId,
          mime: 'image/jpeg',
          maxBytes: marked.length,
          source: marked,
          ref: { kind: 'annotation', id: a.id },
        })
      ).sha
    }
    const res = await deps.grok({
      userId,
      containerId: null,
      requestId: task.execRequestId,
      attempt: Math.max(0, task.attempts - 1),
      prompt: buildInterpretPrompt(ctx, !!marked),
      ...(marked
        ? { image: { mediaType: 'image/jpeg' as const, data: marked.toString('base64') } }
        : {}),
      // Interpret is the platform's (orchestrator plan §4): never on the user's ledger.
      billTo: 'platform',
      rateKey: `studio-interpret:${p.user_id}`,
      onResult: async (r) => {
        await deps.pool.query(
          `INSERT INTO studio_step_results(request_id, user_id, task_id, output)
           VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (request_id) DO NOTHING`,
          [
            task.execRequestId,
            p.user_id,
            task.id,
            JSON.stringify({ text: r.text, model: r.model, frameSha }),
          ],
        )
      },
    })
    answer = res.text
  }

  let interpretation: Interpretation
  try {
    interpretation = parseInterpretation(answer, ctx)
  } catch (err) {
    if (!(err instanceof InterpretParseError)) throw err
    if (task.attempts < 2) {
      await withLease(deps.pool, task, async (c) => {
        await c.query('DELETE FROM studio_step_results WHERE request_id = $1', [task.execRequestId])
        await retryStudioTask(c, task, { delaySeconds: 2, error: err.message })
      })
      return
    }
    interpretation = {
      op: null,
      args: null,
      confidence: 0,
      explanation: 'agent 没看懂这条批注，可以换个说法再发一次。',
    }
  }
  await withLease(deps.pool, task, async (c) => {
    const wrote = await c.query(
      `UPDATE studio_annotations SET interpretation = $2::jsonb, frame_blob_sha = COALESCE(frame_blob_sha, $3)
        WHERE id = $1 AND status = 'sent' AND interpretation IS NULL`,
      [a.id, JSON.stringify(interpretation), frameSha ?? null],
    )
    if (wrote.rowCount) {
      await appendStudioEvent(c, task.projectId, 'annotation.interpreted', {
        annotationId: a.id,
        op: interpretation.op,
        message:
          interpretation.op === null
            ? interpretation.explanation
            : `agent 理解为：${interpretation.explanation}`,
      })
      if (autoApply(interpretation, p.autonomy)) await executeAnnotation(c, task.projectId, a.id)
    }
    await finishStudioTask(c, task, { status: 'done' })
  })
}

/** An interpretation that cannot finish: the annotation stays sent and can be sent again. */
export async function failInterpret(
  deps: ExecuteDeps,
  task: StudioTask,
  e: MediaProviderError,
): Promise<void> {
  const annotationId = (task.payload as { annotationId?: unknown }).annotationId
  await withLease(deps.pool, task, async (c) => {
    if (typeof annotationId === 'string') {
      const wrote = await c.query(
        `UPDATE studio_annotations SET interpretation = $2::jsonb
          WHERE id = $1 AND project_id = $3 AND status = 'sent' AND interpretation IS NULL`,
        [
          annotationId,
          JSON.stringify({
            op: null,
            args: null,
            confidence: 0,
            explanation: 'agent 这次没能处理这条批注，可以稍后再发一次。',
            error: e.code,
          }),
          task.projectId,
        ],
      )
      if (wrote.rowCount) {
        await appendStudioEvent(c, task.projectId, 'annotation.interpreted', {
          annotationId,
          op: null,
          message: 'agent 这次没能处理这条批注，可以稍后再发一次。',
        })
      }
    }
    await finishStudioTask(c, task, { status: 'failed', error: `${e.code}: ${e.message}` })
  })
}
