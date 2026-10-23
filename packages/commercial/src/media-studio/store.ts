/**
 * Media studio project store (OCV5-591 A1). Every query is scoped by user_id: a project, asset,
 * take or event of another user is indistinguishable from one that does not exist.
 *
 * A1 owns create / list / read / edit / pause / resume / cancel / delete and uploads; the
 * orchestrator (A2) drives planning → running → composing → done through the same rows.
 */
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { HttpError } from '../http/util.js'
import { cancelQueuedStudioTasks } from './queue.js'

type Db = Pool | PoolClient

export const STUDIO_MAX_LIVE_PROJECTS = 50
export const STUDIO_MAX_BUDGET_CREDITS = 200_000

export type StudioStatus =
  | 'draft'
  | 'planning'
  | 'running'
  | 'awaiting_user'
  | 'composing'
  | 'done'
  | 'failed'
  | 'paused'
  | 'canceled'

const TERMINAL: ReadonlySet<StudioStatus> = new Set(['done', 'failed', 'canceled'])
const ASPECTS = new Set(['16:9', '9:16', '1:1'])
/** OCV5-591 A2-1 plan §5.1: 40 shots × 10 s must always cover target × 1.3. */
export const STUDIO_MAX_TARGET_SEC = 300

export interface ProjectRow {
  id: string
  title: string
  brief: string
  status: StudioStatus
  autonomy: 'max' | 'confirm'
  aspect: '16:9' | '9:16' | '1:1'
  fps: number
  targetSec: number
  budgetCredits: string
  spentCredits: string
  reservedCredits: string
  settings: Record<string, unknown>
  rev: number
  createdAt: string
  updatedAt: string
}

const PROJECT_COLUMNS = `id::text AS id, title, brief, status, autonomy, aspect, fps,
  target_sec AS "targetSec", budget_credits::text AS "budgetCredits",
  spent_credits::text AS "spentCredits", reserved_credits::text AS "reservedCredits", settings, rev,
  created_at AS "createdAt", updated_at AS "updatedAt"`

const CURSOR_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

const notFound = () => new HttpError(404, 'NOT_FOUND', 'studio project not found')

export interface ProjectPatch {
  title?: string
  brief?: string
  aspect?: string
  targetSec?: number
  budgetCredits?: number
  autonomy?: string
}

function validatePatch(input: Record<string, unknown>): ProjectPatch {
  const out: ProjectPatch = {}
  const bad = (field: string) => new HttpError(400, 'BAD_REQUEST', `invalid ${field}`)
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || input.title.length > 200) throw bad('title')
    out.title = input.title.trim()
  }
  if (input.brief !== undefined) {
    if (typeof input.brief !== 'string' || input.brief.length > 4000) throw bad('brief')
    out.brief = input.brief
  }
  if (input.aspect !== undefined) {
    if (typeof input.aspect !== 'string' || !ASPECTS.has(input.aspect)) throw bad('aspect')
    out.aspect = input.aspect
  }
  if (input.targetSec !== undefined) {
    if (
      !Number.isInteger(input.targetSec) ||
      (input.targetSec as number) < 5 ||
      (input.targetSec as number) > STUDIO_MAX_TARGET_SEC
    )
      throw bad('targetSec')
    out.targetSec = input.targetSec as number
  }
  if (input.budgetCredits !== undefined) {
    if (
      !Number.isInteger(input.budgetCredits) ||
      (input.budgetCredits as number) < 0 ||
      (input.budgetCredits as number) > STUDIO_MAX_BUDGET_CREDITS
    )
      throw bad('budgetCredits')
    out.budgetCredits = input.budgetCredits as number
  }
  if (input.autonomy !== undefined) {
    if (input.autonomy !== 'max' && input.autonomy !== 'confirm') throw bad('autonomy')
    out.autonomy = input.autonomy
  }
  return out
}

export async function appendStudioEvent(
  db: Db,
  projectId: string,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    'INSERT INTO studio_events(project_id, type, payload) VALUES ($1, $2, $3::jsonb)',
    [projectId, type, JSON.stringify(payload)],
  )
}

async function inTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export class StudioStore {
  constructor(private readonly pool: Pool) {}

  /** My Music (OCV5-591 M1, 0325): the audio is already the user's blob (ref id = track id). */
  async addUserTrack(
    userId: string,
    input: {
      id: string
      title: string
      blobSha: string
      mime: string
      rights: Record<string, unknown>
    },
  ): Promise<{ id: string; title: string; blobSha: string; createdAt: string }> {
    const r = await this.pool.query<{
      id: string
      title: string
      blob_sha: string
      created_at: Date
    }>(
      `INSERT INTO studio_user_tracks(id, user_id, title, blob_sha, mime, rights_statement)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id::text AS id, title, blob_sha, created_at`,
      [input.id, userId, input.title, input.blobSha, input.mime, JSON.stringify(input.rights)],
    )
    const row = r.rows[0]!
    return {
      id: row.id,
      title: row.title,
      blobSha: row.blob_sha,
      createdAt: row.created_at.toISOString(),
    }
  }

  async createProject(userId: string, input: Record<string, unknown>): Promise<ProjectRow> {
    const patch = validatePatch(input)
    return inTx(this.pool, async (client) => {
      // Serialize per user so the live-project cap is a single decision.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`studio-user:${userId}`])
      const live = await client.query<{ n: string }>(
        'SELECT COUNT(*)::text AS n FROM studio_projects WHERE user_id=$1 AND deleted_at IS NULL',
        [userId],
      )
      if (Number(live.rows[0]!.n) >= STUDIO_MAX_LIVE_PROJECTS)
        throw new HttpError(409, 'STUDIO_PROJECT_LIMIT', 'too many studio projects')
      const id = randomUUID()
      const row = await client.query<ProjectRow>(
        `INSERT INTO studio_projects(id, user_id, title, brief, aspect, target_sec, budget_credits, autonomy)
         VALUES ($1, $2, $3, $4, COALESCE($5, '16:9'), COALESCE($6, 30), COALESCE($7, 2000), COALESCE($8, 'max'))
         RETURNING ${PROJECT_COLUMNS}`,
        [
          id,
          userId,
          patch.title ?? '',
          patch.brief ?? '',
          patch.aspect ?? null,
          patch.targetSec ?? null,
          patch.budgetCredits ?? null,
          patch.autonomy ?? null,
        ],
      )
      await appendStudioEvent(client, id, 'project.created')
      return row.rows[0]!
    })
  }

  async listProjects(
    userId: string,
    opts: { before?: string; limit?: number } = {},
  ): Promise<{ projects: ProjectRow[]; next: string | null }> {
    const limit = Math.max(1, Math.min(50, Math.trunc(opts.limit ?? 20)))
    // Keyset cursor "<updated_at to the microsecond>_<id>" (Codex Sol r1 P2): a JS Date keeps only
    // milliseconds, and updated_at alone is not unique, so either would skip rows across pages.
    const m = opts.before ? CURSOR_RE.exec(opts.before) : null
    if (opts.before && !m) throw new HttpError(400, 'BAD_REQUEST', 'invalid cursor')
    const rows = await this.pool.query<ProjectRow & { cursor: string }>(
      `SELECT ${PROJECT_COLUMNS},
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '_' || id::text
                AS cursor
       FROM studio_projects
       WHERE user_id=$1 AND deleted_at IS NULL
         AND ($2::timestamptz IS NULL OR (updated_at, id) < ($2::timestamptz, $3::uuid))
       ORDER BY updated_at DESC, id DESC LIMIT $4`,
      [userId, m?.[1] ?? null, m?.[2] ?? null, limit + 1],
    )
    const page = rows.rows.slice(0, limit)
    const next = rows.rows.length > limit ? page.at(-1)!.cursor : null
    const projects = page.map(({ cursor: _cursor, ...p }) => p as ProjectRow)
    return { projects, next }
  }

  async getProject(userId: string, id: string): Promise<ProjectRow | null> {
    const r = await this.pool.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM studio_projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [id, userId],
    )
    return r.rows[0] ?? null
  }

  /** The project page's aggregate: shots, lines, assets, takes, recent events, budget. */
  async projectView(userId: string, id: string): Promise<Record<string, unknown> | null> {
    const project = await this.getProject(userId, id)
    if (!project) return null
    const [shots, lines, assets, takes, events] = await Promise.all([
      this.pool.query(
        `SELECT id::text AS id, ordinal, spec, status, active_take_id::text AS "activeTakeId"
         FROM studio_shots WHERE project_id=$1 ORDER BY ordinal`,
        [id],
      ),
      this.pool.query(
        `SELECT id::text AS id, shot_id::text AS "shotId", ordinal, speaker_asset_id::text AS "speakerAssetId",
                text, emotion, speed::float8 AS speed, status, active_take_id::text AS "activeTakeId"
         FROM studio_lines WHERE project_id=$1 ORDER BY ordinal`,
        [id],
      ),
      this.pool.query(
        `SELECT id::text AS id, kind, name, locked, descriptor, blob_sha AS "blobSha", voice_id AS "voiceId",
                meta, created_at AS "createdAt"
         FROM studio_assets WHERE project_id=$1 AND user_id=$2 ORDER BY created_at`,
        [id, userId],
      ),
      this.pool.query(
        `SELECT id::text AS id, owner_kind AS "ownerKind", owner_id::text AS "ownerId", version, provider,
                model, op, status, error_code AS "errorCode", cost_credits::text AS "costCredits", qa,
                blob_sha AS "blobSha", created_at AS "createdAt", finished_at AS "finishedAt",
                -- OCV5-591 M1: a music take carries its licence snapshot and track card for the UI;
                -- other takes' meta (provider internals) stays server-side.
                CASE WHEN owner_kind = 'music'
                     THEN jsonb_build_object('license', meta->'license', 'track', meta->'track') END AS music,
                -- OCV5-591 A2-1c-2: the media's real length (the timeline places narration by it, as compose
                -- does); a malformed value is left out rather than failing the view.
                CASE WHEN jsonb_typeof(meta->'durationMs') = 'number'
                     THEN (meta->>'durationMs')::float8 END AS "durationMs",
                -- OCV5-591 A2-1c-2: a film's export format, CC BY credits and soft-subtitle file (a film
                -- still being composed has only the format it was asked for, in its inputs).
                CASE WHEN owner_kind = 'final'
                     THEN jsonb_build_object('variant', COALESCE(meta->'variant', inputs->'variant'),
                                             'variantKey', meta->'variantKey',
                                             'credits', meta->'credits', 'srtSha', meta->'srtSha') END AS final
         FROM studio_takes WHERE project_id=$1 ORDER BY created_at DESC LIMIT 500`,
        [id],
      ),
      this.pool.query(
        `SELECT id::text AS id, ts, type, payload FROM studio_events
         WHERE project_id=$1 ORDER BY id DESC LIMIT 50`,
        [id],
      ),
    ])
    return {
      project,
      shots: shots.rows,
      lines: lines.rows,
      assets: assets.rows,
      takes: takes.rows,
      events: events.rows,
    }
  }

  /** Optimistic edit (`expectedRev`). Brief / aspect / length only change while the project is a draft. */
  async updateProject(
    userId: string,
    id: string,
    expectedRev: number,
    input: Record<string, unknown>,
  ): Promise<ProjectRow> {
    const patch = validatePatch(input)
    if (!Number.isInteger(expectedRev))
      throw new HttpError(400, 'BAD_REQUEST', 'invalid expectedRev')
    return inTx(this.pool, async (client) => {
      const cur = await client.query<{
        status: StudioStatus
        rev: number
        spent: string
        reserved: string
      }>(
        `SELECT status, rev, spent_credits::text AS spent, reserved_credits::text AS reserved
         FROM studio_projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`,
        [id, userId],
      )
      const row = cur.rows[0]
      if (!row) throw notFound()
      if (row.rev !== expectedRev)
        throw new HttpError(409, 'STUDIO_REV_CONFLICT', 'project changed')
      const shaping =
        patch.brief !== undefined || patch.aspect !== undefined || patch.targetSec !== undefined
      if (shaping && row.status !== 'draft')
        throw new HttpError(
          409,
          'STUDIO_NOT_DRAFT',
          'brief, aspect and length are fixed once planning starts',
        )
      if (
        patch.budgetCredits !== undefined &&
        BigInt(patch.budgetCredits) < BigInt(row.spent) + BigInt(row.reserved)
      )
        throw new HttpError(
          409,
          'STUDIO_BUDGET_BELOW_SPENT',
          'budget is below what is already spent or reserved',
        )
      const updated = await client.query<ProjectRow>(
        `UPDATE studio_projects SET
           title=COALESCE($3, title), brief=COALESCE($4, brief), aspect=COALESCE($5, aspect),
           target_sec=COALESCE($6, target_sec), budget_credits=COALESCE($7, budget_credits),
           autonomy=COALESCE($8, autonomy), rev=rev+1, updated_at=NOW()
         WHERE id=$1 AND user_id=$2 RETURNING ${PROJECT_COLUMNS}`,
        [
          id,
          userId,
          patch.title ?? null,
          patch.brief ?? null,
          patch.aspect ?? null,
          patch.targetSec ?? null,
          patch.budgetCredits ?? null,
          patch.autonomy ?? null,
        ],
      )
      await appendStudioEvent(client, id, 'project.updated', { fields: Object.keys(patch) })
      return updated.rows[0]!
    })
  }

  /** pause / resume / cancel. Cancel stops new dispatch; in-flight upstream calls finish (plan §4). */
  async transition(
    userId: string,
    id: string,
    action: 'pause' | 'resume' | 'cancel',
  ): Promise<ProjectRow> {
    return inTx(this.pool, async (client) => {
      const cur = await client.query<{ status: StudioStatus; settings: Record<string, unknown> }>(
        `SELECT status, settings FROM studio_projects
         WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`,
        [id, userId],
      )
      const row = cur.rows[0]
      if (!row) throw notFound()
      let next: StudioStatus
      let settings = row.settings
      if (action === 'pause') {
        if (TERMINAL.has(row.status) || row.status === 'paused' || row.status === 'draft')
          throw new HttpError(409, 'STUDIO_BAD_TRANSITION', `cannot pause a ${row.status} project`)
        next = 'paused'
        settings = { ...settings, resumeTo: row.status }
      } else if (action === 'resume') {
        if (row.status !== 'paused')
          throw new HttpError(409, 'STUDIO_BAD_TRANSITION', `cannot resume a ${row.status} project`)
        const to = settings.resumeTo
        next =
          to === 'planning' ||
          to === 'running' ||
          to === 'awaiting_user' ||
          to === 'composing' ||
          // A compose that finished while paused (OCV5-591 A2-1c).
          to === 'done'
            ? to
            : 'running'
        const { resumeTo: _drop, ...rest } = settings
        settings = rest
      } else {
        if (TERMINAL.has(row.status))
          throw new HttpError(409, 'STUDIO_BAD_TRANSITION', `cannot cancel a ${row.status} project`)
        next = 'canceled'
        await cancelQueuedStudioTasks(client, id)
      }
      const updated = await client.query<ProjectRow>(
        `UPDATE studio_projects SET status=$3, settings=$4::jsonb, rev=rev+1, updated_at=NOW()
         WHERE id=$1 AND user_id=$2 RETURNING ${PROJECT_COLUMNS}`,
        [id, userId, next, JSON.stringify(settings)],
      )
      const eventType = {
        pause: 'project.paused',
        resume: 'project.resumed',
        cancel: 'project.canceled',
      }[action]
      await appendStudioEvent(client, id, eventType, {
        from: row.status,
        to: next,
      })
      return updated.rows[0]!
    })
  }

  /** Soft delete; the studio GC hard-deletes after 7 days. */
  async deleteProject(userId: string, id: string): Promise<void> {
    await inTx(this.pool, async (client) => {
      const r = await client.query(
        `UPDATE studio_projects SET deleted_at=NOW(),
           status=CASE WHEN status IN ('done','failed','canceled') THEN status ELSE 'canceled' END,
           rev=rev+1, updated_at=NOW()
         WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
        [id, userId],
      )
      if (r.rowCount !== 1) throw notFound()
      await cancelQueuedStudioTasks(client, id)
      await appendStudioEvent(client, id, 'project.deleted')
    })
  }

  /** Records an uploaded reference (image / audio) as a project asset. */
  async addUploadAsset(
    userId: string,
    projectId: string,
    input: { assetId: string; name: string; blobSha: string; mime: string; bytes: number },
  ): Promise<Record<string, unknown>> {
    return inTx(this.pool, async (client) => {
      const owned = await client.query(
        'SELECT 1 FROM studio_projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE',
        [projectId, userId],
      )
      if (owned.rowCount !== 1) throw notFound()
      const row = await client.query(
        `INSERT INTO studio_assets(id, project_id, user_id, kind, name, blob_sha, meta)
         VALUES ($1, $2, $3, 'upload', $4, $5, $6::jsonb)
         RETURNING id::text AS id, kind, name, blob_sha AS "blobSha", meta, created_at AS "createdAt"`,
        [
          input.assetId,
          projectId,
          userId,
          input.name.slice(0, 200),
          input.blobSha,
          JSON.stringify({ mime: input.mime, bytes: input.bytes, source: 'user_upload' }),
        ],
      )
      await appendStudioEvent(client, projectId, 'asset.uploaded', { assetId: input.assetId })
      return row.rows[0]!
    })
  }

  async projectOwned(userId: string, id: string): Promise<boolean> {
    const r = await this.pool.query(
      'SELECT 1 FROM studio_projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
      [id, userId],
    )
    return r.rowCount === 1
  }
}
