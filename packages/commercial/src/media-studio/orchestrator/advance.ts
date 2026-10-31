// OCV5-591 A2-1a — advanceProject(): read the project under its advisory lock, ask decide() what to
// do, and apply it in the same transaction. Only one process advances a project at a time; any
// other caller returns immediately (the lock holder will see the new state on its next pass).

import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

import { MUSE_SOURCE_FAILED_TEXT, isMuseSourceFailure } from '../providers/museFailures.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { type MediaOp, type MediaRequest, defaultModelFor, kindOf } from '../providers/types.js'
import { enqueueStudioTask } from '../queue.js'
import { appendStudioEvent } from '../store.js'
import { type ShotRedo, settleAnnotations } from './annotate.js'
import { reserveBudget } from './budget.js'
import { DEFAULT_VARIANT } from './composeJob.js'
import { type Action, type DQa, type DState, type Dispatch, decide } from './decide.js'
import { type BibleEntry, biblePrompt, framePrompt, videoPrompt, withAvoid } from './prompts.js'
import { type StudioQaDeps, qaGates } from './qa.js'
import { providerPauseMessage } from './providerFailure.js'

export interface AdvanceDeps {
  pool: Pool
  providers: ProviderRegistry
  /** OCV5-591 A2-1c: the compose sandbox; absent or unconfigured → compose_pending. */
  compose?: { configured(): boolean }
  /** OCV5-591 A2-1b-1: visual QA (absent or disabled → takes are used as they come). */
  qa?: StudioQaDeps
}

/** A2-1b-2: a shot redone from an annotation ignores versions older than these. */
function redoOf(spec: Record<string, unknown> | null | undefined): {
  redo?: { frame: number; video: number }
} {
  const r = spec?.redo as { frame?: unknown; video?: unknown } | undefined
  if (!r || typeof r !== 'object') return {}
  const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0)
  return { redo: { frame: n(r.frame), video: n(r.video) } }
}

function dqa(raw: unknown): DQa | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const q = raw as Record<string, unknown>
  const issues = Array.isArray(q.issues) ? q.issues : []
  return {
    passed: q.passed === true,
    skipped: q.skipped === true,
    next: q.next === 'adopt' || q.next === 'redo' || q.next === 'handoff' ? q.next : null,
    score: typeof q.score === 'number' ? q.score : null,
    avoid: issues
      .map((i) => (i && typeof i === 'object' ? (i as { what?: unknown }).what : null))
      .filter((w): w is string => typeof w === 'string')
      .slice(0, 5),
  }
}

const REPRESENTATIVE_OP: Record<'image' | 'video' | 'voice' | 'music', MediaOp> = {
  image: 'image.generate',
  video: 'video.from_image',
  voice: 'voice.tts',
  music: 'music.generate',
}

interface ProjectRow {
  id: string
  user_id: string
  status: DState['status']
  aspect: '16:9' | '9:16' | '1:1'
  settings: Record<string, unknown>
}

export async function loadState(
  client: PoolClient,
  deps: AdvanceDeps,
  projectId: string,
): Promise<{
  project: ProjectRow
  state: DState
  bible: Array<BibleEntry & { id: string; blobSha: string | null }>
  specs: Map<string, Record<string, unknown>>
  lineText: Map<string, string>
} | null> {
  const p = await client.query<ProjectRow>(
    `SELECT id::text AS id, user_id::text AS user_id, status, aspect, settings
       FROM studio_projects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [projectId],
  )
  const project = p.rows[0]
  if (!project) return null
  const [shots, lines, assets, takes, tasks] = await Promise.all([
    client.query<{
      id: string
      ordinal: number
      status: string
      active_take_id: string | null
      spec: Record<string, unknown>
    }>(
      `SELECT id::text AS id, ordinal, status, active_take_id::text AS active_take_id, spec
         FROM studio_shots WHERE project_id = $1`,
      [projectId],
    ),
    client.query<{ id: string; status: string; active_take_id: string | null; text: string }>(
      `SELECT id::text AS id, status, active_take_id::text AS active_take_id, text
         FROM studio_lines WHERE project_id = $1`,
      [projectId],
    ),
    client.query<{
      id: string
      kind: string
      locked: boolean
      blob_sha: string | null
      name: string
      descriptor: string
    }>(
      `SELECT id::text AS id, kind, locked, blob_sha, name, descriptor
         FROM studio_assets WHERE project_id = $1 AND user_id = $2`,
      [projectId, project.user_id],
    ),
    client.query<{
      id: string
      owner_kind: string
      owner_id: string
      version: number
      provider: string
      status: string
      blob_sha: string | null
      qa: unknown
      error_code: string | null
      meta: Record<string, unknown>
    }>(
      `SELECT id::text AS id, owner_kind, owner_id::text AS owner_id, version, provider, status, blob_sha, qa, error_code, meta
         FROM studio_takes WHERE project_id = $1`,
      [projectId],
    ),
    client.query<{ kind: string; n: string; qa_takes: string[] | null }>(
      `SELECT kind, COUNT(*)::text AS n,
              array_agg(payload->>'takeId') FILTER (WHERE kind = 'qa') AS qa_takes
         FROM studio_tasks
        WHERE project_id = $1 AND status IN ('queued', 'leased') GROUP BY kind`,
      [projectId],
    ),
  ])
  const user = { id: project.user_id }
  const can = (k: keyof typeof REPRESENTATIVE_OP) =>
    deps.providers.candidates(k, REPRESENTATIVE_OP[k], user, { includeOffline: true }).length > 0
  // A2-1b-1: QA calls count against the in-flight budget like generations.
  const inflight = tasks.rows
    .filter((t) => t.kind === 'gen' || t.kind === 'qa')
    .reduce((s, t) => s + Number(t.n), 0)
  const settings = project.settings ?? {}
  const narration = settings.narration as { voiceId?: unknown } | null | undefined
  const state: DState = {
    status: project.status,
    hasPlanTask: tasks.rows.some((t) => t.kind === 'plan'),
    inflight,
    shots: shots.rows.map((s) => ({
      id: s.id,
      ordinal: s.ordinal,
      status: s.status as DState['shots'][number]['status'],
      activeTakeId: s.active_take_id,
      frameTakeId: typeof s.spec?.frameTakeId === 'string' ? s.spec.frameTakeId : null,
      ...redoOf(s.spec),
    })),
    lines: lines.rows.map((l) => ({
      id: l.id,
      status: l.status as DState['lines'][number]['status'],
      activeTakeId: l.active_take_id,
    })),
    assets: assets.rows.map((a) => ({
      id: a.id,
      kind: a.kind as DState['assets'][number]['kind'],
      locked: a.locked,
      blobSha: a.blob_sha,
    })),
    takes: takes.rows.map((t) => ({
      id: t.id,
      ownerKind: t.owner_kind as DState['takes'][number]['ownerKind'],
      ownerId: t.owner_id,
      version: t.version,
      provider: t.provider,
      status: t.status as DState['takes'][number]['status'],
      blobSha: t.blob_sha,
      errorCode: t.error_code,
      providerFailureAcknowledged: t.meta?.providerFailureAcknowledged === true,
      qa: dqa(t.qa),
    })),
    narrationVoiceId: typeof narration?.voiceId === 'string' ? narration.voiceId : null,
    musicSkippedNoted: settings.musicSkippedNoted === true,
    canCompose: deps.compose?.configured() ?? false,
    composeQueued: tasks.rows.some((t) => t.kind === 'compose'),
    qa: qaGates(deps),
    bibleCandidates: deps.qa?.bibleCandidates ?? 1,
    qaQueued: tasks.rows.flatMap((t) => (t.kind === 'qa' ? (t.qa_takes ?? []) : [])),
    canDispatch: {
      image: can('image'),
      video: can('video'),
      voice: can('voice'),
      music: can('music'),
    },
  }
  const bible = assets.rows
    .filter((a) => a.kind === 'character' || a.kind === 'scene' || a.kind === 'style')
    .map((a) => ({
      id: a.id,
      kind: a.kind as BibleEntry['kind'],
      name: a.name,
      descriptor: a.descriptor,
      blobSha: a.blob_sha,
    }))
  return {
    project,
    state,
    bible,
    specs: new Map(shots.rows.map((s) => [s.id, s.spec ?? {}])),
    lineText: new Map(lines.rows.map((l) => [l.id, l.text])),
  }
}

function buildRequest(
  d: Dispatch,
  ctx: NonNullable<Awaited<ReturnType<typeof loadState>>>,
): MediaRequest {
  const aspect = ctx.project.aspect
  const inputs = d.inputs.map((i) => ({ role: i.role, blobSha: i.blobSha }))
  // A2-1b-1: a redo after QA carries what the judge said to avoid.
  if (d.ownerKind === 'bible') {
    const entry = ctx.bible.find((b) => b.id === d.ownerId)!
    return { op: d.op, prompt: withAvoid(biblePrompt(entry, aspect), d.avoid), aspect }
  }
  if (d.ownerKind === 'shot_frame') {
    const spec = ctx.specs.get(d.ownerId) ?? {}
    const base = framePrompt(spec, ctx.bible, aspect)
    // A2-1b-2: a shot redone from an annotation keeps the change on every retry and fallback.
    const redo = (spec.redo ?? null) as ShotRedo | null
    if (redo?.edit) {
      const r = redo.edit.region
      const where = `画面中 x ${Math.round(r.x * 100)}%–${Math.round((r.x + r.w) * 100)}%、y ${Math.round(r.y * 100)}%–${Math.round((r.y + r.h) * 100)}% 的区域`
      return {
        op: 'image.edit',
        prompt: withAvoid(
          `只修改${where}：${redo.edit.instruction}。其余部分保持完全不变。\n${base}`,
          d.avoid,
        ),
        aspect,
        inputs: [
          { role: 'source', blobSha: redo.edit.source },
          ...(redo.edit.reference
            ? [{ role: 'reference' as const, blobSha: redo.edit.reference }]
            : []),
        ],
      }
    }
    return {
      op: d.op,
      prompt: withAvoid(redo?.delta ? `${base}\n修改要求：${redo.delta}` : base, d.avoid),
      aspect,
      inputs,
    }
  }
  if (d.ownerKind === 'shot_video') {
    const spec = ctx.specs.get(d.ownerId) ?? {}
    const dur = Number(spec.durationSec)
    // A video-only redo from an annotation keeps its change on every retry and fallback.
    const videoDelta = ((spec.redo ?? null) as ShotRedo | null)?.videoDelta
    const base = videoPrompt(spec)
    return {
      op: d.op,
      prompt: withAvoid(videoDelta ? `${base}\n修改要求：${videoDelta}` : base, d.avoid, 1000),
      aspect,
      inputs,
      ...(Number.isFinite(dur) ? { durationSec: dur } : {}),
    }
  }
  // line
  return {
    op: d.op,
    text: ctx.lineText.get(d.ownerId) ?? '',
    voiceId: ctx.state.narrationVoiceId ?? '',
  }
}

const OWNER_TABLE: Record<string, string> = {
  // A project's music take is owned by the project itself (OCV5-591 M1).
  music: 'studio_projects',
  bible: 'studio_assets',
  shot_frame: 'studio_shots',
  shot_video: 'studio_shots',
  line: 'studio_lines',
}

/** Dispatch one generation: reserve budget, create the take, enqueue the task bound to it. */
async function dispatchOne(
  client: PoolClient,
  deps: AdvanceDeps,
  ctx: NonNullable<Awaited<ReturnType<typeof loadState>>>,
  d: Dispatch,
): Promise<'queued' | 'budget' | 'no_provider'> {
  const req = buildRequest(d, ctx)
  // A redone first frame may be an edit of the current one: the provider is picked for that op.
  return dispatchRequest(
    client,
    deps,
    { id: ctx.project.id, userId: ctx.project.user_id },
    req.op === d.op ? d : { ...d, op: req.op },
    req,
  )
}

/**
 * The one dispatch path (also used for user-made voices): pick a provider, reserve its worst case,
 * create the take under the owner's lock and enqueue the task bound to it.
 */
export async function dispatchRequest(
  client: PoolClient,
  deps: AdvanceDeps,
  project: { id: string; userId: string },
  d: Pick<Dispatch, 'ownerKind' | 'ownerId' | 'op' | 'exclude'> & {
    /** Only this provider (the source the user picked); no fallback to another one. */
    only?: string
    /** A2-1b-2: the task's key (an annotation execution's per-target key); default per version. */
    idempotencyKey?: string
  },
  req: MediaRequest,
): Promise<'queued' | 'budget' | 'no_provider'> {
  const ctx = { project: { id: project.id, user_id: project.userId } }
  const user = { id: project.userId }
  const provider = deps.providers
    .candidates(kindOf(d.op), d.op, user, { includeOffline: true, exclude: d.exclude })
    .filter((p) => !d.only || p.id === d.only)[0]
  if (!provider) return 'no_provider'
  const est = provider.estimateMaxCost(req)
  if (!(await reserveBudget(client, ctx.project.id, est))) return 'budget'
  // Lock the owner so two dispatches can never compute the same next version (plan r1 P1-2).
  await client.query(`SELECT 1 FROM ${OWNER_TABLE[d.ownerKind]} WHERE id = $1 FOR UPDATE`, [
    d.ownerId,
  ])
  const v = await client.query<{ next: number }>(
    'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM studio_takes WHERE owner_kind = $1 AND owner_id = $2',
    [d.ownerKind, d.ownerId],
  )
  const version = v.rows[0]!.next
  const takeId = randomUUID()
  // The default model for this op (a provider's overall default may not run it, e.g. MiniMax TTS
  // vs voice design); frozen into the task so a re-claim runs the same model.
  const model = req.model ?? defaultModelFor(provider, d.op)?.id ?? ''
  await client.query(
    `INSERT INTO studio_takes(id, project_id, owner_kind, owner_id, version, provider, model, op, inputs, prompt, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 'queued')`,
    [
      takeId,
      ctx.project.id,
      d.ownerKind,
      d.ownerId,
      version,
      provider.id.slice(0, 32),
      model.slice(0, 64),
      d.op.slice(0, 32),
      JSON.stringify({ inputs: req.inputs ?? [] }),
      (req.prompt ?? req.text ?? null)?.slice(0, 8000) ?? null,
    ],
  )
  const affinity = provider.affinity()
  await enqueueStudioTask(client, {
    projectId: ctx.project.id,
    kind: 'gen',
    idempotencyKey: d.idempotencyKey ?? `gen:${d.ownerKind}:${d.ownerId}:v${version}`,
    payload: {
      takeId,
      providerId: provider.id,
      ownerKind: d.ownerKind,
      ownerId: d.ownerId,
      request: { ...req, model },
      booked: '0',
    },
    reservedCredits: est,
    ...(affinity === 'muse' ? { affinity: 'muse' as const } : {}),
  })
  await appendStudioEvent(client, ctx.project.id, 'take.queued', {
    ownerKind: d.ownerKind,
    ownerId: d.ownerId,
    provider: provider.id,
    version,
  })
  return 'queued'
}

/**
 * One QA call for a finished take (A2-1b-1): reserve its worst case against the project budget
 * and enqueue it once per take. A call the catalog cannot price now is not dispatched at all
 * (code r1 P1: a zero reservation would let it spend past the budget); the next pass tries again.
 */
async function dispatchQa(
  client: PoolClient,
  deps: AdvanceDeps,
  projectId: string,
  takeId: string,
): Promise<'queued' | 'budget' | 'exists' | 'unpriced'> {
  const est = deps.qa?.maxCost ? await deps.qa.maxCost().catch(() => null) : 0n
  if (est === null) {
    const noted = await client.query(
      `UPDATE studio_projects SET settings = settings || '{"qaUnpricedNoted":true}'::jsonb
        WHERE id = $1 AND NOT (settings ? 'qaUnpricedNoted') RETURNING id`,
      [projectId],
    )
    if (noted.rowCount) {
      await appendStudioEvent(client, projectId, 'qa.waiting', {
        message: '质检暂时没法估价（模型目录不可用），恢复后自动继续。',
      })
    }
    return 'unpriced'
  }
  if (!(await reserveBudget(client, projectId, est))) return 'budget'
  const r = await enqueueStudioTask(client, {
    projectId,
    kind: 'qa',
    idempotencyKey: `qa:${takeId}`,
    payload: { takeId, booked: '0' },
    reservedCredits: est,
  })
  if (!r.created) {
    // Already judged or judging: give the reservation back.
    await client.query(
      'UPDATE studio_projects SET reserved_credits = GREATEST(0, reserved_credits - $2) WHERE id = $1',
      [projectId, est.toString()],
    )
    return 'exists'
  }
  return 'queued'
}

async function apply(
  client: PoolClient,
  deps: AdvanceDeps,
  ctx: NonNullable<Awaited<ReturnType<typeof loadState>>>,
  actions: Action[],
): Promise<void> {
  const id = ctx.project.id
  for (const a of actions) {
    if (a.type === 'enqueue_plan') {
      const rev = await client.query<{ rev: number }>(
        'SELECT rev FROM studio_projects WHERE id = $1',
        [id],
      )
      await enqueueStudioTask(client, {
        projectId: id,
        kind: 'plan',
        idempotencyKey: `plan:${id}:${rev.rows[0]!.rev}`,
      })
    } else if (a.type === 'dispatch') {
      const r = await dispatchOne(client, deps, ctx, a.dispatch)
      if (r === 'budget') {
        await client.query(
          `UPDATE studio_projects SET status = 'paused', settings = settings || '{"pausedReason":"budget"}'::jsonb,
                  rev = rev + 1, updated_at = NOW() WHERE id = $1`,
          [id],
        )
        await appendStudioEvent(client, id, 'budget.exhausted', {
          message: '预算不够下一步了，已暂停。调高预算后点“继续”。',
        })
        return
      }
      if (r === 'no_provider') {
        const d = a.dispatch
        if (d.ownerKind === 'shot_frame' || d.ownerKind === 'shot_video') {
          await client.query(`UPDATE studio_shots SET status = 'needs_user' WHERE id = $1`, [
            d.ownerId,
          ])
        } else if (d.ownerKind === 'line') {
          await client.query(`UPDATE studio_lines SET status = 'failed' WHERE id = $1`, [d.ownerId])
        }
        // Name the cause when the last try was Muse failing on the image it carries (OCV5-591).
        const last = await client.query<{
          provider: string
          op: string
          error_code: string | null
        }>(
          `SELECT provider, op, error_code FROM studio_takes
            WHERE project_id = $1 AND owner_kind = $2 AND owner_id = $3 AND status = 'failed'
            ORDER BY created_at DESC LIMIT 1`,
          [id, d.ownerKind, d.ownerId],
        )
        const lf = last.rows[0]
        await appendStudioEvent(client, id, 'provider.exhausted', {
          ownerKind: d.ownerKind,
          ownerId: d.ownerId,
          message:
            lf && isMuseSourceFailure(lf.provider, lf.op, lf.error_code)
              ? `${MUSE_SOURCE_FAILED_TEXT}，其它服务也试过了。这一步需要你看一下，可以稍后再试一次。`
              : '可用的服务都试过了，这一步需要你看一下。',
        })
        if (d.ownerKind === 'bible') {
          // Nothing marks an asset as stuck and every frame waits on it: hand the project over.
          await client.query(
            `UPDATE studio_projects SET status = 'awaiting_user',
                    settings = settings || '{"awaitingReason":"needs_user"}'::jsonb,
                    rev = rev + 1, updated_at = NOW()
              WHERE id = $1 AND status = 'running'`,
            [id],
          )
          return
        }
      }
    } else if (a.type === 'dispatch_qa') {
      if ((await dispatchQa(client, deps, id, a.takeId)) === 'budget') {
        await client.query(
          `UPDATE studio_projects SET status = 'paused', settings = settings || '{"pausedReason":"budget"}'::jsonb,
                  rev = rev + 1, updated_at = NOW() WHERE id = $1`,
          [id],
        )
        await appendStudioEvent(client, id, 'budget.exhausted', {
          message: '预算不够做质检了，已暂停。调高预算后点“继续”。',
        })
        return
      }
    } else if (a.type === 'lock_bible') {
      await client.query(
        `UPDATE studio_assets a SET blob_sha = t.blob_sha, locked = TRUE
           FROM studio_takes t
          WHERE a.id = $1 AND a.project_id = $3 AND NOT a.locked AND t.id = $2 AND t.blob_sha IS NOT NULL`,
        [a.assetId, a.takeId, id],
      )
    } else if (a.type === 'adopt_video') {
      await client.query(
        `UPDATE studio_shots SET active_take_id = $2, status = 'ready'
          WHERE id = $1 AND project_id = $3 AND status NOT IN ('needs_user', 'failed')`,
        [a.shotId, a.takeId, id],
      )
    } else if (a.type === 'shot_status') {
      await client.query('UPDATE studio_shots SET status = $2 WHERE id = $1 AND project_id = $3', [
        a.shotId,
        a.status,
        id,
      ])
    } else if (a.type === 'line_status') {
      await client.query('UPDATE studio_lines SET status = $2 WHERE id = $1 AND project_id = $3', [
        a.lineId,
        a.status,
        id,
      ])
    } else if (a.type === 'enqueue_compose') {
      const rev = await client.query<{ rev: number }>(
        'SELECT rev FROM studio_projects WHERE id = $1',
        [id],
      )
      await enqueueStudioTask(client, {
        projectId: id,
        kind: 'compose',
        idempotencyKey: `compose:${id}:auto:${rev.rows[0]!.rev}`,
        payload: { reason: 'auto', variant: DEFAULT_VARIANT },
      })
    } else if (a.type === 'note_music_skipped') {
      await client.query(
        `UPDATE studio_projects SET settings = settings || '{"musicSkippedNoted":true}'::jsonb WHERE id = $1`,
        [id],
      )
      await appendStudioEvent(client, id, 'music.skipped', {
        message: '音乐生成未配置，这次不配乐。',
      })
    } else if (a.type === 'set_status') {
      await client.query(
        `UPDATE studio_projects
            SET status = $2, settings = settings || jsonb_build_object('awaitingReason', $3::text),
                rev = rev + 1, updated_at = NOW()
          WHERE id = $1`,
        [id, a.status, a.reason ?? null],
      )
      await appendStudioEvent(client, id, `project.${a.status}`, {
        reason: a.reason ?? null,
        ...(a.providerCode ? { code: a.providerCode } : {}),
        message:
          a.providerCode ? providerPauseMessage(a.providerCode) : a.status === 'composing'
            ? '镜头和配音都好了，导演 agent 开始合成成片。'
            : a.reason === 'compose_pending'
              ? '镜头和配音都好了，等待合成（合成沙箱未配置）。'
              : a.reason === 'needs_user'
                ? '有镜头需要你看一下。'
                : undefined,
      })
    }
  }
}

/** Advance once. Returns false when another process holds the project's advance lock. */
export async function advanceProject(deps: AdvanceDeps, projectId: string): Promise<boolean> {
  const client = await deps.pool.connect()
  try {
    await client.query('BEGIN')
    const lock = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext('studio-advance:' || $1)) AS ok`,
      [projectId],
    )
    if (!lock.rows[0]?.ok) {
      await client.query('ROLLBACK')
      return false
    }
    // A2-1b-2: an annotation's execution is applied / failed once its targets settle — before the
    // decisions (a finished one frees its target) and after them (code r2 P1: a project this very
    // pass hands to the user ends what was waiting on it; nothing else would settle it later).
    await settleAnnotations(client, projectId)
    const ctx = await loadState(client, deps, projectId)
    if (ctx) await apply(client, deps, ctx, decide(ctx.state))
    await settleAnnotations(client, projectId)
    await client.query('COMMIT')
    return true
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
