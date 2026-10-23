// OCV5-591 A2-1a — user actions on the orchestrator: start a draft, approve a waiting plan, adopt a
// take. Each is one transaction scoped to the caller's project; the project is advanced afterwards.

import type { Pool, PoolClient } from 'pg'

import { randomUUID } from 'node:crypto'

import { HttpError } from '../../http/util.js'
import type { MediaRequest } from '../providers/types.js'
import { STUDIO_MAX_TARGET_SEC, appendStudioEvent } from '../store.js'
import { type AdvanceDeps, dispatchRequest } from './advance.js'

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
  /** Advance soon, off the request path. */
  kick(projectId: string): void
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
        if (
          p.status !== 'awaiting_user' ||
          (p.reason !== 'approve_plan' && p.reason !== 'budget')
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
          message: '方案已确认，开始生成。',
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
          await c.query(
            `UPDATE studio_shots SET status = 'generating', active_take_id = NULL,
                    spec = jsonb_set(spec, '{frameTakeId}', to_jsonb($2::text)) WHERE id = $1`,
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
        // A project waiting on the user picks up again once something was chosen.
        await c.query(
          `UPDATE studio_projects SET status = 'running', settings = settings - 'awaitingReason', rev = rev + 1, updated_at = NOW()
            WHERE id = $1 AND status = 'awaiting_user'
              AND settings->>'awaitingReason' IN ('needs_user', 'compose_pending')`,
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
