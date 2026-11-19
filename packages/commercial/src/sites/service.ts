import { randomBytes } from 'node:crypto'
import dns from 'node:dns'
import type { SitesEdgeClient } from './edgeClient.js'
import {
  computeEnvMapDigest,
  decryptSiteSecretFromDb,
  deriveSiteDbEnvKey,
  encryptSiteSecretForDb,
  sealEdgeEnvMap,
} from './envCrypto.js'
import type {
  SitesRepo,
  StoredSiteCollaboratorRow,
  StoredSiteEnvVarRow,
  StoredSiteInviteRow,
} from './repo.js'
import {
  DEFAULT_SITE_MAX_PER_USER,
  DEFAULT_SITE_MAX_TOTAL_BYTES,
  type EdgeMetaEnvelope,
  SITE_MAX_ACTIVE_INVITES,
  SITE_MAX_COLLABORATORS,
  SITE_MAX_ENV_TOTAL_BYTES,
  SITE_MAX_ENV_VALUE_BYTES,
  SITE_MAX_ENV_VARS,
  SITE_PREVIEW_BOOT_TTL_SEC,
  SITE_PREVIEW_TTL_SEC,
  type SiteAccessRole,
  type SiteAnalyticsResponse,
  type SiteCollaboratorDto,
  type SiteCollaboratorRole,
  type SiteDbInspectResponse,
  type SiteDbQueryResponse,
  type SiteEnvVarDto,
  type SiteInviteDto,
  type SiteInvitePreviewDto,
  type SitePreviewSessionDto,
  type SiteVisibility,
  SitesError,
  type UserSiteDto,
  type UserSiteRow,
  customDomainTxtValueFor,
  decodeSiteBundle,
  generateRandomSiteSlug,
  hashSiteInviteToken,
  hashSitePassword,
  normalizePreviewParentOrigin,
  normalizeSiteTitle,
  parseSiteCollaboratorRole,
  parseSiteVisibility,
  signSitePreviewToken,
  toUserSiteDto,
  validateCustomDomain,
  validateEnvVarKey,
  validateSitePasswordInput,
  validateSiteSlug,
} from './types.js'

export interface SitesServiceConfig {
  enabled: boolean
  baseDomain: string
  maxPerUser?: number
  maxSiteBytes?: number
  edgeSecret?: string
  repo?: SitesRepo
  edge?: SitesEdgeClient
  resolveTxt?: (hostname: string) => Promise<string[][]>
}

export interface PublishSiteInput {
  slug?: string
  title?: string
  visibility?: SiteVisibility
  password?: string
  spaMode?: boolean
  originSessionId?: string | null
  expectedSiteId?: string
  expectedBaseRevision?: number
  expectedBaseContentSha256?: string
  forceOverwrite?: boolean
  gzippedBundle: Buffer
}

export interface UpdateSiteInput {
  title?: string
  visibility?: SiteVisibility
  password?: string
  spaMode?: boolean
  customDomain?: string | null
}

export interface SetSiteEnvVarInput {
  key: string
  value: string
  isSecret?: boolean
}

export interface SitesSummaryResponse {
  enabled: boolean
  baseDomain: string
  maxPerUser: number
  maxSiteBytes: number
  sites: UserSiteDto[]
}

async function defaultResolveTxtWithTimeout(hostname: string, timeoutMs = 5_000): Promise<string[][]> {
  return await new Promise<string[][]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DNS_TIMEOUT')), timeoutMs)
    dns.promises.resolveTxt(hostname).then(
      (rows) => {
        clearTimeout(timer)
        resolve(rows)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

export class SitesService {
  readonly enabled: boolean
  readonly baseDomain: string
  readonly maxPerUser: number
  readonly maxSiteBytes: number
  private readonly edgeSecret: string
  private readonly dbEnvKey: Buffer | null
  private readonly repo?: SitesRepo
  private readonly edge?: SitesEdgeClient
  private readonly resolveTxt: (hostname: string) => Promise<string[][]>
  private readonly slugLocks = new Map<string, Promise<void>>()

  constructor(cfg: SitesServiceConfig) {
    this.enabled = cfg.enabled
    this.baseDomain = cfg.baseDomain
    this.maxPerUser = cfg.maxPerUser ?? DEFAULT_SITE_MAX_PER_USER
    this.maxSiteBytes = cfg.maxSiteBytes ?? DEFAULT_SITE_MAX_TOTAL_BYTES
    this.edgeSecret = cfg.edgeSecret ?? ''
    this.dbEnvKey = this.edgeSecret ? deriveSiteDbEnvKey(this.edgeSecret) : null
    this.repo = cfg.repo
    this.edge = cfg.edge
    this.resolveTxt = cfg.resolveTxt ?? defaultResolveTxtWithTimeout
  }

  private async withSlugLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.slugLocks.get(slug) ?? Promise.resolve()
    let release!: () => void
    const cur = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = prev.then(
      () => cur,
      () => cur,
    )
    this.slugLocks.set(slug, tail)
    await prev.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
      if (this.slugLocks.get(slug) === tail) {
        this.slugLocks.delete(slug)
      }
    }
  }

  private async withTwoSlugLocks<T>(slugA: string, slugB: string, fn: () => Promise<T>): Promise<T> {
    if (slugA === slugB) return this.withSlugLock(slugA, fn)
    const [first, second] = slugA < slugB ? [slugA, slugB] : [slugB, slugA]
    return this.withSlugLock(first, () => this.withSlugLock(second, fn))
  }

  private requireReady(): { repo: SitesRepo; edge: SitesEdgeClient } {
    if (!this.enabled || !this.repo || !this.edge) {
      throw new SitesError('SITES_DISABLED', '持久化站点托管功能尚未开启', 503)
    }
    return { repo: this.repo, edge: this.edge }
  }

  private requireEnvSecrets(): { edgeSecret: string; dbEnvKey: Buffer } {
    if (!this.edgeSecret || !this.dbEnvKey) {
      throw new SitesError('INTERNAL', '未配置站点环境变量加密密钥', 500)
    }
    return { edgeSecret: this.edgeSecret, dbEnvKey: this.dbEnvKey }
  }

  private toEnvDtos(rows: StoredSiteEnvVarRow[]): SiteEnvVarDto[] {
    return rows.map((r) => ({
      key: r.key,
      value: r.isSecret ? null : (r.plainValue ?? ''),
      isSecret: r.isSecret,
      hasValue: true,
      updatedAt: r.updatedAt.toISOString(),
    }))
  }

  private toCollaboratorDtos(rows: StoredSiteCollaboratorRow[]): SiteCollaboratorDto[] {
    return rows.map((r) => ({
      userId: r.userId,
      email: r.email,
      displayName: r.displayName,
      role: r.role,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }))
  }

  private toInviteDtos(rows: StoredSiteInviteRow[]): SiteInviteDto[] {
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      maxUses: r.maxUses,
      useCount: r.useCount,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }))
  }

  private assertOwner(row: UserSiteRow, actionLabel: string): void {
    if ((row.accessRole ?? 'owner') !== 'owner') {
      throw new SitesError('FORBIDDEN', `仅站点所有者可${actionLabel}`, 403)
    }
  }

  private assertCanEdit(row: UserSiteRow, actionLabel: string): void {
    const role = row.accessRole ?? 'owner'
    if (role !== 'owner' && role !== 'editor') {
      throw new SitesError('FORBIDDEN', `仅站点所有者或协作者可${actionLabel}`, 403)
    }
  }

  private buildEdgeEnvPayloadFromRows(
    userId: number,
    siteId: string,
    slug: string,
    rows: StoredSiteEnvVarRow[],
  ): { digest: string; sealedB64: string; totalBytes: number } {
    if (rows.length === 0) {
      return { digest: '', sealedB64: '', totalBytes: 0 }
    }
    const { edgeSecret, dbEnvKey } = this.requireEnvSecrets()
    const envMap: Record<string, string> = {}
    let totalBytes = 0
    for (const row of rows) {
      const val = row.isSecret
        ? (() => {
            if (!row.ciphertext || !row.nonce) {
              throw new SitesError('INTERNAL', `站点密钥 ${row.key} 数据损坏`, 500)
            }
            return decryptSiteSecretFromDb({
              key: dbEnvKey,
              userId,
              siteId,
              envKey: row.key,
              ciphertext: row.ciphertext,
              nonce: row.nonce,
            })
          })()
        : (row.plainValue ?? '')
      totalBytes += Buffer.byteLength(row.key, 'utf8') + Buffer.byteLength(val, 'utf8')
      envMap[row.key] = val
    }
    if (totalBytes > SITE_MAX_ENV_TOTAL_BYTES) {
      throw new SitesError(
        'QUOTA_EXCEEDED',
        `站点环境变量总大小超过 ${SITE_MAX_ENV_TOTAL_BYTES} 字节上限`,
        413,
      )
    }
    return {
      digest: computeEnvMapDigest(envMap, siteId, edgeSecret),
      sealedB64: sealEdgeEnvMap(edgeSecret, slug, envMap),
      totalBytes,
    }
  }

  private async buildEdgeEnvPayload(
    repo: SitesRepo,
    userId: number,
    siteId: string,
    slug: string,
  ): Promise<{ digest: string; sealedB64: string; totalBytes: number }> {
    const rows = await repo.listSiteEnvRows(siteId, userId)
    return this.buildEdgeEnvPayloadFromRows(userId, siteId, slug, rows)
  }

  private async restoreEnvRow(
    repo: SitesRepo,
    siteId: string,
    userId: number,
    key: string,
    prevRow: StoredSiteEnvVarRow | undefined,
  ): Promise<void> {
    if (prevRow) {
      await repo
        .upsertSiteEnvRow({
          siteId,
          userId,
          key: prevRow.key,
          isSecret: prevRow.isSecret,
          plainValue: prevRow.plainValue,
          ciphertext: prevRow.ciphertext,
          nonce: prevRow.nonce,
          maxEnvVars: SITE_MAX_ENV_VARS,
        })
        .catch(() => {})
    } else {
      await repo.deleteSiteEnvRow(siteId, userId, key).catch(() => {})
    }
  }

  private async reconcilePendingByUser(userId: number): Promise<void> {
    if (!this.enabled || !this.repo || !this.edge) return
    const { repo, edge } = { repo: this.repo, edge: this.edge }
    const pending = await repo.listUnleasedPendingByUser(userId)
    if (pending.length === 0) return
    for (const cand of pending) {
      const ownerId = cand.userId
      if (cand.opKind === 'rename' && cand.opRenameToSlug) {
        const targetSlug = cand.opRenameToSlug
        await this.withTwoSlugLocks(cand.slug, targetSlug, async () => {
          const claimed = await repo.tryClaimReconcileLease(cand.id, ownerId)
          if (!claimed) return
          try {
            const newStatus = await edge.getSiteStatus({ slug: targetSlug, siteId: claimed.row.id })
            const oldStatus = await edge.getSiteStatus({ slug: claimed.row.slug, siteId: claimed.row.id })
            const newMatchesId = newStatus.meta?.siteId === claimed.row.id
            const oldMatchesId =
              !oldStatus.meta?.siteId || oldStatus.meta.siteId === claimed.row.id
            const oldRenamedAway =
              !oldStatus.exists ||
              oldStatus.tombstone?.op === 'rename' ||
              (oldStatus.retired?.siteId === claimed.row.id && oldStatus.retired.op === 'rename')

            if (
              newStatus.exists &&
              newMatchesId &&
              newStatus.revision >= claimed.row.edgeRevision &&
              oldRenamedAway
            ) {
              let finalRev = newStatus.revision
              const envBundle = await this.buildEdgeEnvPayload(repo, ownerId, claimed.row.id, targetSlug)
              if (
                newStatus.revision === claimed.row.edgeRevision ||
                (newStatus.meta?.envDigest ?? '') !== envBundle.digest ||
                (newStatus.meta?.previewAclVersion ?? 1) <
                  Math.max(claimed.row.previewAclVersion ?? 1, claimed.row.previewAclTargetVersion ?? 1)
              ) {
                if (newStatus.meta) {
                  const targetAcl = Math.max(
                    claimed.row.previewAclVersion ?? 1,
                    claimed.row.previewAclTargetVersion ?? 1,
                    newStatus.meta.previewAclVersion ?? 1,
                  )
                  await edge.updateMeta({
                    slug: targetSlug,
                    revision: claimed.row.edgeRevision + 1,
                    meta: {
                      siteId: claimed.row.id,
                      title: newStatus.meta.title,
                      visibility: newStatus.meta.visibility,
                      passwordSalt: newStatus.meta.passwordSalt,
                      passwordHash: newStatus.meta.passwordHash,
                      spaMode: newStatus.meta.spaMode,
                      customDomain: newStatus.meta.customDomain ?? null,
                      hasServerApi: Boolean(newStatus.meta.hasServerApi),
                      envDigest: envBundle.digest,
                      contentSha256: newStatus.meta.contentSha256,
                      previewAclVersion: targetAcl,
                      expectedBaseRevision: newStatus.revision,
                    },
                    encryptedEnvB64: envBundle.sealedB64,
                  })
                  finalRev = claimed.row.edgeRevision + 1
                }
              }
              await repo.commitRename({
                siteId: claimed.row.id,
                userId: ownerId,
                leaseId: claimed.leaseId,
                newSlug: targetSlug,
                edgeRevision: finalRev,
              })
            } else if (
              oldStatus.exists &&
              oldMatchesId &&
              oldStatus.revision === claimed.row.edgeRevision &&
              !newStatus.exists
            ) {
              await repo.abortRenameReservation(
                claimed.row.id,
                ownerId,
                claimed.leaseId,
                targetSlug,
                true,
              )
            } else {
              await repo.releaseLease(claimed.row.id, ownerId, claimed.leaseId, false)
            }
          } catch {
            await repo.releaseLease(claimed.row.id, ownerId, claimed.leaseId, false).catch(() => {})
          }
        })
        continue
      }

      await this.withSlugLock(cand.slug, async () => {
        const claimed = await repo.tryClaimReconcileLease(cand.id, ownerId)
        if (!claimed) return
        try {
          const status = await edge.getSiteStatus({ slug: claimed.row.slug, siteId: claimed.row.id })

          if (claimed.row.opKind === 'delete') {
            const tombMatchesId = status.tombstone?.siteId === claimed.row.id
            const retiredDeleteMatches =
              status.retired?.siteId === claimed.row.id &&
              status.retired.op === 'delete' &&
              status.retired.revision > claimed.row.edgeRevision
            if (!status.exists && status.tombstoneRevision > claimed.row.edgeRevision && tombMatchesId) {
              await repo.commitDelete(claimed.row.id, ownerId, claimed.leaseId, status.tombstoneRevision)
            } else if (retiredDeleteMatches && status.retired) {
              await repo.commitDelete(claimed.row.id, ownerId, claimed.leaseId, status.retired.revision)
            } else if (status.exists && status.meta?.siteId === claimed.row.id) {
              await repo.releaseLease(claimed.row.id, ownerId, claimed.leaseId, true)
            } else {
              await repo.releaseLease(claimed.row.id, ownerId, claimed.leaseId, false)
            }
            return
          }

          if (status.exists && status.revision > 0 && status.meta) {
            if (
              claimed.row.edgeRevision === 0
                ? status.meta.siteId !== claimed.row.id
                : Boolean(status.meta.siteId && status.meta.siteId !== claimed.row.id)
            ) {
              if (claimed.row.edgeRevision === 0) {
                await repo.abortPublishPlaceholder(claimed.row.id, ownerId, claimed.leaseId)
              } else {
                await repo.releaseLease(claimed.row.id, ownerId, claimed.leaseId, false)
              }
              return
            }

            const envBundle = await this.buildEdgeEnvPayload(
              repo,
              ownerId,
              claimed.row.id,
              claimed.row.slug,
            )
            let effectiveDigest = status.meta.envDigest ?? ''

            if ((claimed.row.opKind === 'env' || effectiveDigest !== envBundle.digest) && edge.syncEnv) {
              await edge.syncEnv({
                slug: claimed.row.slug,
                siteId: claimed.row.id,
                revision: status.revision,
                expectedBaseRevision: status.revision,
                envDigest: envBundle.digest,
                encryptedEnvB64: envBundle.sealedB64,
              })
              effectiveDigest = envBundle.digest
            }

            const desiredAcl = Math.max(
              1,
              claimed.row.previewAclVersion ?? 1,
              claimed.row.previewAclTargetVersion ?? 1,
              status.meta.previewAclVersion ?? 1,
            )
            let effectiveRev = status.revision
            if ((status.meta.previewAclVersion ?? 1) < desiredAcl) {
              const bumpedRev = status.revision + 1
              await edge.updateMeta({
                slug: claimed.row.slug,
                revision: bumpedRev,
                meta: {
                  siteId: claimed.row.id,
                  title: status.meta.title,
                  visibility: status.meta.visibility,
                  passwordSalt: status.meta.passwordSalt,
                  passwordHash: status.meta.passwordHash,
                  spaMode: status.meta.spaMode,
                  customDomain: status.meta.customDomain ?? null,
                  hasServerApi: Boolean(status.meta.hasServerApi),
                  envDigest: effectiveDigest,
                  contentSha256: status.meta.contentSha256,
                  previewAclVersion: desiredAcl,
                  expectedBaseRevision: status.revision,
                },
                encryptedEnvB64: envBundle.sealedB64,
              })
              effectiveRev = bumpedRev
            }

            if (
              effectiveRev > claimed.row.edgeRevision ||
              effectiveDigest !== claimed.row.envDigest ||
              claimed.row.opKind ||
              desiredAcl > (claimed.row.previewAclVersion ?? 1)
            ) {
              const shouldSyncDomain =
                status.meta.customDomain !== null || claimed.row.customDomainVerified
              const verifiedMatch =
                claimed.row.customDomainVerified &&
                claimed.row.customDomain !== null &&
                claimed.row.customDomain === status.meta.customDomain
              await repo.reconcileFromEdge({
                siteId: claimed.row.id,
                userId: ownerId,
                leaseId: claimed.leaseId,
                title: status.meta.title,
                visibility: status.meta.visibility,
                passwordSalt: status.meta.passwordSalt,
                passwordHash: status.meta.passwordHash,
                spaMode: status.meta.spaMode,
                ...(shouldSyncDomain
                  ? {
                      customDomain: status.meta.customDomain ?? null,
                      customDomainVerified: verifiedMatch,
                    }
                  : {}),
                originSessionId: null,
                hasServerApi: Boolean(status.meta.hasServerApi),
                previewAclVersion: desiredAcl,
                envDigest: effectiveDigest,
                fileCount: status.meta.fileCount,
                sizeBytes: status.meta.sizeBytes,
                contentSha256: status.meta.contentSha256,
                edgeRevision: effectiveRev,
              })
            } else {
              await repo.releaseLease(claimed.row.id, ownerId, claimed.leaseId, true)
            }
          } else if (claimed.row.edgeRevision === 0) {
            await repo.abortPublishPlaceholder(claimed.row.id, ownerId, claimed.leaseId)
          } else {
            // Never delete a PG row on non-delete ops (e.g. an intermediate crash or rename tombstone).
            await repo.releaseLease(claimed.row.id, ownerId, claimed.leaseId, true)
          }
        } catch {
          await repo.releaseLease(claimed.row.id, ownerId, claimed.leaseId, false).catch(() => {})
        }
      })
    }
  }

  async listSummary(userId: number): Promise<SitesSummaryResponse> {
    if (!this.enabled || !this.repo) {
      return {
        enabled: false,
        baseDomain: this.baseDomain,
        maxPerUser: this.maxPerUser,
        maxSiteBytes: this.maxSiteBytes,
        sites: [],
      }
    }
    await this.reconcilePendingByUser(userId)
    const rows = await this.repo.listByUser(userId)
    return {
      enabled: true,
      baseDomain: this.baseDomain,
      maxPerUser: this.maxPerUser,
      maxSiteBytes: this.maxSiteBytes,
      sites: rows.map((r) => toUserSiteDto(r, this.baseDomain)),
    }
  }

  async getSite(userId: number, rawSlug: string): Promise<UserSiteDto> {
    const { repo } = this.requireReady()
    const slug = validateSiteSlug(rawSlug)
    await this.reconcilePendingByUser(userId)
    const row = await repo.getByUserAndSlug(userId, slug)
    if (!row) {
      throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
    }
    return toUserSiteDto(row, this.baseDomain)
  }

  async publishSite(userId: number, input: PublishSiteInput): Promise<UserSiteDto> {
    const { repo, edge } = this.requireReady()
    const decoded = decodeSiteBundle(input.gzippedBundle, this.maxSiteBytes)

    const requestedVisibility =
      input.visibility !== undefined ? parseSiteVisibility(input.visibility) : undefined
    if (input.password !== undefined) {
      validateSitePasswordInput(input.password)
    }

    const explicitSlug =
      input.slug !== undefined && input.slug.trim() !== '' ? validateSiteSlug(input.slug) : null

    await this.reconcilePendingByUser(userId)

    const attemptPublish = (slug: string): Promise<UserSiteRow> =>
      this.withSlugLock(slug, async () => {
        const preHint = await repo.getByUserAndSlug(userId, slug)
        if (preHint) {
          this.assertCanEdit(preHint, '发布更新')
          if ((preHint.accessRole ?? 'owner') !== 'owner') {
            if (input.visibility !== undefined || input.password !== undefined) {
              throw new SitesError('FORBIDDEN', '协作者不能修改站点访问可见性或访问口令', 403)
            }
          }
        }
        const hintVisibility: SiteVisibility = requestedVisibility ?? preHint?.visibility ?? 'public'
        const hintTitle =
          input.title !== undefined
            ? normalizeSiteTitle(input.title, slug)
            : preHint?.title || slug
        const hintSpaMode =
          input.spaMode !== undefined ? Boolean(input.spaMode) : (preHint?.spaMode ?? true)

        let preSalt: string | null = null
        let preHash: string | null = null
        if (hintVisibility === 'password') {
          if (input.password !== undefined) {
            const hashed = hashSitePassword(input.password)
            preSalt = hashed.salt
            preHash = hashed.hash
          } else if (
            preHint?.visibility === 'password' &&
            preHint.passwordSalt &&
            preHint.passwordHash
          ) {
            preSalt = preHint.passwordSalt
            preHash = preHint.passwordHash
          } else {
            throw new SitesError('PASSWORD_REQUIRED', '口令保护模式需要设置 4–128 位访问口令', 400)
          }
        }

        const reservation = await repo.beginPublishReservation({
          userId,
          slug,
          title: hintTitle,
          visibility: hintVisibility,
          passwordSalt: preSalt,
          passwordHash: preHash,
          spaMode: hintSpaMode,
          originSessionId: input.originSessionId ?? null,
          hasServerApi: decoded.hasServerApi,
          serverApiSha256: decoded.serverApiSha256,
          ...(input.expectedSiteId !== undefined ? { expectedSiteId: input.expectedSiteId } : {}),
          ...(input.expectedBaseRevision !== undefined
            ? { expectedBaseRevision: input.expectedBaseRevision }
            : {}),
          ...(input.expectedBaseContentSha256 !== undefined
            ? { expectedBaseContentSha256: input.expectedBaseContentSha256 }
            : {}),
          ...(input.forceOverwrite ? { forceOverwrite: true } : {}),
          maxPerUser: this.maxPerUser,
        })

        const ownerId = reservation.ownerUserId ?? userId
        const accessRole: SiteAccessRole = reservation.accessRole ?? 'owner'
        const lockedExisting = reservation.existing

        if (accessRole !== 'owner' && (input.visibility !== undefined || input.password !== undefined)) {
          await repo.releaseLease(reservation.siteId, ownerId, reservation.leaseId, true).catch(() => {})
          throw new SitesError('FORBIDDEN', '协作者不能修改站点访问可见性或访问口令', 403)
        }

        // B6 rollback safety: verify the live __oc_server/api.mjs bytes on Edge still match the
        // owner-approved PG serverApiSha256 so an out-of-band/pre-0345 write can never leave stale approvals active.
        if (
          accessRole === 'editor' &&
          (decoded.hasServerApi || lockedExisting?.hasServerApi || Boolean(lockedExisting?.serverApiSha256))
        ) {
          const releaseOnVerifyFail = async () => {
            if (reservation.isNewPlaceholder) {
              await repo.abortPublishPlaceholder(reservation.siteId, ownerId, reservation.leaseId).catch(() => {})
            } else {
              await repo.releaseLease(reservation.siteId, ownerId, reservation.leaseId, true).catch(() => {})
            }
          }
          if (!edge.pullBundle) {
            await releaseOnVerifyFail()
            throw new SitesError('EDGE_UNAVAILABLE', '当前边缘节点不支持校验线上服务端代码摘要', 502, true)
          }
          let liveDecoded: ReturnType<typeof decodeSiteBundle>
          try {
            const liveBuf = await edge.pullBundle({
              slug,
              siteId: reservation.siteId,
              expectedRevision: reservation.baseRevision,
            })
            liveDecoded = decodeSiteBundle(liveBuf, this.maxSiteBytes)
          } catch (err) {
            await releaseOnVerifyFail()
            throw err
          }
          const pgHasApi = Boolean(lockedExisting?.hasServerApi)
          const pgApprovedSha = lockedExisting?.serverApiSha256 ?? ''
          if (
            liveDecoded.hasServerApi !== pgHasApi ||
            liveDecoded.serverApiSha256 !== pgApprovedSha ||
            liveDecoded.hasServerApi !== decoded.hasServerApi ||
            liveDecoded.serverApiSha256 !== decoded.serverApiSha256
          ) {
            await releaseOnVerifyFail()
            throw new SitesError(
              'FORBIDDEN',
              '站点当前线上服务端 /api/* 代码与所有者已批准摘要不一致，请先由站点所有者重新确认发布后再允许协作者更新',
              403,
            )
          }
        }

        const finalVisibility: SiteVisibility =
          accessRole === 'owner'
            ? (requestedVisibility ?? lockedExisting?.visibility ?? 'public')
            : (lockedExisting?.visibility ?? 'public')
        let finalSalt = preSalt
        let finalHash = preHash
        if (finalVisibility === 'password' && (input.password === undefined || accessRole !== 'owner')) {
          if (lockedExisting?.passwordSalt && lockedExisting.passwordHash) {
            finalSalt = lockedExisting.passwordSalt
            finalHash = lockedExisting.passwordHash
          } else if (!finalSalt || !finalHash) {
            if (reservation.isNewPlaceholder) {
              await repo.abortPublishPlaceholder(reservation.siteId, ownerId, reservation.leaseId)
            } else {
              await repo.releaseLease(reservation.siteId, ownerId, reservation.leaseId)
            }
            throw new SitesError('PASSWORD_REQUIRED', '口令保护模式需要设置 4–128 位访问口令', 400)
          }
        } else if (finalVisibility !== 'password') {
          finalSalt = null
          finalHash = null
        }

        const finalTitle =
          input.title !== undefined
            ? normalizeSiteTitle(input.title, slug)
            : lockedExisting?.title || hintTitle
        const finalSpa =
          input.spaMode !== undefined
            ? Boolean(input.spaMode)
            : (lockedExisting?.spaMode ?? hintSpaMode)

        const envPayload = await this.buildEdgeEnvPayload(
          repo,
          ownerId,
          reservation.siteId,
          slug,
        )
        const activeVerifiedDomain =
          lockedExisting?.customDomainVerified && lockedExisting.customDomain
            ? lockedExisting.customDomain
            : null

        const effectiveAclVersion = Math.max(
          1,
          lockedExisting?.previewAclVersion ?? 1,
          lockedExisting?.previewAclTargetVersion ?? 1,
        )
        const meta: EdgeMetaEnvelope = {
          siteId: reservation.siteId,
          title: finalTitle,
          visibility: finalVisibility,
          passwordSalt: finalSalt,
          passwordHash: finalHash,
          spaMode: finalSpa,
          customDomain: activeVerifiedDomain,
          hasServerApi: decoded.hasServerApi,
          envDigest: envPayload.digest,
          contentSha256: decoded.contentSha256,
          previewAclVersion: effectiveAclVersion,
          expectedBaseRevision: reservation.baseRevision,
        }

        let committedOnEdge = false
        let pushResult: { needsEnvSync?: boolean; envDigest?: string } = {}
        let overriddenErr: Error | null = null
        try {
          pushResult = await edge.pushBundle({
            slug,
            revision: reservation.edgeRevision,
            gzippedBundle: input.gzippedBundle,
            meta,
            hasServerApi: decoded.hasServerApi,
          })
          committedOnEdge = true
        } catch (err) {
          if (err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE') {
            try {
              const status = await edge.getSiteStatus({ slug, siteId: reservation.siteId })
              if (
                status.exists &&
                status.meta?.siteId === reservation.siteId &&
                status.revision === reservation.edgeRevision &&
                status.meta?.contentSha256 === decoded.contentSha256
              ) {
                committedOnEdge = true
              } else if (
                status.exists &&
                status.meta?.siteId &&
                status.meta.siteId !== reservation.siteId &&
                reservation.isNewPlaceholder
              ) {
                await repo
                  .abortPublishPlaceholder(reservation.siteId, ownerId, reservation.leaseId)
                  .catch(() => {})
                overriddenErr = new SitesError(
                  'SLUG_TAKEN',
                  `子域名 "${slug}" 已被占用，请更换名称`,
                  409,
                )
              } else if (!status.exists && reservation.isNewPlaceholder) {
                await repo
                  .abortPublishPlaceholder(reservation.siteId, ownerId, reservation.leaseId)
                  .catch(() => {})
              } else if (
                status.exists &&
                (!status.meta?.siteId || status.meta.siteId === reservation.siteId) &&
                status.revision === reservation.baseRevision
              ) {
                await repo
                  .releaseLease(reservation.siteId, ownerId, reservation.leaseId, true)
                  .catch(() => {})
              } else {
                await repo
                  .releaseLease(reservation.siteId, ownerId, reservation.leaseId, false)
                  .catch(() => {})
              }
            } catch {
              await repo
                .releaseLease(reservation.siteId, ownerId, reservation.leaseId, false)
                .catch(() => {})
            }
          } else if (err instanceof SitesError && err.code === 'STALE_REVISION') {
            if (reservation.isNewPlaceholder) {
              await repo
                .abortPublishPlaceholder(reservation.siteId, ownerId, reservation.leaseId)
                .catch(() => {})
            } else {
              await repo
                .releaseLease(reservation.siteId, ownerId, reservation.leaseId, false)
                .catch(() => {})
            }
          } else if (reservation.isNewPlaceholder) {
            await repo
              .abortPublishPlaceholder(reservation.siteId, ownerId, reservation.leaseId)
              .catch(() => {})
          } else {
            await repo
              .releaseLease(reservation.siteId, ownerId, reservation.leaseId, true)
              .catch(() => {})
          }
          if (!committedOnEdge) throw overriddenErr ?? err
        }

        let committedDigest = envPayload.digest
        let markEnvPending = false
        let syncErr: Error | null = null
        if (pushResult?.needsEnvSync && edge.syncEnv) {
          try {
            await edge.syncEnv({
              slug,
              siteId: reservation.siteId,
              revision: reservation.edgeRevision,
              expectedBaseRevision: reservation.edgeRevision,
              envDigest: envPayload.digest,
              encryptedEnvB64: envPayload.sealedB64,
            })
          } catch (err) {
            committedDigest = pushResult.envDigest ?? ''
            markEnvPending = true
            syncErr = err instanceof Error ? err : new Error(String(err))
          }
        }

        const committed = await repo.commitPublish({
          siteId: reservation.siteId,
          userId: ownerId,
          leaseId: reservation.leaseId,
          title: finalTitle,
          visibility: finalVisibility,
          passwordSalt: finalSalt,
          passwordHash: finalHash,
          spaMode: finalSpa,
          originSessionId: accessRole === 'owner' ? (input.originSessionId ?? null) : null,
          hasServerApi: decoded.hasServerApi,
          ...(accessRole === 'owner' ? { serverApiSha256: decoded.serverApiSha256 } : {}),
          previewAclVersion: effectiveAclVersion,
          envDigest: committedDigest,
          markEnvPending,
          pendingEnvDigest: markEnvPending ? envPayload.digest : null,
          fileCount: decoded.fileCount,
          sizeBytes: decoded.sizeBytes,
          contentSha256: decoded.contentSha256,
          edgeRevision: reservation.edgeRevision,
        })
        if (syncErr) {
          throw new SitesError(
            'EDGE_UNAVAILABLE',
            `站点文件已发布，但环境变量同步到边缘节点失败，请重试: ${syncErr.message}`,
            502,
            true,
          )
        }
        return {
          ...committed,
          accessRole,
          ownerEmail: preHint?.ownerEmail ?? committed.ownerEmail ?? null,
          ownerDisplayName: preHint?.ownerDisplayName ?? committed.ownerDisplayName ?? null,
          collaboratorCount: preHint?.collaboratorCount ?? committed.collaboratorCount ?? 0,
        }
      })

    if (explicitSlug) {
      const row = await attemptPublish(explicitSlug)
      return toUserSiteDto(row, this.baseDomain)
    }

    for (let i = 0; i < 3; i++) {
      const candidate = generateRandomSiteSlug()
      try {
        const row = await attemptPublish(candidate)
        return toUserSiteDto(row, this.baseDomain)
      } catch (err) {
        if (err instanceof SitesError && err.code === 'SLUG_TAKEN' && i < 2) continue
        throw err
      }
    }
    throw new SitesError('SLUG_TAKEN', '随机站点名冲突，请重试或手动指定 --slug', 409)
  }

  private async pushMetaWithLeaseHandling(args: {
    repo: SitesRepo
    edge: SitesEdgeClient
    site: UserSiteRow
    userId: number
    leaseId: string
    nextRevision: number
    meta: EdgeMetaEnvelope
    encryptedEnvB64?: string
    preserveTargetOnAmbiguous?: boolean
  }): Promise<'committed'> {
    try {
      await args.edge.updateMeta({
        slug: args.site.slug,
        revision: args.nextRevision,
        meta: args.meta,
        encryptedEnvB64: args.encryptedEnvB64,
      })
      return 'committed'
    } catch (err) {
      if (err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE') {
        try {
          const status = await args.edge.getSiteStatus({ slug: args.site.slug, siteId: args.site.id })
          if (
            status.exists &&
            status.meta?.siteId === args.site.id &&
            status.revision === args.nextRevision
          ) {
            return 'committed'
          }
          if (
            status.exists &&
            (!status.meta?.siteId || status.meta.siteId === args.site.id) &&
            status.revision === args.site.edgeRevision
          ) {
            await args.repo
              .releaseLease(args.site.id, args.userId, args.leaseId, !args.preserveTargetOnAmbiguous)
              .catch(() => {})
          } else {
            await args.repo
              .releaseLease(args.site.id, args.userId, args.leaseId, false)
              .catch(() => {})
          }
        } catch (probeErr) {
          await args.repo
            .releaseLease(args.site.id, args.userId, args.leaseId, false)
            .catch(() => {})
          if (args.preserveTargetOnAmbiguous) {
            throw err
          }
          throw probeErr instanceof SitesError ? probeErr : err
        }
      } else if (err instanceof SitesError && err.code === 'STALE_REVISION') {
        await args.repo
          .releaseLease(args.site.id, args.userId, args.leaseId, false)
          .catch(() => {})
      } else {
        await args.repo
          .releaseLease(args.site.id, args.userId, args.leaseId, true)
          .catch(() => {})
      }
      throw err
    }
  }

  async updateSite(userId: number, rawSlug: string, patch: UpdateSiteInput): Promise<UserSiteDto> {
    const { repo, edge } = this.requireReady()
    const slug = validateSiteSlug(rawSlug)
    if (
      patch.title === undefined &&
      patch.visibility === undefined &&
      patch.password === undefined &&
      patch.spaMode === undefined &&
      patch.customDomain === undefined
    ) {
      throw new SitesError('INVALID_INPUT', '没有需要更新的字段', 400)
    }
    if (patch.password !== undefined) {
      validateSitePasswordInput(patch.password)
    }
    const requestedVisibility =
      patch.visibility !== undefined ? parseSiteVisibility(patch.visibility) : undefined
    let normalizedDomain: string | null | undefined = undefined
    if (patch.customDomain !== undefined) {
      if (patch.customDomain === null || patch.customDomain.trim() === '') {
        normalizedDomain = null
      } else {
        normalizedDomain = validateCustomDomain(patch.customDomain, this.baseDomain)
      }
    }

    await this.reconcilePendingByUser(userId)

    const touchesOwnerOnly =
      patch.visibility !== undefined ||
      patch.password !== undefined ||
      patch.customDomain !== undefined

    const row = await this.withSlugLock(slug, async () => {
      const { site, leaseId, nextRevision } = await repo.prepareMetaUpdate(
        userId,
        slug,
        'meta',
        null,
        normalizedDomain ?? null,
        !touchesOwnerOnly,
      )
      const ownerId = site.userId
      const accessRole: SiteAccessRole = site.accessRole ?? 'owner'
      if (touchesOwnerOnly && accessRole !== 'owner') {
        await repo.releaseLease(site.id, ownerId, leaseId, true).catch(() => {})
        throw new SitesError('FORBIDDEN', '仅站点所有者可修改访问权限或自定义域名', 403)
      }

      const nextVisibility: SiteVisibility = requestedVisibility ?? site.visibility
      const nextTitle =
        patch.title !== undefined ? normalizeSiteTitle(patch.title, slug) : site.title
      const nextSpaMode = patch.spaMode !== undefined ? Boolean(patch.spaMode) : site.spaMode

      let nextCustomDomain = site.customDomain
      let nextDomainVerified = site.customDomainVerified
      let nextDomainToken = site.customDomainToken
      if (normalizedDomain === null) {
        nextCustomDomain = null
        nextDomainVerified = false
        nextDomainToken = null
      } else if (normalizedDomain !== undefined && normalizedDomain !== site.customDomain) {
        nextCustomDomain = normalizedDomain
        nextDomainVerified = false
        nextDomainToken = randomBytes(16).toString('hex')
      } else if (normalizedDomain !== undefined && !nextDomainToken) {
        nextDomainToken = randomBytes(16).toString('hex')
      }

      const edgeCustomDomain = nextDomainVerified ? nextCustomDomain : null

      let nextSalt: string | null = null
      let nextHash: string | null = null
      if (nextVisibility === 'password') {
        if (patch.password !== undefined) {
          const hashed = hashSitePassword(patch.password)
          nextSalt = hashed.salt
          nextHash = hashed.hash
        } else if (site.passwordSalt && site.passwordHash) {
          nextSalt = site.passwordSalt
          nextHash = site.passwordHash
        } else {
          await repo.releaseLease(site.id, ownerId, leaseId).catch(() => {})
          throw new SitesError(
            'PASSWORD_REQUIRED',
            '切换到口令保护模式需要设置 4–128 位访问口令',
            400,
          )
        }
      }

      const envPayload = await this.buildEdgeEnvPayload(repo, ownerId, site.id, slug)
      const meta: EdgeMetaEnvelope = {
        siteId: site.id,
        title: nextTitle,
        visibility: nextVisibility,
        passwordSalt: nextSalt,
        passwordHash: nextHash,
        spaMode: nextSpaMode,
        customDomain: edgeCustomDomain,
        hasServerApi: site.hasServerApi,
        envDigest: envPayload.digest,
        contentSha256: site.contentSha256,
        previewAclVersion: Math.max(1, site.previewAclVersion ?? 1, site.previewAclTargetVersion ?? 1),
        expectedBaseRevision: site.edgeRevision,
      }

      await this.pushMetaWithLeaseHandling({
        repo,
        edge,
        site,
        userId: ownerId,
        leaseId,
        nextRevision,
        meta,
        encryptedEnvB64: envPayload.sealedB64,
      })

      try {
        const committed = await repo.commitMetaUpdate({
          siteId: site.id,
          userId: ownerId,
          leaseId,
          title: nextTitle,
          visibility: nextVisibility,
          passwordSalt: nextSalt,
          passwordHash: nextHash,
          spaMode: nextSpaMode,
          customDomain: nextCustomDomain,
          customDomainVerified: nextDomainVerified,
          customDomainToken: nextDomainToken,
          envDigest: envPayload.digest,
          previewAclVersion: Math.max(1, site.previewAclVersion ?? 1, site.previewAclTargetVersion ?? 1),
          edgeRevision: nextRevision,
        })
        return {
          ...committed,
          accessRole,
          ownerEmail: site.ownerEmail ?? committed.ownerEmail ?? null,
          ownerDisplayName: site.ownerDisplayName ?? committed.ownerDisplayName ?? null,
          collaboratorCount: site.collaboratorCount ?? committed.collaboratorCount ?? 0,
        }
      } catch (err) {
        await repo.releaseLease(site.id, ownerId, leaseId, false).catch(() => {})
        throw err
      }
    })
    return toUserSiteDto(row, this.baseDomain)
  }

  async verifyCustomDomain(userId: number, rawSlug: string): Promise<UserSiteDto> {
    const { repo, edge } = this.requireReady()
    const slug = validateSiteSlug(rawSlug)
    await this.reconcilePendingByUser(userId)

    const row = await this.withSlugLock(slug, async () => {
      const current = await repo.getByUserAndSlug(userId, slug)
      if (!current) {
        throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
      }
      this.assertOwner(current, '验证自定义域名')
      if (!current.customDomain) {
        throw new SitesError('INVALID_INPUT', '请先添加并保存自定义域名后再验证', 400)
      }
      if (!current.customDomainVerified) {
        if (!current.customDomainToken) {
          throw new SitesError('INVALID_INPUT', '缺少域名验证令牌，请重新保存域名后重试', 400)
        }
        const expectedTxt = customDomainTxtValueFor(current.id, current.customDomainToken)
        const txtHost = `_oc-site-verify.${current.customDomain}`
        let txtRows: string[][]
        try {
          txtRows = await this.resolveTxt(txtHost)
        } catch {
          txtRows = []
        }
        const matched = txtRows.some((chunks) => chunks.join('').trim() === expectedTxt)
        if (!matched) {
          throw new SitesError(
            'INVALID_INPUT',
            `未在 ${txtHost} 检测到匹配的 TXT 记录 (${expectedTxt})，请等待 DNS 生效后重试`,
            400,
          )
        }
      }

      const { site, leaseId, nextRevision } = await repo.prepareMetaUpdate(
        userId,
        slug,
        'meta',
        null,
        current.customDomain,
      )
      if (
        site.id !== current.id ||
        site.customDomain !== current.customDomain ||
        site.customDomainToken !== current.customDomainToken ||
        site.edgeRevision !== current.edgeRevision
      ) {
        await repo.releaseLease(site.id, userId, leaseId, true).catch(() => {})
        throw new SitesError('STALE_REVISION', '站点域名配置在验证过程中发生变化，请重新验证', 409)
      }
      const envPayload = await this.buildEdgeEnvPayload(repo, userId, site.id, slug)
      const meta: EdgeMetaEnvelope = {
        siteId: site.id,
        title: site.title,
        visibility: site.visibility,
        passwordSalt: site.passwordSalt,
        passwordHash: site.passwordHash,
        spaMode: site.spaMode,
        customDomain: site.customDomain,
        hasServerApi: site.hasServerApi,
        envDigest: envPayload.digest,
        contentSha256: site.contentSha256,
        previewAclVersion: Math.max(1, site.previewAclVersion ?? 1, site.previewAclTargetVersion ?? 1),
        expectedBaseRevision: site.edgeRevision,
      }

      await this.pushMetaWithLeaseHandling({
        repo,
        edge,
        site,
        userId,
        leaseId,
        nextRevision,
        meta,
        encryptedEnvB64: envPayload.sealedB64,
      })

      try {
        return await repo.commitMetaUpdate({
          siteId: site.id,
          userId,
          leaseId,
          title: site.title,
          visibility: site.visibility,
          passwordSalt: site.passwordSalt,
          passwordHash: site.passwordHash,
          spaMode: site.spaMode,
          customDomain: site.customDomain,
          customDomainVerified: true,
          customDomainToken: site.customDomainToken,
          envDigest: envPayload.digest,
          edgeRevision: nextRevision,
        })
      } catch (err) {
        if (err instanceof SitesError && err.code === 'DOMAIN_TAKEN') {
          const revertMeta: EdgeMetaEnvelope = {
            ...meta,
            customDomain: null,
            expectedBaseRevision: nextRevision,
          }
          await edge
            .updateMeta({
              slug,
              revision: nextRevision + 1,
              meta: revertMeta,
              encryptedEnvB64: envPayload.sealedB64,
            })
            .catch(() => {})
        }
        await repo.releaseLease(site.id, userId, leaseId, false).catch(() => {})
        throw err
      }
    })
    return toUserSiteDto(row, this.baseDomain)
  }

  async renameSite(
    userId: number,
    rawOldSlug: string,
    rawNewSlug: string,
  ): Promise<UserSiteDto> {
    const { repo, edge } = this.requireReady()
    const oldSlug = validateSiteSlug(rawOldSlug)
    const newSlug = validateSiteSlug(rawNewSlug)
    if (oldSlug === newSlug) {
      return this.getSite(userId, oldSlug)
    }

    await this.reconcilePendingByUser(userId)

    const row = await this.withTwoSlugLocks(oldSlug, newSlug, async () => {
      const existing = await repo.getByUserAndSlug(userId, oldSlug)
      if (!existing) {
        throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${oldSlug}"`, 404)
      }
      this.assertOwner(existing, '更改站点子域名')
      const { site, leaseId, nextRevision } = await repo.prepareRename(userId, oldSlug, newSlug)
      let committedOnEdge = false
      try {
        await edge.renameSite({
          slug: oldSlug,
          siteId: site.id,
          newSlug,
          revision: nextRevision,
          expectedBaseRevision: site.edgeRevision,
        })
        committedOnEdge = true
      } catch (err) {
        if (err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE') {
          try {
            const newStatus = await edge.getSiteStatus({ slug: newSlug, siteId: site.id })
            if (
              newStatus.exists &&
              newStatus.revision === nextRevision &&
              newStatus.meta?.siteId === site.id
            ) {
              committedOnEdge = true
            } else {
              const oldStatus = await edge.getSiteStatus({ slug: oldSlug, siteId: site.id })
              if (
                oldStatus.exists &&
                oldStatus.revision === site.edgeRevision &&
                (!oldStatus.meta?.siteId || oldStatus.meta.siteId === site.id)
              ) {
                await repo
                  .abortRenameReservation(site.id, userId, leaseId, newSlug, true)
                  .catch(() => {})
              } else {
                await repo.releaseLease(site.id, userId, leaseId, false).catch(() => {})
              }
            }
          } catch {
            await repo.releaseLease(site.id, userId, leaseId, false).catch(() => {})
          }
        } else if (err instanceof SitesError && err.code === 'STALE_REVISION') {
          await repo.releaseLease(site.id, userId, leaseId, false).catch(() => {})
        } else {
          await repo
            .abortRenameReservation(site.id, userId, leaseId, newSlug, true)
            .catch(() => {})
        }
        if (!committedOnEdge) throw err
      }

      return repo.commitRename({
        siteId: site.id,
        userId,
        leaseId,
        newSlug,
        edgeRevision: nextRevision,
      })
    })
    return toUserSiteDto(row, this.baseDomain)
  }

  async listEnvVars(userId: number, rawSlug: string): Promise<SiteEnvVarDto[]> {
    const { repo } = this.requireReady()
    const slug = validateSiteSlug(rawSlug)
    await this.reconcilePendingByUser(userId)
    const row = await repo.getByUserAndSlug(userId, slug)
    if (!row) {
      throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
    }
    this.assertOwner(row, '查看或管理环境变量')
    const envRows = await repo.listSiteEnvRows(row.id, userId)
    return this.toEnvDtos(envRows)
  }

  async setEnvVar(
    userId: number,
    rawSlug: string,
    input: SetSiteEnvVarInput,
  ): Promise<{ envVar: SiteEnvVarDto; envVars: SiteEnvVarDto[] }> {
    const { repo, edge } = this.requireReady()
    const { dbEnvKey } = this.requireEnvSecrets()
    const slug = validateSiteSlug(rawSlug)
    const key = validateEnvVarKey(input.key)
    if (typeof input.value !== 'string') {
      throw new SitesError('INVALID_INPUT', '环境变量值必须是字符串', 400)
    }
    if (Buffer.byteLength(input.value, 'utf8') > SITE_MAX_ENV_VALUE_BYTES) {
      throw new SitesError(
        'INVALID_INPUT',
        `单个环境变量值不能超过 ${SITE_MAX_ENV_VALUE_BYTES} 字节`,
        400,
      )
    }
    const isSecret = Boolean(input.isSecret)

    await this.reconcilePendingByUser(userId)

    return this.withSlugLock(slug, async () => {
      const { site, leaseId, nextRevision } = await repo.prepareMetaUpdate(userId, slug, 'env')
      const prevRows = await repo.listSiteEnvRows(site.id, userId)
      const prevRow = prevRows.find((r) => r.key === key)

      let savedRow: StoredSiteEnvVarRow
      let updatedRows: StoredSiteEnvVarRow[]
      let envPayload: { digest: string; sealedB64: string; totalBytes: number }
      try {
        if (isSecret) {
          const enc = encryptSiteSecretForDb({
            key: dbEnvKey,
            userId,
            siteId: site.id,
            envKey: key,
            plaintext: input.value,
          })
          savedRow = await repo.upsertSiteEnvRow({
            siteId: site.id,
            userId,
            key,
            isSecret: true,
            plainValue: null,
            ciphertext: enc.ciphertext,
            nonce: enc.nonce,
            maxEnvVars: SITE_MAX_ENV_VARS,
          })
        } else {
          savedRow = await repo.upsertSiteEnvRow({
            siteId: site.id,
            userId,
            key,
            isSecret: false,
            plainValue: input.value,
            ciphertext: null,
            nonce: null,
            maxEnvVars: SITE_MAX_ENV_VARS,
          })
        }
        updatedRows = await repo.listSiteEnvRows(site.id, userId)
        envPayload = this.buildEdgeEnvPayloadFromRows(userId, site.id, slug, updatedRows)
      } catch (err) {
        await this.restoreEnvRow(repo, site.id, userId, key, prevRow)
        await repo.releaseLease(site.id, userId, leaseId, true).catch(() => {})
        throw err
      }

      const meta: EdgeMetaEnvelope = {
        siteId: site.id,
        title: site.title,
        visibility: site.visibility,
        passwordSalt: site.passwordSalt,
        passwordHash: site.passwordHash,
        spaMode: site.spaMode,
        customDomain: site.customDomainVerified ? site.customDomain : null,
        hasServerApi: site.hasServerApi,
        envDigest: envPayload.digest,
        contentSha256: site.contentSha256,
        previewAclVersion: Math.max(1, site.previewAclVersion ?? 1, site.previewAclTargetVersion ?? 1),
        expectedBaseRevision: site.edgeRevision,
      }

      try {
        await this.pushMetaWithLeaseHandling({
          repo,
          edge,
          site,
          userId,
          leaseId,
          nextRevision,
          meta,
          encryptedEnvB64: envPayload.sealedB64,
          preserveTargetOnAmbiguous: true,
        })
      } catch (err) {
        // Keep PG env mutation when failure is ambiguous (EDGE_UNAVAILABLE) so next reconcile converges Edge forward (P1 #10).
        if (!(err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE')) {
          await this.restoreEnvRow(repo, site.id, userId, key, prevRow)
        }
        throw err
      }

      await repo.commitMetaUpdate({
        siteId: site.id,
        userId,
        leaseId,
        title: site.title,
        visibility: site.visibility,
        passwordSalt: site.passwordSalt,
        passwordHash: site.passwordHash,
        spaMode: site.spaMode,
        customDomain: site.customDomain,
        customDomainVerified: site.customDomainVerified,
        customDomainToken: site.customDomainToken,
        envDigest: envPayload.digest,
        edgeRevision: nextRevision,
      })

      const envVars = this.toEnvDtos(updatedRows)
      const envVar = envVars.find((v) => v.key === savedRow.key)!
      return { envVar, envVars }
    })
  }

  async deleteEnvVar(
    userId: number,
    rawSlug: string,
    rawKey: string,
  ): Promise<SiteEnvVarDto[]> {
    const { repo, edge } = this.requireReady()
    const slug = validateSiteSlug(rawSlug)
    const key = validateEnvVarKey(rawKey)
    await this.reconcilePendingByUser(userId)

    return this.withSlugLock(slug, async () => {
      const existing = await repo.getByUserAndSlug(userId, slug)
      if (!existing) {
        throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
      }
      this.assertOwner(existing, '管理环境变量')
      const initialRows = await repo.listSiteEnvRows(existing.id, userId)
      if (!initialRows.some((r) => r.key === key)) {
        return this.toEnvDtos(initialRows)
      }

      const { site, leaseId, nextRevision } = await repo.prepareMetaUpdate(userId, slug, 'env')
      const prevRows = await repo.listSiteEnvRows(site.id, userId)
      const prevRow = prevRows.find((r) => r.key === key)
      if (!prevRow) {
        await repo.releaseLease(site.id, userId, leaseId, true).catch(() => {})
        return this.toEnvDtos(prevRows)
      }

      await repo.deleteSiteEnvRow(site.id, userId, key)
      const updatedRows = await repo.listSiteEnvRows(site.id, userId)
      const envPayload = this.buildEdgeEnvPayloadFromRows(userId, site.id, slug, updatedRows)
      const meta: EdgeMetaEnvelope = {
        siteId: site.id,
        title: site.title,
        visibility: site.visibility,
        passwordSalt: site.passwordSalt,
        passwordHash: site.passwordHash,
        spaMode: site.spaMode,
        customDomain: site.customDomainVerified ? site.customDomain : null,
        hasServerApi: site.hasServerApi,
        envDigest: envPayload.digest,
        contentSha256: site.contentSha256,
        previewAclVersion: Math.max(1, site.previewAclVersion ?? 1, site.previewAclTargetVersion ?? 1),
        expectedBaseRevision: site.edgeRevision,
      }

      try {
        await this.pushMetaWithLeaseHandling({
          repo,
          edge,
          site,
          userId,
          leaseId,
          nextRevision,
          meta,
          encryptedEnvB64: envPayload.sealedB64,
          preserveTargetOnAmbiguous: true,
        })
      } catch (err) {
        if (!(err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE')) {
          await this.restoreEnvRow(repo, site.id, userId, key, prevRow)
        }
        throw err
      }

      await repo.commitMetaUpdate({
        siteId: site.id,
        userId,
        leaseId,
        title: site.title,
        visibility: site.visibility,
        passwordSalt: site.passwordSalt,
        passwordHash: site.passwordHash,
        spaMode: site.spaMode,
        customDomain: site.customDomain,
        customDomainVerified: site.customDomainVerified,
        customDomainToken: site.customDomainToken,
        envDigest: envPayload.digest,
        edgeRevision: nextRevision,
      })

      return this.toEnvDtos(updatedRows)
    })
  }

  async getAnalytics(
    userId: number,
    rawSlug: string,
    days = 30,
  ): Promise<SiteAnalyticsResponse> {
    const { repo, edge } = this.requireReady()
    const slug = validateSiteSlug(rawSlug)
    await this.reconcilePendingByUser(userId)
    const row = await repo.getByUserAndSlug(userId, slug)
    if (!row) {
      throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
    }
    return edge.getAnalytics({
      slug: row.slug,
      siteId: row.id,
      expectedRevision: row.edgeRevision,
      days,
    })
  }

  async inspectDb(
    userId: number,
    rawSlug: string,
    opts?: { table?: string; limit?: number },
  ): Promise<SiteDbInspectResponse> {
    const { repo, edge } = this.requireReady()
    const slug = validateSiteSlug(rawSlug)
    await this.reconcilePendingByUser(userId)
    const row = await repo.getByUserAndSlug(userId, slug)
    if (!row) {
      throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
    }
    return edge.inspectDb({
      slug: row.slug,
      siteId: row.id,
      expectedRevision: row.edgeRevision,
      table: opts?.table,
      limit: opts?.limit,
    })
  }

  async executeDbSql(
    userId: number,
    rawSlug: string,
    input: { sql: string; params?: unknown[] },
  ): Promise<SiteDbQueryResponse> {
    const { repo, edge } = this.requireReady()
    const slug = validateSiteSlug(rawSlug)
    await this.reconcilePendingByUser(userId)
    const row = await repo.getByUserAndSlug(userId, slug)
    if (!row) {
      throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
    }
    this.assertCanEdit(row, '执行数据库 SQL')
    return edge.executeDbSql({
      slug: row.slug,
      siteId: row.id,
      expectedRevision: row.edgeRevision,
      sql: input.sql,
      params: input.params,
    })
  }

  async pullSiteBundle(
    userId: number,
    rawSlug: string,
  ): Promise<{ site: UserSiteDto; gzippedBundle: Buffer }> {
    const { repo, edge } = this.requireReady()
    if (!edge.pullBundle) {
      throw new SitesError('EDGE_UNAVAILABLE', '当前边缘节点不支持拉取站点包', 501)
    }
    const slug = validateSiteSlug(rawSlug)
    await this.reconcilePendingByUser(userId)
    const row = await repo.getByUserAndSlug(userId, slug)
    if (!row) {
      throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
    }
    this.assertCanEdit(row, '拉取站点代码')
    const gzippedBundle = await edge.pullBundle({
      slug: row.slug,
      siteId: row.id,
      expectedRevision: row.edgeRevision,
    })
    decodeSiteBundle(gzippedBundle, this.maxSiteBytes)
    return { site: toUserSiteDto(row, this.baseDomain), gzippedBundle }
  }

  private async syncPreviewAclToEdge(ownerUserId: number, slug: string): Promise<void> {
    const { repo, edge } = this.requireReady()
    await this.withSlugLock(slug, async () => {
      const { site, leaseId, nextRevision } = await repo.prepareMetaUpdate(ownerUserId, slug, 'meta')
      const currentAcl = Math.max(1, site.previewAclVersion ?? 1)
      const targetAcl = Math.max(currentAcl, site.previewAclTargetVersion ?? 1)
      if (currentAcl >= targetAcl) {
        await repo.releaseLease(site.id, ownerUserId, leaseId, true).catch(() => {})
        return
      }
      const envPayload = await this.buildEdgeEnvPayload(repo, ownerUserId, site.id, slug)
      const meta: EdgeMetaEnvelope = {
        siteId: site.id,
        title: site.title,
        visibility: site.visibility,
        passwordSalt: site.passwordSalt,
        passwordHash: site.passwordHash,
        spaMode: site.spaMode,
        customDomain: site.customDomainVerified ? site.customDomain : null,
        hasServerApi: site.hasServerApi,
        envDigest: envPayload.digest,
        contentSha256: site.contentSha256,
        previewAclVersion: targetAcl,
        expectedBaseRevision: site.edgeRevision,
      }
      await this.pushMetaWithLeaseHandling({
        repo,
        edge,
        site,
        userId: ownerUserId,
        leaseId,
        nextRevision,
        meta,
        encryptedEnvB64: envPayload.sealedB64,
      })
      try {
        await repo.commitMetaUpdate({
          siteId: site.id,
          userId: ownerUserId,
          leaseId,
          title: site.title,
          visibility: site.visibility,
          passwordSalt: site.passwordSalt,
          passwordHash: site.passwordHash,
          spaMode: site.spaMode,
          customDomain: site.customDomain,
          customDomainVerified: site.customDomainVerified,
          customDomainToken: site.customDomainToken,
          envDigest: envPayload.digest,
          previewAclVersion: targetAcl,
          edgeRevision: nextRevision,
        })
      } catch (err) {
        await repo.releaseLease(site.id, ownerUserId, leaseId, false).catch(() => {})
        throw err
      }
    })
  }

  async createPreviewSession(
    userId: number,
    rawSlug: string,
    parentOriginRaw: string,
  ): Promise<SitePreviewSessionDto> {
    const { repo } = this.requireReady()
    const { edgeSecret } = this.requireEnvSecrets()
    const slug = validateSiteSlug(rawSlug)
    const parentOrigin = normalizePreviewParentOrigin(parentOriginRaw)
    await this.reconcilePendingByUser(userId)
    const row = await repo.getByUserAndSlug(userId, slug)
    if (!row) {
      throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
    }
    this.assertCanEdit(row, '使用实时预览编辑')
    const nowSec = Math.floor(Date.now() / 1000)
    const bootExpSec = nowSec + SITE_PREVIEW_BOOT_TTL_SEC
    const sessionExpSec = nowSec + SITE_PREVIEW_TTL_SEC
    const bootCode = signSitePreviewToken({
      secret: edgeSecret,
      kind: 'boot',
      siteId: row.id,
      slug: row.slug,
      parentOrigin,
      aclVersion: Math.max(1, row.previewAclVersion ?? 1, row.previewAclTargetVersion ?? 1),
      nonce: randomBytes(16).toString('hex'),
      expSec: bootExpSec,
    })
    const siteOrigin = `https://${row.slug}.${this.baseDomain}`
    return {
      bootstrapUrl: `${siteOrigin}/__oc_site_preview_bootstrap?code=${encodeURIComponent(bootCode)}`,
      siteOrigin,
      siteUrl: siteOrigin,
      expiresAt: new Date(sessionExpSec * 1000).toISOString(),
    }
  }

  async getSharingState(
    userId: number,
    rawSlug: string,
  ): Promise<{
    site: UserSiteDto
    collaborators: SiteCollaboratorDto[]
    invites: SiteInviteDto[]
  }> {
    const { repo } = this.requireReady()
    const slug = validateSiteSlug(rawSlug)
    await this.reconcilePendingByUser(userId)
    const row = await repo.getByUserAndSlug(userId, slug)
    if (!row) {
      throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
    }
    const collaborators = repo.listCollaborators
      ? this.toCollaboratorDtos(await repo.listCollaborators(row.id))
      : []
    const invites =
      (row.accessRole ?? 'owner') === 'owner' && repo.listActiveInvites
        ? this.toInviteDtos(await repo.listActiveInvites(row.id, userId))
        : []
    return {
      site: toUserSiteDto(row, this.baseDomain),
      collaborators,
      invites,
    }
  }

  async addCollaboratorByEmail(
    userId: number,
    rawSlug: string,
    input: { email: string; role?: SiteCollaboratorRole },
  ): Promise<{ collaborator: SiteCollaboratorDto; collaborators: SiteCollaboratorDto[] }> {
    const { repo } = this.requireReady()
    if (!repo.upsertCollaboratorByEmail || !repo.listCollaborators) {
      throw new SitesError('INTERNAL', '当前存储层未启用协作管理', 501)
    }
    const slug = validateSiteSlug(rawSlug)
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new SitesError('INVALID_INPUT', '请输入合法的邮箱地址', 400)
    }
    const role = parseSiteCollaboratorRole(input.role, 'editor')
    await this.reconcilePendingByUser(userId)
    const row = await repo.getByUserAndSlug(userId, slug)
    if (!row) {
      throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
    }
    this.assertOwner(row, '添加协作者')
    const saved = await repo.upsertCollaboratorByEmail({
      siteId: row.id,
      ownerUserId: userId,
      email,
      role,
      maxCollaborators: SITE_MAX_COLLABORATORS,
    })
    await this.syncPreviewAclToEdge(userId, slug)
    const all = await repo.listCollaborators(row.id)
    return {
      collaborator: this.toCollaboratorDtos([saved])[0]!,
      collaborators: this.toCollaboratorDtos(all),
    }
  }

  async updateCollaboratorRole(
    userId: number,
    rawSlug: string,
    targetUserId: number,
    rawRole: SiteCollaboratorRole,
  ): Promise<{ collaborator: SiteCollaboratorDto; collaborators: SiteCollaboratorDto[] }> {
    const { repo } = this.requireReady()
    if (!repo.updateCollaboratorRole || !repo.listCollaborators) {
      throw new SitesError('INTERNAL', '当前存储层未启用协作管理', 501)
    }
    if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
      throw new SitesError('INVALID_INPUT', '无效的用户 ID', 400)
    }
    const slug = validateSiteSlug(rawSlug)
    const role = parseSiteCollaboratorRole(rawRole)
    await this.reconcilePendingByUser(userId)
    const row = await repo.getByUserAndSlug(userId, slug)
    if (!row) {
      throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
    }
    this.assertOwner(row, '修改协作者角色')
    const saved = await repo.updateCollaboratorRole({
      siteId: row.id,
      ownerUserId: userId,
      targetUserId,
      role,
    })
    await this.syncPreviewAclToEdge(userId, slug)
    const all = await repo.listCollaborators(row.id)
    return {
      collaborator: this.toCollaboratorDtos([saved])[0]!,
      collaborators: this.toCollaboratorDtos(all),
    }
  }

  async removeCollaborator(
    userId: number,
    rawSlug: string,
    targetUserId: number,
  ): Promise<{ ok: true; collaborators: SiteCollaboratorDto[] }> {
    const { repo } = this.requireReady()
    if (!repo.removeCollaborator || !repo.listCollaborators) {
      throw new SitesError('INTERNAL', '当前存储层未启用协作管理', 501)
    }
    if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
      throw new SitesError('INVALID_INPUT', '无效的用户 ID', 400)
    }
    const slug = validateSiteSlug(rawSlug)
    await this.reconcilePendingByUser(userId)
    const row = await repo.getByUserAndSlug(userId, slug)
    if (!row) {
      throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
    }
    this.assertOwner(row, '移除协作者')
    await repo.removeCollaborator({ siteId: row.id, ownerUserId: userId, targetUserId })
    await this.syncPreviewAclToEdge(userId, slug)
    const all = await repo.listCollaborators(row.id)
    return { ok: true, collaborators: this.toCollaboratorDtos(all) }
  }

  async leaveSite(userId: number, rawSlug: string): Promise<{ ok: true; slug: string }> {
    const { repo } = this.requireReady()
    if (!repo.leaveSiteCollaborator) {
      throw new SitesError('INTERNAL', '当前存储层未启用协作管理', 501)
    }
    const slug = validateSiteSlug(rawSlug)
    await this.reconcilePendingByUser(userId)
    const row = await repo.getByUserAndSlug(userId, slug)
    if (!row) {
      throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
    }
    if ((row.accessRole ?? 'owner') === 'owner') {
      throw new SitesError('INVALID_INPUT', '站点所有者不能退出自己的站点', 400)
    }
    await repo.leaveSiteCollaborator(row.id, userId)
    await this.syncPreviewAclToEdge(row.userId, slug)
    return { ok: true, slug }
  }

  async createInvite(
    userId: number,
    rawSlug: string,
    input: {
      role?: SiteCollaboratorRole
      expiresInHours?: number | null
      maxUses?: number | null
    },
  ): Promise<{ invite: SiteInviteDto; token: string; invites: SiteInviteDto[] }> {
    const { repo } = this.requireReady()
    if (!repo.createInvite || !repo.listActiveInvites) {
      throw new SitesError('INTERNAL', '当前存储层未启用邀请链接', 501)
    }
    const slug = validateSiteSlug(rawSlug)
    const role = parseSiteCollaboratorRole(input.role, 'editor')
    let expiresAt: Date | null = null
    if (input.expiresInHours !== null) {
      const hours = input.expiresInHours === undefined ? 24 * 7 : Number(input.expiresInHours)
      if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 365) {
        throw new SitesError('INVALID_INPUT', '邀请链接有效期需在 1 小时至 365 天之间', 400)
      }
      expiresAt = new Date(Date.now() + Math.trunc(hours * 3600 * 1000))
    }
    let maxUses: number | null = null
    if (input.maxUses !== undefined && input.maxUses !== null) {
      const parsedMax = Math.trunc(Number(input.maxUses))
      if (!Number.isSafeInteger(parsedMax) || parsedMax < 1 || parsedMax > 1000) {
        throw new SitesError('INVALID_INPUT', '最大使用次数需为 1–1000 的正整数', 400)
      }
      maxUses = parsedMax
    }
    await this.reconcilePendingByUser(userId)
    const row = await repo.getByUserAndSlug(userId, slug)
    if (!row) {
      throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
    }
    this.assertOwner(row, '创建协作邀请链接')
    const token = randomBytes(24).toString('base64url')
    const tokenHash = hashSiteInviteToken(token)
    const created = await repo.createInvite({
      siteId: row.id,
      ownerUserId: userId,
      tokenHash,
      role,
      maxUses,
      expiresAt,
      maxActiveInvites: SITE_MAX_ACTIVE_INVITES,
    })
    const active = await repo.listActiveInvites(row.id, userId)
    return {
      invite: this.toInviteDtos([created])[0]!,
      token,
      invites: this.toInviteDtos(active),
    }
  }

  async revokeInvite(
    userId: number,
    rawSlug: string,
    inviteId: string,
  ): Promise<{ ok: true; invites: SiteInviteDto[] }> {
    const { repo } = this.requireReady()
    if (!repo.revokeInvite || !repo.listActiveInvites) {
      throw new SitesError('INTERNAL', '当前存储层未启用邀请链接', 501)
    }
    const slug = validateSiteSlug(rawSlug)
    if (!inviteId || typeof inviteId !== 'string' || inviteId.length > 64) {
      throw new SitesError('INVALID_INPUT', '无效的邀请 ID', 400)
    }
    await this.reconcilePendingByUser(userId)
    const row = await repo.getByUserAndSlug(userId, slug)
    if (!row) {
      throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
    }
    this.assertOwner(row, '撤销协作邀请链接')
    await repo.revokeInvite({ siteId: row.id, ownerUserId: userId, inviteId })
    const active = await repo.listActiveInvites(row.id, userId)
    return { ok: true, invites: this.toInviteDtos(active) }
  }

  async previewInvite(userId: number, rawToken: string): Promise<SiteInvitePreviewDto> {
    const { repo } = this.requireReady()
    if (!repo.lookupInviteByTokenHash) {
      throw new SitesError('INTERNAL', '当前存储层未启用邀请链接', 501)
    }
    const token = typeof rawToken === 'string' ? rawToken.trim() : ''
    if (!token || token.length < 16 || token.length > 128) {
      throw new SitesError('INVITE_INVALID', '邀请链接无效或已过期', 404)
    }
    const lookup = await repo.lookupInviteByTokenHash(hashSiteInviteToken(token), userId)
    if (!lookup) {
      throw new SitesError('INVITE_INVALID', '邀请链接无效、已过期或已被撤销', 404)
    }
    return {
      valid: true,
      site: {
        id: lookup.site.id,
        slug: lookup.site.slug,
        title: lookup.site.title,
        url: `https://${lookup.site.slug}.${this.baseDomain}`,
      },
      role: lookup.invite.role,
      ownerEmail: lookup.ownerEmail,
      ownerDisplayName: lookup.ownerDisplayName,
      expiresAt: lookup.invite.expiresAt ? lookup.invite.expiresAt.toISOString() : null,
      alreadyRole: lookup.alreadyRole,
    }
  }

  async acceptInvite(
    userId: number,
    rawToken: string,
  ): Promise<{ site: UserSiteDto; role: SiteAccessRole; alreadyMember: boolean }> {
    const { repo } = this.requireReady()
    if (!repo.acceptInviteByTokenHash) {
      throw new SitesError('INTERNAL', '当前存储层未启用邀请链接', 501)
    }
    const token = typeof rawToken === 'string' ? rawToken.trim() : ''
    if (!token || token.length < 16 || token.length > 128) {
      throw new SitesError('INVITE_INVALID', '邀请链接无效或已过期', 404)
    }
    const result = await repo.acceptInviteByTokenHash(
      hashSiteInviteToken(token),
      userId,
      SITE_MAX_COLLABORATORS,
    )
    return {
      site: toUserSiteDto(result.site, this.baseDomain),
      role: result.role,
      alreadyMember: result.alreadyMember,
    }
  }

  async deleteSite(userId: number, rawSlug: string): Promise<{ ok: true; slug: string }> {
    const { repo, edge } = this.requireReady()
    const slug = validateSiteSlug(rawSlug)
    await this.reconcilePendingByUser(userId)
    await this.withSlugLock(slug, async () => {
      const existing = await repo.getByUserAndSlug(userId, slug)
      if (!existing) {
        throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
      }
      this.assertOwner(existing, '删除站点')
      const { site, leaseId, deleteRevision } = await repo.prepareDelete(userId, slug)
      let deletedOnEdge = false
      try {
        await edge.deleteSite({ slug, siteId: site.id, revision: deleteRevision })
        deletedOnEdge = true
      } catch (err) {
        if (err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE') {
          try {
            const status = await edge.getSiteStatus({ slug, siteId: site.id })
            if (
              (!status.exists &&
                status.tombstoneRevision >= deleteRevision &&
                status.tombstone?.siteId === site.id) ||
              (status.retired?.siteId === site.id &&
                status.retired.op === 'delete' &&
                status.retired.revision >= deleteRevision)
            ) {
              deletedOnEdge = true
            } else if (
              status.exists &&
              (!status.meta?.siteId || status.meta.siteId === site.id) &&
              status.revision === site.edgeRevision
            ) {
              await repo.releaseLease(site.id, userId, leaseId, true).catch(() => {})
            } else {
              await repo.releaseLease(site.id, userId, leaseId, false).catch(() => {})
            }
          } catch {
            await repo.releaseLease(site.id, userId, leaseId, false).catch(() => {})
          }
        } else if (err instanceof SitesError && err.code === 'STALE_REVISION') {
          await repo.releaseLease(site.id, userId, leaseId, false).catch(() => {})
        } else {
          await repo.releaseLease(site.id, userId, leaseId, true).catch(() => {})
        }
        if (!deletedOnEdge) throw err
      }
      await repo.commitDelete(site.id, userId, leaseId, deleteRevision)
    })
    return { ok: true, slug }
  }
}
