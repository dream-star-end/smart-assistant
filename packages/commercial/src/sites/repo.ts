import type { Pool, PoolClient } from 'pg'
import {
  SitesError,
  type SiteVisibility,
  type UserSiteRow,
} from './types.js'

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
  isNewPlaceholder: boolean
  edgeRevision: number
  existing: UserSiteRow | null
}

export interface CommitPublishInput {
  siteId: string
  userId: number
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
  nextRevision: number
}

export interface DeleteReservation {
  site: UserSiteRow
  deleteRevision: number
}

export interface SitesRepo {
  listByUser(userId: number): Promise<UserSiteRow[]>
  getByUserAndSlug(userId: number, slug: string): Promise<UserSiteRow | null>
  beginPublishReservation(input: PublishReservationInput): Promise<PublishReservation>
  commitPublish(input: CommitPublishInput): Promise<UserSiteRow>
  abortPublishPlaceholder(siteId: string, userId: number): Promise<void>
  prepareMetaUpdate(userId: number, slug: string): Promise<MetaUpdateReservation>
  commitMetaUpdate(input: {
    siteId: string
    userId: number
    title: string
    visibility: SiteVisibility
    passwordSalt: string | null
    passwordHash: string | null
    spaMode: boolean
    edgeRevision: number
  }): Promise<UserSiteRow>
  prepareDelete(userId: number, slug: string): Promise<DeleteReservation>
  commitDelete(siteId: string, userId: number): Promise<void>
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
        const existing = existingRes.rows[0] ? mapRow(existingRes.rows[0]) : null

        if (existing) {
          if (existing.userId !== input.userId) {
            throw new SitesError('SLUG_TAKEN', `子域名 "${input.slug}" 已被占用，请更换名称`, 409)
          }
          const edgeRevision = await allocateNextEdgeRevision(client)
          return {
            siteId: existing.id,
            isNewPlaceholder: existing.edgeRevision === 0,
            edgeRevision,
            existing: existing.edgeRevision > 0 ? existing : null,
          }
        }

        const countRes = await client.query<{ cnt: number }>(
          'SELECT COUNT(*)::int AS cnt FROM user_sites WHERE user_id = $1 AND edge_revision > 0',
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
               slug, user_id, title, visibility, password_salt, password_hash, spa_mode, edge_revision
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0)
             RETURNING id`,
            [
              input.slug,
              input.userId,
              input.title,
              input.visibility,
              input.passwordSalt,
              input.passwordHash,
              input.spaMode,
            ],
          )
          return {
            siteId: ins.rows[0]!.id,
            isNewPlaceholder: true,
            edgeRevision,
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
         SET title = $3,
             visibility = $4,
             password_salt = $5,
             password_hash = $6,
             spa_mode = $7,
             file_count = $8,
             size_bytes = $9,
             content_sha256 = $10,
             edge_revision = $11,
             updated_at = NOW(),
             last_published_at = NOW()
         WHERE id = $1 AND user_id = $2 AND edge_revision < $11
         RETURNING *`,
        [
          input.siteId,
          input.userId,
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

      // Out-of-order slower write lost to a newer publish or concurrent delete: read current state.
      const currentRes = await pool.query<RawUserSiteRow>(
        'SELECT * FROM user_sites WHERE id = $1 AND user_id = $2 AND edge_revision > 0',
        [input.siteId, input.userId],
      )
      if (currentRes.rows[0]) return mapRow(currentRes.rows[0])
      throw new SitesError('SITE_NOT_FOUND', '站点已被删除', 404)
    },

    async abortPublishPlaceholder(siteId, userId) {
      await pool.query(
        'DELETE FROM user_sites WHERE id = $1 AND user_id = $2 AND edge_revision = 0',
        [siteId, userId],
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
        if (!res.rows[0]) {
          throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
        }
        const nextRevision = await allocateNextEdgeRevision(client)
        return { site: mapRow(res.rows[0]), nextRevision }
      })
    },

    async commitMetaUpdate(input) {
      const res = await pool.query<RawUserSiteRow>(
        `UPDATE user_sites
         SET title = $3,
             visibility = $4,
             password_salt = $5,
             password_hash = $6,
             spa_mode = $7,
             edge_revision = $8,
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND edge_revision < $8
         RETURNING *`,
        [
          input.siteId,
          input.userId,
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
        'SELECT * FROM user_sites WHERE id = $1 AND user_id = $2 AND edge_revision > 0',
        [input.siteId, input.userId],
      )
      if (currentRes.rows[0]) return mapRow(currentRes.rows[0])
      throw new SitesError('SITE_NOT_FOUND', '站点不存在或已被删除', 404)
    },

    async prepareDelete(userId, slug) {
      return withTx(pool, async (client) => {
        const res = await client.query<RawUserSiteRow>(
          `SELECT * FROM user_sites
           WHERE user_id = $1 AND slug = $2 AND edge_revision > 0
           FOR UPDATE`,
          [userId, slug],
        )
        if (!res.rows[0]) {
          throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
        }
        const deleteRevision = await allocateNextEdgeRevision(client)
        return { site: mapRow(res.rows[0]), deleteRevision }
      })
    },

    async commitDelete(siteId, userId) {
      await pool.query('DELETE FROM user_sites WHERE id = $1 AND user_id = $2', [siteId, userId])
    },
  }
}
