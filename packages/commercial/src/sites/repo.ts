import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResult } from 'pg'
import {
  SitesError,
  type SiteOpKind,
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
  originSessionId?: string | null
  hasServerApi: boolean
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
  customDomain?: string | null
  customDomainVerified?: boolean
  customDomainToken?: string | null
  originSessionId?: string | null
  hasServerApi: boolean
  envDigest?: string
  markEnvPending?: boolean
  pendingEnvDigest?: string | null
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

export interface StoredSiteEnvVarRow {
  siteId: string
  key: string
  isSecret: boolean
  plainValue: string | null
  ciphertext: Buffer | null
  nonce: Buffer | null
  updatedAt: Date
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
  prepareMetaUpdate(
    userId: number,
    slug: string,
    opKind?: SiteOpKind,
    pendingEnvDigest?: string | null,
    checkCustomDomain?: string | null,
  ): Promise<MetaUpdateReservation>
  commitMetaUpdate(input: {
    siteId: string
    userId: number
    leaseId: string
    title: string
    visibility: SiteVisibility
    passwordSalt: string | null
    passwordHash: string | null
    spaMode: boolean
    customDomain: string | null
    customDomainVerified: boolean
    customDomainToken: string | null
    envDigest?: string
    edgeRevision: number
  }): Promise<UserSiteRow>
  prepareRename(userId: number, oldSlug: string, newSlug: string): Promise<MetaUpdateReservation>
  commitRename(input: {
    siteId: string
    userId: number
    leaseId: string
    newSlug: string
    edgeRevision: number
  }): Promise<UserSiteRow>
  abortRenameReservation(
    siteId: string,
    userId: number,
    leaseId: string,
    newSlug: string,
    clearTarget?: boolean,
  ): Promise<void>
  prepareDelete(userId: number, slug: string): Promise<DeleteReservation>
  commitDelete(siteId: string, userId: number, leaseId: string, deleteRevision: number): Promise<void>
  listSiteEnvRows(siteId: string, userId: number): Promise<StoredSiteEnvVarRow[]>
  upsertSiteEnvRow(input: {
    siteId: string
    userId: number
    key: string
    isSecret: boolean
    plainValue: string | null
    ciphertext: Buffer | null
    nonce: Buffer | null
    maxEnvVars: number
  }): Promise<StoredSiteEnvVarRow>
  deleteSiteEnvRow(siteId: string, userId: number, key: string): Promise<boolean>
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
  custom_domain: string | null
  custom_domain_verified?: boolean | null
  custom_domain_token?: string | null
  origin_session_id: string | null
  has_server_api: boolean
  env_digest?: string | null
  op_kind?: SiteOpKind | null
  op_rename_to_slug?: string | null
  op_env_digest?: string | null
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

interface RawSiteEnvVarRow {
  site_id: string
  env_key: string
  is_secret: boolean
  plain_value: string | null
  ciphertext: Buffer | null
  nonce: Buffer | null
  updated_at: Date
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
    customDomain: r.custom_domain ?? null,
    customDomainVerified: Boolean(r.custom_domain_verified),
    customDomainToken: r.custom_domain_token ?? null,
    originSessionId: r.origin_session_id ?? null,
    hasServerApi: Boolean(r.has_server_api),
    envDigest: r.env_digest ?? '',
    opKind: r.op_kind ?? null,
    opRenameToSlug: r.op_rename_to_slug ?? null,
    opEnvDigest: r.op_env_digest ?? null,
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

function mapEnvRow(r: RawSiteEnvVarRow): StoredSiteEnvVarRow {
  return {
    siteId: r.site_id,
    key: r.env_key,
    isSecret: Boolean(r.is_secret),
    plainValue: r.plain_value ?? null,
    ciphertext: r.ciphertext ? Buffer.from(r.ciphertext) : null,
    nonce: r.nonce ? Buffer.from(r.nonce) : null,
    updatedAt: r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at),
  }
}

function isCustomDomainUniqueViolation(err: unknown): boolean {
  const pgErr = err as { code?: string; constraint?: string; detail?: string }
  return (
    pgErr?.code === '23505' &&
    (pgErr.constraint === 'idx_user_sites_custom_domain_verified_unique' ||
      pgErr.constraint === 'idx_user_sites_custom_domain_unique' ||
      String(pgErr.detail ?? '').includes('custom_domain'))
  )
}

function hasActiveLease(row: { op_lease_id: string | null; op_lease_until: Date | null }): boolean {
  if (!row.op_lease_id || !row.op_lease_until) return false
  const until =
    row.op_lease_until instanceof Date ? row.op_lease_until.getTime() : new Date(row.op_lease_until).getTime()
  return until > Date.now()
}

async function lockSlugAdvisory(client: PoolClient, slug: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('oc_site_slug:' || $1))`, [slug])
}

async function lockTwoSlugsAdvisory(client: PoolClient, a: string, b: string): Promise<void> {
  if (a === b) {
    await lockSlugAdvisory(client, a)
    return
  }
  const [first, second] = a < b ? [a, b] : [b, a]
  await lockSlugAdvisory(client, first)
  await lockSlugAdvisory(client, second)
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
           AND (edge_revision = 0 OR op_target_rev > edge_revision OR op_kind IS NOT NULL)
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
           AND (edge_revision = 0 OR op_target_rev > edge_revision OR op_kind IS NOT NULL)
         RETURNING *`,
        [siteId, userId, leaseId, leaseUntil],
      )
      return res.rows[0] ? { row: mapRow(res.rows[0]), leaseId } : null
    },

    async reconcileFromEdge(input) {
      const hasDomainPatch = input.customDomain !== undefined
      const hasEnvDigestPatch = input.envDigest !== undefined
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
             edge_revision = GREATEST(edge_revision, $12),
             has_server_api = $13,
             custom_domain = CASE WHEN $14::boolean THEN $15 ELSE custom_domain END,
             custom_domain_verified = CASE
               WHEN $14::boolean AND $15::text IS NULL THEN FALSE
               WHEN $14::boolean AND $16::boolean THEN TRUE
               ELSE custom_domain_verified
             END,
             env_digest = CASE WHEN $17::boolean THEN $18 ELSE env_digest END,
             op_lease_id = NULL,
             op_lease_until = NULL,
             op_expected_rev = 0,
             op_target_rev = 0,
             op_kind = NULL,
             op_rename_to_slug = NULL,
             op_env_digest = NULL,
             updated_at = NOW(),
             last_published_at = CASE WHEN edge_revision = 0 THEN NOW() ELSE last_published_at END
         WHERE id = $1
           AND user_id = $2
           AND op_lease_id = $3
           AND edge_revision <= $12
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
          input.hasServerApi,
          hasDomainPatch,
          input.customDomain ?? null,
          Boolean(input.customDomainVerified),
          hasEnvDigestPatch,
          input.envDigest ?? '',
        ],
      )
      return res.rows[0] ? mapRow(res.rows[0]) : null
    },

    async beginPublishReservation(input) {
      return withTx(pool, async (client) => {
        const userLock = await client.query<{ id: number }>(
          'SELECT id FROM users WHERE id = $1 FOR UPDATE',
          [input.userId],
        )
        if (userLock.rows.length === 0) {
          throw new SitesError('SITE_NOT_FOUND', '用户不存在', 404)
        }

        await lockSlugAdvisory(client, input.slug)

        // Check durable slug claim first so an in-flight rename target can never be hijacked.
        const claimRes = await client.query<{ site_id: string; claim_kind: string; owner_id: number }>(
          `SELECT c.site_id, c.claim_kind, s.user_id AS owner_id
           FROM user_site_slug_claims c
           JOIN user_sites s ON s.id = c.site_id
           WHERE c.slug = $1
           FOR UPDATE OF c, s`,
          [input.slug],
        )
        const claim = claimRes.rows[0]
        if (claim) {
          if (Number(claim.owner_id) !== input.userId) {
            throw new SitesError('SLUG_TAKEN', `子域名 "${input.slug}" 已被占用，请更换名称`, 409)
          }
          if (claim.claim_kind === 'rename_target') {
            throw new SitesError(
              'SLUG_BUSY',
              `子域名 "${input.slug}" 正在迁移重命名中，请稍后重试`,
              409,
              true,
            )
          }
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
            throw new SitesError(
              'SLUG_BUSY',
              `站点 "${input.slug}" 正在进行另一项发布或变更，请稍后重试`,
              409,
              true,
            )
          }
          const existing = mapRow(existingRaw)
          const edgeRevision = await allocateNextEdgeRevision(client)
          await client.query(
            `UPDATE user_sites
             SET op_lease_id = $2,
                 op_lease_until = $3,
                 op_expected_rev = edge_revision,
                 op_target_rev = $4,
                 op_kind = 'publish',
                 op_rename_to_slug = NULL,
                 op_env_digest = NULL,
                 updated_at = NOW()
             WHERE id = $1`,
            [existing.id, leaseId, leaseUntil, edgeRevision],
          )
          await client.query(
            `INSERT INTO user_site_slug_claims (slug, site_id, claim_kind)
             VALUES ($1, $2, 'active')
             ON CONFLICT (slug) DO NOTHING`,
            [input.slug, existing.id],
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

        const countRes = await client.query<{ cnt: number }>(
          'SELECT COUNT(*)::int AS cnt FROM user_sites WHERE user_id = $1',
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
               origin_session_id, has_server_api,
               edge_revision, op_lease_id, op_lease_until, op_expected_rev, op_target_rev, op_kind
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, 0, $12, 'publish')
             RETURNING id`,
            [
              input.slug,
              input.userId,
              input.title,
              input.visibility,
              input.passwordSalt,
              input.passwordHash,
              input.spaMode,
              input.originSessionId ?? null,
              input.hasServerApi,
              leaseId,
              leaseUntil,
              edgeRevision,
            ],
          )
          const siteId = ins.rows[0]!.id
          await client.query(
            `INSERT INTO user_site_slug_claims (slug, site_id, claim_kind)
             VALUES ($1, $2, 'active')`,
            [input.slug, siteId],
          )
          return {
            siteId,
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
      const hasEnvDigest = input.envDigest !== undefined
      const markEnvPending = Boolean(input.markEnvPending)
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
             has_server_api = $13,
             origin_session_id = COALESCE($14, origin_session_id),
             env_digest = CASE WHEN $15::boolean THEN $16 ELSE env_digest END,
             op_lease_id = CASE WHEN op_lease_id = $3 THEN NULL ELSE op_lease_id END,
             op_lease_until = CASE WHEN op_lease_id = $3 THEN NULL ELSE op_lease_until END,
             op_expected_rev = CASE WHEN op_lease_id = $3 THEN 0 ELSE op_expected_rev END,
             op_target_rev = CASE
               WHEN $17::boolean AND op_lease_id = $3 THEN $12
               WHEN op_lease_id = $3 OR op_target_rev <= $12 THEN 0
               ELSE op_target_rev
             END,
             op_kind = CASE
               WHEN $17::boolean AND op_lease_id = $3 THEN 'env'
               WHEN op_lease_id = $3 THEN NULL
               ELSE op_kind
             END,
             op_rename_to_slug = CASE WHEN op_lease_id = $3 THEN NULL ELSE op_rename_to_slug END,
             op_env_digest = CASE
               WHEN $17::boolean AND op_lease_id = $3 THEN $18
               WHEN op_lease_id = $3 THEN NULL
               ELSE op_env_digest
             END,
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
          input.hasServerApi,
          input.originSessionId ?? null,
          hasEnvDigest,
          input.envDigest ?? '',
          markEnvPending,
          input.pendingEnvDigest ?? null,
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
           SET op_lease_id = NULL,
               op_lease_until = NULL,
               op_expected_rev = 0,
               op_target_rev = 0,
               op_kind = NULL,
               op_rename_to_slug = NULL,
               op_env_digest = NULL
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

    async prepareMetaUpdate(userId, slug, opKind = 'meta', pendingEnvDigest = null, checkCustomDomain = null) {
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
        if (checkCustomDomain) {
          const dup = await client.query<{ id: string }>(
            `SELECT id FROM user_sites
             WHERE custom_domain = $1 AND custom_domain_verified = TRUE AND id <> $2
             LIMIT 1`,
            [checkCustomDomain, site.id],
          )
          if (dup.rows.length > 0) {
            throw new SitesError('DOMAIN_TAKEN', '该自定义域名已被其他站点绑定', 409)
          }
        }
        const nextRevision = await allocateNextEdgeRevision(client)
        const leaseId = randomUUID()
        const leaseUntil = new Date(Date.now() + OP_LEASE_TTL_MS)
        await client.query(
          `UPDATE user_sites
           SET op_lease_id = $2,
               op_lease_until = $3,
               op_expected_rev = edge_revision,
               op_target_rev = $4,
               op_kind = $5,
               op_rename_to_slug = NULL,
               op_env_digest = $6
           WHERE id = $1`,
          [site.id, leaseId, leaseUntil, nextRevision, opKind, pendingEnvDigest],
        )
        return { site, leaseId, nextRevision }
      })
    },

    async commitMetaUpdate(input) {
      const hasEnvDigest = input.envDigest !== undefined
      return withTx(pool, async (client) => {
        if (input.customDomain) {
          const dup = await client.query<{ id: string }>(
            `SELECT id FROM user_sites
             WHERE custom_domain = $1 AND custom_domain_verified = TRUE AND id <> $2
             LIMIT 1`,
            [input.customDomain, input.siteId],
          )
          if (dup.rows.length > 0) {
            throw new SitesError('DOMAIN_TAKEN', '该自定义域名已被其他站点绑定', 409)
          }
        }
        let res: QueryResult<RawUserSiteRow>
        try {
          res = await client.query<RawUserSiteRow>(
            `UPDATE user_sites
             SET title = $4,
                 visibility = $5,
                 password_salt = $6,
                 password_hash = $7,
                 spa_mode = $8,
                 custom_domain = $10,
                 custom_domain_verified = $11,
                 custom_domain_token = $12,
                 env_digest = CASE WHEN $13::boolean THEN $14 ELSE env_digest END,
                 edge_revision = $9,
                 op_lease_id = CASE WHEN op_lease_id = $3 THEN NULL ELSE op_lease_id END,
                 op_lease_until = CASE WHEN op_lease_id = $3 THEN NULL ELSE op_lease_until END,
                 op_expected_rev = CASE WHEN op_lease_id = $3 THEN 0 ELSE op_expected_rev END,
                 op_target_rev = CASE WHEN op_lease_id = $3 OR op_target_rev <= $9 THEN 0 ELSE op_target_rev END,
                 op_kind = CASE WHEN op_lease_id = $3 THEN NULL ELSE op_kind END,
                 op_rename_to_slug = CASE WHEN op_lease_id = $3 THEN NULL ELSE op_rename_to_slug END,
                 op_env_digest = CASE WHEN op_lease_id = $3 THEN NULL ELSE op_env_digest END,
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
              input.customDomain,
              input.customDomainVerified,
              input.customDomainToken,
              hasEnvDigest,
              input.envDigest ?? '',
            ],
          )
        } catch (err) {
          if (isCustomDomainUniqueViolation(err)) {
            throw new SitesError('DOMAIN_TAKEN', '该自定义域名已被其他站点绑定', 409)
          }
          throw err
        }
        if (res.rows[0]) return mapRow(res.rows[0])
        const currentRes = await client.query<RawUserSiteRow>(
          'SELECT * FROM user_sites WHERE id = $1 AND user_id = $2',
          [input.siteId, input.userId],
        )
        const cur = currentRes.rows[0]
        if (cur && Number(cur.edge_revision) === input.edgeRevision) {
          return mapRow(cur)
        }
        throw new SitesError('STALE_REVISION', '站点存在更新版本或已被删除', 409)
      })
    },

    async prepareRename(userId, oldSlug, newSlug) {
      return withTx(pool, async (client) => {
        await lockTwoSlugsAdvisory(client, oldSlug, newSlug)

        const res = await client.query<RawUserSiteRow>(
          `SELECT * FROM user_sites
           WHERE user_id = $1 AND slug = $2 AND edge_revision > 0
           FOR UPDATE`,
          [userId, oldSlug],
        )
        const raw = res.rows[0]
        if (!raw) {
          throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${oldSlug}"`, 404)
        }
        if (hasActiveLease(raw)) {
          throw new SitesError('SLUG_BUSY', `站点 "${oldSlug}" 正在处理另一项变更，请稍后重试`, 409, true)
        }
        const dstClaim = await client.query<{ site_id: string }>(
          'SELECT site_id FROM user_site_slug_claims WHERE slug = $1 FOR UPDATE',
          [newSlug],
        )
        const dstRow = await client.query<{ id: string }>(
          'SELECT id FROM user_sites WHERE slug = $1 FOR UPDATE',
          [newSlug],
        )
        if (dstClaim.rows.length > 0 || dstRow.rows.length > 0) {
          throw new SitesError('SLUG_TAKEN', `子域名 "${newSlug}" 已被占用，请更换名称`, 409)
        }
        const site = mapRow(raw)
        const nextRevision = await allocateNextEdgeRevision(client)
        const leaseId = randomUUID()
        const leaseUntil = new Date(Date.now() + OP_LEASE_TTL_MS)

        await client.query(
          `INSERT INTO user_site_slug_claims (slug, site_id, claim_kind)
           VALUES ($1, $2, 'rename_target')`,
          [newSlug, site.id],
        )
        await client.query(
          `UPDATE user_sites
           SET op_lease_id = $2,
               op_lease_until = $3,
               op_expected_rev = edge_revision,
               op_target_rev = $4,
               op_kind = 'rename',
               op_rename_to_slug = $5,
               op_env_digest = NULL
           WHERE id = $1`,
          [site.id, leaseId, leaseUntil, nextRevision, newSlug],
        )
        return { site, leaseId, nextRevision }
      })
    },

    async commitRename(input) {
      return withTx(pool, async (client) => {
        const preRes = await client.query<{ slug: string }>(
          'SELECT slug FROM user_sites WHERE id = $1 AND user_id = $2',
          [input.siteId, input.userId],
        )
        const pre = preRes.rows[0]
        if (!pre) {
          throw new SitesError('STALE_REVISION', '站点存在更新版本或已被删除', 409)
        }
        await lockTwoSlugsAdvisory(client, pre.slug, input.newSlug)
        const curRes = await client.query<RawUserSiteRow>(
          'SELECT * FROM user_sites WHERE id = $1 AND user_id = $2 FOR UPDATE',
          [input.siteId, input.userId],
        )
        const cur = curRes.rows[0]
        if (!cur) {
          throw new SitesError('STALE_REVISION', '站点存在更新版本或已被删除', 409)
        }
        if (cur.slug !== pre.slug) {
          await lockSlugAdvisory(client, cur.slug)
        }
        if (Number(cur.edge_revision) === input.edgeRevision && cur.slug === input.newSlug) {
          await client.query(
            `UPDATE user_site_slug_claims SET claim_kind = 'active', updated_at = NOW()
             WHERE slug = $1 AND site_id = $2`,
            [input.newSlug, input.siteId],
          )
          return mapRow(cur)
        }
        if (Number(cur.edge_revision) >= input.edgeRevision) {
          throw new SitesError('STALE_REVISION', '站点存在更新版本或已被删除', 409)
        }
        try {
          const upd = await client.query<RawUserSiteRow>(
            `UPDATE user_sites
             SET slug = $4,
                 edge_revision = $5,
                 op_lease_id = CASE WHEN op_lease_id = $3 THEN NULL ELSE op_lease_id END,
                 op_lease_until = CASE WHEN op_lease_id = $3 THEN NULL ELSE op_lease_until END,
                 op_expected_rev = CASE WHEN op_lease_id = $3 THEN 0 ELSE op_expected_rev END,
                 op_target_rev = CASE WHEN op_lease_id = $3 OR op_target_rev <= $5 THEN 0 ELSE op_target_rev END,
                 op_kind = CASE WHEN op_lease_id = $3 THEN NULL ELSE op_kind END,
                 op_rename_to_slug = CASE WHEN op_lease_id = $3 THEN NULL ELSE op_rename_to_slug END,
                 op_env_digest = CASE WHEN op_lease_id = $3 THEN NULL ELSE op_env_digest END,
                 updated_at = NOW()
             WHERE id = $1 AND user_id = $2 AND edge_revision < $5
             RETURNING *`,
            [input.siteId, input.userId, input.leaseId, input.newSlug, input.edgeRevision],
          )
          if (!upd.rows[0]) {
            throw new SitesError('STALE_REVISION', '站点存在更新版本或已被删除', 409)
          }
          await client.query(
            'DELETE FROM user_site_slug_claims WHERE site_id = $1 AND slug <> $2',
            [input.siteId, input.newSlug],
          )
          await client.query(
            `INSERT INTO user_site_slug_claims (slug, site_id, claim_kind, updated_at)
             VALUES ($1, $2, 'active', NOW())
             ON CONFLICT (slug) DO UPDATE SET
               claim_kind = 'active',
               updated_at = NOW()
             WHERE user_site_slug_claims.site_id = EXCLUDED.site_id`,
            [input.newSlug, input.siteId],
          )
          return mapRow(upd.rows[0])
        } catch (err) {
          if ((err as { code?: string })?.code === '23505') {
            throw new SitesError('SLUG_TAKEN', `子域名 "${input.newSlug}" 已被占用，请更换名称`, 409)
          }
          throw err
        }
      })
    },

    async abortRenameReservation(siteId, userId, leaseId, newSlug, clearTarget = true) {
      await withTx(pool, async (client) => {
        await client.query(
          `DELETE FROM user_site_slug_claims
           WHERE slug = $1 AND site_id = $2 AND claim_kind = 'rename_target'`,
          [newSlug, siteId],
        )
        if (clearTarget) {
          await client.query(
            `UPDATE user_sites
             SET op_lease_id = NULL,
                 op_lease_until = NULL,
                 op_expected_rev = 0,
                 op_target_rev = 0,
                 op_kind = NULL,
                 op_rename_to_slug = NULL,
                 op_env_digest = NULL
             WHERE id = $1 AND user_id = $2 AND op_lease_id = $3`,
            [siteId, userId, leaseId],
          )
        } else {
          await client.query(
            `UPDATE user_sites
             SET op_lease_id = NULL, op_lease_until = NULL
             WHERE id = $1 AND user_id = $2 AND op_lease_id = $3`,
            [siteId, userId, leaseId],
          )
        }
      })
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
               op_target_rev = $4,
               op_kind = 'delete',
               op_rename_to_slug = NULL,
               op_env_digest = NULL
           WHERE id = $1`,
          [site.id, leaseId, leaseUntil, deleteRevision],
        )
        return { site, leaseId, deleteRevision }
      })
    },

    async commitDelete(siteId, userId, _leaseId, deleteRevision) {
      await pool.query(
        'DELETE FROM user_sites WHERE id = $1 AND user_id = $2 AND edge_revision < $3',
        [siteId, userId, deleteRevision],
      )
    },

    async listSiteEnvRows(siteId, userId) {
      const res = await pool.query<RawSiteEnvVarRow>(
        `SELECT e.site_id, e.env_key, e.is_secret, e.plain_value, e.ciphertext, e.nonce, e.updated_at
         FROM user_site_env_vars e
         JOIN user_sites s ON s.id = e.site_id
         WHERE e.site_id = $1 AND s.user_id = $2
         ORDER BY e.env_key ASC`,
        [siteId, userId],
      )
      return res.rows.map(mapEnvRow)
    },

    async upsertSiteEnvRow(input) {
      return withTx(pool, async (client) => {
        const siteRes = await client.query<{ id: string }>(
          `SELECT id FROM user_sites
           WHERE id = $1 AND user_id = $2 AND edge_revision > 0
           FOR UPDATE`,
          [input.siteId, input.userId],
        )
        if (siteRes.rows.length === 0) {
          throw new SitesError('SITE_NOT_FOUND', '未找到对应站点', 404)
        }
        const cntRes = await client.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt
           FROM user_site_env_vars
           WHERE site_id = $1 AND env_key <> $2`,
          [input.siteId, input.key],
        )
        if ((cntRes.rows[0]?.cnt ?? 0) >= input.maxEnvVars) {
          throw new SitesError(
            'QUOTA_EXCEEDED',
            `每个站点最多配置 ${input.maxEnvVars} 个环境变量`,
            429,
          )
        }
        const res = await client.query<RawSiteEnvVarRow>(
          `INSERT INTO user_site_env_vars (
             site_id, env_key, is_secret, plain_value, ciphertext, nonce, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (site_id, env_key) DO UPDATE SET
             is_secret = EXCLUDED.is_secret,
             plain_value = EXCLUDED.plain_value,
             ciphertext = EXCLUDED.ciphertext,
             nonce = EXCLUDED.nonce,
             updated_at = NOW()
           RETURNING site_id, env_key, is_secret, plain_value, ciphertext, nonce, updated_at`,
          [
            input.siteId,
            input.key,
            input.isSecret,
            input.plainValue,
            input.ciphertext,
            input.nonce,
          ],
        )
        return mapEnvRow(res.rows[0]!)
      })
    },

    async deleteSiteEnvRow(siteId, userId, key) {
      const res = await pool.query(
        `DELETE FROM user_site_env_vars e
         USING user_sites s
         WHERE e.site_id = s.id
           AND e.site_id = $1
           AND s.user_id = $2
           AND e.env_key = $3`,
        [siteId, userId, key],
      )
      return (res.rowCount ?? 0) > 0
    },
  }
}
