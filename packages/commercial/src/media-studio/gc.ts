/**
 * Media studio GC tick (OCV5-591 A1; plan §6). Safe to run on both A/B masters at once: every step
 * is a locked, idempotent statement.
 *
 *   1. projects soft-deleted more than 7 days ago: drop every blob ref their takes, assets and
 *      annotations hold (giving back the owner's quota), then delete the project (FK cascade)
 *   2. takes that finished more than 30 days ago and were never adopted (not the active take of
 *      their shot/line and not referenced by an asset): drop their blob ref
 *   3. StudioBlobStore.gc(): unreferenced blobs (row + file) and expired quota holds
 */
import type { Pool } from 'pg'
import type { BlobRefKind, StudioBlobStore } from './blobs.js'

export const STUDIO_GC_INTERVAL_MS = 60 * 60 * 1000

export async function runStudioGc(deps: {
  pool: Pool
  blobs: StudioBlobStore
  batch?: number
}): Promise<{ projects: number; takes: number; blobs: number }> {
  const batch = Math.max(1, Math.min(500, Math.trunc(deps.batch ?? 50)))
  let projects = 0
  const expired = await deps.pool.query<{ id: string; user_id: string }>(
    `SELECT id::text AS id, user_id::text AS user_id FROM studio_projects
     WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '7 days'
     ORDER BY deleted_at LIMIT $1`,
    [batch],
  )
  for (const p of expired.rows) {
    const userId = BigInt(p.user_id)
    const owners = await deps.pool.query<{ kind: BlobRefKind; id: string }>(
      `SELECT CASE WHEN owner_kind='final' THEN 'final' ELSE 'take' END AS kind, id::text AS id
         FROM studio_takes WHERE project_id=$1
       UNION ALL SELECT CASE WHEN kind='upload' THEN 'upload' ELSE 'asset' END, id::text
         FROM studio_assets WHERE project_id=$1
       UNION ALL SELECT 'annotation', id::text FROM studio_annotations WHERE project_id=$1`,
      [p.id],
    )
    for (const ref of owners.rows) await deps.blobs.dropRefs(userId, ref)
    const del = await deps.pool.query(
      `DELETE FROM studio_projects WHERE id=$1 AND deleted_at < NOW() - INTERVAL '7 days'`,
      [p.id],
    )
    projects += del.rowCount ?? 0
  }

  let takes = 0
  const stale = await deps.pool.query<{ id: string; user_id: string }>(
    `SELECT t.id::text AS id, p.user_id::text AS user_id
       FROM studio_takes t JOIN studio_projects p ON p.id=t.project_id
      WHERE t.finished_at < NOW() - INTERVAL '30 days' AND t.blob_sha IS NOT NULL
        AND t.owner_kind <> 'final'
        AND NOT EXISTS (SELECT 1 FROM studio_shots s WHERE s.active_take_id=t.id)
        AND NOT EXISTS (SELECT 1 FROM studio_lines l WHERE l.active_take_id=t.id)
        AND NOT EXISTS (SELECT 1 FROM studio_assets a
                         WHERE a.project_id=t.project_id AND a.blob_sha=t.blob_sha)
        AND EXISTS (SELECT 1 FROM studio_blob_refs r
                     WHERE r.user_id=p.user_id AND r.ref_kind='take' AND r.ref_id=t.id)
      LIMIT $1`,
    [batch * 10],
  )
  for (const t of stale.rows) {
    takes += await deps.blobs.dropRefs(BigInt(t.user_id), { kind: 'take', id: t.id })
  }

  const blobs = await deps.blobs.gc()
  return { projects, takes, blobs }
}
