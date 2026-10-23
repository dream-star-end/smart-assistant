// OCV5-591 A2-1b-2 — running an interpreted annotation (plan §2.2): one claim per execution; the
// change is recorded on its target and the director (decide) does the generating.
//
//   - claim: `sent` + an op + no execution running (or the last one failed) → execution n+1
//     running. Auto-apply and a user's apply share this one entry, so two applies (or an apply
//     racing auto-apply) start one execution (plan r1 P1).
//   - the change lives on the target, not in a one-off request (code r1 P1): a shot carries
//     `spec.redo` (version floors + the prompt delta or the frame edit), a line its new text and the
//     narration its new voice. decide dispatches from it — one generation per owner at a time, and
//     a retry or a fallback provider redoes the same change. Runs never lose it.
//   - a finished / composing / waiting project is reopened in the claim's transaction; an export
//     asked for meanwhile waits for the new film (compose start).
//   - one execution per target at a time: a second annotation on a shot or line being changed
//     fails with "busy" instead of racing it (code r1 P1).
//   - settleAnnotations() (each advance) applies it once every target is ready on a version made
//     for it, or fails it when a target or the project was handed to the user.

import type { PoolClient } from 'pg'

import { appendStudioEvent } from '../store.js'
import type { Interpretation } from './interpret.js'

export type Target =
  | { kind: 'shot'; id: string; minVideo: number }
  | { kind: 'line'; id: string; minVersion: number }

/** A redo the director builds its next first frame from (advance.buildRequest). */
export interface ShotRedo {
  frame: number
  video: number
  delta?: string
  edit?: {
    source: string
    reference: string | null
    instruction: string
    region: { x: number; y: number; w: number; h: number }
  }
}

class AnnotationRunError extends Error {
  constructor(readonly code: 'target_gone' | 'target_busy') {
    super(code)
    this.name = 'AnnotationRunError'
  }
}

const OPEN = ['running', 'awaiting_user', 'composing', 'done', 'paused']

const nextVersion = async (c: PoolClient, ownerKind: string, ownerId: string) =>
  (
    await c.query<{ next: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM studio_takes WHERE owner_kind = $1 AND owner_id = $2',
      [ownerKind, ownerId],
    )
  ).rows[0]!.next

/** The ids an instruction changes (to keep one execution per target). */
async function touches(c: PoolClient, projectId: string, i: Interpretation): Promise<string[]> {
  if (i.op === 'regenerate_shot' || i.op === 'edit_frame' || i.op === 'retime_shot')
    return [i.args.shotId]
  if (i.op === 'change_line') return [i.args.lineId]
  if (i.op === 'swap_voice')
    return (
      await c.query<{ id: string }>(
        'SELECT id::text AS id FROM studio_lines WHERE project_id = $1',
        [projectId],
      )
    ).rows.map((r) => r.id)
  return []
}

/**
 * Claim and start one execution. Returns false when there is nothing to claim (already running,
 * applied, rejected, no op) or the project cannot take work (canceled / failed / not started).
 */
export async function executeAnnotation(
  c: PoolClient,
  projectId: string,
  annotationId: string,
): Promise<'running' | 'applied' | 'failed' | false> {
  const p = await c.query<{ status: string }>(
    'SELECT status FROM studio_projects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
    [projectId],
  )
  if (!p.rows[0] || !OPEN.includes(p.rows[0].status)) return false
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
  const i = row.interpretation
  await c.query('SAVEPOINT annot_run')
  try {
    // One execution per target: another annotation changing it now would race this one.
    const ids = await touches(c, projectId, i)
    if (ids.length) {
      const busy = await c.query(
        `SELECT 1 FROM studio_annotations a, jsonb_array_elements(COALESCE(a.interpretation->'execution'->'targets', '[]'::jsonb)) t
          WHERE a.project_id = $1 AND a.id <> $2 AND a.status = 'sent'
            AND a.interpretation->'execution'->>'state' = 'running' AND t->>'id' = ANY($3::text[]) LIMIT 1`,
        [projectId, annotationId, ids],
      )
      if (busy.rowCount) throw new AnnotationRunError('target_busy')
      // A line with a voice take still on its way would be overwritten by that older take.
      const live = await c.query(
        `SELECT 1 FROM studio_takes WHERE project_id = $1 AND owner_kind = 'line'
            AND owner_id::text = ANY($2::text[]) AND status IN ('queued', 'running') LIMIT 1`,
        [projectId, ids],
      )
      if (live.rowCount && (i.op === 'change_line' || i.op === 'swap_voice'))
        throw new AnnotationRunError('target_busy')
    }
    const targets: Target[] = []
    const redoShot = async (
      shotId: string,
      from: 'frame' | 'video',
      extra: Partial<ShotRedo> = {},
    ) => {
      const redo: ShotRedo = {
        frame: from === 'frame' ? await nextVersion(c, 'shot_frame', shotId) : 0,
        video: await nextVersion(c, 'shot_video', shotId),
        ...extra,
      }
      const r = await c.query(
        `UPDATE studio_shots SET status = 'generating', active_take_id = NULL,
                spec = (spec - 'frameTakeId') || jsonb_build_object('redo', $2::jsonb)
          WHERE id = $1 AND project_id = $3`,
        [shotId, JSON.stringify(redo), projectId],
      )
      if (!r.rowCount) throw new AnnotationRunError('target_gone')
      targets.push({ kind: 'shot', id: shotId, minVideo: redo.video })
    }
    const redoLine = async (lineId: string, text?: string) => {
      const minVersion = await nextVersion(c, 'line', lineId)
      const r = await c.query(
        // The old voice take is let go (code r2 P1): the film's inputs change at once, so a compose
        // in flight (an export) never publishes the old voice while the new one waits.
        `UPDATE studio_lines SET status = 'planned', active_take_id = NULL, text = COALESCE($2, text)
          WHERE id = $1 AND project_id = $3`,
        [lineId, text ?? null, projectId],
      )
      if (!r.rowCount) throw new AnnotationRunError('target_gone')
      targets.push({ kind: 'line', id: lineId, minVersion })
    }

    if (i.op === 'adopt_take') {
      if (!(await adoptTakeIn(c, projectId, i.args.takeId)))
        throw new AnnotationRunError('target_gone')
    } else if (i.op === 'regenerate_shot') {
      await redoShot(i.args.shotId, 'frame', { delta: i.args.promptDelta })
    } else if (i.op === 'edit_frame') {
      const source = await currentFrame(c, i.args.shotId)
      if (!source) throw new AnnotationRunError('target_gone')
      await redoShot(i.args.shotId, 'frame', {
        edit: {
          source,
          reference: row.frame_blob_sha,
          instruction: i.args.instruction,
          region: i.args.region,
        },
      })
    } else if (i.op === 'retime_shot') {
      const r = await c.query(
        `UPDATE studio_shots SET spec = jsonb_set(spec, '{durationSec}', to_jsonb($2::float8)) WHERE id = $1 AND project_id = $3`,
        [i.args.shotId, i.args.durationSec, projectId],
      )
      if (!r.rowCount) throw new AnnotationRunError('target_gone')
      // The same first frame, a new video of the new length.
      await redoShot(i.args.shotId, 'video')
    } else if (i.op === 'change_line') {
      await redoLine(i.args.lineId, i.args.text)
    } else if (i.op === 'swap_voice') {
      await c.query(
        `UPDATE studio_projects
            SET settings = jsonb_set(settings, '{narration}', COALESCE(settings->'narration', '{}'::jsonb) || jsonb_build_object('voiceId', $2::text))
          WHERE id = $1`,
        [projectId, i.args.voiceId],
      )
      for (const id of await touches(c, projectId, i)) await redoLine(id)
    }

    // A finished film (or one waiting on the user, or being composed) goes back to the director.
    const reopened = await c.query(
      `UPDATE studio_projects SET status = 'running', settings = settings - 'awaitingReason',
              rev = rev + 1, updated_at = NOW()
        WHERE id = $1 AND status IN ('done', 'awaiting_user', 'composing') RETURNING id`,
      [projectId],
    )
    // Paused: resuming lands on the director, which picks the change up.
    await c.query(
      `UPDATE studio_projects SET settings = settings || '{"resumeTo":"running"}'::jsonb
        WHERE id = $1 AND status = 'paused' AND settings->>'resumeTo' IN ('done', 'composing', 'awaiting_user')`,
      [projectId],
    )
    if (reopened.rowCount) {
      await appendStudioEvent(c, projectId, 'project.reopened', {
        annotationId,
        message: '按你的批注重新制作，完成后会重新合成成片（不收费）。',
      })
    }
    if (i.op === 'adopt_take') {
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
    // Nothing of this execution stays; it is recorded failed and can be tried again.
    await c.query('ROLLBACK TO SAVEPOINT annot_run')
    await failExecution(c, projectId, annotationId, err.code)
    return 'failed'
  }
}

const FAIL_MESSAGE: Record<string, string> = {
  target_gone: '批注指向的内容已经不在了。',
  target_busy: '这一项正在按另一条批注修改，等它完成后可以再试。',
  needs_user: '按批注重做的版本需要你看一下，可以选一个版本，或再试一次。',
  user_chose: '你选了另一个版本，这条批注没有继续执行；需要的话可以再试一次。',
}

async function failExecution(c: PoolClient, projectId: string, annotationId: string, code: string) {
  await c.query(
    `UPDATE studio_annotations
        SET interpretation = jsonb_set(jsonb_set(interpretation, '{execution,state}', '"failed"'),
                                       '{execution,error}', to_jsonb($2::text))
      WHERE id = $1`,
    [annotationId, code],
  )
  await appendStudioEvent(c, projectId, 'annotation.failed', {
    annotationId,
    message: FAIL_MESSAGE[code] ?? '这条批注没执行成功，可以再试一次。',
  })
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
      `UPDATE studio_shots SET active_take_id = $2, status = 'ready', spec = spec - 'frameTakeId' - 'redo' WHERE id = $1`,
      [t.owner_id, takeId],
    )
  } else if (t.owner_kind === 'shot_frame') {
    await c.query(
      `UPDATE studio_shots SET status = 'generating', active_take_id = NULL,
              spec = jsonb_set(spec - 'redo', '{frameTakeId}', to_jsonb($2::text)) WHERE id = $1`,
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
 * for it (new takes go through QA as usual); it fails when a target was handed to the user, or the
 * project stopped (waiting on the user, failed, canceled) with a target still unfinished.
 */
export async function settleAnnotations(c: PoolClient, projectId: string): Promise<void> {
  const running = await c.query<{ id: string; targets: Target[] | null; pstatus: string }>(
    `SELECT a.id::text AS id, a.interpretation->'execution'->'targets' AS targets, p.status AS pstatus
       FROM studio_annotations a JOIN studio_projects p ON p.id = a.project_id
      WHERE a.project_id = $1 AND a.status = 'sent' AND a.interpretation->'execution'->>'state' = 'running'`,
    [projectId],
  )
  for (const a of running.rows) {
    const stopped = ['awaiting_user', 'failed', 'canceled'].includes(a.pstatus)
    let pending = false
    let failed = false
    let chose = false
    let last: string | null = null
    for (const t of a.targets ?? []) {
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
      else if (s.status === 'ready')
        chose = true // the user picked an older version meanwhile
      else if (stopped) failed = true
      else pending = true
    }
    if (pending && !failed && !chose) continue
    if (failed || chose) {
      await failExecution(c, projectId, a.id, failed ? 'needs_user' : 'user_chose')
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
