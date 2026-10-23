// OCV5-591 A2-1b-2 — running an interpreted annotation (plan §2.2): one claim per execution, all
// of its dispatches in the claim's transaction, and completion read from the targets afterwards.
//
//   - claim: `sent` + an op + no execution running (or the last one failed) → execution n+1
//     running. Auto-apply and a user's apply share this one entry, so two applies (or an apply
//     racing auto-apply) dispatch and reserve once (plan r1 P1).
//   - every generation of an execution gets its own stable key annot:<id>:<n>:<kind>:<owner>:<step>
//     (plan r2 P1), so a voice swap over many lines never dedupes its own lines.
//   - a finished project is reopened in the same transaction (plan r1 P1).
//   - settleAnnotations() (each advance) turns a running execution into applied / failed once its
//     targets are ready again (new takes judged by QA as usual) or were handed to the user.

import type { PoolClient } from 'pg'

import type { MediaRequest } from '../providers/types.js'
import { appendStudioEvent } from '../store.js'
import { type AdvanceDeps, dispatchRequest, loadState } from './advance.js'
import type { Interpretation } from './interpret.js'
import { framePrompt } from './prompts.js'

type Target =
  | { kind: 'shot'; id: string; minVideo: number }
  | { kind: 'line'; id: string; minVersion: number }

export class AnnotationRunError extends Error {
  constructor(readonly code: 'budget' | 'no_provider' | 'target_gone') {
    super(code)
    this.name = 'AnnotationRunError'
  }
}

const nextVersion = async (c: PoolClient, ownerKind: string, ownerId: string) =>
  (
    await c.query<{ next: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM studio_takes WHERE owner_kind = $1 AND owner_id = $2',
      [ownerKind, ownerId],
    )
  ).rows[0]!.next

/**
 * Claim and run one execution. Returns false when there is nothing to claim (already running,
 * applied, rejected, or no op). A dispatch that cannot happen (budget, no provider) rolls the
 * execution's own writes back and records it as failed, so the user can try again later.
 */
export async function executeAnnotation(
  c: PoolClient,
  deps: AdvanceDeps,
  projectId: string,
  annotationId: string,
): Promise<'running' | 'applied' | 'failed' | false> {
  const claim = await c.query<{
    n: number
    interpretation: Interpretation
    frame_blob_sha: string | null
  }>(
    `UPDATE studio_annotations
        SET interpretation = interpretation || jsonb_build_object('execution', jsonb_build_object(
              'n', COALESCE((interpretation->'execution'->>'n')::int, 0) + 1,
              'state', 'running', 'startedAt', NOW()))
      WHERE id = $1 AND project_id = $2 AND status = 'sent'
        AND interpretation->>'op' IS NOT NULL
        AND (interpretation->'execution' IS NULL OR interpretation->'execution'->>'state' = 'failed')
      RETURNING (interpretation->'execution'->>'n')::int AS n, interpretation, frame_blob_sha`,
    [annotationId, projectId],
  )
  const row = claim.rows[0]
  if (!row) return false
  const key = (kind: string, owner: string, step: string) =>
    `annot:${annotationId}:${row.n}:${kind}:${owner}:${step}`
  await c.query('SAVEPOINT annot_run')
  try {
    // A finished film (or one waiting on the user) goes back to the director (plan r1 P1).
    const reopened = await c.query(
      `UPDATE studio_projects SET status = 'running', settings = settings - 'awaitingReason',
              rev = rev + 1, updated_at = NOW()
        WHERE id = $1 AND status IN ('done', 'awaiting_user') RETURNING id`,
      [projectId],
    )
    if (reopened.rowCount) {
      await appendStudioEvent(c, projectId, 'project.reopened', {
        annotationId,
        message: '按你的批注重新制作，完成后会重新合成成片（不收费）。',
      })
    }
    const ctx = await loadState(c, deps, projectId)
    if (!ctx) throw new AnnotationRunError('target_gone')
    const project = { id: projectId, userId: ctx.project.user_id }
    const i = row.interpretation
    const targets: Target[] = []
    const dispatch = async (
      d: { ownerKind: 'shot_frame' | 'line'; ownerId: string; op: MediaRequest['op'] },
      req: MediaRequest,
      step: string,
    ) => {
      const r = await dispatchRequest(
        c,
        deps,
        project,
        { ...d, exclude: [], idempotencyKey: key(d.ownerKind, d.ownerId, step) },
        req,
      )
      if (r !== 'queued') throw new AnnotationRunError(r)
    }
    /** The shot starts over from a new first frame (or only a new video): older versions no longer count. */
    const redoShot = async (shotId: string, from: 'frame' | 'video') => {
      const frame = from === 'frame' ? await nextVersion(c, 'shot_frame', shotId) : 0
      const video = await nextVersion(c, 'shot_video', shotId)
      await c.query(
        `UPDATE studio_shots SET status = 'generating', active_take_id = NULL,
                spec = (spec - 'frameTakeId') || jsonb_build_object('redo', jsonb_build_object('frame', $2::int, 'video', $3::int))
          WHERE id = $1 AND project_id = $4`,
        [shotId, frame, video, projectId],
      )
      targets.push({ kind: 'shot', id: shotId, minVideo: video })
    }
    const spec = (shotId: string) => ctx.specs.get(shotId) ?? {}
    const aspect = ctx.project.aspect

    if (i.op === 'regenerate_shot') {
      const prompt = `${framePrompt(spec(i.args.shotId), ctx.bible, aspect)}\n修改要求：${i.args.promptDelta}`
      const refs = ctx.bible.flatMap((b) =>
        b.blobSha ? [{ role: 'reference' as const, blobSha: b.blobSha }] : [],
      )
      await redoShot(i.args.shotId, 'frame')
      await dispatch(
        { ownerKind: 'shot_frame', ownerId: i.args.shotId, op: 'image.generate' },
        { op: 'image.generate', prompt, aspect, inputs: refs },
        'frame',
      )
    } else if (i.op === 'edit_frame') {
      const source = await currentFrame(c, i.args.shotId)
      if (!source) throw new AnnotationRunError('target_gone')
      const r = i.args.region
      const where = `画面中 x ${Math.round(r.x * 100)}%–${Math.round((r.x + r.w) * 100)}%、y ${Math.round(r.y * 100)}%–${Math.round((r.y + r.h) * 100)}% 的区域`
      const prompt = `只修改${where}：${i.args.instruction}。其余部分保持完全不变。\n${framePrompt(spec(i.args.shotId), ctx.bible, aspect)}`
      await redoShot(i.args.shotId, 'frame')
      await dispatch(
        { ownerKind: 'shot_frame', ownerId: i.args.shotId, op: 'image.edit' },
        {
          op: 'image.edit',
          prompt,
          aspect,
          inputs: [
            { role: 'source', blobSha: source },
            ...(row.frame_blob_sha
              ? [{ role: 'reference' as const, blobSha: row.frame_blob_sha }]
              : []),
          ],
        },
        'edit',
      )
    } else if (i.op === 'retime_shot') {
      await c.query(
        `UPDATE studio_shots SET spec = jsonb_set(spec, '{durationSec}', to_jsonb($2::float8)) WHERE id = $1`,
        [i.args.shotId, i.args.durationSec],
      )
      // Same first frame, a new video of the new length: the director dispatches it.
      await redoShot(i.args.shotId, 'video')
    } else if (i.op === 'change_line') {
      const voiceId = ctx.state.narrationVoiceId
      if (!voiceId) throw new AnnotationRunError('no_provider')
      const minVersion = await nextVersion(c, 'line', i.args.lineId)
      await c.query(
        `UPDATE studio_lines SET text = $2, status = 'generating' WHERE id = $1 AND project_id = $3`,
        [i.args.lineId, i.args.text, projectId],
      )
      await dispatch(
        { ownerKind: 'line', ownerId: i.args.lineId, op: 'voice.tts' },
        { op: 'voice.tts', text: i.args.text, voiceId },
        'tts',
      )
      targets.push({ kind: 'line', id: i.args.lineId, minVersion })
    } else if (i.op === 'swap_voice') {
      await c.query(
        `UPDATE studio_projects
            SET settings = jsonb_set(settings, '{narration}', COALESCE(settings->'narration', '{}'::jsonb) || jsonb_build_object('voiceId', $2::text))
          WHERE id = $1`,
        [projectId, i.args.voiceId],
      )
      for (const [lineId, text] of ctx.lineText) {
        if (!text.trim()) continue
        const minVersion = await nextVersion(c, 'line', lineId)
        await c.query(`UPDATE studio_lines SET status = 'generating' WHERE id = $1`, [lineId])
        await dispatch(
          { ownerKind: 'line', ownerId: lineId, op: 'voice.tts' },
          { op: 'voice.tts', text, voiceId: i.args.voiceId },
          'tts',
        )
        targets.push({ kind: 'line', id: lineId, minVersion })
      }
    } else if (i.op === 'adopt_take') {
      const adopted = await adoptTakeIn(c, projectId, i.args.takeId)
      if (!adopted) throw new AnnotationRunError('target_gone')
      await c.query(
        `UPDATE studio_annotations
            SET status = 'applied', applied_take_id = $2,
                interpretation = jsonb_set(interpretation, '{execution,state}', '"done"')
          WHERE id = $1`,
        [annotationId, i.args.takeId],
      )
      await appendStudioEvent(c, projectId, 'annotation.applied', {
        annotationId,
        message: '已按批注采用你指定的版本。',
      })
      await c.query('RELEASE SAVEPOINT annot_run')
      return 'applied'
    }
    await c.query(
      `UPDATE studio_annotations
          SET interpretation = jsonb_set(interpretation, '{execution,targets}', $2::jsonb)
        WHERE id = $1`,
      [annotationId, JSON.stringify(targets)],
    )
    await appendStudioEvent(c, projectId, 'annotation.running', {
      annotationId,
      message: `按批注开始修改：${i.explanation}`,
    })
    await c.query('RELEASE SAVEPOINT annot_run')
    return 'running'
  } catch (err) {
    if (!(err instanceof AnnotationRunError)) throw err
    // Nothing of this execution stays (no take, no reservation, no reopen); it is recorded failed.
    await c.query('ROLLBACK TO SAVEPOINT annot_run')
    await c.query(
      `UPDATE studio_annotations
          SET interpretation = jsonb_set(jsonb_set(interpretation, '{execution,state}', '"failed"'),
                                         '{execution,error}', to_jsonb($2::text))
        WHERE id = $1`,
      [annotationId, err.code],
    )
    await appendStudioEvent(c, projectId, 'annotation.failed', {
      annotationId,
      message:
        err.code === 'budget'
          ? '预算不够执行这条批注，调高预算后可以再试。'
          : err.code === 'no_provider'
            ? '现在没有可用的服务执行这条批注，稍后可以再试。'
            : '批注指向的内容已经不在了。',
    })
    return 'failed'
  }
}

/** The shot's current first frame: its adopted video's, else its newest usable frame. */
async function currentFrame(c: PoolClient, shotId: string): Promise<string | null> {
  const r = await c.query<{ sha: string | null }>(
    `SELECT COALESCE(
       (SELECT v.inputs->'inputs'->0->>'blobSha' FROM studio_shots s JOIN studio_takes v ON v.id = s.active_take_id
         WHERE s.id = $1 AND v.owner_kind = 'shot_video'
           AND v.inputs->'inputs'->0->>'role' = 'first_frame'),
       (SELECT f.blob_sha FROM studio_takes f
         WHERE f.owner_kind = 'shot_frame' AND f.owner_id = $1 AND f.status = 'succeeded' AND f.blob_sha IS NOT NULL
           AND (f.qa IS NULL OR (f.qa->>'passed')::boolean IS TRUE OR (f.qa->>'skipped')::boolean IS TRUE)
         ORDER BY f.version DESC LIMIT 1)) AS sha`,
    [shotId],
  )
  return r.rows[0]?.sha ?? null
}

/**
 * Adopt a finished take of this project as the user would (same effect as selectTake, inside the
 * caller's transaction). false when the take is not a finished one of this project.
 */
export async function adoptTakeIn(
  c: PoolClient,
  projectId: string,
  takeId: string,
): Promise<boolean> {
  const t = (
    await c.query<{
      owner_kind: string
      owner_id: string
      blob_sha: string | null
      status: string
    }>(
      `SELECT owner_kind, owner_id::text AS owner_id, blob_sha, status FROM studio_takes
        WHERE id = $1 AND project_id = $2`,
      [takeId, projectId],
    )
  ).rows[0]
  if (!t || t.status !== 'succeeded' || !t.blob_sha) return false
  if (t.owner_kind === 'shot_video') {
    await c.query(
      `UPDATE studio_shots SET active_take_id = $2, status = 'ready', spec = spec - 'frameTakeId' WHERE id = $1`,
      [t.owner_id, takeId],
    )
  } else if (t.owner_kind === 'shot_frame') {
    await c.query(
      `UPDATE studio_shots SET status = 'generating', active_take_id = NULL,
              spec = jsonb_set(spec, '{frameTakeId}', to_jsonb($2::text)) WHERE id = $1`,
      [t.owner_id, takeId],
    )
  } else if (t.owner_kind === 'line') {
    await c.query(`UPDATE studio_lines SET active_take_id = $2, status = 'ready' WHERE id = $1`, [
      t.owner_id,
      takeId,
    ])
  } else if (t.owner_kind === 'bible') {
    await c.query('UPDATE studio_assets SET blob_sha = $2, locked = TRUE WHERE id = $1', [
      t.owner_id,
      t.blob_sha,
    ])
  } else {
    return false
  }
  return true
}

/**
 * Each advance: a running execution is applied once every target is ready again on a version made
 * for it (new takes go through QA as usual), or failed when a target was handed to the user.
 */
export async function settleAnnotations(c: PoolClient, projectId: string): Promise<void> {
  const running = await c.query<{ id: string; targets: Target[] | null }>(
    `SELECT id::text AS id, interpretation->'execution'->'targets' AS targets FROM studio_annotations
      WHERE project_id = $1 AND status = 'sent' AND interpretation->'execution'->>'state' = 'running'`,
    [projectId],
  )
  for (const a of running.rows) {
    const targets = a.targets ?? []
    let pending = false
    let failed = false
    let last: string | null = null
    for (const t of targets) {
      const r =
        t.kind === 'shot'
          ? await c.query<{ status: string; take: string | null; ok: boolean }>(
              `SELECT s.status, s.active_take_id::text AS take,
                      COALESCE(v.owner_kind = 'shot_video' AND v.version >= $2, FALSE) AS ok
                 FROM studio_shots s LEFT JOIN studio_takes v ON v.id = s.active_take_id WHERE s.id = $1`,
              [t.id, t.minVideo],
            )
          : await c.query<{ status: string; take: string | null; ok: boolean }>(
              `SELECT l.status, l.active_take_id::text AS take, COALESCE(v.version >= $2, FALSE) AS ok
                 FROM studio_lines l LEFT JOIN studio_takes v ON v.id = l.active_take_id WHERE l.id = $1`,
              [t.id, t.minVersion],
            )
      const s = r.rows[0]
      if (!s || s.status === 'needs_user' || s.status === 'failed') failed = true
      else if (s.status === 'ready' && s.ok) last = s.take
      else pending = true
    }
    if (pending && !failed) continue
    if (failed) {
      await c.query(
        `UPDATE studio_annotations
            SET interpretation = jsonb_set(jsonb_set(interpretation, '{execution,state}', '"failed"'),
                                           '{execution,error}', '"needs_user"')
          WHERE id = $1`,
        [a.id],
      )
      await appendStudioEvent(c, projectId, 'annotation.failed', {
        annotationId: a.id,
        message: '按批注重做的版本需要你看一下，可以选一个版本，或再发一次。',
      })
    } else {
      await c.query(
        `UPDATE studio_annotations
            SET status = 'applied', applied_take_id = $2::uuid,
                interpretation = jsonb_set(interpretation, '{execution,state}', '"done"')
          WHERE id = $1`,
        [a.id, last],
      )
      await appendStudioEvent(c, projectId, 'annotation.applied', {
        annotationId: a.id,
        message: '已按批注改好了。',
      })
    }
  }
}
