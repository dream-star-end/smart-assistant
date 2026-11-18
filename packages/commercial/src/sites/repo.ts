import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  SitesError,
  type SiteVisibility,
  type UserSiteRow,
} from './types.js'

const OP_LEASE_TTL_MS = 60_000

export interface PublishReservationInput {
  userId: number
  slug: string
  title: string
  visibility: SiteVisibility
  passwordSalt: string | null
  passwordHash: string | null
  spaMode: boolean
  maxPerUser: number
}

export interface PublishReservation {
  siteId: string
  leaseId: string
  isNewPlaceholder: boolean
  edgeRevision: number
  baseRevision: number
  existing: UserSiteRow | null
}

export interface CommitPublishInput {
  siteId: string
  userId: number
  leaseId: string
  title: string
  visibility: SiteVisibility
  passwordSalt: string | null
  passwordHash: string | null
  spaMode: boolean
  fileCount: number
  sizeBytes: number
  contentSha256: string
  edgeRevision: number
}

export interface MetaUpdateReservation {
  site: UserSiteRow
  leaseId: string
  nextRevision: number
}

export interface DeleteReservation {
  site: UserSiteRow
  leaseId: string
  deleteRevision: number
}

export interface SitesRepo {
  listByUser(userId: number): Promise<UserSiteRow[]>
  getByUserAndSlug(userId: number, slug: string): Promise<UserSiteRow | null>
  listUnleasedPendingByUser(userId: number): Promise<UserSiteRow[]>
  tryClaimReconcileLease(
    siteId: string,
    userId: number,
  ): Promise<{ row: UserSiteRow; leaseId: string } | null>
  reconcileFromEdge(input: CommitPublishInput): Promise<UserSiteRow | null>
  beginPublishReservation(input: PublishReservationInput): Promise<PublishReservation>
  commitPublish(input: CommitPublishInput): Promise<UserSiteRow>
  abortPublishPlaceholder(siteId: string, userId: number, leaseId: string): Promise<void>
  releaseLease(siteId: string, userId: number, leaseId: string, clearTarget?: boolean): Promise<void>
  prepareMetaUpdate(userId: number, slug: string): Promise<MetaUpdateReservation>
  commitMetaUpdate(input: {
    siteId: string
    userId: number
    leaseId: string
    title: string
    visibility: SiteVisibility
    passwordSalt: string | null
    passwordHash: string | null
    spaMode: boolean
    edgeRevision: number
  }): Promise<UserSiteRow>
  prepareDelete(userId: number, slug: string): Promise<DeleteReservation>
  commitDelete(siteId: string, userId: number, leaseId: string, deleteRevision: number): Promise<void>
}

interface RawUserSiteRow {
  id: string
  slug: string
  user_id: number
  title: string
  visibility: SiteVisibility
  password_salt: string | null
  password_hash: string | null
  spa_mode: boolean
  file_count: number
  size_bytes: string | number
  content_sha256: string
  edge_revision: string | number
  op_lease_id: string | null
  op_lease_until: Date | null
  op_expected_rev: string | number
  op_target_rev: string | number
  created_at: Date
  updated_at: Date
  last_published_at: Date
}

function mapRow(r: RawUserSiteRow): UserSiteRow {
  return {
    id: r.id,
    slug: r.slug,
    userId: Number(r.user_id),
    title: r.title,
    visibility: r.visibility,
    passwordSalt: r.password_salt,
    passwordHash: r.password_hash,
    spaMode: r.spa_mode,
    fileCount: Number(r.file_count),
    sizeBytes: Number(r.size_bytes),
    contentSha256: r.content_sha256,
    edgeRevision: Number(r.edge_revision),
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at),
    lastPublishedAt:
      r.last_published_at instanceof Date ? r.last_published_at : new Date(r.last_published_at),
  }
}

function hasActiveLease(row: { op_lease_id: string | null; op_lease_until: Date | null }): boolean {
  if (!row.op_lease_id || !row.op_lease_until) return false
  const until =
    row.op_lease_until instanceof Date ? row.op_lease_until.getTime() : new Date(row.op_lease_until).getTime()
  return until > Date.now()
}

async function allocateNextEdgeRevision(client: PoolClient): Promise<number> {
  const revRes = await client.query<{ last_rev: string | number }>(
    `INSERT INTO user_sites_rev_counter (id, last_rev)
     VALUES (1, 1)
     ON CONFLICT (id) DO UPDATE SET last_rev = user_sites_rev_counter.last_rev + 1
     RETURNING last_rev`,
  )
  return Number(revRes.rows[0]!.last_rev)
}

async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore rollback error */
    }
    throw err
  } finally {
    client.release()
  }
}

export function createPgSitesRepo(pool: Pool): SitesRepo {
  return {
    async listByUser(userId) {
      const res = await pool.query<RawUserSiteRow>(
        `SELECT * FROM user_sites
         WHERE user_id = $1 AND edge_revision > 0
         ORDER BY updated_at DESC, created_at DESC`,
        [userId],
      )
      return res.rows.map(mapRow)
    },

    async getByUserAndSlug(userId, slug) {
      const res = await pool.query<RawUserSiteRow>(
        `SELECT * FROM user_sites
         WHERE user_id = $1 AND slug = $2 AND edge_revision > 0`,
        [userId, slug],
      )
      return res.rows[0] ? mapRow(res.rows[0]) : null
    },

    async listUnleasedPendingByUser(userId) {
      const res = await pool.query<RawUserSiteRow>(
        `SELECT * FROM user_sites
         WHERE user_id = $1
           AND (op_lease_until IS NULL OR op_lease_until <= NOW())
           AND (edge_revision = 0 OR op_target_rev > edge_revision)
         ORDER BY created_at ASC`,
        [userId],
      )
      return res.rows.map(mapRow)
    },

    async tryClaimReconcileLease(siteId, userId) {
      const leaseId = randomUUID()
      const leaseUntil = new Date(Date.now() + OP_LEASE_TTL_MS)
      const res = await pool.query<RawUserSiteRow>(
        `UPDATE user_sites
         SET op_lease_id = $3,
             op_lease_until = $4
         WHERE id = $1
           AND user_id = $2
           AND (op_lease_until IS NULL OR op_lease_until <= NOW())
           AND (edge_revision = 0 OR op_target_rev > edge_revision)
         RETURNING *`,
        [siteId, userId, leaseId, leaseUntil],
      )
      return res.rows[0] ? { row: mapRow(res.rows[0]), leaseId } : null
    },

    async reconcileFromEdge(input) {
      const res = await pool.query<RawUserSiteRow>(
        `UPDATE user_sites
         SET title = $4,
             visibility = $5,
             password_salt = $6,
             password_hash = $7,
             spa_mode = $8,
             file_count = $9,
             size_bytes = $10,
             content_sha256 = $11,
             edge_revision = $12,
             op_lease_id = NULL,
             op_lease_until = NULL,
             op_expected_rev = 0,
             op_target_rev = 0,
             updated_at = NOW(),
             last_published_at = CASE WHEN edge_revision = 0 THEN NOW() ELSE last_published_at END
         WHERE id = $1
           AND user_id = $2
           AND op_lease_id = $3
           AND edge_revision < $12
         RETURNING *`,
        [
          input.siteId,
          input.userId,
          input.leaseId,
          input.title,
          input.visibility,
          input.passwordSalt,
          input.passwordHash,
          input.spaMode,
          input.fileCount,
          input.sizeBytes,
          input.contentSha256,
          input.edgeRevision,
        ],
      )
      return res.rows[0] ? mapRow(res.rows[0]) : null
    },

    async beginPublishReservation(input) {
      return withTx(pool, async (client) => {
        // Lock user row to serialize per-user quota checks across concurrent publishes.
        const userLock = await client.query<{ id: number }>(
          'SELECT id FROM users WHERE id = $1 FOR UPDATE',
          [input.userId],
        )
        if (userLock.rows.length === 0) {
          throw new SitesError('SITE_NOT_FOUND', '用户不存在', 404)
        }

        const existingRes = await client.query<RawUserSiteRow>(
          'SELECT * FROM user_sites WHERE slug = $1 FOR UPDATE',
          [input.slug],
        )
        const existingRaw = existingRes.rows[0] ?? null
        const leaseId = randomUUID()
        const leaseUntil = new Date(Date.now() + OP_LEASE_TTL_MS)

        if (existingRaw) {
          if (Number(existingRaw.user_id) !== input.userId) {
            throw new SitesError('SLUG_TAKEN', `子域名 "${input.slug}" 已被占用，请更换名称`, 409)
          }
          if (hasActiveLease(existingRaw)) {
            throw new SitesError('SLUG_BUSY', `站点 "${input.slug}" 正在进行另一项发布或变更，请稍后重试`, 409, true)
          }
          const existing = mapRow(existingRaw)
          const edgeRevision = await allocateNextEdgeRevision(client)
          await client.query(
            `UPDATE user_sites
             SET op_lease_id = $2,
                 op_lease_until = $3,
                 op_expected_rev = edge_revision,
                 op_target_rev = $4,
                 updated_at = NOW()
             WHERE id = $1`,
            [existing.id, leaseId, leaseUntil, edgeRevision],
          )
          return {
            siteId: existing.id,
            leaseId,
            isNewPlaceholder: existing.edgeRevision === 0,
            edgeRevision,
            baseRevision: existing.edgeRevision,
            existing: existing.edgeRevision > 0 ? existing : null,
          }
        }

        // Count all existing rows (published, in-flight, and unresolved indeterminate placeholders) to enforce strict quota (B5/B3).
        const countRes = await client.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt FROM user_sites WHERE user_id = $1`,
          [input.userId],
        )
        const count = countRes.rows[0]?.cnt ?? 0
        if (count >= input.maxPerUser) {
          throw new SitesError(
            'QUOTA_EXCEEDED',
            `已达到站点数量上限（最多 ${input.maxPerUser} 个），请先删除旧站点或覆盖更新`,
            429,
          )
        }

        const edgeRevision = await allocateNextEdgeRevision(client)
        try {
          const ins = await client.query<{ id: string }>(
            `INSERT INTO user_sites (
               slug, user_id, title, visibility, password_salt, password_hash, spa_mode,
               edge_revision, op_lease_id, op_lease_until, op_expected_rev, op_target_rev
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, 0, $10)
             RETURNING id`,
            [
              input.slug,
              input.userId,
              input.title,
              input.visibility,
              input.passwordSalt,
              input.passwordHash,
              input.spaMode,
              leaseId,
              leaseUntil,
              edgeRevision,
            ],
          )
          return {
            siteId: ins.rows[0]!.id,
            leaseId,
            isNewPlaceholder: true,
            edgeRevision,
            baseRevision: 0,
            existing: null,
          }
        } catch (err) {
          if ((err as { code?: string })?.code === '23505') {
            throw new SitesError('SLUG_TAKEN', `子域名 "${input.slug}" 已被占用，请更换名称`, 409)
          }
          throw err
        }
      })
    },

    async commitPublish(input) {
      const res = await pool.query<RawUserSiteRow>(
        `UPDATE user_sites
         SET title = $4,
             visibility = $5,
             password_salt = $6,
             password_hash = $7,
             spa_mode = $8,
             file_count = $9,
             size_bytes = $10,
             content_sha256 = $11,
             edge_revision = $12,
             op_lease_id = CASE WHEN op_lease_id = $3 THEN NULL ELSE op_lease_id END,
             op_lease_until = CASE WHEN op_lease_id = $3 THEN NULL ELSE op_lease_until END,
             op_expected_rev = CASE WHEN op_lease_id = $3 THEN 0 ELSE op_expected_rev END,
             op_target_rev = CASE WHEN op_lease_id = $3 OR op_target_rev <= $12 THEN 0 ELSE op_target_rev END,
             updated_at = NOW(),
             last_published_at = NOW()
         WHERE id = $1 AND user_id = $2 AND edge_revision < $12
         RETURNING *`,
        [
          input.siteId,
          input.userId,
          input.leaseId,
          input.title,
          input.visibility,
          input.passwordSalt,
          input.passwordHash,
          input.spaMode,
          input.fileCount,
          input.sizeBytes,
          input.contentSha256,
          input.edgeRevision,
        ],
      )
      if (res.rows[0]) return mapRow(res.rows[0])

      const currentRes = await pool.query<RawUserSiteRow>(
        'SELECT * FROM user_sites WHERE id = $1 AND user_id = $2',
        [input.siteId, input.userId],
      )
      const cur = currentRes.rows[0]
      if (cur && Number(cur.edge_revision) === input.edgeRevision) {
        return mapRow(cur)
      }
      throw new SitesError('STALE_REVISION', '站点存在更新版本或已被删除', 409)
    },

    async abortPublishPlaceholder(siteId, userId, leaseId) {
      await pool.query(
        'DELETE FROM user_sites WHERE id = $1 AND user_id = $2 AND op_lease_id = $3 AND edge_revision = 0',
        [siteId, userId, leaseId],
      )
    },

    async releaseLease(siteId, userId, leaseId, clearTarget = true) {
      if (clearTarget) {
        await pool.query(
          `UPDATE user_sites
           SET op_lease_id = NULL, op_lease_until = NULL, op_expected_rev = 0, op_target_rev = 0
           WHERE id = $1 AND user_id = $2 AND op_lease_id = $3`,
          [siteId, userId, leaseId],
        )
        return
      }
      await pool.query(
        `UPDATE user_sites
         SET op_lease_id = NULL, op_lease_until = NULL
         WHERE id = $1 AND user_id = $2 AND op_lease_id = $3`,
        [siteId, userId, leaseId],
      )
    },

    async prepareMetaUpdate(userId, slug) {
      return withTx(pool, async (client) => {
        const res = await client.query<RawUserSiteRow>(
          `SELECT * FROM user_sites
           WHERE user_id = $1 AND slug = $2 AND edge_revision > 0
           FOR UPDATE`,
          [userId, slug],
        )
        const raw = res.rows[0]
        if (!raw) {
          throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
        }
        if (hasActiveLease(raw)) {
          throw new SitesError('SLUG_BUSY', `站点 "${slug}" 正在处理另一项变更，请稍后重试`, 409, true)
        }
        const site = mapRow(raw)
        const nextRevision = await allocateNextEdgeRevision(client)
        const leaseId = randomUUID()
        const leaseUntil = new Date(Date.now() + OP_LEASE_TTL_MS)
        await client.query(
          `UPDATE user_sites
           SET op_lease_id = $2,
               op_lease_until = $3,
               op_expected_rev = edge_revision,
               op_target_rev = $4
           WHERE id = $1`,
          [site.id, leaseId, leaseUntil, nextRevision],
        )
        return { site, leaseId, nextRevision }
      })
    },

    async commitMetaUpdate(input) {
      const res = await pool.query<RawUserSiteRow>(
        `UPDATE user_sites
         SET title = $4,
             visibility = $5,
             password_salt = $6,
             password_hash = $7,
             spa_mode = $8,
             edge_revision = $9,
             op_lease_id = CASE WHEN op_lease_id = $3 THEN NULL ELSE op_lease_id END,
             op_lease_until = CASE WHEN op_lease_id = $3 THEN NULL ELSE op_lease_until END,
             op_expected_rev = CASE WHEN op_lease_id = $3 THEN 0 ELSE op_expected_rev END,
             op_target_rev = CASE WHEN op_lease_id = $3 OR op_target_rev <= $9 THEN 0 ELSE op_target_rev END,
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND edge_revision < $9
         RETURNING *`,
        [
          input.siteId,
          input.userId,
          input.leaseId,
          input.title,
          input.visibility,
          input.passwordSalt,
          input.passwordHash,
          input.spaMode,
          input.edgeRevision,
        ],
      )
      if (res.rows[0]) return mapRow(res.rows[0])
      const currentRes = await pool.query<RawUserSiteRow>(
        'SELECT * FROM user_sites WHERE id = $1 AND user_id = $2',
        [input.siteId, input.userId],
      )
      const cur = currentRes.rows[0]
      if (cur && Number(cur.edge_revision) === input.edgeRevision) {
        return mapRow(cur)
      }
      throw new SitesError('STALE_REVISION', '站点存在更新版本或已被删除', 409)
    },

    async prepareDelete(userId, slug) {
      return withTx(pool, async (client) => {
        const res = await client.query<RawUserSiteRow>(
          `SELECT * FROM user_sites
           WHERE user_id = $1 AND slug = $2 AND edge_revision > 0
           FOR UPDATE`,
          [userId, slug],
        )
        const raw = res.rows[0]
        if (!raw) {
          throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
        }
        if (hasActiveLease(raw)) {
          throw new SitesError('SLUG_BUSY', `站点 "${slug}" 正在处理另一项变更，请稍后重试`, 409, true)
        }
        const site = mapRow(raw)
        const deleteRevision = await allocateNextEdgeRevision(client)
        const leaseId = randomUUID()
        const leaseUntil = new Date(Date.now() + OP_LEASE_TTL_MS)
        await client.query(
          `UPDATE user_sites
           SET op_lease_id = $2,
               op_lease_until = $3,
               op_expected_rev = edge_revision,
               op_target_rev = $4
           WHERE id = $1`,
          [site.id, leaseId, leaseUntil, deleteRevision],
        )
        return { site, leaseId, deleteRevision }
      })
    },

    async commitDelete(siteId, userId, _leaseId, deleteRevision) {
      // Fencing revision check prevents an out-of-order late delete from deleting a newer published site (B2).
      await pool.query(
        'DELETE FROM user_sites WHERE id = $1 AND user_id = $2 AND edge_revision < $3',
        [siteId, userId, deleteRevision],
      )
    },
  }
}
