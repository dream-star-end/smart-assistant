// OCV5-591 A2-1a — task executors. Every final write happens in one transaction that first proves
// the lease is still ours (owner + epoch); a worker that lost its lease commits nothing and the new
// holder redoes the step. Provider calls are idempotent per exec_request_id (A2-0), so a redo never
// pays twice; what was actually charged is booked against payload.booked (plan r3 §4).

import { readFile } from 'node:fs/promises'
import type { Pool, PoolClient } from 'pg'

import type { GrokRunner } from '../../grok/visionProxy.js'
import type { StudioBlobStore } from '../blobs.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { MediaProviderError, type MediaRequest, type MediaResult } from '../providers/types.js'
import { type StudioTask, finishStudioTask, retryStudioTask } from '../queue.js'
import { appendStudioEvent } from '../store.js'
import { bookTaskCharge, overBudget } from './budget.js'
import { type ComposeRunnerLike, composePayload, failCompose, runCompose } from './compose.js'
import { LeaseLostError, withLease } from './lease.js'
import { buildModerationPrompt, moderationOutcome, parseModeration } from './moderation.js'
import {
  PlanParseError,
  type PlanVoice,
  type StudioPlan,
  buildPlanPrompt,
  parsePlan,
} from './plan.js'
import { type StudioQaDeps, qaGates } from './qa.js'
import { failQa, runQa } from './runQa.js'

export { LeaseLostError }

export const MAX_PROVIDER_ATTEMPTS = 3
/** Claims (including lease expiries after a crash or timeout) before a task is given up. */
export const MAX_TASK_CLAIMS = 6
/** Longest raw Muse clip a shot can stretch to when its line runs long (plan §2). */
export const MAX_SHOT_SEC = 10

export interface ExecuteDeps {
  pool: Pool
  blobs: StudioBlobStore
  providers: ProviderRegistry
  grok?: GrokRunner
  systemVoices: () => Promise<PlanVoice[]>
  /** OCV5-588 sandbox (OC_STUDIO_FFMPEG_IMAGE_ID); absent → compose waits (compose_pending). */
  compose?: ComposeRunnerLike
  /** OCV5-591 A2-1b-1: visual QA (absent → takes are used as they come). */
  qa?: StudioQaDeps
}

async function projectOf(pool: Pool, projectId: string) {
  const r = await pool.query<{
    user_id: string
    brief: string
    aspect: '16:9' | '9:16' | '1:1'
    target_sec: number
    autonomy: 'max' | 'confirm'
    budget_credits: string
    title: string
  }>(
    `SELECT user_id::text AS user_id, brief, aspect, target_sec, autonomy, budget_credits::text AS budget_credits, title
       FROM studio_projects WHERE id = $1`,
    [projectId],
  )
  return r.rows[0] ?? null
}

// ── plan ────────────────────────────────────────────────────────────────────────────────────────

/** Rough cost of the whole plan from the registry's own estimates (the model never prices). */
function estimatePlan(
  plan: StudioPlan,
  providers: ProviderRegistry,
  user: { id: string },
  aspect: MediaRequest['aspect'],
): bigint {
  const first = (
    op: Parameters<ProviderRegistry['candidates']>[1],
    kind: Parameters<ProviderRegistry['candidates']>[0],
  ) => providers.candidates(kind, op, user, { includeOffline: true })[0]
  const img = first('image.generate', 'image')
  const vid = first('video.from_image', 'video')
  const tts = first('voice.tts', 'voice')
  let total = 0n
  if (img)
    total +=
      img.estimateMaxCost({ op: 'image.generate', aspect }) *
      BigInt(plan.bible.length + plan.shots.length)
  if (vid)
    total += vid.estimateMaxCost({ op: 'video.from_image', aspect }) * BigInt(plan.shots.length)
  if (tts)
    for (const s of plan.shots)
      if (s.dialogue) total += tts.estimateMaxCost({ op: 'voice.tts', text: s.dialogue })
  return total
}

/**
 * Brief moderation (plan §1.6, platform-paid, stored per request id so a re-claim never re-asks).
 * Returns false when the project stops here: a clear violation fails it; an unsure brief without
 * visual QA to back it up returns it to draft so the user can change it.
 */
async function moderateBrief(
  deps: ExecuteDeps,
  task: StudioTask,
  p: NonNullable<Awaited<ReturnType<typeof projectOf>>>,
): Promise<boolean> {
  const requestId = `${task.execRequestId}:mod`
  const stored = await deps.pool.query<{ output: { text?: string } }>(
    'SELECT output FROM studio_step_results WHERE request_id = $1',
    [requestId],
  )
  let text = typeof stored.rows[0]?.output?.text === 'string' ? stored.rows[0].output.text : null
  if (text === null && deps.grok) {
    try {
      text = (
        await deps.grok({
          userId: BigInt(p.user_id),
          containerId: null,
          requestId,
          attempt: Math.max(0, task.attempts - 1),
          prompt: buildModerationPrompt(p.brief),
          billTo: 'platform',
          onResult: async (r) => {
            await deps.pool.query(
              `INSERT INTO studio_step_results(request_id, user_id, task_id, output)
               VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (request_id) DO NOTHING`,
              [requestId, p.user_id, task.id, JSON.stringify({ text: r.text, model: r.model })],
            )
          },
        })
      ).text
    } catch {
      text = null // unavailable: decided below like an unsure verdict
    }
  }
  const m = text === null ? { verdict: 'unavailable' as const, reason: '' } : parseModeration(text)
  const outcome = moderationOutcome(m.verdict, deps.qa?.enabled === true)
  if (outcome === 'plan') {
    if (m.verdict !== 'pass') {
      await appendStudioEvent(deps.pool, task.projectId, 'brief.moderation_deferred', {
        message: '需求审核没能给出明确结论，之后每一版画面都会再做内容审核。',
      })
    }
    return true
  }
  await withLease(deps.pool, task, async (c) => {
    await finishStudioTask(c, task, { status: 'done', error: `brief moderation: ${m.verdict}` })
    await c.query(
      `UPDATE studio_projects SET status = $2, settings = settings || jsonb_build_object('moderation', $3::text),
              rev = rev + 1, updated_at = NOW() WHERE id = $1 AND status = 'planning'`,
      [task.projectId, outcome === 'fail' ? 'failed' : 'draft', m.verdict],
    )
    await appendStudioEvent(c, task.projectId, 'brief.moderation', {
      verdict: m.verdict,
      message:
        outcome === 'fail'
          ? `需求未通过内容审核${m.reason ? `：${m.reason}` : ''}，不能制作。`
          : `需求可能不合规${m.reason ? `（${m.reason}）` : ''}，请修改后再开始。`,
    })
  })
  return false
}

async function runPlan(deps: ExecuteDeps, task: StudioTask): Promise<void> {
  const p = await projectOf(deps.pool, task.projectId)
  if (!p) {
    await finishStudioTask(deps.pool, task, { status: 'canceled', error: 'project gone' })
    return
  }
  const user = { id: p.user_id }
  const available = {
    image:
      deps.providers.candidates('image', 'image.generate', user, { includeOffline: true }).length >
      0,
    video:
      deps.providers.candidates('video', 'video.from_image', user, { includeOffline: true })
        .length > 0,
    voice:
      deps.providers.candidates('voice', 'voice.tts', user, { includeOffline: true }).length > 0,
    music:
      deps.providers.candidates('music', 'music.generate', user, { includeOffline: true }).length >
      0,
  }
  const voices = available.voice ? await deps.systemVoices().catch(() => []) : []
  const input = {
    brief: p.brief,
    aspect: p.aspect,
    targetSec: p.target_sec,
    available: { ...available, voice: available.voice && voices.length > 0 },
    voices,
  }

  // A2-1b-1: the brief is moderated before anything is planned or generated (D7).
  if (!(await moderateBrief(deps, task, p))) return

  // A stored answer (an earlier attempt got it, then lost its lease) is reused, never re-asked.
  const stored = await deps.pool.query<{ output: { text?: string } }>(
    'SELECT output FROM studio_step_results WHERE request_id = $1',
    [task.execRequestId],
  )
  let answer = typeof stored.rows[0]?.output?.text === 'string' ? stored.rows[0].output.text : null
  if (answer === null) {
    if (!deps.grok)
      throw new MediaProviderError('PLANNER_UNAVAILABLE', false, 'planner is not configured')
    const res = await deps.grok({
      userId: BigInt(p.user_id),
      containerId: null,
      requestId: task.execRequestId,
      attempt: Math.max(0, task.attempts - 1),
      prompt: buildPlanPrompt(input),
      billTo: 'platform',
      onResult: async (r) => {
        await deps.pool.query(
          `INSERT INTO studio_step_results(request_id, user_id, task_id, output)
           VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (request_id) DO NOTHING`,
          [
            task.execRequestId,
            p.user_id,
            task.id,
            JSON.stringify({ text: r.text, model: r.model }),
          ],
        )
      },
    })
    answer = res.text
  }

  let plan: StudioPlan
  try {
    plan = parsePlan(answer, input)
  } catch (err) {
    if (!(err instanceof PlanParseError)) throw err
    await withLease(deps.pool, task, async (c) => {
      await c.query('DELETE FROM studio_step_results WHERE request_id = $1', [task.execRequestId])
      if (task.attempts < 2) {
        // One more try with a fresh answer (a new attempt id bills nothing: the planner is platform-paid).
        await retryStudioTask(c, task, {
          delaySeconds: 2,
          error: `plan invalid: ${err.issues.join('; ')}`.slice(0, 500),
        })
        return
      }
      await finishStudioTask(c, task, { status: 'failed', error: 'plan invalid twice' })
      await c.query(
        `UPDATE studio_projects SET status = 'draft', settings = settings || '{"planFailed":true}'::jsonb,
                rev = rev + 1, updated_at = NOW() WHERE id = $1 AND status = 'planning'`,
        [task.projectId],
      )
      await appendStudioEvent(c, task.projectId, 'plan.failed', {
        message: '分镜方案没写好，可以改一下需求再开拍。',
      })
    })
    return
  }

  const estimate = estimatePlan(plan, deps.providers, user, p.aspect)
  await withLease(deps.pool, task, async (c) => {
    const status = await c.query<{ status: string }>(
      'SELECT status FROM studio_projects WHERE id = $1 FOR UPDATE',
      [task.projectId],
    )
    if (status.rows[0]?.status !== 'planning') {
      await finishStudioTask(c, task, { status: 'canceled', error: 'project left planning' })
      return
    }
    await c.query('DELETE FROM studio_lines WHERE project_id = $1', [task.projectId])
    await c.query('DELETE FROM studio_shots WHERE project_id = $1', [task.projectId])
    await c.query(
      `DELETE FROM studio_assets WHERE project_id = $1 AND kind IN ('character','scene','style')`,
      [task.projectId],
    )
    for (const [i, s] of plan.shots.entries()) {
      const shot = await c.query<{ id: string }>(
        'INSERT INTO studio_shots(id, project_id, ordinal, spec) VALUES (gen_random_uuid(), $1, $2, $3::jsonb) RETURNING id::text AS id',
        [
          task.projectId,
          i,
          JSON.stringify({
            title: s.title,
            framing: s.framing,
            action: s.action,
            durationSec: s.durationSec,
          }),
        ],
      )
      if (s.dialogue) {
        await c.query(
          `INSERT INTO studio_lines(id, project_id, shot_id, ordinal, text, emotion, speed)
           VALUES (gen_random_uuid(), $1, $2, (SELECT COUNT(*) FROM studio_lines WHERE project_id = $1), $3, $4, $5)`,
          [
            task.projectId,
            shot.rows[0]!.id,
            s.dialogue,
            plan.narration?.emotion ?? null,
            plan.narration?.speed ?? null,
          ],
        )
      }
    }
    for (const b of plan.bible) {
      await c.query(
        'INSERT INTO studio_assets(id, project_id, user_id, kind, name, descriptor) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)',
        [task.projectId, p.user_id, b.kind, b.name, b.descriptor],
      )
    }
    const fits = estimate <= BigInt(p.budget_credits)
    const next = p.autonomy === 'max' && fits ? 'running' : 'awaiting_user'
    const reason = next === 'running' ? null : fits ? 'approve_plan' : 'budget'
    await c.query(
      `UPDATE studio_projects
          SET status = $2, title = CASE WHEN title = '' THEN $3 ELSE title END,
              settings = settings || jsonb_build_object('narration', $4::jsonb, 'music', $5::jsonb,
                                                        'estimateCredits', $6::text, 'awaitingReason', $7::text),
              rev = rev + 1, updated_at = NOW()
        WHERE id = $1`,
      [
        task.projectId,
        next,
        plan.title,
        JSON.stringify(plan.narration),
        JSON.stringify(plan.music),
        estimate.toString(),
        reason,
      ],
    )
    await appendStudioEvent(c, task.projectId, 'plan.ready', {
      shots: plan.shots.length,
      estimateCredits: estimate.toString(),
      message: `分镜方案写好了：${plan.shots.length} 个镜头，预估 ${estimate} 积分${next === 'running' ? '，开始生成' : fits ? '，等你确认' : '，超出预算，等你调整'}。`,
    })
    await finishStudioTask(c, task, { status: 'done' })
  })
}

// ── generation ──────────────────────────────────────────────────────────────────────────────────

interface GenPayload {
  takeId: string
  providerId: string
  ownerKind: 'bible' | 'shot_frame' | 'shot_video' | 'line' | 'music'
  ownerId: string
  request: MediaRequest
}

function genPayload(task: StudioTask): GenPayload {
  const p = task.payload as Partial<GenPayload>
  if (
    typeof p.takeId !== 'string' ||
    typeof p.providerId !== 'string' ||
    !p.request ||
    typeof p.ownerId !== 'string' ||
    !p.ownerKind
  ) {
    throw new MediaProviderError('INVALID_TASK', false, 'gen task payload is incomplete')
  }
  return p as GenPayload
}

/** Owner side effects of a succeeded take (bible locks, video adopts, line ready, long lines stretch). */
async function adopt(
  c: PoolClient,
  projectId: string,
  g: GenPayload,
  takeId: string,
  sha: string | null,
  out: MediaResult,
  /** A2-1b-1: QA judges this take first; runQa adopts it if it passes. */
  gated = false,
): Promise<void> {
  const voiceId = typeof out.meta?.voiceId === 'string' ? out.meta.voiceId : null
  if (g.ownerKind === 'bible' && voiceId) {
    // A designed / cloned voice keeps its id and preview; "use as narration" is the user's call.
    await c.query(
      'UPDATE studio_assets SET voice_id = $2, blob_sha = COALESCE($3, blob_sha) WHERE id = $1 AND project_id = $4',
      [g.ownerId, voiceId, sha, projectId],
    )
    await appendStudioEvent(c, projectId, 'voice.created', {
      assetId: g.ownerId,
      message: '新音色已就绪，可以试听，也可以设为旁白。',
    })
  } else if (g.ownerKind === 'bible') {
    if (gated) return
    await c.query(
      'UPDATE studio_assets SET blob_sha = $2, locked = TRUE WHERE id = $1 AND project_id = $3',
      [g.ownerId, sha, projectId],
    )
  } else if (g.ownerKind === 'shot_video') {
    // Only while the shot still waits for this video: not after the user chose another take, not
    // when a long line sent it to the user, not when a different first frame was picked since.
    // A declined video stays a finished version the user can choose.
    if (gated) return
    const first = g.request.inputs?.find((i) => i.role === 'first_frame')?.blobSha ?? null
    await c.query(
      `UPDATE studio_shots s SET active_take_id = $2, status = 'ready', spec = s.spec - 'frameTakeId'
        WHERE s.id = $1 AND s.project_id = $3 AND s.status IN ('generating', 'qa')
          AND (NOT s.spec ? 'frameTakeId'
               OR EXISTS (SELECT 1 FROM studio_takes f
                           WHERE f.id::text = s.spec->>'frameTakeId' AND f.blob_sha = $4))`,
      [g.ownerId, takeId, projectId, first],
    )
  } else if (g.ownerKind === 'line') {
    await c.query(
      `UPDATE studio_lines SET active_take_id = $2, status = 'ready' WHERE id = $1 AND project_id = $3`,
      [g.ownerId, takeId, projectId],
    )
    const ms = out.outputs[0]?.durationMs
    if (typeof ms === 'number' && ms > 0) {
      const shot = await c.query<{ id: string; ordinal: number; dur: number | null }>(
        `SELECT s.id::text AS id, s.ordinal, (s.spec->>'durationSec')::float8 AS dur
           FROM studio_lines l JOIN studio_shots s ON s.id = l.shot_id WHERE l.id = $1 FOR UPDATE OF s`,
        [g.ownerId],
      )
      const sh = shot.rows[0]
      const need = Math.round((ms / 1000 + 0.3) * 10) / 10
      if (sh && sh.dur !== null && need > sh.dur) {
        if (need <= MAX_SHOT_SEC) {
          await c.query(
            `UPDATE studio_shots SET spec = jsonb_set(spec, '{durationSec}', to_jsonb($2::float8)) WHERE id = $1`,
            [sh.id, need],
          )
          await appendStudioEvent(c, projectId, 'shot.extended', {
            shotId: sh.id,
            lineId: g.ownerId,
            message: `#${sh.ordinal + 1} 台词比画面长 ${(need - sh.dur).toFixed(1)}s，已自动把镜头延长到 ${need}s`,
          })
        } else {
          await c.query(`UPDATE studio_shots SET status = 'needs_user' WHERE id = $1`, [sh.id])
          await appendStudioEvent(c, projectId, 'shot.needs_user', {
            shotId: sh.id,
            message: `#${sh.ordinal + 1} 的台词有 ${need}s，超过一个镜头能延长的长度，需要你改短台词或拆成两个镜头。`,
          })
        }
      }
    }
  } else if (g.ownerKind === 'music') {
    // The project's soundtrack (OCV5-591 M1): the newest chosen track wins. Takes are versioned in
    // the order the user chose them, so a slower, older choice finishing last never replaces a newer
    // one (code r1 P1). Its licence snapshot is in the take's meta; the edit stays as the user set it.
    const adopted = await c.query(
      `UPDATE studio_projects p SET settings = p.settings || jsonb_build_object('musicTakeId', $2::text),
              rev = p.rev + 1, updated_at = NOW()
        WHERE p.id = $1
          AND NOT EXISTS (SELECT 1 FROM studio_takes cur, studio_takes mine
                           WHERE cur.id::text = p.settings->>'musicTakeId' AND mine.id = $2::uuid
                             AND cur.version > mine.version)`,
      [projectId, takeId],
    )
    if (adopted.rowCount) {
      await appendStudioEvent(c, projectId, 'music.selected', {
        takeId,
        message: '配乐换成了你选的曲子。',
      })
    }
  }
  // shot_frame: nothing to adopt — the next advance starts the video from it.
}

async function runGen(deps: ExecuteDeps, task: StudioTask, signal: AbortSignal): Promise<void> {
  const g = genPayload(task)
  const p = await projectOf(deps.pool, task.projectId)
  const provider = deps.providers.get(g.providerId)
  if (!p || !provider) {
    await failGen(
      deps,
      task,
      g,
      new MediaProviderError('PROVIDER_UNAVAILABLE', false, 'provider or project gone'),
    )
    return
  }
  const userId = BigInt(p.user_id)
  if (task.failover) {
    await failGen(
      deps,
      task,
      g,
      new MediaProviderError(
        'PROVIDER_OFFLINE',
        false,
        'provider stayed offline past its deadline',
      ),
    )
    return
  }
  await deps.pool.query(
    `UPDATE studio_takes SET status = 'running' WHERE id = $1 AND status = 'queued'`,
    [g.takeId],
  )
  let result: MediaResult
  try {
    result = await provider.run(
      {
        userId,
        execRequestId: task.execRequestId,
        maxCostCredits: task.reservedCredits,
        signal,
        readInput: async (sha) => {
          const f = await deps.blobs.open(userId, sha)
          if (!f)
            throw new MediaProviderError('INPUT_MISSING', false, 'input blob is not available')
          return readFile(f.path)
        },
      },
      g.request,
    )
  } catch (err) {
    if (signal.aborted) throw new LeaseLostError()
    const e =
      err instanceof MediaProviderError
        ? err
        : new MediaProviderError('PROVIDER_ERROR', false, (err as Error).message ?? 'error')
    if (e.retryable && task.attempts < MAX_PROVIDER_ATTEMPTS) {
      await withLease(deps.pool, task, async (c) => {
        await retryStudioTask(c, task, {
          delaySeconds: 30 * 2 ** (task.attempts - 1),
          error: `${e.code}: ${e.message}`,
        })
      })
      return
    }
    await failGen(deps, task, g, e, userId, provider)
    return
  }
  const out = result.outputs[0]
  const newVoice = typeof result.meta?.voiceId === 'string' ? result.meta.voiceId : null
  if (!out && !newVoice) {
    await failGen(
      deps,
      task,
      g,
      new MediaProviderError('NO_OUTPUT', false, 'provider returned nothing'),
      userId,
      provider,
    )
    return
  }
  // Blob first (outside the lease transaction): a lost lease leaves an orphan ref the GC reclaims.
  // A new voice may come without preview audio; its voice id alone is the result then.
  const stored = out
    ? await deps.blobs.put({
        userId,
        mime: out.mime,
        maxBytes: out.bytes.length,
        source: out.bytes,
        ref: { kind: 'take', id: g.takeId },
      })
    : null
  // A2-1b-1: which takes QA judges before use; a gateable take QA does not judge says so.
  const gates = qaGates(deps)
  const gateable =
    (g.ownerKind === 'bible' && !newVoice) ||
    g.ownerKind === 'shot_frame' ||
    g.ownerKind === 'shot_video'
  const gated =
    gateable && gates[g.ownerKind as 'bible' | 'shot_frame' | 'shot_video'] === true && !!stored
  const skipped = gateable && !gated
  await withLease(deps.pool, task, async (c) => {
    await c.query(
      `UPDATE studio_takes
          SET status = 'succeeded', blob_sha = $2, cost_credits = $3, provider_ref = $4::jsonb,
              model = $5, meta = meta || $6::jsonb, finished_at = NOW(),
              qa = CASE WHEN $7::jsonb IS NULL THEN qa ELSE $7::jsonb END
        WHERE id = $1`,
      [
        g.takeId,
        stored?.sha ?? null,
        result.costCredits.toString(),
        JSON.stringify(result.providerRef),
        result.model.slice(0, 64),
        JSON.stringify({
          ...(result.meta ?? {}),
          ...(out?.durationMs ? { durationMs: out.durationMs } : {}),
        }),
        skipped
          ? JSON.stringify({
              skipped: true,
              reason: !deps.qa?.enabled ? 'off' : 'no_sandbox',
            })
          : null,
      ],
    )
    await adopt(c, task.projectId, g, g.takeId, stored?.sha ?? null, result, gated)
    await bookTaskCharge(c, task, result.costCredits, { release: true })
    await appendStudioEvent(c, task.projectId, 'take.succeeded', {
      ownerKind: g.ownerKind,
      ownerId: g.ownerId,
      takeId: g.takeId,
      costCredits: result.costCredits.toString(),
    })
    if (result.overReservation || (await overBudget(c, task.projectId))) {
      await c.query(
        `UPDATE studio_projects SET status = 'paused', settings = settings || '{"pausedReason":"budget"}'::jsonb,
                rev = rev + 1 WHERE id = $1 AND status = 'running'`,
        [task.projectId],
      )
      await appendStudioEvent(c, task.projectId, 'budget.exceeded', {
        message: '实际费用超出了预算，已暂停。',
      })
    }
    await finishStudioTask(c, task, { status: 'done' })
  })
}

async function failGen(
  deps: ExecuteDeps,
  task: StudioTask,
  g: GenPayload,
  e: MediaProviderError,
  userId?: bigint,
  provider?: ReturnType<ProviderRegistry['get']>,
): Promise<void> {
  // Book whatever this execution did charge right away; late charges are caught by reconcile().
  // An unreadable ledger books nothing here (booked stays as it was); reconcile() catches up.
  const read =
    userId !== undefined && provider
      ? await provider.chargedFor(userId, task.execRequestId).catch(() => null)
      : 0n
  const booked = BigInt(String((task.payload as { booked?: unknown }).booked ?? '0'))
  const charged = read ?? booked
  await withLease(deps.pool, task, async (c) => {
    await c.query(
      `UPDATE studio_takes SET status = 'failed', error_code = $2, cost_credits = $3, finished_at = NOW() WHERE id = $1`,
      [g.takeId, e.code.replace(/[^A-Z0-9_]/g, '_').slice(0, 64) || 'FAILED', charged.toString()],
    )
    await bookTaskCharge(c, task, charged, { release: true })
    await appendStudioEvent(c, task.projectId, 'take.failed', {
      ownerKind: g.ownerKind,
      ownerId: g.ownerId,
      takeId: g.takeId,
      code: e.code,
      message: `${g.providerId} 失败（${e.code}），会自动换下一个可用的服务。`,
    })
    await finishStudioTask(c, task, { status: 'failed', error: `${e.code}: ${e.message}` })
  })
}

/** Paused projects keep their queued work for later; canceled / deleted ones drop it. */
async function gate(deps: ExecuteDeps, task: StudioTask): Promise<boolean> {
  const r = await deps.pool.query<{ status: string; deleted: boolean }>(
    'SELECT status, deleted_at IS NOT NULL AS deleted FROM studio_projects WHERE id = $1',
    [task.projectId],
  )
  const p = r.rows[0]
  // An export-format switch re-composes a finished project (plan §1); everything else stops at done.
  const exportOfDone =
    p?.status === 'done' && task.kind === 'compose' && composePayload(task).reason === 'export'
  if (
    !p ||
    p.deleted ||
    p.status === 'canceled' ||
    p.status === 'failed' ||
    (p.status === 'done' && !exportOfDone)
  ) {
    const composeTake = task.kind === 'compose' ? composePayload(task).takeId : undefined
    const owner = composeTake
      ? (
          await deps.pool.query<{ user_id: string }>(
            'SELECT user_id::text AS user_id FROM studio_projects WHERE id = $1',
            [task.projectId],
          )
        ).rows[0]
      : undefined
    await withLease(deps.pool, task, async (c) => {
      if (composeTake) {
        if (owner)
          await deps.blobs.dropRefs(BigInt(owner.user_id), { kind: 'final', id: composeTake }, c)
        await c.query(
          `UPDATE studio_takes SET status = 'canceled', finished_at = NOW() WHERE id = $1 AND status IN ('queued','running')`,
          [composeTake],
        )
      }
      if (task.kind === 'gen') {
        const takeId = (task.payload as { takeId?: unknown }).takeId
        if (typeof takeId === 'string') {
          await c.query(
            `UPDATE studio_takes SET status = 'canceled', finished_at = NOW() WHERE id = $1 AND status IN ('queued','running')`,
            [takeId],
          )
        }
        await bookTaskCharge(c, task, 0n, { release: true })
      }
      // A2-1b-1: a QA task releases its reservation (a charge from a lost earlier attempt is
      // booked by reconcile()).
      if (task.kind === 'qa') {
        const booked = BigInt(String((task.payload as { booked?: unknown }).booked ?? '0'))
        await bookTaskCharge(c, task, booked, { release: true })
      }
      await finishStudioTask(c, task, { status: 'canceled', error: 'project is no longer active' })
    })
    return false
  }
  if (p.status === 'paused') {
    // Waiting out a pause is not an attempt: give the claim back so MAX_TASK_CLAIMS counts runs only.
    await withLease(deps.pool, task, async (c) => {
      await retryStudioTask(c, task, { delaySeconds: 60, error: 'project paused' })
      await c.query('UPDATE studio_tasks SET attempts = GREATEST(0, attempts - 1) WHERE id = $1', [
        task.id,
      ])
    })
    return false
  }
  return true
}

/**
 * An executor error that is not a lost lease: retry with backoff a bounded number of times, then
 * close the task — a generation books what was charged and releases its reservation, a plan hands
 * the project to the user. Never leaves the task leased (it would re-run on every lease expiry).
 */
async function recover(deps: ExecuteDeps, task: StudioTask, err: unknown): Promise<void> {
  const e =
    err instanceof MediaProviderError
      ? err
      : new MediaProviderError('EXECUTOR_ERROR', true, (err as Error)?.message ?? 'error')
  if (e.retryable && task.attempts < MAX_PROVIDER_ATTEMPTS) {
    await withLease(deps.pool, task, (c) =>
      retryStudioTask(c, task, {
        delaySeconds: 30 * 2 ** (task.attempts - 1),
        error: `${e.code}: ${e.message}`,
      }),
    )
    return
  }
  if (task.kind === 'compose') {
    await failCompose(deps, task, e.code, e.message)
    return
  }
  if (task.kind === 'qa') {
    await failQa(deps, task, e)
    return
  }
  if (task.kind === 'gen') {
    let g: GenPayload | null = null
    try {
      g = genPayload(task)
    } catch {
      g = null
    }
    if (g) {
      const p = await projectOf(deps.pool, task.projectId)
      const provider = deps.providers.get(g.providerId)
      await failGen(deps, task, g, e, p ? BigInt(p.user_id) : undefined, provider)
      return
    }
    await withLease(deps.pool, task, async (c) => {
      await bookTaskCharge(c, task, 0n, { release: true })
      await finishStudioTask(c, task, { status: 'failed', error: `${e.code}: ${e.message}` })
    })
    return
  }
  await withLease(deps.pool, task, async (c) => {
    await finishStudioTask(c, task, { status: 'failed', error: `${e.code}: ${e.message}` })
    if (task.kind === 'plan') {
      await c.query(
        `UPDATE studio_projects SET status = 'draft', settings = settings || '{"planFailed":true}'::jsonb,
                rev = rev + 1, updated_at = NOW() WHERE id = $1 AND status = 'planning'`,
        [task.projectId],
      )
      await appendStudioEvent(c, task.projectId, 'plan.failed', {
        message: '导演 agent 这次没能写出分镜方案，可以改一下需求或稍后再开拍。',
      })
    }
  })
}

export async function executeTask(
  deps: ExecuteDeps,
  task: StudioTask,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (task.attempts > MAX_TASK_CLAIMS) {
      throw new MediaProviderError('TOO_MANY_ATTEMPTS', false, `claimed ${task.attempts} times`)
    }
    if (!(await gate(deps, task))) return
    if (task.kind === 'plan') return await runPlan(deps, task)
    if (task.kind === 'gen') return await runGen(deps, task, signal)
    if (task.kind === 'compose') return await runCompose(deps, task)
    if (task.kind === 'qa') return await runQa(deps, task)
    throw new MediaProviderError('INVALID_TASK', false, `unknown task kind ${task.kind}`)
  } catch (err) {
    // A lost lease (or a timeout abort) belongs to the next holder; it must not write anything.
    if (err instanceof LeaseLostError || signal.aborted) throw err
    await recover(deps, task, err)
  }
}
