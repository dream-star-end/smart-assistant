// OCV5-591 A2-1a — user actions on the orchestrator: start a draft, approve a waiting plan, adopt a
// take. Each is one transaction scoped to the caller's project; the project is advanced afterwards.

import type { Pool, PoolClient } from 'pg'

import { randomUUID } from 'node:crypto'

import { HttpError } from '../../http/util.js'
import { ComposeSpecError, type MusicEdit, validateMusicEdit } from '../compose/spec.js'
import { voiceCustomOn } from '../providers/adapters/minimaxSpeech.js'
import type { MediaRequest } from '../providers/types.js'
import { enqueueStudioTask } from '../queue.js'
import { STUDIO_MAX_TARGET_SEC, appendStudioEvent } from '../store.js'
import { type AdvanceDeps, dispatchRequest } from './advance.js'
import { type AnnotationApi, makeAnnotationApi } from './annotations.js'
import { loadComposeInputs } from './compose.js'
import { parseVariant, variantKey } from './composeJob.js'

export interface OrchestratorApi {
  start(userId: string, projectId: string): Promise<void>
  approve(userId: string, projectId: string): Promise<void>
  selectTake(userId: string, takeId: string): Promise<{ projectId: string }>
  /** Design or clone a voice with MiniMax (user decision 2026-10-23 13:03); runs as a studio task. */
  createVoice(
    userId: string,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<{ assetId: string }>
  /** Use a ready designed / cloned voice for the narration lines not voiced yet. */
  useVoiceForNarration(userId: string, assetId: string): Promise<{ projectId: string }>
  /** OCV5-591 M1: use a catalog / library track as the project's music (a free music take). */
  selectMusic(
    userId: string,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<{ queued: true }>
  /** OCV5-591 M1: trim / place / loop / fades / ducking for the project's music. */
  setMusicEdit(userId: string, projectId: string, body: Record<string, unknown>): Promise<MusicEdit>
  /**
   * OCV5-591 A2-1c: the film in another export format. Free (user decision 2026-10-23 22:13);
   * a film already composed for the same format and inputs is returned instead of re-composing.
   */
  requestExport(
    userId: string,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<{ queued: true } | { reused: true; takeId: string }>
  /** Advance soon, off the request path. */
  kick(projectId: string): void
  /** OCV5-591 A2-1b-2: drafts, send → interpret, apply / reject. */
  annotations: AnnotationApi
}

const notFound = () => new HttpError(404, 'NOT_FOUND', 'not found')

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

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null

export function makeOrchestratorApi(
  pool: Pool,
  kick: (projectId: string) => void,
  deps?: AdvanceDeps,
): OrchestratorApi {
  return {
    kick,
    annotations: makeAnnotationApi(pool, deps, kick),
    async start(userId, projectId) {
      await inTx(pool, async (c) => {
        // One running project per user (backend plan §3): serialize the decision per user.
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`studio-user:${userId}`])
        const r = await c.query<{ status: string; brief: string; target_sec: number }>(
          `SELECT status, brief, target_sec FROM studio_projects
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`,
          [projectId, userId],
        )
        const p = r.rows[0]
        if (!p) throw notFound()
        if (p.status !== 'draft')
          throw new HttpError(409, 'STUDIO_BAD_TRANSITION', `cannot start a ${p.status} project`)
        if (!p.brief.trim())
          throw new HttpError(400, 'STUDIO_BRIEF_REQUIRED', 'write the brief first')
        if (p.target_sec > STUDIO_MAX_TARGET_SEC) {
          throw new HttpError(
            409,
            'STUDIO_TARGET_TOO_LONG',
            `target length must be at most ${STUDIO_MAX_TARGET_SEC} s`,
          )
        }
        const busy = await c.query(
          `SELECT 1 FROM studio_projects WHERE user_id = $1 AND id <> $2 AND deleted_at IS NULL
              AND status IN ('planning', 'running', 'composing') LIMIT 1`,
          [userId, projectId],
        )
        if (busy.rowCount)
          throw new HttpError(409, 'STUDIO_PROJECT_BUSY', 'another project is still running')
        await c.query(
          `UPDATE studio_projects SET status = 'planning', settings = settings - 'planFailed',
                  rev = rev + 1, updated_at = NOW() WHERE id = $1`,
          [projectId],
        )
        await appendStudioEvent(c, projectId, 'project.started', {
          message: '开拍了，导演 agent 正在写分镜。',
        })
      })
      kick(projectId)
    },
    async approve(userId, projectId) {
      await inTx(pool, async (c) => {
        const r = await c.query<{
          status: string
          reason: string | null
          est: string | null
          budget: string
          spent: string
        }>(
          `SELECT status, settings->>'awaitingReason' AS reason, settings->>'estimateCredits' AS est,
                  budget_credits::text AS budget, spent_credits::text AS spent
             FROM studio_projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`,
          [projectId, userId],
        )
        const p = r.rows[0]
        if (!p) throw notFound()
        // compose_failed: the user asks the director to compose the film again (free). Nothing
        // retried it and no page offered it, so a failed compose left the project stuck unless a
        // note was written (INC-20261027-STUDIO-COMPOSE-FAILED-NO-RETRY).
        if (
          p.status !== 'awaiting_user' ||
          (p.reason !== 'approve_plan' && p.reason !== 'budget' && p.reason !== 'compose_failed')
        ) {
          throw new HttpError(409, 'STUDIO_BAD_TRANSITION', 'nothing to approve')
        }
        if (
          p.reason === 'budget' &&
          p.est !== null &&
          BigInt(p.est) > BigInt(p.budget) - BigInt(p.spent)
        ) {
          throw new HttpError(
            409,
            'STUDIO_BUDGET_TOO_LOW',
            'raise the budget to cover the estimate first',
          )
        }
        await c.query(
          `UPDATE studio_projects SET status = 'running', settings = settings - 'awaitingReason',
                  rev = rev + 1, updated_at = NOW() WHERE id = $1`,
          [projectId],
        )
        await appendStudioEvent(c, projectId, 'project.approved', {
          message:
            p.reason === 'compose_failed' ? '重新合成成片（不收费）。' : '方案已确认，开始生成。',
        })
      })
      kick(projectId)
    },
    async createVoice(userId, projectId, body) {
      if (!deps)
        throw new HttpError(503, 'STUDIO_ORCHESTRATOR_OFF', 'the director agent is not running')
      const mode = body.mode
      if (mode !== 'design' && mode !== 'clone')
        throw new HttpError(400, 'BAD_REQUEST', 'mode must be design or clone')
      // Reserved, not open (user 2026-10-24 05:02): nothing is created or charged.
      if (!voiceCustomOn())
        throw new HttpError(
          409,
          'STUDIO_VOICE_CUSTOM_OFF',
          'voice design and clone are not open yet',
        )
      const name = str(body.name, 40)
      if (!name) throw new HttpError(400, 'BAD_REQUEST', 'name must be 1..40 chars')
      const preview = body.previewText === undefined ? null : str(body.previewText, 200)
      if (body.previewText !== undefined && !preview)
        throw new HttpError(400, 'BAD_REQUEST', 'previewText must be 1..200 chars')
      const assetId = await inTx(pool, async (c) => {
        const r = await c.query<{ status: string }>(
          'SELECT status FROM studio_projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE',
          [projectId, userId],
        )
        const p = r.rows[0]
        if (!p) throw notFound()
        if (['done', 'canceled', 'failed'].includes(p.status)) {
          throw new HttpError(
            409,
            'STUDIO_BAD_TRANSITION',
            `cannot add a voice to a ${p.status} project`,
          )
        }
        let req: MediaRequest
        let descriptor: string
        if (mode === 'design') {
          const prompt = str(body.prompt, 600)
          if (!prompt) throw new HttpError(400, 'BAD_REQUEST', 'describe the voice in 1..600 chars')
          if (!preview) throw new HttpError(400, 'BAD_REQUEST', 'a preview line is required')
          req = { op: 'voice.design', prompt, text: preview, label: name }
          descriptor = prompt
        } else {
          // Cloning needs the uploader's own statement (OCV5-589 / D7) and their own uploaded sample.
          if (body.consent !== true) {
            throw new HttpError(
              400,
              'CLONE_CONSENT_REQUIRED',
              'confirm the sample is your own voice or you are authorized to use it',
            )
          }
          const sampleId = typeof body.sampleAssetId === 'string' ? body.sampleAssetId : ''
          const s = await c.query<{ blob_sha: string | null; mime: string | null; name: string }>(
            `SELECT blob_sha, meta->>'mime' AS mime, name FROM studio_assets
              WHERE id::text = $1 AND project_id = $2 AND user_id = $3 AND kind = 'upload'`,
            [sampleId, projectId, userId],
          )
          const sample = s.rows[0]
          if (!sample?.blob_sha || !sample.mime?.startsWith('audio/')) {
            throw new HttpError(
              400,
              'BAD_REQUEST',
              'choose an uploaded audio sample of this project',
            )
          }
          req = {
            op: 'voice.clone',
            label: name,
            inputs: [{ role: 'source', blobSha: sample.blob_sha }],
            consent: { statement: 'self_or_authorized', acceptedAt: new Date().toISOString() },
            ...(preview ? { text: preview } : {}),
          }
          descriptor = `快速复刻：${sample.name}`.slice(0, 200)
        }
        const id = randomUUID()
        await c.query(
          `INSERT INTO studio_assets(id, project_id, user_id, kind, name, descriptor, meta)
           VALUES ($1, $2, $3, 'voice', $4, $5, $6::jsonb)`,
          [id, projectId, userId, name, descriptor, JSON.stringify({ mode })],
        )
        const outcome = await dispatchRequest(
          c,
          deps,
          { id: projectId, userId },
          { ownerKind: 'bible', ownerId: id, op: req.op, exclude: [] },
          req,
        )
        if (outcome === 'budget')
          throw new HttpError(
            409,
            'STUDIO_BUDGET_TOO_LOW',
            'not enough budget left for a new voice (990 credits)',
          )
        if (outcome === 'no_provider')
          throw new HttpError(409, 'STUDIO_VOICE_UNAVAILABLE', 'no voice provider is configured')
        await appendStudioEvent(c, projectId, 'voice.requested', {
          assetId: id,
          message: mode === 'design' ? `正在设计音色「${name}」` : `正在复刻音色「${name}」`,
        })
        return id
      })
      return { assetId }
    },
    async requestExport(userId, projectId, body) {
      if (!deps?.compose?.configured())
        throw new HttpError(503, 'STUDIO_COMPOSE_OFF', 'the compose sandbox is not configured')
      const variant = parseVariant(body)
      if (!variant) throw new HttpError(400, 'BAD_REQUEST', 'resolution and subtitles are required')
      return inTx(pool, async (c) => {
        const r = await c.query<{ status: string }>(
          'SELECT status FROM studio_projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE',
          [projectId, userId],
        )
        const p = r.rows[0]
        if (!p) throw notFound()
        if (p.status !== 'done')
          throw new HttpError(409, 'STUDIO_NOT_DONE', 'the film is not composed yet')
        const inputs = await loadComposeInputs(c, projectId, variant)
        if (!inputs) throw notFound()
        const same = await c.query<{ id: string }>(
          `SELECT id::text AS id FROM studio_takes
            WHERE project_id = $1 AND owner_kind = 'final' AND status = 'succeeded'
              AND meta->>'variantKey' = $2 AND meta->>'inputsKey' = $3
            ORDER BY version DESC LIMIT 1`,
          [projectId, variantKey(variant), inputs.inputsKey],
        )
        if (same.rows[0]) return { reused: true as const, takeId: same.rows[0].id }
        // A failed attempt for these inputs does not block another request for them.
        const tries = await c.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM studio_tasks WHERE project_id = $1 AND kind = 'compose' AND status IN ('failed','canceled')`,
          [projectId],
        )
        await enqueueStudioTask(c, {
          projectId,
          kind: 'compose',
          idempotencyKey: `compose:${projectId}:${inputs.inputsKey}:export:${tries.rows[0]!.n}`,
          payload: { reason: 'export', variant },
        })
        await appendStudioEvent(c, projectId, 'compose.export_requested', {
          variantKey: variantKey(variant),
          message: '正在按新规格重新合成，免费。',
        })
        return { queued: true as const }
      })
    },
    async selectMusic(userId, projectId, body) {
      if (!deps)
        throw new HttpError(503, 'STUDIO_ORCHESTRATOR_OFF', 'the director agent is not running')
      const providerId = str(body.providerId, 40)
      const trackId = str(body.trackId, 36)
      if (!providerId || !trackId)
        throw new HttpError(400, 'BAD_REQUEST', 'providerId and trackId are required')
      const source = deps.providers.get(providerId)
      if (!source || source.kind !== 'music' || !source.search)
        throw new HttpError(400, 'BAD_REQUEST', 'providerId is not a music source')
      await inTx(pool, async (c) => {
        const r = await c.query<{ status: string }>(
          'SELECT status FROM studio_projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE',
          [projectId, userId],
        )
        const p = r.rows[0]
        if (!p) throw notFound()
        // A finished film may change its music: it then goes back to the director (A2-1c).
        if (['canceled', 'failed'].includes(p.status))
          throw new HttpError(409, 'STUDIO_BAD_TRANSITION', `cannot change a ${p.status} project`)
        const outcome = await dispatchRequest(
          c,
          deps,
          { id: projectId, userId },
          {
            ownerKind: 'music',
            ownerId: projectId,
            op: 'music.fetch',
            exclude: [],
            only: providerId,
          },
          { op: 'music.fetch', trackId },
        )
        if (outcome === 'no_provider')
          throw new HttpError(409, 'STUDIO_MUSIC_UNAVAILABLE', 'this music source is not available')
        if (outcome === 'budget')
          throw new HttpError(409, 'STUDIO_BUDGET_TOO_LOW', 'the project is over its budget')
        // A finished film goes back to the director, who re-composes it with the new music (free).
        await c.query(
          `UPDATE studio_projects SET status = 'running', settings = settings - 'awaitingReason', rev = rev + 1, updated_at = NOW()
            WHERE id = $1 AND status = 'done'`,
          [projectId],
        )
        // Paused after a compose finished (resume would land on done): resume to the director
        // instead (code r2 P1), so the new music is composed.
        await c.query(
          `UPDATE studio_projects SET settings = settings || '{"resumeTo":"running"}'::jsonb
            WHERE id = $1 AND status = 'paused' AND settings->>'resumeTo' = 'done'`,
          [projectId],
        )
        await appendStudioEvent(c, projectId, 'music.requested', {
          providerId,
          trackId,
          message: '正在换配乐。',
        })
      })
      kick(projectId)
      return { queued: true }
    },
    async setMusicEdit(userId, projectId, body) {
      let edit: MusicEdit
      try {
        edit = validateMusicEdit(body)
      } catch (err) {
        if (err instanceof ComposeSpecError) throw new HttpError(400, 'BAD_REQUEST', err.message)
        throw err
      }
      const r = await pool.query(
        `UPDATE studio_projects SET settings = settings || jsonb_build_object('musicEdit', $3::jsonb)
                -- paused after a compose finished: resume to the director with the new edit (code r2 P1)
                || CASE WHEN status = 'paused' AND settings->>'resumeTo' = 'done'
                        THEN '{"resumeTo":"running"}'::jsonb ELSE '{}'::jsonb END,
                -- A finished film goes back to the director with the new edit (free re-compose).
                status = CASE WHEN status = 'done' THEN 'running' ELSE status END,
                rev = rev + 1, updated_at = NOW()
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL AND status NOT IN ('canceled','failed')`,
        [projectId, userId, JSON.stringify(edit)],
      )
      if (r.rowCount !== 1) {
        const exists = await pool.query(
          'SELECT 1 FROM studio_projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
          [projectId, userId],
        )
        if (!exists.rowCount) throw notFound()
        throw new HttpError(409, 'STUDIO_BAD_TRANSITION', 'the project no longer takes edits')
      }
      kick(projectId)
      return edit
    },
    async useVoiceForNarration(userId, assetId) {
      const projectId = await inTx(pool, async (c) => {
        const r = await c.query<{ project_id: string; voice_id: string | null; pstatus: string }>(
          `SELECT a.project_id::text AS project_id, a.voice_id, p.status AS pstatus
             FROM studio_assets a JOIN studio_projects p ON p.id = a.project_id
            WHERE a.id::text = $1 AND a.user_id = $2 AND a.kind = 'voice' AND p.deleted_at IS NULL
            FOR UPDATE OF p`,
          [assetId, userId],
        )
        const a = r.rows[0]
        if (!a) throw notFound()
        if (!a.voice_id)
          throw new HttpError(409, 'STUDIO_VOICE_NOT_READY', 'the voice is not ready yet')
        if (['done', 'canceled', 'failed'].includes(a.pstatus)) {
          throw new HttpError(409, 'STUDIO_BAD_TRANSITION', `cannot change a ${a.pstatus} project`)
        }
        await c.query(
          `UPDATE studio_assets SET locked = (id::text = $2) WHERE project_id = $1 AND kind = 'voice'`,
          [a.project_id, assetId],
        )
        await c.query(
          `UPDATE studio_projects
              SET settings = jsonb_set(settings, '{narration}', COALESCE(settings->'narration', '{}'::jsonb) || jsonb_build_object('voiceId', $2::text)),
                  rev = rev + 1, updated_at = NOW()
            WHERE id = $1`,
          [a.project_id, a.voice_id],
        )
        await appendStudioEvent(c, a.project_id, 'voice.narration', {
          assetId,
          message: '旁白改用这个音色；还没配的台词会用它。',
        })
        return a.project_id
      })
      kick(projectId)
      return { projectId }
    },
    async selectTake(userId, takeId) {
      const projectId = await inTx(pool, async (c) => {
        const r = await c.query<{
          project_id: string
          owner_kind: string
          owner_id: string
          status: string
          blob_sha: string | null
          pstatus: string
        }>(
          `SELECT t.project_id::text AS project_id, t.owner_kind, t.owner_id::text AS owner_id, t.status, t.blob_sha,
                  p.status AS pstatus
             FROM studio_takes t JOIN studio_projects p ON p.id = t.project_id
            WHERE t.id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL
            FOR UPDATE OF p`,
          [takeId, userId],
        )
        const t = r.rows[0]
        if (!t) throw notFound()
        if (t.status !== 'succeeded' || !t.blob_sha)
          throw new HttpError(409, 'STUDIO_TAKE_NOT_READY', 'only a finished take can be chosen')
        if (['done', 'canceled', 'failed'].includes(t.pstatus)) {
          throw new HttpError(409, 'STUDIO_BAD_TRANSITION', `cannot change a ${t.pstatus} project`)
        }
        if (t.owner_kind === 'shot_video') {
          await c.query(
            `UPDATE studio_shots SET active_take_id = $2, status = 'ready', spec = spec - 'frameTakeId' WHERE id = $1`,
            [t.owner_id, takeId],
          )
        } else if (t.owner_kind === 'shot_frame') {
          // A frame is only the start of a new video (plan r1 P1-3): the shot goes back to work.
          // The pick is the user's retry: like an annotation's redo it opens a new video window
          // (redo.video = next version), so a provider that failed this shot's earlier videos is
          // tried again instead of excluded for good — the only video provider (Muse) once failed
          // left the shot unable to ever get a video (INC-20261027-STUDIO-RETRY-PROVIDER-EXCLUDED).
          await c.query(
            `UPDATE studio_shots
                SET status = 'generating', active_take_id = NULL,
                    spec = jsonb_set(spec, '{frameTakeId}', to_jsonb($2::text))
                      || jsonb_build_object('redo', COALESCE(spec->'redo', '{"frame":0}'::jsonb)
                           || jsonb_build_object('video', (SELECT COALESCE(MAX(version), 0) + 1 FROM studio_takes
                                                            WHERE owner_kind = 'shot_video' AND owner_id = $1)))
              WHERE id = $1`,
            [t.owner_id, takeId],
          )
        } else if (t.owner_kind === 'line') {
          await c.query(
            `UPDATE studio_lines SET active_take_id = $2, status = 'ready' WHERE id = $1`,
            [t.owner_id, takeId],
          )
        } else if (t.owner_kind === 'bible') {
          await c.query('UPDATE studio_assets SET blob_sha = $2, locked = TRUE WHERE id = $1', [
            t.owner_id,
            t.blob_sha,
          ])
        } else {
          throw new HttpError(409, 'STUDIO_BAD_TRANSITION', 'this take cannot be chosen yet')
        }
        // A new choice returns composition to the director, which dispatches any replacement
        // video before composing again. Keep budget/plan approval and user pauses intact.
        await c.query(
          `UPDATE studio_projects SET status = 'running', settings = settings - 'awaitingReason', rev = rev + 1, updated_at = NOW()
            WHERE id = $1 AND (status = 'composing' OR (status = 'awaiting_user'
              AND settings->>'awaitingReason' IN ('needs_user', 'compose_pending')))`,
          [t.project_id],
        )
        await c.query(
          `UPDATE studio_projects SET settings = settings || '{"resumeTo":"running"}'::jsonb
            WHERE id = $1 AND status = 'paused' AND settings->>'resumeTo' = 'composing'`,
          [t.project_id],
        )
        await appendStudioEvent(c, t.project_id, 'take.selected', {
          takeId,
          ownerKind: t.owner_kind,
          ownerId: t.owner_id,
          message: '已采用你选的版本。',
        })
        return t.project_id
      })
      kick(projectId)
      return { projectId }
    },
  }
}
