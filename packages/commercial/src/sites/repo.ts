import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResult } from 'pg'
import {
  SitesError,
  type SiteAccessRole,
  type SiteCollaboratorRole,
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
  serverApiSha256?: string
  expectedSiteId?: string
  expectedBaseRevision?: number
  expectedBaseContentSha256?: string
  forceOverwrite?: boolean
  maxPerUser: number
}

export interface PublishReservation {
  siteId: string
  ownerUserId: number
  accessRole: SiteAccessRole
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
  serverApiSha256?: string
  previewAclVersion?: number
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

export interface StoredSiteCollaboratorRow {
  siteId: string
  userId: number
  email: string
  displayName: string | null
  role: SiteCollaboratorRole
  createdAt: Date
  updatedAt: Date
}

export interface StoredSiteInviteRow {
  id: string
  siteId: string
  role: SiteCollaboratorRole
  maxUses: number | null
  useCount: number
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}

export interface StoredSiteInviteLookup {
  invite: StoredSiteInviteRow
  site: UserSiteRow
  ownerEmail: string | null
  ownerDisplayName: string | null
  alreadyRole: SiteAccessRole | null
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
    allowEditor?: boolean,
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
    previewAclVersion?: number
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
  listCollaborators?(siteId: string): Promise<StoredSiteCollaboratorRow[]>
  upsertCollaboratorByEmail?(input: {
    siteId: string
    ownerUserId: number
    email: string
    role: SiteCollaboratorRole
    maxCollaborators: number
  }): Promise<StoredSiteCollaboratorRow>
  updateCollaboratorRole?(input: {
    siteId: string
    ownerUserId: number
    targetUserId: number
    role: SiteCollaboratorRole
  }): Promise<StoredSiteCollaboratorRow>
  removeCollaborator?(input: {
    siteId: string
    ownerUserId: number
    targetUserId: number
  }): Promise<boolean>
  leaveSiteCollaborator?(siteId: string, actorUserId: number): Promise<boolean>
  listActiveInvites?(siteId: string, ownerUserId: number): Promise<StoredSiteInviteRow[]>
  createInvite?(input: {
    siteId: string
    ownerUserId: number
    tokenHash: string
    role: SiteCollaboratorRole
    maxUses: number | null
    expiresAt: Date | null
    maxActiveInvites: number
  }): Promise<StoredSiteInviteRow>
  revokeInvite?(input: {
    siteId: string
    ownerUserId: number
    inviteId: string
  }): Promise<boolean>
  lookupInviteByTokenHash?(
    tokenHash: string,
    actorUserId: number,
  ): Promise<StoredSiteInviteLookup | null>
  acceptInviteByTokenHash?(
    tokenHash: string,
    actorUserId: number,
    maxCollaborators: number,
  ): Promise<{ site: UserSiteRow; role: SiteAccessRole; alreadyMember: boolean }>
}

interface RawUserSiteRow {
  id: string
  slug: string
  user_id: number
  access_role?: SiteAccessRole | null
  owner_email?: string | null
  owner_display_name?: string | null
  collaborator_count?: string | number | null
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
  server_api_sha256?: string | null
  op_server_api_sha256?: string | null
  preview_acl_version?: string | number | null
  preview_acl_target_version?: string | number | null
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

interface RawSiteCollaboratorRow {
  site_id: string
  user_id: number
  email: string
  display_name: string | null
  role: SiteCollaboratorRole
  created_at: Date
  updated_at: Date
}

interface RawSiteInviteRow {
  id: string
  site_id: string
  role: SiteCollaboratorRole
  max_uses: number | null
  use_count: number
  expires_at: Date | null
  revoked_at: Date | null
  created_at: Date
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
    accessRole: r.access_role ?? 'owner',
    ownerEmail: r.owner_email ?? null,
    ownerDisplayName: r.owner_display_name ?? null,
    collaboratorCount: r.collaborator_count != null ? Number(r.collaborator_count) : 0,
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
    serverApiSha256: r.server_api_sha256 ?? '',
    opServerApiSha256: r.op_server_api_sha256 ?? null,
    previewAclVersion: r.preview_acl_version != null ? Math.max(1, Number(r.preview_acl_version)) : 1,
    previewAclTargetVersion:
      r.preview_acl_target_version != null
        ? Math.max(1, Number(r.preview_acl_target_version))
        : r.preview_acl_version != null
          ? Math.max(1, Number(r.preview_acl_version))
          : 1,
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

function mapCollaboratorRow(r: RawSiteCollaboratorRow): StoredSiteCollaboratorRow {
  return {
    siteId: r.site_id,
    userId: Number(r.user_id),
    email: r.email,
    displayName: r.display_name ?? null,
    role: r.role,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at),
  }
}

function mapInviteRow(r: RawSiteInviteRow): StoredSiteInviteRow {
  return {
    id: r.id,
    siteId: r.site_id,
    role: r.role,
    maxUses: r.max_uses === null || r.max_uses === undefined ? null : Number(r.max_uses),
    useCount: Number(r.use_count ?? 0),
    expiresAt: r.expires_at ? (r.expires_at instanceof Date ? r.expires_at : new Date(r.expires_at)) : null,
    revokedAt: r.revoked_at ? (r.revoked_at instanceof Date ? r.revoked_at : new Date(r.revoked_at)) : null,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
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
        `SELECT s.*,
                CASE WHEN s.user_id = $1 THEN 'owner' ELSE c.role END AS access_role,
                u.email AS owner_email,
                u.display_name AS owner_display_name,
                (SELECT COUNT(*)::int FROM user_site_collaborators cc WHERE cc.site_id = s.id) AS collaborator_count
         FROM user_sites s
         LEFT JOIN user_site_collaborators c ON c.site_id = s.id AND c.user_id = $1
         LEFT JOIN users u ON u.id = s.user_id
         WHERE s.edge_revision > 0
           AND (s.user_id = $1 OR c.user_id IS NOT NULL)
         ORDER BY s.updated_at DESC, s.created_at DESC`,
        [userId],
      )
      return res.rows.map(mapRow)
    },

    async getByUserAndSlug(userId, slug) {
      const res = await pool.query<RawUserSiteRow>(
        `SELECT s.*,
                CASE WHEN s.user_id = $1 THEN 'owner' ELSE c.role END AS access_role,
                u.email AS owner_email,
                u.display_name AS owner_display_name,
                (SELECT COUNT(*)::int FROM user_site_collaborators cc WHERE cc.site_id = s.id) AS collaborator_count
         FROM user_sites s
         LEFT JOIN user_site_collaborators c ON c.site_id = s.id AND c.user_id = $1
         LEFT JOIN users u ON u.id = s.user_id
         WHERE s.slug = $2
           AND s.edge_revision > 0
           AND (s.user_id = $1 OR c.user_id IS NOT NULL)`,
        [userId, slug],
      )
      return res.rows[0] ? mapRow(res.rows[0]) : null
    },

    async listUnleasedPendingByUser(userId) {
      const res = await pool.query<RawUserSiteRow>(
        `SELECT s.*
         FROM user_sites s
         LEFT JOIN user_site_collaborators c ON c.site_id = s.id AND c.user_id = $1
         WHERE (s.user_id = $1 OR c.user_id IS NOT NULL)
           AND (s.op_lease_until IS NULL OR s.op_lease_until <= NOW())
           AND (
             s.edge_revision = 0
             OR s.op_target_rev > s.edge_revision
             OR s.op_kind IS NOT NULL
             OR s.preview_acl_target_version > s.preview_acl_version
           )
         ORDER BY s.created_at ASC`,
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
           AND (
             edge_revision = 0
             OR op_target_rev > edge_revision
             OR op_kind IS NOT NULL
             OR preview_acl_target_version > preview_acl_version
           )
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
             server_api_sha256 = CASE
               WHEN NOT $13::boolean THEN ''
               WHEN op_kind = 'publish' AND op_target_rev > 0 AND op_target_rev <= $12 AND op_server_api_sha256 IS NOT NULL THEN op_server_api_sha256
               ELSE server_api_sha256
             END,
             custom_domain = CASE WHEN $14::boolean THEN $15 ELSE custom_domain END,
             custom_domain_verified = CASE
               WHEN $14::boolean AND $15::text IS NULL THEN FALSE
               WHEN $14::boolean AND $16::boolean THEN TRUE
               ELSE custom_domain_verified
             END,
             env_digest = CASE WHEN $17::boolean THEN $18 ELSE env_digest END,
             preview_acl_version = GREATEST(preview_acl_version, $19),
             preview_acl_target_version = GREATEST(preview_acl_target_version, $19),
             op_lease_id = NULL,
             op_lease_until = NULL,
             op_expected_rev = 0,
             op_target_rev = 0,
             op_kind = NULL,
             op_rename_to_slug = NULL,
             op_env_digest = NULL,
             op_server_api_sha256 = NULL,
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
          Math.max(1, Math.trunc(input.previewAclVersion ?? 1)),
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
        let collabRoleOnClaim: SiteCollaboratorRole | null = null
        if (claim && Number(claim.owner_id) !== input.userId) {
          const collabRes = await client.query<{ role: SiteCollaboratorRole }>(
            `SELECT role FROM user_site_collaborators
             WHERE site_id = $1 AND user_id = $2
             FOR SHARE`,
            [claim.site_id, input.userId],
          )
          collabRoleOnClaim = collabRes.rows[0]?.role ?? null
          if (!collabRoleOnClaim) {
            throw new SitesError('SLUG_TAKEN', `子域名 "${input.slug}" 已被占用，请更换名称`, 409)
          }
          if (collabRoleOnClaim !== 'editor') {
            throw new SitesError('FORBIDDEN', '你对该站点只有只读权限，无法发布更新', 403)
          }
        }
        if (claim && claim.claim_kind === 'rename_target') {
          throw new SitesError(
            'SLUG_BUSY',
            `子域名 "${input.slug}" 正在迁移重命名中，请稍后重试`,
            409,
            true,
          )
        }

        const existingRes = await client.query<RawUserSiteRow>(
          'SELECT * FROM user_sites WHERE slug = $1 FOR UPDATE',
          [input.slug],
        )
        const existingRaw = existingRes.rows[0] ?? null
        const leaseId = randomUUID()
        const leaseUntil = new Date(Date.now() + OP_LEASE_TTL_MS)
        const hasExpectedBase = Boolean(
          input.expectedSiteId ||
            input.expectedBaseRevision !== undefined ||
            input.expectedBaseContentSha256,
        )

        if (existingRaw) {
          const ownerUserId = Number(existingRaw.user_id)
          let accessRole: SiteAccessRole = 'owner'
          if (ownerUserId !== input.userId) {
            const role =
              collabRoleOnClaim ??
              (
                await client.query<{ role: SiteCollaboratorRole }>(
                  `SELECT role FROM user_site_collaborators
                   WHERE site_id = $1 AND user_id = $2
                   FOR SHARE`,
                  [existingRaw.id, input.userId],
                )
              ).rows[0]?.role ??
              null
            if (!role || Number(existingRaw.edge_revision) <= 0) {
              throw new SitesError('SLUG_TAKEN', `子域名 "${input.slug}" 已被占用，请更换名称`, 409)
            }
            if (role !== 'editor') {
              throw new SitesError('FORBIDDEN', '你对该站点只有只读权限，无法发布更新', 403)
            }
            accessRole = 'editor'
          }
          if (hasActiveLease(existingRaw)) {
            throw new SitesError(
              'SLUG_BUSY',
              `站点 "${input.slug}" 正在进行另一项发布或变更，请稍后重试`,
              409,
              true,
            )
          }
          const existing = mapRow({ ...existingRaw, access_role: accessRole })

          if (input.expectedSiteId && existing.id !== input.expectedSiteId) {
            throw new SitesError(
              'STALE_REVISION',
              `子域名 "${input.slug}" 已指向其他站点，拒绝覆盖；请确认站点状态后重新拉取`,
              409,
            )
          }

          if (accessRole !== 'owner' && input.forceOverwrite) {
            throw new SitesError('FORBIDDEN', '仅站点所有者可执行强制覆盖发布', 403)
          }

          // P0 #1: Editor may never introduce, alter, or remove __oc_server/api.mjs (which receives owner ctx.env).
          if (
            accessRole === 'editor' &&
            (input.hasServerApi || existing.hasServerApi || Boolean(existing.serverApiSha256))
          ) {
            const approvedSha = existing.serverApiSha256 ?? ''
            const incomingSha = input.hasServerApi ? (input.serverApiSha256 ?? '') : ''
            const matchesApproved = existing.hasServerApi
              ? input.hasServerApi && Boolean(approvedSha) && incomingSha === approvedSha
              : !input.hasServerApi && approvedSha === '' && incomingSha === ''
            if (!matchesApproved) {
              throw new SitesError(
                'FORBIDDEN',
                '仅站点所有者可新增、修改或移除服务端 /api/* 代码（以保护站点密钥与后端路由）；协作者可自由修改并发布前端静态文件',
                403,
              )
            }
          }

          // P1 #7: Optimistic concurrency guard preventing stale full-bundle overwrites across collaborators.
          if (existing.edgeRevision > 0) {
            const collabExistsRes = await client.query<{ has_collab: boolean }>(
              `SELECT EXISTS (
                 SELECT 1 FROM user_site_collaborators WHERE site_id = $1
               ) AS has_collab`,
              [existing.id],
            )
            const hasCollaborators = Boolean(collabExistsRes.rows[0]?.has_collab)
            const requiresBaseline =
              accessRole === 'editor' ||
              (accessRole === 'owner' && hasCollaborators && !input.forceOverwrite)
            if (
              requiresBaseline &&
              input.expectedBaseRevision === undefined &&
              !input.expectedBaseContentSha256
            ) {
              throw new SitesError(
                'STALE_REVISION',
                accessRole === 'editor'
                  ? `协同发布必须提供拉取基线版本，请先运行 oc-site pull ${input.slug} 后再发布`
                  : `站点 "${input.slug}" 已开启多人协作，请先运行 oc-site pull ${input.slug} 同步协作者最新版本后再发布（如需强制覆盖请传 --force）`,
                409,
              )
            }
            if (
              input.expectedBaseRevision !== undefined &&
              existing.edgeRevision !== input.expectedBaseRevision
            ) {
              throw new SitesError(
                'STALE_REVISION',
                `远端站点已更新至版本 rev ${existing.edgeRevision}（本地基线 rev ${input.expectedBaseRevision}），请先运行 oc-site pull ${input.slug} 合并后再发布`,
                409,
              )
            }
            if (
              input.expectedBaseContentSha256 &&
              existing.contentSha256 !== input.expectedBaseContentSha256
            ) {
              throw new SitesError(
                'STALE_REVISION',
                `远端站点内容已发生变化，请先运行 oc-site pull ${input.slug} 合并后再发布`,
                409,
              )
            }
          }

          const edgeRevision = await allocateNextEdgeRevision(client)
          const pendingOwnerApiSha =
            accessRole === 'owner' ? (input.hasServerApi ? (input.serverApiSha256 ?? '') : '') : null
          await client.query(
            `UPDATE user_sites
             SET op_lease_id = $2,
                 op_lease_until = $3,
                 op_expected_rev = edge_revision,
                 op_target_rev = $4,
                 op_kind = 'publish',
                 op_rename_to_slug = NULL,
                 op_env_digest = NULL,
                 op_server_api_sha256 = $5,
                 updated_at = NOW()
             WHERE id = $1`,
            [existing.id, leaseId, leaseUntil, edgeRevision, pendingOwnerApiSha],
          )
          await client.query(
            `INSERT INTO user_site_slug_claims (slug, site_id, claim_kind)
             VALUES ($1, $2, 'active')
             ON CONFLICT (slug) DO NOTHING`,
            [input.slug, existing.id],
          )
          return {
            siteId: existing.id,
            ownerUserId,
            accessRole,
            leaseId,
            isNewPlaceholder: existing.edgeRevision === 0,
            edgeRevision,
            baseRevision: existing.edgeRevision,
            existing: existing.edgeRevision > 0 ? existing : null,
          }
        }

        // P1 #7: Update-only semantics — never silently create a brand-new (potentially public) site when a pull baseline was supplied!
        if (hasExpectedBase) {
          throw new SitesError(
            'STALE_REVISION',
            `基线站点 "${input.slug}" 已不存在或已被重命名，拒绝自动新建站点；如需全新发布请移除本地 .oc-site-state.json 后显式发布`,
            409,
          )
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
        const initialOwnerApiSha = input.hasServerApi ? (input.serverApiSha256 ?? '') : ''
        try {
          const ins = await client.query<{ id: string }>(
            `INSERT INTO user_sites (
               slug, user_id, title, visibility, password_salt, password_hash, spa_mode,
               origin_session_id, has_server_api, op_server_api_sha256,
               edge_revision, op_lease_id, op_lease_until, op_expected_rev, op_target_rev, op_kind
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12, 0, $13, 'publish')
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
              initialOwnerApiSha,
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
            ownerUserId: input.userId,
            accessRole: 'owner',
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
      const hasServerApiSha = input.serverApiSha256 !== undefined
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
             server_api_sha256 = CASE WHEN $19::boolean THEN $20 ELSE server_api_sha256 END,
             preview_acl_version = GREATEST(preview_acl_version, $21),
             preview_acl_target_version = GREATEST(preview_acl_target_version, $21),
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
             op_server_api_sha256 = CASE WHEN op_lease_id = $3 THEN NULL ELSE op_server_api_sha256 END,
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
          hasServerApiSha,
          input.serverApiSha256 ?? '',
          Math.max(1, Math.trunc(input.previewAclVersion ?? 1)),
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
               op_env_digest = NULL,
               op_server_api_sha256 = NULL
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

    async prepareMetaUpdate(
      userId,
      slug,
      opKind = 'meta',
      pendingEnvDigest = null,
      checkCustomDomain = null,
      allowEditor = false,
    ) {
      return withTx(pool, async (client) => {
        const res = await client.query<RawUserSiteRow>(
          `SELECT s.*,
                  CASE WHEN s.user_id = $1 THEN 'owner' ELSE c.role END AS access_role
           FROM user_sites s
           LEFT JOIN user_site_collaborators c ON c.site_id = s.id AND c.user_id = $1
           WHERE s.slug = $2
             AND s.edge_revision > 0
             AND (s.user_id = $1 OR c.user_id IS NOT NULL)
           FOR UPDATE OF s`,
          [userId, slug],
        )
        const raw = res.rows[0]
        if (!raw) {
          throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
        }
        const role: SiteAccessRole = raw.access_role ?? 'owner'
        if (role !== 'owner' && !(allowEditor && role === 'editor')) {
          throw new SitesError('FORBIDDEN', '仅站点所有者或具编辑权限的协作者可执行此操作', 403)
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
      const hasPreviewAcl = input.previewAclVersion !== undefined
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
                 preview_acl_version = CASE WHEN $15::boolean THEN GREATEST(preview_acl_version, $16) ELSE preview_acl_version END,
                 preview_acl_target_version = CASE WHEN $15::boolean THEN GREATEST(preview_acl_target_version, $16) ELSE preview_acl_target_version END,
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
              hasPreviewAcl,
              input.previewAclVersion ?? 1,
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
          const claimRes = await client.query<{ slug: string }>(
            `INSERT INTO user_site_slug_claims (slug, site_id, claim_kind, updated_at)
             VALUES ($1, $2, 'active', NOW())
             ON CONFLICT (slug) DO UPDATE SET
               claim_kind = 'active',
               updated_at = NOW()
             WHERE user_site_slug_claims.site_id = EXCLUDED.site_id
             RETURNING slug`,
            [input.newSlug, input.siteId],
          )
          if (claimRes.rows.length === 0) {
            throw new SitesError('SLUG_TAKEN', `子域名 "${input.newSlug}" 已被占用，请更换名称`, 409)
          }
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

    async listCollaborators(siteId) {
      const res = await pool.query<RawSiteCollaboratorRow>(
        `SELECT c.site_id, c.user_id, u.email, u.display_name, c.role, c.created_at, c.updated_at
         FROM user_site_collaborators c
         JOIN users u ON u.id = c.user_id
         WHERE c.site_id = $1
         ORDER BY c.created_at ASC, c.user_id ASC`,
        [siteId],
      )
      return res.rows.map(mapCollaboratorRow)
    },

    async upsertCollaboratorByEmail(input) {
      return withTx(pool, async (client) => {
        const siteRes = await client.query<{ id: string; user_id: number }>(
          `SELECT id, user_id FROM user_sites
           WHERE id = $1 AND user_id = $2 AND edge_revision > 0
           FOR UPDATE`,
          [input.siteId, input.ownerUserId],
        )
        if (siteRes.rows.length === 0) {
          throw new SitesError('SITE_NOT_FOUND', '未找到对应站点', 404)
        }
        const userRes = await client.query<{
          id: number
          email: string
          display_name: string | null
          email_verified: boolean
        }>(
          `SELECT id, email, display_name, email_verified FROM users
           WHERE LOWER(email) = LOWER($1) AND status = 'active'
           LIMIT 1`,
          [input.email],
        )
        const target = userRes.rows[0]
        if (!target) {
          throw new SitesError('USER_NOT_FOUND', `未找到注册邮箱为 ${input.email} 的站内用户`, 404)
        }
        if (!target.email_verified) {
          throw new SitesError(
            'INVALID_INPUT',
            `账号 ${input.email} 尚未完成邮箱验证，无法按邮箱直接授权；请改用邀请链接让对方确认加入`,
            400,
          )
        }
        const targetUserId = Number(target.id)
        if (targetUserId === input.ownerUserId) {
          throw new SitesError('INVALID_INPUT', '不能将站点所有者自己添加为协作者', 400)
        }
        const cntRes = await client.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt FROM user_site_collaborators
           WHERE site_id = $1 AND user_id <> $2`,
          [input.siteId, targetUserId],
        )
        if ((cntRes.rows[0]?.cnt ?? 0) >= input.maxCollaborators) {
          throw new SitesError(
            'QUOTA_EXCEEDED',
            `单个站点最多添加 ${input.maxCollaborators} 名协作者`,
            429,
          )
        }
        const prevRes = await client.query<{ role: SiteCollaboratorRole }>(
          `SELECT role FROM user_site_collaborators
           WHERE site_id = $1 AND user_id = $2
           FOR UPDATE`,
          [input.siteId, targetUserId],
        )
        const prevRole = prevRes.rows[0]?.role ?? null
        const upsertRes = await client.query<{ created_at: Date; updated_at: Date; role: SiteCollaboratorRole }>(
          `INSERT INTO user_site_collaborators (site_id, user_id, role, invited_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NOW(), NOW())
           ON CONFLICT (site_id, user_id) DO UPDATE SET
             role = EXCLUDED.role,
             updated_at = NOW()
           RETURNING role, created_at, updated_at`,
          [input.siteId, targetUserId, input.role, input.ownerUserId],
        )
        if (prevRole === 'editor' && input.role === 'viewer') {
          await client.query(
            `UPDATE user_sites
             SET preview_acl_target_version = GREATEST(preview_acl_target_version, preview_acl_version) + 1,
                 updated_at = NOW()
             WHERE id = $1`,
            [input.siteId],
          )
        }
        const row = upsertRes.rows[0]!
        return mapCollaboratorRow({
          site_id: input.siteId,
          user_id: targetUserId,
          email: target.email,
          display_name: target.display_name,
          role: row.role,
          created_at: row.created_at,
          updated_at: row.updated_at,
        })
      })
    },

    async updateCollaboratorRole(input) {
      return withTx(pool, async (client) => {
        const siteRes = await client.query<{ id: string }>(
          'SELECT id FROM user_sites WHERE id = $1 AND user_id = $2 AND edge_revision > 0 FOR UPDATE',
          [input.siteId, input.ownerUserId],
        )
        if (siteRes.rows.length === 0) {
          throw new SitesError('SITE_NOT_FOUND', '未找到对应站点', 404)
        }
        const prevRes = await client.query<{ role: SiteCollaboratorRole }>(
          `SELECT role FROM user_site_collaborators
           WHERE site_id = $1 AND user_id = $2
           FOR UPDATE`,
          [input.siteId, input.targetUserId],
        )
        const prevRole = prevRes.rows[0]?.role ?? null
        if (!prevRole) {
          throw new SitesError('USER_NOT_FOUND', '未找到该协作者', 404)
        }
        const updRes = await client.query<RawSiteCollaboratorRow>(
          `UPDATE user_site_collaborators c
           SET role = $3, updated_at = NOW()
           FROM users u
           WHERE c.site_id = $1 AND c.user_id = $2 AND u.id = c.user_id
           RETURNING c.site_id, c.user_id, u.email, u.display_name, c.role, c.created_at, c.updated_at`,
          [input.siteId, input.targetUserId, input.role],
        )
        if (!updRes.rows[0]) {
          throw new SitesError('USER_NOT_FOUND', '未找到该协作者', 404)
        }
        if (prevRole === 'editor' && input.role === 'viewer') {
          await client.query(
            `UPDATE user_sites
             SET preview_acl_target_version = GREATEST(preview_acl_target_version, preview_acl_version) + 1,
                 updated_at = NOW()
             WHERE id = $1`,
            [input.siteId],
          )
        }
        return mapCollaboratorRow(updRes.rows[0])
      })
    },

    async removeCollaborator(input) {
      return withTx(pool, async (client) => {
        const siteRes = await client.query<{ id: string }>(
          'SELECT id FROM user_sites WHERE id = $1 AND user_id = $2 AND edge_revision > 0 FOR UPDATE',
          [input.siteId, input.ownerUserId],
        )
        if (siteRes.rows.length === 0) {
          return false
        }
        const res = await client.query(
          `DELETE FROM user_site_collaborators
           WHERE site_id = $1 AND user_id = $2`,
          [input.siteId, input.targetUserId],
        )
        const removed = (res.rowCount ?? 0) > 0
        if (removed) {
          await client.query(
            `UPDATE user_sites
             SET preview_acl_target_version = GREATEST(preview_acl_target_version, preview_acl_version) + 1,
                 updated_at = NOW()
             WHERE id = $1`,
            [input.siteId],
          )
        }
        return removed
      })
    },

    async leaveSiteCollaborator(siteId, actorUserId) {
      return withTx(pool, async (client) => {
        const siteRes = await client.query<{ id: string }>(
          'SELECT id FROM user_sites WHERE id = $1 AND edge_revision > 0 FOR UPDATE',
          [siteId],
        )
        if (siteRes.rows.length === 0) {
          return false
        }
        const res = await client.query(
          `DELETE FROM user_site_collaborators
           WHERE site_id = $1 AND user_id = $2`,
          [siteId, actorUserId],
        )
        const left = (res.rowCount ?? 0) > 0
        if (left) {
          await client.query(
            `UPDATE user_sites
             SET preview_acl_target_version = GREATEST(preview_acl_target_version, preview_acl_version) + 1,
                 updated_at = NOW()
             WHERE id = $1`,
            [siteId],
          )
        }
        return left
      })
    },

    async listActiveInvites(siteId, ownerUserId) {
      const res = await pool.query<RawSiteInviteRow>(
        `SELECT i.id, i.site_id, i.role, i.max_uses, i.use_count, i.expires_at, i.revoked_at, i.created_at
         FROM user_site_invites i
         JOIN user_sites s ON s.id = i.site_id
         WHERE i.site_id = $1
           AND s.user_id = $2
           AND i.revoked_at IS NULL
           AND (i.expires_at IS NULL OR i.expires_at > NOW())
           AND (i.max_uses IS NULL OR i.use_count < i.max_uses)
         ORDER BY i.created_at DESC`,
        [siteId, ownerUserId],
      )
      return res.rows.map(mapInviteRow)
    },

    async createInvite(input) {
      return withTx(pool, async (client) => {
        const siteRes = await client.query<{ id: string }>(
          `SELECT id FROM user_sites
           WHERE id = $1 AND user_id = $2 AND edge_revision > 0
           FOR UPDATE`,
          [input.siteId, input.ownerUserId],
        )
        if (siteRes.rows.length === 0) {
          throw new SitesError('SITE_NOT_FOUND', '未找到对应站点', 404)
        }
        const cntRes = await client.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt FROM user_site_invites
           WHERE site_id = $1
             AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > NOW())
             AND (max_uses IS NULL OR use_count < max_uses)`,
          [input.siteId],
        )
        if ((cntRes.rows[0]?.cnt ?? 0) >= input.maxActiveInvites) {
          throw new SitesError(
            'QUOTA_EXCEEDED',
            `单个站点最多同时保留 ${input.maxActiveInvites} 条有效邀请链接，请先撤销旧链接`,
            429,
          )
        }
        const ins = await client.query<RawSiteInviteRow>(
          `INSERT INTO user_site_invites (
             site_id, token_hash, role, created_by, max_uses, expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, site_id, role, max_uses, use_count, expires_at, revoked_at, created_at`,
          [
            input.siteId,
            input.tokenHash,
            input.role,
            input.ownerUserId,
            input.maxUses,
            input.expiresAt,
          ],
        )
        return mapInviteRow(ins.rows[0]!)
      })
    },

    async revokeInvite(input) {
      const res = await pool.query(
        `UPDATE user_site_invites i
         SET revoked_at = NOW()
         FROM user_sites s
         WHERE i.site_id = s.id
           AND i.site_id = $1
           AND s.user_id = $2
           AND i.id = $3
           AND i.revoked_at IS NULL`,
        [input.siteId, input.ownerUserId, input.inviteId],
      )
      return (res.rowCount ?? 0) > 0
    },

    async lookupInviteByTokenHash(tokenHash, actorUserId) {
      const invRes = await pool.query<RawSiteInviteRow>(
        `SELECT id, site_id, role, max_uses, use_count, expires_at, revoked_at, created_at
         FROM user_site_invites
         WHERE token_hash = $1`,
        [tokenHash],
      )
      const inv = invRes.rows[0]
      if (!inv || inv.revoked_at) return null
      if (inv.expires_at && new Date(inv.expires_at).getTime() <= Date.now()) return null
      if (inv.max_uses !== null && Number(inv.use_count) >= Number(inv.max_uses)) return null

      const siteRes = await pool.query<RawUserSiteRow>(
        `SELECT s.*,
                u.email AS owner_email,
                u.display_name AS owner_display_name,
                CASE
                  WHEN s.user_id = $2 THEN 'owner'
                  ELSE c.role
                END AS access_role,
                (SELECT COUNT(*)::int FROM user_site_collaborators cc WHERE cc.site_id = s.id) AS collaborator_count
         FROM user_sites s
         LEFT JOIN users u ON u.id = s.user_id
         LEFT JOIN user_site_collaborators c ON c.site_id = s.id AND c.user_id = $2
         WHERE s.id = $1 AND s.edge_revision > 0`,
        [inv.site_id, actorUserId],
      )
      const siteRaw = siteRes.rows[0]
      if (!siteRaw) return null
      return {
        invite: mapInviteRow(inv),
        site: mapRow(siteRaw),
        ownerEmail: siteRaw.owner_email ?? null,
        ownerDisplayName: siteRaw.owner_display_name ?? null,
        alreadyRole: siteRaw.access_role ?? null,
      }
    },

    async acceptInviteByTokenHash(tokenHash, actorUserId, maxCollaborators) {
      return withTx(pool, async (client) => {
        const invRes = await client.query<RawSiteInviteRow>(
          `SELECT id, site_id, role, max_uses, use_count, expires_at, revoked_at, created_at
           FROM user_site_invites
           WHERE token_hash = $1
           FOR UPDATE`,
          [tokenHash],
        )
        const inv = invRes.rows[0]
        if (!inv || inv.revoked_at) {
          throw new SitesError('INVITE_INVALID', '邀请链接无效或已被撤销', 404)
        }
        if (inv.expires_at && new Date(inv.expires_at).getTime() <= Date.now()) {
          throw new SitesError('INVITE_INVALID', '邀请链接已过期', 410)
        }
        if (inv.max_uses !== null && Number(inv.use_count) >= Number(inv.max_uses)) {
          throw new SitesError('INVITE_INVALID', '邀请链接使用次数已达上限', 410)
        }

        const actorRes = await client.query<{ id: number }>(
          `SELECT id FROM users WHERE id = $1 AND status = 'active'`,
          [actorUserId],
        )
        if (actorRes.rows.length === 0) {
          throw new SitesError('USER_NOT_FOUND', '当前用户账号状态异常', 403)
        }

        const siteRes = await client.query<RawUserSiteRow>(
          `SELECT s.*,
                  u.email AS owner_email,
                  u.display_name AS owner_display_name,
                  (SELECT COUNT(*)::int FROM user_site_collaborators cc WHERE cc.site_id = s.id) AS collaborator_count
           FROM user_sites s
           LEFT JOIN users u ON u.id = s.user_id
           WHERE s.id = $1 AND s.edge_revision > 0
           FOR UPDATE OF s`,
          [inv.site_id],
        )
        const siteRaw = siteRes.rows[0]
        if (!siteRaw) {
          throw new SitesError('SITE_NOT_FOUND', '对应站点已不存在', 404)
        }
        const ownerUserId = Number(siteRaw.user_id)
        if (ownerUserId === actorUserId) {
          return {
            site: mapRow({ ...siteRaw, access_role: 'owner' }),
            role: 'owner' as SiteAccessRole,
            alreadyMember: true,
          }
        }

        const existingRes = await client.query<{ role: SiteCollaboratorRole }>(
          `SELECT role FROM user_site_collaborators
           WHERE site_id = $1 AND user_id = $2
           FOR UPDATE`,
          [siteRaw.id, actorUserId],
        )
        const existingRole = existingRes.rows[0]?.role ?? null
        if (existingRole === 'editor' || (existingRole === 'viewer' && inv.role === 'viewer')) {
          return {
            site: mapRow({ ...siteRaw, access_role: existingRole }),
            role: existingRole,
            alreadyMember: true,
          }
        }

        if (!existingRole) {
          const cntRes = await client.query<{ cnt: number }>(
            'SELECT COUNT(*)::int AS cnt FROM user_site_collaborators WHERE site_id = $1',
            [siteRaw.id],
          )
          if ((cntRes.rows[0]?.cnt ?? 0) >= maxCollaborators) {
            throw new SitesError(
              'QUOTA_EXCEEDED',
              `该站点协作者人数已达上限（最多 ${maxCollaborators} 人）`,
              429,
            )
          }
        }

        await client.query(
          `INSERT INTO user_site_collaborators (site_id, user_id, role, invited_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NOW(), NOW())
           ON CONFLICT (site_id, user_id) DO UPDATE SET
             role = EXCLUDED.role,
             updated_at = NOW()`,
          [siteRaw.id, actorUserId, inv.role, ownerUserId],
        )
        await client.query(
          'UPDATE user_site_invites SET use_count = use_count + 1 WHERE id = $1',
          [inv.id],
        )
        const nextCount = Number(siteRaw.collaborator_count ?? 0) + (existingRole ? 0 : 1)
        return {
          site: mapRow({
            ...siteRaw,
            access_role: inv.role,
            collaborator_count: nextCount,
          }),
          role: inv.role,
          alreadyMember: false,
        }
      })
    },
  }
}
