// OCV5-591 A2-1c — the compose task (docs/ocv5-591-a2-1c-compose-plan.md). Started by the director
// agent once every shot and line is ready, or by an export-format switch; never charged (user
// decisions 2026-10-23 21:42 and 22:13). The final take exists before its blob, so the blob's ref
// always has an owner; the result is published only if the project's inputs still match what was
// composed.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool, PoolClient } from 'pg'

import type { ComposeResult } from '../compose/runner.js'
import type { ComposeOp, MusicEdit } from '../compose/spec.js'
import { MediaProviderError } from '../providers/types.js'
import { type StudioTask, enqueueStudioTask, finishStudioTask } from '../queue.js'
import { appendStudioEvent } from '../store.js'
import {
  ComposeJobError,
  DEFAULT_VARIANT,
  type ExportVariant,
  type JobLine,
  type JobMusic,
  type JobShot,
  buildComposeJob,
  finalQa,
  parseVariant,
  variantKey,
} from './composeJob.js'
import type { ExecuteDeps } from './execute.js'
import { withLease } from './lease.js'

type Db = Pool | PoolClient

/** The sandbox as the orchestrator uses it (OCV5-588 ComposeRunner). */
export interface ComposeRunnerLike {
  configured(): boolean
  prepare(jobId: string): Promise<{ inDir: string; outDir: string }>
  run(jobId: string, op: ComposeOp): Promise<ComposeResult>
  cleanup(jobId: string): Promise<void>
}

export interface ComposePayload {
  reason: 'auto' | 'export'
  variant: ExportVariant
  takeId?: string
  inputsKey?: string
}

export function composePayload(task: StudioTask): ComposePayload {
  const p = task.payload as Partial<ComposePayload>
  const variant = parseVariant(p.variant) ?? DEFAULT_VARIANT
  return {
    reason: p.reason === 'export' ? 'export' : 'auto',
    variant,
    ...(typeof p.takeId === 'string' ? { takeId: p.takeId } : {}),
    ...(typeof p.inputsKey === 'string' ? { inputsKey: p.inputsKey } : {}),
  }
}

export interface ComposeInputs {
  userId: string
  aspect: '16:9' | '9:16' | '1:1'
  status: string
  shots: JobShot[]
  lines: JobLine[]
  music: JobMusic | null
  /** Shots without a finished video (compose cannot start). */
  missing: string[]
  /** Fingerprint of everything the cut is made of, for this export format (plan §3.7a). */
  inputsKey: string
}

/** Everything one compose reads, from the project as it is now. */
export async function loadComposeInputs(
  db: Db,
  projectId: string,
  variant: ExportVariant,
): Promise<ComposeInputs | null> {
  const p = await db.query<{
    user_id: string
    aspect: ComposeInputs['aspect']
    status: string
    settings: Record<string, unknown>
  }>(
    'SELECT user_id::text AS user_id, aspect, status, settings FROM studio_projects WHERE id = $1 AND deleted_at IS NULL',
    [projectId],
  )
  const project = p.rows[0]
  if (!project) return null
  const shots = await db.query<{
    id: string
    ordinal: number
    dur: number | null
    take_id: string | null
    sha: string | null
    kind: string | null
    status: string | null
    video_ms: number | null
  }>(
    `SELECT s.id::text AS id, s.ordinal, (s.spec->>'durationSec')::float8 AS dur, t.id::text AS take_id,
            t.blob_sha AS sha, t.owner_kind AS kind, t.status, (t.meta->>'durationMs')::float8 AS video_ms
       FROM studio_shots s LEFT JOIN studio_takes t ON t.id = s.active_take_id
      WHERE s.project_id = $1 ORDER BY s.ordinal`,
    [projectId],
  )
  const lines = await db.query<{
    id: string
    shot_id: string | null
    ordinal: number
    text: string
    take_id: string | null
    sha: string | null
    mime: string | null
    audio_ms: number | null
  }>(
    `SELECT l.id::text AS id, l.shot_id::text AS shot_id, l.ordinal, l.text, t.id::text AS take_id,
            t.blob_sha AS sha, b.mime, (t.meta->>'durationMs')::float8 AS audio_ms
       FROM studio_lines l
       LEFT JOIN studio_takes t ON t.id = l.active_take_id AND t.status = 'succeeded'
       LEFT JOIN studio_blobs b ON b.sha256 = t.blob_sha
      WHERE l.project_id = $1 ORDER BY l.ordinal`,
    [projectId],
  )
  const musicTakeId =
    typeof project.settings?.musicTakeId === 'string' ? project.settings.musicTakeId : null
  const edit = (project.settings?.musicEdit ?? {}) as MusicEdit
  let music: JobMusic | null = null
  if (musicTakeId) {
    const m = await db.query<{
      sha: string
      mime: string
      license: Record<string, unknown> | null
    }>(
      `SELECT t.blob_sha AS sha, b.mime, t.meta->'license' AS license
         FROM studio_takes t JOIN studio_blobs b ON b.sha256 = t.blob_sha
        WHERE t.id::text = $1 AND t.project_id = $2 AND t.owner_kind = 'music' AND t.status = 'succeeded'`,
      [musicTakeId, projectId],
    )
    const row = m.rows[0]
    if (row) music = { sha: row.sha, mime: row.mime, edit, license: row.license }
  }
  const missing = shots.rows
    .filter((s) => !s.sha || s.kind !== 'shot_video' || s.status !== 'succeeded')
    .map((s) => s.id)
  const jobShots: JobShot[] = shots.rows
    .filter((s) => s.sha && s.kind === 'shot_video' && s.status === 'succeeded')
    .map((s) => ({
      id: s.id,
      ordinal: s.ordinal,
      durationSec: s.dur ?? 5,
      videoSha: s.sha!,
      videoSec: s.video_ms ? s.video_ms / 1000 : null,
    }))
  const jobLines: JobLine[] = lines.rows
    .filter((l) => l.sha)
    .map((l) => ({
      id: l.id,
      shotId: l.shot_id,
      ordinal: l.ordinal,
      text: l.text,
      audioSha: l.sha!,
      audioMime: l.mime ?? 'audio/mpeg',
      audioSec: l.audio_ms ? l.audio_ms / 1000 : null,
    }))
  const inputsKey = createHash('sha256')
    .update(
      JSON.stringify({
        shots: shots.rows.map((s) => [s.id, s.take_id, s.dur]),
        lines: lines.rows.map((l) => [l.id, l.take_id, l.text]),
        musicTakeId: music ? musicTakeId : null,
        edit: music ? edit : null,
        aspect: project.aspect,
        variant: variantKey(variant),
      }),
    )
    .digest('hex')
  return {
    userId: project.user_id,
    aspect: project.aspect,
    status: project.status,
    shots: jobShots,
    lines: jobLines,
    music,
    missing,
    inputsKey,
  }
}

const RETRYABLE = new Set(['COMPOSE_BUSY', 'COMPOSE_DISK', 'COMPOSE_TIMEOUT'])

/** Sandbox errors become provider-style errors so the executor's retry rules apply. */
function asTaskError(err: unknown): unknown {
  const code = (err as { code?: unknown })?.code
  if (typeof code === 'string' && code.startsWith('COMPOSE_'))
    return new MediaProviderError(code, RETRYABLE.has(code), (err as Error).message)
  return err
}

export async function runCompose(deps: ExecuteDeps, task: StudioTask): Promise<void> {
  const runner = deps.compose
  if (!runner?.configured())
    throw new MediaProviderError(
      'COMPOSE_NOT_CONFIGURED',
      false,
      'the compose sandbox is not configured',
    )
  const pl = composePayload(task)
  const inputs = await loadComposeInputs(deps.pool, task.projectId, pl.variant)
  if (!inputs) {
    await finishStudioTask(deps.pool, task, { status: 'canceled', error: 'project gone' })
    return
  }
  // A2-1b-2: the film is being reworked (an annotation reopened it). An export waits for the new
  // film instead of failing on missing inputs; an auto run ends — the director composes again.
  // Inputs and status are read separately: missing inputs get a fresh status (code r2 P1), so a
  // rework that started in between waits instead of failing the export.
  const status =
    inputs.missing.length > 0
      ? ((
          await deps.pool.query<{ status: string }>(
            'SELECT status FROM studio_projects WHERE id = $1',
            [task.projectId],
          )
        ).rows[0]?.status ?? inputs.status)
      : inputs.status
  if (status !== 'done' && status !== 'composing') {
    await withLease(deps.pool, task, async (c) => {
      if (pl.reason === 'export' && ['running', 'awaiting_user', 'paused'].includes(status)) {
        await enqueueStudioTask(c, {
          projectId: task.projectId,
          kind: 'compose',
          idempotencyKey: `compose:${task.projectId}:export-wait:${task.id}`,
          payload: { reason: 'export', variant: pl.variant },
          runAfterSeconds: 60,
        })
      }
      if (pl.takeId) {
        await c.query(
          `UPDATE studio_takes SET status = 'canceled', finished_at = NOW() WHERE id = $1 AND status IN ('queued','running')`,
          [pl.takeId],
        )
        await deps.blobs.dropRefs(BigInt(inputs.userId), { kind: 'final', id: pl.takeId }, c)
      }
      await finishStudioTask(c, task, { status: 'done', error: `project is ${status}` })
    })
    return
  }
  if (inputs.missing.length)
    throw new MediaProviderError(
      'COMPOSE_INPUTS',
      false,
      `${inputs.missing.length} shot(s) have no finished video`,
    )

  let job: ReturnType<typeof buildComposeJob>
  try {
    job = buildComposeJob({
      aspect: inputs.aspect,
      variant: pl.variant,
      shots: inputs.shots,
      lines: inputs.lines,
      music: inputs.music,
    })
  } catch (err) {
    if (!(err instanceof ComposeJobError)) throw err
    // Narration that cannot fit is the user's call (plan §3.2), not a retry.
    await withLease(deps.pool, task, async (c) => {
      if (err.shotId)
        await c.query(
          `UPDATE studio_shots SET status = 'needs_user' WHERE id = $1 AND project_id = $2`,
          [err.shotId, task.projectId],
        )
      if (pl.reason === 'auto') {
        await c.query(
          `UPDATE studio_projects SET status = 'awaiting_user', settings = settings || '{"awaitingReason":"needs_user"}'::jsonb,
                  rev = rev + 1, updated_at = NOW() WHERE id = $1 AND status = 'composing'`,
          [task.projectId],
        )
      }
      await appendStudioEvent(c, task.projectId, 'compose.needs_user', {
        shotId: err.shotId,
        message: err.message,
      })
      if (pl.takeId) {
        await c.query(
          `UPDATE studio_takes SET status = 'failed', error_code = 'COMPOSE_NARRATION', finished_at = NOW()
            WHERE id = $1 AND status IN ('queued','running')`,
          [pl.takeId],
        )
      }
      // An earlier attempt may have written its blob already (code r1 P1): give it back, atomically.
      if (pl.takeId)
        await deps.blobs.dropRefs(BigInt(inputs.userId), { kind: 'final', id: pl.takeId }, c)
      await finishStudioTask(c, task, {
        status: 'failed',
        error: `COMPOSE_NARRATION: ${err.message}`.slice(0, 500),
      })
    })
    return
  }

  // The final take first (plan §3.7): the blob's ref then always belongs to a take.
  let takeId = pl.takeId
  if (!takeId) {
    takeId = await withLease(deps.pool, task, async (c) => {
      await c.query('SELECT 1 FROM studio_projects WHERE id = $1 FOR UPDATE', [task.projectId])
      const v = await c.query<{ next: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM studio_takes WHERE owner_kind = 'final' AND owner_id = $1`,
        [task.projectId],
      )
      const id = (
        await c.query<{ id: string }>(
          `INSERT INTO studio_takes(id, project_id, owner_kind, owner_id, version, provider, model, op, inputs, status, cost_credits)
           VALUES (gen_random_uuid(), $1, 'final', $1, $2, 'compose', 'ffmpeg', 'compose', $3::jsonb, 'running', 0)
           RETURNING id::text AS id`,
          [
            task.projectId,
            v.rows[0]!.next,
            JSON.stringify({ variant: pl.variant, reason: pl.reason }),
          ],
        )
      ).rows[0]!.id
      await c.query('UPDATE studio_tasks SET payload = payload || $2::jsonb WHERE id = $1', [
        task.id,
        JSON.stringify({ takeId: id, inputsKey: inputs.inputsKey }),
      ])
      return id
    })
    // Recovery reads the take from the payload: keep this task's copy in step with the row.
    task.payload = { ...task.payload, takeId, inputsKey: inputs.inputsKey }
  }

  const userId = BigInt(inputs.userId)
  // Per lease epoch (code r1 P1): a holder that lost its lease never touches the new holder's dirs.
  const jobId = `c-${task.id}-e${task.epoch}`
  const qaJob = `q-${task.id}-e${task.epoch}`
  let finalSha: string
  let srtSha: string | null = null
  let qa: ReturnType<typeof finalQa>
  try {
    const { inDir } = await runner.prepare(jobId)
    for (const [name, sha] of Object.entries(job.files)) {
      const f = await deps.blobs.open(userId, sha)
      if (!f)
        throw new MediaProviderError('COMPOSE_INPUTS', false, `input ${name} is not available`)
      await copyFile(f.path, join(inDir, name))
    }
    for (const [name, text] of Object.entries(job.texts)) await writeFile(join(inDir, name), text)
    const out = await runner.run(jobId, { op: 'compose', spec: job.spec }).catch((e) => {
      throw asTaskError(e)
    })
    const film = out.outputs.find((o) => o.name === 'final.mp4')
    if (!film)
      throw new MediaProviderError('COMPOSE_OUTPUT', false, 'compose produced no final.mp4')
    // Final QA (plan §3.6) on a copy, so the probe sees exactly the file that is stored.
    const q = await runner.prepare(qaJob)
    await copyFile(film.path, join(q.inDir, 'final.mp4'))
    const probe = await runner.run(qaJob, { op: 'probe', file: 'final.mp4' }).catch((e) => {
      throw asTaskError(e)
    })
    qa = finalQa(probe.stdoutJson, job.expectedSec)
    const bytes = (await stat(film.path)).size
    finalSha = (
      await deps.blobs.put({
        userId,
        mime: 'video/mp4',
        maxBytes: bytes,
        source: createReadStream(film.path),
        ref: { kind: 'final', id: takeId },
      })
    ).sha
    if (job.srt) {
      const buf = Buffer.from(job.srt, 'utf8')
      srtSha = (
        await deps.blobs.put({
          userId,
          mime: 'application/x-subrip',
          maxBytes: buf.length,
          source: buf,
          ref: { kind: 'final', id: takeId },
        })
      ).sha
    }
  } finally {
    await runner.cleanup(jobId).catch(() => {})
    await runner.cleanup(qaJob).catch(() => {})
  }

  // Publish only if the cut still matches the project (plan §3.7a).
  await withLease(deps.pool, task, async (c) => {
    await c.query('SELECT 1 FROM studio_projects WHERE id = $1 FOR UPDATE', [task.projectId])
    const now = await loadComposeInputs(c, task.projectId, pl.variant)
    // What this run actually composed (a re-claim composes the inputs as they are now).
    const composedKey = inputs.inputsKey
    // A generation still in flight (e.g. a newly chosen track) will change the inputs (code r1 P1).
    const pending = await c.query(
      `SELECT 1 FROM studio_tasks WHERE project_id = $1 AND kind = 'gen' AND status IN ('queued','leased') LIMIT 1`,
      [task.projectId],
    )
    if (pending.rowCount) {
      await c.query(
        `UPDATE studio_takes SET status = 'canceled', finished_at = NOW() WHERE id = $1`,
        [takeId],
      )
      // Back to the director: it composes again once that work has finished.
      await c.query(
        `UPDATE studio_projects SET status = 'running', settings = settings - 'awaitingReason', rev = rev + 1, updated_at = NOW()
          WHERE id = $1 AND status IN ('composing','done')`,
        [task.projectId],
      )
      await appendStudioEvent(c, task.projectId, 'compose.superseded', {
        message: '合成期间有新的改动（如换配乐）还在进行，等它完成后重新合成。',
      })
      // An export keeps the format it was asked for (code r2 P1): it comes back after that work.
      if (pl.reason === 'export') {
        await enqueueStudioTask(c, {
          projectId: task.projectId,
          kind: 'compose',
          idempotencyKey: `compose:${task.projectId}:export-after:${task.id}`,
          payload: { reason: 'export', variant: pl.variant },
          runAfterSeconds: 30,
        })
      }
      await deps.blobs.dropRefs(userId, { kind: 'final', id: takeId }, c)
      await finishStudioTask(c, task, { status: 'done', error: 'superseded by pending work' })
      return 'superseded' as const
    }
    if (!now || now.inputsKey !== composedKey) {
      await c.query(
        `UPDATE studio_takes SET status = 'canceled', finished_at = NOW() WHERE id = $1`,
        [takeId],
      )
      if (now) {
        await enqueueStudioTask(c, {
          projectId: task.projectId,
          kind: 'compose',
          idempotencyKey: `compose:${task.projectId}:${now.inputsKey}:${pl.reason}:${task.id}`,
          payload: { reason: pl.reason, variant: pl.variant },
        })
        await appendStudioEvent(c, task.projectId, 'compose.superseded', {
          message: '合成期间配乐或镜头有改动，按最新的内容重新合成。',
        })
      }
      await deps.blobs.dropRefs(userId, { kind: 'final', id: takeId }, c)
      await finishStudioTask(c, task, { status: 'done', error: 'superseded by newer inputs' })
      return 'superseded' as const
    }
    await c.query(
      `UPDATE studio_takes SET status = 'succeeded', blob_sha = $2, qa = $3::jsonb, meta = meta || $4::jsonb, finished_at = NOW()
        WHERE id = $1`,
      [
        takeId,
        finalSha,
        JSON.stringify(qa),
        JSON.stringify({
          variant: pl.variant,
          variantKey: variantKey(pl.variant),
          inputsKey: composedKey,
          credits: job.credits,
          srtSha,
          reason: pl.reason,
          durationMs: Math.round(job.expectedSec * 1000),
        }),
      ],
    )
    if (pl.reason === 'auto') {
      await c.query(
        `UPDATE studio_projects SET status = 'done', settings = settings - 'awaitingReason', rev = rev + 1, updated_at = NOW()
          WHERE id = $1 AND status = 'composing'`,
        [task.projectId],
      )
      // Paused while composing (code r1 P1): resume then lands on the finished film.
      await c.query(
        `UPDATE studio_projects SET settings = settings || '{"resumeTo":"done"}'::jsonb
          WHERE id = $1 AND status = 'paused' AND settings->>'resumeTo' = 'composing'`,
        [task.projectId],
      )
    }
    await appendStudioEvent(c, task.projectId, 'compose.done', {
      takeId,
      variantKey: variantKey(pl.variant),
      passed: qa.passed,
      message: qa.passed
        ? pl.reason === 'auto'
          ? `成片合成好了：${job.expectedSec} 秒。`
          : '新规格的成片合成好了，可以下载。'
        : `成片合成好了，但质检没通过（时长 ${qa.durationSec ?? '未知'} 秒，应为 ${job.expectedSec} 秒），请看一下。`,
    })
    // A re-claimed run reuses the take; what an earlier attempt stored on it is given back in this
    // same transaction (code r1 / r2 P1): never a window where the task is done but refs leak.
    await deps.blobs.dropRefsExcept(
      userId,
      { kind: 'final', id: takeId },
      [finalSha, ...(srtSha ? [srtSha] : [])],
      c,
    )
    await finishStudioTask(c, task, { status: 'done' })
    return 'published' as const
  })
}

/** A compose that will not be retried: its take fails and gives its blob refs back (plan §4). */
export async function failCompose(
  deps: ExecuteDeps,
  task: StudioTask,
  code: string,
  message: string,
): Promise<void> {
  const pl = composePayload(task)
  const p = await deps.pool.query<{ user_id: string }>(
    'SELECT user_id::text AS user_id FROM studio_projects WHERE id = $1',
    [task.projectId],
  )
  await withLease(deps.pool, task, async (c) => {
    if (pl.takeId) {
      await c.query(
        `UPDATE studio_takes SET status = 'failed', error_code = $2, finished_at = NOW() WHERE id = $1 AND status IN ('queued','running')`,
        [pl.takeId, code.replace(/[^A-Z0-9_]/g, '_').slice(0, 64) || 'COMPOSE_FAILED'],
      )
    }
    if (pl.reason === 'auto') {
      await c.query(
        `UPDATE studio_projects SET status = 'awaiting_user', settings = settings || '{"awaitingReason":"compose_failed"}'::jsonb,
                rev = rev + 1, updated_at = NOW() WHERE id = $1 AND status = 'composing'`,
        [task.projectId],
      )
    }
    await appendStudioEvent(c, task.projectId, 'compose.failed', {
      code,
      message:
        pl.reason === 'auto'
          ? '成片没有合成成功，没有扣费。可以稍后让导演 agent 再试。'
          : '这个规格没有合成成功，没有扣费，可以稍后再试。',
    })
    if (pl.takeId && p.rows[0])
      await deps.blobs.dropRefs(BigInt(p.rows[0].user_id), { kind: 'final', id: pl.takeId }, c)
    await finishStudioTask(c, task, {
      status: 'failed',
      error: `${code}: ${message}`.slice(0, 500),
    })
  })
}
