// Muse media bridge — PG persistence (audit rows, rate counts, bridge credentials). OCV5-561.
// Credits for a succeeded job are recorded by billing.ts in the same row (OCV5-574).
//
// The hub keeps live job state in memory; this table is the audit trail and the source of
// truth after a master restart. Durable conversation videos also store an execution journal.
// The audit status stays `queued` until the bridge acks, then becomes `running`.

import type { Pool } from 'pg'

import type { MuseDurableState, MuseFence } from './durable.js'
import { MuseFenceLost } from './durable.js'

import { MuseError, type MuseKind } from './protocol.js'

export type MuseJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface MuseJobInsert {
  id: string
  userId: string
  containerId: string | null
  kind: MuseKind
  promptSha256: Buffer
  promptPreview: string
  params: Record<string, unknown>
  admissionLimits?: { queue: number; user: number }
  durable?: MuseDurableState
  leaseOwner?: string
  /** Quoted credits for a billed job (0319, commercial); 0n/absent = not billed. */
  priceCredits?: bigint
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
  /** Succeeded rows: the delivered files, in index order. */
  files: Array<{ mime: string; bytes: number; sha256: string }> | null
  snapshotId: string | null
  durable?: MuseDurableState
  /** Credits actually debited (0319); null when not billed or on a database without 0319. */
  debitedCredits: string | null
}

export interface MuseStore {
  insertJob(row: MuseJobInsert): Promise<void>
  markRunning(id: string, credentialId: string, fence?: MuseFence): Promise<void>
  finishJob(id: string, fin: MuseJobFinish, fence?: MuseFence): Promise<void>
  countRecent(userId: string, kind: MuseKind): Promise<{ hour: number; day: number }>
  /** Jobs of this kind queued across the site since the start of the day (UTC). */
  countSiteToday(kind: MuseKind): Promise<number>
  /** Rows left queued/running by a process that can no longer finish them: older than `graceMs`
   * (0 = all) and not among `ownIds`, this process's open jobs. */
  failOrphans(graceMs: number, ownIds: readonly string[]): Promise<number>
  findJob(userId: string, id: string): Promise<MuseJobRecord | null>
  /** Sum of the quoted credits of this account's open (queued/running) jobs, across processes. */
  openCredits(userId: string): Promise<bigint>
  findCredential(tokenSha256: Buffer): Promise<{ id: string } | null>
  touchCredential(id: string, bridgeVersion: string | null): Promise<void>
}

export function createPgMuseStore(pool: Pool): MuseStore {
  return {
    async insertJob(row) {
      const values = [
        row.id,
        row.userId,
        row.containerId,
        row.kind,
        row.promptSha256,
        row.promptPreview,
        JSON.stringify(row.params),
      ]
      if (row.durable) {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          await client.query("SELECT pg_advisory_xact_lock(hashtext('muse-durable-admission'))")
          const counts = await client.query<{ waiting: string; mine: string }>(
            `SELECT COUNT(*) FILTER (WHERE status='queued' OR durable->>'state'='queued')::text AS waiting,
            COUNT(*) FILTER (WHERE user_id=$1)::text AS mine
           FROM muse_media_jobs WHERE status IN ('queued','running')`,
            [row.userId],
          )
          if (
            Number(counts.rows[0]!.waiting) >=
            (row.admissionLimits?.queue ?? Number.POSITIVE_INFINITY)
          )
            throw new MuseError(503, 'MUSE_BUSY', 'the Muse queue is full', true)
          if (
            Number(counts.rows[0]!.mine) >= (row.admissionLimits?.user ?? Number.POSITIVE_INFINITY)
          )
            throw new MuseError(
              429,
              'MUSE_USER_BUSY',
              'too many pending Muse jobs for this account',
              true,
            )
          await client.query(
            `INSERT INTO muse_media_jobs
           (id,user_id,container_id,kind,prompt_sha256,prompt_preview,params,status,price_credits,
            durable,lease_owner,lease_until,durable_payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10,NOW()+INTERVAL '120 seconds',$11)`,
            [
              ...values,
              (row.priceCredits ?? 0n).toString(),
              JSON.stringify({ ...row.durable, spec: undefined }),
              row.leaseOwner,
              JSON.stringify(row.durable.spec),
            ],
          )
          await client.query('COMMIT')
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {})
          throw err
        } finally {
          client.release()
        }
        return
      }
      // price_credits exists only where 0319 ran (commercial); unbilled jobs never name it.
      if (row.priceCredits !== undefined && row.priceCredits > 0n) {
        await pool.query(
          `INSERT INTO muse_media_jobs
             (id, user_id, container_id, kind, prompt_sha256, prompt_preview, params, status,
              price_credits)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8)`,
          [...values, row.priceCredits.toString()],
        )
        return
      }
      await pool.query(
        `INSERT INTO muse_media_jobs
           (id, user_id, container_id, kind, prompt_sha256, prompt_preview, params, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')`,
        values,
      )
    },
    async markRunning(id, credentialId, fence) {
      const r = await pool.query(
        `UPDATE muse_media_jobs
            SET status = 'running', started_at = NOW(), bridge_credential_id = $2
          WHERE id = $1 AND status IN ('queued','running')
          ${fence ? "AND lease_owner=$3 AND durable->>'nonce'=$4 AND lease_until>NOW()" : ''}`,
        fence ? [id, credentialId, fence.owner, fence.nonce] : [id, credentialId],
      )
      if (fence && r.rowCount !== 1) throw new MuseFenceLost()
    },
    async finishJob(id, fin, fence) {
      const r = await pool.query(
        `UPDATE muse_media_jobs
            SET status = $2, error_code = $3, upstream_error_code = $4, files = $5,
                muse_artifact_ids = $6, muse_snapshot_id = $7, finished_at = NOW()
          WHERE id = $1 AND status IN ('queued', 'running')
          ${fence ? "AND lease_owner=$8 AND durable->>'nonce'=$9 AND lease_until>NOW()" : ''}`,
        [
          id,
          fin.status,
          fin.errorCode,
          fin.upstreamErrorCode,
          fin.files ? JSON.stringify(fin.files) : null,
          fin.artifactIds,
          fin.snapshotId,
          ...(fence ? [fence.owner, fence.nonce] : []),
        ],
      )
      if (fence && r.rowCount !== 1) {
        // Billing may already have committed success on this very attempt. A different winner
        // (or an expired unbilled writer) must never be reported as this callback's success.
        const won =
          fin.status === 'succeeded'
            ? await pool.query(
                `SELECT 1 FROM muse_media_jobs WHERE id=$1 AND status='succeeded'
           AND lease_owner=$2 AND durable->>'nonce'=$3`,
                [id, fence.owner, fence.nonce],
              )
            : null
        if (!won?.rowCount) throw new MuseFenceLost()
      }
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
            AND COALESCE(to_jsonb(muse_media_jobs)->'durable', 'null'::jsonb) = 'null'::jsonb
            AND queued_at <= NOW() - make_interval(secs => $1::double precision / 1000)
            AND NOT (id = ANY($2::text[]))`,
        [graceMs, [...ownIds]],
      )
      return r.rowCount ?? 0
    },
    async findJob(userId, id) {
      // The whole row as JSON: columns a database does not have (debited_credits before 0319)
      // read as absent instead of failing the query.
      const r = await pool.query<{ r: Record<string, unknown> }>(
        'SELECT to_jsonb(m) AS r FROM muse_media_jobs m WHERE id = $1 AND user_id = $2',
        [id, userId],
      )
      const row = r.rows[0]?.r
      if (!row) return null
      const files = Array.isArray(row.files)
        ? (row.files as Array<{ mime: string; bytes: number; sha256: string }>)
        : null
      const debited = row.debited_credits
      return {
        id: String(row.id),
        ...(row.durable ? { durable: row.durable as MuseDurableState } : {}),
        kind: row.kind as MuseKind,
        status: row.status as MuseJobStatus,
        errorCode: typeof row.error_code === 'string' ? row.error_code : null,
        files,
        snapshotId: typeof row.muse_snapshot_id === 'string' ? row.muse_snapshot_id : null,
        debitedCredits:
          typeof debited === 'number' || typeof debited === 'string' ? String(debited) : null,
      }
    },
    async openCredits(userId) {
      const r = await pool.query<{ n: string }>(
        `SELECT COALESCE(SUM(price_credits), 0)::text AS n FROM muse_media_jobs
          WHERE user_id = $1 AND status IN ('queued', 'running')`,
        [userId],
      )
      return BigInt(r.rows[0]?.n ?? '0')
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
