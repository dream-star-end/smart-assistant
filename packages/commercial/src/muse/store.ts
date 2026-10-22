// Muse media bridge — PG persistence (audit rows, rate counts, bridge credentials). OCV5-561.
// Credits for a succeeded job are recorded by billing.ts in the same row (OCV5-574).
//
// The hub keeps live job state in memory; this table is the audit trail and the source of
// truth after a master restart. The in-memory `dispatched` state is never written: the row
// stays `queued` until the bridge acks, then becomes `running`.

import type { Pool } from 'pg'

import type { MuseKind } from './protocol.js'

export type MuseJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface MuseJobInsert {
  id: string
  userId: string
  containerId: string | null
  kind: MuseKind
  promptSha256: Buffer
  promptPreview: string
  params: Record<string, unknown>
}

export interface MuseJobFinish {
  status: Exclude<MuseJobStatus, 'queued' | 'running'>
  errorCode: string | null
  upstreamErrorCode: string | null
  files: Array<{ mime: string; bytes: number; sha256: string }> | null
  artifactIds: string[] | null
  snapshotId: string | null
}

export interface MuseJobRecord {
  id: string
  kind: MuseKind
  status: MuseJobStatus
  errorCode: string | null
}

export interface MuseStore {
  insertJob(row: MuseJobInsert): Promise<void>
  markRunning(id: string, credentialId: string): Promise<void>
  finishJob(id: string, fin: MuseJobFinish): Promise<void>
  countRecent(userId: string, kind: MuseKind): Promise<{ hour: number; day: number }>
  /** Jobs of this kind queued across the site since the start of the day (UTC). */
  countSiteToday(kind: MuseKind): Promise<number>
  /** Rows left queued/running by a process that can no longer finish them: older than `graceMs`
   * (0 = all) and not among `ownIds`, this process's open jobs. */
  failOrphans(graceMs: number, ownIds: readonly string[]): Promise<number>
  findJob(userId: string, id: string): Promise<MuseJobRecord | null>
  findCredential(tokenSha256: Buffer): Promise<{ id: string } | null>
  touchCredential(id: string, bridgeVersion: string | null): Promise<void>
}

export function createPgMuseStore(pool: Pool): MuseStore {
  return {
    async insertJob(row) {
      await pool.query(
        `INSERT INTO muse_media_jobs
           (id, user_id, container_id, kind, prompt_sha256, prompt_preview, params, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')`,
        [
          row.id,
          row.userId,
          row.containerId,
          row.kind,
          row.promptSha256,
          row.promptPreview,
          JSON.stringify(row.params),
        ],
      )
    },
    async markRunning(id, credentialId) {
      await pool.query(
        `UPDATE muse_media_jobs
            SET status = 'running', started_at = NOW(), bridge_credential_id = $2
          WHERE id = $1 AND status = 'queued'`,
        [id, credentialId],
      )
    },
    async finishJob(id, fin) {
      await pool.query(
        `UPDATE muse_media_jobs
            SET status = $2, error_code = $3, upstream_error_code = $4, files = $5,
                muse_artifact_ids = $6, muse_snapshot_id = $7, finished_at = NOW()
          WHERE id = $1 AND status IN ('queued', 'running')`,
        [
          id,
          fin.status,
          fin.errorCode,
          fin.upstreamErrorCode,
          fin.files ? JSON.stringify(fin.files) : null,
          fin.artifactIds,
          fin.snapshotId,
        ],
      )
    },
    async countRecent(userId, kind) {
      const r = await pool.query<{ hour: string; day: string }>(
        `SELECT COUNT(*) FILTER (WHERE queued_at > NOW() - INTERVAL '1 hour') AS hour,
                COUNT(*) AS day
           FROM muse_media_jobs
          WHERE user_id = $1 AND kind = $2 AND queued_at > NOW() - INTERVAL '1 day'`,
        [userId, kind],
      )
      return { hour: Number(r.rows[0]?.hour ?? 0), day: Number(r.rows[0]?.day ?? 0) }
    },
    async countSiteToday(kind) {
      const r = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM muse_media_jobs
          WHERE kind = $1 AND queued_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        [kind],
      )
      return Number(r.rows[0]?.n ?? 0)
    },
    async failOrphans(graceMs, ownIds) {
      const r = await pool.query(
        `UPDATE muse_media_jobs
            SET status = 'failed', error_code = 'MUSE_MASTER_RESTARTED', finished_at = NOW()
          WHERE status IN ('queued', 'running')
            AND queued_at <= NOW() - make_interval(secs => $1::double precision / 1000)
            AND NOT (id = ANY($2::text[]))`,
        [graceMs, [...ownIds]],
      )
      return r.rowCount ?? 0
    },
    async findJob(userId, id) {
      const r = await pool.query<{
        id: string
        kind: MuseKind
        status: MuseJobStatus
        error_code: string | null
      }>(
        'SELECT id, kind, status, error_code FROM muse_media_jobs WHERE id = $1 AND user_id = $2',
        [id, userId],
      )
      const row = r.rows[0]
      return row
        ? { id: row.id, kind: row.kind, status: row.status, errorCode: row.error_code }
        : null
    },
    async findCredential(tokenSha256) {
      const r = await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM muse_bridge_credentials
          WHERE token_sha256 = $1 AND revoked_at IS NULL`,
        [tokenSha256],
      )
      return r.rows[0] ? { id: r.rows[0].id } : null
    },
    async touchCredential(id, bridgeVersion) {
      await pool.query(
        `UPDATE muse_bridge_credentials
            SET last_seen_at = NOW(), last_bridge_version = COALESCE($2, last_bridge_version)
          WHERE id = $1`,
        [id, bridgeVersion],
      )
    },
  }
}
