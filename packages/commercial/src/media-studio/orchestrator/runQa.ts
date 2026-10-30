// OCV5-591 A2-1b-1 — the QA task (plan §1): one Grok vision call on a contact sheet of the take
// (and the locked bible), billed to the user by tokens, then the owner is adopted, redone or handed
// to the user. Same lease rules as every executor: the answer is stored per request id before it is
// used, so a re-claimed task never asks (or pays) twice; every final write proves the lease.

import { copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PoolClient } from 'pg'

import { GrokRunError, type GrokVisionUsage } from '../../grok/visionProxy.js'
import { grokCharged } from '../providers/charges.js'
import { MediaProviderError } from '../providers/types.js'
import { type StudioTask, finishStudioTask, retryStudioTask } from '../queue.js'
import { appendStudioEvent } from '../store.js'
import { bookTaskCharge, overBudget } from './budget.js'
import type { ExecuteDeps } from './execute.js'
import { withLease } from './lease.js'
import type { BibleEntry, ShotSpecForPrompt } from './prompts.js'
import {
  CLIP_POINTS,
  QA_REASON_TEXT,
  QA_TARGET,
  type QaHistory,
  type QaJudgement,
  type QaOwnerKind,
  QaParseError,
  type QaReason,
  type QaVerdict,
  buildQaPrompt,
  contactSheet,
  criteriaFor,
  judgeQa,
  parseQa,
} from './qa.js'

interface QaTake {
  id: string
  owner_kind: string
  owner_id: string
  version: number
  status: string
  blob_sha: string | null
  qa: unknown
  duration_ms: number | null
  inputs: { inputs?: Array<{ role?: string; blobSha?: string }> } | null
  user_id: string
  created_at: Date
}

interface QaContext {
  label: string
  shot?: ShotSpecForPrompt & { durationSec?: number }
  assetKind?: 'character' | 'scene' | 'style'
  bible: BibleEntry[]
  refShas: string[]
}

const QA_OWNER_KINDS = new Set<string>(Object.keys(QA_TARGET))

async function loadTake(deps: ExecuteDeps, task: StudioTask): Promise<QaTake | null> {
  const takeId = (task.payload as { takeId?: unknown }).takeId
  if (typeof takeId !== 'string')
    throw new MediaProviderError('INVALID_TASK', false, 'qa task has no take')
  const r = await deps.pool.query<QaTake>(
    `SELECT t.id::text AS id, t.owner_kind, t.owner_id::text AS owner_id, t.version, t.status, t.blob_sha,
            t.qa, (t.meta->>'durationMs')::float8 AS duration_ms, t.inputs, p.user_id::text AS user_id,
            t.created_at
       FROM studio_takes t JOIN studio_projects p ON p.id = t.project_id
      WHERE t.id = $1 AND t.project_id = $2`,
    [takeId, task.projectId],
  )
  return r.rows[0] ?? null
}

async function loadContext(
  deps: ExecuteDeps,
  projectId: string,
  kind: QaOwnerKind,
  ownerId: string,
): Promise<QaContext> {
  if (kind === 'bible') {
    const a = (
      await deps.pool.query<{
        kind: 'character' | 'scene' | 'style'
        name: string
        descriptor: string
      }>('SELECT kind, name, descriptor FROM studio_assets WHERE id = $1 AND project_id = $2', [
        ownerId,
        projectId,
      ])
    ).rows[0]
    return {
      label: a ? `设定图「${a.name}」` : '设定图',
      ...(a ? { assetKind: a.kind } : {}),
      bible: a ? [{ kind: a.kind, name: a.name, descriptor: a.descriptor }] : [],
      refShas: [],
    }
  }
  const [shot, assets] = await Promise.all([
    deps.pool.query<{ ordinal: number; spec: Record<string, unknown> }>(
      'SELECT ordinal, spec FROM studio_shots WHERE id = $1 AND project_id = $2',
      [ownerId, projectId],
    ),
    deps.pool.query<{
      kind: 'character' | 'scene' | 'style'
      name: string
      descriptor: string
      blob_sha: string | null
    }>(
      `SELECT kind, name, descriptor, blob_sha FROM studio_assets
        WHERE project_id = $1 AND kind IN ('character','scene','style') AND locked
        ORDER BY CASE kind WHEN 'character' THEN 0 WHEN 'scene' THEN 1 ELSE 2 END, created_at`,
      [projectId],
    ),
  ])
  const s = shot.rows[0]
  const spec = s?.spec ?? {}
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const dur = Number(spec.durationSec)
  return {
    label: s ? `#${s.ordinal + 1}` : '镜头',
    shot: {
      ...(str(spec.title) ? { title: str(spec.title) } : {}),
      ...(str(spec.framing) ? { framing: str(spec.framing) } : {}),
      ...(str(spec.action) ? { action: str(spec.action) } : {}),
      ...(Number.isFinite(dur) && dur > 0 ? { durationSec: dur } : {}),
    },
    bible: assets.rows.map((a) => ({ kind: a.kind, name: a.name, descriptor: a.descriptor })),
    refShas: assets.rows.flatMap((a) => (a.blob_sha ? [a.blob_sha] : [])).slice(0, 3),
  }
}

async function readBlob(deps: ExecuteDeps, userId: bigint, sha: string): Promise<Buffer> {
  const f = await deps.blobs.open(userId, sha)
  if (!f) throw new MediaProviderError('INPUT_MISSING', false, 'a QA input is not available')
  return readFile(f.path)
}

/** The candidate image(s): the frame / bible image itself, or 4 frames taken from the clip. */
async function candidates(
  deps: ExecuteDeps,
  task: StudioTask,
  t: QaTake,
  ctx: QaContext,
  userId: bigint,
): Promise<Buffer[]> {
  if (QA_TARGET[t.owner_kind as QaOwnerKind] !== 'clip')
    return [await readBlob(deps, userId, t.blob_sha!)]
  const runner = deps.compose
  if (!runner?.configured())
    throw new MediaProviderError(
      'QA_NO_SANDBOX',
      false,
      'the sandbox that takes clip frames is not configured',
    )
  const sec =
    t.duration_ms && t.duration_ms > 0 ? t.duration_ms / 1000 : (ctx.shot?.durationSec ?? 5)
  // Per lease epoch, like compose: a holder that lost its lease never touches the new one's dirs.
  const job = `v-${task.id}-e${task.epoch}`
  try {
    const { inDir } = await runner.prepare(job)
    const f = await deps.blobs.open(userId, t.blob_sha!)
    if (!f) throw new MediaProviderError('INPUT_MISSING', false, 'the clip is not available')
    await copyFile(f.path, join(inDir, 'clip.mp4'))
    const times = CLIP_POINTS.map((p) => Math.round(p * sec * 100) / 100)
    const out = await runner.run(job, { op: 'frames', file: 'clip.mp4', times })
    const frames = times.map((_t, i) => out.outputs.find((o) => o.name === `frame-${i}.png`))
    if (frames.some((o) => !o))
      throw new MediaProviderError('QA_FRAMES', true, 'the sandbox did not return every frame')
    return Promise.all(frames.map((o) => readFile(o!.path)))
  } finally {
    await runner.cleanup(job).catch(() => {})
  }
}

/**
 * Earlier QA'd attempts of this owner, counted in rounds of candidates. A hand-off starts a new
 * count only for takes made after it (the user acted); a candidate of the same round that was
 * already on its way still counts with its siblings (code r1 P1: no reset of the redo cap).
 */
async function history(
  deps: ExecuteDeps,
  t: QaTake,
  perRound: number,
): Promise<{ h: QaHistory; scored: Array<{ id: string; score: number }> }> {
  const r = await deps.pool.query<{ id: string; qa: Record<string, unknown>; created_at: Date }>(
    `SELECT id::text AS id, qa, created_at FROM studio_takes
      WHERE owner_kind = $1 AND owner_id = $2 AND version < $3 AND qa IS NOT NULL
      ORDER BY version`,
    [t.owner_kind, t.owner_id, t.version],
  )
  let since: Array<{ id: string; score: number }> = []
  let handoffAt: number | null = null
  const fresh = (created: Date) => handoffAt !== null && created.getTime() > handoffAt
  for (const row of r.rows) {
    if (fresh(row.created_at)) {
      since = []
      handoffAt = null
    }
    if (row.qa.skipped === true || row.qa.reason === 'unavailable' || row.qa.error) continue
    since.push({ id: row.id, score: typeof row.qa.score === 'number' ? row.qa.score : 0 })
    if (row.qa.next === 'handoff') {
      const at = typeof row.qa.at === 'string' ? Date.parse(row.qa.at) : Number.NaN
      handoffAt = Number.isFinite(at) ? at : row.created_at.getTime()
    }
  }
  if (fresh(t.created_at)) since = []
  const rounds = Math.floor(since.length / Math.max(1, perRound))
  const prior = since.slice(0, rounds * perRound)
  return {
    h: {
      attempts: rounds,
      bestScore: prior.length ? Math.max(...prior.map((p) => p.score)) : null,
    },
    scored: since,
  }
}

interface StoredAnswer {
  text?: string
  model?: string
  usage?: GrokVisionUsage
  /** The billing request id the answer was charged under (`<exec>` or `<exec>~<n>`). */
  requestId?: string
}

const attemptOf = (task: StudioTask) => {
  const n = Number((task.payload as { qaAttempt?: unknown }).qaAttempt ?? 0)
  return Number.isSafeInteger(n) && n >= 0 ? n : 0
}

async function setAttempt(c: PoolClient, task: StudioTask, n: number): Promise<void> {
  await c.query(
    `UPDATE studio_tasks SET payload = jsonb_set(payload, '{qaAttempt}', to_jsonb($2::int)) WHERE id = $1`,
    [task.id, n],
  )
  task.payload = { ...task.payload, qaAttempt: n }
}

/**
 * The billing attempt for the next call (code r1 P1): it does not follow the claim count, so two
 * holders can never pay twice. The finalize journal is the fence — one admitted call per billing
 * id. An id still in flight belongs to another (or a crashed) holder: wait. An id that has ended
 * is looked at again for a stored answer first (code r2 P1: the other holder may have stored and
 * settled it after we last looked); only an ended id without one is spent: move to the next.
 */
async function billingAttempt(
  deps: ExecuteDeps,
  task: StudioTask,
): Promise<{ attempt: number } | { stored: StoredAnswer }> {
  const n = attemptOf(task)
  const id = n === 0 ? task.execRequestId : `${task.execRequestId}~${n}`
  const j = await deps.pool.query<{ state: string }>(
    'SELECT state FROM request_finalize_journal WHERE request_id = $1',
    [id],
  )
  const state = j.rows[0]?.state
  if (state === 'inflight' || state === 'finalizing')
    throw new MediaProviderError(
      'QA_IN_FLIGHT',
      true,
      'an earlier call of this QA is still running',
    )
  if (state === 'aborted' || state === 'committed') {
    const again = await storedAnswer(deps, task)
    if (again) return { stored: again }
    await withLease(deps.pool, task, (c) => setAttempt(c, task, n + 1))
    return { attempt: n + 1 }
  }
  return { attempt: n }
}

async function storedAnswer(deps: ExecuteDeps, task: StudioTask): Promise<StoredAnswer | null> {
  const r = await deps.pool.query<{ output: StoredAnswer }>(
    'SELECT output FROM studio_step_results WHERE request_id = $1',
    [task.execRequestId],
  )
  const out = r.rows[0]?.output
  return out && typeof out.text === 'string' ? out : null
}

/** The user picked a first frame for this shot: their choice is not judged (code r1 / r2 P1). */
async function userPickedFrame(deps: ExecuteDeps, shotId: string): Promise<boolean> {
  const r = await deps.pool.query<{ picked: boolean }>(
    `SELECT spec ? 'frameTakeId' AS picked FROM studio_shots WHERE id = $1`,
    [shotId],
  )
  return r.rows[0]?.picked === true
}

/** Grok failures: busy / transient ones retry with the executor's backoff; the rest end QA. */
function asQaError(err: unknown): MediaProviderError {
  if (err instanceof MediaProviderError) return err
  if (err instanceof GrokRunError) {
    const transient = err.status === 429 || err.status === 409 || err.status >= 500
    return new MediaProviderError(`QA_${err.code}`.slice(0, 64), transient, err.message)
  }
  return new MediaProviderError('QA_ERROR', true, (err as Error)?.message ?? 'error')
}

export async function runQa(deps: ExecuteDeps, task: StudioTask): Promise<void> {
  const t = await loadTake(deps, task)
  if (!t || t.status !== 'succeeded' || !t.blob_sha || t.qa || !QA_OWNER_KINDS.has(t.owner_kind)) {
    // Gone, replaced, or already judged by an earlier holder: nothing to do.
    await withLease(deps.pool, task, async (c) => {
      await bookTaskCharge(
        c,
        task,
        BigInt(String((task.payload as { booked?: unknown }).booked ?? '0')),
        { release: true },
      )
      await finishStudioTask(c, task, { status: 'done', error: 'nothing to judge' })
    })
    return
  }
  const kind = t.owner_kind as QaOwnerKind
  const target = QA_TARGET[kind]
  const userId = BigInt(t.user_id)
  // A stored answer means a call already ran: settle it again first (idempotent), whatever
  // happens next — even a skip below must not leave a finished call unbilled (code r3 P1).
  const kept = await storedAnswer(deps, task)
  if (kept?.requestId && kept.usage && deps.grokResettle) {
    try {
      await deps.grokResettle({ userId, requestId: kept.requestId, usage: kept.usage })
    } catch (err) {
      throw new MediaProviderError('QA_BILLING', true, (err as Error)?.message ?? 'resettle failed')
    }
  }
  // Picked by the user while this QA was queued: not judged (code r2 P1). Whatever an earlier
  // attempt did charge is booked; a call still in flight is booked later by reconcile().
  if (kind === 'shot_frame' && (await userPickedFrame(deps, t.owner_id))) {
    const booked = BigInt(String((task.payload as { booked?: unknown }).booked ?? '0'))
    const charged =
      (await grokCharged(deps.pool, userId, task.execRequestId).catch(() => null)) ?? booked
    await withLease(deps.pool, task, async (c) => {
      await c.query(
        `UPDATE studio_takes SET qa = jsonb_build_object('skipped', true, 'reason', 'user_picked', 'costCredits', $2::text)
          WHERE id = $1 AND qa IS NULL`,
        [t.id, charged.toString()],
      )
      await bookTaskCharge(c, task, charged, { release: true })
      await finishStudioTask(c, task, { status: 'done', error: 'the user picked a frame' })
    })
    return
  }
  const ctx = await loadContext(deps, task.projectId, kind, t.owner_id)

  let out = kept
  let attempt = 0
  if (!out) {
    if (!deps.grok)
      throw new MediaProviderError('QA_UNAVAILABLE', false, 'the QA judge is not configured')
    const next = await billingAttempt(deps, task)
    if ('stored' in next) out = next.stored
    else attempt = next.attempt
  }
  // An answer found only now (another holder stored it after we first looked) is settled too.
  if (out && out !== kept && out.requestId && out.usage && deps.grokResettle) {
    // An earlier holder got (and stored) the answer; its settle may not have happened (code r1
    // P1). Settling again under the id it billed is idempotent.
    try {
      await deps.grokResettle({ userId, requestId: out.requestId, usage: out.usage })
    } catch (err) {
      throw new MediaProviderError('QA_BILLING', true, (err as Error)?.message ?? 'resettle failed')
    }
  }
  let answer = out?.text ?? null
  if (answer === null) {
    if (!deps.grok)
      throw new MediaProviderError('QA_UNAVAILABLE', false, 'the QA judge is not configured')
    const [cands, refs] = await Promise.all([
      candidates(deps, task, t, ctx, userId),
      Promise.all(ctx.refShas.map((sha) => readBlob(deps, userId, sha))),
    ])
    const sheet = await contactSheet(cands, refs)
    try {
      const res = await deps.grok({
        userId,
        containerId: null,
        requestId: task.execRequestId,
        attempt,
        prompt: buildQaPrompt({
          target,
          ...(ctx.assetKind ? { assetKind: ctx.assetKind } : {}),
          ...(ctx.shot ? { shot: ctx.shot } : {}),
          bible: ctx.bible,
          candidates: sheet.candidates,
          references: sheet.references,
        }),
        image: { mediaType: 'image/jpeg', data: sheet.jpeg.toString('base64') },
        // Visual QA is the user's (orchestrator plan §4), by tokens, like any agent work.
        billTo: 'user',
        onResult: async (r) => {
          await deps.pool.query(
            `INSERT INTO studio_step_results(request_id, user_id, task_id, output)
             VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (request_id) DO NOTHING`,
            [
              task.execRequestId,
              t.user_id,
              task.id,
              JSON.stringify({
                text: r.text,
                model: r.model,
                usage: r.usage,
                requestId: r.requestId,
              } satisfies StoredAnswer),
            ],
          )
        },
      })
      answer = res.text
    } catch (err) {
      throw asQaError(err)
    }
  }

  let verdict: QaVerdict | null = null
  try {
    verdict = parseQa(answer)
  } catch (err) {
    if (!(err instanceof QaParseError)) throw err
    if (task.attempts < 2) {
      // One more answer (the next attempt id); a second bad answer counts as "unsure".
      // A deliberate second call: the next billing attempt (this one was answered and paid).
      await withLease(deps.pool, task, async (c) => {
        await c.query('DELETE FROM studio_step_results WHERE request_id = $1', [task.execRequestId])
        await setAttempt(c, task, attemptOf(task) + 1)
        await retryStudioTask(c, task, { delaySeconds: 2, error: err.message.slice(0, 500) })
      })
      return
    }
  }
  const perRound = kind === 'bible' ? (deps.qa?.bibleCandidates ?? 1) : 1
  const { h, scored } = await history(deps, t, perRound)
  const j: QaJudgement = verdict
    ? judgeQa(verdict, criteriaFor(target, ctx.assetKind), h)
    : { passed: false, score: 0, next: 'handoff', reason: 'low_confidence' }
  await settle(
    deps,
    task,
    t,
    kind,
    ctx,
    {
      ...(verdict ?? { summary: 'agent 没能给出有效的质检结果。', issues: [] }),
      ...j,
      attempt: h.attempts + 1,
    },
    j,
    scored,
  )
}

/** A QA that cannot finish (no judge, judge refused, retries spent): hand the owner to the user. */
export async function failQa(
  deps: ExecuteDeps,
  task: StudioTask,
  e: MediaProviderError,
): Promise<void> {
  const t = await loadTake(deps, task).catch(() => null)
  const kind = t && QA_OWNER_KINDS.has(t.owner_kind) ? (t.owner_kind as QaOwnerKind) : null
  if (!t || !kind || t.qa) {
    await withLease(deps.pool, task, async (c) => {
      await bookTaskCharge(
        c,
        task,
        BigInt(String((task.payload as { booked?: unknown }).booked ?? '0')),
        { release: true },
      )
      await finishStudioTask(c, task, { status: 'failed', error: `${e.code}: ${e.message}` })
    })
    return
  }
  const ctx = await loadContext(deps, task.projectId, kind, t.owner_id)
  const j: QaJudgement = { passed: false, score: 0, next: 'handoff', reason: 'unavailable' }
  await settle(
    deps,
    task,
    t,
    kind,
    ctx,
    { ...j, summary: `这次没能完成质检（${e.code}）。`, issues: [], error: e.code },
    j,
    [],
    { status: 'failed', error: `${e.code}: ${e.message}` },
  )
}

async function settle(
  deps: ExecuteDeps,
  task: StudioTask,
  t: QaTake,
  kind: QaOwnerKind,
  ctx: QaContext,
  qa: Record<string, unknown> & { summary?: string },
  j: QaJudgement,
  scored: Array<{ id: string; score: number }>,
  finish: { status: 'done' | 'failed'; error?: string } = { status: 'done' },
): Promise<void> {
  const userId = BigInt(t.user_id)
  // What this execution actually debited (all attempts); an unreadable ledger books what was
  // already booked, and reconcile() catches up later.
  const booked = BigInt(String((task.payload as { booked?: unknown }).booked ?? '0'))
  const charged =
    (await grokCharged(deps.pool, userId, task.execRequestId).catch(() => null)) ?? booked
  await withLease(deps.pool, task, async (c) => {
    const wrote = await c.query(
      'UPDATE studio_takes SET qa = $2::jsonb WHERE id = $1 AND qa IS NULL',
      [
        t.id,
        JSON.stringify({ ...qa, costCredits: charged.toString(), at: new Date().toISOString() }),
      ],
    )
    await bookTaskCharge(c, task, charged, { release: true })
    if (wrote.rowCount)
      await outcome(c, task.projectId, t, kind, ctx, j, qa.summary ?? '', [
        ...scored,
        { id: t.id, score: j.score },
      ])
    if (await overBudget(c, task.projectId)) {
      await c.query(
        `UPDATE studio_projects SET status = 'paused', settings = settings || '{"pausedReason":"budget"}'::jsonb,
                rev = rev + 1 WHERE id = $1 AND status = 'running'`,
        [task.projectId],
      )
      await appendStudioEvent(c, task.projectId, 'budget.exceeded', {
        message: '实际费用超出了预算，已暂停。',
      })
    }
    await finishStudioTask(c, task, finish)
  })
}

async function outcome(
  c: PoolClient,
  projectId: string,
  t: QaTake,
  kind: QaOwnerKind,
  ctx: QaContext,
  j: QaJudgement,
  summary: string,
  scored: Array<{ id: string; score: number }>,
): Promise<void> {
  const why = (r: QaReason) => `${ctx.label}${QA_REASON_TEXT[r]}${summary ? `：${summary}` : ''}`
  if (kind === 'bible') {
    if (j.next === 'adopt') {
      // Lock the best passing candidate once none of this asset's candidates is still pending.
      const pending = await c.query(
        `SELECT 1 FROM studio_takes WHERE owner_kind = 'bible' AND owner_id = $1 AND id <> $2
            AND (status IN ('queued','running') OR (status = 'succeeded' AND qa IS NULL)) LIMIT 1`,
        [t.owner_id, t.id],
      )
      if (!pending.rowCount) {
        await c.query(
          `UPDATE studio_assets a SET blob_sha = best.blob_sha, locked = TRUE
             FROM (SELECT blob_sha FROM studio_takes
                    WHERE owner_kind = 'bible' AND owner_id = $1 AND status = 'succeeded'
                      AND blob_sha IS NOT NULL AND (qa->>'passed')::boolean IS TRUE
                    ORDER BY (qa->>'score')::float8 DESC NULLS LAST, version DESC LIMIT 1) best
            WHERE a.id = $1 AND a.project_id = $2 AND NOT a.locked`,
          [t.owner_id, projectId],
        )
      }
      await appendStudioEvent(c, projectId, 'qa.passed', { takeId: t.id, message: why('passed') })
    } else if (j.next === 'redo') {
      await appendStudioEvent(c, projectId, 'qa.redo', {
        takeId: t.id,
        message: `${why(j.reason)}。自动重做。`,
      })
    } else {
      await appendStudioEvent(c, projectId, 'qa.needs_user', {
        takeId: t.id,
        reason: j.reason,
        takeIds: best2(scored),
        message: `${why(j.reason)}。请选一个版本或写批注。`,
      })
    }
    return
  }

  if (j.next === 'adopt') {
    if (kind === 'shot_video') {
      // As runGen adopts without QA: only while the shot still waits for this video (not after the
      // user chose another take or picked a different first frame since).
      const first = t.inputs?.inputs?.find((i) => i.role === 'first_frame')?.blobSha ?? null
      await c.query(
        `UPDATE studio_shots s SET active_take_id = $2, status = 'ready', spec = s.spec - 'frameTakeId'
          WHERE s.id = $1 AND s.project_id = $3 AND s.status IN ('generating', 'qa')
            AND (SELECT version FROM studio_takes WHERE id = $2) >= COALESCE((s.spec->'redo'->>'video')::int, 0)
            AND (NOT s.spec ? 'frameTakeId'
                 OR EXISTS (SELECT 1 FROM studio_takes f
                             WHERE f.id::text = s.spec->>'frameTakeId' AND f.blob_sha = $4))`,
        [t.owner_id, t.id, projectId, first],
      )
    } else {
      await c.query(
        `UPDATE studio_shots SET status = 'generating' WHERE id = $1 AND status = 'qa'`,
        [t.owner_id],
      )
    }
    await appendStudioEvent(c, projectId, 'qa.passed', { takeId: t.id, message: why('passed') })
  } else if (j.next === 'redo') {
    await c.query(
      `UPDATE studio_shots s SET status = 'generating' WHERE s.id = $1 AND s.status = 'qa' AND ${PICK_OK}`,
      [t.owner_id, firstFrame(t)],
    )
    await appendStudioEvent(c, projectId, 'qa.redo', {
      takeId: t.id,
      message: `${why(j.reason)}。自动重做。`,
    })
  } else {
    // A frame the user picked meanwhile is theirs (code r2 P1): an older take's verdict does not
    // stop the shot.
    const stopped = await c.query(
      `UPDATE studio_shots s SET status = 'needs_user'
        WHERE s.id = $1 AND s.status IN ('generating', 'qa') AND ${PICK_OK}`,
      [t.owner_id, firstFrame(t)],
    )
    if (!stopped.rowCount) return
    await appendStudioEvent(c, projectId, 'shot.needs_user', {
      shotId: t.owner_id,
      takeId: t.id,
      reason: j.reason,
      takeIds: best2(scored),
      message: `${why(j.reason)}。最好的版本已留给你挑，也可以写批注。`,
    })
  }
}

/**
 * A verdict may move the shot only while the user has not picked a first frame since — or, for a
 * video, picked the very frame it was made from. $2 is the take's own first frame (or null).
 */
const PICK_OK = `(NOT s.spec ? 'frameTakeId'
  OR ($2::text IS NOT NULL AND EXISTS (SELECT 1 FROM studio_takes f
                                       WHERE f.id::text = s.spec->>'frameTakeId' AND f.blob_sha = $2::text)))`

function firstFrame(t: QaTake): string | null {
  return t.owner_kind === 'shot_video'
    ? (t.inputs?.inputs?.find((i) => i.role === 'first_frame')?.blobSha ?? null)
    : null
}

function best2(scored: Array<{ id: string; score: number }>): string[] {
  return [...scored]
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((s) => s.id)
}
