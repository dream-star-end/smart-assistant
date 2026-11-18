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
import type { SitesRepo, StoredSiteEnvVarRow } from './repo.js'
import {
  DEFAULT_SITE_MAX_PER_USER,
  DEFAULT_SITE_MAX_TOTAL_BYTES,
  type EdgeMetaEnvelope,
  SITE_MAX_ENV_TOTAL_BYTES,
  SITE_MAX_ENV_VALUE_BYTES,
  SITE_MAX_ENV_VARS,
  type SiteAnalyticsResponse,
  type SiteDbInspectResponse,
  type SiteDbQueryResponse,
  type SiteEnvVarDto,
  type SiteVisibility,
  SitesError,
  type UserSiteDto,
  type UserSiteRow,
  customDomainTxtValueFor,
  decodeSiteBundle,
  generateRandomSiteSlug,
  hashSitePassword,
  normalizeSiteTitle,
  parseSiteVisibility,
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
      if (cand.opKind === 'rename' && cand.opRenameToSlug) {
        const targetSlug = cand.opRenameToSlug
        await this.withTwoSlugLocks(cand.slug, targetSlug, async () => {
          const claimed = await repo.tryClaimReconcileLease(cand.id, userId)
          if (!claimed) return
          try {
            const newStatus = await edge.getSiteStatus({ slug: targetSlug })
            const oldStatus = await edge.getSiteStatus({ slug: claimed.row.slug })
            const newMatchesId =
              !newStatus.meta?.siteId || newStatus.meta.siteId === claimed.row.id
            const oldMatchesId =
              !oldStatus.meta?.siteId || oldStatus.meta.siteId === claimed.row.id

            if (
              newStatus.exists &&
              newMatchesId &&
              newStatus.revision >= claimed.row.edgeRevision &&
              (!oldStatus.exists || oldStatus.tombstone?.op === 'rename')
            ) {
              let finalRev = newStatus.revision
              const envBundle = await this.buildEdgeEnvPayload(repo, userId, claimed.row.id, targetSlug)
              if (
                newStatus.revision === claimed.row.edgeRevision ||
                (newStatus.meta?.envDigest ?? '') !== envBundle.digest
              ) {
                if (newStatus.meta) {
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
                      expectedBaseRevision: newStatus.revision,
                    },
                    encryptedEnvB64: envBundle.sealedB64,
                  })
                  finalRev = claimed.row.edgeRevision + 1
                }
              }
              await repo.commitRename({
                siteId: claimed.row.id,
                userId,
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
                userId,
                claimed.leaseId,
                targetSlug,
                true,
              )
            } else {
              await repo.releaseLease(claimed.row.id, userId, claimed.leaseId, false)
            }
          } catch {
            await repo.releaseLease(claimed.row.id, userId, claimed.leaseId, false).catch(() => {})
          }
        })
        continue
      }

      await this.withSlugLock(cand.slug, async () => {
        const claimed = await repo.tryClaimReconcileLease(cand.id, userId)
        if (!claimed) return
        try {
          const status = await edge.getSiteStatus({ slug: claimed.row.slug })

          if (claimed.row.opKind === 'delete') {
            const tombMatchesId =
              !status.tombstone?.siteId || status.tombstone.siteId === claimed.row.id
            if (!status.exists && status.tombstoneRevision > claimed.row.edgeRevision && tombMatchesId) {
              await repo.commitDelete(claimed.row.id, userId, claimed.leaseId, status.tombstoneRevision)
            } else if (status.exists && (!status.meta?.siteId || status.meta.siteId === claimed.row.id)) {
              await repo.releaseLease(claimed.row.id, userId, claimed.leaseId, true)
            } else {
              await repo.releaseLease(claimed.row.id, userId, claimed.leaseId, false)
            }
            return
          }

          if (status.exists && status.revision > 0 && status.meta) {
            if (status.meta.siteId && status.meta.siteId !== claimed.row.id) {
              if (claimed.row.edgeRevision === 0) {
                await repo.abortPublishPlaceholder(claimed.row.id, userId, claimed.leaseId)
              } else {
                await repo.releaseLease(claimed.row.id, userId, claimed.leaseId, false)
              }
              return
            }

            const envBundle = await this.buildEdgeEnvPayload(
              repo,
              userId,
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

            if (status.revision > claimed.row.edgeRevision || effectiveDigest !== claimed.row.envDigest || claimed.row.opKind) {
              const shouldSyncDomain =
                status.meta.customDomain !== null || claimed.row.customDomainVerified
              const verifiedMatch =
                claimed.row.customDomainVerified &&
                claimed.row.customDomain !== null &&
                claimed.row.customDomain === status.meta.customDomain
              await repo.reconcileFromEdge({
                siteId: claimed.row.id,
                userId,
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
                envDigest: effectiveDigest,
                fileCount: status.meta.fileCount,
                sizeBytes: status.meta.sizeBytes,
                contentSha256: status.meta.contentSha256,
                edgeRevision: status.revision,
              })
            } else {
              await repo.releaseLease(claimed.row.id, userId, claimed.leaseId, true)
            }
          } else if (claimed.row.edgeRevision === 0) {
            await repo.abortPublishPlaceholder(claimed.row.id, userId, claimed.leaseId)
          } else {
            // Never delete a PG row on non-delete ops (e.g. an intermediate crash or rename tombstone).
            await repo.releaseLease(claimed.row.id, userId, claimed.leaseId, true)
          }
        } catch {
          await repo.releaseLease(claimed.row.id, userId, claimed.leaseId, false).catch(() => {})
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
          maxPerUser: this.maxPerUser,
        })

        const lockedExisting = reservation.existing
        const finalVisibility: SiteVisibility =
          requestedVisibility ?? lockedExisting?.visibility ?? 'public'
        let finalSalt = preSalt
        let finalHash = preHash
        if (finalVisibility === 'password' && input.password === undefined) {
          if (lockedExisting?.passwordSalt && lockedExisting.passwordHash) {
            finalSalt = lockedExisting.passwordSalt
            finalHash = lockedExisting.passwordHash
          } else if (!finalSalt || !finalHash) {
            if (reservation.isNewPlaceholder) {
              await repo.abortPublishPlaceholder(reservation.siteId, userId, reservation.leaseId)
            } else {
              await repo.releaseLease(reservation.siteId, userId, reservation.leaseId)
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
          userId,
          reservation.siteId,
          slug,
        )
        const activeVerifiedDomain =
          lockedExisting?.customDomainVerified && lockedExisting.customDomain
            ? lockedExisting.customDomain
            : null

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
          expectedBaseRevision: reservation.baseRevision,
        }

        let committedOnEdge = false
        let pushResult: { needsEnvSync?: boolean; envDigest?: string } = {}
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
              const status = await edge.getSiteStatus({ slug })
              if (status.exists && status.revision === reservation.edgeRevision) {
                committedOnEdge = true
              } else if (!status.exists && reservation.isNewPlaceholder) {
                await repo
                  .abortPublishPlaceholder(reservation.siteId, userId, reservation.leaseId)
                  .catch(() => {})
              } else if (status.exists && status.revision === reservation.baseRevision) {
                await repo
                  .releaseLease(reservation.siteId, userId, reservation.leaseId, true)
                  .catch(() => {})
              } else {
                await repo
                  .releaseLease(reservation.siteId, userId, reservation.leaseId, false)
                  .catch(() => {})
              }
            } catch {
              await repo
                .releaseLease(reservation.siteId, userId, reservation.leaseId, false)
                .catch(() => {})
            }
          } else if (err instanceof SitesError && err.code === 'STALE_REVISION') {
            await repo
              .releaseLease(reservation.siteId, userId, reservation.leaseId, false)
              .catch(() => {})
          } else if (reservation.isNewPlaceholder) {
            await repo
              .abortPublishPlaceholder(reservation.siteId, userId, reservation.leaseId)
              .catch(() => {})
          } else {
            await repo
              .releaseLease(reservation.siteId, userId, reservation.leaseId, true)
              .catch(() => {})
          }
          if (!committedOnEdge) throw err
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
          userId,
          leaseId: reservation.leaseId,
          title: finalTitle,
          visibility: finalVisibility,
          passwordSalt: finalSalt,
          passwordHash: finalHash,
          spaMode: finalSpa,
          originSessionId: input.originSessionId ?? null,
          hasServerApi: decoded.hasServerApi,
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
        return committed
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
          const status = await args.edge.getSiteStatus({ slug: args.site.slug })
          if (status.exists && status.revision === args.nextRevision) {
            return 'committed'
          }
          if (status.exists && status.revision === args.site.edgeRevision) {
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

    const row = await this.withSlugLock(slug, async () => {
      const { site, leaseId, nextRevision } = await repo.prepareMetaUpdate(
        userId,
        slug,
        'meta',
        null,
        normalizedDomain ?? null,
      )

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
          await repo.releaseLease(site.id, userId, leaseId).catch(() => {})
          throw new SitesError(
            'PASSWORD_REQUIRED',
            '切换到口令保护模式需要设置 4–128 位访问口令',
            400,
          )
        }
      }

      const envPayload = await this.buildEdgeEnvPayload(repo, userId, site.id, slug)
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
          title: nextTitle,
          visibility: nextVisibility,
          passwordSalt: nextSalt,
          passwordHash: nextHash,
          spaMode: nextSpaMode,
          customDomain: nextCustomDomain,
          customDomainVerified: nextDomainVerified,
          customDomainToken: nextDomainToken,
          envDigest: envPayload.digest,
          edgeRevision: nextRevision,
        })
      } catch (err) {
        await repo.releaseLease(site.id, userId, leaseId, false).catch(() => {})
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
        })
      } catch (err) {
        throw err
      }

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
            const newStatus = await edge.getSiteStatus({ slug: newSlug })
            if (
              newStatus.exists &&
              newStatus.revision === nextRevision &&
              (!newStatus.meta?.siteId || newStatus.meta.siteId === site.id)
            ) {
              committedOnEdge = true
            } else {
              const oldStatus = await edge.getSiteStatus({ slug: oldSlug })
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
    return edge.executeDbSql({
      slug: row.slug,
      siteId: row.id,
      expectedRevision: row.edgeRevision,
      sql: input.sql,
      params: input.params,
    })
  }

  async deleteSite(userId: number, rawSlug: string): Promise<{ ok: true; slug: string }> {
    const { repo, edge } = this.requireReady()
    const slug = validateSiteSlug(rawSlug)
    await this.reconcilePendingByUser(userId)
    await this.withSlugLock(slug, async () => {
      const { site, leaseId, deleteRevision } = await repo.prepareDelete(userId, slug)
      let deletedOnEdge = false
      try {
        await edge.deleteSite({ slug, siteId: site.id, revision: deleteRevision })
        deletedOnEdge = true
      } catch (err) {
        if (err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE') {
          try {
            const status = await edge.getSiteStatus({ slug })
            if (
              !status.exists &&
              status.tombstoneRevision >= deleteRevision &&
              (!status.tombstone?.siteId || status.tombstone.siteId === site.id)
            ) {
              deletedOnEdge = true
            } else if (status.exists && status.revision === site.edgeRevision) {
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
